import { CapabilityError } from "./errors.js";
import { resolveColumns } from "./columns.js";

const REQUIRED_FIELDS = Object.freeze([
  "leadId",
  "leadType",
  "participantType",
  "conversationChannel",
  "callDurationMillis",
  "eventDateTime"
]);
const GOOGLE_ADS_REQUIRED_PATHS = Object.freeze([
  Object.freeze(["localServicesLead", "id"]),
  Object.freeze(["localServicesLead", "leadType"]),
  Object.freeze(["localServicesLeadConversation", "participantType"]),
  Object.freeze(["localServicesLeadConversation", "conversationChannel"]),
  Object.freeze(["localServicesLeadConversation", "eventDateTime"])
]);
const GOOGLE_ADS_MESSAGE_TEXT_PATH = Object.freeze([
  "localServicesLeadConversation",
  "messageDetails",
  "text"
]);
const GOOGLE_ADS_CAPABILITY_ERROR = "Google Ads results cannot establish capabilities.";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function columnsDataContainer(payload) {
  const candidate = isRecord(payload?.result) ? payload.result : payload;
  return isRecord(candidate) && Array.isArray(candidate.columns) && Array.isArray(candidate.data)
    ? candidate
    : null;
}

export function detectEnvelope(payload) {
  if (columnsDataContainer(payload)) return "columns-data";
  if (isRecord(payload) && Array.isArray(payload.results)) return "google-ads-results";
  throw new CapabilityError("Unsupported response envelope.");
}

function hasOwnPath(value, path) {
  let current = value;
  for (const key of path) {
    if (!isRecord(current) || !Object.hasOwn(current, key)) return false;
    current = current[key];
  }
  return true;
}

function validateGoogleAdsResults(results, requireMessageText) {
  if (results.length === 0) throw new CapabilityError(GOOGLE_ADS_CAPABILITY_ERROR);
  if (results.some((result) =>
    GOOGLE_ADS_REQUIRED_PATHS.some((path) => !hasOwnPath(result, path)))) {
    throw new CapabilityError(GOOGLE_ADS_CAPABILITY_ERROR);
  }

  const messageTextAvailable = results.some((result) =>
    hasOwnPath(result, GOOGLE_ADS_MESSAGE_TEXT_PATH));
  if (requireMessageText && !messageTextAvailable) {
    throw new CapabilityError(GOOGLE_ADS_CAPABILITY_ERROR);
  }
  return messageTextAvailable;
}

function requiredFields(messageTextAvailable) {
  return Object.fromEntries([
    ...REQUIRED_FIELDS.map((field) => [field, true]),
    ["messageText", messageTextAvailable]
  ]);
}

export function probePayload(payload, { requireMessageText = false } = {}) {
  const envelope = detectEnvelope(payload);
  const container = columnsDataContainer(payload);
  const messageTextAvailable = container
    ? resolveColumns(container.columns, { requireMessageText }).messageText !== null
    : validateGoogleAdsResults(payload.results, requireMessageText);

  return {
    supported: true,
    envelope,
    requiredFields: requiredFields(messageTextAvailable),
    rowContainerPresent: true,
    pagination: "not-declared"
  };
}
