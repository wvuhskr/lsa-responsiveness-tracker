import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CapabilityError, DataIntegrityError } from "../src/errors.js";
import { ingestAccount } from "../src/ingest.js";

const syntheticRoot = fileURLToPath(new URL("./fixtures/synthetic/", import.meta.url));
const paginationManifest = path.join(syntheticRoot, "pagination/manifest.json");
const AS_OF = "2026-01-31T12:00:00-06:00";

function accountFor(inputManifest = paginationManifest) {
  return {
    key: "example-heating",
    name: "Example Heating",
    customerId: "1000000001",
    timeZone: "America/Chicago",
    inputManifest
  };
}

async function writeInput({
  payload,
  rawPage,
  format = "columns-data",
  completion = {
    method: "connector-complete-saved-result",
    savedResultWasComplete: true
  }
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lsa-ingest-"));
  const pagePath = path.join(root, "page.json");
  const manifestPath = path.join(root, "manifest.json");
  await writeFile(pagePath, rawPage ?? JSON.stringify(payload));
  await writeFile(manifestPath, JSON.stringify({
    schemaVersion: 1,
    format,
    source: { customerId: "1000000001" },
    completion,
    pages: [{ path: "page.json" }]
  }));
  return accountFor(manifestPath);
}

async function writePagedInput({
  payloads,
  pages,
  format = "columns-data",
  completion = { method: "all-page-tokens-consumed" }
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lsa-ingest-pages-"));
  for (let index = 0; index < payloads.length; index += 1) {
    await writeFile(
      path.join(root, `page-${index + 1}.json`),
      typeof payloads[index] === "string"
        ? payloads[index]
        : JSON.stringify(payloads[index])
    );
  }
  const normalizedPages = pages ?? payloads.map((_, index) => ({
    path: `page-${index + 1}.json`,
    requestToken: index === 0 ? null : "SYNTHETIC-PAGE-2-TOKEN",
    nextPageToken: index === payloads.length - 1
      ? null
      : "SYNTHETIC-PAGE-2-TOKEN"
  }));
  await writeFile(path.join(root, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    format,
    completion,
    pages: normalizedPages,
    source: { customerId: "1000000001" }
  }));
  return accountFor(path.join(root, "manifest.json"));
}

function columnsPayload(row, { includeMessageTextColumn = true } = {}) {
  const columns = [
    "localServicesLead.id",
    "localServicesLead.leadType",
    "localServicesLeadConversation.participantType",
    "localServicesLeadConversation.conversationChannel",
    "localServicesLeadConversation.phoneCallDetails.callDurationMillis",
    "localServicesLeadConversation.eventDateTime"
  ];
  if (includeMessageTextColumn) {
    columns.push("localServicesLeadConversation.messageDetails.text");
  }
  return { result: { columns, data: [row] } };
}

function validRow() {
  return [
    "SYNTHETIC-TEMP-LEAD-0001",
    "MESSAGE",
    "CONSUMER",
    "SMS",
    null,
    "2026-01-10T12:00:00Z",
    "SYNTHETIC-TEMP-MESSAGE-SECRET"
  ];
}

async function assertIngestRejected(account, pattern, {
  page = 1,
  row,
  markers = [],
  includeMessageText = false
} = {}) {
  await assert.rejects(ingestAccount(account, {
    includeMessageText,
    asOf: AS_OF,
    disambiguation: "reject"
  }), (error) => {
    assert.ok(error instanceof DataIntegrityError);
    assert.match(error.message, pattern);
    assert.match(error.message, new RegExp(`Page ${page}`));
    if (row !== undefined) assert.match(error.message, new RegExp(`row ${row}`));
    for (const marker of markers) assert.equal(error.message.includes(marker), false);
    assert.equal(error.message.includes("1000000001"), false);
    return true;
  });
}

async function assertCapabilityRejected(account, pattern, {
  page = 1,
  markers = [],
  includeMessageText = false
} = {}) {
  await assert.rejects(ingestAccount(account, {
    includeMessageText,
    asOf: AS_OF,
    disambiguation: "reject"
  }), (error) => {
    assert.ok(error instanceof CapabilityError);
    assert.equal(error.exitCode, 3);
    assert.match(error.message, pattern);
    assert.match(error.message, new RegExp(`Page ${page}`));
    for (const marker of markers) assert.equal(error.message.includes(marker), false);
    assert.equal(error.message.includes("1000000001"), false);
    return true;
  });
}

test("normalizes both paginated columns-data aliases in manifest order", async () => {
  const input = await ingestAccount(accountFor(), {
    includeMessageText: false,
    asOf: AS_OF,
    disambiguation: "reject"
  });

  assert.deepEqual(input, {
    accountKey: "example-heating",
    events: [
      {
        leadId: "SYNTHETIC-PAGE-LEAD-0001",
        leadType: "MESSAGE",
        participantType: "CONSUMER",
        conversationChannel: "SMS",
        callDurationMillis: null,
        epochNanoseconds: 1_768_068_000_123_456_000n,
        fractionalDigits: 6
      },
      {
        leadId: "SYNTHETIC-PAGE-LEAD-0002",
        leadType: "SYNTHETIC_BOOKING",
        participantType: "ADVERTISER",
        conversationChannel: "BOOKING",
        callDurationMillis: 0,
        epochNanoseconds: 1_768_089_600_000_000_000n,
        fractionalDigits: 0
      }
    ],
    capability: {
      envelope: "columns-data",
      completionMethod: "all-page-tokens-consumed",
      messageTextAvailable: true,
      pageCount: 2
    }
  });
});

test("normalizes exact Google Ads object paths and retains opted-in message text", async () => {
  const payload = JSON.parse(await readFile(
    path.join(syntheticRoot, "google-ads-results.json"),
    "utf8"
  ));
  const account = await writeInput({ payload, format: "google-ads-results" });

  const input = await ingestAccount(account, {
    includeMessageText: true,
    asOf: AS_OF,
    disambiguation: "reject"
  });

  assert.deepEqual(input.events, [
    {
      leadId: "SYNTHETIC-OBJECT-LEAD-0001",
      leadType: "MESSAGE",
      participantType: "CONSUMER",
      conversationChannel: "SMS",
      callDurationMillis: null,
      epochNanoseconds: 1_768_046_400_123_456_000n,
      fractionalDigits: 6,
      messageText: "SYNTHETIC PRIVATE MESSAGE FOR TESTING ONLY"
    },
    {
      leadId: "SYNTHETIC-OBJECT-LEAD-0002",
      leadType: "BOOKING",
      participantType: "ADVERTISER",
      conversationChannel: "PHONE_CALL",
      callDurationMillis: 0,
      epochNanoseconds: 1_768_046_401_000_000_000n,
      fractionalDigits: 0
    }
  ]);
  assert.deepEqual(input.capability, {
    envelope: "google-ads-results",
    completionMethod: "connector-complete-saved-result",
    messageTextAvailable: true,
    pageCount: 1
  });
});

test("does not retain message text when disabled", async () => {
  const input = await ingestAccount(accountFor(), {
    asOf: AS_OF,
    disambiguation: "reject"
  });

  assert.equal(input.events.every((event) => event.messageText === undefined), true);
  assert.equal(input.events.some((event) =>
    Object.values(event).includes("SYNTHETIC PAGINATED MESSAGE FOR TESTING ONLY")), false);
});

test("requires message-text capability only when text retention is enabled", async () => {
  const row = validRow().slice(0, 6);
  const account = await writeInput({
    payload: columnsPayload(row, { includeMessageTextColumn: false })
  });

  const withoutText = await ingestAccount(account, {
    includeMessageText: false,
    asOf: AS_OF,
    disambiguation: "reject"
  });
  assert.equal(withoutText.capability.messageTextAvailable, false);
  assert.equal(withoutText.events[0].messageText, undefined);

  await assertCapabilityRejected(account, /message-text capability is unavailable/, {
    includeMessageText: true
  });
});

test("accepts an event exactly at asOf", async () => {
  const row = validRow();
  row[5] = AS_OF;
  const account = await writeInput({ payload: columnsPayload(row) });

  const input = await ingestAccount(account, {
    includeMessageText: false,
    asOf: AS_OF,
    disambiguation: "reject"
  });

  assert.equal(input.events.length, 1);
  assert.equal(input.events[0].epochNanoseconds, 1_769_882_400_000_000_000n);
});

test("rejects a short or long columns-data row before field lookup", async () => {
  const shortPayload = columnsPayload(validRow().slice(0, 6));
  shortPayload.result.columns[0] = "SYNTHETIC-UNRESOLVED-COLUMN-SECRET";
  const payloads = [shortPayload, columnsPayload([...validRow(), "EXTRA"])];

  for (const payload of payloads) {
    const account = await writeInput({ payload });
    await assertIngestRejected(account, /row width does not match columns/, {
      row: 1,
      markers: [
        "SYNTHETIC-TEMP-MESSAGE-SECRET",
        "SYNTHETIC-UNRESOLVED-COLUMN-SECRET"
      ]
    });
  }
});

test("rejects a non-array columns-data row as a row-width failure", async () => {
  const payload = columnsPayload(validRow());
  payload.result.data = [{ private: "SYNTHETIC-NON-ARRAY-ROW-SECRET" }];
  const account = await writeInput({ payload });

  await assertIngestRejected(account, /row width does not match columns/, {
    row: 1,
    markers: ["SYNTHETIC-NON-ARRAY-ROW-SECRET"]
  });
});

test("rejects missing required row values without echoing the value", async () => {
  const cases = [
    [0, null, /missing lead ID/],
    [0, "", /missing lead ID/],
    [1, null, /missing lead type/],
    [2, null, /missing participant type/],
    [3, "", /missing conversation channel/],
    [5, null, /missing event timestamp/]
  ];

  for (const [index, value, pattern] of cases) {
    const row = validRow();
    row[index] = value;
    const account = await writeInput({ payload: columnsPayload(row) });
    await assertIngestRejected(account, pattern, {
      row: 1,
      markers: ["SYNTHETIC-TEMP-MESSAGE-SECRET"]
    });
  }
});

test("rejects non-string lead, participant, and channel enum values", async () => {
  const cases = [
    [1, 7, /invalid lead type/],
    [2, 7, /invalid participant type/],
    [3, 7, /invalid conversation channel/]
  ];

  for (const [index, value, pattern] of cases) {
    const row = validRow();
    row[index] = value;
    const account = await writeInput({ payload: columnsPayload(row) });
    await assertIngestRejected(account, pattern, { row: 1 });
  }
});

test("rejects participant enum values other than consumer and advertiser", async () => {
  const marker = "SYNTHETIC-PARTICIPANT-SECRET";
  const row = validRow();
  row[2] = marker;
  const account = await writeInput({ payload: columnsPayload(row) });

  await assertIngestRejected(account, /invalid participant type/, {
    row: 1,
    markers: [marker]
  });
});

test("retains an unknown string lead type in normalized uppercase form", async () => {
  const row = validRow();
  row[1] = "synthetic_new_lead_type";
  const account = await writeInput({ payload: columnsPayload(row) });

  const input = await ingestAccount(account, {
    includeMessageText: false,
    asOf: AS_OF,
    disambiguation: "reject"
  });

  assert.equal(input.events[0].leadType, "SYNTHETIC_NEW_LEAD_TYPE");
});

test("rejects negative, fractional, malformed-string, and unsafe call durations", async () => {
  for (const duration of [-1, 1.5, "1.5", 9_007_199_254_740_992]) {
    const row = validRow();
    row[4] = duration;
    const account = await writeInput({ payload: columnsPayload(row) });
    await assertIngestRejected(account, /invalid call duration/, { row: 1 });
  }
});

test("rejects an absent Google Ads duration without selection evidence", async () => {
  const payload = JSON.parse(await readFile(
    path.join(syntheticRoot, "google-ads-results.json"),
    "utf8"
  ));
  delete payload.results[0].localServicesLeadConversation.phoneCallDetails;
  const account = await writeInput({ payload, format: "google-ads-results" });

  await assert.rejects(ingestAccount(account, {
    includeMessageText: false,
    asOf: AS_OF,
    disambiguation: "reject"
  }), CapabilityError);
});

test("accepts present null and zero Google Ads object call durations", async () => {
  const base = JSON.parse(await readFile(
    path.join(syntheticRoot, "google-ads-results.json"),
    "utf8"
  ));

  for (const duration of [null, 0]) {
    const payload = structuredClone(base);
    payload.results = [payload.results[0]];
    payload.results[0].localServicesLeadConversation.phoneCallDetails
      .callDurationMillis = duration;
    const account = await writeInput({ payload, format: "google-ads-results" });
    const input = await ingestAccount(account, {
      includeMessageText: false,
      asOf: AS_OF,
      disambiguation: "reject"
    });
    assert.equal(input.events[0].callDurationMillis, duration);
  }
});

test("rejects invalid present Google Ads object call durations", async () => {
  const base = JSON.parse(await readFile(
    path.join(syntheticRoot, "google-ads-results.json"),
    "utf8"
  ));

  for (const duration of [-1, 1.5, "1.5", 9_007_199_254_740_992]) {
    const payload = structuredClone(base);
    payload.results = [payload.results[0]];
    payload.results[0].localServicesLeadConversation.phoneCallDetails
      .callDurationMillis = duration;
    const account = await writeInput({ payload, format: "google-ads-results" });
    await assertIngestRejected(account, /invalid call duration/, { row: 1 });
  }
});

test("rejects invalid timestamps and events after asOf without echoing source text", async () => {
  const cases = [
    ["SYNTHETIC-INVALID-TIMESTAMP-SECRET", /invalid event timestamp/],
    ["2026-02-01T00:00:00Z", /event occurs after asOf/]
  ];

  for (const [timestamp, pattern] of cases) {
    const row = validRow();
    row[5] = timestamp;
    const account = await writeInput({ payload: columnsPayload(row) });
    await assertIngestRejected(account, pattern, { row: 1, markers: [timestamp] });
  }
});

test("rejects malformed JSON and appended truncation prose without exposing it", async () => {
  const marker = "SYNTHETIC-TRUNCATION-SECRET";
  const account = await writeInput({
    rawPage: `${JSON.stringify(columnsPayload(validRow()))}\nOutput truncated ${marker}`
  });

  await assertIngestRejected(account, /malformed JSON/, { markers: [marker] });
});

test("rejects duplicate decoded JSON members in connector pages", async () => {
  const valid = JSON.stringify(columnsPayload(validRow()));
  const cases = [
    valid.replace(
      "{",
      '{"syntheticShadow":1,"syntheticShadow":2,'
    ),
    valid.replace(
      '"columns":',
      '"syntheticNested":1,"syntheticNested":2,"columns":'
    ),
    valid.replace(
      "{",
      '{"syntheticShadow":1,"synthetic\\u0053hadow":2,'
    )
  ];

  for (const rawPage of cases) {
    const account = await writeInput({ rawPage });
    await assertIngestRejected(account, /malformed JSON/, {
      markers: ["SYNTHETIC-TEMP-MESSAGE-SECRET"]
    });
  }
});

test("fails safely when a manifest-valid page does not exist at ingestion time", async () => {
  const marker = "SYNTHETIC-MISSING-PAGE-SECRET";
  const root = await mkdtemp(path.join(os.tmpdir(), "lsa-ingest-missing-"));
  const manifestPath = path.join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify({
    schemaVersion: 1,
    format: "columns-data",
    completion: {
      method: "connector-complete-saved-result",
      savedResultWasComplete: true
    },
    pages: [{ path: `${marker}.json` }]
  }));

  await assertIngestRejected(accountFor(manifestPath), /input is unreadable/, {
    markers: [marker]
  });
});

