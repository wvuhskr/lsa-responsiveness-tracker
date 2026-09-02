import { DataIntegrityError } from "./errors.js";
import { isNamedIanaTimeZone, parseTimestamp } from "./timestamps.js";

const PRODUCT = "lsa-responsiveness-tracker";
const SCHEMA_VERSION = 1;
const METRIC_VERSION = "lsa-responsiveness/v1";
const MAX_ACCOUNTS = 1_000;
const MAX_HISTORY_POINTS = 100_000;
const MAX_RECENT_UNANSWERED = 100_000;
const ACCOUNT_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENUM_VALUE = /^[A-Z][A-Z0-9_]*$/;
const CANONICAL_UNSIGNED_INTEGER = /^(?:0|[1-9]\d*)$/;
const CANONICAL_MEDIAN = /^(?:0|[1-9]\d*)(?:\.5)?$/;
const ISO_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|[+-](\d{2}):(\d{2}))$/;

const INPUT_FIELDS = new Set([
  "mode", "generatedAt", "asOf", "windowDays", "privacy", "output",
  "accounts", "historyPoints"
]);
const INPUT_ACCOUNT_FIELDS = new Set([
  "metrics", "timeZone", "capability", "completion"
]);
const METRICS_FIELDS = new Set([
  "metricVersion", "account", "counts", "rates", "replySpeed",
  "diagnostics", "recentUnanswered"
]);
const METRIC_ACCOUNT_FIELDS = new Set(["key", "name"]);
const COUNT_FIELDS = Object.freeze([
  "repliedMessages",
  "recentUnansweredMessages",
  "oldUnansweredMessages",
  "eligibleMessages",
  "eligiblePhoneCalls",
  "connectedCalls",
  "totalEligible",
  "totalResponded"
]);
const RATE_FIELDS = Object.freeze([
  "totalResponsiveness",
  "callsConnected",
  "messagesReplied",
  "repliedWithin24Hours"
]);
const BUCKET_FIELDS = Object.freeze([
  "within5m", "within1h", "within24h", "over24h"
]);
const FIXED_DIAGNOSTIC_FIELDS = Object.freeze([
  "incompleteWindowLeads", "bookingLeads", "unsupportedLeadTypes"
]);
const REQUIRED_CAPABILITY_FIELDS = Object.freeze([
  "leadId",
  "leadType",
  "participantType",
  "conversationChannel",
  "callDurationMillis",
  "eventDateTime",
  "messageText"
]);
const HISTORY_FIELDS = new Set([
  "accountKey", "accountName", "asOf", "windowDays", "metricVersion",
  ...COUNT_FIELDS, ...RATE_FIELDS, "medianReplyNanoseconds",
  "replySpeedBuckets", "diagnostics"
]);
const MODEL_FIELDS = new Set([
  "product", "schemaVersion", "mode", "generatedAt", "asOf", "windowDays",
  "privacy", "caveats", "accounts"
]);
const MODEL_ACCOUNT_FIELDS = new Set([
  "key", "name", "timeZone", "metricVersion", "counts", "rates",
  "replySpeed", "diagnostics", "capability", "completion",
  "recentUnanswered", "trend"
]);

const CAVEATS = Object.freeze({
  metric: "This report is a response-time and lead-status proxy, not Google's official Local Services Ads responsiveness figure.",
  phone: "Phone connection is approximate because missing inbound-call duration is not definitive evidence of a missed call.",
  privacy: "Generated reports stay local; treat private reports and action lists as sensitive lead data."
});

class InvalidReport extends Error {}

function invalid() {
  throw new InvalidReport();
}

function exactRecord(value, allowed) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  if (Object.getOwnPropertySymbols(value).length !== 0) invalid();
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== allowed.size) invalid();
  for (const key of keys) {
    if (!allowed.has(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value") ||
        descriptor.enumerable !== true) {
      invalid();
    }
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) invalid();
  }
  return value;
}

function exactOptionalRecord(value, allowed, required) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  if (Object.getOwnPropertySymbols(value).length !== 0) invalid();
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!allowed.has(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value") ||
        descriptor.enumerable !== true) {
      invalid();
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) invalid();
  }
  return value;
}

