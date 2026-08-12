import {describe, expect, test} from 'bun:test';
import {createHash, createPrivateKey, createPublicKey, sign} from 'node:crypto';

import {canonicalJson} from './crypto.js';
import {
  dedupeReceipts,
  parseReceiptMarker,
  validateReceipt,
} from './receipts.js';
import {parseCanonicalTimestamp} from './time.js';
import {
  parseRepoId,
  type Actor,
  type Project,
  type PullRequest,
  type RunReceipt,
} from './types.js';

const ED25519_PRIVATE_KEY_PREFIX = Buffer.from(
  '302e020100300506032b657004220420',
  'hex',
);
const PRIVATE_KEY_SEED = Buffer.from(
  '9d61b19deffd5a60ba844af492ec2cc4' + '4449c5697b326919703bac031cae7f60',
  'hex',
);
const PRIVATE_KEY = createPrivateKey({
  key: Buffer.concat([ED25519_PRIVATE_KEY_PREFIX, PRIVATE_KEY_SEED]),
  format: 'der',
  type: 'pkcs8',
});
const PUBLIC_KEY_DER = createPublicKey(PRIVATE_KEY).export({
  format: 'der',
  type: 'spki',
});
const PUBLIC_KEY = PUBLIC_KEY_DER.subarray(-32);
const PUBLIC_KEY_BASE64 = PUBLIC_KEY.toString('base64');
const DEVICE_KEY_ID = createHash('sha256').update(PUBLIC_KEY).digest('hex');

const RECEIPT: RunReceipt = {
  version: 1,
  runId: 'run-01',
  project: 'ship',
  repo: 'openai/ship',
  startedAt: parseCanonicalTimestamp('2026-08-12T08:00:00.000Z'),
  completedAt: parseCanonicalTimestamp('2026-08-12T08:10:00.000Z'),
  agent: {client: 'codex', provider: 'openai', model: 'gpt-5'},
  skill: {revision: 'v1', sha256: 'a'.repeat(64)},
  usage: {confidence: 'exact', totalTokens: 123, costMicroUsd: '456'},
  device: {keyId: 'b'.repeat(64), publicKey: 'public-key'},
  trajectorySha256: 'c'.repeat(64),
  signature: 'signature',
};

function marker(value: unknown = RECEIPT): string {
  return `<!-- ship-receipt: ${canonicalJson(value)} -->`;
}

const PROJECT: Project = {
  id: 'ship',
  name: 'Ship',
  repositories: [{id: parseRepoId('OpenAI/Ship'), branch: 'main'}],
  allowedModels: [{client: 'codex', provider: 'openai', model: 'gpt-5'}],
};

const PULL_REQUEST: PullRequest = {
  id: 'PR_kwDOFixture',
  repo: parseRepoId('openai/ship'),
  number: 42,
  title: 'Implement receipt validation',
  author: {id: 'U_fixture', login: 'contributor'},
  mergedAt: parseCanonicalTimestamp('2026-08-12T08:30:00.000Z'),
  headSha: 'd'.repeat(40),
  files: [],
  closedIssueIds: [],
  reviews: [],
  evidence: [],
};

const ACTOR: Actor = {id: 'U_fixture', login: 'contributor'};

function unsignedReceipt(): Omit<RunReceipt, 'signature'> {
  return {
    version: 1,
    runId: 'run-01',
    project: 'ship',
    repo: parseRepoId('OPENAI/SHIP'),
    startedAt: parseCanonicalTimestamp('2026-08-12T08:00:00.000Z'),
    completedAt: parseCanonicalTimestamp('2026-08-12T08:10:00.000Z'),
    agent: {client: 'codex', provider: 'openai', model: 'gpt-5'},
    skill: {revision: 'v1.2.3+fixture', sha256: 'a'.repeat(64)},
    usage: {confidence: 'exact', totalTokens: 123, costMicroUsd: '456'},
    device: {keyId: DEVICE_KEY_ID, publicKey: PUBLIC_KEY_BASE64},
    trajectorySha256: 'c'.repeat(64),
  };
}

