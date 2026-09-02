import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { OutputError } from "../src/errors.js";
import { writeHistoryAtomic } from "../src/history.js";
import { buildReportModel } from "../src/report-model.js";
import {
  _createReportTransactionForTests,
  writeReportTransaction
} from "../src/report-transaction.js";
import { writeOutputBundle } from "../src/write-output.js";

function metric(accountName, responded) {
  return {
    metricVersion: "lsa-responsiveness/v1",
    account: { key: "example-heating", name: accountName },
    counts: {
      repliedMessages: responded,
      recentUnansweredMessages: responded ? 0 : 1,
      oldUnansweredMessages: 0,
      eligibleMessages: 1,
      eligiblePhoneCalls: 0,
      connectedCalls: 0,
      totalEligible: 1,
      totalResponded: responded
    },
    rates: {
      totalResponsiveness: responded,
      callsConnected: null,
      messagesReplied: responded,
      repliedWithin24Hours: responded
    },
    replySpeed: {
      medianNanoseconds: responded ? "60000000000" : null,
      buckets: {
        within5m: responded,
        within1h: 0,
        within24h: 0,
        over24h: 0
      }
    },
    diagnostics: { incompleteWindowLeads: 0, excludedLeadTypes: {} },
    recentUnanswered: responded ? [] : [{
      leadId: "900000000001",
      firstContactEpochNanoseconds: "1769888400000000000"
    }]
  };
}

function historyPoint(accountName, responded) {
  return {
    accountKey: "example-heating",
    accountName,
    asOf: "2026-01-31T12:00:00-06:00",
    windowDays: 30,
    metricVersion: "lsa-responsiveness/v1",
    repliedMessages: responded,
    recentUnansweredMessages: responded ? 0 : 1,
    oldUnansweredMessages: 0,
    eligibleMessages: 1,
    eligiblePhoneCalls: 0,
    connectedCalls: 0,
    totalEligible: 1,
    totalResponded: responded,
    totalResponsiveness: responded,
    callsConnected: null,
    messagesReplied: responded,
    repliedWithin24Hours: responded,
    medianReplyNanoseconds: responded ? "60000000000" : null,
    replySpeedBuckets: {
      within5m: responded,
      within1h: 0,
      within24h: 0,
      over24h: 0
    },
    diagnostics: {
      incompleteWindowLeads: 0,
      bookingLeads: 0,
      unsupportedLeadTypes: 0
    }
  };
}

function history(accountName, responded) {
  return { schemaVersion: 1, points: [historyPoint(accountName, responded)] };
}

function reportModel(accountName, responded) {
  return buildReportModel({
    mode: "private",
    generatedAt: "2026-01-31T12:05:00-06:00",
    asOf: "2026-01-31T12:00:00-06:00",
    windowDays: 30,
    privacy: {
      includeLeadIds: true,
      includeMessageText: false,
      messageSnippetCharacters: 120
    },
    output: { writeActionCsv: false },
    accounts: [{
      metrics: metric(accountName, responded),
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
        pagination: "single-page"
      },
      completion: { method: "single-page-no-continuation", pageCount: 1 }
    }],
    historyPoints: []
  });
}

async function area(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lsa-joint-transaction-"));
  await chmod(root, 0o700);
  t.after(async () => rm(root, { recursive: true, force: true }));
  return {
    root,
    reportPath: path.join(root, "report"),
    historyPath: path.join(root, "history.json")
  };
}

function input(paths, oldName = "Synthetic Old", newName = "Synthetic New") {
  return {
    reportDestination: paths.reportPath,
    reportModel: reportModel(newName, 1),
    history: {
      path: paths.historyPath,
      previous: history(oldName, 0),
      next: history(newName, 1)
    }
  };
}

async function seed(paths) {
  await writeOutputBundle(paths.reportPath, reportModel("Synthetic Old", 0));
  await writeHistoryAtomic(paths.historyPath, history("Synthetic Old", 0));
}

