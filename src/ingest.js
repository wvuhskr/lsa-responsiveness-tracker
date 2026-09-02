import { resolveColumns } from "./columns.js";
import { CapabilityError, DataIntegrityError } from "./errors.js";
import { loadManifest, readValidatedPage } from "./manifest.js";
import { detectEnvelope } from "./probe.js";
import { parseStrictJson } from "./strict-json.js";
import { parseTimestamp } from "./timestamps.js";

const PARTICIPANTS = new Set(["CONSUMER", "ADVERTISER"]);
const OBJECT_PATHS = Object.freeze({
  leadId: Object.freeze(["localServicesLead", "id"]),
  leadType: Object.freeze(["localServicesLead", "leadType"]),
  participantType: Object.freeze([
    "localServicesLeadConversation", "participantType"
  ]),
  conversationChannel: Object.freeze([
    "localServicesLeadConversation", "conversationChannel"
  ]),
  callDurationMillis: Object.freeze([
    "localServicesLeadConversation", "phoneCallDetails", "callDurationMillis"
  ]),
  eventDateTime: Object.freeze([
    "localServicesLeadConversation", "eventDateTime"
  ]),
  messageText: Object.freeze([
    "localServicesLeadConversation", "messageDetails", "text"
  ])
});
const REQUIRED_OBJECT_FIELDS = Object.freeze([
  "leadId",
  "leadType",
  "participantType",
  "conversationChannel",
  "eventDateTime"
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pageFailure(pageNumber, category, rowNumber) {
  const location = rowNumber === undefined
    ? `Page ${pageNumber}`
    : `Page ${pageNumber}, row ${rowNumber}`;
  throw new DataIntegrityError(`${location}: ${category}.`);
}

function capabilityFailure(pageNumber, category) {
  throw new CapabilityError(`Page ${pageNumber}: ${category}.`);
}

function hasOwnPath(value, nestedPath) {
  let current = value;
  for (const key of nestedPath) {
    if (!isRecord(current) || !Object.hasOwn(current, key)) return false;
    current = current[key];
  }
  return true;
}

function valueAtPath(value, nestedPath) {
  return nestedPath.reduce((current, key) => current[key], value);
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

function responseContinuationValues(payload) {
  const candidates = [payload];
  if (isRecord(payload?.result)) candidates.push(payload.result);
  const values = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    for (const field of ["nextPageToken", "next_page_token"]) {
      if (Object.hasOwn(candidate, field)) values.push(candidate[field]);
    }
  }
  return values;
}

function reconcileResponsePagination(payload, manifest, page, pageNumber) {
  const values = responseContinuationValues(payload);
  if (values.length === 0) return;

  if (manifest.completion.method !== "all-page-tokens-consumed") {
    if (values.some((value) => value !== null && value !== "")) {
      pageFailure(pageNumber, "pagination evidence is inconsistent");
    }
    return;
  }

  const expected = page.nextPageToken;
  if (values.some((value) =>
    !(value === null || (typeof value === "string" && value.length > 0)) ||
    value !== expected)) {
    pageFailure(pageNumber, "pagination evidence is inconsistent");
  }
}

async function readPayload(page, pageNumber) {
  const text = readValidatedPage(page);

  let payload;
  try {
    payload = parseStrictJson(text);
  } catch {
    pageFailure(pageNumber, "malformed JSON");
  }
  if (hasConnectorFailureEvidence(payload) || typeof payload === "string") {
    pageFailure(pageNumber, "connector error or truncation output");
  }
  return payload;
}

function detectPageEnvelope(payload, pageNumber) {
  try {
    return detectEnvelope(payload);
  } catch (error) {
    if (error instanceof CapabilityError) {
      capabilityFailure(pageNumber, "unsupported response envelope");
    }
    throw error;
  }
}

function requiredString(value, field, pageNumber, rowNumber) {
  if (value === null || value === undefined ||
      (typeof value === "string" && value.trim().length === 0)) {
    pageFailure(pageNumber, `missing ${field}`, rowNumber);
  }
  if (typeof value !== "string") {
    pageFailure(pageNumber, `invalid ${field}`, rowNumber);
  }
  return value;
}

function enumValue(value, field, pageNumber, rowNumber) {
  return requiredString(value, field, pageNumber, rowNumber).toUpperCase();
}

function normalizedDuration(value, pageNumber, rowNumber) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    pageFailure(pageNumber, "invalid call duration", rowNumber);
  }
  return value;
}

