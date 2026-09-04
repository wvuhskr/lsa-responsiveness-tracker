import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CapabilityError, DataIntegrityError } from "../src/errors.js";
import { ingestAccount } from "../src/ingest.js";
import { computeAccountMetrics } from "../src/metrics.js";
import { parseTimestamp, windowStartFor } from "../src/timestamps.js";

const fixtureRoot = fileURLToPath(
  new URL("./fixtures/synthetic/", import.meta.url)
);
const AS_OF = "2026-01-31 12:00:00";
const WINDOW_DAYS = 30;
const DEFAULT_ACCOUNT = Object.freeze({
  customerId: "1000000001",
  key: "example-heating",
  businessName: "Example Heating",
  timeZone: "America/New_York"
});

const requiredFixtures = new Map([
  ["normal-columns.json", "camelCase calls, messages, booking, and precision"],
  ["normal-objects.json", "Google Ads nested-object response"],
  ["no-activity.json", "valid empty account"],
  ["missing-fields.json", "missing capability"],
  ["malformed-row.json", "row-width integrity"],
  ["mixed-lead-types.json", "conflicting lead type"],
  ["unsupported-resource.json", "unsupported resource error"],
  ["authentication-error.json", "authentication-shaped error"],
  ["truncated-display.txt", "display truncation rejection"]
]);
const allowedAccountIds = new Set(["1000000001", "1000000002"]);
const allowedLeadIds = new Set([
  "900000000001",
  "900000000002",
  "900000000003",
  "900000000004",
  "900000000005",
  "900000000006",
  "900000000007",
  "900000000008",
  "900000000009",
  "900000000010",
  "900000000011",
  "900000000012",
  "900000000013",
  "900000000014",
  "900000000098",
  "900000000099",
  "SYNTHETIC-LEAD-0001",
  "SYNTHETIC-OBJECT-LEAD-0001",
  "SYNTHETIC-OBJECT-LEAD-0002",
  "SYNTHETIC-PAGE-LEAD-0001",
  "SYNTHETIC-PAGE-LEAD-0002"
]);
const requiredAssignedLabels = new Map([
  ...[...requiredFixtures.keys()]
    .filter((name) => name.endsWith(".json"))
    .map((name) => [name, "SYNTHETIC FIXTURE ONLY"]),
  ["expected-normal.json", "SYNTHETIC FIXTURE ONLY"],
  [
    "truncated-display.txt",
    "\"Truncated display fixture: SYNTHETIC TRUNCATED DISPLAY DETAIL\""
  ]
]);
const JSON_FIXTURE_LABEL = "SYNTHETIC FIXTURE ONLY";
const TEXT_FIXTURE_HEADER = "SYNTHETIC FIXTURE ONLY\n";
const legacyExactContentDigests = new Map([
  [
    "columns-camel.json",
    "0ef8a3d5ddccfdc9f662da7d3c9df855b463bb1cd7ea32a1a040a194be6e826d"
  ],
  [
    "google-ads-results.json",
    "b14122a3ddb84dc45d89deb560bf0d7cfa85bf5076301682ab78a8ba2fb652d7"
  ],
  [
    "pagination/manifest.json",
    "1916939800353bc0859f9a5113d0928d2ef5f412ce83c902da0a60765b215a2c"
  ],
  [
    "pagination/page-1.json",
    "906304ef2ac7a1a6f4055bd57db7590cee1282b2cd861b4e6975c6b177598c24"
  ],
  [
    "pagination/page-2.json",
    "64712bb48dca32ecc1a17d6875529e60797fc4a792c10fdf86eee69cb4716f73"
  ]
]);
const legacySafeEmptyPolicies = new Map([
  ["columns-snake.json", {
    columns: [
      "local_services_lead.id",
      "local_services_lead.lead_type",
      "local_services_lead_conversation.participant_type",
      "local_services_lead_conversation.conversation_channel",
      "local_services_lead_conversation.phone_call_details.call_duration_millis",
      "local_services_lead_conversation.event_date_time"
    ],
    data: []
  }],
  ["missing-column.json", {
    columns: [
      "localServicesLead.id",
      "localServicesLead.leadType",
      "localServicesLeadConversation.participantType",
      "localServicesLeadConversation.conversationChannel",
      "localServicesLeadConversation.phoneCallDetails.callDurationMillis"
    ],
    data: []
  }]
]);

const rawPrivacyRules = [
  [
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
    "email-like value"
  ],
  [
    /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/,
    "phone-like value"
  ],
  [
    /\b\d{1,5}\s+[A-Za-z]+(?:\s+[A-Za-z]+){0,3}\s+(?:Street|St|Road|Rd|Avenue|Ave|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way)\b/i,
    "address-like value"
  ],
  [
    /\b(?:Google|Microsoft|Meta|Facebook|ServiceTitan|Apple|Amazon|BRAND[-_ ]LIKE[-_ ]TEST[-_ ]MARKER)\b/i,
    "brand-like value"
  ],
  [
    /(?:\/Users\/|\/home\/|\/private\/|[A-Za-z]:\\+Users\\+)/i,
    "private-path form"
  ]
];

function auditFailure(relativePath, category) {
  throw new Error(`${relativePath}: ${category}`);
}

function scanRawText(text, relativePath) {
  for (const [pattern, category] of rawPrivacyRules) {
    if (pattern.test(text)) auditFailure(relativePath, category);
  }
}

