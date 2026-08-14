import {readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';

import {parseCanonicalTimestamp} from './time.js';
import {
  parseRepoId,
  type Project,
  type ProjectModel,
  type ProjectRepository,
  type RepoId,
  type RewardConfig,
  type RewardFunding,
} from './types.js';

const PROJECT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;
const INVALID_BRANCH_CHARACTER_PATTERN = /[~^:?*[\]\\]/;

const PROJECT_FIELDS = new Set([
  'id',
  'name',
  'mission',
  'repositories',
  'reward',
  'allowedModels',
]);
const REPOSITORY_FIELDS = new Set(['id', 'branch']);
const REWARD_FIELDS = new Set([
  'startsAt',
  'token',
  'monthlyPoolBaseUnits',
  'funding',
]);
const TOKEN_FIELDS = new Set(['address', 'decimals', 'symbol']);
const MODEL_FIELDS = new Set(['client', 'provider', 'model']);
const PLEDGED_FUNDING_FIELDS = new Set(['status', 'settlement', 'unusedFunds']);
const COMMITTED_FUNDING_FIELDS = new Set([
  'status',
  'settlement',
  'committedBaseUnits',
  'unusedFunds',
]);

type LoadedProjects = {
  readonly projects: readonly Project[];
  readonly projectsByRepo: ReadonlyMap<RepoId, Project>;
};

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecord(
  value: unknown,
  allowedFields: ReadonlySet<string>,
  context: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${context} must be an object.`);
  }

  const unknownField = Object.keys(value).find(
    field => !allowedFields.has(field),
  );
  if (unknownField !== undefined) {
    throw new TypeError(`${context} contains unknown field "${unknownField}".`);
  }

  return value;
}

function parseNonemptyString(value: unknown, context: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw new TypeError(`${context} must be a non-empty trimmed string.`);
  }

  return value;
}

function parseProjectId(value: unknown, context: string): Lowercase<string> {
  if (typeof value !== 'string' || !PROJECT_ID_PATTERN.test(value)) {
    throw new TypeError(
      `${context} must be a lowercase identifier using letters, digits, and single hyphens.`,
    );
  }

  return value as Lowercase<string>;
}

function parseBranch(value: unknown, context: string): string {
  const branch = parseNonemptyString(value, context);
  const components = branch.split('/');
  const containsControlCharacter = [...branch].some(character => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 32 || codePoint === 127);
  });
  if (
    branch.startsWith('-') ||
    branch.endsWith('.') ||
    branch === '@' ||
    branch.includes('..') ||
    branch.includes('@{') ||
    containsControlCharacter ||
    INVALID_BRANCH_CHARACTER_PATTERN.test(branch) ||
    components.some(
      component =>
        component.length === 0 ||
        component.startsWith('.') ||
        component.endsWith('.lock'),
    )
  ) {
    throw new TypeError(`${context} is not a valid Git branch name.`);
  }

  return branch;
}

function parseRepository(value: unknown, context: string): ProjectRepository {
  const record = parseRecord(value, REPOSITORY_FIELDS, context);

  return {
    id: parseRepoId(record.id),
    branch: parseBranch(record.branch, `${context}.branch`),
  };
}

function parseFunding(value: unknown, context: string): RewardFunding {
  if (!isRecord(value)) {
    throw new TypeError(`${context} must be an object.`);
  }
  if (value.status === 'pledged') {
    const funding = parseRecord(value, PLEDGED_FUNDING_FIELDS, context);
    if (
      funding.settlement !== 'proposal-only' ||
      funding.unusedFunds !== 'rollover-without-cap-increase'
    ) {
      throw new TypeError(`${context} pledged policy is invalid.`);
    }
    return {
      status: 'pledged',
      settlement: 'proposal-only',
      unusedFunds: 'rollover-without-cap-increase',
    };
  }
  if (value.status === 'committed') {
    const funding = parseRecord(value, COMMITTED_FUNDING_FIELDS, context);
    if (
      funding.settlement !== 'owner-executed' ||
      funding.unusedFunds !== 'rollover-without-cap-increase' ||
      typeof funding.committedBaseUnits !== 'string' ||
      !INTEGER_PATTERN.test(funding.committedBaseUnits) ||
      funding.committedBaseUnits === '0'
    ) {
      throw new TypeError(`${context} committed policy is invalid.`);
    }
    return {
      status: 'committed',
      settlement: 'owner-executed',
      committedBaseUnits: funding.committedBaseUnits,
      unusedFunds: 'rollover-without-cap-increase',
    };
  }
  throw new TypeError(`${context}.status is unsupported.`);
}

function parseReward(value: unknown, context: string): RewardConfig {
  const record = parseRecord(value, REWARD_FIELDS, context);
  if (
    typeof record.monthlyPoolBaseUnits !== 'string' ||
    !INTEGER_PATTERN.test(record.monthlyPoolBaseUnits)
  ) {
    throw new TypeError(
      `${context}.monthlyPoolBaseUnits must be a canonical non-negative base-10 integer string.`,
    );
  }
  const token = parseRecord(record.token, TOKEN_FIELDS, `${context}.token`);
  if (
    typeof token.address !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(token.address)
  ) {
    throw new TypeError(
      `${context}.token.address must be a 20-byte EVM address.`,
    );
  }
  if (
    typeof token.decimals !== 'number' ||
    !Number.isSafeInteger(token.decimals) ||
    token.decimals < 0 ||
    token.decimals > 255
  ) {
    throw new TypeError(
      `${context}.token.decimals must be an integer from 0 to 255.`,
    );
  }

  const funding =
    record.funding === undefined
      ? undefined
      : parseFunding(record.funding, `${context}.funding`);
  return {
    startsAt: parseCanonicalTimestamp(record.startsAt),
    token: {
      address: token.address as `0x${string}`,
      decimals: token.decimals,
      symbol: parseNonemptyString(token.symbol, `${context}.token.symbol`),
    },
    monthlyPoolBaseUnits: record.monthlyPoolBaseUnits,
    ...(funding === undefined ? {} : {funding}),
  };
}

function parseModel(value: unknown, context: string): ProjectModel {
  const record = parseRecord(value, MODEL_FIELDS, context);
  if (record.client !== 'codex' && record.client !== 'claude-code') {
    throw new TypeError(`${context}.client is not supported.`);
  }

  return {
    client: record.client,
    provider: parseNonemptyString(record.provider, `${context}.provider`),
    model: parseNonemptyString(record.model, `${context}.model`),
  };
}

function parseProject(value: unknown, source: string): Project {
  const record = parseRecord(value, PROJECT_FIELDS, `Project in ${source}`);
  const id = parseProjectId(record.id, `Project id in ${source}`);
  const name = parseNonemptyString(record.name, `Project ${id}.name`);
  const mission = parseNonemptyString(record.mission, `Project ${id}.mission`);

  if (!Array.isArray(record.repositories) || record.repositories.length === 0) {
    throw new TypeError(
      `Project ${id}.repositories must be a non-empty array.`,
    );
  }
  const repositories = record.repositories.map((repository, index) =>
    parseRepository(repository, `Project ${id}.repositories[${index}]`),
  );

  if (!Array.isArray(record.allowedModels)) {
    throw new TypeError(`Project ${id}.allowedModels must be an array.`);
  }
  const allowedModels = record.allowedModels.map((model, index) =>
    parseModel(model, `Project ${id}.allowedModels[${index}]`),
  );
  const modelKeys = new Set<string>();
  for (const model of allowedModels) {
    const key = JSON.stringify([model.client, model.provider, model.model]);
    if (modelKeys.has(key)) {
      throw new TypeError(`Project ${id} contains a duplicate allowed model.`);
    }
    modelKeys.add(key);
  }

  const project: Project = {
    id,
    name,
    mission,
    repositories,
    allowedModels,
  };
  if (record.reward !== undefined) {
    return {
      ...project,
      reward: parseReward(record.reward, `Project ${id}.reward`),
    };
  }

  return project;
}

/**
 * Loads and validates all direct JSON project definitions in a directory.
 *
 * Repository ownership and map keys follow GitHub's case-insensitive semantics,
 * while repository ids in validated project values retain their source spelling.
 *
 * @param projectsDirectory Directory containing the project JSON definitions.
 * @returns Projects sorted by id and their unique repository ownership map.
 */
export async function loadProjects(
  projectsDirectory = 'projects',
): Promise<LoadedProjects> {
  const entries = await readdir(projectsDirectory, {withFileTypes: true});
  const filenames = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => entry.name)
    .sort(compareText);

  const projects = await Promise.all(
    filenames.map(async filename => {
      const path = join(projectsDirectory, filename);
      const contents = await readFile(path, 'utf8');
      let value: unknown;
      try {
        value = JSON.parse(contents);
      } catch {
        throw new TypeError(`Project file ${filename} is not valid JSON.`);
      }
      return parseProject(value, filename);
    }),
  );
  projects.sort((left, right) => compareText(left.id, right.id));

  const projectIds = new Set<string>();
  const projectsByRepo = new Map<RepoId, Project>();
  for (const project of projects) {
    if (projectIds.has(project.id)) {
      throw new TypeError(`Duplicate project id "${project.id}".`);
    }
    projectIds.add(project.id);

    for (const repository of project.repositories) {
      const normalizedId = repository.id.toLowerCase();
      const normalizedRepoId = normalizedId as RepoId;
      const owner = projectsByRepo.get(normalizedRepoId);
      if (owner !== undefined) {
        throw new TypeError(
          `Repository "${repository.id}" is claimed by both "${owner.id}" and "${project.id}".`,
        );
      }
      projectsByRepo.set(normalizedRepoId, project);
    }
  }

  return {projects, projectsByRepo};
}

/**
 * Finds the validated project that owns a GitHub repository.
 *
 * @param repoId Repository identifier, matched using GitHub's case-insensitive
 *     semantics.
 * @param projectsByRepo Unique ownership map produced by {@link loadProjects}.
 * @returns The owning project, or undefined when the repository is unowned.
 */
export function projectForRepo(
  repoId: RepoId,
  projectsByRepo: ReadonlyMap<RepoId, Project>,
): Project | undefined {
  return projectsByRepo.get(repoId.toLowerCase() as RepoId);
}
