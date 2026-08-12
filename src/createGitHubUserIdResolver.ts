import type {GitHubUserIdResolver} from './resolveActorWallet.js';

const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';
const QUERY = `
  query ResolveGitHubUserId($id: ID!) {
    node(id: $id) {
      ... on User {
        id
        databaseId
      }
    }
  }
`;

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Creates a resolver from stable GitHub GraphQL Actor ids to numeric user ids.
 *
 * The returned node id must equal the requested Actor id. Login is deliberately
 * unused because it is mutable and is not the identity keyed by UIK.
 *
 * @param token GitHub bearer token permitted to query the GraphQL API.
 * @param fetchImpl Injected fetch implementation for deterministic tests.
 * @returns A resolver compatible with {@link resolveActorWallet}.
 */
export function createGitHubUserIdResolver(
  token: string,
  fetchImpl: Fetch = fetch,
): GitHubUserIdResolver {
  if (token.length === 0 || token.trim() !== token) {
    throw new TypeError('GitHub token must be a non-empty trimmed string.');
  }

  return async actorId => {
    if (actorId.length === 0 || actorId.trim() !== actorId) {
      throw new TypeError('Actor id must be a non-empty trimmed string.');
    }

    const response = await fetchImpl(GITHUB_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'ship',
      },
      body: JSON.stringify({query: QUERY, variables: {id: actorId}}),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error('GitHub actor-id lookup failed.');
    }

    const value: unknown = await response.json();
    if (!isRecord(value) || 'errors' in value || !isRecord(value.data)) {
      throw new TypeError('GitHub actor-id response is invalid.');
    }
    const node = value.data.node;
    if (!isRecord(node) || node.id !== actorId) {
      throw new TypeError('GitHub actor-id response did not match the actor.');
    }
    if (
      typeof node.databaseId !== 'number' ||
      !Number.isSafeInteger(node.databaseId) ||
      node.databaseId <= 0
    ) {
      throw new TypeError('GitHub actor database id is invalid.');
    }

    return String(node.databaseId);
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
