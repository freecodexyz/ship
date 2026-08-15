import {canonicalJson, verifyReceiptSignature} from './crypto.js';
import {parseCanonicalTimestamp} from './time.js';
import {
  parseRepoId,
  type Actor,
  type Project,
  type ProjectModel,
  type PullRequest,
  type RunReceipt,
  type Usage,
} from './types.js';

const MARKER_NAME = 'ship-receipt';
const MARKER_PATTERN = /^\s*<!-- ship-receipt: (\{.*\}) -->\s*$/;
const PROJECT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NON_NEGATIVE_INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SKILL_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

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
const AGENT_FIELDS = new Set(['client', 'provider', 'model']);
const SKILL_FIELDS = new Set(['revision', 'sha256']);
const USAGE_FIELDS = new Set(['confidence', 'totalTokens', 'costMicroUsd']);
const DEVICE_FIELDS = new Set(['keyId', 'publicKey']);

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

function parseString(value: unknown, context: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${context} must be a string.`);
  }

  return value;
}

function parseProjectId(value: unknown): Lowercase<string> {
  if (typeof value !== 'string' || !PROJECT_ID_PATTERN.test(value)) {
    throw new TypeError('Receipt project must be a lowercase project id.');
  }

  return value as Lowercase<string>;
}

function parseAgent(value: unknown): ProjectModel {
  const agent = parseRecord(value, AGENT_FIELDS, 'Receipt agent');
  if (agent.client !== 'codex' && agent.client !== 'claude-code') {
    throw new TypeError('Receipt agent.client is unsupported.');
  }

  return {
    client: agent.client,
    provider: parseString(agent.provider, 'Receipt agent.provider'),
    model: parseString(agent.model, 'Receipt agent.model'),
  };
}

function parseUsage(value: unknown): Usage {
  const usage = parseRecord(value, USAGE_FIELDS, 'Receipt usage');
  const {confidence, totalTokens, costMicroUsd} = usage;

  if (confidence === 'unavailable') {
    if (totalTokens !== 0 || costMicroUsd !== '0') {
      throw new TypeError(
        'Unavailable receipt usage must contain zero values.',
      );
    }
    return {confidence, totalTokens, costMicroUsd};
  }

  if (confidence !== 'exact' && confidence !== 'bounded') {
    throw new TypeError('Receipt usage.confidence is unsupported.');
  }
  if (
    typeof totalTokens !== 'number' ||
    !Number.isSafeInteger(totalTokens) ||
    totalTokens < 0
  ) {
    throw new TypeError(
      'Receipt usage.totalTokens must be a non-negative safe integer.',
    );
  }
  if (
    typeof costMicroUsd !== 'string' ||
    !NON_NEGATIVE_INTEGER_PATTERN.test(costMicroUsd)
  ) {
    throw new TypeError(
      'Receipt usage.costMicroUsd must be a canonical non-negative integer string.',
    );
  }

  return {confidence, totalTokens, costMicroUsd};
}

function parseReceipt(value: unknown): RunReceipt {
  const receipt = parseRecord(value, RECEIPT_FIELDS, 'Receipt');
  if (receipt.version !== 1) {
    throw new TypeError('Receipt version must be 1.');
  }

  const skill = parseRecord(receipt.skill, SKILL_FIELDS, 'Receipt skill');
  const device = parseRecord(receipt.device, DEVICE_FIELDS, 'Receipt device');
  const parsed: RunReceipt = {
    version: receipt.version,
    runId: parseString(receipt.runId, 'Receipt runId'),
    project: parseProjectId(receipt.project),
    repo: parseRepoId(receipt.repo),
    startedAt: parseCanonicalTimestamp(receipt.startedAt),
    completedAt: parseCanonicalTimestamp(receipt.completedAt),
    agent: parseAgent(receipt.agent),
    skill: {
      revision: parseString(skill.revision, 'Receipt skill.revision'),
      sha256: parseString(skill.sha256, 'Receipt skill.sha256'),
    },
    usage: parseUsage(receipt.usage),
    device: {
      keyId: parseString(device.keyId, 'Receipt device.keyId'),
      publicKey: parseString(device.publicKey, 'Receipt device.publicKey'),
    },
    signature: parseString(receipt.signature, 'Receipt signature'),
  };

  if (receipt.trajectorySha256 !== undefined) {
    return {
      ...parsed,
      trajectorySha256: parseString(
        receipt.trajectorySha256,
        'Receipt trajectorySha256',
      ),
    };
  }

  return parsed;
}

function acceptedProseLines(body: string): readonly string[] {
  const accepted: string[] = [];
  let fence: {readonly character: '`' | '~'; readonly length: number} | null =
    null;

  for (const line of body.split(/\r?\n/)) {
    if (/^\s{0,3}>/.test(line)) continue;

    if (fence !== null) {
      const closingPattern = new RegExp(
        `^\\s{0,3}${fence.character}{${fence.length},}\\s*$`,
      );
      if (closingPattern.test(line)) fence = null;
      continue;
    }

    const opening = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    const delimiter = opening?.[1];
    if (delimiter !== undefined) {
      const character = delimiter[0];
      if (character === '`' || character === '~') {
        fence = {character, length: delimiter.length};
      }
      continue;
    }

    accepted.push(line);
  }

  return accepted;
}

