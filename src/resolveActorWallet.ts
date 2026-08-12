import type {Actor} from './types.js';

/** Base mainnet, the only identity-binding chain currently supported. */
export const BASE_MAINNET_CHAIN_ID = 8453 as const;

/** UIK deployment recorded by the identity repository for Base mainnet. */
export const BASE_MAINNET_UIK_ADDRESS =
  '0x944db2a2b1268c38cc50cb6337894b55128161cc' as const;

const OWNER_OF_SELECTOR = '6352211e';
const NONEXISTENT_TOKEN_SELECTOR = '7e273289';
const UINT64_MAX = (1n << 64n) - 1n;
const WORD_HEX_LENGTH = 64;
const ADDRESS_HEX_LENGTH = 40;

type BaseMainnetChainId = typeof BASE_MAINNET_CHAIN_ID;
type EvmAddress = `0x${string}`;

/** Narrow actor-id lookup required because modern GitHub node ids are opaque. */
export type GitHubUserIdResolver = (actorId: Actor['id']) => Promise<unknown>;

/** Consumer-side boundary for one read-only EVM contract call. */
export type EvmContractReader = (request: {
  readonly chainId: BaseMainnetChainId;
  readonly to: typeof BASE_MAINNET_UIK_ADDRESS;
  readonly data: `0x${string}`;
}) => Promise<
  | {readonly status: 'success'; readonly data: unknown}
  | {readonly status: 'reverted'; readonly data: unknown}
  | {readonly status: 'failure'}
>;

/** Complete outcome of resolving a stable GitHub actor id through UIK. */
export type ActorWalletResolution =
  | {
      readonly status: 'bound';
      readonly actorId: Actor['id'];
      readonly chainId: BaseMainnetChainId;
      readonly wallet: EvmAddress;
    }
  | {
      readonly status: 'unbound';
      readonly actorId: Actor['id'];
      readonly chainId: BaseMainnetChainId;
    }
  | {
      readonly status: 'error';
      readonly actorId: Actor['id'];
      readonly chainId: number;
      readonly reason:
        | 'unsupported-chain'
        | 'actor-id-resolution-failed'
        | 'invalid-github-user-id'
        | 'contract-call-failed'
        | 'invalid-contract-response';
    };

/**
 * Resolves a stable GitHub Actor id to its current UIK wallet binding.
 *
 * UIK token ids are numeric GitHub database ids, while Ship actors carry
 * opaque GitHub GraphQL node ids. The injected resolver crosses that identity
 * boundary. The injected contract reader performs one `ownerOf(uint256)` call
 * against the pinned Base-mainnet UIK deployment.
 *
 * Only the exact `ERC721NonexistentToken(uint256)` revert for the requested
 * token is classified as unbound. Transport failures, other reverts, and
 * malformed return data remain distinguishable errors.
 *
 * @param actorId Stable GitHub GraphQL actor node id.
 * @param chainId EIP-155 chain id; currently only Base mainnet is supported.
 * @param resolveGitHubUserId Resolves the opaque actor id to a numeric id.
 * @param readContract Executes the read-only EVM call.
 * @returns A bound, unbound, or explicit error result.
 */
export async function resolveActorWallet(
  actorId: Actor['id'],
  chainId: number,
  resolveGitHubUserId: GitHubUserIdResolver,
  readContract: EvmContractReader,
): Promise<ActorWalletResolution> {
  if (chainId !== BASE_MAINNET_CHAIN_ID) {
    return {status: 'error', actorId, chainId, reason: 'unsupported-chain'};
  }

  let unresolvedGitHubUserId: unknown;
  try {
    unresolvedGitHubUserId = await resolveGitHubUserId(actorId);
  } catch {
    return {
      status: 'error',
      actorId,
      chainId,
      reason: 'actor-id-resolution-failed',
    };
  }

  const githubUserId = parseGitHubUserId(unresolvedGitHubUserId);
  if (githubUserId === null) {
    return {
      status: 'error',
      actorId,
      chainId,
      reason: 'invalid-github-user-id',
    };
  }

  const encodedTokenId = encodeWord(githubUserId);
  let callResult: Awaited<ReturnType<EvmContractReader>>;
  try {
    callResult = await readContract({
      chainId,
      to: BASE_MAINNET_UIK_ADDRESS,
      data: `0x${OWNER_OF_SELECTOR}${encodedTokenId}`,
    });
  } catch {
    return {status: 'error', actorId, chainId, reason: 'contract-call-failed'};
  }

  switch (callResult.status) {
    case 'success': {
      const wallet = parseOwnerOfResult(callResult.data);
      return wallet === null
        ? {
            status: 'error',
            actorId,
            chainId,
            reason: 'invalid-contract-response',
          }
        : {status: 'bound', actorId, chainId, wallet};
    }
    case 'reverted':
      return isNonexistentTokenRevert(callResult.data, encodedTokenId)
        ? {status: 'unbound', actorId, chainId}
        : {status: 'error', actorId, chainId, reason: 'contract-call-failed'};
    case 'failure':
      return {
        status: 'error',
        actorId,
        chainId,
        reason: 'contract-call-failed',
      };
    default:
      return assertNever(callResult);
  }
}

function parseGitHubUserId(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;

  const parsed = BigInt(value);
  return parsed <= UINT64_MAX ? parsed : null;
}

function encodeWord(value: bigint): string {
  return value.toString(16).padStart(WORD_HEX_LENGTH, '0');
}

function parseOwnerOfResult(value: unknown): EvmAddress | null {
  if (
    typeof value !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(value) ||
    value.slice(2, 26) !== '0'.repeat(24)
  ) {
    return null;
  }

  const address = value.slice(-ADDRESS_HEX_LENGTH).toLowerCase();
  if (address === '0'.repeat(ADDRESS_HEX_LENGTH)) return null;
  return `0x${address}`;
}

function isNonexistentTokenRevert(
  value: unknown,
  encodedTokenId: string,
): boolean {
  return (
    typeof value === 'string' &&
    value.toLowerCase() ===
      `0x${NONEXISTENT_TOKEN_SELECTOR}${encodedTokenId}`.toLowerCase()
  );
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported EVM call result: ${String(value)}`);
}
