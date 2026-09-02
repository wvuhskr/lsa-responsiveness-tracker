import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink
} from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import { OutputError } from "./errors.js";
import { readHistory, writeHistoryAtomic } from "./history.js";
import { assertReportModel } from "./report-model.js";
import { parseStrictJson } from "./strict-json.js";
import { writeOutputBundle } from "./write-output.js";

const WRITE_ERROR = "Report and history could not be written.";
const PRODUCT = "lsa-responsiveness-tracker";
const MANIFEST_NAME = "report-manifest.json";
const STATIC_REPORT_FILES = Object.freeze(["report.html", "summary.json"]);
const MAX_MANIFEST_BYTES = 64n * 1024n;
const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

class InvalidTransaction extends Error {}

function invalid() {
  throw new InvalidTransaction();
}

function isPlainDataRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) {
    return false;
  }
  for (const name of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value") ||
        descriptor.enumerable !== true) {
      return false;
    }
  }
  return true;
}

function exactRecord(value, names) {
  if (!isPlainDataRecord(value)) invalid();
  const actual = Object.getOwnPropertyNames(value).sort();
  const expected = [...names].sort();
  if (actual.length !== expected.length ||
      actual.some((name, index) => name !== expected[index])) {
    invalid();
  }
  return value;
}

function canonicalInput(input) {
  exactRecord(input, ["reportDestination", "reportModel", "history"]);
  if (typeof input.reportDestination !== "string" ||
      input.reportDestination.length === 0 ||
      input.reportDestination.includes("\u0000")) {
    invalid();
  }
  const reportModel = assertReportModel(input.reportModel);
  if (reportModel.mode !== "private") invalid();

  let history = null;
  if (input.history !== null) {
    exactRecord(input.history, ["path", "previous", "next"]);
    if (typeof input.history.path !== "string" ||
        input.history.path.length === 0 || input.history.path.includes("\u0000") ||
        !isPlainDataRecord(input.history.previous) ||
        !isPlainDataRecord(input.history.next)) {
      invalid();
    }
    history = {
      path: input.history.path,
      previous: input.history.previous,
      next: input.history.next
    };
  }
  return {
    reportDestination: input.reportDestination,
    reportModel,
    history
  };
}

function canonicalFactoryOptions(options) {
  exactRecord(options, ["checkpoint"]);
  if (typeof options.checkpoint !== "function") invalid();
  return options.checkpoint;
}

function retainedIdentity(stats) {
  if (typeof stats.dev !== "bigint" || typeof stats.ino !== "bigint") invalid();
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(stats, identity) {
  return identity !== undefined && typeof stats.dev === "bigint" &&
    typeof stats.ino === "bigint" && stats.dev === identity.dev &&
    stats.ino === identity.ino;
}

function validateOwner(stats) {
  if (typeof process.getuid === "function" &&
      stats.uid !== BigInt(process.getuid())) {
    invalid();
  }
}

function validateParentStats(stats) {
  if (!stats.isDirectory() || typeof stats.mode !== "bigint" ||
      (stats.mode & 0o022n) !== 0n) {
    invalid();
  }
  validateOwner(stats);
}

function validatePrivateDirectoryStats(stats) {
  if (!stats.isDirectory() || typeof stats.mode !== "bigint" ||
      typeof stats.nlink !== "bigint" || (stats.mode & 0o077n) !== 0n) {
    invalid();
  }
  validateOwner(stats);
}

function validatePrivateFileStats(stats) {
  if (!stats.isFile() || typeof stats.mode !== "bigint" ||
      typeof stats.size !== "bigint" || typeof stats.nlink !== "bigint" ||
      stats.nlink !== 1n || (stats.mode & 0o077n) !== 0n) {
    invalid();
  }
  validateOwner(stats);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function recordFor(stats, bytes) {
  const identity = retainedIdentity(stats);
  return {
    ...identity,
    size: stats.size,
    digest: digest(bytes)
  };
}

function sameRecord(left, right) {
  return left !== undefined && right !== undefined &&
    left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.digest === right.digest;
}

async function lstatOrAbsent(target) {
  try {
    return await lstat(target, { bigint: true });
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    invalid();
  }
}

async function revalidateParent(state) {
  const stats = await lstat(state.parent, { bigint: true });
  validateParentStats(stats);
  if (!sameIdentity(stats, state.parentIdentity)) invalid();
}

async function confirmedAbsent(target, state) {
  if (await lstatOrAbsent(target) !== null) return false;
  await revalidateParent(state);
  return await lstatOrAbsent(target) === null;
}

async function readPrivateFile(filePath, expected, maximumBytes) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(filePath, flags);
    const opened = await handle.stat({ bigint: true });
    validatePrivateFileStats(opened);
    if (maximumBytes !== undefined && opened.size > maximumBytes) invalid();
    const bytes = await handle.readFile();
    const finalStats = await handle.stat({ bigint: true });
    validatePrivateFileStats(finalStats);
    if (!sameIdentity(finalStats, retainedIdentity(opened)) ||
        finalStats.size !== opened.size ||
        BigInt(bytes.byteLength) !== finalStats.size) {
      invalid();
    }
    const record = recordFor(finalStats, bytes);
    if (expected !== undefined && !sameRecord(record, expected)) invalid();
    await handle.close();
    handle = undefined;
    const pathnameStats = await lstat(filePath, { bigint: true });
    validatePrivateFileStats(pathnameStats);
    if (!sameIdentity(pathnameStats, record) ||
        pathnameStats.size !== record.size) {
      invalid();
    }
    return { bytes, record };
  } catch {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {}
    }
    invalid();
  }
}

