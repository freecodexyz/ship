import {createHash} from 'node:crypto';

import {canonicalJson} from './crypto.js';
import {
  createCycleProposal,
  PROPOSAL_REVIEW_DAYS,
  type CycleProposal,
} from './createCycleProposal.js';
import {
  BASE_MAINNET_CHAIN_ID,
  type ActorWalletResolution,
} from './resolveActorWallet.js';
import {validateSnapshot} from './snapshot.js';
import {parseCanonicalTimestamp} from './time.js';

const DAY_MILLISECONDS = 86_400_000;

/**
 * Verifies a proposal against the exact archived source-snapshot bytes.
 *
 * All score, receipt, allocation, wallet, review, and provenance fields are
 * deterministically re-derived. A proposal cannot validate against a different
 * snapshot, even if that snapshot parses to equivalent JSON.
 */
export function verifyCycleProposal(
  untrustedProposal: unknown,
  sourceSnapshotBytes: Buffer,
): void {
  const proposal = validateProposalBoundary(untrustedProposal);
  const untrustedSnapshot = parseJson(sourceSnapshotBytes);
  const snapshot = validateSnapshot(untrustedSnapshot);
  const snapshotDigest = createHash('sha256')
    .update(sourceSnapshotBytes)
    .digest('hex');
  if (proposal.sourceSnapshot.sha256 !== snapshotDigest) {
    throw new TypeError(
      'Proposal SHA-256 does not match source-snapshot bytes.',
    );
  }
  if (
    proposal.sourceSnapshot.schemaVersion !== snapshot.schemaVersion ||
    proposal.sourceSnapshot.generatedAt !== snapshot.generatedAt
  ) {
    throw new TypeError(
      'Proposal source metadata does not match its snapshot.',
    );
  }

  const generatedAt = parseCanonicalTimestamp(proposal.generatedAt);
  const lastMaterialChangeAt = parseCanonicalTimestamp(
    proposal.review.lastMaterialChangeAt,
  );
  const reviewEndsAt = parseCanonicalTimestamp(proposal.review.endsAt);
  if (lastMaterialChangeAt < generatedAt) {
    throw new TypeError(
      'Proposal material change cannot predate proposal generation.',
    );
  }
  if (
    proposal.review.days !== PROPOSAL_REVIEW_DAYS ||
    Date.parse(reviewEndsAt) !==
      Date.parse(lastMaterialChangeAt) + PROPOSAL_REVIEW_DAYS * DAY_MILLISECONDS
  ) {
    throw new TypeError(
      'Proposal review must end 14 days after its last material change.',
    );
  }

  const walletResolutions = new Map<string, ActorWalletResolution>();
  for (const allocation of proposal.allocations) {
    if (allocation.wallet === null) {
      walletResolutions.set(allocation.actor.id, {
        status: 'unbound',
        actorId: allocation.actor.id,
        chainId: BASE_MAINNET_CHAIN_ID,
      });
    } else {
      if (allocation.wallet.observedAt > lastMaterialChangeAt) {
        throw new TypeError(
          'Proposal wallet observation is newer than its material change.',
        );
      }
      walletResolutions.set(allocation.actor.id, {
        status: 'bound',
        actorId: allocation.actor.id,
        chainId: allocation.wallet.chainId,
        wallet: allocation.wallet.address,
      });
    }
  }

  const expected = createCycleProposal({
    project: proposal.project,
    cycle: proposal.cycle,
    generatedAt,
    snapshot,
    sourceSnapshotSha256: snapshotDigest,
    walletResolutions,
  });
  const expectedWithReview: CycleProposal = {
    ...expected,
    review: {...proposal.review},
    allocations: expected.allocations.map((allocation, index) => {
      const actualWallet = proposal.allocations[index]?.wallet;
      if (
        actualWallet === undefined ||
        actualWallet === null ||
        allocation.wallet === null
      ) {
        return allocation;
      }
      return {
        ...allocation,
        wallet: {
          ...allocation.wallet,
          observedAt: actualWallet.observedAt,
        },
      };
    }),
  };
  if (canonicalJson(proposal) !== canonicalJson(expectedWithReview)) {
    throw new TypeError('Proposal differs from its frozen source snapshot.');
  }
}

function validateProposalBoundary(value: unknown): CycleProposal {
  const proposal = requireRecord(value, 'Proposal');
  const sourceSnapshot = requireRecord(
    proposal.sourceSnapshot,
    'Proposal sourceSnapshot',
  );
  const review = requireRecord(proposal.review, 'Proposal review');
  const allocations = requireArray(
    proposal.allocations,
    'Proposal allocations',
  );

  requireString(proposal.project, 'Proposal project');
  requireString(proposal.cycle, 'Proposal cycle');
  requireString(proposal.generatedAt, 'Proposal generatedAt');
  requireString(sourceSnapshot.sha256, 'Proposal sourceSnapshot SHA-256');
  requireString(
    sourceSnapshot.generatedAt,
    'Proposal sourceSnapshot generatedAt',
  );
  requireNumber(
    sourceSnapshot.schemaVersion,
    'Proposal snapshot schemaVersion',
  );
  requireNumber(review.days, 'Proposal review days');
  requireString(review.lastMaterialChangeAt, 'Proposal material change');
  requireString(review.endsAt, 'Proposal review end');

  for (const [index, allocationValue] of allocations.entries()) {
    const allocation = requireRecord(
      allocationValue,
      `Proposal allocation ${index}`,
    );
    const actor = requireRecord(
      allocation.actor,
      `Proposal allocation ${index} actor`,
    );
    requireString(actor.id, `Proposal allocation ${index} actor ID`);
    if (allocation.wallet !== null) {
      const wallet = requireRecord(
        allocation.wallet,
        `Proposal allocation ${index} wallet`,
      );
      requireString(
        wallet.observedAt,
        `Proposal allocation ${index} wallet observation`,
      );
    }
  }
  return value as CycleProposal;
}

function requireRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string')
    throw new TypeError(`${label} must be a string.`);
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== 'number')
    throw new TypeError(`${label} must be a number.`);
  return value;
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error: unknown) {
    throw new TypeError('Source snapshot is not valid JSON.', {cause: error});
  }
}
