import {describe, expect, test} from 'bun:test';

import {SCORE_RULES} from '../src/constants.js';
import {allocateMonthlyPool, computeRewardWeights} from '../src/rewards.js';
import {parseCanonicalTimestamp} from '../src/time.js';
import {
  parseRepoId,
  type Actor,
  type Award,
  type Project,
  type RewardContributor,
  type RunReceipt,
  type ScoreBucket,
} from '../src/types.js';

const REPOSITORY = parseRepoId('OpenAI/Ship');
const ACTOR: Actor = {id: 'U_contributor', login: 'contributor'};
const OCCURRED_AT = parseCanonicalTimestamp('2026-08-10T12:00:00.000Z');
const REWARD_STARTS_AT = parseCanonicalTimestamp('2026-08-01T00:00:00.000Z');
const PROJECT: Project = {
  id: 'ship',
  name: 'Ship',
  mission: 'Deliver bounded, reviewable improvements to Ship.',
  repositories: [{id: REPOSITORY, branch: 'main'}],
  allowedModels: [],
};

function bucket(overrides: Partial<ScoreBucket> = {}): ScoreBucket {
  return {
    project: PROJECT.id,
    cycle: '2026-08',
    actor: ACTOR,
    score: 10,
    breakdown: {
      merged_pr: 10,
      resolved_issue: 0,
      test_change: 0,
      evidence: 0,
      review: 0,
      evaluation: 0,
    },
    counts: {
      merged_pr: 1,
      resolved_issue: 0,
      test_change: 0,
      review: 0,
      evaluation: 0,
    },
    ...overrides,
  };
}

function award(
  runId: string,
  overrides: Partial<Extract<Award, {readonly kind: 'merged_pr'}>> = {},
): Extract<Award, {readonly kind: 'merged_pr'}> {
  return {
    id: `award-${runId}`,
    kind: 'merged_pr',
    project: PROJECT.id,
    repo: REPOSITORY,
    cycle: '2026-08',
    actor: ACTOR,
    occurredAt: OCCURRED_AT,
    source: {kind: 'pr', number: 1, title: 'Accepted work'},
    points: 10,
    runId,
    ...overrides,
  };
}

function receipt(
  runId: string,
  totalTokens: number,
  overrides: Partial<RunReceipt> = {},
): RunReceipt {
  return {
    version: 1,
    runId,
    project: PROJECT.id,
    repo: REPOSITORY,
    startedAt: parseCanonicalTimestamp('2026-08-10T11:00:00.000Z'),
    completedAt: OCCURRED_AT,
    agent: {client: 'codex', provider: 'openai', model: 'gpt-5'},
    skill: {revision: 'a'.repeat(40), sha256: 'b'.repeat(64)},
    usage: {confidence: 'exact', totalTokens, costMicroUsd: '1'},
    device: {keyId: 'device', publicKey: 'public-key'},
    signature: 'signature',
    ...overrides,
  };
}

function contributor(
  actorId: string,
  adjustedWeight: number,
): RewardContributor {
  return {
    project: PROJECT.id,
    cycle: '2026-08',
    actorId,
    canonicalScore: 10,
    creditedTokens: 0,
    computeBonusBasisPoints: 0,
    adjustedWeight,
    projectedBaseUnits: '0',
  };
}

function rewardedProject(monthlyPoolBaseUnits: string): Project {
  return {
    ...PROJECT,
    reward: {
      startsAt: REWARD_STARTS_AT,
      token: {address: `0x${'1'.repeat(40)}`, decimals: 18, symbol: 'SHIP'},
      monthlyPoolBaseUnits,
    },
  };
}