function exactManifest(value) {
  exactRecord(value, ["product", "schemaVersion", "mode", "files"]);
  if (value.product !== PRODUCT || value.schemaVersion !== 1 ||
      value.mode !== "private" || !Array.isArray(value.files) ||
      Object.getPrototypeOf(value.files) !== Array.prototype ||
      Object.getOwnPropertySymbols(value.files).length !== 0) {
    invalid();
  }
  const expected = [...STATIC_REPORT_FILES];
  if (value.files.length === 3) expected.push("recent-unanswered.csv");
  if (value.files.length !== expected.length ||
      value.files.some((name, index) => name !== expected[index])) {
    invalid();
  }
  return {
    product: PRODUCT,
    schemaVersion: 1,
    mode: "private",
    files: expected
  };
}

function manifestSource(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function validateReportBundle(directory, expected) {
  const stats = await lstat(directory, { bigint: true });
  validatePrivateDirectoryStats(stats);
  const identity = retainedIdentity(stats);
  if (expected !== undefined && !sameIdentity(stats, expected.identity)) invalid();

  const manifestFile = await readPrivateFile(
    path.join(directory, MANIFEST_NAME),
    expected?.files.get(MANIFEST_NAME),
    MAX_MANIFEST_BYTES
  );
  let parsed;
  try {
    parsed = parseStrictJson(manifestFile.bytes.toString("utf8"));
  } catch {
    invalid();
  }
  const manifest = exactManifest(parsed);
  if (manifestFile.bytes.toString("utf8") !== manifestSource(manifest)) invalid();

  const expectedNames = [...manifest.files, MANIFEST_NAME].sort();
  const actualNames = (await readdir(directory)).sort();
  if (actualNames.length !== expectedNames.length ||
      actualNames.some((name, index) => name !== expectedNames[index])) {
    invalid();
  }
  const files = new Map([[MANIFEST_NAME, manifestFile.record]]);
  for (const name of manifest.files) {
    const file = await readPrivateFile(
      path.join(directory, name),
      expected?.files.get(name)
    );
    files.set(name, file.record);
  }
  if (expected !== undefined && expected.files.size !== files.size) invalid();
  const finalNames = (await readdir(directory)).sort();
  const finalStats = await lstat(directory, { bigint: true });
  validatePrivateDirectoryStats(finalStats);
  if (!sameIdentity(finalStats, identity) ||
      finalNames.length !== expectedNames.length ||
      finalNames.some((name, index) => name !== expectedNames[index])) {
    invalid();
  }
  return { identity, files, manifest };
}

async function validateHistoryFile(filePath, expectedHistory, expectedRecord) {
  const first = await readPrivateFile(filePath, expectedRecord);
  const parsed = await readHistory(filePath);
  const second = await readPrivateFile(filePath, first.record);
  if (!sameRecord(first.record, second.record) ||
      !isDeepStrictEqual(parsed, expectedHistory)) {
    invalid();
  }
  return first.record;
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function pathsOverlap(left, right) {
  return isContained(left, right) || isContained(right, left);
}

async function prepareTarget(requested) {
  if (typeof requested !== "string" || requested.length === 0 ||
      requested.includes("\u0000")) {
    invalid();
  }
  const absolute = path.resolve(requested);
  const requestedParent = path.dirname(absolute);
  const basename = path.basename(absolute);
  if (basename.length === 0 || basename === "." || basename === ".." ||
      !Number.isSafeInteger(process.pid) || process.pid <= 0) {
    invalid();
  }
  const requestedParentStats = await lstat(requestedParent, { bigint: true });
  if (requestedParentStats.isSymbolicLink()) invalid();
  validateParentStats(requestedParentStats);
  const parent = await realpath(requestedParent);
  const parentStats = await lstat(parent, { bigint: true });
  validateParentStats(parentStats);
  const target = path.join(parent, basename);
  if (path.dirname(target) !== parent || path.basename(target) !== basename) {
    invalid();
  }
  return {
    parent,
    parentIdentity: retainedIdentity(parentStats),
    basename,
    target
  };
}

async function validatePackageBoundary(requested, target) {
  const packageStats = await lstat(PACKAGE_ROOT, { bigint: true });
  if (packageStats.isSymbolicLink() || !packageStats.isDirectory()) invalid();
  const canonicalPackageRoot = await realpath(PACKAGE_ROOT);
  const lexicalInside = isContained(PACKAGE_ROOT, path.resolve(requested));
  const physicalInside = isContained(canonicalPackageRoot, target);
  if (lexicalInside !== physicalInside) invalid();
  if (physicalInside && !isContained(
    path.join(canonicalPackageRoot, "private-output"),
    target
  )) {
    invalid();
  }
}

function randomSibling(state, kind) {
  const random = randomBytes(16).toString("hex");
  if (!/^[0-9a-f]{32}$/.test(random)) invalid();
  const name = `.${state.basename}.${kind}-${process.pid}-${random}`;
  const sibling = path.join(state.parent, name);
  if (path.dirname(sibling) !== state.parent || path.basename(sibling) !== name) {
    invalid();
  }
  return sibling;
}

async function syncDirectory(directory, expectedIdentity, privateDirectory) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) |
    (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(directory, flags);
    const opened = await handle.stat({ bigint: true });
    if (privateDirectory) {
      validatePrivateDirectoryStats(opened);
    } else {
      validateParentStats(opened);
    }
    if (!sameIdentity(opened, expectedIdentity)) invalid();
    await handle.sync();
    await handle.close();
    handle = undefined;
    const finalStats = await lstat(directory, { bigint: true });
    if (privateDirectory) {
      validatePrivateDirectoryStats(finalStats);
    } else {
      validateParentStats(finalStats);
    }
    if (!sameIdentity(finalStats, expectedIdentity)) invalid();
  } catch {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {}
    }
    invalid();
  }
}