function normalizedTimestamp(value, account, options, asOf, pageNumber, rowNumber) {
  requiredString(value, "event timestamp", pageNumber, rowNumber);
  let parsed;
  try {
    parsed = parseTimestamp(value, {
      timeZone: account.timeZone,
      disambiguation: options.disambiguation
    });
  } catch {
    pageFailure(pageNumber, "invalid event timestamp", rowNumber);
  }
  if (parsed.epochNanoseconds > asOf) {
    pageFailure(pageNumber, "event occurs after asOf", rowNumber);
  }
  return parsed;
}

function normalizeEvent(values, account, options, asOf, pageNumber, rowNumber) {
  const leadId = requiredString(values.leadId, "lead ID", pageNumber, rowNumber);
  const leadType = enumValue(values.leadType, "lead type", pageNumber, rowNumber);
  const participantType = enumValue(
    values.participantType,
    "participant type",
    pageNumber,
    rowNumber
  );
  if (!PARTICIPANTS.has(participantType)) {
    pageFailure(pageNumber, "invalid participant type", rowNumber);
  }
  const conversationChannel = enumValue(
    values.conversationChannel,
    "conversation channel",
    pageNumber,
    rowNumber
  );
  const callDurationMillis = normalizedDuration(
    values.callDurationMillis,
    pageNumber,
    rowNumber
  );
  const timestamp = normalizedTimestamp(
    values.eventDateTime,
    account,
    options,
    asOf,
    pageNumber,
    rowNumber
  );

  const event = {
    leadId,
    leadType,
    participantType,
    conversationChannel,
    callDurationMillis,
    epochNanoseconds: timestamp.epochNanoseconds,
    fractionalDigits: timestamp.fractionalDigits
  };
  if (options.includeMessageText && values.messageText !== null &&
      values.messageText !== undefined) {
    if (typeof values.messageText !== "string") {
      pageFailure(pageNumber, "invalid message text", rowNumber);
    }
    event.messageText = values.messageText;
  }
  return event;
}

function columnsContainer(payload) {
  return payload.result ?? payload;
}

function normalizeColumnsData(payload, account, options, asOf, pageNumber) {
  const container = columnsContainer(payload);
  if (!isRecord(container) || !Array.isArray(container.columns) ||
      !Array.isArray(container.data)) {
    capabilityFailure(pageNumber, "unsupported response envelope");
  }

  for (let index = 0; index < container.data.length; index += 1) {
    const row = container.data[index];
    if (!Array.isArray(row) || row.length !== container.columns.length) {
      pageFailure(pageNumber, "row width does not match columns", index + 1);
    }
  }

  let columns;
  try {
    columns = resolveColumns(container.columns);
  } catch (error) {
    if (error instanceof CapabilityError) {
      capabilityFailure(pageNumber, "required columns are unavailable");
    }
    throw error;
  }
  if (options.includeMessageText && columns.messageText === null) {
    capabilityFailure(pageNumber, "message-text capability is unavailable");
  }

  return {
    messageTextAvailable: columns.messageText !== null,
    events: container.data.map((row, index) => normalizeEvent({
      leadId: row[columns.leadId],
      leadType: row[columns.leadType],
      participantType: row[columns.participantType],
      conversationChannel: row[columns.conversationChannel],
      callDurationMillis: row[columns.callDurationMillis],
      eventDateTime: row[columns.eventDateTime],
      messageText: columns.messageText === null ? undefined : row[columns.messageText]
    }, account, options, asOf, pageNumber, index + 1))
  };
}

