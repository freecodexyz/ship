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

import {BASE_MAINNET_CHAIN_ID} from './resolveActorWallet.js';
import {verifyStoredCycleProposal} from './verifyStoredCycleProposal.js';
import {writeCycleProposal} from './writeCycleProposal.js';

const directories: string[] = [];
const PROJECT = 'alpha';
const CYCLE = '2026-07';
const SNAPSHOT_PATH = 'tests/fixtures/snapshot/complete.golden.json';

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map(directory => rm(directory, {recursive: true, force: true})),
  );
});

describe('verifyStoredCycleProposal', () => {
  test('rejects missing, partial, and tampered canonical cycles', async () => {
    const cyclesDirectory = await mkdtemp(join(tmpdir(), 'ship-verify-'));
    directories.push(cyclesDirectory);
    const cycleDirectory = join(cyclesDirectory, PROJECT, CYCLE);
    await mkdir(cycleDirectory, {recursive: true});
    const input = {project: PROJECT, cycle: CYCLE, cyclesDirectory};

    await expect(verifyStoredCycleProposal(input)).rejects.toThrow(
      'Reward cycle does not exist',
    );
    await writeFile(join(cycleDirectory, 'proposal.json'), '{}');
    await expect(verifyStoredCycleProposal(input)).rejects.toThrow(
      'Cycle is partial',
    );
    await rm(cycleDirectory, {recursive: true, force: true});
    await writeCycle(cyclesDirectory);
    await writeFile(
      join(cycleDirectory, 'source-snapshot.json'),
      Buffer.concat([
        await readFile(join(cycleDirectory, 'source-snapshot.json')),
        Buffer.from(' '),
      ]),
    );
    await expect(verifyStoredCycleProposal(input)).rejects.toThrow(
      'SHA-256 does not match',
    );
  });

  test('rejects path traversal and symbolic-link cycle files', async () => {
    await expect(
      verifyStoredCycleProposal({project: `../${PROJECT}`, cycle: CYCLE}),
    ).rejects.toThrow('canonical project ID');

    const cyclesDirectory = await mkdtemp(join(tmpdir(), 'ship-verify-'));
    directories.push(cyclesDirectory);
    const sourceCyclesDirectory = join(cyclesDirectory, 'source');
    const cycleDirectory = join(cyclesDirectory, 'target', PROJECT, CYCLE);
    await writeCycle(sourceCyclesDirectory);
    await mkdir(cycleDirectory, {recursive: true});
    await symlink(
      join(sourceCyclesDirectory, PROJECT, CYCLE, 'proposal.json'),
      join(cycleDirectory, 'proposal.json'),
    );
    await writeFile(
      join(cycleDirectory, 'source-snapshot.json'),
      await readFile(
        join(sourceCyclesDirectory, PROJECT, CYCLE, 'source-snapshot.json'),
      ),
    );

    await expect(
      verifyStoredCycleProposal({
        project: PROJECT,
        cycle: CYCLE,
        cyclesDirectory: join(cyclesDirectory, 'target'),
      }),
    ).rejects.toThrow('must be a regular file');
  });
});

async function writeCycle(cyclesDirectory: string): Promise<void> {
  await writeCycleProposal({
    project: PROJECT,
    cycle: CYCLE,
    generatedAt: '2026-09-01T00:05:00.000Z',
    snapshotPath: SNAPSHOT_PATH,
    cyclesDirectory,
    resolveWallet: async actor => ({
      status: 'unbound',
      actorId: actor.id,
      chainId: BASE_MAINNET_CHAIN_ID,
    }),
  });
}
