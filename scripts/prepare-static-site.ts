import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateSnapshot} from '../src/snapshot.js';

const REPOSITORY = 'freecodexyz/ship';
const PUBLIC_ORIGIN = 'https://ship.freecodefund.xyz';
const MAX_SKILL_FILES = 32;
const MAX_SKILL_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SKILL_TREE_BYTES = 16 * 1024 * 1024;

export type ContributorSkill = {
  readonly id: string;
  readonly name: string;
  readonly sourcePath: string;
};

type FileDigest = {readonly path: string; readonly sha256: string};

type SnapshotMetadata = {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly source: {readonly repository: string; readonly revision: string};
  readonly snapshot: {
    readonly schemaVersion: 3;
    readonly url: string;
    readonly sha256: string;
    readonly bytes: number;
  };
};

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function git(
  root: string,
  args: readonly string[],
  encoding: BufferEncoding = 'utf8',
): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding,
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

/** Finds canonical contributor skill trees and rejects orphaned trees. */
export async function discoverContributorSkills(
  root: string,
): Promise<readonly ContributorSkill[]> {
  const projectsDirectory = join(root, 'projects');
  const skillsDirectory = join(root, 'skills');
  const projectIds = new Set(
    (await readdir(projectsDirectory, {withFileTypes: true}))
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => entry.name.slice(0, -'.json'.length)),
  );
  const skills: ContributorSkill[] = [];
  for (const entry of await readdir(skillsDirectory, {withFileTypes: true})) {
    if (!entry.name.startsWith('contribute-to-')) continue;
    if (!entry.isDirectory()) {
      throw new TypeError(`${entry.name} must be a regular directory`);
    }
    const id = entry.name.slice('contribute-to-'.length);
    if (!projectIds.has(id)) {
      throw new TypeError(
        `contributor skill ${entry.name} has no projects/${id}.json`,
      );
    }
    const skillMarkdown = join(skillsDirectory, entry.name, 'SKILL.md');
    if (!(await lstat(skillMarkdown)).isFile()) {
      throw new TypeError(`${entry.name} must contain a regular SKILL.md`);
    }
    skills.push({id, name: entry.name, sourcePath: `skills/${entry.name}`});
  }
  return skills.sort((left, right) => left.id.localeCompare(right.id));
}

/** Constructs archive provenance from the exact canonical file manifest. */
export function buildProvenance(
  skill: ContributorSkill,
  revision: string,
  files: readonly FileDigest[],
): object {
  const source = files.find(file => file.path === 'SKILL.md');
  if (source === undefined) throw new TypeError(`${skill.name} omits SKILL.md`);
  return {
    schemaVersion: 1,
    name: skill.name,
    repository: REPOSITORY,
    revision,
    source: {path: `${skill.sourcePath}/SKILL.md`, sha256: source.sha256},
    files,
  };
}

/** Describes the exact public snapshot bytes for remote consumers. */
export async function publishedSnapshotMetadata(
  snapshotPath: string,
  revision: string,
): Promise<SnapshotMetadata> {
  const bytes = await readFile(snapshotPath);
  const snapshot: unknown = JSON.parse(bytes.toString('utf8'));
  const validated = validateSnapshot(snapshot);
  return {
    schemaVersion: 1,
    generatedAt: validated.generatedAt,
    source: {repository: REPOSITORY, revision},
    snapshot: {
      schemaVersion: 3,
      url: `${PUBLIC_ORIGIN}/api/v1/snapshot.json`,
      sha256: sha256(bytes),
      bytes: bytes.length,
    },
  };
}

async function regularFiles(
  root: string,
  prefix = '',
): Promise<readonly string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, {withFileTypes: true})) {
    const absolute = join(root, entry.name);
    const path = join(prefix, entry.name).replaceAll('\\', '/');
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink())
      throw new TypeError(`skill contains symlink: ${path}`);
    if (stats.isDirectory())
      files.push(...(await regularFiles(absolute, path)));
    else if (stats.isFile()) files.push(path);
    else throw new TypeError(`skill contains non-regular file: ${path}`);
  }
  return files.sort();
}

