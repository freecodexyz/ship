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
import {fileURLToPath} from 'node:url';

import {canonicalJson} from '../src/crypto.js';
import {
  buildSnapshot,
  validateSnapshot,
  writeSnapshot,
} from '../src/snapshot.js';
import {parseCanonicalTimestamp} from '../src/time.js';
import {
  parseRepoId,
  type Actor,
  type Award,
  type Project,
  type RunReceipt,
  type ScoreBreakdown,
  type ScoreBucket,
  type ScoreCounts,
} from '../src/types.js';

const GOLDEN_PATH = fileURLToPath(
  new URL('./fixtures/snapshot/complete.golden.json', import.meta.url),
);
const GENERATED_AT = parseCanonicalTimestamp('2026-09-01T00:05:00.000Z');
const WINDOW = {
  from: parseCanonicalTimestamp('2026-07-01T00:00:00.000Z'),
  to: parseCanonicalTimestamp('2026-09-01T00:00:00.000Z'),
};
const ALPHA_REPOSITORY = parseRepoId('Acme/Alpha');
const ZETA_REPOSITORY = parseRepoId('Acme/Zeta');
const ALICE: Actor = {id: 'U_alice', login: 'alice'};
const BOB: Actor = {id: 'U_bob', login: 'bob'};
const CAROL: Actor = {id: 'U_carol', login: 'carol'};

const PROJECTS: readonly Project[] = [
  {
    id: 'zeta',
    name: 'Zeta Project',
    mission: 'Deliver bounded, reviewable improvements to Zeta Project.',
    repositories: [{id: ZETA_REPOSITORY, branch: 'trunk'}],
    allowedModels: [
      {
        client: 'claude-code',
        provider: 'anthropic',
        model: 'claude-opus-4.1',
      },
    ],
  },
  {
    id: 'alpha',
    name: 'Alpha Project',
    mission: 'Deliver bounded, reviewable improvements to Alpha Project.',
    repositories: [{id: ALPHA_REPOSITORY, branch: 'main'}],
    reward: {
      startsAt: parseCanonicalTimestamp('2026-07-01T00:00:00.000Z'),
      token: {address: `0x${'1'.repeat(40)}`, decimals: 6, symbol: 'USDC'},
      monthlyPoolBaseUnits: '1000000',
    },
    allowedModels: [
      {client: 'codex', provider: 'openai', model: 'gpt-5'},
      {
        client: 'claude-code',
        provider: 'anthropic',
        model: 'claude-opus-4.1',
      },
    ],
  },
];