async function rawSnapshot(paths) {
  const report = {};
  for (const name of (await readdir(paths.reportPath)).sort()) {
    report[name] = (await readFile(path.join(paths.reportPath, name))).toString("base64");
  }
  return {
    report,
    history: (await readFile(paths.historyPath)).toString("base64")
  };
}

async function artifacts(root) {
  return (await readdir(root)).filter((name) =>
    /\.(?:stage|backup|quarantine)-/.test(name));
}

function outputFailure(error) {
  assert.ok(error instanceof OutputError);
  assert.equal(error.exitCode, 5);
  assert.equal(error.message, "Report and history could not be written.");
  assert.equal(error.message.includes("lsa-joint-transaction"), false);
  return true;
}

test("the production transaction replaces report and history together", async (t) => {
  const paths = await area(t);
  await seed(paths);
  await writeReportTransaction(input(paths));

  assert.match(
    await readFile(path.join(paths.reportPath, "report.html"), "utf8"),
    /Synthetic New/
  );
  assert.match(await readFile(paths.historyPath, "utf8"), /Synthetic New/);
  assert.deepEqual(await artifacts(paths.root), []);
});

test("every pre-commit boundary failure restores both targets byte-for-byte", async (t) => {
  const checkpoints = [
    "after-history-stage",
    "after-report-stage",
    "before-history-backup",
    "after-history-backup",
    "before-report-backup",
    "after-report-backup",
    "before-history-install",
    "after-history-install",
    "before-report-install",
    "after-report-install",
    "before-commit"
  ];
  for (const checkpoint of checkpoints) {
    await t.test(checkpoint, async (st) => {
      const paths = await area(st);
      await seed(paths);
      const before = await rawSnapshot(paths);
      const transaction = _createReportTransactionForTests({
        checkpoint: async (name) => {
          if (name === checkpoint) throw new Error("SYNTHETIC INJECTED FAILURE");
        }
      });
      await assert.rejects(transaction(input(paths)), outputFailure);
      assert.deepEqual(await rawSnapshot(paths), before);
      assert.deepEqual(await artifacts(paths.root), []);
    });
  }
});

test("failures with originally absent targets remove only owned transaction output", async (t) => {
  const paths = await area(t);
  const transaction = _createReportTransactionForTests({
    checkpoint: async (name) => {
      if (name === "after-report-install") {
        throw new Error("SYNTHETIC INJECTED FAILURE");
      }
    }
  });
  const next = input(paths);
  next.history.previous = { schemaVersion: 1, points: [] };
  await assert.rejects(transaction(next), outputFailure);
  assert.deepEqual(await readdir(paths.root), []);
});

test("all absent-target combinations commit complete new targets", async (t) => {
  for (const [reportExists, historyExists] of [
    [false, false],
    [true, false],
    [false, true]
  ]) {
    await t.test(`report-${reportExists}-history-${historyExists}`, async (st) => {
      const paths = await area(st);
      if (reportExists) {
        await writeOutputBundle(paths.reportPath, reportModel("Synthetic Old", 0));
      }
      if (historyExists) {
        await writeHistoryAtomic(paths.historyPath, history("Synthetic Old", 0));
      }
      const transactionInput = input(paths);
      if (!historyExists) {
        transactionInput.history.previous = { schemaVersion: 1, points: [] };
      }
      await writeReportTransaction(transactionInput);
      assert.match(
        await readFile(path.join(paths.reportPath, "report.html"), "utf8"),
        /Synthetic New/
      );
      assert.match(await readFile(paths.historyPath, "utf8"), /Synthetic New/);
      assert.deepEqual(await artifacts(paths.root), []);
    });
  }
});

