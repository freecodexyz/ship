import {
  BASE_MAINNET_CHAIN_ID,
  BASE_MAINNET_UIK_ADDRESS,
  type ActorWalletResolution,
} from './resolveActorWallet.js';
import {allocateMonthlyPool, computeRewardWeights} from './rewards.js';
import {
  cycleBounds,
  parseCanonicalTimestamp,
  type CanonicalTimestamp,
} from './time.js';
import type {
  Actor,
  Award,
  Project,
  RewardContributor,
  RewardToken,
  Snapshot,
} from './types.js';

export const PROPOSAL_REVIEW_DAYS = 14 as const;

const DAY_MILLISECONDS = 86_400_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LOWERCASE_EVM_ADDRESS_PATTERN = /^0x[a-f0-9]{40}$/;
const ZERO_EVM_ADDRESS = `0x${'0'.repeat(40)}`;

export type ProposalAllocation = {
  readonly intentId: string;
  readonly actor: Actor;
  readonly canonicalScore: number;
  readonly receiptComputation: {
    readonly creditedTokens: number;
    readonly computeBonusBasisPoints: number;
    readonly adjustedWeight: number;
    readonly linkedRunIds: readonly string[];
  };
  readonly projectedBaseUnits: string;
  readonly state: 'proposed' | 'unclaimed';
  readonly wallet: {
    readonly chainId: typeof BASE_MAINNET_CHAIN_ID;
    readonly address: `0x${string}`;
    readonly identityContract: typeof BASE_MAINNET_UIK_ADDRESS;
    readonly observedAt: Snapshot['generatedAt'];
  } | null;
  readonly awardIds: readonly string[];
};

/** Immutable proposed allocations for one closed project cycle. */
export type CycleProposal = {
  readonly schemaVersion: 1;
  readonly kind: 'reward-proposal';
  readonly status: 'proposed';
  readonly project: Project['id'];
  readonly cycle: string;
  readonly generatedAt: Snapshot['generatedAt'];
  readonly contributionWindow: {
    readonly from: Snapshot['window']['from'];
    readonly to: Snapshot['window']['to'];
  };
  readonly review: {
    readonly days: typeof PROPOSAL_REVIEW_DAYS;
    readonly lastMaterialChangeAt: CanonicalTimestamp;
    readonly endsAt: CanonicalTimestamp;
  };
  readonly sourceSnapshot: {
    readonly schemaVersion: Snapshot['schemaVersion'];
    readonly generatedAt: Snapshot['generatedAt'];
    readonly sha256: string;
  };
  readonly reward: {
    readonly token: RewardToken;
    readonly monthlyPoolBaseUnits: string;
  };
  readonly walletBinding: {
    readonly chainId: typeof BASE_MAINNET_CHAIN_ID;
    readonly contract: typeof BASE_MAINNET_UIK_ADDRESS;
  };
  readonly allocations: readonly ProposalAllocation[];
  readonly totals: {
    readonly projectedBaseUnits: string;
    readonly proposedBaseUnits: string;
    readonly unclaimedBaseUnits: string;
  };
};

export type CreateCycleProposalInput = {
  readonly project: Project['id'];
  readonly cycle: string;
  readonly generatedAt: CanonicalTimestamp;
  readonly snapshot: Snapshot;
  readonly sourceSnapshotSha256: string;
  readonly walletResolutions: ReadonlyMap<Actor['id'], ActorWalletResolution>;
};

/**
 * Creates a deterministic reward proposal from one validated frozen snapshot.
 *
 * Receipt bonuses and ERC-20 base-unit allocations are recomputed from the
 * canonical buckets, awards, and receipts. Optional reward projections in the
 * source JSON are deliberately not trusted as proposal input.
 */
