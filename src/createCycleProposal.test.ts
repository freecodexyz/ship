import {readFile} from 'node:fs/promises';

import {describe, expect, test} from 'bun:test';

import {createCycleProposal} from './createCycleProposal.js';
import {
  BASE_MAINNET_CHAIN_ID,
  type ActorWalletResolution,
} from './resolveActorWallet.js';
import {validateSnapshot} from './snapshot.js';
import type {Actor, Snapshot} from './types.js';

const SNAPSHOT_PATH = 'tests/fixtures/snapshot/complete.golden.json';
const SOURCE_DIGEST = 'a'.repeat(64);
const ALICE_WALLET = '0x1111111111111111111111111111111111111111';

async function fixture(): Promise<Snapshot> {
  const value: unknown = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
  return validateSnapshot(value);
}

function resolutions(
  snapshot: Snapshot,
  overrides: ReadonlyMap<string, ActorWalletResolution> = new Map(),
): ReadonlyMap<string, ActorWalletResolution> {
  return new Map(
    snapshot.buckets
      .filter(
        bucket => bucket.project === 'alpha' && bucket.cycle === '2026-07',
      )
      .map(bucket => [
        bucket.actor.id,
        overrides.get(bucket.actor.id) ?? {
          status: 'unbound' as const,
          actorId: bucket.actor.id,
          chainId: BASE_MAINNET_CHAIN_ID,
        },
      ]),
  );
}

