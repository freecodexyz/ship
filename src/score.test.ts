import {describe, expect, test} from 'bun:test';

import {
  applyAward,
  createBucket,
  scoreFacts,
  validateScoringInvariants,
} from './score.js';
import {parseCanonicalTimestamp} from './time.js';
import type {Actor, Award, Fact, RepoId} from './types.js';

const actor: Actor = {id: 'actor-1', login: 'contributor'};

type FactOptions = {
  readonly project?: Lowercase<string>;
  readonly cycle?: string;
  readonly actor?: Actor;
  readonly occurredAt?: string;
};

function fact(
  kind: Exclude<Fact['kind'], 'evidence' | 'evaluation'>,
  id: string,
  options: FactOptions = {},
): Fact {
  return {
    id,
    kind,
    project: options.project ?? 'project',
    repo: 'owner/repo' as RepoId,
    cycle: options.cycle ?? '2026-07',
    actor: options.actor ?? actor,
    occurredAt: parseCanonicalTimestamp(
      options.occurredAt ?? '2026-07-01T00:00:00.000Z',
    ),
    source: {kind: 'pr', number: 1, title: id},
  };
}

function evidenceFact(
  id: string,
  evidenceKind: Extract<Fact, {kind: 'evidence'}>['evidenceKind'],
  options: FactOptions = {},
): Fact {
  return {...fact('merged_pr', id, options), kind: 'evidence', evidenceKind};
}

function evaluationFact(
  id: string,
  evaluationPoints: number,
  options: FactOptions = {},
): Fact {
  return {
    ...fact('merged_pr', id, options),
    kind: 'evaluation',
    evaluationPoints,
  };
}

describe('createBucket', () => {
  test('creates plain serializable data with every value initialized to zero', () => {
    const bucket = createBucket(fact('merged_pr', 'merged'));

    expect(bucket).toEqual({
      project: 'project',
      cycle: '2026-07',
      actor,
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
    });
    expect(Object.getPrototypeOf(bucket)).toBe(Object.prototype);
    expect(() => JSON.stringify(bucket)).not.toThrow();
  });
});

describe('applyAward', () => {
  test('updates each category, accepted count, score, and ledger together', () => {
    const cases: readonly {
      readonly awardedFact: Fact;
      readonly category: keyof ReturnType<typeof createBucket>['breakdown'];
      readonly countCategory:
        keyof ReturnType<typeof createBucket>['counts'] | undefined;
    }[] = [
      {
        awardedFact: fact('merged_pr', 'merged'),
        category: 'merged_pr',
        countCategory: 'merged_pr',
      },
      {
        awardedFact: fact('resolved_issue', 'issue'),
        category: 'resolved_issue',
        countCategory: 'resolved_issue',
      },
      {
        awardedFact: fact('test_change', 'test'),
        category: 'test_change',
        countCategory: 'test_change',
      },
      {
        awardedFact: evidenceFact('evidence', 'video'),
        category: 'evidence',
        countCategory: undefined,
      },
      {
        awardedFact: fact('review', 'review'),
        category: 'review',
        countCategory: 'review',
      },
      {
        awardedFact: evaluationFact('evaluation', 20),
        category: 'evaluation',
        countCategory: 'evaluation',
      },
    ];

    for (const {awardedFact, category, countCategory} of cases) {
      const bucket = createBucket(awardedFact);
      const awards: Award[] = [];

      applyAward(bucket, awardedFact, 3, awards);

      expect(bucket.score).toBe(3);
      expect(bucket.breakdown[category]).toBe(3);
      expect(
        Object.values(bucket.breakdown).reduce(
          (total, points) => total + points,
          0,
        ),
      ).toBe(3);
      expect(bucket.counts).toEqual({
        merged_pr: countCategory === 'merged_pr' ? 1 : 0,
        resolved_issue: countCategory === 'resolved_issue' ? 1 : 0,
        test_change: countCategory === 'test_change' ? 1 : 0,
        review: countCategory === 'review' ? 1 : 0,
        evaluation: countCategory === 'evaluation' ? 1 : 0,
      });
      expect(awards).toEqual([{...awardedFact, points: 3}]);
    }
  });

  test.each([0, -1, 1.5])(
    'rejects invalid points %p without changing bucket or ledger',
    points => {
      const awardedFact = fact('merged_pr', 'merged');
      const bucket = createBucket(awardedFact);
      const originalBucket = structuredClone(bucket);
      const awards: Award[] = [];

      expect(() => applyAward(bucket, awardedFact, points, awards)).toThrow(
        'Award points must be a positive safe integer.',
      );
      expect(bucket).toEqual(originalBucket);
      expect(awards).toEqual([]);
    },
  );
});

