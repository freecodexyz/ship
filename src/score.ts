import {SCORE_RULES} from './constants.js';
import type {
  Award,
  Fact,
  ScoreBreakdown,
  ScoreBucket,
  ScoreCounts,
} from './types.js';

type ScoreResult = {
  readonly awards: Award[];
  readonly buckets: ScoreBucket[];
};

type MutableScoreBreakdown = {
  -readonly [Category in keyof ScoreBreakdown]: ScoreBreakdown[Category];
};

type MutableScoreCounts = {
  -readonly [Category in keyof ScoreCounts]: ScoreCounts[Category];
};

type MutableScoreBucket = {
  readonly project: ScoreBucket['project'];
  readonly cycle: ScoreBucket['cycle'];
  readonly actor: ScoreBucket['actor'];
  score: number;
  readonly breakdown: MutableScoreBreakdown;
  readonly counts: MutableScoreCounts;
};

/**
 * Applies per-actor, per-project, per-cycle scoring caps to qualified facts.
 *
 * Facts are selected newest-first, with deterministic fact id as the tie-breaker,
 * so category caps retain the latest qualifying outcomes. Emitted awards are
 * returned in chronological order for stable audit output.
 *
 * @param facts Qualified semantic facts without cap state.
 * @returns The capped audit awards and their independently scoped buckets.
 */
export function scoreFacts(facts: readonly Fact[]): ScoreResult {
  const sortedFacts = [...facts].sort(compareFactsNewest);
  const bucketsByKey = new Map<string, MutableScoreBucket>();
  const awards: Award[] = [];

  for (const fact of sortedFacts) {
    const key = bucketKey(fact.project, fact.cycle, fact.actor.id);
    let bucket = bucketsByKey.get(key);
    if (bucket === undefined) {
      bucket = createBucket(fact);
      bucketsByKey.set(key, bucket);
    }

    const points = pointsForFact(fact, bucket);
    if (points > 0) applyAward(bucket, fact, points, awards);
  }

  awards.sort(compareFacts);
  const buckets = [...bucketsByKey.values()].sort(compareBuckets);
  validateScoringInvariants(buckets, awards);
  return {awards, buckets};
}

/**
 * Creates a plain, empty score bucket scoped to the supplied fact.
 *
 * @param fact Fact providing the project, cycle, and actor identity.
 * @returns A serializable score bucket with every category initialized.
 */
export function createBucket(fact: Fact): ScoreBucket {
  return {
    project: fact.project,
    cycle: fact.cycle,
    actor: fact.actor,
    score: 0,
    breakdown: {
      merged_pr: 0,
      resolved_issue: 0,
      test_change: 0,
      evidence: 0,
      review: 0,
      evaluation: 0,
    },
    counts: {
      merged_pr: 0,
      resolved_issue: 0,
      test_change: 0,
      review: 0,
      evaluation: 0,
    },
  };
}

function pointsForFact(fact: Fact, bucket: MutableScoreBucket): number {
  switch (fact.kind) {
    case 'merged_pr':
      return belowCountCap(
        bucket.counts.merged_pr,
        SCORE_RULES.mergedPullRequest.countCap,
      )
        ? SCORE_RULES.mergedPullRequest.points
        : 0;
    case 'resolved_issue':
      return belowCountCap(
        bucket.counts.resolved_issue,
        SCORE_RULES.resolvedIssue.countCap,
      )
        ? SCORE_RULES.resolvedIssue.points
        : 0;
    case 'test_change':
      return belowCountCap(
        bucket.counts.test_change,
        SCORE_RULES.materialTestChange.countCap,
      )
        ? SCORE_RULES.materialTestChange.points
        : 0;
    case 'evidence': {
      const remainingCapacity =
        SCORE_RULES.evidence.pointCap - bucket.breakdown.evidence;
      return Math.max(
        0,
        Math.min(
          SCORE_RULES.evidence.weights[fact.evidenceKind],
          remainingCapacity,
        ),
      );
    }
    case 'review':
      return belowCountCap(
        bucket.counts.review,
        SCORE_RULES.substantiveReview.countCap,
      )
        ? SCORE_RULES.substantiveReview.points
        : 0;
    case 'evaluation':
      if (
        !Number.isSafeInteger(fact.evaluationPoints) ||
        fact.evaluationPoints <= 0
      ) {
        throw new TypeError(
          `Evaluation fact "${fact.id}" must have positive integer points.`,
        );
      }
      return belowCountCap(
        bucket.counts.evaluation,
        SCORE_RULES.evaluatedContribution.countCap,
      )
        ? Math.min(
            fact.evaluationPoints,
            SCORE_RULES.evaluatedContribution.maximumPoints,
          )
        : 0;
    default:
      return assertNever(fact);
  }
}