function signedReceipt(
  unsigned: Omit<RunReceipt, 'signature'> = unsignedReceipt(),
): RunReceipt {
  const signature = sign(
    null,
    Buffer.from(canonicalJson(unsigned), 'utf8'),
    PRIVATE_KEY,
  ).toString('base64');
  return {...unsigned, signature};
}

describe('parseReceiptMarker', () => {
  test('extracts one canonical receipt marker from accepted prose', () => {
    expect(parseReceiptMarker(`Contribution details\n\n${marker()}\n`)).toEqual(
      RECEIPT,
    );
  });

  test('accepts the receipt without its optional trajectory digest', () => {
    const {trajectorySha256, ...receipt} = RECEIPT;
    void trajectorySha256;

    expect(parseReceiptMarker(marker(receipt))).toEqual(receipt);
  });

  test('ignores marker examples in fenced code blocks and blockquotes', () => {
    const body = [
      '```markdown',
      marker({...RECEIPT, runId: 'fenced'}),
      '```',
      `> ${marker({...RECEIPT, runId: 'quoted'})}`,
      '~~~',
      marker({...RECEIPT, runId: 'tilde-fenced'}),
      '~~~',
      marker(),
    ].join('\n');

    expect(parseReceiptMarker(body)).toEqual(RECEIPT);
  });

  test('rejects no marker and duplicate markers', () => {
    expect(() => parseReceiptMarker('No receipt here.')).toThrow(TypeError);
    expect(() => parseReceiptMarker(`${marker()}\n${marker()}`)).toThrow(
      /Duplicate/,
    );
  });

  test.each([
    '<!-- ship-receipt {"version":1} -->',
    '<!-- SHIP-RECEIPT: {"version":1} -->',
    '<!-- ship-receipt: not-json -->',
    `prefix ${marker()}`,
    `${marker()} suffix`,
  ])('rejects malformed or unsupported marker %s', malformed => {
    expect(() => parseReceiptMarker(malformed)).toThrow(TypeError);
  });

  test('rejects malformed and non-canonical JSON payloads', () => {
    expect(() =>
      parseReceiptMarker('<!-- ship-receipt: {"version":} -->'),
    ).toThrow(/valid JSON/);
    expect(() =>
      parseReceiptMarker(
        `<!-- ship-receipt: ${JSON.stringify(RECEIPT, null, 0)} -->`,
      ),
    ).toThrow(/canonical JSON/);
  });

  test('rejects unknown fields and structurally invalid nested values', () => {
    expect(() =>
      parseReceiptMarker(marker({...RECEIPT, unexpected: true})),
    ).toThrow(/unknown field/);
    expect(() =>
      parseReceiptMarker(
        marker({...RECEIPT, agent: {...RECEIPT.agent, client: 'other'}}),
      ),
    ).toThrow(/unsupported/);
    expect(() =>
      parseReceiptMarker(
        marker({
          ...RECEIPT,
          usage: {
            confidence: 'unavailable',
            totalTokens: 1,
            costMicroUsd: '0',
          },
        }),
      ),
    ).toThrow(/zero values/);
  });

  test('does not perform semantic receipt validation', () => {
    const receipt = {...RECEIPT, runId: '', signature: ''};

    expect(parseReceiptMarker(marker(receipt))).toEqual(receipt);
  });
});

