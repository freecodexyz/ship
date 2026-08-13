import {describe, expect, test} from 'bun:test';

import {allocateMonthlyPool, computeRewardWeights} from './rewards.js';
import {parseCanonicalTimestamp} from './time.js';
import type {
  Actor,
  Award,
  Project,
  RepoId,
  RewardContributor,
  RunReceipt,
  ScoreBucket,
} from './types.js';

const repo = 'Owner/Repo' as RepoId;
const actor: Actor = {id: 'actor-1', login: 'contributor'};
const occurredAt = parseCanonicalTimestamp('2026-08-10T12:00:00.000Z');
const rewardStartsAt = parseCanonicalTimestamp('2026-08-01T00:00:00.000Z');
const project: Project = {
  id: 'ship',
  name: 'Ship',
  mission: 'Deliver bounded, reviewable improvements to Ship.',
  repositories: [{id: repo, branch: 'main'}],
  allowedModels: [],
};

function bucket(overrides: Partial<ScoreBucket> = {}): ScoreBucket {
  return {
    project: project.id,
    cycle: '2026-08',
    actor,
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
  overrides: Partial<Extract<Award, {readonly kind: 'merged_pr'}>> = {},
): Extract<Award, {readonly kind: 'merged_pr'}> {
  return {
    id: 'award-1',
    kind: 'merged_pr',
    project: project.id,
    repo,
    cycle: '2026-08',
    actor,
    occurredAt,
    source: {kind: 'pr', number: 1, title: 'Accepted work'},
    points: 10,
    runId: 'run-1',
    ...overrides,
  };
}

function receipt(overrides: Partial<RunReceipt> = {}): RunReceipt {
  return {
    version: 1,
    runId: 'run-1',
    project: project.id,
    repo,
    startedAt: parseCanonicalTimestamp('2026-08-10T11:00:00.000Z'),
    completedAt: occurredAt,
    agent: {client: 'codex', provider: 'openai', model: 'gpt-5'},
    skill: {revision: 'a'.repeat(40), sha256: 'b'.repeat(64)},
    usage: {
      confidence: 'exact',
      totalTokens: 100_000,
      costMicroUsd: '1',
    },
    device: {keyId: 'device', publicKey: 'public-key'},
    signature: 'signature',
    ...overrides,
  };
}

function contributor(
  actorId: string,
  adjustedWeight: number,
  overrides: Partial<RewardContributor> = {},
): RewardContributor {
  return {
    project: project.id,
    cycle: '2026-08',
    actorId,
    canonicalScore: 10,
    creditedTokens: 0,
    computeBonusBasisPoints: 0,
    adjustedWeight,
    projectedBaseUnits: '0',
    ...overrides,
  };
}

describe('computeRewardWeights', () => {
  test('credits a linked receipt once and caps it per accepted outcome', () => {
    const secondAward: Award = {
      ...award(),
      id: 'award-2',
      kind: 'test_change',
      points: 5,
    };
    const [contributor] = computeRewardWeights(
      [bucket()],
      [award(), secondAward],
      [
        receipt({
          usage: {
            confidence: 'bounded',
            totalTokens: 900_000,
            costMicroUsd: '1',
          },
        }),
      ],
      [project],
    );

    expect(contributor).toEqual({
      project: 'ship',
      cycle: '2026-08',
      actorId: actor.id,
      canonicalScore: 10,
      creditedTokens: 100_000,
      computeBonusBasisPoints: 250,
      adjustedWeight: 102_500,
      projectedBaseUnits: '0',
    });
  });

  test('ignores receipts not linked through a consistent accepted award', () => {
    const otherActor: Actor = {id: 'actor-2', login: 'other'};
    const cases: readonly Award[][] = [
      [],
      [award({runId: 'another-run'})],
      [award({project: 'other'})],
      [award({repo: 'Owner/Other' as RepoId})],
      [award({actor: otherActor})],
    ];

    for (const awards of cases) {
      expect(
        computeRewardWeights([bucket()], awards, [receipt()], [project])[0]
          ?.creditedTokens,
      ).toBe(0);
    }
  });

  test('saturates the compute bonus at its configured maximum', () => {
    const awards = Array.from({length: 11}, (_, index) =>
      award({id: `award-${index}`, runId: `run-${index}`}),
    );
    const receipts = Array.from({length: 11}, (_, index) =>
      receipt({runId: `run-${index}`}),
    );
    const [contributor] = computeRewardWeights([bucket()], awards, receipts, [
      project,
    ]);

    expect(contributor?.creditedTokens).toBe(1_100_000);
    expect(contributor?.computeBonusBasisPoints).toBe(2_500);
    expect(contributor?.adjustedWeight).toBe(125_000);
  });

  test('keeps zero canonical score and reward weight at zero', () => {
    const canonicalBucket = bucket({
      score: 0,
      breakdown: {
        merged_pr: 0,
        resolved_issue: 0,
        test_change: 0,
        evidence: 0,
        review: 0,
        evaluation: 0,
      },
    });
    const [contributor] = computeRewardWeights(
      [canonicalBucket],
      [award()],
      [receipt()],
      [project],
    );

    expect(contributor?.canonicalScore).toBe(0);
    expect(contributor?.adjustedWeight).toBe(0);
    expect(canonicalBucket.score).toBe(0);
  });

  test('does not mutate canonical buckets, awards, or receipts', () => {
    const canonicalBucket = Object.freeze(bucket());
    const canonicalAward = Object.freeze(award());
    const acceptedReceipt = Object.freeze(receipt());

    computeRewardWeights(
      [canonicalBucket],
      [canonicalAward],
      [acceptedReceipt],
      [project],
    );

    expect(canonicalBucket.score).toBe(10);
    expect(canonicalAward.points).toBe(10);
    expect(acceptedReceipt.usage.totalTokens).toBe(100_000);
  });
});

describe('allocateMonthlyPool', () => {
  test('conserves pools larger than the safe integer range', () => {
    const monthlyPoolBaseUnits = '900719925474099300000';
    const rewardedProject: Project = {
      ...project,
      reward: {
        startsAt: rewardStartsAt,
        token: {address: `0x${'1'.repeat(40)}`, decimals: 18, symbol: 'SHIP'},
        monthlyPoolBaseUnits: monthlyPoolBaseUnits,
      },
    };
    const allocations = allocateMonthlyPool(rewardedProject, '2026-08', [
      contributor('actor-1', 1),
      contributor('actor-2', 2),
      contributor('actor-3', 4),
    ]);

    const total = allocations.reduce(
      (sum, allocation) => sum + BigInt(allocation.projectedBaseUnits),
      0n,
    );
    expect(total).toBe(BigInt(monthlyPoolBaseUnits));
    expect(
      allocations.map(allocation => allocation.projectedBaseUnits),
    ).toEqual([
      '128674275067728471429',
      '257348550135456942857',
      '514697100270913885714',
    ]);
  });

  test('uses actor id to break equal remainders deterministically', () => {
    const rewardedProject: Project = {
      ...project,
      reward: {
        startsAt: rewardStartsAt,
        token: {address: `0x${'1'.repeat(40)}`, decimals: 18, symbol: 'SHIP'},
        monthlyPoolBaseUnits: '2',
      },
    };
    const contributors = [
      contributor('actor-c', 1),
      contributor('actor-a', 1),
      contributor('actor-b', 1),
    ];

    const allocations = allocateMonthlyPool(
      rewardedProject,
      '2026-08',
      contributors,
    );

    expect(
      allocations.map(allocation => allocation.projectedBaseUnits),
    ).toEqual(['0', '1', '1']);
    expect(allocations.map(allocation => allocation.actorId)).toEqual(
      contributors.map(allocation => allocation.actorId),
    );
  });

  test('returns zero allocations for zero weight, zero pool, or inactive rewards', () => {
    const token = {
      address: `0x${'1'.repeat(40)}` as const,
      decimals: 18,
      symbol: 'SHIP',
    };
    const zeroPoolProject: Project = {
      ...project,
      reward: {
        startsAt: rewardStartsAt,
        token,
        monthlyPoolBaseUnits: '0',
      },
    };
    const nonzeroPoolProject: Project = {
      ...project,
      reward: {
        startsAt: rewardStartsAt,
        token,
        monthlyPoolBaseUnits: '100',
      },
    };
    const futureRewardProject: Project = {
      ...project,
      reward: {
        startsAt: parseCanonicalTimestamp('2026-09-01T00:00:00.000Z'),
        token,
        monthlyPoolBaseUnits: '100',
      },
    };

    expect(
      allocateMonthlyPool(nonzeroPoolProject, '2026-08', [
        contributor('actor-1', 0),
        contributor('actor-2', 0),
      ]).map(allocation => allocation.projectedBaseUnits),
    ).toEqual(['0', '0']);
    expect(
      allocateMonthlyPool(zeroPoolProject, '2026-08', [
        contributor('actor-1', 1),
      ])[0]?.projectedBaseUnits,
    ).toBe('0');
    expect(
      allocateMonthlyPool(futureRewardProject, '2026-08', [
        contributor('actor-1', 1),
      ])[0]?.projectedBaseUnits,
    ).toBe('0');
  });

  test('does not mutate reward weights and rejects mixed allocation scopes', () => {
    const rewardedProject: Project = {
      ...project,
      reward: {
        startsAt: rewardStartsAt,
        token: {address: `0x${'1'.repeat(40)}`, decimals: 18, symbol: 'SHIP'},
        monthlyPoolBaseUnits: '10',
      },
    };
    const weights = Object.freeze([
      Object.freeze(contributor('actor-1', 1, {projectedBaseUnits: '99'})),
    ]);

    expect(
      allocateMonthlyPool(rewardedProject, '2026-08', weights)[0]
        ?.projectedBaseUnits,
    ).toBe('10');
    expect(weights[0]?.projectedBaseUnits).toBe('99');
    expect(() =>
      allocateMonthlyPool(rewardedProject, '2026-08', [
        contributor('actor-1', 1, {cycle: '2026-07'}),
      ]),
    ).toThrow('requested project and cycle');
  });
});
