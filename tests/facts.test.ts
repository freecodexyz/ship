import {describe, expect, test} from 'bun:test';

import {deriveFacts} from '../src/facts.js';
import {parseCanonicalTimestamp} from '../src/time.js';
import {
  parseRepoId,
  type Actor,
  type Evidence,
  type Fact,
  type Issue,
  type Project,
  type PullRequest,
  type Review,
} from '../src/types.js';

const REPOSITORY = parseRepoId('OpenAI/Ship');
const AUTHOR: Actor = {id: 'U_author', login: 'author'};
const REVIEWER: Actor = {id: 'U_reviewer', login: 'reviewer'};
const PROJECT: Project = {
  id: 'ship',
  name: 'Ship',
  mission: 'Deliver bounded, reviewable improvements to Ship.',
  repositories: [{id: REPOSITORY, branch: 'main'}],
  allowedModels: [],
};

function timestamp(value: string) {
  return parseCanonicalTimestamp(value);
}

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 'PR_node_1',
    repo: REPOSITORY,
    number: 17,
    title: 'Implement deterministic facts',
    author: AUTHOR,
    mergedAt: timestamp('2026-08-15T12:00:00.000Z'),
    headSha: 'a'.repeat(40),
    files: [],
    closedIssueIds: [],
    reviews: [],
    evidence: [],
    ...overrides,
  };
}

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'ISSUE_node_1',
    repo: REPOSITORY,
    number: 23,
    title: 'Facts are not deterministic',
    author: AUTHOR,
    closedAt: timestamp('2026-08-15T12:00:00.000Z'),
    stateReason: 'COMPLETED',
    labels: [],
    ...overrides,
  };
}

function review(overrides: Partial<Review> = {}): Review {
  return {
    id: 'REVIEW_node_1',
    author: REVIEWER,
    state: 'APPROVED',
    submittedAt: timestamp('2026-08-15T11:59:59.999Z'),
    bodyLength: 50,
    inlineComments: 0,
    ...overrides,
  };
}

function derive(
  pullRequests: readonly PullRequest[],
  issues: readonly Issue[] = [],
): Fact[] {
  return deriveFacts([PROJECT], pullRequests, issues);
}

function factsOfKind<K extends Fact['kind']>(
  facts: readonly Fact[],
  kind: K,
): Extract<Fact, {readonly kind: K}>[] {
  return facts.filter(
    (fact): fact is Extract<Fact, {readonly kind: K}> => fact.kind === kind,
  );
}

describe('deriveFacts merged pull requests', () => {
  test('turns an owned merged pull request into one attributed fact', () => {
    const facts = derive([pullRequest()]);

    expect(facts).toEqual([
      {
        id: 'merged_pr:PR_node_1',
        project: PROJECT.id,
        repo: REPOSITORY,
        cycle: '2026-08',
        actor: AUTHOR,
        occurredAt: timestamp('2026-08-15T12:00:00.000Z'),
        source: {
          kind: 'pr',
          number: 17,
          title: 'Implement deterministic facts',
        },
        kind: 'merged_pr',
      },
    ]);
  });
});

describe('deriveFacts material test changes', () => {
  test.each([
    [
      'the additions threshold',
      [{path: 'src/parser.test.ts', additions: 20, deletions: 0}],
      true,
    ],
    [
      'the aggregate churn threshold',
      [
        {path: 'tests/parser.ts', additions: 10, deletions: 15},
        {path: 'src/formatter.spec.ts', additions: 9, deletions: 16},
      ],
      true,
    ],
    [
      'neither threshold',
      [{path: '__tests__/parser.ts', additions: 9, deletions: 10}],
      false,
    ],
    [
      'thresholds reached only by non-test files',
      [{path: 'src/parser.ts', additions: 100, deletions: 100}],
      false,
    ],
  ] as const)(
    'emits a test-change fact when files meet %s',
    (_, files, expected) => {
      const facts = derive([pullRequest({files})]);

      expect(factsOfKind(facts, 'test_change')).toHaveLength(expected ? 1 : 0);
      expect(factsOfKind(facts, 'merged_pr')).toHaveLength(1);
    },
  );
});

describe('deriveFacts resolved issues', () => {
  test('emits a resolved-issue fact for an issue closed by the merged PR', () => {
    const facts = derive(
      [pullRequest({closedIssueIds: ['ISSUE_node_1']})],
      [issue()],
    );

    expect(factsOfKind(facts, 'resolved_issue')).toEqual([
      {
        id: 'resolved_issue:ISSUE_node_1',
        project: PROJECT.id,
        repo: REPOSITORY,
        cycle: '2026-08',
        actor: AUTHOR,
        occurredAt: timestamp('2026-08-15T12:00:00.000Z'),
        source: {
          kind: 'issue',
          number: 23,
          title: 'Facts are not deterministic',
        },
        kind: 'resolved_issue',
      },
    ]);
  });

  test('does not infer resolution without a closing PR reference', () => {
    const facts = derive(
      [pullRequest()],
      [issue({labels: ['resolved', 'fixed']})],
    );

    expect(factsOfKind(facts, 'resolved_issue')).toEqual([]);
  });

  test('excludes NOT_PLANNED issues even when the PR has a closing reference', () => {
    const facts = derive(
      [pullRequest({closedIssueIds: ['ISSUE_node_1']})],
      [issue({stateReason: 'NOT_PLANNED'})],
    );

    expect(factsOfKind(facts, 'resolved_issue')).toEqual([]);
  });
});

