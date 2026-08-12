import {afterEach, describe, expect, test} from 'bun:test';
import {mkdir, mkdtemp, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

import type {CycleProposal} from './createCycleProposal.js';
import {runCli} from './cli.js';
import type {WriteCycleProposalInput} from './writeCycleProposal.js';

const directories: string[] = [];
const repositoryRoot = process.cwd();

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map(directory => rm(directory, {recursive: true, force: true})),
  );
});

describe('CLI', () => {
  test('runs as bun src/cli.ts and prints a short generation summary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ship-cli-'));
    directories.push(directory);
    const projectsDirectory = join(directory, 'projects');
    const outputPath = join(directory, 'snapshot.json');
    await mkdir(projectsDirectory);

    const result = await invoke(
      [
        '--projects-dir',
        projectsDirectory,
        '--output',
        outputPath,
        '--now',
        '2026-08-12T12:00:00.000Z',
        '--collection-window-days',
        '2',
      ],
      'test-token',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('ship: Loading project configuration...\n');
    expect(result.stderr).toContain(
      'ship: Collecting 0 projects from 2026-08-10T12:00:00.000Z to 2026-08-12T12:00:00.000Z.\n',
    );
    expect(result.stderr).toContain(
      `ship: Validated 0 buckets and 0 awards; writing ${outputPath}...\n`,
    );
    expect(result.stderr).toContain(`ship: Wrote ${outputPath}.\n`);
    expect(result.stdout).toBe(
      `Generated 0 projects, 0 buckets, 0 awards, and 0 receipts in ${outputPath}.\n`,
    );
    expect(JSON.parse(await readFile(outputPath, 'utf8'))).toMatchObject({
      generatedAt: '2026-08-12T12:00:00.000Z',
      window: {
        from: '2026-08-10T12:00:00.000Z',
        to: '2026-08-12T12:00:00.000Z',
      },
      projects: [],
      buckets: [],
      awards: [],
      receipts: [],
    });
  });

  test('exits non-zero when GITHUB_TOKEN is absent', async () => {
    const result = await invoke([], undefined);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('GITHUB_TOKEN must be set');
  });

  test('exits non-zero when generation fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ship-cli-'));
    directories.push(directory);
    const result = await invoke(
      ['--projects-dir', join(directory, 'missing-projects')],
      'test-token',
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ship: generation failed:');
  });

  test('runs proposal generation as a subcommand of the same CLI', async () => {
    const writes: WriteCycleProposalInput[] = [];
    const stdout = captureOutput();
    const stderr = captureOutput();
    const proposal = {
      project: 'microcodex',
      cycle: '2026-08',
      allocations: [],
    } as unknown as CycleProposal;

    const exitCode = await runCli(
      [
        'proposal',
        '--project',
        'microcodex',
        '--cycle',
        '2026-08',
        '--generated-at',
        '2026-09-01T00:00:00.000Z',
        '--base-rpc-url',
        'https://mainnet.base.org',
      ],
      {GITHUB_TOKEN: 'github-token'},
      stdout,
      stderr,
      {
        createWalletResolver: (token, rpcUrl) => {
          expect(token).toBe('github-token');
          expect(rpcUrl).toBe('https://mainnet.base.org');
          return async () => {
            throw new Error('unused');
          };
        },
        generate: async () => {
          throw new Error('generate command must not run');
        },
        writeProposal: async input => {
          writes.push(input);
          return proposal;
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe('');
    expect(stdout.text()).toContain('cycles/microcodex/2026-08/proposal.json');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      project: 'microcodex',
      cycle: '2026-08',
      generatedAt: '2026-09-01T00:00:00.000Z',
      snapshotPath: 'dist/snapshot.json',
    });
  });

  test('proposal subcommand reports writer failures', async () => {
    const stdout = captureOutput();
    const stderr = captureOutput();
    const exitCode = await runCli(
      [
        'proposal',
        '--project',
        'microcodex',
        '--cycle',
        '2026-08',
        '--generated-at',
        '2026-09-01T00:00:00.000Z',
        '--base-rpc-url',
        'https://mainnet.base.org',
        '--snapshot',
        'frozen.json',
      ],
      {GITHUB_TOKEN: 'token'},
      stdout,
      stderr,
      {
        createWalletResolver: () => async () => {
          throw new Error('unused');
        },
        generate: async () => {
          throw new Error('unused');
        },
        writeProposal: async () => {
          throw new Error('cycle already exists');
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe('');
    expect(stderr.text()).toContain(
      'ship: proposal failed: cycle already exists',
    );
  });

  test('proposal subcommand requires authentication and narrow arguments', async () => {
    const stdout = captureOutput();
    const stderr = captureOutput();
    const dependencies = {
      createWalletResolver: () => async () => {
        throw new Error('unused');
      },
      generate: async () => {
        throw new Error('unused');
      },
      writeProposal: async () => {
        throw new Error('unused');
      },
    };
    const missingToken = await runCli(
      [
        'proposal',
        '--project',
        'microcodex',
        '--cycle',
        '2026-08',
        '--generated-at',
        '2026-09-01T00:00:00.000Z',
        '--base-rpc-url',
        'https://mainnet.base.org',
      ],
      {},
      stdout,
      stderr,
      dependencies,
    );
    expect(missingToken).toBe(1);
    expect(stderr.text()).toContain(
      'GITHUB_TOKEN must be set to a non-whitespace token',
    );

    const invalidCycle = await runCli(
      ['proposal', '--project', 'microcodex', '--cycle', 'August'],
      {GITHUB_TOKEN: 'token'},
      stdout,
      stderr,
      dependencies,
    );
    expect(invalidCycle).toBe(1);
    expect(stderr.text()).toContain('--cycle must use YYYY-MM');
  });

  test.each([
    [['--unknown', 'value'], 'unknown flag: --unknown'],
    [['--output'], 'missing value for --output'],
    [
      ['--now', '2026-08-12'],
      '--now must use canonical UTC form YYYY-MM-DDTHH:mm:ss.sssZ',
    ],
    [
      ['--collection-window-days', '0'],
      '--collection-window-days must be a positive integer',
    ],
    [['--output', 'one', '--output', 'two'], 'duplicate flag: --output'],
  ])('rejects invalid narrow flags %#', async (args, expectedMessage) => {
    const result = await invoke(args, 'test-token');

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(expectedMessage);
    expect(result.stderr).toContain('Usage: bun src/cli.ts');
  });
});

function captureOutput(): {write(value: string): void; text(): string} {
  let contents = '';
  return {
    write(value: string): void {
      contents += value;
    },
    text(): string {
      return contents;
    },
  };
}

async function invoke(
  args: readonly string[],
  token: string | undefined,
): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const subprocess = Bun.spawn([process.execPath, 'src/cli.ts', ...args], {
    cwd: repositoryRoot,
    env: {...process.env, GITHUB_TOKEN: token},
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);

  return {exitCode, stdout, stderr};
}
