import {randomUUID} from 'node:crypto';
import {mkdir, open, rename, unlink, type FileHandle} from 'node:fs/promises';
import {basename, dirname, join} from 'node:path';

import {SCORE_RULES} from './constants.js';
import {canonicalJson} from './crypto.js';
import {validateScoringInvariants} from './score.js';
import {
  cycleId,
  parseCanonicalTimestamp,
  type CanonicalTimestamp,
} from './time.js';
import {
  parseRepoId,
  type Award,
  type CollectionWindow,
  type Project,
  type RewardContributor,
  type RunReceipt,
  type ScoreBucket,
  type Snapshot,
  type Usage,
} from './types.js';

type SnapshotWithRewards = Snapshot & {
  readonly rewards?: readonly RewardContributor[];
};

export type SnapshotJsonFormat = 'pretty' | 'compact';

export type WriteSnapshotOptions = {
  readonly outputPath?: string;
  readonly format?: SnapshotJsonFormat;
};

const DEFAULT_SNAPSHOT_PATH = 'dist/snapshot.json';

const PROJECT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CYCLE_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;

const SNAPSHOT_FIELDS = new Set([
  'schemaVersion',
  'generatedAt',
  'window',
  'projects',
  'buckets',
  'awards',
  'receipts',
  'rewards',
]);
const WINDOW_FIELDS = new Set(['from', 'to']);
const PROJECT_FIELDS = new Set([
  'id',
  'name',
  'mission',
  'repositories',
  'reward',
  'allowedModels',
]);
const REPOSITORY_FIELDS = new Set(['id', 'branch']);
const REWARD_CONFIG_FIELDS = new Set([
  'startsAt',
  'token',
  'monthlyPoolBaseUnits',
]);
const TOKEN_FIELDS = new Set(['address', 'decimals', 'symbol']);
const MODEL_FIELDS = new Set(['client', 'provider', 'model']);
const BUCKET_FIELDS = new Set([
  'project',
  'cycle',
  'actor',
  'score',
  'breakdown',
  'counts',
]);
const ACTOR_FIELDS = new Set(['id', 'login']);
const BREAKDOWN_FIELDS = new Set([
  'merged_pr',
  'resolved_issue',
  'test_change',
  'evidence',
  'review',
  'evaluation',
]);
const COUNT_FIELDS = new Set([
  'merged_pr',
  'resolved_issue',
  'test_change',
  'review',
  'evaluation',
]);
const AWARD_BASE_FIELDS = [
  'id',
  'kind',
  'project',
  'repo',
  'cycle',
  'actor',
  'occurredAt',
  'source',
  'points',
  'runId',
] as const;
const STANDARD_AWARD_FIELDS = new Set(AWARD_BASE_FIELDS);
const EVIDENCE_AWARD_FIELDS = new Set([...AWARD_BASE_FIELDS, 'evidenceKind']);
const EVALUATION_AWARD_FIELDS = new Set([
  ...AWARD_BASE_FIELDS,
  'evaluationPoints',
]);
const ALL_AWARD_FIELDS = new Set([
  ...AWARD_BASE_FIELDS,
  'evidenceKind',
  'evaluationPoints',
]);
const SOURCE_FIELDS = new Set(['kind', 'number', 'title']);
const RECEIPT_FIELDS = new Set([
  'version',
  'runId',
  'project',
  'repo',
  'startedAt',
  'completedAt',
  'agent',
  'skill',
  'usage',
  'device',
  'trajectorySha256',
  'signature',
]);
const SKILL_FIELDS = new Set(['revision', 'sha256']);
const USAGE_FIELDS = new Set(['confidence', 'totalTokens', 'costMicroUsd']);
const DEVICE_FIELDS = new Set(['keyId', 'publicKey']);
const REWARD_CONTRIBUTOR_FIELDS = new Set([
  'project',
  'cycle',
  'actorId',
  'canonicalScore',
  'creditedTokens',
  'computeBonusBasisPoints',
  'adjustedWeight',
  'projectedBaseUnits',
]);

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareProjects(left: Project, right: Project): number {
  return compareText(left.id, right.id);
}

function compareBuckets(left: ScoreBucket, right: ScoreBucket): number {
  return (
    compareText(left.project, right.project) ||
    compareText(left.cycle, right.cycle) ||
    right.score - left.score ||
    compareText(left.actor.id, right.actor.id)
  );
}

function compareAwards(left: Award, right: Award): number {
  return (
    compareText(left.occurredAt, right.occurredAt) ||
    compareText(left.id, right.id)
  );
}

function compareReceipts(left: RunReceipt, right: RunReceipt): number {
  return compareText(left.runId, right.runId);
}

