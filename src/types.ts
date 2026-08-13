import type {CanonicalTimestamp} from './time.js';

/** A GitHub repository identifier in canonical `owner/name` form. */
export type RepoId = `${string}/${string}`;

/** A GitHub contributor identified authoritatively by their stable node id. */
export type Actor = {
  readonly id: string;
  readonly login: string;
};

/** Complete validated configuration for one contribution project. */
export type Project = {
  readonly id: Lowercase<string>;
  readonly name: string;
  readonly mission: string;
  readonly repositories: readonly ProjectRepository[];
  readonly reward?: RewardConfig;
  readonly allowedModels: readonly ProjectModel[];
};

/** A GitHub repository and the integration branch accepted by a project. */
export type ProjectRepository = {
  readonly id: RepoId;
  readonly branch: string;
};

/** An agent client, provider, and model tuple allowed by a project. */
export type ProjectModel = {
  readonly client: 'codex' | 'claude-code';
  readonly provider: string;
  readonly model: string;
};

/** An ERC-20 token used for project reward allocation. */
export type RewardToken = {
  readonly address: `0x${string}`;
  readonly decimals: number;
  readonly symbol: string;
};

/** The monthly ERC-20 reward policy for a project. */
export type RewardConfig = {
  readonly startsAt: CanonicalTimestamp;
  readonly token: RewardToken;
  /** A canonical integer amount in the token's smallest indivisible unit. */
  readonly monthlyPoolBaseUnits: string;
};

/** The inclusive start and exclusive end of collected GitHub data. */
export type CollectionWindow = {
  readonly from: CanonicalTimestamp;
  readonly to: CanonicalTimestamp;
};

/** A merged GitHub pull request normalized for deterministic scoring. */
export type PullRequest = {
  readonly id: string;
  readonly repo: RepoId;
  readonly number: number;
  readonly title: string;
  readonly author: Actor | null;
  readonly mergedAt: CanonicalTimestamp;
  readonly headSha: string;
  readonly files: readonly PullRequestFile[];
  readonly closedIssueIds: readonly string[];
  readonly reviews: readonly Review[];
  readonly evidence: readonly Evidence[];
  readonly receipt?: RunReceipt;
};

/** A repository-relative file change used by deterministic qualification rules. */
export type PullRequestFile = {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
};

/** A submitted GitHub pull-request review normalized for scoring qualification. */
export type Review = {
  readonly id: string;
  readonly author: Actor | null;
  readonly state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';
  readonly submittedAt: CanonicalTimestamp;
  readonly bodyLength: number;
  readonly inlineComments: number;
};

/** A closed GitHub issue normalized for resolved-work qualification. */
export type Issue = {
  readonly id: string;
  readonly repo: RepoId;
  readonly number: number;
  readonly title: string;
  readonly author: Actor | null;
  readonly closedAt: CanonicalTimestamp;
  readonly stateReason: 'COMPLETED' | 'NOT_PLANNED' | null;
  readonly labels: readonly string[];
};

/** A verified evidence artifact associated with a pull request. */
export type Evidence = {
  readonly kind: 'screenshot' | 'video' | 'logs' | 'trajectory' | 'artifact';
  readonly sha256: string;
};

/** Compute usage reported by a signed run receipt. */
export type Usage =
  | {
      readonly confidence: 'exact' | 'bounded';
      /** A non-negative safe integer. */
      readonly totalTokens: number;
      /** A non-negative integer number of micro-US dollars. */
      readonly costMicroUsd: string;
    }
  | {
      readonly confidence: 'unavailable';
      readonly totalTokens: 0;
      readonly costMicroUsd: '0';
    };

/** The canonical signed receipt for one supported agent run. */
export type RunReceipt = {
  readonly version: 1;
  readonly runId: string;
  readonly project: Project['id'];
  readonly repo: RepoId;
  readonly startedAt: CanonicalTimestamp;
  readonly completedAt: CanonicalTimestamp;
  readonly agent: ProjectModel;
  readonly skill: {
    readonly revision: string;
    readonly sha256: string;
  };
  readonly usage: Usage;
  readonly device: {
    readonly keyId: string;
    readonly publicKey: string;
  };
  readonly trajectorySha256?: string;
  readonly signature: string;
};