describe('computeRewardWeights', () => {
  test('receipts cannot create or modify canonical score', () => {
    const zeroScoreBucket = Object.freeze(
      bucket({
        score: 0,
        breakdown: {
          merged_pr: 0,
          resolved_issue: 0,
          test_change: 0,
          evidence: 0,
          review: 0,
          evaluation: 0,
        },
      }),
    );

    const result = computeRewardWeights(
      [zeroScoreBucket],
      [award('run-1')],
      [receipt('run-1', 100_000)],
      [PROJECT],
    );

    expect(result[0]).toMatchObject({
      canonicalScore: 0,
      creditedTokens: 100_000,
      adjustedWeight: 0,
    });
    expect(zeroScoreBucket.score).toBe(0);
    expect(
      computeRewardWeights([], [], [receipt('orphan-run', 100_000)], [PROJECT]),
    ).toEqual([]);
  });

  test('unrelated receipts contribute no credited tokens', () => {
    const canonicalBucket = bucket();
    const acceptedAward = award('accepted-run');
    const unrelatedReceipts = [
      receipt('different-run', 100_000),
      receipt('accepted-run', 100_000, {project: 'other'}),
      receipt('accepted-run', 100_000, {
        repo: parseRepoId('OpenAI/Unrelated'),
      }),
    ];

    for (const unrelatedReceipt of unrelatedReceipts) {
      const [result] = computeRewardWeights(
        [canonicalBucket],
        [acceptedAward],
        [unrelatedReceipt],
        [PROJECT],
      );

      expect(result?.creditedTokens).toBe(0);
      expect(result?.computeBonusBasisPoints).toBe(0);
      expect(result?.adjustedWeight).toBe(100_000);
    }
  });

  test('applies the token cap once per accepted outcome', () => {
    const awards = [
      award('run-1'),
      award('run-1', {id: 'award-run-1-secondary'}),
      award('run-2'),
    ];
    const receipts = [receipt('run-1', 900_000), receipt('run-2', 900_000)];

    const [result] = computeRewardWeights([bucket()], awards, receipts, [
      PROJECT,
    ]);

    expect(result?.creditedTokens).toBe(
      SCORE_RULES.computeReward.creditedTokensPerOutcomeCap * 2,
    );
  });

  test('bounds the compute bonus at the configured maximum', () => {
    const outcomeCount =
      SCORE_RULES.computeReward.saturationTokens /
        SCORE_RULES.computeReward.creditedTokensPerOutcomeCap +
      1;
    const awards = Array.from({length: outcomeCount}, (_, index) =>
      award(`run-${index}`),
    );
    const receipts = Array.from({length: outcomeCount}, (_, index) =>
      receipt(
        `run-${index}`,
        SCORE_RULES.computeReward.creditedTokensPerOutcomeCap,
      ),
    );

    const [result] = computeRewardWeights([bucket()], awards, receipts, [
      PROJECT,
    ]);

    expect(result?.creditedTokens).toBeGreaterThan(
      SCORE_RULES.computeReward.saturationTokens,
    );
    expect(result?.computeBonusBasisPoints).toBe(
      SCORE_RULES.computeReward.maximumBonusBasisPoints,
    );
    expect(result?.computeBonusBasisPoints).toBeLessThanOrEqual(
      SCORE_RULES.computeReward.maximumBonusBasisPoints,
    );
  });
});

describe('allocateMonthlyPool', () => {
  test('uses bigint arithmetic and conserves the exact pool', () => {
    const monthlyPoolBaseUnits = '900719925474099300000';
    const allocations = allocateMonthlyPool(
      rewardedProject(monthlyPoolBaseUnits),
      '2026-08',
      [
        contributor('actor-1', 1),
        contributor('actor-2', 2),
        contributor('actor-3', 4),
      ],
    );

    const allocatedTotal = allocations.reduce(
      (total, allocation) => total + BigInt(allocation.projectedBaseUnits),
      0n,
    );

    expect(allocatedTotal).toBe(BigInt(monthlyPoolBaseUnits));
    expect(allocations.map(value => value.projectedBaseUnits)).toEqual([
      '128674275067728471429',
      '257348550135456942857',
      '514697100270913885714',
    ]);
  });

  test('breaks equal remainders by actor id regardless of input order', () => {
    const project = rewardedProject('2');
    const first = allocateMonthlyPool(project, '2026-08', [
      contributor('actor-c', 1),
      contributor('actor-a', 1),
      contributor('actor-b', 1),
    ]);
    const second = allocateMonthlyPool(project, '2026-08', [
      contributor('actor-b', 1),
      contributor('actor-c', 1),
      contributor('actor-a', 1),
    ]);
    const byActorId = (values: readonly RewardContributor[]) =>
      Object.fromEntries(
        values.map(value => [value.actorId, value.projectedBaseUnits]),
      );

    expect(byActorId(first)).toEqual({
      'actor-a': '1',
      'actor-b': '1',
      'actor-c': '0',
    });
    expect(byActorId(second)).toEqual(byActorId(first));
  });
});
