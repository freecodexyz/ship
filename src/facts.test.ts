import {describe, expect, test} from 'bun:test';

import {
  deriveFacts,
  evidenceFacts,
  isMaterialTestChange,
  isSubstantiveReview,
  qualifiesResolvedIssue,
} from './facts.js';
import {parseCanonicalTimestamp} from './time.js';
import type {
  Actor,
  Issue,
  Project,
  PullRequest,
  RepoId,
  Review,
} from './types.js';

const repo = 'Owner/Repo' as RepoId;
const author: Actor = {id: 'actor-author', login: 'author'};
const reviewer: Actor = {id: 'actor-reviewer', login: 'reviewer'};
const project: Project = {
  id: 'ship',
  name: 'Ship',
  mission: 'Deliver bounded, reviewable improvements to Ship.',
  repositories: [{id: repo, branch: 'main'}],
  allowedModels: [],
};

function review(overrides: Partial<Review> = {}): Review {
  return {
    id: 'review-1',
    author: reviewer,
    state: 'APPROVED',
    submittedAt: parseCanonicalTimestamp('2026-07-31T23:59:59.999Z'),
    bodyLength: 50,
    inlineComments: 0,
    ...overrides,
  };
}

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 'pr-1',
    repo: 'owner/repo' as RepoId,
    number: 1,
    title: 'Accepted contribution',
    author,
    mergedAt: parseCanonicalTimestamp('2026-08-01T00:00:00.000Z'),
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
    id: 'issue-1',
    repo,
    number: 10,
    title: 'Resolved problem',
    author,
    closedAt: parseCanonicalTimestamp('2026-08-01T00:00:00.001Z'),
    stateReason: 'COMPLETED',
    labels: [],
    ...overrides,
  };
}

describe('isMaterialTestChange', () => {
  test('qualifies additions-only changes at the exact threshold', () => {
    expect(
      isMaterialTestChange(
        pullRequest({
          files: [{path: 'src/value.test.ts', additions: 20, deletions: 0}],
        }),
      ),
    ).toBe(true);
  });

  test('qualifies aggregate test churn at the exact threshold', () => {
    expect(
      isMaterialTestChange(
        pullRequest({
          files: [
            {path: 'tests/value.ts', additions: 10, deletions: 15},
            {path: 'src/value.spec.ts', additions: 9, deletions: 16},
          ],
        }),
      ),
    ).toBe(true);
  });

  test('recognizes hyphenated test scripts', () => {
    expect(
      isMaterialTestChange(
        pullRequest({
          files: [
            {path: 'deploy/smoke-test.sh', additions: 20, deletions: 0},
            {path: 'deploy/test-install.sh', additions: 20, deletions: 0},
          ],
        }),
      ),
    ).toBe(true);
  });

  test('rejects test changes immediately below both thresholds', () => {
    expect(
      isMaterialTestChange(
        pullRequest({
          files: [{path: '__tests__/value.ts', additions: 9, deletions: 10}],
        }),
      ),
    ).toBe(false);
  });

  test('ignores non-test files when calculating additions and churn', () => {
    expect(
      isMaterialTestChange(
        pullRequest({
          files: [
            {path: 'src/value.ts', additions: 100, deletions: 100},
            {path: 'docs/testing.md', additions: 100, deletions: 100},
          ],
        }),
      ),
    ).toBe(false);
  });
});

describe('isSubstantiveReview', () => {
  test('accepts meaningful reviews submitted before merge', () => {
    expect(isSubstantiveReview(review(), pullRequest())).toBe(true);
    expect(
      isSubstantiveReview(
        review({
          state: 'CHANGES_REQUESTED',
          bodyLength: 0,
          inlineComments: 1,
        }),
        pullRequest(),
      ),
    ).toBe(true);
  });

  test('requires known human reviewer and pull-request author actors', () => {
    expect(isSubstantiveReview(review({author: null}), pullRequest())).toBe(
      false,
    );
    expect(isSubstantiveReview(review(), pullRequest({author: null}))).toBe(
      false,
    );
  });

  test('rejects self-review by stable actor id even when logins differ', () => {
    expect(
      isSubstantiveReview(
        review({author: {id: author.id, login: 'renamed-author'}}),
        pullRequest(),
      ),
    ).toBe(false);
  });

  test('requires submission strictly before merge', () => {
    expect(
      isSubstantiveReview(
        review({
          submittedAt: parseCanonicalTimestamp('2026-08-01T00:00:00.000Z'),
        }),
        pullRequest(),
      ),
    ).toBe(false);
    expect(
      isSubstantiveReview(
        review({
          submittedAt: parseCanonicalTimestamp('2026-08-01T00:00:00.001Z'),
        }),
        pullRequest(),
      ),
    ).toBe(false);
  });

  test('accepts only approved and changes-requested review states', () => {
    expect(
      isSubstantiveReview(review({state: 'COMMENTED'}), pullRequest()),
    ).toBe(false);
    expect(
      isSubstantiveReview(review({state: 'DISMISSED'}), pullRequest()),
    ).toBe(false);
  });

  test('requires the exact body threshold or an inline comment', () => {
    expect(
      isSubstantiveReview(
        review({bodyLength: 49, inlineComments: 0}),
        pullRequest(),
      ),
    ).toBe(false);
    expect(
      isSubstantiveReview(
        review({bodyLength: 50, inlineComments: 0}),
        pullRequest(),
      ),
    ).toBe(true);
    expect(
      isSubstantiveReview(
        review({bodyLength: 0, inlineComments: 1}),
        pullRequest(),
      ),
    ).toBe(true);
  });
});