describe('deriveFacts substantive reviews', () => {
  test.each([
    ['an approved 50-character body', review()],
    [
      'a changes-requested inline comment',
      review({
        id: 'REVIEW_node_inline',
        state: 'CHANGES_REQUESTED',
        bodyLength: 0,
        inlineComments: 1,
      }),
    ],
  ] as const)('emits a review fact for %s', (_, submittedReview) => {
    const facts = derive([pullRequest({reviews: [submittedReview]})]);
    const reviewFacts = factsOfKind(facts, 'review');

    expect(reviewFacts).toHaveLength(1);
    expect(reviewFacts[0]?.actor).toBe(REVIEWER);
    expect(reviewFacts[0]?.source).toEqual({
      kind: 'review',
      number: 17,
      title: 'Implement deterministic facts',
    });
  });

  test('excludes a trivial review', () => {
    const facts = derive([
      pullRequest({
        reviews: [review({bodyLength: 49, inlineComments: 0})],
      }),
    ]);

    expect(factsOfKind(facts, 'review')).toEqual([]);
  });

  test('excludes self-review by stable actor id even after a login change', () => {
    const facts = derive([
      pullRequest({
        reviews: [
          review({author: {id: AUTHOR.id, login: 'author-after-rename'}}),
        ],
      }),
    ]);

    expect(factsOfKind(facts, 'review')).toEqual([]);
  });

  test.each([
    ['at merge', '2026-08-15T12:00:00.000Z'],
    ['after merge', '2026-08-15T12:00:00.001Z'],
  ] as const)('excludes a review submitted %s', (_, submittedAt) => {
    const facts = derive([
      pullRequest({
        reviews: [review({submittedAt: timestamp(submittedAt)})],
      }),
    ]);

    expect(factsOfKind(facts, 'review')).toEqual([]);
  });
});

describe('deriveFacts evidence', () => {
  test('emits one fact for each evidence category', () => {
    const evidence: readonly Evidence[] = [
      {kind: 'screenshot', sha256: 'a'.repeat(64)},
      {kind: 'video', sha256: 'b'.repeat(64)},
      {kind: 'logs', sha256: 'c'.repeat(64)},
      {kind: 'trajectory', sha256: 'd'.repeat(64)},
      {kind: 'artifact', sha256: 'e'.repeat(64)},
    ];

    const facts = derive([pullRequest({evidence})]);

    expect(
      factsOfKind(facts, 'evidence').map(fact => fact.evidenceKind),
    ).toEqual(['artifact', 'logs', 'screenshot', 'trajectory', 'video']);
  });

  test('emits at most one deterministic artifact per evidence category', () => {
    const lowerDigest = 'e'.repeat(64);
    const higherDigest = 'f'.repeat(64);
    const facts = derive([
      pullRequest({
        evidence: [
          {kind: 'logs', sha256: higherDigest},
          {kind: 'logs', sha256: lowerDigest},
          {kind: 'video', sha256: higherDigest},
        ],
      }),
    ]);

    expect(
      factsOfKind(facts, 'evidence').map(fact => [fact.evidenceKind, fact.id]),
    ).toEqual([
      ['logs', `evidence:PR_node_1:logs:${lowerDigest}`],
      ['video', `evidence:PR_node_1:video:${higherDigest}`],
    ]);
  });
});

describe('deriveFacts actor qualification', () => {
  test('excludes every PR-derived fact for a normalized missing or bot author', () => {
    const facts = derive(
      [
        pullRequest({
          author: null,
          files: [{path: 'tests/facts.ts', additions: 20, deletions: 0}],
          closedIssueIds: ['ISSUE_node_1'],
          reviews: [review()],
          evidence: [{kind: 'logs', sha256: 'a'.repeat(64)}],
        }),
      ],
      [issue()],
    );

    expect(facts).toEqual([]);
  });

  test('excludes a normalized missing or bot reviewer', () => {
    const facts = derive([pullRequest({reviews: [review({author: null})]})]);

    expect(factsOfKind(facts, 'review')).toEqual([]);
    expect(factsOfKind(facts, 'merged_pr')).toHaveLength(1);
  });
});

describe('deriveFacts UTC cycle assignment', () => {
  test('partitions facts on the exact UTC month boundary', () => {
    const beforeBoundary = timestamp('2026-07-31T23:59:59.999Z');
    const atBoundary = timestamp('2026-08-01T00:00:00.000Z');
    const facts = derive([
      pullRequest({id: 'PR_july', number: 30, mergedAt: beforeBoundary}),
      pullRequest({id: 'PR_august', number: 31, mergedAt: atBoundary}),
    ]);

    expect(
      factsOfKind(facts, 'merged_pr').map(fact => [
        fact.id,
        fact.occurredAt,
        fact.cycle,
      ]),
    ).toEqual([
      ['merged_pr:PR_july', beforeBoundary, '2026-07'],
      ['merged_pr:PR_august', atBoundary, '2026-08'],
    ]);
  });

  test('uses each fact occurrence time rather than the PR merge month', () => {
    const facts = derive([
      pullRequest({
        mergedAt: timestamp('2026-08-01T00:00:00.000Z'),
        reviews: [
          review({
            submittedAt: timestamp('2026-07-31T23:59:59.999Z'),
          }),
        ],
      }),
    ]);

    expect(facts.map(fact => [fact.kind, fact.cycle])).toEqual([
      ['review', '2026-07'],
      ['merged_pr', '2026-08'],
    ]);
  });
});
