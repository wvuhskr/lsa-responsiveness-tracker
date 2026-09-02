import { DataIntegrityError } from "./errors.js";

const METRIC_VERSION = "lsa-responsiveness/v1";
const PARTICIPANT_TYPES = new Set(["CONSUMER", "ADVERTISER"]);
const INCLUDED_LEAD_TYPES = new Set(["MESSAGE", "PHONE_CALL"]);
const ENUM_VALUE = /^[A-Z][A-Z0-9_]*$/;
const NS_PER_SECOND = 1_000_000_000n;
const NS_PER_MINUTE = 60n * NS_PER_SECOND;
const NS_PER_HOUR = 60n * NS_PER_MINUTE;
const NS_PER_DAY = 24n * NS_PER_HOUR;
const RECENT_MESSAGE_NS = 7n * NS_PER_DAY;
const FIVE_MINUTES_NS = 5n * NS_PER_MINUTE;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function failInput() {
  throw new DataIntegrityError("Metric input is invalid.");
}

function failWindow() {
  throw new DataIntegrityError("Metric window bounds are invalid.");
}

function failEvent() {
  throw new DataIntegrityError("Metric event is invalid.");
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isEnumValue(value) {
  return typeof value === "string" && ENUM_VALUE.test(value);
}

function validateInput(input) {
  if (!isRecord(input) || !isRecord(input.account) ||
      !isNonEmptyString(input.account.key) ||
      !isNonEmptyString(input.account.name) || !Array.isArray(input.events)) {
    failInput();
  }
  if (typeof input.asOfNs !== "bigint" ||
      typeof input.windowStartNs !== "bigint" ||
      input.windowStartNs >= input.asOfNs) {
    failWindow();
  }
}

function validateEvent(event) {
  if (!isRecord(event) || !isNonEmptyString(event.leadId) ||
      !isEnumValue(event.leadType) ||
      !PARTICIPANT_TYPES.has(event.participantType) ||
      !isEnumValue(event.conversationChannel) ||
      !Object.hasOwn(event, "callDurationMillis") ||
      !(event.callDurationMillis === null ||
        (Number.isSafeInteger(event.callDurationMillis) &&
          event.callDurationMillis >= 0)) ||
      typeof event.epochNanoseconds !== "bigint" ||
      !Object.hasOwn(event, "fractionalDigits") ||
      !Number.isInteger(event.fractionalDigits) ||
      event.fractionalDigits < 0 || event.fractionalDigits > 9 ||
      (Object.hasOwn(event, "messageText") &&
        typeof event.messageText !== "string")) {
    failEvent();
  }
}

function compareBigInts(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function groupInWindowEvents(events, windowStartNs, asOfNs) {
  const groups = new Map();

  for (const event of events) {
    validateEvent(event);
    if (event.epochNanoseconds > asOfNs) {
      throw new DataIntegrityError("Metric event occurs after asOf.");
    }
    if (event.epochNanoseconds <= windowStartNs) continue;

    let group = groups.get(event.leadId);
    if (group === undefined) {
      group = { leadType: event.leadType, events: [] };
      groups.set(event.leadId, group);
    } else if (group.leadType !== event.leadType) {
      throw new DataIntegrityError(
        "Metric events contain conflicting lead types."
      );
    }
    group.events.push(event);
  }

  for (const group of groups.values()) {
    group.events.sort((left, right) => compareBigInts(
      left.epochNanoseconds,
      right.epochNanoseconds
    ));
  }
  return groups;
}

function emptyCounts() {
  return {
    repliedMessages: 0,
    recentUnansweredMessages: 0,
    oldUnansweredMessages: 0,
    eligibleMessages: 0,
    eligiblePhoneCalls: 0,
    connectedCalls: 0,
    totalEligible: 0,
    totalResponded: 0
  };
}

function emptyBuckets() {
  return { within5m: 0, within1h: 0, within24h: 0, over24h: 0 };
}

function addReplyBucket(buckets, duration) {
  if (duration <= FIVE_MINUTES_NS) {
    buckets.within5m += 1;
  } else if (duration <= NS_PER_HOUR) {
    buckets.within1h += 1;
  } else if (duration <= NS_PER_DAY) {
    buckets.within24h += 1;
  } else {
    buckets.over24h += 1;
  }
}

function exactMedian(values) {
  if (values.length === 0) return null;
  values.sort(compareBigInts);
  const middle = Math.floor(values.length / 2);
  if (values.length % 2 === 1) return values[middle].toString();

  const sum = values[middle - 1] + values[middle];
  const whole = sum / 2n;
  return sum % 2n === 0n ? whole.toString() : `${whole}.5`;
}

function rate(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function assertFormulaInvariants(counts, buckets, recentUnanswered) {
  const bucketReplies = buckets.within5m + buckets.within1h +
    buckets.within24h + buckets.over24h;
  if (counts.eligibleMessages !== counts.repliedMessages +
        counts.recentUnansweredMessages ||
      counts.totalEligible !== counts.eligibleMessages +
        counts.eligiblePhoneCalls ||
      counts.totalResponded !== counts.repliedMessages +
        counts.connectedCalls ||
      counts.totalResponded > counts.totalEligible ||
      bucketReplies !== counts.repliedMessages ||
      recentUnanswered.length !== counts.recentUnansweredMessages) {
    throw new DataIntegrityError("Metric formula invariant failed.");
  }
}

function incrementExcluded(excludedLeadTypes, leadType) {
  excludedLeadTypes.set(
    leadType,
    (excludedLeadTypes.get(leadType) ?? 0) + 1
  );
}

function stableExcludedLeadTypes(excludedLeadTypes) {
  return Object.fromEntries(
    [...excludedLeadTypes.entries()].sort(([left], [right]) =>
      compareStrings(left, right))
  );
}

function stableRecentUnanswered(records) {
  records.sort((left, right) => {
    const timeOrder = compareBigInts(left.firstContactNs, right.firstContactNs);
    return timeOrder === 0
      ? compareStrings(left.record.leadId, right.record.leadId)
      : timeOrder;
  });
  return records.map(({ record }) => record);
}

function earliestConsumerEvents(events) {
  const firstConsumer = events.find((event) =>
    event.participantType === "CONSUMER");
  if (firstConsumer === undefined) return [];
  return events.filter((event) =>
    event.participantType === "CONSUMER" &&
    event.epochNanoseconds === firstConsumer.epochNanoseconds);
}

function sharedNonEmptyMessageText(events) {
  const first = events[0];
  if (!Object.hasOwn(first, "messageText") || first.messageText.length === 0) {
    return undefined;
  }
  return events.every((event) =>
    Object.hasOwn(event, "messageText") &&
    event.messageText === first.messageText)
    ? first.messageText
    : undefined;
}

export function computeAccountMetrics(input) {
  validateInput(input);
  const groups = groupInWindowEvents(
    input.events,
    input.windowStartNs,
    input.asOfNs
  );
  const counts = emptyCounts();
  const buckets = emptyBuckets();
  const replyDurations = [];
  const recentRecords = [];
  const excludedLeadTypes = new Map();
  const recentBoundaryNs = input.asOfNs - RECENT_MESSAGE_NS;
  let incompleteWindowLeads = 0;

  const orderedGroups = [...groups.entries()].sort(([left], [right]) =>
    compareStrings(left, right));
  for (const [leadId, group] of orderedGroups) {
    const includedLeadType = INCLUDED_LEAD_TYPES.has(group.leadType);
    if (!includedLeadType) {
      incrementExcluded(excludedLeadTypes, group.leadType);
    }

    const firstContacts = earliestConsumerEvents(group.events);
    if (firstContacts.length === 0) {
      incompleteWindowLeads += 1;
      continue;
    }
    const firstContact = firstContacts[0];
    if (!includedLeadType) continue;

    if (group.leadType === "MESSAGE") {
      const firstResponse = group.events.find((event) =>
        event.participantType === "ADVERTISER" &&
        event.epochNanoseconds >= firstContact.epochNanoseconds);
      if (firstResponse !== undefined) {
        const duration = firstResponse.epochNanoseconds -
          firstContact.epochNanoseconds;
        counts.repliedMessages += 1;
        replyDurations.push(duration);
        addReplyBucket(buckets, duration);
      } else if (firstContact.epochNanoseconds >= recentBoundaryNs) {
        counts.recentUnansweredMessages += 1;
        const record = {
          leadId,
          firstContactEpochNanoseconds:
            firstContact.epochNanoseconds.toString()
        };
        const messageText = sharedNonEmptyMessageText(firstContacts);
        if (messageText !== undefined) {
          record.messageText = messageText;
        }
        recentRecords.push({
          firstContactNs: firstContact.epochNanoseconds,
          record
        });
      } else {
        counts.oldUnansweredMessages += 1;
      }
      continue;
    }

    counts.eligiblePhoneCalls += 1;
    const connected = group.events.some((event) =>
      event.participantType === "ADVERTISER") ||
      group.events.some((event) =>
        event.participantType === "CONSUMER" &&
        event.conversationChannel === "PHONE_CALL" &&
        event.callDurationMillis !== null &&
        event.callDurationMillis > 1000);
    if (connected) counts.connectedCalls += 1;
  }

  counts.eligibleMessages = counts.repliedMessages +
    counts.recentUnansweredMessages;
  counts.totalEligible = counts.eligibleMessages + counts.eligiblePhoneCalls;
  counts.totalResponded = counts.repliedMessages + counts.connectedCalls;
  const recentUnanswered = stableRecentUnanswered(recentRecords);
  assertFormulaInvariants(counts, buckets, recentUnanswered);

  const repliesWithin24Hours = buckets.within5m + buckets.within1h +
    buckets.within24h;
  return {
    metricVersion: METRIC_VERSION,
    account: { key: input.account.key, name: input.account.name },
    counts,
    rates: {
      totalResponsiveness: rate(counts.totalResponded, counts.totalEligible),
      callsConnected: rate(counts.connectedCalls, counts.eligiblePhoneCalls),
      messagesReplied: rate(counts.repliedMessages, counts.eligibleMessages),
      repliedWithin24Hours: rate(
        repliesWithin24Hours,
        counts.eligibleMessages
      )
    },
    replySpeed: {
      medianNanoseconds: exactMedian(replyDurations),
      buckets
    },
    diagnostics: {
      incompleteWindowLeads,
      excludedLeadTypes: stableExcludedLeadTypes(excludedLeadTypes)
    },
    recentUnanswered
  };
}