describe('validateReceipt', () => {
  test('validates parser output by identity and accepts repository casing', () => {
    const receipt = parseReceiptMarker(marker(signedReceipt()));

    expect(validateReceipt(receipt, PROJECT, PULL_REQUEST)).toBe(receipt);
  });

  test.each(['', ' run-01', 'run 01', 'run/01', 'x'.repeat(129)])(
    'rejects malformed run id %j',
    runId => {
      expect(() =>
        validateReceipt(
          signedReceipt({...unsignedReceipt(), runId}),
          PROJECT,
          PULL_REQUEST,
        ),
      ).toThrow(/runId/);
    },
  );

  test('rejects unsupported schema versions and malformed timestamps', () => {
    const version = signedReceipt() as unknown as {version: number};
    version.version = 2;
    expect(() =>
      validateReceipt(version as unknown as RunReceipt, PROJECT, PULL_REQUEST),
    ).toThrow(/version/);

    const malformed = {
      ...signedReceipt(),
      startedAt: '2026-08-12T08:00:00Z',
    } as unknown as RunReceipt;
    expect(() => validateReceipt(malformed, PROJECT, PULL_REQUEST)).toThrow(
      /canonical UTC timestamp/,
    );
  });

  test('rejects reversed runs and runs completed after pull-request merge', () => {
    const reversed = signedReceipt({
      ...unsignedReceipt(),
      startedAt: parseCanonicalTimestamp('2026-08-12T08:11:00.000Z'),
    });
    expect(() => validateReceipt(reversed, PROJECT, PULL_REQUEST)).toThrow(
      /precede/,
    );

    const afterMerge = signedReceipt({
      ...unsignedReceipt(),
      completedAt: parseCanonicalTimestamp('2026-08-12T08:31:00.000Z'),
    });
    expect(() => validateReceipt(afterMerge, PROJECT, PULL_REQUEST)).toThrow(
      /merge/,
    );
  });

  test('rejects project and repository mismatches', () => {
    const wrongProject = signedReceipt({
      ...unsignedReceipt(),
      project: 'other',
    });
    expect(() => validateReceipt(wrongProject, PROJECT, PULL_REQUEST)).toThrow(
      /project/,
    );

    const wrongRepo = signedReceipt({
      ...unsignedReceipt(),
      repo: parseRepoId('openai/other'),
    });
    expect(() => validateReceipt(wrongRepo, PROJECT, PULL_REQUEST)).toThrow(
      /repository/,
    );

    const unownedProject: Project = {
      ...PROJECT,
      repositories: [{id: parseRepoId('openai/other'), branch: 'main'}],
    };
    expect(() =>
      validateReceipt(signedReceipt(), unownedProject, PULL_REQUEST),
    ).toThrow(/not owned/);
  });

  test('rejects an agent tuple not explicitly allowed by the project', () => {
    const receipt = signedReceipt({
      ...unsignedReceipt(),
      agent: {client: 'codex', provider: 'openai', model: 'gpt-4'},
    });

    expect(() => validateReceipt(receipt, PROJECT, PULL_REQUEST)).toThrow(
      /not allowed/,
    );
  });

  test.each([
    [{revision: 'bad revision', sha256: 'a'.repeat(64)}, /revision/],
    [{revision: 'v1', sha256: 'A'.repeat(64)}, /skill digest/],
    [{revision: 'v1', sha256: 'a'.repeat(63)}, /skill digest/],
  ] as const)('rejects malformed skill provenance', (skill, message) => {
    const receipt = signedReceipt({...unsignedReceipt(), skill});

    expect(() => validateReceipt(receipt, PROJECT, PULL_REQUEST)).toThrow(
      message,
    );
  });

  test('rejects malformed usage and accepts the unavailable zero state', () => {
    const unsafeUsage = signedReceipt({
      ...unsignedReceipt(),
      usage: {
        confidence: 'exact',
        totalTokens: Number.MAX_SAFE_INTEGER + 1,
        costMicroUsd: '1',
      },
    });
    expect(() => validateReceipt(unsafeUsage, PROJECT, PULL_REQUEST)).toThrow(
      /safe integer/,
    );

    const unavailable = signedReceipt({
      ...unsignedReceipt(),
      usage: {confidence: 'unavailable', totalTokens: 0, costMicroUsd: '0'},
    });
    expect(validateReceipt(unavailable, PROJECT, PULL_REQUEST)).toBe(
      unavailable,
    );

    const invalidUnavailable = signedReceipt({
      ...unsignedReceipt(),
      usage: {
        confidence: 'unavailable',
        totalTokens: 1,
        costMicroUsd: '0',
      } as unknown as RunReceipt['usage'],
    });
    expect(() =>
      validateReceipt(invalidUnavailable, PROJECT, PULL_REQUEST),
    ).toThrow(/zero values/);
  });

  test('rejects malformed optional trajectory digests', () => {
    const receipt = signedReceipt({
      ...unsignedReceipt(),
      trajectorySha256: 'C'.repeat(64),
    });

    expect(() => validateReceipt(receipt, PROJECT, PULL_REQUEST)).toThrow(
      /trajectory digest/,
    );
  });

  test('rejects malformed device keys, signatures, and tampered fields', () => {
    const badKeyId = signedReceipt({
      ...unsignedReceipt(),
      device: {...unsignedReceipt().device, keyId: '0'.repeat(64)},
    });
    expect(() => validateReceipt(badKeyId, PROJECT, PULL_REQUEST)).toThrow(
      /signature/,
    );

    const badPublicKey = signedReceipt({
      ...unsignedReceipt(),
      device: {...unsignedReceipt().device, publicKey: 'not-base64'},
    });
    expect(() => validateReceipt(badPublicKey, PROJECT, PULL_REQUEST)).toThrow(
      /signature/,
    );

    const badSignature = {
      ...signedReceipt(),
      signature: Buffer.alloc(64).toString('base64'),
    };
    expect(() => validateReceipt(badSignature, PROJECT, PULL_REQUEST)).toThrow(
      /signature/,
    );

    const tampered = {...signedReceipt(), runId: 'run-02'};
    expect(() => validateReceipt(tampered, PROJECT, PULL_REQUEST)).toThrow(
      /signature/,
    );
  });

  test('keeps receipt failure isolated from pull-request scoring inputs', () => {
    const invalidReceipt = {
      ...signedReceipt(),
      signature: Buffer.alloc(64).toString('base64'),
    };
    const pullRequest = {...PULL_REQUEST, receipt: invalidReceipt};
    const before = canonicalJson(pullRequest);

    expect(() => validateReceipt(invalidReceipt, PROJECT, pullRequest)).toThrow(
      /signature/,
    );
    expect(canonicalJson(pullRequest)).toBe(before);
    expect(pullRequest.id).toBe(PULL_REQUEST.id);
  });
});

