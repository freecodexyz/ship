import {createHash} from 'node:crypto';

import type {
  Actor,
  CollectionWindow,
  Evidence,
  Issue,
  ProjectRepository,
  PullRequest,
  PullRequestFile,
  Review,
} from './types.js';
import {
  cycleId,
  parseCanonicalTimestamp,
  type CanonicalTimestamp,
} from './time.js';

const GITHUB_API_ORIGIN = 'https://api.github.com';
const GITHUB_GRAPHQL_URL = `${GITHUB_API_ORIGIN}/graphql`;
const API_VERSION = '2022-11-28';
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_MAX_RECORDS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const BASE_RETRY_DELAY_MS = 250;
const MAX_URL_LENGTH = 8_192;
const GITHUB_SEARCH_RESULT_LIMIT = 1_000;
const MAX_SEARCH_INTERVALS = 4_096;
const MAX_SEARCH_COLLECTION_ATTEMPTS = 3;
const DETAIL_BATCH_SIZE = 25;
const DETAIL_BATCH_CONCURRENCY = 2;
const NETWORK_CONCURRENCY = 6;
const DETAILED_PULL_REQUESTS_PER_ACTOR_CYCLE = 5;
const MAX_EVIDENCE_REFERENCES = 32;
const MAX_PULL_REQUEST_BODY_EDITS = 100;
const MAX_EVIDENCE_URL_LENGTH = 2_048;
const MAX_EVIDENCE_REDIRECTS = 3;
const RETRYABLE_ERROR = Symbol('retryableGitHubError');
const GITHUB_TIMESTAMP_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/u;

const EVIDENCE_LIMITS = {
  screenshot: 8 * 1024 * 1024,
  video: 64 * 1024 * 1024,
  logs: 4 * 1024 * 1024,
  trajectory: 16 * 1024 * 1024,
  artifact: 32 * 1024 * 1024,
} as const satisfies Readonly<Record<Evidence['kind'], number>>;

const EVIDENCE_MIME_TYPES = {
  screenshot: new Set([
    'image/avif',
    'image/gif',
    'image/jpeg',
    'image/png',
    'image/webp',
  ]),
  video: new Set(['video/mp4', 'video/quicktime', 'video/webm']),
  logs: new Set(['application/json', 'application/x-ndjson', 'text/plain']),
  trajectory: new Set(['application/json', 'application/x-ndjson']),
  artifact: new Set([
    'application/gzip',
    'application/json',
    'application/octet-stream',
    'application/x-ndjson',
    'application/x-tar',
    'application/zip',
    'image/avif',
    'image/gif',
    'image/jpeg',
    'image/png',
    'image/webp',
    'text/plain',
  ]),
} as const satisfies Readonly<Record<Evidence['kind'], ReadonlySet<string>>>;

const SEARCH_MERGED_PULL_REQUESTS_QUERY = `
  query SearchMergedPullRequests($query: String!, $after: String) {
    search(query: $query, type: ISSUE, first: 100, after: $after) {
      issueCount
      nodes {
        ... on PullRequest {
          id
          number
          title
          author { __typename login ... on Node { id } }
          mergedAt
          baseRefName
          headRefOid
        }
      }
      pageInfo { hasNextPage endCursor }
    }
    rateLimit { remaining resetAt }
  }
`;

const PULL_REQUEST_FILES_QUERY = `
  query PullRequestFiles(
    $owner: String!, $name: String!, $number: Int!, $after: String
  ) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        files(first: 100, after: $after) {
          nodes { path additions deletions }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
    rateLimit { remaining resetAt }
  }
`;

const PULL_REQUEST_REVIEWS_QUERY = `
  query PullRequestReviews(
    $owner: String!, $name: String!, $number: Int!, $after: String
  ) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviews(first: 100, after: $after) {
          nodes {
            id
            author { __typename login ... on Node { id } }
            state
            submittedAt
            body
            comments { totalCount }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
    rateLimit { remaining resetAt }
  }
`;

const PULL_REQUEST_CLOSING_ISSUES_QUERY = `
  query PullRequestClosingIssues(
    $owner: String!, $name: String!, $number: Int!, $after: String
  ) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        closingIssuesReferences(first: 100, after: $after) {
          nodes { id }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
    rateLimit { remaining resetAt }
  }
`;

const REFERENCED_ISSUE_QUERY = `
  query ReferencedIssue($id: ID!, $after: String) {
    node(id: $id) {
      __typename
      ... on Issue {
        id
        number
        title
        author { __typename login ... on Node { id } }
        closedAt
        stateReason
        repository { nameWithOwner }
        labels(first: 100, after: $after) {
          nodes { name }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
    rateLimit { remaining resetAt }
  }
`;

const PULL_REQUEST_EVIDENCE_MATERIAL_QUERY = `
  query PullRequestEvidenceMaterial(
    $owner: String!, $name: String!, $number: Int!, $after: String
  ) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        id
        headRefOid
        author { ... on Node { id } }
        body
        lastEditedAt
        userContentEdits(last: 100) {
          totalCount
          nodes {
            editedAt
            editor { ... on Node { id } }
          }
        }
      }
    }
    rateLimit { remaining resetAt }
  }
`;

const PULL_REQUEST_DETAILS_QUERY = `
  query PullRequestDetails($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on PullRequest {
        id
        headRefOid
        author { __typename login ... on Node { id } }
        body
        lastEditedAt
        userContentEdits(last: 100) {
          totalCount
          nodes {
            editedAt
            editor { ... on Node { id } }
          }
        }
        files(first: 100) {
          nodes { path additions deletions }
          pageInfo { hasNextPage endCursor }
        }
        reviews(first: 100) {
          nodes {
            id
            author { __typename login ... on Node { id } }
            state
            submittedAt
            body
            comments { totalCount }
          }
          pageInfo { hasNextPage endCursor }
        }
        closingIssuesReferences(first: 100) {
          nodes { id }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
    rateLimit { remaining resetAt }
  }
`;

export type GitHubRecords = {
  readonly pullRequests: readonly PullRequest[];
  readonly issues: readonly Issue[];
};

/** The normalized GitHub data source consumed by generation. */
export type GitHubClient = {
  /**
   * Collects normalized records for one project's configured repositories.
   * Category hydration caps are shared across every repository in this call.
   *
   * @param repositories Validated project repository configurations.
   * @param window Inclusive-start, exclusive-end collection interval.
   * @returns Normalized records with all transport state removed.
   */
  readonly collect: (
    repositories: readonly ProjectRepository[],
    window: CollectionWindow,
  ) => Promise<GitHubRecords>;
};

type FetchTransport = (url: string, init: RequestInit) => Promise<Response>;

type Sleep = (milliseconds: number) => Promise<void>;

type GraphqlPage = {
  readonly query: string;
  readonly variables?: Readonly<Record<string, unknown>>;
  readonly connectionPath: readonly string[];
};

type GraphqlQuery = {
  readonly query: string;
  readonly variables?: Readonly<Record<string, unknown>>;
};

type GitHubTransport = {
  readonly maxPages: number;
  readonly maxRecords: number;
  readonly fetchEvidence: (
    url: string,
    maxBytes: number,
  ) => Promise<EvidenceResource>;
  readonly paginateRest: (path: string) => Promise<readonly unknown[]>;
  readonly paginateGraphql: (
    operation: GraphqlPage,
  ) => Promise<readonly unknown[]>;
  readonly searchGraphql: (
    operation: GraphqlPage,
  ) => Promise<GraphqlSearchResult>;
  readonly queryGraphql: (
    operation: GraphqlQuery,
  ) => Promise<Readonly<Record<string, unknown>>>;
};

type GraphqlSearchResult = {
  readonly totalCount: number;
  readonly nodes: readonly unknown[];
};

type RepositoryCollector = (
  transport: GitHubTransport,
  repository: ProjectRepository,
  window: CollectionWindow,
) => Promise<GitHubRecords>;

type GitHubClientOptions = {
  readonly token: string;
  readonly log?: (message: string) => void;
  readonly collectRepository?: RepositoryCollector;
  readonly fetch?: FetchTransport;
  readonly sleep?: Sleep;
  readonly now?: () => number;
  readonly maxPages?: number;
  readonly maxRecords?: number;
  readonly maxResponseBytes?: number;
  readonly maxRetries?: number;
  readonly maxRetryDelayMs?: number;
  readonly requestTimeoutMs?: number;
};

type SafetyLimits = {
  readonly maxPages: number;
  readonly maxRecords: number;
  readonly maxResponseBytes: number;
  readonly maxRetries: number;
  readonly maxRetryDelayMs: number;
  readonly requestTimeoutMs: number;
};

type RateLimit = {
  readonly remaining?: number;
  readonly resetAtMs?: number;
};

type ParsedResponse<T> = {
  readonly value: T;
  readonly rateLimit: RateLimit;
  readonly nextLink?: string;
};

type GraphqlConnectionPage = {
  readonly nodes: readonly unknown[];
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
  readonly rateLimit: RateLimit;
};

type GraphqlSearchPage = GraphqlConnectionPage & {
  readonly totalCount: number;
};

type SearchInterval = {
  readonly from: CanonicalTimestamp;
  readonly to: CanonicalTimestamp;
};

type SearchCandidate = {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly author: Actor | null;
  readonly mergedAt: CanonicalTimestamp;
  readonly baseBranch: string;
  readonly headSha: string;
};

type LocatedCandidate = {
  readonly repository: ProjectRepository;
  readonly owner: string;
  readonly name: string;
  readonly candidate: SearchCandidate;
};

type HydrationPlan = {
  readonly files: boolean;
  readonly closingIssues: boolean;
  readonly evidence: boolean;
};

type FirstConnectionPage = {
  readonly nodes: readonly unknown[];
  readonly hasNextPage: boolean;
};

type IntervalCollection = {
  readonly reportedCount: number;
  readonly candidates: readonly SearchCandidate[];
};