test("rejects structured connector failure or partial-result output", async () => {
  const valid = columnsPayload(validRow());
  const cases = [
    { error: "SYNTHETIC-CONNECTOR-ERROR-SECRET" },
    { truncated: true, message: "SYNTHETIC-TRUNCATED-OUTPUT-SECRET" },
    { ...structuredClone(valid), isError: true },
    { ...structuredClone(valid), partial: true },
    {
      result: { ...structuredClone(valid.result), isError: true }
    },
    {
      result: { ...structuredClone(valid.result), partial: true }
    }
  ];

  for (const payload of cases) {
    const account = await writeInput({ payload });
    await assertIngestRejected(account, /connector error or truncation output/, {
      markers: Object.values(payload).filter((value) => typeof value === "string")
    });
  }
});

test("accepts matching response pagination evidence at root and wrapper aliases", async () => {
  const cases = [
    { scope: "root", field: "nextPageToken" },
    { scope: "wrapper", field: "next_page_token" }
  ];

  for (const { scope, field } of cases) {
    const first = columnsPayload(validRow());
    const second = columnsPayload(validRow());
    if (scope === "root") {
      first[field] = "SYNTHETIC-PAGE-2-TOKEN";
    } else {
      first.result[field] = "SYNTHETIC-PAGE-2-TOKEN";
    }
    const account = await writePagedInput({ payloads: [first, second] });
    const result = await ingestAccount(account, {
      asOf: AS_OF,
      disambiguation: "reject"
    });
    assert.equal(result.events.length, 2);
    assert.equal(result.capability.pageCount, 2);
  }
});

