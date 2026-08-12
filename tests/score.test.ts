import {describe, expect, test} from 'bun:test';

import {scoreFacts} from '../src/score.js';
import {parseCanonicalTimestamp} from '../src/time.js';
import type {Actor, Fact, RepoId} from '../src/types.js';

const primaryActor: Actor = {id: 'actor-1', login: 'primary'};

type FixedFactKind = 'merged_pr' | 'resolved_issue' | 'test_change' | 'review';

type FactOptions = {
  readonly project?: Lowercase<string>;
  readonly cycle?: string;
  readonly actor?: Actor;
  readonly occurredAt?: string;
};

type FixedCategory = {
  readonly kind: FixedFactKind;
  readonly breakdown: 'merged_pr' | 'resolved_issue' | 'test_change' | 'review';
  readonly points: number;
  readonly countCap: number;
};

const fixedCategories: readonly FixedCategory[] = [
  {kind: 'merged_pr', breakdown: 'merged_pr', points: 10, countCap: 5},
  {
    kind: 'resolved_issue',
    breakdown: 'resolved_issue',
    points: 4,
    countCap: 5,
  },
  {kind: 'test_change', breakdown: 'test_change', points: 4, countCap: 5},
  {kind: 'review', breakdown: 'review', points: 3, countCap: 10},
] as const;

function fixedFact(
  kind: FixedFactKind,
  id: string,
  options: FactOptions = {},
): Fact {
  const base = factBase(id, options);
  switch (kind) {
    case 'merged_pr':
      return {...base, kind};
    case 'resolved_issue':
      return {...base, kind};
    case 'test_change':
      return {...base, kind};
    case 'review':
      return {...base, kind};
    default:
      return assertNever(kind);
  }
}

function evidenceFact(
  id: string,
  evidenceKind: Extract<Fact, {kind: 'evidence'}>['evidenceKind'],
  options: FactOptions = {},
): Fact {
  return {...factBase(id, options), kind: 'evidence', evidenceKind};
}

function evaluationFact(
  id: string,
  evaluationPoints: number,
  options: FactOptions = {},
): Fact {
  return {
    ...factBase(id, options),
    kind: 'evaluation',
    evaluationPoints,
  };
}

function factBase(id: string, options: FactOptions): Omit<Fact, 'kind'> {
  const cycle = options.cycle ?? '2026-07';
  return {
    id,
    project: options.project ?? 'project-a',
    repo: 'owner/repository' as RepoId,
    cycle,
    actor: options.actor ?? primaryActor,
    occurredAt: parseCanonicalTimestamp(
      options.occurredAt ?? `${cycle}-01T00:00:00.000Z`,
    ),
    source: {kind: 'pr', number: 1, title: id},
  };
}

function fixedFacts(
  category: FixedCategory,
  count: number,
  prefix: string,
  options: FactOptions = {},
): Fact[] {
  return Array.from({length: count}, (_, index) =>
    fixedFact(
      category.kind,
      `${prefix}-${String(index).padStart(2, '0')}`,
      options,
    ),
  );
}

function mergedFacts(
  count: number,
  prefix: string,
  options: FactOptions = {},
): Fact[] {
  return Array.from({length: count}, (_, index) =>
    fixedFact(
      'merged_pr',
      `${prefix}-${String(index).padStart(2, '0')}`,
      options,
    ),
  );
}

function assertNever(value: never): never {
  throw new Error(`Unhandled fixed fact kind: ${String(value)}`);
}

describe('scoreFacts point values', () => {
  test.each([...fixedCategories])(
    'awards $points points for one $kind fact',
    category => {
      const result = scoreFacts([fixedFact(category.kind, category.kind)]);

      expect(result.awards).toHaveLength(1);
      expect(result.awards[0]?.points).toBe(category.points);
      expect(result.buckets[0]?.score).toBe(category.points);
      expect(result.buckets[0]?.breakdown[category.breakdown]).toBe(
        category.points,
      );
    },
  );

  test.each([
    ['screenshot', 1],
    ['video', 2],
    ['logs', 1],
    ['trajectory', 1],
    ['artifact', 1],
  ] as const)('awards %s evidence at %i points', (kind, points) => {
    const result = scoreFacts([evidenceFact(`evidence-${kind}`, kind)]);

    expect(result.awards[0]?.points).toBe(points);
    expect(result.buckets[0]?.breakdown.evidence).toBe(points);
  });

  test.each([
    [1, 1],
    [7, 7],
    [8, 8],
    [20, 8],
    [99, 8],
  ] as const)(
    'awards %i evaluation points as %i after the per-event maximum',
    (requested, awarded) => {
      const result = scoreFacts([
        evaluationFact(`evaluation-${requested}`, requested),
      ]);

      expect(result.awards[0]?.points).toBe(awarded);
      expect(result.buckets[0]?.breakdown.evaluation).toBe(awarded);
      expect(result.buckets[0]?.counts.evaluation).toBe(1);
    },
  );
});