export function createCycleProposal(
  input: CreateCycleProposalInput,
): CycleProposal {
  const bounds = cycleBounds(input.cycle);
  parseCanonicalTimestamp(input.generatedAt);
  if (input.generatedAt < bounds.to) {
    throw new RangeError(`Cycle "${input.cycle}" has not closed.`);
  }
  const project = input.snapshot.projects.find(
    candidate => candidate.id === input.project,
  );
  if (project === undefined) {
    throw new TypeError(
      `Snapshot does not contain project "${input.project}".`,
    );
  }
  if (project.reward === undefined) {
    throw new TypeError(`Project "${input.project}" has no reward policy.`);
  }
  if (project.reward.startsAt > bounds.from) {
    throw new RangeError(
      `Project "${input.project}" was not reward-active at cycle start.`,
    );
  }
  assertFrozenCycle(input.snapshot, bounds.from, bounds.to);
  if (input.generatedAt < input.snapshot.generatedAt) {
    throw new RangeError(
      'Proposal generation cannot predate its frozen snapshot.',
    );
  }
  if (!SHA256_PATTERN.test(input.sourceSnapshotSha256)) {
    throw new TypeError(
      'Source snapshot SHA-256 must be lowercase hexadecimal.',
    );
  }

  const buckets = input.snapshot.buckets
    .filter(
      bucket =>
        bucket.project === input.project && bucket.cycle === input.cycle,
    )
    .sort(
      (left, right) =>
        right.score - left.score || compareText(left.actor.id, right.actor.id),
    );
  const awards = input.snapshot.awards.filter(
    award => award.project === input.project && award.cycle === input.cycle,
  );
  const weights = computeRewardWeights(
    buckets,
    input.snapshot.awards,
    input.snapshot.receipts,
    input.snapshot.projects,
  );
  const contributors = allocateMonthlyPool(project, input.cycle, weights);
  const awardsByActor = indexAwardsByActor(awards);
  const allocations = contributors.map((contributor, index) =>
    createAllocation(
      input.project,
      input.cycle,
      index,
      contributor,
      buckets[index]?.actor,
      awardsByActor.get(contributor.actorId) ?? [],
      input.walletResolutions.get(contributor.actorId),
      input.generatedAt,
    ),
  );

  const proposed = sumAllocationState(allocations, 'proposed');
  const unclaimed = sumAllocationState(allocations, 'unclaimed');
  const reviewEndsAt = parseCanonicalTimestamp(
    new Date(
      Date.parse(input.generatedAt) + PROPOSAL_REVIEW_DAYS * DAY_MILLISECONDS,
    ).toISOString(),
  );
  return {
    schemaVersion: 1,
    kind: 'reward-proposal',
    status: 'proposed',
    project: project.id,
    cycle: input.cycle,
    generatedAt: input.generatedAt,
    contributionWindow: bounds,
    review: {
      days: PROPOSAL_REVIEW_DAYS,
      lastMaterialChangeAt: input.generatedAt,
      endsAt: reviewEndsAt,
    },
    sourceSnapshot: {
      schemaVersion: input.snapshot.schemaVersion,
      generatedAt: input.snapshot.generatedAt,
      sha256: input.sourceSnapshotSha256,
    },
    reward: {
      token: {...project.reward.token},
      monthlyPoolBaseUnits: project.reward.monthlyPoolBaseUnits,
    },
    walletBinding: {
      chainId: BASE_MAINNET_CHAIN_ID,
      contract: BASE_MAINNET_UIK_ADDRESS,
    },
    allocations,
    totals: {
      projectedBaseUnits: (proposed + unclaimed).toString(),
      proposedBaseUnits: proposed.toString(),
      unclaimedBaseUnits: unclaimed.toString(),
    },
  };
}

function assertFrozenCycle(
  snapshot: Snapshot,
  cycleFrom: Snapshot['window']['from'],
  cycleTo: Snapshot['window']['to'],
): void {
  parseCanonicalTimestamp(snapshot.generatedAt);
  if (
    snapshot.window.from > cycleFrom ||
    snapshot.window.to < cycleTo ||
    snapshot.generatedAt < cycleTo
  ) {
    throw new RangeError(
      'Frozen snapshot does not cover the complete closed project cycle.',
    );
  }
}