function compareRewards(
  left: RewardContributor,
  right: RewardContributor,
): number {
  return (
    compareText(left.project, right.project) ||
    compareText(left.cycle, right.cycle) ||
    right.canonicalScore - left.canonicalScore ||
    compareText(left.actorId, right.actorId)
  );
}

function copyProject(project: Project): Project {
  const copy: Project = {
    id: project.id,
    name: project.name,
    mission: project.mission,
    repositories: project.repositories.map(repository => ({
      id: repository.id,
      branch: repository.branch,
    })),
    allowedModels: project.allowedModels.map(model => ({
      client: model.client,
      provider: model.provider,
      model: model.model,
    })),
  };

  return project.reward === undefined
    ? copy
    : {
        ...copy,
        reward: {
          startsAt: project.reward.startsAt,
          token: {...project.reward.token},
          monthlyPoolBaseUnits: project.reward.monthlyPoolBaseUnits,
        },
      };
}

function copyBucket(bucket: ScoreBucket): ScoreBucket {
  return {
    project: bucket.project,
    cycle: bucket.cycle,
    actor: {id: bucket.actor.id, login: bucket.actor.login},
    score: bucket.score,
    breakdown: {
      merged_pr: bucket.breakdown.merged_pr,
      resolved_issue: bucket.breakdown.resolved_issue,
      test_change: bucket.breakdown.test_change,
      evidence: bucket.breakdown.evidence,
      review: bucket.breakdown.review,
      evaluation: bucket.breakdown.evaluation,
    },
    counts: {
      merged_pr: bucket.counts.merged_pr,
      resolved_issue: bucket.counts.resolved_issue,
      test_change: bucket.counts.test_change,
      review: bucket.counts.review,
      evaluation: bucket.counts.evaluation,
    },
  };
}

function copyAward(award: Award): Award {
  const common = {
    id: award.id,
    project: award.project,
    repo: award.repo,
    cycle: award.cycle,
    actor: {id: award.actor.id, login: award.actor.login},
    occurredAt: award.occurredAt,
    source: {
      kind: award.source.kind,
      number: award.source.number,
      title: award.source.title,
    },
    points: award.points,
    ...(award.runId === undefined ? {} : {runId: award.runId}),
  };

  switch (award.kind) {
    case 'merged_pr':
    case 'resolved_issue':
    case 'test_change':
    case 'review':
      return {...common, kind: award.kind};
    case 'evidence':
      return {
        ...common,
        kind: award.kind,
        evidenceKind: award.evidenceKind,
      };
    case 'evaluation':
      return {
        ...common,
        kind: award.kind,
        evaluationPoints: award.evaluationPoints,
      };
    default:
      return assertNever(award);
  }
}

function copyUsage(usage: Usage): Usage {
  switch (usage.confidence) {
    case 'exact':
    case 'bounded':
      return {
        confidence: usage.confidence,
        totalTokens: usage.totalTokens,
        costMicroUsd: usage.costMicroUsd,
      };
    case 'unavailable':
      return {
        confidence: usage.confidence,
        totalTokens: usage.totalTokens,
        costMicroUsd: usage.costMicroUsd,
      };
    default:
      return assertNever(usage);
  }
}

function copyReceipt(receipt: RunReceipt): RunReceipt {
  const copy: RunReceipt = {
    version: receipt.version,
    runId: receipt.runId,
    project: receipt.project,
    repo: receipt.repo,
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
    agent: {
      client: receipt.agent.client,
      provider: receipt.agent.provider,
      model: receipt.agent.model,
    },
    skill: {
      revision: receipt.skill.revision,
      sha256: receipt.skill.sha256,
    },
    usage: copyUsage(receipt.usage),
    device: {
      keyId: receipt.device.keyId,
      publicKey: receipt.device.publicKey,
    },
    signature: receipt.signature,
  };

  return receipt.trajectorySha256 === undefined
    ? copy
    : {...copy, trajectorySha256: receipt.trajectorySha256};
}