test("rejects response pagination evidence that contradicts manifest completion", async () => {
  const saved = columnsPayload(validRow());
  saved.nextPageToken = "SYNTHETIC-SAVED-UNDRAINED";
  const savedAccount = await writeInput({ payload: saved });
  await assertIngestRejected(savedAccount, /pagination evidence is inconsistent/, {
    markers: ["SYNTHETIC-SAVED-UNDRAINED"]
  });

  const single = columnsPayload(validRow());
  single.result.next_page_token = "SYNTHETIC-SINGLE-UNDRAINED";
  const singleAccount = await writePagedInput({
    payloads: [single],
    completion: { method: "single-page-no-continuation" },
    pages: [{
      path: "page-1.json",
      requestToken: null,
      nextPageToken: null
    }]
  });
  await assertIngestRejected(singleAccount, /pagination evidence is inconsistent/, {
    markers: ["SYNTHETIC-SINGLE-UNDRAINED"]
  });

  const mismatchedFirst = columnsPayload(validRow());
  mismatchedFirst.next_page_token = "SYNTHETIC-WRONG-TOKEN";
  const mismatchAccount = await writePagedInput({
    payloads: [mismatchedFirst, columnsPayload(validRow())]
  });
  await assertIngestRejected(mismatchAccount, /pagination evidence is inconsistent/, {
    markers: ["SYNTHETIC-WRONG-TOKEN", "SYNTHETIC-PAGE-2-TOKEN"]
  });

  const finalPage = columnsPayload(validRow());
  finalPage.result.nextPageToken = "SYNTHETIC-FINAL-UNDRAINED";
  const finalAccount = await writePagedInput({
    payloads: [columnsPayload(validRow()), finalPage]
  });
  await assertIngestRejected(finalAccount, /pagination evidence is inconsistent/, {
    page: 2,
    markers: ["SYNTHETIC-FINAL-UNDRAINED"]
  });
});