describe('createCycleProposal', () => {
  test('recomputes receipt weights and exact base-unit allocations', async () => {
    const snapshot = await fixture();
    const proposal = createCycleProposal({
      project: 'alpha',
      cycle: '2026-07',
      generatedAt: snapshot.generatedAt,
      snapshot,
      sourceSnapshotSha256: SOURCE_DIGEST,
      walletResolutions: resolutions(
        snapshot,
        new Map([
          [
            'U_alice',
            {
              status: 'bound',
              actorId: 'U_alice',
              chainId: BASE_MAINNET_CHAIN_ID,
              wallet: ALICE_WALLET,
            },
          ],
        ]),
      ),
    });

    expect(proposal).toMatchObject({
      kind: 'reward-proposal',
      status: 'proposed',
      project: 'alpha',
      cycle: '2026-07',
      generatedAt: snapshot.generatedAt,
      contributionWindow: {
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-08-01T00:00:00.000Z',
      },
      sourceSnapshot: {sha256: SOURCE_DIGEST},
      review: {
        days: 14,
        lastMaterialChangeAt: snapshot.generatedAt,
        endsAt: '2026-09-15T00:05:00.000Z',
      },
      reward: {
        monthlyPoolBaseUnits: '1000000',
        token: {symbol: 'USDC', decimals: 6},
      },
    });
    expect(proposal.allocations.map(row => row.actor.id)).toEqual([
      'U_alice',
      'U_bob',
      'U_carol',
    ]);
    expect(proposal.allocations[0]).toMatchObject({
      canonicalScore: 31,
      state: 'proposed',
      wallet: {
        chainId: BASE_MAINNET_CHAIN_ID,
        address: ALICE_WALLET,
        observedAt: snapshot.generatedAt,
      },
      receiptComputation: {
        creditedTokens: 100000,
        computeBonusBasisPoints: 250,
        adjustedWeight: 317750,
        linkedRunIds: ['run-alpha'],
      },
    });
    expect(proposal.allocations[1]).toMatchObject({
      canonicalScore: 11,
      state: 'unclaimed',
      wallet: null,
      receiptComputation: {
        creditedTokens: 0,
        computeBonusBasisPoints: 0,
        adjustedWeight: 110000,
      },
    });
    expect(
      proposal.allocations.reduce(
        (sum, row) => sum + BigInt(row.projectedBaseUnits),
        0n,
      ),
    ).toBe(1000000n);
    const aliceAllocation = proposal.allocations[0];
    expect(aliceAllocation).toBeDefined();
    if (aliceAllocation === undefined) return;
    expect(proposal.totals).toEqual({
      projectedBaseUnits: '1000000',
      proposedBaseUnits: aliceAllocation.projectedBaseUnits,
      unclaimedBaseUnits: (
        BigInt(proposal.allocations[1]?.projectedBaseUnits ?? '0') +
        BigInt(proposal.allocations[2]?.projectedBaseUnits ?? '0')
      ).toString(),
    });
  });

  test('does not trust optional cached snapshot rewards', async () => {
    const snapshot = await fixture();
    const withBogusProjection = {
      ...snapshot,
      rewards: snapshot.buckets.map(bucket => ({
        project: bucket.project,
        cycle: bucket.cycle,
        actorId: bucket.actor.id,
        canonicalScore: bucket.score,
        creditedTokens: 0,
        computeBonusBasisPoints: 0,
        adjustedWeight: 0,
        projectedBaseUnits: '0',
      })),
    };
    const proposal = createCycleProposal({
      project: 'alpha',
      cycle: '2026-07',
      generatedAt: snapshot.generatedAt,
      snapshot: withBogusProjection,
      sourceSnapshotSha256: SOURCE_DIGEST,
      walletResolutions: resolutions(snapshot),
    });

    expect(proposal.totals.projectedBaseUnits).toBe('1000000');
    expect(proposal.allocations[0]?.receiptComputation.creditedTokens).toBe(
      100000,
    );
  });

  test('fails closed on wallet errors and missing resolutions', async () => {
    const snapshot = await fixture();
    const failed = resolutions(
      snapshot,
      new Map([
        [
          'U_alice',
          {
            status: 'error',
            actorId: 'U_alice',
            chainId: BASE_MAINNET_CHAIN_ID,
            reason: 'contract-call-failed',
          },
        ],
      ]),
    );
    expect(() =>
      createCycleProposal({
        project: 'alpha',
        cycle: '2026-07',
        generatedAt: snapshot.generatedAt,
        snapshot,
        sourceSnapshotSha256: SOURCE_DIGEST,
        walletResolutions: failed,
      }),
    ).toThrow('contract-call-failed');
    expect(() =>
      createCycleProposal({
        project: 'alpha',
        cycle: '2026-07',
        generatedAt: snapshot.generatedAt,
        snapshot,
        sourceSnapshotSha256: SOURCE_DIGEST,
        walletResolutions: new Map(),
      }),
    ).toThrow('Missing wallet resolution');
    const invalidBound = resolutions(
      snapshot,
      new Map([
        [
          'U_alice',
          {
            status: 'bound',
            actorId: 'U_alice',
            chainId: BASE_MAINNET_CHAIN_ID,
            wallet: '0x0000000000000000000000000000000000000000',
          },
        ],
      ]),
    );
    expect(() =>
      createCycleProposal({
        project: 'alpha',
        cycle: '2026-07',
        generatedAt: snapshot.generatedAt,
        snapshot,
        sourceSnapshotSha256: SOURCE_DIGEST,
        walletResolutions: invalidBound,
      }),
    ).toThrow('Invalid wallet resolution');
  });

  test('refuses incomplete, open, inactive, and malformed source inputs', async () => {
    const snapshot = await fixture();
    const input = {
      project: 'alpha',
      cycle: '2026-07',
      generatedAt: snapshot.generatedAt,
      snapshot,
      sourceSnapshotSha256: SOURCE_DIGEST,
      walletResolutions: resolutions(snapshot),
    } as const;

    expect(() =>
      createCycleProposal({
        ...input,
        snapshot: {
          ...snapshot,
          window: {...snapshot.window, from: '2026-07-02T00:00:00.000Z'},
        } as Snapshot,
      }),
    ).toThrow('complete closed');
    expect(() =>
      createCycleProposal({
        ...input,
        snapshot: {
          ...snapshot,
          generatedAt: '2026-07-31T23:59:59.999Z',
        } as Snapshot,
      }),
    ).toThrow('complete closed');
    expect(() =>
      createCycleProposal({
        ...input,
        generatedAt: '2026-08-31T23:59:59.999Z' as Snapshot['generatedAt'],
      }),
    ).toThrow('cannot predate');
    expect(() =>
      createCycleProposal({...input, sourceSnapshotSha256: 'A'.repeat(64)}),
    ).toThrow('SHA-256');
    expect(() => createCycleProposal({...input, project: 'zeta'})).toThrow(
      'no reward policy',
    );
  });

  test('records a closed zero-award cycle without wallet lookups', async () => {
    const snapshot = await fixture();
    const emptySnapshot = {
      ...snapshot,
      buckets: snapshot.buckets.filter(bucket => bucket.project !== 'alpha'),
      awards: snapshot.awards.filter(award => award.project !== 'alpha'),
      receipts: snapshot.receipts.filter(
        receipt => receipt.project !== 'alpha',
      ),
    };
    const proposal = createCycleProposal({
      project: 'alpha',
      cycle: '2026-07',
      generatedAt: snapshot.generatedAt,
      snapshot: emptySnapshot,
      sourceSnapshotSha256: SOURCE_DIGEST,
      walletResolutions: new Map<Actor['id'], ActorWalletResolution>(),
    });

    expect(proposal.allocations).toEqual([]);
    expect(proposal.totals).toEqual({
      projectedBaseUnits: '0',
      proposedBaseUnits: '0',
      unclaimedBaseUnits: '0',
    });
  });
});
