import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  rmdir
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.js";
import {
  AppError,
  CapabilityError,
  DataIntegrityError,
  OutputError,
  UsageError
} from "./errors.js";
import { readHistory, upsertHistory } from "./history.js";
import { ingestAccount } from "./ingest.js";
import { computeAccountMetrics } from "./metrics.js";
import { probePayload } from "./probe.js";
import { buildReportModel } from "./report-model.js";
import { writeReportTransaction } from "./report-transaction.js";
import { parseStrictJson } from "./strict-json.js";
import { parseTimestamp, windowStartFor } from "./timestamps.js";
import { writeOutputBundle } from "./write-output.js";

const USAGE = [
  "Usage: lsa-responsiveness <command> [options]",
  "Commands:",
  "  demo --output-dir PATH [--replace-demo]",
  "  probe --input PATH [--input PATH ...] [--format auto|columns-data|google-ads-results]",
  "  report --config PATH --output-dir PATH"
].join("\n");
const FORMATS = new Set(["auto", "columns-data", "google-ads-results"]);
const EXAMPLE_RESPONSE = fileURLToPath(
  new URL("../examples/synthetic-connector-response.json", import.meta.url)
);
const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const DEMO_ACCOUNT = Object.freeze({
  key: "example-heating",
  name: "Example Heating",
  customerId: "1000000001",
  timeZone: "America/New_York"
});
const DEMO_AS_OF = "2026-01-31T12:00:00-05:00";
const DEMO_GENERATED_AT = "2026-01-31T12:05:00-05:00";
const DEMO_WINDOW_DAYS = 30;
const REQUIRED_CAPABILITY_FIELDS = Object.freeze([
  "leadId",
  "leadType",
  "participantType",
  "conversationChannel",
  "callDurationMillis",
  "eventDateTime"
]);

function usage() {
  throw new UsageError(USAGE);
}

function optionValue(argv, index) {
  const value = argv[index + 1];
  if (typeof value !== "string" || value.length === 0 ||
      value.startsWith("--")) {
    usage();
  }
  return value;
}

function parseDemo(argv) {
  let outputDir;
  let replaceDemo = false;
  let sawReplaceDemo = false;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--output-dir") {
      if (outputDir !== undefined) usage();
      outputDir = optionValue(argv, index);
      index += 1;
    } else if (option === "--replace-demo") {
      if (sawReplaceDemo) usage();
      sawReplaceDemo = true;
      replaceDemo = true;
    } else {
      usage();
    }
  }
  if (outputDir === undefined) usage();
  return { outputDir, replaceDemo };
}

function parseProbe(argv) {
  const inputs = [];
  let format = "auto";
  let sawFormat = false;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--input") {
      inputs.push(optionValue(argv, index));
      index += 1;
    } else if (option === "--format") {
      if (sawFormat) usage();
      sawFormat = true;
      format = optionValue(argv, index);
      index += 1;
      if (!FORMATS.has(format)) usage();
    } else {
      usage();
    }
  }
  if (inputs.length === 0) usage();
  return { inputs, format };
}

function parseReport(argv) {
  let configPath;
  let outputDir;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--config") {
      if (configPath !== undefined) usage();
      configPath = optionValue(argv, index);
      index += 1;
    } else if (option === "--output-dir") {
      if (outputDir !== undefined) usage();
      outputDir = optionValue(argv, index);
      index += 1;
    } else {
      usage();
    }
  }
  if (configPath === undefined || outputDir === undefined) usage();
  return { configPath, outputDir };
}

function parseCommand(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) {
    usage();
  }
  const [command, ...options] = argv;
  if (command === "demo") return { command, options: parseDemo(options) };
  if (command === "probe") return { command, options: parseProbe(options) };
  if (command === "report") return { command, options: parseReport(options) };
  usage();
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasConnectorFailureEvidence(payload) {
  const candidates = [payload];
  if (isRecord(payload?.result)) candidates.push(payload.result);
  return candidates.some((candidate) => isRecord(candidate) && (
    Object.hasOwn(candidate, "error") ||
    Object.hasOwn(candidate, "errors") ||
    candidate.truncated === true ||
    candidate.isTruncated === true ||
    candidate.isError === true ||
    candidate.partial === true
  ));
}

