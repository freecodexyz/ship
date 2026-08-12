import {
  BASE_MAINNET_CHAIN_ID,
  type EvmContractReader,
} from './resolveActorWallet.js';

const JSON_RPC_VERSION = '2.0';
const BASE_MAINNET_HEX_CHAIN_ID = '0x2105';

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Creates a read-only JSON-RPC adapter for the Base-mainnet UIK lookup.
 *
 * The adapter verifies the endpoint's chain id before every contract call. It
 * returns protocol and transport failures as data so the identity resolver can
 * keep expected unbound identities distinct from infrastructure failures.
 *
 * @param rpcUrl Base-mainnet JSON-RPC endpoint.
 * @param fetchImpl Injected fetch implementation for deterministic tests.
 * @returns A contract reader compatible with {@link resolveActorWallet}.
 */
export function createBaseContractReader(
  rpcUrl: string,
  fetchImpl: Fetch = fetch,
): EvmContractReader {
  const endpoint = parseRpcUrl(rpcUrl);

  return async request => {
    if (request.chainId !== BASE_MAINNET_CHAIN_ID) return {status: 'failure'};

    const chainResponse = await jsonRpc(
      endpoint,
      'eth_chainId',
      [],
      1,
      fetchImpl,
    );
    if (
      chainResponse.status !== 'success' ||
      typeof chainResponse.result !== 'string' ||
      chainResponse.result.toLowerCase() !== BASE_MAINNET_HEX_CHAIN_ID
    ) {
      return {status: 'failure'};
    }

    const callResponse = await jsonRpc(
      endpoint,
      'eth_call',
      [{to: request.to, data: request.data}, 'latest'],
      2,
      fetchImpl,
    );
    switch (callResponse.status) {
      case 'success':
        return {status: 'success', data: callResponse.result};
      case 'reverted':
        return {status: 'reverted', data: callResponse.data};
      case 'failure':
        return {status: 'failure'};
      default:
        return assertNever(callResponse);
    }
  };
}

type JsonRpcResult =
  | {readonly status: 'success'; readonly result: unknown}
  | {readonly status: 'reverted'; readonly data: unknown}
  | {readonly status: 'failure'};

async function jsonRpc(
  endpoint: URL,
  method: string,
  params: readonly unknown[],
  id: number,
  fetchImpl: Fetch,
): Promise<JsonRpcResult> {
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({jsonrpc: JSON_RPC_VERSION, id, method, params}),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return {status: 'failure'};
  }
  if (!response.ok) return {status: 'failure'};

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return {status: 'failure'};
  }
  if (
    !isRecord(value) ||
    value.jsonrpc !== JSON_RPC_VERSION ||
    value.id !== id
  ) {
    return {status: 'failure'};
  }
  if ('result' in value && !('error' in value)) {
    return {status: 'success', result: value.result};
  }
  if (!('result' in value) && isRecord(value.error)) {
    return {
      status: 'reverted',
      data: extractRevertData(value.error.data),
    };
  }
  return {status: 'failure'};
}

function extractRevertData(value: unknown): unknown {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.data === 'string') return value.data;
  return null;
}

function parseRpcUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('RPC URL must be an absolute HTTP or HTTPS URL.');
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    throw new TypeError(
      'RPC URL must be an absolute HTTP or HTTPS URL without credentials or a fragment.',
    );
  }
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported JSON-RPC result: ${String(value)}`);
}