function identityKeysForReport(bundle) {
  return [
    `${bundle.identity.dev}:${bundle.identity.ino}`,
    ...[...bundle.files.values()].map((record) => `${record.dev}:${record.ino}`)
  ];
}

function assertDistinctPhysicalRecords(records) {
  const seen = new Set();
  for (const record of records) {
    const keys = record.kind === "report"
      ? identityKeysForReport(record.value)
      : [`${record.value.dev}:${record.value.ino}`];
    for (const key of keys) {
      if (seen.has(key)) invalid();
      seen.add(key);
    }
  }
}

async function validateExistingTargets(reportState, historyState, previous) {
  const reportStats = await lstatOrAbsent(reportState.target);
  if (reportStats === null) {
    if (!await confirmedAbsent(reportState.target, reportState)) invalid();
    reportState.existing = null;
  } else {
    if (reportStats.isSymbolicLink()) invalid();
    reportState.existing = await validateReportBundle(reportState.target);
  }

  const historyStats = await lstatOrAbsent(historyState.target);
  if (historyStats === null) {
    if (!await confirmedAbsent(historyState.target, historyState) ||
        !isDeepStrictEqual(previous, { schemaVersion: 1, points: [] })) {
      invalid();
    }
    historyState.existing = null;
  } else {
    if (historyStats.isSymbolicLink()) invalid();
    historyState.existing = await validateHistoryFile(
      historyState.target,
      previous
    );
  }
  const physical = [];
  if (reportState.existing !== null) {
    physical.push({ kind: "report", value: reportState.existing });
  }
  if (historyState.existing !== null) {
    physical.push({ kind: "history", value: historyState.existing });
  }
  assertDistinctPhysicalRecords(physical);
}