describe('qualifiesResolvedIssue', () => {
  test('accepts a merged pull request closing a completed issue', () => {
    expect(
      qualifiesResolvedIssue(
        issue(),
        pullRequest({closedIssueIds: ['issue-1']}),
      ),
    ).toBe(true);
  });

  test('accepts a closing reference when GitHub provides no state reason', () => {
    expect(
      qualifiesResolvedIssue(
        issue({stateReason: null}),
        pullRequest({closedIssueIds: ['issue-1']}),
      ),
    ).toBe(true);
  });

  test('rejects NOT_PLANNED even when the merged pull request closes it', () => {
    expect(
      qualifiesResolvedIssue(
        issue({stateReason: 'NOT_PLANNED'}),
        pullRequest({closedIssueIds: ['issue-1']}),
      ),
    ).toBe(false);
  });

  test('requires a closing reference and does not treat labels as fallback', () => {
    expect(
      qualifiesResolvedIssue(
        issue({labels: ['resolved', 'fixed']}),
        pullRequest({closedIssueIds: []}),
      ),
    ).toBe(false);
  });

  test('credits the closing pull request author independently of the reporter', () => {
    expect(
      qualifiesResolvedIssue(
        issue({author: reviewer}),
        pullRequest({closedIssueIds: ['issue-1']}),
      ),
    ).toBe(true);
    expect(
      qualifiesResolvedIssue(
        issue({author: null}),
        pullRequest({closedIssueIds: ['issue-1']}),
      ),
    ).toBe(true);
  });
});

describe('evidenceFacts', () => {
  test('preserves every evidence category and attributes facts to the PR author', () => {
    const mergedAt = parseCanonicalTimestamp('2026-08-01T00:00:00.000Z');
    const facts = evidenceFacts(
      pullRequest({
        mergedAt,
        evidence: [
          {kind: 'video', sha256: 'e'.repeat(64)},
          {kind: 'screenshot', sha256: 'a'.repeat(64)},
          {kind: 'logs', sha256: 'b'.repeat(64)},
          {kind: 'trajectory', sha256: 'd'.repeat(64)},
          {kind: 'artifact', sha256: 'c'.repeat(64)},
        ],
      }),
      project,
    );

    expect(facts.map(fact => fact.evidenceKind)).toEqual([
      'artifact',
      'logs',
      'screenshot',
      'trajectory',
      'video',
    ]);
    expect(facts.every(fact => fact.actor === author)).toBe(true);
    expect(facts.every(fact => fact.occurredAt === mergedAt)).toBe(true);
    expect(facts.every(fact => fact.cycle === '2026-08')).toBe(true);
  });

  test('keeps one deterministic artifact per evidence category', () => {
    const lowerDigest = 'a'.repeat(64);
    const higherDigest = 'b'.repeat(64);
    const facts = evidenceFacts(
      pullRequest({
        evidence: [
          {kind: 'logs', sha256: higherDigest},
          {kind: 'video', sha256: lowerDigest},
          {kind: 'logs', sha256: lowerDigest},
        ],
      }),
      project,
    );

    expect(facts.map(fact => [fact.evidenceKind, fact.id])).toEqual([
      ['logs', `evidence:pr-1:logs:${lowerDigest}`],
      ['video', `evidence:pr-1:video:${lowerDigest}`],
    ]);
  });

  test('does not create evidence facts without a known PR author', () => {
    expect(
      evidenceFacts(
        pullRequest({
          author: null,
          evidence: [{kind: 'screenshot', sha256: 'a'.repeat(64)}],
        }),
        project,
      ),
    ).toEqual([]);
  });
});

