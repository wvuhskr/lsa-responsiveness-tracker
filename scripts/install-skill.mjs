#!/usr/bin/env node

import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink
} from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseStrictJson } from "../src/strict-json.js";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const SOURCE_SKILL = path.join(
  PACKAGE_ROOT,
  ".agents/skills/lsa-responsiveness-tracker"
);
const CLI_ENTRY = path.join(PACKAGE_ROOT, "bin/lsa-responsiveness.js");
const PACKAGE_JSON = path.join(PACKAGE_ROOT, "package.json");
const SKILL_NAME = "lsa-responsiveness-tracker";
const PRODUCT = "lsa-responsiveness-tracker";
const PAYLOADS = Object.freeze([
  "SKILL.md",
  "references/connector-contract.md",
  "references/runbook.md"
]);
const PROJECT_PLATFORMS = new Set([
  "agents", "codex", "cursor", "opencode", "gemini", "claude"
]);
const USER_PLATFORMS = new Set(["codex", "claude", "opencode"]);
const HASH_PATTERN = /^[a-f0-9]{64}$/;

class InstallerError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

function usageError() {
  throw new InstallerError("Invalid installer command or options.", 2);
}

function safetyError(message = "Skill installation could not be completed safely.") {
  throw new InstallerError(message, 5);
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length === 0) usageError();
  const [command, ...options] = argv;
  if (command !== "install" && command !== "uninstall") usageError();

  const parsed = {
    command,
    platform: undefined,
    scope: undefined,
    project: undefined,
    dryRun: false,
    forceRemoveModified: false
  };

  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (["--platform", "--scope", "--project"].includes(option)) {
      const key = option.slice(2).replace(/-([a-z])/g, (_, letter) =>
        letter.toUpperCase());
      const value = options[index + 1];
      if (parsed[key] !== undefined || typeof value !== "string" ||
          value.length === 0 || value.startsWith("--")) {
        usageError();
      }
      parsed[key] = value;
      index += 1;
      continue;
    }
    if (option === "--dry-run") {
      if (parsed.dryRun) usageError();
      parsed.dryRun = true;
      continue;
    }
    if (option === "--force-remove-modified") {
      if (parsed.forceRemoveModified || command !== "uninstall") usageError();
      parsed.forceRemoveModified = true;
      continue;
    }
    usageError();
  }

  if (parsed.platform === undefined || parsed.scope === undefined ||
      !["project", "user"].includes(parsed.scope)) {
    usageError();
  }
  if (parsed.scope === "project" && parsed.project === undefined) usageError();
  if (parsed.scope === "user" && parsed.project !== undefined) usageError();

  const supported = parsed.scope === "project"
    ? PROJECT_PLATFORMS.has(parsed.platform)
    : USER_PLATFORMS.has(parsed.platform);
  if (!supported) {
    throw new InstallerError(
      "Unsupported platform and scope combination.",
      2
    );
  }
  return parsed;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function identity(stats) {
  return `${stats.dev}:${stats.ino}`;
}

async function lstatOrAbsent(target) {
  try {
    return await lstat(target, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    safetyError();
  }
}

async function canonicalDirectory(target) {
  let canonical;
  let stats;
  try {
    canonical = await realpath(path.resolve(target));
    stats = await lstat(canonical, { bigint: true });
  } catch {
    usageError();
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) usageError();
  return { path: canonical, identity: identity(stats) };
}

function homeDirectory() {
  const value = process.env.HOME || process.env.USERPROFILE || os.homedir();
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    usageError();
  }
  return value;
}

function destinationSuffix(platform, scope) {
  if (scope === "project") {
    const prefix = platform === "claude" ? ".claude" : ".agents";
    return [prefix, "skills", SKILL_NAME];
  }
  if (platform === "codex") return [".codex", "skills", SKILL_NAME];
  if (platform === "claude") return [".claude", "skills", SKILL_NAME];
  return [".config", "opencode", "skills", SKILL_NAME];
}

async function resolveDestination(options) {
  const base = await canonicalDirectory(
    options.scope === "project" ? options.project : homeDirectory()
  );
  const suffix = destinationSuffix(options.platform, options.scope);
  return {
    base,
    suffix,
    destination: path.join(base.path, ...suffix),
    parent: path.join(base.path, ...suffix.slice(0, -1))
  };
}

async function validateExistingRoute(base, suffix) {
  let current = base.path;
  const baseStats = await lstatOrAbsent(current);
  if (baseStats === null || !baseStats.isDirectory() ||
      identity(baseStats) !== base.identity) {
    safetyError();
  }

  for (const component of suffix) {
    current = path.join(current, component);
    const stats = await lstatOrAbsent(current);
    if (stats === null) return;
    if (!stats.isDirectory() || stats.isSymbolicLink()) safetyError();
  }
}

async function validateDestinationAbsent(context) {
  await validateExistingRoute(context.base, context.suffix.slice(0, -1));
  const stats = await lstatOrAbsent(context.destination);
  if (stats !== null) {
    throw new InstallerError("Skill installation target is not empty.", 5);
  }
}