function hasUnresolvedContinuation(payload) {
  const candidates = [payload];
  if (isRecord(payload?.result)) candidates.push(payload.result);
  return candidates.some((candidate) => {
    if (!isRecord(candidate)) return false;
    for (const name of ["nextPageToken", "next_page_token"]) {
      if (Object.hasOwn(candidate, name) && candidate[name] !== null &&
          candidate[name] !== "") {
        return true;
      }
    }
    return false;
  });
}

function validateProbeRows(payload, envelope) {
  if (envelope !== "columns-data") return;
  const container = isRecord(payload?.result) ? payload.result : payload;
  if (!Array.isArray(container.columns) || !Array.isArray(container.data)) {
    throw new DataIntegrityError("Probe input is malformed.");
  }
  for (const row of container.data) {
    if (!Array.isArray(row) || row.length !== container.columns.length) {
      throw new DataIntegrityError("Probe input is malformed.");
    }
  }
}

async function readProbePayload(inputPath) {
  let source;
  try {
    source = await readFile(inputPath, "utf8");
  } catch {
    throw new UsageError("Probe input could not be read.\n" + USAGE);
  }
  let payload;
  try {
    payload = parseStrictJson(source);
  } catch {
    throw new DataIntegrityError("Probe input is malformed or truncated.");
  }
  if (!isRecord(payload) || hasConnectorFailureEvidence(payload)) {
    throw new DataIntegrityError("Probe input contains connector-error or truncation evidence.");
  }
  if (hasUnresolvedContinuation(payload)) {
    throw new DataIntegrityError("Probe input has an unresolved continuation page.");
  }
  return payload;
}

function capabilityTable(capabilities) {
  const headings = [
    "Input",
    "Supported",
    "Envelope",
    "Lead ID",
    "Lead type",
    "Participant",
    "Channel",
    "Call duration",
    "Timestamp",
    "Message text"
  ];
  const lines = [headings.join(" | ")];
  for (let index = 0; index < capabilities.length; index += 1) {
    const capability = capabilities[index];
    const available = (name) => capability.requiredFields[name] ? "Yes" : "No";
    lines.push([
      `Input ${index + 1}`,
      "Yes",
      capability.envelope,
      available("leadId"),
      available("leadType"),
      available("participantType"),
      available("conversationChannel"),
      available("callDurationMillis"),
      available("eventDateTime"),
      available("messageText")
    ].join(" | "));
  }
  return lines.join("\n");
}

async function runProbe(options, io) {
  const capabilities = [];
  for (const inputPath of options.inputs) {
    const payload = await readProbePayload(inputPath);
    let capability;
    try {
      capability = probePayload(payload);
    } catch (error) {
      if (error instanceof CapabilityError) {
        throw new CapabilityError("Probe input does not provide the required fields or supported capability.");
      }
      throw error;
    }
    if (options.format !== "auto" && capability.envelope !== options.format) {
      throw new CapabilityError("Probe input does not match the selected format.");
    }
    validateProbeRows(payload, capability.envelope);
    capabilities.push(capability);
  }
  io.out(capabilityTable(capabilities));
}

function capabilityFromIngestion(capability) {
  const requiredFields = Object.fromEntries(
    REQUIRED_CAPABILITY_FIELDS.map((field) => [field, true])
  );
  requiredFields.messageText = capability.messageTextAvailable;
  const pagination = capability.completionMethod === "all-page-tokens-consumed"
    ? "paginated"
    : capability.completionMethod === "single-page-no-continuation"
      ? "single-page"
      : "not-declared";
  return {
    capability: {
      supported: true,
      envelope: capability.envelope,
      requiredFields,
      rowContainerPresent: true,
      pagination
    },
    completion: {
      method: capability.completionMethod,
      pageCount: capability.pageCount
    }
  };
}

function fixedDiagnostics(diagnostics) {
  let bookingLeads = 0;
  let unsupportedLeadTypes = 0;
  for (const [leadType, count] of Object.entries(diagnostics.excludedLeadTypes)) {
    if (leadType === "BOOKING") {
      bookingLeads = count;
    } else {
      unsupportedLeadTypes += count;
      if (!Number.isSafeInteger(unsupportedLeadTypes)) {
        throw new DataIntegrityError("Report diagnostics are invalid.");
      }
    }
  }
  return {
    incompleteWindowLeads: diagnostics.incompleteWindowLeads,
    bookingLeads,
    unsupportedLeadTypes
  };
}

