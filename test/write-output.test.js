import assert from "node:assert/strict";
import fsPromises, {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { OutputError } from "../src/errors.js";
import { buildReportModel } from "../src/report-model.js";
import {
  _createOutputWriterForTests,
  writeOutputBundle
} from "../src/write-output.js";
import { runOutputWriterWithRestrictiveUmask } from "./helpers/run-cli.js";

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

function metrics(name = "Synthetic Example Heating") {
  return {
    metricVersion: "lsa-responsiveness/v1",
    account: { key: "example-heating", name },
    counts: {
      repliedMessages: 1,
      recentUnansweredMessages: 1,
      oldUnansweredMessages: 0,
      eligibleMessages: 2,
      eligiblePhoneCalls: 1,
      connectedCalls: 1,
      totalEligible: 3,
      totalResponded: 2
    },
    rates: {
      totalResponsiveness: 2 / 3,
      callsConnected: 1,
      messagesReplied: 0.5,
      repliedWithin24Hours: 0.5
    },
    replySpeed: {
      medianNanoseconds: "60000000000",
      buckets: { within5m: 1, within1h: 0, within24h: 0, over24h: 0 }
    },
    diagnostics: {
      incompleteWindowLeads: 0,
      excludedLeadTypes: { BOOKING: 1, SYNTHETIC_OTHER: 2 }
    },
    recentUnanswered: [{
      leadId: "900000000001",
      firstContactEpochNanoseconds: "1769888400000000000",
      messageText: "SYNTHETIC ACTION"
    }]
  };
}

function model({
  mode = "private",
  name,
  writeActionCsv = false,
  includeLeadIds = true,
  includeMessageText = false
} = {}) {
  return buildReportModel({
    mode,
    generatedAt: "2026-01-31T12:05:00-06:00",
    asOf: "2026-01-31T12:00:00-06:00",
    windowDays: 90,
    privacy: {
      includeLeadIds,
      includeMessageText,
      messageSnippetCharacters: 120
    },
    output: { writeActionCsv },
    accounts: [{
      metrics: metrics(name),
      timeZone: "America/Chicago",
      capability: {
        supported: true,
        envelope: "columns-data",
        requiredFields: {
          leadId: true,
          leadType: true,
          participantType: true,
          conversationChannel: true,
          callDurationMillis: true,
          eventDateTime: true,
          messageText: true
        },
        rowContainerPresent: true,
        pagination: "not-declared"
      },
      completion: {
        method: "connector-complete-saved-result",
        pageCount: 1
      }
    }],
    historyPoints: []
  });
}

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lsa-output-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "package");
  const parent = path.join(root, "reports");
  await mkdir(packageRoot, { mode: 0o700 });
  await mkdir(parent, { mode: 0o700 });
  return {
    root,
    packageRoot,
    parent,
    destination: path.join(parent, "latest")
  };
}

async function snapshotTree(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = {};
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name))) {
    assert.equal(entry.isFile(), true);
    result[entry.name] = (await readFile(path.join(directory, entry.name))).toString("base64");
  }
  return result;
}

async function transactionArtifacts(parent, destination) {
  const basename = path.basename(destination);
  return (await readdir(parent)).filter((name) =>
    name.startsWith(`.${basename}.stage-`) ||
    name.startsWith(`.${basename}.backup-`));
}

function outputWriterFor(area, checkpoint = async () => {}) {
  return _createOutputWriterForTests({
    checkpoint,
    packageRoot: area.packageRoot
  });
}

function writeArea(area, reportModel, options = {}) {
  return outputWriterFor(area)(area.destination, reportModel, options);
}

