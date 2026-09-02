import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OutputError } from "./errors.js";
import { renderCsv } from "./render-csv.js";
import { renderHtml } from "./render-html.js";
import { renderJson } from "./render-json.js";
import { parseStrictJson } from "./strict-json.js";

const PRODUCT = "lsa-responsiveness-tracker";
const SCHEMA_VERSION = 1;
const UNSAFE_ERROR = "Report output target is unsafe.";
const WRITE_ERROR = "Report output could not be written.";
const MAX_MANIFEST_BYTES = 64n * 1024n;
const MODULE_PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const MANIFEST_NAME = "report-manifest.json";
const STATIC_PAYLOADS = Object.freeze(["report.html", "summary.json"]);

class InvalidOutput extends Error {}

function invalid() {
  throw new InvalidOutput();
}

function isPlainDataRecord(value) {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype &&
    Object.getOwnPropertySymbols(value).length === 0;
}

function canonicalWriterOptions(options) {
  if (!isPlainDataRecord(options)) invalid();
  const names = Object.getOwnPropertyNames(options);
  if (names.some((name) => name !== "replaceDemo") || names.length > 1) {
    invalid();
  }
  if (!Object.hasOwn(options, "replaceDemo")) return { replaceDemo: false };
  const descriptor = Object.getOwnPropertyDescriptor(options, "replaceDemo");
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value") ||
      descriptor.enumerable !== true ||
      typeof descriptor.value !== "boolean") {
    invalid();
  }
  return { replaceDemo: descriptor.value };
}

