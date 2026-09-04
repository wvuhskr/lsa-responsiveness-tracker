import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsPromises, {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  _createMainForTests,
  _createReportHandlerForTests
} from "../src/cli.js";
import { writeHistoryAtomic } from "../src/history.js";
import {
  _createReportTransactionForTests,
  writeReportTransaction
} from "../src/report-transaction.js";
import {
  runCli,
  runCliWithRestrictiveUmask,
  runDemoWithRestrictiveUmaskAudit,
  packageRoot
} from "./helpers/run-cli.js";

const fixtureRoot = fileURLToPath(
  new URL("./fixtures/synthetic/", import.meta.url)
);
const REQUIRED_COLUMNS = [
  "localServicesLead.id",
  "localServicesLead.leadType",
  "localServicesLeadConversation.participantType",
  "localServicesLeadConversation.conversationChannel",
  "localServicesLeadConversation.phoneCallDetails.callDurationMillis",
  "localServicesLeadConversation.eventDateTime",
  "localServicesLeadConversation.messageDetails.text"
];

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(name) {
  return readFile(path.join(fixtureRoot, name), "utf8");
}

async function privateWorkspace(t, prefix = "lsa-cli-") {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  await chmod(root, 0o700);
  t.after(async () => rm(root, { recursive: true, force: true }));
  const outputDir = path.join(root, "output");
  await mkdir(outputDir, { mode: 0o700 });
  return { root, outputDir };
}

