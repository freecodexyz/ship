import {SCORE_RULES} from './constants.js';
import {cycleBounds} from './time.js';
import type {
  Award,
  Project,
  RepoId,
  RewardContributor,
  RunReceipt,
  ScoreBucket,
} from './types.js';

const BASIS_POINTS_SCALE = 10_000;
const CANONICAL_INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;

/**
 * Derives compute-adjusted reward weights without changing canonical scoring.
 *
 * One receipt can support several awards from the same accepted outcome, but
 * its tokens are credited only once. A linked outcome must agree on project,
 * repository, cycle, and stable actor identity before it can affect a bucket.
 * Adjusted weights use basis-point-scaled score units so later proportional
 * allocation can remain integer-only.
 *
 * @param buckets Canonical score buckets to derive reward weights for.
 * @param awards Accepted score-bearing outcomes.
 * @param receipts Accepted, validated, and deduplicated run receipts.
 * @param projects Validated project configurations.
 * @returns Reward contributors in the same deterministic order as `buckets`.
 */
export function computeRewardWeights(
  buckets: readonly ScoreBucket[],
  awards: readonly Award[],
  receipts: readonly RunReceipt[],
  projects: readonly Project[],
): RewardContributor[] {
  const creditedTokensByBucket = indexCreditedTokens(
    awards,
    receipts,
    projects,
  );

  return buckets.map(bucket => {
    assertCanonicalScore(bucket.score);

    const creditedTokens = creditedTokensByBucket.get(bucketKey(bucket)) ?? 0;
    const computeBonusBasisPoints = computeTokenBonus(creditedTokens);
    const adjustedWeight =
      bucket.score === 0
        ? 0
        : safeNumber(
            BigInt(bucket.score) *
              BigInt(BASIS_POINTS_SCALE + computeBonusBasisPoints),
            'Adjusted reward weight',
          );

    return {
      project: bucket.project,
      cycle: bucket.cycle,
      actorId: bucket.actor.id,
      canonicalScore: bucket.score,
      creditedTokens,
      computeBonusBasisPoints,
      adjustedWeight,
      projectedBaseUnits: '0',
    };
  });
}

/**
 * Allocates one project's UTC monthly reward pool by adjusted weight.
 *
 * Amounts are calculated with the largest-remainder method. Equal remainders
 * are resolved by stable actor id, while the returned contributor order stays
 * the same as the input order. This function only projects amounts; it does not
 * perform or schedule payments.
 *
 * @param project The project whose configured monthly pool is allocated.
 * @param cycle The UTC calendar month receiving the allocation.
 * @param contributors Reward weights for exactly this project and cycle.
 * @returns New contributor values with projected ERC-20 base-unit allocations.
 */
export function allocateMonthlyPool(
  project: Project,
  cycle: ScoreBucket['cycle'],
  contributors: readonly RewardContributor[],
): RewardContributor[] {
  const {from: cycleStartsAt} = cycleBounds(cycle);
  assertAllocationScope(project, cycle, contributors);

  const configuredReward = project.reward;
  const availablePool =
    configuredReward === undefined || configuredReward.startsAt > cycleStartsAt
      ? 0n
      : parseBaseUnits(configuredReward.monthlyPoolBaseUnits);
  const weightedContributors = contributors.map(contributor => ({
    actorId: contributor.actorId,
    contributor,
    weight: parseAdjustedWeight(contributor.adjustedWeight),
  }));
  const totalWeight = weightedContributors.reduce(
    (sum, contributor) => sum + contributor.weight,
    0n,
  );

  if (availablePool === 0n || totalWeight === 0n) {
    return contributors.map(contributor => ({
      ...contributor,
      projectedBaseUnits: '0',
    }));
  }

  const allocations = weightedContributors.map(contributor => {
    const weightedPool = availablePool * contributor.weight;
    return {
      ...contributor,
      amount: weightedPool / totalWeight,
      remainder: weightedPool % totalWeight,
    };
  });
  const allocated = allocations.reduce(
    (sum, allocation) => sum + allocation.amount,
    0n,
  );
  let remaining = availablePool - allocated;

  const remainderOrder = [...allocations].sort(
    (left, right) =>
      compareBigIntDescending(left.remainder, right.remainder) ||
      compareActorId(left.actorId, right.actorId),
  );
  for (const allocation of remainderOrder) {
    if (remaining === 0n) break;
    if (allocation.weight === 0n) continue;
    allocation.amount += 1n;
    remaining -= 1n;
  }

  if (remaining !== 0n) {
    throw new Error('Monthly reward allocation did not conserve the pool.');
  }

  return allocations.map(allocation => ({
    ...allocation.contributor,
    projectedBaseUnits: allocation.amount.toString(),
  }));
}

function assertAllocationScope(
  project: Project,
  cycle: ScoreBucket['cycle'],
  contributors: readonly RewardContributor[],
): void {
  const actorIds = new Set<string>();

  for (const contributor of contributors) {
    if (contributor.project !== project.id || contributor.cycle !== cycle) {
      throw new TypeError(
        'Monthly allocation contributors must share the requested project and cycle.',
      );
    }
    if (actorIds.has(contributor.actorId)) {
      throw new TypeError(
        'Monthly allocation contributors must have unique actor ids.',
      );
    }
    actorIds.add(contributor.actorId);
  }
}