test("the joint commit precedes cleanup and post-commit failure keeps both new targets", async (t) => {
  const paths = await area(t);
  await seed(paths);
  const transaction = _createReportTransactionForTests({
    checkpoint: async (name) => {
      if (name === "before-history-backup-cleanup") {
        throw new Error("SYNTHETIC POST-COMMIT FAILURE");
      }
    }
  });
  await assert.rejects(transaction(input(paths)), outputFailure);
  assert.match(
    await readFile(path.join(paths.reportPath, "report.html"), "utf8"),
    /Synthetic New/
  );
  assert.match(await readFile(paths.historyPath, "utf8"), /Synthetic New/);
  assert.ok((await artifacts(paths.root)).length >= 1);
});

test("overlapping report and history targets are rejected without mutation", async (t) => {
  const paths = await area(t);
  await seed(paths);
  const before = await rawSnapshot(paths);
  const transactionInput = input(paths);
  transactionInput.history.path = path.join(paths.reportPath, "history.json");
  await assert.rejects(writeReportTransaction(transactionInput), outputFailure);
  assert.deepEqual(await rawSnapshot(paths), before);
});

test("duplicate decoded report-manifest members cannot authorize a transaction", async (t) => {
  const paths = await area(t);
  await seed(paths);
  const manifestPath = path.join(paths.reportPath, "report-manifest.json");
  const source = await readFile(manifestPath, "utf8");
  await writeFile(manifestPath, source.replace(
    '"product": "lsa-responsiveness-tracker"',
    '"product": "synthetic-shadow",\n  "pr\\u006fduct": "lsa-responsiveness-tracker"'
  ), { mode: 0o600 });
  const before = await rawSnapshot(paths);

  await assert.rejects(writeReportTransaction(input(paths)), outputFailure);
  assert.deepEqual(await rawSnapshot(paths), before);
  assert.deepEqual(await artifacts(paths.root), []);
});

test("history cannot escape into the public package outside private-output", async (t) => {
  const paths = await area(t);
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
  );
  const forbiddenHistory = path.join(
    packageRoot,
    "examples",
    `.task10-forbidden-history-${process.pid}.json`
  );
  t.after(async () => rm(forbiddenHistory, { force: true }));
  const transactionInput = input(paths);
  transactionInput.history.path = forbiddenHistory;
  transactionInput.history.previous = { schemaVersion: 1, points: [] };
  await assert.rejects(writeReportTransaction(transactionInput), outputFailure);
  await assert.rejects(lstat(forbiddenHistory), (error) => error.code === "ENOENT");
  assert.deepEqual(await readdir(paths.root), []);
});

test("a foreign replacement of an owned stage is preserved, not deleted", async (t) => {
  const paths = await area(t);
  await seed(paths);
  let foreignPath;
  const transaction = _createReportTransactionForTests({
    checkpoint: async (name) => {
      if (name !== "after-history-stage") return;
      const stage = (await readdir(paths.root)).find((entry) =>
        entry.startsWith(".history.json.stage-"));
      assert.ok(stage);
      const owned = path.join(paths.root, stage);
      const displaced = `${owned}.displaced`;
      await writeFile(displaced, "SYNTHETIC FOREIGN BYTES\n", { mode: 0o600 });
      await rm(owned);
      await writeFile(owned, "SYNTHETIC FOREIGN BYTES\n", { mode: 0o600 });
      foreignPath = owned;
    }
  });
  await assert.rejects(transaction(input(paths)), outputFailure);
  assert.equal(await readFile(foreignPath, "utf8"), "SYNTHETIC FOREIGN BYTES\n");
});