async function writeAccount(root, {
  key,
  name,
  customerId,
  timeZone,
  pageSource,
  format = "columns-data",
  completion = {
    method: "connector-complete-saved-result",
    savedResultWasComplete: true
  }
}) {
  const directory = path.join(root, `input-${key}`);
  await mkdir(directory, { mode: 0o700 });
  await writeFile(path.join(directory, "page.json"), pageSource, { mode: 0o600 });
  await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    format,
    source: { customerId },
    completion,
    pages: [{ path: "page.json" }]
  }, null, 2)}\n`, { mode: 0o600 });
  return {
    key,
    name,
    customerId,
    timeZone,
    inputManifest: path.relative(root, path.join(directory, "manifest.json"))
  };
}

async function writeConfig(root, accounts, overrides = {}) {
  const config = {
    schemaVersion: 1,
    asOf: "2026-01-31T12:00:00-05:00",
    windowDays: 30,
    accounts,
    ...overrides
  };
  const configPath = path.join(root, "config.json");
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600
  });
  return configPath;
}

function reportArgs(configPath, outputDir) {
  return ["report", "--config", configPath, "--output-dir", outputDir];
}

function assertNoPrivateMarker(result, markers) {
  for (const marker of markers) {
    assert.equal(result.stdout.includes(marker), false);
    assert.equal(result.stderr.includes(marker), false);
  }
}

async function assertReportBundleModes(reportDirectory) {
  assert.equal((await stat(reportDirectory)).mode & 0o777, 0o700);
  assert.deepEqual((await readdir(reportDirectory)).sort(), [
    "report-manifest.json",
    "report.html",
    "summary.json"
  ]);
  for (const name of await readdir(reportDirectory)) {
    assert.equal(
      (await stat(path.join(reportDirectory, name))).mode & 0o777,
      0o600
    );
  }
}

async function assertNoTransactionResidue(directory) {
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      assert.doesNotMatch(
        entry.name,
        /\.(?:stage|backup|temporary|quarantine)-/
      );
      if (entry.isDirectory()) pending.push(path.join(current, entry.name));
    }
  }
}

async function runInjectedReport(args, transaction) {
  const stdout = [];
  const stderr = [];
  const report = _createReportHandlerForTests({
    writeReportTransaction: transaction
  });
  const main = _createMainForTests({
    handlers: {
      demo: async () => {},
      probe: async () => {},
      report
    },
    debugEnabled: false
  });
  const status = await main(args, {
    out: (value) => stdout.push(String(value)),
    err: (value) => stderr.push(String(value))
  });
  return {
    status,
    stdout: stdout.length === 0 ? "" : `${stdout.join("\n")}\n`,
    stderr: stderr.length === 0 ? "" : `${stderr.join("\n")}\n`
  };
}

test("the exact parser rejects malformed commands and options with exit 2", () => {
  const cases = [
    [],
    ["unknown"],
    ["demo"],
    ["demo", "--output-dir"],
    ["demo", "--output-dir", "one", "--output-dir", "two"],
    ["demo", "--replace-demo", "--replace-demo", "--output-dir", "one"],
    ["demo", "--input", "one", "--output-dir", "two"],
    ["demo", "--output-dir=one"],
    ["demo", "position", "--output-dir", "one"],
    ["probe"],
    ["probe", "--input"],
    ["probe", "--input", "one", "--format"],
    ["probe", "--input", "one", "--format", "auto", "--format", "auto"],
    ["probe", "--input", "one", "--format", "aggregate"],
    ["probe", "--input", "one", "--config", "two"],
    ["report"],
    ["report", "--config", "one"],
    ["report", "--output-dir", "one"],
    ["report", "--config", "one", "--config", "two", "--output-dir", "three"],
    ["report", "--config", "one", "--output-dir", "two", "extra"],
    ["report", "--config", "one", "--output-dir", "--replace-demo"]
  ];
  for (const args of cases) {
    const result = runCli(args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.match(result.stderr, /Usage: lsa-responsiveness/);
    assert.equal(result.stdout, "");
  }
});

test("demo is deterministic, marked synthetic, and replacement is explicit", async (t) => {
  const { root } = await privateWorkspace(t, "lsa-cli-demo-");
  const destination = path.join(root, "demo");
  const first = runCli(["demo", "--output-dir", destination], {
    cwd: path.dirname(packageRoot)
  });
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual((await readdir(destination)).sort(), [
    "report-manifest.json",
    "report.html",
    "summary.json"
  ]);
  const html = await readFile(path.join(destination, "report.html"), "utf8");
  const summary = await readFile(path.join(destination, "summary.json"), "utf8");
  assert.match(html, /Synthetic demonstration data/);
  assert.equal(JSON.parse(summary).mode, "synthetic");
  const before = [digest(html), digest(summary)];

  const refused = runCli(["demo", "--output-dir", destination]);
  assert.equal(refused.status, 5);
  const replaced = runCli([
    "demo", "--output-dir", destination, "--replace-demo"
  ]);
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.deepEqual([
    digest(await readFile(path.join(destination, "report.html"), "utf8")),
    digest(await readFile(path.join(destination, "summary.json"), "utf8"))
  ], before);
});

test("demo normalizes all created artifacts under a restrictive inherited umask", async (t) => {
  if (process.platform === "win32") t.skip("POSIX mode test");
  const { root } = await privateWorkspace(t, "lsa-cli-demo-umask-");
  const temporaryParent = path.join(root, "temporary");
  const destination = path.join(root, "demo");
  await mkdir(temporaryParent, { mode: 0o700 });
  const result = runDemoWithRestrictiveUmaskAudit([
    "demo", "--output-dir", destination
  ], {
    cwd: path.dirname(packageRoot),
    env: {
      TMPDIR: temporaryParent,
      TMP: temporaryParent,
      TEMP: temporaryParent
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const auditLine = result.stdout.split("\n")
    .find((line) => line.startsWith("UMASK-AUDIT "));
  assert.equal(typeof auditLine, "string");
  assert.deepEqual(JSON.parse(auditLine.slice("UMASK-AUDIT ".length)), {
    directory: 0o700,
    files: {
      "manifest.json": 0o600,
      "synthetic-response.json": 0o600
    }
  });
  assert.match(result.stdout, /Synthetic demo report written\./);
  await assertReportBundleModes(destination);
  assert.deepEqual(await readdir(temporaryParent), []);
  await assertNoTransactionResidue(root);
});

test("demo refuses an unrelated existing directory even with replace-demo", async (t) => {
  const { root } = await privateWorkspace(t);
  const destination = path.join(root, "unrelated");
  await mkdir(destination, { mode: 0o700 });
  await writeFile(path.join(destination, "keep.txt"), "SYNTHETIC KEEP\n", {
    mode: 0o600
  });
  const result = runCli([
    "demo", "--output-dir", destination, "--replace-demo"
  ]);
  assert.equal(result.status, 5);
  assert.equal(
    await readFile(path.join(destination, "keep.txt"), "utf8"),
    "SYNTHETIC KEEP\n"
  );
});

test("probe prints only a fixed structural table for multiple inputs", async (t) => {
  const { root } = await privateWorkspace(t, "lsa-cli-probe-");
  const markers = [
    "PRIVATE-PROBE-LEAD-MARKER",
    "PRIVATE-PROBE-MESSAGE-MARKER",
    "2222222222"
  ];
  const firstPath = path.join(root, "private-marker-one.json");
  const secondPath = path.join(root, "private-marker-two.json");
  const payload = {
    result: {
      columns: REQUIRED_COLUMNS,
      data: [[
        markers[0], "MESSAGE", "CONSUMER", "SMS", null,
        "2026-01-30T12:00:00Z", markers[1]
      ]]
    },
    customerId: markers[2]
  };
  await writeFile(firstPath, JSON.stringify(payload), { mode: 0o600 });
  await writeFile(secondPath, await fixture("normal-columns.json"), { mode: 0o600 });

  const result = runCli([
    "probe", "--input", firstPath, "--input", secondPath,
    "--format", "columns-data"
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Input \| Supported \| Envelope \|/);
  assert.match(result.stdout, /Input 1 \| Yes \| columns-data \|/);
  assert.match(result.stdout, /Input 2 \| Yes \| columns-data \|/);
  assertNoPrivateMarker(result, [...markers, firstPath, secondPath]);
  assert.equal(result.stderr, "");
});

test("probe classifies unsupported capability as exit 3", async (t) => {
  const { root } = await privateWorkspace(t);
  const aggregatePath = path.join(root, "aggregate.json");
  await writeFile(aggregatePath, JSON.stringify({
    result: { columns: ["campaign.id", "metrics.clicks"], data: [["1", 2]] }
  }), { mode: 0o600 });
  const result = runCli(["probe", "--input", aggregatePath]);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /required fields|unsupported capability/i);
  assertNoPrivateMarker(result, [aggregatePath, "campaign.id", "1"]);
});

test("probe classifies malformed, connector-error, and unresolved-page data as exit 4", async (t) => {
  const { root } = await privateWorkspace(t);
  const valid = {
    result: {
      columns: REQUIRED_COLUMNS,
      data: [[
        "SYNTHETIC-PROBE-FLAG-LEAD", "MESSAGE", "CONSUMER", "SMS", null,
        "2026-01-30T12:00:00Z", "SYNTHETIC-PROBE-FLAG-MESSAGE"
      ]]
    }
  };
  const cases = [
    ["malformed.json", '{"result":', "PRIVATE-MALFORMED-MARKER"],
    ["error.json", JSON.stringify({ error: "PRIVATE-CONNECTOR-MARKER" }),
      "PRIVATE-CONNECTOR-MARKER"],
    ["truncated.json", JSON.stringify({
      result: { columns: REQUIRED_COLUMNS, data: [] },
      truncated: true,
      detail: "PRIVATE-TRUNCATION-MARKER"
    }), "PRIVATE-TRUNCATION-MARKER"],
    ["page.json", JSON.stringify({
      result: { columns: REQUIRED_COLUMNS, data: [] },
      nextPageToken: "PRIVATE-NEXT-TOKEN"
    }), "PRIVATE-NEXT-TOKEN"],
    ["root-is-error.json", JSON.stringify({
      ...structuredClone(valid),
      isError: true,
      detail: "PRIVATE-ROOT-IS-ERROR-MARKER"
    }), "PRIVATE-ROOT-IS-ERROR-MARKER"],
    ["root-partial.json", JSON.stringify({
      ...structuredClone(valid),
      partial: true,
      detail: "PRIVATE-ROOT-PARTIAL-MARKER"
    }), "PRIVATE-ROOT-PARTIAL-MARKER"],
    ["wrapper-is-error.json", JSON.stringify({
      result: {
        ...structuredClone(valid.result),
        isError: true,
        detail: "PRIVATE-WRAPPER-IS-ERROR-MARKER"
      }
    }), "PRIVATE-WRAPPER-IS-ERROR-MARKER"],
    ["wrapper-partial.json", JSON.stringify({
      result: {
        ...structuredClone(valid.result),
        partial: true,
        detail: "PRIVATE-WRAPPER-PARTIAL-MARKER"
      }
    }), "PRIVATE-WRAPPER-PARTIAL-MARKER"]
  ];
  for (const [name, source, marker] of cases) {
    const inputPath = path.join(root, name);
    await writeFile(inputPath, source, { mode: 0o600 });
    const result = runCli(["probe", "--input", inputPath]);
    assert.equal(result.status, 4, name);
    assertNoPrivateMarker(result, [
      marker,
      inputPath,
      "SYNTHETIC-PROBE-FLAG-LEAD",
      "SYNTHETIC-PROBE-FLAG-MESSAGE"
    ]);
    assert.equal(result.stdout, "");
  }
});

test("probe rejects duplicate decoded JSON members without printing input", async (t) => {
  const { root } = await privateWorkspace(t);
  const base = JSON.stringify({
    result: { columns: REQUIRED_COLUMNS, data: [] }
  });
  const cases = [
    base.replace("{", '{"probeShadow":1,"probeShadow":2,'),
    base.replace(
      '"columns":',
      '"nestedShadow":1,"nestedShadow":2,"columns":'
    ),
    base.replace("{", '{"probeShadow":1,"probe\\u0053hadow":2,')
  ];

  for (const [index, source] of cases.entries()) {
    const inputPath = path.join(root, `duplicate-${index}.json`);
    await writeFile(inputPath, source, { mode: 0o600 });
    const result = runCli(["probe", "--input", inputPath]);
    assert.equal(result.status, 4);
    assert.equal(result.stdout, "");
    assertNoPrivateMarker(result, [inputPath, "probeShadow", "nestedShadow"]);
  }
});

test("probe enforces the explicitly selected response format", async (t) => {
  const { root } = await privateWorkspace(t);
  const inputPath = path.join(root, "columns.json");
  await writeFile(inputPath, await fixture("normal-columns.json"), { mode: 0o600 });
  const result = runCli([
    "probe", "--input", inputPath, "--format", "google-ads-results"
  ]);
  assert.equal(result.status, 3);
  assertNoPrivateMarker(result, [inputPath, "900000000001"]);
});

test("an incomplete report fails closed with exit 4 and no live output", async (t) => {
  const { root, outputDir } = await privateWorkspace(t);
  const account = await writeAccount(root, {
    key: "example-heating",
    name: "Example Heating",
    customerId: "1000000001",
    timeZone: "America/New_York",
    pageSource: '{"result": "SYNTHETIC TRUNCATED PRIVATE ROW"'
  });
  const configPath = await writeConfig(root, [account]);
  const result = runCli(reportArgs(configPath, outputDir));
  assert.equal(result.status, 4, result.stderr);
  assert.equal((await readdir(outputDir)).length, 0);
  assertNoPrivateMarker(result, [
    "SYNTHETIC TRUNCATED PRIVATE ROW", configPath, account.inputManifest,
    account.customerId
  ]);
});

test("report rejects explicit connector failure and partial flags with no output", async (t) => {
  const base = {
    result: {
      columns: REQUIRED_COLUMNS,
      data: [[
        "SYNTHETIC-FLAG-LEAD", "MESSAGE", "CONSUMER", "SMS", null,
        "2026-01-30T12:00:00Z", "SYNTHETIC-FLAG-MESSAGE"
      ]]
    }
  };
  for (const [scope, flag] of [
    ["root", "isError"],
    ["root", "partial"],
    ["wrapper", "isError"],
    ["wrapper", "partial"]
  ]) {
    await t.test(`${scope}-${flag}`, async (st) => {
      const { root, outputDir } = await privateWorkspace(st);
      const payload = structuredClone(base);
      const marker = `SYNTHETIC-${scope}-${flag}-PRIVATE`;
      const target = scope === "root" ? payload : payload.result;
      target[flag] = true;
      target.detail = marker;
      const account = await writeAccount(root, {
        key: "example-heating",
        name: "Example Heating",
        customerId: "1000000001",
        timeZone: "America/New_York",
        pageSource: JSON.stringify(payload)
      });
      const configPath = await writeConfig(root, [account]);
      const result = runCli(reportArgs(configPath, outputDir));
      assert.equal(result.status, 4);
      assert.equal(result.stdout, "");
      assert.deepEqual(await readdir(outputDir), []);
      assertNoPrivateMarker(result, [marker, account.customerId]);
    });
  }
});

test("report rejects duplicate page members and unresolved response tokens with no output", async (t) => {
  const base = JSON.stringify({
    result: { columns: REQUIRED_COLUMNS, data: [] }
  });
  const cases = [
    base.replace(
      "{",
      '{"truncated":true,"truncated":false,'
    ),
    JSON.stringify({
      result: { columns: REQUIRED_COLUMNS, data: [] },
      nextPageToken: "SYNTHETIC-UNDRAINED-ROOT-TOKEN"
    }),
    JSON.stringify({
      result: {
        columns: REQUIRED_COLUMNS,
        data: [],
        next_page_token: "SYNTHETIC-UNDRAINED-WRAPPER-TOKEN"
      }
    })
  ];

  for (const [index, pageSource] of cases.entries()) {
    await t.test(`case-${index + 1}`, async (st) => {
      const { root, outputDir } = await privateWorkspace(st);
      const account = await writeAccount(root, {
        key: "example-heating",
        name: "Example Heating",
        customerId: "1000000001",
        timeZone: "America/New_York",
        pageSource
      });
      const configPath = await writeConfig(root, [account]);
      const result = runCli(reportArgs(configPath, outputDir));
      assert.equal(result.status, 4);
      assert.equal(result.stdout, "");
      assert.deepEqual(await readdir(outputDir), []);
      assertNoPrivateMarker(result, [
        "SYNTHETIC-UNDRAINED-ROOT-TOKEN",
        "SYNTHETIC-UNDRAINED-WRAPPER-TOKEN",
        account.customerId
      ]);
    });
  }
});

test("report maps unsupported connector capability to exit 3 without output", async (t) => {
  const noMessageColumns = REQUIRED_COLUMNS.slice(0, -1);
  const cases = [
    {
      name: "aggregate-columns",
      pageSource: JSON.stringify({
        result: { columns: ["campaign.id", "metrics.clicks"], data: [["1", 2]] }
      }),
      overrides: {}
    },
    {
      name: "unsupported-envelope",
      pageSource: JSON.stringify({
        aggregates: [{ private: "SYNTHETIC-UNSUPPORTED-PRIVATE" }]
      }),
      overrides: {}
    },
    {
      name: "message-text-unavailable",
      pageSource: JSON.stringify({ result: { columns: noMessageColumns, data: [] } }),
      overrides: {
        privacy: {
          includeLeadIds: false,
          includeMessageText: true,
          messageSnippetCharacters: 120
        }
      }
    }
  ];

  for (const item of cases) {
    await t.test(item.name, async (st) => {
      const { root, outputDir } = await privateWorkspace(st);
      const account = await writeAccount(root, {
        key: "example-heating",
        name: "Example Heating",
        customerId: "1000000001",
        timeZone: "America/New_York",
        pageSource: item.pageSource,
        format: "auto"
      });
      const configPath = await writeConfig(root, [account], item.overrides);
      const result = runCli(reportArgs(configPath, outputDir));
      assert.equal(result.status, 3);
      assert.equal(result.stdout, "");
      assert.deepEqual(await readdir(outputDir), []);
      assertNoPrivateMarker(result, [
        "campaign.id", "SYNTHETIC-UNSUPPORTED-PRIVATE", account.customerId
      ]);
    });
  }
});

test("report maps duplicate configuration JSON to fixed exit 2", async (t) => {
  const { root, outputDir } = await privateWorkspace(t);
  const account = await writeAccount(root, {
    key: "example-heating",
    name: "Example Heating",
    customerId: "1000000001",
    timeZone: "America/New_York",
    pageSource: JSON.stringify({ result: { columns: REQUIRED_COLUMNS, data: [] } })
  });
  const configPath = await writeConfig(root, [account]);
  const source = await readFile(configPath, "utf8");
  await writeFile(configPath, source.replace(
    '"windowDays": 30',
    '"windowDays": 1,\n  "\\u0077indowDays": 30'
  ), { mode: 0o600 });

  const result = runCli(reportArgs(configPath, outputDir));
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Configuration must be readable valid JSON.\n");
  assert.deepEqual(await readdir(outputDir), []);
});

test("incomplete multi-account input creates no output container or partial first account", async (t) => {
  const { root } = await privateWorkspace(t);
  const missingOutput = path.join(root, "not-created");
  const accounts = [
    await writeAccount(root, {
      key: "example-heating",
      name: "Example Heating",
      customerId: "1000000001",
      timeZone: "America/New_York",
      pageSource: await fixture("normal-columns.json")
    }),
    await writeAccount(root, {
      key: "example-plumbing",
      name: "Example Plumbing",
      customerId: "1000000002",
      timeZone: "America/Los_Angeles",
      pageSource: '{"result":"SYNTHETIC SECOND ACCOUNT TRUNCATION"'
    })
  ];
  const configPath = await writeConfig(root, accounts);
  const result = runCli(reportArgs(configPath, missingOutput));
  assert.equal(result.status, 4, result.stderr);
  await assert.rejects(lstat(missingOutput), (error) => error.code === "ENOENT");
  assertNoPrivateMarker(result, [
    "SYNTHETIC SECOND ACCOUNT TRUNCATION",
    accounts[0].customerId,
    accounts[1].customerId
  ]);
});

test("valid no-activity input succeeds without fabricating a percentage", async (t) => {
  const { root, outputDir } = await privateWorkspace(t);
  const account = await writeAccount(root, {
    key: "example-plumbing",
    name: "Example Plumbing",
    customerId: "1000000002",
    timeZone: "America/New_York",
    pageSource: await fixture("no-activity.json")
  });
  const configPath = await writeConfig(root, [account]);
  const result = runCli(reportArgs(configPath, outputDir));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await readdir(outputDir)).sort(), ["history.json", "report"]);
  const html = await readFile(path.join(outputDir, "report/report.html"), "utf8");
  const summary = JSON.parse(
    await readFile(path.join(outputDir, "report/summary.json"), "utf8")
  );
  assert.match(html, /No eligible activity/);
  assert.equal(summary.accounts[0].rates.totalResponsiveness, null);
  assert.equal((await stat(path.join(outputDir, "history.json"))).mode & 0o777, 0o600);
});

test("report creates only the requested final private output container", async (t) => {
  const { root } = await privateWorkspace(t);
  const outputDir = path.join(root, "created-output");
  const account = await writeAccount(root, {
    key: "example-plumbing",
    name: "Example Plumbing",
    customerId: "1000000002",
    timeZone: "UTC",
    pageSource: await fixture("no-activity.json")
  });
  const configPath = await writeConfig(root, [account]);
  const result = runCli(reportArgs(configPath, outputDir));
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await stat(outputDir)).mode & 0o777, 0o700);
  assert.deepEqual((await readdir(outputDir)).sort(), ["history.json", "report"]);
});

test("report normalizes created directories under a restrictive inherited umask", async (t) => {
  if (process.platform === "win32") t.skip("POSIX mode test");
  const cases = [
    { preexistingOutput: false, historyEnabled: false },
    { preexistingOutput: true, historyEnabled: false },
    { preexistingOutput: false, historyEnabled: true },
    { preexistingOutput: true, historyEnabled: true }
  ];

  for (const item of cases) {
    const label = `${item.preexistingOutput ? "existing" : "missing"}-output-` +
      `${item.historyEnabled ? "history" : "no-history"}`;
    await t.test(label, async (st) => {
      const { root, outputDir: existingOutput } = await privateWorkspace(st);
      const outputDir = item.preexistingOutput
        ? existingOutput
        : path.join(root, "created-output");
      let historyDirectory;
      const history = item.historyEnabled
        ? { enabled: true, path: "../separate-history/history.json" }
        : { enabled: false, path: "unused-history.json" };
      if (item.historyEnabled) {
        historyDirectory = path.join(root, "separate-history");
        await mkdir(historyDirectory, { mode: 0o700 });
      }
      const account = await writeAccount(root, {
        key: "example-plumbing",
        name: "Example Plumbing",
        customerId: "1000000002",
        timeZone: "UTC",
        pageSource: await fixture("no-activity.json")
      });
      const configPath = await writeConfig(root, [account], { history });
      const result = runCliWithRestrictiveUmask(
        reportArgs(configPath, outputDir)
      );

      assert.equal(result.status, 0, result.stderr);
      assert.equal((await stat(outputDir)).mode & 0o777, 0o700);
      await assertReportBundleModes(path.join(outputDir, "report"));
      if (item.historyEnabled) {
        assert.deepEqual(await readdir(outputDir), ["report"]);
        assert.deepEqual(await readdir(historyDirectory), ["history.json"]);
        assert.equal(
          (await stat(path.join(historyDirectory, "history.json"))).mode & 0o777,
          0o600
        );
      } else {
        assert.deepEqual(await readdir(outputDir), ["report"]);
      }
      await assertNoTransactionResidue(root);
    });
  }
});

test("output-container chmod failure removes only the retained empty creation", async (t) => {
  if (process.platform === "win32") t.skip("POSIX mode test");
  const { root } = await privateWorkspace(t);
  const outputDir = path.join(root, "created-output");
  const account = await writeAccount(root, {
    key: "example-plumbing",
    name: "Example Plumbing",
    customerId: "1000000002",
    timeZone: "UTC",
    pageSource: await fixture("no-activity.json")
  });
  const configPath = await writeConfig(root, [account], {
    history: { enabled: false, path: "unused-history.json" }
  });
  const originalChmod = fsPromises.chmod;
  let attempts = 0;

  fsPromises.chmod = async (candidate, ...args) => {
    if (candidate === outputDir) {
      attempts += 1;
      throw new Error("SYNTHETIC OUTPUT CONTAINER CHMOD FAILURE");
    }
    return originalChmod(candidate, ...args);
  };
  syncBuiltinESMExports();

  let result;
  try {
    result = await runInjectedReport(
      reportArgs(configPath, outputDir),
      writeReportTransaction
    );
  } finally {
    fsPromises.chmod = originalChmod;
    syncBuiltinESMExports();
  }

  assert.equal(attempts, 1);
  assert.equal(result.status, 5);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Output container could not be created.\n");
  await assert.rejects(lstat(outputDir), { code: "ENOENT" });
});

test("an output container substituted during chmod is rejected and never deleted", async (t) => {
  if (process.platform === "win32") t.skip("POSIX mode test");
  const { root } = await privateWorkspace(t);
  const outputDir = path.join(root, "created-output");
  const displaced = path.join(root, "displaced-output");
  const markerPath = path.join(outputDir, "foreign.txt");
  const account = await writeAccount(root, {
    key: "example-plumbing",
    name: "Example Plumbing",
    customerId: "1000000002",
    timeZone: "UTC",
    pageSource: await fixture("no-activity.json")
  });
  const configPath = await writeConfig(root, [account], {
    history: { enabled: false, path: "unused-history.json" }
  });
  const originalChmod = fsPromises.chmod;
  let substituted = false;

  fsPromises.chmod = async (candidate, mode, ...args) => {
    if (candidate === outputDir && !substituted) {
      substituted = true;
      await rename(outputDir, displaced);
      await mkdir(outputDir, { mode: 0o700 });
      await writeFile(markerPath, "SYNTHETIC FOREIGN CONTAINER BYTES\n", {
        mode: 0o600
      });
    }
    return originalChmod(candidate, mode, ...args);
  };
  syncBuiltinESMExports();

  let result;
  try {
    result = await runInjectedReport(
      reportArgs(configPath, outputDir),
      writeReportTransaction
    );
  } finally {
    fsPromises.chmod = originalChmod;
    syncBuiltinESMExports();
  }

  assert.equal(substituted, true);
  assert.equal(result.status, 5);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Output container could not be created.\n");
  assert.equal((await lstat(displaced)).isDirectory(), true);
  assert.equal((await lstat(outputDir)).isDirectory(), true);
  assert.equal(
    await readFile(markerPath, "utf8"),
    "SYNTHETIC FOREIGN CONTAINER BYTES\n"
  );
});

test("report removes only its newly created empty container after pre-commit failure", async (t) => {
  const { root, outputDir: existingOutput } = await privateWorkspace(t);
  const account = await writeAccount(root, {
    key: "example-plumbing",
    name: "Example Plumbing",
    customerId: "1000000002",
    timeZone: "UTC",
    pageSource: await fixture("no-activity.json")
  });
  const configPath = await writeConfig(root, [account], {
    history: { enabled: true, path: "../missing-history-parent/history.json" }
  });

  const createdOutput = path.join(root, "created-output");
  const createdResult = runCli(reportArgs(configPath, createdOutput));
  assert.equal(createdResult.status, 5);
  assert.equal(createdResult.stderr, "Report and history could not be written.\n");
  await assert.rejects(lstat(createdOutput), (error) => error.code === "ENOENT");

  const existingResult = runCli(reportArgs(configPath, existingOutput));
  assert.equal(existingResult.status, 5);
  assert.deepEqual(await readdir(existingOutput), []);
});

test("report preserves substituted and nonempty created containers on failure", async (t) => {
  for (const mode of ["substituted", "nonempty"]) {
    await t.test(mode, async (st) => {
      const { root } = await privateWorkspace(st);
      const outputDir = path.join(root, `created-${mode}`);
      const historyDir = path.join(root, `history-${mode}`);
      await mkdir(historyDir, { mode: 0o700 });
      const account = await writeAccount(root, {
        key: "example-plumbing",
        name: "Example Plumbing",
        customerId: "1000000002",
        timeZone: "UTC",
        pageSource: await fixture("no-activity.json")
      });
      const configPath = await writeConfig(root, [account], {
        history: { enabled: true, path: `../history-${mode}/history.json` }
      });
      const displaced = path.join(root, `displaced-${mode}`);
      const markerPath = path.join(outputDir, "foreign.txt");
      const transaction = _createReportTransactionForTests({
        checkpoint: async (name) => {
          if (name !== "after-history-stage") return;
          if (mode === "substituted") {
            await rename(outputDir, displaced);
            await mkdir(outputDir, { mode: 0o700 });
          } else {
            await writeFile(markerPath, "SYNTHETIC FOREIGN CONTAINER BYTES\n", {
              mode: 0o600
            });
          }
          throw new Error("SYNTHETIC PRE-COMMIT FAILURE");
        }
      });

      const result = await runInjectedReport(
        reportArgs(configPath, outputDir),
        transaction
      );
      assert.equal(result.status, 5);
      assert.equal(result.stderr, "Report and history could not be written.\n");
      assert.equal((await lstat(outputDir)).isDirectory(), true);
      if (mode === "substituted") {
        assert.equal((await lstat(displaced)).isDirectory(), true);
        assert.deepEqual(await readdir(outputDir), []);
      } else {
        assert.equal(
          await readFile(markerPath, "utf8"),
          "SYNTHETIC FOREIGN CONTAINER BYTES\n"
        );
      }
    });
  }
});

test("report never removes a created container after joint commit", async (t) => {
  const { root } = await privateWorkspace(t);
  const outputDir = path.join(root, "created-postcommit");
  const historyDir = path.join(root, "history-postcommit");
  const historyPath = path.join(historyDir, "history.json");
  await mkdir(historyDir, { mode: 0o700 });
  await writeHistoryAtomic(historyPath, { schemaVersion: 1, points: [] });
  const account = await writeAccount(root, {
    key: "example-plumbing",
    name: "Example Plumbing",
    customerId: "1000000002",
    timeZone: "UTC",
    pageSource: await fixture("no-activity.json")
  });
  const configPath = await writeConfig(root, [account], {
    history: { enabled: true, path: "../history-postcommit/history.json" }
  });
  const transaction = _createReportTransactionForTests({
    checkpoint: async (name) => {
      if (name === "before-history-backup-cleanup") {
        throw new Error("SYNTHETIC POST-COMMIT FAILURE");
      }
    }
  });

  const result = await runInjectedReport(
    reportArgs(configPath, outputDir),
    transaction
  );
  assert.equal(result.status, 5);
  assert.equal(result.stderr, "Report and history could not be written.\n");
  assert.deepEqual((await readdir(outputDir)).sort(), ["report"]);
  assert.deepEqual((await readdir(path.join(outputDir, "report"))).sort(), [
    "report-manifest.json",
    "report.html",
    "summary.json"
  ]);
});

test("report isolates accounts, time zones, IDs, and diagnostics", async (t) => {
  const { root, outputDir } = await privateWorkspace(t);
  const accounts = [
    await writeAccount(root, {
      key: "example-heating",
      name: "Example Heating",
      customerId: "1000000001",
      timeZone: "America/New_York",
      pageSource: await fixture("normal-columns.json")
    }),
    await writeAccount(root, {
      key: "example-plumbing",
      name: "Example Plumbing",
      customerId: "1000000002",
      timeZone: "America/Los_Angeles",
      pageSource: await fixture("no-activity.json")
    })
  ];
  const configPath = await writeConfig(root, accounts);
  const result = runCli(reportArgs(configPath, outputDir));
  assert.equal(result.status, 0, result.stderr);

  const summarySource = await readFile(
    path.join(outputDir, "report/summary.json"), "utf8"
  );
  const summary = JSON.parse(summarySource);
  assert.deepEqual(summary.accounts.map(({ key, timeZone }) => ({ key, timeZone })), [
    { key: "example-heating", timeZone: "America/New_York" },
    { key: "example-plumbing", timeZone: "America/Los_Angeles" }
  ]);
  assert.equal(summary.accounts[0].counts.totalEligible, 10);
  assert.equal(summary.accounts[1].counts.totalEligible, 0);
  assert.deepEqual(summary.accounts[0].diagnostics, {
    incompleteWindowLeads: 1,
    bookingLeads: 1,
    unsupportedLeadTypes: 1
  });
  for (const customerId of accounts.map(({ customerId }) => customerId)) {
    assert.equal(summarySource.includes(customerId), false);
  }
  assert.equal(summarySource.includes("SYNTHETIC MESSAGE: request alpha"), false);

  const historyPath = path.join(outputDir, "history.json");
  const history = JSON.parse(await readFile(historyPath, "utf8"));
  assert.equal(history.points.length, 2);
  assert.deepEqual(history.points[0].diagnostics, {
    incompleteWindowLeads: 1,
    bookingLeads: 1,
    unsupportedLeadTypes: 1
  });
  assert.equal(JSON.stringify(history).includes("excludedLeadTypes"), false);

  const rerun = runCli(reportArgs(configPath, outputDir));
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(
    JSON.parse(await readFile(historyPath, "utf8")).points.length,
    2
  );
});

test("report carries validated pagination pageCount without paths or tokens", async (t) => {
  const { root, outputDir } = await privateWorkspace(t);
  const account = {
    key: "example-heating",
    name: "Example Heating",
    customerId: "1000000001",
    timeZone: "America/Chicago",
    inputManifest: path.join(fixtureRoot, "pagination/manifest.json")
  };
  const configPath = await writeConfig(root, [account], {
    asOf: "2026-01-31T12:00:00-06:00",
    windowDays: 30
  });
  const result = runCli(reportArgs(configPath, outputDir));
  assert.equal(result.status, 0, result.stderr);
  const summarySource = await readFile(
    path.join(outputDir, "report/summary.json"), "utf8"
  );
  const accountSummary = JSON.parse(summarySource).accounts[0];
  assert.deepEqual(accountSummary.completion, {
    method: "all-page-tokens-consumed",
    pageCount: 2
  });
  assert.equal(accountSummary.capability.pagination, "paginated");
  assert.equal(summarySource.includes("SYNTHETIC-PAGE-2-TOKEN"), false);
  assert.equal(summarySource.includes("page-1.json"), false);
  assert.equal(summarySource.includes(account.customerId), false);
});

test("a configured history path remains separate from the nested report bundle", async (t) => {
  const { root, outputDir } = await privateWorkspace(t);
  const historyDirectory = path.join(root, "aggregate-history");
  await mkdir(historyDirectory, { mode: 0o700 });
  const account = await writeAccount(root, {
    key: "example-plumbing",
    name: "Example Plumbing",
    customerId: "1000000002",
    timeZone: "UTC",
    pageSource: await fixture("no-activity.json")
  });
  const configPath = await writeConfig(root, [account], {
    history: { enabled: true, path: "../aggregate-history/history.json" }
  });
  const result = runCli(reportArgs(configPath, outputDir));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readdir(outputDir), ["report"]);
  assert.equal(
    JSON.parse(await readFile(
      path.join(historyDirectory, "history.json"), "utf8"
    )).points.length,
    1
  );
});

test("message text is retained only when explicitly enabled", async (t) => {
  const { root, outputDir } = await privateWorkspace(t);
  const account = await writeAccount(root, {
    key: "example-heating",
    name: "Example Heating",
    customerId: "1000000001",
    timeZone: "America/New_York",
    pageSource: await fixture("normal-columns.json")
  });
  const configPath = await writeConfig(root, [account], {
    privacy: {
      includeLeadIds: false,
      includeMessageText: true,
      messageSnippetCharacters: 24
    },
    output: { writeActionCsv: true }
  });
  const result = runCli(reportArgs(configPath, outputDir));
  assert.equal(result.status, 0, result.stderr);
  const summarySource = await readFile(
    path.join(outputDir, "report/summary.json"), "utf8"
  );
  assert.match(summarySource, /SYNTHETIC MESSAGE: recen/);
  assert.equal(summarySource.includes("SYNTHETIC MESSAGE: recent unanswered"), false);
  assert.equal(summarySource.includes("900000000005"), false);
  assert.deepEqual((await readdir(path.join(outputDir, "report"))).sort(), [
    "recent-unanswered.csv",
    "report-manifest.json",
    "report.html",
    "summary.json"
  ]);
});

test("history disabled writes only the nested report bundle", async (t) => {
  const { root, outputDir } = await privateWorkspace(t);
  const account = await writeAccount(root, {
    key: "example-plumbing",
    name: "Example Plumbing",
    customerId: "1000000002",
    timeZone: "UTC",
    pageSource: await fixture("no-activity.json")
  });
  const configPath = await writeConfig(root, [account], {
    history: { enabled: false, path: "unused-history.json" }
  });
  const result = runCli(reportArgs(configPath, outputDir));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readdir(outputDir), ["report"]);
});

test("history inside the report subtree is rejected before any write", async (t) => {
  const { root, outputDir } = await privateWorkspace(t);
  const account = await writeAccount(root, {
    key: "example-plumbing",
    name: "Example Plumbing",
    customerId: "1000000002",
    timeZone: "UTC",
    pageSource: await fixture("no-activity.json")
  });
  const configPath = await writeConfig(root, [account], {
    history: { enabled: true, path: "report/history.json" }
  });
  const result = runCli(reportArgs(configPath, outputDir));
  assert.equal(result.status, 2);
  assert.deepEqual(await readdir(outputDir), []);
});

test("unsafe output creation returns exit 5 and preserves unrelated bytes", async (t) => {
  const { root } = await privateWorkspace(t);
  const destination = path.join(root, "existing");
  await mkdir(destination, { mode: 0o700 });
  await writeFile(path.join(destination, "unrelated"), "SYNTHETIC UNRELATED", {
    mode: 0o600
  });
  const result = runCli(["demo", "--output-dir", destination]);
  assert.equal(result.status, 5);
  assert.equal(
    await readFile(path.join(destination, "unrelated"), "utf8"),
    "SYNTHETIC UNRELATED"
  );
});

test("report refuses a public-package output container before creating it", async (t) => {
  const { root } = await privateWorkspace(t);
  const destination = path.join(
    packageRoot,
    "examples",
    `.task10-forbidden-output-${process.pid}`
  );
  t.after(async () => rm(destination, { recursive: true, force: true }));
  const account = await writeAccount(root, {
    key: "example-plumbing",
    name: "Example Plumbing",
    customerId: "1000000002",
    timeZone: "UTC",
    pageSource: await fixture("no-activity.json")
  });
  const configPath = await writeConfig(root, [account]);
  const result = runCli(reportArgs(configPath, destination));
  assert.equal(result.status, 2);
  await assert.rejects(lstat(destination), (error) => error.code === "ENOENT");
});

test("unexpected failures are sanitized with and without debug mode", async () => {
  const marker = "PRIVATE-UNEXPECTED-ROW-VALUE";
  const stackPath = "/synthetic/local/debug/path.js";
  const failure = new Error(marker);
  failure.stack = `Error: ${marker}\n    at synthetic (${stackPath}:1:2)`;
  const handlers = {
    demo: async () => { throw failure; },
    probe: async () => {},
    report: async () => {}
  };
  for (const debugEnabled of [false, true]) {
    const stdout = [];
    const stderr = [];
    const injectedMain = _createMainForTests({ handlers, debugEnabled });
    const status = await injectedMain([
      "demo", "--output-dir", "/synthetic/output"
    ], {
      out: (value) => stdout.push(String(value)),
      err: (value) => stderr.push(String(value))
    });
    assert.equal(status, 1);
    assert.match(stderr.join("\n"), /Unexpected internal failure\./);
    assert.equal(stderr.join("\n").includes(marker), false);
    assert.equal(stdout.length, 0);
    assert.equal(stderr.join("\n").includes(stackPath), debugEnabled);
  }
});