function canonicalTestFactoryOptions(options) {
  if (!isPlainDataRecord(options)) invalid();
  const names = Object.getOwnPropertyNames(options).sort();
  if (names.length !== 2 || names[0] !== "checkpoint" ||
      names[1] !== "packageRoot") {
    invalid();
  }
  const checkpoint = Object.getOwnPropertyDescriptor(options, "checkpoint");
  const packageRoot = Object.getOwnPropertyDescriptor(options, "packageRoot");
  if (checkpoint === undefined || packageRoot === undefined ||
      !Object.hasOwn(checkpoint, "value") ||
      !Object.hasOwn(packageRoot, "value") ||
      checkpoint.enumerable !== true || packageRoot.enumerable !== true ||
      typeof checkpoint.value !== "function" ||
      typeof packageRoot.value !== "string") {
    invalid();
  }
  return {
    checkpoint: checkpoint.value,
    packageRoot: packageRoot.value
  };
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function retainedIdentity(stats) {
  if (typeof stats.dev !== "bigint" || typeof stats.ino !== "bigint") {
    invalid();
  }
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(stats, identity) {
  return identity !== undefined && typeof stats.dev === "bigint" &&
    typeof stats.ino === "bigint" && stats.dev === identity.dev &&
    stats.ino === identity.ino;
}

function validateCurrentOwner(stats) {
  if (typeof process.getuid === "function" &&
      stats.uid !== BigInt(process.getuid())) {
    invalid();
  }
}

function validateParentDirectory(stats) {
  if (!stats.isDirectory() || typeof stats.mode !== "bigint" ||
      (stats.mode & 0o022n) !== 0n) {
    invalid();
  }
  validateCurrentOwner(stats);
}

function validatePrivateDirectory(stats) {
  if (!stats.isDirectory() || typeof stats.mode !== "bigint" ||
      (stats.mode & 0o777n) !== 0o700n) {
    invalid();
  }
  validateCurrentOwner(stats);
}

function validateOwnedDirectoryForNormalization(stats) {
  if (!stats.isDirectory() || typeof stats.mode !== "bigint") invalid();
  validateCurrentOwner(stats);
  retainedIdentity(stats);
}

function validatePrivateFile(stats) {
  if (!stats.isFile() || typeof stats.mode !== "bigint" ||
      typeof stats.size !== "bigint" || typeof stats.nlink !== "bigint" ||
      stats.nlink !== 1n || (stats.mode & 0o077n) !== 0n) {
    invalid();
  }
  validateCurrentOwner(stats);
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

function exactManifest(value) {
  if (!isPlainDataRecord(value)) invalid();
  const keys = Object.keys(value);
  if (keys.length !== 4 || !Object.hasOwn(value, "product") ||
      !Object.hasOwn(value, "schemaVersion") || !Object.hasOwn(value, "mode") ||
      !Object.hasOwn(value, "files") || value.product !== PRODUCT ||
      value.schemaVersion !== SCHEMA_VERSION ||
      !["private", "synthetic"].includes(value.mode) ||
      !Array.isArray(value.files) ||
      Object.getPrototypeOf(value.files) !== Array.prototype ||
      Object.getOwnPropertySymbols(value.files).length !== 0) {
    invalid();
  }
  const expected = [...STATIC_PAYLOADS];
  if (value.files.length === 3) expected.push("recent-unanswered.csv");
  if (value.files.length !== expected.length ||
      value.files.some((file, index) => file !== expected[index])) {
    invalid();
  }
  return {
    product: PRODUCT,
    schemaVersion: SCHEMA_VERSION,
    mode: value.mode,
    files: expected
  };
}

function manifestBytes(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function digestBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readVerifiedPrivateFile(filePath, expected, maxBytes) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(filePath, flags);
    const openedStats = await handle.stat({ bigint: true });
    validatePrivateFile(openedStats);
    if (maxBytes !== undefined && openedStats.size > maxBytes) invalid();
    const identity = retainedIdentity(openedStats);
    if (expected !== undefined &&
        (!sameIdentity(openedStats, expected) ||
          openedStats.size !== expected.size)) {
      invalid();
    }

    const bytes = await handle.readFile();
    const finalHandleStats = await handle.stat({ bigint: true });
    validatePrivateFile(finalHandleStats);
    if (!sameIdentity(finalHandleStats, identity) ||
        finalHandleStats.size !== openedStats.size ||
        BigInt(bytes.byteLength) !== finalHandleStats.size) {
      invalid();
    }
    const digest = digestBytes(bytes);
    if (expected !== undefined && digest !== expected.digest) invalid();

    await handle.close();
    handle = undefined;
    const pathnameStats = await lstat(filePath, { bigint: true });
    validatePrivateFile(pathnameStats);
    if (!sameIdentity(pathnameStats, identity) ||
        pathnameStats.size !== finalHandleStats.size) {
      invalid();
    }
    return {
      bytes,
      record: {
        dev: identity.dev,
        ino: identity.ino,
        size: finalHandleStats.size,
        digest
      }
    };
  } catch {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {}
    }
    invalid();
  }
}

async function validateExactNames(directory, fileRecords) {
  const names = (await readdir(directory)).sort();
  const expected = [...fileRecords.keys()].sort();
  if (names.length !== expected.length ||
      names.some((name, index) => name !== expected[index])) {
    invalid();
  }
  return names;
}

async function revalidateDirectory(directory, identity) {
  const stats = await lstat(directory, { bigint: true });
  validatePrivateDirectory(stats);
  if (!sameIdentity(stats, identity)) invalid();
}

async function revalidateBundle(directory, bundle) {
  if (bundle === undefined || bundle.identity === undefined ||
      !(bundle.fileRecords instanceof Map)) {
    invalid();
  }
  await revalidateDirectory(directory, bundle.identity);
  const names = await validateExactNames(directory, bundle.fileRecords);
  for (const name of names) {
    await readVerifiedPrivateFile(
      path.join(directory, name),
      bundle.fileRecords.get(name),
      name === MANIFEST_NAME ? MAX_MANIFEST_BYTES : undefined
    );
  }
  await validateExactNames(directory, bundle.fileRecords);
  await revalidateDirectory(directory, bundle.identity);
}

async function validateExistingBundle(target, targetStats) {
  validatePrivateDirectory(targetStats);
  const identity = retainedIdentity(targetStats);
  const manifestPath = path.join(target, MANIFEST_NAME);
  const manifestFile = await readVerifiedPrivateFile(
    manifestPath,
    undefined,
    MAX_MANIFEST_BYTES
  );
  const source = manifestFile.bytes.toString("utf8");
  let parsed;
  try {
    parsed = parseStrictJson(source);
  } catch {
    invalid();
  }
  const manifest = exactManifest(parsed);
  if (source !== manifestBytes(manifest)) invalid();

  const fileRecords = new Map([[MANIFEST_NAME, manifestFile.record]]);
  const expectedNames = [...manifest.files, MANIFEST_NAME].sort();
  const names = (await readdir(target)).sort();
  if (names.length !== expectedNames.length ||
      names.some((name, index) => name !== expectedNames[index])) {
    invalid();
  }
  for (const name of manifest.files) {
    const file = await readVerifiedPrivateFile(path.join(target, name));
    fileRecords.set(name, file.record);
  }
  const bundle = { identity, fileRecords, manifest };
  await revalidateBundle(target, bundle);
  return bundle;
}

async function prepareTarget(destination, packageRoot, nextMode, replaceDemo) {
  if (typeof destination !== "string" || destination.length === 0 ||
      destination.includes("\u0000") || typeof packageRoot !== "string" ||
      packageRoot.length === 0 || packageRoot.includes("\u0000") ||
      typeof replaceDemo !== "boolean") {
    invalid();
  }
  const requestedTarget = path.resolve(destination);
  const requestedParent = path.dirname(requestedTarget);
  const basename = path.basename(requestedTarget);
  if (basename.length === 0 || basename === "." || basename === ".." ||
      !Number.isSafeInteger(process.pid) || process.pid <= 0) {
    invalid();
  }

  const requestedParentStats = await lstat(requestedParent, { bigint: true });
  if (requestedParentStats.isSymbolicLink()) invalid();
  validateParentDirectory(requestedParentStats);
  const parent = await realpath(requestedParent);
  if (!path.isAbsolute(parent)) invalid();
  const parentStats = await lstat(parent, { bigint: true });
  validateParentDirectory(parentStats);
  const parentIdentity = retainedIdentity(parentStats);
  const target = path.join(parent, basename);
  if (path.dirname(target) !== parent || path.basename(target) !== basename) {
    invalid();
  }

  const requestedPackageRoot = path.resolve(packageRoot);
  const packageStats = await lstat(requestedPackageRoot, { bigint: true });
  if (packageStats.isSymbolicLink() || !packageStats.isDirectory()) invalid();
  const canonicalPackageRoot = await realpath(requestedPackageRoot);
  const lexicalInside = isContained(requestedPackageRoot, requestedTarget);
  const physicalInside = isContained(canonicalPackageRoot, target);
  if (lexicalInside !== physicalInside) invalid();
  if (physicalInside) {
    const privateRoot = path.join(canonicalPackageRoot, "private-output");
    if (!isContained(privateRoot, target)) invalid();
  }

  const targetStats = await lstatOrAbsent(target);
  let existing = null;
  if (targetStats !== null) {
    if (targetStats.isSymbolicLink()) invalid();
    existing = await validateExistingBundle(target, targetStats);
    if ((existing.manifest.mode === "synthetic" || nextMode === "synthetic") &&
        !replaceDemo) {
      invalid();
    }
  }
  return {
    parent,
    parentIdentity,
    target,
    basename,
    existing
  };
}

async function revalidateParent(parent, identity) {
  const stats = await lstat(parent, { bigint: true });
  validateParentDirectory(stats);
  if (!sameIdentity(stats, identity)) invalid();
}

function randomSibling(parent, basename, kind) {
  const random = randomBytes(16).toString("hex");
  if (!/^[0-9a-f]{32}$/.test(random)) invalid();
  const name = `.${basename}.${kind}-${process.pid}-${random}`;
  const sibling = path.join(parent, name);
  if (path.dirname(sibling) !== parent || path.basename(sibling) !== name) invalid();
  return sibling;
}

async function writePrivateFile(filePath, source) {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT |
    fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
  const bytes = Buffer.from(source, "utf8");
  let handle;
  let identity;
  try {
    handle = await open(filePath, flags, 0o600);
    const created = await handle.stat({ bigint: true });
    validatePrivateFile(created);
    identity = retainedIdentity(created);
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const verified = await readVerifiedPrivateFile(filePath);
    if (!sameIdentity(verified.record, identity) ||
        verified.record.size !== BigInt(bytes.byteLength) ||
        verified.record.digest !== digestBytes(bytes)) {
      invalid();
    }
    return verified.record;
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {}
    }
    if (identity !== undefined) {
      try {
        const stats = await lstat(filePath, { bigint: true });
        validatePrivateFile(stats);
        if (sameIdentity(stats, identity)) await unlink(filePath);
      } catch {}
    }
    throw error;
  }
}