type SearchSafetyState = {
  intervals: number;
};

type SearchCollectionResult =
  | {readonly status: 'consistent'; readonly collection: IntervalCollection}
  | {readonly status: 'changed'};

type ReferencedIssuePage =
  | {readonly issue: null}
  | {
      readonly issue: Omit<Issue, 'labels'>;
      readonly labels: readonly string[];
      readonly hasNextPage: boolean;
      readonly endCursor: string | null;
    };

type EvidenceTransport = Pick<GitHubTransport, 'fetchEvidence'>;

type EvidenceReference = {
  readonly kind: Evidence['kind'];
  readonly url: string;
};

type EvidenceResource = {
  readonly contentType: string;
  readonly sha256: string;
  readonly prefix: Uint8Array;
};

type PullRequestEvidenceMaterial = {
  readonly body: string | null;
};

type RetryableError = Error & {
  readonly [RETRYABLE_ERROR]: true;
};

/**
 * Creates a bounded, authenticated GitHub client.
 *
 * By default, collection retains scalar records for every merged pull request,
 * globally selects each actor's newest five per UTC cycle, and batch-hydrates
 * only that deterministic subset. `collectRepository` is an optional low-level
 * seam for focused transport tests that need uncapped repository collection.
 *
 * @param options Authentication, normalized collection operation, and optional
 *     transport dependencies used by focused tests.
 * @returns A client whose only output is normalized GitHub records.
 */
export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  const token = parseToken(options.token);
  const limits = parseLimits(options);
  const fetchTransport = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const transport = createTransport(token, fetchTransport, sleep, now, limits);

  return {
    collect: async (repositories, window) => {
      if (options.collectRepository === undefined) {
        return collectProjectRecords(
          transport,
          repositories,
          window,
          options.log,
        );
      }
      const pullRequests: PullRequest[] = [];
      const issues: Issue[] = [];

      // Sequential collection prevents configured repositories from competing
      // with one another for the same bounded GitHub rate limit.
      for (const repository of repositories) {
        const records = await options.collectRepository(
          transport,
          repository,
          window,
        );
        pullRequests.push(...records.pullRequests);
        issues.push(...records.issues);
      }

      return {pullRequests, issues};
    },
  };
}

async function collectProjectRecords(
  transport: GitHubTransport,
  repositories: readonly ProjectRepository[],
  window: CollectionWindow,
  log: ((message: string) => void) | undefined,
): Promise<GitHubRecords> {
  const locatedCandidates: LocatedCandidate[] = [];
  for (const repository of repositories) {
    log?.(`Searching ${repository.id} for merged pull requests...`);
    const [owner, name] = parseRepositoryParts(repository);
    const candidates = await fetchMergedPullRequestCandidates(
      transport,
      repository,
      window,
    );
    locatedCandidates.push(
      ...candidates.map(candidate => ({repository, owner, name, candidate})),
    );
    log?.(`Found ${candidates.length} merged candidates in ${repository.id}.`);
  }
  const windowCandidates = locatedCandidates.filter(
    ({candidate}) =>
      candidate.mergedAt >= window.from && candidate.mergedAt < window.to,
  );
  locatedCandidates.sort(compareLocatedCandidatesNewest);

  const selectedIds = selectDetailedPullRequestIds(locatedCandidates);
  const detailedCandidates = windowCandidates
    .filter(({candidate}) => selectedIds.has(candidate.id))
    .sort(compareLocatedCandidatesNewest);
  log?.(
    `Hydrating ${detailedCandidates.length} of ${windowCandidates.length} ` +
      'in-window pull requests...',
  );
  const detailedPullRequests = await hydratePullRequestBatches(
    transport,
    detailedCandidates,
    log,
  );
  const detailsById = new Map(
    detailedPullRequests.map(pullRequest => [pullRequest.id, pullRequest]),
  );
  const pullRequests = windowCandidates.map(
    located =>
      detailsById.get(located.candidate.id) ?? shallowPullRequest(located),
  );
  const issues: Issue[] = [];
  for (const repository of repositories) {
    const repositoryPullRequests = detailedPullRequests.filter(
      pullRequest =>
        pullRequest.repo.toLowerCase() === repository.id.toLowerCase(),
    );
    const referencedIssueCount = new Set(
      repositoryPullRequests.flatMap(pullRequest => pullRequest.closedIssueIds),
    ).size;
    if (referencedIssueCount > 0) {
      log?.(
        `Fetching ${referencedIssueCount} referenced issues from ${repository.id}...`,
      );
    }
    const referencedIssues = await fetchReferencedIssues(
      transport,
      repository,
      repositoryPullRequests,
    );
    issues.push(
      ...referencedIssues.filter(
        issue => issue.closedAt >= window.from && issue.closedAt < window.to,
      ),
    );
  }

  pullRequests.sort(comparePullRequests);
  issues.sort((left, right) => compareText(left.id, right.id));
  return {pullRequests, issues};
}

function selectDetailedPullRequestIds(
  candidates: readonly LocatedCandidate[],
): ReadonlySet<string> {
  const usage = new Map<string, number>();
  const selected = new Set<string>();
  for (const {candidate} of candidates) {
    if (candidate.author === null) continue;
    const key = JSON.stringify([
      candidate.author.id,
      cycleId(candidate.mergedAt),
    ]);
    const count = usage.get(key) ?? 0;
    if (count >= DETAILED_PULL_REQUESTS_PER_ACTOR_CYCLE) continue;
    usage.set(key, count + 1);
    selected.add(candidate.id);
  }
  return selected;
}

function shallowPullRequest(located: LocatedCandidate): PullRequest {
  const {candidate, repository} = located;
  return {
    id: candidate.id,
    repo: repository.id,
    number: candidate.number,
    title: candidate.title,
    author: candidate.author,
    mergedAt: candidate.mergedAt,
    headSha: candidate.headSha,
    files: [],
    closedIssueIds: [],
    reviews: [],
    evidence: [],
  };
}

/**
 * Fetches every merged pull request accepted by one repository configuration.
 *
 * Search is used only to identify and qualify candidates. Intervals above
 * GitHub's 1,000-result search ceiling are bisected, and the child counts must
 * exactly reconcile with their parent before any result is accepted. Detailed
 * scoring inputs are hydrated only after branch and half-open-window checks.
 *
 * @param transport The authenticated, bounded GitHub transport seam.
 * @param repository The validated repository and accepted integration branch.
 * @param window The inclusive-start, exclusive-end merge interval.
 * @returns Fully normalized pull requests in deterministic merge order.
 */
export async function fetchMergedPullRequests(
  transport: GitHubTransport,
  repository: ProjectRepository,
  window: CollectionWindow,
): Promise<readonly PullRequest[]> {
  const [owner, name] = parseRepositoryParts(repository);
  const candidates = await fetchMergedPullRequestCandidates(
    transport,
    repository,
    window,
  );

  const pullRequests: PullRequest[] = [];
  for (const candidate of candidates) {
    pullRequests.push(
      await hydratePullRequest(transport, repository, owner, name, candidate, {
        files: true,
        closingIssues: true,
        evidence: true,
      }),
    );
  }
  return pullRequests;
}

async function fetchMergedPullRequestCandidates(
  transport: GitHubTransport,
  repository: ProjectRepository,
  window: CollectionWindow,
): Promise<readonly SearchCandidate[]> {
  const interval = parseCollectionWindow(window);
  let collection: IntervalCollection | undefined;
  for (
    let attempt = 0;
    attempt < MAX_SEARCH_COLLECTION_ATTEMPTS;
    attempt += 1
  ) {
    const result = await collectSearchInterval(
      transport,
      repository,
      interval,
      {intervals: 0},
    );
    if (result.status === 'consistent') {
      collection = result.collection;
      break;
    }
  }
  if (collection === undefined) {
    throw requestFailure(
      'GitHub pull-request search interval counts kept changing during collection.',
    );
  }

  const qualifiedById = new Map<string, SearchCandidate>();
  for (const candidate of collection.candidates) {
    if (
      candidate.baseBranch !== repository.branch ||
      candidate.mergedAt < interval.from ||
      candidate.mergedAt >= interval.to
    ) {
      continue;
    }

    const existing = qualifiedById.get(candidate.id);
    if (existing !== undefined && !sameCandidate(existing, candidate)) {
      throw requestFailure(
        `GitHub search returned conflicting data for pull request ${candidate.id}.`,
      );
    }
    qualifiedById.set(candidate.id, candidate);
  }

  return [...qualifiedById.values()].sort(compareCandidates);
}

async function hydratePullRequestBatches(
  transport: GitHubTransport,
  candidates: readonly LocatedCandidate[],
  log?: (message: string) => void,
): Promise<readonly PullRequest[]> {
  const batches = Array.from(
    {length: Math.ceil(candidates.length / DETAIL_BATCH_SIZE)},
    (_, index) =>
      candidates.slice(
        index * DETAIL_BATCH_SIZE,
        (index + 1) * DETAIL_BATCH_SIZE,
      ),
  );
  const hydrated = await mapConcurrent(
    batches,
    DETAIL_BATCH_CONCURRENCY,
    async (batch, batchIndex) => {
      log?.(
        `Hydrating pull-request batch ${batchIndex + 1}/${batches.length} ` +
          `(${batch.length} pull requests)...`,
      );
      const data = await transport.queryGraphql({
        query: PULL_REQUEST_DETAILS_QUERY,
        variables: {ids: batch.map(({candidate}) => candidate.id)},
      });
      if (!Array.isArray(data.nodes) || data.nodes.length !== batch.length) {
        throw requestFailure(
          'GitHub pull-request details did not match the requested batch.',
        );
      }
      const nodes = data.nodes;
      return mapConcurrent(
        batch,
        NETWORK_CONCURRENCY,
        async (located, nodeIndex) =>
          hydrateBatchedPullRequest(
            transport,
            located,
            nodes[nodeIndex],
            nodeIndex,
          ),
      );
    },
  );
  return hydrated.flat();
}