describe('scoreFacts caps', () => {
  test.each([...fixedCategories])(
    'caps $kind at $countCap accepted facts',
    category => {
      const attemptedCount = category.countCap + 2;
      const result = scoreFacts(
        fixedFacts(category, attemptedCount, category.kind),
      );
      const bucket = result.buckets[0];

      expect(bucket?.score).toBe(category.points * category.countCap);
      expect(bucket?.breakdown[category.breakdown]).toBe(
        category.points * category.countCap,
      );
      expect(bucket?.counts[category.breakdown]).toBe(category.countCap);
      expect(result.awards).toHaveLength(category.countCap);
      expect(
        result.awards.every(award => award.points === category.points),
      ).toBe(true);
    },
  );

  test('caps evidence at 30 points', () => {
    const result = scoreFacts(
      Array.from({length: 16}, (_, index) =>
        evidenceFact(`evidence-${index}`, 'video'),
      ),
    );

    expect(result.awards).toHaveLength(15);
    expect(result.buckets[0]?.breakdown.evidence).toBe(30);
    expect(result.buckets[0]?.score).toBe(30);
  });

  test('caps evaluation at three accepted events', () => {
    const result = scoreFacts([
      evaluationFact('evaluation-01', 7),
      evaluationFact('evaluation-02', 20),
      evaluationFact('evaluation-03', 20),
      evaluationFact('evaluation-04', 20),
    ]);

    expect(result.awards.map(award => award.points)).toEqual([8, 8, 8]);
    expect(result.buckets[0]?.breakdown.evaluation).toBe(24);
    expect(result.buckets[0]?.counts.evaluation).toBe(3);
    expect(result.buckets[0]?.score).toBe(24);
  });

  test('reaches the theoretical maximum of 174 points', () => {
    const facts: Fact[] = [
      ...mergedFacts(5, 'maximum-merged'),
      ...fixedFacts(fixedCategories[1]!, 5, 'maximum-issue'),
      ...fixedFacts(fixedCategories[2]!, 5, 'maximum-test'),
      ...fixedFacts(fixedCategories[3]!, 10, 'maximum-review'),
      ...Array.from({length: 15}, (_, index) =>
        evidenceFact(`maximum-evidence-${index}`, 'video'),
      ),
      evaluationFact('maximum-evaluation-01', 8),
      evaluationFact('maximum-evaluation-02', 8),
      evaluationFact('maximum-evaluation-03', 8),
    ];

    const result = scoreFacts(facts);

    expect(result.buckets).toEqual([
      {
        project: 'project-a',
        cycle: '2026-07',
        actor: primaryActor,
        score: 174,
        breakdown: {
          merged_pr: 50,
          resolved_issue: 20,
          test_change: 20,
          evidence: 30,
          review: 30,
          evaluation: 24,
        },
        counts: {
          merged_pr: 5,
          resolved_issue: 5,
          test_change: 5,
          review: 10,
          evaluation: 3,
        },
      },
    ]);
    expect(result.awards.reduce((sum, award) => sum + award.points, 0)).toBe(
      174,
    );
  });
});

