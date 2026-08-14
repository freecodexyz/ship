import {expect, test} from 'bun:test';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {loadProjects, projectForRepo} from './projects.js';
import {parseCanonicalTimestamp} from './time.js';

function project(
  id: string,
  repositoryId = `owner/${id}`,
): Record<string, unknown> {
  return {
    id,
    name: `Project ${id}`,
    mission: `Deliver bounded, reviewable improvements to Project ${id}.`,
    repositories: [{id: repositoryId, branch: 'main'}],
    allowedModels: [{client: 'codex', provider: 'openai', model: 'gpt-5'}],
  };
}

async function withProjectFiles<T>(
  files: Readonly<Record<string, unknown>>,
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'ship-projects-'));
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

async function expectInvalid(
  files: Readonly<Record<string, unknown>>,
): Promise<void> {
  await withProjectFiles(files, async directory => {
    await expect(loadProjects(directory)).rejects.toBeInstanceOf(TypeError);
  });
}

test('loads projects by id and maps normalized repository ownership', async () => {
  await withProjectFiles(
    {
      'first-file.json': project('zulu', 'MixedCase/Repository'),
      'second-file.json': project('alpha'),
      'ignored.txt': project('ignored'),
    },
    async directory => {
      const loaded = await loadProjects(directory);

      expect(loaded.projects.map(value => value.id)).toEqual(['alpha', 'zulu']);
      expect(loaded.projects[1]?.repositories[0]?.id).toBe(
        'MixedCase/Repository',
      );
      expect(loaded.projectsByRepo.get('mixedcase/repository')?.id).toBe(
        'zulu',
      );
    },
  );
});

test('finds a project using GitHub case-insensitive repository semantics', async () => {
  await withProjectFiles(
    {'project.json': project('project', 'MixedCase/Repository')},
    async directory => {
      const loaded = await loadProjects(directory);

      const owner = projectForRepo(
        'MIXEDCASE/repository',
        loaded.projectsByRepo,
      );

      expect(owner).toBe(loaded.projects[0]);
      expect(owner?.repositories[0]?.id).toBe('MixedCase/Repository');
    },
  );
});

test('returns undefined for an unowned repository', async () => {
  await withProjectFiles(
    {'project.json': project('project')},
    async directory => {
      const loaded = await loadProjects(directory);

      expect(
        projectForRepo('another/repository', loaded.projectsByRepo),
      ).toBeUndefined();
    },
  );
});

test('accepts a valid canonical reward', async () => {
  await withProjectFiles(
    {
      'rewarded.json': {
        ...project('rewarded'),
        reward: {
          startsAt: '2026-08-01T00:00:00.000Z',
          token: {address: `0x${'1'.repeat(40)}`, decimals: 6, symbol: 'USDC'},
          monthlyPoolBaseUnits: '1000000',
        },
      },
    },
    async directory => {
      const loaded = await loadProjects(directory);
      expect(loaded.projects[0]?.reward).toEqual({
        startsAt: parseCanonicalTimestamp('2026-08-01T00:00:00.000Z'),
        token: {
          address: `0x${'1'.repeat(40)}`,
          decimals: 6,
          symbol: 'USDC',
        },
        monthlyPoolBaseUnits: '1000000',
      });
    },
  );
});

test('loads optional funding metadata without changing reward paths', async () => {
  await withProjectFiles(
    {
      'funded.json': {
        ...project('funded'),
        reward: {
          startsAt: '2026-08-01T00:00:00.000Z',
          token: {address: `0x${'1'.repeat(40)}`, decimals: 6, symbol: 'USDC'},
          monthlyPoolBaseUnits: '1000000',
          funding: {
            status: 'committed',
            settlement: 'owner-executed',
            committedBaseUnits: '2500000',
            unusedFunds: 'rollover-without-cap-increase',
          },
        },
      },
    },
    async directory => {
      const reward = (await loadProjects(directory)).projects[0]?.reward;

      expect(reward?.monthlyPoolBaseUnits).toBe('1000000');
      expect(reward?.funding).toEqual({
        status: 'committed',
        settlement: 'owner-executed',
        committedBaseUnits: '2500000',
        unusedFunds: 'rollover-without-cap-increase',
      });
    },
  );
});

test('rejects duplicate project ids', async () => {
  await expectInvalid({
    'one.json': project('same', 'owner/one'),
    'two.json': project('same', 'owner/two'),
  });
});

test('rejects case-insensitive duplicate repository ownership', async () => {
  await expectInvalid({
    'one.json': project('one', 'Owner/Repo'),
    'two.json': project('two', 'owner/repo'),
  });
});

test.each([
  ['malformed project id', {...project('valid'), id: 'Not-Lowercase'}],
  [
    'malformed repository id',
    {
      ...project('valid'),
      repositories: [{id: 'owner/repo/path', branch: 'main'}],
    },
  ],
  [
    'invalid branch',
    {
      ...project('valid'),
      repositories: [{id: 'owner/repo', branch: 'bad..ref'}],
    },
  ],
  [
    'invalid reward timestamp',
    {
      ...project('valid'),
      reward: {
        startsAt: '2026-08-01',
        token: {address: `0x${'1'.repeat(40)}`, decimals: 18, symbol: 'SHIP'},
        monthlyPoolBaseUnits: '1',
      },
    },
  ],
  [
    'invalid reward integer',
    {
      ...project('valid'),
      reward: {
        startsAt: '2026-08-01T00:00:00.000Z',
        monthlyPoolBaseUnits: '1.5',
      },
    },
  ],
  [
    'invalid pledged funding metadata',
    {
      ...project('valid'),
      reward: {
        startsAt: '2026-08-01T00:00:00.000Z',
        token: {address: `0x${'1'.repeat(40)}`, decimals: 18, symbol: 'SHIP'},
        monthlyPoolBaseUnits: '1',
        funding: {
          status: 'pledged',
          settlement: 'owner-executed',
          unusedFunds: 'rollover-without-cap-increase',
        },
      },
    },
  ],
  [
    'invalid committed funding metadata',
    {
      ...project('valid'),
      reward: {
        startsAt: '2026-08-01T00:00:00.000Z',
        token: {address: `0x${'1'.repeat(40)}`, decimals: 18, symbol: 'SHIP'},
        monthlyPoolBaseUnits: '1',
        funding: {
          status: 'committed',
          settlement: 'owner-executed',
          committedBaseUnits: '0',
          unusedFunds: 'rollover-without-cap-increase',
        },
      },
    },
  ],
  [
    'duplicate allowed model tuple',
    {
      ...project('valid'),
      allowedModels: [
        {client: 'codex', provider: 'openai', model: 'gpt-5'},
        {client: 'codex', provider: 'openai', model: 'gpt-5'},
      ],
    },
  ],
  ['unknown top-level field', {...project('valid'), slug: 'valid'}],
] as const)('rejects %s', async (_description, value) => {
  await expectInvalid({'invalid.json': value});
});