async function hydrateBatchedPullRequest(
  transport: GitHubTransport,
  located: LocatedCandidate,
  value: unknown,
  index: number,
): Promise<PullRequest> {
  const {candidate, repository, owner, name} = located;
  const context = `GitHub pull-request detail ${index}`;
  const node = parseRecord(value, context);
  if (node.__typename !== 'PullRequest') {
    throw requestFailure(`${context} must be a pull request.`);
  }
  if (
    parseNonemptyApiString(node.id, `${context}.id`) !== candidate.id ||
    parseSha(node.headRefOid, `${context}.headRefOid`) !== candidate.headSha
  ) {
    throw requestFailure(`${context} did not match the requested revision.`);
  }
  const actor = parseActor(node.author, `${context}.author`);
  if (
    actor?.id !== candidate.author?.id ||
    actor?.login !== candidate.author?.login
  ) {
    throw requestFailure(`${context} returned a different author.`);
  }

  const variables = {owner, name, number: candidate.number} as const;
  const connectionPrefix = ['repository', 'pullRequest'] as const;
  const firstFiles = parseFirstConnectionPage(node.files, `${context}.files`);
  const firstReviews = parseFirstConnectionPage(
    node.reviews,
    `${context}.reviews`,
  );
  const firstClosingIssues = parseFirstConnectionPage(
    node.closingIssuesReferences,
    `${context}.closingIssuesReferences`,
  );
  const fileNodes = firstFiles.hasNextPage
    ? await transport.paginateGraphql({
        query: PULL_REQUEST_FILES_QUERY,
        variables,
        connectionPath: [...connectionPrefix, 'files'],
      })
    : firstFiles.nodes;
  const reviewNodes = firstReviews.hasNextPage
    ? await transport.paginateGraphql({
        query: PULL_REQUEST_REVIEWS_QUERY,
        variables,
        connectionPath: [...connectionPrefix, 'reviews'],
      })
    : firstReviews.nodes;
  const closingIssueNodes = firstClosingIssues.hasNextPage
    ? await transport.paginateGraphql({
        query: PULL_REQUEST_CLOSING_ISSUES_QUERY,
        variables,
        connectionPath: [...connectionPrefix, 'closingIssuesReferences'],
      })
    : firstClosingIssues.nodes;

  const evidenceMaterial = parsePullRequestEvidenceMaterial(
    {repository: {pullRequest: node}},
    candidate,
  );
  let evidence: readonly Evidence[] = [];
  if (evidenceMaterial.body !== null) {
    try {
      evidence = await extractEvidence(
        transport,
        {repo: repository.id, headSha: candidate.headSha},
        evidenceMaterial.body,
      );
    } catch {
      // Optional evidence cannot invalidate independently verified GitHub work.
    }
  }

  return {
    ...shallowPullRequest(located),
    files: fileNodes.map((file, fileIndex) =>
      parsePullRequestFile(file, `${context}.files.nodes[${fileIndex}]`),
    ),
    closedIssueIds: dedupeStrings(
      closingIssueNodes.map((issue, issueIndex) =>
        parseNodeId(
          issue,
          `${context}.closingIssuesReferences.nodes[${issueIndex}]`,
        ),
      ),
    ),
    reviews: reviewNodes.flatMap((review, reviewIndex) => {
      const parsed = parseReview(
        review,
        `${context}.reviews.nodes[${reviewIndex}]`,
      );
      return parsed === null ? [] : [parsed];
    }),
    evidence,
  };
}

function parseFirstConnectionPage(
  value: unknown,
  context: string,
): FirstConnectionPage {
  const connection = parseRecord(value, context);
  const nodes = parseConnectionNodes(connection);
  const pageInfo = parseRecord(connection.pageInfo, `${context}.pageInfo`);
  if (typeof pageInfo.hasNextPage !== 'boolean') {
    throw requestFailure(`${context}.pageInfo.hasNextPage must be a boolean.`);
  }
  if (pageInfo.endCursor !== null && typeof pageInfo.endCursor !== 'string') {
    throw requestFailure(
      `${context}.pageInfo.endCursor must be a string or null.`,
    );
  }
  if (
    pageInfo.hasNextPage &&
    (pageInfo.endCursor === null || pageInfo.endCursor.length === 0)
  ) {
    throw requestFailure(`${context}.pageInfo cursor is invalid.`);
  }
  return {nodes, hasNextPage: pageInfo.hasNextPage};
}

/**
 * Fetches only the closed issues referenced by normalized merged pull requests.
 *
 * Stable node ids are deduplicated before transport work. Each issue and all of
 * its labels must remain consistent throughout pagination; missing, non-issue,
 * cross-repository, or changing nodes fail collection rather than silently
 * removing a potential resolved-issue score.
 *
 * @param transport The authenticated, bounded GitHub transport seam.
 * @param repository The repository whose merged pull requests are being read.
 * @param pullRequests Normalized merged pull requests for the repository.
 * @returns Referenced closed issues sorted by stable GitHub node id.
 */
export async function fetchReferencedIssues(
  transport: GitHubTransport,
  repository: ProjectRepository,
  pullRequests: readonly PullRequest[],
): Promise<readonly Issue[]> {
  parseRepositoryParts(repository);
  const issueIds = new Set<string>();
  for (const pullRequest of pullRequests) {
    if (pullRequest.repo.toLowerCase() !== repository.id.toLowerCase()) {
      throw requestFailure(
        `Pull request ${pullRequest.id} does not belong to ${repository.id}.`,
      );
    }
    for (const issueId of pullRequest.closedIssueIds) {
      issueIds.add(
        parseNonemptyApiString(issueId, 'GitHub referenced issue id'),
      );
    }
  }

  if (issueIds.size > transport.maxRecords) {
    throw requestFailure(
      'GitHub referenced issues exceeded the record safety limit.',
    );
  }

  const sortedIds = [...issueIds].sort((left, right) =>
    left.localeCompare(right),
  );
  const issues = await mapConcurrent(
    sortedIds,
    NETWORK_CONCURRENCY,
    async issueId => fetchReferencedIssue(transport, repository, issueId),
  );
  return issues.flatMap(issue => (issue === null ? [] : [issue]));
}

/**
 * Verifies explicit evidence references found in contributor-authored material.
 *
 * A canonical PR body must contain exactly one `evidence-head` marker matching
 * the merged head. Links and images are accepted only from recognized
 * `evidence-row` sections and only when they use immutable GitHub attachment
 * URLs. Invalid references and failed verification are omitted so evidence
 * ingestion cannot remove otherwise valid GitHub contribution score.
 *
 * @param transport The injected, unauthenticated evidence download boundary.
 * @param pullRequest Repository and accepted revision used for URL verification.
 * @param body Canonical pull-request body after edit-history qualification.
 * @returns Verified, content-addressed evidence in row order.
 */
export async function extractEvidence(
  transport: EvidenceTransport,
  pullRequest: Pick<PullRequest, 'repo' | 'headSha'>,
  body: string,
): Promise<readonly Evidence[]> {
  const references = parseEvidenceReferences(body, pullRequest.headSha);
  const seenUrls = new Set<string>();
  const seenDigests = new Set<string>();
  const evidence: Evidence[] = [];

  for (const reference of references) {
    const url = parseEvidenceUrl(reference.url);
    if (url === null || seenUrls.has(url)) continue;
    seenUrls.add(url);

    let resource: EvidenceResource;
    try {
      resource = await transport.fetchEvidence(
        url,
        EVIDENCE_LIMITS[reference.kind],
      );
    } catch {
      continue;
    }
    if (
      !EVIDENCE_MIME_TYPES[reference.kind].has(resource.contentType) ||
      !hasValidEvidenceStructure(reference.kind, resource) ||
      seenDigests.has(resource.sha256)
    ) {
      continue;
    }

    seenDigests.add(resource.sha256);
    evidence.push({kind: reference.kind, sha256: resource.sha256});
  }

  return evidence;
}

