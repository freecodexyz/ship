#!/usr/bin/env node
/** Capture one bounded agent run and emit Ship's existing signed receipt marker. */
import {spawnSync} from 'node:child_process';
import {createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign} from 'node:crypto';
import {chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = JSON.parse(readFileSync(join(skillRoot, 'project.json'), 'utf8'));
const MAX_REPORT = 32 * 1024 * 1024;
const MAX_TRAJECTORY = 100 * 1024 * 1024;
const RUN_ID = /^run_[0-9A-HJKMNP-TV-Z]{26}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const INTEGER = /^(?:0|[1-9]\d*)$/u;

function fail(message) { throw new TypeError(message); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function canonicalJson(value, ancestors = new Set()) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('canonical JSON rejects non-finite numbers');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value !== 'object') fail(`canonical JSON rejects ${typeof value}`);
  if (ancestors.has(value)) fail('canonical JSON rejects circular values');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item, ancestors)).join(',')}]`;
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail('canonical JSON accepts only plain objects');
    if (Object.getOwnPropertySymbols(value).length > 0) fail('canonical JSON rejects symbol keys');
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key], ancestors)}`).join(',')}}`;
  } finally { ancestors.delete(value); }
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {encoding: 'utf8', maxBuffer: MAX_REPORT, timeout: 120_000, windowsHide: true, ...options});
  if (result.error || result.signal || result.status !== 0) fail(`${command} ${args[0]} failed`);
  return result.stdout.trim();
}
function git(root, args) { return run('git', ['-C', root, ...args], {timeout: 15_000}); }
function repositoryFromRemote(url) {
  const match = url.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([^/\s]+\/[^/\s]+?)(?:\.git)?$/iu);
  return match ? match[1] : null;
}
function requireRepository(path) {
  const root = realpathSync(resolve(path));
  if (realpathSync(git(root, ['rev-parse', '--show-toplevel'])) !== root) fail('--repo-root must be the Git worktree root');
  const remotes = git(root, ['remote', '-v']).split(/\r?\n/u).map(line => repositoryFromRemote(line.trim().split(/\s+/u)[1] ?? '')).filter(Boolean);
  const configured = project.repositories.find(repository => remotes.some(remote => remote.toLowerCase() === repository.id.toLowerCase()));
  if (!configured) fail('--repo-root must reference a repository configured for this project');
  return {root, repository: configured.id};
}
function requireModel(client, provider, model) {
  const selected = project.allowedModels.find(candidate => candidate.client === client && candidate.provider === provider && candidate.model === model);
  if (!selected) fail('client/provider/model must exactly match project.allowedModels');
  return selected;
}
function isoNow() { return new Date().toISOString(); }
function stateRoot() {
  const configured = process.env.XDG_CONFIG_HOME;
  const base = configured && resolve(configured) === configured ? configured : join(homedir(), '.config');
  return join(base, 'ship');
}
function directory(path) {
  mkdirSync(path, {recursive: true, mode: 0o700});
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`refusing unsafe state directory: ${path}`);
  chmodSync(path, 0o700);
}
function runPaths() {
  const root = join(stateRoot(), 'runs');
  const active = join(root, 'active');
  const completed = join(root, 'completed');
  directory(active); directory(completed);
  return {active, completed};
}
function readState(path, context) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_REPORT) fail(`refusing unsafe ${context} state`);
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { fail(`${context} state is malformed`); }
}
function atomicJson(path, value, exclusive = false) {
  if (exclusive) {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {flag: 'wx', mode: 0o600});
    return;
  }
  if (existsSync(path)) fail(`refusing existing state: ${path}`);
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {flag: 'wx', mode: 0o600});
  renameSync(temporary, path);
}
function deviceKey() {
  const root = stateRoot(); directory(root);
  const path = join(root, 'device-ed25519.pem');
  let privateKey;
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('refusing unsafe device key');
    privateKey = createPrivateKey(readFileSync(path));
  } else {
    const generated = generateKeyPairSync('ed25519');
    writeFileSync(path, generated.privateKey.export({format: 'pem', type: 'pkcs8'}), {flag: 'wx', mode: 0o600});
    privateKey = generated.privateKey;
  }
  chmodSync(path, 0o600);
  const der = createPublicKey(privateKey).export({format: 'der', type: 'spki'});
  const raw = Buffer.from(der).subarray(-32);
  return {privateKey, publicKey: raw.toString('base64'), keyId: sha256(raw)};
}
function runId(now = Date.now(), entropy = randomBytes(10)) {
  let value = (BigInt(now) << 80n) | BigInt(`0x${entropy.toString('hex')}`);
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let encoded = '';
  for (let index = 0; index < 26; index += 1) { encoded = alphabet[Number(value & 31n)] + encoded; value >>= 5n; }
  return `run_${encoded}`;
}
function skillProvenance() {
  const skillPath = `skills/contribute-to-${project.id}`;
  const root = git(skillRoot, ['rev-parse', '--show-toplevel']);
  if (git(root, ['status', '--porcelain', '--', skillPath])) fail('contributor skill must be committed and clean before starting a receipt');
  const revision = git(root, ['rev-parse', 'HEAD']);
  if (!SHA.test(revision)) fail('skill revision must be a full Git commit SHA');
  git(root, ['cat-file', '-e', `${revision}:${skillPath}/SKILL.md`]);
  return {revision, sha256: sha256(readFileSync(join(skillRoot, 'SKILL.md')))};
}
function commandExists(command) {
  const result = spawnSync(command, ['--version'], {stdio: 'ignore', timeout: 5_000, windowsHide: true});
  return result.status === 0;
}
function number(value, names) {
  for (const name of names) if (typeof value[name] === 'number' && Number.isFinite(value[name]) && value[name] >= 0) return value[name];
  return 0;
}
function normalizeUsage(payload, root) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.sessions)) return null;
  const sessions = {};
  for (const session of payload.sessions) {
    if (!session || typeof session !== 'object') continue;
    const id = session.sessionId ?? session.session_id ?? session.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    const path = session.projectPath ?? session.project_path ?? session.cwd ?? session.workingDirectory ?? session.path;
    const pathMatched = typeof path === 'string' && resolve(path) === root;
    if (typeof path === 'string' && !pathMatched) continue;
    const input = Math.floor(number(session, ['inputTokens', 'input_tokens']));
    const output = Math.floor(number(session, ['outputTokens', 'output_tokens']));
    const cacheWrite = Math.floor(number(session, ['cacheCreationTokens', 'cache_creation_tokens', 'cacheWriteTokens']));
    const cacheRead = Math.floor(number(session, ['cacheReadTokens', 'cache_read_tokens']));
    const visible = input + output + cacheWrite + cacheRead;
    sessions[sha256(id)] = {tokens: Math.floor(Math.max(visible, number(session, ['totalTokens', 'total_tokens']))), cost: Math.max(0, Math.round(number(session, ['totalCost', 'costUSD', 'costUsd', 'cost']) * 1_000_000)), pathMatched};
  }
  return sessions;
}
function collectUsage(client, root) {
  const runner = commandExists('bun') ? ['bun', ['x', 'ccusage@20.0.19']] : commandExists('npx') ? ['npx', ['--yes', 'ccusage@20.0.19']] : null;
  if (!runner) return null;
  const source = client === 'codex' ? 'codex' : 'claude';
  const args = [...runner[1], source, 'session', '--json', '--mode', 'calculate'];
  try { return normalizeUsage(JSON.parse(run(runner[0], args, {cwd: root})), root); } catch { return null; }
}
function usageDelta(before, after, client) {
  if (!before || !after) return {confidence: 'unavailable', totalTokens: 0, costMicroUsd: '0'};
  let tokens = 0; let cost = 0; let exact = client === 'claude-code';
  for (const [id, current] of Object.entries(after)) {
    const prior = before[id] ?? {tokens: 0, cost: 0, pathMatched: current.pathMatched};
    if (current.tokens < prior.tokens || current.cost < prior.cost) return {confidence: 'unavailable', totalTokens: 0, costMicroUsd: '0'};
    if (current.tokens === prior.tokens) continue;
    tokens += current.tokens - prior.tokens; cost += current.cost - prior.cost; exact &&= current.pathMatched;
  }
  if (!Number.isSafeInteger(tokens) || !Number.isSafeInteger(cost) || tokens <= 0) return {confidence: 'unavailable', totalTokens: 0, costMicroUsd: '0'};
  return {confidence: exact ? 'exact' : 'bounded', totalTokens: tokens, costMicroUsd: String(cost)};
}
function trajectory(path) {
  if (!path) return undefined;
  const absolute = resolve(path); const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TRAJECTORY) fail('trajectory must be a regular file no larger than 100 MiB');
  return sha256(readFileSync(absolute));
}
function parseArguments(values) {
  const options = {action: values[0], run: null, client: null, provider: null, model: null, repoRoot: process.cwd(), trajectory: null, json: false};
  for (let index = 1; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === '--json') options.json = true;
    else if (['--run', '--client', '--provider', '--model', '--repo-root', '--trajectory'].includes(argument)) {
      const value = values[++index]; if (!value) fail(`${argument} requires a value`);
      options[argument.slice(2).replace('repo-root', 'repoRoot')] = value;
    } else fail(`unknown argument: ${argument}`);
  }
  if (!['start', 'finish'].includes(options.action)) fail('action must be start or finish');
  if (options.action === 'finish' && !RUN_ID.test(options.run ?? '')) fail('finish requires --run from start');
  requireModel(options.client, options.provider, options.model);
  return options;
}
function output(value, json) { process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${value.message}\n`); }
function start(options) {
  const repository = requireRepository(options.repoRoot); const provenance = skillProvenance(); const id = runId();
  const state = {version: 1, runId: id, project: project.id, repo: repository.repository, rootHash: sha256(repository.root), startedAt: isoNow(), agent: {client: options.client, provider: options.provider, model: options.model}, skill: provenance, baseline: collectUsage(options.client, repository.root)};
  const paths = runPaths(); atomicJson(join(paths.active, `${id}.json`), state, true);
  output({runId: id, usageStatus: state.baseline ? 'capturing' : 'unavailable', message: `Ship receipt run started. Keep this id: ${id}`}, options.json);
}
function finish(options) {
  const repository = requireRepository(options.repoRoot); const paths = runPaths(); const active = join(paths.active, `${options.run}.json`); const completed = join(paths.completed, `${options.run}.json`);
  if (!existsSync(active) && existsSync(completed)) { const saved = readState(completed, 'completed run'); output({...saved, message: saved.marker}, options.json); return; }
  if (!existsSync(active)) fail('active run state was not found');
  const state = readState(active, 'active run');
  if (state.runId !== options.run || state.project !== project.id || state.repo.toLowerCase() !== repository.repository.toLowerCase() || state.rootHash !== sha256(repository.root) || canonicalJson(state.agent) !== canonicalJson({client: options.client, provider: options.provider, model: options.model}) || !SHA256.test(state.skill?.sha256)) fail('run state does not match this project, repository, model, or checkout');
  const unsigned = {version: 1, runId: state.runId, project: state.project, repo: state.repo, startedAt: state.startedAt, completedAt: isoNow(), agent: state.agent, skill: state.skill, usage: usageDelta(state.baseline, collectUsage(options.client, repository.root), options.client), device: {keyId: '', publicKey: ''}};
  const digest = trajectory(options.trajectory); if (digest) unsigned.trajectorySha256 = digest;
  const key = deviceKey(); unsigned.device = {keyId: key.keyId, publicKey: key.publicKey};
  const receipt = {...unsigned, signature: sign(null, Buffer.from(canonicalJson(unsigned), 'utf8'), key.privateKey).toString('base64')};
  const marker = `<!-- ship-receipt: ${canonicalJson(receipt)} -->`;
  atomicJson(completed, {receipt, marker}); rmSync(active);
  output({receipt, marker, message: marker}, options.json);
}
export function main(values = process.argv.slice(2)) { const options = parseArguments(values); options.action === 'start' ? start(options) : finish(options); }
const direct = process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (direct) { try { main(); } catch (error) { process.stderr.write(`run-receipt: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; } }
