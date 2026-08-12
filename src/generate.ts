import {createGitHubClient, type GitHubClient} from './github.js';
import {deriveFacts} from './facts.js';
import {loadProjects, projectForRepo} from './projects.js';
import {dedupeReceipts, validateReceipt} from './receipts.js';
import {allocateMonthlyPool, computeRewardWeights} from './rewards.js';
import {scoreFacts, validateScoringInvariants} from './score.js';
import {buildSnapshot, validateSnapshot, writeSnapshot} from './snapshot.js';
import {parseCanonicalTimestamp, type CanonicalTimestamp} from './time.js';
import type {
  Actor,
  CollectionWindow,
  Issue,
  Project,
  PullRequest,
  RepoId,
  RewardContributor,
  RunReceipt,
  Snapshot,
} from './types.js';

const DEFAULT_COLLECTION_WINDOW_DAYS = 35;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

type GenerationInputs = {
  readonly githubToken?: string;
  readonly log?: (message: string) => void;
  readonly projectsDirectory?: string;
  readonly outputPath?: string;
  readonly now?: string;
  readonly includeRewards?: boolean;
  readonly githubClient?: GitHubClient;
};

type GenerationWindow =
  | {
      readonly collectionWindowDays?: number;
      readonly window?: never;
    }
  | {
      readonly collectionWindowDays?: never;
      readonly window: CollectionWindow;
    };

/** Inputs and the narrow GitHub seam required to run one generation. */
export type GenerationOptions = GenerationInputs & GenerationWindow;

type GeneratedSnapshot = Snapshot & {
  readonly rewards?: readonly RewardContributor[];
};

type AttributedReceipt = {
  readonly receipt: RunReceipt;
  readonly actor: Actor;
};

/**
 * Runs the complete generation pipeline from validated configuration to disk.
 *
 * @param options Runtime inputs and an optional normalized GitHub data source.
 * @returns The validated snapshot written to the configured output path.
 */
export async function generate(
  options: GenerationOptions,
): Promise<GeneratedSnapshot> {
  options.log?.('Loading project configuration...');
  const {projects, projectsByRepo} = await loadProjects(
    options.projectsDirectory,
  );
  const generatedAt = generationTimestamp(options.now);
  const window = collectionWindow(options, generatedAt);
  options.log?.(
    `Collecting ${projects.length} projects from ${window.from} to ${window.to}.`,
  );

  const github = githubClient(options);
  const pullRequests: PullRequest[] = [];
  const issues: Issue[] = [];
  for (const [index, project] of projects.entries()) {
    options.log?.(
      `Collecting project ${index + 1}/${projects.length}: ${project.id}...`,
    );
    const records = await github.collect(project.repositories, window);
    pullRequests.push(...records.pullRequests);
    issues.push(...records.issues);
    options.log?.(
      `Collected ${project.id}: ${records.pullRequests.length} pull requests, ` +
        `${records.issues.length} issues.`,
    );
  }

  options.log?.(
    `Scoring ${pullRequests.length} pull requests and ${issues.length} issues...`,
  );
  const receipts = acceptedReceipts(pullRequests, projectsByRepo);
  const facts = deriveFacts(projects, pullRequests, issues).filter(
    fact => fact.occurredAt >= window.from && fact.occurredAt < window.to,
  );
  const {buckets, awards} = scoreFacts(facts);
  validateScoringInvariants(buckets, awards);

  const rewards = options.includeRewards
    ? projectRewards(projects, buckets, awards, receipts)
    : undefined;
  const snapshot = buildSnapshot(
    generatedAt,
    window,
    projects,
    buckets,
    awards,
    receipts,
    rewards,
  );
  const validated = validateSnapshot(snapshot);
  const outputPath = options.outputPath ?? 'dist/snapshot.json';
  options.log?.(
    `Validated ${buckets.length} buckets and ${awards.length} awards; ` +
      `writing ${outputPath}...`,
  );

  if (options.outputPath === undefined) {
    await writeSnapshot(validated);
  } else {
    await writeSnapshot(validated, options.outputPath);
  }
  options.log?.(`Wrote ${outputPath}.`);
  return validated;
}

function githubClient(options: GenerationOptions): GitHubClient {
  if (options.githubClient !== undefined) return options.githubClient;
  if (options.githubToken === undefined) {
    throw new TypeError(
      'Generation requires a GitHub token or an injected GitHub client.',
    );
  }

  return createGitHubClient({
    token: options.githubToken,
    ...(options.log === undefined ? {} : {log: options.log}),
  });
}

function generationTimestamp(now: string | undefined): CanonicalTimestamp {
  return parseCanonicalTimestamp(now ?? new Date().toISOString());
}

function collectionWindow(
  options: GenerationOptions,
  generatedAt: CanonicalTimestamp,
): CollectionWindow {
  if (options.window !== undefined) {
    if (options.collectionWindowDays !== undefined) {
      throw new TypeError(
        'Generation accepts either an explicit window or collection-window days.',
      );
    }
    const from = parseCanonicalTimestamp(options.window.from);
    const to = parseCanonicalTimestamp(options.window.to);
    if (from >= to) {
      throw new TypeError('Generation window.from must precede window.to.');
    }
    return {from, to};
  }

  const days = options.collectionWindowDays ?? DEFAULT_COLLECTION_WINDOW_DAYS;
  if (!Number.isSafeInteger(days) || days <= 0) {
    throw new TypeError(
      'Generation collectionWindowDays must be a positive safe integer.',
    );
  }
  const fromMilliseconds =
    Date.parse(generatedAt) - days * MILLISECONDS_PER_DAY;
  if (!Number.isFinite(fromMilliseconds)) {
    throw new RangeError('Generation collection window is outside Date range.');
  }

  return {
    from: parseCanonicalTimestamp(new Date(fromMilliseconds).toISOString()),
    to: generatedAt,
  };
}

function acceptedReceipts(
  pullRequests: Parameters<typeof deriveFacts>[1],
  projectsByRepo: ReadonlyMap<RepoId, Project>,
): RunReceipt[] {
  const attributed: AttributedReceipt[] = [];

  for (const pullRequest of pullRequests) {
    if (pullRequest.receipt === undefined || pullRequest.author === null) {
      continue;
    }
    const project = projectForRepo(pullRequest.repo, projectsByRepo);
    if (project === undefined) continue;

    try {
      attributed.push({
        receipt: validateReceipt(pullRequest.receipt, project, pullRequest),
        actor: pullRequest.author,
      });
    } catch {
      // A bad optional receipt cannot remove independently earned GitHub score.
    }
  }

  return dedupeReceipts(attributed);
}

function projectRewards(
  projects: readonly Project[],
  buckets: Parameters<typeof computeRewardWeights>[0],
  awards: Parameters<typeof computeRewardWeights>[1],
  receipts: readonly RunReceipt[],
): RewardContributor[] {
  const weights = computeRewardWeights(buckets, awards, receipts, projects);
  const allocated: RewardContributor[] = [];

  for (const project of projects) {
    const cycles = new Set(
      weights
        .filter(contributor => contributor.project === project.id)
        .map(contributor => contributor.cycle),
    );
    for (const cycle of [...cycles].sort()) {
      const contributors = weights.filter(
        contributor =>
          contributor.project === project.id && contributor.cycle === cycle,
      );
      allocated.push(...allocateMonthlyPool(project, cycle, contributors));
    }
  }

  return allocated;
}
