import assert from "node:assert/strict";
import test from "node:test";

import { DataIntegrityError } from "../src/errors.js";
import { computeAccountMetrics } from "../src/metrics.js";

const NS_PER_SECOND = 1_000_000_000n;
const NS_PER_MINUTE = 60n * NS_PER_SECOND;
const NS_PER_HOUR = 60n * NS_PER_MINUTE;
const NS_PER_DAY = 24n * NS_PER_HOUR;
const AS_OF_NS = 20n * NS_PER_DAY;
const WINDOW_START_NS = 0n;
const ACCOUNT = Object.freeze({ key: "example", name: "Synthetic Example" });

function event(leadId, leadType, participantType, conversationChannel,
  callDurationMillis, epochNanoseconds, options = {}) {
  const normalized = {
    leadId,
    leadType,
    participantType,
    conversationChannel,
    callDurationMillis,
    epochNanoseconds,
    fractionalDigits: 9
  };
  if (Object.hasOwn(options, "messageText")) {
    normalized.messageText = options.messageText;
  }
  return normalized;
}

function metricInput(events, overrides = {}) {
  return {
    account: ACCOUNT,
    asOfNs: AS_OF_NS,
    windowStartNs: WINDOW_START_NS,
    events,
    ...overrides
  };
}

function assertMetricRejected(action, pattern, markers = []) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof DataIntegrityError);
    assert.equal(error.code, "DATA_INTEGRITY");
    assert.equal(error.exitCode, 4);
    assert.match(error.message, pattern);
    for (const marker of markers) {
      assert.equal(error.message.includes(marker), false);
    }
    return true;
  });
}