describe('deriveFacts', () => {
  test('qualifies each GitHub scoring concept without applying caps', () => {
    const pullRequests = Array.from({length: 6}, (_, index) =>
      pullRequest({
        id: `pr-${index}`,
        number: index + 1,
        files: [{path: 'src/value.test.ts', additions: 20, deletions: 0}],
        closedIssueIds: index === 0 ? ['issue-1'] : [],
        reviews: index === 0 ? [review()] : [],
        evidence:
          index === 0
            ? [
                {kind: 'screenshot', sha256: 'a'.repeat(64)},
                {kind: 'screenshot', sha256: 'a'.repeat(64)},
                {kind: 'logs', sha256: 'b'.repeat(64)},
              ]
            : [],
      }),
    );

    const facts = deriveFacts([project], pullRequests, [issue()]);

    expect(facts.filter(fact => fact.kind === 'merged_pr')).toHaveLength(6);
    expect(facts.filter(fact => fact.kind === 'test_change')).toHaveLength(6);
    expect(facts.filter(fact => fact.kind === 'resolved_issue')).toHaveLength(
      1,
    );
    expect(facts.filter(fact => fact.kind === 'review')).toHaveLength(1);
    expect(facts.filter(fact => fact.kind === 'evidence')).toHaveLength(2);
  });

  test('keeps only the first qualifying review from each reviewer on a PR', () => {
    const later = review({
      id: 'review-later',
      submittedAt: parseCanonicalTimestamp('2026-07-31T23:59:59.999Z'),
    });
    const earlier = review({
      id: 'review-earlier',
      submittedAt: parseCanonicalTimestamp('2026-07-31T23:59:59.998Z'),
    });

    const facts = deriveFacts(
      [project],
      [pullRequest({reviews: [later, earlier]})],
      [],
    );

    expect(
      facts.filter(fact => fact.kind === 'review').map(fact => fact.id),
    ).toEqual(['review:review-earlier']);
  });

  test('excludes unknown actors and non-qualifying outcomes', () => {
    const facts = deriveFacts(
      [project],
      [
        pullRequest({author: null}),
        pullRequest({
          id: 'pr-2',
          reviews: [
            review({id: 'self', author}),
            review({
              id: 'late',
              submittedAt: parseCanonicalTimestamp('2026-08-01T00:00:00.001Z'),
            }),
            review({id: 'trivial', bodyLength: 1}),
          ],
          closedIssueIds: ['issue-1'],
        }),
      ],
      [issue({stateReason: 'NOT_PLANNED'})],
    );

    expect(facts.map(fact => fact.kind)).toEqual(['merged_pr']);
  });

  test('credits a resolved issue to the closing pull-request author', () => {
    const facts = deriveFacts(
      [project],
      [pullRequest({closedIssueIds: ['issue-1']})],
      [issue()],
    );

    const resolvedIssue = facts.find(fact => fact.kind === 'resolved_issue');
    expect(resolvedIssue?.actor).toEqual(author);
  });

  test('credits a multiply referenced issue once to the latest closing PR', () => {
    const laterAuthor: Actor = {id: 'actor-later', login: 'later'};
    const closedIssue = issue({
      author: laterAuthor,
      closedAt: parseCanonicalTimestamp('2026-08-01T00:00:00.003Z'),
    });
    const earlier = pullRequest({
      id: 'pr-earlier',
      mergedAt: parseCanonicalTimestamp('2026-08-01T00:00:00.001Z'),
      closedIssueIds: [closedIssue.id],
    });
    const later = pullRequest({
      id: 'pr-later',
      author: laterAuthor,
      mergedAt: parseCanonicalTimestamp('2026-08-01T00:00:00.002Z'),
      closedIssueIds: [closedIssue.id],
    });

    const facts = deriveFacts([project], [later, earlier], [closedIssue]);
    const resolvedIssues = facts.filter(fact => fact.kind === 'resolved_issue');

    expect(resolvedIssues).toHaveLength(1);
    expect(resolvedIssues[0]?.actor).toEqual(laterAuthor);
  });

  test('assigns UTC cycles and sorts by timestamp then deterministic id', () => {
    const facts = deriveFacts(
      [project],
      [pullRequest({reviews: [review()]})],
      [],
      [
        {
          id: 'evaluation-1',
          repo,
          actor: author,
          occurredAt: parseCanonicalTimestamp('2026-08-01T00:00:00.000Z'),
          source: {kind: 'pr', number: 1, title: 'Accepted contribution'},
          evaluationPoints: 20,
        },
      ],
    );

    expect(facts.map(fact => [fact.id, fact.cycle])).toEqual([
      ['review:review-1', '2026-07'],
      ['evaluation:evaluation-1', '2026-08'],
      ['merged_pr:pr-1', '2026-08'],
    ]);
  });
});
