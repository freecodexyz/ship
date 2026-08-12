import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {describe, expect, test} from 'bun:test';

import {canonicalJson} from './crypto.js';
import {BASE_MAINNET_CHAIN_ID} from './resolveActorWallet.js';
import {parseCanonicalTimestamp} from './time.js';
import {verifyCycleProposal} from './verifyCycleProposal.js';
import {writeCycleProposal} from './writeCycleProposal.js';

const FIXTURE_PATH = 'tests/fixtures/snapshot/complete.golden.json';
const WALLET = '0x1111111111111111111111111111111111111111';

async function withTemporaryDirectory<T>(
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'ship-proposal-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

describe('writeCycleProposal', () => {
  test('binds exact source bytes and writes deterministic pretty JSON', async () => {
    await withTemporaryDirectory(async directory => {
      const sourceBytes = await readFile(FIXTURE_PATH);
      const snapshotPath = join(directory, 'frozen.json');
      const cyclesDirectory = join(directory, 'cycles');
      const outputPath = join(
        cyclesDirectory,
        'alpha',
        '2026-07',
        'proposal.json',
      );
      await writeFile(snapshotPath, sourceBytes);
      const observed: string[] = [];

      const proposal = await writeCycleProposal({
        project: 'alpha',
        cycle: '2026-07',
        generatedAt: '2026-09-01T00:05:00.000Z',
        snapshotPath,
        cyclesDirectory,
        resolveWallet: async actor => {
          observed.push(actor.id);
          return actor.id === 'U_alice'
            ? {
                status: 'bound',
                actorId: actor.id,
                chainId: BASE_MAINNET_CHAIN_ID,
                wallet: WALLET,
              }
            : {
                status: 'unbound',
                actorId: actor.id,
                chainId: BASE_MAINNET_CHAIN_ID,
              };
        },
      });

      expect(observed).toEqual(['U_alice', 'U_bob', 'U_carol']);
      expect(proposal.sourceSnapshot.sha256).toBe(
        createHash('sha256').update(sourceBytes).digest('hex'),
      );
      expect(proposal.review.days).toBe(14);
      expect(String(proposal.review.lastMaterialChangeAt)).toBe(
        '2026-09-01T00:05:00.000Z',
      );
      expect(String(proposal.review.endsAt)).toBe('2026-09-15T00:05:00.000Z');
      expect(
        await readFile(
          join(cyclesDirectory, 'alpha', '2026-07', 'source-snapshot.json'),
        ),
      ).toEqual(sourceBytes);
      const written = await readFile(outputPath, 'utf8');
      expect(written).toBe(
        `${JSON.stringify(JSON.parse(canonicalJson(proposal)), null, 2)}\n`,
      );
    });
  });

  test('refuses to replace an existing proposal', async () => {
    await withTemporaryDirectory(async directory => {
      const cyclesDirectory = join(directory, 'cycles');
      const cycleDirectory = join(cyclesDirectory, 'alpha', '2026-07');
      const outputPath = join(cycleDirectory, 'proposal.json');
      const snapshotArchivePath = join(cycleDirectory, 'source-snapshot.json');
      await mkdir(cycleDirectory, {recursive: true});
      await writeFile(outputPath, 'keep me');
      await writeFile(snapshotArchivePath, 'keep snapshot');
      await expect(
        writeCycleProposal({
          project: 'alpha',
          cycle: '2026-07',
          generatedAt: '2026-09-01T00:05:00.000Z',
          snapshotPath: FIXTURE_PATH,
          cyclesDirectory,
          resolveWallet: async actor => ({
            status: 'unbound',
            actorId: actor.id,
            chainId: BASE_MAINNET_CHAIN_ID,
          }),
        }),
      ).rejects.toThrow('Refusing to replace');
      expect(await readFile(outputPath, 'utf8')).toBe('keep me');
    });
  });

  test.each(['proposal.json', 'source-snapshot.json'])(
    'refuses partial cycles containing only %s before resolving wallets',
    async existingFile => {
      await withTemporaryDirectory(async directory => {
        const cyclesDirectory = join(directory, 'cycles');
        const cycleDirectory = join(cyclesDirectory, 'alpha', '2026-07');
        await mkdir(cycleDirectory, {recursive: true});
        await writeFile(join(cycleDirectory, existingFile), '{}');
        let resolutionCount = 0;

        await expect(
          writeCycleProposal({
            project: 'alpha',
            cycle: '2026-07',
            generatedAt: '2026-09-01T00:05:00.000Z',
            snapshotPath: FIXTURE_PATH,
            cyclesDirectory,
            resolveWallet: async actor => {
              resolutionCount += 1;
              return {
                status: 'unbound',
                actorId: actor.id,
                chainId: BASE_MAINNET_CHAIN_ID,
              };
            },
          }),
        ).rejects.toThrow('Cycle is partial');
        expect(resolutionCount).toBe(0);
      });
    },
  );

  test('rejects non-canonical project and cycle path segments', async () => {
    await withTemporaryDirectory(async directory => {
      const input = {
        generatedAt: '2026-09-01T00:05:00.000Z',
        snapshotPath: FIXTURE_PATH,
        cyclesDirectory: join(directory, 'cycles'),
        resolveWallet: async (actor: {readonly id: string}) => ({
          status: 'unbound' as const,
          actorId: actor.id,
          chainId: BASE_MAINNET_CHAIN_ID,
        }),
      };
      await expect(
        writeCycleProposal({...input, project: '../alpha', cycle: '2026-07'}),
      ).rejects.toThrow('canonical project ID');
      await expect(
        writeCycleProposal({...input, project: 'alpha', cycle: '../2026-07'}),
      ).rejects.toThrow('must use YYYY-MM');
    });
  });

  test('rejects archived-byte, review, wallet-time, and allocation tampering', async () => {
    await withTemporaryDirectory(async directory => {
      const cyclesDirectory = join(directory, 'cycles');
      const sourceBytes = await readFile(FIXTURE_PATH);
      const proposal = await writeCycleProposal({
        project: 'alpha',
        cycle: '2026-07',
        generatedAt: '2026-09-01T00:05:00.000Z',
        snapshotPath: FIXTURE_PATH,
        cyclesDirectory,
        resolveWallet: async actor => ({
          status: 'bound',
          actorId: actor.id,
          chainId: BASE_MAINNET_CHAIN_ID,
          wallet: WALLET,
        }),
      });

      expect(() =>
        verifyCycleProposal(
          proposal,
          Buffer.concat([sourceBytes, Buffer.from(' ')]),
        ),
      ).toThrow('SHA-256 does not match');
      expect(() =>
        verifyCycleProposal(
          {
            ...proposal,
            review: {
              ...proposal.review,
              endsAt: parseCanonicalTimestamp('2026-09-14T00:05:00.000Z'),
            },
          },
          sourceBytes,
        ),
      ).toThrow('must end 14 days');
      expect(() =>
        verifyCycleProposal(
          {
            ...proposal,
            review: {
              ...proposal.review,
              lastMaterialChangeAt: parseCanonicalTimestamp(
                '2026-09-01T00:04:59.999Z',
              ),
              endsAt: parseCanonicalTimestamp('2026-09-15T00:04:59.999Z'),
            },
          },
          sourceBytes,
        ),
      ).toThrow('predate proposal generation');
      expect(() =>
        verifyCycleProposal(
          {
            ...proposal,
            allocations: proposal.allocations.map((allocation, index) =>
              index === 0
                ? {...allocation, projectedBaseUnits: '1'}
                : allocation,
            ),
          },
          sourceBytes,
        ),
      ).toThrow('differs from');
      expect(() =>
        verifyCycleProposal(
          {
            ...proposal,
            allocations: proposal.allocations.map((allocation, index) =>
              index === 0 ? {...allocation, canonicalScore: 1} : allocation,
            ),
          },
          sourceBytes,
        ),
      ).toThrow('differs from');
      expect(() => verifyCycleProposal({}, sourceBytes)).toThrow(
        'sourceSnapshot must be an object',
      );
    });
  });

  test('does not write when a lookup or snapshot validation fails', async () => {
    await withTemporaryDirectory(async directory => {
      const cyclesDirectory = join(directory, 'cycles');
      const outputPath = join(
        cyclesDirectory,
        'alpha',
        '2026-07',
        'proposal.json',
      );
      await expect(
        writeCycleProposal({
          project: 'alpha',
          cycle: '2026-07',
          generatedAt: '2026-09-01T00:05:00.000Z',
          snapshotPath: FIXTURE_PATH,
          cyclesDirectory,
          resolveWallet: async actor => ({
            status: 'error',
            actorId: actor.id,
            chainId: BASE_MAINNET_CHAIN_ID,
            reason: 'contract-call-failed',
          }),
        }),
      ).rejects.toThrow('contract-call-failed');
      await expect(readFile(outputPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });

      const malformedPath = join(directory, 'malformed.json');
      await writeFile(malformedPath, '{');
      await expect(
        writeCycleProposal({
          project: 'alpha',
          cycle: '2026-07',
          generatedAt: '2026-09-01T00:05:00.000Z',
          snapshotPath: malformedPath,
          cyclesDirectory,
          resolveWallet: async actor => ({
            status: 'unbound',
            actorId: actor.id,
            chainId: BASE_MAINNET_CHAIN_ID,
          }),
        }),
      ).rejects.toThrow('not valid JSON');
    });
  });
});
