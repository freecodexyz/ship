import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {describe, expect, test} from 'bun:test';

import {BASE_MAINNET_CHAIN_ID} from './resolveActorWallet.js';
import {writeCycleProposal} from './writeCycleProposal.js';
import {writeCycleProposalReview} from './writeCycleProposalReview.js';

const FIXTURE_PATH = 'tests/fixtures/snapshot/complete.golden.json';
const WALLET = '0x1111111111111111111111111111111111111111' as const;

async function withCycle<T>(
  run: (input: {
    cyclesDirectory: string;
    intentId: string;
    snapshotPath: string;
  }) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'ship-review-'));
  try {
    const cyclesDirectory = join(directory, 'cycles');
    const snapshotPath = join(directory, 'frozen.json');
    await writeFile(snapshotPath, await readFile(FIXTURE_PATH));
    const proposal = await writeCycleProposal({
      project: 'alpha',
      cycle: '2026-07',
      generatedAt: '2026-09-01T00:05:00.000Z',
      snapshotPath,
      cyclesDirectory,
      resolveWallet: async actor => ({
        status: 'bound',
        actorId: actor.id,
        chainId: BASE_MAINNET_CHAIN_ID,
        wallet: WALLET,
      }),
    });
    const intentId = proposal.allocations[0]?.intentId;
    if (intentId === undefined) throw new Error('fixture has no allocation');
    return await run({cyclesDirectory, intentId, snapshotPath});
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

describe('writeCycleProposalReview', () => {
  test('rewrites only proposal.json and preserves exact source bytes', async () => {
    await withCycle(async ({cyclesDirectory, intentId}) => {
      const sourcePath = join(
        cyclesDirectory,
        'alpha',
        '2026-07',
        'source-snapshot.json',
      );
      const before = await readFile(sourcePath);
      const edited = await writeCycleProposalReview({
        project: 'alpha',
        cycle: '2026-07',
        cyclesDirectory,
        intentId,
        changedAt: '2026-09-02T00:05:00.000Z',
        state: 'excluded',
        approvedBaseUnits: '0',
        adjustmentReason: 'Excluded after public review.',
      });

      expect(edited.allocations[0]).toMatchObject({
        state: 'excluded',
        approvedBaseUnits: '0',
        adjustmentReason: 'Excluded after public review.',
      });
      expect(await readFile(sourcePath)).toEqual(before);
    });
  });

  test('refreshes only the target wallet and fails closed on resolver errors', async () => {
    await withCycle(async ({cyclesDirectory, intentId}) => {
      const edited = await writeCycleProposalReview({
        project: 'alpha',
        cycle: '2026-07',
        cyclesDirectory,
        intentId,
        changedAt: '2026-09-02T00:05:00.000Z',
        state: 'approved',
        approvedBaseUnits: '590888',
        adjustmentReason: null,
        resolveWallet: async actor => ({
          status: 'bound',
          actorId: actor.id,
          chainId: BASE_MAINNET_CHAIN_ID,
          wallet: '0x2222222222222222222222222222222222222222',
        }),
      });
      expect(edited.allocations[0]?.wallet).toMatchObject({
        address: '0x2222222222222222222222222222222222222222',
        observedAt: '2026-09-02T00:05:00.000Z',
      });
      const proposalPath = join(
        cyclesDirectory,
        'alpha',
        '2026-07',
        'proposal.json',
      );
      const beforeFailure = await readFile(proposalPath);
      await expect(
        writeCycleProposalReview({
          project: 'alpha',
          cycle: '2026-07',
          cyclesDirectory,
          intentId,
          changedAt: '2026-09-03T00:05:00.000Z',
          state: 'approved',
          approvedBaseUnits: '590888',
          adjustmentReason: null,
          resolveWallet: async actor => ({
            status: 'error',
            actorId: actor.id,
            chainId: BASE_MAINNET_CHAIN_ID,
            reason: 'contract-call-failed',
          }),
        }),
      ).rejects.toThrow('contract-call-failed');
      expect(await readFile(proposalPath)).toEqual(beforeFailure);
    });
  });

  test('refuses missing, partial, and source-tampered cycles', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ship-review-missing-'));
    try {
      const input = {
        project: 'alpha',
        cycle: '2026-07',
        cyclesDirectory: join(directory, 'cycles'),
        intentId: 'reward_alpha_2026_07_0001_u_alice',
        changedAt: '2026-09-02T00:05:00.000Z',
        state: 'excluded' as const,
        approvedBaseUnits: '0',
        adjustmentReason: 'Excluded after public review.',
      };
      await expect(writeCycleProposalReview(input)).rejects.toThrow(
        'does not exist',
      );
    } finally {
      await rm(directory, {recursive: true, force: true});
    }

    await withCycle(async ({cyclesDirectory, intentId}) => {
      const sourcePath = join(
        cyclesDirectory,
        'alpha',
        '2026-07',
        'source-snapshot.json',
      );
      await writeFile(sourcePath, '{}');
      await expect(
        writeCycleProposalReview({
          project: 'alpha',
          cycle: '2026-07',
          cyclesDirectory,
          intentId,
          changedAt: '2026-09-02T00:05:00.000Z',
          state: 'excluded',
          approvedBaseUnits: '0',
          adjustmentReason: 'Excluded after public review.',
        }),
      ).rejects.toThrow();
    });
  });
});
