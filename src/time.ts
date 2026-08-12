const CANONICAL_TIMESTAMP_PATTERN =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;
const CYCLE_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** A UTC timestamp in the canonical format emitted by Date#toISOString. */
export type CanonicalTimestamp = string & {
  readonly __brand: 'CanonicalTimestamp';
};

/** The inclusive start and exclusive end of a UTC calendar month. */
export type CycleBounds = {
  readonly from: CanonicalTimestamp;
  readonly to: CanonicalTimestamp;
};

/** Returns whether a value is a valid canonical UTC timestamp. */
export function isCanonicalTimestamp(
  value: unknown,
): value is CanonicalTimestamp {
  if (typeof value !== 'string' || !CANONICAL_TIMESTAMP_PATTERN.test(value)) {
    return false;
  }

  const instant = new Date(value);
  return !Number.isNaN(instant.getTime()) && instant.toISOString() === value;
}

/** Validates and narrows an external value to a canonical UTC timestamp. */
export function parseCanonicalTimestamp(value: unknown): CanonicalTimestamp {
  if (!isCanonicalTimestamp(value)) {
    throw new TypeError(
      'Expected a canonical UTC timestamp in YYYY-MM-DDTHH:mm:ss.sssZ form.',
    );
  }

  return value;
}

/** Returns the UTC calendar-month identifier for a canonical timestamp. */
export function cycleId(timestamp: string): string {
  return parseCanonicalTimestamp(timestamp).slice(0, 7);
}

/** Returns the inclusive start and exclusive end of a UTC calendar month. */
export function cycleBounds(cycle: string): CycleBounds {
  const match = CYCLE_PATTERN.exec(cycle);
  if (match === null) {
    throw new TypeError('Expected a cycle in YYYY-MM form.');
  }

  const yearPart = match[1];
  const monthPart = match[2];
  if (yearPart === undefined || monthPart === undefined) {
    throw new TypeError('Expected a cycle in YYYY-MM form.');
  }

  const year = Number(yearPart);
  const month = Number(monthPart);
  if (year === 9999 && month === 12) {
    throw new RangeError('Cycle 9999-12 has no canonical exclusive bound.');
  }

  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextCycle = `${String(nextYear).padStart(4, '0')}-${String(
    nextMonth,
  ).padStart(2, '0')}`;

  return {
    from: parseCanonicalTimestamp(`${cycle}-01T00:00:00.000Z`),
    to: parseCanonicalTimestamp(`${nextCycle}-01T00:00:00.000Z`),
  };
}
