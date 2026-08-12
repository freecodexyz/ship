import {afterEach, describe, expect, test} from 'bun:test';
import {mkdir, mkdtemp, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

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
