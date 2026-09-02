import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsPromises, {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { OutputError } from "../src/errors.js";
import {
  readHistory,
  upsertHistory,
  writeHistoryAtomic
} from "../src/history.js";

const READ_ERROR = "History file could not be read.";
const DATA_ERROR = "History data is invalid.";
const WRITE_ERROR = "History file could not be written.";

function historyPoint(overrides = {}) {
  return {
    accountKey: "example-heating",
    accountName: "Synthetic Example Heating",
    asOf: "2026-01-31T12:00:00-06:00",
    windowDays: 90,
    metricVersion: "lsa-responsiveness/v1",
    repliedMessages: 6,
    recentUnansweredMessages: 2,
    oldUnansweredMessages: 3,
    eligibleMessages: 8,
    eligiblePhoneCalls: 4,
    connectedCalls: 3,
    totalEligible: 12,
    totalResponded: 9,
    totalResponsiveness: 0.75,
    callsConnected: 0.75,
    messagesReplied: 0.75,
    repliedWithin24Hours: 0.5,
    medianReplyNanoseconds: "60000000000.5",
    replySpeedBuckets: {
      within5m: 2,
      within1h: 1,
      within24h: 1,
      over24h: 2
    },
    diagnostics: {
      incompleteWindowLeads: 1,
      bookingLeads: 2,
      unsupportedLeadTypes: 1
    },
    ...overrides
  };
}

function historyFile(points = []) {
  return { schemaVersion: 1, points };
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lsa-history-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

function assertOutputError(error, message) {
  assert.ok(error instanceof OutputError);
  assert.equal(error.name, "OutputError");
  assert.equal(error.code, "OUTPUT");
  assert.equal(error.exitCode, 5);
  assert.equal(error.message, message);
  return true;
}

function assertDataRejected(action) {
  assert.throws(action, (error) => assertOutputError(error, DATA_ERROR));
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

function withFilesystemIdentity(stats, dev, ino, options) {
  const useBigInt = options !== null && typeof options === "object" &&
    options.bigint === true;
  const identity = {
    dev: useBigInt ? dev : Number(dev),
    ino: useBigInt ? ino : Number(ino)
  };
  return new Proxy(stats, {
    get(target, property) {
      if (Object.hasOwn(identity, property)) return identity[property];
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

test("readHistory returns an empty versioned history only for an absent file", async (t) => {
  const directory = await temporaryDirectory(t);
  const missing = path.join(directory, "missing-history.json");

  assert.deepEqual(await readHistory(missing), { schemaVersion: 1, points: [] });
  await assert.rejects(stat(missing), { code: "ENOENT" });
});

test("readHistory rejects a dangling symlink instead of treating it as absent", async (t) => {
  const directory = await temporaryDirectory(t);
  const historyPath = path.join(directory, "history.json");
  await symlink("missing-target.json", historyPath);

  await assert.rejects(readHistory(historyPath), (error) =>
    assertOutputError(error, READ_ERROR));
});

test("malformed existing history fails without changing one byte", async (t) => {
  const directory = await temporaryDirectory(t);
  const historyPath = path.join(directory, "history.json");
  const original = Buffer.from("{\n  \"schemaVersion\": 1,\n  \"points\": [\n", "utf8");
  await writeFile(historyPath, original);

  await assert.rejects(readHistory(historyPath), (error) => {
    assertOutputError(error, READ_ERROR);
    assert.equal(error.message.includes(historyPath), false);
    assert.equal(error.message.includes(original.toString("utf8")), false);
    return true;
  });
  assert.deepEqual(await readFile(historyPath), original);
});

test("readHistory rejects duplicate JSON fields and duplicate metric identities", async (t) => {
  const directory = await temporaryDirectory(t);
  const historyPath = path.join(directory, "history.json");
  await writeFile(historyPath,
    '{"schemaVersion":1,"schemaVersion":1,"points":[]}\n');
  await assert.rejects(readHistory(historyPath), (error) =>
    assertOutputError(error, READ_ERROR));

  const point = historyPoint();
  await writeFile(historyPath, JSON.stringify(historyFile([point, point])));
  await assert.rejects(readHistory(historyPath), (error) =>
    assertOutputError(error, READ_ERROR));
});

test("readHistory rejects wrong schemas, unknown fields, unsafe types, and read errors", async (t) => {
  const directory = await temporaryDirectory(t);
  const historyPath = path.join(directory, "history.json");
  const invalidFiles = [
    { schemaVersion: 2, points: [] },
    { schemaVersion: 1, points: [], unexpected: true },
    { schemaVersion: 1, points: "not-an-array" },
    historyFile([{ ...historyPoint(), totalEligible: Number.MAX_SAFE_INTEGER + 1 }]),
    historyFile([{ ...historyPoint(), totalResponsiveness: null }])
  ];

  for (const invalid of invalidFiles) {
    await writeFile(historyPath, JSON.stringify(invalid));
    await assert.rejects(readHistory(historyPath), (error) =>
      assertOutputError(error, READ_ERROR));
  }

  const directoryPath = path.join(directory, "not-a-file");
  await mkdir(directoryPath);
  await assert.rejects(readHistory(directoryPath), (error) => {
    assertOutputError(error, READ_ERROR);
    assert.equal(error.message.includes(directoryPath), false);
    return true;
  });
});

test("upsert replaces the same four-field metric identity", () => {
  const point = historyPoint();
  const once = upsertHistory(historyFile(), point);
  const replacement = historyPoint({
    connectedCalls: 2,
    totalResponded: 8,
    totalResponsiveness: 2 / 3,
    callsConnected: 0.5
  });
  const twice = upsertHistory(once, replacement);

  assert.equal(twice.points.length, 1);
  assert.equal(twice.points[0].totalResponded, 8);
  assert.equal(twice.points[0].connectedCalls, 2);
});

test("upsert appends each distinct identity component and sorts deterministically", () => {
  const points = [
    historyPoint({ accountKey: "zeta", accountName: "Synthetic Zeta" }),
    historyPoint({ asOf: "2026-02-01T12:00:00-06:00" }),
    historyPoint({ windowDays: 30 }),
    historyPoint({ accountKey: "alpha", accountName: "Synthetic Alpha" })
  ];
  let history = historyFile();
  for (const point of points) history = upsertHistory(history, point);

  assert.deepEqual(history.points.map((point) => [
    point.accountKey, point.asOf, point.windowDays, point.metricVersion
  ]), [
    ["alpha", "2026-01-31T12:00:00-06:00", 90, "lsa-responsiveness/v1"],
    ["example-heating", "2026-01-31T12:00:00-06:00", 30,
      "lsa-responsiveness/v1"],
    ["example-heating", "2026-02-01T12:00:00-06:00", 90,
      "lsa-responsiveness/v1"],
    ["zeta", "2026-01-31T12:00:00-06:00", 90, "lsa-responsiveness/v1"]
  ]);

  const reversed = points.toReversed().reduce(
    (value, point) => upsertHistory(value, point), historyFile()
  );
  assert.deepEqual(reversed, history);
});

test("upsert rejects NUL-bearing identity values and collision-capable histories", () => {
  for (const point of [
    historyPoint({ accountKey: "example\u0000heating" }),
    historyPoint({ asOf: "2026-01-31T12:00:00-06:00\u0000suffix" }),
    historyPoint({ metricVersion: "lsa-responsiveness/v1\u0000suffix" })
  ]) {
    assertDataRejected(() => upsertHistory(historyFile(), point));
  }

  const first = historyPoint();
  assertDataRejected(() => upsertHistory(historyFile([first, { ...first }]), first));
});

test("history rejects every lead-level, account-ID, connector, raw, path, and unknown field", () => {
  const forbidden = [
    "recentUnanswered",
    "leadId",
    "messageText",
    "phoneNumber",
    "customerId",
    "accountId",
    "connector",
    "capability",
    "rawPayload",
    "inputPath",
    "arbitraryUnknown"
  ];
  for (const field of forbidden) {
    assertDataRejected(() => upsertHistory(historyFile(), historyPoint({
      [field]: "SYNTHETIC PRIVATE MARKER"
    })));
  }

  assertDataRejected(() => upsertHistory(historyFile(), historyPoint({
    diagnostics: {
      incompleteWindowLeads: 1,
      bookingLeads: 2,
      unsupportedLeadTypes: 1,
      rawPayload: "SYNTHETIC PRIVATE NESTED MARKER"
    }
  })));
  assertDataRejected(() => upsertHistory(historyFile(), historyPoint({
    diagnostics: {
      incompleteWindowLeads: 1,
      bookingLeads: 2,
      unsupportedLeadTypes: 1,
      CUSTOMER_SYNTHETIC_123: 1
    }
  })));
  assertDataRejected(() => upsertHistory(historyFile(), historyPoint({
    diagnostics: {
      incompleteWindowLeads: 1,
      bookingLeads: 2,
      unsupportedLeadTypes: 1,
      excludedLeadTypes: { BOOKING: 2 }
    }
  })));
  assertDataRejected(() => upsertHistory(historyFile(), historyPoint({
    replySpeedBuckets: {
      within5m: 2,
      within1h: 1,
      within24h: 1,
      over24h: 2,
      leadId: 1
    }
  })));
});

test("history rejects non-plain prototypes, accessors, symbols, and array side properties", () => {
  const inheritedPoint = Object.assign(
    Object.create({ leadId: "SYNTHETIC INHERITED PRIVATE ID" }),
    historyPoint()
  );
  assertDataRejected(() => upsertHistory(historyFile(), inheritedPoint));

  const accessorPoint = historyPoint();
  Object.defineProperty(accessorPoint, "accountName", {
    enumerable: true,
    get() { return "Synthetic Accessor"; }
  });
  assertDataRejected(() => upsertHistory(historyFile(), accessorPoint));

  const symbolPoint = historyPoint();
  symbolPoint[Symbol("leadId")] = "SYNTHETIC SYMBOL PRIVATE ID";
  assertDataRejected(() => upsertHistory(historyFile(), symbolPoint));

  const points = [historyPoint()];
  points.leadId = "SYNTHETIC ARRAY PRIVATE ID";
  assertDataRejected(() => upsertHistory(historyFile(points), historyPoint()));

  const inheritedPoints = [historyPoint()];
  const privateArrayPrototype = Object.assign(Object.create(Array.prototype), {
    leadId: "SYNTHETIC INHERITED ARRAY PRIVATE ID"
  });
  Object.setPrototypeOf(inheritedPoints, privateArrayPrototype);
  assertDataRejected(() =>
    upsertHistory(historyFile(inheritedPoints), historyPoint()));
});

test("history rejects unsafe aggregate count, rate, duration, bucket, and diagnostic values", () => {
  for (const point of [
    historyPoint({ repliedMessages: -1 }),
    historyPoint({ repliedMessages: 1.5 }),
    historyPoint({ repliedMessages: Number.MAX_SAFE_INTEGER + 1 }),
    historyPoint({ totalResponsiveness: Number.NaN }),
    historyPoint({ callsConnected: Number.POSITIVE_INFINITY }),
    historyPoint({ messagesReplied: -0.01 }),
    historyPoint({ repliedWithin24Hours: 1.01 }),
    historyPoint({ medianReplyNanoseconds: "1e9" }),
    historyPoint({ medianReplyNanoseconds: "-1" }),
    historyPoint({ medianReplyNanoseconds: 1 }),
    historyPoint({ medianReplyNanoseconds: "00" }),
    historyPoint({ medianReplyNanoseconds: "01" }),
    historyPoint({ medianReplyNanoseconds: "0.0" }),
    historyPoint({ medianReplyNanoseconds: "1.0" }),
    historyPoint({ medianReplyNanoseconds: "1.25" }),
    historyPoint({ medianReplyNanoseconds: ".5" }),
    historyPoint({
      replySpeedBuckets: { within5m: 2, within1h: -1, within24h: 1, over24h: 2 }
    }),
    historyPoint({
      diagnostics: {
        incompleteWindowLeads: -1,
        bookingLeads: 2,
        unsupportedLeadTypes: 1
      }
    }),
    historyPoint({
      diagnostics: {
        incompleteWindowLeads: 1,
        bookingLeads: -1,
        unsupportedLeadTypes: 1
      }
    }),
    historyPoint({
      diagnostics: {
        incompleteWindowLeads: 1,
        bookingLeads: 2,
        unsupportedLeadTypes: Number.MAX_SAFE_INTEGER + 1
      }
    })
  ]) {
    assertDataRejected(() => upsertHistory(historyFile(), point));
  }
});

test("history requires canonical median and complete reply buckets on every point", () => {
  const withoutMedian = historyPoint();
  delete withoutMedian.medianReplyNanoseconds;
  const withoutBuckets = historyPoint();
  delete withoutBuckets.replySpeedBuckets;
  const bypass = historyPoint({ repliedWithin24Hours: 0.123 });
  delete bypass.medianReplyNanoseconds;
  delete bypass.replySpeedBuckets;

  assertDataRejected(() => upsertHistory(historyFile(), withoutMedian));
  assertDataRejected(() => upsertHistory(historyFile(), withoutBuckets));
  assertDataRejected(() => upsertHistory(historyFile(), bypass));

  for (const medianReplyNanoseconds of ["0", "1", "0.5", "1.5"]) {
    assert.equal(
      upsertHistory(historyFile(), historyPoint({ medianReplyNanoseconds }))
        .points[0].medianReplyNanoseconds,
      medianReplyNanoseconds
    );
  }
});

test("history persists only the fixed aggregate diagnostic counts", () => {
  const point = historyPoint({
    diagnostics: {
      incompleteWindowLeads: 3,
      bookingLeads: 4,
      unsupportedLeadTypes: 5
    }
  });

  assert.deepEqual(
    upsertHistory(historyFile(), point).points[0].diagnostics,
    {
      incompleteWindowLeads: 3,
      bookingLeads: 4,
      unsupportedLeadTypes: 5
    }
  );
});

test("history rejects impossible metadata and inconsistent aggregate formulas", () => {
  for (const point of [
    historyPoint({ accountName: " " }),
    historyPoint({ asOf: "2026-02-30T12:00:00-06:00" }),
    historyPoint({ asOf: "2026-01-31T12:00:00" }),
    historyPoint({ windowDays: 0 }),
    historyPoint({ metricVersion: "lsa-responsiveness/v2" }),
    historyPoint({ eligibleMessages: 7 }),
    historyPoint({ connectedCalls: 5 }),
    historyPoint({ totalEligible: 11 }),
    historyPoint({ totalResponded: 10 }),
    historyPoint({ totalResponsiveness: 0.5 }),
    historyPoint({ callsConnected: 0.5 }),
    historyPoint({ messagesReplied: 0.5 }),
    historyPoint({ repliedWithin24Hours: 0.25 }),
    historyPoint({
      replySpeedBuckets: { within5m: 3, within1h: 1, within24h: 1, over24h: 2 }
    })
  ]) {
    assertDataRejected(() => upsertHistory(historyFile(), point));
  }
});

test("asOf accepts fully valid explicit offsets through plus 23:59", () => {
  for (const asOf of [
    "2024-02-29T23:59:59Z",
    "2026-02-28T23:59:59.123456789+23:59",
    "2026-01-01T00:00:00-23:59"
  ]) {
    assert.equal(
      upsertHistory(historyFile(), historyPoint({ asOf })).points[0].asOf,
      asOf
    );
  }

  for (const asOf of [
    "2026-02-29T12:00:00+23:59",
    "2024-02-30T12:00:00+23:59",
    "2026-04-31T12:00:00+23:59",
    "2026-01-01T24:00:00+23:59",
    "2026-01-01T00:60:00+23:59",
    "2026-01-01T00:00:60+23:59",
    "2026-01-01T00:00:00+24:00"
  ]) {
    assertDataRejected(() => upsertHistory(historyFile(), historyPoint({ asOf })));
  }
});

test("upsert allows replacement but rejects a distinct point at the history limit", () => {
  const base = historyPoint();
  const points = Array.from({ length: 100_000 }, (_, index) => ({
    ...base,
    accountKey: `example-${String(index).padStart(6, "0")}`,
    accountName: `Synthetic Example ${index}`
  }));
  const full = historyFile(points);
  const replacement = {
    ...points[0],
    accountName: "Synthetic Replacement At Limit"
  };

  const replaced = upsertHistory(full, replacement);
  assert.equal(replaced.points.length, 100_000);
  assert.equal(replaced.points[0].accountName, "Synthetic Replacement At Limit");
  assertDataRejected(() => upsertHistory(full, historyPoint({
    accountKey: "overflow",
    accountName: "Synthetic Overflow"
  })));
});

test("zero denominators require null rates and no replied-message duration", () => {
  const zero = historyPoint({
    repliedMessages: 0,
    recentUnansweredMessages: 0,
    oldUnansweredMessages: 0,
    eligibleMessages: 0,
    eligiblePhoneCalls: 0,
    connectedCalls: 0,
    totalEligible: 0,
    totalResponded: 0,
    totalResponsiveness: null,
    callsConnected: null,
    messagesReplied: null,
    repliedWithin24Hours: null,
    medianReplyNanoseconds: null,
    replySpeedBuckets: { within5m: 0, within1h: 0, within24h: 0, over24h: 0 }
  });

  assert.deepEqual(upsertHistory(historyFile(), zero).points, [zero]);
  assertDataRejected(() => upsertHistory(historyFile(), {
    ...zero,
    totalResponsiveness: 0
  }));
  assertDataRejected(() => upsertHistory(historyFile(), {
    ...zero,
    medianReplyNanoseconds: "0"
  }));
});

test("upsert is pure and returns detached canonical data", () => {
  const existingPoint = historyPoint({
    accountKey: "alpha",
    accountName: "Synthetic Alpha"
  });
  const existing = deepFreeze(historyFile([existingPoint]));
  const newPoint = deepFreeze(historyPoint());
  const beforeExisting = JSON.stringify(existing);
  const beforePoint = JSON.stringify(newPoint);

  const result = upsertHistory(existing, newPoint);

  assert.equal(JSON.stringify(existing), beforeExisting);
  assert.equal(JSON.stringify(newPoint), beforePoint);
  assert.notEqual(result, existing);
  assert.notEqual(result.points, existing.points);
  assert.notEqual(result.points[0], existing.points[0]);
  assert.notEqual(result.points[1], newPoint);
  result.points[1].diagnostics.bookingLeads = 99;
  assert.equal(newPoint.diagnostics.bookingLeads, 2);
});

test("history serialization contains only aggregate allowlisted data", () => {
  const serialized = JSON.stringify(upsertHistory(historyFile(), historyPoint()));
  const keys = new Set();
  JSON.parse(serialized, (key, value) => {
    if (key.length > 0) keys.add(key);
    return value;
  });
  for (const forbidden of [
    "recentUnanswered",
    "leadId",
    "messageText",
    "phoneNumber",
    "customerId",
    "accountId",
    "connector",
    "capability",
    "rawPayload",
    "inputPath"
  ]) {
    assert.equal(keys.has(forbidden), false);
  }
  assert.equal(serialized.includes("SYNTHETIC PRIVATE MARKER"), false);
});

test("writeHistoryAtomic performs a secure first write with a final newline", async (t) => {
  const directory = await temporaryDirectory(t);
  const historyPath = path.join(directory, "history.json");
  const history = upsertHistory(historyFile(), historyPoint());

  await writeHistoryAtomic(historyPath, history);

  const text = await readFile(historyPath, "utf8");
  assert.equal(text.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(text), history);
  assert.deepEqual(await readHistory(historyPath), history);
  assert.equal((await stat(historyPath)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(directory)).sort(), ["history.json"]);
});

test("writeHistoryAtomic overwrites atomically, restores mode, and is idempotent", async (t) => {
  const directory = await temporaryDirectory(t);
  const historyPath = path.join(directory, "history.json");
  await writeFile(historyPath, "SYNTHETIC OLD BYTES\n", { mode: 0o644 });
  await chmod(historyPath, 0o644);
  const history = upsertHistory(historyFile(), historyPoint());

  await writeHistoryAtomic(historyPath, history);
  const once = await readFile(historyPath);
  await writeHistoryAtomic(historyPath, history);
  const twice = await readFile(historyPath);

  assert.deepEqual(twice, once);
  assert.equal(once.includes(Buffer.from("SYNTHETIC OLD BYTES")), false);
  assert.equal((await stat(historyPath)).mode & 0o777, 0o600);
});

test("writeHistoryAtomic serializes canonical point and diagnostic ordering", async (t) => {
  const directory = await temporaryDirectory(t);
  const firstPath = path.join(directory, "first.json");
  const secondPath = path.join(directory, "second.json");
  const alpha = historyPoint({ accountKey: "alpha", accountName: "Synthetic Alpha" });
  const zeta = historyPoint({
    accountKey: "zeta",
    accountName: "Synthetic Zeta",
    diagnostics: {
      unsupportedLeadTypes: 1,
      incompleteWindowLeads: 1,
      bookingLeads: 2
    }
  });
  const first = upsertHistory(upsertHistory(historyFile(), zeta), alpha);
  const second = upsertHistory(upsertHistory(historyFile(), alpha), zeta);

  await writeHistoryAtomic(firstPath, first);
  await writeHistoryAtomic(secondPath, second);

  assert.deepEqual(await readFile(secondPath), await readFile(firstPath));
  assert.deepEqual(second, first);
});

test("writeHistoryAtomic rejects missing parents with a fixed sanitized error", async (t) => {
  const directory = await temporaryDirectory(t);
  const historyPath = path.join(directory, "missing-parent", "history.json");
  const history = upsertHistory(historyFile(), historyPoint());

  await assert.rejects(writeHistoryAtomic(historyPath, history), (error) => {
    assertOutputError(error, WRITE_ERROR);
    assert.equal(error.message.includes(historyPath), false);
    return true;
  });
  await assert.rejects(stat(path.dirname(historyPath)), { code: "ENOENT" });
});

test("writeHistoryAtomic rejects a group-writable parent before creating files", async (t) => {
  const directory = await temporaryDirectory(t);
  const historyPath = path.join(directory, "history.json");
  const history = upsertHistory(historyFile(), historyPoint());
  await chmod(directory, 0o770);

  try {
    await assert.rejects(writeHistoryAtomic(historyPath, history), (error) =>
      assertOutputError(error, WRITE_ERROR));
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await chmod(directory, 0o700);
  }
});

test("writeHistoryAtomic detects a parent identity change above Number precision", async (t) => {
  const directory = await temporaryDirectory(t);
  const canonicalDirectory = await fsPromises.realpath(directory);
  const historyPath = path.join(directory, "history.json");
  const history = upsertHistory(historyFile(), historyPoint());
  const firstDev = 9_007_199_254_740_992n;
  const secondDev = 9_007_199_254_740_993n;
  const firstIno = 18_014_398_509_481_984n;
  const secondIno = 18_014_398_509_481_985n;
  assert.equal(Number(firstDev), Number(secondDev));
  assert.equal(Number(firstIno), Number(secondIno));
  const originalLstat = fsPromises.lstat;
  let parentChecks = 0;

  fsPromises.lstat = async (candidate, options) => {
    const stats = await originalLstat(candidate, options);
    if (candidate !== canonicalDirectory) return stats;
    const changed = parentChecks > 0;
    parentChecks += 1;
    return withFilesystemIdentity(
      stats,
      changed ? secondDev : firstDev,
      changed ? secondIno : firstIno,
      options
    );
  };
  syncBuiltinESMExports();

  try {
    await assert.rejects(writeHistoryAtomic(historyPath, history), (error) =>
      assertOutputError(error, WRITE_ERROR));
  } finally {
    fsPromises.lstat = originalLstat;
    syncBuiltinESMExports();
  }

  assert.equal(parentChecks, 2);
  await assert.rejects(stat(historyPath), { code: "ENOENT" });
  assert.deepEqual(await readdir(directory), []);
});

test("writeHistoryAtomic detects a temp identity change above Number precision", async (t) => {
  const directory = await temporaryDirectory(t);
  const historyPath = path.join(directory, "history.json");
  const history = upsertHistory(historyFile(), historyPoint());
  const firstDev = 9_007_199_254_740_992n;
  const secondDev = 9_007_199_254_740_993n;
  const firstIno = 18_014_398_509_481_984n;
  const secondIno = 18_014_398_509_481_985n;
  assert.equal(Number(firstDev), Number(secondDev));
  assert.equal(Number(firstIno), Number(secondIno));
  const originalLstat = fsPromises.lstat;
  const originalOpen = fsPromises.open;
  let temporaryPath;

  fsPromises.open = async (...args) => {
    const handle = await originalOpen(...args);
    return new Proxy(handle, {
      get(target, property) {
        if (property === "stat") {
          return async (options) => withFilesystemIdentity(
            await target.stat(options), firstDev, firstIno, options
          );
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
  };
  fsPromises.lstat = async (candidate, options) => {
    const stats = await originalLstat(candidate, options);
    if (!path.basename(candidate).startsWith(".history.json.tmp-")) return stats;
    temporaryPath = candidate;
    return withFilesystemIdentity(stats, secondDev, secondIno, options);
  };
  syncBuiltinESMExports();

  try {
    await assert.rejects(writeHistoryAtomic(historyPath, history), (error) =>
      assertOutputError(error, WRITE_ERROR));
  } finally {
    fsPromises.open = originalOpen;
    fsPromises.lstat = originalLstat;
    syncBuiltinESMExports();
  }

  assert.notEqual(temporaryPath, undefined);
  await assert.rejects(stat(historyPath), { code: "ENOENT" });
  assert.equal((await stat(temporaryPath)).isFile(), true);
});

test("writeHistoryAtomic rejects a changed temp identity before rename", async (t) => {
  const directory = await temporaryDirectory(t);
  const historyPath = path.join(directory, "history.json");
  const foreignSource = path.join(directory, "foreign-source");
  const foreignBytes = Buffer.from("SYNTHETIC FOREIGN REPLACEMENT\n", "utf8");
  await writeFile(foreignSource, foreignBytes, { mode: 0o600 });
  const history = upsertHistory(historyFile(), historyPoint());
  const originalLstat = fsPromises.lstat;
  const originalRename = fsPromises.rename;
  let replacementPath;

  fsPromises.lstat = async (candidate, ...args) => {
    if (replacementPath === undefined &&
        path.basename(candidate).startsWith(".history.json.tmp-")) {
      replacementPath = candidate;
      await originalRename(foreignSource, candidate);
    }
    return originalLstat(candidate, ...args);
  };
  syncBuiltinESMExports();

  try {
    await assert.rejects(writeHistoryAtomic(historyPath, history), (error) =>
      assertOutputError(error, WRITE_ERROR));
  } finally {
    fsPromises.lstat = originalLstat;
    syncBuiltinESMExports();
  }

  assert.notEqual(replacementPath, undefined);
  assert.deepEqual(await readFile(replacementPath), foreignBytes);
  await assert.rejects(stat(historyPath), { code: "ENOENT" });
});

test("cleanup never deletes a foreign replacement at the owned temp path", async (t) => {
  const directory = await temporaryDirectory(t);
  const historyPath = path.join(directory, "history.json");
  const originalTarget = Buffer.from("SYNTHETIC ORIGINAL TARGET\n", "utf8");
  const foreignSource = path.join(directory, "foreign-source");
  const foreignBytes = Buffer.from("SYNTHETIC FOREIGN TEMP\n", "utf8");
  await writeFile(historyPath, originalTarget, { mode: 0o600 });
  await writeFile(foreignSource, foreignBytes, { mode: 0o600 });
  const history = upsertHistory(historyFile(), historyPoint());
  const originalRename = fsPromises.rename;
  let replacementPath;

  fsPromises.rename = async (source, destination) => {
    if (path.basename(source).startsWith(".history.json.tmp-")) {
      replacementPath = source;
      await originalRename(foreignSource, source);
      const error = new Error("synthetic rename failure");
      error.code = "EIO";
      throw error;
    }
    return originalRename(source, destination);
  };
  syncBuiltinESMExports();

  try {
    await assert.rejects(writeHistoryAtomic(historyPath, history), (error) =>
      assertOutputError(error, WRITE_ERROR));
  } finally {
    fsPromises.rename = originalRename;
    syncBuiltinESMExports();
  }

  assert.notEqual(replacementPath, undefined);
  assert.deepEqual(await readFile(historyPath), originalTarget);
  assert.deepEqual(await readFile(replacementPath), foreignBytes);
});

test("write validation preserves an existing target byte-for-byte", async (t) => {
  const directory = await temporaryDirectory(t);
  const historyPath = path.join(directory, "history.json");
  const original = Buffer.from("SYNTHETIC EXISTING HISTORY BYTES\n", "utf8");
  await writeFile(historyPath, original);

  await assert.rejects(writeHistoryAtomic(historyPath, historyFile([
    { ...historyPoint(), leadId: "SYNTHETIC PRIVATE ID" }
  ])), (error) => assertOutputError(error, DATA_ERROR));

  assert.deepEqual(await readFile(historyPath), original);
  assert.deepEqual((await readdir(directory)).sort(), ["history.json"]);
});

test("a post-temp write failure removes only its known sibling temp", async (t) => {
  const directory = await temporaryDirectory(t);
  const historyPath = path.join(directory, "history.json");
  const unrelated = path.join(directory, ".history.json.tmp-unrelated");
  await mkdir(historyPath);
  await writeFile(unrelated, "SYNTHETIC UNRELATED TEMP\n");
  const history = upsertHistory(historyFile(), historyPoint());

  await assert.rejects(writeHistoryAtomic(historyPath, history), (error) =>
    assertOutputError(error, WRITE_ERROR));

  assert.equal((await stat(historyPath)).isDirectory(), true);
  assert.equal(await readFile(unrelated, "utf8"), "SYNTHETIC UNRELATED TEMP\n");
  assert.deepEqual((await readdir(directory)).sort(), [
    ".history.json.tmp-unrelated",
    "history.json"
  ]);
});

test("an exclusive-open collision never deletes the pre-existing temp", async (t) => {
  const directory = await temporaryDirectory(t);
  const historyPath = path.join(directory, "history.json");
  const randomHex = "07".repeat(16);
  const collisionPath = path.join(
    directory,
    `.history.json.tmp-${process.pid}-${randomHex}`
  );
  const collisionBytes = Buffer.from("SYNTHETIC PRE-EXISTING TEMP\n", "utf8");
  await writeFile(collisionPath, collisionBytes);
  const history = upsertHistory(historyFile(), historyPoint());
  const originalRandomBytes = crypto.randomBytes;
  crypto.randomBytes = () => Buffer.alloc(16, 7);
  syncBuiltinESMExports();

  try {
    await assert.rejects(writeHistoryAtomic(historyPath, history), (error) =>
      assertOutputError(error, WRITE_ERROR));
  } finally {
    crypto.randomBytes = originalRandomBytes;
    syncBuiltinESMExports();
  }

  assert.deepEqual(await readFile(collisionPath), collisionBytes);
  await assert.rejects(stat(historyPath), { code: "ENOENT" });
});

test("writeHistoryAtomic accepts frozen input without mutation", async (t) => {
  const directory = await temporaryDirectory(t);
  const historyPath = path.join(directory, "history.json");
  const history = deepFreeze(upsertHistory(historyFile(), historyPoint()));
  const before = JSON.stringify(history);

  await writeHistoryAtomic(historyPath, history);

  assert.equal(JSON.stringify(history), before);
  assert.deepEqual(await readHistory(historyPath), history);
});
