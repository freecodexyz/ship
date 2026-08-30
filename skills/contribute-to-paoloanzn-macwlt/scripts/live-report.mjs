#!/usr/bin/env node
/** Self-contained, GET-only GitHub work inventory. Reads adjacent project.json/policy.json. */
import {spawnSync} from 'node:child_process';
import {readFileSync, realpathSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_OUTPUT = 64 * 1024 * 1024;
const MAX_ITEMS = 5000;
let collectedItems = 0;
const SAFE_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const FULL_SHA = /^[0-9a-f]{40}$/u;
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const LABEL_SUFFIX = /^[a-z0-9][a-z0-9._/-]*$/iu;
const BOT = /(?:\[bot\]$|(?:^|[-_])bot$|^(?:dependabot|github-actions|renovate)(?:\[bot\])?$)/iu;
const EPIC_TITLE = /^\s*(?:\[[^\]]*\bepic\b[^\]]*\]|epic\s*:)/iu;
const SENSITIVE = /(?:security|vulnerab|exploit|credential|secret|private\s+disclos)/iu;

function fail(message) { throw new TypeError(message); }
function object(value, name) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`); return value; }
function strings(value, name) { if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) fail(`${name} must be a string array`); return value; }
function readJson(path) { try { return object(JSON.parse(readFileSync(path, 'utf8')), path); } catch (error) { fail(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`); } }
function parseArgs(values, allowedRepos) {
  let json = false; let repo = null;
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] === '--json') json = true;
    else if (values[i] === '--repo') { repo = values[++i]; if (!repo) fail('--repo requires owner/name'); }
    else fail(`unknown argument: ${values[i]}`);
  }
  if (repo !== null && !allowedRepos.has(repo.toLowerCase())) fail('--repo must name a registered project repository');
  return {json, repo};
}
function validate(project, policy) {
  if (project.schemaVersion !== 1 || typeof project.id !== 'string' || typeof project.name !== 'string' || !Array.isArray(project.repositories) || project.repositories.length === 0) fail('invalid project.json');
  const repos = new Set();
  for (const candidate of project.repositories) {
    const repo = object(candidate, 'repository');
    if (typeof repo.id !== 'string' || typeof repo.branch !== 'string' || !REPO.test(repo.id) || repos.has(repo.id.toLowerCase())) fail('invalid or duplicate repository');
    repos.add(repo.id.toLowerCase());
    if (repo.previousIds !== undefined) {
      if (!Array.isArray(repo.previousIds) || repo.previousIds.length === 0) fail('repository.previousIds must be a non-empty array');
      for (const candidatePrevious of repo.previousIds) {
        const previous = object(candidatePrevious, 'repository.previousIds entry');
        if (typeof previous.id !== 'string' || !REPO.test(previous.id) || repos.has(previous.id.toLowerCase())) fail('invalid or duplicate repository identity');
        if (typeof previous.retiredAt !== 'string' || !TIMESTAMP.test(previous.retiredAt) || new Date(previous.retiredAt).toISOString() !== previous.retiredAt) fail('invalid repository retirement timestamp');
        repos.add(previous.id.toLowerCase());
      }
    }
  }
  if (policy.schemaVersion !== 2) fail('invalid policy schemaVersion');
  strings(policy.modes, 'modes');
  const issues = object(policy.issues, 'issues');
  for (const key of ['readyLabels', 'blockedLabels', 'sensitiveLabels', 'epicLabels']) strings(issues[key], `issues.${key}`);
  if (typeof issues.allowUnlabeled !== 'boolean') fail('issues.allowUnlabeled must be boolean');
  const claims = object(policy.claims, 'claims');
  if (typeof claims.assignees !== 'boolean') fail('claims.assignees must be boolean');
  strings(claims.implementationLabels, 'implementationLabels'); strings(claims.reviewLabels, 'reviewLabels');
  for (const key of ['implementationLabelPrefixes', 'reviewLabelPrefixes']) {
    if (strings(claims[key], key).some(prefix => prefix.length < 2 || !prefix.endsWith(':'))) fail(`${key} entries must end in a colon`);
  }
  const comments = object(claims.comments, 'claims.comments');
  if (typeof comments.enabled !== 'boolean' || typeof comments.implementationPrefix !== 'string' || typeof comments.reviewPrefix !== 'string' || !Number.isInteger(comments.expiresAfterDays) || comments.expiresAfterDays < 1 || comments.expiresAfterDays > 30) fail('invalid comment claim policy');
  if (strings(comments.trustedAssociations, 'trustedAssociations').some(value => !SAFE_ASSOCIATIONS.has(value))) fail('invalid trusted association');
  strings(policy.priorityLabels, 'priorityLabels');
  return new Set(project.repositories.map(repository => repository.id.toLowerCase()));
}
function ghLines(endpoint) {
  const result = spawnSync('gh', ['api', '--method', 'GET', '--paginate', '--jq', '.[]', endpoint], {encoding: 'utf8', maxBuffer: MAX_OUTPUT, timeout: 60_000});
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`GitHub collection failed for ${endpoint}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`);
  const lines = result.stdout.split(/\r?\n/u).filter(Boolean);
  collectedItems += lines.length;
  if (lines.length > MAX_ITEMS || collectedItems > MAX_ITEMS) fail(`resource bound exceeded for ${endpoint}`);
  return lines.map((line, index) => { try { return object(JSON.parse(line), `${endpoint}[${index}]`); } catch { fail(`malformed GitHub response for ${endpoint} at item ${index + 1}`); } });
}
const lower = values => new Set(values.map(value => value.toLowerCase()));
const labelsOf = item => {
  if (!Array.isArray(item.labels)) fail('labels must be an array');
  return item.labels.map((label, index) => {
    if (typeof label === 'string') return label;
    const value = object(label, `labels[${index}]`);
    if (typeof value.name !== 'string') fail(`labels[${index}].name must be a string`);
    return value.name;
  });
};
function account(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.login !== 'string' || value.login.length === 0) return {kind: 'unknown', login: null, id: null};
  if (value.type !== undefined && typeof value.type !== 'string') fail(`${name}.type must be a string when present`);
  const id = Number.isInteger(value.id) ? value.id : null;
  if (value.type !== undefined && value.type.toLowerCase() !== 'user' && value.type.toLowerCase() !== 'bot') return {kind: 'unknown', login: value.login, id};
  return {kind: value.type?.toLowerCase() === 'bot' || BOT.test(value.login) ? 'bot' : 'human', login: value.login, id};
}
const sameAccount = (left, right) => left.login !== null && right.login !== null && ((left.id !== null && right.id !== null && left.id === right.id) || left.login.toLowerCase() === right.login.toLowerCase());
const author = item => account(item.user, 'user');
function commonReasons(item, policy) {
  const labelNames = labelsOf(item); const labels = lower(labelNames); const reasons = [];
  const actor = author(item);
  if (actor.kind === 'unknown') reasons.push('unknown-author');
  if (actor.kind === 'bot') reasons.push('bot-authored');
  if (labelNames.some(label => SENSITIVE.test(label)) || SENSITIVE.test(item.title ?? '') || policy.issues.sensitiveLabels.some(label => labels.has(label.toLowerCase()))) reasons.push('security-sensitive');
  if (policy.issues.blockedLabels.some(label => labels.has(label.toLowerCase()))) reasons.push('blocked');
  return reasons;
}
function hasClaimLabel(labels, exact, prefixes) {
  const exactLabels = lower(exact);
  return labels.some(label => {
    const normalized = label.trim().toLowerCase();
    if (exactLabels.has(normalized)) return true;
    return prefixes.some(prefix => normalized.startsWith(prefix.toLowerCase()) && LABEL_SUFFIX.test(normalized.slice(prefix.length)));
  });
}
function assignmentReasons(item, omit) {
  if (!Array.isArray(item.assignees)) fail('assignees must be an array');
  const actors = item.assignees.map((value, index) => account(value, `assignees[${index}]`)).filter(candidate => omit === null || !sameAccount(candidate, omit));
  const reasons = [];
  if (actors.some(candidate => candidate.kind === 'human')) reasons.push('assigned');
  if (actors.some(candidate => candidate.kind === 'unknown')) reasons.push('unverifiable-assignee');
  return reasons;
}
function recentClaim(comments, prefix, config, now, omit = null) {
  if (!config.enabled) return false;
  const cutoff = now - config.expiresAfterDays * 86_400_000;
  return comments.some((comment, index) => {
    const actor = account(comment.user, `comments[${index}].user`);
    if (actor.kind !== 'human' || (omit !== null && sameAccount(actor, omit))) return false;
    if (typeof comment.author_association !== 'string' || typeof comment.created_at !== 'string') fail(`comments[${index}] has invalid attribution or timestamp`);
    const createdAt = Date.parse(comment.created_at);
    const body = typeof comment.body === 'string' ? comment.body.trimStart() : '';
    return body.toLowerCase().startsWith(prefix.toLowerCase()) && /\S/u.test(body.slice(prefix.length)) && config.trustedAssociations.includes(comment.author_association.toUpperCase()) && Number.isFinite(createdAt) && createdAt >= cutoff && createdAt <= now + 300_000;
  });
}
function priority(item, policy) {
  const labels = lower(labelsOf(item));
  const index = policy.priorityLabels.findIndex(label => labels.has(label.toLowerCase()));
  return index === -1 ? policy.priorityLabels.length : index;
}
function issueState(repo, item, policy, now) {
  const reasons = commonReasons(item, policy); const labels = labelsOf(item); const normalizedLabels = lower(labels);
  if (EPIC_TITLE.test(item.title ?? '') || policy.issues.epicLabels.some(label => normalizedLabels.has(label.toLowerCase()))) reasons.push('epic');
  if (!policy.issues.allowUnlabeled && !policy.issues.readyLabels.some(label => normalizedLabels.has(label.toLowerCase()))) reasons.push('untriaged');
  if (policy.claims.assignees) reasons.push(...assignmentReasons(item, null));
  if (hasClaimLabel(labels, policy.claims.implementationLabels, policy.claims.implementationLabelPrefixes)) reasons.push('claimed');
  if (policy.claims.comments.enabled && item.comments > 0 && recentClaim(ghLines(`repos/${repo}/issues/${item.number}/comments?per_page=100`), policy.claims.comments.implementationPrefix, policy.claims.comments, now)) reasons.push('claimed');
  return [...new Set(reasons)].sort();
}
function currentHeadDecision(reviews, item) {
  const headSha = item.head?.sha;
  if (typeof headSha !== 'string' || !FULL_SHA.test(headSha.toLowerCase())) fail('pull request head.sha must be a full commit SHA');
  const pullAuthor = author(item); const latest = new Map();
  for (let index = 0; index < reviews.length; index += 1) {
    const review = reviews[index]; const reviewer = account(review.user, `reviews[${index}].user`);
    if (reviewer.kind !== 'human' || sameAccount(reviewer, pullAuthor)) continue;
    if (typeof review.state !== 'string') fail(`reviews[${index}].state must be a string`);
    const state = review.state.toUpperCase();
    if (!['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(state)) continue;
    const hasProvenance = typeof review.submitted_at === 'string' && Number.isFinite(Date.parse(review.submitted_at)) && typeof review.commit_id === 'string' && FULL_SHA.test(review.commit_id.toLowerCase());
    if (!hasProvenance && ['APPROVED', 'CHANGES_REQUESTED'].includes(state)) return ['UNVERIFIABLE'];
    if (!hasProvenance) continue;
    const key = reviewer.id === null ? `login:${reviewer.login.toLowerCase()}` : `id:${reviewer.id}`;
    const submittedAt = Date.parse(review.submitted_at); const previous = latest.get(key);
    if (!previous || submittedAt > previous.submittedAt) latest.set(key, {submittedAt, values: [{state, commit: review.commit_id.toLowerCase()}]});
    else if (submittedAt === previous.submittedAt) previous.values.push({state, commit: review.commit_id.toLowerCase()});
  }
  const decisions = [];
  for (const entry of latest.values()) {
    const states = entry.values.filter(value => value.commit === headSha.toLowerCase()).map(value => value.state);
    if (states.includes('CHANGES_REQUESTED')) decisions.push('CHANGES_REQUESTED');
    else if (states.includes('APPROVED')) decisions.push('APPROVED');
  }
  return decisions;
}
function pullState(repo, item, policy, now) {
  const reasons = commonReasons(item, policy); const labels = labelsOf(item); const pullAuthor = author(item);
  if (typeof item.draft !== 'boolean') fail('pull request draft must be boolean');
  if (item.draft) reasons.push('draft');
  if (hasClaimLabel(labels, policy.claims.reviewLabels, policy.claims.reviewLabelPrefixes)) reasons.push('claimed');
  if (policy.claims.assignees) reasons.push(...assignmentReasons(item, pullAuthor));
  if (!Array.isArray(item.requested_reviewers) || !Array.isArray(item.requested_teams)) fail('review requests must be arrays');
  if (item.requested_reviewers.length > 0 || item.requested_teams.length > 0) reasons.push('active-review-request');
  const reviews = ghLines(`repos/${repo}/pulls/${item.number}/reviews?per_page=100`);
  const decisions = currentHeadDecision(reviews, item);
  if (decisions.includes('UNVERIFIABLE')) reasons.push('unverifiable-review-state');
  if (decisions.includes('APPROVED')) reasons.push('already-approved');
  if (decisions.includes('CHANGES_REQUESTED')) reasons.push('changes-requested');
  if (policy.claims.comments.enabled) {
    const issueComments = ghLines(`repos/${repo}/issues/${item.number}/comments?per_page=100`);
    const inlineComments = ghLines(`repos/${repo}/pulls/${item.number}/comments?per_page=100`);
    if (recentClaim([...issueComments, ...inlineComments], policy.claims.comments.reviewPrefix, policy.claims.comments, now, pullAuthor)) reasons.push('claimed');
  }
  return [...new Set(reasons)].sort();
}
function normalized(repo, kind, item, reasons, policy) {
  if (!Number.isInteger(item.number) || typeof item.title !== 'string' || typeof item.html_url !== 'string' || typeof item.updated_at !== 'string' || !Number.isFinite(Date.parse(item.updated_at))) fail(`malformed ${kind} in ${repo}`);
  return {id: `${repo}#${item.number}`, repository: repo, kind, number: item.number, title: item.title, url: item.html_url, updatedAt: item.updated_at, labels: labelsOf(item).sort(), author: author(item).login, priority: priority(item, policy), reasons};
}
function collect(project, policy, filter) {
  const startedAt = new Date().toISOString(); const now = Date.now(); const candidates = []; const excluded = []; const repositories = [];
  for (const configured of project.repositories.filter(item => filter === null || item.id.toLowerCase() === filter.toLowerCase())) {
    const allIssues = ghLines(`repos/${configured.id}/issues?state=open&per_page=100&sort=updated&direction=desc`);
    const pulls = ghLines(`repos/${configured.id}/pulls?state=open&per_page=100&sort=updated&direction=desc`);
    const issues = allIssues.filter(item => item.pull_request === undefined);
    repositories.push({id: configured.id, branch: configured.branch, openIssues: issues.length, openPullRequests: pulls.length});
    if (policy.modes.some(mode => mode !== 'review')) for (const item of issues) {
      const reasons = issueState(configured.id, item, policy, now); const value = normalized(configured.id, 'issue', item, reasons, policy);
      (reasons.length === 0 ? candidates : excluded).push(value);
    }
    if (policy.modes.includes('review')) for (const item of pulls) {
      const reasons = pullState(configured.id, item, policy, now); const value = normalized(configured.id, 'pull-request', item, reasons, policy);
      (reasons.length === 0 ? candidates : excluded).push(value);
    }
  }
  const sort = (a, b) => a.priority - b.priority || Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.id.localeCompare(b.id);
  candidates.sort(sort); excluded.sort((a, b) => a.id.localeCompare(b.id));
  const completedAt = new Date().toISOString();
  return {schemaVersion: 1, project: project.id, generatedAt: completedAt, collection: {startedAt, completedAt, complete: true, consistency: 'GitHub APIs are not transactional; revalidate an item before acting.'}, repositories, summary: {candidates: candidates.length, excluded: excluded.length, openIssues: repositories.reduce((sum, repo) => sum + repo.openIssues, 0), openPullRequests: repositories.reduce((sum, repo) => sum + repo.openPullRequests, 0)}, candidates, excluded};
}
function markdown(report) {
  const out = [`# ${report.project} live work`, '', `Generated ${report.generatedAt}. GitHub is authoritative; revalidate before acting.`, '', `Candidates: ${report.summary.candidates}; excluded: ${report.summary.excluded}.`, '', '## Candidates', ''];
  if (report.candidates.length === 0) out.push('None.');
  else for (const item of report.candidates) out.push(`- [${item.id}: ${item.title}](${item.url}) (${item.kind})`);
  out.push('', '## Excluded', '');
  if (report.excluded.length === 0) out.push('None.');
  else for (const item of report.excluded) out.push(`- [${item.id}: ${item.title}](${item.url}) — ${item.reasons.join(', ')}`);
  return `${out.join('\n')}\n`;
}

try {
  const project = readJson(resolve(ROOT, 'project.json')); const policy = readJson(resolve(ROOT, 'policy.json'));
  const repos = validate(project, policy); const options = parseArgs(process.argv.slice(2), repos);
  const report = collect(project, policy, options.repo);
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : markdown(report));
} catch (error) {
  process.stderr.write(`live-report: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
