import {describe, expect, test} from 'bun:test';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {canonicalJson} from './crypto.js';
import {buildSnapshot, validateSnapshot, writeSnapshot} from './snapshot.js';
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

const generatedAt = parseCanonicalTimestamp('2026-08-12T10:00:00.000Z');
const window = {
  from: parseCanonicalTimestamp('2026-07-01T00:00:00.000Z'),
  to: parseCanonicalTimestamp('2026-09-01T00:00:00.000Z'),
};
const repo = 'owner/repo' as RepoId;

function project(id: Lowercase<string>): Project {
  return {
    id,
    name: id,
    repositories: [{id: repo, branch: 'main'}],
    allowedModels: [],
  };
}

function bucket(
  projectId: Lowercase<string>,
  cycle: string,
  score: number,
  actor: Actor,
): ScoreBucket {
  return {
    project: projectId,
    cycle,
    actor,
    score,
    breakdown: {
      merged_pr: score,
      resolved_issue: 0,
      test_change: 0,
      evidence: 0,
      review: 0,
      evaluation: 0,
    },
    counts: {
      merged_pr: score === 0 ? 0 : 1,
      resolved_issue: 0,
      test_change: 0,
      review: 0,
      evaluation: 0,
    },
  };
}

function award(id: string, occurredAt: string, actor: Actor): Award {
  return {
    id,
    kind: 'merged_pr',
    project: 'alpha',
    repo,
    cycle: '2026-08',
    actor,
    occurredAt: parseCanonicalTimestamp(occurredAt),
    source: {kind: 'pr', number: 1, title: id},
    points: 10,
  };
}

function receipt(runId: string): RunReceipt {
  return {
    version: 1,
    runId,
    project: 'alpha',
    repo,
    startedAt: parseCanonicalTimestamp('2026-08-01T00:00:00.000Z'),
    completedAt: parseCanonicalTimestamp('2026-08-01T01:00:00.000Z'),
    agent: {client: 'codex', provider: 'openai', model: 'gpt-5'},
    skill: {revision: 'a'.repeat(40), sha256: 'b'.repeat(64)},
    usage: {confidence: 'unavailable', totalTokens: 0, costMicroUsd: '0'},
    device: {keyId: 'device', publicKey: 'public-key'},
    signature: 'signature',
  };
}

function reward(
  projectId: Lowercase<string>,
  cycle: string,
  canonicalScore: number,
  actorId: string,
): RewardContributor {
  return {
    project: projectId,
    cycle,
    actorId,
    canonicalScore,
    creditedTokens: 0,
    computeBonusBasisPoints: 0,
    adjustedWeight: canonicalScore * 10_000,
    projectedBaseUnits: '0',
  };
}

describe('buildSnapshot', () => {
  test('constructs canonical primitive output in the required order', () => {
    const actorA: Actor = {id: 'actor-a', login: 'a'};
    const actorB: Actor = {id: 'actor-b', login: 'b'};
    const snapshot = buildSnapshot(
      generatedAt,
      window,
      [project('zeta'), project('alpha')],
      [
        bucket('zeta', '2026-07', 1, actorA),
        bucket('alpha', '2026-08', 2, actorA),
        bucket('alpha', '2026-07', 3, actorB),
        bucket('alpha', '2026-07', 5, actorB),
        bucket('alpha', '2026-07', 5, actorA),
      ],
      [
        award('z-award', '2026-08-02T00:00:00.000Z', actorA),
        award('z-award', '2026-08-01T00:00:00.000Z', actorA),
        award('a-award', '2026-08-01T00:00:00.000Z', actorB),
      ],
      [receipt('run-z'), receipt('run-a')],
      [
        reward('zeta', '2026-07', 1, 'actor-a'),
        reward('alpha', '2026-07', 5, 'actor-b'),
        reward('alpha', '2026-07', 5, 'actor-a'),
      ],
    );

    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.generatedAt).toBe(generatedAt);
    expect(snapshot.window).toEqual(window);
    expect(snapshot.projects.map(value => value.id)).toEqual(['alpha', 'zeta']);
    expect(
      snapshot.buckets.map(value => [
        value.project,
        value.cycle,
        value.score,
        value.actor.id,
      ]),
    ).toEqual([
      ['alpha', '2026-07', 5, 'actor-a'],
      ['alpha', '2026-07', 5, 'actor-b'],
      ['alpha', '2026-07', 3, 'actor-b'],
      ['alpha', '2026-08', 2, 'actor-a'],
      ['zeta', '2026-07', 1, 'actor-a'],
    ]);
    expect(snapshot.awards.map(value => value.id)).toEqual([
      'a-award',
      'z-award',
      'z-award',
    ]);
    expect(snapshot.receipts.map(value => value.runId)).toEqual([
      'run-a',
      'run-z',
    ]);
    expect(snapshot.rewards?.map(value => value.actorId)).toEqual([
      'actor-a',
      'actor-b',
      'actor-a',
    ]);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    expect('rank' in snapshot).toBe(false);
    expect('leaderboard' in snapshot).toBe(false);
  });

  test('rejects awards outside the declared collection window', () => {
    const snapshot = validSnapshot();
    const outside = {
      ...award(
        'outside',
        '2026-09-01T00:00:00.000Z',
        snapshot.buckets[0]!.actor,
      ),
      cycle: '2026-09',
    } as Award;

    expect(() => validateSnapshot({...snapshot, awards: [outside]})).toThrow(
      'outside the snapshot window',
    );
  });

  test('does not mutate or retain nested input objects', () => {
    const actor: Actor = {id: 'actor', login: 'before'};
    const projects = [project('alpha')];
    const buckets = [bucket('alpha', '2026-08', 10, actor)];
    const awards = [award('award', '2026-08-01T00:00:00.000Z', actor)];
    const receipts = [receipt('run')];
    const projectOrder = [...projects];
    const bucketOrder = [...buckets];

    const snapshot = buildSnapshot(
      generatedAt,
      window,
      projects,
      buckets,
      awards,
      receipts,
    );

    expect(projects).toEqual(projectOrder);
    expect(buckets).toEqual(bucketOrder);
    expect(snapshot.projects[0]).not.toBe(projects[0]);
    expect(snapshot.buckets[0]).not.toBe(buckets[0]);
    expect(snapshot.buckets[0]?.actor).not.toBe(actor);
    expect(snapshot.awards[0]).not.toBe(awards[0]);
    expect(snapshot.receipts[0]).not.toBe(receipts[0]);
    expect(snapshot.rewards).toBeUndefined();
  });
});

