import {describe, expect, test} from 'bun:test';

import {
  BASE_MAINNET_CHAIN_ID,
  BASE_MAINNET_UIK_ADDRESS,
  resolveActorWallet,
  type EvmContractReader,
  type GitHubUserIdResolver,
} from './resolveActorWallet.js';

const ACTOR_ID = 'U_kgDOBj2A8Q';
const GITHUB_USER_ID = '16385918';
const ENCODED_USER_ID = BigInt(GITHUB_USER_ID).toString(16).padStart(64, '0');
const WALLET = '0x1234567890abcdef1234567890abcdef12345678';

function resolver(value: unknown = GITHUB_USER_ID): GitHubUserIdResolver {
  return async actorId => {
    expect(actorId).toBe(ACTOR_ID);
    return value;
  };
}

function reader(
  result: Awaited<ReturnType<EvmContractReader>>,
): EvmContractReader {
  return async request => {
    expect(request).toEqual({
      chainId: BASE_MAINNET_CHAIN_ID,
      to: BASE_MAINNET_UIK_ADDRESS,
      data: `0x6352211e${ENCODED_USER_ID}`,
    });
    return result;
  };
}

describe('resolveActorWallet', () => {
  test('returns the current bound Base-mainnet wallet', async () => {
    const result = await resolveActorWallet(
      ACTOR_ID,
      BASE_MAINNET_CHAIN_ID,
      resolver(),
      reader({
        status: 'success',
        data: `0x${'0'.repeat(24)}${WALLET.slice(2).toUpperCase()}`,
      }),
    );

    expect(result).toEqual({
      status: 'bound',
      actorId: ACTOR_ID,
      chainId: BASE_MAINNET_CHAIN_ID,
      wallet: WALLET,
    });
  });

  test('marks only the matching nonexistent-token revert as unbound', async () => {
    const result = await resolveActorWallet(
      ACTOR_ID,
      BASE_MAINNET_CHAIN_ID,
      resolver(),
      reader({
        status: 'reverted',
        data: `0x7e273289${ENCODED_USER_ID}`,
      }),
    );

    expect(result).toEqual({
      status: 'unbound',
      actorId: ACTOR_ID,
      chainId: BASE_MAINNET_CHAIN_ID,
    });

    expect(
      await resolveActorWallet(
        ACTOR_ID,
        BASE_MAINNET_CHAIN_ID,
        resolver(),
        reader({status: 'reverted', data: '0xdeadbeef'}),
      ),
    ).toEqual({
      status: 'error',
      actorId: ACTOR_ID,
      chainId: BASE_MAINNET_CHAIN_ID,
      reason: 'contract-call-failed',
    });
  });

  test('rejects unsupported chains without resolving or calling', async () => {
    let resolverCalled = false;
    let readerCalled = false;

    const result = await resolveActorWallet(
      ACTOR_ID,
      1,
      async () => {
        resolverCalled = true;
        return GITHUB_USER_ID;
      },
      async () => {
        readerCalled = true;
        return {status: 'failure'};
      },
    );

    expect(result).toEqual({
      status: 'error',
      actorId: ACTOR_ID,
      chainId: 1,
      reason: 'unsupported-chain',
    });
    expect(resolverCalled).toBe(false);
    expect(readerCalled).toBe(false);
  });

  test.each([1, 0, '0', '01', '-1', '', ((1n << 64n) + 1n).toString()])(
    'rejects invalid numeric GitHub user id %j',
    async githubUserId => {
      let readerCalled = false;
      const result = await resolveActorWallet(
        ACTOR_ID,
        BASE_MAINNET_CHAIN_ID,
        resolver(githubUserId),
        async () => {
          readerCalled = true;
          return {status: 'failure'};
        },
      );

      expect(result).toEqual({
        status: 'error',
        actorId: ACTOR_ID,
        chainId: BASE_MAINNET_CHAIN_ID,
        reason: 'invalid-github-user-id',
      });
      expect(readerCalled).toBe(false);
    },
  );

  test('models actor-id resolver and contract-reader failures', async () => {
    expect(
      await resolveActorWallet(
        ACTOR_ID,
        BASE_MAINNET_CHAIN_ID,
        async () => {
          throw new Error('GitHub unavailable');
        },
        reader({status: 'failure'}),
      ),
    ).toEqual({
      status: 'error',
      actorId: ACTOR_ID,
      chainId: BASE_MAINNET_CHAIN_ID,
      reason: 'actor-id-resolution-failed',
    });

    expect(
      await resolveActorWallet(
        ACTOR_ID,
        BASE_MAINNET_CHAIN_ID,
        resolver(),
        async () => {
          throw new Error('RPC unavailable');
        },
      ),
    ).toEqual({
      status: 'error',
      actorId: ACTOR_ID,
      chainId: BASE_MAINNET_CHAIN_ID,
      reason: 'contract-call-failed',
    });
  });

  test.each([
    '0x',
    `0x${'0'.repeat(64)}`,
    `0x${'1'.repeat(24)}${WALLET.slice(2)}`,
    `0x${'0'.repeat(23)}${WALLET.slice(2)}`,
    `0x${'z'.repeat(64)}`,
  ])('rejects malformed ownerOf result %j', async data => {
    const result = await resolveActorWallet(
      ACTOR_ID,
      BASE_MAINNET_CHAIN_ID,
      resolver(),
      reader({status: 'success', data}),
    );

    expect(result).toEqual({
      status: 'error',
      actorId: ACTOR_ID,
      chainId: BASE_MAINNET_CHAIN_ID,
      reason: 'invalid-contract-response',
    });
  });
});