function belowCountCap(count: number, cap: number): boolean {
  return count < cap;
}

/**
 * Records an already-approved positive point award in its bucket and ledger.
 *
 * Qualification and cap decisions belong to the caller. This function only
 * keeps the bucket's category, accepted count, total, and award ledger in sync.
 *
 * @param bucket Mutable in-progress bucket receiving the award.
 * @param fact Qualified fact identifying the category and award details.
 * @param points Positive safe integer points already approved by the caller.
 * @param awards Mutable ledger receiving exactly one corresponding award.
 */
export function applyAward(
  bucket: MutableScoreBucket,
  fact: Fact,
  points: number,
  awards: Award[],
): void {
  if (!Number.isSafeInteger(points) || points <= 0) {
    throw new TypeError('Award points must be a positive safe integer.');
  }

  switch (fact.kind) {
    case 'merged_pr':
      bucket.breakdown.merged_pr += points;
      bucket.counts.merged_pr += 1;
      break;
    case 'resolved_issue':
      bucket.breakdown.resolved_issue += points;
      bucket.counts.resolved_issue += 1;
      break;
    case 'test_change':
      bucket.breakdown.test_change += points;
      bucket.counts.test_change += 1;
      break;
    case 'evidence':
      bucket.breakdown.evidence += points;
      break;
    case 'review':
      bucket.breakdown.review += points;
      bucket.counts.review += 1;
      break;
    case 'evaluation':
      bucket.breakdown.evaluation += points;
      bucket.counts.evaluation += 1;
      break;
    default:
      assertNever(fact);
  }

  bucket.score += points;
  awards.push({...fact, points});
}

/**
 * Verifies that generated buckets and their award ledger obey scoring policy.
 *
 * @param buckets Final score buckets to validate.
 * @param awards Audit awards that must exactly fund the matching buckets.
 */
