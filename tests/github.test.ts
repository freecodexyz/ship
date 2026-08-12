import {describe, expect, test} from 'bun:test';
import {createHash} from 'node:crypto';

import {
  createGitHubClient,
  extractEvidence,
  fetchMergedPullRequests,
  fetchReferencedIssues,
  type GitHubRecords,
} from '../src/github.js';
import {parseCanonicalTimestamp} from '../src/time.js';
import {
  parseRepoId,
  type CollectionWindow,
  type ProjectRepository,
  type PullRequest,
} from '../src/types.js';
import {recordedResponses} from './fixtures/github/recordedResponses.js';

const repository: ProjectRepository = {
  id: parseRepoId('owner/repository'),
  branch: 'main',
};
const window: CollectionWindow = {
  from: parseCanonicalTimestamp('2026-07-01T00:00:00.000Z'),
  to: parseCanonicalTimestamp('2026-08-01T00:00:00.000Z'),
};

type GraphqlRequest = {
  readonly query: string;
  readonly variables: Readonly<Record<string, unknown>>;
};

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: {'Content-Type': 'application/json'},
  });
}

function binaryResponse(value: string, contentType: string): Response {
  return new Response(value, {headers: {'Content-Type': contentType}});
}

function parseRecord(
  value: unknown,
  context: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${context} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function parseGraphqlRequest(init: RequestInit): GraphqlRequest {
  if (typeof init.body !== 'string') {
    throw new TypeError('GraphQL request body must be a string.');
  }
  const body: unknown = JSON.parse(init.body);
  const record = parseRecord(body, 'GraphQL request');
  if (typeof record.query !== 'string') {
    throw new TypeError('GraphQL request query must be a string.');
  }
  return {
    query: record.query,
    variables: parseRecord(record.variables, 'GraphQL request variables'),
  };
}

function cursor(variables: Readonly<Record<string, unknown>>): string | null {
  const value = variables.after;
  if (value !== null && typeof value !== 'string') {
    throw new TypeError('GraphQL cursor must be a string or null.');
  }
  return value;
}

function variableString(
  variables: Readonly<Record<string, unknown>>,
  name: string,
): string {
  const value = variables[name];
  if (typeof value !== 'string') {
    throw new TypeError(`GraphQL variable ${name} must be a string.`);
  }
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function searchCandidate(
  id: string,
  number: number,
  mergedAt: string,
  baseRefName = 'main',
): Readonly<Record<string, unknown>> {
  return {
    id,
    number,
    title: `Pull request ${number}`,
    author: {id: `USER_${number}`, login: `contributor-${number}`},
    mergedAt,
    baseRefName,
    headRefOid: number.toString(16).padStart(40, '0'),
  };
}

function searchResponse(
  issueCount: number,
  nodes: readonly unknown[],
  hasNextPage = false,
  endCursor: string | null = null,
): Response {
  return jsonResponse({
    data: {search: {issueCount, nodes, pageInfo: {hasNextPage, endCursor}}},
  });
}

describe('GitHub transport normalization contract', () => {
  test('paginates, deduplicates, and returns normalized pull requests and issues', async () => {
    const graphqlPages: string[] = [];
    const evidenceRequests: string[] = [];
    const fetch = async (url: string, init: RequestInit): Promise<Response> => {
      if (url === recordedResponses.evidenceUrls.screenshot) {
        evidenceRequests.push(url);
        expect(new Headers(init.headers).has('authorization')).toBe(false);
        return binaryResponse('GIF89averified screenshot', 'image/png');
      }
      if (url === recordedResponses.evidenceUrls.logs) {
        evidenceRequests.push(url);
        expect(new Headers(init.headers).has('authorization')).toBe(false);
        return binaryResponse('verified logs', 'text/plain; charset=utf-8');
      }
      expect(url).toBe('https://api.github.com/graphql');

      const request = parseGraphqlRequest(init);
      const after = cursor(request.variables);
      if (request.query.includes('query SearchMergedPullRequests')) {
        graphqlPages.push(`search:${after ?? 'first'}`);
        return jsonResponse(
          after === null
            ? recordedResponses.search.first
            : recordedResponses.search.second,
        );
      }
      if (request.query.includes('query PullRequestFiles')) {
        graphqlPages.push(`files:${after ?? 'first'}`);
        return jsonResponse(
          after === null
            ? recordedResponses.files.first
            : recordedResponses.files.second,
        );
      }
      if (request.query.includes('query PullRequestReviews')) {
        graphqlPages.push(`reviews:${after ?? 'first'}`);
        return jsonResponse(
          after === null
            ? recordedResponses.reviews.first
            : recordedResponses.reviews.second,
        );
      }
      if (request.query.includes('query PullRequestClosingIssues')) {
        graphqlPages.push('closing-issues:first');
        return jsonResponse(recordedResponses.closingIssues);
      }
      if (request.query.includes('query PullRequestEvidenceMaterial')) {
        graphqlPages.push('evidence-material:first');
        return jsonResponse(recordedResponses.evidenceMaterial);
      }
      if (request.query.includes('query ReferencedIssue')) {
        const id = variableString(request.variables, 'id');
        graphqlPages.push(`issue:${id}:${after ?? 'first'}`);
        if (id === 'ISSUE_1') {
          return jsonResponse(
            after === null
              ? recordedResponses.issues.issue1First
              : recordedResponses.issues.issue1Second,
          );
        }
        if (id === 'ISSUE_2' && after === null) {
          return jsonResponse(recordedResponses.issues.issue2);
        }
      }
      throw new Error('Unexpected synthetic GitHub request.');
    };

    const client = createGitHubClient({
      token: 'github-token',
      fetch,
      collectRepository: async (
        transport,
        requestedRepository,
        requestedWindow,
      ) => {
        const pullRequests = await fetchMergedPullRequests(
          transport,
          requestedRepository,
          requestedWindow,
        );
        const issues = await fetchReferencedIssues(
          transport,
          requestedRepository,
          pullRequests,
        );
        return {pullRequests, issues};
      },
    });

    const records = await client.collect([repository], window);
    const expected: GitHubRecords = {
      pullRequests: [
        {
          id: 'PR_contract',
          repo: repository.id,
          number: 7,
          title: 'Normalize transport records',
          author: {id: 'USER_contributor', login: 'contributor'},
          mergedAt: parseCanonicalTimestamp(recordedResponses.mergedAt),
          headSha: recordedResponses.headSha,
          files: [
            {path: 'src/github.ts', additions: 21, deletions: 4},
            {path: 'src/types.ts', additions: 3, deletions: 1},
          ],
          closedIssueIds: ['ISSUE_2', 'ISSUE_1'],
          reviews: [
            {
              id: 'REVIEW_approved',
              author: {id: 'USER_reviewer', login: 'reviewer'},
              state: 'APPROVED',
              submittedAt: parseCanonicalTimestamp('2026-07-10T11:00:00.000Z'),
              bodyLength: 16,
              inlineComments: 2,
            },
            {
              id: 'REVIEW_deleted-author',
              author: null,
              state: 'COMMENTED',
              submittedAt: parseCanonicalTimestamp('2026-07-10T11:30:00.000Z'),
              bodyLength: 0,
              inlineComments: 1,
            },
          ],
          evidence: [
            {
              kind: 'screenshot',
              sha256: sha256('GIF89averified screenshot'),
            },
            {kind: 'logs', sha256: sha256('verified logs')},
          ],
        },
      ],
      issues: [
        {
          id: 'ISSUE_1',
          repo: repository.id,
          number: 11,
          title: 'Fix transport normalization',
          author: {id: 'USER_contributor', login: 'contributor'},
          closedAt: parseCanonicalTimestamp('2026-07-09T18:00:00.000Z'),
          stateReason: 'COMPLETED',
          labels: ['bug', 'priority'],
        },
        {
          id: 'ISSUE_2',
          repo: repository.id,
          number: 12,
          title: 'Deferred cleanup',
          author: {id: 'USER_contributor', login: 'contributor'},
          closedAt: parseCanonicalTimestamp('2026-07-09T19:00:00.000Z'),
          stateReason: 'NOT_PLANNED',
          labels: [],
        },
      ],
    };

    expect(records).toEqual(expected);
    expect(graphqlPages).toEqual([
      'search:first',
      'search:search-page-2',
      'files:first',
      'files:files-page-2',
      'reviews:first',
      'reviews:reviews-page-2',
      'closing-issues:first',
      'evidence-material:first',
      'issue:ISSUE_1:first',
      'issue:ISSUE_2:first',
      'issue:ISSUE_1:labels-page-2',
    ]);
    expect(evidenceRequests).toEqual([
      recordedResponses.evidenceUrls.screenshot,
      recordedResponses.evidenceUrls.logs,
    ]);
  });

  test('splits search windows above the GitHub result ceiling', async () => {
    const midpoint = '2026-07-16T12:00:00.000Z';
    const queries: string[] = [];
    const leftCandidates = Array.from({length: 1_000}, (_, index) =>
      searchCandidate(
        `PR_left_${index}`,
        index + 1,
        '2026-07-10T12:00:00.000Z',
        'release',
      ),
    );
    const rightCandidate = searchCandidate(
      'PR_right',
      1_001,
      '2026-07-20T12:00:00.000Z',
      'release',
    );
    const client = createGitHubClient({
      token: 'github-token',
      fetch: async (_url, init) => {
        const request = parseGraphqlRequest(init);
        const query = variableString(request.variables, 'query');
        queries.push(query);
        if (
          query.includes(
            `merged:${window.from}..${new Date(
              Date.parse(window.to) - 1,
            ).toISOString()}`,
          )
        ) {
          return searchResponse(1_001, []);
        }
        if (
          query.includes(
            `merged:${window.from}..${new Date(
              Date.parse(midpoint) - 1,
            ).toISOString()}`,
          )
        ) {
          return searchResponse(1_000, leftCandidates);
        }
        if (
          query.includes(
            `merged:${midpoint}..${new Date(
              Date.parse(window.to) - 1,
            ).toISOString()}`,
          )
        ) {
          return searchResponse(1, [rightCandidate]);
        }
        throw new Error('Unexpected split search interval.');
      },
      collectRepository: async (
        transport,
        requestedRepository,
        requestedWindow,
      ) => ({
        pullRequests: await fetchMergedPullRequests(
          transport,
          requestedRepository,
          requestedWindow,
        ),
        issues: [],
      }),
    });

    await expect(client.collect([repository], window)).resolves.toEqual({
      pullRequests: [],
      issues: [],
    });
    expect(queries).toHaveLength(3);
    expect(queries[1]).toContain(
      `merged:${window.from}..${new Date(
        Date.parse(midpoint) - 1,
      ).toISOString()}`,
    );
    expect(queries[2]).toContain(
      `merged:${midpoint}..${new Date(
        Date.parse(window.to) - 1,
      ).toISOString()}`,
    );
  });

  test('accepts only verified evidence within repository and resource boundaries', async () => {
    const goodUrl =
      'https://github.com/user-attachments/assets/11111111-1111-1111-1111-111111111111';
    const duplicateDigestUrl =
      'https://github.com/user-attachments/assets/22222222-2222-2222-2222-222222222222';
    const wrongMimeUrl =
      'https://github.com/user-attachments/assets/33333333-3333-3333-3333-333333333333';
    const oversizedUrl =
      'https://github.com/user-attachments/assets/44444444-4444-4444-4444-444444444444';
    const wrongRevisionUrl = `https://raw.githubusercontent.com/owner/repository/${'a'.repeat(40)}/old.png`;
    const requested: string[] = [];
    let evidence: PullRequest['evidence'] = [];
    const client = createGitHubClient({
      token: 'github-token',
      fetch: async (url, init) => {
        requested.push(url);
        expect(init.redirect).toBe('manual');
        expect(new Headers(init.headers).has('authorization')).toBe(false);
        if (url === goodUrl || url === duplicateDigestUrl) {
          return binaryResponse('GIF89asame verified image', 'image/png');
        }
        if (url === wrongMimeUrl) {
          return binaryResponse('not an image', 'text/plain');
        }
        if (url === oversizedUrl) {
          return new Response('x', {
            headers: {
              'Content-Type': 'text/plain',
              'Content-Length': String(4 * 1024 * 1024 + 1),
            },
          });
        }
        throw new Error('Unsafe evidence URL reached the transport.');
      },
      collectRepository: async transport => {
        evidence = await extractEvidence(
          transport,
          {repo: repository.id, headSha: recordedResponses.headSha},
          [
            `<!-- evidence-head:${recordedResponses.headSha} -->`,
            '<!-- evidence-row:after-screenshots -->',
            `[good](${goodUrl}) [duplicate](${duplicateDigestUrl}) ` +
              `[wrong MIME](${wrongMimeUrl})`,
            '<!-- evidence-row:frontend-logs -->',
            `[oversized](${oversizedUrl})`,
            `[wrong revision](${wrongRevisionUrl})`,
            '[external](https://example.com/image.png)',
            '[insecure](http://github.com/user-attachments/assets/12345678-1234-1234-1234-123456789abc)',
          ].join('\n'),
        );
        return {pullRequests: [], issues: []};
      },
    });

    await client.collect([repository], window);

    expect(evidence).toEqual([
      {
        kind: 'screenshot',
        sha256: sha256('GIF89asame verified image'),
      },
    ]);
    expect(requested).toEqual([
      goodUrl,
      duplicateDigestUrl,
      wrongMimeUrl,
      oversizedUrl,
    ]);
  });

  test('fails closed when search cannot return its reported collection', async () => {
    const client = createGitHubClient({
      token: 'github-token',
      fetch: async () =>
        searchResponse(2, [
          searchCandidate('PR_only', 1, recordedResponses.mergedAt),
        ]),
      collectRepository: async (
        transport,
        requestedRepository,
        requestedWindow,
      ) => ({
        pullRequests: await fetchMergedPullRequests(
          transport,
          requestedRepository,
          requestedWindow,
        ),
        issues: [],
      }),
    });

    await expect(client.collect([repository], window)).rejects.toThrow(
      'did not return its reported result count',
    );
  });

  test('fails closed when referenced-issue pagination is incomplete', async () => {
    const pullRequest: PullRequest = {
      id: 'PR_issue_reference',
      repo: repository.id,
      number: 9,
      title: 'Reference an issue',
      author: {id: 'USER_contributor', login: 'contributor'},
      mergedAt: parseCanonicalTimestamp(recordedResponses.mergedAt),
      headSha: recordedResponses.headSha,
      files: [],
      closedIssueIds: ['ISSUE_incomplete'],
      reviews: [],
      evidence: [],
    };
    const client = createGitHubClient({
      token: 'github-token',
      fetch: async () =>
        jsonResponse({
          data: {
            node: {
              __typename: 'Issue',
              id: 'ISSUE_incomplete',
              number: 99,
              title: 'Incomplete labels',
              author: {id: 'USER_contributor', login: 'contributor'},
              closedAt: recordedResponses.mergedAt,
              stateReason: 'COMPLETED',
              repository: {nameWithOwner: repository.id},
              labels: {
                nodes: [{name: 'bug'}],
                pageInfo: {hasNextPage: true, endCursor: null},
              },
            },
          },
        }),
      collectRepository: async (transport, requestedRepository) => ({
        pullRequests: [pullRequest],
        issues: await fetchReferencedIssues(transport, requestedRepository, [
          pullRequest,
        ]),
      }),
    });

    await expect(client.collect([repository], window)).rejects.toThrow(
      'returned an invalid cursor',
    );
  });
});
