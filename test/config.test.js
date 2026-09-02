import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, validateTimeZone } from "../src/config.js";
import { UsageError } from "../src/errors.js";

function validConfig() {
  return {
    schemaVersion: 1,
    asOf: "2026-01-31T12:00:00-06:00",
    windowDays: 90,
    accounts: [{
      key: "example-heating",
      name: "Example Heating",
      customerId: "1000000001",
      timeZone: "America/Chicago",
      inputManifest: "private/example-heating.manifest.json"
    }]
  };
}

async function loadFixture(config, outputDirName = "reports") {
  const root = await mkdtemp(path.join(os.tmpdir(), "lsa-config-"));
  const configPath = path.join(root, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  return loadConfig(configPath, path.join(root, outputDirName));
}

async function loadRawFixture(source, outputDirName = "reports") {
  const root = await mkdtemp(path.join(os.tmpdir(), "lsa-config-raw-"));
  const configPath = path.join(root, "config.json");
  await writeFile(configPath, source);
  return loadConfig(configPath, path.join(root, outputDirName));
}

test("resolves manifests from config directory and history from output directory", async () => {
  const config = await loadFixture(validConfig());
  const configDir = path.dirname(config.configPath);
  assert.equal(config.accounts[0].inputManifest,
    path.join(configDir, "private/example-heating.manifest.json"));
  assert.equal(config.history.path, path.join(config.outputDir, "history.json"));
  assert.equal(config.privacy.includeMessageText, false);
  assert.equal(config.output.writeActionCsv, false);
});

test("rejects numeric customer IDs before they lose precision", async () => {
  const config = validConfig();
  config.accounts[0].customerId = 1000000001;
  await assert.rejects(loadFixture(config), /customerId/);
});

test("rejects a configuration with an unsupported schema version", async () => {
  const config = validConfig();
  config.schemaVersion = 2;
  await assert.rejects(loadFixture(config), /schemaVersion/);
});

test("rejects duplicate decoded configuration members with fixed usage errors", async () => {
  const base = JSON.stringify(validConfig());
  const cases = [
    base.replace('"windowDays":90', '"windowDays":1,"windowDays":90'),
    base.replace(
      '"name":"Example Heating"',
      '"name":"Synthetic Shadow","name":"Example Heating"'
    ),
    base.replace('"windowDays":90', '"windowDays":1,"\\u0077indowDays":90')
  ];

  for (const source of cases) {
    await assert.rejects(loadRawFixture(source), (error) => {
      assert.ok(error instanceof UsageError);
      assert.equal(error.exitCode, 2);
      assert.equal(error.message, "Configuration must be readable valid JSON.");
      assert.equal(error.message.includes("Synthetic Shadow"), false);
      return true;
    });
  }
});

test("rejects asOf timestamps without an explicit offset", async () => {
  const config = validConfig();
  config.asOf = "2026-01-31T12:00:00";
  await assert.rejects(loadFixture(config), /asOf/);
});

test("rejects malformed asOf values that merely end in Z", async () => {
  const config = validConfig();
  config.asOf = "not-a-timestampZ";
  await assert.rejects(loadFixture(config), /asOf/);
});

test("rejects impossible offset-bearing asOf calendar and time components", async () => {
  const config = validConfig();
  config.asOf = "2026-99-99T99:99:99-06:00";
  await assert.rejects(loadFixture(config), /asOf/);
});

test("rejects a non-integer windowDays value", async () => {
  const config = validConfig();
  config.windowDays = 90.5;
  await assert.rejects(loadFixture(config), /windowDays/);
});

test("rejects an empty accounts list", async () => {
  const config = validConfig();
  config.accounts = [];
  await assert.rejects(loadFixture(config), /accounts/);
});

test("rejects account keys outside lowercase hyphen-case", async () => {
  const config = validConfig();
  config.accounts[0].key = "Example_Heating";
  await assert.rejects(loadFixture(config), /accounts\[0\]\.key/);
});

test("rejects duplicate account keys after exact string validation", async () => {
  const config = validConfig();
  config.accounts.push({ ...config.accounts[0], name: "Example Plumbing" });
  await assert.rejects(loadFixture(config), /accounts\[1\]\.key/);
});

test("rejects blank account names", async () => {
  const config = validConfig();
  config.accounts[0].name = " ";
  await assert.rejects(loadFixture(config), /accounts\[0\]\.name/);
});

test("rejects customer IDs that are not exactly ten string digits", async () => {
  const config = validConfig();
  config.accounts[0].customerId = "100000001";
  await assert.rejects(loadFixture(config), /customerId/);
});

test("rejects an account with an invalid IANA time zone", async () => {
  const config = validConfig();
  config.accounts[0].timeZone = "Not/AZone";
  await assert.rejects(loadFixture(config), /timeZone/);
});

test("validates IANA time zones without rejecting a supported zone", () => {
  for (const zone of ["America/Chicago", "UTC", "US/Eastern", "Etc/GMT+5"]) {
    assert.equal(validateTimeZone(zone), true);
  }
  assert.equal(validateTimeZone("Not/AZone"), false);
});

test("rejects ASCII and Unicode-sign numeric account time zones", async () => {
  for (const zone of ["+05:00", "-03:30", "−05:00"]) {
    assert.equal(validateTimeZone(zone), false);
    const config = validConfig();
    config.accounts[0].timeZone = zone;
    await assert.rejects(loadFixture(config), /accounts\[0\]\.timeZone/);
  }
});

test("rejects an empty account inputManifest path", async () => {
  const config = validConfig();
  config.accounts[0].inputManifest = "";
  await assert.rejects(loadFixture(config), /inputManifest/);
});

test("rejects display.goodThreshold outside the inclusive percentage range", async () => {
  const config = validConfig();
  config.display = { goodThreshold: 101 };
  await assert.rejects(loadFixture(config), /display\.goodThreshold/);
});

test("rejects display.midThreshold when it is not finite", async () => {
  const config = validConfig();
  config.display = { midThreshold: "75" };
  await assert.rejects(loadFixture(config), /display\.midThreshold/);
});

test("rejects display thresholds when good is below mid", async () => {
  const config = validConfig();
  config.display = { goodThreshold: 74, midThreshold: 75 };
  await assert.rejects(loadFixture(config), /display\.goodThreshold/);
});

test("rejects a non-boolean privacy.includeLeadIds", async () => {
  const config = validConfig();
  config.privacy = { includeLeadIds: "true" };
  await assert.rejects(loadFixture(config), /privacy\.includeLeadIds/);
});

test("rejects a non-boolean privacy.includeMessageText", async () => {
  const config = validConfig();
  config.privacy = { includeMessageText: 0 };
  await assert.rejects(loadFixture(config), /privacy\.includeMessageText/);
});

test("rejects privacy.messageSnippetCharacters outside its integer range", async () => {
  const config = validConfig();
  config.privacy = { messageSnippetCharacters: 0 };
  await assert.rejects(loadFixture(config), /privacy\.messageSnippetCharacters/);
});

test("rejects a non-boolean output.writeActionCsv", async () => {
  const config = validConfig();
  config.output = { writeActionCsv: "false" };
  await assert.rejects(loadFixture(config), /output\.writeActionCsv/);
});

test("rejects a non-boolean history.enabled", async () => {
  const config = validConfig();
  config.history = { enabled: 1 };
  await assert.rejects(loadFixture(config), /history\.enabled/);
});

test("rejects an unsupported timestamps.dstDisambiguation value", async () => {
  const config = validConfig();
  config.timestamps = { dstDisambiguation: "nearest" };
  await assert.rejects(loadFixture(config), /timestamps\.dstDisambiguation/);
});

test("rejects unknown top-level keys instead of silently defaulting them", async () => {
  const config = validConfig();
  config.priavcy = { includeMessageText: true };
  await assert.rejects(loadFixture(config), /priavcy/);
});

test("rejects unknown nested keys instead of silently defaulting them", async () => {
  const config = validConfig();
  config.privacy = { includeMessageTexts: true };
  await assert.rejects(loadFixture(config), /privacy\.includeMessageTexts/);
});

test("rejects unknown account keys instead of passing private values through", async () => {
  const config = validConfig();
  config.accounts[0].customerID = "1000000001";
  await assert.rejects(loadFixture(config), /accounts\[0\]\.customerID/);
});
