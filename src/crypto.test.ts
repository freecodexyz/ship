import {describe, expect, test} from 'bun:test';
import {createHash, createPrivateKey, createPublicKey, sign} from 'node:crypto';

import {canonicalJson, verifyReceiptSignature} from './crypto.js';

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

type TestReceipt = {
  readonly version: 1;
  readonly runId: string;
  readonly project: string;
  readonly device: {
    readonly keyId: string;
    readonly publicKey: string;
  };
  readonly signature: string;
};

function signedReceipt(): TestReceipt {
  const unsignedReceipt = {
    version: 1,
    runId: 'run-fixture',
    project: 'ship',
    device: {
      keyId: DEVICE_KEY_ID,
      publicKey: PUBLIC_KEY_BASE64,
    },
  } as const;
  const signature = sign(
    null,
    Buffer.from(canonicalJson(unsignedReceipt), 'utf8'),
    PRIVATE_KEY,
  ).toString('base64');
  return {...unsignedReceipt, signature};
}

describe('canonicalJson', () => {
  test('sorts object keys recursively and preserves array order', () => {
    const fixture = {
      z: 3,
      nested: {unicode: {'\uE000': 2, '\uD83D\uDE00': 1}, b: false, a: null},
      array: [{y: 2, x: 1}, 'first', 4],
    };

    expect(canonicalJson(fixture)).toBe(
      '{"array":[{"x":1,"y":2},"first",4],"nested":{"a":null,"b":false,' +
        '"unicode":{"😀":1,"":2}},"z":3}',
    );
  });

  test('produces identical bytes regardless of object insertion order', () => {
    expect(canonicalJson({second: 2, first: 1})).toBe(
      canonicalJson({first: 1, second: 2}),
    );
  });

  test.each([
    ['undefined', undefined],
    ['a function', () => undefined],
    ['a symbol', Symbol('unsupported')],
    ['a bigint', 1n],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
  ] as const)('rejects %s', (_description, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });

  test('rejects unsupported values nested in objects and arrays', () => {
    expect(() => canonicalJson({invalid: undefined})).toThrow(TypeError);
    expect(() => canonicalJson([1, undefined])).toThrow(TypeError);

    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(() => canonicalJson(sparse)).toThrow(TypeError);
  });

  test('rejects non-plain objects and symbol keys', () => {
    expect(() => canonicalJson(new Date(0))).toThrow(TypeError);
    expect(() => canonicalJson({[Symbol('key')]: 'value'})).toThrow(TypeError);
  });

  test('rejects circular references but permits repeated references', () => {
    const circular: {self?: unknown} = {};
    circular.self = circular;
    expect(() => canonicalJson(circular)).toThrow(TypeError);

    const shared = {b: 2, a: 1};
    expect(canonicalJson([shared, shared])).toBe(
      '[{"a":1,"b":2},{"a":1,"b":2}]',
    );
  });
});

describe('verifyReceiptSignature', () => {
  test('verifies a canonical signed receipt without mutating it', () => {
    const receipt = signedReceipt();
    const before = canonicalJson(receipt);

    expect(verifyReceiptSignature(receipt)).toBe(true);
    expect(canonicalJson(receipt)).toBe(before);
  });

  test('rejects tampered signed fields and signatures', () => {
    const receipt = signedReceipt();

    expect(
      verifyReceiptSignature({...receipt, project: 'tampered-project'}),
    ).toBe(false);
    expect(
      verifyReceiptSignature({
        ...receipt,
        signature: Buffer.alloc(64).toString('base64'),
      }),
    ).toBe(false);
  });

  test('rejects a device key id not derived from the public key', () => {
    const receipt = signedReceipt();

    expect(
      verifyReceiptSignature({
        ...receipt,
        device: {...receipt.device, keyId: '0'.repeat(64)},
      }),
    ).toBe(false);
  });

  test('rejects malformed and non-canonical cryptographic encodings', () => {
    const receipt = signedReceipt();

    expect(
      verifyReceiptSignature({
        ...receipt,
        device: {...receipt.device, publicKey: 'not-base64'},
      }),
    ).toBe(false);
    expect(
      verifyReceiptSignature({
        ...receipt,
        signature: receipt.signature.replace(/=+$/, ''),
      }),
    ).toBe(false);
  });
});