function historyPoint(metrics, config) {
  return {
    accountKey: metrics.account.key,
    accountName: metrics.account.name,
    asOf: config.asOf,
    windowDays: config.windowDays,
    metricVersion: metrics.metricVersion,
    ...metrics.counts,
    ...metrics.rates,
    medianReplyNanoseconds: metrics.replySpeed.medianNanoseconds,
    replySpeedBuckets: metrics.replySpeed.buckets,
    diagnostics: fixedDiagnostics(metrics.diagnostics)
  };
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function pathsOverlap(left, right) {
  return isContained(left, right) || isContained(right, left);
}

function validateOwner(stats) {
  return typeof process.getuid !== "function" ||
    stats.uid === BigInt(process.getuid());
}

function validOwnedDirectoryForNormalization(stats) {
  return stats.isDirectory() && typeof stats.mode === "bigint" &&
    typeof stats.dev === "bigint" && typeof stats.ino === "bigint" &&
    validateOwner(stats);
}

function validPrivateDirectory(stats) {
  return validOwnedDirectoryForNormalization(stats) &&
    (stats.mode & 0o777n) === 0o700n;
}

function validParentDirectory(stats) {
  return stats.isDirectory() && typeof stats.mode === "bigint" &&
    (stats.mode & 0o022n) === 0n && validateOwner(stats);
}

function sameDirectoryIdentity(stats, identity) {
  return identity !== null && identity !== undefined &&
    typeof stats.dev === "bigint" && typeof stats.ino === "bigint" &&
    stats.dev === identity.dev && stats.ino === identity.ino;
}

async function cleanupRetainedEmptyDirectory(directory, identity) {
  if (identity === null || identity === undefined) return;
  try {
    const stats = await lstat(directory, { bigint: true });
    if (stats.isSymbolicLink() ||
        !validOwnedDirectoryForNormalization(stats) ||
        !sameDirectoryIdentity(stats, identity)) {
      return;
    }
    await rmdir(directory);
  } catch {
    // A mismatch, substitution, or nonempty directory must remain untouched.
  }
}

async function normalizeCreatedPrivateDirectory(directory, errorMessage) {
  let identity;
  try {
    const created = await lstat(directory, { bigint: true });
    if (created.isSymbolicLink() ||
        !validOwnedDirectoryForNormalization(created)) {
      throw new Error("unsafe");
    }
    identity = { dev: created.dev, ino: created.ino };
    await chmod(directory, 0o700);
    const normalized = await lstat(directory, { bigint: true });
    if (normalized.isSymbolicLink() || !validPrivateDirectory(normalized) ||
        !sameDirectoryIdentity(normalized, identity)) {
      throw new Error("unsafe");
    }
    return { identity, stats: normalized };
  } catch {
    await cleanupRetainedEmptyDirectory(directory, identity);
    throw new OutputError(errorMessage);
  }
}

async function ensurePrivateOutputContainer(requested) {
  if (typeof requested !== "string" || requested.length === 0 ||
      requested.includes("\u0000")) {
    throw new UsageError("Output container is unsafe.");
  }
  const absolute = path.resolve(requested);
  const parent = path.dirname(absolute);
  const basename = path.basename(absolute);
  if (basename.length === 0 || basename === "." || basename === "..") {
    throw new UsageError("Output container is unsafe.");
  }
  let parentStats;
  try {
    parentStats = await lstat(parent, { bigint: true });
  } catch {
    throw new UsageError("Output container parent is unsafe.");
  }
  if (parentStats.isSymbolicLink() || !validParentDirectory(parentStats)) {
    throw new UsageError("Output container parent is unsafe.");
  }
  const canonicalParent = await realpath(parent);
  const canonicalPackageRoot = await realpath(PACKAGE_ROOT);
  const physicalTarget = path.join(canonicalParent, basename);
  const lexicalInsidePackage = isContained(PACKAGE_ROOT, absolute);
  const physicalInsidePackage = isContained(canonicalPackageRoot, physicalTarget);
  if (lexicalInsidePackage !== physicalInsidePackage ||
      (physicalInsidePackage && !isContained(
        path.join(canonicalPackageRoot, "private-output"),
        physicalTarget
      ))) {
    throw new UsageError("Output container is outside the private-output boundary.");
  }
  let current;
  let created = false;
  try {
    current = await lstat(absolute, { bigint: true });
  } catch (error) {
    if (error === null || typeof error !== "object" || error.code !== "ENOENT") {
      throw new UsageError("Output container is unsafe.");
    }
  }
  let createdIdentity = null;
  if (current === undefined) {
    try {
      await mkdir(absolute, { mode: 0o700 });
    } catch {
      throw new OutputError("Output container could not be created.");
    }
    const normalized = await normalizeCreatedPrivateDirectory(
      absolute,
      "Output container could not be created."
    );
    current = normalized.stats;
    createdIdentity = normalized.identity;
    created = true;
  }
  if (current.isSymbolicLink() || !validPrivateDirectory(current)) {
    if (created) {
      await cleanupRetainedEmptyDirectory(absolute, createdIdentity);
      throw new OutputError("Output container could not be created.");
    }
    throw new UsageError("Output container is unsafe.");
  }
  let canonical;
  let canonicalStats;
  try {
    canonical = await realpath(absolute);
    canonicalStats = await lstat(canonical, { bigint: true });
  } catch {
    if (created) {
      await cleanupRetainedEmptyDirectory(absolute, createdIdentity);
      throw new OutputError("Output container could not be created.");
    }
    throw new UsageError("Output container is unsafe.");
  }
  if (!validPrivateDirectory(canonicalStats) ||
      canonicalStats.dev !== current.dev || canonicalStats.ino !== current.ino ||
      (created && !sameDirectoryIdentity(canonicalStats, createdIdentity))) {
    if (created) {
      await cleanupRetainedEmptyDirectory(absolute, createdIdentity);
      throw new OutputError("Output container could not be created.");
    }
    throw new UsageError("Output container is unsafe.");
  }
  return {
    path: canonical,
    createdIdentity: created ? createdIdentity : null
  };
}

async function cleanupCreatedOutputContainer(directory, identity) {
  if (identity === null) return;
  try {
    let stats = await lstat(directory, { bigint: true });
    if (stats.isSymbolicLink() || !validPrivateDirectory(stats) ||
        !sameDirectoryIdentity(stats, identity)) {
      return;
    }
    stats = await lstat(directory, { bigint: true });
    if (stats.isSymbolicLink() || !validPrivateDirectory(stats) ||
        !sameDirectoryIdentity(stats, identity)) {
      return;
    }
    await rmdir(directory);
  } catch {
    // Cleanup is best-effort and must never replace the original fixed error.
  }
}

async function calculateAccount(account, config) {
  const ingested = await ingestAccount(account, {
    asOf: config.asOf,
    includeMessageText: config.privacy.includeMessageText,
    disambiguation: config.timestamps.dstDisambiguation
  });
  const asOfNs = parseTimestamp(config.asOf).epochNanoseconds;
  const windowStartNs = windowStartFor(
    config.asOf,
    account.timeZone,
    config.windowDays,
    config.timestamps.dstDisambiguation
  );
  const metrics = computeAccountMetrics({
    account: { key: account.key, name: account.name },
    events: ingested.events,
    asOfNs,
    windowStartNs
  });
  return {
    account,
    metrics,
    ...capabilityFromIngestion(ingested.capability)
  };
}

async function runReport(options, io, transactionWriter = writeReportTransaction) {
  const requestedOutput = path.resolve(options.outputDir);
  const config = await loadConfig(options.configPath, requestedOutput);
  const reportDestination = path.join(requestedOutput, "report");
  if (config.history.enabled &&
      pathsOverlap(reportDestination, config.history.path)) {
    throw new UsageError("History must be outside the report bundle.");
  }

  const calculated = [];
  for (const account of config.accounts) {
    calculated.push(await calculateAccount(account, config));
  }

  const previousHistory = config.history.enabled
    ? await readHistory(config.history.path)
    : { schemaVersion: 1, points: [] };
  let nextHistory = previousHistory;
  if (config.history.enabled) {
    for (const result of calculated) {
      nextHistory = upsertHistory(nextHistory, historyPoint(result.metrics, config));
    }
  }

  const reportModel = buildReportModel({
    mode: "private",
    generatedAt: new Date().toISOString(),
    asOf: config.asOf,
    windowDays: config.windowDays,
    privacy: config.privacy,
    output: config.output,
    accounts: calculated.map((result) => ({
      metrics: result.metrics,
      timeZone: result.account.timeZone,
      capability: result.capability,
      completion: result.completion
    })),
    historyPoints: config.history.enabled ? nextHistory.points : []
  });

  const outputContainer = await ensurePrivateOutputContainer(requestedOutput);
  const canonicalReportDestination = path.join(outputContainer.path, "report");
  try {
    if (config.history.enabled &&
        pathsOverlap(canonicalReportDestination, config.history.path)) {
      throw new UsageError("History must be outside the report bundle.");
    }

    await transactionWriter({
      reportDestination: canonicalReportDestination,
      reportModel,
      history: config.history.enabled ? {
        path: config.history.path,
        previous: previousHistory,
        next: nextHistory
      } : null
    });
  } catch (error) {
    await cleanupCreatedOutputContainer(
      outputContainer.path,
      outputContainer.createdIdentity
    );
    throw error;
  }
  io.out("Private report written.");
}

function validOwnedDemoFile(stats, requireExactMode) {
  return stats.isFile() && typeof stats.mode === "bigint" &&
    typeof stats.dev === "bigint" && typeof stats.ino === "bigint" &&
    typeof stats.size === "bigint" && typeof stats.nlink === "bigint" &&
    stats.nlink === 1n && validateOwner(stats) &&
    (!requireExactMode || (stats.mode & 0o777n) === 0o600n);
}

function sameFileIdentity(stats, identity) {
  return identity !== undefined && typeof stats.dev === "bigint" &&
    typeof stats.ino === "bigint" && stats.dev === identity.dev &&
    stats.ino === identity.ino;
}

async function writePrivateDemoFile(filePath, source) {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT |
    fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
  const bytes = Buffer.from(source, "utf8");
  let handle;
  let identity;
  try {
    handle = await open(filePath, flags, 0o600);
    const created = await handle.stat({ bigint: true });
    if (!validOwnedDemoFile(created, false)) throw new Error("unsafe");
    identity = { dev: created.dev, ino: created.ino };
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
    const normalized = await handle.stat({ bigint: true });
    if (!validOwnedDemoFile(normalized, true) ||
        !sameFileIdentity(normalized, identity) ||
        normalized.size !== BigInt(bytes.byteLength)) {
      throw new Error("unsafe");
    }
    await handle.close();
    handle = undefined;
    const pathStats = await lstat(filePath, { bigint: true });
    if (pathStats.isSymbolicLink() || !validOwnedDemoFile(pathStats, true) ||
        !sameFileIdentity(pathStats, identity) ||
        pathStats.size !== BigInt(bytes.byteLength)) {
      throw new Error("unsafe");
    }
  } catch {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {}
    }
    throw new OutputError("Synthetic demo input could not be created.");
  }
}

