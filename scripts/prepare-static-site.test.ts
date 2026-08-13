import {describe, expect, test} from 'bun:test';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  buildProvenance,
  discoverContributorSkills,
  publishedSnapshotMetadata,
} from './prepare-static-site.js';

describe('discoverContributorSkills', () => {
  test('returns canonical contributor skills in project order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ship-site-test-'));
    try {
      await mkdir(join(root, 'projects'));
      await mkdir(join(root, 'skills', 'contribute-to-zulu'), {
        recursive: true,
      });
      await mkdir(join(root, 'skills', 'contribute-to-alpha'), {
        recursive: true,
      });
      await writeFile(join(root, 'projects', 'zulu.json'), '{}');
      await writeFile(join(root, 'projects', 'alpha.json'), '{}');
      await writeFile(
        join(root, 'skills', 'contribute-to-zulu', 'SKILL.md'),
        'z',
      );
      await writeFile(
        join(root, 'skills', 'contribute-to-alpha', 'SKILL.md'),
        'a',
      );
      expect(await discoverContributorSkills(root)).toEqual([
        {
          id: 'alpha',
          name: 'contribute-to-alpha',
          sourcePath: 'skills/contribute-to-alpha',
        },
        {
          id: 'zulu',
          name: 'contribute-to-zulu',
          sourcePath: 'skills/contribute-to-zulu',
        },
      ]);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  test('rejects a skill without matching canonical project metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ship-site-test-'));
    try {
      await mkdir(join(root, 'projects'));
      await mkdir(join(root, 'skills', 'contribute-to-orphan'), {
        recursive: true,
      });
      await writeFile(
        join(root, 'skills', 'contribute-to-orphan', 'SKILL.md'),
        'x',
      );
      await expect(discoverContributorSkills(root)).rejects.toThrow('orphan');
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });
});

test('buildProvenance binds the complete canonical tree', () => {
  expect(
    buildProvenance(
      {
        id: 'alpha',
        name: 'contribute-to-alpha',
        sourcePath: 'skills/contribute-to-alpha',
      },
      'a'.repeat(40),
      [
        {path: 'SKILL.md', sha256: 'b'.repeat(64)},
        {path: 'policy.json', sha256: 'c'.repeat(64)},
      ],
    ),
  ).toEqual({
    schemaVersion: 1,
    name: 'contribute-to-alpha',
    repository: 'freecodexyz/ship',
    revision: 'a'.repeat(40),
    source: {
      path: 'skills/contribute-to-alpha/SKILL.md',
      sha256: 'b'.repeat(64),
    },
    files: [
      {path: 'SKILL.md', sha256: 'b'.repeat(64)},
      {path: 'policy.json', sha256: 'c'.repeat(64)},
    ],
  });
});

test('publishedSnapshotMetadata describes exact public bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ship-site-test-'));
  try {
    const path = join(root, 'snapshot.json');
    await writeFile(
      path,
      await readFile(
        join(
          import.meta.dir,
          '..',
          'tests',
          'fixtures',
          'snapshot',
          'complete.golden.json',
        ),
      ),
    );
    const metadata = await publishedSnapshotMetadata(path, 'd'.repeat(40));
    expect(metadata.schemaVersion).toBe(1);
    expect(metadata.snapshot.schemaVersion).toBe(3);
    expect(metadata.snapshot.url).toBe(
      'https://ship.freecodefund.xyz/api/v1/snapshot.json',
    );
    expect(metadata.snapshot.bytes).toBe((await readFile(path)).length);
    expect(metadata.source.revision).toBe('d'.repeat(40));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