describe('scoreFacts', () => {
  test('applies every point value and evaluation per-event maximum', () => {
    const result = scoreFacts([
      fact('merged_pr', 'merged'),
      fact('resolved_issue', 'issue'),
      fact('test_change', 'test'),
      evidenceFact('screenshot', 'screenshot'),
      evidenceFact('video', 'video'),
      evidenceFact('logs', 'logs'),
      evidenceFact('trajectory', 'trajectory'),
      evidenceFact('artifact', 'artifact'),
      fact('review', 'review'),
      evaluationFact('evaluation', 99),
    ]);

    expect(result.awards.map(award => award.points)).toEqual([
      1, 8, 4, 1, 10, 3, 1, 4, 1, 2,
    ]);
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toEqual({
      project: 'project',
      cycle: '2026-07',
      actor,
      score: 35,
      breakdown: {
        merged_pr: 10,
        resolved_issue: 4,
        test_change: 4,
        evidence: 6,
        review: 3,
        evaluation: 8,
      },
      counts: {
        merged_pr: 1,
        resolved_issue: 1,
        test_change: 1,
        review: 1,
        evaluation: 1,
      },
    });
  });

  test('applies all caps, emits no zero-point awards, and reaches 174', () => {
    const facts: Fact[] = [
      ...Array.from({length: 6}, (_, index) =>
        fact('merged_pr', `merged-${index}`),
      ),
      ...Array.from({length: 6}, (_, index) =>
        fact('resolved_issue', `issue-${index}`),
      ),
      ...Array.from({length: 6}, (_, index) =>
        fact('test_change', `test-${index}`),
      ),
      ...Array.from({length: 11}, (_, index) =>
        fact('review', `review-${index}`),
      ),
      ...Array.from({length: 16}, (_, index) =>
        evidenceFact(`evidence-${index}`, 'video'),
      ),
      ...Array.from({length: 4}, (_, index) =>
        evaluationFact(`evaluation-${index}`, 8),
      ),
    ];

    const result = scoreFacts(facts);

    expect(result.buckets[0]?.score).toBe(174);
    expect(result.buckets[0]?.breakdown).toEqual({
      merged_pr: 50,
      resolved_issue: 20,
      test_change: 20,
      evidence: 30,
      review: 30,
      evaluation: 24,
    });
    expect(result.buckets[0]?.counts).toEqual({
      merged_pr: 5,
      resolved_issue: 5,
      test_change: 5,
      review: 10,
      evaluation: 3,
    });
    expect(result.awards).toHaveLength(43);
    expect(result.awards.every(award => award.points > 0)).toBe(true);
    expect(
      result.awards.reduce((total, award) => total + award.points, 0),
    ).toBe(174);
  });

  test('stops emitting evidence awards at the point cap', () => {
    const result = scoreFacts(
      Array.from({length: 16}, (_, index) =>
        evidenceFact(`video-${index}`, 'video'),
      ),
    );

    expect(result.awards).toHaveLength(15);
    expect(result.awards.every(award => award.points === 2)).toBe(true);
    expect(result.buckets[0]?.breakdown.evidence).toBe(30);
  });

  test('partitions every cap by actor, project, and cycle', () => {
    const secondActor: Actor = {id: 'actor-2', login: 'second'};
    const scopes: readonly FactOptions[] = [
      {},
      {actor: secondActor},
      {project: 'other'},
      {cycle: '2026-08'},
    ];
    const facts = scopes.flatMap((options, scopeIndex) =>
      Array.from({length: 6}, (_, factIndex) =>
        fact('merged_pr', `scope-${scopeIndex}-${factIndex}`, options),
      ),
    );

    const result = scoreFacts(facts);

    expect(result.buckets).toHaveLength(4);
    expect(result.buckets.map(bucket => bucket.score)).toEqual([
      50, 50, 50, 50,
    ]);
    expect(result.awards).toHaveLength(20);
  });

  test('sorts facts and buckets deterministically without mutating input', () => {
    const later = fact('merged_pr', 'z-later', {
      project: 'zulu',
      occurredAt: '2026-07-02T00:00:00.000Z',
    });
    const tiedSecond = fact('review', 'b-tied', {project: 'alpha'});
    const tiedFirst = fact('review', 'a-tied', {project: 'alpha'});
    const input = [later, tiedSecond, tiedFirst];

    const first = scoreFacts(input);
    const second = scoreFacts([...input].reverse());

    expect(first).toEqual(second);
    expect(first.awards.map(award => award.id)).toEqual([
      'a-tied',
      'b-tied',
      'z-later',
    ]);
    expect(first.buckets.map(bucket => bucket.project)).toEqual([
      'alpha',
      'zulu',
    ]);
    expect(input).toEqual([later, tiedSecond, tiedFirst]);
  });
});

