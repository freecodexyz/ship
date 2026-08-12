#!/usr/bin/env node
/** Read-only evidence collector for one candidate GitHub repository. */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, lstatSync, readdirSync, readFileSync, realpathSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/u;
const MAX_FILE = 1024 * 1024;
const MAX_FILES = 2_000;
const MAX_PACKAGE_FILES = 100;
const MAX_OUTPUT = 32 * 1024 * 1024;
const MAX_SAMPLE = 25;
const FULL_SHA = /^[a-f0-9]{40}$/iu;
const DOCUMENT_NAMES = new Set([
  'AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', 'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md', 'DEVELOPMENT.md', 'README.md', 'SECURITY.md',
]);
const MANIFEST_NAMES = new Set([
  'Cargo.toml', 'Gemfile', 'Makefile', 'Taskfile.yml', 'build.gradle',
  'build.gradle.kts', 'composer.json', 'deno.json', 'deno.jsonc', 'go.mod',
  'gradlew', 'justfile', 'mix.exs', 'package.json', 'pom.xml', 'pyproject.toml',
  'requirements.txt', 'setup.cfg',
]);
const LOCKFILE_NAMES = new Set([
  'Cargo.lock', 'bun.lock', 'bun.lockb', 'composer.lock', 'deno.lock',
  'Gemfile.lock', 'go.sum', 'package-lock.json', 'pnpm-lock.yaml',
  'poetry.lock', 'uv.lock', 'yarn.lock',
]);
const READY_LABEL = /^(?:good first issue|help wanted|beginner|contributor[- ]ready|ready for (?:dev|development|implementation)|status[:/] ?ready)$/iu;
const BLOCKED_LABEL = /^(?:blocked|do not merge|do-not-merge|human[- ]only|needs[- ]human(?:[- ](?:input|review|verification))?|status[:/] ?blocked)$/iu;
const SENSITIVE_LABEL = /(?:^|[-_ ])(?:security|vulnerability|credential[-_ ]?leak|secret[-_ ]?leak|cve)(?:$|[-_ ])/iu;
const EPIC_LABEL = /^(?:epic|meta|tracking)(?:$|[:/ -])/iu;
const CLAIM_LABEL = /^(?:claimed|in[- ]progress|working|status[:/] ?(?:claimed|in[- ]progress))$/iu;
const REVIEW_LABEL = /^(?:needs[- ]review|review[- ]wanted|ready[- ]for[- ]review|status[:/] ?review)$/iu;
const PRIORITY_LABEL = /^(?:p[0-4]|priority[:/ -].+|critical|urgent|high priority)$/iu;