test("computes the stable blended shape and applies the strict call threshold", () => {
  const result = computeAccountMetrics(metricInput([
    event("message-1", "MESSAGE", "CONSUMER", "SMS", null,
      1n * NS_PER_DAY),
    event("message-1", "MESSAGE", "ADVERTISER", "SMS", null,
      1n * NS_PER_DAY + NS_PER_MINUTE),
    event("call-1000", "PHONE_CALL", "CONSUMER", "PHONE_CALL", 1000,
      2n * NS_PER_DAY),
    event("call-1001", "PHONE_CALL", "CONSUMER", "PHONE_CALL", 1001,
      3n * NS_PER_DAY)
  ]));

  assert.deepEqual(result, {
    metricVersion: "lsa-responsiveness/v1",
    account: { key: "example", name: "Synthetic Example" },
    counts: {
      repliedMessages: 1,
      recentUnansweredMessages: 0,
      oldUnansweredMessages: 0,
      eligibleMessages: 1,
      eligiblePhoneCalls: 2,
      connectedCalls: 1,
      totalEligible: 3,
      totalResponded: 2
    },
    rates: {
      totalResponsiveness: 2 / 3,
      callsConnected: 0.5,
      messagesReplied: 1,
      repliedWithin24Hours: 1
    },
    replySpeed: {
      medianNanoseconds: "60000000000",
      buckets: { within5m: 1, within1h: 0, within24h: 0, over24h: 0 }
    },
    diagnostics: {
      incompleteWindowLeads: 0,
      excludedLeadTypes: {}
    },
    recentUnanswered: []
  });
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("counts a callback after contact and ignores an earlier advertiser event", () => {
  const contact = AS_OF_NS - NS_PER_DAY;
  const result = computeAccountMetrics(metricInput([
    event("callback", "MESSAGE", "CONSUMER", "SMS", null, contact),
    event("callback", "MESSAGE", "ADVERTISER", "PHONE_CALL", null,
      contact + 5n * NS_PER_SECOND),
    event("earlier-only", "MESSAGE", "ADVERTISER", "SMS", null,
      contact - 10n * NS_PER_SECOND),
    event("earlier-only", "MESSAGE", "CONSUMER", "EMAIL", null, contact)
  ]));

  assert.equal(result.counts.repliedMessages, 1);
  assert.equal(result.counts.recentUnansweredMessages, 1);
  assert.equal(result.counts.eligibleMessages, 2);
  assert.equal(result.rates.messagesReplied, 0.5);
  assert.equal(result.replySpeed.medianNanoseconds, "5000000000");
});

test("accepts an advertiser event tied with first contact regardless of row order", () => {
  const tiedAt = AS_OF_NS - NS_PER_DAY;
  const result = computeAccountMetrics(metricInput([
    event("tie", "MESSAGE", "ADVERTISER", "PHONE_CALL", null, tiedAt),
    event("tie", "MESSAGE", "CONSUMER", "SMS", null, tiedAt)
  ]));

  assert.equal(result.counts.repliedMessages, 1);
  assert.equal(result.replySpeed.medianNanoseconds, "0");
  assert.deepEqual(result.replySpeed.buckets,
    { within5m: 1, within1h: 0, within24h: 0, over24h: 0 });
});

test("omits differing text from tied first contacts in every permutation", () => {
  const tiedAt = AS_OF_NS - NS_PER_DAY;
  const first = event("different-text", "MESSAGE", "CONSUMER", "SMS", null,
    tiedAt, { messageText: "SYNTHETIC TIED TEXT A" });
  const second = event("different-text", "MESSAGE", "CONSUMER", "SMS", null,
    tiedAt, { messageText: "SYNTHETIC TIED TEXT B" });

  const forward = computeAccountMetrics(metricInput([first, second]));
  const reverse = computeAccountMetrics(metricInput([second, first]));

  assert.deepEqual(reverse, forward);
  assert.equal(forward.counts.repliedMessages, 0);
  assert.equal(forward.counts.recentUnansweredMessages, 1);
  assert.deepEqual(forward.recentUnanswered, [{
    leadId: "different-text",
    firstContactEpochNanoseconds: tiedAt.toString()
  }]);
});

test("omits text when one tied first contact has no text in every permutation", () => {
  const tiedAt = AS_OF_NS - NS_PER_DAY;
  const present = event("missing-text", "MESSAGE", "CONSUMER", "SMS", null,
    tiedAt, { messageText: "SYNTHETIC TIED PRESENT TEXT" });
  const absent = event("missing-text", "MESSAGE", "CONSUMER", "SMS", null,
    tiedAt);

  const forward = computeAccountMetrics(metricInput([present, absent]));
  const reverse = computeAccountMetrics(metricInput([absent, present]));

  assert.deepEqual(reverse, forward);
  assert.equal(forward.counts.repliedMessages, 0);
  assert.equal(forward.counts.recentUnansweredMessages, 1);
  assert.deepEqual(forward.recentUnanswered, [{
    leadId: "missing-text",
    firstContactEpochNanoseconds: tiedAt.toString()
  }]);
});

test("retains identical nonempty text from tied first contacts in every permutation", () => {
  const tiedAt = AS_OF_NS - NS_PER_DAY;
  const first = event("identical-text", "MESSAGE", "CONSUMER", "SMS", null,
    tiedAt, { messageText: "SYNTHETIC IDENTICAL TIED TEXT" });
  const second = event("identical-text", "MESSAGE", "CONSUMER", "EMAIL", null,
    tiedAt, { messageText: "SYNTHETIC IDENTICAL TIED TEXT" });

  const forward = computeAccountMetrics(metricInput([first, second]));
  const reverse = computeAccountMetrics(metricInput([second, first]));

  assert.deepEqual(reverse, forward);
  assert.equal(forward.counts.repliedMessages, 0);
  assert.equal(forward.counts.recentUnansweredMessages, 1);
  assert.deepEqual(forward.recentUnanswered, [{
    leadId: "identical-text",
    firstContactEpochNanoseconds: tiedAt.toString(),
    messageText: "SYNTHETIC IDENTICAL TIED TEXT"
  }]);
});

test("omits empty text even when every tied first contact has it", () => {
  const tiedAt = AS_OF_NS - NS_PER_DAY;
  const result = computeAccountMetrics(metricInput([
    event("empty-text", "MESSAGE", "CONSUMER", "SMS", null, tiedAt,
      { messageText: "" }),
    event("empty-text", "MESSAGE", "CONSUMER", "EMAIL", null, tiedAt,
      { messageText: "" })
  ]));

  assert.deepEqual(result.recentUnanswered, [{
    leadId: "empty-text",
    firstContactEpochNanoseconds: tiedAt.toString()
  }]);
});

test("keeps replied messages eligible when first contact is older than seven days", () => {
  const firstContact = AS_OF_NS - 7n * NS_PER_DAY - 1n;
  const result = computeAccountMetrics(metricInput([
    event("old-but-replied", "MESSAGE", "CONSUMER", "SMS", null,
      firstContact),
    event("old-but-replied", "MESSAGE", "ADVERTISER", "SMS", null,
      firstContact + 10n)
  ]));

  assert.equal(result.counts.repliedMessages, 1);
  assert.equal(result.counts.eligibleMessages, 1);
  assert.equal(result.counts.oldUnansweredMessages, 0);
  assert.equal(result.rates.messagesReplied, 1);
});

test("includes the exact seven-day boundary and excludes one nanosecond older", () => {
  const boundary = AS_OF_NS - 7n * NS_PER_DAY;
  const result = computeAccountMetrics(metricInput([
    event("recent-with-text", "MESSAGE", "CONSUMER", "SMS", null, boundary,
      { messageText: "SYNTHETIC OPT-IN FIRST CONTACT" }),
    event("old", "MESSAGE", "CONSUMER", "SMS", null, boundary - 1n,
      { messageText: "SYNTHETIC OLD TEXT" }),
    event("recent-no-first-text", "MESSAGE", "CONSUMER", "EMAIL", null,
      boundary + 1n),
    event("recent-no-first-text", "MESSAGE", "CONSUMER", "SMS", null,
      boundary + 2n, { messageText: "SYNTHETIC LATER TEXT" })
  ]));

  assert.equal(result.counts.recentUnansweredMessages, 2);
  assert.equal(result.counts.oldUnansweredMessages, 1);
  assert.equal(result.counts.eligibleMessages, 2);
  assert.deepEqual(result.recentUnanswered, [
    {
      leadId: "recent-with-text",
      firstContactEpochNanoseconds: boundary.toString(),
      messageText: "SYNTHETIC OPT-IN FIRST CONTACT"
    },
    {
      leadId: "recent-no-first-text",
      firstContactEpochNanoseconds: (boundary + 1n).toString()
    }
  ]);
  assert.equal(result.recentUnanswered.some((lead) =>
    lead.messageText === "SYNTHETIC LATER TEXT"), false);
  assert.equal(JSON.stringify(result).includes("SYNTHETIC OLD TEXT"), false);
});

test("diagnoses no-consumer leads and counts every excluded lead type", () => {
  const result = computeAccountMetrics(metricInput([
    event("message-edge", "MESSAGE", "ADVERTISER", "SMS", null,
      AS_OF_NS - NS_PER_DAY),
    event("booking", "BOOKING", "CONSUMER", "BOOKING", null,
      AS_OF_NS - NS_PER_DAY),
    event("unknown", "SYNTHETIC_OTHER", "CONSUMER", "EMAIL", null,
      AS_OF_NS - NS_PER_DAY),
    event("unknown-edge", "SYNTHETIC_EDGE", "ADVERTISER", "EMAIL", null,
      AS_OF_NS - NS_PER_DAY)
  ]));

  assert.deepEqual(result.counts, {
    repliedMessages: 0,
    recentUnansweredMessages: 0,
    oldUnansweredMessages: 0,
    eligibleMessages: 0,
    eligiblePhoneCalls: 0,
    connectedCalls: 0,
    totalEligible: 0,
    totalResponded: 0
  });
  assert.deepEqual(result.rates, {
    totalResponsiveness: null,
    callsConnected: null,
    messagesReplied: null,
    repliedWithin24Hours: null
  });
  assert.equal(result.diagnostics.incompleteWindowLeads, 2);
  assert.deepEqual(result.diagnostics.excludedLeadTypes, {
    BOOKING: 1,
    SYNTHETIC_EDGE: 1,
    SYNTHETIC_OTHER: 1
  });
});

test("reports a no-consumer unknown lead in both orthogonal diagnostics only", () => {
  const result = computeAccountMetrics(metricInput([
    event("orthogonal", "SYNTHETIC_UNKNOWN", "ADVERTISER", "EMAIL", null,
      AS_OF_NS - NS_PER_DAY)
  ]));

  assert.equal(result.diagnostics.incompleteWindowLeads, 1);
  assert.deepEqual(result.diagnostics.excludedLeadTypes,
    { SYNTHETIC_UNKNOWN: 1 });
  assert.deepEqual(result.counts, {
    repliedMessages: 0,
    recentUnansweredMessages: 0,
    oldUnansweredMessages: 0,
    eligibleMessages: 0,
    eligiblePhoneCalls: 0,
    connectedCalls: 0,
    totalEligible: 0,
    totalResponded: 0
  });
});

test("filters the exact window start before grouping and includes exact asOf", () => {
  const result = computeAccountMetrics(metricInput([
    event("mixed-at-edge", "PHONE_CALL", "CONSUMER", "PHONE_CALL", 1001,
      WINDOW_START_NS),
    event("mixed-at-edge", "MESSAGE", "CONSUMER", "SMS", null,
      AS_OF_NS - 1n),
    event("mixed-at-edge", "MESSAGE", "ADVERTISER", "SMS", null,
      AS_OF_NS),
    event("start-only", "MESSAGE", "ADVERTISER", "SMS", null,
      WINDOW_START_NS),
    event("before-start", "PHONE_CALL", "CONSUMER", "PHONE_CALL", 1001,
      WINDOW_START_NS - 1n)
  ]));

  assert.equal(result.counts.repliedMessages, 1);
  assert.equal(result.counts.eligiblePhoneCalls, 0);
  assert.equal(result.diagnostics.incompleteWindowLeads, 0);
  assert.equal(result.replySpeed.medianNanoseconds, "1");
});

test("connects phone leads by any advertiser but not by duration on another channel", () => {
  const contact = AS_OF_NS - NS_PER_DAY;
  const result = computeAccountMetrics(metricInput([
    event("advertiser-connect", "PHONE_CALL", "ADVERTISER", "EMAIL", null,
      contact - 1n),
    event("advertiser-connect", "PHONE_CALL", "CONSUMER", "SMS", 1001,
      contact),
    event("wrong-channel", "PHONE_CALL", "CONSUMER", "SMS", 1001,
      contact)
  ]));

  assert.equal(result.counts.eligiblePhoneCalls, 2);
  assert.equal(result.counts.connectedCalls, 1);
  assert.equal(result.rates.callsConnected, 0.5);
});

test("uses exact reply-bucket boundaries and an exact half-nanosecond median", () => {
  const firstContact = NS_PER_DAY;
  const delays = [
    5n * NS_PER_MINUTE,
    5n * NS_PER_MINUTE + 1n,
    NS_PER_HOUR,
    NS_PER_HOUR + 1n,
    NS_PER_DAY,
    NS_PER_DAY + 1n
  ];
  const events = [];
  for (let index = 0; index < delays.length; index += 1) {
    const leadId = `bucket-${index + 1}`;
    events.push(
      event(leadId, "MESSAGE", "CONSUMER", "SMS", null, firstContact),
      event(leadId, "MESSAGE", "ADVERTISER", "SMS", null,
        firstContact + delays[index])
    );
  }

  const result = computeAccountMetrics(metricInput(events));

  assert.deepEqual(result.replySpeed.buckets,
    { within5m: 1, within1h: 2, within24h: 2, over24h: 1 });
  assert.equal(result.replySpeed.medianNanoseconds, "3600000000000.5");
  assert.equal(result.rates.repliedWithin24Hours, 5 / 6);
});

test("returns JSON-safe null rates and null median when there is no data", () => {
  const result = computeAccountMetrics(metricInput([]));

  assert.deepEqual(result, {
    metricVersion: "lsa-responsiveness/v1",
    account: { key: "example", name: "Synthetic Example" },
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
    diagnostics: {
      incompleteWindowLeads: 0,
      excludedLeadTypes: {}
    },
    recentUnanswered: []
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("rejects conflicting in-window lead types without exposing row values", () => {
  const privateLeadId = "SYNTHETIC-PRIVATE-CONFLICT-ID";
  const privateAccount = {
    key: "private-key-marker",
    name: "SYNTHETIC PRIVATE ACCOUNT NAME"
  };

  assertMetricRejected(() => computeAccountMetrics(metricInput([
    event(privateLeadId, "MESSAGE", "CONSUMER", "SMS", null,
      AS_OF_NS - 2n),
    event(privateLeadId, "PHONE_CALL", "CONSUMER", "PHONE_CALL", 1001,
      AS_OF_NS - 1n)
  ], { account: privateAccount })), /conflicting lead types/, [
    privateLeadId,
    privateAccount.key,
    privateAccount.name,
    "MESSAGE",
    "PHONE_CALL"
  ]);
});

test("rejects invalid window metadata and future events deterministically", () => {
  for (const overrides of [
    { asOfNs: 1 },
    { windowStartNs: "0" },
    { windowStartNs: AS_OF_NS },
    { windowStartNs: AS_OF_NS + 1n }
  ]) {
    assertMetricRejected(
      () => computeAccountMetrics(metricInput([], overrides)),
      /window bounds are invalid/
    );
  }

  const futureMarker = "SYNTHETIC-FUTURE-PRIVATE-ID";
  assertMetricRejected(() => computeAccountMetrics(metricInput([
    event(futureMarker, "MESSAGE", "CONSUMER", "SMS", null,
      AS_OF_NS + 1n)
  ])), /event occurs after asOf/, [futureMarker]);
});

test("rejects malformed normalized inputs with sanitized errors", () => {
  const valid = event("SYNTHETIC-VALID-ROW-ID", "MESSAGE", "CONSUMER", "SMS", null,
    AS_OF_NS - 1n);
  const invalidInputs = [
    null,
    metricInput([], { account: { key: "", name: "Synthetic Example" } }),
    metricInput("not-an-array")
  ];
  for (const invalidInput of invalidInputs) {
    assertMetricRejected(
      () => computeAccountMetrics(invalidInput),
      /Metric input is invalid/
    );
  }

  const invalidEvents = [
    { ...valid, leadId: "" },
    { ...valid, leadType: "message" },
    { ...valid, participantType: "SYSTEM" },
    { ...valid, conversationChannel: "sms" },
    { ...valid, callDurationMillis: -1 },
    { ...valid, callDurationMillis: 1.5 },
    { ...valid, epochNanoseconds: "1" },
    { ...valid, messageText: 7 },
    Object.fromEntries(Object.entries(valid).filter(([key]) =>
      key !== "callDurationMillis"))
  ];
  for (const invalidEvent of invalidEvents) {
    assertMetricRejected(() => computeAccountMetrics(metricInput([
      { ...invalidEvent, privateMarker: "SYNTHETIC PRIVATE ROW VALUE" }
    ])), /Metric event is invalid/, [
      "SYNTHETIC PRIVATE ROW VALUE",
      "SYNTHETIC-VALID-ROW-ID",
      "SYSTEM"
    ]);
  }
});

test("rejects invalid fractionalDigits metadata with sanitized errors", () => {
  const valid = event("SYNTHETIC-FRACTION-ROW", "MESSAGE", "CONSUMER", "SMS",
    null, AS_OF_NS - 1n);
  const withoutFractionalDigits = Object.fromEntries(
    Object.entries(valid).filter(([key]) => key !== "fractionalDigits")
  );
  const invalidEvents = [
    withoutFractionalDigits,
    { ...valid, fractionalDigits: "9" },
    { ...valid, fractionalDigits: -1 },
    { ...valid, fractionalDigits: 10 },
    { ...valid, fractionalDigits: 1.5 }
  ];

  for (const invalidEvent of invalidEvents) {
    assertMetricRejected(() => computeAccountMetrics(metricInput([
      { ...invalidEvent, privateMarker: "SYNTHETIC FRACTION PRIVATE VALUE" }
    ])), /Metric event is invalid/, [
      "SYNTHETIC-FRACTION-ROW",
      "SYNTHETIC FRACTION PRIVATE VALUE"
    ]);
  }
});

test("accepts fractionalDigits at both inclusive bounds", () => {
  const zero = event("fraction-zero", "PHONE_CALL", "CONSUMER", "PHONE_CALL",
    1001, AS_OF_NS - 2n);
  const nine = event("fraction-nine", "PHONE_CALL", "CONSUMER", "PHONE_CALL",
    1001, AS_OF_NS - 1n);
  zero.fractionalDigits = 0;
  nine.fractionalDigits = 9;

  const result = computeAccountMetrics(metricInput([zero, nine]));

  assert.equal(result.counts.eligiblePhoneCalls, 2);
  assert.equal(result.counts.connectedCalls, 2);
});

test("is deterministic and does not mutate normalized event input", () => {
  const originalEvents = [
    event("pure", "MESSAGE", "ADVERTISER", "SMS", null,
      AS_OF_NS - 1n),
    event("pure", "MESSAGE", "CONSUMER", "SMS", null,
      AS_OF_NS - 2n)
  ];
  const originalOrder = originalEvents.map((item) => item.epochNanoseconds);
  for (const item of originalEvents) Object.freeze(item);
  Object.freeze(originalEvents);
  const input = Object.freeze(metricInput(originalEvents));

  const first = computeAccountMetrics(input);
  const second = computeAccountMetrics(input);

  assert.deepEqual(second, first);
  assert.deepEqual(originalEvents.map((item) => item.epochNanoseconds),
    originalOrder);
  assert.doesNotThrow(() => JSON.stringify(first));
});
