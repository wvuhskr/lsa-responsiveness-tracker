import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  open,
  readFile,
  realpath,
  rename,
  unlink
} from "node:fs/promises";
import path from "node:path";

import { OutputError } from "./errors.js";

const READ_ERROR = "History file could not be read.";
const DATA_ERROR = "History data is invalid.";
const WRITE_ERROR = "History file could not be written.";
const METRIC_VERSION = "lsa-responsiveness/v1";
const MAX_HISTORY_POINTS = 100_000;
const ACCOUNT_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CANONICAL_MEDIAN_DURATION = /^(?:0|[1-9]\d*)(?:\.5)?$/;
const ISO_TIMESTAMP_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|[+-](\d{2}):(\d{2}))$/;

const COUNT_FIELDS = Object.freeze([
  "repliedMessages",
  "recentUnansweredMessages",
  "oldUnansweredMessages",
  "eligibleMessages",
  "eligiblePhoneCalls",
  "connectedCalls",
  "totalEligible",
  "totalResponded"
]);
const RATE_FIELDS = Object.freeze([
  "totalResponsiveness",
  "callsConnected",
  "messagesReplied",
  "repliedWithin24Hours"
]);
const POINT_FIELDS = new Set([
  "accountKey",
  "accountName",
  "asOf",
  "windowDays",
  "metricVersion",
  ...COUNT_FIELDS,
  ...RATE_FIELDS,
  "medianReplyNanoseconds",
  "replySpeedBuckets",
  "diagnostics"
]);
const REQUIRED_POINT_FIELDS = new Set([
  "accountKey",
  "accountName",
  "asOf",
  "windowDays",
  "metricVersion",
  ...COUNT_FIELDS,
  ...RATE_FIELDS,
  "medianReplyNanoseconds",
  "replySpeedBuckets",
  "diagnostics"
]);
const BUCKET_FIELDS = Object.freeze([
  "within5m",
  "within1h",
  "within24h",
  "over24h"
]);
const DIAGNOSTIC_FIELDS = Object.freeze([
  "incompleteWindowLeads",
  "bookingLeads",
  "unsupportedLeadTypes"
]);

class InvalidHistoryError extends Error {}

function invalid() {
  throw new InvalidHistoryError();
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function identity(point) {
  return [
    point.accountKey,
    point.asOf,
    point.windowDays,
    point.metricVersion
  ].join("\u0000");
}

function ownDataKeys(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  if (Object.getOwnPropertySymbols(value).length !== 0) invalid();

  const keys = Object.getOwnPropertyNames(value);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value") ||
        descriptor.enumerable !== true) {
      invalid();
    }
  }
  return keys;
}

function denseArrayValues(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > MAX_HISTORY_POINTS ||
      Object.getOwnPropertySymbols(value).length !== 0) {
    invalid();
  }
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) invalid();
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value") ||
        descriptor.enumerable !== true) {
      invalid();
    }
  }
  return value;
}

function exactRecord(value, allowed, required = allowed) {
  const keys = ownDataKeys(value);
  for (const key of keys) {
    if (!allowed.has(key)) invalid();
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) invalid();
  }
  return value;
}

function validString(value, maximumLength) {
  return typeof value === "string" && value.length <= maximumLength &&
    value.trim().length > 0 && !value.includes("\u0000");
}

function validTimestamp(value) {
  if (typeof value !== "string" || value.includes("\u0000")) return false;
  const match = ISO_TIMESTAMP_WITH_OFFSET.exec(value);
  if (match === null) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30,
    31, 31, 30, 31, 30, 31];

  return month >= 1 && month <= 12 && day >= 1 &&
    day <= daysInMonth[month - 1] && hour <= 23 && minute <= 59 &&
    second <= 59 && offsetHour <= 23 && offsetMinute <= 59;
}

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

function validRate(value) {
  return value === null || (Number.isFinite(value) && value >= 0 &&
    value <= 1 && !Object.is(value, -0));
}