/**
 * Extracts the sole supported signed-run receipt from pull-request prose.
 *
 * A marker is a standalone `<!-- ship-receipt: {canonical-json} -->` line.
 * Markers shown in Markdown fenced code blocks or blockquotes are examples and
 * are ignored. Any other occurrence of the marker name is unsupported.
 *
 * @param body Accepted pull-request body or contribution footer.
 * @returns The structurally validated canonical receipt.
 */
export function parseReceiptMarker(body: string): RunReceipt {
  const payloads: string[] = [];
  let unsupportedMarker = false;

  for (const line of acceptedProseLines(body)) {
    const marker = MARKER_PATTERN.exec(line);
    const payload = marker?.[1];
    if (payload !== undefined) {
      payloads.push(payload);
    } else if (line.toLowerCase().includes(MARKER_NAME)) {
      unsupportedMarker = true;
    }
  }

  if (unsupportedMarker) {
    throw new TypeError(
      'Receipt marker is malformed, ambiguous, or unsupported.',
    );
  }
  if (payloads.length !== 1) {
    throw new TypeError(
      payloads.length === 0
        ? 'Expected exactly one receipt marker.'
        : 'Duplicate receipt markers are not supported.',
    );
  }

  const payload = payloads[0];
  if (payload === undefined) {
    throw new TypeError('Expected exactly one receipt marker.');
  }

  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new TypeError('Receipt marker payload is not valid JSON.');
  }
  if (canonicalJson(value) !== payload) {
    throw new TypeError('Receipt marker payload is not canonical JSON.');
  }

  return parseReceipt(value);
}