function denseArray(value, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > maximum || Object.getOwnPropertySymbols(value).length !== 0) {
    invalid();
  }
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) invalid();
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value") ||
        descriptor.enumerable !== true) {
      invalid();
    }
  }
  return value;
}

function validString(value, maximum = 512) {
  return typeof value === "string" && value.length > 0 &&
    value.length <= maximum && !value.includes("\u0000");
}

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

function validRate(value) {
  return value === null || (Number.isFinite(value) && value >= 0 &&
    value <= 1 && !Object.is(value, -0));
}

function expectedRate(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function validTimestamp(value) {
  if (!validString(value, 64)) return false;
  const match = ISO_WITH_OFFSET.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] &&
    hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 &&
    offsetMinute <= 59;
}

function validTimeZone(value) {
  return validString(value, 128) && isNamedIanaTimeZone(value);
}

function canonicalCounts(value) {
  exactRecord(value, new Set(COUNT_FIELDS));
  const counts = {};
  for (const field of COUNT_FIELDS) {
    if (!validCount(value[field])) invalid();
    counts[field] = value[field];
  }
  if (counts.eligibleMessages !== counts.repliedMessages +
        counts.recentUnansweredMessages ||
      counts.connectedCalls > counts.eligiblePhoneCalls ||
      counts.totalEligible !== counts.eligibleMessages +
        counts.eligiblePhoneCalls ||
      counts.totalResponded !== counts.repliedMessages +
        counts.connectedCalls ||
      counts.totalResponded > counts.totalEligible) {
    invalid();
  }
  return counts;
}

function canonicalRates(value, counts, buckets) {
  exactRecord(value, new Set(RATE_FIELDS));
  const rates = {};
  for (const field of RATE_FIELDS) {
    if (!validRate(value[field])) invalid();
    rates[field] = value[field];
  }
  const within24 = buckets.within5m + buckets.within1h + buckets.within24h;
  if (rates.totalResponsiveness !== expectedRate(
        counts.totalResponded, counts.totalEligible) ||
      rates.callsConnected !== expectedRate(
        counts.connectedCalls, counts.eligiblePhoneCalls) ||
      rates.messagesReplied !== expectedRate(
        counts.repliedMessages, counts.eligibleMessages) ||
      rates.repliedWithin24Hours !== expectedRate(
        within24, counts.eligibleMessages)) {
    invalid();
  }
  return rates;
}

function canonicalBuckets(value, repliedMessages) {
  exactRecord(value, new Set(BUCKET_FIELDS));
  const buckets = {};
  let sum = 0;
  for (const field of BUCKET_FIELDS) {
    if (!validCount(value[field])) invalid();
    sum += value[field];
    if (!Number.isSafeInteger(sum)) invalid();
    buckets[field] = value[field];
  }
  if (sum !== repliedMessages) invalid();
  return buckets;
}

function canonicalMedian(value, repliedMessages) {
  if (value === null) {
    if (repliedMessages !== 0) invalid();
    return null;
  }
  const text = typeof value === "bigint" ? value.toString() : value;
  if (repliedMessages === 0 || typeof text !== "string" ||
      text.length > 128 || !CANONICAL_MEDIAN.test(text)) {
    invalid();
  }
  return text;
}

function canonicalMetricDiagnostics(value) {
  exactRecord(value, new Set(["incompleteWindowLeads", "excludedLeadTypes"]));
  if (!validCount(value.incompleteWindowLeads)) invalid();
  const excluded = value.excludedLeadTypes;
  if (excluded === null || typeof excluded !== "object" ||
      Array.isArray(excluded) ||
      (Object.getPrototypeOf(excluded) !== Object.prototype &&
        Object.getPrototypeOf(excluded) !== null) ||
      Object.getOwnPropertySymbols(excluded).length !== 0) {
    invalid();
  }
  let bookingLeads = 0;
  let unsupportedLeadTypes = 0;
  for (const key of Object.getOwnPropertyNames(excluded)) {
    const descriptor = Object.getOwnPropertyDescriptor(excluded, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value") ||
        descriptor.enumerable !== true || !ENUM_VALUE.test(key) ||
        key.length > 128 || !validCount(excluded[key])) {
      invalid();
    }
    if (key === "BOOKING") {
      bookingLeads = excluded[key];
    } else {
      unsupportedLeadTypes += excluded[key];
      if (!Number.isSafeInteger(unsupportedLeadTypes)) invalid();
    }
  }
  return {
    incompleteWindowLeads: value.incompleteWindowLeads,
    bookingLeads,
    unsupportedLeadTypes
  };
}

