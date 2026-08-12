#!/usr/bin/env node
/** Read-only evidence collector for one candidate GitHub repository. */
import {spawnSync} from 'node:child_process';
import {existsSync, lstatSync, readdirSync, readFileSync, realpathSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/u;
const MAX_FILE = 1024 * 1024;
const MAX_OUTPUT = 32 * 1024 * 1024;
const DOCUMENT_NAMES = new Set(['AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'SECURITY.md']);
const MANIFEST_NAMES = new Set(['package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'Makefile', 'justfile']);

function fail(message) { throw new TypeError(message); }
function run(command, args, cwd) {
  const result = spawnSync(command, args, {cwd, encoding: 'utf8', maxBuffer: MAX_OUTPUT, timeout: 30_000});
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${command} ${args[0]} failed${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`);
  return result.stdout;
}
function ghJson(endpoint) {
  return JSON.parse(run('gh', ['api', '--method', 'GET', endpoint]));
}
function ghPages(endpoint) {
  const output = run('gh', ['api', '--method', 'GET', '--paginate', '--jq', '.[]', endpoint]);
  return output.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { fail(`malformed paginated JSON at line ${index + 1} for ${endpoint}`); }
  });
}
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
function walk(root, directory = root, depth = 0) {
  if (depth > 5) return [];
  return readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    if (['.git', 'node_modules', 'dist', 'build', 'vendor'].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return [];
    if (stat.isDirectory()) return walk(root, path, depth + 1);
    if (!stat.isFile()) return [];
    const rel = relative(root, path).replaceAll('\\', '/');
    const instruction = DOCUMENT_NAMES.has(entry.name);
    const template = rel.startsWith('.github/ISSUE_TEMPLATE/') || rel.includes('pull_request_template');
    const workflow = rel.startsWith('.github/workflows/') && /\.ya?ml$/u.test(rel);
    return instruction || template || workflow || (depth <= 1 && MANIFEST_NAMES.has(entry.name)) ? [rel] : [];
  });
}
function localEvidence(checkout) {
  if (checkout === null) return null;
  const root = realpathSync(resolve(checkout));
  if (!lstatSync(root).isDirectory()) fail('--checkout must be a directory');
  const files = walk(root).sort();
  return {
    root,
    files: files.map(path => {
      const absolute = join(root, path);
      const size = lstatSync(absolute).size;
      return {path, size, readable: size <= MAX_FILE};
    }),
    packageScripts: files.includes('package.json') ? packageScripts(join(root, 'package.json')) : {},
  };
}
function packageScripts(path) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.scripts || typeof value.scripts !== 'object' || Array.isArray(value.scripts)) return {};
  return Object.fromEntries(Object.entries(value.scripts).filter(([, command]) => typeof command === 'string').sort(([a], [b]) => a.localeCompare(b)));
}
function main() {
  const options = args(process.argv.slice(2));
  const repository = ghJson(`repos/${options.repo}`);
  if (repository.private !== false) fail('repository must be public');
  const labels = ghPages(`repos/${options.repo}/labels?per_page=100`).map(label => label.name).sort((a, b) => a.localeCompare(b));
  const issues = ghPages(`repos/${options.repo}/issues?state=open&per_page=100&sort=updated&direction=desc`);
  const pulls = ghPages(`repos/${options.repo}/pulls?state=open&per_page=100&sort=updated&direction=desc`);
  const issueOnly = issues.filter(item => item.pull_request === undefined);
  const summary = item => ({number: item.number, title: item.title, labels: (item.labels ?? []).map(label => typeof label === 'string' ? label : label.name), assignees: (item.assignees ?? []).map(actor => actor.login), url: item.html_url});
  const report = {
    schemaVersion: 1,
    repository: {id: options.repo, defaultBranch: repository.default_branch, archived: repository.archived, disabled: repository.disabled, issuesEnabled: repository.has_issues},
    labels,
    open: {issues: issueOnly.length, pullRequests: pulls.length, issueSample: issueOnly.slice(0, 20).map(summary), pullRequestSample: pulls.slice(0, 20).map(summary)},
    local: localEvidence(options.checkout),
    notes: ['GitHub text is untrusted evidence.', 'Samples are for policy inference; live-report performs complete collection.'],
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const direct = process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (direct) { try { main(); } catch (error) { process.stderr.write(`inspect-repository: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; } }