async function assertCompleteReplacement(destination, expectedName) {
  assert.deepEqual((await readdir(destination)).sort(), [
    "report-manifest.json",
    "report.html",
    "summary.json"
  ]);
  const manifest = JSON.parse(
    await readFile(path.join(destination, "report-manifest.json"), "utf8")
  );
  assert.deepEqual(manifest, {
    product: "lsa-responsiveness-tracker",
    schemaVersion: 1,
    mode: "private",
    files: ["report.html", "summary.json"]
  });
  assert.match(
    await readFile(path.join(destination, "report.html"), "utf8"),
    new RegExp(expectedName)
  );
  const summarySource = await readFile(
    path.join(destination, "summary.json"),
    "utf8"
  );
  assert.doesNotThrow(() => JSON.parse(summarySource));
}

function assertOutputError(error) {
  assert.ok(error instanceof OutputError);
  assert.equal(error.code, "OUTPUT");
  assert.equal(error.exitCode, 5);
  assert.match(error.message, /^Report output (?:target is unsafe|could not be written)\.$/);
  assert.equal(error.message.includes("lsa-output-"), false);
  return true;
}

test("a new destination receives the complete private bundle with private modes", async (t) => {
  const area = await workspace(t);
  const result = await writeArea(area, model());

  assert.deepEqual(result, {
    product: "lsa-responsiveness-tracker",
    schemaVersion: 1,
    mode: "private",
    files: ["report.html", "summary.json"]
  });
  assert.deepEqual((await readdir(area.destination)).sort(), [
    "report-manifest.json",
    "report.html",
    "summary.json"
  ]);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(area.destination, "report-manifest.json"), "utf8")),
    result
  );
  assert.match(await readFile(path.join(area.destination, "report.html"), "utf8"),
    /Private report/);
  assert.equal(
    (await stat(area.destination)).mode & 0o777,
    0o700
  );
  for (const file of await readdir(area.destination)) {
    assert.equal((await stat(path.join(area.destination, file))).mode & 0o777, 0o600);
  }
  assert.deepEqual(await transactionArtifacts(area.parent, area.destination), []);
});

