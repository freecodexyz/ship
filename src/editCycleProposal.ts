import {
  PROPOSAL_REVIEW_DAYS,
  type CycleProposal,
  type ProposalAllocation,
  type ProposalAllocationState,
} from './createCycleProposal.js';
import {canonicalJson} from './crypto.js';
import {parseCanonicalTimestamp, type CanonicalTimestamp} from './time.js';

const DAY_MILLISECONDS = 86_400_000;

export type EditCycleProposalInput = {
  readonly proposal: CycleProposal;
  readonly intentId: string;
  readonly changedAt: string;
  readonly state: ProposalAllocationState;
  readonly approvedBaseUnits: string;
  readonly adjustmentReason: string | null;
  /** Omit to retain the reviewed wallet; use null to remove it. */
  readonly wallet?: ProposalAllocation['wallet'];
};

/** Applies one material review decision without changing source-derived fields. */
export function editCycleProposal(
  input: EditCycleProposalInput,
): CycleProposal {
  const changedAt = parseCanonicalTimestamp(input.changedAt);
  if (changedAt <= input.proposal.review.lastMaterialChangeAt) {
    throw new RangeError(
      'Material change time must be newer than the previous material change.',
    );
  }
  if (!/^(?:0|[1-9]\d*)$/.test(input.approvedBaseUnits)) {
    throw new TypeError('Approved amount must use canonical base units.');
  }
  const index = input.proposal.allocations.findIndex(
    allocation => allocation.intentId === input.intentId,
  );
  const current = input.proposal.allocations[index];
  if (current === undefined) {
    throw new TypeError(`Unknown proposal intent "${input.intentId}".`);
  }
  const wallet = input.wallet === undefined ? current.wallet : input.wallet;
  if (wallet !== null && wallet.observedAt > changedAt) {
    throw new RangeError(
      'Wallet observation cannot be newer than the material change.',
    );
  }
  const updated: ProposalAllocation = {
    ...current,
    approvedBaseUnits: input.approvedBaseUnits,
    state: input.state,
    adjustmentReason: input.adjustmentReason,
    wallet,
  };
  validateDecision(updated);
  if (canonicalJson(updated) === canonicalJson(current)) {
    throw new TypeError('Review edit does not materially change the proposal.');
  }

  const allocations = input.proposal.allocations.map((allocation, rowIndex) =>
    rowIndex === index ? updated : allocation,
  );
  return {
    ...input.proposal,
    review: {
      days: PROPOSAL_REVIEW_DAYS,
      lastMaterialChangeAt: changedAt,
      endsAt: reviewEnd(changedAt),
    },
    allocations,
    totals: reviewTotals(allocations),
  };
}

function validateDecision(allocation: ProposalAllocation): void {
  const approved = BigInt(allocation.approvedBaseUnits);
  const projected = BigInt(allocation.projectedBaseUnits);
  if (approved > projected) {
    throw new TypeError('Approved amount cannot exceed projected amount.');
  }
  if (
    allocation.adjustmentReason !== null &&
    (allocation.adjustmentReason.trim() !== allocation.adjustmentReason ||
      allocation.adjustmentReason.length < 12 ||
      allocation.adjustmentReason.length > 1000)
  ) {
    throw new TypeError(
      'Adjustment reason must be 12 to 1000 trimmed characters.',
    );
  }
  if (
    allocation.state !== 'proposed' &&
    allocation.state !== 'unclaimed' &&
    approved < projected &&
    allocation.adjustmentReason === null
  ) {
    throw new TypeError('Allocation reduction requires an adjustment reason.');
  }
  if (allocation.state === 'approved') {
    if (approved === 0n || allocation.wallet === null) {
      throw new TypeError('Approved allocation requires money and a wallet.');
    }
  } else if (approved !== 0n) {
    throw new TypeError(
      'Non-approved allocation must have zero approved amount.',
    );
  }
  if (allocation.state === 'proposed' && allocation.wallet === null) {
    throw new TypeError('Proposed allocation requires a wallet.');
  }
  if (allocation.state === 'unclaimed' && allocation.wallet !== null) {
    throw new TypeError('Unclaimed allocation cannot retain a wallet.');
  }
}

function reviewEnd(changedAt: CanonicalTimestamp): CanonicalTimestamp {
  return parseCanonicalTimestamp(
    new Date(
      Date.parse(changedAt) + PROPOSAL_REVIEW_DAYS * DAY_MILLISECONDS,
    ).toISOString(),
  );
}

function reviewTotals(
  allocations: readonly ProposalAllocation[],
): CycleProposal['totals'] {
  const sum = (
    select: (allocation: ProposalAllocation) => string,
    include: (allocation: ProposalAllocation) => boolean = () => true,
  ): string =>
    allocations
      .filter(include)
      .reduce((total, allocation) => total + BigInt(select(allocation)), 0n)
      .toString();
  return {
    projectedBaseUnits: sum(allocation => allocation.projectedBaseUnits),
    approvedBaseUnits: sum(allocation => allocation.approvedBaseUnits),
    proposedBaseUnits: sum(
      allocation => allocation.projectedBaseUnits,
      allocation => allocation.state === 'proposed',
    ),
    unclaimedBaseUnits: sum(
      allocation => allocation.projectedBaseUnits,
      allocation => allocation.state === 'unclaimed',
    ),
  };
}