test("rejects malformed present response pagination metadata", async () => {
  for (const token of ["", 7, true]) {
    const first = columnsPayload(validRow());
    first.result.next_page_token = token;
    const account = await writePagedInput({
      payloads: [first, columnsPayload(validRow())]
    });
    await assertIngestRejected(account, /pagination evidence is inconsistent/);
  }
});

test("rejects a page envelope that conflicts with the declared manifest format", async () => {
  const payload = JSON.parse(await readFile(
    path.join(syntheticRoot, "google-ads-results.json"),
    "utf8"
  ));
  const account = await writeInput({ payload, format: "columns-data" });

  await assertIngestRejected(account, /response envelope does not match the manifest/);
});

test("rejects mixed page envelopes when the manifest format is auto", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lsa-ingest-mixed-"));
  const objectPayload = JSON.parse(await readFile(
    path.join(syntheticRoot, "google-ads-results.json"),
    "utf8"
  ));
  await writeFile(path.join(root, "one.json"), JSON.stringify(columnsPayload(validRow())));
  await writeFile(path.join(root, "two.json"), JSON.stringify(objectPayload));
  await writeFile(path.join(root, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    format: "auto",
    completion: { method: "all-page-tokens-consumed" },
    source: { customerId: "1000000001" },
    pages: [
      { path: "one.json", requestToken: null, nextPageToken: "SYNTHETIC-MIXED-TOKEN" },
      { path: "two.json", requestToken: "SYNTHETIC-MIXED-TOKEN", nextPageToken: null }
    ]
  }));

  await assertIngestRejected(accountFor(path.join(root, "manifest.json")),
    /response envelope does not match earlier pages/, {
      page: 2,
      markers: ["SYNTHETIC-MIXED-TOKEN"]
    });
});