function normalizedKey(value) {
  return String(value).replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function structuralKeys(pathParts) {
  const keys = pathParts
    .filter((part) => !/^\d+$/.test(String(part)))
    .map(normalizedKey);
  return {
    current: keys.at(-1) ?? "",
    parent: keys.at(-2) ?? ""
  };
}

const ACCOUNT_IDENTIFIER_KEYS = new Set([
  "accountid",
  "accountidentifier",
  "alternateaccountid",
  "alternateaccountidentifier",
  "customerid",
  "customeridentifier"
]);
const LEAD_IDENTIFIER_KEYS = new Set([
  "alternateleadid",
  "alternateleadidentifier",
  "conversationid",
  "conversationidentifier",
  "leadid",
  "leadidentifier",
  "leadreferenceid",
  "localservicesleadid"
]);
const NAME_KEYS = new Set([
  "accountname",
  "alternatebusinessname",
  "business",
  "businessname",
  "company",
  "companyname",
  "customername",
  "name"
]);
const MESSAGE_ERROR_KEYS = new Set([
  "alternatedetail",
  "alternateerror",
  "alternatemessage",
  "body",
  "content",
  "description",
  "detail",
  "error",
  "errormessage",
  "message",
  "messagetext",
  "text"
]);
const EVENT_TIMESTAMP_KEYS = new Set([
  "alternateeventat",
  "alternateeventdate",
  "alternateeventdatetime",
  "alternateeventtime",
  "alternateeventtimestamp",
  "eventat",
  "eventdate",
  "eventdatetime",
  "eventtime",
  "eventtimestamp",
  "localservicesleadconversationeventdatetime"
]);
const NON_IDENTIFIER_NUMERIC_KEYS = new Set([
  "alternateeventat",
  "alternateeventdate",
  "alternateeventdatetime",
  "alternateeventtime",
  "alternateeventtimestamp",
  "asofns",
  "calldurationmillis",
  "date",
  "datetime",
  "duration",
  "durationmillis",
  "epochnanoseconds",
  "eventat",
  "eventdate",
  "eventdatetime",
  "eventtime",
  "eventtimestamp",
  "firstcontactepochnanoseconds",
  "localservicesleadconversationeventdatetime",
  "localservicesleadconversationphonecalldetailscalldurationmillis",
  "mediannanoseconds",
  "nanoseconds",
  "timestamp",
  "windowstartns"
]);

function identifierKindForPath(pathParts) {
  const { current, parent } = structuralKeys(pathParts);
  if (ACCOUNT_IDENTIFIER_KEYS.has(current)) return "account";
  if (LEAD_IDENTIFIER_KEYS.has(current) ||
      (current === "id" && parent === "localserviceslead")) {
    return "lead";
  }
  return null;
}

function isNamePath(pathParts) {
  return NAME_KEYS.has(structuralKeys(pathParts).current);
}

function isMessageOrErrorPath(pathParts) {
  return MESSAGE_ERROR_KEYS.has(structuralKeys(pathParts).current);
}

function isEventTimestampPath(pathParts) {
  return EVENT_TIMESTAMP_KEYS.has(structuralKeys(pathParts).current);
}

function isNonIdentifierNumericPath(pathParts) {
  return NON_IDENTIFIER_NUMERIC_KEYS.has(structuralKeys(pathParts).current);
}

function normalizedIdentifier(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[0-9][0-9\s().+-]*[0-9]$/.test(trimmed)) return null;
  return trimmed.replace(/\D/g, "");
}

function assertAllowedIdentifier(value, allowed, category, relativePath) {
  const normalized = normalizedIdentifier(value);
  const canonical = allowed.has(value)
    ? value
    : normalized !== null && allowed.has(normalized)
      ? normalized
      : null;
  if (canonical === null) {
    auditFailure(relativePath, `${category} identifier is not allowlisted`);
  }
  return canonical;
}

const inlineNumericSeparators = new Set(["+", "-", ".", "(", ")"]);

function isAsciiDigit(character) {
  return character >= "0" && character <= "9";
}

function numericRuns(value) {
  const runs = [];
  let index = 0;
  while (index < value.length) {
    const character = value[index];
    if (!isAsciiDigit(character) &&
        !inlineNumericSeparators.has(character)) {
      index += 1;
      continue;
    }

    const start = index;
    let hasDigit = false;
    while (index < value.length &&
        (isAsciiDigit(value[index]) ||
          inlineNumericSeparators.has(value[index]))) {
      if (isAsciiDigit(value[index])) hasDigit = true;
      index += 1;
    }
    if (!hasDigit) continue;

    const raw = value.slice(start, index);
    runs.push({
      digitGroups: raw.match(/\d+/g) ?? [],
      end: index,
      raw,
      start
    });
  }
  return runs;
}

const identifierGroupShapes = [
  [10],
  [12],
  [3, 3, 4],
  [3, 3, 3, 3],
  [4, 4, 4]
];

function candidatesFromGroups(groups) {
  const matchingShape = identifierGroupShapes.find((shape) =>
    shape.length === groups.length && shape.every((length, index) =>
      groups[index].length === length
    )
  );
  return matchingShape === undefined ? null : [groups.join("")];
}

function numericCandidatesFromRuns(value) {
  const runs = numericRuns(value);
  const candidates = [];

  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    if (/^\d{3,4}$/.test(run.raw)) {
      const groups = [...run.digitGroups];
      let nextIndex = index + 1;
      while (nextIndex < runs.length &&
          /^\s+$/.test(value.slice(runs[nextIndex - 1].end,
            runs[nextIndex].start)) &&
          /^\d{3,4}$/.test(runs[nextIndex].raw)) {
        groups.push(...runs[nextIndex].digitGroups);
        nextIndex += 1;
      }
      const partition = candidatesFromGroups(groups);
      if (partition !== null) candidates.push(...partition);
      index = nextIndex - 1;
      continue;
    }

    const partition = candidatesFromGroups(run.digitGroups);
    if (partition !== null) {
      candidates.push(...partition);
      continue;
    }

    const nextRun = runs[index + 1];
    if (nextRun !== undefined &&
        /^\s+$/.test(value.slice(run.end, nextRun.start))) {
      const joined = candidatesFromGroups([
        ...run.digitGroups,
        ...nextRun.digitGroups
      ]);
      if (joined !== null) {
        candidates.push(...joined);
        index += 1;
      }
    }
  }
  return candidates;
}

function numericIdentifierCandidates(value, keyPath) {
  if ((typeof value !== "string" && typeof value !== "number" &&
      typeof value !== "bigint") || isNonIdentifierNumericPath(keyPath)) {
    return [];
  }
  const withoutTimestamps = String(value).replace(
    /\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?\b/g,
    " "
  );
  return numericCandidatesFromRuns(withoutTimestamps);
}

function scanIdentifierLikeValue(value, keyPath, relativePath, observed) {
  for (const digits of numericIdentifierCandidates(value, keyPath)) {
    if (digits.length === 10) {
      if (!allowedAccountIds.has(digits)) {
        auditFailure(relativePath, "numeric identifier is not allowlisted");
      }
      observed?.accountIds.add(digits);
    } else {
      if (!allowedLeadIds.has(digits)) {
        auditFailure(relativePath, "numeric identifier is not allowlisted");
      }
      observed?.leadIds.add(digits);
    }
  }
}

function auditScalar(value, keyPath, relativePath, observed) {
  const identifierKind = identifierKindForPath(keyPath);
  if (identifierKind === "account") {
    const canonical = assertAllowedIdentifier(
      value,
      allowedAccountIds,
      "account",
      relativePath
    );
    observed?.accountIds.add(canonical);
  } else if (identifierKind === "lead") {
    const canonical = assertAllowedIdentifier(
      value,
      allowedLeadIds,
      "lead",
      relativePath
    );
    observed?.leadIds.add(canonical);
  }
  if (isNamePath(keyPath) &&
      (typeof value !== "string" || !/^Example(?:\s|$)/.test(value))) {
    auditFailure(relativePath, "name must begin with Example");
  }
  if (isMessageOrErrorPath(keyPath) && typeof value === "string" &&
      !/^SYNTHETIC(?:[ _:-]|$)/i.test(value)) {
    auditFailure(
      relativePath,
      "message or error text must be synthetic-labeled"
    );
  }
  if (isEventTimestampPath(keyPath) &&
      (typeof value !== "string" ||
        !/^2026-01-(?:0[1-9]|[12]\d|3[01])[ T]/.test(value))) {
    auditFailure(relativePath, "event timestamp must be in January 2026");
  }
  if (typeof value === "string") {
    scanRawText(value, relativePath);
  }
  scanIdentifierLikeValue(value, keyPath, relativePath, observed);
}