async function createStage(parent, basename, payloads, manifest, checkpoint) {
  const stage = randomSibling(parent, basename, "stage");
  let identity;
  let bundle;
  try {
    await mkdir(stage, { mode: 0o700 });
    const created = await lstat(stage, { bigint: true });
    validateOwnedDirectoryForNormalization(created);
    identity = retainedIdentity(created);
    await chmod(stage, 0o700);
    const normalized = await lstat(stage, { bigint: true });
    validatePrivateDirectory(normalized);
    if (!sameIdentity(normalized, identity)) invalid();
    bundle = {
      identity,
      fileRecords: new Map()
    };
    await checkpoint("stage-created");
    for (const [name, bytes] of payloads) {
      const record = await writePrivateFile(path.join(stage, name), bytes);
      bundle.fileRecords.set(name, record);
      await checkpoint(`after-stage-file:${name}`);
    }
    const manifestRecord = await writePrivateFile(
      path.join(stage, MANIFEST_NAME),
      manifestBytes(manifest)
    );
    bundle.fileRecords.set(MANIFEST_NAME, manifestRecord);
    await checkpoint(`after-stage-file:${MANIFEST_NAME}`);
    await revalidateBundle(stage, bundle);
    return { stage, bundle };
  } catch (error) {
    if (bundle === undefined) {
      await cleanupRetainedEmptyDirectory(stage, identity);
    } else {
      await cleanupOwnedDirectory(stage, bundle);
    }
    throw error;
  }
}

