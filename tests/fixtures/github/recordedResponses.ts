const headSha = '7777777777777777777777777777777777777777';
const mergedAt = '2026-07-10T12:00:00.000Z';
const screenshotUrl =
  'https://github.com/user-attachments/assets/11111111-1111-1111-1111-111111111111';
const logsUrl =
  'https://github.com/user-attachments/assets/22222222-2222-2222-2222-222222222222';

const searchCandidate = {
  id: 'PR_contract',
  number: 7,
  title: 'Normalize transport records',
  author: {id: 'USER_contributor', login: 'contributor'},
  mergedAt,
  baseRefName: 'main',
  headRefOid: headSha,
};

/** Synthetic GitHub responses shaped like captured GraphQL API payloads. */
export const recordedResponses = {
  headSha,
  mergedAt,
  evidenceUrls: {screenshot: screenshotUrl, logs: logsUrl},
  search: {
    first: {
      data: {
        search: {
          issueCount: 2,
          nodes: [searchCandidate],
          pageInfo: {hasNextPage: true, endCursor: 'search-page-2'},
        },
      },
    },
    second: {
      data: {
        search: {
          issueCount: 2,
          nodes: [searchCandidate],
          pageInfo: {hasNextPage: false, endCursor: null},
        },
      },
    },
  },
  files: {
    first: {
      data: {
        repository: {
          pullRequest: {
            files: {
              nodes: [{path: 'src/github.ts', additions: 21, deletions: 4}],
              pageInfo: {hasNextPage: true, endCursor: 'files-page-2'},
            },
          },
        },
      },
    },
    second: {
      data: {
        repository: {
          pullRequest: {
            files: {
              nodes: [{path: 'src/types.ts', additions: 3, deletions: 1}],
              pageInfo: {hasNextPage: false, endCursor: null},
            },
          },
        },
      },
    },
  },
  reviews: {
    first: {
      data: {
        repository: {
          pullRequest: {
            reviews: {
              nodes: [
                {
                  id: 'REVIEW_approved',
                  author: {id: 'USER_reviewer', login: 'reviewer'},
                  state: 'APPROVED',
                  submittedAt: '2026-07-10T11:00:00.000Z',
                  body: '  Thorough review.  ',
                  comments: {totalCount: 2},
                },
              ],
              pageInfo: {hasNextPage: true, endCursor: 'reviews-page-2'},
            },
          },
        },
      },
    },
    second: {
      data: {
        repository: {
          pullRequest: {
            reviews: {
              nodes: [
                {
                  id: 'REVIEW_deleted-author',
                  author: null,
                  state: 'COMMENTED',
                  submittedAt: '2026-07-10T11:30:00.000Z',
                  body: null,
                  comments: {totalCount: 1},
                },
                {state: 'PENDING'},
              ],
              pageInfo: {hasNextPage: false, endCursor: null},
            },
          },
        },
      },
    },
  },
  closingIssues: {
    data: {
      repository: {
        pullRequest: {
          closingIssuesReferences: {
            nodes: [{id: 'ISSUE_2'}, {id: 'ISSUE_1'}, {id: 'ISSUE_1'}],
            pageInfo: {hasNextPage: false, endCursor: null},
          },
        },
      },
    },
  },
  evidenceMaterial: {
    data: {
      repository: {
        pullRequest: {
          id: 'PR_contract',
          headRefOid: headSha,
          author: {id: 'USER_contributor'},
          body: [
            `<!-- evidence-head:${headSha} -->`,
            '<!-- evidence-row:after-screenshots -->',
            `![after](${screenshotUrl})`,
            '<!-- evidence-row:frontend-logs -->',
            `[logs](${logsUrl})`,
          ].join('\n'),
          lastEditedAt: null,
          userContentEdits: {totalCount: 0, nodes: []},
        },
      },
    },
  },
  issues: {
    issue1First: {
      data: {
        node: {
          __typename: 'Issue',
          id: 'ISSUE_1',
          number: 11,
          title: 'Fix transport normalization',
          author: {
            __typename: 'User',
            id: 'USER_contributor',
            login: 'contributor',
          },
          closedAt: '2026-07-09T18:00:00.000Z',
          stateReason: 'COMPLETED',
          repository: {nameWithOwner: 'OWNER/REPOSITORY'},
          labels: {
            nodes: [{name: 'priority'}, {name: 'priority'}],
            pageInfo: {hasNextPage: true, endCursor: 'labels-page-2'},
          },
        },
      },
    },
    issue1Second: {
      data: {
        node: {
          __typename: 'Issue',
          id: 'ISSUE_1',
          number: 11,
          title: 'Fix transport normalization',
          author: {
            __typename: 'User',
            id: 'USER_contributor',
            login: 'contributor',
          },
          closedAt: '2026-07-09T18:00:00.000Z',
          stateReason: 'COMPLETED',
          repository: {nameWithOwner: 'owner/repository'},
          labels: {
            nodes: [{name: 'bug'}],
            pageInfo: {hasNextPage: false, endCursor: null},
          },
        },
      },
    },
    issue2: {
      data: {
        node: {
          __typename: 'Issue',
          id: 'ISSUE_2',
          number: 12,
          title: 'Deferred cleanup',
          author: {
            __typename: 'User',
            id: 'USER_contributor',
            login: 'contributor',
          },
          closedAt: '2026-07-09T19:00:00.000Z',
          stateReason: 'NOT_PLANNED',
          repository: {nameWithOwner: 'owner/repository'},
          labels: {
            nodes: [],
            pageInfo: {hasNextPage: false, endCursor: null},
          },
        },
      },
    },
  },
} as const;