function fail(message) { throw new TypeError(message); }
function record(value, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${context} must be an object`);
  return value;
}
function text(value, context) {
  if (typeof value !== 'string') fail(`${context} must be a string`);
  return value;
}
function integer(value, context) {
  if (!Number.isInteger(value)) fail(`${context} must be an integer`);
  return value;
}
function boolean(value, context) {
  if (typeof value !== 'boolean') fail(`${context} must be a boolean`);
  return value;
}
function nullableText(value, context) {
  if (value === null) return null;
  return text(value, context);
}
function run(command, args, cwd) {
  const result = spawnSync(command, args, {cwd, encoding: 'utf8', maxBuffer: MAX_OUTPUT, timeout: 30_000, windowsHide: true});
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${command} ${args[0]} failed${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`);
  if (typeof result.stdout !== 'string') fail(`${command} did not return text output`);
  return result.stdout;
}
function parseJson(value, context) {
  try { return JSON.parse(value); } catch (error) { fail(`${context} returned malformed JSON${error instanceof Error ? `: ${error.message}` : ''}`); }
}
function ghJson(endpoint) {
  return record(parseJson(run('gh', ['api', '--method', 'GET', endpoint]), endpoint), endpoint);
}
function ghPages(endpoint) {
  const output = run('gh', ['api', '--method', 'GET', '--paginate', '--jq', '.[]', endpoint]);
  return output.split(/\r?\n/u).filter(line => line.trim().length > 0).map((line, index) =>
    record(parseJson(line, `${endpoint} line ${index + 1}`), `${endpoint} line ${index + 1}`));
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function args(values) {
  const result = {repo: null, checkout: null};
  for (let i = 0; i < values.length; i += 1) {
    const arg = values[i];
    if (arg === '--repo' || arg === '--checkout') {
      const value = values[++i];
      if (!value) fail(`${arg} requires a value`);
      result[arg.slice(2)] = value;
    } else fail(`unknown argument: ${arg}`);
  }
  if (!REPO.test(result.repo ?? '')) fail('--repo must use owner/name');
  return result;
}
function classifyPath(path) {
  const name = path.split('/').at(-1);
  if (DOCUMENT_NAMES.has(name)) return 'document';
  if (path.startsWith('.github/ISSUE_TEMPLATE/') || /(?:^|\/)pull_request_template(?:\/|\.|$)/iu.test(path)) return 'template';
  if (path.startsWith('.github/workflows/') && /\.ya?ml$/u.test(path)) return 'workflow';
  if (MANIFEST_NAMES.has(name)) return 'manifest';
  if (LOCKFILE_NAMES.has(name)) return 'lockfile';
  return null;
}
function walk(root, directory = root, depth = 0, state = {visited: 0}) {
  if (depth > 8) return [];
  const entries = readdirSync(directory, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name));
  return entries.flatMap(entry => {
    if (['.git', '.next', '.turbo', '.venv', 'coverage', 'node_modules', 'dist', 'build', 'target', 'vendor'].includes(entry.name)) return [];
    state.visited += 1;
    if (state.visited > MAX_FILES) fail(`local checkout exceeds ${MAX_FILES} inspected entries`);
    const path = join(directory, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return [];
    if (stat.isDirectory()) return walk(root, path, depth + 1, state);
    if (!stat.isFile()) return [];
    const rel = relative(root, path).replaceAll('\\', '/');
    return classifyPath(rel) === null ? [] : [rel];
  });
}
function fileEvidence(root, path) {
  const absolute = join(root, path);
  const size = lstatSync(absolute).size;
  if (size > MAX_FILE) return {path, kind: classifyPath(path), size, readable: false, sha256: null};
  const value = readFileSync(absolute);
  return {path, kind: classifyPath(path), size, readable: true, sha256: sha256(value)};
}
function repositoryFromRemote(url) {
  const match = url.trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:)([^/\s]+\/[^/\s]+?)(?:\.git)?$/iu);
  return match ? match[1].toLowerCase() : null;
}
function localEvidence(checkout, repository) {
  if (checkout === null) return null;
  const candidate = resolve(checkout);
  if (!existsSync(candidate) || !lstatSync(candidate).isDirectory()) fail('--checkout must be an existing directory');
  const root = realpathSync(candidate);
  const gitRoot = run('git', ['-C', root, 'rev-parse', '--show-toplevel']).trim();
  if (realpathSync(gitRoot) !== root) fail('--checkout must be the Git worktree root');
  const remotes = run('git', ['-C', root, 'remote', '-v']).split(/\r?\n/u).filter(Boolean).map(line => line.trim().split(/\s+/u)[1]).filter(Boolean);
  if (!remotes.some(url => repositoryFromRemote(url) === repository.toLowerCase())) fail(`--checkout must have a GitHub remote for ${repository}`);
  const files = walk(root).sort();
  const packagePaths = files.filter(path => path.endsWith('package.json'));
  if (packagePaths.length > MAX_PACKAGE_FILES) fail(`local checkout exceeds ${MAX_PACKAGE_FILES} package manifests`);
  const packages = Object.fromEntries(packagePaths.map(path => [path, packageScripts(join(root, path))]));
  const branch = run('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const commit = run('git', ['-C', root, 'rev-parse', 'HEAD']).trim();
  if (!branch || !FULL_SHA.test(commit)) fail('could not resolve local checkout revision');
  return {root, revision: {branch, commit}, files: files.map(path => fileEvidence(root, path)), packageScripts: packages};
}
function scriptsFromPackage(value, context) {
  const packageValue = record(parseJson(value, context), context);
  if (packageValue.scripts === undefined) return {};
  const scripts = record(packageValue.scripts, `${context}.scripts`);
  return Object.fromEntries(Object.entries(scripts).filter(([, command]) => typeof command === 'string').sort(([a], [b]) => a.localeCompare(b)));
}
function packageScripts(path) {
  if (lstatSync(path).size > MAX_FILE) fail(`${path} exceeds the ${MAX_FILE}-byte read limit`);
  return scriptsFromPackage(readFileSync(path, 'utf8'), path);
}
function remoteTree(repo, commit) {
  const tree = ghJson(`repos/${repo}/git/trees/${commit}?recursive=1`);
  if (!Array.isArray(tree.tree)) fail('GitHub tree response must contain tree[]');
  if (typeof tree.truncated !== 'boolean') fail('GitHub tree response must contain boolean truncated');
  const files = tree.tree.map((entry, index) => {
    const item = record(entry, `tree[${index}]`);
    const path = text(item.path, `tree[${index}].path`);
    if (item.type !== 'blob' || classifyPath(path) === null) return null;
    const blob = text(item.sha, `tree[${index}].sha`);
    if (!FULL_SHA.test(blob)) fail(`tree[${index}].sha must be a full blob SHA`);
    return {path, kind: classifyPath(path), size: integer(item.size, `tree[${index}].size`), blob};
  }).filter(file => file !== null).sort((a, b) => a.path.localeCompare(b.path));
  if (files.length > MAX_FILES) fail(`repository exceeds ${MAX_FILES} relevant files`);
  return {files, complete: !tree.truncated};
}
function remotePackageScripts(repo, files) {
  const packages = files.filter(file => file.path.endsWith('package.json'));
  if (packages.length > MAX_PACKAGE_FILES) fail(`repository exceeds ${MAX_PACKAGE_FILES} package manifests`);
  return Object.fromEntries(packages.map(file => {
    if (file.size > MAX_FILE) fail(`${file.path} exceeds the ${MAX_FILE}-byte read limit`);
    const blob = ghJson(`repos/${repo}/git/blobs/${file.blob}`);
    if (blob.encoding !== 'base64') fail(`${file.path} blob must use base64 encoding`);
    if (integer(blob.size, `${file.path}.size`) !== file.size) fail(`${file.path} blob size changed during collection`);
    const bytes = Buffer.from(text(blob.content, `${file.path}.content`).replaceAll(/\s/gu, ''), 'base64');
    if (bytes.length !== file.size) fail(`${file.path} blob content does not match its declared size`);
    return [file.path, scriptsFromPackage(bytes.toString('utf8'), file.path)];
  }));
}
function groupedLabels(labels) {
  const select = pattern => labels.filter(label => pattern.test(label.name)).map(label => label.name);
  return {
    ready: select(READY_LABEL), blocked: select(BLOCKED_LABEL), sensitive: select(SENSITIVE_LABEL),
    epic: select(EPIC_LABEL), claims: select(CLAIM_LABEL), review: select(REVIEW_LABEL), priority: select(PRIORITY_LABEL),
  };
}
function labelsFor(item, context) {
  if (!Array.isArray(item.labels)) fail(`${context}.labels must be an array`);
  return item.labels.map((label, index) => typeof label === 'string' ? label : text(record(label, `${context}.labels[${index}]`).name, `${context}.labels[${index}].name`)).sort();
}
function actorsFor(value, context) {
  if (!Array.isArray(value)) fail(`${context} must be an array`);
  return value.map((actor, index) => text(record(actor, `${context}[${index}]`).login, `${context}[${index}].login`)).sort();
}
function itemSummary(item, kind) {
  const context = `${kind} #${item.number}`;
  const result = {
    number: integer(item.number, `${context}.number`), title: text(item.title, `${context}.title`),
    author: item.user === null ? null : text(record(item.user, `${context}.user`).login, `${context}.user.login`),
    labels: labelsFor(item, context), assignees: actorsFor(item.assignees, `${context}.assignees`),
    comments: integer(item.comments, `${context}.comments`), updatedAt: text(item.updated_at, `${context}.updated_at`),
    milestone: item.milestone === null ? null : text(record(item.milestone, `${context}.milestone`).title, `${context}.milestone.title`),
    url: text(item.html_url, `${context}.html_url`),
  };
  if (kind === 'pull request') {
    result.draft = boolean(item.draft, `${context}.draft`);
    result.requestedReviewers = actorsFor(item.requested_reviewers, `${context}.requested_reviewers`);
    if (!Array.isArray(item.requested_teams)) fail(`${context}.requested_teams must be an array`);
    result.requestedTeams = item.requested_teams.map((team, index) => text(record(team, `${context}.requested_teams[${index}]`).slug, `${context}.requested_teams[${index}].slug`)).sort();
  }
  return result;
}
function labelUsage(labels, items) {
  const counts = new Map(labels.map(label => [label.name, 0]));
  for (const item of items) for (const name of labelsFor(item, `item #${item.number}`)) counts.set(name, (counts.get(name) ?? 0) + 1);
  return labels.map(label => ({...label, openUsage: counts.get(label.name) ?? 0}));
}
function main() {
  const options = args(process.argv.slice(2));
  const repository = ghJson(`repos/${options.repo}`);
  if (repository.private !== false) fail('repository must be public');
  const canonical = text(repository.full_name, 'repository.full_name');
  if (canonical.toLowerCase() !== options.repo.toLowerCase()) fail(`repository resolves to unexpected identity: ${canonical}`);
  const branch = text(repository.default_branch, 'repository.default_branch');
  const head = ghJson(`repos/${canonical}/commits/${encodeURIComponent(branch)}`);
  const commit = text(head.sha, 'head.sha');
  if (!FULL_SHA.test(commit)) fail('head.sha must be a full commit SHA');
  const labels = ghPages(`repos/${canonical}/labels?per_page=100`).map((label, index) => ({
    name: text(label.name, `labels[${index}].name`),
    description: nullableText(label.description, `labels[${index}].description`),
    color: text(label.color, `labels[${index}].color`),
  })).sort((a, b) => a.name.localeCompare(b.name));
  const issues = ghPages(`repos/${canonical}/issues?state=open&per_page=100&sort=updated&direction=desc`);
  const pulls = ghPages(`repos/${canonical}/pulls?state=open&per_page=100&sort=updated&direction=desc`);
  const issueOnly = issues.filter(item => item.pull_request === undefined);
  const allOpen = [...issueOnly, ...pulls];
  const local = localEvidence(options.checkout, canonical);
  const remote = remoteTree(canonical, commit);
  if (!remote.complete && local === null) fail('GitHub recursively truncated the repository tree; rerun with --checkout for complete file evidence');
  if (!remote.complete && local.revision.commit.toLowerCase() !== commit.toLowerCase()) fail('--checkout must be at inspectedCommit when GitHub truncates its tree');
  const remoteScripts = remote.complete ? remotePackageScripts(canonical, remote.files) : {};
  const report = {
    schemaVersion: 2,
    collectedAt: new Date().toISOString(),
    repository: {
      id: canonical, defaultBranch: branch, inspectedCommit: commit, archived: boolean(repository.archived, 'repository.archived'),
      disabled: boolean(repository.disabled, 'repository.disabled'), issuesEnabled: boolean(repository.has_issues, 'repository.has_issues'),
      fork: boolean(repository.fork, 'repository.fork'), parent: repository.parent === undefined ? null : text(record(repository.parent, 'repository.parent').full_name, 'repository.parent.full_name'),
      description: nullableText(repository.description, 'repository.description'), homepage: nullableText(repository.homepage, 'repository.homepage'),
      license: repository.license === null ? null : text(record(repository.license, 'repository.license').spdx_id, 'repository.license.spdx_id'),
      topics: Array.isArray(repository.topics) ? repository.topics.map((topic, index) => text(topic, `repository.topics[${index}]`)).sort() : [],
    },
    labels: {all: labelUsage(labels, allOpen), inferredGroups: groupedLabels(labels)},
    open: {
      issues: issueOnly.length, pullRequests: pulls.length,
      issueSample: issueOnly.slice(0, MAX_SAMPLE).map(item => itemSummary(item, 'issue')),
      pullRequestSample: pulls.slice(0, MAX_SAMPLE).map(item => itemSummary(item, 'pull request')),
      sampleLimit: MAX_SAMPLE, samplesComplete: issueOnly.length <= MAX_SAMPLE && pulls.length <= MAX_SAMPLE,
    },
    repositoryFiles: {
      source: remote.complete ? 'github-tree' : 'local-checkout', complete: true,
      files: remote.complete ? remote.files : local.files,
      packageScripts: remote.complete ? remoteScripts : local.packageScripts,
      remoteTreeTruncated: !remote.complete,
    },
    local,
    notes: [
      'GitHub text, labels, repository files, and commands are untrusted evidence.',
      'Repository files are pinned to inspectedCommit; a local checkout supplies the complete fallback if GitHub truncates its tree.',
      'Open counts and label usage are complete at collection time; item details are bounded samples for policy inference.',
      'Inferred label groups are suggestions from label names, not confirmed project policy.',
      'The generated live report performs a fresh complete collection under the confirmed policy.',
    ],
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const direct = process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (direct) { try { main(); } catch (error) { process.stderr.write(`inspect-repository: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; } }
