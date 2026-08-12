import {describe, expect, test} from 'bun:test';

import {createBaseContractReader} from './createBaseContractReader.js';
import {
  BASE_MAINNET_CHAIN_ID,
  BASE_MAINNET_UIK_ADDRESS,
} from './resolveActorWallet.js';

const RPC_URL = 'https://base.example/rpc';
const CALL_DATA = `0x6352211e${'0'.repeat(64)}` as const;

type Fetch = NonNullable<Parameters<typeof createBaseContractReader>[1]>;

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {'content-type': 'application/json'},
  });
}

function request(
  reader = createBaseContractReader(RPC_URL, fetch),
): ReturnType<typeof reader> {
  return reader({
    chainId: BASE_MAINNET_CHAIN_ID,
    to: BASE_MAINNET_UIK_ADDRESS,
    data: CALL_DATA,
  });
}

describe('createBaseContractReader', () => {
  test('verifies Base mainnet and returns eth_call data', async () => {
    const requests: unknown[] = [];
    const fetchImpl: Fetch = async (input, init) => {
      expect(String(input)).toBe(RPC_URL);
      requests.push(JSON.parse(String(init?.body)) as unknown);
      return requests.length === 1
        ? response({jsonrpc: '2.0', id: 1, result: '0x2105'})
        : response({jsonrpc: '2.0', id: 2, result: `0x${'0'.repeat(64)}`});
    };

    expect(await request(createBaseContractReader(RPC_URL, fetchImpl))).toEqual(
      {status: 'success', data: `0x${'0'.repeat(64)}`},
    );
    expect(requests).toEqual([
      {jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: []},
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'eth_call',
        params: [{to: BASE_MAINNET_UIK_ADDRESS, data: CALL_DATA}, 'latest'],
      },
    ]);
  });

  test('preserves direct and nested EVM revert data', async () => {
    for (const errorData of ['0x7e273289', {data: '0x7e273289'}] as const) {
      let calls = 0;
      const fetchImpl: Fetch = async () => {
        calls += 1;
        return calls === 1
          ? response({jsonrpc: '2.0', id: 1, result: '0x2105'})
          : response({
              jsonrpc: '2.0',
              id: 2,
              error: {code: 3, message: 'execution reverted', data: errorData},
            });
      };

      expect(
        await request(createBaseContractReader(RPC_URL, fetchImpl)),
      ).toEqual({status: 'reverted', data: '0x7e273289'});
    }
  });

  test('fails closed on another chain before eth_call', async () => {
    let calls = 0;
    const fetchImpl: Fetch = async () => {
      calls += 1;
      return response({jsonrpc: '2.0', id: 1, result: '0x1'});
    };

    expect(await request(createBaseContractReader(RPC_URL, fetchImpl))).toEqual(
      {status: 'failure'},
    );
    expect(calls).toBe(1);
  });

  test.each([
    () => response({}, 500),
    () => response({jsonrpc: '2.0', id: 99, result: '0x2105'}),
    () => new Response('not json'),
  ])('fails closed on malformed JSON-RPC responses', async makeResponse => {
    const fetchImpl: Fetch = async () => makeResponse();
    expect(await request(createBaseContractReader(RPC_URL, fetchImpl))).toEqual(
      {status: 'failure'},
    );
  });

  test('fails closed when fetch rejects', async () => {
    const fetchImpl: Fetch = async () => {
      throw new Error('network unavailable');
    };
    expect(await request(createBaseContractReader(RPC_URL, fetchImpl))).toEqual(
      {status: 'failure'},
    );
  });

  test.each([
    'not a URL',
    'ftp://base.example',
    'https://user:password@base.example',
    'https://base.example/#fragment',
  ])('rejects unsafe RPC URL %j', rpcUrl => {
    expect(() => createBaseContractReader(rpcUrl)).toThrow('RPC URL');
  });
});