function expectedRate(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function ratesEqual(actual, expected) {
  return actual === expected;
}

function canonicalBuckets(value, repliedMessages, eligibleMessages,
  repliedWithin24Hours) {
  const allowed = new Set(BUCKET_FIELDS);
  exactRecord(value, allowed);
  const result = {};
  let totalReplies = 0;
  for (const field of BUCKET_FIELDS) {
    if (!validCount(value[field])) invalid();
    totalReplies += value[field];
    if (!Number.isSafeInteger(totalReplies)) invalid();
    result[field] = value[field];
  }
  if (totalReplies !== repliedMessages) invalid();

  const within24Hours = result.within5m + result.within1h +
    result.within24h;
  if (!ratesEqual(
    repliedWithin24Hours,
    expectedRate(within24Hours, eligibleMessages)
  )) {
    invalid();
  }
  return result;
}

function canonicalDiagnostics(value) {
  exactRecord(value, new Set(DIAGNOSTIC_FIELDS));
  const result = {};
  for (const field of DIAGNOSTIC_FIELDS) {
    if (!validCount(value[field])) invalid();
    result[field] = value[field];
  }
  return result;
}

function canonicalPoint(value) {
  exactRecord(value, POINT_FIELDS, REQUIRED_POINT_FIELDS);
  if (!validString(value.accountKey, 128) ||
      !ACCOUNT_KEY.test(value.accountKey) ||
      !validString(value.accountName, 256) ||
      !validTimestamp(value.asOf) ||
      !Number.isSafeInteger(value.windowDays) || value.windowDays < 1 ||
      value.windowDays > 365 ||
      value.metricVersion !== METRIC_VERSION ||
      value.metricVersion.includes("\u0000")) {
    invalid();
  }

  const counts = {};
  for (const field of COUNT_FIELDS) {
    if (!validCount(value[field])) invalid();
    counts[field] = value[field];
  }
  if (counts.eligibleMessages !== counts.repliedMessages +
        counts.recentUnansweredMessages ||
      counts.connectedCalls > counts.eligiblePhoneCalls ||
      counts.totalEligible !== counts.eligibleMessages +
        counts.eligiblePhoneCalls ||
      counts.totalResponded !== counts.repliedMessages +
        counts.connectedCalls ||
      counts.totalResponded > counts.totalEligible) {
    invalid();
  }

  const rates = {};
  for (const field of RATE_FIELDS) {
    if (!validRate(value[field])) invalid();
    rates[field] = value[field];
  }
  if (!ratesEqual(
    rates.totalResponsiveness,
    expectedRate(counts.totalResponded, counts.totalEligible)
  ) || !ratesEqual(
    rates.callsConnected,
    expectedRate(counts.connectedCalls, counts.eligiblePhoneCalls)
  ) || !ratesEqual(
    rates.messagesReplied,
    expectedRate(counts.repliedMessages, counts.eligibleMessages)
  )) {
    invalid();
  }

  const medianReplyNanoseconds = value.medianReplyNanoseconds;
  if (medianReplyNanoseconds === null) {
    if (counts.repliedMessages !== 0) invalid();
  } else if (counts.repliedMessages === 0 ||
      typeof medianReplyNanoseconds !== "string" ||
      medianReplyNanoseconds.length > 128 ||
      !CANONICAL_MEDIAN_DURATION.test(medianReplyNanoseconds)) {
    invalid();
  }

  const replySpeedBuckets = canonicalBuckets(
    value.replySpeedBuckets,
    counts.repliedMessages,
    counts.eligibleMessages,
    rates.repliedWithin24Hours
  );

  const result = {
    accountKey: value.accountKey,
    accountName: value.accountName,
    asOf: value.asOf,
    windowDays: value.windowDays,
    metricVersion: value.metricVersion
  };
  for (const field of COUNT_FIELDS) result[field] = counts[field];
  for (const field of RATE_FIELDS) result[field] = rates[field];
  result.medianReplyNanoseconds = medianReplyNanoseconds;
  result.replySpeedBuckets = replySpeedBuckets;
  result.diagnostics = canonicalDiagnostics(value.diagnostics);
  return result;
}

function canonicalHistory(value) {
  exactRecord(value, new Set(["schemaVersion", "points"]));
  if (value.schemaVersion !== 1) invalid();
  const points = denseArrayValues(value.points).map(canonicalPoint);
  const identities = new Set();
  for (const point of points) {
    const key = identity(point);
    if (identities.has(key)) invalid();
    identities.add(key);
  }
  points.sort((left, right) => compareStrings(identity(left), identity(right)));
  return { schemaVersion: 1, points };
}

function parseStrictJson(source) {
  if (typeof source !== "string") invalid();
  let position = 0;

  function skipWhitespace() {
    while (position < source.length && /[\u0009\u000a\u000d\u0020]/.test(
      source[position]
    )) {
      position += 1;
    }
  }

  function parseString() {
    if (source[position] !== '"') invalid();
    const start = position;
    position += 1;
    while (position < source.length) {
      const character = source[position];
      if (character === '"') {
        position += 1;
        try {
          return JSON.parse(source.slice(start, position));
        } catch {
          invalid();
        }
      }
      if (character === "\\") {
        position += 1;
        if (position >= source.length) invalid();
        const escape = source[position];
        if (escape === "u") {
          const hex = source.slice(position + 1, position + 5);
          if (hex.length !== 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) invalid();
          position += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(escape)) invalid();
        position += 1;
        continue;
      }
      if (character.charCodeAt(0) <= 0x1f) invalid();
      position += 1;
    }
    invalid();
  }

  function parseNumber() {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      source.slice(position)
    );
    if (match === null) invalid();
    position += match[0].length;
    return Number(match[0]);
  }

  function parseArray() {
    position += 1;
    const result = [];
    skipWhitespace();
    if (source[position] === "]") {
      position += 1;
      return result;
    }
    while (position < source.length) {
      result.push(parseValue());
      skipWhitespace();
      if (source[position] === "]") {
        position += 1;
        return result;
      }
      if (source[position] !== ",") invalid();
      position += 1;
      skipWhitespace();
    }
    invalid();
  }

  function parseObject() {
    position += 1;
    const result = Object.create(null);
    const keys = new Set();
    skipWhitespace();
    if (source[position] === "}") {
      position += 1;
      return result;
    }
    while (position < source.length) {
      const key = parseString();
      if (keys.has(key)) invalid();
      keys.add(key);
      skipWhitespace();
      if (source[position] !== ":") invalid();
      position += 1;
      const value = parseValue();
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true
      });
      skipWhitespace();
      if (source[position] === "}") {
        position += 1;
        return result;
      }
      if (source[position] !== ",") invalid();
      position += 1;
      skipWhitespace();
    }
    invalid();
  }

  function parseValue() {
    skipWhitespace();
    const character = source[position];
    if (character === '"') return parseString();
    if (character === "{") return parseObject();
    if (character === "[") return parseArray();
    if (character === "-" || (character >= "0" && character <= "9")) {
      return parseNumber();
    }
    for (const [token, value] of [
      ["true", true],
      ["false", false],
      ["null", null]
    ]) {
      if (source.startsWith(token, position)) {
        position += token.length;
        return value;
      }
    }
    invalid();
  }

  const value = parseValue();
  skipWhitespace();
  if (position !== source.length) invalid();
  return value;
}

