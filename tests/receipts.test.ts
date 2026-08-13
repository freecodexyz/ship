import {describe, expect, test} from 'bun:test';
import {createHash, createPrivateKey, createPublicKey, sign} from 'node:crypto';
import {readFileSync} from 'node:fs';

import {canonicalJson, verifyReceiptSignature} from '../src/crypto.js';
import {
  dedupeReceipts,
  parseReceiptMarker,
  validateReceipt,
} from '../src/receipts.js';
import {parseCanonicalTimestamp} from '../src/time.js';
import {
  parseRepoId,
  type Actor,
  type Project,
  type PullRequest,
  type RunReceipt,
} from '../src/types.js';

const PRIVATE_KEY = createPrivateKey(
  readFileSync(
    new URL('./fixtures/receipts/ed25519-private.pem', import.meta.url),
    'utf8',
  ),
);
const PUBLIC_KEY = createPublicKey(
  readFileSync(
    new URL('./fixtures/receipts/ed25519-public.pem', import.meta.url),
    'utf8',
  ),
);
const PUBLIC_KEY_DER = Buffer.from(
  PUBLIC_KEY.export({format: 'der', type: 'spki'}),
);
const RAW_PUBLIC_KEY = PUBLIC_KEY_DER.subarray(-32);
const PUBLIC_KEY_BASE64 = RAW_PUBLIC_KEY.toString('base64');
const DEVICE_KEY_ID = createHash('sha256').update(RAW_PUBLIC_KEY).digest('hex');

const ACTOR: Actor = {id: 'U_contract', login: 'contract-contributor'};
const PROJECT: Project = {
  id: 'ship',
  name: 'Ship',
  mission: 'Deliver bounded, reviewable improvements to Ship.',
  repositories: [{id: parseRepoId('OpenAI/Ship'), branch: 'main'}],
  allowedModels: [{client: 'codex', provider: 'openai', model: 'gpt-5'}],
};
const PULL_REQUEST: PullRequest = {
  id: 'PR_contract',
  repo: parseRepoId('openai/ship'),
  number: 42,
  title: 'Exercise the signed receipt contract',
  author: ACTOR,
  mergedAt: parseCanonicalTimestamp('2026-08-12T08:30:00.000Z'),
  headSha: 'd'.repeat(40),
  files: [],
  closedIssueIds: [],
  reviews: [],
  evidence: [],
};