describe('dedupeReceipts', () => {
  test('collapses exact canonical duplicates and preserves discovery order', () => {
    const first = signedReceipt();
    const duplicate = signedReceipt();
    const second = signedReceipt({...unsignedReceipt(), runId: 'run-02'});

    const accepted = dedupeReceipts([
      {receipt: first, actor: ACTOR},
      {receipt: duplicate, actor: ACTOR},
      {receipt: second, actor: ACTOR},
    ]);

    expect(accepted).toEqual([first, second]);
    expect(accepted[0]).toBe(first);
  });

  test('rejects every receipt sharing a run id with conflicting bytes', () => {
    const original = signedReceipt();
    const conflict = signedReceipt({
      ...unsignedReceipt(),
      usage: {confidence: 'exact', totalTokens: 124, costMicroUsd: '456'},
    });
    const unrelated = signedReceipt({...unsignedReceipt(), runId: 'run-02'});

    expect(
      dedupeReceipts([
        {receipt: original, actor: ACTOR},
        {receipt: unrelated, actor: ACTOR},
        {receipt: conflict, actor: ACTOR},
      ]),
    ).toEqual([unrelated]);
  });

  test('rejects every receipt from a device used by multiple actors', () => {
    const first = signedReceipt();
    const second = signedReceipt({...unsignedReceipt(), runId: 'run-02'});
    const otherActor: Actor = {id: 'U_other', login: 'other'};

    expect(
      dedupeReceipts([
        {receipt: first, actor: ACTOR},
        {receipt: second, actor: otherActor},
      ]),
    ).toEqual([]);
  });

  test('uses stable actor id rather than mutable login for device ownership', () => {
    const first = signedReceipt();
    const second = signedReceipt({...unsignedReceipt(), runId: 'run-02'});
    const renamedActor: Actor = {id: ACTOR.id, login: 'renamed'};

    expect(
      dedupeReceipts([
        {receipt: first, actor: ACTOR},
        {receipt: second, actor: renamedActor},
      ]),
    ).toEqual([first, second]);
  });
});
