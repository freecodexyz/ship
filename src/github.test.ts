import {expect, test} from 'bun:test';
import {createHash} from 'node:crypto';

import {deriveFacts} from './facts.js';
import {
  createGitHubClient,
  extractEvidence,
  fetchMergedPullRequests,
  fetchReferencedIssues,
} from './github.js';
import {scoreFacts} from './score.js';
import {parseCanonicalTimestamp} from './time.js';
import type {
  CollectionWindow,
  Issue,
  Project,
  ProjectRepository,
  PullRequest,
} from './types.js';

const repository: ProjectRepository = {id: 'owner/repository', branch: 'main'};
const window: CollectionWindow = {
  from: parseCanonicalTimestamp('2026-07-01T00:00:00.000Z'),
  to: parseCanonicalTimestamp('2026-08-01T00:00:00.000Z'),
};
const mergedAt = parseCanonicalTimestamp('2026-07-10T12:00:00.000Z');

const pullRequest: PullRequest = {
  id: 'PR_node',
  repo: repository.id,
  number: 7,
  title: 'A normalized pull request',
  author: {id: 'USER_node', login: 'contributor'},
  mergedAt,
  headSha: 'a'.repeat(40),
  files: [],
  closedIssueIds: ['ISSUE_node'],
  reviews: [],
  evidence: [],
};

const issue: Issue = {
  id: 'ISSUE_node',
  repo: repository.id,
  number: 3,
  title: 'A normalized issue',
  author: pullRequest.author,
  closedAt: mergedAt,
  stateReason: 'COMPLETED',
  labels: ['accepted'],
};

const project: Project = {
  id: 'project',
  name: 'Project',
  mission: 'Deliver bounded, reviewable improvements to Ship.',
  repositories: [repository],
  allowedModels: [],
};

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), init);
}

function binaryResponse(
  value: string,
  contentType: string,
  init: ResponseInit = {},
): Response {
  const response = new Response(value, init);
  response.headers.set('Content-Type', contentType);
  return response;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function evidenceBody(headSha: string, rows: readonly string[]): string {
  return [`<!-- evidence-head:${headSha} -->`, ...rows].join('\n');
}

async function extractWithFetch(
  material: string,
  fetch: (url: string, init: RequestInit) => Promise<Response>,
  target: Pick<PullRequest, 'repo' | 'headSha'> = pullRequest,
): Promise<PullRequest['evidence']> {
  let extracted: PullRequest['evidence'] = [];
  const client = createGitHubClient({
    token: 'github-token',
    fetch,
    collectRepository: async transport => {
      extracted = await extractEvidence(transport, target, material);
      return {pullRequests: [], issues: []};
    },
  });
  await client.collect([repository], window);
  return extracted;
}

function requestRecord(init: RequestInit): Readonly<Record<string, unknown>> {
  if (typeof init.body !== 'string') {
    throw new TypeError('Expected a JSON request body.');
  }
  const value: unknown = JSON.parse(init.body);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected a JSON request object.');
  }
  return value as Readonly<Record<string, unknown>>;
}

function searchCandidate(
  id: string,
  number: number,
  candidateMergedAt: string,
  baseRefName = 'main',
): Readonly<Record<string, unknown>> {
  return {
    id,
    number,
    title: `Pull request ${number}`,
    author: {id: `USER_${number}`, login: `contributor-${number}`},
    mergedAt: candidateMergedAt,
    baseRefName,
    headRefOid: number.toString(16).padStart(40, '0'),
  };
}

function searchResponse(
  totalCount: number,
  nodes: readonly unknown[],
): Response {
  return jsonResponse({
    data: {
      search: {
        issueCount: totalCount,
        nodes,
        pageInfo: {hasNextPage: false, endCursor: null},
      },
    },
  });
}

function referencedIssueNode(
  id: string,
  number: number,
  title: string,
  labels: readonly string[],
  hasNextPage = false,
  endCursor: string | null = null,
  nameWithOwner = repository.id,
): Readonly<Record<string, unknown>> {
  return {
    __typename: 'Issue',
    id,
    number,
    title,
    author: {id: 'USER_node', login: 'contributor'},
    closedAt: mergedAt,
    stateReason: 'COMPLETED',
    repository: {nameWithOwner},
    labels: {
      nodes: labels.map(name => ({name})),
      pageInfo: {hasNextPage, endCursor},
    },
  };
}

function referencedIssueResponse(node: unknown): Response {
  return jsonResponse({data: {node}});
}

function graphqlOperation(init: RequestInit): string {
  const query = requestRecord(init).query;
  if (typeof query !== 'string') {
    throw new TypeError('Expected a GraphQL query string.');
  }
  return query;
}

