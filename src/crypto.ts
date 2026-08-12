import {createHash, createPublicKey, verify} from 'node:crypto';

const ED25519_PUBLIC_KEY_LENGTH = 32;
const ED25519_SIGNATURE_LENGTH = 64;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const CANONICAL_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

type ReceiptSignatureFields = {
  readonly device: {
    readonly keyId: string;
    readonly publicKey: string;
  };
  readonly signature: string;
};

/**
 * Serializes a JSON value deterministically for signing and stable hashing.
 *
 * Object keys are ordered lexicographically by UTF-16 code units. Arrays retain
 * their input order. Values outside the JSON data model are rejected instead of
 * being omitted or coerced as they are by JSON.stringify.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, new Set<object>());
}

/**
 * Verifies an Ed25519 signature over a receipt's canonical unsigned payload.
 *
 * Public keys and signatures use padded Base64. Device key ids are the
 * lowercase hexadecimal SHA-256 digest of the raw 32-byte public key.
 *
 * @param receipt Receipt containing the signing device and signature fields.
 * @returns Whether the device identity and receipt signature are valid.
 */
export function verifyReceiptSignature<T extends ReceiptSignatureFields>(
  receipt: T,
): boolean {
  const {signature: encodedSignature, ...unsignedReceipt} = receipt;
  const publicKey = decodeCanonicalBase64(
    receipt.device.publicKey,
    ED25519_PUBLIC_KEY_LENGTH,
  );
  const signature = decodeCanonicalBase64(
    encodedSignature,
    ED25519_SIGNATURE_LENGTH,
  );
  if (
    publicKey === undefined ||
    signature === undefined ||
    !SHA256_HEX_PATTERN.test(receipt.device.keyId)
  ) {
    return false;
  }

  const expectedKeyId = createHash('sha256').update(publicKey).digest('hex');
  if (receipt.device.keyId !== expectedKeyId) return false;

  const payload = Buffer.from(canonicalJson(unsignedReceipt), 'utf8');

  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, payload, key, signature);
  } catch {
    return false;
  }
}

function decodeCanonicalBase64(
  value: string,
  expectedLength: number,
): Buffer | undefined {
  if (!CANONICAL_BASE64_PATTERN.test(value)) return undefined;

  const decoded = Buffer.from(value, 'base64');
  if (
    decoded.length !== expectedLength ||
    decoded.toString('base64') !== value
  ) {
    return undefined;
  }
  return decoded;
}

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(
          'Canonical JSON does not support non-finite numbers',
        );
      }
      return stringifyPrimitive(value);
    case 'string':
      return stringifyPrimitive(value);
    case 'object':
      return serializeObject(value, ancestors);
    default:
      throw new TypeError(`Canonical JSON does not support ${typeof value}`);
  }
}

function stringifyPrimitive(value: string | number): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError('Canonical JSON could not serialize a primitive value');
  }
  return serialized;
}

function serializeObject(value: object, ancestors: Set<object>): string {
  if (ancestors.has(value)) {
    throw new TypeError('Canonical JSON does not support circular references');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return serializeArray(value, ancestors);
    }

    const prototype: object | null = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Canonical JSON supports only plain objects');
    }

    return serializeRecord(value, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function serializeArray(
  value: readonly unknown[],
  ancestors: Set<object>,
): string {
  const entries: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    entries.push(serialize(value[index], ancestors));
  }
  return `[${entries.join(',')}]`;
}

function serializeRecord(value: object, ancestors: Set<object>): string {
  const symbolKeys = Object.getOwnPropertySymbols(value);
  if (symbolKeys.length > 0) {
    throw new TypeError('Canonical JSON supports only string object keys');
  }

  const entries = Object.keys(value)
    .sort()
    .map(key => {
      const propertyValue: unknown = Reflect.get(value, key);
      return `${stringifyPrimitive(key)}:${serialize(propertyValue, ancestors)}`;
    });
  return `{${entries.join(',')}}`;
}