function copyReward(reward: RewardContributor): RewardContributor {
  return {
    project: reward.project,
    cycle: reward.cycle,
    actorId: reward.actorId,
    canonicalScore: reward.canonicalScore,
    creditedTokens: reward.creditedTokens,
    computeBonusBasisPoints: reward.computeBonusBasisPoints,
    adjustedWeight: reward.adjustedWeight,
    projectedBaseUnits: reward.projectedBaseUnits,
  };
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported snapshot value: ${String(value)}`);
}

/**
 * Constructs the public static snapshot from already validated domain values.
 *
 * The returned collections and their nested records are fresh plain data, so
 * sorting never mutates caller-owned arrays or objects. Optional reward
 * projections remain derived output and do not alter canonical score data.
 *
 * @param generatedAt Canonical timestamp at which generation completed.
 * @param window Inclusive collection start and exclusive collection end.
 * @param projects Validated project definitions.
 * @param buckets Canonical actor/project/cycle score buckets.
 * @param awards Accepted score-bearing audit records.
 * @param receipts Accepted, validated, and deduplicated run receipts.
 * @param rewards Optional derived reward projections.
 * @returns A deterministic plain-data snapshot ready for later validation.
 */
export function buildSnapshot(
  generatedAt: CanonicalTimestamp,
  window: CollectionWindow,
  projects: readonly Project[],
  buckets: readonly ScoreBucket[],
  awards: readonly Award[],
  receipts: readonly RunReceipt[],
  rewards?: readonly RewardContributor[],
): SnapshotWithRewards {
  const snapshot: Snapshot = {
    schemaVersion: 3,
    generatedAt,
    window: {from: window.from, to: window.to},
    projects: projects.map(copyProject).sort(compareProjects),
    buckets: buckets.map(copyBucket).sort(compareBuckets),
    awards: awards.map(copyAward).sort(compareAwards),
    receipts: receipts.map(copyReceipt).sort(compareReceipts),
  };

  return rewards === undefined
    ? snapshot
    : {
        ...snapshot,
        rewards: rewards.map(copyReward).sort(compareRewards),
      };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecord(
  value: unknown,
  fields: ReadonlySet<string>,
  context: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${context} must be an object.`);
  }

  const unknownField = Object.keys(value).find(field => !fields.has(field));
  if (unknownField !== undefined) {
    throw new TypeError(`${context} contains unknown field "${unknownField}".`);
  }

  return value;
}

function parseArray(value: unknown, context: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${context} must be an array.`);
  }
  return value;
}

function parseString(value: unknown, context: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${context} must be a string.`);
  }
  return value;
}

function parseNonemptyString(value: unknown, context: string): string {
  const parsed = parseString(value, context);
  if (parsed.length === 0) {
    throw new TypeError(`${context} must not be empty.`);
  }
  return parsed;
}

function parseMission(value: unknown, context: string): string {
  const parsed = parseNonemptyString(value, context);
  if (parsed.trim() !== parsed) {
    throw new TypeError(`${context} must be trimmed.`);
  }
  return parsed;
}

function parseProjectId(value: unknown, context: string): Lowercase<string> {
  if (typeof value !== 'string' || !PROJECT_ID_PATTERN.test(value)) {
    throw new TypeError(`${context} must be a lowercase project id.`);
  }
  return value as Lowercase<string>;
}

function parseCycle(value: unknown, context: string): string {
  if (typeof value !== 'string' || !CYCLE_PATTERN.test(value)) {
    throw new TypeError(`${context} must use YYYY-MM form.`);
  }
  return value;
}