async function isGenuinelyAbsent(historyPath) {
  try {
    await lstat(historyPath);
    return false;
  } catch (error) {
    return error !== null && typeof error === "object" && error.code === "ENOENT";
  }
}

function retainedIdentity(stats) {
  if (typeof stats.dev !== "bigint" || typeof stats.ino !== "bigint") {
    invalid();
  }
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(stats, expected) {
  return expected !== undefined && typeof expected.dev === "bigint" &&
    typeof expected.ino === "bigint" && typeof stats.dev === "bigint" &&
    typeof stats.ino === "bigint" && stats.dev === expected.dev &&
    stats.ino === expected.ino;
}

function validatePrivateDirectory(stats) {
  if (!stats.isDirectory() || typeof stats.mode !== "bigint" ||
      (stats.mode & 0o022n) !== 0n) {
    invalid();
  }
  if (typeof process.getuid === "function" &&
      stats.uid !== BigInt(process.getuid())) {
    invalid();
  }
}

async function validatedWritePaths(historyPath) {
  if (typeof historyPath !== "string" || historyPath.length === 0 ||
      historyPath.includes("\u0000")) {
    invalid();
  }
  const requestedTarget = path.resolve(historyPath);
  const requestedDirectory = path.dirname(requestedTarget);
  const basename = path.basename(requestedTarget);
  if (basename.length === 0 || basename === "." || basename === ".." ||
      !Number.isSafeInteger(process.pid) || process.pid <= 0) {
    invalid();
  }

  const directory = await realpath(requestedDirectory);
  if (!path.isAbsolute(directory)) invalid();
  const directoryStats = await lstat(directory, { bigint: true });
  validatePrivateDirectory(directoryStats);
  const parentIdentity = retainedIdentity(directoryStats);
  const target = path.join(directory, basename);
  if (path.dirname(target) !== directory || path.basename(target) !== basename) {
    invalid();
  }

  const random = randomBytes(16).toString("hex");
  if (!/^[0-9a-f]{32}$/.test(random)) invalid();
  const temporary = path.join(
    directory,
    `.${basename}.tmp-${process.pid}-${random}`
  );
  if (temporary === target || path.dirname(temporary) !== directory ||
      path.basename(temporary) !== `.${basename}.tmp-${process.pid}-${random}`) {
    invalid();
  }
  return { directory, parentIdentity, target, temporary };
}

async function revalidateParent(directory, expectedIdentity) {
  const stats = await lstat(directory, { bigint: true });
  validatePrivateDirectory(stats);
  if (!sameIdentity(stats, expectedIdentity)) invalid();
}

async function revalidateTemporary(temporary, expectedIdentity) {
  const stats = await lstat(temporary, { bigint: true });
  if (!stats.isFile() || !sameIdentity(stats, expectedIdentity)) invalid();
}

async function cleanupOwnedTemporary(temporary, expectedIdentity) {
  if (temporary === undefined || expectedIdentity === undefined) return;
  try {
    const stats = await lstat(temporary, { bigint: true });
    if (stats.isFile() && sameIdentity(stats, expectedIdentity)) {
      await unlink(temporary);
    }
  } catch {}
}

export async function readHistory(historyPath) {
  let source;
  try {
    source = await readFile(historyPath, "utf8");
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT" &&
        await isGenuinelyAbsent(historyPath)) {
      return { schemaVersion: 1, points: [] };
    }
    throw new OutputError(READ_ERROR);
  }

  try {
    return canonicalHistory(parseStrictJson(source));
  } catch {
    throw new OutputError(READ_ERROR);
  }
}