function sameRepository(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function isAllowedModel(receipt: RunReceipt, project: Project): boolean {
  return project.allowedModels.some(
    model =>
      model.client === receipt.agent.client &&
      model.provider === receipt.agent.provider &&
      model.model === receipt.agent.model,
  );
}

/**
 * Validates a parsed signed-run receipt against its project and pull request.
 *
 * This function is pure: receipt rejection has no effect on the pull request or
 * its independently earned GitHub score. Callers may omit a rejected receipt
 * from compute-reward and snapshot inputs while continuing to process the pull
 * request itself.
 *
 * @param receipt Structurally parsed receipt to validate.
 * @param project Trusted project configuration for the pull request.
 * @param pullRequest Normalized accepted pull request containing the marker.
 * @returns The exact receipt object supplied by the caller.
 */
export function validateReceipt(
  receipt: RunReceipt,
  project: Project,
  pullRequest: PullRequest,
): RunReceipt {
  const parsed = parseReceipt(receipt);

  if (!RUN_ID_PATTERN.test(parsed.runId)) {
    throw new TypeError('Receipt runId has an invalid format.');
  }

  const startedAt = parseCanonicalTimestamp(parsed.startedAt);
  const completedAt = parseCanonicalTimestamp(parsed.completedAt);
  const mergedAt = parseCanonicalTimestamp(pullRequest.mergedAt);
  if (startedAt > completedAt) {
    throw new TypeError('Receipt completedAt must not precede startedAt.');
  }
  if (completedAt > mergedAt) {
    throw new TypeError(
      'Receipt completedAt must not follow pull-request merge.',
    );
  }

  if (parsed.project !== project.id) {
    throw new TypeError('Receipt project does not match the current project.');
  }

  const receiptRepo = parseRepoId(parsed.repo);
  const pullRequestRepo = parseRepoId(pullRequest.repo);
  const repository = project.repositories.find(candidate =>
    sameRepository(candidate.id, pullRequestRepo),
  );
  if (repository === undefined) {
    throw new TypeError('Pull-request repository is not owned by the project.');
  }
  const receiptMatchesCurrent = sameRepository(receiptRepo, repository.id);
  const receiptMatchesPrevious = repository.previousIds?.some(
    previous =>
      sameRepository(receiptRepo, previous.id) &&
      completedAt <= parseCanonicalTimestamp(previous.retiredAt),
  );
  if (!receiptMatchesCurrent && receiptMatchesPrevious !== true) {
    throw new TypeError(
      'Receipt repository does not match the pull request repository lineage at completion time.',
    );
  }

  if (!isAllowedModel(parsed, project)) {
    throw new TypeError('Receipt agent model is not allowed by the project.');
  }
  if (!SKILL_REVISION_PATTERN.test(parsed.skill.revision)) {
    throw new TypeError('Receipt skill revision has an invalid format.');
  }
  if (!SHA256_PATTERN.test(parsed.skill.sha256)) {
    throw new TypeError('Receipt skill digest must be lowercase SHA-256 hex.');
  }

  parseUsage(parsed.usage);
  if (
    parsed.trajectorySha256 !== undefined &&
    !SHA256_PATTERN.test(parsed.trajectorySha256)
  ) {
    throw new TypeError(
      'Receipt trajectory digest must be lowercase SHA-256 hex.',
    );
  }

  if (
    typeof parsed.device.keyId !== 'string' ||
    typeof parsed.device.publicKey !== 'string' ||
    typeof parsed.signature !== 'string'
  ) {
    throw new TypeError('Receipt device key fields are invalid.');
  }

  let signatureIsValid = false;
  try {
    signatureIsValid = verifyReceiptSignature(receipt);
  } catch {
    signatureIsValid = false;
  }
  if (!signatureIsValid) {
    throw new TypeError('Receipt Ed25519 signature is invalid.');
  }

  return receipt;
}

type AttributedReceipt = {
  readonly receipt: RunReceipt;
  readonly actor: Actor;
};

/**
 * Removes duplicate receipts and rejects conflicted run or device identities.
 *
 * Every input receipt must already have passed {@link validateReceipt}. Exact
 * duplicate run receipts collapse to their first occurrence. If a run id has
 * more than one canonical representation, every use of that run id is
 * rejected. Likewise, every receipt from a device key attributed to more than
 * one stable GitHub actor id is rejected.
 *
 * @param attributedReceipts Validated receipts and their pull-request authors.
 * @returns Accepted receipts in first-discovery order.
 */
export function dedupeReceipts(
  attributedReceipts: readonly AttributedReceipt[],
): RunReceipt[] {
  const canonicalReceiptByRunId = new Map<string, string>();
  const actorIdByDeviceKeyId = new Map<string, string>();
  const conflictedRunIds = new Set<string>();
  const conflictedDeviceKeyIds = new Set<string>();

  for (const {receipt, actor} of attributedReceipts) {
    const canonicalReceipt = canonicalJson(receipt);
    const existingCanonicalReceipt = canonicalReceiptByRunId.get(receipt.runId);
    if (
      existingCanonicalReceipt !== undefined &&
      existingCanonicalReceipt !== canonicalReceipt
    ) {
      conflictedRunIds.add(receipt.runId);
    } else if (existingCanonicalReceipt === undefined) {
      canonicalReceiptByRunId.set(receipt.runId, canonicalReceipt);
    }

    const existingActorId = actorIdByDeviceKeyId.get(receipt.device.keyId);
    if (existingActorId !== undefined && existingActorId !== actor.id) {
      conflictedDeviceKeyIds.add(receipt.device.keyId);
    } else if (existingActorId === undefined) {
      actorIdByDeviceKeyId.set(receipt.device.keyId, actor.id);
    }
  }

  const acceptedRunIds = new Set<string>();
  const acceptedReceipts: RunReceipt[] = [];
  for (const {receipt} of attributedReceipts) {
    if (
      conflictedRunIds.has(receipt.runId) ||
      conflictedDeviceKeyIds.has(receipt.device.keyId) ||
      acceptedRunIds.has(receipt.runId)
    ) {
      continue;
    }

    acceptedRunIds.add(receipt.runId);
    acceptedReceipts.push(receipt);
  }

  return acceptedReceipts;
}