function canonicalFixedDiagnostics(value) {
  exactRecord(value, new Set(FIXED_DIAGNOSTIC_FIELDS));
  const result = {};
  for (const field of FIXED_DIAGNOSTIC_FIELDS) {
    if (!validCount(value[field])) invalid();
    result[field] = value[field];
  }
  return result;
}

function canonicalCapability(value) {
  exactRecord(value, new Set([
    "supported", "envelope", "requiredFields", "rowContainerPresent",
    "pagination"
  ]));
  if (value.supported !== true || value.rowContainerPresent !== true ||
      !["columns-data", "google-ads-results"].includes(value.envelope) ||
      !["not-declared", "single-page", "paginated"].includes(value.pagination)) {
    invalid();
  }
  exactRecord(value.requiredFields, new Set(REQUIRED_CAPABILITY_FIELDS));
  const requiredFields = {};
  for (const field of REQUIRED_CAPABILITY_FIELDS) {
    if (typeof value.requiredFields[field] !== "boolean" ||
        (field !== "messageText" && value.requiredFields[field] !== true)) {
      invalid();
    }
    requiredFields[field] = value.requiredFields[field];
  }
  return {
    supported: true,
    envelope: value.envelope,
    requiredFields,
    rowContainerPresent: true,
    pagination: value.pagination
  };
}

function canonicalCompletion(value) {
  exactRecord(value, new Set(["method", "pageCount"]));
  if (!["single-page-no-continuation", "all-page-tokens-consumed",
    "connector-complete-saved-result"].includes(value.method) ||
      !Number.isSafeInteger(value.pageCount) || value.pageCount < 1 ||
      (value.method !== "all-page-tokens-consumed" && value.pageCount !== 1)) {
    invalid();
  }
  return { method: value.method, pageCount: value.pageCount };
}

function canonicalRecentUnanswered(value, privacy) {
  const records = denseArray(value, MAX_RECENT_UNANSWERED);
  return records.map((record) => {
    exactOptionalRecord(
      record,
      new Set(["leadId", "firstContactEpochNanoseconds", "messageText"]),
      new Set(["leadId", "firstContactEpochNanoseconds"])
    );
    if (!validString(record.leadId, 512)) invalid();
    const contact = typeof record.firstContactEpochNanoseconds === "bigint"
      ? record.firstContactEpochNanoseconds.toString()
      : record.firstContactEpochNanoseconds;
    if (typeof contact !== "string" || contact.length > 128 ||
        !CANONICAL_UNSIGNED_INTEGER.test(contact)) {
      invalid();
    }
    if (Object.hasOwn(record, "messageText") &&
        typeof record.messageText !== "string") {
      invalid();
    }
    const selected = { firstContactEpochNanoseconds: contact };
    if (privacy.includeLeadIds) selected.leadId = record.leadId;
    if (privacy.includeMessageText && Object.hasOwn(record, "messageText")) {
      selected.messageText = Array.from(record.messageText)
        .slice(0, privacy.messageSnippetCharacters)
        .join("");
    }
    return selected;
  });
}