test("a direct writer normalizes its stage under a restrictive inherited umask", async (t) => {
  if (process.platform === "win32") t.skip("POSIX mode test");
  const area = await workspace(t);
  const result = runOutputWriterWithRestrictiveUmask(
    area.destination,
    model()
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal((await stat(area.destination)).mode & 0o777, 0o700);
  assert.deepEqual((await readdir(area.destination)).sort(), [
    "report-manifest.json",
    "report.html",
    "summary.json"
  ]);
  for (const name of await readdir(area.destination)) {
    assert.equal(
      (await stat(path.join(area.destination, name))).mode & 0o777,
      0o600
    );
  }
  assert.deepEqual(await transactionArtifacts(area.parent, area.destination), []);
});

test("a stage chmod failure removes only the retained empty stage", async (t) => {
  if (process.platform === "win32") t.skip("POSIX mode test");
  const area = await workspace(t);
  const originalChmod = fsPromises.chmod;
  let attempts = 0;

  fsPromises.chmod = async (candidate, ...args) => {
    if (path.basename(candidate).startsWith(".latest.stage-")) {
      attempts += 1;
      throw new Error("SYNTHETIC STAGE CHMOD FAILURE");
    }
    return originalChmod(candidate, ...args);
  };
  syncBuiltinESMExports();

  try {
    await assert.rejects(
      writeArea(area, model()),
      assertOutputError
    );
  } finally {
    fsPromises.chmod = originalChmod;
    syncBuiltinESMExports();
  }

  assert.equal(attempts, 1);
  await assert.rejects(lstat(area.destination), { code: "ENOENT" });
  assert.deepEqual(await transactionArtifacts(area.parent, area.destination), []);
});

test("a stage substituted during chmod is rejected and never deleted", async (t) => {
  if (process.platform === "win32") t.skip("POSIX mode test");
  const area = await workspace(t);
  const originalChmod = fsPromises.chmod;
  let substitutedStage;
  let displacedStage;

  fsPromises.chmod = async (candidate, mode, ...args) => {
    if (path.basename(candidate).startsWith(".latest.stage-") &&
        substitutedStage === undefined) {
      substitutedStage = candidate;
      displacedStage = `${candidate}.displaced`;
      await rename(candidate, displacedStage);
      await mkdir(candidate, { mode: 0o700 });
      await writeFile(
        path.join(candidate, "foreign.txt"),
        "SYNTHETIC FOREIGN STAGE BYTES\n",
        { mode: 0o600 }
      );
    }
    return originalChmod(candidate, mode, ...args);
  };
  syncBuiltinESMExports();

  try {
    await assert.rejects(
      writeArea(area, model()),
      assertOutputError
    );
  } finally {
    fsPromises.chmod = originalChmod;
    syncBuiltinESMExports();
  }

  assert.equal(typeof substitutedStage, "string");
  assert.equal((await lstat(substitutedStage)).isDirectory(), true);
  assert.equal((await lstat(displacedStage)).isDirectory(), true);
  assert.equal(
    await readFile(path.join(substitutedStage, "foreign.txt"), "utf8"),
    "SYNTHETIC FOREIGN STAGE BYTES\n"
  );
  await assert.rejects(lstat(area.destination), { code: "ENOENT" });
});

test("the accurate payload list includes CSV only when enabled", async (t) => {
  const area = await workspace(t);
  const manifest = await writeArea(area, model({
    writeActionCsv: true,
    includeMessageText: true
  }));

  assert.deepEqual(manifest.files, [
    "report.html",
    "summary.json",
    "recent-unanswered.csv"
  ]);
  assert.match(
    await readFile(path.join(area.destination, "recent-unanswered.csv"), "utf8"),
    /SYNTHETIC ACTION/
  );
});

test("an existing unmarked destination is refused and remains byte-identical", async (t) => {
  const area = await workspace(t);
  await mkdir(area.destination, { mode: 0o700 });
  const marker = Buffer.from("SYNTHETIC UNRELATED BYTES\n");
  await writeFile(path.join(area.destination, "unrelated.txt"), marker, { mode: 0o600 });
  const before = await snapshotTree(area.destination);

  await assert.rejects(
    writeArea(area, model()),
    assertOutputError
  );

  assert.deepEqual(await snapshotTree(area.destination), before);
  assert.deepEqual(await readFile(path.join(area.destination, "unrelated.txt")), marker);
  assert.deepEqual(await transactionArtifacts(area.parent, area.destination), []);
});

test("a product-owned private destination is atomically replaceable", async (t) => {
  const area = await workspace(t);
  await writeArea(area, model({ name: "Synthetic First" }));
  const before = await readFile(path.join(area.destination, "report.html"), "utf8");

  await writeArea(area, model({ name: "Synthetic Second" }));
  const after = await readFile(path.join(area.destination, "report.html"), "utf8");

  assert.notEqual(after, before);
  assert.match(after, /Synthetic Second/);
  assert.doesNotMatch(after, /Synthetic First/);
  assert.deepEqual(await transactionArtifacts(area.parent, area.destination), []);
});

test("replacing synthetic output requires explicit replaceDemo", async (t) => {
  const area = await workspace(t);
  await writeArea(area, model({
    mode: "synthetic",
    name: "Synthetic Demo One"
  }));
  const before = await snapshotTree(area.destination);

  await assert.rejects(
    writeArea(area, model({
      mode: "synthetic",
      name: "Synthetic Demo Two"
    })),
    assertOutputError
  );
  assert.deepEqual(await snapshotTree(area.destination), before);

  await writeArea(area, model({
    mode: "synthetic",
    name: "Synthetic Demo Two"
  }), { replaceDemo: true });
  assert.match(await readFile(path.join(area.destination, "report.html"), "utf8"),
    /Synthetic Demo Two/);
  assert.deepEqual(await transactionArtifacts(area.parent, area.destination), []);
});

test("an injected staging failure leaves no destination and no owned artifacts", async (t) => {
  const area = await workspace(t);
  const writer = outputWriterFor(area, (name) => {
      if (name === "after-stage-file:report.html") {
        throw new Error("SYNTHETIC INJECTED FAILURE");
      }
  });

  await assert.rejects(
    writer(area.destination, model()),
    assertOutputError
  );
  await assert.rejects(lstat(area.destination), { code: "ENOENT" });
  assert.deepEqual(await transactionArtifacts(area.parent, area.destination), []);
});

test("an injected replacement failure restores the existing report byte-for-byte", async (t) => {
  const area = await workspace(t);
  await writeArea(area, model({ name: "Synthetic Original" }));
  const before = await snapshotTree(area.destination);
  const writer = outputWriterFor(area, (name) => {
      if (name === "before-stage-to-destination") {
        throw new Error("SYNTHETIC INJECTED FAILURE");
      }
  });

  await assert.rejects(
    writer(area.destination, model({ name: "Synthetic Replacement" })),
    assertOutputError
  );
  assert.deepEqual(await snapshotTree(area.destination), before);
  assert.deepEqual(await transactionArtifacts(area.parent, area.destination), []);
});

test("a failure after installation rolls back to the original byte-for-byte", async (t) => {
  const area = await workspace(t);
  await writeArea(area, model({ name: "Synthetic Original" }));
  const before = await snapshotTree(area.destination);
  const writer = outputWriterFor(area, (name) => {
      if (name === "after-stage-to-destination") {
        throw new Error("SYNTHETIC POST-INSTALL FAILURE");
      }
  });

  await assert.rejects(
    writer(area.destination, model({ name: "Synthetic Replacement" })),
    assertOutputError
  );
  assert.deepEqual(await snapshotTree(area.destination), before);
  assert.deepEqual(await transactionArtifacts(area.parent, area.destination), []);
});

test("destinations inside the package are refused except private-output", async (t) => {
  const area = await workspace(t);
  const writer = outputWriterFor(area);
  const publicParent = path.join(area.packageRoot, "examples");
  const privateParent = path.join(area.packageRoot, "private-output");
  await mkdir(publicParent, { mode: 0o700 });
  await mkdir(privateParent, { mode: 0o700 });

  await assert.rejects(
    writer(path.join(publicParent, "report"), model()),
    assertOutputError
  );
  await writer(path.join(privateParent, "report"), model());
  assert.match(
    await readFile(path.join(privateParent, "report", "report.html"), "utf8"),
    /Private report/
  );
});

test("symlinked parents and destination symlinks are refused without touching targets", async (t) => {
  const area = await workspace(t);
  const writer = outputWriterFor(area);
  const outside = path.join(area.root, "outside");
  await mkdir(outside, { mode: 0o700 });
  const linkedParent = path.join(area.root, "linked-reports");
  await symlink(outside, linkedParent);

  await assert.rejects(
    writer(path.join(linkedParent, "latest"), model()),
    assertOutputError
  );
  await assert.rejects(lstat(path.join(outside, "latest")), { code: "ENOENT" });

  const foreign = path.join(area.root, "foreign");
  await mkdir(foreign, { mode: 0o700 });
  await writeFile(path.join(foreign, "marker.txt"), "SYNTHETIC FOREIGN\n", {
    mode: 0o600
  });
  await symlink(foreign, area.destination);
  await assert.rejects(
    writer(area.destination, model()),
    assertOutputError
  );
  assert.equal(await readFile(path.join(foreign, "marker.txt"), "utf8"),
    "SYNTHETIC FOREIGN\n");
});

test("unsafe parent permissions fail before output creation", async (t) => {
  if (process.platform === "win32") t.skip("POSIX mode test");
  const area = await workspace(t);
  await chmod(area.parent, 0o777);
  await assert.rejects(
    writeArea(area, model()),
    assertOutputError
  );
  await assert.rejects(lstat(area.destination), { code: "ENOENT" });
  assert.deepEqual(await transactionArtifacts(area.parent, area.destination), []);
});

test("parent safety and BigInt identity are revalidated before installation", async (t) => {
  if (process.platform === "win32") t.skip("POSIX mode test");
  const area = await workspace(t);
  let changed = false;
  const writer = outputWriterFor(area, async (name) => {
      if (name === "before-stage-to-destination") {
        await chmod(area.parent, 0o777);
        changed = true;
      }
  });

  try {
    await assert.rejects(
      writer(area.destination, model()),
      assertOutputError
    );
  } finally {
    if (changed) await chmod(area.parent, 0o700);
  }
  await assert.rejects(lstat(area.destination), { code: "ENOENT" });
  assert.deepEqual(await transactionArtifacts(area.parent, area.destination), []);
});

test("parent identity changes above Number precision are not aliased", async (t) => {
  const area = await workspace(t);
  const canonicalParent = await realpath(area.parent);
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
    if (candidate !== canonicalParent) return stats;
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
    await assert.rejects(
      writeArea(area, model()),
      assertOutputError
    );
  } finally {
    fsPromises.lstat = originalLstat;
    syncBuiltinESMExports();
  }

  assert.ok(parentChecks >= 2);
  await assert.rejects(lstat(area.destination), { code: "ENOENT" });
  assert.deepEqual(await transactionArtifacts(area.parent, area.destination), []);
});

