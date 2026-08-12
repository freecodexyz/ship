import {generate, type GenerationOptions} from './generate.js';
import {parseCanonicalTimestamp} from './time.js';

const USAGE =
  'Usage: bun src/cli.ts [--projects-dir PATH] [--output PATH] ' +
  '[--now TIMESTAMP] [--collection-window-days DAYS]';

type CliOptions = {
  readonly projectsDirectory?: string;
  readonly outputPath?: string;
  readonly now?: string;
  readonly collectionWindowDays?: number;
};

type ParseResult =
  | {readonly ok: true; readonly options: CliOptions}
  | {readonly ok: false; readonly message: string};

type Output = {
  readonly write: (message: string) => void;
};

type Environment = Readonly<Record<string, string | undefined>>;

/** Runs the executable command and returns its process exit code. */
async function runCli(
  argv: readonly string[],
  environment: Environment,
  output: Output,
  errorOutput: Output,
): Promise<number> {
  const parsed = parseArguments(argv);
  if (!parsed.ok) {
    errorOutput.write(`ship: ${parsed.message}\n${USAGE}\n`);
    return 1;
  }

  const token = parseGitHubToken(environment.GITHUB_TOKEN);
  if (!token.ok) {
    errorOutput.write(`ship: ${token.message}\n`);
    return 1;
  }

  try {
    const snapshot = await generate({
      ...generationOptions(parsed.options, token.value),
      log: message => errorOutput.write(`ship: ${message}\n`),
    });
    const destination = parsed.options.outputPath ?? 'dist/snapshot.json';
    output.write(
      `Generated ${snapshot.projects.length} projects, ` +
        `${snapshot.buckets.length} buckets, ${snapshot.awards.length} awards, ` +
        `and ${snapshot.receipts.length} receipts in ${destination}.\n`,
    );
    return 0;
  } catch (error: unknown) {
    errorOutput.write(`ship: generation failed: ${errorMessage(error)}\n`);
    return 1;
  }
}

function parseArguments(argv: readonly string[]): ParseResult {
  const values = new Map<string, string>();
  const supportedFlags = new Set([
    '--projects-dir',
    '--output',
    '--now',
    '--collection-window-days',
  ]);

  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (flag === undefined || !supportedFlags.has(flag)) {
      return {ok: false, message: `unknown flag: ${flag ?? ''}`};
    }
    if (values.has(flag)) {
      return {ok: false, message: `duplicate flag: ${flag}`};
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--') || value.length === 0) {
      return {ok: false, message: `missing value for ${flag}`};
    }
    values.set(flag, value);
  }

  const projectsDirectory = values.get('--projects-dir');
  const outputPath = values.get('--output');
  const now = values.get('--now');
  const collectionWindowDays = values.get('--collection-window-days');

  if (now !== undefined) {
    try {
      parseCanonicalTimestamp(now);
    } catch {
      return {
        ok: false,
        message: '--now must use canonical UTC form YYYY-MM-DDTHH:mm:ss.sssZ',
      };
    }
  }

  const parsedDays = parsePositiveSafeInteger(collectionWindowDays);
  if (!parsedDays.ok) return parsedDays;

  return {
    ok: true,
    options: {
      ...(projectsDirectory === undefined ? {} : {projectsDirectory}),
      ...(outputPath === undefined ? {} : {outputPath}),
      ...(now === undefined ? {} : {now}),
      ...(parsedDays.value === undefined
        ? {}
        : {collectionWindowDays: parsedDays.value}),
    },
  };
}

function parsePositiveSafeInteger(
  value: string | undefined,
):
  | {readonly ok: true; readonly value: number | undefined}
  | {readonly ok: false; readonly message: string} {
  if (value === undefined) return {ok: true, value: undefined};
  if (!/^[1-9]\d*$/.test(value)) {
    return {
      ok: false,
      message: '--collection-window-days must be a positive integer',
    };
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return {
      ok: false,
      message: '--collection-window-days must be a positive safe integer',
    };
  }
  return {ok: true, value: parsed};
}

function parseGitHubToken(
  value: string | undefined,
):
  | {readonly ok: true; readonly value: string}
  | {readonly ok: false; readonly message: string} {
  if (value === undefined || value.length === 0 || /\s/.test(value)) {
    return {
      ok: false,
      message: 'GITHUB_TOKEN must be set to a non-whitespace token',
    };
  }
  return {ok: true, value};
}

function generationOptions(
  options: CliOptions,
  githubToken: string,
): GenerationOptions {
  return {
    githubToken,
    ...(options.projectsDirectory === undefined
      ? {}
      : {projectsDirectory: options.projectsDirectory}),
    ...(options.outputPath === undefined
      ? {}
      : {outputPath: options.outputPath}),
    ...(options.now === undefined ? {} : {now: options.now}),
    ...(options.collectionWindowDays === undefined
      ? {}
      : {collectionWindowDays: options.collectionWindowDays}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void runCli(
  process.argv.slice(2),
  process.env,
  process.stdout,
  process.stderr,
).then(
  exitCode => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    process.stderr.write(`ship: generation failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  },
);
