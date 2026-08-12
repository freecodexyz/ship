import {SCORE_RULES} from './constants.js';
import {projectForRepo} from './projects.js';
import {cycleId, type CanonicalTimestamp} from './time.js';
import type {
  Actor,
  Evidence,
  Fact,
  Issue,
  Project,
  PullRequest,
  RepoId,
  Review,
  SourceRef,
} from './types.js';

const MIN_SUBSTANTIVE_REVIEW_BODY_LENGTH = 50;

type TrustedEvaluatorAward = {
  readonly id: string;
  readonly repo: RepoId;
  readonly actor: Actor | null;
  readonly occurredAt: CanonicalTimestamp;
  readonly source: SourceRef;
  readonly evaluationPoints: number;
};

type FactBaseInput = {
  readonly id: string;
  readonly project: Project;
  readonly repo: RepoId;
  readonly actor: Actor;
  readonly occurredAt: CanonicalTimestamp;
  readonly source: SourceRef;
};

/**
 * Converts trusted contribution records into independently scoreable facts.
 *
 * Repository ownership determines the project for every fact. Facts are
 * returned in ascending occurrence-time order, with deterministic fact id as
 * the tie-breaker. Qualification is intentionally uncapped; score limits are a
 * later scoring concern.
 *
 * @param projects Validated project configurations with unique repositories.
 * @param pullRequests Normalized merged pull requests.
 * @param issues Normalized issues referenced by the pull requests.
 * @param evaluatorAwards Trusted evaluator decisions, if evaluation is enabled.
 * @returns Qualified facts in deterministic scoring order.
 */
export function deriveFacts(
  projects: readonly Project[],
  pullRequests: readonly PullRequest[],
  issues: readonly Issue[],
  evaluatorAwards: readonly TrustedEvaluatorAward[] = [],
): Fact[] {
  const projectsByRepo = indexProjectsByRepository(projects);
  const issuesById = indexIssuesById(issues);
  const facts: Fact[] = [];

  for (const pullRequest of pullRequests) {
    const project = projectForRepo(pullRequest.repo, projectsByRepo);
    const actor = pullRequest.author;
    if (project === undefined || actor === null) continue;

    const pullRequestSource = sourceForPullRequest(pullRequest);
    facts.push(
      factBase(
        {
          id: `merged_pr:${pullRequest.id}`,
          project,
          repo: pullRequest.repo,
          actor,
          occurredAt: pullRequest.mergedAt,
          source: pullRequestSource,
        },
        'merged_pr',
      ),
    );

    if (isMaterialTestChange(pullRequest)) {
      facts.push(
        factBase(
          {
            id: `test_change:${pullRequest.id}`,
            project,
            repo: pullRequest.repo,
            actor,
            occurredAt: pullRequest.mergedAt,
            source: pullRequestSource,
          },
          'test_change',
        ),
      );
    }

    facts.push(...evidenceFacts(pullRequest, project));

    for (const review of firstSubstantiveReviewsByActor(pullRequest)) {
      const reviewer = review.author;
      if (reviewer === null) continue;

      facts.push(
        factBase(
          {
            id: `review:${review.id}`,
            project,
            repo: pullRequest.repo,
            actor: reviewer,
            occurredAt: review.submittedAt,
            source: {
              kind: 'review',
              number: pullRequest.number,
              title: pullRequest.title,
            },
          },
          'review',
        ),
      );
    }
  }

  for (const issue of issuesById.values()) {
    const issueProject = projectForRepo(issue.repo, projectsByRepo);
    if (issueProject === undefined) continue;
    const closingPullRequest = latestClosingPullRequest(
      issue,
      pullRequests,
      projectsByRepo,
    );
    if (closingPullRequest === null || closingPullRequest.author === null) {
      continue;
    }

    facts.push(
      factBase(
        {
          id: `resolved_issue:${issue.id}`,
          project: issueProject,
          repo: issue.repo,
          actor: closingPullRequest.author,
          occurredAt: issue.closedAt,
          source: {
            kind: 'issue',
            number: issue.number,
            title: issue.title,
          },
        },
        'resolved_issue',
      ),
    );
  }

  for (const award of evaluatorAwards) {
    const project = projectForRepo(award.repo, projectsByRepo);
    if (project === undefined || award.actor === null) continue;
    if (
      !Number.isSafeInteger(award.evaluationPoints) ||
      award.evaluationPoints <= 0
    ) {
      throw new TypeError(
        'Trusted evaluator points must be a positive safe integer.',
      );
    }

    facts.push({
      ...factBase(
        {
          id: `evaluation:${award.id}`,
          project,
          repo: award.repo,
          actor: award.actor,
          occurredAt: award.occurredAt,
          source: award.source,
        },
        'evaluation',
      ),
      evaluationPoints: award.evaluationPoints,
    });
  }

  facts.sort(compareFacts);
  assertUniqueFactIds(facts);
  return facts;
}