async function readRegularFileNoFollow(target) {
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n) safetyError();
    const content = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (identity(before) !== identity(after) || before.size !== after.size) {
      safetyError();
    }
    return { content, identity: identity(after) };
  } catch (error) {
    if (error instanceof InstallerError) throw error;
    safetyError();
  } finally {
    try {
      await handle?.close();
    } catch {
      // A sanitized validation error takes precedence over a close error.
    }
  }
}

async function loadSource() {
  const canonicalSource = await realpath(SOURCE_SKILL).catch(() => safetyError());
  if (canonicalSource !== SOURCE_SKILL) safetyError();
  const cli = await readRegularFileNoFollow(CLI_ENTRY);
  if (cli.content.length === 0) safetyError();

  let packageMetadata;
  try {
    packageMetadata = parseStrictJson(await readFile(PACKAGE_JSON, "utf8"));
  } catch {
    safetyError();
  }
  if (packageMetadata?.name !== PRODUCT ||
      typeof packageMetadata.version !== "string" ||
      packageMetadata.version.length === 0) {
    safetyError();
  }

  const payloads = [];
  for (const relative of PAYLOADS) {
    const source = path.join(SOURCE_SKILL, ...relative.split("/"));
    const file = await readRegularFileNoFollow(source);
    payloads.push({
      path: relative,
      content: file.content,
      sha256: sha256(file.content)
    });
  }
  return {
    version: packageMetadata.version,
    payloads
  };
}

async function preflightInstall(options) {
  const [context, source] = await Promise.all([
    resolveDestination(options),
    loadSource()
  ]);
  await validateDestinationAbsent(context);
  return { context, source };
}

async function writeExclusive(target, content, mode) {
  let handle;
  try {
    handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
        constants.O_NOFOLLOW,
      mode
    );
    await handle.writeFile(content);
    await handle.chmod(mode);
    await handle.sync();
  } catch (error) {
    if (error instanceof InstallerError) throw error;
    safetyError();
  } finally {
    try {
      await handle?.close();
    } catch {
      // The installation will be rejected during verification if needed.
    }
  }
}

async function verifyFile(target, expectedHash) {
  const file = await readRegularFileNoFollow(target);
  if (sha256(file.content) !== expectedHash) safetyError();
}

async function removeKnownStage(stage) {
  if (typeof stage !== "string") return;
  for (const relative of [...PAYLOADS, "installation.json"].reverse()) {
    const target = path.join(stage, ...relative.split("/"));
    try {
      const stats = await lstat(target);
      if (stats.isFile() || stats.isSymbolicLink()) await unlink(target);
    } catch {
      // Best effort only; never recursively remove an unexpected object.
    }
  }
  try {
    await rmdir(path.join(stage, "references"));
  } catch {
    // Preserve unexpected or nonempty residue.
  }
  try {
    await rmdir(stage);
  } catch {
    // Preserve unexpected or nonempty residue.
  }
}