describe('validateScoringInvariants', () => {
  function maximumResult(): ReturnType<typeof scoreFacts> {
    return scoreFacts([
      ...Array.from({length: 5}, (_, index) =>
        fact('merged_pr', `merged-${index}`),
      ),
      ...Array.from({length: 5}, (_, index) =>
        fact('resolved_issue', `issue-${index}`),
      ),
      ...Array.from({length: 5}, (_, index) =>
        fact('test_change', `test-${index}`),
      ),
      ...Array.from({length: 10}, (_, index) =>
        fact('review', `review-${index}`),
      ),
      ...Array.from({length: 15}, (_, index) =>
        evidenceFact(`evidence-${index}`, 'video'),
      ),
      ...Array.from({length: 3}, (_, index) =>
        evaluationFact(`evaluation-${index}`, 8),
      ),
    ]);
  }

  test('accepts exact buckets and awards at the theoretical maximum', () => {
    const result = maximumResult();

    expect(result.buckets[0]?.score).toBe(174);
    expect(() =>
      validateScoringInvariants(result.buckets, result.awards),
    ).not.toThrow();
  });

  test('rejects a score that differs from its breakdown', () => {
    const result = maximumResult();
    const bucket = result.buckets[0];
    if (bucket === undefined) throw new Error('Expected score bucket.');

    expect(() =>
      validateScoringInvariants([{...bucket, score: bucket.score - 1}], []),
    ).toThrow('Score bucket does not equal its category breakdown.');
  });

  test.each([
    ['merged_pr', 'Merged pull request'],
    ['resolved_issue', 'Resolved issue'],
    ['test_change', 'Material test change'],
    ['review', 'Substantive review'],
    ['evaluation', 'Evaluation'],
  ] as const)('rejects %s counts above their cap', (category, label) => {
    const result = maximumResult();
    const bucket = result.buckets[0];
    if (bucket === undefined) throw new Error('Expected score bucket.');

    expect(() =>
      validateScoringInvariants(
        [
          {
            ...bucket,
            counts: {...bucket.counts, [category]: Number.MAX_SAFE_INTEGER},
          },
        ],
        result.awards,
      ),
    ).toThrow(`${label} count exceeds its configured cap.`);
  });

  test('rejects evidence points above their point cap', () => {
    const result = maximumResult();
    const bucket = result.buckets[0];
    if (bucket === undefined) throw new Error('Expected score bucket.');
    const breakdown = {...bucket.breakdown, evidence: 31};

    expect(() =>
      validateScoringInvariants(
        [{...bucket, score: 175, breakdown}],
        result.awards,
      ),
    ).toThrow('Evidence points exceed their configured cap.');
  });

  test.each([
    {evaluation: 0, count: 1},
    {evaluation: 21, count: 1},
  ])(
    'rejects $evaluation evaluation points for $count event',
    ({evaluation, count}) => {
      const base = createBucket(evaluationFact('evaluation', 20));
      const breakdown = {...base.breakdown, evaluation};
      const bucket = {
        ...base,
        score: evaluation,
        breakdown,
        counts: {...base.counts, evaluation: count},
      };

      expect(() => validateScoringInvariants([bucket], [])).toThrow(
        'Evaluation points cannot be produced by the accepted event count.',
      );
    },
  );

  test('rejects a score above the maximum implied by the rules', () => {
    const result = maximumResult();
    const bucket = result.buckets[0];
    if (bucket === undefined) throw new Error('Expected score bucket.');
    const breakdown = {...bucket.breakdown, merged_pr: 51};

    expect(() =>
      validateScoringInvariants(
        [{...bucket, score: 175, breakdown}],
        result.awards,
      ),
    ).toThrow('Score bucket exceeds the theoretical maximum.');
  });

  test('requires exact award sums for every project, cycle, and actor', () => {
    const first = scoreFacts([fact('merged_pr', 'first')]);
    const second = scoreFacts([
      fact('merged_pr', 'second', {project: 'other'}),
    ]);

    expect(() =>
      validateScoringInvariants(
        [...first.buckets, ...second.buckets],
        [...first.awards],
      ),
    ).toThrow('Score bucket does not equal its matching awards.');

    expect(() =>
      validateScoringInvariants(first.buckets, [
        ...first.awards,
        ...second.awards,
      ]),
    ).toThrow('An award does not have a matching score bucket.');
  });
});