async function cleanupRetainedEmptyDirectory(directory, identity) {
  if (directory === undefined || identity === undefined) return false;
  try {
    const stats = await lstat(directory, { bigint: true });
    validateOwnedDirectoryForNormalization(stats);
    if (!sameIdentity(stats, identity)) return false;
    await rmdir(directory);
    return true;
  } catch {
    return false;
  }
}

async function cleanupOwnedDirectory(directory, bundle) {
  if (directory === undefined || bundle === undefined) return true;
  try {
    await revalidateBundle(directory, bundle);
    const names = [...bundle.fileRecords.keys()].sort();
    for (const name of names) {
      const filePath = path.join(directory, name);
      await readVerifiedPrivateFile(filePath, bundle.fileRecords.get(name));
      await unlink(filePath);
    }
    await revalidateDirectory(directory, bundle.identity);
    if ((await readdir(directory)).length !== 0) return false;
    await rmdir(directory);
    return true;
  } catch {
    return false;
  }
}

async function quarantineInstalledBundle(state) {
  let complete = true;
  try {
    await revalidateBundle(state.target, state.stageBundle);
  } catch {
    complete = false;
  }
  await revalidateParent(state.parent, state.parentIdentity);
  await revalidateDirectory(state.target, state.stageBundle.identity);
  if (await lstatOrAbsent(state.stage) !== null) invalid();
  await rename(state.target, state.stage);
  state.installed = false;
  if (complete) await revalidateBundle(state.stage, state.stageBundle);
}