test("rejects every missing required Google Ads nested path with row location", async () => {
  const requiredPaths = [
    ["localServicesLead", "id"],
    ["localServicesLead", "leadType"],
    ["localServicesLeadConversation", "participantType"],
    ["localServicesLeadConversation", "conversationChannel"],
    ["localServicesLeadConversation", "eventDateTime"]
  ];
  const base = JSON.parse(await readFile(
    path.join(syntheticRoot, "google-ads-results.json"),
    "utf8"
  ));

  for (const nestedPath of requiredPaths) {
    const payload = structuredClone(base);
    const parent = nestedPath.slice(0, -1).reduce(
      (current, key) => current[key],
      payload.results[0]
    );
    delete parent[nestedPath.at(-1)];
    const account = await writeInput({ payload, format: "google-ads-results" });
    await assertIngestRejected(account, /required nested field is missing/, { row: 1 });
  }
});

test("rejects a non-object Google Ads result with row location", async () => {
  const marker = "SYNTHETIC-NON-OBJECT-RESULT-SECRET";
  const account = await writeInput({
    payload: { results: [marker] },
    format: "google-ads-results"
  });

  await assertIngestRejected(account, /required nested field is missing/, {
    row: 1,
    markers: [marker]
  });
});

test("rejects unavailable required columns with a sanitized page-level error", async () => {
  const payload = columnsPayload(validRow());
  payload.result.columns[0] = "SYNTHETIC-PRIVATE-COLUMN-SECRET";
  const account = await writeInput({ payload });

  await assertCapabilityRejected(account, /required columns are unavailable/, {
    markers: ["SYNTHETIC-PRIVATE-COLUMN-SECRET"]
  });
});