function hasValidEvidenceStructure(
  kind: Evidence['kind'],
  resource: EvidenceResource,
): boolean {
  const bytes = resource.prefix;
  const ascii = (offset: number, value: string): boolean =>
    [...value].every(
      (character, index) => bytes[offset + index] === character.charCodeAt(0),
    );
  const image =
    (bytes[0] === 0x89 && ascii(1, 'PNG\r\n\x1a\n')) ||
    (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    ascii(0, 'GIF87a') ||
    ascii(0, 'GIF89a') ||
    (ascii(0, 'RIFF') && ascii(8, 'WEBP')) ||
    ascii(4, 'ftypavif');
  if (kind === 'screenshot') return image;
  if (kind === 'video') {
    return (
      ascii(0, '\x1aE\xdf\xa3') || (bytes.length >= 12 && ascii(4, 'ftyp'))
    );
  }
  if (kind === 'logs') return isSafeTextEvidence(bytes, false);
  if (kind === 'trajectory') return isSafeTextEvidence(bytes, true);
  if (image) return true;
  return (
    ascii(0, 'PK\x03\x04') ||
    ascii(0, 'PK\x05\x06') ||
    ascii(0, 'PK\x07\x08') ||
    (bytes[0] === 0x1f && bytes[1] === 0x8b) ||
    ascii(257, 'ustar') ||
    isSafeTextEvidence(bytes, false)
  );
}

function isSafeTextEvidence(bytes: Uint8Array, requireJson: boolean): boolean {
  let text: string;
  try {
    text = new TextDecoder('utf-8', {fatal: true}).decode(bytes).trimStart();
  } catch {
    return false;
  }
  if (
    text.length === 0 ||
    [...text].some(character => {
      const code = character.charCodeAt(0);
      return code < 32 && code !== 9 && code !== 10 && code !== 13;
    })
  ) {
    return false;
  }
  return !requireJson || text.startsWith('{') || text.startsWith('[');
}

function parseEvidenceReferences(
  body: string,
  headSha: string,
): readonly EvidenceReference[] {
  const lines = proseLines(body);
  const headPattern = /<!--\s*evidence-head:([0-9a-f]{40})\s*-->/giu;
  const heads = lines.flatMap(line =>
    [...line.matchAll(headPattern)].flatMap(match =>
      match[1] === undefined ? [] : [match[1].toLowerCase()],
    ),
  );
  if (heads.length !== 1 || heads[0] !== headSha.toLowerCase()) return [];

  const references: EvidenceReference[] = [];
  const rowPattern = /<!--\s*evidence-row:([a-z0-9-]+)\s*-->/iu;
  let active: {
    readonly kind: Evidence['kind'];
    readonly lines: string[];
  } | null = null;
  const acceptActiveRow = (): boolean => {
    if (active === null) return false;
    for (const line of active.lines) {
      if (isNotApplicableEvidenceRow(line)) break;
      for (const url of evidenceUrls(line)) {
        references.push({kind: active.kind, url});
        if (references.length === MAX_EVIDENCE_REFERENCES) return true;
      }
    }
    active = null;
    return false;
  };

  for (const line of lines) {
    const row = rowPattern.exec(line);
    if (row !== null) {
      if (acceptActiveRow()) return references;
      const kind = evidenceKindForRow(row[1] ?? '');
      active =
        kind === null ? null : {kind, lines: [line.replace(row[0], '').trim()]};
    } else if (active !== null) {
      active.lines.push(line);
    }
  }
  acceptActiveRow();
  return references;
}

function proseLines(material: string): readonly string[] {
  const lines: string[] = [];
  let fence: '`' | '~' | null = null;
  for (const line of material.split(/\r?\n/u)) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/u.exec(line);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1];
      if (marker !== undefined) {
        const character = marker[0];
        if (character === '`' || character === '~') {
          fence =
            fence === null ? character : fence === character ? null : fence;
        }
      }
      continue;
    }
    if (fence !== null || /^\s*>/u.test(line)) continue;
    lines.push(line.replace(/`[^`\r\n]*`/gu, ''));
  }
  return lines;
}

function evidenceKindForRow(value: string): Evidence['kind'] | null {
  switch (value.toLowerCase()) {
    case 'before-screenshots':
    case 'after-screenshots':
    case 'screenshots':
      return 'screenshot';
    case 'walkthrough-video':
    case 'video':
      return 'video';
    case 'backend-logs':
    case 'frontend-logs':
    case 'logs':
      return 'logs';
    case 'llm-trajectory':
    case 'trajectory':
      return 'trajectory';
    case 'domain-artifact':
    case 'domain-artifacts':
      return 'artifact';
    default:
      return null;
  }
}

function isNotApplicableEvidenceRow(line: string): boolean {
  return /^\s*-\s*\[[ x]\]\s*N\s*\/\s*A(?:\s|$)/iu.test(line);
}

function evidenceUrls(line: string): readonly string[] {
  const urls: string[] = [];
  const patterns = [
    /!?\[[^\]\r\n]{0,512}\]\(\s*<?(https:\/\/[^\s)>]+)>?(?:\s+["'][^"'\r\n]*["'])?\s*\)/gu,
    /<img\b[^>]*\bsrc=["'](https:\/\/[^"']+)["'][^>]*>/giu,
    /(?<!["'(=])(https:\/\/github\.com\/user-attachments\/(?:assets|files)\/[^\s<>)]+)/gu,
  ] as const;
  for (const pattern of patterns) {
    for (const match of line.matchAll(pattern)) {
      const url = match[1]?.replace(/[.,;:]$/u, '');
      if (url !== undefined && !urls.includes(url)) urls.push(url);
    }
  }
  return urls;
}

function parseEvidenceUrl(value: string): string | null {
  if (
    value.length === 0 ||
    value.length > MAX_EVIDENCE_URL_LENGTH ||
    value.includes('%')
  ) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    return null;
  }

  const components = url.pathname.split('/').filter(Boolean);
  return url.hostname === 'github.com' && isGitHubUserAttachment(components)
    ? url.toString()
    : null;
}

function isGitHubUserAttachment(components: readonly string[]): boolean {
  return (
    components.length === 3 &&
    components[0] === 'user-attachments' &&
    components[1] === 'assets' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      components[2] ?? '',
    )
  );
}

async function fetchReferencedIssue(
  transport: GitHubTransport,
  repository: ProjectRepository,
  issueId: string,
): Promise<Issue | null> {
  const cursors = new Set<string>();
  const labels: string[] = [];
  let after: string | null = null;
  let accepted: Omit<Issue, 'labels'> | undefined;

  for (let page = 0; ; page += 1) {
    if (page >= transport.maxPages) {
      throw requestFailure(
        `GitHub labels for referenced issue ${issueId} exceeded the page limit.`,
      );
    }

    const data = await transport.queryGraphql({
      query: REFERENCED_ISSUE_QUERY,
      variables: {id: issueId, after},
    });
    const parsed = parseReferencedIssuePage(data, repository, issueId, page);
    if (parsed.issue === null) {
      if (accepted !== undefined) {
        throw requestFailure(
          `GitHub referenced issue ${issueId} changed during collection.`,
        );
      }
      return null;
    }
    if (accepted !== undefined && !sameIssue(accepted, parsed.issue)) {
      throw requestFailure(
        `GitHub referenced issue ${issueId} changed during collection.`,
      );
    }
    accepted = parsed.issue;
    appendBounded(labels, parsed.labels, transport.maxRecords);

    if (!parsed.hasNextPage) {
      return {
        ...parsed.issue,
        labels: [...new Set(labels)].sort((left, right) =>
          left.localeCompare(right),
        ),
      };
    }

    const cursor = parsed.endCursor;
    if (cursor === null || cursor.length === 0 || cursors.has(cursor)) {
      throw requestFailure(
        `GitHub labels for referenced issue ${issueId} returned an invalid cursor.`,
      );
    }
    cursors.add(cursor);
    after = cursor;
  }
}

async function extractPullRequestEvidence(
  transport: GitHubTransport,
  repository: ProjectRepository,
  owner: string,
  name: string,
  candidate: SearchCandidate,
): Promise<readonly Evidence[]> {
  if (candidate.author === null) return [];
  try {
    const material = await fetchPullRequestEvidenceMaterial(
      transport,
      owner,
      name,
      candidate,
    );
    if (material.body === null) return [];
    return await extractEvidence(
      transport,
      {repo: repository.id, headSha: candidate.headSha},
      material.body,
    );
  } catch {
    // Evidence is optional score input. An unavailable or inconsistent source
    // remains unverified without invalidating independently normalized GitHub work.
    return [];
  }
}

async function fetchPullRequestEvidenceMaterial(
  transport: GitHubTransport,
  owner: string,
  name: string,
  candidate: SearchCandidate,
): Promise<PullRequestEvidenceMaterial> {
  const data = await transport.queryGraphql({
    query: PULL_REQUEST_EVIDENCE_MATERIAL_QUERY,
    variables: {owner, name, number: candidate.number, after: null},
  });
  return parsePullRequestEvidenceMaterial(data, candidate);
}

function parsePullRequestEvidenceMaterial(
  data: Readonly<Record<string, unknown>>,
  candidate: SearchCandidate,
): PullRequestEvidenceMaterial {
  const context = `GitHub evidence material for pull request ${candidate.id}`;
  const repository = parseRecord(data.repository, `${context}.repository`);
  const pullRequest = parseRecord(
    repository.pullRequest,
    `${context}.pullRequest`,
  );
  if (
    parseNonemptyApiString(pullRequest.id, `${context}.id`) !== candidate.id ||
    parseSha(pullRequest.headRefOid, `${context}.headRefOid`) !==
      candidate.headSha
  ) {
    throw requestFailure(`${context} did not match the accepted revision.`);
  }

  const author = pullRequest.author;
  if (candidate.author === null || author === null) {
    throw requestFailure(`${context} has no verifiable contributor.`);
  }
  const authorId = parseNonemptyApiString(
    parseRecord(author, `${context}.author`).id,
    `${context}.author.id`,
  );
  if (authorId !== candidate.author.id) {
    throw requestFailure(`${context} returned a different contributor.`);
  }

  const body = parseNullableApiString(pullRequest.body, `${context}.body`);
  if (body === null || body.length === 0) return {body: null};
  const lastEditedAt = parseNullableApiTimestamp(
    pullRequest.lastEditedAt,
    `${context}.lastEditedAt`,
  );
  if (lastEditedAt === null || lastEditedAt <= candidate.mergedAt)
    return {body};

  const edits = parseRecord(
    pullRequest.userContentEdits,
    `${context}.userContentEdits`,
  );
  const totalCount = parseNonnegativeApiInteger(
    edits.totalCount,
    `${context}.userContentEdits.totalCount`,
  );
  const nodes = parseConnectionNodes(edits);
  if (totalCount > MAX_PULL_REQUEST_BODY_EDITS || nodes.length !== totalCount) {
    throw requestFailure(`${context} edit history is incomplete.`);
  }
  for (const [index, value] of nodes.entries()) {
    const editContext = `${context}.userContentEdits.nodes[${index}]`;
    const edit = parseRecord(value, editContext);
    const editedAt = parseApiTimestamp(
      edit.editedAt,
      `${editContext}.editedAt`,
    );
    if (editedAt <= candidate.mergedAt || edit.editor === null) continue;
    const editorId = parseNonemptyApiString(
      parseRecord(edit.editor, `${editContext}.editor`).id,
      `${editContext}.editor.id`,
    );
    if (editorId === authorId) return {body: null};
  }
  return {body};
}

async function collectSearchInterval(
  transport: GitHubTransport,
  repository: ProjectRepository,
  interval: SearchInterval,
  safety: SearchSafetyState,
): Promise<SearchCollectionResult> {
  safety.intervals += 1;
  if (safety.intervals > MAX_SEARCH_INTERVALS) {
    throw requestFailure(
      'GitHub pull-request search exceeded its interval safety limit.',
    );
  }

  const result = await transport.searchGraphql({
    query: SEARCH_MERGED_PULL_REQUESTS_QUERY,
    variables: {
      query: mergedPullRequestSearchQuery(repository, interval),
    },
    connectionPath: ['search'],
  });

  if (result.totalCount <= GITHUB_SEARCH_RESULT_LIMIT) {
    return {
      status: 'consistent',
      collection: {
        reportedCount: result.totalCount,
        candidates: result.nodes.map((node, index) =>
          parseSearchCandidate(node, `GitHub search result ${index}`),
        ),
      },
    };
  }

  const [leftInterval, rightInterval] = splitSearchInterval(interval);
  const [left, right] = await Promise.all([
    collectSearchInterval(transport, repository, leftInterval, safety),
    collectSearchInterval(transport, repository, rightInterval, safety),
  ]);
  if (left.status === 'changed') return left;
  if (right.status === 'changed') return right;
  if (
    left.collection.reportedCount + right.collection.reportedCount !==
    result.totalCount
  ) {
    return {status: 'changed'};
  }

  return {
    status: 'consistent',
    collection: {
      reportedCount: result.totalCount,
      candidates: [
        ...left.collection.candidates,
        ...right.collection.candidates,
      ],
    },
  };
}

async function hydratePullRequest(
  transport: GitHubTransport,
  repository: ProjectRepository,
  owner: string,
  name: string,
  candidate: SearchCandidate,
  plan: HydrationPlan,
): Promise<PullRequest> {
  const variables = {
    owner,
    name,
    number: candidate.number,
  } as const;
  const connectionPrefix = ['repository', 'pullRequest'] as const;

  const fileNodes = plan.files
    ? await transport.paginateGraphql({
        query: PULL_REQUEST_FILES_QUERY,
        variables,
        connectionPath: [...connectionPrefix, 'files'],
      })
    : [];
  const reviewNodes = await transport.paginateGraphql({
    query: PULL_REQUEST_REVIEWS_QUERY,
    variables,
    connectionPath: [...connectionPrefix, 'reviews'],
  });
  const closingIssueNodes = plan.closingIssues
    ? await transport.paginateGraphql({
        query: PULL_REQUEST_CLOSING_ISSUES_QUERY,
        variables,
        connectionPath: [...connectionPrefix, 'closingIssuesReferences'],
      })
    : [];
  const evidence = plan.evidence
    ? await extractPullRequestEvidence(
        transport,
        repository,
        owner,
        name,
        candidate,
      )
    : [];

  return {
    id: candidate.id,
    repo: repository.id,
    number: candidate.number,
    title: candidate.title,
    author: candidate.author,
    mergedAt: candidate.mergedAt,
    headSha: candidate.headSha,
    files: fileNodes.map((node, index) =>
      parsePullRequestFile(node, `GitHub pull-request file ${index}`),
    ),
    closedIssueIds: dedupeStrings(
      closingIssueNodes.map((node, index) =>
        parseNodeId(node, `GitHub closing issue ${index}`),
      ),
    ),
    reviews: reviewNodes.flatMap((node, index) => {
      const review = parseReview(node, `GitHub pull-request review ${index}`);
      return review === null ? [] : [review];
    }),
    evidence,
  };
}

function mergedPullRequestSearchQuery(
  repository: ProjectRepository,
  interval: SearchInterval,
): string {
  const inclusiveEnd = parseCanonicalTimestamp(
    new Date(Date.parse(interval.to) - 1).toISOString(),
  );
  return [
    `repo:${quoteSearchValue(repository.id)}`,
    'is:pr',
    'is:merged',
    `base:${quoteSearchValue(repository.branch)}`,
    `merged:${interval.from}..${inclusiveEnd}`,
    'sort:created-asc',
  ].join(' ');
}

function quoteSearchValue(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function splitSearchInterval(
  interval: SearchInterval,
): readonly [SearchInterval, SearchInterval] {
  const fromMs = Date.parse(interval.from);
  const toMs = Date.parse(interval.to);
  const midpointMs = fromMs + Math.floor((toMs - fromMs) / 2);
  if (midpointMs <= fromMs || midpointMs >= toMs) {
    throw requestFailure(
      'GitHub search exceeded 1,000 results in an interval that cannot be split.',
    );
  }
  const midpoint = parseCanonicalTimestamp(new Date(midpointMs).toISOString());
  return [
    {from: interval.from, to: midpoint},
    {from: midpoint, to: interval.to},
  ];
}

function parseCollectionWindow(window: CollectionWindow): SearchInterval {
  const from = parseCanonicalTimestamp(window.from);
  const to = parseCanonicalTimestamp(window.to);
  if (from >= to) {
    throw new TypeError('GitHub collection window must be non-empty.');
  }
  return {from, to};
}

function parseRepositoryParts(
  repository: ProjectRepository,
): readonly [string, string] {
  const parts = repository.id.split('/');
  const owner = parts[0];
  const name = parts[1];
  if (
    parts.length !== 2 ||
    owner === undefined ||
    owner.length === 0 ||
    name === undefined ||
    name.length === 0 ||
    repository.branch.length === 0
  ) {
    throw new TypeError('GitHub repository configuration is invalid.');
  }
  return [owner, name];
}

function parseSearchCandidate(
  value: unknown,
  context: string,
): SearchCandidate {
  const record = parseRecord(value, context);
  return {
    id: parseNonemptyApiString(record.id, `${context}.id`),
    number: parsePositiveApiInteger(record.number, `${context}.number`),
    title: parseApiString(record.title, `${context}.title`),
    author: parseActor(record.author, `${context}.author`),
    mergedAt: parseApiTimestamp(record.mergedAt, `${context}.mergedAt`),
    baseBranch: parseNonemptyApiString(
      record.baseRefName,
      `${context}.baseRefName`,
    ),
    headSha: parseSha(record.headRefOid, `${context}.headRefOid`),
  };
}

function parsePullRequestFile(
  value: unknown,
  context: string,
): PullRequestFile {
  const record = parseRecord(value, context);
  return {
    path: parseNonemptyApiString(record.path, `${context}.path`),
    additions: parseNonnegativeApiInteger(
      record.additions,
      `${context}.additions`,
    ),
    deletions: parseNonnegativeApiInteger(
      record.deletions,
      `${context}.deletions`,
    ),
  };
}

function parseReferencedIssuePage(
  data: Readonly<Record<string, unknown>>,
  repository: ProjectRepository,
  requestedId: string,
  page: number,
): ReferencedIssuePage {
  const context = `GitHub referenced issue ${requestedId} page ${page}`;
  if (data.node === null || data.node === undefined) {
    throw requestFailure(`${context} was not found.`);
  }
  const node = parseRecord(data.node, context);
  if (node.__typename !== 'Issue') {
    throw requestFailure(`${context} did not resolve to an issue.`);
  }

  const id = parseNonemptyApiString(node.id, `${context}.id`);
  if (id !== requestedId) {
    throw requestFailure(`${context} returned a different node id.`);
  }
  const issueRepository = parseNonemptyApiString(
    parseRecord(node.repository, `${context}.repository`).nameWithOwner,
    `${context}.repository.nameWithOwner`,
  );
  if (issueRepository.toLowerCase() !== repository.id.toLowerCase()) {
    throw requestFailure(`${context} belongs to a different repository.`);
  }

  const stateReason = node.stateReason;
  if (node.closedAt === null) {
    if (stateReason !== null && stateReason !== 'REOPENED') {
      throw requestFailure(
        `${context}.stateReason is invalid for an open issue.`,
      );
    }
    return {issue: null};
  }
  if (stateReason !== 'COMPLETED' && stateReason !== 'NOT_PLANNED') {
    throw requestFailure(`${context}.stateReason is invalid.`);
  }

  const connection = parseRecord(node.labels, `${context}.labels`);
  const labelNodes = parseConnectionNodes(connection);
  const pageInfo = parseRecord(
    connection.pageInfo,
    `${context}.labels.pageInfo`,
  );
  if (typeof pageInfo.hasNextPage !== 'boolean') {
    throw requestFailure(
      `${context}.labels.pageInfo.hasNextPage must be a boolean.`,
    );
  }
  if (pageInfo.endCursor !== null && typeof pageInfo.endCursor !== 'string') {
    throw requestFailure(
      `${context}.labels.pageInfo.endCursor must be a string or null.`,
    );
  }

  return {
    issue: {
      id,
      repo: repository.id,
      number: parsePositiveApiInteger(node.number, `${context}.number`),
      title: parseApiString(node.title, `${context}.title`),
      author: parseActor(node.author, `${context}.author`),
      closedAt: parseApiTimestamp(node.closedAt, `${context}.closedAt`),
      stateReason,
    },
    labels: labelNodes.map((label, index) =>
      parseNonemptyApiString(
        parseRecord(label, `${context}.labels.nodes[${index}]`).name,
        `${context}.labels.nodes[${index}].name`,
      ),
    ),
    hasNextPage: pageInfo.hasNextPage,
    endCursor: pageInfo.endCursor,
  };
}

function parseReview(value: unknown, context: string): Review | null {
  const record = parseRecord(value, context);
  const state = parseApiString(record.state, `${context}.state`);
  if (state === 'PENDING') return null;
  if (
    state !== 'APPROVED' &&
    state !== 'CHANGES_REQUESTED' &&
    state !== 'COMMENTED' &&
    state !== 'DISMISSED'
  ) {
    throw requestFailure(`${context}.state is invalid.`);
  }

  const body = record.body;
  if (body !== null && typeof body !== 'string') {
    throw requestFailure(`${context}.body must be a string or null.`);
  }
  const comments = parseRecord(record.comments, `${context}.comments`);
  return {
    id: parseNonemptyApiString(record.id, `${context}.id`),
    author: parseActor(record.author, `${context}.author`),
    state,
    submittedAt: parseApiTimestamp(
      record.submittedAt,
      `${context}.submittedAt`,
    ),
    bodyLength: body === null ? 0 : body.trim().length,
    inlineComments: parseNonnegativeApiInteger(
      comments.totalCount,
      `${context}.comments.totalCount`,
    ),
  };
}

function parseActor(value: unknown, context: string): Actor | null {
  if (value === null) return null;
  const record = parseRecord(value, context);
  const login = parseNonemptyApiString(record.login, `${context}.login`);
  if (record.__typename === 'Bot' || isBotLogin(login)) return null;
  return {
    id: parseNonemptyApiString(record.id, `${context}.id`),
    login,
  };
}

function isBotLogin(login: string): boolean {
  return /(?:\[bot\]|-bot)$/iu.test(login);
}

function parseNodeId(value: unknown, context: string): string {
  return parseNonemptyApiString(
    parseRecord(value, context).id,
    `${context}.id`,
  );
}

function parseSha(value: unknown, context: string): string {
  const sha = parseApiString(value, context);
  if (!/^[0-9a-f]{40}$/u.test(sha)) {
    throw requestFailure(`${context} must be a lowercase 40-character SHA.`);
  }
  return sha;
}

function parseApiTimestamp(
  value: unknown,
  context: string,
): CanonicalTimestamp {
  const timestamp = parseApiString(value, context);
  const match = GITHUB_TIMESTAMP_PATTERN.exec(timestamp);
  if (match === null || match[1] === undefined) {
    throw requestFailure(`${context} is not a valid GitHub timestamp.`);
  }
  const canonical = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`;
  try {
    return parseCanonicalTimestamp(canonical);
  } catch (error: unknown) {
    throw requestFailure(`${context} is not a valid GitHub timestamp.`, error);
  }
}