function validSnapshot() {
  const actor: Actor = {id: 'actor', login: 'contributor'};
  return buildSnapshot(
    generatedAt,
    window,
    [project('alpha')],
    [bucket('alpha', '2026-08', 10, actor)],
    [award('award', '2026-08-01T00:00:00.000Z', actor)],
    [],
  );
}

describe('validateSnapshot', () => {
  test('accepts the exact static boundary and preserves object identity', () => {
    const snapshot = validSnapshot();

    expect(validateSnapshot(snapshot)).toBe(snapshot);
  });

  test('rejects unknown top-level and nested fields', () => {
    const snapshot = validSnapshot();
    const firstBucket = snapshot.buckets[0];
    expect(firstBucket).toBeDefined();
    if (firstBucket === undefined) return;

    expect(() => validateSnapshot({...snapshot, leaderboard: []})).toThrow(
      'unknown field',
    );
    expect(() =>
      validateSnapshot({
        ...snapshot,
        buckets: [
          {...firstBucket, actor: {...firstBucket.actor, numericId: 1}},
        ],
      }),
    ).toThrow('unknown field');
  });

  test('rejects malformed timestamps, windows, cycles, and repositories', () => {
    const snapshot = validSnapshot();
    const firstProject = snapshot.projects[0];
    const firstBucket = snapshot.buckets[0];
    expect(firstProject).toBeDefined();
    expect(firstBucket).toBeDefined();
    if (firstProject === undefined || firstBucket === undefined) return;

    expect(() =>
      validateSnapshot({...snapshot, generatedAt: '2026-08-12T10:00:00Z'}),
    ).toThrow('canonical UTC timestamp');
    expect(() =>
      validateSnapshot({
        ...snapshot,
        window: {from: snapshot.window.to, to: snapshot.window.from},
      }),
    ).toThrow('must precede');
    expect(() =>
      validateSnapshot({
        ...snapshot,
        buckets: [{...firstBucket, cycle: '2026-13'}],
      }),
    ).toThrow('YYYY-MM');
    expect(() =>
      validateSnapshot({
        ...snapshot,
        projects: [
          {
            ...firstProject,
            repositories: [{id: 'not-a-repository', branch: 'main'}],
          },
        ],
      }),
    ).toThrow('Repository id');
  });

  test('rejects duplicate project, repository, award, and receipt ids', () => {
    const snapshot = validSnapshot();
    const firstProject = snapshot.projects[0];
    const firstAward = snapshot.awards[0];
    expect(firstProject).toBeDefined();
    expect(firstAward).toBeDefined();
    if (firstProject === undefined || firstAward === undefined) return;

    expect(() =>
      validateSnapshot({
        ...snapshot,
        projects: [
          firstProject,
          {
            ...project('alpha'),
            repositories: [{id: 'owner/other' as RepoId, branch: 'main'}],
          },
        ],
      }),
    ).toThrow('Duplicate project id');
    expect(() =>
      validateSnapshot({
        ...snapshot,
        projects: [firstProject, project('beta')],
      }),
    ).toThrow('duplicate ownership');
    expect(() =>
      validateSnapshot({...snapshot, awards: [firstAward, firstAward]}),
    ).toThrow('Duplicate award id');

    const run = receipt('run');
    expect(() => validateSnapshot({...snapshot, receipts: [run, run]})).toThrow(
      'Duplicate receipt runId',
    );
  });

  test('rejects records referring to missing projects, buckets, and receipts', () => {
    const snapshot = validSnapshot();
    const firstBucket = snapshot.buckets[0];
    const firstAward = snapshot.awards[0];
    expect(firstBucket).toBeDefined();
    expect(firstAward).toBeDefined();
    if (firstBucket === undefined || firstAward === undefined) return;

    expect(() =>
      validateSnapshot({
        ...snapshot,
        buckets: [{...firstBucket, project: 'missing'}],
      }),
    ).toThrow('missing project');
    expect(() => validateSnapshot({...snapshot, buckets: []})).toThrow(
      'no matching bucket',
    );
    expect(() =>
      validateSnapshot({
        ...snapshot,
        awards: [{...firstAward, runId: 'missing-run'}],
      }),
    ).toThrow('missing receipt');
  });

  test('rejects bucket totals and category ledgers that disagree with awards', () => {
    const snapshot = validSnapshot();
    const firstBucket = snapshot.buckets[0];
    expect(firstBucket).toBeDefined();
    if (firstBucket === undefined) return;

    expect(() =>
      validateSnapshot({
        ...snapshot,
        buckets: [{...firstBucket, score: 9}],
      }),
    ).toThrow('category breakdown');
    expect(() =>
      validateSnapshot({
        ...snapshot,
        buckets: [
          {
            ...firstBucket,
            breakdown: {
              ...firstBucket.breakdown,
              merged_pr: 0,
              evidence: 10,
            },
            counts: {...firstBucket.counts, merged_pr: 0},
          },
        ],
      }),
    ).toThrow('breakdown does not match awards');
  });

  test('validates receipt links and optional reward references', () => {
    const snapshot = validSnapshot();
    const firstAward = snapshot.awards[0];
    expect(firstAward).toBeDefined();
    if (firstAward === undefined) return;

    const linked = {
      ...snapshot,
      awards: [{...firstAward, runId: 'run'}],
      receipts: [receipt('run')],
      rewards: [reward('alpha', '2026-08', 10, 'actor')],
    };
    expect(validateSnapshot(linked)).toBe(linked);
    expect(() =>
      validateSnapshot({
        ...linked,
        rewards: [reward('alpha', '2026-08', 9, 'actor')],
      }),
    ).toThrow('does not match a score bucket');
    expect(() =>
      validateSnapshot({
        ...linked,
        receipts: [{...receipt('run'), repo: 'owner/other'}],
      }),
    ).toThrow('unowned repository');
  });
});