/** Shared identity and provenance for an independently scoreable event. */
type FactBase = {
  readonly id: string;
  readonly project: Project['id'];
  readonly repo: RepoId;
  readonly cycle: string;
  readonly actor: Actor;
  readonly occurredAt: CanonicalTimestamp;
  readonly source: SourceRef;
};

/** An independently scoreable event that has passed semantic qualification. */
export type Fact =
  | (FactBase & {readonly kind: 'merged_pr'})
  | (FactBase & {readonly kind: 'resolved_issue'})
  | (FactBase & {readonly kind: 'test_change'})
  | (FactBase & {
      readonly kind: 'evidence';
      readonly evidenceKind: Evidence['kind'];
    })
  | (FactBase & {readonly kind: 'review'})
  | (FactBase & {
      readonly kind: 'evaluation';
      readonly evaluationPoints: number;
    });

/** Compact descriptive provenance for a scoreable GitHub event. */
export type SourceRef = {
  readonly kind: 'pr' | 'issue' | 'review';
  readonly number: number;
  readonly title: string;
};

/** A score-bearing fact retained in the canonical audit ledger. */
export type Award = Fact & {
  readonly points: number;
  readonly runId?: RunReceipt['runId'];
};

/** Per-category point totals for one score bucket. */
export type ScoreBreakdown = {
  readonly merged_pr: number;
  readonly resolved_issue: number;
  readonly test_change: number;
  readonly evidence: number;
  readonly review: number;
  readonly evaluation: number;
};

/** Accepted score-bearing outcome counts used to enforce category caps. */
export type ScoreCounts = {
  readonly merged_pr: number;
  readonly resolved_issue: number;
  readonly test_change: number;
  readonly review: number;
  readonly evaluation: number;
};

/** Canonical score for one actor in one project and UTC calendar month. */
export type ScoreBucket = {
  readonly project: Project['id'];
  readonly cycle: Fact['cycle'];
  readonly actor: Actor;
  readonly score: number;
  readonly breakdown: ScoreBreakdown;
  readonly counts: ScoreCounts;
};

/** Optional reward projection derived from a canonical score bucket. */
export type RewardContributor = {
  readonly project: ScoreBucket['project'];
  readonly cycle: ScoreBucket['cycle'];
  readonly actorId: Actor['id'];
  readonly canonicalScore: ScoreBucket['score'];
  readonly creditedTokens: number;
  readonly computeBonusBasisPoints: number;
  readonly adjustedWeight: number;
  /** ERC-20 smallest-unit integer; reward projections are never scoring input. */
  readonly projectedBaseUnits: string;
};

/** The stable static JSON contract emitted by the generator. */
export type Snapshot = {
  readonly schemaVersion: 3;
  readonly generatedAt: CanonicalTimestamp;
  readonly window: CollectionWindow;
  readonly projects: readonly Project[];
  readonly buckets: readonly ScoreBucket[];
  readonly awards: readonly Award[];
  readonly receipts: readonly RunReceipt[];
};

const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Parses a canonical GitHub repository identifier while preserving its casing.
 *
 * @param value The untrusted value to parse.
 * @returns The validated repository identifier.
 */
export function parseRepoId(value: unknown): RepoId {
  if (typeof value !== 'string' || /\s/.test(value)) {
    throw new TypeError('Repository id must be a canonical owner/name string.');
  }

  const parts = value.split('/');
  if (parts.length !== 2) {
    throw new TypeError('Repository id must contain exactly one slash.');
  }

  const [owner, repository] = parts;
  if (
    owner === undefined ||
    repository === undefined ||
    !GITHUB_OWNER_PATTERN.test(owner) ||
    !GITHUB_REPOSITORY_PATTERN.test(repository)
  ) {
    throw new TypeError('Repository id must be a canonical owner/name string.');
  }

  return value as RepoId;
}