function parseNullableApiTimestamp(
  value: unknown,
  context: string,
): CanonicalTimestamp | null {
  return value === null ? null : parseApiTimestamp(value, context);
}

function parseApiString(value: unknown, context: string): string {
  if (typeof value !== 'string') {
    throw requestFailure(`${context} must be a string.`);
  }
  return value;
}

function parseNullableApiString(
  value: unknown,
  context: string,
): string | null {
  return value === null ? null : parseApiString(value, context);
}

function parseNonemptyApiString(value: unknown, context: string): string {
  const parsed = parseApiString(value, context);
  if (parsed.length === 0) {
    throw requestFailure(`${context} must not be empty.`);
  }
  return parsed;
}

function parseNonnegativeApiInteger(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw requestFailure(`${context} must be a non-negative safe integer.`);
  }
  return value;
}

function parsePositiveApiInteger(value: unknown, context: string): number {
  const parsed = parseNonnegativeApiInteger(value, context);
  if (parsed === 0) {
    throw requestFailure(`${context} must be positive.`);
  }
  return parsed;
}

function dedupeStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sameCandidate(left: SearchCandidate, right: SearchCandidate): boolean {
  return (
    left.id === right.id &&
    left.number === right.number &&
    left.title === right.title &&
    left.author?.id === right.author?.id &&
    left.author?.login === right.author?.login &&
    left.mergedAt === right.mergedAt &&
    left.baseBranch === right.baseBranch &&
    left.headSha === right.headSha
  );
}