test("classifies unsupported envelopes as capability failures", async () => {
  const marker = "SYNTHETIC-UNSUPPORTED-ENVELOPE-SECRET";
  const account = await writeInput({
    payload: { aggregates: [{ private: marker }] },
    format: "auto"
  });

  await assertCapabilityRejected(account, /unsupported response envelope/, {
    markers: [marker]
  });
});

test("accepts valid empty columns-data when required capability is declared", async () => {
  const payload = columnsPayload(validRow());
  payload.result.data = [];
  const account = await writeInput({ payload });

  const result = await ingestAccount(account, {
    asOf: AS_OF,
    disambiguation: "reject"
  });
  assert.deepEqual(result.events, []);
  assert.equal(result.capability.envelope, "columns-data");
  assert.equal(result.capability.messageTextAvailable, true);
});

test("rejects invalid opted-in message text without echoing it", async () => {
  const row = validRow();
  row[6] = { private: "SYNTHETIC-MESSAGE-OBJECT-SECRET" };
  const account = await writeInput({ payload: columnsPayload(row) });

  await assert.rejects(ingestAccount(account, {
    includeMessageText: true,
    asOf: AS_OF,
    disambiguation: "reject"
  }), (error) => {
    assert.ok(error instanceof DataIntegrityError);
    assert.match(error.message, /Page 1, row 1: invalid message text/);
    assert.equal(error.message.includes("SYNTHETIC-MESSAGE-OBJECT-SECRET"), false);
    return true;
  });
});