function createAllocation(
  project: string,
  cycle: string,
  index: number,
  contributor: RewardContributor,
  actor: Actor | undefined,
  awards: readonly Award[],
  resolution: ActorWalletResolution | undefined,
  observedAt: CanonicalTimestamp,
): ProposalAllocation {
  if (actor === undefined || actor.id !== contributor.actorId) {
    throw new Error('Reward contributor does not match its score bucket.');
  }
  if (resolution === undefined || resolution.actorId !== actor.id) {
    throw new TypeError(`Missing wallet resolution for actor "${actor.id}".`);
  }

  let state: ProposalAllocation['state'];
  let wallet: ProposalAllocation['wallet'];
  switch (resolution.status) {
    case 'bound':
      if (
        resolution.chainId !== BASE_MAINNET_CHAIN_ID ||
        !LOWERCASE_EVM_ADDRESS_PATTERN.test(resolution.wallet) ||
        resolution.wallet === ZERO_EVM_ADDRESS
      ) {
        throw new TypeError(
          `Invalid wallet resolution for actor "${actor.id}".`,
        );
      }
      state = 'proposed';
      wallet = {
        chainId: resolution.chainId,
        address: resolution.wallet,
        identityContract: BASE_MAINNET_UIK_ADDRESS,
        observedAt,
      };
      break;
    case 'unbound':
      if (resolution.chainId !== BASE_MAINNET_CHAIN_ID) {
        throw new TypeError(
          `Invalid wallet resolution for actor "${actor.id}".`,
        );
      }
      state = 'unclaimed';
      wallet = null;
      break;
    case 'error':
      throw new Error(
        `Wallet resolution failed for actor "${actor.id}": ${resolution.reason}.`,
      );
    default:
      return assertNever(resolution);
  }

  const orderedAwards = [...awards].sort(
    (left, right) =>
      compareText(left.occurredAt, right.occurredAt) ||
      compareText(left.id, right.id),
  );
  const linkedRunIds = [
    ...new Set(
      orderedAwards
        .filter(award => award.runId !== undefined)
        .map(award => award.runId as string),
    ),
  ].sort(compareText);

  return {
    intentId: `reward_${intentPart(project)}_${cycle.replace('-', '_')}_${String(index + 1).padStart(4, '0')}_${intentPart(actor.id)}`,
    actor: {...actor},
    canonicalScore: contributor.canonicalScore,
    receiptComputation: {
      creditedTokens: contributor.creditedTokens,
      computeBonusBasisPoints: contributor.computeBonusBasisPoints,
      adjustedWeight: contributor.adjustedWeight,
      linkedRunIds,
    },
    projectedBaseUnits: contributor.projectedBaseUnits,
    state,
    wallet,
    awardIds: orderedAwards.map(award => award.id),
  };
}

function indexAwardsByActor(
  awards: readonly Award[],
): ReadonlyMap<Actor['id'], readonly Award[]> {
  const indexed = new Map<Actor['id'], Award[]>();
  for (const award of awards) {
    const actorAwards = indexed.get(award.actor.id) ?? [];
    actorAwards.push(award);
    indexed.set(award.actor.id, actorAwards);
  }
  return indexed;
}

function sumAllocationState(
  allocations: readonly ProposalAllocation[],
  state: ProposalAllocation['state'],
): bigint {
  return allocations
    .filter(allocation => allocation.state === state)
    .reduce(
      (sum, allocation) => sum + BigInt(allocation.projectedBaseUnits),
      0n,
    );
}

function intentPart(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 48);
  if (normalized.length === 0) {
    throw new TypeError('Proposal intent component must not be empty.');
  }
  return normalized;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected wallet resolution: ${String(value)}`);
}
