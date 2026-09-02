import { DataIntegrityError } from "./errors.js";

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})?$/;
const IANA_TIME_ZONE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)*$/;
const NS_PER_SECOND = 1_000_000_000n;
const NS_PER_MILLISECOND = 1_000_000n;
const SECONDS_PER_HOUR = 3_600n;
const SECONDS_PER_DAY = 86_400n;
const NS_PER_DAY = SECONDS_PER_DAY * NS_PER_SECOND;
const DISAMBIGUATIONS = new Set(["reject", "earlier", "later"]);

export function isNamedIanaTimeZone(timeZone) {
  if (typeof timeZone !== "string" ||
      !IANA_TIME_ZONE_IDENTIFIER.test(timeZone)) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, month) {
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30,
    31, 31, 30, 31, 30, 31];
  return days[month - 1];
}

function parseComponents(text) {
  const match = typeof text === "string" ? TIMESTAMP.exec(text) : null;
  if (!match) {
    throw new DataIntegrityError("eventDateTime has an invalid timestamp format.");
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText,
    fraction = "", offset] = match;
  const components = {
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText),
    hour: Number(hourText),
    minute: Number(minuteText),
    second: Number(secondText)
  };

  if (components.month < 1 || components.month > 12 ||
      components.day < 1 ||
      components.day > daysInMonth(components.year, components.month)) {
    throw new DataIntegrityError("eventDateTime has an invalid calendar date.");
  }
  if (components.hour > 23 || components.minute > 59 ||
      components.second > 59) {
    throw new DataIntegrityError("eventDateTime has an invalid clock time.");
  }

  return { components, fraction, offset };
}

function fractionToNanoseconds(fraction) {
  return fraction === "" ? 0n : BigInt(fraction.padEnd(9, "0"));
}

function utcEpochSeconds({ year, month, day, hour, minute, second }) {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  const milliseconds = date.getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new DataIntegrityError("eventDateTime is outside the supported range.");
  }
  return BigInt(milliseconds) / 1_000n;
}

function explicitOffsetSeconds(offset) {
  if (offset === "Z") return 0n;

  const sign = offset[0] === "-" ? -1n : 1n;
  const hours = Number(offset.slice(1, 3));
  const minutes = Number(offset.slice(4, 6));
  if (hours > 23 || minutes > 59) {
    throw new DataIntegrityError("eventDateTime has an invalid UTC offset.");
  }
  return sign * (BigInt(hours) * SECONDS_PER_HOUR + BigInt(minutes) * 60n);
}

function disambiguationFrom(options) {
  const disambiguation = options?.disambiguation === undefined
    ? "reject"
    : options.disambiguation;
  if (!DISAMBIGUATIONS.has(disambiguation)) {
    throw new DataIntegrityError(
      "disambiguation must be reject, earlier, or later."
    );
  }
  return disambiguation;
}

function formatterFor(timeZone) {
  if (!isNamedIanaTimeZone(timeZone)) {
    throw new DataIntegrityError("timeZone must be a valid IANA time zone.");
  }

  try {
    return new Intl.DateTimeFormat("en-CA-u-ca-gregory-nu-latn", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      hourCycle: "h23",
      era: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  } catch (error) {
    if (error instanceof RangeError) {
      throw new DataIntegrityError("timeZone must be a valid IANA time zone.");
    }
    throw error;
  }
}

function formattedComponents(formatter, epochMilliseconds) {
  const values = Object.create(null);
  for (const part of formatter.formatToParts(new Date(epochMilliseconds))) {
    if (part.type !== "literal") values[part.type] = part.value;
  }

  const displayedYear = Number(values.year);
  const year = values.era === "BC" ? 1 - displayedYear : displayedYear;
  return {
    year,
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour) === 24 ? 0 : Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second)
  };
}

function formatEpochSecond(formatter, epochSecond) {
  return formattedComponents(formatter, Number(epochSecond * 1_000n));
}

function sameComponents(left, right) {
  return left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second;
}

function resolveLocalEpochSecond(components, timeZone, disambiguation) {
  const formatter = formatterFor(timeZone);
  const naiveEpochSecond = utcEpochSeconds(components);
  const offsets = new Set();

  for (let hour = -36; hour <= 36; hour += 1) {
    const sampleEpochSecond = naiveEpochSecond + BigInt(hour) * SECONDS_PER_HOUR;
    const local = formatEpochSecond(formatter, sampleEpochSecond);
    offsets.add(utcEpochSeconds(local) - sampleEpochSecond);
  }

  const candidates = new Set();
  for (const offset of offsets) {
    const candidate = naiveEpochSecond - offset;
    if (sameComponents(formatEpochSecond(formatter, candidate), components)) {
      candidates.add(candidate);
    }
  }

  const ordered = [...candidates].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0);
  if (ordered.length === 0) {
    throw new DataIntegrityError("eventDateTime is a nonexistent local time.");
  }
  if (ordered.length === 1) return ordered[0];
  if (disambiguation === "reject") {
    throw new DataIntegrityError("eventDateTime is an ambiguous local time.");
  }
  return disambiguation === "earlier" ? ordered[0] : ordered.at(-1);
}

function nonNegativeInteger(value, name) {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw new DataIntegrityError(`${name} must be a non-negative integer.`);
}

function floorDivide(dividend, divisor) {
  const quotient = dividend / divisor;
  return dividend < 0n && dividend % divisor !== 0n
    ? quotient - 1n
    : quotient;
}

export function parseTimestamp(text, options = {}) {
  const { components, fraction, offset } = parseComponents(text);
  const disambiguation = disambiguationFrom(options);
  const epochSecond = offset === undefined
    ? resolveLocalEpochSecond(components, options?.timeZone, disambiguation)
    : utcEpochSeconds(components) - explicitOffsetSeconds(offset);

  return {
    epochNanoseconds: epochSecond * NS_PER_SECOND +
      fractionToNanoseconds(fraction),
    fractionalDigits: fraction.length,
    hadExplicitOffset: offset !== undefined
  };
}

export function subtractExactDays(epochNanoseconds, days) {
  if (typeof epochNanoseconds !== "bigint") {
    throw new DataIntegrityError("epochNanoseconds must be a bigint.");
  }
  return epochNanoseconds - nonNegativeInteger(days, "days") * NS_PER_DAY;
}

export function windowStartFor(asOfText, timeZone, windowDays,
  disambiguation = "reject") {
  const dayCount = nonNegativeInteger(windowDays, "windowDays");
  const formatter = formatterFor(timeZone);
  const asOf = parseTimestamp(asOfText, { timeZone, disambiguation });
  const asOfMilliseconds = floorDivide(
    asOf.epochNanoseconds,
    NS_PER_MILLISECOND
  );
  const localDate = formattedComponents(formatter, Number(asOfMilliseconds));
  const targetEpochSecond = utcEpochSeconds({
    ...localDate,
    hour: 0,
    minute: 0,
    second: 0
  }) - dayCount * SECONDS_PER_DAY;
  const target = new Date(Number(targetEpochSecond * 1_000n));
  if (Number.isNaN(target.getTime()) || target.getUTCFullYear() < 0 ||
      target.getUTCFullYear() > 9_999) {
    throw new DataIntegrityError(
      "window start falls outside the supported four-digit year range."
    );
  }

  const midnight = [
    String(target.getUTCFullYear()).padStart(4, "0"),
    String(target.getUTCMonth() + 1).padStart(2, "0"),
    String(target.getUTCDate()).padStart(2, "0")
  ].join("-") + " 00:00:00";
  return parseTimestamp(midnight, { timeZone, disambiguation })
    .epochNanoseconds;
}