describe('scoreFacts bucket isolation', () => {
  test('applies caps independently for two actors', () => {
    const secondActor: Actor = {id: 'actor-2', login: 'secondary'};
    const result = scoreFacts([
      ...mergedFacts(6, 'actor-one', {actor: primaryActor}),
      ...mergedFacts(6, 'actor-two', {actor: secondActor}),
    ]);

    expect(
      result.buckets.map(bucket => [bucket.actor.id, bucket.score]),
    ).toEqual([
      ['actor-1', 50],
      ['actor-2', 50],
    ]);
    expect(result.awards).toHaveLength(10);
  });

  test('applies caps independently for two projects', () => {
    const result = scoreFacts([
      ...mergedFacts(6, 'project-a', {project: 'project-a'}),
      ...mergedFacts(6, 'project-b', {project: 'project-b'}),
    ]);

    expect(
      result.buckets.map(bucket => [bucket.project, bucket.score]),
    ).toEqual([
      ['project-a', 50],
      ['project-b', 50],
    ]);
    expect(result.awards).toHaveLength(10);
  });

  test('applies caps independently for two UTC months', () => {
    const result = scoreFacts([
      ...mergedFacts(6, 'july', {cycle: '2026-07'}),
      ...mergedFacts(6, 'august', {cycle: '2026-08'}),
    ]);

    expect(result.buckets.map(bucket => [bucket.cycle, bucket.score])).toEqual([
      ['2026-07', 50],
      ['2026-08', 50],
    ]);
    expect(result.awards).toHaveLength(10);
  });

  test('keeps the 92/120/50 regression totals in three distinct buckets', () => {
    const projectAJuly: Fact[] = [
      ...mergedFacts(5, 'a-july-merged'),
      ...fixedFacts(fixedCategories[1]!, 3, 'a-july-issue'),
      ...fixedFacts(fixedCategories[3]!, 4, 'a-july-review'),
      evidenceFact('a-july-screenshot', 'screenshot'),
    ];
    const projectAAugustOptions = {
      project: 'project-a',
      cycle: '2026-08',
    } as const;
    const projectAAugust: Fact[] = [
      ...mergedFacts(5, 'a-august-merged', projectAAugustOptions),
      ...fixedFacts(
        fixedCategories[1]!,
        3,
        'a-august-issue',
        projectAAugustOptions,
      ),
      ...fixedFacts(
        fixedCategories[2]!,
        4,
        'a-august-test',
        projectAAugustOptions,
      ),
      ...fixedFacts(
        fixedCategories[3]!,
        5,
        'a-august-review',
        projectAAugustOptions,
      ),
      ...Array.from({length: 3}, (_, index) =>
        evidenceFact(
          `a-august-evidence-${index}`,
          'screenshot',
          projectAAugustOptions,
        ),
      ),
    ];
    const projectBJuly = mergedFacts(5, 'b-july-merged', {
      project: 'project-b',
      cycle: '2026-07',
    });

    const result = scoreFacts([
      ...projectAAugust,
      ...projectBJuly,
      ...projectAJuly,
    ]);

    expect(
      result.buckets.map(bucket => ({
        project: bucket.project,
        cycle: bucket.cycle,
        actorId: bucket.actor.id,
        score: bucket.score,
      })),
    ).toEqual([
      {
        project: 'project-a',
        cycle: '2026-07',
        actorId: 'actor-1',
        score: 75,
      },
      {
        project: 'project-a',
        cycle: '2026-08',
        actorId: 'actor-1',
        score: 96,
      },
      {
        project: 'project-b',
        cycle: '2026-07',
        actorId: 'actor-1',
        score: 50,
      },
    ]);
    expect(result.buckets.reduce((sum, bucket) => sum + bucket.score, 0)).toBe(
      221,
    );
  });
});

describe('scoreFacts deterministic ordering', () => {
  test('keeps latest cap winners and orders awards and buckets', () => {
    const cappedFacts = [
      fixedFact('merged_pr', 'winner-05', {
        occurredAt: '2026-07-02T00:00:00.000Z',
      }),
      fixedFact('merged_pr', 'excluded-late', {
        occurredAt: '2026-07-03T00:00:00.000Z',
      }),
      fixedFact('merged_pr', 'winner-03'),
      fixedFact('merged_pr', 'winner-01'),
      fixedFact('merged_pr', 'winner-04'),
      fixedFact('merged_pr', 'winner-02'),
    ];
    const actorA: Actor = {id: 'actor-a', login: 'a'};
    const actorZ: Actor = {id: 'actor-z', login: 'z'};
    const scopedFacts = [
      fixedFact('review', 'scope-z-project', {project: 'z-project'}),
      fixedFact('review', 'scope-august', {cycle: '2026-08'}),
      fixedFact('review', 'scope-actor-z', {actor: actorZ}),
      fixedFact('review', 'scope-actor-a', {actor: actorA}),
    ];
    const input = [...scopedFacts, ...cappedFacts];

    const forward = scoreFacts(input);
    const reverse = scoreFacts([...input].reverse());

    expect(forward).toEqual(reverse);
    expect(
      forward.awards
        .filter(award => award.kind === 'merged_pr')
        .map(award => award.id),
    ).toEqual([
      'winner-02',
      'winner-03',
      'winner-04',
      'winner-05',
      'excluded-late',
    ]);
    expect(
      forward.buckets.map(bucket => [
        bucket.project,
        bucket.cycle,
        bucket.actor.id,
      ]),
    ).toEqual([
      ['project-a', '2026-07', 'actor-1'],
      ['project-a', '2026-07', 'actor-a'],
      ['project-a', '2026-07', 'actor-z'],
      ['project-a', '2026-08', 'actor-1'],
      ['z-project', '2026-07', 'actor-1'],
    ]);
    expect(input).toEqual([...scopedFacts, ...cappedFacts]);
  });
});