async function restoreAfterFailure(state) {
  let restored = true;
  try {
    if (state.installed) await quarantineInstalledBundle(state);
    if (state.backedUp) {
      await revalidateParent(state.parent, state.parentIdentity);
      await revalidateBundle(state.backup, state.backupBundle);
      if (await lstatOrAbsent(state.target) !== null) invalid();
      await rename(state.backup, state.target);
      state.backedUp = false;
      await revalidateBundle(state.target, state.backupBundle);
    }
  } catch {
    restored = false;
  }
  const stageCleaned = await cleanupOwnedDirectory(
    state.stage,
    state.stageBundle
  );
  return restored && stageCleaned;
}

function payloadsForModel(model) {
  const payloads = new Map([
    ["report.html", renderHtml(model)],
    ["summary.json", renderJson(model)]
  ]);
  const csv = renderCsv(model);
  if (csv !== null) payloads.set("recent-unanswered.csv", csv);
  const manifest = {
    product: PRODUCT,
    schemaVersion: SCHEMA_VERSION,
    mode: model.mode,
    files: [...payloads.keys()]
  };
  return { payloads, manifest };
}

function createWriter(checkpoint, packageRoot) {
  return async function outputWriter(destination, model, options = {}) {
    let writerOptions;
    try {
      writerOptions = canonicalWriterOptions(options);
    } catch {
      throw new OutputError(UNSAFE_ERROR);
    }
    const { payloads, manifest } = payloadsForModel(model);
    let prepared;
    try {
      prepared = await prepareTarget(
        destination,
        packageRoot,
        model.mode,
        writerOptions.replaceDemo
      );
    } catch {
      throw new OutputError(UNSAFE_ERROR);
    }

    const state = {
      parent: prepared.parent,
      parentIdentity: prepared.parentIdentity,
      target: prepared.target,
      stage: undefined,
      stageBundle: undefined,
      backup: undefined,
      backupBundle: prepared.existing,
      backedUp: false,
      installed: false,
      committed: false
    };
    try {
      const staged = await createStage(
        state.parent,
        prepared.basename,
        payloads,
        manifest,
        checkpoint
      );
      state.stage = staged.stage;
      state.stageBundle = staged.bundle;
      await revalidateParent(state.parent, state.parentIdentity);

      if (prepared.existing !== null) {
        state.backup = randomSibling(state.parent, prepared.basename, "backup");
        if (await lstatOrAbsent(state.backup) !== null) invalid();
        await checkpoint("before-existing-to-backup");
        await revalidateParent(state.parent, state.parentIdentity);
        await revalidateBundle(state.target, state.backupBundle);
        await rename(state.target, state.backup);
        state.backedUp = true;
        await revalidateBundle(state.backup, state.backupBundle);
        await checkpoint("after-existing-to-backup");
        await revalidateBundle(state.backup, state.backupBundle);
      }

      await checkpoint("before-stage-to-destination");
      await revalidateParent(state.parent, state.parentIdentity);
      await revalidateBundle(state.stage, state.stageBundle);
      if (await lstatOrAbsent(state.target) !== null) invalid();
      await rename(state.stage, state.target);
      state.installed = true;
      await revalidateBundle(state.target, state.stageBundle);
      await checkpoint("after-stage-to-destination");
      await revalidateBundle(state.target, state.stageBundle);

      if (state.backedUp) {
        await checkpoint("before-backup-cleanup");
        await revalidateParent(state.parent, state.parentIdentity);
        await revalidateBundle(state.target, state.stageBundle);
        state.committed = true;
        if (!await cleanupOwnedDirectory(state.backup, state.backupBundle)) {
          invalid();
        }
        state.backedUp = false;
      }
      state.installed = false;
      return manifest;
    } catch {
      if (!state.committed) await restoreAfterFailure(state);
      throw new OutputError(WRITE_ERROR);
    }
  };
}

const productionWriter = createWriter(async () => {}, MODULE_PACKAGE_ROOT);

export async function writeOutputBundle(destination, model, options = {}) {
  return productionWriter(destination, model, options);
}

export function _createOutputWriterForTests(options) {
  const factory = canonicalTestFactoryOptions(options);
  return createWriter(
    async (name) => factory.checkpoint(name),
    factory.packageRoot
  );
}