function indexProjectsByRepository(
  projects: readonly Project[],
): ReadonlyMap<RepoId, Project> {
  const projectsByRepo = new Map<RepoId, Project>();

  for (const project of projects) {
    for (const repository of project.repositories) {
      const key = normalizedRepoId(repository.id);
      const existing = projectsByRepo.get(key);
      if (existing !== undefined) {
        throw new TypeError(
          `Repository "${repository.id}" is owned by both "${existing.id}" and "${project.id}".`,
        );
      }
      projectsByRepo.set(key, project);
    }
  }

  return projectsByRepo;
}

function indexIssuesById(issues: readonly Issue[]): ReadonlyMap<string, Issue> {
  const issuesById = new Map<string, Issue>();
  for (const issue of issues) {
    const existing = issuesById.get(issue.id);
    if (existing !== undefined && !sameIssue(existing, issue)) {
      throw new TypeError(`Issue id "${issue.id}" has conflicting records.`);
    }
    issuesById.set(issue.id, issue);
  }
  return issuesById;
}

function sameIssue(left: Issue, right: Issue): boolean {
  return (
    left.repo.toLowerCase() === right.repo.toLowerCase() &&
    left.number === right.number &&
    left.title === right.title &&
    left.author?.id === right.author?.id &&
    left.author?.login === right.author?.login &&
    left.closedAt === right.closedAt &&
    left.stateReason === right.stateReason &&
    left.labels.length === right.labels.length &&
    left.labels.every((label, index) => label === right.labels[index])
  );
}

function normalizedRepoId(repo: RepoId): RepoId {
  return repo.toLowerCase() as RepoId;
}

function latestClosingPullRequest(
  issue: Issue,
  pullRequests: readonly PullRequest[],
  projectsByRepo: ReadonlyMap<RepoId, Project>,
): PullRequest | null {
  let latest: PullRequest | null = null;
  for (const pullRequest of pullRequests) {
    if (
      pullRequest.author === null ||
      projectForRepo(pullRequest.repo, projectsByRepo) === undefined ||
      !qualifiesResolvedIssue(issue, pullRequest)
    ) {
      continue;
    }
    if (
      latest === null ||
      pullRequest.mergedAt > latest.mergedAt ||
      (pullRequest.mergedAt === latest.mergedAt &&
        compareText(pullRequest.id, latest.id) < 0)
    ) {
      latest = pullRequest;
    }
  }
  return latest;
}

function sourceForPullRequest(pullRequest: PullRequest): SourceRef {
  return {
    kind: 'pr',
    number: pullRequest.number,
    title: pullRequest.title,
  };
}

function factBase<K extends Fact['kind']>(
  input: FactBaseInput,
  kind: K,
): Extract<Fact, {readonly kind: K}> {
  return {
    id: input.id,
    project: input.project.id,
    repo: input.repo,
    cycle: cycleId(input.occurredAt),
    actor: input.actor,
    occurredAt: input.occurredAt,
    source: input.source,
    kind,
  } as Extract<Fact, {readonly kind: K}>;
}

/**
 * Returns whether test-file additions or churn meet the material thresholds.
 *
 * Test files are paths in a test, tests, or __tests__ directory; files named
 * *.test.*, *.spec.*, test-* / test_*, or *-test / *_test are also treated as
 * tests. The
 * normalized pull-request file model exposes only the current path, so renamed
 * source paths are not considered separately.
 *
 * @param pullRequest Normalized pull request whose file changes are inspected.
 * @returns Whether its aggregate test-file changes are material.
 */
export function isMaterialTestChange(pullRequest: PullRequest): boolean {
  let additions = 0;
  let churn = 0;

  for (const file of pullRequest.files) {
    if (!isTestPath(file.path)) continue;
    additions += file.additions;
    churn += file.additions + file.deletions;
  }

  return (
    additions >= SCORE_RULES.materialTestThresholds.additions &&
    churn >= SCORE_RULES.materialTestThresholds.churn
  );
}

function isTestPath(path: string): boolean {
  const normalizedPath = path.replaceAll('\\', '/').toLowerCase();
  const segments = normalizedPath.split('/');
  const filename = segments.at(-1) ?? '';
  const inTestDirectory = segments
    .slice(0, -1)
    .some(
      segment =>
        segment === 'test' || segment === 'tests' || segment === '__tests__',
    );

  return (
    inTestDirectory ||
    /(?:^|\.)(?:test|spec)\.[^.]+$/.test(filename) ||
    /^(?:test[-_].+|.+[-_]test)\.[^.]+$/.test(filename)
  );
}