function sameIssue(
  left: Omit<Issue, 'labels'>,
  right: Omit<Issue, 'labels'>,
): boolean {
  return (
    left.id === right.id &&
    left.repo === right.repo &&
    left.number === right.number &&
    left.title === right.title &&
    left.author?.id === right.author?.id &&
    left.author?.login === right.author?.login &&
    left.closedAt === right.closedAt &&
    left.stateReason === right.stateReason
  );
}

function compareCandidates(
  left: SearchCandidate,
  right: SearchCandidate,
): number {
  return (
    left.mergedAt.localeCompare(right.mergedAt) ||
    left.id.localeCompare(right.id)
  );
}

function compareLocatedCandidatesNewest(
  left: LocatedCandidate,
  right: LocatedCandidate,
): number {
  return (
    compareText(right.candidate.mergedAt, left.candidate.mergedAt) ||
    compareText(right.candidate.id, left.candidate.id)
  );
}

function comparePullRequests(left: PullRequest, right: PullRequest): number {
  return (
    compareText(left.mergedAt, right.mergedAt) || compareText(left.id, right.id)
  );
}

function createTransport(
  token: string,
  fetchTransport: FetchTransport,
  sleep: Sleep,
  now: () => number,
  limits: SafetyLimits,
): GitHubTransport {
  const request = createRequester(token, fetchTransport, sleep, now, limits);

  return {
    maxPages: limits.maxPages,
    maxRecords: limits.maxRecords,
    fetchEvidence: (url, maxBytes) =>
      fetchEvidenceResource(
        fetchTransport,
        url,
        maxBytes,
        limits.requestTimeoutMs,
      ),
    paginateRest: path => paginateRest(path, request, sleep, now, limits),
    paginateGraphql: operation =>
      paginateGraphql(operation, request, sleep, now, limits),
    searchGraphql: operation =>
      searchGraphql(operation, request, sleep, now, limits),
    queryGraphql: operation =>
      queryGraphql(operation, request, sleep, now, limits),
  };
}

async function fetchEvidenceResource(
  fetchTransport: FetchTransport,
  initialUrl: string,
  maxBytes: number,
  requestTimeoutMs: number,
): Promise<EvidenceResource> {
  const attachment = new URL(initialUrl).hostname === 'github.com';
  let url = initialUrl;

  for (let redirect = 0; ; redirect += 1) {
    const response = await fetchTransport(url, {
      method: 'GET',
      headers: {
        Accept: '*/*',
        'User-Agent': 'ship',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (isRedirectStatus(response.status)) {
      await discardBody(response);
      if (redirect >= MAX_EVIDENCE_REDIRECTS) {
        throw requestFailure('Evidence download exceeded its redirect limit.');
      }
      const location = response.headers.get('location');
      if (location === null) {
        throw requestFailure('Evidence redirect did not provide a location.');
      }
      url = parseEvidenceRedirect(location, url, attachment);
      continue;
    }
    if (response.status !== 200) {
      await discardBody(response);
      throw requestFailure(
        `Evidence download failed with HTTP ${response.status}.`,
      );
    }

    const contentType = parseEvidenceContentType(response.headers);
    const {sha256, prefix} = await hashResponseBody(response, maxBytes);
    return {contentType, sha256, prefix};
  }
}

function parseEvidenceRedirect(
  location: string,
  currentUrl: string,
  attachment: boolean,
): string {
  if (location.length === 0 || location.length > MAX_EVIDENCE_URL_LENGTH) {
    throw requestFailure('Evidence redirect URL violates the safety limit.');
  }
  let url: URL;
  try {
    url = new URL(location, currentUrl);
  } catch (error: unknown) {
    throw requestFailure('Evidence redirect URL is invalid.', error);
  }
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0 ||
    url.hash.length > 0
  ) {
    throw requestFailure('Evidence redirect URL is unsafe.');
  }

  const attachmentObjectHost =
    url.hostname === 'objects.githubusercontent.com' ||
    /^github-production-user-asset-[a-z0-9-]+\.s3\.amazonaws\.com$/u.test(
      url.hostname,
    );
  const allowedHost =
    url.hostname === 'github.com' ||
    url.hostname === 'raw.githubusercontent.com' ||
    url.hostname === 'user-images.githubusercontent.com' ||
    (attachment && attachmentObjectHost);
  if (!allowedHost) {
    throw requestFailure('Evidence redirect attempted to leave GitHub hosts.');
  }
  if (!attachmentObjectHost && url.search.length > 0) {
    throw requestFailure(
      'Evidence redirect URL contains an unsupported query.',
    );
  }
  return url.toString();
}

function isRedirectStatus(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

function parseEvidenceContentType(headers: Headers): string {
  const value = headers.get('content-type');
  if (value === null) {
    throw requestFailure('Evidence response Content-Type is missing.');
  }
  const contentType = value.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType === undefined || contentType.length === 0) {
    throw requestFailure('Evidence response Content-Type is invalid.');
  }
  return contentType;
}

async function hashResponseBody(
  response: Response,
  maxBytes: number,
): Promise<{readonly sha256: string; readonly prefix: Uint8Array}> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength)) {
      await discardBody(response);
      throw requestFailure('Evidence response Content-Length is invalid.');
    }
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length <= 0 || length > maxBytes) {
      await discardBody(response);
      throw requestFailure('Evidence response violates its byte limit.');
    }
  }
  if (response.body === null) {
    throw requestFailure('Evidence response body is missing.');
  }

  const hash = createHash('sha256');
  const prefix = new Uint8Array(512);
  const reader = response.body.getReader();
  let length = 0;
  let prefixLength = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw requestFailure('Evidence response violates its byte limit.');
      }
      hash.update(chunk.value);
      const prefixRemaining = prefix.length - prefixLength;
      if (prefixRemaining > 0) {
        const accepted = chunk.value.subarray(0, prefixRemaining);
        prefix.set(accepted, prefixLength);
        prefixLength += accepted.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (length === 0) {
    throw requestFailure('Evidence response body is empty.');
  }
  return {sha256: hash.digest('hex'), prefix: prefix.subarray(0, prefixLength)};
}

