import {afterEach, describe, expect, test} from 'bun:test';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

import {generate, type GenerationOptions} from './generate.js';
import {parseCanonicalTimestamp} from './time.js';
import type {GitHubClient} from './github.js';
import type {Project, PullRequest, RunReceipt} from './types.js';

const directories: string[] = [];
const project: Project = {
  id: 'alpha',
  name: 'Alpha',
  mission: 'Deliver bounded, reviewable improvements to Ship.',
  repositories: [{id: 'owner/repository', branch: 'main'}],
  reward: {
    startsAt: parseCanonicalTimestamp('2026-01-01T00:00:00.000Z'),
    token: {address: `0x${'1'.repeat(40)}`, decimals: 18, symbol: 'SHIP'},
    monthlyPoolBaseUnits: '1000',
  },
  allowedModels: [],
};
const pullRequest: PullRequest = {
  id: 'PR_1',
  repo: 'owner/repository',
  number: 1,
  title: 'Ship generation',
  author: {id: 'ACTOR_1', login: 'contributor'},
  mergedAt: parseCanonicalTimestamp('2026-08-10T12:00:00.000Z'),
  headSha: 'a'.repeat(40),
  files: [],
  closedIssueIds: [],
  reviews: [],
  evidence: [],
};

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map(directory => rm(directory, {recursive: true, force: true})),
  );
});

describe('generate', () => {
  test('orchestrates normalized data into a validated written snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ship-generate-'));
    directories.push(directory);
    const projectsDirectory = join(directory, 'projects');
    const outputPath = join(directory, 'snapshot.json');
    await mkdir(projectsDirectory);
    await writeFile(
      join(projectsDirectory, 'alpha.json'),
      JSON.stringify(project),
      'utf8',
    );
    let collected:
      | {
          readonly repositories: Parameters<GitHubClient['collect']>[0];
          readonly window: Parameters<GitHubClient['collect']>[1];
        }
      | undefined;
    const githubClient: GitHubClient = {
      collect: async (repositories, window) => {
        collected = {repositories, window};
        return {
          pullRequests: [
            {
              ...pullRequest,
              receipt: {version: 2} as unknown as RunReceipt,
            },
          ],
          issues: [],
        };
      },
    };

    const messages: string[] = [];
    const options = {
      githubClient,
      log: (message: string) => messages.push(message),
      projectsDirectory,
      outputPath,
      now: '2026-08-12T12:00:00.000Z',
      collectionWindowDays: 2,
      includeRewards: true,
    } satisfies GenerationOptions;
    const snapshot = await generate(options);

    expect(snapshot.window).toEqual({
      from: parseCanonicalTimestamp('2026-08-10T12:00:00.000Z'),
      to: parseCanonicalTimestamp('2026-08-12T12:00:00.000Z'),
    });
    expect(collected).toEqual({
      repositories: project.repositories,
      window: snapshot.window,
    });
    expect(snapshot.buckets).toHaveLength(1);
    expect(snapshot.buckets[0]?.score).toBe(10);
    expect(snapshot.awards).toHaveLength(1);
    expect(snapshot.receipts).toEqual([]);
    expect(snapshot.rewards).toEqual([
      {
        project: 'alpha',
        cycle: '2026-08',
        actorId: 'ACTOR_1',
        canonicalScore: 10,
        creditedTokens: 0,
        computeBonusBasisPoints: 0,
        adjustedWeight: 100000,
        projectedBaseUnits: '1000',
      },
    ]);
    expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual(snapshot);
    expect(messages).toEqual([
      'Loading project configuration...',
      'Collecting 1 projects from 2026-08-10T12:00:00.000Z to 2026-08-12T12:00:00.000Z.',
      'Collecting project 1/1: alpha...',
      'Collected alpha: 1 pull requests, 0 issues.',
      'Scoring 1 pull requests and 0 issues...',
      `Validated 1 buckets and 1 awards; writing ${outputPath}...`,
      `Wrote ${outputPath}.`,
    ]);
  });

  test('does not score nested events outside the collection window', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ship-generate-'));
    directories.push(directory);
    const projectsDirectory = join(directory, 'projects');
    const outputPath = join(directory, 'snapshot.json');
    await mkdir(projectsDirectory);
    await writeFile(
      join(projectsDirectory, 'alpha.json'),
      JSON.stringify(project),
      'utf8',
    );
    const githubClient: GitHubClient = {
      collect: async () => ({
        pullRequests: [
          {
            ...pullRequest,
            reviews: [
              {
                id: 'REVIEW_OLD',
                author: {id: 'REVIEWER', login: 'reviewer'},
                state: 'APPROVED',
                submittedAt: parseCanonicalTimestamp(
                  '2026-08-09T12:00:00.000Z',
                ),
                bodyLength: 50,
                inlineComments: 0,
              },
            ],
          },
        ],
        issues: [],
      }),
    };

    const snapshot = await generate({
      githubClient,
      projectsDirectory,
      outputPath,
      now: '2026-08-12T12:00:00.000Z',
      collectionWindowDays: 2,
    });

    expect(snapshot.awards.map(award => award.kind)).toEqual(['merged_pr']);
  });

  test('uses an explicit deterministic collection window', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ship-generate-'));
    directories.push(directory);
    const projectsDirectory = join(directory, 'projects');
    const outputPath = join(directory, 'snapshot.json');
    await mkdir(projectsDirectory);
    await writeFile(
      join(projectsDirectory, 'alpha.json'),
      JSON.stringify(project),
      'utf8',
    );
    const window = {
      from: parseCanonicalTimestamp('2026-07-01T00:00:00.000Z'),
      to: parseCanonicalTimestamp('2026-08-01T00:00:00.000Z'),
    };
    let collectedWindow: Parameters<GitHubClient['collect']>[1] | undefined;
    const githubClient: GitHubClient = {
      collect: async (_repositories, receivedWindow) => {
        collectedWindow = receivedWindow;
        return {pullRequests: [], issues: []};
      },
    };

    const snapshot = await generate({
      githubClient,
      projectsDirectory,
      outputPath,
      now: '2026-08-12T12:00:00.000Z',
      window,
      includeRewards: false,
    });

    expect(snapshot.generatedAt).toBe(
      parseCanonicalTimestamp('2026-08-12T12:00:00.000Z'),
    );
    expect(snapshot.window).toEqual(window);
    expect(collectedWindow).toEqual(window);
    expect(snapshot.rewards).toBeUndefined();
    expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual(snapshot);
  });

  test('rejects ambiguous window options before collecting data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ship-generate-'));
    directories.push(directory);
    const projectsDirectory = join(directory, 'projects');
    const outputPath = join(directory, 'snapshot.json');
    await mkdir(projectsDirectory);
    await writeFile(outputPath, 'unchanged', 'utf8');
    let collections = 0;
    const githubClient: GitHubClient = {
      collect: async () => {
        collections += 1;
        return {pullRequests: [], issues: []};
      },
    };

    const invalidOptions = {
      githubClient,
      projectsDirectory,
      outputPath,
      now: '2026-08-12T12:00:00.000Z',
      collectionWindowDays: 35,
      window: {
        from: parseCanonicalTimestamp('2026-07-01T00:00:00.000Z'),
        to: parseCanonicalTimestamp('2026-08-01T00:00:00.000Z'),
      },
    } as unknown as GenerationOptions;

    await expect(generate(invalidOptions)).rejects.toThrow(
      'either an explicit window',
    );
    expect(collections).toBe(0);
    expect(await readFile(outputPath, 'utf8')).toBe('unchanged');
  });
});
