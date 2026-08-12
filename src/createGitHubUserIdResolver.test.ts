import {describe, expect, test} from 'bun:test';

import {createGitHubUserIdResolver} from './createGitHubUserIdResolver.js';

const ACTOR_ID = 'U_kgDOBj2A8Q';
type Fetch = NonNullable<Parameters<typeof createGitHubUserIdResolver>[1]>;

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {status});
}

describe('createGitHubUserIdResolver', () => {
  test('resolves an opaque stable Actor id to its numeric database id', async () => {
    const fetchImpl: Fetch = async (input, init) => {
      expect(String(input)).toBe('https://api.github.com/graphql');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('authorization')).toBe(
        'Bearer github-token',
      );
      const body = JSON.parse(String(init?.body)) as {
        readonly query: string;
        readonly variables: {readonly id: string};
      };
      expect(body.query).toContain('databaseId');
      expect(body.variables).toEqual({id: ACTOR_ID});
      return response({data: {node: {id: ACTOR_ID, databaseId: 16385918}}});
    };

    const resolve = createGitHubUserIdResolver('github-token', fetchImpl);
    expect(await resolve(ACTOR_ID)).toBe('16385918');
  });

  test.each([
    {data: {node: null}},
    {data: {node: {id: 'another-id', databaseId: 1}}},
    {data: {node: {id: ACTOR_ID, databaseId: 0}}},
    {data: {node: {id: ACTOR_ID, databaseId: '1'}}},
    {errors: [{message: 'failed'}], data: null},
  ])('rejects malformed or mismatched GitHub response', async value => {
    const resolve = createGitHubUserIdResolver('github-token', async () =>
      response(value),
    );
    await expect(resolve(ACTOR_ID)).rejects.toThrow();
  });

  test('rejects unsuccessful GitHub responses', async () => {
    const resolve = createGitHubUserIdResolver('github-token', async () =>
      response({}, 500),
    );
    await expect(resolve(ACTOR_ID)).rejects.toThrow('lookup failed');
  });

  test.each(['', ' token', 'token '])('rejects invalid token %j', token => {
    expect(() => createGitHubUserIdResolver(token)).toThrow('GitHub token');
  });

  test.each(['', ' actor', 'actor '])(
    'rejects invalid Actor id %j',
    actorId => {
      const resolve = createGitHubUserIdResolver('github-token', async () =>
        response({}),
      );
      expect(resolve(actorId)).rejects.toThrow('Actor id');
    },
  );
});
