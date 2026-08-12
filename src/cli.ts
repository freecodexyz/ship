import {createBaseContractReader} from './createBaseContractReader.js';
import {createGitHubUserIdResolver} from './createGitHubUserIdResolver.js';
import {generate, type GenerationOptions} from './generate.js';
import {
  BASE_MAINNET_CHAIN_ID,
  resolveActorWallet,
  type ActorWalletResolution,
} from './resolveActorWallet.js';
import {parseCanonicalTimestamp} from './time.js';
import type {Actor} from './types.js';
import {writeCycleProposal} from './writeCycleProposal.js';

const GENERATE_USAGE =
  'Usage: bun src/cli.ts [--projects-dir PATH] [--output PATH] ' +
  '[--now TIMESTAMP] [--collection-window-days DAYS]';
const PROPOSAL_USAGE =
  'Usage: bun src/cli.ts proposal --project ID --cycle YYYY-MM ' +
  '--generated-at TIMESTAMP --base-rpc-url URL [--snapshot PATH]';

type GenerateOptions = {
  readonly projectsDirectory?: string;
  readonly outputPath?: string;
  readonly now?: string;
  readonly collectionWindowDays?: number;
};

type Result<T> =
  | {readonly ok: true; readonly value: T}
  | {readonly ok: false; readonly message: string};

type ProposalOptions = {
  readonly project: string;
  readonly cycle: string;
  readonly generatedAt: string;
  readonly baseRpcUrl: string;
  readonly snapshotPath: string;
};

type Output = {
  readonly write: (message: string) => void;
};

type Environment = Readonly<Record<string, string | undefined>>;

type CliDependencies = {
  readonly createWalletResolver: (
    githubToken: string,
    baseRpcUrl: string,
  ) => (actor: Actor) => Promise<ActorWalletResolution>;
  readonly generate: typeof generate;
  readonly writeProposal: typeof writeCycleProposal;
};

const DEFAULT_DEPENDENCIES: CliDependencies = {
  createWalletResolver: (githubToken, baseRpcUrl) => {
    const resolveGitHubUserId = createGitHubUserIdResolver(githubToken);
    const readContract = createBaseContractReader(baseRpcUrl);
    return actor =>
      resolveActorWallet(
        actor.id,
        BASE_MAINNET_CHAIN_ID,
        resolveGitHubUserId,
        readContract,
      );
  },
  generate,
  writeProposal: writeCycleProposal,
};

/** Runs the executable command and returns its process exit code. */
export async function runCli(
  argv: readonly string[],
  environment: Environment,
  output: Output,
  errorOutput: Output,
  dependencies: CliDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  if (argv[0] === 'proposal') {
    return runProposalCommand(
      argv.slice(1),
      environment,
      output,
      errorOutput,
      dependencies,
    );
  }
  const parsed = parseGenerateArguments(argv);
  if (!parsed.ok) {
    errorOutput.write(`ship: ${parsed.message}\n${GENERATE_USAGE}\n`);
    return 1;
  }

  const token = parseGitHubToken(environment.GITHUB_TOKEN);
  if (!token.ok) {
    errorOutput.write(`ship: ${token.message}\n`);
    return 1;
  }

  try {
    const snapshot = await dependencies.generate({
      ...generationOptions(parsed.value, token.value),
      log: message => errorOutput.write(`ship: ${message}\n`),
    });
    const destination = parsed.value.outputPath ?? 'dist/snapshot.json';
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

async function runProposalCommand(
  argv: readonly string[],
  environment: Environment,
  output: Output,
  errorOutput: Output,
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseProposalArguments(argv);
  if (!parsed.ok) {
    errorOutput.write(`ship: ${parsed.message}\n${PROPOSAL_USAGE}\n`);
    return 1;
  }
  const token = parseGitHubToken(environment.GITHUB_TOKEN);
  if (!token.ok) {
    errorOutput.write(`ship: ${token.message}\n`);
    return 1;
  }

  try {
    const proposal = await dependencies.writeProposal({
      project: parsed.value.project,
      cycle: parsed.value.cycle,
      generatedAt: parsed.value.generatedAt,
      snapshotPath: parsed.value.snapshotPath,
      resolveWallet: dependencies.createWalletResolver(
        token.value,
        parsed.value.baseRpcUrl,
      ),
    });
    output.write(
      `Wrote ${proposal.allocations.length} allocations for ` +
        `${proposal.project}/${proposal.cycle} to ` +
        `cycles/${proposal.project}/${proposal.cycle}/proposal.json.\n`,
    );
    return 0;
  } catch (error: unknown) {
    errorOutput.write(`ship: proposal failed: ${errorMessage(error)}\n`);
    return 1;
  }
}

function parseProposalArguments(
  argv: readonly string[],
): Result<ProposalOptions> {
  const values = new Map<string, string>();
  const supportedFlags = new Set([
    '--project',
    '--cycle',
    '--generated-at',
    '--base-rpc-url',
    '--snapshot',
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (flag === undefined || !supportedFlags.has(flag)) {
      return {ok: false, message: `unknown proposal flag: ${flag ?? ''}`};
    }
    if (values.has(flag)) {
      return {ok: false, message: `duplicate flag: ${flag}`};
    }
    const value = argv[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith('--')) {
      return {ok: false, message: `missing value for ${flag}`};
    }
    values.set(flag, value);
  }

  const project = values.get('--project');
  const cycle = values.get('--cycle');
  const generatedAt = values.get('--generated-at');
  const baseRpcUrl = values.get('--base-rpc-url');
  if (project === undefined)
    return {ok: false, message: '--project is required'};
  if (cycle === undefined || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(cycle)) {
    return {ok: false, message: '--cycle must use YYYY-MM'};
  }
  if (generatedAt === undefined) {
    return {ok: false, message: '--generated-at is required'};
  }
  try {
    parseCanonicalTimestamp(generatedAt);
  } catch {
    return {
      ok: false,
      message: '--generated-at must use canonical UTC timestamp form',
    };
  }
  if (baseRpcUrl === undefined) {
    return {ok: false, message: '--base-rpc-url is required'};
  }
  return {
    ok: true,
    value: {
      project,
      cycle,
      generatedAt,
      baseRpcUrl,
      snapshotPath: values.get('--snapshot') ?? 'dist/snapshot.json',
    },
  };
}

function parseGenerateArguments(
  argv: readonly string[],
): Result<GenerateOptions> {
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
    value: {
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
): Result<number | undefined> {
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

function parseGitHubToken(value: string | undefined): Result<string> {
  if (value === undefined || value.length === 0 || /\s/.test(value)) {
    return {
      ok: false,
      message: 'GITHUB_TOKEN must be set to a non-whitespace token',
    };
  }
  return {ok: true, value};
}

function generationOptions(
  options: GenerateOptions,
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

if (import.meta.main) {
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
      process.stderr.write(`ship: command failed: ${errorMessage(error)}\n`);
      process.exitCode = 1;
    },
  );
}
