import {createHash, randomUUID} from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';

import {canonicalJson} from './crypto.js';
import {
  createCycleProposal,
  type CycleProposal,
} from './createCycleProposal.js';
import type {ActorWalletResolution} from './resolveActorWallet.js';
import {validateSnapshot} from './snapshot.js';
import {parseCanonicalTimestamp} from './time.js';
import type {Actor} from './types.js';
import {verifyCycleProposal} from './verifyCycleProposal.js';

const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_WALLET_LOOKUPS = 200;
const PROJECT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CYCLE_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const WALLET_LOOKUP_CONCURRENCY = 4;

export type WriteCycleProposalInput = {
  readonly project: string;
  readonly cycle: string;
  readonly generatedAt: string;
  readonly snapshotPath: string;
  /** Root used for tests or embedding; cycle paths below it remain canonical. */
  readonly cyclesDirectory?: string;
  readonly resolveWallet: (actor: Actor) => Promise<ActorWalletResolution>;
};

/**
 * Reads a frozen final-cycle snapshot and writes a new immutable proposal file.
 *
 * The source JSON is fully validated before receipt weights are recomputed.
 * Wallet lookups are bounded and order preserving. Existing output is never
 * replaced, and no contract transaction is performed.
 */
export async function writeCycleProposal(
  input: WriteCycleProposalInput,
): Promise<CycleProposal> {
  const generatedAt = parseCanonicalTimestamp(input.generatedAt);
  if (!PROJECT_ID_PATTERN.test(input.project)) {
    throw new TypeError('Proposal project must be a canonical project ID.');
  }
  if (!CYCLE_PATTERN.test(input.cycle)) {
    throw new TypeError('Proposal cycle must use YYYY-MM.');
  }
  const cycleDirectory = join(
    input.cyclesDirectory ?? 'cycles',
    input.project,
    input.cycle,
  );
  const canonicalOutputPath = join(cycleDirectory, 'proposal.json');
  const canonicalSnapshotArchivePath = join(
    cycleDirectory,
    'source-snapshot.json',
  );
  const outputPath = resolve(canonicalOutputPath);
  const snapshotArchivePath = resolve(canonicalSnapshotArchivePath);
  await assertCyclePathsAbsent(outputPath, snapshotArchivePath);
  const sourceBytes = await readBoundedSnapshot(input.snapshotPath);
  const untrustedSnapshot = parseJson(sourceBytes);
  const snapshot = validateSnapshot(untrustedSnapshot);
  const project = snapshot.projects.find(
    candidate => candidate.id === input.project,
  );
  if (project === undefined) {
    throw new TypeError(
      `Snapshot does not contain project "${input.project}".`,
    );
  }

  const actors = snapshot.buckets
    .filter(
      bucket =>
        bucket.project === input.project && bucket.cycle === input.cycle,
    )
    .sort(
      (left, right) =>
        right.score - left.score || compareText(left.actor.id, right.actor.id),
    )
    .map(bucket => bucket.actor);
  if (actors.length > MAX_WALLET_LOOKUPS) {
    throw new RangeError(
      `Cycle has more than ${MAX_WALLET_LOOKUPS} wallet lookups.`,
    );
  }

  const resolutions = await mapConcurrent(
    actors,
    WALLET_LOOKUP_CONCURRENCY,
    async actor => ({actor, resolution: await input.resolveWallet(actor)}),
  );
  const walletResolutions = new Map(
    resolutions.map(({actor, resolution}) => [actor.id, resolution] as const),
  );
  const proposal = createCycleProposal({
    project: project.id,
    cycle: input.cycle,
    generatedAt,
    snapshot,
    sourceSnapshotSha256: createHash('sha256')
      .update(sourceBytes)
      .digest('hex'),
    walletResolutions,
  });
  verifyCycleProposal(proposal, sourceBytes);
  await writeNewFileAtomically(snapshotArchivePath, sourceBytes);
  try {
    await writeNewFileAtomically(outputPath, proposalBytes(proposal));
  } catch (error: unknown) {
    await unlink(snapshotArchivePath).catch(() => undefined);
    throw error;
  }
  const archivedBytes = await readFile(snapshotArchivePath);
  const writtenProposalBytes = await readFile(outputPath);
  if (!archivedBytes.equals(sourceBytes)) {
    throw new Error('Archived snapshot bytes do not match source snapshot.');
  }
  if (!writtenProposalBytes.equals(proposalBytes(proposal))) {
    throw new Error('Written proposal bytes do not match generated proposal.');
  }
  verifyCycleProposal(parseJson(writtenProposalBytes), archivedBytes);
  return proposal;
}

async function readBoundedSnapshot(path: string): Promise<Buffer> {
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_SNAPSHOT_BYTES) {
    throw new RangeError('Frozen snapshot exceeds the 64 MiB size limit.');
  }
  return bytes;
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error: unknown) {
    throw new TypeError('Frozen snapshot is not valid JSON.', {cause: error});
  }
}

async function assertCyclePathsAbsent(
  proposalPath: string,
  snapshotPath: string,
): Promise<void> {
  const [proposalExists, snapshotExists] = await Promise.all([
    regularFileExists(proposalPath),
    regularFileExists(snapshotPath),
  ]);
  if (proposalExists !== snapshotExists) {
    throw new Error(
      'Cycle is partial; proposal and source snapshot must coexist.',
    );
  }
  if (proposalExists) {
    throw new Error('Refusing to replace an existing reward cycle.');
  }
}

async function regularFileExists(path: string): Promise<boolean> {
  const stats = await lstat(path).catch((error: unknown) => {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (stats === undefined) return false;
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new TypeError(`Cycle path "${path}" must be a regular file.`);
  }
  return true;
}

function proposalBytes(proposal: CycleProposal): Buffer {
  return Buffer.from(
    `${JSON.stringify(JSON.parse(canonicalJson(proposal)), null, 2)}\n`,
    'utf8',
  );
}

async function writeNewFileAtomically(
  path: string,
  bytes: Buffer,
): Promise<void> {
  await mkdir(dirname(path), {recursive: true});
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let temporaryFile: FileHandle | undefined;
  try {
    temporaryFile = await open(temporaryPath, 'wx', 0o644);
    await temporaryFile.writeFile(bytes);
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;
    try {
      await link(temporaryPath, path);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'EEXIST') {
        throw new Error(`Refusing to replace existing proposal "${path}".`, {
          cause: error,
        });
      }
      throw error;
    }
  } finally {
    await temporaryFile?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(error => {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    });
  }
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  transform: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await transform(value);
    }
  }

  await Promise.all(
    Array.from({length: Math.min(concurrency, values.length)}, () => worker()),
  );
  return results;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