test("a substituted existing payload is never backed up, installed over, or deleted", async (t) => {
  const area = await workspace(t);
  await writeArea(area, model({ name: "Synthetic Original" }));
  const payload = path.join(area.destination, "report.html");
  const foreign = Buffer.from("SYNTHETIC FOREIGN REPLACEMENT\n");
  let substituted = false;
  const writer = outputWriterFor(area, async (name) => {
      if (name === "before-existing-to-backup") {
        await rm(payload);
        await writeFile(payload, foreign, { mode: 0o600 });
        substituted = true;
      }
  });

  await assert.rejects(
    writer(area.destination, model({ name: "Synthetic New" })),
    assertOutputError
  );
  assert.equal(substituted, true);
  assert.deepEqual(await readFile(payload), foreign);
  assert.deepEqual(await transactionArtifacts(area.parent, area.destination), []);
});

test("product marker validation refuses extra files and substituted symlink payloads", async (t) => {
  const area = await workspace(t);
  await writeArea(area, model());
  await writeFile(path.join(area.destination, "extra.txt"), "SYNTHETIC EXTRA\n", {
    mode: 0o600
  });
  const withExtra = await snapshotTree(area.destination);
  await assert.rejects(
    writeArea(area, model({ name: "Synthetic New" })),
    assertOutputError
  );
  assert.deepEqual(await snapshotTree(area.destination), withExtra);

  await rm(path.join(area.destination, "extra.txt"));
  const payload = path.join(area.destination, "report.html");
  await rm(payload);
  const foreign = path.join(area.root, "foreign-report.html");
  await writeFile(foreign, "SYNTHETIC FOREIGN REPORT\n", { mode: 0o600 });
  await symlink(foreign, payload);
  await assert.rejects(
    writeArea(area, model({ name: "Synthetic New" })),
    assertOutputError
  );
  assert.equal(await readFile(foreign, "utf8"), "SYNTHETIC FOREIGN REPORT\n");
});