function canonicalMetrics(value, privacy) {
  exactRecord(value, METRICS_FIELDS);
  if (value.metricVersion !== METRIC_VERSION) invalid();
  exactRecord(value.account, METRIC_ACCOUNT_FIELDS);
  if (!validString(value.account.key, 128) ||
      !ACCOUNT_KEY.test(value.account.key) ||
      !validString(value.account.name, 256)) {
    invalid();
  }
  const counts = canonicalCounts(value.counts);
  exactRecord(value.replySpeed, new Set(["medianNanoseconds", "buckets"]));
  const buckets = canonicalBuckets(value.replySpeed.buckets, counts.repliedMessages);
  const rates = canonicalRates(value.rates, counts, buckets);
  const medianNanoseconds = canonicalMedian(
    value.replySpeed.medianNanoseconds,
    counts.repliedMessages
  );
  const recentUnanswered = canonicalRecentUnanswered(
    value.recentUnanswered,
    privacy
  );
  if (recentUnanswered.length !== counts.recentUnansweredMessages) invalid();
  return {
    key: value.account.key,
    name: value.account.name,
    metricVersion: METRIC_VERSION,
    counts,
    rates,
    replySpeed: { medianNanoseconds, buckets },
    diagnostics: canonicalMetricDiagnostics(value.diagnostics),
    recentUnanswered
  };
}

function canonicalHistoryPoint(value) {
  exactRecord(value, HISTORY_FIELDS);
  if (!validString(value.accountKey, 128) ||
      !ACCOUNT_KEY.test(value.accountKey) ||
      !validString(value.accountName, 256) || !validTimestamp(value.asOf) ||
      !Number.isInteger(value.windowDays) || value.windowDays < 1 ||
      value.windowDays > 365 || value.metricVersion !== METRIC_VERSION) {
    invalid();
  }
  const counts = canonicalCounts(Object.fromEntries(
    COUNT_FIELDS.map((field) => [field, value[field]])
  ));
  const buckets = canonicalBuckets(value.replySpeedBuckets, counts.repliedMessages);
  const rates = canonicalRates(Object.fromEntries(
    RATE_FIELDS.map((field) => [field, value[field]])
  ), counts, buckets);
  canonicalMedian(value.medianReplyNanoseconds, counts.repliedMessages);
  canonicalFixedDiagnostics(value.diagnostics);
  return {
    accountKey: value.accountKey,
    asOf: value.asOf,
    epochNanoseconds: parseTimestamp(value.asOf).epochNanoseconds,
    windowDays: value.windowDays,
    metricVersion: value.metricVersion,
    totalResponded: counts.totalResponded,
    totalEligible: counts.totalEligible,
    totalResponsiveness: rates.totalResponsiveness
  };
}

function compareTrend(left, right) {
  if (left.epochNanoseconds < right.epochNanoseconds) return -1;
  if (left.epochNanoseconds > right.epochNanoseconds) return 1;
  return left.asOf < right.asOf ? -1 : left.asOf > right.asOf ? 1 : 0;
}

function trendForAccount(points, key, windowDays, reportAsOfNs) {
  const result = points.filter((point) =>
    point.accountKey === key && point.windowDays === windowDays &&
    point.metricVersion === METRIC_VERSION && point.totalResponsiveness !== null &&
    point.epochNanoseconds <= reportAsOfNs)
    .sort(compareTrend)
    .map((point) => ({
      asOf: point.asOf,
      totalResponded: point.totalResponded,
      totalEligible: point.totalEligible,
      totalResponsiveness: point.totalResponsiveness
    }));
  return result.length >= 2 ? result : [];
}

function canonicalPrivacy(value, output) {
  exactRecord(value, new Set([
    "includeLeadIds", "includeMessageText", "messageSnippetCharacters"
  ]));
  exactRecord(output, new Set(["writeActionCsv"]));
  if (typeof value.includeLeadIds !== "boolean" ||
      typeof value.includeMessageText !== "boolean" ||
      !Number.isInteger(value.messageSnippetCharacters) ||
      value.messageSnippetCharacters < 1 || value.messageSnippetCharacters > 500 ||
      typeof output.writeActionCsv !== "boolean") {
    invalid();
  }
  return {
    includeLeadIds: value.includeLeadIds,
    includeMessageText: value.includeMessageText,
    messageSnippetCharacters: value.messageSnippetCharacters,
    writeActionCsv: output.writeActionCsv
  };
}

