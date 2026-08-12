import {lstat, readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';

import type {CycleProposal} from './createCycleProposal.js';
import {verifyCycleProposal} from './verifyCycleProposal.js';

const MAX_PROPOSAL_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const PROJECT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CYCLE_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;

export type VerifyStoredCycleProposalInput = {
  readonly project: string;
  readonly cycle: string;
  /** Root used for tests or embedding; cycle paths below it remain canonical. */
  readonly cyclesDirectory?: string;
};

/** Verifies a complete proposal against its exact canonical snapshot archive. */
export async function verifyStoredCycleProposal(
  input: VerifyStoredCycleProposalInput,
): Promise<CycleProposal> {
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
    readBoundedFile(proposalPath, MAX_PROPOSAL_BYTES, 'Proposal'),
    readBoundedFile(snapshotPath, MAX_SNAPSHOT_BYTES, 'Source snapshot'),
  ]);
  const proposal = verifyCycleProposal(
    parseProposal(proposalBytes),
    snapshotBytes,
  );
  if (proposal.project !== input.project || proposal.cycle !== input.cycle) {
    throw new TypeError('Proposal does not match its canonical cycle path.');
  }
  return proposal;
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

async function readBoundedFile(
  path: string,
  maximumBytes: number,
  label: string,
): Promise<Buffer> {
  const bytes = await readFile(path);
  if (bytes.byteLength > maximumBytes) {
    throw new RangeError(`${label} exceeds the 64 MiB size limit.`);
  }
  return bytes;
}

function parseProposal(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error: unknown) {
    throw new TypeError('Proposal is not valid JSON.', {cause: error});
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