async function cleanupDemoWorkspace(directory, identity) {
  try {
    const parent = await realpath(path.dirname(directory));
    const temporaryParent = await realpath(os.tmpdir());
    const stats = await lstat(directory, { bigint: true });
    if (parent !== temporaryParent ||
        !path.basename(directory).startsWith("lsa-responsiveness-demo-") ||
        !validPrivateDirectory(stats) || stats.dev !== identity.dev ||
        stats.ino !== identity.ino) {
      throw new Error("unsafe");
    }
    await rm(directory, { recursive: true, force: false });
  } catch {
    throw new OutputError("Synthetic demo workspace could not be cleaned.");
  }
}

async function runDemo(options, io) {
  let workspace;
  let identity;
  let failure;
  try {
    workspace = await mkdtemp(
      path.join(os.tmpdir(), "lsa-responsiveness-demo-")
    );
    const normalizedWorkspace = await normalizeCreatedPrivateDirectory(
      workspace,
      "Synthetic demo workspace is unsafe."
    );
    identity = normalizedWorkspace.identity;
    const pagePath = path.join(workspace, "synthetic-response.json");
    const manifestPath = path.join(workspace, "manifest.json");
    const source = await readFile(EXAMPLE_RESPONSE, "utf8");
    await writePrivateDemoFile(pagePath, source);
    await writePrivateDemoFile(manifestPath, `${JSON.stringify({
      schemaVersion: 1,
      format: "columns-data",
      completion: {
        method: "connector-complete-saved-result",
        savedResultWasComplete: true
      },
      pages: [{ path: "synthetic-response.json" }]
    }, null, 2)}\n`);

    const account = { ...DEMO_ACCOUNT, inputManifest: manifestPath };
    const config = {
      asOf: DEMO_AS_OF,
      windowDays: DEMO_WINDOW_DAYS,
      privacy: {
        includeLeadIds: true,
        includeMessageText: false,
        messageSnippetCharacters: 120
      },
      output: { writeActionCsv: false },
      timestamps: { dstDisambiguation: "reject" }
    };
    const calculated = await calculateAccount(account, config);
    const reportModel = buildReportModel({
      mode: "synthetic",
      generatedAt: DEMO_GENERATED_AT,
      asOf: DEMO_AS_OF,
      windowDays: DEMO_WINDOW_DAYS,
      privacy: config.privacy,
      output: config.output,
      accounts: [{
        metrics: calculated.metrics,
        timeZone: account.timeZone,
        capability: calculated.capability,
        completion: calculated.completion
      }],
      historyPoints: []
    });
    await writeOutputBundle(options.outputDir, reportModel, {
      replaceDemo: options.replaceDemo
    });
  } catch (error) {
    failure = error;
  }
  if (workspace !== undefined && identity !== undefined) {
    try {
      await cleanupDemoWorkspace(workspace, identity);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
  io.out("Synthetic demo report written.");
}

const productionHandlers = Object.freeze({
  demo: runDemo,
  probe: runProbe,
  report: runReport
});

function debugFrames(error) {
  if (!(error instanceof Error) || typeof error.stack !== "string") {
    return "Debug stack unavailable.";
  }
  const frames = error.stack.split("\n").slice(1)
    .filter((line) => /^\s*at\s/.test(line))
    .slice(0, 20);
  return frames.length === 0 ? "Debug stack unavailable." : frames.join("\n");
}

function createMain(handlers, debugEnabled) {
  return async function commandMain(argv, io = {
    out: console.log,
    err: console.error
  }) {
    try {
      const parsed = parseCommand(argv);
      await handlers[parsed.command](parsed.options, io);
      return 0;
    } catch (error) {
      if (error instanceof AppError) {
        io.err(error.message);
        return error.exitCode;
      }
      io.err("Unexpected internal failure.");
      if (debugEnabled()) io.err(debugFrames(error));
      return 1;
    }
  };
}

const productionMain = createMain(
  productionHandlers,
  () => process.env.LSA_RESPONSIVENESS_DEBUG === "1"
);

export async function main(argv, io) {
  return productionMain(argv, io);
}

export function _createReportHandlerForTests(options) {
  const descriptor = isRecord(options)
    ? Object.getOwnPropertyDescriptor(options, "writeReportTransaction")
    : undefined;
  if (!isRecord(options) || Object.getPrototypeOf(options) !== Object.prototype ||
      Object.getOwnPropertyNames(options).length !== 1 ||
      Object.getOwnPropertySymbols(options).length !== 0 ||
      descriptor === undefined || !Object.hasOwn(descriptor, "value") ||
      descriptor.enumerable !== true ||
      typeof descriptor.value !== "function") {
    throw new TypeError("Report handler test options are invalid.");
  }
  return (commandOptions, io) => runReport(
    commandOptions,
    io,
    descriptor.value
  );
}

export function _createMainForTests(options) {
  if (!isRecord(options) || Object.keys(options).length !== 2 ||
      !Object.hasOwn(options, "handlers") ||
      !Object.hasOwn(options, "debugEnabled") ||
      typeof options.debugEnabled !== "boolean" ||
      !isRecord(options.handlers) ||
      Object.keys(options.handlers).length !== 3 ||
      !["demo", "probe", "report"].every((name) =>
        typeof options.handlers[name] === "function")) {
    throw new TypeError("CLI test options are invalid.");
  }
  return createMain(options.handlers, () => options.debugEnabled);
}