function createRequester(
  token: string,
  fetchTransport: FetchTransport,
  sleep: Sleep,
  now: () => number,
  limits: SafetyLimits,
): <T>(
  url: string,
  init: RequestInit,
  parse: (value: unknown) => T,
) => Promise<ParsedResponse<T>> {
  return async <T>(
    url: string,
    init: RequestInit,
    parse: (value: unknown) => T,
  ): Promise<ParsedResponse<T>> => {
    for (let attempt = 0; attempt <= limits.maxRetries; attempt += 1) {
      let response: Response;
      try {
        response = await fetchTransport(url, {
          ...init,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'User-Agent': 'ship',
            'X-GitHub-Api-Version': API_VERSION,
            ...init.headers,
          },
          signal: AbortSignal.timeout(limits.requestTimeoutMs),
        });
      } catch (error: unknown) {
        if (attempt === limits.maxRetries) {
          throw requestFailure('GitHub transport failed after retries.', error);
        }
        await sleep(retryDelay(attempt, limits));
        continue;
      }

      const rateLimit = parseRateLimitHeaders(response.headers);
      if (!response.ok) {
        await discardBody(response);
        if (!isTransientStatus(response.status, response.headers)) {
          throw requestFailure(
            `GitHub request failed with HTTP ${response.status}.`,
          );
        }
        if (attempt === limits.maxRetries) {
          throw requestFailure(
            `GitHub request remained transiently unavailable after ${
              limits.maxRetries + 1
            } attempts.`,
          );
        }
        await sleep(
          responseRetryDelay(response.headers, attempt, now(), limits),
        );
        continue;
      }

      try {
        const value = parse(await readJson(response, limits.maxResponseBytes));
        return {
          value,
          rateLimit,
          nextLink: nextLink(response.headers),
        };
      } catch (error: unknown) {
        if (isRetryableError(error) && attempt < limits.maxRetries) {
          await sleep(retryDelay(attempt, limits));
          continue;
        }
        throw error;
      }
    }

    throw requestFailure('GitHub retry state became inconsistent.');
  };
}

async function paginateRest(
  path: string,
  request: ReturnType<typeof createRequester>,
  sleep: Sleep,
  now: () => number,
  limits: SafetyLimits,
): Promise<readonly unknown[]> {
  let nextUrl: string | undefined = parseRestUrl(path, true);
  const visited = new Set<string>();
  const records: unknown[] = [];

  for (let page = 0; nextUrl !== undefined; page += 1) {
    if (page >= limits.maxPages) {
      throw requestFailure('GitHub REST pagination exceeded its page limit.');
    }
    if (visited.has(nextUrl)) {
      throw requestFailure('GitHub REST pagination repeated a page URL.');
    }
    visited.add(nextUrl);

    const response = await request(nextUrl, {method: 'GET'}, parseRestPage);
    appendBounded(records, response.value, limits.maxRecords);
    const link = response.nextLink;
    if (link === undefined) return records;

    await waitForRateLimit(response.rateLimit, sleep, now, limits);
    nextUrl = parseRestUrl(link, false);
  }

  return records;
}

async function paginateGraphql(
  operation: GraphqlPage,
  request: ReturnType<typeof createRequester>,
  sleep: Sleep,
  now: () => number,
  limits: SafetyLimits,
): Promise<readonly unknown[]> {
  validateGraphqlOperation(operation);
  const records: unknown[] = [];
  const cursors = new Set<string>();
  let after: string | null = null;

  for (let page = 0; ; page += 1) {
    if (page >= limits.maxPages) {
      throw requestFailure(
        'GitHub GraphQL pagination exceeded its page limit.',
      );
    }

    const variables = {...operation.variables, after};
    const body = stringifyRequestBody({query: operation.query, variables});
    const response = await request(
      GITHUB_GRAPHQL_URL,
      {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body,
      },
      value => parseGraphqlPage(value, operation.connectionPath),
    );
    appendBounded(records, response.value.nodes, limits.maxRecords);
    if (!response.value.hasNextPage) return records;

    const cursor = response.value.endCursor;
    if (cursor === null || cursor.length === 0 || cursors.has(cursor)) {
      throw requestFailure('GitHub GraphQL pagination cursor is invalid.');
    }
    cursors.add(cursor);
    after = cursor;

    await waitForRateLimit(
      mergeRateLimits(response.rateLimit, response.value.rateLimit),
      sleep,
      now,
      limits,
    );
  }
}

async function searchGraphql(
  operation: GraphqlPage,
  request: ReturnType<typeof createRequester>,
  sleep: Sleep,
  now: () => number,
  limits: SafetyLimits,
): Promise<GraphqlSearchResult> {
  validateGraphqlOperation(operation);
  const records: unknown[] = [];
  const cursors = new Set<string>();
  let after: string | null = null;
  let expectedCount: number | undefined;

  for (let page = 0; ; page += 1) {
    if (page >= limits.maxPages) {
      throw requestFailure(
        'GitHub GraphQL search pagination exceeded its page limit.',
      );
    }

    const variables = {...operation.variables, after};
    const body = stringifyRequestBody({query: operation.query, variables});
    const response = await request(
      GITHUB_GRAPHQL_URL,
      {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body,
      },
      value => parseGraphqlSearchPage(value, operation.connectionPath),
    );
    const totalCount = response.value.totalCount;
    if (expectedCount === undefined) {
      expectedCount = totalCount;
    } else if (expectedCount !== totalCount) {
      throw requestFailure(
        'GitHub GraphQL search count changed during pagination.',
      );
    }

    if (totalCount > GITHUB_SEARCH_RESULT_LIMIT) {
      return {totalCount, nodes: []};
    }

    appendBounded(records, response.value.nodes, limits.maxRecords);
    if (!response.value.hasNextPage) {
      if (records.length !== totalCount) {
        throw requestFailure(
          'GitHub GraphQL search did not return its reported result count.',
        );
      }
      return {totalCount, nodes: records};
    }

    const cursor = response.value.endCursor;
    if (cursor === null || cursor.length === 0 || cursors.has(cursor)) {
      throw requestFailure('GitHub GraphQL search cursor is invalid.');
    }
    cursors.add(cursor);
    after = cursor;

    await waitForRateLimit(
      mergeRateLimits(response.rateLimit, response.value.rateLimit),
      sleep,
      now,
      limits,
    );
  }
}

async function queryGraphql(
  operation: GraphqlQuery,
  request: ReturnType<typeof createRequester>,
  sleep: Sleep,
  now: () => number,
  limits: SafetyLimits,
): Promise<Readonly<Record<string, unknown>>> {
  validateGraphqlQuery(operation);
  const body = stringifyRequestBody({
    query: operation.query,
    variables: operation.variables,
  });
  const response = await request(
    GITHUB_GRAPHQL_URL,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body,
    },
    parseGraphqlQuery,
  );
  await waitForRateLimit(
    mergeRateLimits(response.rateLimit, response.value.rateLimit),
    sleep,
    now,
    limits,
  );
  return response.value.data;
}

function parseGraphqlQuery(value: unknown): {
  readonly data: Readonly<Record<string, unknown>>;
  readonly rateLimit: RateLimit;
} {
  const envelope = parseRecord(value, 'GitHub GraphQL response');
  if (envelope.errors !== undefined) {
    const errors = parseGraphqlErrors(envelope.errors);
    if (errors.retryable) throw retryableError(errors.message);
    throw requestFailure(errors.message);
  }
  const data = parseRecord(envelope.data, 'GitHub GraphQL response data');
  return {
    data,
    rateLimit: parseGraphqlRateLimit(data.rateLimit),
  };
}

function parseRestPage(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw requestFailure('GitHub REST page must be an array.');
  }
  return value;
}

function parseGraphqlSearchPage(
  value: unknown,
  connectionPath: readonly string[],
): GraphqlSearchPage {
  const page = parseGraphqlPage(value, connectionPath);
  const envelope = parseRecord(value, 'GitHub GraphQL search response');
  let current: unknown = parseRecord(
    envelope.data,
    'GitHub GraphQL search response data',
  );
  for (const component of connectionPath) {
    current = parseRecord(
      current,
      `GitHub GraphQL search path ${connectionPath.join('.')}`,
    )[component];
  }
  const connection = parseRecord(current, 'GitHub GraphQL search connection');
  return {
    ...page,
    totalCount: parseNonnegativeApiInteger(
      connection.issueCount,
      'GitHub GraphQL search issueCount',
    ),
  };
}

function parseGraphqlPage(
  value: unknown,
  connectionPath: readonly string[],
): GraphqlConnectionPage {
  const envelope = parseRecord(value, 'GitHub GraphQL response');
  if (envelope.errors !== undefined) {
    const errors = parseGraphqlErrors(envelope.errors);
    if (errors.retryable) throw retryableError(errors.message);
    throw requestFailure(errors.message);
  }

  let current: unknown = parseRecord(
    envelope.data,
    'GitHub GraphQL response data',
  );
  for (const component of connectionPath) {
    current = parseRecord(
      current,
      `GitHub GraphQL connection path ${connectionPath.join('.')}`,
    )[component];
  }

  const connection = parseRecord(current, 'GitHub GraphQL connection');
  const nodes = parseConnectionNodes(connection);
  const pageInfo = parseRecord(connection.pageInfo, 'GitHub GraphQL pageInfo');
  if (typeof pageInfo.hasNextPage !== 'boolean') {
    throw requestFailure('GitHub GraphQL hasNextPage must be a boolean.');
  }
  if (pageInfo.endCursor !== null && typeof pageInfo.endCursor !== 'string') {
    throw requestFailure('GitHub GraphQL endCursor must be a string or null.');
  }

  return {
    nodes,
    hasNextPage: pageInfo.hasNextPage,
    endCursor: pageInfo.endCursor,
    rateLimit: parseGraphqlRateLimit(
      parseRecord(envelope.data, 'GitHub GraphQL response data').rateLimit,
    ),
  };
}

function parseConnectionNodes(
  connection: Readonly<Record<string, unknown>>,
): readonly unknown[] {
  if (Array.isArray(connection.nodes)) return connection.nodes;
  if (!Array.isArray(connection.edges)) {
    throw requestFailure(
      'GitHub GraphQL connection must contain nodes or edges.',
    );
  }
  return connection.edges.map(
    (edge, index) => parseRecord(edge, `GitHub GraphQL edge ${index}`).node,
  );
}