function toJsonSafe(value, seen = new Set()) {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value === "string" ||
      typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid();
    return value;
  }
  if (typeof value !== "object" || seen.has(value)) invalid();
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    denseArray(value, Math.max(MAX_HISTORY_POINTS, MAX_RECENT_UNANSWERED));
    result = value.map((item) => toJsonSafe(item, seen));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null ||
        Object.getOwnPropertySymbols(value).length !== 0) {
      invalid();
    }
    result = {};
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, "value") ||
          descriptor.enumerable !== true) {
        invalid();
      }
      result[key] = toJsonSafe(value[key], seen);
    }
  }
  seen.delete(value);
  return result;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validateModelAccount(account, privacy, reportAsOfNs) {
  exactRecord(account, MODEL_ACCOUNT_FIELDS);
  if (!validString(account.key, 128) || !ACCOUNT_KEY.test(account.key) ||
      !validString(account.name, 256) || !validTimeZone(account.timeZone) ||
      account.metricVersion !== METRIC_VERSION) {
    invalid();
  }
  const counts = canonicalCounts(account.counts);
  exactRecord(account.replySpeed, new Set(["medianNanoseconds", "buckets"]));
  const buckets = canonicalBuckets(account.replySpeed.buckets, counts.repliedMessages);
  canonicalRates(account.rates, counts, buckets);
  canonicalMedian(account.replySpeed.medianNanoseconds, counts.repliedMessages);
  canonicalFixedDiagnostics(account.diagnostics);
  const capability = canonicalCapability(account.capability);
  if (privacy.includeMessageText && !capability.requiredFields.messageText) {
    invalid();
  }
  canonicalCompletion(account.completion);
  const recent = denseArray(account.recentUnanswered, MAX_RECENT_UNANSWERED);
  if (recent.length !== counts.recentUnansweredMessages) invalid();
  for (const record of recent) {
    const allowed = new Set(["firstContactEpochNanoseconds"]);
    const required = new Set(["firstContactEpochNanoseconds"]);
    if (privacy.includeLeadIds) {
      allowed.add("leadId");
      required.add("leadId");
    }
    if (privacy.includeMessageText) allowed.add("messageText");
    exactOptionalRecord(record, allowed, required);
    if (!CANONICAL_UNSIGNED_INTEGER.test(record.firstContactEpochNanoseconds) ||
        (privacy.includeLeadIds && !validString(record.leadId, 512)) ||
        (Object.hasOwn(record, "messageText") &&
          typeof record.messageText !== "string") ||
        (Object.hasOwn(record, "messageText") &&
          Array.from(record.messageText).length > privacy.messageSnippetCharacters)) {
      invalid();
    }
  }
  const trend = denseArray(account.trend, MAX_HISTORY_POINTS);
  if (trend.length === 1) invalid();
  let previousTrendNs;
  for (const point of trend) {
    exactRecord(point, new Set([
      "asOf", "totalResponded", "totalEligible", "totalResponsiveness"
    ]));
    if (!validTimestamp(point.asOf) || !validCount(point.totalResponded) ||
        !validCount(point.totalEligible) || point.totalEligible === 0 ||
        point.totalResponded > point.totalEligible ||
        !validRate(point.totalResponsiveness) ||
        point.totalResponsiveness !== expectedRate(
          point.totalResponded, point.totalEligible)) {
      invalid();
    }
    const pointNs = parseTimestamp(point.asOf).epochNanoseconds;
    if (pointNs > reportAsOfNs ||
        (previousTrendNs !== undefined && pointNs <= previousTrendNs)) {
      invalid();
    }
    previousTrendNs = pointNs;
  }
}