function normalizeGoogleAdsResults(payload, account, options, asOf, pageNumber) {
  if (!Array.isArray(payload.results) || payload.results.length === 0) {
    capabilityFailure(pageNumber, "Google Ads results cannot establish capabilities");
  }

  for (let index = 0; index < payload.results.length; index += 1) {
    const result = payload.results[index];
    if (!isRecord(result) || REQUIRED_OBJECT_FIELDS.some((field) =>
      !hasOwnPath(result, OBJECT_PATHS[field]))) {
      pageFailure(pageNumber, "required nested field is missing", index + 1);
    }
  }

  const messageTextAvailable = payload.results.some((result) =>
    hasOwnPath(result, OBJECT_PATHS.messageText));
  if (options.includeMessageText && !messageTextAvailable) {
    capabilityFailure(pageNumber, "message-text capability is unavailable");
  }

  return {
    messageTextAvailable,
    events: payload.results.map((result, index) => normalizeEvent({
      leadId: valueAtPath(result, OBJECT_PATHS.leadId),
      leadType: valueAtPath(result, OBJECT_PATHS.leadType),
      participantType: valueAtPath(result, OBJECT_PATHS.participantType),
      conversationChannel: valueAtPath(result, OBJECT_PATHS.conversationChannel),
      callDurationMillis: hasOwnPath(result, OBJECT_PATHS.callDurationMillis)
        ? valueAtPath(result, OBJECT_PATHS.callDurationMillis)
        : null,
      eventDateTime: valueAtPath(result, OBJECT_PATHS.eventDateTime),
      messageText: hasOwnPath(result, OBJECT_PATHS.messageText)
        ? valueAtPath(result, OBJECT_PATHS.messageText)
        : undefined
    }, account, options, asOf, pageNumber, index + 1))
  };
}

function normalizeOptions(account, options) {
  if (!isRecord(account) || typeof account.key !== "string" ||
      typeof account.timeZone !== "string" ||
      typeof account.inputManifest !== "string" || !isRecord(options) ||
      typeof options.asOf !== "string" ||
      (options.includeMessageText !== undefined &&
        typeof options.includeMessageText !== "boolean")) {
    throw new DataIntegrityError("Account ingestion options are invalid.");
  }

  const normalized = {
    asOf: options.asOf,
    includeMessageText: options.includeMessageText ?? false,
    disambiguation: options.disambiguation ?? "reject"
  };
  let asOf;
  try {
    asOf = parseTimestamp(normalized.asOf, {
      timeZone: account.timeZone,
      disambiguation: normalized.disambiguation
    }).epochNanoseconds;
  } catch {
    throw new DataIntegrityError("Account ingestion options are invalid.");
  }
  return { normalized, asOf };
}

export async function ingestAccount(account, options = {}) {
  const { normalized, asOf } = normalizeOptions(account, options);
  const manifest = await loadManifest(account.inputManifest);
  const events = [];
  const messageTextCapabilities = [];
  let envelope;

  for (let index = 0; index < manifest.pages.length; index += 1) {
    const pageNumber = index + 1;
    const payload = await readPayload(manifest.pages[index], pageNumber);
    reconcileResponsePagination(
      payload,
      manifest,
      manifest.pages[index],
      pageNumber
    );
    const detected = detectPageEnvelope(payload, pageNumber);
    if (manifest.format !== "auto" && detected !== manifest.format) {
      pageFailure(pageNumber, "response envelope does not match the manifest");
    }
    if (envelope !== undefined && detected !== envelope) {
      pageFailure(pageNumber, "response envelope does not match earlier pages");
    }
    envelope ??= detected;

    const page = detected === "columns-data"
      ? normalizeColumnsData(payload, account, normalized, asOf, pageNumber)
      : normalizeGoogleAdsResults(payload, account, normalized, asOf, pageNumber);
    events.push(...page.events);
    messageTextCapabilities.push(page.messageTextAvailable);
  }

  return {
    accountKey: account.key,
    events,
    capability: {
      envelope,
      completionMethod: manifest.completion.method,
      messageTextAvailable: messageTextCapabilities.every(Boolean),
      pageCount: manifest.pages.length
    }
  };
}
