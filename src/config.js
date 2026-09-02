import { readFile } from "node:fs/promises";
import path from "node:path";
import { UsageError } from "./errors.js";
import { parseStrictJson } from "./strict-json.js";
import { isNamedIanaTimeZone } from "./timestamps.js";

const DEFAULTS = Object.freeze({
  display: { goodThreshold: 90, midThreshold: 75 },
  privacy: {
    includeLeadIds: true,
    includeMessageText: false,
    messageSnippetCharacters: 120
  },
  output: { writeActionCsv: false },
  timestamps: { dstDisambiguation: "reject" },
  history: { enabled: true, path: "history.json" }
});

const TOP_LEVEL_KEYS = new Set([
  "schemaVersion", "asOf", "windowDays", "accounts", "display", "privacy",
  "output", "timestamps", "history"
]);
const ACCOUNT_KEYS = new Set(["key", "name", "customerId", "timeZone", "inputManifest"]);
const DISPLAY_KEYS = new Set(["goodThreshold", "midThreshold"]);
const PRIVACY_KEYS = new Set([
  "includeLeadIds", "includeMessageText", "messageSnippetCharacters"
]);
const OUTPUT_KEYS = new Set(["writeActionCsv"]);
const TIMESTAMP_KEYS = new Set(["dstDisambiguation"]);
const HISTORY_KEYS = new Set(["enabled", "path"]);
const ISO_TIMESTAMP_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

export function validateTimeZone(zone) {
  return isNamedIanaTimeZone(zone);
}

function requireCondition(condition, message) {
  if (!condition) throw new UsageError(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownKeys(value, allowedKeys, label) {
  requireCondition(isRecord(value), label);
  for (const key of Object.keys(value)) {
    requireCondition(allowedKeys.has(key), `${label}.${key}`);
  }
}

function mergeSection(raw, defaults, allowedKeys, label) {
  if (raw === undefined) return { ...defaults };
  rejectUnknownKeys(raw, allowedKeys, label);
  return { ...defaults, ...raw };
}

function validatePercentage(value, field) {
  requireCondition(Number.isFinite(value) && value >= 0 && value <= 100, field);
}

function isIsoTimestampWithOffset(value) {
  if (typeof value !== "string") return false;
  const match = ISO_TIMESTAMP_WITH_OFFSET.exec(value);
  if (!match) return false;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText,
    offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30,
    31, 31, 30, 31, 30, 31];

  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1] &&
    hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59;
}

export async function loadConfig(configPath, outputDir) {
  const absoluteConfig = path.resolve(configPath);
  const configDir = path.dirname(absoluteConfig);
  let raw;
  try {
    raw = parseStrictJson(await readFile(absoluteConfig, "utf8"));
  } catch {
    throw new UsageError("Configuration must be readable valid JSON.");
  }

  rejectUnknownKeys(raw, TOP_LEVEL_KEYS, "configuration");
  requireCondition(raw.schemaVersion === 1, "schemaVersion");
  requireCondition(
    isIsoTimestampWithOffset(raw.asOf),
    "asOf"
  );
  requireCondition(
    Number.isInteger(raw.windowDays) && raw.windowDays >= 1 && raw.windowDays <= 365,
    "windowDays"
  );
  requireCondition(Array.isArray(raw.accounts) && raw.accounts.length > 0, "accounts");

  const accountKeys = new Set();
  const accounts = raw.accounts.map((account, index) => {
    const label = `accounts[${index}]`;
    rejectUnknownKeys(account, ACCOUNT_KEYS, label);
    requireCondition(
      typeof account.key === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(account.key),
      `${label}.key`
    );
    requireCondition(!accountKeys.has(account.key), `${label}.key`);
    accountKeys.add(account.key);
    requireCondition(typeof account.name === "string" && account.name.trim().length > 0,
      `${label}.name`);
    requireCondition(typeof account.customerId === "string" && /^\d{10}$/.test(account.customerId),
      `${label}.customerId`);
    requireCondition(validateTimeZone(account.timeZone), `${label}.timeZone`);
    requireCondition(typeof account.inputManifest === "string" && account.inputManifest.length > 0,
      `${label}.inputManifest`);
    return {
      ...account,
      inputManifest: path.resolve(configDir, account.inputManifest)
    };
  });

  const display = mergeSection(raw.display, DEFAULTS.display, DISPLAY_KEYS, "display");
  const privacy = mergeSection(raw.privacy, DEFAULTS.privacy, PRIVACY_KEYS, "privacy");
  const output = mergeSection(raw.output, DEFAULTS.output, OUTPUT_KEYS, "output");
  const timestamps = mergeSection(
    raw.timestamps, DEFAULTS.timestamps, TIMESTAMP_KEYS, "timestamps"
  );
  const history = mergeSection(raw.history, DEFAULTS.history, HISTORY_KEYS, "history");

  validatePercentage(display.goodThreshold, "display.goodThreshold");
  validatePercentage(display.midThreshold, "display.midThreshold");
  requireCondition(display.goodThreshold >= display.midThreshold, "display.goodThreshold");
  requireCondition(typeof privacy.includeLeadIds === "boolean", "privacy.includeLeadIds");
  requireCondition(typeof privacy.includeMessageText === "boolean", "privacy.includeMessageText");
  requireCondition(
    Number.isInteger(privacy.messageSnippetCharacters) &&
      privacy.messageSnippetCharacters >= 1 && privacy.messageSnippetCharacters <= 500,
    "privacy.messageSnippetCharacters"
  );
  requireCondition(typeof output.writeActionCsv === "boolean", "output.writeActionCsv");
  requireCondition(
    ["reject", "earlier", "later"].includes(timestamps.dstDisambiguation),
    "timestamps.dstDisambiguation"
  );
  requireCondition(typeof history.enabled === "boolean", "history.enabled");
  requireCondition(typeof history.path === "string" && history.path.length > 0, "history.path");

  return {
    schemaVersion: 1,
    asOf: raw.asOf,
    windowDays: raw.windowDays,
    accounts,
    display,
    privacy,
    output,
    timestamps,
    history: {
      enabled: history.enabled,
      path: path.resolve(outputDir, history.path)
    },
    configPath: absoluteConfig,
    outputDir: path.resolve(outputDir)
  };
}