function parseBaseUnits(value: string): bigint {
  if (!CANONICAL_INTEGER_PATTERN.test(value)) {
    throw new TypeError(
      'Monthly reward pool must be a canonical non-negative integer string.',
    );
  }
  return BigInt(value);
}

function parseAdjustedWeight(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(
      'Adjusted reward weight must be a non-negative safe integer.',
    );
  }
  return BigInt(value);
}

function compareBigIntDescending(left: bigint, right: bigint): number {
  if (left > right) return -1;
  if (left < right) return 1;
  return 0;
}

function compareActorId(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function indexCreditedTokens(
  awards: readonly Award[],
  receipts: readonly RunReceipt[],
  projects: readonly Project[],
): ReadonlyMap<string, number> {
  const awardsByRunId = new Map<string, Award[]>();
  for (const award of awards) {
    if (award.runId === undefined) continue;
    const linkedAwards = awardsByRunId.get(award.runId) ?? [];
    linkedAwards.push(award);
    awardsByRunId.set(award.runId, linkedAwards);
  }

  const projectsById = indexProjects(projects);
  const uniqueReceipts = indexUniqueReceipts(receipts);
  const creditedTokensByBucket = new Map<string, number>();

  for (const receipt of uniqueReceipts.values()) {
    const linkedAwards = awardsByRunId.get(receipt.runId);
    if (linkedAwards === undefined || linkedAwards.length === 0) continue;

    const project = projectsById.get(receipt.project);
    if (
      project === undefined ||
      !projectOwnsRepository(project, receipt.repo) ||
      !isConsistentOutcome(linkedAwards, receipt)
    ) {
      continue;
    }

    const acceptedAward = linkedAwards[0];
    if (acceptedAward === undefined) continue;

    const key = awardBucketKey(acceptedAward);
    const creditedForOutcome = Math.min(
      receipt.usage.totalTokens,
      SCORE_RULES.computeReward.creditedTokensPerOutcomeCap,
    );
    const current = creditedTokensByBucket.get(key) ?? 0;
    const next = current + creditedForOutcome;
    if (!Number.isSafeInteger(next)) {
      throw new RangeError('Credited token total exceeds safe integer range.');
    }
    creditedTokensByBucket.set(key, next);
  }

  return creditedTokensByBucket;
}

function indexProjects(
  projects: readonly Project[],
): ReadonlyMap<Project['id'], Project> {
  const projectsById = new Map<Project['id'], Project>();
  const duplicateIds = new Set<Project['id']>();

  for (const project of projects) {
    if (projectsById.has(project.id)) duplicateIds.add(project.id);
    projectsById.set(project.id, project);
  }
  for (const duplicateId of duplicateIds) projectsById.delete(duplicateId);

  return projectsById;
}

function indexUniqueReceipts(
  receipts: readonly RunReceipt[],
): ReadonlyMap<RunReceipt['runId'], RunReceipt> {
  const receiptsByRunId = new Map<RunReceipt['runId'], RunReceipt>();
  const duplicateRunIds = new Set<RunReceipt['runId']>();

  for (const receipt of receipts) {
    if (receiptsByRunId.has(receipt.runId)) duplicateRunIds.add(receipt.runId);
    receiptsByRunId.set(receipt.runId, receipt);
  }
  for (const duplicateRunId of duplicateRunIds) {
    receiptsByRunId.delete(duplicateRunId);
  }

  return receiptsByRunId;
}

function isConsistentOutcome(
  awards: readonly Award[],
  receipt: RunReceipt,
): boolean {
  const first = awards[0];
  if (first === undefined) return false;

  return awards.every(
    award =>
      Number.isSafeInteger(award.points) &&
      award.points > 0 &&
      award.project === receipt.project &&
      sameRepository(award.repo, receipt.repo) &&
      award.project === first.project &&
      sameRepository(award.repo, first.repo) &&
      award.cycle === first.cycle &&
      award.actor.id === first.actor.id,
  );
}

function projectOwnsRepository(project: Project, repo: RepoId): boolean {
  return project.repositories.some(repository =>
    sameRepository(repository.id, repo),
  );
}

function sameRepository(left: RepoId, right: RepoId): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function computeTokenBonus(creditedTokens: number): number {
  const boundedTokens = Math.min(
    creditedTokens,
    SCORE_RULES.computeReward.saturationTokens,
  );

  return Number(
    (BigInt(boundedTokens) *
      BigInt(SCORE_RULES.computeReward.maximumBonusBasisPoints)) /
      BigInt(SCORE_RULES.computeReward.saturationTokens),
  );
}

function bucketKey(bucket: ScoreBucket): string {
  return compositeBucketKey(bucket.project, bucket.cycle, bucket.actor.id);
}

function awardBucketKey(award: Award): string {
  return compositeBucketKey(award.project, award.cycle, award.actor.id);
}

function compositeBucketKey(
  project: string,
  cycle: string,
  actorId: string,
): string {
  return JSON.stringify([project, cycle, actorId]);
}

function assertCanonicalScore(score: number): void {
  if (!Number.isSafeInteger(score) || score < 0) {
    throw new TypeError('Canonical score must be a non-negative safe integer.');
  }
}

function safeNumber(value: bigint, description: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${description} exceeds safe integer range.`);
  }
  return Number(value);
}
