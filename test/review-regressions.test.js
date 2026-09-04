import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ingestAccount } from "../src/ingest.js";
import { FIELD_ALIASES } from "../src/columns.js";
import { formatDuration, formatContactTime } from "../src/format-time.js";
import { runCli } from "./helpers/run-cli.js";

const fields = Object.values(FIELD_ALIASES).map((aliases) => aliases[0]);
const asOf = "2026-01-31T12:00:00Z";
const row = (duration = "2000") => ({
  localServicesLead: { id: "900000000001", leadType: "PHONE_CALL",
    resourceName: "customers/1000000001/localServicesLeads/900000000001" },
  localServicesLeadConversation: { participantType: "CONSUMER",
    conversationChannel: "PHONE_CALL", eventDateTime: "2026-01-30T12:00:00Z",
    phoneCallDetails: { callDurationMillis: duration } }
});

async function workspace(t, payloads, { source = { customerId: "1000000001", selectedFields: fields }, format = "google-ads-results" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lsa-regression-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pages = payloads.map((_, i) => ({ path: `page-${i}.json`,
    requestToken: i ? `synthetic-${i}` : null,
    nextPageToken: i < payloads.length - 1 ? `synthetic-${i + 1}` : null }));
  for (let i = 0; i < payloads.length; i++) {
    await writeFile(path.join(root, pages[i].path), JSON.stringify(payloads[i]), { mode: 0o600 });
  }
  const manifest = { schemaVersion: 1, format,
    ...(source === null ? {} : { source }),
    completion: { method: "all-page-tokens-consumed" }, pages };
  const manifestPath = path.join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  const account = { key: "example", name: "Example", customerId: "1000000001", timeZone: "UTC", inputManifest: manifestPath };
  const configPath = path.join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, asOf, windowDays: 30, accounts: [account] }), { mode: 0o600 });
  return { root, account, configPath, manifestPath };
}

test("native decimal durations preserve exact safe integers and reject invalid values", async (t) => {
  for (const value of ["0", "1000", "1001", "9007199254740991", 2000, null]) {
    const { account } = await workspace(t, [{ results: [row(value)] }]);
    const data = await ingestAccount(account, { asOf });
    assert.equal(data.events[0].callDurationMillis, value === null ? null : Number(value));
  }
  for (const value of ["-1", "1.5", "1e3", "", " 2", "9007199254740992", true]) {
    const { account } = await workspace(t, [{ results: [row(value)] }]);
    await assert.rejects(ingestAccount(account, { asOf }), /invalid call duration/);
  }
});

test("wrong customer rows fail in CLI without producing a report or leaking identities", async (t) => {
  const bad = row();
  bad.localServicesLead.resourceName = "customers/1000000002/localServicesLeads/900000000001";
  const { root, configPath } = await workspace(t, [{ results: [bad] }]);
  for (const args of [["probe", "--config", configPath], ["report", "--config", configPath, "--output-dir", path.join(root, "out")]]) {
    const result = runCli(args);
    assert.equal(result.status, 4);
    assert.doesNotMatch(result.stdout + result.stderr, /100000000[12]|900000000001/);
  }
  await assert.rejects(access(path.join(root, "out")));
});

test("every page and every returned identity is checked including columns aliases", async (t) => {
  for (const column of ["customer.id", "local_services_lead.resource_name", "localServicesLeadConversation.resourceName"]) {
    const value = column === "customer.id" ? "1000000002" : "customers/1000000002/localServicesLeads/900000000001";
    const columns = [...fields.slice(0, 6), column];
    const values = ["900000000001", "PHONE_CALL", "CONSUMER", "PHONE_CALL", "2000", "2026-01-30T12:00:00Z", value];
    const { account } = await workspace(t, [{ columns, data: [values] }], { format: "columns-data" });
    await assert.rejects(ingestAccount(account, { asOf }), /customer/);
  }
  const bad = row();
  bad.customer = { id: "1000000002" };
  const { account } = await workspace(t, [{ results: [row()], nextPageToken: "synthetic-1" }, { results: [bad] }]);
  await assert.rejects(ingestAccount(account, { asOf }), /customer/);
});

test("unbound rows and contradictory source evidence are rejected", async (t) => {
  const unbound = row();
  delete unbound.localServicesLead.resourceName;
  for (const source of [null, { customerId: "1000000002" }]) {
    const { account } = await workspace(t, [{ results: [unbound] }], { source });
    await assert.rejects(ingestAccount(account, { asOf }), /customer/);
  }
  const { account } = await workspace(t, [{ results: [row()] }], { source: null });
  assert.equal((await ingestAccount(account, { asOf })).events.length, 1);
});

test("config probe consumes a complete token chain, rejecting broken or missing continuation", async (t) => {
  const { configPath, root } = await workspace(t, [{ results: [row()], nextPageToken: "synthetic-1" }, { results: [] }]);
  assert.equal(runCli(["probe", "--config", configPath]).status, 0);
  assert.equal(runCli(["report", "--config", configPath, "--output-dir", path.join(root, "out")]).status, 0);
  await writeFile(path.join(root, "page-1.json"), JSON.stringify({ results: [], nextPageToken: "synthetic-extra" }));
  assert.equal(runCli(["probe", "--config", configPath]).status, 4);
  assert.equal(runCli(["probe", "--config", configPath, "--input", "unused"]).status, 2);
});

test("verified empty native periods produce no-activity reports; missing selection evidence fails", async (t) => {
  const { configPath, root } = await workspace(t, [{ results: [] }]);
  const out = path.join(root, "out");
  assert.equal(runCli(["probe", "--config", configPath]).status, 0);
  assert.equal(runCli(["report", "--config", configPath, "--output-dir", out]).status, 0);
  const summary = JSON.parse(await readFile(path.join(out, "report/summary.json"), "utf8"));
  assert.equal(summary.accounts[0].rates.totalResponsiveness, null);
  const missing = await workspace(t, [{ results: [] }], { source: { customerId: "1000000001" } });
  assert.equal(runCli(["probe", "--config", missing.configPath]).status, 3);
});

test("omitted duration needs query evidence even when other fields are populated", async (t) => {
  const noDuration = row();
  delete noDuration.localServicesLeadConversation.phoneCallDetails;
  const good = await workspace(t, [{ results: [noDuration] }]);
  assert.equal((await ingestAccount(good.account, { asOf })).events[0].callDurationMillis, null);
  const bad = await workspace(t, [{ results: [noDuration] }], { source: { customerId: "1000000001" } });
  await assert.rejects(ingestAccount(bad.account, { asOf }), /selection evidence/);
  const incomplete = await workspace(t, [{ results: [] }], { source: { customerId: "1000000001", selectedFields: fields.filter((f) => !f.includes("call_duration")) } });
  assert.equal(runCli(["probe", "--config", incomplete.configPath]).status, 3);
});

test("human time display rounds only presentation and distinguishes DST offsets", () => {
  assert.equal(formatDuration(null), "No data");
  assert.equal(formatDuration("0"), "0s");
  assert.equal(formatDuration("1.5"), "<0.1s");
  assert.equal(formatDuration("70500000000"), "1m 10.5s");
  assert.equal(formatDuration("59950000000"), "1m 0s");
  assert.equal(formatDuration("90061000000000"), "1d 1h 1m 1s");
  const early = BigInt(Date.parse("2026-11-01T05:30:00Z")) * 1_000_000n;
  const late = early + 3_600_000_000_000n;
  assert.match(formatContactTime(early.toString(), "America/New_York"), /1:30:00 AM EDT/);
  assert.match(formatContactTime(late.toString(), "America/New_York"), /1:30:00 AM EST/);
});