function auditStructure(
  value,
  keyPath,
  relativePath,
  observed,
  ancestors = new WeakSet()
) {
  if (value !== null && typeof value === "object") {
    if (ancestors.has(value)) return;
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
          auditStructure(
            value[index],
            [...keyPath, String(index)],
            relativePath,
            observed,
            ancestors
          );
        }
        return;
      }
      if (Array.isArray(value.columns) && Array.isArray(value.data)) {
        for (const [key, child] of Object.entries(value)) {
          if (key === "data") continue;
          scanRawText(key, relativePath);
          scanIdentifierLikeValue(key, [], relativePath, observed);
          auditStructure(
            child,
            [...keyPath, key],
            relativePath,
            observed,
            ancestors
          );
        }
        auditColumnsContainer(value, relativePath, observed, ancestors);
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        scanRawText(key, relativePath);
        scanIdentifierLikeValue(key, [], relativePath, observed);
        auditStructure(
          child,
          [...keyPath, key],
          relativePath,
          observed,
          ancestors
        );
      }
      return;
    } finally {
      ancestors.delete(value);
    }
  }
  auditScalar(value, keyPath, relativePath, observed);
}

function auditColumnsContainer(container, relativePath, observed, ancestors) {
  if (!Array.isArray(container?.columns) || !Array.isArray(container?.data)) {
    return;
  }

  const columnPaths = container.columns.map((column) => {
    const normalized = typeof column === "string"
      ? normalizedKey(column)
      : "";
    if (normalized.endsWith("localservicesleadid")) {
      return ["localServicesLead.id"];
    }
    if (normalized.endsWith("eventdatetime") ||
        normalized.endsWith("eventtimestamp") ||
        normalized.endsWith("eventdate") ||
        normalized.endsWith("eventtime")) {
      return ["eventDateTime"];
    }
    if (normalized.endsWith("messagedetailstext")) return ["messageText"];
    if (normalized.endsWith("calldurationmillis")) {
      return ["callDurationMillis"];
    }
    return [typeof column === "string" ? column : "unknownColumn"];
  });

  for (const row of container.data) {
    if (!Array.isArray(row)) {
      auditStructure(
        row,
        ["unmappedRow"],
        relativePath,
        observed,
        ancestors
      );
      continue;
    }
    for (let index = 0; index < row.length; index += 1) {
      const cellPath = columnPaths[index] ?? ["unmappedCell"];
      auditStructure(
        row[index],
        cellPath,
        relativePath,
        observed,
        ancestors
      );
    }
  }
}

async function enumerateFixtureFiles(root, relativeDirectory = "") {
  const directory = path.join(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files = [];

  for (const entry of entries) {
    const relativePath = relativeDirectory === ""
      ? entry.name
      : path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await enumerateFixtureFiles(root, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      auditFailure(relativePath, "unsupported fixture entry type");
    }
  }
  return files;
}

function decodeFixture(buffer, relativePath) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    auditFailure(relativePath, "fixture must be valid UTF-8");
  }
}

const JSON_AUDIT_MAX_DEPTH = 128;

class DuplicateJsonKeyError extends Error {}

function assertNoDuplicateJsonKeys(raw) {
  let position = 0;

  function syntaxError() {
    throw new SyntaxError("invalid JSON fixture syntax");
  }

  function skipWhitespace() {
    while (position < raw.length &&
        (raw[position] === " " || raw[position] === "\t" ||
          raw[position] === "\n" || raw[position] === "\r")) {
      position += 1;
    }
  }

  function parseStringToken() {
    if (raw[position] !== '"') syntaxError();
    const start = position;
    position += 1;

    while (position < raw.length) {
      const character = raw[position];
      if (character === '"') {
        position += 1;
        return JSON.parse(raw.slice(start, position));
      }
      if (character === "\\") {
        position += 1;
        if (position >= raw.length) syntaxError();
        const escape = raw[position];
        if (escape === "u") {
          for (let offset = 1; offset <= 4; offset += 1) {
            if (!/[0-9A-Fa-f]/.test(raw[position + offset] ?? "")) {
              syntaxError();
            }
          }
          position += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(escape)) syntaxError();
        position += 1;
        continue;
      }
      if (raw.charCodeAt(position) < 0x20) syntaxError();
      position += 1;
    }
    syntaxError();
  }

  function parseNumber() {
    const match =
      /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
        raw.slice(position)
      );
    if (match === null) syntaxError();
    position += match[0].length;
  }

  function parseLiteral(literal) {
    if (!raw.startsWith(literal, position)) syntaxError();
    position += literal.length;
  }

  function parseArray(depth) {
    position += 1;
    skipWhitespace();
    if (raw[position] === "]") {
      position += 1;
      return;
    }
    while (true) {
      parseValue(depth);
      skipWhitespace();
      if (raw[position] === "]") {
        position += 1;
        return;
      }
      if (raw[position] !== ",") syntaxError();
      position += 1;
      skipWhitespace();
    }
  }

  function parseObject(depth) {
    position += 1;
    skipWhitespace();
    const keys = new Set();
    if (raw[position] === "}") {
      position += 1;
      return;
    }
    while (true) {
      const key = parseStringToken();
      if (keys.has(key)) throw new DuplicateJsonKeyError();
      keys.add(key);
      skipWhitespace();
      if (raw[position] !== ":") syntaxError();
      position += 1;
      skipWhitespace();
      parseValue(depth);
      skipWhitespace();
      if (raw[position] === "}") {
        position += 1;
        return;
      }
      if (raw[position] !== ",") syntaxError();
      position += 1;
      skipWhitespace();
    }
  }

  function parseValue(depth) {
    if (depth > JSON_AUDIT_MAX_DEPTH) syntaxError();
    skipWhitespace();
    const character = raw[position];
    if (character === "{") {
      parseObject(depth + 1);
    } else if (character === "[") {
      parseArray(depth + 1);
    } else if (character === '"') {
      parseStringToken();
    } else if (character === "t") {
      parseLiteral("true");
    } else if (character === "f") {
      parseLiteral("false");
    } else if (character === "n") {
      parseLiteral("null");
    } else if (character === "-" || isAsciiDigit(character)) {
      parseNumber();
    } else {
      syntaxError();
    }
  }

  parseValue(0);
  skipWhitespace();
  if (position !== raw.length) syntaxError();
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function parsedJsonDigest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function assertJsonFixtureLabel(payload, relativePath, requiredLabels) {
  const requiredLabel = requiredLabels.get(relativePath);
  if (requiredLabel !== undefined &&
      payload?.syntheticMetadata?.label !== requiredLabel) {
    auditFailure(relativePath, "assigned fixture label is invalid");
  }
  if (payload?.syntheticMetadata?.label === JSON_FIXTURE_LABEL) return;

  const exactContentDigest = legacyExactContentDigests.get(relativePath);
  if (exactContentDigest !== undefined &&
      parsedJsonDigest(payload) === exactContentDigest) {
    return;
  }
  const safeEmptyPolicy = legacySafeEmptyPolicies.get(relativePath);
  if (safeEmptyPolicy !== undefined &&
      JSON.stringify(payload) === JSON.stringify(safeEmptyPolicy)) {
    return;
  }
  auditFailure(relativePath, "JSON fixture requires dedicated synthetic label");
}