async function canonicalFileManifest(
  root: string,
  skill: ContributorSkill,
): Promise<readonly FileDigest[]> {
  const skillRoot = join(root, skill.sourcePath);
  const actual = await regularFiles(skillRoot);
  const tracked = git(root, ['ls-files', '-z', '--', skill.sourcePath])
    .split('\0')
    .filter(Boolean)
    .map(path => relative(skill.sourcePath, path).replaceAll('\\', '/'))
    .sort();
  if (
    tracked.length === 0 ||
    tracked.length > MAX_SKILL_FILES ||
    tracked.includes('PROVENANCE.json') ||
    tracked.length !== actual.length ||
    tracked.some((path, index) => path !== actual[index])
  ) {
    throw new TypeError(
      `${skill.name} must be an exact, bounded, tracked file tree`,
    );
  }
  const committed = git(root, [
    'ls-tree',
    '-r',
    '-z',
    '--name-only',
    'HEAD',
    '--',
    skill.sourcePath,
  ])
    .split('\0')
    .filter(Boolean)
    .map(path => relative(skill.sourcePath, path).replaceAll('\\', '/'))
    .sort();
  if (
    committed.length !== tracked.length ||
    committed.some((path, index) => path !== tracked[index])
  ) {
    throw new TypeError(`${skill.name} differs from the named Ship revision`);
  }
  let treeBytes = 0;
  const manifest: FileDigest[] = [];
  for (const path of tracked) {
    const bytes = await readFile(join(skillRoot, path));
    const committedBytes = execFileSync(
      'git',
      ['show', `HEAD:${skill.sourcePath}/${path}`],
      {
        cwd: root,
        encoding: 'buffer',
        maxBuffer: MAX_SKILL_FILE_BYTES + 1,
      },
    );
    if (!bytes.equals(committedBytes)) {
      throw new TypeError(
        `${skill.name}/${path} differs from the named Ship revision`,
      );
    }
    if (bytes.length > MAX_SKILL_FILE_BYTES) {
      throw new TypeError(`${skill.name}/${path} exceeds the file size bound`);
    }
    treeBytes += bytes.length;
    manifest.push({path, sha256: sha256(bytes)});
  }
  if (treeBytes > MAX_SKILL_TREE_BYTES)
    throw new TypeError(`${skill.name} exceeds the tree size bound`);
  return manifest;
}

async function publishSkill(
  root: string,
  outputRoot: string,
  skill: ContributorSkill,
  revision: string,
): Promise<object> {
  const files = await canonicalFileManifest(root, skill);
  const provenance = buildProvenance(skill, revision, files);
  const projectRoot = join(outputRoot, 'skills', 'v1', skill.id);
  const archiveName = `${skill.name}.skill`;
  const archivePath = join(projectRoot, archiveName);
  const staging = await mkdtemp(join(tmpdir(), `${skill.name}-`));
  try {
    const stagedSkill = join(staging, skill.name);
    for (const file of files) {
      const source = join(root, skill.sourcePath, file.path);
      const destination = join(stagedSkill, file.path);
      await mkdir(dirname(destination), {recursive: true});
      await cp(source, destination);
    }
    await writeFile(join(stagedSkill, 'PROVENANCE.json'), json(provenance));
    await mkdir(projectRoot, {recursive: true});
    execFileSync(
      'python3',
      [join(root, 'scripts', 'package-skill.py'), stagedSkill, archivePath],
      {
        cwd: root,
        stdio: 'inherit',
      },
    );
  } finally {
    await rm(staging, {recursive: true, force: true});
  }
  const archive = await readFile(archivePath);
  const archiveSha256 = sha256(archive);
  const source = files.find(file => file.path === 'SKILL.md');
  if (source === undefined) throw new TypeError(`${skill.name} omits SKILL.md`);
  await cp(
    join(root, skill.sourcePath, 'SKILL.md'),
    join(projectRoot, 'skill.md'),
  );
  await writeFile(
    join(projectRoot, `${archiveName}.sha256`),
    `${archiveSha256}  ${archiveName}\n`,
  );
  const manifest = {
    schemaVersion: 1,
    id: skill.id,
    name: skill.name,
    repository: REPOSITORY,
    revision,
    source: {
      path: `${skill.sourcePath}/SKILL.md`,
      url: `https://github.com/${REPOSITORY}/blob/${revision}/${skill.sourcePath}/SKILL.md`,
      publicUrl: `${PUBLIC_ORIGIN}/skills/v1/${skill.id}/skill.md`,
      sha256: source.sha256,
    },
    archive: {
      url: `${PUBLIC_ORIGIN}/skills/v1/${skill.id}/${archiveName}`,
      checksumUrl: `${PUBLIC_ORIGIN}/skills/v1/${skill.id}/${archiveName}.sha256`,
      sha256: archiveSha256,
      bytes: archive.length,
    },
    authority: {
      apiOrigin: 'https://api.github.com',
      rawOrigin: 'https://raw.githubusercontent.com',
      canonicalPath: skill.sourcePath,
      branch: 'main',
    },
  };
  await writeFile(join(projectRoot, 'manifest.json'), json(manifest));
  return manifest;
}

