import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolveColumns } from "../src/columns.js";

const fixtureRoot = new URL("./fixtures/synthetic/", import.meta.url);

async function loadFixture(name) {
  return JSON.parse(await readFile(new URL(name, fixtureRoot), "utf8"));
}

const expectedRequired = {
  leadId: 0,
  leadType: 1,
  participantType: 2,
  conversationChannel: 3,
  callDurationMillis: 4,
  eventDateTime: 5,
  messageText: null
};

test("resolves only the exact snake_case aliases", async () => {
  const payload = await loadFixture("columns-snake.json");
  assert.deepEqual(resolveColumns(payload.columns), expectedRequired);
});

test("resolves only the exact camelCase aliases", async () => {
  const payload = await loadFixture("columns-camel.json");
  assert.deepEqual(resolveColumns(payload.columns), { ...expectedRequired, messageText: 6 });
});

test("rejects duplicate aliases for one canonical field", async () => {
  const payload = await loadFixture("columns-snake.json");
  assert.throws(
    () => resolveColumns([...payload.columns, "localServicesLead.id"]),
    /Multiple columns resolve to leadId/
  );
});

test("rejects a missing required field without treating a similar name as an alias", async () => {
  const payload = await loadFixture("missing-column.json");
  assert.throws(
    () => resolveColumns([...payload.columns, "localServicesLeadConversation.eventDatetime"]),
    /Required field eventDateTime is unavailable/
  );
});

test("requires message text only when the caller explicitly requests it", async () => {
  const payload = await loadFixture("columns-snake.json");
  assert.throws(() => resolveColumns(payload.columns, { requireMessageText: true }),
    /Required field messageText is unavailable/);
});