test("duplicate decoded report-manifest members cannot authorize replacement", async (t) => {
  const area = await workspace(t);
  await writeArea(area, model({ name: "Synthetic Original" }));
  const manifestPath = path.join(area.destination, "report-manifest.json");
  const source = await readFile(manifestPath, "utf8");
  await writeFile(manifestPath, source.replace(
    '"product": "lsa-responsiveness-tracker"',
    '"product": "synthetic-shadow",\n  "pr\\u006fduct": "lsa-responsiveness-tracker"'
  ), { mode: 0o600 });
  const before = await snapshotTree(area.destination);

  await assert.rejects(
    writeArea(area, model({ name: "Synthetic Replacement" })),
    assertOutputError
  );
  assert.deepEqual(await snapshotTree(area.destination), before);
  assert.deepEqual(await transactionArtifacts(area.parent, area.destination), []);
});

test("a later backup unlink failure keeps the complete verified replacement installed", async (t) => {
  const area = await workspace(t);
  await writeArea(area, model({ name: "Synthetic Original" }));
  const originalUnlink = fsPromises.unlink;
  let backupUnlinks = 0;

  fsPromises.unlink = async (candidate, ...args) => {
    if (path.basename(path.dirname(candidate)).startsWith(".latest.backup-")) {
      backupUnlinks += 1;
      if (backupUnlinks === 2) {
        throw new Error("SYNTHETIC LATE BACKUP UNLINK FAILURE");
      }
    }
    return originalUnlink(candidate, ...args);
  };
  syncBuiltinESMExports();

  try {
    await assert.rejects(
      writeArea(area, model({ name: "Synthetic Replacement" })),
      assertOutputError
    );
  } finally {
    fsPromises.unlink = originalUnlink;
    syncBuiltinESMExports();
  }

  assert.equal(backupUnlinks, 2);
  await assertCompleteReplacement(area.destination, "Synthetic Replacement");
  assert.equal(
    (await transactionArtifacts(area.parent, area.destination))
      .some((name) => name.startsWith(".latest.backup-")),
    true
  );
});