function validateBuiltModel(model) {
  exactRecord(model, MODEL_FIELDS);
  if (model.product !== PRODUCT || model.schemaVersion !== SCHEMA_VERSION ||
      !["private", "synthetic"].includes(model.mode) ||
      !validTimestamp(model.generatedAt) || !validTimestamp(model.asOf) ||
      !Number.isInteger(model.windowDays) || model.windowDays < 1 ||
      model.windowDays > 365) {
    invalid();
  }
  exactRecord(model.privacy, new Set([
    "includeLeadIds", "includeMessageText", "messageSnippetCharacters",
    "writeActionCsv"
  ]));
  if (typeof model.privacy.includeLeadIds !== "boolean" ||
      typeof model.privacy.includeMessageText !== "boolean" ||
      !Number.isInteger(model.privacy.messageSnippetCharacters) ||
      model.privacy.messageSnippetCharacters < 1 ||
      model.privacy.messageSnippetCharacters > 500 ||
      typeof model.privacy.writeActionCsv !== "boolean") {
    invalid();
  }
  exactRecord(model.caveats, new Set(["metric", "phone", "privacy"]));
  if (model.caveats.metric !== CAVEATS.metric ||
      model.caveats.phone !== CAVEATS.phone ||
      model.caveats.privacy !== CAVEATS.privacy) {
    invalid();
  }
  const accounts = denseArray(model.accounts, MAX_ACCOUNTS);
  if (accounts.length === 0) invalid();
  const keys = new Set();
  const reportAsOfNs = parseTimestamp(model.asOf).epochNanoseconds;
  for (const account of accounts) {
    validateModelAccount(account, model.privacy, reportAsOfNs);
    if (keys.has(account.key)) invalid();
    keys.add(account.key);
  }
  toJsonSafe(model);
}

export function assertReportModel(model) {
  try {
    validateBuiltModel(model);
    return model;
  } catch {
    throw new DataIntegrityError("Report model is invalid.");
  }
}

export function buildReportModel(input) {
  try {
    exactRecord(input, INPUT_FIELDS);
    if (!["private", "synthetic"].includes(input.mode) ||
        !validTimestamp(input.generatedAt) || !validTimestamp(input.asOf) ||
        !Number.isInteger(input.windowDays) || input.windowDays < 1 ||
        input.windowDays > 365) {
      invalid();
    }
    const privacy = canonicalPrivacy(input.privacy, input.output);
    const reportAsOfNs = parseTimestamp(input.asOf).epochNanoseconds;
    const historyPoints = denseArray(input.historyPoints, MAX_HISTORY_POINTS)
      .map(canonicalHistoryPoint);
    const historyIdentities = new Set();
    for (const point of historyPoints) {
      const identity = [
        point.accountKey, point.asOf, point.windowDays, point.metricVersion
      ].join("\u0000");
      if (historyIdentities.has(identity)) invalid();
      historyIdentities.add(identity);
    }
    const accountInputs = denseArray(input.accounts, MAX_ACCOUNTS);
    if (accountInputs.length === 0) invalid();
    const keys = new Set();
    const accounts = accountInputs.map((accountInput) => {
      exactRecord(accountInput, INPUT_ACCOUNT_FIELDS);
      if (!validTimeZone(accountInput.timeZone)) invalid();
      const metric = canonicalMetrics(accountInput.metrics, privacy);
      if (keys.has(metric.key)) invalid();
      keys.add(metric.key);
      const capability = canonicalCapability(accountInput.capability);
      if (privacy.includeMessageText && !capability.requiredFields.messageText) {
        invalid();
      }
      return {
        key: metric.key,
        name: metric.name,
        timeZone: accountInput.timeZone,
        metricVersion: metric.metricVersion,
        counts: metric.counts,
        rates: metric.rates,
        replySpeed: metric.replySpeed,
        diagnostics: metric.diagnostics,
        capability,
        completion: canonicalCompletion(accountInput.completion),
        recentUnanswered: metric.recentUnanswered,
        trend: trendForAccount(
          historyPoints,
          metric.key,
          input.windowDays,
          reportAsOfNs
        )
      };
    });
    const model = toJsonSafe({
      product: PRODUCT,
      schemaVersion: SCHEMA_VERSION,
      mode: input.mode,
      generatedAt: input.generatedAt,
      asOf: input.asOf,
      windowDays: input.windowDays,
      privacy,
      caveats: CAVEATS,
      accounts
    });
    validateBuiltModel(model);
    return deepFreeze(model);
  } catch {
    throw new DataIntegrityError("Report input is invalid.");
  }
}