function parseNonNegativeInteger(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${context} must be a non-negative safe integer.`);
  }
  return value;
}

function parsePositiveInteger(value: unknown, context: string): number {
  const parsed = parseNonNegativeInteger(value, context);
  if (parsed === 0) {
    throw new TypeError(`${context} must be positive.`);
  }
  return parsed;
}

function parseIntegerString(value: unknown, context: string): string {
  if (typeof value !== 'string' || !INTEGER_PATTERN.test(value)) {
    throw new TypeError(
      `${context} must be a canonical non-negative integer string.`,
    );
  }
  return value;
}

function parseActor(value: unknown, context: string): ScoreBucket['actor'] {
  const actor = parseRecord(value, ACTOR_FIELDS, context);
  return {
    id: parseNonemptyString(actor.id, `${context}.id`),
    login: parseNonemptyString(actor.login, `${context}.login`),
  };
}

function parseModel(
  value: unknown,
  context: string,
): Project['allowedModels'][number] {
  const model = parseRecord(value, MODEL_FIELDS, context);
  if (model.client !== 'codex' && model.client !== 'claude-code') {
    throw new TypeError(`${context}.client is unsupported.`);
  }
  return {
    client: model.client,
    provider: parseNonemptyString(model.provider, `${context}.provider`),
    model: parseNonemptyString(model.model, `${context}.model`),
  };
}

function parseProject(value: unknown, context: string): Project {
  const project = parseRecord(value, PROJECT_FIELDS, context);
  const repositories = parseArray(
    project.repositories,
    `${context}.repositories`,
  ).map((repositoryValue, index) => {
    const repository = parseRecord(
      repositoryValue,
      REPOSITORY_FIELDS,
      `${context}.repositories[${index}]`,
    );
    return {
      id: parseRepoId(repository.id),
      branch: parseNonemptyString(
        repository.branch,
        `${context}.repositories[${index}].branch`,
      ),
    };
  });
  if (repositories.length === 0) {
    throw new TypeError(`${context}.repositories must not be empty.`);
  }

  const allowedModels = parseArray(
    project.allowedModels,
    `${context}.allowedModels`,
  ).map((model, index) =>
    parseModel(model, `${context}.allowedModels[${index}]`),
  );
  const parsed: Project = {
    id: parseProjectId(project.id, `${context}.id`),
    name: parseNonemptyString(project.name, `${context}.name`),
    mission: parseMission(project.mission, `${context}.mission`),
    repositories,
    allowedModels,
  };

  if (project.reward === undefined) return parsed;
  const reward = parseRecord(
    project.reward,
    REWARD_CONFIG_FIELDS,
    `${context}.reward`,
  );
  const token = parseRecord(
    reward.token,
    TOKEN_FIELDS,
    `${context}.reward.token`,
  );
  if (
    typeof token.address !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(token.address)
  ) {
    throw new TypeError(
      `${context}.reward.token.address must be a 20-byte EVM address.`,
    );
  }
  const decimals = parseNonNegativeInteger(
    token.decimals,
    `${context}.reward.token.decimals`,
  );
  if (decimals > 255) {
    throw new TypeError(
      `${context}.reward.token.decimals must not exceed 255.`,
    );
  }
  const symbol = parseNonemptyString(
    token.symbol,
    `${context}.reward.token.symbol`,
  );
  if (symbol.trim() !== symbol) {
    throw new TypeError(`${context}.reward.token.symbol must be trimmed.`);
  }
  return {
    ...parsed,
    reward: {
      startsAt: parseCanonicalTimestamp(reward.startsAt),
      token: {
        address: token.address as `0x${string}`,
        decimals,
        symbol,
      },
      monthlyPoolBaseUnits: parseIntegerString(
        reward.monthlyPoolBaseUnits,
        `${context}.reward.monthlyPoolBaseUnits`,
      ),
    },
  };
}

function parseBreakdown(
  value: unknown,
  context: string,
): ScoreBucket['breakdown'] {
  const breakdown = parseRecord(value, BREAKDOWN_FIELDS, context);
  return {
    merged_pr: parseNonNegativeInteger(
      breakdown.merged_pr,
      `${context}.merged_pr`,
    ),
    resolved_issue: parseNonNegativeInteger(
      breakdown.resolved_issue,
      `${context}.resolved_issue`,
    ),
    test_change: parseNonNegativeInteger(
      breakdown.test_change,
      `${context}.test_change`,
    ),
    evidence: parseNonNegativeInteger(
      breakdown.evidence,
      `${context}.evidence`,
    ),
    review: parseNonNegativeInteger(breakdown.review, `${context}.review`),
    evaluation: parseNonNegativeInteger(
      breakdown.evaluation,
      `${context}.evaluation`,
    ),
  };
}

function parseCounts(value: unknown, context: string): ScoreBucket['counts'] {
  const counts = parseRecord(value, COUNT_FIELDS, context);
  return {
    merged_pr: parseNonNegativeInteger(
      counts.merged_pr,
      `${context}.merged_pr`,
    ),
    resolved_issue: parseNonNegativeInteger(
      counts.resolved_issue,
      `${context}.resolved_issue`,
    ),
    test_change: parseNonNegativeInteger(
      counts.test_change,
      `${context}.test_change`,
    ),
    review: parseNonNegativeInteger(counts.review, `${context}.review`),
    evaluation: parseNonNegativeInteger(
      counts.evaluation,
      `${context}.evaluation`,
    ),
  };
}

function parseBucket(value: unknown, context: string): ScoreBucket {
  const bucket = parseRecord(value, BUCKET_FIELDS, context);
  return {
    project: parseProjectId(bucket.project, `${context}.project`),
    cycle: parseCycle(bucket.cycle, `${context}.cycle`),
    actor: parseActor(bucket.actor, `${context}.actor`),
    score: parseNonNegativeInteger(bucket.score, `${context}.score`),
    breakdown: parseBreakdown(bucket.breakdown, `${context}.breakdown`),
    counts: parseCounts(bucket.counts, `${context}.counts`),
  };
}

function awardFields(kind: unknown, context: string): ReadonlySet<string> {
  switch (kind) {
    case 'merged_pr':
    case 'resolved_issue':
    case 'test_change':
    case 'review':
      return STANDARD_AWARD_FIELDS;
    case 'evidence':
      return EVIDENCE_AWARD_FIELDS;
    case 'evaluation':
      return EVALUATION_AWARD_FIELDS;
    default:
      throw new TypeError(`${context}.kind is unsupported.`);
  }
}

function parseAward(value: unknown, context: string): Award {
  const unvalidated = parseRecord(value, ALL_AWARD_FIELDS, context);
  const award = parseRecord(
    value,
    awardFields(unvalidated.kind, context),
    context,
  );
  const source = parseRecord(award.source, SOURCE_FIELDS, `${context}.source`);
  const sourceKind = source.kind;
  if (
    sourceKind !== 'pr' &&
    sourceKind !== 'issue' &&
    sourceKind !== 'review'
  ) {
    throw new TypeError(`${context}.source.kind is unsupported.`);
  }

  const common = {
    id: parseNonemptyString(award.id, `${context}.id`),
    project: parseProjectId(award.project, `${context}.project`),
    repo: parseRepoId(award.repo),
    cycle: parseCycle(award.cycle, `${context}.cycle`),
    actor: parseActor(award.actor, `${context}.actor`),
    occurredAt: parseCanonicalTimestamp(award.occurredAt),
    source: {
      kind: sourceKind,
      number: parsePositiveInteger(source.number, `${context}.source.number`),
      title: parseString(source.title, `${context}.source.title`),
    } as const,
    points: parsePositiveInteger(award.points, `${context}.points`),
    ...(award.runId === undefined
      ? {}
      : {runId: parseNonemptyString(award.runId, `${context}.runId`)}),
  };

  if (cycleId(common.occurredAt) !== common.cycle) {
    throw new TypeError(`${context}.cycle does not match occurredAt.`);
  }

  switch (award.kind) {
    case 'merged_pr':
    case 'resolved_issue':
    case 'test_change':
    case 'review':
      return {...common, kind: award.kind};
    case 'evidence':
      if (
        award.evidenceKind !== 'screenshot' &&
        award.evidenceKind !== 'video' &&
        award.evidenceKind !== 'logs' &&
        award.evidenceKind !== 'trajectory' &&
        award.evidenceKind !== 'artifact'
      ) {
        throw new TypeError(`${context}.evidenceKind is unsupported.`);
      }
      return {...common, kind: award.kind, evidenceKind: award.evidenceKind};
    case 'evaluation':
      return {
        ...common,
        kind: award.kind,
        evaluationPoints: parsePositiveInteger(
          award.evaluationPoints,
          `${context}.evaluationPoints`,
        ),
      };
    default:
      throw new TypeError(`${context}.kind is unsupported.`);
  }
}

function parseUsage(value: unknown, context: string): Usage {
  const usage = parseRecord(value, USAGE_FIELDS, context);
  if (usage.confidence === 'unavailable') {
    if (usage.totalTokens !== 0 || usage.costMicroUsd !== '0') {
      throw new TypeError(`${context} unavailable values must be zero.`);
    }
    return {confidence: usage.confidence, totalTokens: 0, costMicroUsd: '0'};
  }
  if (usage.confidence !== 'exact' && usage.confidence !== 'bounded') {
    throw new TypeError(`${context}.confidence is unsupported.`);
  }
  return {
    confidence: usage.confidence,
    totalTokens: parseNonNegativeInteger(
      usage.totalTokens,
      `${context}.totalTokens`,
    ),
    costMicroUsd: parseIntegerString(
      usage.costMicroUsd,
      `${context}.costMicroUsd`,
    ),
  };
}

function parseReceipt(value: unknown, context: string): RunReceipt {
  const receipt = parseRecord(value, RECEIPT_FIELDS, context);
  if (receipt.version !== 1) {
    throw new TypeError(`${context}.version must be 1.`);
  }
  const skill = parseRecord(receipt.skill, SKILL_FIELDS, `${context}.skill`);
  const device = parseRecord(
    receipt.device,
    DEVICE_FIELDS,
    `${context}.device`,
  );
  const startedAt = parseCanonicalTimestamp(receipt.startedAt);
  const completedAt = parseCanonicalTimestamp(receipt.completedAt);
  if (startedAt > completedAt) {
    throw new TypeError(`${context}.completedAt must not precede startedAt.`);
  }

  const parsed: RunReceipt = {
    version: 1,
    runId: parseNonemptyString(receipt.runId, `${context}.runId`),
    project: parseProjectId(receipt.project, `${context}.project`),
    repo: parseRepoId(receipt.repo),
    startedAt,
    completedAt,
    agent: parseModel(receipt.agent, `${context}.agent`),
    skill: {
      revision: parseNonemptyString(
        skill.revision,
        `${context}.skill.revision`,
      ),
      sha256: parseNonemptyString(skill.sha256, `${context}.skill.sha256`),
    },
    usage: parseUsage(receipt.usage, `${context}.usage`),
    device: {
      keyId: parseNonemptyString(device.keyId, `${context}.device.keyId`),
      publicKey: parseNonemptyString(
        device.publicKey,
        `${context}.device.publicKey`,
      ),
    },
    signature: parseNonemptyString(receipt.signature, `${context}.signature`),
  };
  return receipt.trajectorySha256 === undefined
    ? parsed
    : {
        ...parsed,
        trajectorySha256: parseNonemptyString(
          receipt.trajectorySha256,
          `${context}.trajectorySha256`,
        ),
      };
}

function parseRewardContributor(
  value: unknown,
  context: string,
): RewardContributor {
  const reward = parseRecord(value, REWARD_CONTRIBUTOR_FIELDS, context);
  return {
    project: parseProjectId(reward.project, `${context}.project`),
    cycle: parseCycle(reward.cycle, `${context}.cycle`),
    actorId: parseNonemptyString(reward.actorId, `${context}.actorId`),
    canonicalScore: parseNonNegativeInteger(
      reward.canonicalScore,
      `${context}.canonicalScore`,
    ),
    creditedTokens: parseNonNegativeInteger(
      reward.creditedTokens,
      `${context}.creditedTokens`,
    ),
    computeBonusBasisPoints: parseNonNegativeInteger(
      reward.computeBonusBasisPoints,
      `${context}.computeBonusBasisPoints`,
    ),
    adjustedWeight: parseNonNegativeInteger(
      reward.adjustedWeight,
      `${context}.adjustedWeight`,
    ),
    projectedBaseUnits: parseIntegerString(
      reward.projectedBaseUnits,
      `${context}.projectedBaseUnits`,
    ),
  };
}

function bucketKey(project: string, cycle: string, actorId: string): string {
  return JSON.stringify([project, cycle, actorId]);
}

function sameRepository(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function assertUniqueProjectsAndRepositories(
  projects: readonly Project[],
): ReadonlyMap<Project['id'], ReadonlySet<string>> {
  const repositoriesByProject = new Map<Project['id'], ReadonlySet<string>>();
  const repositoryOwners = new Map<string, Project['id']>();
  for (const project of projects) {
    if (repositoriesByProject.has(project.id)) {
      throw new TypeError(`Duplicate project id "${project.id}".`);
    }

    const repositories = new Set<string>();
    for (const repository of project.repositories) {
      const normalized = repository.id.toLowerCase();
      const owner = repositoryOwners.get(normalized);
      if (owner !== undefined) {
        throw new TypeError(
          `Repository "${repository.id}" has duplicate ownership by "${owner}" and "${project.id}".`,
        );
      }
      repositories.add(normalized);
      repositoryOwners.set(normalized, project.id);
    }
    repositoriesByProject.set(project.id, repositories);
  }
  return repositoriesByProject;
}

function assertOwnedRepository(
  project: string,
  repository: string,
  repositoriesByProject: ReadonlyMap<string, ReadonlySet<string>>,
  context: string,
): void {
  const repositories = repositoriesByProject.get(project);
  if (
    repositories === undefined ||
    !repositories.has(repository.toLowerCase())
  ) {
    throw new TypeError(`${context} refers to an unowned repository.`);
  }
}

function expectedAwardPoints(award: Award): number | null {
  switch (award.kind) {
    case 'merged_pr':
      return SCORE_RULES.mergedPullRequest.points;
    case 'resolved_issue':
      return SCORE_RULES.resolvedIssue.points;
    case 'test_change':
      return SCORE_RULES.materialTestChange.points;
    case 'review':
      return SCORE_RULES.substantiveReview.points;
    case 'evidence':
      return null;
    case 'evaluation':
      return Math.min(
        award.evaluationPoints,
        SCORE_RULES.evaluatedContribution.maximumPoints,
      );
    default:
      return assertNever(award);
  }
}

function assertAwardLedgerMatchesBuckets(
  buckets: readonly ScoreBucket[],
  awards: readonly Award[],
): void {
  const bucketsByKey = new Map<string, ScoreBucket>();
  const ledgerByKey = new Map<
    string,
    {
      breakdown: Record<keyof ScoreBucket['breakdown'], number>;
      counts: Record<keyof ScoreBucket['counts'], number>;
    }
  >();
  for (const bucket of buckets) {
    const key = bucketKey(bucket.project, bucket.cycle, bucket.actor.id);
    if (bucketsByKey.has(key)) {
      throw new TypeError(`Duplicate score bucket ${key}.`);
    }
    bucketsByKey.set(key, bucket);
  }

  for (const award of awards) {
    const key = bucketKey(award.project, award.cycle, award.actor.id);
    if (!bucketsByKey.has(key)) {
      throw new TypeError(`Award "${award.id}" has no matching bucket.`);
    }
    const expectedPoints = expectedAwardPoints(award);
    if (expectedPoints !== null && award.points !== expectedPoints) {
      throw new TypeError(`Award "${award.id}" has invalid points.`);
    }
    if (
      award.kind === 'evidence' &&
      award.points > SCORE_RULES.evidence.weights[award.evidenceKind]
    ) {
      throw new TypeError(`Award "${award.id}" has invalid evidence points.`);
    }

    const ledger = ledgerByKey.get(key) ?? {
      breakdown: {
        merged_pr: 0,
        resolved_issue: 0,
        test_change: 0,
        evidence: 0,
        review: 0,
        evaluation: 0,
      },
      counts: {
        merged_pr: 0,
        resolved_issue: 0,
        test_change: 0,
        review: 0,
        evaluation: 0,
      },
    };
    ledger.breakdown[award.kind] += award.points;
    if (award.kind !== 'evidence') ledger.counts[award.kind] += 1;
    ledgerByKey.set(key, ledger);
  }

  for (const [key, bucket] of bucketsByKey) {
    const ledger = ledgerByKey.get(key) ?? {
      breakdown: {
        merged_pr: 0,
        resolved_issue: 0,
        test_change: 0,
        evidence: 0,
        review: 0,
        evaluation: 0,
      },
      counts: {
        merged_pr: 0,
        resolved_issue: 0,
        test_change: 0,
        review: 0,
        evaluation: 0,
      },
    };
    for (const category of BREAKDOWN_FIELDS) {
      const typedCategory = category as keyof ScoreBucket['breakdown'];
      if (bucket.breakdown[typedCategory] !== ledger.breakdown[typedCategory]) {
        throw new TypeError(`Bucket ${key} breakdown does not match awards.`);
      }
    }
    for (const category of COUNT_FIELDS) {
      const typedCategory = category as keyof ScoreBucket['counts'];
      if (bucket.counts[typedCategory] !== ledger.counts[typedCategory]) {
        throw new TypeError(`Bucket ${key} counts do not match awards.`);
      }
    }
  }
}

/**
 * Validates the complete, intentionally small static snapshot boundary.
 *
 * This checks exact object shapes, canonical scalar forms, uniqueness,
 * project/repository ownership, cross-record references, and the complete
 * bucket-to-award scoring ledger. It deliberately does not repeat GitHub
 * ingestion or receipt-signature validation and performs no writing.
 *
 * @param value Untrusted value that is about to be serialized or was parsed.
 * @returns The original value narrowed to the validated snapshot contract.
 */
export function validateSnapshot(value: unknown): SnapshotWithRewards {
  const snapshot = parseRecord(value, SNAPSHOT_FIELDS, 'Snapshot');
  if (snapshot.schemaVersion !== 3) {
    throw new TypeError('Snapshot schemaVersion must be 3.');
  }
  parseCanonicalTimestamp(snapshot.generatedAt);

  const window = parseRecord(snapshot.window, WINDOW_FIELDS, 'Snapshot window');
  const from = parseCanonicalTimestamp(window.from);
  const to = parseCanonicalTimestamp(window.to);
  if (from >= to) {
    throw new TypeError('Snapshot window.from must precede window.to.');
  }

  const projects = parseArray(snapshot.projects, 'Snapshot projects').map(
    (project, index) => parseProject(project, `Snapshot projects[${index}]`),
  );
  const repositoriesByProject = assertUniqueProjectsAndRepositories(projects);

  const buckets = parseArray(snapshot.buckets, 'Snapshot buckets').map(
    (bucket, index) => parseBucket(bucket, `Snapshot buckets[${index}]`),
  );
  for (const [index, bucket] of buckets.entries()) {
    if (!repositoriesByProject.has(bucket.project)) {
      throw new TypeError(
        `Snapshot buckets[${index}] refers to a missing project.`,
      );
    }
  }

  const awardIds = new Set<string>();
  const awards = parseArray(snapshot.awards, 'Snapshot awards').map(
    (award, index) => {
      const parsed = parseAward(award, `Snapshot awards[${index}]`);
      if (awardIds.has(parsed.id)) {
        throw new TypeError(`Duplicate award id "${parsed.id}".`);
      }
      awardIds.add(parsed.id);
      if (parsed.occurredAt < from || parsed.occurredAt >= to) {
        throw new TypeError(
          `Snapshot awards[${index}].occurredAt is outside the snapshot window.`,
        );
      }
      assertOwnedRepository(
        parsed.project,
        parsed.repo,
        repositoriesByProject,
        `Snapshot awards[${index}]`,
      );
      return parsed;
    },
  );

  const receiptIds = new Set<string>();
  const receipts = parseArray(snapshot.receipts, 'Snapshot receipts').map(
    (receipt, index) => {
      const parsed = parseReceipt(receipt, `Snapshot receipts[${index}]`);
      if (receiptIds.has(parsed.runId)) {
        throw new TypeError(`Duplicate receipt runId "${parsed.runId}".`);
      }
      receiptIds.add(parsed.runId);
      assertOwnedRepository(
        parsed.project,
        parsed.repo,
        repositoriesByProject,
        `Snapshot receipts[${index}]`,
      );
      return parsed;
    },
  );

  const receiptsById = new Map(
    receipts.map(receipt => [receipt.runId, receipt] as const),
  );
  for (const award of awards) {
    if (award.runId === undefined) continue;
    const receipt = receiptsById.get(award.runId);
    if (receipt === undefined) {
      throw new TypeError(
        `Award "${award.id}" refers to missing receipt "${award.runId}".`,
      );
    }
    if (
      receipt.project !== award.project ||
      !sameRepository(receipt.repo, award.repo)
    ) {
      throw new TypeError(
        `Award "${award.id}" does not match its linked receipt.`,
      );
    }
  }

  assertAwardLedgerMatchesBuckets(buckets, awards);
  validateScoringInvariants(buckets, awards);

  if (snapshot.rewards !== undefined) {
    const rewards = parseArray(snapshot.rewards, 'Snapshot rewards').map(
      (reward, index) =>
        parseRewardContributor(reward, `Snapshot rewards[${index}]`),
    );
    const bucketsByKey = new Map(
      buckets.map(bucket => [
        bucketKey(bucket.project, bucket.cycle, bucket.actor.id),
        bucket,
      ]),
    );
    const rewardKeys = new Set<string>();
    for (const reward of rewards) {
      const key = bucketKey(reward.project, reward.cycle, reward.actorId);
      if (rewardKeys.has(key)) {
        throw new TypeError(`Duplicate reward contributor ${key}.`);
      }
      rewardKeys.add(key);
      const bucket = bucketsByKey.get(key);
      if (bucket === undefined || bucket.score !== reward.canonicalScore) {
        throw new TypeError(
          `Reward contributor ${key} does not match a score bucket.`,
        );
      }
    }
  }

  return value as SnapshotWithRewards;
}

function parseWriteSnapshotOptions(
  destination: string | WriteSnapshotOptions,
): Required<WriteSnapshotOptions> {
  const outputPath =
    typeof destination === 'string'
      ? destination
      : (destination.outputPath ?? DEFAULT_SNAPSHOT_PATH);
  const format =
    typeof destination === 'string'
      ? 'pretty'
      : (destination.format ?? 'pretty');

  if (outputPath.length === 0) {
    throw new TypeError('Snapshot output path must not be empty.');
  }
  if (format !== 'pretty' && format !== 'compact') {
    throw new TypeError('Snapshot JSON format must be "pretty" or "compact".');
  }
  return {outputPath, format};
}

function serializeSnapshot(
  snapshot: SnapshotWithRewards,
  format: SnapshotJsonFormat,
): string {
  const compact = canonicalJson(snapshot);
  if (format === 'compact') return compact;

  const parsed: unknown = JSON.parse(compact);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

async function removeTemporaryFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error: unknown) {
    if (!(
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT'
    )) {
      throw error;
    }
  }
}

/**
 * Validates, deterministically serializes, and atomically writes a snapshot.
 *
 * The temporary file is created beside the destination so the final rename is
 * atomic on the destination filesystem. Its contents are flushed and the file
 * is closed before replacement. Any failure before the rename removes the
 * temporary file and leaves an existing destination untouched.
 *
 * @param snapshot Snapshot value to validate and write.
 * @param destination Output path or formatting options.
 */
export async function writeSnapshot(
  snapshot: unknown,
  destination: string | WriteSnapshotOptions = {},
): Promise<void> {
  const validated = validateSnapshot(snapshot);
  const {outputPath, format} = parseWriteSnapshotOptions(destination);
  const serialized = serializeSnapshot(validated, format);
  const directory = dirname(outputPath);
  const temporaryPath = join(
    directory,
    `.${basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );

  await mkdir(directory, {recursive: true});

  let temporaryFile: FileHandle | undefined;
  let ownsTemporaryFile = false;
  try {
    temporaryFile = await open(temporaryPath, 'wx', 0o644);
    ownsTemporaryFile = true;
    await temporaryFile.writeFile(serialized, 'utf8');
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;
    await rename(temporaryPath, outputPath);
  } catch (error: unknown) {
    try {
      await temporaryFile?.close();
    } finally {
      if (ownsTemporaryFile) await removeTemporaryFile(temporaryPath);
    }
    throw error;
  }
}