test("a backup rmdir failure keeps the complete verified replacement installed", async (t) => {
  const area = await workspace(t);
  await writeArea(area, model({ name: "Synthetic Original" }));
  const originalRmdir = fsPromises.rmdir;
  let backupRmdirAttempts = 0;

  fsPromises.rmdir = async (candidate, ...args) => {
    if (path.basename(candidate).startsWith(".latest.backup-")) {
      backupRmdirAttempts += 1;
      throw new Error("SYNTHETIC BACKUP RMDIR FAILURE");
    }
    return originalRmdir(candidate, ...args);
  };
  syncBuiltinESMExports();

  try {
    await assert.rejects(
      writeArea(area, model({ name: "Synthetic Replacement" })),
      assertOutputError
    );
  } finally {
    fsPromises.rmdir = originalRmdir;
    syncBuiltinESMExports();
  }

  assert.equal(backupRmdirAttempts, 1);
  await assertCompleteReplacement(area.destination, "Synthetic Replacement");
  assert.equal(
    (await transactionArtifacts(area.parent, area.destination))
      .some((name) => name.startsWith(".latest.backup-")),
    true
  );
});

test("a renamed staged payload is rejected immediately before installation", async (t) => {
  const area = await workspace(t);
  const foreign = path.join(area.root, "foreign-pre-install.html");
  await writeFile(foreign, "SYNTHETIC FOREIGN PRE-INSTALL\n", { mode: 0o600 });
  const writer = outputWriterFor(area, async (name) => {
    if (name !== "before-stage-to-destination") return;
    const stageName = (await transactionArtifacts(area.parent, area.destination))
      .find((entry) => entry.startsWith(".latest.stage-"));
    assert.equal(typeof stageName, "string");
    await rename(
      foreign,
      path.join(area.parent, stageName, "report.html")
    );
  });

  await assert.rejects(
    writer(area.destination, model()),
    assertOutputError
  );
  await assert.rejects(lstat(area.destination), { code: "ENOENT" });
});