async function validateStateRecord(state, location, expectedHistory) {
  const expected = location === "target"
    ? (state.installed ? state.stageRecord : state.existing)
    : location === "stage" ? state.stageRecord : state.existing;
  const target = state[location];
  if (expected === null || expected === undefined || target === undefined) invalid();
  return state.kind === "report"
    ? validateReportBundle(target, expected)
    : validateHistoryFile(
      target,
      expectedHistory ?? (location === "stage" || state.installed
        ? state.nextHistory
        : state.previousHistory),
      expected
    );
}

async function revalidateForwardState(reportState, historyState) {
  await revalidateParent(reportState);
  await revalidateParent(historyState);
  if (reportState.backedUp) await validateStateRecord(reportState, "backup");
  if (historyState.backedUp) {
    await validateStateRecord(historyState, "backup", historyState.previousHistory);
  }
  if (reportState.installed) await validateStateRecord(reportState, "target");
  if (historyState.installed) {
    await validateStateRecord(historyState, "target", historyState.nextHistory);
  }
}

async function checkpointAndRevalidate(checkpoint, name, reportState,
  historyState) {
  await checkpoint(name);
  await revalidateForwardState(reportState, historyState);
}

async function cleanupHistoryFile(filePath, record, expectedHistory) {
  if (filePath === undefined || record === undefined) return true;
  try {
    await validateHistoryFile(filePath, expectedHistory, record);
    await unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

async function cleanupReportBundle(directory, bundle) {
  if (directory === undefined || bundle === undefined) return true;
  try {
    await validateReportBundle(directory, bundle);
    for (const name of [...bundle.files.keys()].sort()) {
      await readPrivateFile(path.join(directory, name), bundle.files.get(name));
      await unlink(path.join(directory, name));
    }
    const stats = await lstat(directory, { bigint: true });
    validatePrivateDirectoryStats(stats);
    if (!sameIdentity(stats, bundle.identity) ||
        (await readdir(directory)).length !== 0) {
      invalid();
    }
    await rmdir(directory);
    return true;
  } catch {
    return false;
  }
}

async function cleanupOwnedStage(state) {
  if (state.stage === undefined || state.stageRecord === undefined) return true;
  return state.kind === "report"
    ? cleanupReportBundle(state.stage, state.stageRecord)
    : cleanupHistoryFile(state.stage, state.stageRecord, state.nextHistory);
}

async function quarantineForeignTarget(state) {
  const current = await lstatOrAbsent(state.target);
  if (current === null) return true;
  const quarantine = randomSibling(state, "quarantine");
  if (!await confirmedAbsent(quarantine, state)) return false;
  await revalidateParent(state);
  await rename(state.target, quarantine);
  return await confirmedAbsent(state.target, state);
}

async function moveInstalledBackToStage(state) {
  if (!state.installed) {
    if (state.existing === null &&
        !await confirmedAbsent(state.target, state)) {
      return quarantineForeignTarget(state);
    }
    return true;
  }
  let owned = true;
  try {
    await validateStateRecord(
      state,
      "target",
      state.kind === "history" ? state.nextHistory : undefined
    );
  } catch {
    owned = false;
  }
  if (!owned) {
    state.installed = false;
    return quarantineForeignTarget(state);
  }

  let recovery = state.stage;
  if (recovery === undefined || !await confirmedAbsent(recovery, state)) {
    recovery = randomSibling(state, "rollback");
    if (!await confirmedAbsent(recovery, state)) return false;
  }
  await revalidateParent(state);
  await rename(state.target, recovery);
  state.stage = recovery;
  state.installed = false;
  await validateStateRecord(
    state,
    "stage",
    state.kind === "history" ? state.nextHistory : undefined
  );
  return true;
}

async function restoreBackup(state) {
  if (!state.backedUp) return true;
  try {
    await revalidateParent(state);
    await validateStateRecord(
      state,
      "backup",
      state.kind === "history" ? state.previousHistory : undefined
    );
    if (!await confirmedAbsent(state.target, state) &&
        !await quarantineForeignTarget(state)) {
      return false;
    }
    await rename(state.backup, state.target);
    state.backedUp = false;
    if (state.kind === "report") {
      await validateReportBundle(state.target, state.existing);
    } else {
      await validateHistoryFile(
        state.target,
        state.previousHistory,
        state.existing
      );
    }
    return true;
  } catch {
    return false;
  }
}

async function rollback(reportState, historyState) {
  let restored = true;
  for (const state of [reportState, historyState]) {
    try {
      if (!await moveInstalledBackToStage(state)) restored = false;
    } catch {
      restored = false;
    }
  }
  for (const state of [reportState, historyState]) {
    if (!await restoreBackup(state)) restored = false;
  }
  for (const state of [reportState, historyState]) {
    if (!await cleanupOwnedStage(state)) restored = false;
  }
  return restored;
}

async function backupExisting(state, checkpoint, reportState, historyState) {
  if (state.existing === null) return;
  state.backup = randomSibling(state, "backup");
  if (!await confirmedAbsent(state.backup, state)) invalid();
  const before = `before-${state.kind}-backup`;
  const after = `after-${state.kind}-backup`;
  await checkpointAndRevalidate(checkpoint, before, reportState, historyState);
  await revalidateParent(state);
  await validateStateRecord(
    state,
    "target",
    state.kind === "history" ? state.previousHistory : undefined
  );
  await rename(state.target, state.backup);
  state.backedUp = true;
  if (!await confirmedAbsent(state.target, state)) invalid();
  await validateStateRecord(
    state,
    "backup",
    state.kind === "history" ? state.previousHistory : undefined
  );
  await checkpointAndRevalidate(checkpoint, after, reportState, historyState);
}

async function installStage(state, checkpoint, reportState, historyState) {
  const before = `before-${state.kind}-install`;
  const after = `after-${state.kind}-install`;
  await checkpointAndRevalidate(checkpoint, before, reportState, historyState);
  await revalidateParent(state);
  await validateStateRecord(
    state,
    "stage",
    state.kind === "history" ? state.nextHistory : undefined
  );
  if (!await confirmedAbsent(state.target, state)) invalid();
  await rename(state.stage, state.target);
  state.installed = true;
  await validateStateRecord(
    state,
    "target",
    state.kind === "history" ? state.nextHistory : undefined
  );
  if (!await confirmedAbsent(state.stage, state)) invalid();
  await checkpointAndRevalidate(checkpoint, after, reportState, historyState);
}

async function cleanupBackupAfterCommit(state, checkpoint, reportState,
  historyState) {
  if (!state.backedUp) return;
  await checkpointAndRevalidate(
    checkpoint,
    `before-${state.kind}-backup-cleanup`,
    reportState,
    historyState
  );
  const cleaned = state.kind === "report"
    ? await cleanupReportBundle(state.backup, state.existing)
    : await cleanupHistoryFile(
      state.backup,
      state.existing,
      state.previousHistory
    );
  if (!cleaned) invalid();
  state.backedUp = false;
  await checkpointAndRevalidate(
    checkpoint,
    `after-${state.kind}-backup-cleanup`,
    reportState,
    historyState
  );
}

async function coordinatedWrite(input, checkpoint) {
  let canonical;
  try {
    canonical = canonicalInput(input);
  } catch {
    throw new OutputError(WRITE_ERROR);
  }
  if (canonical.history === null) {
    try {
      return await writeOutputBundle(
        canonical.reportDestination,
        canonical.reportModel
      );
    } catch {
      throw new OutputError(WRITE_ERROR);
    }
  }

  let reportState;
  let historyState;
  let committed = false;
  try {
    reportState = {
      ...(await prepareTarget(canonical.reportDestination)),
      kind: "report",
      stage: undefined,
      stageRecord: undefined,
      backup: undefined,
      existing: undefined,
      backedUp: false,
      installed: false
    };
    historyState = {
      ...(await prepareTarget(canonical.history.path)),
      kind: "history",
      stage: undefined,
      stageRecord: undefined,
      backup: undefined,
      existing: undefined,
      previousHistory: canonical.history.previous,
      nextHistory: canonical.history.next,
      backedUp: false,
      installed: false
    };
    await validatePackageBoundary(
      canonical.reportDestination,
      reportState.target
    );
    await validatePackageBoundary(canonical.history.path, historyState.target);
    if (pathsOverlap(reportState.target, historyState.target)) invalid();
    await validateExistingTargets(
      reportState,
      historyState,
      canonical.history.previous
    );

    historyState.stage = randomSibling(historyState, "stage");
    reportState.stage = randomSibling(reportState, "stage");
    if (pathsOverlap(reportState.stage, historyState.stage) ||
        pathsOverlap(reportState.stage, historyState.target) ||
        pathsOverlap(historyState.stage, reportState.target) ||
        !await confirmedAbsent(historyState.stage, historyState) ||
        !await confirmedAbsent(reportState.stage, reportState)) {
      invalid();
    }

    await writeHistoryAtomic(historyState.stage, canonical.history.next);
    historyState.stageRecord = await validateHistoryFile(
      historyState.stage,
      canonical.history.next
    );
    await syncDirectory(historyState.parent, historyState.parentIdentity, false);
    await checkpoint("after-history-stage");
    await validateStateRecord(historyState, "stage", historyState.nextHistory);
    await revalidateParent(historyState);

    await writeOutputBundle(reportState.stage, canonical.reportModel);
    reportState.stageRecord = await validateReportBundle(reportState.stage);
    await syncDirectory(
      reportState.stage,
      reportState.stageRecord.identity,
      true
    );
    await syncDirectory(reportState.parent, reportState.parentIdentity, false);
    await checkpoint("after-report-stage");
    await validateStateRecord(reportState, "stage");
    await validateStateRecord(historyState, "stage", historyState.nextHistory);
    await revalidateParent(reportState);
    await revalidateParent(historyState);

    const physical = [
      { kind: "report", value: reportState.stageRecord },
      { kind: "history", value: historyState.stageRecord }
    ];
    if (reportState.existing !== null) {
      physical.push({ kind: "report", value: reportState.existing });
    }
    if (historyState.existing !== null) {
      physical.push({ kind: "history", value: historyState.existing });
    }
    assertDistinctPhysicalRecords(physical);

    await backupExisting(historyState, checkpoint, reportState, historyState);
    await backupExisting(reportState, checkpoint, reportState, historyState);
    await installStage(historyState, checkpoint, reportState, historyState);
    await installStage(reportState, checkpoint, reportState, historyState);

    await checkpointAndRevalidate(
      checkpoint,
      "before-commit",
      reportState,
      historyState
    );
    await syncDirectory(historyState.parent, historyState.parentIdentity, false);
    if (reportState.parent !== historyState.parent) {
      await syncDirectory(reportState.parent, reportState.parentIdentity, false);
    }
    await revalidateForwardState(reportState, historyState);
    committed = true;

    await cleanupBackupAfterCommit(
      historyState,
      checkpoint,
      reportState,
      historyState
    );
    await cleanupBackupAfterCommit(
      reportState,
      checkpoint,
      reportState,
      historyState
    );
    reportState.installed = false;
    historyState.installed = false;
    return {
      product: PRODUCT,
      schemaVersion: 1,
      report: reportState.stageRecord.manifest,
      historyWritten: true
    };
  } catch {
    if (!committed && reportState !== undefined && historyState !== undefined) {
      await rollback(reportState, historyState);
    }
    throw new OutputError(WRITE_ERROR);
  }
}

const productionWriter = (input) => coordinatedWrite(input, async () => {});

export async function writeReportTransaction(input) {
  return productionWriter(input);
}

export function _createReportTransactionForTests(options) {
  let checkpoint;
  try {
    checkpoint = canonicalFactoryOptions(options);
  } catch {
    throw new TypeError("Report transaction test options are invalid.");
  }
  return (input) => coordinatedWrite(input, checkpoint);
}
