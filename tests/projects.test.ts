import {describe, expect, test} from 'bun:test';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {loadProjects, projectForRepo} from '../src/projects.js';
import {parseCanonicalTimestamp} from '../src/time.js';

const FIXTURES_DIRECTORY = fileURLToPath(
  new URL('./fixtures/projects/', import.meta.url),
);
const CANONICAL_TIMESTAMP = parseCanonicalTimestamp('2026-08-01T00:00:00.000Z');
const TOKEN = {
  address: `0x${'1'.repeat(40)}` as `0x${string}`,
  decimals: 18,
  symbol: 'SHIP',
};

function fixtureDirectory(name: string): string {
  return join(FIXTURES_DIRECTORY, name);
}

function project(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: 'project',
    name: 'Project',
    repositories: [{id: 'owner/repository', branch: 'main'}],
    allowedModels: [],
    ...overrides,
  };
}

async function withProjectFiles<T>(
  files: Readonly<Record<string, unknown>>,
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'ship-project-contract-'));
  const directory = join(root, 'projects');
  await mkdir(directory);

  try {
    await Promise.all(
      Object.entries(files).map(([filename, value]) =>
        writeFile(join(directory, filename), JSON.stringify(value), 'utf8'),
      ),
    );
    return await run(directory);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

async function expectInvalidProject(value: unknown, message: RegExp) {
  await withProjectFiles({'project.json': value}, async directory => {
    await expect(loadProjects(directory)).rejects.toThrow(message);
  });
}

async function expectInvalidFixture(name: string, message: RegExp) {
  await expect(loadProjects(fixtureDirectory(name))).rejects.toThrow(message);
}

describe('valid project configuration contract', () => {
  test('loads minimal projects and preserves validated optional fields', async () => {
    const loaded = await loadProjects(fixtureDirectory('valid'));

    expect(loaded.projects).toEqual([
      {
        id: 'alpha',
        name: 'Alpha Project',
        repositories: [{id: 'Acme/Alpha', branch: 'main'}],
        allowedModels: [],
      },
      {
        id: 'zulu',
        name: 'Zulu Project',
        repositories: [{id: 'MixedCase/Zulu', branch: 'release/next'}],
        reward: {
          startsAt: CANONICAL_TIMESTAMP,
          token: TOKEN,
          monthlyPoolBaseUnits: '1000000',
        },
        allowedModels: [{client: 'codex', provider: 'openai', model: 'gpt-5'}],
      },
    ]);
  });

  test('loads deterministically by project id, independent of file order', async () => {
    const first = await loadProjects(fixtureDirectory('valid'));
    const second = await loadProjects(fixtureDirectory('valid'));

    expect(first.projects.map(value => value.id)).toEqual(['alpha', 'zulu']);
    expect(second.projects).toEqual(first.projects);
    expect([...first.projectsByRepo.keys()]).toEqual([
      'acme/alpha',
      'mixedcase/zulu',
    ]);
  });

  test('enforces case-insensitive repository ownership while preserving source casing', async () => {
    const loaded = await loadProjects(fixtureDirectory('valid'));
    const owner = projectForRepo('MIXEDCASE/zulu', loaded.projectsByRepo);

    expect(owner).toBe(loaded.projects[1]);
    expect(owner?.repositories[0]?.id).toBe('MixedCase/Zulu');
    expect(
      projectForRepo('unowned/repository', loaded.projectsByRepo),
    ).toBeUndefined();
  });
});

describe('project and repository identity contract', () => {
  test('rejects a malformed project id fixture', async () => {
    await expectInvalidFixture('malformed-project-id', /Project id/);
  });

  test.each(['UPPERCASE', '-leading', 'trailing-', 'two--hyphens', 'space id'])(
    'rejects malformed project id %j',
    async id => {
      await expectInvalidProject(project({id}), /Project id/);
    },
  );

  test('rejects a malformed repository id fixture', async () => {
    await expectInvalidFixture('malformed-repository-id', /repository id/i);
  });

  test.each([
    'owner',
    'owner/repository/path',
    '/repository',
    'owner/',
    '-owner/repository',
    'owner/repository name',
  ])('rejects malformed repository id %j', async id => {
    await expectInvalidProject(
      project({repositories: [{id, branch: 'main'}]}),
      /repository id/i,
    );
  });

  test('rejects duplicate repositories within one project case-insensitively', async () => {
    await expectInvalidFixture('duplicate-repositories', /claimed by both/);
  });

  test('rejects repository ownership shared by two projects case-insensitively', async () => {
    await expectInvalidFixture('duplicate-ownership', /claimed by both/);
  });
});

describe('branch validation contract', () => {
  test('rejects an invalid branch fixture', async () => {
    await expectInvalidFixture('invalid-branch', /valid Git branch name/);
  });

  test.each([
    '',
    ' branch',
    'branch ',
    '-branch',
    'branch.',
    '@',
    'feature..next',
    'feature@{next',
    'feature//next',
    'feature/.hidden',
    'feature/next.lock',
    'feature~next',
    'feature^next',
    'feature:next',
    'feature?next',
    'feature*next',
    'feature[next',
    'feature\\next',
    'feature\tnext',
  ])('rejects invalid branch %j', async branch => {
    await expectInvalidProject(
      project({repositories: [{id: 'owner/repository', branch}]}),
      /branch|non-empty trimmed string/,
    );
  });
});

describe('reward validation contract', () => {
  test('accepts arbitrary ERC-20 metadata and base-unit amounts', async () => {
    const token = {
      address: '0xabcdefABCDEFabcdefABCDEFabcdefABCDEFabcd' as `0x${string}`,
      decimals: 0,
      symbol: 'VOTE',
    };
    const loaded = await withProjectFiles(
      {
        'token.json': project({
          reward: {
            startsAt: CANONICAL_TIMESTAMP,
            token,
            monthlyPoolBaseUnits: '900719925474099300000',
          },
        }),
      },
      directory => loadProjects(directory),
    );
    expect(loaded.projects[0]?.reward).toEqual({
      startsAt: CANONICAL_TIMESTAMP,
      token,
      monthlyPoolBaseUnits: '900719925474099300000',
    });
  });

  test.each([
    ['short address', {...TOKEN, address: '0x1234'}, /20-byte EVM address/],
    [
      'non-hex address',
      {...TOKEN, address: `0x${'g'.repeat(40)}`},
      /20-byte EVM address/,
    ],
    ['negative decimals', {...TOKEN, decimals: -1}, /integer from 0 to 255/],
    ['excessive decimals', {...TOKEN, decimals: 256}, /integer from 0 to 255/],
    ['fractional decimals', {...TOKEN, decimals: 1.5}, /integer from 0 to 255/],
    ['empty symbol', {...TOKEN, symbol: ''}, /non-empty trimmed string/],
    [
      'untrimmed symbol',
      {...TOKEN, symbol: ' SHIP'},
      /non-empty trimmed string/,
    ],
  ])('rejects %s', async (_description, token, message) => {
    await expectInvalidProject(
      project({
        reward: {
          startsAt: CANONICAL_TIMESTAMP,
          token,
          monthlyPoolBaseUnits: '1',
        },
      }),
      message,
    );
  });

  test('rejects a non-canonical reward integer fixture', async () => {
    await expectInvalidFixture('invalid-reward', /base-10 integer string/);
  });

  test.each([1, -1, '01', '-1', '+1', '1.5', '1 ', ''])(
    'rejects invalid monthly pool value %j',
    async monthlyPoolBaseUnits => {
      await expectInvalidProject(
        project({
          reward: {startsAt: CANONICAL_TIMESTAMP, monthlyPoolBaseUnits},
        }),
        /base-10 integer string/,
      );
    },
  );

  test('rejects a non-canonical reward timestamp fixture', async () => {
    await expectInvalidFixture('invalid-timestamp', /canonical UTC timestamp/);
  });

  test.each([
    '2026-08-01',
    '2026-08-01T00:00:00Z',
    '2026-08-01T00:00:00.000+00:00',
    '2026-02-30T00:00:00.000Z',
    '2026-13-01T00:00:00.000Z',
  ])('rejects invalid reward timestamp %j', async startsAt => {
    await expectInvalidProject(
      project({reward: {startsAt, token: TOKEN, monthlyPoolBaseUnits: '0'}}),
      /canonical UTC timestamp/,
    );
  });
});

describe('allowed model and exact-schema contract', () => {
  test('rejects duplicate allowed model tuples', async () => {
    await expectInvalidFixture('duplicate-model', /duplicate allowed model/);
  });

  test('rejects an unknown top-level field fixture', async () => {
    await expectInvalidFixture('unknown-field', /unknown field/);
  });

  test.each([
    [
      'repository',
      project({
        repositories: [
          {id: 'owner/repository', branch: 'main', archived: false},
        ],
      }),
    ],
    [
      'reward',
      project({
        reward: {
          startsAt: CANONICAL_TIMESTAMP,
          token: TOKEN,
          monthlyPoolBaseUnits: '0',
          currency: 'USDC',
        },
      }),
    ],
    [
      'model',
      project({
        allowedModels: [
          {
            client: 'codex',
            provider: 'openai',
            model: 'gpt-5',
            alias: 'default',
          },
        ],
      }),
    ],
  ] as const)('rejects an unknown %s field', async (_scope, value) => {
    await expectInvalidProject(value, /unknown field/);
  });
});