export function upsertHistory(history, point) {
  try {
    const existing = canonicalHistory(history);
    const replacement = canonicalPoint(point);
    const replacementIdentity = identity(replacement);
    let replaced = false;
    const points = existing.points.map((existingPoint) => {
      if (identity(existingPoint) !== replacementIdentity) return existingPoint;
      replaced = true;
      return replacement;
    });
    if (!replaced) {
      if (points.length >= MAX_HISTORY_POINTS) invalid();
      points.push(replacement);
    }
    points.sort((left, right) => compareStrings(identity(left), identity(right)));
    return { schemaVersion: 1, points };
  } catch {
    throw new OutputError(DATA_ERROR);
  }
}

export async function writeHistoryAtomic(historyPath, history) {
  let serialized;
  try {
    serialized = `${JSON.stringify(canonicalHistory(history), null, 2)}\n`;
  } catch {
    throw new OutputError(DATA_ERROR);
  }

  let target;
  let temporary;
  let directory;
  let parentIdentity;
  let temporaryIdentity;
  let handle;
  try {
    ({ directory, parentIdentity, target, temporary } =
      await validatedWritePaths(historyPath));
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT |
      fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
    handle = await open(temporary, flags, 0o600);
    const createdStats = await handle.stat({ bigint: true });
    if (!createdStats.isFile()) invalid();
    temporaryIdentity = retainedIdentity(createdStats);
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      const openHandle = handle;
      handle = undefined;
      await openHandle.close();
    }
    await revalidateParent(directory, parentIdentity);
    await revalidateTemporary(temporary, temporaryIdentity);
    await rename(temporary, target);
    temporary = undefined;
  } catch {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {}
    }
    await cleanupOwnedTemporary(temporary, temporaryIdentity);
    throw new OutputError(WRITE_ERROR);
  }
}