function assertTextFixtureLabel(raw, relativePath, requiredLabels) {
  const requiredLabel = requiredLabels.get(relativePath);
  if (requiredLabel !== undefined) {
    if (raw.trim() !== requiredLabel) {
      auditFailure(relativePath, "assigned fixture label is invalid");
    }
    return;
  }
  if (!raw.startsWith(TEXT_FIXTURE_HEADER)) {
    auditFailure(relativePath, "text fixture requires exact synthetic header");
  }
}

async function auditSyntheticFixtureTree(root, { requiredLabels = new Map() } = {}) {
  const relativePaths = await enumerateFixtureFiles(root);
  const observedAccountIds = new Set();
  const observedLeadIds = new Set();
  const observed = { accountIds: observedAccountIds, leadIds: observedLeadIds };

  for (const relativePath of relativePaths) {
    const extension = path.extname(relativePath);
    if (extension !== ".json" && extension !== ".txt") {
      auditFailure(relativePath, "unsupported fixture file type");
    }
    const raw = decodeFixture(
      await readFile(path.join(root, relativePath)),
      relativePath
    );

    if (extension === ".txt") {
      assertTextFixtureLabel(raw, relativePath, requiredLabels);
      scanRawText(raw, relativePath);
      scanIdentifierLikeValue(raw, [], relativePath, observed);
      continue;
    }

    let payload;
    try {
      assertNoDuplicateJsonKeys(raw);
      payload = JSON.parse(raw);
    } catch (error) {
      if (error instanceof DuplicateJsonKeyError) {
        auditFailure(relativePath, "fixture contains duplicate JSON key");
      }
      auditFailure(relativePath, "fixture must be valid JSON");
    }
    assertJsonFixtureLabel(payload, relativePath, requiredLabels);
    auditStructure(payload, [], relativePath, observed);
    scanRawText(raw, relativePath);
  }

  for (const requiredPath of requiredLabels.keys()) {
    if (!relativePaths.includes(requiredPath)) {
      auditFailure(requiredPath, "assigned fixture is missing");
    }
  }
  return {
    fileCount: relativePaths.length,
    relativePaths,
    observedAccountIds,
    observedLeadIds
  };
}

const normalColumnNames = Object.freeze({
  leadId: "localServicesLead.id",
  leadType: "localServicesLead.leadType",
  participantType: "localServicesLeadConversation.participantType",
  conversationChannel: "localServicesLeadConversation.conversationChannel",
  callDurationMillis:
    "localServicesLeadConversation.phoneCallDetails.callDurationMillis",
  eventTimestamp: "localServicesLeadConversation.eventDateTime",
  messageText: "localServicesLeadConversation.messageDetails.text"
});

