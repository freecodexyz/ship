import {readFile} from 'node:fs/promises';

import {describe, expect, test} from 'bun:test';

import {createCycleProposal} from './createCycleProposal.js';
import {editCycleProposal} from './editCycleProposal.js';
import {BASE_MAINNET_CHAIN_ID} from './resolveActorWallet.js';
import {validateSnapshot} from './snapshot.js';

const SNAPSHOT_PATH = 'tests/fixtures/snapshot/complete.golden.json';
const WALLET = '0x1111111111111111111111111111111111111111' as const;

async function proposal() {
  const value: unknown = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
  const snapshot = validateSnapshot(value);
  const walletResolutions = new Map(
    snapshot.buckets
      .filter(
        bucket => bucket.project === 'alpha' && bucket.cycle === '2026-07',
      )
      .map(bucket => [
        bucket.actor.id,
        {
          status: 'bound' as const,
          actorId: bucket.actor.id,
          chainId: BASE_MAINNET_CHAIN_ID,
          wallet: WALLET,
        },
      ]),
  );
  return createCycleProposal({
    project: 'alpha',
    cycle: '2026-07',
    generatedAt: snapshot.generatedAt,
    snapshot,
    sourceSnapshotSha256: 'a'.repeat(64),
    walletResolutions,
  });
}

describe('editCycleProposal', () => {
  test('records the final agreed amount and resets review after a material change', async () => {
    const initial = await proposal();
    const row = initial.allocations[0];
    expect(row).toBeDefined();
    if (row === undefined) return;

    const edited = editCycleProposal({
      proposal: initial,
      intentId: row.intentId,
      changedAt: '2026-09-02T00:05:00.000Z',
      state: 'approved',
      approvedBaseUnits: row.projectedBaseUnits,
      adjustmentReason: null,
    });

    expect(edited.allocations[0]).toMatchObject({
      canonicalScore: row.canonicalScore,
      projectedBaseUnits: row.projectedBaseUnits,
      approvedBaseUnits: row.projectedBaseUnits,
      state: 'approved',
    });
    expect(edited.review).toMatchObject({
      lastMaterialChangeAt: '2026-09-02T00:05:00.000Z',
      endsAt: '2026-09-16T00:05:00.000Z',
    });
    expect(edited.totals.approvedBaseUnits).toBe(row.projectedBaseUnits);
    expect(initial.allocations[0]?.approvedBaseUnits).toBe('0');
  });

  test('requires reasons for reductions and coherent final states', async () => {
    const initial = await proposal();
    const row = initial.allocations[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    const input = {
      proposal: initial,
      intentId: row.intentId,
      changedAt: '2026-09-02T00:05:00.000Z',
    };

    expect(() =>
      editCycleProposal({
        ...input,
        state: 'approved',
        approvedBaseUnits: '1',
        adjustmentReason: null,
      }),
    ).toThrow('reduction requires');
    expect(() =>
      editCycleProposal({
        ...input,
        state: 'excluded',
        approvedBaseUnits: '1',
        adjustmentReason: 'Not eligible after review.',
      }),
    ).toThrow('Non-approved');
    expect(() =>
      editCycleProposal({
        ...input,
        state: 'approved',
        approvedBaseUnits: (BigInt(row.projectedBaseUnits) + 1n).toString(),
        adjustmentReason: null,
      }),
    ).toThrow('cannot exceed');
  });

  test('rejects unknown intents, stale timestamps, and no-op edits', async () => {
    const initial = await proposal();
    const row = initial.allocations[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(() =>
      editCycleProposal({
        proposal: initial,
        intentId: 'missing',
        changedAt: '2026-09-02T00:05:00.000Z',
        state: 'excluded',
        approvedBaseUnits: '0',
        adjustmentReason: 'Not eligible after review.',
      }),
    ).toThrow('Unknown proposal intent');
    expect(() =>
      editCycleProposal({
        proposal: initial,
        intentId: row.intentId,
        changedAt: String(initial.review.lastMaterialChangeAt),
        state: 'excluded',
        approvedBaseUnits: '0',
        adjustmentReason: 'Not eligible after review.',
      }),
    ).toThrow('must be newer');
    expect(() =>
      editCycleProposal({
        proposal: initial,
        intentId: row.intentId,
        changedAt: '2026-09-02T00:05:00.000Z',
        state: row.state,
        approvedBaseUnits: row.approvedBaseUnits,
        adjustmentReason: row.adjustmentReason,
      }),
    ).toThrow('does not materially change');
  });
});