async function withTemporaryDirectory<T>(
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'ship-snapshot-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

describe('writeSnapshot', () => {
  test('writes deterministic pretty and compact JSON', async () => {
    await withTemporaryDirectory(async directory => {
      const snapshot = validSnapshot();
      const reordered = {
        receipts: snapshot.receipts,
        awards: snapshot.awards,
        buckets: snapshot.buckets,
        projects: snapshot.projects,
        window: snapshot.window,
        generatedAt: snapshot.generatedAt,
        schemaVersion: snapshot.schemaVersion,
      };
      const prettyPath = join(directory, 'nested', 'pretty.json');
      const compactPath = join(directory, 'compact.json');

      await writeSnapshot(reordered, prettyPath);
      await writeSnapshot(snapshot, {
        outputPath: compactPath,
        format: 'compact',
      });

      const pretty = await readFile(prettyPath, 'utf8');
      const compact = await readFile(compactPath, 'utf8');
      expect(compact).toBe(canonicalJson(snapshot));
      expect(pretty).toBe(`${JSON.stringify(JSON.parse(compact), null, 2)}\n`);
      expect(JSON.parse(pretty)).toEqual(JSON.parse(compact));
    });
  });

  test('validates before writing and preserves an existing destination', async () => {
    await withTemporaryDirectory(async directory => {
      const outputPath = join(directory, 'snapshot.json');
      await writeFile(outputPath, 'existing', 'utf8');

      await expect(
        writeSnapshot({...validSnapshot(), schemaVersion: 1}, outputPath),
      ).rejects.toThrow('schemaVersion');

      expect(await readFile(outputPath, 'utf8')).toBe('existing');
      expect(await readdir(directory)).toEqual(['snapshot.json']);
    });
  });

  test('removes its temporary file when atomic replacement fails', async () => {
    await withTemporaryDirectory(async directory => {
      const outputPath = join(directory, 'snapshot.json');
      await mkdir(outputPath);

      await expect(
        writeSnapshot(validSnapshot(), outputPath),
      ).rejects.toThrow();

      expect(await readdir(directory)).toEqual(['snapshot.json']);
    });
  });
});