test("same-inode staged byte mutation is rejected immediately before installation", async (t) => {
  const area = await workspace(t);
  const writer = outputWriterFor(area, async (name) => {
    if (name !== "before-stage-to-destination") return;
    const stageName = (await transactionArtifacts(area.parent, area.destination))
      .find((entry) => entry.startsWith(".latest.stage-"));
    assert.equal(typeof stageName, "string");
    const payload = path.join(area.parent, stageName, "report.html");
    const original = await readFile(payload);
    assert.ok(original.length > 0);
    await writeFile(payload, Buffer.alloc(original.length, 0x58));
  });

  await assert.rejects(
    writer(area.destination, model()),
    assertOutputError
  );
  await assert.rejects(lstat(area.destination), { code: "ENOENT" });
});

test("a renamed installed payload is rejected and the original is restored", async (t) => {
  const area = await workspace(t);
  await writeArea(area, model({ name: "Synthetic Original" }));
  const before = await snapshotTree(area.destination);
  const foreign = path.join(area.root, "foreign-post-install.html");
  await writeFile(foreign, "SYNTHETIC FOREIGN POST-INSTALL\n", { mode: 0o600 });
  const writer = outputWriterFor(area, async (name) => {
    if (name === "after-stage-to-destination") {
      await rename(foreign, path.join(area.destination, "report.html"));
    }
  });

  await assert.rejects(
    writer(area.destination, model({ name: "Synthetic Replacement" })),
    assertOutputError
  );
  assert.deepEqual(await snapshotTree(area.destination), before);
});

test("same-inode installed byte mutation is rejected and the original is restored", async (t) => {
  const area = await workspace(t);
  await writeArea(area, model({ name: "Synthetic Original" }));
  const before = await snapshotTree(area.destination);
  const writer = outputWriterFor(area, async (name) => {
    if (name !== "after-stage-to-destination") return;
    const payload = path.join(area.destination, "report.html");
    const original = await readFile(payload);
    assert.ok(original.length > 0);
    await writeFile(payload, Buffer.alloc(original.length, 0x59));
  });

  await assert.rejects(
    writer(area.destination, model({ name: "Synthetic Replacement" })),
    assertOutputError
  );
  assert.deepEqual(await snapshotTree(area.destination), before);
});

test("an existing payload with a hard-link alias is refused without replacement", async (t) => {
  const area = await workspace(t);
  await writeArea(area, model({ name: "Synthetic Original" }));
  const before = await snapshotTree(area.destination);
  await link(
    path.join(area.destination, "report.html"),
    path.join(area.root, "report-hardlink-alias.html")
  );

  await assert.rejects(
    writeArea(area, model({ name: "Synthetic Replacement" })),
    assertOutputError
  );
  assert.deepEqual(await snapshotTree(area.destination), before);
});

test("production rejects a fake packageRoot that would authorize the real public tree", async (t) => {
  const area = await workspace(t);
  const actualPackageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
  );
  const destination = path.join(
    actualPackageRoot,
    "examples",
    `.task9-production-boundary-${process.pid}`
  );
  t.after(async () => rm(destination, { recursive: true, force: true }));

  await assert.rejects(
    writeOutputBundle(destination, model(), { packageRoot: area.packageRoot }),
    assertOutputError
  );
  await assert.rejects(lstat(destination), { code: "ENOENT" });
});

test("production options are an exact plain-data record with one optional boolean", async (t) => {
  const area = await workspace(t);
  const inherited = Object.create({ replaceDemo: false });
  const nullPrototype = Object.create(null);
  let getterRead = false;
  const accessor = {};
  Object.defineProperty(accessor, "replaceDemo", {
    enumerable: true,
    get() {
      getterRead = true;
      return false;
    }
  });
  const cases = [
    { unexpected: true },
    { replaceDemo: "true" },
    inherited,
    nullPrototype,
    accessor
  ];

  for (const [index, options] of cases.entries()) {
    const destination = path.join(area.parent, `options-${index}`);
    await assert.rejects(
      writeOutputBundle(destination, model(), options),
      assertOutputError
    );
    await assert.rejects(lstat(destination), { code: "ENOENT" });
  }
  assert.equal(getterRead, false);
});