test("a foreign installed target is quarantined while both originals are restored", async (t) => {
  const paths = await area(t);
  await seed(paths);
  const before = await rawSnapshot(paths);
  const marker = "SYNTHETIC FOREIGN INSTALLED TARGET\n";
  const transaction = _createReportTransactionForTests({
    checkpoint: async (name) => {
      if (name !== "after-report-install") return;
      const displaced = path.join(paths.root, ".synthetic-displaced-new-report");
      await rename(paths.reportPath, displaced);
      await mkdir(paths.reportPath, { mode: 0o700 });
      await writeFile(path.join(paths.reportPath, "foreign.txt"), marker, {
        mode: 0o600
      });
    }
  });
  await assert.rejects(transaction(input(paths)), outputFailure);
  assert.deepEqual(await rawSnapshot(paths), before);
  const quarantines = (await readdir(paths.root)).filter((name) =>
    name.startsWith(".report.quarantine-"));
  assert.equal(quarantines.length, 1);
  assert.equal(
    await readFile(path.join(paths.root, quarantines[0], "foreign.txt"), "utf8"),
    marker
  );
});

test("a foreign target created before install is quarantined when the original was absent", async (t) => {
  const paths = await area(t);
  const marker = "SYNTHETIC FOREIGN PREINSTALL TARGET\n";
  const transaction = _createReportTransactionForTests({
    checkpoint: async (name) => {
      if (name !== "before-report-install") return;
      await mkdir(paths.reportPath, { mode: 0o700 });
      await writeFile(path.join(paths.reportPath, "foreign.txt"), marker, {
        mode: 0o600
      });
    }
  });
  const transactionInput = input(paths);
  transactionInput.history.previous = { schemaVersion: 1, points: [] };
  await assert.rejects(transaction(transactionInput), outputFailure);
  assert.equal((await readdir(paths.root)).includes("report"), false);
  assert.equal((await readdir(paths.root)).includes("history.json"), false);
  const quarantine = (await readdir(paths.root)).find((name) =>
    name.startsWith(".report.quarantine-"));
  assert.ok(quarantine);
  assert.equal(
    await readFile(path.join(paths.root, quarantine, "foreign.txt"), "utf8"),
    marker
  );
});

test("a foreign backup-cleanup replacement is preserved after joint commit", async (t) => {
  const paths = await area(t);
  await seed(paths);
  const marker = "SYNTHETIC FOREIGN BACKUP TARGET\n";
  let foreignBackup;
  const transaction = _createReportTransactionForTests({
    checkpoint: async (name) => {
      if (name !== "before-report-backup-cleanup") return;
      const backupName = (await readdir(paths.root)).find((entry) =>
        entry.startsWith(".report.backup-"));
      assert.ok(backupName);
      foreignBackup = path.join(paths.root, backupName);
      await rename(foreignBackup, `${foreignBackup}.displaced`);
      await mkdir(foreignBackup, { mode: 0o700 });
      await writeFile(path.join(foreignBackup, "foreign.txt"), marker, {
        mode: 0o600
      });
    }
  });
  await assert.rejects(transaction(input(paths)), outputFailure);
  assert.match(
    await readFile(path.join(paths.reportPath, "report.html"), "utf8"),
    /Synthetic New/
  );
  assert.match(await readFile(paths.historyPath, "utf8"), /Synthetic New/);
  assert.equal(
    await readFile(path.join(foreignBackup, "foreign.txt"), "utf8"),
    marker
  );
});

test("history-disabled writes use the report bundle authority", async (t) => {
  const paths = await area(t);
  await writeReportTransaction({
    reportDestination: paths.reportPath,
    reportModel: reportModel("Synthetic Report Only", 1),
    history: null
  });
  assert.match(
    await readFile(path.join(paths.reportPath, "report.html"), "utf8"),
    /Synthetic Report Only/
  );
  assert.deepEqual(await readdir(paths.root), ["report"]);
});

test("transaction inputs and test options are exact plain data", async (t) => {
  const paths = await area(t);
  for (const invalid of [
    null,
    { ...input(paths), extra: true },
    { ...input(paths), reportDestination: "" },
    { ...input(paths), history: { ...input(paths).history, extra: true } }
  ]) {
    await assert.rejects(writeReportTransaction(invalid), outputFailure);
  }
  assert.throws(
    () => _createReportTransactionForTests({ checkpoint: async () => {}, extra: true }),
    /invalid/i
  );
});
