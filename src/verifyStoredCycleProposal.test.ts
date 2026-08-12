import {afterEach, describe, expect, test} from 'bun:test';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {verifyStoredCycleProposal} from './verifyStoredCycleProposal.js';

const directories: string[] = [];
const canonicalCycle = join('cycles', 'microcodex', '2026-08');

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map(directory => rm(directory, {recursive: true, force: true})),
  );
});

describe('verifyStoredCycleProposal', () => {
  test('verifies the canonical reviewed proposal against exact archived bytes', async () => {
    const proposal = await verifyStoredCycleProposal({
      project: 'microcodex',
      cycle: '2026-08',
    });

    expect(proposal.allocations[0]).toMatchObject({
      approvedBaseUnits: '1000000000',
      state: 'approved',
    });
    expect(proposal.sourceSnapshot.sha256).toBe(
      '54c2515061a47b52640501ffc1153aedbe9cc4254e92a8c30ce692c5b7a135a3',
    );
  });

  test('rejects missing, partial, and tampered canonical cycles', async () => {
    const cyclesDirectory = await mkdtemp(join(tmpdir(), 'ship-verify-'));
    directories.push(cyclesDirectory);
    const cycleDirectory = join(cyclesDirectory, 'microcodex', '2026-08');
    await mkdir(cycleDirectory, {recursive: true});
    const input = {project: 'microcodex', cycle: '2026-08', cyclesDirectory};

    await expect(verifyStoredCycleProposal(input)).rejects.toThrow(
      'Reward cycle does not exist',
    );
    await writeFile(
      join(cycleDirectory, 'proposal.json'),
      await readFile(join(canonicalCycle, 'proposal.json')),
    );
    await expect(verifyStoredCycleProposal(input)).rejects.toThrow(
      'Cycle is partial',
    );
    await writeFile(
      join(cycleDirectory, 'source-snapshot.json'),
      Buffer.concat([
        await readFile(join(canonicalCycle, 'source-snapshot.json')),
        Buffer.from(' '),
      ]),
    );
    await expect(verifyStoredCycleProposal(input)).rejects.toThrow(
      'SHA-256 does not match',
    );
  });

  test('rejects path traversal and symbolic-link cycle files', async () => {
    await expect(
      verifyStoredCycleProposal({project: '../microcodex', cycle: '2026-08'}),
    ).rejects.toThrow('canonical project ID');

    const cyclesDirectory = await mkdtemp(join(tmpdir(), 'ship-verify-'));
    directories.push(cyclesDirectory);
    const cycleDirectory = join(cyclesDirectory, 'microcodex', '2026-08');
    await mkdir(cycleDirectory, {recursive: true});
    await symlink(
      join(process.cwd(), canonicalCycle, 'proposal.json'),
      join(cycleDirectory, 'proposal.json'),
    );
    await writeFile(
      join(cycleDirectory, 'source-snapshot.json'),
      await readFile(join(canonicalCycle, 'source-snapshot.json')),
    );

    await expect(
      verifyStoredCycleProposal({
        project: 'microcodex',
        cycle: '2026-08',
        cyclesDirectory,
      }),
    ).rejects.toThrow('must be a regular file');
  });
});