async function install(preflight) {
  const { context, source } = preflight;
  let stage;
  try {
    await validateDestinationAbsent(context);
    await mkdir(context.parent, { recursive: true, mode: 0o755 });
    await validateExistingRoute(context.base, context.suffix.slice(0, -1));
    const canonicalParent = await realpath(context.parent);
    if (canonicalParent !== context.parent) safetyError();

    stage = await mkdtemp(path.join(
      context.parent,
      `.${SKILL_NAME}.install-`
    ));
    await chmod(stage, 0o700);
    await mkdir(path.join(stage, "references"), { mode: 0o755 });
    await chmod(path.join(stage, "references"), 0o755);

    for (const payload of source.payloads) {
      const target = path.join(stage, ...payload.path.split("/"));
      await writeExclusive(target, payload.content, 0o644);
      await verifyFile(target, payload.sha256);
    }

    const receipt = {
      schemaVersion: 1,
      product: PRODUCT,
      version: source.version,
      cliEntry: CLI_ENTRY,
      sourceSkill: SOURCE_SKILL,
      files: source.payloads.map(({ path: relative, sha256: digest }) => ({
        path: relative,
        sha256: digest
      }))
    };
    await writeExclusive(
      path.join(stage, "installation.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
      0o600
    );

    for (const payload of source.payloads) {
      await verifyFile(
        path.join(stage, ...payload.path.split("/")),
        payload.sha256
      );
    }
    await validateDestinationAbsent(context);
    await rename(stage, context.destination);
    stage = undefined;
  } catch (error) {
    await removeKnownStage(stage);
    if (error instanceof InstallerError) throw error;
    safetyError();
  }
}

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function validateReceipt(receipt) {
  const keys = [
    "schemaVersion", "product", "version", "cliEntry", "sourceSkill", "files"
  ];
  if (!exactKeys(receipt, keys) || receipt.schemaVersion !== 1 ||
      receipt.product !== PRODUCT || typeof receipt.version !== "string" ||
      receipt.version.length === 0 || !path.isAbsolute(receipt.cliEntry) ||
      !path.isAbsolute(receipt.sourceSkill) || !Array.isArray(receipt.files) ||
      receipt.files.length !== PAYLOADS.length) {
    safetyError("Installed skill receipt is invalid.");
  }

  for (let index = 0; index < PAYLOADS.length; index += 1) {
    const record = receipt.files[index];
    if (!exactKeys(record, ["path", "sha256"]) ||
        record.path !== PAYLOADS[index] ||
        !HASH_PATTERN.test(record.sha256)) {
      safetyError("Installed skill receipt is invalid.");
    }
  }
  return receipt;
}

async function loadReceipt(context) {
  const destinationStats = await lstatOrAbsent(context.destination);
  if (destinationStats === null || !destinationStats.isDirectory() ||
      destinationStats.isSymbolicLink()) {
    safetyError("Installed skill receipt is unavailable.");
  }

  const receiptPath = path.join(context.destination, "installation.json");
  const receiptFile = await readRegularFileNoFollow(receiptPath);
  let receipt;
  try {
    receipt = validateReceipt(parseStrictJson(receiptFile.content.toString("utf8")));
  } catch (error) {
    if (error instanceof InstallerError) throw error;
    safetyError("Installed skill receipt is invalid.");
  }
  return {
    receipt,
    destinationIdentity: identity(destinationStats),
    receiptIdentity: receiptFile.identity
  };
}

async function classifyPayloads(context, receipt) {
  const records = [];
  let modified = false;
  for (const record of receipt.files) {
    const target = path.join(context.destination, ...record.path.split("/"));
    const stats = await lstatOrAbsent(target);
    if (stats === null || !stats.isFile() || stats.isSymbolicLink() ||
        stats.nlink !== 1n) {
      modified = true;
      records.push({ ...record, target, identity: null });
      continue;
    }
    const file = await readRegularFileNoFollow(target);
    const matches = sha256(file.content) === record.sha256;
    if (!matches) modified = true;
    records.push({ ...record, target, identity: file.identity });
  }
  return { records, modified };
}

async function preflightUninstall(options) {
  const context = await resolveDestination(options);
  await validateExistingRoute(context.base, context.suffix.slice(0, -1));
  const loaded = await loadReceipt(context);
  const classified = await classifyPayloads(context, loaded.receipt);
  if (classified.modified && !options.forceRemoveModified) {
    throw new InstallerError(
      "Installed skill files were modified; removal refused.",
      5
    );
  }
  return { context, ...loaded, ...classified };
}

async function revalidateDestination(preflight) {
  const stats = await lstatOrAbsent(preflight.context.destination);
  if (stats === null || !stats.isDirectory() || stats.isSymbolicLink() ||
      identity(stats) !== preflight.destinationIdentity) {
    safetyError("Installed skill changed during removal.");
  }
}

async function unlinkRecorded(target, expectedIdentity, expectedHash, force) {
  const stats = await lstatOrAbsent(target);
  if (stats === null) {
    if (force) return;
    safetyError("Installed skill changed during removal.");
  }
  if (stats.isDirectory()) safetyError("Installed skill changed during removal.");
  if (!force && (!stats.isFile() || stats.isSymbolicLink() ||
      identity(stats) !== expectedIdentity)) {
    safetyError("Installed skill changed during removal.");
  }
  if (!force) {
    const file = await readRegularFileNoFollow(target);
    if (file.identity !== expectedIdentity ||
        (expectedHash !== null && sha256(file.content) !== expectedHash)) {
      safetyError("Installed skill changed during removal.");
    }
  }
  try {
    await unlink(target);
  } catch {
    safetyError("Installed skill could not be removed safely.");
  }
}

async function uninstall(preflight, force) {
  await revalidateDestination(preflight);
  for (const record of preflight.records) {
    await revalidateDestination(preflight);
    await unlinkRecorded(record.target, record.identity, record.sha256, force);
  }

  await revalidateDestination(preflight);
  const receiptPath = path.join(preflight.context.destination, "installation.json");
  await unlinkRecorded(receiptPath, preflight.receiptIdentity, null, false);

  try {
    await rmdir(path.join(preflight.context.destination, "references"));
  } catch (error) {
    if (error?.code !== "ENOTEMPTY" && error?.code !== "ENOENT") {
      safetyError("Installed skill could not be removed safely.");
    }
  }
  try {
    await rmdir(preflight.context.destination);
  } catch (error) {
    if (error?.code !== "ENOTEMPTY") {
      safetyError("Installed skill could not be removed safely.");
    }
  }
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.command === "install") {
    const preflight = await preflightInstall(options);
    if (options.dryRun) {
      process.stdout.write("Skill installation preflight passed; no files written.\n");
      return;
    }
    await install(preflight);
    process.stdout.write("Skill installed.\n");
    return;
  }

  const preflight = await preflightUninstall(options);
  if (options.dryRun) {
    process.stdout.write("Skill removal preflight passed; no files removed.\n");
    return;
  }
  await uninstall(preflight, options.forceRemoveModified);
  process.stdout.write("Skill uninstalled.\n");
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof InstallerError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode;
  } else {
    process.stderr.write("Skill installer failed unexpectedly.\n");
    process.exitCode = 1;
  }
}