const BUCKETS: readonly ScoreBucket[] = [
  {
    project: 'zeta',
    cycle: '2026-07',
    actor: BOB,
    score: 12,
    breakdown: {
      merged_pr: 0,
      resolved_issue: 4,
      test_change: 0,
      evidence: 0,
      review: 0,
      evaluation: 8,
    },
    counts: {
      merged_pr: 0,
      resolved_issue: 1,
      test_change: 0,
      review: 0,
      evaluation: 1,
    },
  },
  {
    project: 'alpha',
    cycle: '2026-08',
    actor: ALICE,
    score: 3,
    breakdown: {
      merged_pr: 0,
      resolved_issue: 0,
      test_change: 0,
      evidence: 0,
      review: 3,
      evaluation: 0,
    },
    counts: {
      merged_pr: 0,
      resolved_issue: 0,
      test_change: 0,
      review: 1,
      evaluation: 0,
    },
  },
  {
    project: 'alpha',
    cycle: '2026-07',
    actor: CAROL,
    score: 11,
    breakdown: {
      merged_pr: 10,
      resolved_issue: 0,
      test_change: 0,
      evidence: 1,
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
  },
  {
    project: 'alpha',
    cycle: '2026-07',
    actor: ALICE,
    score: 31,
    breakdown: {
      merged_pr: 10,
      resolved_issue: 4,
      test_change: 4,
      evidence: 2,
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
  },
  {
    project: 'alpha',
    cycle: '2026-07',
    actor: BOB,
    score: 11,
    breakdown: {
      merged_pr: 10,
      resolved_issue: 0,
      test_change: 0,
      evidence: 1,
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
  },
];

type AwardBase = Pick<
  Award,
  'id' | 'project' | 'repo' | 'cycle' | 'actor' | 'occurredAt' | 'source'
>;

function awardBase(
  id: string,
  project: Project['id'],
  repo: Award['repo'],
  actor: Actor,
  occurredAt: string,
  source: Award['source'],
): AwardBase {
  return {
    id,
    project,
    repo,
    cycle: occurredAt.slice(0, 7),
    actor,
    occurredAt: parseCanonicalTimestamp(occurredAt),
    source,
  };
}

const AWARDS: readonly Award[] = [
  {
    ...awardBase(
      'award-alpha-august-review',
      'alpha',
      ALPHA_REPOSITORY,
      ALICE,
      '2026-08-02T12:00:00.000Z',
      {kind: 'review', number: 108, title: 'Review August change'},
    ),
    kind: 'review',
    points: 3,
  },
  {
    ...awardBase(
      'award-alpha-carol-merged',
      'alpha',
      ALPHA_REPOSITORY,
      CAROL,
      '2026-07-09T10:00:00.000Z',
      {kind: 'pr', number: 107, title: 'Carol improves caching'},
    ),
    kind: 'merged_pr',
    points: 10,
    runId: 'run-carol',
  },
  {
    ...awardBase(
      'award-alpha-carol-evidence',
      'alpha',
      ALPHA_REPOSITORY,
      CAROL,
      '2026-07-09T10:00:00.000Z',
      {kind: 'pr', number: 107, title: 'Carol improves caching'},
    ),
    kind: 'evidence',
    evidenceKind: 'screenshot',
    points: 1,
  },
  {
    ...awardBase(
      'award-alpha-bob-merged',
      'alpha',
      ALPHA_REPOSITORY,
      BOB,
      '2026-07-09T10:00:00.000Z',
      {kind: 'pr', number: 106, title: 'Bob improves caching'},
    ),
    kind: 'merged_pr',
    points: 10,
  },
  {
    ...awardBase(
      'award-alpha-bob-evidence',
      'alpha',
      ALPHA_REPOSITORY,
      BOB,
      '2026-07-09T10:00:00.000Z',
      {kind: 'pr', number: 106, title: 'Bob improves caching'},
    ),
    kind: 'evidence',
    evidenceKind: 'screenshot',
    points: 1,
  },
  {
    ...awardBase(
      'award-alpha-evaluation',
      'alpha',
      ALPHA_REPOSITORY,
      ALICE,
      '2026-07-08T10:00:00.000Z',
      {kind: 'pr', number: 105, title: 'Evaluate Alpha outcome'},
    ),
    kind: 'evaluation',
    evaluationPoints: 12,
    points: 8,
  },
  {
    ...awardBase(
      'award-alpha-review',
      'alpha',
      ALPHA_REPOSITORY,
      ALICE,
      '2026-07-07T10:00:00.000Z',
      {kind: 'review', number: 104, title: 'Review Alpha change'},
    ),
    kind: 'review',
    points: 3,
  },
  {
    ...awardBase(
      'award-alpha-evidence',
      'alpha',
      ALPHA_REPOSITORY,
      ALICE,
      '2026-07-06T10:00:00.000Z',
      {kind: 'pr', number: 103, title: 'Demonstrate Alpha change'},
    ),
    kind: 'evidence',
    evidenceKind: 'video',
    points: 2,
  },
  {
    ...awardBase(
      'award-alpha-test',
      'alpha',
      ALPHA_REPOSITORY,
      ALICE,
      '2026-07-05T10:00:00.000Z',
      {kind: 'pr', number: 102, title: 'Test Alpha behavior'},
    ),
    kind: 'test_change',
    points: 4,
  },
  {
    ...awardBase(
      'award-alpha-issue',
      'alpha',
      ALPHA_REPOSITORY,
      ALICE,
      '2026-07-04T10:00:00.000Z',
      {kind: 'issue', number: 101, title: 'Resolve Alpha issue'},
    ),
    kind: 'resolved_issue',
    points: 4,
  },
  {
    ...awardBase(
      'award-alpha-merged',
      'alpha',
      ALPHA_REPOSITORY,
      ALICE,
      '2026-07-03T10:00:00.000Z',
      {kind: 'pr', number: 100, title: 'Ship Alpha feature'},
    ),
    kind: 'merged_pr',
    points: 10,
    runId: 'run-alpha',
  },
  {
    ...awardBase(
      'award-zeta-evaluation',
      'zeta',
      ZETA_REPOSITORY,
      BOB,
      '2026-07-02T11:00:00.000Z',
      {kind: 'pr', number: 201, title: 'Evaluate Zeta outcome'},
    ),
    kind: 'evaluation',
    evaluationPoints: 25,
    points: 8,
    runId: 'run-zeta',
  },
  {
    ...awardBase(
      'award-zeta-issue',
      'zeta',
      ZETA_REPOSITORY,
      BOB,
      '2026-07-02T10:00:00.000Z',
      {kind: 'issue', number: 200, title: 'Resolve Zeta issue'},
    ),
    kind: 'resolved_issue',
    points: 4,
  },
];

function receipt(
  runId: string,
  project: Project['id'],
  repo: RunReceipt['repo'],
  actorModel: RunReceipt['agent'],
  startedAt: string,
  completedAt: string,
  usage: RunReceipt['usage'],
  trajectorySha256?: string,
): RunReceipt {
  const value: RunReceipt = {
    version: 1,
    runId,
    project,
    repo,
    startedAt: parseCanonicalTimestamp(startedAt),
    completedAt: parseCanonicalTimestamp(completedAt),
    agent: actorModel,
    skill: {revision: `${runId}-revision`, sha256: 'a'.repeat(64)},
    usage,
    device: {
      keyId: `${runId}-device-key`,
      publicKey: `${runId}-public-key`,
    },
    signature: `${runId}-signature`,
  };
  return trajectorySha256 === undefined ? value : {...value, trajectorySha256};
}

const RECEIPTS: readonly RunReceipt[] = [
  receipt(
    'run-zeta',
    'zeta',
    ZETA_REPOSITORY,
    {client: 'claude-code', provider: 'anthropic', model: 'claude-opus-4.1'},
    '2026-07-02T08:30:00.000Z',
    '2026-07-02T09:30:00.000Z',
    {confidence: 'bounded', totalTokens: 500000, costMicroUsd: '250000'},
    'f'.repeat(64),
  ),
  receipt(
    'run-carol',
    'alpha',
    ALPHA_REPOSITORY,
    {client: 'codex', provider: 'openai', model: 'gpt-5'},
    '2026-07-09T08:30:00.000Z',
    '2026-07-09T09:30:00.000Z',
    {confidence: 'unavailable', totalTokens: 0, costMicroUsd: '0'},
  ),
  receipt(
    'run-alpha',
    'alpha',
    ALPHA_REPOSITORY,
    {client: 'codex', provider: 'openai', model: 'gpt-5'},
    '2026-07-03T08:30:00.000Z',
    '2026-07-03T09:30:00.000Z',
    {confidence: 'exact', totalTokens: 123456, costMicroUsd: '654321'},
  ),
];

const FIXED_SNAPSHOT = buildSnapshot(
  GENERATED_AT,
  WINDOW,
  PROJECTS,
  BUCKETS,
  AWARDS,
  RECEIPTS,
);

type MutableBreakdown = {
  -readonly [Category in keyof ScoreBreakdown]: number;
};
type MutableCounts = {-readonly [Category in keyof ScoreCounts]: number};

function summarizeAwards(awards: readonly Award[]): {
  readonly score: number;
  readonly breakdown: ScoreBreakdown;
  readonly counts: ScoreCounts;
} {
  const breakdown: MutableBreakdown = {
    merged_pr: 0,
    resolved_issue: 0,
    test_change: 0,
    evidence: 0,
    review: 0,
    evaluation: 0,
  };
  const counts: MutableCounts = {
    merged_pr: 0,
    resolved_issue: 0,
    test_change: 0,
    review: 0,
    evaluation: 0,
  };
  let score = 0;

  for (const award of awards) {
    score += award.points;
    switch (award.kind) {
      case 'merged_pr':
        breakdown.merged_pr += award.points;
        counts.merged_pr += 1;
        break;
      case 'resolved_issue':
        breakdown.resolved_issue += award.points;
        counts.resolved_issue += 1;
        break;
      case 'test_change':
        breakdown.test_change += award.points;
        counts.test_change += 1;
        break;
      case 'evidence':
        breakdown.evidence += award.points;
        break;
      case 'review':
        breakdown.review += award.points;
        counts.review += 1;
        break;
      case 'evaluation':
        breakdown.evaluation += award.points;
        counts.evaluation += 1;
        break;
      default:
        assertNever(award);
    }
  }

  return {score, breakdown, counts};
}

function assertNever(value: never): never {
  throw new Error(`Unhandled award: ${JSON.stringify(value)}`);
}

function containsKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some(item => containsKey(item, key));
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(
    ([entryKey, entryValue]) =>
      entryKey === key || containsKey(entryValue, key),
  );
}

async function readGolden(): Promise<string> {
  return readFile(GOLDEN_PATH, 'utf8');
}

async function withTemporaryDirectory<T>(
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'ship-snapshot-contract-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

describe('snapshot static-data contract', () => {
  test('matches the checked-in golden snapshot exactly', async () => {
    const golden = await readGolden();
    const parsed: unknown = JSON.parse(golden);

    expect(validateSnapshot(parsed)).toEqual(FIXED_SNAPSHOT);
    expect(golden).toBe(
      `${JSON.stringify(JSON.parse(canonicalJson(FIXED_SNAPSHOT)), null, 2)}\n`,
    );
  });

  test('orders every public collection deterministically', () => {
    const rebuilt = buildSnapshot(
      GENERATED_AT,
      WINDOW,
      [...PROJECTS].reverse(),
      [...BUCKETS].reverse(),
      [...AWARDS].reverse(),
      [...RECEIPTS].reverse(),
    );

    expect(rebuilt).toEqual(FIXED_SNAPSHOT);
    expect(FIXED_SNAPSHOT.projects.map(project => project.id)).toEqual([
      'alpha',
      'zeta',
    ]);
    expect(
      FIXED_SNAPSHOT.buckets.map(bucket => [
        bucket.project,
        bucket.cycle,
        bucket.score,
        bucket.actor.id,
      ]),
    ).toEqual([
      ['alpha', '2026-07', 31, 'U_alice'],
      ['alpha', '2026-07', 11, 'U_bob'],
      ['alpha', '2026-07', 11, 'U_carol'],
      ['alpha', '2026-08', 3, 'U_alice'],
      ['zeta', '2026-07', 12, 'U_bob'],
    ]);
    expect(FIXED_SNAPSHOT.awards.map(award => award.id)).toEqual([
      'award-zeta-issue',
      'award-zeta-evaluation',
      'award-alpha-merged',
      'award-alpha-issue',
      'award-alpha-test',
      'award-alpha-evidence',
      'award-alpha-review',
      'award-alpha-evaluation',
      'award-alpha-bob-evidence',
      'award-alpha-bob-merged',
      'award-alpha-carol-evidence',
      'award-alpha-carol-merged',
      'award-alpha-august-review',
    ]);
    expect(FIXED_SNAPSHOT.receipts.map(receipt => receipt.runId)).toEqual([
      'run-alpha',
      'run-carol',
      'run-zeta',
    ]);
  });

  test('keeps every score exactly auditable from its award ledger', () => {
    expect(validateSnapshot(FIXED_SNAPSHOT)).toBe(FIXED_SNAPSHOT);

    for (const bucket of FIXED_SNAPSHOT.buckets) {
      const awards = FIXED_SNAPSHOT.awards.filter(
        award =>
          award.project === bucket.project &&
          award.cycle === bucket.cycle &&
          award.actor.id === bucket.actor.id,
      );
      expect(summarizeAwards(awards)).toEqual({
        score: bucket.score,
        breakdown: bucket.breakdown,
        counts: bucket.counts,
      });
    }
  });

  test('contains canonical data only, without frontend-derived state', () => {
    expect(Object.keys(FIXED_SNAPSHOT).sort()).toEqual([
      'awards',
      'buckets',
      'generatedAt',
      'projects',
      'receipts',
      'schemaVersion',
      'window',
    ]);

    for (const forbidden of [
      'globalScore',
      'globalTotal',
      'leaderboard',
      'percentage',
      'rank',
      'share',
      'totalScore',
    ]) {
      expect(containsKey(FIXED_SNAPSHOT, forbidden)).toBe(false);
    }
  });
});

describe('snapshot atomic writer contract', () => {
  test('replaces an existing destination with exact golden bytes', async () => {
    await withTemporaryDirectory(async directory => {
      const outputPath = join(directory, 'snapshot.json');
      await writeFile(outputPath, 'stale snapshot', 'utf8');

      await writeSnapshot(FIXED_SNAPSHOT, outputPath);

      expect(await readFile(outputPath, 'utf8')).toBe(await readGolden());
      expect(await readdir(directory)).toEqual(['snapshot.json']);
    });
  });

  test('preserves the destination when validation fails', async () => {
    await withTemporaryDirectory(async directory => {
      const outputPath = join(directory, 'snapshot.json');
      await writeFile(outputPath, 'existing snapshot', 'utf8');

      await expect(
        writeSnapshot({...FIXED_SNAPSHOT, awards: []}, outputPath),
      ).rejects.toThrow(/awards|bucket/i);

      expect(await readFile(outputPath, 'utf8')).toBe('existing snapshot');
      expect(await readdir(directory)).toEqual(['snapshot.json']);
    });
  });

  test('cleans up the temporary file when replacement fails', async () => {
    await withTemporaryDirectory(async directory => {
      const outputPath = join(directory, 'snapshot.json');
      await mkdir(outputPath);

      await expect(writeSnapshot(FIXED_SNAPSHOT, outputPath)).rejects.toThrow();

      expect(await readdir(directory)).toEqual(['snapshot.json']);
    });
  });
});