test('authenticates and hides REST and GraphQL pagination state', async () => {
  const authorizations: Array<string | null> = [];
  const graphqlCursors: unknown[] = [];
  let graphqlPage = 0;

  const client = createGitHubClient({
    token: 'github-token',
    fetch: async (url, init) => {
      authorizations.push(new Headers(init.headers).get('authorization'));

      if (url === 'https://api.github.com/items?page=1') {
        return jsonResponse([{id: 'REST_1'}], {
          headers: {
            Link: '<https://api.github.com/items?page=2>; rel="next"',
            'X-RateLimit-Remaining': '2',
          },
        });
      }
      if (url === 'https://api.github.com/items?page=2') {
        return jsonResponse([{id: 'REST_2'}]);
      }
      if (url === 'https://api.github.com/graphql') {
        const body = requestRecord(init);
        const variables = body.variables;
        if (
          typeof variables !== 'object' ||
          variables === null ||
          Array.isArray(variables)
        ) {
          throw new TypeError('Expected GraphQL variables.');
        }
        graphqlCursors.push(
          (variables as Readonly<Record<string, unknown>>).after,
        );
        graphqlPage += 1;
        if (graphqlPage === 1) {
          return jsonResponse({
            data: {
              repository: {
                pullRequests: {
                  nodes: [{id: 'GRAPHQL_1'}],
                  pageInfo: {hasNextPage: true, endCursor: 'cursor-1'},
                },
              },
              rateLimit: {
                remaining: 2,
                resetAt: '2026-07-01T00:01:00.000Z',
              },
            },
          });
        }
        return jsonResponse({
          data: {
            repository: {
              pullRequests: {
                edges: [{node: {id: 'GRAPHQL_2'}}],
                pageInfo: {hasNextPage: false, endCursor: null},
              },
            },
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    collectRepository: async (
      transport,
      requestedRepository,
      requestedWindow,
    ) => {
      expect(requestedRepository).toEqual(repository);
      expect(requestedWindow).toEqual(window);

      const rest = await transport.paginateRest('/items?page=1');
      const graphql = await transport.paginateGraphql({
        query:
          'query Items($after: String) { repository { pullRequests { nodes { id } } } }',
        connectionPath: ['repository', 'pullRequests'],
      });

      expect(rest).toEqual([{id: 'REST_1'}, {id: 'REST_2'}]);
      expect(graphql).toEqual([{id: 'GRAPHQL_1'}, {id: 'GRAPHQL_2'}]);
      return {pullRequests: [pullRequest], issues: [issue]};
    },
  });

  await expect(client.collect([repository], window)).resolves.toEqual({
    pullRequests: [pullRequest],
    issues: [issue],
  });
  expect(authorizations).toEqual([
    'Bearer github-token',
    'Bearer github-token',
    'Bearer github-token',
    'Bearer github-token',
  ]);
  expect(graphqlCursors).toEqual([null, 'cursor-1']);
});

test('retries transient responses within the configured bound', async () => {
  const delays: number[] = [];
  let attempts = 0;
  const client = createGitHubClient({
    token: 'github-token',
    fetch: async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(null, {
          status: 503,
          headers: {'Retry-After': '0'},
        });
      }
      return jsonResponse([]);
    },
    sleep: milliseconds => {
      delays.push(milliseconds);
      return Promise.resolve();
    },
    collectRepository: async transport => {
      await transport.paginateRest('/items');
      return {pullRequests: [], issues: []};
    },
  });

  await expect(client.collect([repository], window)).resolves.toEqual({
    pullRequests: [],
    issues: [],
  });
  expect(attempts).toBe(2);
  expect(delays).toEqual([0]);
});

test('rejects pagination that leaves the official API origin', async () => {
  let attempts = 0;
  const client = createGitHubClient({
    token: 'github-token',
    fetch: async () => {
      attempts += 1;
      return jsonResponse([], {
        headers: {Link: '<https://example.com/items?page=2>; rel="next"'},
      });
    },
    collectRepository: async transport => {
      await transport.paginateRest('/items');
      return {pullRequests: [], issues: []};
    },
  });

  await expect(client.collect([repository], window)).rejects.toThrow(
    'pagination attempted to leave api.github.com',
  );
  expect(attempts).toBe(1);
});

test('fails before reading a response over the configured byte limit', async () => {
  const client = createGitHubClient({
    token: 'github-token',
    maxResponseBytes: 16,
    fetch: async () =>
      jsonResponse([{value: 'too large'}], {
        headers: {'Content-Length': '100'},
      }),
    collectRepository: async transport => {
      await transport.paginateRest('/items');
      return {pullRequests: [], issues: []};
    },
  });

  await expect(client.collect([repository], window)).rejects.toThrow(
    'response exceeded the byte limit',
  );
});

test('fails closed when exhausted rate-limit delay exceeds its bound', async () => {
  let attempts = 0;
  const client = createGitHubClient({
    token: 'github-token',
    now: () => 0,
    maxRetryDelayMs: 100,
    fetch: async () => {
      attempts += 1;
      return jsonResponse([], {
        headers: {
          Link: '<https://api.github.com/items?page=2>; rel="next"',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': '10',
        },
      });
    },
    collectRepository: async transport => {
      await transport.paginateRest('/items?page=1');
      return {pullRequests: [], issues: []};
    },
  });

  await expect(client.collect([repository], window)).rejects.toThrow(
    'retry delay exceeded its safety limit',
  );
  expect(attempts).toBe(1);
});

test('fetches, qualifies, hydrates, normalizes, and deduplicates merged pull requests', async () => {
  const hydrationOperations: string[] = [];
  const accepted = searchCandidate('PR_stable', 7, '2026-07-01T00:00:00Z');
  const acceptedSha = '7'.padStart(40, '0');
  const screenshotUrl =
    'https://github.com/user-attachments/assets/11111111-1111-1111-1111-111111111111';
  const logsUrl =
    'https://github.com/user-attachments/assets/22222222-2222-2222-2222-222222222222';
  const client = createGitHubClient({
    token: 'github-token',
    fetch: async (url, init) => {
      if (url === screenshotUrl) {
        hydrationOperations.push('evidenceDownload');
        expect(new Headers(init.headers).has('authorization')).toBe(false);
        return binaryResponse('GIF89averified screenshot', 'image/png');
      }
      if (url === logsUrl) {
        hydrationOperations.push('evidenceDownload');
        return binaryResponse('verified logs', 'text/plain');
      }
      expect(url).toBe('https://api.github.com/graphql');
      const operation = graphqlOperation(init);
      if (operation.includes('query SearchMergedPullRequests')) {
        const variables = requestRecord(init).variables as Readonly<
          Record<string, unknown>
        >;
        expect(variables.query).toBe(
          'repo:"owner/repository" is:pr is:merged base:"main" ' +
            `merged:${window.from}..${new Date(
              Date.parse(window.to) - 1,
            ).toISOString()} sort:created-asc`,
        );
        return searchResponse(4, [
          accepted,
          accepted,
          searchCandidate('PR_wrong_branch', 8, mergedAt, 'release'),
          searchCandidate('PR_upper_bound', 9, window.to),
        ]);
      }

      const body = requestRecord(init);
      expect(body.variables).toEqual({
        owner: 'owner',
        name: 'repository',
        number: 7,
        after: null,
      });
      if (operation.includes('query PullRequestFiles')) {
        hydrationOperations.push('files');
        return jsonResponse({
          data: {
            repository: {
              pullRequest: {
                files: {
                  nodes: [{path: 'src/change.ts', additions: 12, deletions: 3}],
                  pageInfo: {hasNextPage: false, endCursor: null},
                },
              },
            },
          },
        });
      }
      if (operation.includes('query PullRequestReviews')) {
        hydrationOperations.push('reviews');
        return jsonResponse({
          data: {
            repository: {
              pullRequest: {
                reviews: {
                  nodes: [
                    {
                      id: 'REVIEW_1',
                      author: {id: 'REVIEWER_1', login: 'reviewer'},
                      state: 'APPROVED',
                      submittedAt: mergedAt,
                      body: '  Looks good.  ',
                      comments: {totalCount: 2},
                    },
                    {state: 'PENDING'},
                  ],
                  pageInfo: {hasNextPage: false, endCursor: null},
                },
              },
            },
          },
        });
      }
      if (operation.includes('query PullRequestClosingIssues')) {
        hydrationOperations.push('closingIssues');
        return jsonResponse({
          data: {
            repository: {
              pullRequest: {
                closingIssuesReferences: {
                  nodes: [{id: 'ISSUE_1'}, {id: 'ISSUE_1'}, {id: 'ISSUE_2'}],
                  pageInfo: {hasNextPage: false, endCursor: null},
                },
              },
            },
          },
        });
      }
      if (operation.includes('query PullRequestEvidenceMaterial')) {
        hydrationOperations.push('evidenceMaterial');
        return jsonResponse({
          data: {
            repository: {
              pullRequest: {
                id: 'PR_stable',
                headRefOid: acceptedSha,
                author: {id: 'USER_7'},
                body: evidenceBody(acceptedSha, [
                  '<!-- evidence-row:after-screenshots -->',
                  `![after](${screenshotUrl})`,
                  '<!-- evidence-row:frontend-logs -->',
                  `[logs](${logsUrl})`,
                ]),
                lastEditedAt: null,
                userContentEdits: {totalCount: 0, nodes: []},
              },
            },
          },
        });
      }
      throw new Error(`Unexpected GraphQL operation: ${operation}`);
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
    pullRequests: [
      {
        id: 'PR_stable',
        repo: repository.id,
        number: 7,
        title: 'Pull request 7',
        author: {id: 'USER_7', login: 'contributor-7'},
        mergedAt: window.from,
        headSha: acceptedSha,
        files: [{path: 'src/change.ts', additions: 12, deletions: 3}],
        closedIssueIds: ['ISSUE_1', 'ISSUE_2'],
        reviews: [
          {
            id: 'REVIEW_1',
            author: {id: 'REVIEWER_1', login: 'reviewer'},
            state: 'APPROVED',
            submittedAt: mergedAt,
            bodyLength: 11,
            inlineComments: 2,
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
    issues: [],
  });
  expect(hydrationOperations).toEqual([
    'files',
    'reviews',
    'closingIssues',
    'evidenceMaterial',
    'evidenceDownload',
    'evidenceDownload',
  ]);
});

test('voids author post-merge body edits but retains pinned maintainer edits', async () => {
  const attachment =
    'https://github.com/user-attachments/assets/99999999-9999-9999-9999-999999999999';

  async function collectEvidence(
    editorId: string,
  ): Promise<PullRequest['evidence']> {
    const headSha = '8'.repeat(40);
    const candidate = {
      ...searchCandidate('PR_edited', 8, mergedAt),
      headRefOid: headSha,
    };
    const client = createGitHubClient({
      token: 'github-token',
      fetch: async (url, init) => {
        if (url === attachment)
          return binaryResponse('GIF89aimage', 'image/png');
        const operation = graphqlOperation(init);
        if (operation.includes('query SearchMergedPullRequests')) {
          return searchResponse(1, [candidate]);
        }
        if (operation.includes('query PullRequestDetails')) {
          return jsonResponse({
            data: {
              nodes: [
                {
                  __typename: 'PullRequest',
                  id: 'PR_edited',
                  headRefOid: headSha,
                  author: {id: 'USER_8', login: 'contributor-8'},
                  body: evidenceBody(headSha, [
                    '<!-- evidence-row:after-screenshots -->',
                    `![after](${attachment})`,
                  ]),
                  lastEditedAt: '2026-07-10T12:00:01Z',
                  userContentEdits: {
                    totalCount: 1,
                    nodes: [
                      {
                        editedAt: '2026-07-10T12:00:01Z',
                        editor: {id: editorId},
                      },
                    ],
                  },
                  files: {
                    nodes: [],
                    pageInfo: {hasNextPage: false, endCursor: null},
                  },
                  reviews: {
                    nodes: [],
                    pageInfo: {hasNextPage: false, endCursor: null},
                  },
                  closingIssuesReferences: {
                    nodes: [],
                    pageInfo: {hasNextPage: false, endCursor: null},
                  },
                },
              ],
              rateLimit: {remaining: 4_000, resetAt: mergedAt},
            },
          });
        }
        throw new Error(`Unexpected GraphQL operation: ${operation}`);
      },
    });
    const records = await client.collect([repository], window);
    return records.pullRequests[0]?.evidence ?? [];
  }

  await expect(collectEvidence('USER_8')).resolves.toEqual([]);
  await expect(collectEvidence('MAINTAINER_1')).resolves.toEqual([
    {kind: 'screenshot', sha256: sha256('GIF89aimage')},
  ]);
});

test('normalizes typed and patterned bot actors as missing', async () => {
  const candidates = [
    {
      ...searchCandidate('PR_typed_bot', 1, mergedAt),
      author: {__typename: 'Bot', id: 'BOT_1', login: 'automation'},
    },
    {
      ...searchCandidate('PR_pattern_bot', 2, mergedAt),
      author: {__typename: 'User', id: 'BOT_2', login: 'dependabot[bot]'},
    },
  ];
  const client = createGitHubClient({
    token: 'github-token',
    fetch: async (_url, init) => {
      const operation = graphqlOperation(init);
      if (operation.includes('query SearchMergedPullRequests')) {
        return searchResponse(candidates.length, candidates);
      }
      throw new Error(`Unexpected GraphQL operation: ${operation}`);
    },
  });

  const records = await client.collect([repository], window);

  expect(records.pullRequests.map(value => value.author)).toEqual([null, null]);
  expect(scoreFacts(deriveFacts([project], records.pullRequests, []))).toEqual({
    buckets: [],
    awards: [],
  });
});

test('batch-hydrates only the latest five author outcomes', async () => {
  const operations: string[] = [];
  const candidates = Array.from({length: 6}, (_, index) => {
    const number = index + 1;
    return {
      ...searchCandidate(`PR_${number}`, number, '2026-07-06T12:00:00Z'),
      author: {id: 'USER_shared', login: 'shared'},
    };
  });
  const client = createGitHubClient({
    token: 'github-token',
    fetch: async (url, init) => {
      if (url.startsWith('https://github.com/user-attachments/')) {
        operations.push('evidence-download');
        return binaryResponse(`\x00\x00\x00\x18ftypvideo:${url}`, 'video/mp4');
      }

      const operation = graphqlOperation(init);
      const body = requestRecord(init);
      const variables = body.variables as Readonly<Record<string, unknown>>;
      if (operation.includes('query SearchMergedPullRequests')) {
        operations.push('search');
        return searchResponse(candidates.length, candidates);
      }
      if (operation.includes('query PullRequestDetails')) {
        const ids = variables.ids;
        if (!Array.isArray(ids)) throw new TypeError('Expected detail ids.');
        const numbers = ids.map(id => Number(String(id).slice('PR_'.length)));
        operations.push(`details:${numbers.join(',')}`);
        return jsonResponse({
          data: {
            nodes: numbers.map(number => {
              const sha = number.toString(16).padStart(40, '0');
              const evidenceUrl =
                'https://github.com/user-attachments/assets/' +
                `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;
              return {
                __typename: 'PullRequest',
                id: `PR_${number}`,
                headRefOid: sha,
                author: {id: 'USER_shared', login: 'shared'},
                body: evidenceBody(sha, [
                  '<!-- evidence-row:walkthrough-video -->',
                  `[video](${evidenceUrl})`,
                ]),
                lastEditedAt: null,
                userContentEdits: {totalCount: 0, nodes: []},
                files: {
                  nodes: [
                    {path: 'tests/change.test.ts', additions: 20, deletions: 0},
                  ],
                  pageInfo: {hasNextPage: false, endCursor: null},
                },
                reviews: {
                  nodes: [],
                  pageInfo: {hasNextPage: false, endCursor: null},
                },
                closingIssuesReferences: {
                  nodes: [{id: `ISSUE_${number}`}],
                  pageInfo: {hasNextPage: false, endCursor: null},
                },
                comments: {
                  nodes: [],
                  pageInfo: {hasNextPage: false, endCursor: null},
                },
              };
            }),
            rateLimit: {remaining: 4_000, resetAt: mergedAt},
          },
        });
      }
      if (operation.includes('query ReferencedIssue')) {
        const id = variables.id;
        if (typeof id !== 'string') throw new TypeError('Expected issue id.');
        const number = Number(id.slice('ISSUE_'.length));
        operations.push(`issue:${number}`);
        return referencedIssueResponse({
          ...referencedIssueNode(id, number, `Issue ${number}`, []),
          closedAt: '2026-07-07T12:00:00Z',
        });
      }

      throw new Error(`Unexpected GraphQL operation: ${operation}`);
    },
  });

  const records = await client.collect([repository], window);
  const result = scoreFacts(
    deriveFacts([project], records.pullRequests, records.issues),
  );

  expect(operations.filter(value => value.startsWith('details:'))).toEqual([
    'details:6,5,4,3,2',
  ]);
  expect(
    operations.filter(value => value === 'evidence-download'),
  ).toHaveLength(5);
  expect(
    result.awards
      .filter(award => award.kind === 'merged_pr')
      .map(award => award.source.number),
  ).toEqual([2, 3, 4, 5, 6]);
  expect(result.buckets).toHaveLength(1);
  expect(result.buckets[0]?.score).toBe(100);
});

test('shares detail selection across project repositories', async () => {
  const repositories: readonly ProjectRepository[] = [
    {id: 'owner/alpha', branch: 'main'},
    {id: 'owner/beta', branch: 'main'},
  ];
  const numbersByRepository = new Map([
    ['owner/alpha', [1, 4, 6]],
    ['owner/beta', [2, 3, 5]],
  ]);
  const detailBatches: number[][] = [];
  const client = createGitHubClient({
    token: 'github-token',
    fetch: async (_url, init) => {
      const operation = graphqlOperation(init);
      const body = requestRecord(init);
      const variables = body.variables as Readonly<Record<string, unknown>>;
      if (operation.includes('query SearchMergedPullRequests')) {
        const query = variables.query;
        if (typeof query !== 'string') throw new TypeError('Expected search.');
        const entry = [...numbersByRepository.entries()].find(([repo]) =>
          query.includes(repo),
        );
        if (entry === undefined) throw new Error('Unexpected repository.');
        return searchResponse(
          entry[1].length,
          entry[1].map(number => ({
            ...searchCandidate(
              `PR_${number}`,
              number,
              `2026-07-${String(number).padStart(2, '0')}T12:00:00Z`,
            ),
            author: {id: 'USER_shared', login: 'shared'},
          })),
        );
      }
      if (operation.includes('query PullRequestDetails')) {
        const ids = variables.ids;
        if (!Array.isArray(ids)) throw new TypeError('Expected detail ids.');
        const numbers = ids.map(id => Number(String(id).slice('PR_'.length)));
        detailBatches.push(numbers);
        return jsonResponse({
          data: {
            nodes: numbers.map(number => ({
              __typename: 'PullRequest',
              id: `PR_${number}`,
              headRefOid: number.toString(16).padStart(40, '0'),
              author: {id: 'USER_shared', login: 'shared'},
              body: null,
              lastEditedAt: null,
              userContentEdits: {totalCount: 0, nodes: []},
              files: {
                nodes: [
                  {path: 'tests/change.test.ts', additions: 20, deletions: 0},
                ],
                pageInfo: {hasNextPage: false, endCursor: null},
              },
              reviews: {
                nodes: [],
                pageInfo: {hasNextPage: false, endCursor: null},
              },
              closingIssuesReferences: {
                nodes: [],
                pageInfo: {hasNextPage: false, endCursor: null},
              },
              comments: {
                nodes: [],
                pageInfo: {hasNextPage: false, endCursor: null},
              },
            })),
            rateLimit: {remaining: 4_000, resetAt: mergedAt},
          },
        });
      }
      if (operation.includes('query PullRequestFiles')) {
        return jsonResponse({
          data: {
            repository: {
              pullRequest: {
                files: {
                  nodes: [],
                  pageInfo: {hasNextPage: false, endCursor: null},
                },
              },
            },
          },
        });
      }
      if (operation.includes('query PullRequestReviews')) {
        return jsonResponse({
          data: {
            repository: {
              pullRequest: {
                reviews: {
                  nodes: [],
                  pageInfo: {hasNextPage: false, endCursor: null},
                },
              },
            },
          },
        });
      }
      if (operation.includes('query PullRequestClosingIssues')) {
        return jsonResponse({
          data: {
            repository: {
              pullRequest: {
                closingIssuesReferences: {
                  nodes: [],
                  pageInfo: {hasNextPage: false, endCursor: null},
                },
              },
            },
          },
        });
      }
      throw new Error(`Unexpected GraphQL operation: ${operation}`);
    },
  });

  await client.collect(repositories, window);

  expect(detailBatches).toEqual([[6, 5, 4, 3, 2]]);
});

test('splits only search intervals above the GitHub result limit', async () => {
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
  let searchCall = 0;
  const client = createGitHubClient({
    token: 'github-token',
    fetch: async (_url, init) => {
      const operation = graphqlOperation(init);
      if (!operation.includes('query SearchMergedPullRequests')) {
        throw new Error('Unqualified pull requests must not be hydrated.');
      }
      const variables = requestRecord(init).variables as Readonly<
        Record<string, unknown>
      >;
      if (typeof variables.query !== 'string') {
        throw new TypeError('Expected a search query.');
      }
      queries.push(variables.query);
      searchCall += 1;
      if (searchCall === 1) return searchResponse(1_001, []);
      if (searchCall === 2) return searchResponse(1_000, leftCandidates);
      return searchResponse(1, [rightCandidate]);
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
  expect(queries[0]).toContain(
    `merged:${window.from}..${new Date(
      Date.parse(window.to) - 1,
    ).toISOString()}`,
  );
  expect(queries[1]).toContain(
    `merged:${window.from}..2026-07-16T11:59:59.999Z`,
  );
  expect(queries[2]).toContain(
    `merged:2026-07-16T12:00:00.000Z..${new Date(
      Date.parse(window.to) - 1,
    ).toISOString()}`,
  );
});

test('fails closed when search pagination cannot prove its reported count', async () => {
  const client = createGitHubClient({
    token: 'github-token',
    fetch: async () =>
      searchResponse(2, [searchCandidate('PR_only', 1, mergedAt)]),
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

test('retries when split interval counts change during collection', async () => {
  let searchCall = 0;
  const client = createGitHubClient({
    token: 'github-token',
    fetch: async () => {
      searchCall += 1;
      if (searchCall === 1) return searchResponse(1_001, []);
      return searchResponse(0, []);
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
  expect(searchCall).toBe(4);
});

test('fails closed when split interval counts keep changing', async () => {
  let searchCall = 0;
  const client = createGitHubClient({
    token: 'github-token',
    fetch: async () => {
      searchCall += 1;
      return searchCall % 3 === 1
        ? searchResponse(1_001, [])
        : searchResponse(0, []);
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

  await expect(client.collect([repository], window)).rejects.toThrow(
    'interval counts kept changing during collection',
  );
  expect(searchCall).toBe(9);
});

test('fetches only unique referenced issues and normalizes them deterministically', async () => {
  const requestedPages: unknown[] = [];
  const pullRequests: readonly PullRequest[] = [
    {...pullRequest, closedIssueIds: ['ISSUE_B', 'ISSUE_A', 'ISSUE_A']},
    {...pullRequest, id: 'PR_other', number: 8, closedIssueIds: ['ISSUE_B']},
  ];
  const client = createGitHubClient({
    token: 'github-token',
    fetch: async (_url, init) => {
      expect(graphqlOperation(init)).toContain('query ReferencedIssue');
      const variables = requestRecord(init).variables;
      requestedPages.push(variables);
      if (
        typeof variables !== 'object' ||
        variables === null ||
        Array.isArray(variables)
      ) {
        throw new TypeError('Expected GraphQL variables.');
      }
      const values = variables as Readonly<Record<string, unknown>>;
      if (values.id === 'ISSUE_A' && values.after === null) {
        return referencedIssueResponse(
          referencedIssueNode(
            'ISSUE_A',
            11,
            'Issue A',
            ['zeta', 'zeta'],
            true,
            'labels-a',
          ),
        );
      }
      if (values.id === 'ISSUE_A' && values.after === 'labels-a') {
        return referencedIssueResponse(
          referencedIssueNode('ISSUE_A', 11, 'Issue A', ['alpha']),
        );
      }
      if (values.id === 'ISSUE_B' && values.after === null) {
        return referencedIssueResponse(
          referencedIssueNode('ISSUE_B', 12, 'Issue B', ['bug']),
        );
      }
      throw new Error('Unexpected referenced issue request.');
    },
    collectRepository: async (transport, requestedRepository) => ({
      pullRequests,
      issues: await fetchReferencedIssues(
        transport,
        requestedRepository,
        pullRequests,
      ),
    }),
  });

  await expect(client.collect([repository], window)).resolves.toEqual({
    pullRequests,
    issues: [
      {
        id: 'ISSUE_A',
        repo: repository.id,
        number: 11,
        title: 'Issue A',
        author: {id: 'USER_node', login: 'contributor'},
        closedAt: mergedAt,
        stateReason: 'COMPLETED',
        labels: ['alpha', 'zeta'],
      },
      {
        id: 'ISSUE_B',
        repo: repository.id,
        number: 12,
        title: 'Issue B',
        author: {id: 'USER_node', login: 'contributor'},
        closedAt: mergedAt,
        stateReason: 'COMPLETED',
        labels: ['bug'],
      },
    ],
  });
  expect(requestedPages).toEqual([
    {id: 'ISSUE_A', after: null},
    {id: 'ISSUE_B', after: null},
    {id: 'ISSUE_A', after: 'labels-a'},
  ]);
});

test('does not query GitHub when pull requests reference no issues', async () => {
  let requests = 0;
  const pullRequests = [{...pullRequest, closedIssueIds: []}];
  const client = createGitHubClient({
    token: 'github-token',
    fetch: async () => {
      requests += 1;
      throw new Error('No GitHub request was expected.');
    },
    collectRepository: async (transport, requestedRepository) => ({
      pullRequests,
      issues: await fetchReferencedIssues(
        transport,
        requestedRepository,
        pullRequests,
      ),
    }),
  });

  await expect(client.collect([repository], window)).resolves.toEqual({
    pullRequests,
    issues: [],
  });
  expect(requests).toBe(0);
});

test('omits referenced issues that were reopened after a pull request merged', async () => {
  const reopened = {
    ...referencedIssueNode('ISSUE_node', 11, 'Reopened issue', []),
    closedAt: null,
    stateReason: 'REOPENED',
  };
  const client = createGitHubClient({
    token: 'github-token',
    fetch: async () => referencedIssueResponse(reopened),
    collectRepository: async (transport, requestedRepository) => ({
      pullRequests: [pullRequest],
      issues: await fetchReferencedIssues(transport, requestedRepository, [
        pullRequest,
      ]),
    }),
  });

  await expect(client.collect([repository], window)).resolves.toEqual({
    pullRequests: [pullRequest],
    issues: [],
  });
});

test('fails closed when a referenced issue cannot be fetched', async () => {
  const client = createGitHubClient({
    token: 'github-token',
    fetch: async () => referencedIssueResponse(null),
    collectRepository: async (transport, requestedRepository) => ({
      pullRequests: [pullRequest],
      issues: await fetchReferencedIssues(transport, requestedRepository, [
        pullRequest,
      ]),
    }),
  });

  await expect(client.collect([repository], window)).rejects.toThrow(
    'ISSUE_node page 0 was not found',
  );
});

test('fails closed when a referenced issue changes during label pagination', async () => {
  let page = 0;
  const client = createGitHubClient({
    token: 'github-token',
    fetch: async () => {
      page += 1;
      return page === 1
        ? referencedIssueResponse(
            referencedIssueNode(
              'ISSUE_node',
              3,
              'Original title',
              [],
              true,
              'next-labels',
            ),
          )
        : referencedIssueResponse(
            referencedIssueNode('ISSUE_node', 3, 'Changed title', []),
          );
    },
    collectRepository: async (transport, requestedRepository) => ({
      pullRequests: [pullRequest],
      issues: await fetchReferencedIssues(transport, requestedRepository, [
        pullRequest,
      ]),
    }),
  });

  await expect(client.collect([repository], window)).rejects.toThrow(
    'ISSUE_node changed during collection',
  );
  expect(page).toBe(2);
});

test('fails closed when a referenced issue belongs to another repository', async () => {
  const client = createGitHubClient({
    token: 'github-token',
    fetch: async () =>
      referencedIssueResponse(
        referencedIssueNode(
          'ISSUE_node',
          3,
          'Wrong repository',
          [],
          false,
          null,
          'other/repository',
        ),
      ),
    collectRepository: async (transport, requestedRepository) => ({
      pullRequests: [pullRequest],
      issues: await fetchReferencedIssues(transport, requestedRepository, [
        pullRequest,
      ]),
    }),
  });

  await expect(client.collect([repository], window)).rejects.toThrow(
    'belongs to a different repository',
  );
});

test('extracts canonical evidence rows and deduplicates resource identities', async () => {
  const revision = pullRequest.headSha;
  const urls = {
    screenshot:
      'https://github.com/user-attachments/assets/11111111-1111-1111-1111-111111111111',
    video:
      'https://github.com/user-attachments/assets/22222222-2222-2222-2222-222222222222',
    logs: 'https://github.com/user-attachments/assets/33333333-3333-3333-3333-333333333333',
    trajectory:
      'https://github.com/user-attachments/assets/44444444-4444-4444-4444-444444444444',
    artifact:
      'https://github.com/user-attachments/assets/55555555-5555-5555-5555-555555555555',
    duplicateDigest:
      'https://github.com/user-attachments/assets/66666666-6666-6666-6666-666666666666',
  } as const;
  const requested: string[] = [];
  const resources = new Map<string, readonly [string, string]>([
    [urls.screenshot, ['GIF89ascreenshot bytes', 'image/png']],
    [urls.video, ['\x00\x00\x00\x18ftypvideo bytes', 'video/mp4']],
    [urls.logs, ['log bytes', 'text/plain; charset=utf-8']],
    [urls.trajectory, ['{"trajectory":"bytes"}', 'application/json']],
    [urls.artifact, ['PK\x03\x04artifact bytes', 'application/zip']],
    [urls.duplicateDigest, ['log bytes', 'text/plain']],
  ]);

  const evidence = await extractWithFetch(
    evidenceBody(revision, [
      '<!-- evidence-row:after-screenshots -->',
      '- [x] Browser captures from the merged head:',
      `  <img alt="after" src="${urls.screenshot}" />`,
      '<!-- evidence-row:walkthrough-video -->',
      `- [x] ${urls.video}`,
      '<!-- evidence-row:frontend-logs -->',
      `- [x] [browser log](${urls.logs})`,
      '<!-- evidence-row:llm-trajectory -->',
      `- [x] [trace](${urls.trajectory})`,
      '<!-- evidence-row:domain-artifacts -->',
      `- [x] [archive](${urls.artifact})`,
      '- [x] N/A - placeholder',
      '<!-- evidence-row:backend-logs -->',
      `- [x] [copy](${urls.duplicateDigest})`,
      `> [quoted](${urls.logs})`,
      '```md',
      `[fenced](${urls.logs})`,
      '```',
    ]),
    async (url, init) => {
      requested.push(url);
      expect(new Headers(init.headers).has('authorization')).toBe(false);
      expect(init.redirect).toBe('manual');
      const resource = resources.get(url);
      if (resource === undefined) throw new Error(`Unexpected URL: ${url}`);
      return binaryResponse(resource[0], resource[1]);
    },
  );

  expect(evidence).toEqual([
    {kind: 'screenshot', sha256: sha256('GIF89ascreenshot bytes')},
    {kind: 'video', sha256: sha256('\x00\x00\x00\x18ftypvideo bytes')},
    {kind: 'logs', sha256: sha256('log bytes')},
    {kind: 'trajectory', sha256: sha256('{"trajectory":"bytes"}')},
    {kind: 'artifact', sha256: sha256('PK\x03\x04artifact bytes')},
  ]);
  expect(requested).toHaveLength(6);
});

test('rejects unbound, duplicate-head, N/A, mutable, mistyped, and oversized evidence', async () => {
  const revision = pullRequest.headSha;
  const wrongMime =
    'https://github.com/user-attachments/assets/77777777-7777-7777-7777-777777777777';
  const oversized =
    'https://github.com/user-attachments/assets/88888888-8888-8888-8888-888888888888';
  const requested: string[] = [];

  const evidence = await extractWithFetch(
    evidenceBody(revision, [
      '<!-- evidence-row:after-screenshots -->',
      `- [x] [wrong MIME](${wrongMime})`,
      '<!-- evidence-row:frontend-logs -->',
      `- [x] [oversized](${oversized})`,
      '<!-- evidence-row:walkthrough-video -->',
      '- [x] N/A - no user flow',
      `- [third-party claim](${wrongMime})`,
      '- [release](https://github.com/owner/repository/releases/download/tag/video.mp4)',
    ]),
    async url => {
      requested.push(url);
      return url === wrongMime
        ? binaryResponse('plain text', 'text/plain')
        : binaryResponse('small body', 'text/plain', {
            headers: {'Content-Length': String(4 * 1024 * 1024 + 1)},
          });
    },
  );
  expect(evidence).toEqual([]);
  expect(requested).toEqual([wrongMime, oversized]);

  for (const invalidBody of [
    '<!-- evidence-row:after-screenshots -->\n![x](' + wrongMime + ')',
    evidenceBody('b'.repeat(40), [
      '<!-- evidence-row:after-screenshots -->',
      `![x](${wrongMime})`,
    ]),
    evidenceBody(revision, [
      `<!-- evidence-head:${revision} -->`,
      '<!-- evidence-row:after-screenshots -->',
      `![x](${wrongMime})`,
    ]),
  ]) {
    expect(
      await extractWithFetch(invalidBody, async () => {
        throw new Error('Invalid evidence package reached transport.');
      }),
    ).toEqual([]);
  }
});

test('follows only bounded GitHub attachment redirects', async () => {
  const acceptedAttachment =
    'https://github.com/user-attachments/assets/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const rejectedAttachment =
    'https://github.com/user-attachments/assets/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const objectUrl =
    'https://github-production-user-asset-6210df.s3.amazonaws.com/123/file.jpg?' +
    'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=fixed';
  const requested: string[] = [];

  const evidence = await extractWithFetch(
    evidenceBody(pullRequest.headSha, [
      '<!-- evidence-row:after-screenshots -->',
      `![accepted](${acceptedAttachment}) ![rejected](${rejectedAttachment})`,
    ]),
    async (url, init) => {
      requested.push(url);
      expect(new Headers(init.headers).has('authorization')).toBe(false);
      if (url === acceptedAttachment) {
        return new Response(null, {
          status: 302,
          headers: {Location: objectUrl},
        });
      }
      if (url === objectUrl)
        return binaryResponse('RIFF0000WEBPimage', 'image/webp');
      return new Response(null, {
        status: 302,
        headers: {Location: 'https://example.com/stolen'},
      });
    },
  );

  expect(evidence).toEqual([
    {kind: 'screenshot', sha256: sha256('RIFF0000WEBPimage')},
  ]);
  expect(requested).toEqual([
    acceptedAttachment,
    objectUrl,
    rejectedAttachment,
  ]);
});