async function writeStaticFiles(outputRoot: string): Promise<void> {
  const headers = [
    '/*',
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: no-referrer',
    '  Strict-Transport-Security: max-age=31536000; includeSubDomains',
    "  Content-Security-Policy: default-src 'none'; frame-ancestors 'none'",
    '  Access-Control-Allow-Origin: *',
    '',
    '/api/*',
    '  Content-Type: application/json; charset=utf-8',
    '  Cache-Control: public, max-age=300, stale-while-revalidate=900',
    '',
    '/skills/*',
    '  Cache-Control: public, max-age=300, must-revalidate',
    '',
  ].join('\n');
  const html =
    '<!doctype html><html lang="en"><meta charset="utf-8"><title>Ship static resources</title><meta name="viewport" content="width=device-width"><body><h1>Ship static resources</h1><p><a href="/api/v1/index.json">Snapshot API</a> · <a href="/skills/v1/index.json">Contributor skills</a> · <a href="https://github.com/freecodexyz/ship/blob/main/STATIC_API.md">Documentation</a></p></body></html>\n';
  await writeFile(join(outputRoot, '_headers'), headers);
  await writeFile(join(outputRoot, 'index.html'), html);
}

async function main(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const outputRoot = join(root, 'dist');
  const sourceSnapshot = resolve(
    root,
    process.env.SHIP_SNAPSHOT_PATH ?? join('dist', 'snapshot.json'),
  );
  const revision = git(root, ['rev-parse', 'HEAD']);
  if (!/^[0-9a-f]{40}$/.test(revision))
    throw new TypeError('HEAD is not a full Git revision');
  const snapshotMetadata = await publishedSnapshotMetadata(
    sourceSnapshot,
    revision,
  );
  const snapshotBytes = await readFile(sourceSnapshot);

  await rm(join(outputRoot, 'api'), {recursive: true, force: true});
  await rm(join(outputRoot, 'skills'), {recursive: true, force: true});
  await mkdir(join(outputRoot, 'api', 'v1'), {recursive: true});
  await mkdir(join(outputRoot, 'skills', 'v1'), {recursive: true});
  await writeFile(
    join(outputRoot, 'api', 'v1', 'snapshot.json'),
    snapshotBytes,
  );
  await writeFile(
    join(outputRoot, 'api', 'v1', 'index.json'),
    json(snapshotMetadata),
  );

  const manifests = [];
  for (const skill of await discoverContributorSkills(root)) {
    manifests.push(await publishSkill(root, outputRoot, skill, revision));
  }
  await writeFile(
    join(outputRoot, 'skills', 'v1', 'index.json'),
    json({
      schemaVersion: 1,
      generatedAt: snapshotMetadata.generatedAt,
      repository: REPOSITORY,
      revision,
      skills: manifests,
    }),
  );
  await writeStaticFiles(outputRoot);
  console.log(
    `Prepared Ship static resources from ${revision}: ${manifests.length} skill artifact(s).`,
  );
}

if (import.meta.main) await main();