export function validateScoringInvariants(
  buckets: readonly ScoreBucket[],
  awards: readonly Award[],
): void {
  const awardPointsByBucket = new Map<string, number>();
  for (const award of awards) {
    assertPositiveSafeInteger(award.points, 'Award points');
    const key = bucketKey(award.project, award.cycle, award.actor.id);
    awardPointsByBucket.set(
      key,
      (awardPointsByBucket.get(key) ?? 0) + award.points,
    );
  }

  const bucketKeys = new Set<string>();
  for (const bucket of buckets) {
    const key = bucketKey(bucket.project, bucket.cycle, bucket.actor.id);
    if (bucketKeys.has(key)) {
      throw new Error(`Duplicate score bucket for ${key}.`);
    }
    bucketKeys.add(key);

    assertNonNegativeSafeInteger(bucket.score, 'Bucket score');
    const breakdownTotal = sumBreakdown(bucket.breakdown);
    if (bucket.score !== breakdownTotal) {
      throw new Error('Score bucket does not equal its category breakdown.');
    }

    validateCount(
      bucket.counts.merged_pr,
      SCORE_RULES.mergedPullRequest.countCap,
      'Merged pull request',
    );
    validateCount(
      bucket.counts.resolved_issue,
      SCORE_RULES.resolvedIssue.countCap,
      'Resolved issue',
    );
    validateCount(
      bucket.counts.test_change,
      SCORE_RULES.materialTestChange.countCap,
      'Material test change',
    );
    validateCount(
      bucket.counts.review,
      SCORE_RULES.substantiveReview.countCap,
      'Substantive review',
    );
    validateCount(
      bucket.counts.evaluation,
      SCORE_RULES.evaluatedContribution.countCap,
      'Evaluation',
    );

    if (bucket.breakdown.evidence > SCORE_RULES.evidence.pointCap) {
      throw new Error('Evidence points exceed their configured cap.');
    }

    const minimumEvaluationPoints = bucket.counts.evaluation;
    const maximumEvaluationPoints =
      bucket.counts.evaluation *
      SCORE_RULES.evaluatedContribution.maximumPoints;
    if (
      bucket.breakdown.evaluation < minimumEvaluationPoints ||
      bucket.breakdown.evaluation > maximumEvaluationPoints
    ) {
      throw new Error(
        'Evaluation points cannot be produced by the accepted event count.',
      );
    }

    if (bucket.score > theoreticalMaximumScore()) {
      throw new Error('Score bucket exceeds the theoretical maximum.');
    }

    validateFixedCategory(
      bucket.breakdown.merged_pr,
      bucket.counts.merged_pr,
      SCORE_RULES.mergedPullRequest.points,
      'Merged pull request',
    );
    validateFixedCategory(
      bucket.breakdown.resolved_issue,
      bucket.counts.resolved_issue,
      SCORE_RULES.resolvedIssue.points,
      'Resolved issue',
    );
    validateFixedCategory(
      bucket.breakdown.test_change,
      bucket.counts.test_change,
      SCORE_RULES.materialTestChange.points,
      'Material test change',
    );
    validateFixedCategory(
      bucket.breakdown.review,
      bucket.counts.review,
      SCORE_RULES.substantiveReview.points,
      'Substantive review',
    );

    if (bucket.score !== (awardPointsByBucket.get(key) ?? 0)) {
      throw new Error('Score bucket does not equal its matching awards.');
    }
    awardPointsByBucket.delete(key);
  }

  if (awardPointsByBucket.size > 0) {
    throw new Error('An award does not have a matching score bucket.');
  }
}

function sumBreakdown(breakdown: ScoreBreakdown): number {
  const values = [
    breakdown.merged_pr,
    breakdown.resolved_issue,
    breakdown.test_change,
    breakdown.evidence,
    breakdown.review,
    breakdown.evaluation,
  ] as const;
  for (const points of values) {
    assertNonNegativeSafeInteger(points, 'Score breakdown points');
  }
  return values.reduce((total, points) => total + points, 0);
}

function validateCount(count: number, cap: number, category: string): void {
  assertNonNegativeSafeInteger(count, `${category} count`);
  if (count > cap) {
    throw new Error(`${category} count exceeds its configured cap.`);
  }
}

function validateFixedCategory(
  points: number,
  count: number,
  pointsPerEvent: number,
  category: string,
): void {
  if (points !== count * pointsPerEvent) {
    throw new Error(`${category} points do not match its accepted count.`);
  }
}

function theoreticalMaximumScore(): number {
  return (
    SCORE_RULES.mergedPullRequest.points *
      SCORE_RULES.mergedPullRequest.countCap +
    SCORE_RULES.resolvedIssue.points * SCORE_RULES.resolvedIssue.countCap +
    SCORE_RULES.materialTestChange.points *
      SCORE_RULES.materialTestChange.countCap +
    SCORE_RULES.substantiveReview.points *
      SCORE_RULES.substantiveReview.countCap +
    SCORE_RULES.evidence.pointCap +
    SCORE_RULES.evaluatedContribution.maximumPoints *
      SCORE_RULES.evaluatedContribution.countCap
  );
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
}

function bucketKey(project: string, cycle: string, actorId: string): string {
  return JSON.stringify([project, cycle, actorId]);
}

function compareFacts(left: Fact, right: Fact): number {
  return (
    compareText(left.occurredAt, right.occurredAt) ||
    compareText(left.id, right.id)
  );
}

function compareFactsNewest(left: Fact, right: Fact): number {
  return (
    compareText(right.occurredAt, left.occurredAt) ||
    compareText(right.id, left.id)
  );
}

function compareBuckets(left: ScoreBucket, right: ScoreBucket): number {
  return (
    compareText(left.project, right.project) ||
    compareText(left.cycle, right.cycle) ||
    compareText(left.actor.id, right.actor.id)
  );
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled fact kind: ${JSON.stringify(value)}`);
}
