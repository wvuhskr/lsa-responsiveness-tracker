import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { detectEnvelope, probePayload } from "../src/probe.js";
import { CapabilityError } from "../src/errors.js";

const fixtureRoot = new URL("./fixtures/synthetic/", import.meta.url);

async function loadFixture(name) {
  return JSON.parse(await readFile(new URL(name, fixtureRoot), "utf8"));
}

test("detects the columns-data envelope through an optional result wrapper", async () => {
  const payload = await loadFixture("columns-snake.json");
  assert.equal(detectEnvelope({ result: payload }), "columns-data");
});

test("detects the Google Ads results envelope without accepting unrelated arrays", () => {
  assert.equal(detectEnvelope({ results: [] }), "google-ads-results");
  assert.throws(() => detectEnvelope({ records: [] }), /Unsupported response envelope/);
});

function googleAdsResult() {
  return {
    localServicesLead: {
      id: "SYNTHETIC-OBJECT-LEAD",
      leadType: "MESSAGE"
    },
    localServicesLeadConversation: {
      participantType: "CONSUMER",
      conversationChannel: "SMS",
      phoneCallDetails: { callDurationMillis: null },
      eventDateTime: "2026-01-10 12:00:00.123456",
      messageDetails: { text: "SYNTHETIC-OBJECT-MESSAGE" }
    }
  };
}

function withoutPath(value, path) {
  const copy = structuredClone(value);
  const parent = path.slice(0, -1).reduce((current, key) => current[key], copy);
  delete parent[path.at(-1)];
  return copy;
}

test("rejects empty Google Ads object-results because no schema is declared", () => {
  assert.throws(() => probePayload({ results: [] }), /Google Ads results cannot establish capabilities/);
});

test("rejects Google Ads object-results missing any non-optional nested field", () => {
  const requiredPaths = [
    ["localServicesLead", "id"],
    ["localServicesLead", "leadType"],
    ["localServicesLeadConversation", "participantType"],
    ["localServicesLeadConversation", "conversationChannel"],
    ["localServicesLeadConversation", "eventDateTime"]
  ];

  for (const path of requiredPaths) {
    assert.throws(
      () => probePayload({ results: [withoutPath(googleAdsResult(), path)] }),
      /Google Ads results cannot establish capabilities/
    );
  }
});

test("does not claim duration capability without selection evidence", () => {
  const objectResult = googleAdsResult();
  delete objectResult.localServicesLeadConversation.phoneCallDetails;

  assert.throws(() => probePayload({ results: [objectResult] }), CapabilityError);
});

test("reports observed message-text availability independently of request mode", async () => {
  const present = await loadFixture("columns-camel.json");
  const absent = await loadFixture("columns-snake.json");

  assert.equal(probePayload({ result: present }).requiredFields.messageText, true);
  assert.equal(probePayload({ result: present }, { requireMessageText: true })
    .requiredFields.messageText, true);
  assert.equal(probePayload({ result: absent }).requiredFields.messageText, false);
  assert.throws(() => probePayload({ result: absent }, { requireMessageText: true }),
    /Required field messageText is unavailable/);
});

test("probe output contains capability structure but no synthetic row values", async () => {
  const payload = await loadFixture("columns-camel.json");
  const result = probePayload({ result: payload });

  assert.deepEqual(result, {
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
  });
  assert.equal(JSON.stringify(result).includes("SYNTHETIC-PRIVATE-MESSAGE"), false);
  assert.equal(JSON.stringify(result).includes("SYNTHETIC-LEAD-0001"), false);
});

test("probe errors remain generic when a payload contains sensitive fragments", () => {
  const sensitivePayload = {
    result: {
      columns: ["CUSTOMER-9999999999", "TOOL-NAME", "/private/source.json"],
      data: [["SYNTHETIC-LEAD-SECRET", "SYNTHETIC-MESSAGE-SECRET", "NEXT-TOKEN-SECRET"]]
    }
  };

  assert.throws(() => probePayload(sensitivePayload), (error) => {
    const message = String(error.message);
    return !message.includes("CUSTOMER-9999999999") &&
      !message.includes("SYNTHETIC-LEAD-SECRET") &&
      !message.includes("SYNTHETIC-MESSAGE-SECRET") &&
      !message.includes("NEXT-TOKEN-SECRET") &&
      !message.includes("TOOL-NAME") &&
      !message.includes("/private/source.json");
  });
});