function parseGraphqlErrors(value: unknown): {
  readonly retryable: boolean;
  readonly message: string;
} {
  if (!Array.isArray(value) || value.length === 0) {
    throw requestFailure('GitHub GraphQL errors must be a non-empty array.');
  }

  let retryable = true;
  for (const error of value) {
    const record = parseRecord(error, 'GitHub GraphQL error');
    const type = record.type;
    if (type !== 'RATE_LIMITED' && type !== 'INTERNAL' && type !== 'TIMEOUT') {
      retryable = false;
    }
  }
  return {
    retryable,
    message: retryable
      ? 'GitHub GraphQL reported a transient error.'
      : 'GitHub GraphQL reported an operation error.',
  };
}

function parseGraphqlRateLimit(value: unknown): RateLimit {
  if (value === undefined || value === null) return {};
  const record = parseRecord(value, 'GitHub GraphQL rateLimit');
  const remaining = parseOptionalNonnegativeInteger(
    record.remaining,
    'GitHub GraphQL rateLimit.remaining',
  );
  let resetAtMs: number | undefined;
  if (record.resetAt !== undefined) {
    if (typeof record.resetAt !== 'string') {
      throw requestFailure('GitHub GraphQL rateLimit.resetAt is invalid.');
    }
    resetAtMs = Date.parse(record.resetAt);
    if (!Number.isFinite(resetAtMs)) {
      throw requestFailure('GitHub GraphQL rateLimit.resetAt is invalid.');
    }
  }
  return {remaining, resetAtMs};
}

function parseRateLimitHeaders(headers: Headers): RateLimit {
  const remainingValue = headers.get('x-ratelimit-remaining');
  const resetValue = headers.get('x-ratelimit-reset');
  const remaining = parseOptionalIntegerHeader(
    remainingValue,
    'x-ratelimit-remaining',
  );
  const resetSeconds = parseOptionalIntegerHeader(
    resetValue,
    'x-ratelimit-reset',
  );
  return {
    remaining,
    resetAtMs: resetSeconds === undefined ? undefined : resetSeconds * 1_000,
  };
}

function mergeRateLimits(headers: RateLimit, graphql: RateLimit): RateLimit {
  return {
    remaining: graphql.remaining ?? headers.remaining,
    resetAtMs: graphql.resetAtMs ?? headers.resetAtMs,
  };
}

async function waitForRateLimit(
  rateLimit: RateLimit,
  sleep: Sleep,
  now: () => number,
  limits: SafetyLimits,
): Promise<void> {
  if (rateLimit.remaining === undefined || rateLimit.remaining > 0) return;
  if (rateLimit.resetAtMs === undefined) {
    throw requestFailure(
      'GitHub rate limit was exhausted without a reset time.',
    );
  }

  const delay = Math.max(0, rateLimit.resetAtMs - now() + 1_000);
  assertDelayWithinBound(delay, limits);
  await sleep(delay);
}

function parseRestUrl(value: string, allowRelative: boolean): string {
  if (value.length === 0 || value.length > MAX_URL_LENGTH) {
    throw requestFailure('GitHub REST URL violates the safety limit.');
  }
  if (!allowRelative && !value.startsWith(`${GITHUB_API_ORIGIN}/`)) {
    throw requestFailure(
      'GitHub pagination attempted to leave api.github.com.',
    );
  }
  if (allowRelative && (!value.startsWith('/') || value.startsWith('//'))) {
    throw requestFailure('GitHub REST path must be root-relative.');
  }

  const url = new URL(value, GITHUB_API_ORIGIN);
  if (
    url.origin !== GITHUB_API_ORIGIN ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw requestFailure('GitHub REST URL must use api.github.com.');
  }
  return url.toString();
}

function nextLink(headers: Headers): string | undefined {
  const value = headers.get('link');
  if (value === null) return undefined;
  for (const part of value.split(/,(?=\s*<)/u)) {
    const match = /^\s*<([^>]+)>\s*;(.*)$/u.exec(part);
    if (match === null) continue;
    const parameters = match[2];
    if (
      parameters !== undefined &&
      /(?:^|;)\s*rel="?next"?(?:;|$)/u.test(parameters)
    ) {
      return match[1];
    }
  }
  return undefined;
}

function appendBounded<T>(
  destination: T[],
  items: readonly T[],
  maxRecords: number,
): void {
  if (destination.length + items.length > maxRecords) {
    throw requestFailure('GitHub pagination exceeded its record limit.');
  }
  destination.push(...items);
}

async function readJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw requestFailure('GitHub response Content-Length is invalid.');
    }
    if (length > maxBytes) {
      await discardBody(response);
      throw requestFailure('GitHub response exceeded the byte limit.');
    }
  }

  if (response.body === null) {
    throw requestFailure('GitHub response body is missing.');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw requestFailure('GitHub response exceeded the byte limit.');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch (error: unknown) {
    throw requestFailure('GitHub response was not valid UTF-8.', error);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw requestFailure('GitHub response was not valid JSON.', error);
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already unusable; cancellation is best-effort cleanup.
  }
}

function responseRetryDelay(
  headers: Headers,
  attempt: number,
  nowMs: number,
  limits: SafetyLimits,
): number {
  const retryAfter = headers.get('retry-after');
  let delay: number | undefined;
  if (retryAfter !== null) {
    if (/^\d+$/u.test(retryAfter)) {
      delay = Number(retryAfter) * 1_000;
    } else {
      const retryAt = Date.parse(retryAfter);
      if (!Number.isFinite(retryAt)) {
        throw requestFailure('GitHub Retry-After header is invalid.');
      }
      delay = Math.max(0, retryAt - nowMs);
    }
  }

  if (delay === undefined && headers.get('x-ratelimit-remaining') === '0') {
    const reset = headers.get('x-ratelimit-reset');
    if (reset === null || !/^\d+$/u.test(reset)) {
      throw requestFailure('GitHub rate-limit reset header is invalid.');
    }
    delay = Math.max(0, Number(reset) * 1_000 - nowMs + 1_000);
  }

  const selected = delay ?? retryDelay(attempt, limits);
  assertDelayWithinBound(selected, limits);
  return selected;
}

function retryDelay(attempt: number, limits: SafetyLimits): number {
  const delay = BASE_RETRY_DELAY_MS * 2 ** attempt;
  assertDelayWithinBound(delay, limits);
  return delay;
}

function assertDelayWithinBound(delay: number, limits: SafetyLimits): void {
  if (
    !Number.isSafeInteger(delay) ||
    delay < 0 ||
    delay > limits.maxRetryDelayMs
  ) {
    throw requestFailure('GitHub retry delay exceeded its safety limit.');
  }
}

function isTransientStatus(status: number, headers: Headers): boolean {
  return (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    (status === 403 &&
      (headers.has('retry-after') ||
        headers.get('x-ratelimit-remaining') === '0'))
  );
}

function validateGraphqlOperation(operation: GraphqlPage): void {
  validateGraphqlQuery(operation);
  if (
    operation.connectionPath.length === 0 ||
    operation.connectionPath.some(
      component => component.length === 0 || component.trim() !== component,
    )
  ) {
    throw new TypeError('GitHub GraphQL connection path is invalid.');
  }
}

function validateGraphqlQuery(operation: GraphqlQuery): void {
  if (operation.query.trim().length === 0) {
    throw new TypeError('GitHub GraphQL query must not be empty.');
  }
}

function stringifyRequestBody(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (error: unknown) {
    throw requestFailure(
      'GitHub request body was not JSON-serializable.',
      error,
    );
  }
}

function parseToken(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    /\s/u.test(value)
  ) {
    throw new TypeError('GitHub token must be a non-empty token string.');
  }
  return value;
}

function parseLimits(options: GitHubClientOptions): SafetyLimits {
  return {
    maxPages: parsePositiveInteger(
      options.maxPages ?? DEFAULT_MAX_PAGES,
      'maxPages',
    ),
    maxRecords: parsePositiveInteger(
      options.maxRecords ?? DEFAULT_MAX_RECORDS,
      'maxRecords',
    ),
    maxResponseBytes: parsePositiveInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      'maxResponseBytes',
    ),
    maxRetries: parseNonnegativeInteger(
      options.maxRetries ?? DEFAULT_MAX_RETRIES,
      'maxRetries',
    ),
    maxRetryDelayMs: parsePositiveInteger(
      options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
      'maxRetryDelayMs',
    ),
    requestTimeoutMs: parsePositiveInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs',
    ),
  };
}

function parsePositiveInteger(value: unknown, name: string): number {
  const integer = parseNonnegativeInteger(value, name);
  if (integer === 0) throw new TypeError(`${name} must be positive.`);
  return integer;
}

function parseNonnegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

function parseOptionalNonnegativeInteger(
  value: unknown,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  return parseNonnegativeInteger(value, name);
}

function parseOptionalIntegerHeader(
  value: string | null,
  name: string,
): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/u.test(value)) {
    throw requestFailure(`GitHub ${name} header is invalid.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw requestFailure(`GitHub ${name} header is invalid.`);
  }
  return parsed;
}

async function mapConcurrent<T, U>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<U>,
): Promise<readonly U[]> {
  const results: U[] = new Array(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      if (index >= values.length) return;
      nextIndex += 1;
      const value = values[index];
      if (value === undefined) {
        throw new Error('Concurrent work index became inconsistent.');
      }
      results[index] = await operation(value, index);
    }
  }

  await Promise.all(
    Array.from({length: Math.min(concurrency, values.length)}, worker),
  );
  return results;
}

function parseRecord(
  value: unknown,
  context: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw requestFailure(`${context} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requestFailure(message: string, cause?: unknown): Error {
  return new Error(message, cause === undefined ? undefined : {cause});
}

function retryableError(message: string): RetryableError {
  return Object.assign(new Error(message), {[RETRYABLE_ERROR]: true as const});
}

function isRetryableError(value: unknown): value is RetryableError {
  return value instanceof Error && Reflect.get(value, RETRYABLE_ERROR) === true;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