/**
 * Returns whether a submitted review is eligible for substantive-review score.
 *
 * Normalized null actors represent identities that are not known humans. A
 * review is meaningful when it has at least 50 written characters or one
 * inline comment. Scoring caps remain a later scoring concern.
 *
 * @param review Normalized review to qualify.
 * @param pullRequest Merged pull request on which the review was submitted.
 * @returns Whether the review is a substantive review by another known actor.
 */
export function isSubstantiveReview(
  review: Review,
  pullRequest: PullRequest,
): boolean {
  const pullRequestAuthor = pullRequest.author;
  const reviewer = review.author;
  if (pullRequestAuthor === null || reviewer === null) return false;

  return (
    reviewer.id !== pullRequestAuthor.id &&
    review.submittedAt < pullRequest.mergedAt &&
    (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED') &&
    (review.bodyLength >= MIN_SUBSTANTIVE_REVIEW_BODY_LENGTH ||
      review.inlineComments > 0)
  );
}

function firstSubstantiveReviewsByActor(
  pullRequest: PullRequest,
): readonly Review[] {
  const firstByActor = new Map<string, Review>();
  for (const review of [...pullRequest.reviews].sort(
    (left, right) =>
      compareText(left.submittedAt, right.submittedAt) ||
      compareText(left.id, right.id),
  )) {
    if (!isSubstantiveReview(review, pullRequest) || review.author === null) {
      continue;
    }
    if (!firstByActor.has(review.author.id)) {
      firstByActor.set(review.author.id, review);
    }
  }
  return [...firstByActor.values()];
}

/**
 * Returns whether a merged pull request confirms an issue was resolved.
 *
 * The pull request's normalized closing-issue reference is the positive
 * signal. Labels are deliberately not accepted as a fallback: a manually
 * closed issue without a merged closing pull request does not qualify.
 * Explicit NOT_PLANNED closures never qualify, regardless of that reference.
 * The issue reporter does not control attribution; deriveFacts credits the
 * verified closing pull-request author.
 *
 * @param issue Normalized closed issue to qualify.
 * @param pullRequest Merged pull request claimed to have closed the issue.
 * @returns Whether the issue is a confirmed resolved outcome.
 */
export function qualifiesResolvedIssue(
  issue: Issue,
  pullRequest: PullRequest,
): boolean {
  return (
    pullRequest.author !== null &&
    issue.stateReason !== 'NOT_PLANNED' &&
    pullRequest.mergedAt <= issue.closedAt &&
    pullRequest.closedIssueIds.includes(issue.id)
  );
}

/**
 * Converts a pull request's verified evidence into independently scored facts.
 *
 * At most one verified artifact per evidence category produces a fact. When a
 * category has several artifacts, the lowest digest wins deterministically.
 * Facts are credited to the pull-request author at the deterministic merge
 * timestamp; pull requests without a known author cannot produce evidence
 * facts.
 *
 * @param pullRequest Normalized merged pull request containing verified evidence.
 * @param project Project that owns the pull request's repository.
 * @returns Deterministically ordered, identity-deduplicated evidence facts.
 */
export function evidenceFacts(
  pullRequest: PullRequest,
  project: Project,
): readonly Extract<Fact, {readonly kind: 'evidence'}>[] {
  const actor = pullRequest.author;
  if (actor === null) return [];

  const evidenceByKind = new Map<Evidence['kind'], Evidence>();
  for (const evidence of pullRequest.evidence) {
    const accepted = evidenceByKind.get(evidence.kind);
    if (accepted === undefined || evidence.sha256 < accepted.sha256) {
      evidenceByKind.set(evidence.kind, evidence);
    }
  }

  return [...evidenceByKind.values()]
    .sort((left, right) => compareText(left.kind, right.kind))
    .map(evidence => ({
      ...factBase(
        {
          id: `evidence:${pullRequest.id}:${evidence.kind}:${evidence.sha256}`,
          project,
          repo: pullRequest.repo,
          actor,
          occurredAt: pullRequest.mergedAt,
          source: sourceForPullRequest(pullRequest),
        },
        'evidence',
      ),
      evidenceKind: evidence.kind,
    }));
}

function compareFacts(left: Fact, right: Fact): number {
  return (
    compareText(left.occurredAt, right.occurredAt) ||
    compareText(left.id, right.id)
  );
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertUniqueFactIds(facts: readonly Fact[]): void {
  const ids = new Set<string>();
  for (const fact of facts) {
    if (ids.has(fact.id)) {
      throw new TypeError(`Duplicate deterministic fact id "${fact.id}".`);
    }
    ids.add(fact.id);
  }
}