function unsignedReceipt(
  overrides: Partial<Omit<RunReceipt, 'signature'>> = {},
): Omit<RunReceipt, 'signature'> {
  return {
    version: 1,
    runId: 'run-contract-01',
    project: 'ship',
    repo: parseRepoId('OPENAI/SHIP'),
    startedAt: parseCanonicalTimestamp('2026-08-12T08:00:00.000Z'),
    completedAt: parseCanonicalTimestamp('2026-08-12T08:10:00.000Z'),
    agent: {client: 'codex', provider: 'openai', model: 'gpt-5'},
    skill: {revision: 'v1.2.3+contract', sha256: 'a'.repeat(64)},
    usage: {confidence: 'exact', totalTokens: 123, costMicroUsd: '456'},
    device: {keyId: DEVICE_KEY_ID, publicKey: PUBLIC_KEY_BASE64},
    trajectorySha256: 'c'.repeat(64),
    ...overrides,
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

function marker(value: unknown): string {
  return `<!-- ship-receipt: ${canonicalJson(value)} -->`;
}

describe('receipt marker and canonical JSON contract', () => {
  test('parses one canonical marker and ignores quoted or fenced examples', () => {
    const receipt = signedReceipt();
    const body = [
      'Receipt examples:',
      '```html',
      marker({...receipt, runId: 'fenced-example'}),
      '```',
      `> ${marker({...receipt, runId: 'quoted-example'})}`,
      '',
      marker(receipt),
    ].join('\n');

    expect(parseReceiptMarker(body)).toEqual(receipt);
  });

  test('rejects missing, duplicate, malformed, and non-canonical markers', () => {
    const receipt = signedReceipt();
    const nonCanonicalPayload = JSON.stringify(receipt);

    expect(() => parseReceiptMarker('No receipt marker.')).toThrow(TypeError);
    expect(() =>
      parseReceiptMarker(`${marker(receipt)}\n${marker(receipt)}`),
    ).toThrow(/Duplicate/);
    expect(() =>
      parseReceiptMarker('<!-- ship-receipt: {"version":} -->'),
    ).toThrow(/valid JSON/);
    expect(() =>
      parseReceiptMarker(`<!-- ship-receipt: ${nonCanonicalPayload} -->`),
    ).toThrow(/canonical JSON/);
  });

  test('runtime-validates receipt fields and rejects unknown fields', () => {
    const receipt = signedReceipt();

    expect(() => parseReceiptMarker(marker({...receipt, version: 2}))).toThrow(
      /version/,
    );
    expect(() =>
      parseReceiptMarker(marker({...receipt, unknown: true})),
    ).toThrow(/unknown field/);
    expect(() =>
      parseReceiptMarker(
        marker({...receipt, agent: {...receipt.agent, client: 'other'}}),
      ),
    ).toThrow(/unsupported/);
  });

  test('sorts keys recursively while preserving array order', () => {
    expect(
      canonicalJson({z: 3, nested: {b: 2, a: 1}, values: [{y: 2, x: 1}, 0]}),
    ).toBe('{"nested":{"a":1,"b":2},"values":[{"x":1,"y":2},0],"z":3}');
    expect(canonicalJson({second: 2, first: 1})).toBe(
      canonicalJson({first: 1, second: 2}),
    );
  });
});

describe('deterministic Ed25519 fixture contract', () => {
  test('derives the fixed public key and device key id from fixture material', () => {
    const derivedPublicKey = Buffer.from(
      createPublicKey(PRIVATE_KEY).export({format: 'der', type: 'spki'}),
    );

    expect(derivedPublicKey).toEqual(PUBLIC_KEY_DER);
    expect(PUBLIC_KEY_BASE64).toBe(
      '11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=',
    );
    expect(DEVICE_KEY_ID).toBe(
      '21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9',
    );
  });

  test('signs deterministically and verifies the canonical unsigned receipt', () => {
    const first = signedReceipt();
    const second = signedReceipt();

    expect(first.signature).toBe(second.signature);
    expect(first.signature).toBe(
      'ePDRTCXSLtVzldOYZ4FcBSzoqNvJ2saB9vNIPmjm/1EoD+fDb7of2WdAaGExNQXh+' +
        '1a/WYDaKPm9OyMQt7wBCw==',
    );
    expect(verifyReceiptSignature(first)).toBe(true);
    expect(validateReceipt(first, PROJECT, PULL_REQUEST)).toBe(first);
  });

  test('rejects mismatched key ids, malformed signatures, and tampering', () => {
    const receipt = signedReceipt();

    expect(
      verifyReceiptSignature({
        ...receipt,
        device: {...receipt.device, keyId: '0'.repeat(64)},
      }),
    ).toBe(false);
    expect(verifyReceiptSignature({...receipt, signature: 'not-base64'})).toBe(
      false,
    );
    expect(
      verifyReceiptSignature({
        ...receipt,
        usage: {...receipt.usage, totalTokens: 124},
      }),
    ).toBe(false);

    const tamperedRunId = {...receipt, runId: 'run-contract-tampered'};
    expect(() => validateReceipt(tamperedRunId, PROJECT, PULL_REQUEST)).toThrow(
      /signature/,
    );
  });
});

describe('receipt runtime validation contract', () => {
  test('rejects project and repository mismatches', () => {
    const wrongProject = signedReceipt({
      ...unsignedReceipt(),
      project: 'other',
    });
    const wrongRepository = signedReceipt({
      ...unsignedReceipt(),
      repo: parseRepoId('openai/other'),
    });

    expect(() => validateReceipt(wrongProject, PROJECT, PULL_REQUEST)).toThrow(
      /project/,
    );
    expect(() =>
      validateReceipt(wrongRepository, PROJECT, PULL_REQUEST),
    ).toThrow(/repository/);
  });

  test('rejects unsupported model tuples', () => {
    const receipt = signedReceipt({
      ...unsignedReceipt(),
      agent: {client: 'codex', provider: 'openai', model: 'unsupported'},
    });

    expect(() => validateReceipt(receipt, PROJECT, PULL_REQUEST)).toThrow(
      /not allowed/,
    );
  });

  test.each([
    {confidence: 'exact', totalTokens: -1, costMicroUsd: '1'},
    {confidence: 'exact', totalTokens: 1.5, costMicroUsd: '1'},
    {confidence: 'bounded', totalTokens: 1, costMicroUsd: '01'},
    {confidence: 'unavailable', totalTokens: 1, costMicroUsd: '0'},
    {confidence: 'unavailable', totalTokens: 0, costMicroUsd: '1'},
  ] as const)('rejects malformed usage %#', usage => {
    const receipt = {...signedReceipt(), usage} as unknown as RunReceipt;

    expect(() => parseReceiptMarker(marker(receipt))).toThrow(
      /usage|zero values|safe integer/,
    );
    expect(() => validateReceipt(receipt, PROJECT, PULL_REQUEST)).toThrow(
      /usage|zero values|safe integer/,
    );
  });
});

describe('receipt deduplication contract', () => {
  test('collapses duplicate run ids with identical canonical bytes', () => {
    const first = signedReceipt();
    const duplicate = signedReceipt();

    const accepted = dedupeReceipts([
      {receipt: first, actor: ACTOR},
      {receipt: duplicate, actor: ACTOR},
    ]);

    expect(accepted).toEqual([first]);
    expect(accepted[0]).toBe(first);
  });

  test('rejects all conflicting bytes for one run id without affecting others', () => {
    const original = signedReceipt();
    const conflict = signedReceipt({
      ...unsignedReceipt(),
      usage: {confidence: 'exact', totalTokens: 999, costMicroUsd: '456'},
    });
    const unrelated = signedReceipt({
      ...unsignedReceipt(),
      runId: 'run-contract-02',
    });

    expect(
      dedupeReceipts([
        {receipt: original, actor: ACTOR},
        {receipt: unrelated, actor: ACTOR},
        {receipt: conflict, actor: ACTOR},
      ]),
    ).toEqual([unrelated]);
  });
});
