import {randomUUID} from 'node:crypto';
import {
  lstat,
  open,
  readFile,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import {join, resolve} from 'node:path';

import {canonicalJson} from './crypto.js';
import {
  BASE_MAINNET_UIK_ADDRESS,
  type ActorWalletResolution,
} from './resolveActorWallet.js';
import {parseCanonicalTimestamp} from './time.js';
import type {Actor} from './types.js';
import {
  editCycleProposal,
  type EditCycleProposalInput,
} from './editCycleProposal.js';
import {verifyCycleProposal} from './verifyCycleProposal.js';

const PROJECT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CYCLE_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;

export type WriteCycleProposalReviewInput = Omit<
  EditCycleProposalInput,
  'proposal'
> & {
  readonly project: string;
  readonly cycle: string;
  /** Root used for tests or embedding; cycle paths below it remain canonical. */
  readonly cyclesDirectory?: string;
  readonly resolveWallet?: (actor: Actor) => Promise<ActorWalletResolution>;
};

/** Verifies and atomically rewrites only the review-owned proposal fields. */
export async function writeCycleProposalReview(
  input: WriteCycleProposalReviewInput,
): Promise<ReturnType<typeof editCycleProposal>> {
  if (!PROJECT_ID_PATTERN.test(input.project)) {
    throw new TypeError('Proposal project must be a canonical project ID.');
  }
  if (!CYCLE_PATTERN.test(input.cycle)) {
    throw new TypeError('Proposal cycle must use YYYY-MM.');
  }
  const directory = join(
    input.cyclesDirectory ?? 'cycles',
    input.project,
    input.cycle,
  );
  const proposalPath = resolve(directory, 'proposal.json');
  const snapshotPath = resolve(directory, 'source-snapshot.json');
  await assertCompleteCycle(proposalPath, snapshotPath);
  const [proposalBytes, snapshotBytes] = await Promise.all([
    readFile(proposalPath),
    readFile(snapshotPath),
  ]);
  const proposal = verifyCycleProposal(parseJson(proposalBytes), snapshotBytes);
  if (proposal.project !== input.project || proposal.cycle !== input.cycle) {
    throw new TypeError('Proposal does not match its canonical cycle path.');
  }
  const row = proposal.allocations.find(
    allocation => allocation.intentId === input.intentId,
  );
  if (row === undefined) {
    throw new TypeError(`Unknown proposal intent "${input.intentId}".`);
  }
  const refreshedWallet =
    input.resolveWallet === undefined
      ? undefined
      : walletFromResolution(
          await input.resolveWallet(row.actor),
          row.actor.id,
          input.changedAt,
        );
  const edited = editCycleProposal({
    proposal,
    intentId: input.intentId,
    changedAt: input.changedAt,
    state: input.state,
    approvedBaseUnits: input.approvedBaseUnits,
    adjustmentReason: input.adjustmentReason,
    ...(refreshedWallet === undefined
      ? input.wallet === undefined
        ? {}
        : {wallet: input.wallet}
      : {wallet: refreshedWallet}),
  });
  verifyCycleProposal(edited, snapshotBytes);
  await replaceFileAtomically(proposalPath, proposalBytesFor(edited));
  const written = await readFile(proposalPath);
  const verified = verifyCycleProposal(parseJson(written), snapshotBytes);
  if (!written.equals(proposalBytesFor(edited))) {
    throw new Error('Written review proposal bytes do not match the edit.');
  }
  return verified;
}

function walletFromResolution(
  resolution: ActorWalletResolution,
  actorId: string,
  observedAt: string,
): NonNullable<EditCycleProposalInput['wallet']> | null {
  if (resolution.actorId !== actorId) {
    throw new TypeError('Wallet resolution does not match the reviewed Actor.');
  }
  switch (resolution.status) {
    case 'bound':
      return {
        chainId: resolution.chainId,
        address: resolution.wallet,
        identityContract: BASE_MAINNET_UIK_ADDRESS,
        observedAt: parseCanonicalTimestamp(observedAt),
      };
    case 'unbound':
      return null;
    case 'error':
      throw new Error(`Wallet resolution failed: ${resolution.reason}.`);
    default:
      return assertNever(resolution);
  }
}

async function assertCompleteCycle(
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
  if (!proposalExists) throw new Error('Reward cycle does not exist.');
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

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error: unknown) {
    throw new TypeError('Proposal is not valid JSON.', {cause: error});
  }
}

function proposalBytesFor(
  proposal: ReturnType<typeof editCycleProposal>,
): Buffer {
  return Buffer.from(
    `${JSON.stringify(JSON.parse(canonicalJson(proposal)), null, 2)}\n`,
    'utf8',
  );
}

async function replaceFileAtomically(
  path: string,
  bytes: Buffer,
): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let temporaryFile: FileHandle | undefined;
  try {
    temporaryFile = await open(temporaryPath, 'wx', 0o644);
    await temporaryFile.writeFile(bytes);
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;
    await rename(temporaryPath, path);
  } finally {
    await temporaryFile?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(error => {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    });
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected wallet resolution: ${String(value)}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