function stableCanonicalEvents(events) {
  return events.sort((left, right) => {
    const leftKey = JSON.stringify(Object.values(left));
    const rightKey = JSON.stringify(Object.values(right));
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function canonicalColumnsEvents(payload) {
  const container = payload.result ?? payload;
  const indexes = Object.fromEntries(Object.entries(normalColumnNames)
    .map(([key, column]) => [key, container.columns.indexOf(column)]));
  for (const [key, index] of Object.entries(indexes)) {
    assert.notEqual(index, -1, `normal columns fixture lacks ${key}`);
  }

  return stableCanonicalEvents(container.data.map((row) => ({
    leadId: row[indexes.leadId],
    leadType: row[indexes.leadType].toUpperCase(),
    participantType: row[indexes.participantType].toUpperCase(),
    conversationChannel: row[indexes.conversationChannel].toUpperCase(),
    callDurationMillis: row[indexes.callDurationMillis] ?? null,
    eventTimestamp: row[indexes.eventTimestamp],
    messageText: row[indexes.messageText] ?? null
  })));
}

function canonicalObjectEvents(payload) {
  return stableCanonicalEvents(payload.results.map((row) => {
    const lead = row.localServicesLead;
    const conversation = row.localServicesLeadConversation;
    return {
      leadId: lead.id,
      leadType: lead.leadType.toUpperCase(),
      participantType: conversation.participantType.toUpperCase(),
      conversationChannel: conversation.conversationChannel.toUpperCase(),
      callDurationMillis:
        conversation.phoneCallDetails?.callDurationMillis ?? null,
      eventTimestamp: conversation.eventDateTime,
      messageText: conversation.messageDetails?.text ?? null
    };
  }));
}

function assertRawNormalFixturesEquivalent(columns, objects) {
  const columnEvents = canonicalColumnsEvents(columns);
  const objectEvents = canonicalObjectEvents(objects);
  assert.deepEqual(
    objectEvents,
    columnEvents,
    "normal fixture semantic mismatch"
  );
  return columnEvents;
}

function fixturePath(name) {
  return path.join(fixtureRoot, name);
}

async function fixtureText(name) {
  return readFile(fixturePath(name), "utf8");
}

async function fixtureJson(name) {
  return JSON.parse(await fixtureText(name));
}

function accountMetadata(payload) {
  const metadata = payload !== null && typeof payload === "object" &&
    !Array.isArray(payload)
    ? payload.syntheticMetadata
    : undefined;
  return metadata ?? DEFAULT_ACCOUNT;
}

async function ingestFixture(name, { includeMessageText = false } = {}) {
  const rawPage = await fixtureText(name);
  let payload;
  try {
    payload = JSON.parse(rawPage);
  } catch {
    payload = undefined;
  }
  const metadata = accountMetadata(payload);
  const root = await mkdtemp(path.join(os.tmpdir(), "lsa-fixture-matrix-"));
  const pagePath = path.join(root, "page.json");
  const manifestPath = path.join(root, "manifest.json");
  await writeFile(pagePath, rawPage);
  await writeFile(manifestPath, JSON.stringify({
    schemaVersion: 1,
    format: "auto",
    source: { customerId: metadata.customerId },
    completion: {
      method: "connector-complete-saved-result",
      savedResultWasComplete: true
    },
    pages: [{ path: "page.json" }]
  }));

  const account = {
    key: metadata.key,
    name: metadata.businessName,
    customerId: metadata.customerId,
    timeZone: metadata.timeZone,
    inputManifest: manifestPath
  };
  const ingested = await ingestAccount(account, {
    asOf: AS_OF,
    includeMessageText,
    disambiguation: "reject"
  });
  return { account, ingested };
}

async function calculateFixture(name) {
  const { account, ingested } = await ingestFixture(name);
  const asOfNs = parseTimestamp(AS_OF, {
    timeZone: account.timeZone,
    disambiguation: "reject"
  }).epochNanoseconds;
  const windowStartNs = windowStartFor(
    AS_OF,
    account.timeZone,
    WINDOW_DAYS,
    "reject"
  );
  return computeAccountMetrics({
    account: { key: account.key, name: account.name },
    events: ingested.events,
    asOfNs,
    windowStartNs
  });
}

function assertSanitizedDataIntegrityError(error, expectedMessage, markers) {
  assert.ok(error instanceof DataIntegrityError);
  assert.equal(error.code, "DATA_INTEGRITY");
  assert.equal(error.exitCode, 4);
  assert.equal(error.message, expectedMessage);
  for (const marker of markers) {
    assert.equal(error.message.includes(marker), false);
  }
  return true;
}

function assertSanitizedCapabilityError(error, expectedMessage, markers) {
  assert.ok(error instanceof CapabilityError);
  assert.equal(error.code, "CAPABILITY");
  assert.equal(error.exitCode, 3);
  assert.equal(error.message, expectedMessage);
  for (const marker of markers) {
    assert.equal(error.message.includes(marker), false);
  }
  return true;
}

async function writeTempFixtureTree(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lsa-fixture-audit-"));
  for (const [relativePath, value] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    const contents = Buffer.isBuffer(value)
      ? value
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
    await writeFile(target, contents);
  }
  return root;
}

function safeAuditPayload(overrides = {}) {
  return {
    syntheticMetadata: {
      label: "SYNTHETIC FIXTURE ONLY",
      customerId: "1000000001",
      businessName: "Example Audit"
    },
    note: "SYNTHETIC AUDIT NOTE",
    ...overrides
  };
}

function insertDuplicateBeforeKey(raw, key, shadowValue) {
  const needle = `${JSON.stringify(key)}:`;
  const index = raw.indexOf(needle);
  assert.notEqual(index, -1, `Missing JSON key for duplicate test: ${key}`);
  return `${raw.slice(0, index)}${needle}${JSON.stringify(shadowValue)},${raw.slice(index)}`;
}

test("recursive audit rejects the reviewer's exact unlabeled two-file bypass", async () => {
  const root = await writeTempFixtureTree({
    "nested/unlabeled.json": {
      candidateId: "1000000009",
      business: "Sample Plumbing",
      eventDate: "2026-02-01 09:00:00",
      body: "ordinary customer request"
    },
    "nested/unlabeled.txt": "ordinary fixture text 1000000009"
  });

  await assert.rejects(
    auditSyntheticFixtureTree(root),
    /JSON fixture requires dedicated synthetic label/
  );
});

test("every discovered JSON and text fixture needs a deliberate label", async () => {
  const cases = [
    {
      name: "unlisted JSON",
      files: { "unlisted.json": { note: "SYNTHETIC AUDIT NOTE" } },
      expected: /JSON fixture requires dedicated synthetic label/
    },
    {
      name: "unlisted text",
      files: { "unlisted.txt": "ordinary fixture text" },
      expected: /text fixture requires exact synthetic header/
    },
    {
      name: "incidental synthetic substring",
      files: { "incidental.json": { leadType: "OTHER_SYNTHETIC" } },
      expected: /JSON fixture requires dedicated synthetic label/
    }
  ];

  for (const fixtureCase of cases) {
    const root = await writeTempFixtureTree(fixtureCase.files);
    await assert.rejects(
      auditSyntheticFixtureTree(root),
      fixtureCase.expected,
      fixtureCase.name
    );
  }
});

test("expanded structural synonyms cannot bypass fixture policy", async () => {
  const cases = [
    ["candidate ID", { candidateId: "1000000009" }, /numeric identifier is not allowlisted/],
    ["business", { business: "Sample Plumbing" }, /name must begin with Example/],
    ["company", { company: "Sample Plumbing" }, /name must begin with Example/],
    ["event date", { eventDate: "2026-02-01 09:00:00" }, /event timestamp must be in January 2026/],
    ["event time", { eventTime: "2026-02-01 09:00:00" }, /event timestamp must be in January 2026/],
    ["body", { body: "ordinary customer request" }, /message or error text must be synthetic-labeled/],
    ["detail", { detail: "ordinary customer request" }, /message or error text must be synthetic-labeled/],
    ["description", { description: "ordinary customer request" }, /message or error text must be synthetic-labeled/],
    ["content", { content: "ordinary customer request" }, /message or error text must be synthetic-labeled/]
  ];

  for (const [name, overrides, expected] of cases) {
    const root = await writeTempFixtureTree({
      [`${name.replaceAll(" ", "-")}.json`]: safeAuditPayload(overrides)
    });
    await assert.rejects(auditSyntheticFixtureTree(root), expected, name);
  }
});

test("object-valued columns cells receive every structural audit", async (t) => {
  const safeCell = {
    candidateId: "1000000001",
    business: "Example Audit",
    eventDate: "2026-01-05 09:00:00",
    body: "SYNTHETIC MESSAGE: ordinary customer request"
  };
  const cases = [
    [
      "exact combined reproduction",
      {
        candidateId: "1000000009",
        business: "Sample Plumbing",
        eventDate: "2026-02-01 09:00:00",
        body: "ordinary customer request"
      },
      /numeric identifier is not allowlisted/
    ],
    [
      "candidate ID",
      { ...safeCell, candidateId: "1000000009" },
      /numeric identifier is not allowlisted/
    ],
    [
      "business name",
      { ...safeCell, business: "Sample Plumbing" },
      /name must begin with Example/
    ],
    [
      "February event date",
      { ...safeCell, eventDate: "2026-02-01 09:00:00" },
      /event timestamp must be in January 2026/
    ],
    [
      "unlabeled body",
      { ...safeCell, body: "ordinary customer request" },
      /message or error text must be synthetic-labeled/
    ]
  ];

  for (const [name, cell, expected] of cases) {
    await t.test(name, async () => {
      const root = await writeTempFixtureTree({
        "object-cell.json": safeAuditPayload({
          columns: ["misc"],
          data: [[cell]]
        })
      });
      await assert.rejects(auditSyntheticFixtureTree(root), expected);
    });
  }
});

test("recursive audit helper is cycle-safe for constructed objects", () => {
  const cyclic = { note: "SYNTHETIC AUDIT NOTE" };
  cyclic.self = cyclic;

  assert.doesNotThrow(() => auditStructure(
    cyclic,
    [],
    "constructed-cycle.json",
    { accountIds: new Set(), leadIds: new Set() }
  ));
});

test("raw JSON and text identifier scanning rejects plain and formatted values", async () => {
  const cases = [
    ["plain JSON", "plain.json", safeAuditPayload({ candidateId: "1000000009" })],
    ["formatted JSON", "formatted.json", safeAuditPayload({ candidateId: "123-456-7890" })],
    ["plain text", "plain.txt", "SYNTHETIC FIXTURE ONLY\nordinary 1000000009"],
    ["formatted text", "formatted.txt", "SYNTHETIC FIXTURE ONLY\nordinary 123-456-7890"],
    ["plain 12-digit text", "lead.txt", "SYNTHETIC FIXTURE ONLY\nordinary 900000000100"],
    ["formatted 12-digit text", "lead-formatted.txt", "SYNTHETIC FIXTURE ONLY\nordinary 900-000-000-100"]
  ];

  for (const [name, relativePath, value] of cases) {
    const root = await writeTempFixtureTree({ [relativePath]: value });
    await assert.rejects(
      auditSyntheticFixtureTree(root),
      /identifier is not allowlisted|phone-like value/,
      name
    );
  }
});

test("adjacent identifier candidates are extracted separately", async (t) => {
  const rejectionCases = [
    [
      "reviewer exact two-invalid-ID reproduction",
      "1000000009 900000000100"
    ],
    [
      "invalid account before allowed lead",
      "1000000009 900000000001"
    ],
    [
      "allowed account before invalid lead",
      "1000000001 900000000100"
    ],
    [
      "invalid account after two allowed candidates",
      "1000000001 900000000001 1000000009"
    ]
  ];

  for (const [name, candidates] of rejectionCases) {
    await t.test(name, async () => {
      const root = await writeTempFixtureTree({
        "multiple.txt": `${TEXT_FIXTURE_HEADER}ordinary ${candidates}`
      });
      await assert.rejects(
        auditSyntheticFixtureTree(root),
        /numeric identifier is not allowlisted/
      );
    });
  }

  await t.test("two adjacent allowlisted IDs are both observed", async () => {
    const root = await writeTempFixtureTree({
      "multiple.txt": `${TEXT_FIXTURE_HEADER}ordinary 1000000001 900000000001`
    });
    const result = await auditSyntheticFixtureTree(root);
    assert.deepEqual(result.observedAccountIds, new Set(["1000000001"]));
    assert.deepEqual(result.observedLeadIds, new Set(["900000000001"]));
  });

  await t.test("long uninterrupted digit runs do not create substrings", async () => {
    const root = await writeTempFixtureTree({
      "longer.txt": `${TEXT_FIXTURE_HEADER}ordinary 110000000019000000000011`
    });
    const result = await auditSyntheticFixtureTree(root);
    assert.deepEqual(result.observedAccountIds, new Set());
    assert.deepEqual(result.observedLeadIds, new Set());
  });
});

test("plus-formatted identifiers are audited in text and unknown JSON fields", async (t) => {
  const cases = [
    [
      "10-digit text",
      "plus-account.txt",
      `${TEXT_FIXTURE_HEADER}ordinary 123+456+7890`
    ],
    [
      "12-digit text",
      "plus-lead.txt",
      `${TEXT_FIXTURE_HEADER}ordinary 900+000+000+100`
    ],
    [
      "10-digit JSON",
      "plus-account.json",
      safeAuditPayload({ note: "SYNTHETIC AUDIT NOTE 123+456+7890" })
    ],
    [
      "12-digit JSON",
      "plus-lead.json",
      safeAuditPayload({ note: "SYNTHETIC AUDIT NOTE 900+000+000+100" })
    ]
  ];

  for (const [name, relativePath, value] of cases) {
    await t.test(name, async () => {
      const root = await writeTempFixtureTree({ [relativePath]: value });
      await assert.rejects(
        auditSyntheticFixtureTree(root),
        /numeric identifier is not allowlisted/
      );
    });
  }
});

test("long formatted numeric runs never expose shorter identifier prefixes", async (t) => {
  const runs = [
    ["hyphens", "123-456-789-012-345"],
    ["plus signs", "123+456+789+012+345"],
    ["dots", "123.456.789.012.345"],
    ["spaces", "123 456 789 012 345"],
    ["24-digit hyphens", "123-456-789-012-345-678-901-234"],
    ["24-digit plus signs", "123+456+789+012+345+678+901+234"],
    ["24-digit dots", "123.456.789.012.345.678.901.234"],
    ["24-digit spaces", "123 456 789 012 345 678 901 234"]
  ];

  for (const [name, run] of runs) {
    await t.test(name, async () => {
      const root = await writeTempFixtureTree({
        "long-formatted.txt": `${TEXT_FIXTURE_HEADER}ordinary ${run}`
      });
      const result = await auditSyntheticFixtureTree(root);
      assert.deepEqual(result.observedAccountIds, new Set());
      assert.deepEqual(result.observedLeadIds, new Set());
    });
  }
});

test("formatted candidates remain separate across external delimiters", async (t) => {
  const rejectionCases = [
    ["invalid plus lead after allowed account", "1000000001,900+000+000+100"],
    ["invalid plus account before allowed lead", "123+456+7890;900000000001"]
  ];

  for (const [name, text] of rejectionCases) {
    await t.test(name, async () => {
      const root = await writeTempFixtureTree({
        "delimited.txt": `${TEXT_FIXTURE_HEADER}ordinary ${text}`
      });
      await assert.rejects(
        auditSyntheticFixtureTree(root),
        /numeric identifier is not allowlisted/
      );
    });
  }

  await t.test("two plus-formatted allowlisted IDs are both observed", async () => {
    const root = await writeTempFixtureTree({
      "delimited.txt":
        `${TEXT_FIXTURE_HEADER}ordinary 100+000+0001 / 900+000+000+001`
    });
    const result = await auditSyntheticFixtureTree(root);
    assert.deepEqual(result.observedAccountIds, new Set(["1000000001"]));
    assert.deepEqual(result.observedLeadIds, new Set(["900000000001"]));
  });

  await t.test("whitespace separates two complete plus-formatted IDs", async () => {
    const root = await writeTempFixtureTree({
      "delimited.txt":
        `${TEXT_FIXTURE_HEADER}ordinary 100+000+0001 900+000+000+001`
    });
    const result = await auditSyntheticFixtureTree(root);
    assert.deepEqual(result.observedAccountIds, new Set(["1000000001"]));
    assert.deepEqual(result.observedLeadIds, new Set(["900000000001"]));
  });
});

test("space-grouped candidates consume their whole numeric run", () => {
  assert.deepEqual(
    numericIdentifierCandidates("123 456 7890", []),
    ["1234567890"]
  );
  assert.deepEqual(
    numericIdentifierCandidates("900 000 000 001", []),
    ["900000000001"]
  );
  assert.deepEqual(
    numericIdentifierCandidates("100 000 0001 900 000 000 001", []),
    []
  );
});

test("legacy data-bearing label exceptions reject any added content", async (t) => {
  const legacyPaths = [
    "columns-camel.json",
    "google-ads-results.json",
    "pagination/manifest.json",
    "pagination/page-1.json",
    "pagination/page-2.json"
  ];

  for (const relativePath of legacyPaths) {
    await t.test(relativePath, async () => {
      const payload = await fixtureJson(relativePath);
      payload.extraAuditRecord = { note: "SYNTHETIC EXTRA CONTENT" };
      const root = await writeTempFixtureTree({ [relativePath]: payload });
      await assert.rejects(
        auditSyntheticFixtureTree(root),
        /JSON fixture requires dedicated synthetic label/
      );
    });
  }
});

test("duplicate JSON keys are rejected before every label-policy branch", async (t) => {
  const violation = {
    candidateId: "1000000009",
    business: "Sample Plumbing",
    eventDate: "2026-02-01 09:00:00",
    body: "ordinary customer request"
  };

  await t.test("reviewer shadowed legacy data payload", async () => {
    const raw = insertDuplicateBeforeKey(
      await fixtureText("columns-camel.json"),
      "data",
      [[violation]]
    );
    const root = await writeTempFixtureTree({ "columns-camel.json": raw });
    await assert.rejects(
      auditSyntheticFixtureTree(root),
      /fixture contains duplicate JSON key/
    );
  });

  await t.test("reviewer shadowed safe-empty columns payload", async () => {
    const raw = insertDuplicateBeforeKey(
      await fixtureText("columns-snake.json"),
      "columns",
      [violation]
    );
    const root = await writeTempFixtureTree({ "columns-snake.json": raw });
    await assert.rejects(
      auditSyntheticFixtureTree(root),
      /fixture contains duplicate JSON key/
    );
  });

  await t.test("dedicated-label top-level duplicate", async () => {
    const raw = JSON.stringify(safeAuditPayload()).replace(
      '"note":',
      '"note":"SYNTHETIC SHADOWED NOTE","note":'
    );
    const root = await writeTempFixtureTree({ "dedicated.json": raw });
    await assert.rejects(
      auditSyntheticFixtureTree(root),
      /fixture contains duplicate JSON key/
    );
  });

  await t.test("dedicated-label nested duplicate", async () => {
    const raw = JSON.stringify(safeAuditPayload()).replace(
      '"label":',
      '"label":"SHADOWED LABEL","label":'
    );
    const root = await writeTempFixtureTree({ "nested.json": raw });
    await assert.rejects(
      auditSyntheticFixtureTree(root),
      /fixture contains duplicate JSON key/
    );
  });

  await t.test("escaped spelling that decodes to an existing key", async () => {
    const raw = String.raw`{"syntheticMetadata":{"label":"SYNTHETIC FIXTURE ONLY","customerId":"1000000001","businessName":"Example Audit"},"note":"SYNTHETIC SHADOWED NOTE","n\u006fte":"SYNTHETIC AUDIT NOTE"}`;
    const root = await writeTempFixtureTree({ "escaped.json": raw });
    await assert.rejects(
      auditSyntheticFixtureTree(root),
      /fixture contains duplicate JSON key/
    );
  });

  const exactLegacyCases = [
    ["columns-camel.json", "columns", null],
    ["google-ads-results.json", "results", null],
    ["pagination/manifest.json", "schemaVersion", 999],
    ["pagination/page-1.json", "result", null],
    ["pagination/page-2.json", "columns", null]
  ];
  for (const [relativePath, key, shadowValue] of exactLegacyCases) {
    await t.test(`exact legacy policy: ${relativePath}`, async () => {
      const raw = insertDuplicateBeforeKey(
        await fixtureText(relativePath),
        key,
        shadowValue
      );
      const root = await writeTempFixtureTree({ [relativePath]: raw });
      await assert.rejects(
        auditSyntheticFixtureTree(root),
        /fixture contains duplicate JSON key/
      );
    });
  }

  const safeEmptyCases = ["columns-snake.json", "missing-column.json"];
  for (const relativePath of safeEmptyCases) {
    await t.test(`exact safe-empty policy: ${relativePath}`, async () => {
      const raw = insertDuplicateBeforeKey(
        await fixtureText(relativePath),
        "columns",
        null
      );
      const root = await writeTempFixtureTree({ [relativePath]: raw });
      await assert.rejects(
        auditSyntheticFixtureTree(root),
        /fixture contains duplicate JSON key/
      );
    });
  }
});

test("explicit time and duration keys do not exempt candidateId or create false IDs", async () => {
  const validRoot = await writeTempFixtureTree({
    "time-values.json": safeAuditPayload({
      eventDate: "2026-01-05 09:00:00",
      callDurationMillis: 1000000009,
      medianNanoseconds: "1000000009"
    })
  });
  await auditSyntheticFixtureTree(validRoot);

  const candidateRoot = await writeTempFixtureTree({
    "candidate.json": safeAuditPayload({ candidateId: "1000000009" })
  });
  await assert.rejects(
    auditSyntheticFixtureTree(candidateRoot),
    /numeric identifier is not allowlisted/
  );
});

test("recursive audit rejects hidden, structural, raw-text, and unscannable bypasses", async () => {
  const cases = [
    {
      name: "unlisted nested fixture",
      files: {
        "nested/unlisted.json": safeAuditPayload({
          alternateAccountId: "1000000009"
        })
      },
      expected: /account identifier is not allowlisted/
    },
    {
      name: "formatted nonallowlisted identifier",
      files: {
        "formatted.json": safeAuditPayload({
          alternateAccountIdentifier: "123-456-7890"
        })
      },
      expected: /account identifier is not allowlisted/
    },
    {
      name: "alternate lead identifier key",
      files: {
        "alternate-id.json": safeAuditPayload({
          leadReferenceId: "900000000100"
        })
      },
      expected: /lead identifier is not allowlisted/
    },
    {
      name: "alternate name key",
      files: {
        "alternate-name.json": safeAuditPayload({
          alternateBusinessName: "Sample Plumbing"
        })
      },
      expected: /name must begin with Example/
    },
    {
      name: "alternate message key",
      files: {
        "alternate-message.json": safeAuditPayload({
          alternateMessage: "unlabeled test message"
        })
      },
      expected: /message or error text must be synthetic-labeled/
    },
    {
      name: "alternate error key",
      files: {
        "alternate-error.json": safeAuditPayload({
          alternateError: "unlabeled test error"
        })
      },
      expected: /message or error text must be synthetic-labeled/
    },
    {
      name: "non-January event timestamp",
      files: {
        "wrong-month.json": safeAuditPayload({
          alternateEventTimestamp: "2026-02-01 09:00:00"
        })
      },
      expected: /event timestamp must be in January 2026/
    },
    {
      name: "phone-like contact marker",
      files: {
        "phone.json": safeAuditPayload({
          alternateMessage: "SYNTHETIC MESSAGE: 123-456-7890"
        })
      },
      expected: /phone-like value/
    },
    {
      name: "email-like contact marker",
      files: {
        "email.json": safeAuditPayload({
          alternateMessage: "SYNTHETIC MESSAGE: audit@example.test"
        })
      },
      expected: /email-like value/
    },
    {
      name: "address-like contact marker",
      files: {
        "address.json": safeAuditPayload({
          alternateMessage: "SYNTHETIC MESSAGE: 123 Example Street"
        })
      },
      expected: /address-like value/
    },
    {
      name: "brand-like marker",
      files: {
        "brand.json": safeAuditPayload({
          alternateMessage: "SYNTHETIC MESSAGE: BRAND-LIKE-TEST-MARKER"
        })
      },
      expected: /brand-like value/
    },
    {
      name: "POSIX user path",
      files: {
        "path.json": safeAuditPayload({
          alternateError: "SYNTHETIC ERROR: /Users/example/source.json"
        })
      },
      expected: /private-path form/
    },
    {
      name: "POSIX private path",
      files: {
        "path.json": safeAuditPayload({
          alternateError: "SYNTHETIC ERROR: /private/example/source.json"
        })
      },
      expected: /private-path form/
    },
    {
      name: "Windows user path",
      files: {
        "path.json": safeAuditPayload({
          alternateError: "SYNTHETIC ERROR: C:\\Users\\Example\\source.json"
        })
      },
      expected: /private-path form/
    },
    {
      name: "unexpected fixture type",
      files: { "unexpected.bin": Buffer.from("SYNTHETIC") },
      expected: /unsupported fixture file type/
    },
    {
      name: "invalid UTF-8 text",
      files: { "invalid.txt": Buffer.from([0xff]) },
      expected: /fixture must be valid UTF-8/
    },
    {
      name: "malformed JSON",
      files: { "malformed.json": "{ SYNTHETIC" },
      expected: /fixture must be valid JSON/
    }
  ];

  for (const fixtureCase of cases) {
    const root = await writeTempFixtureTree(fixtureCase.files);
    await assert.rejects(
      auditSyntheticFixtureTree(root),
      fixtureCase.expected,
      fixtureCase.name
    );
  }
});

test("the complete real fixture tree passes the recursive audit", async () => {
  const result = await auditSyntheticFixtureTree(fixtureRoot, {
    requiredLabels: requiredAssignedLabels
  });

  assert.ok(result.fileCount >= requiredAssignedLabels.size);
  assert.ok(result.relativePaths.includes("pagination/page-1.json"));
  assert.ok(result.relativePaths.includes("truncated-display.txt"));
  assert.deepEqual(result.observedAccountIds, allowedAccountIds);
  assert.deepEqual(result.observedLeadIds, allowedLeadIds);
});

test("normal envelopes are independently identical event for event", async () => {
  const columns = await fixtureJson("normal-columns.json");
  const objects = await fixtureJson("normal-objects.json");
  const events = assertRawNormalFixturesEquivalent(columns, objects);

  assert.equal(events.length, 19);
});

test("raw equivalence catches an aggregate-neutral fixture mutation", async () => {
  const columns = await fixtureJson("normal-columns.json");
  const objects = await fixtureJson("normal-objects.json");
  const mutated = structuredClone(objects);
  mutated.results[5].localServicesLeadConversation.messageDetails.text =
    "SYNTHETIC MESSAGE: changed reply gamma";

  assert.throws(
    () => assertRawNormalFixturesEquivalent(columns, mutated),
    /normal fixture semantic mismatch/
  );
});

test("every required synthetic fixture exists", async () => {
  const missing = [];
  const loaded = new Map();
  for (const [name] of requiredFixtures) {
    try {
      loaded.set(name, await fixtureText(name));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      missing.push(name);
    }
  }

  assert.deepEqual(missing, [], `Missing fixtures: ${missing.join(", ")}`);
});

test("columns and object fixtures produce identical hand-authored metrics", async () => {
  const columnsMetrics = await calculateFixture("normal-columns.json");
  const objectMetrics = await calculateFixture("normal-objects.json");
  const {
    syntheticMetadata,
    ...expected
  } = JSON.parse(await fixtureText("expected-normal.json"));

  assert.deepEqual(syntheticMetadata, { label: "SYNTHETIC FIXTURE ONLY" });
  assert.deepEqual(columnsMetrics, expected);
  assert.deepEqual(objectMetrics, expected);
});

test("both normal envelopes preserve the exact microsecond reply duration", async () => {
  for (const name of ["normal-columns.json", "normal-objects.json"]) {
    const { ingested } = await ingestFixture(name);
    const events = ingested.events.filter((event) =>
      event.leadId === "900000000001");
    assert.equal(events.length, 2);
    assert.equal(events[1].epochNanoseconds - events[0].epochNanoseconds,
      45_123_456_000n);
    assert.equal(events[1].fractionalDigits, 6);
  }
});

test("the no-activity fixture is valid and produces JSON-safe empty metrics", async () => {
  const result = await calculateFixture("no-activity.json");
  assert.deepEqual(result, {
    metricVersion: "lsa-responsiveness/v1",
    account: { key: "example-plumbing", name: "Example Plumbing" },
    counts: {
      repliedMessages: 0,
      recentUnansweredMessages: 0,
      oldUnansweredMessages: 0,
      eligibleMessages: 0,
      eligiblePhoneCalls: 0,
      connectedCalls: 0,
      totalEligible: 0,
      totalResponded: 0
    },
    rates: {
      totalResponsiveness: null,
      callsConnected: null,
      messagesReplied: null,
      repliedWithin24Hours: null
    },
    replySpeed: {
      medianNanoseconds: null,
      buckets: { within5m: 0, within1h: 0, within24h: 0, over24h: 0 }
    },
    diagnostics: { incompleteWindowLeads: 0, excludedLeadTypes: {} },
    recentUnanswered: []
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("every negative fixture reaches its intended sanitized error path", async () => {
  const ingestCases = [
    {
      name: "missing-fields.json",
      message: "Page 1: required columns are unavailable.",
      markers: ["SYNTHETIC_UNSUPPORTED_FIELD"],
      capability: true
    },
    {
      name: "malformed-row.json",
      message: "Page 1, row 1: row width does not match columns.",
      markers: ["900000000098", "SYNTHETIC MESSAGE: malformed row marker"]
    },
    {
      name: "unsupported-resource.json",
      message: "Page 1: unsupported response envelope.",
      markers: ["SYNTHETIC UNSUPPORTED RESOURCE DETAIL"],
      capability: true
    },
    {
      name: "authentication-error.json",
      message: "Page 1: connector error or truncation output.",
      markers: ["SYNTHETIC AUTHENTICATION FAILURE DETAIL"]
    },
    {
      name: "truncated-display.txt",
      message: "Page 1: connector error or truncation output.",
      markers: ["SYNTHETIC TRUNCATED DISPLAY DETAIL"]
    }
  ];

  for (const fixture of ingestCases) {
    await assert.rejects(
      ingestFixture(fixture.name),
      (error) => (fixture.capability
        ? assertSanitizedCapabilityError
        : assertSanitizedDataIntegrityError)(
          error,
          fixture.message,
          fixture.markers
        ),
      fixture.name
    );
  }

  const { account, ingested } = await ingestFixture("mixed-lead-types.json");
  const asOfNs = parseTimestamp(AS_OF, {
    timeZone: account.timeZone,
    disambiguation: "reject"
  }).epochNanoseconds;
  const windowStartNs = windowStartFor(
    AS_OF,
    account.timeZone,
    WINDOW_DAYS,
    "reject"
  );
  assert.throws(() => computeAccountMetrics({
    account: { key: account.key, name: account.name },
    events: ingested.events,
    asOfNs,
    windowStartNs
  }), (error) => assertSanitizedDataIntegrityError(
    error,
    "Metric events contain conflicting lead types.",
    ["900000000099", "MESSAGE", "PHONE_CALL", account.name]
  ));
});
