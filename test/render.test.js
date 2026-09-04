import assert from "node:assert/strict";
import test from "node:test";

import { DataIntegrityError } from "../src/errors.js";
import { buildReportModel } from "../src/report-model.js";
import { renderCsv } from "../src/render-csv.js";
import { renderHtml } from "../src/render-html.js";
import { renderJson } from "../src/render-json.js";

const REQUIRED_FIELDS = Object.freeze({
  leadId: true,
  leadType: true,
  participantType: true,
  conversationChannel: true,
  callDurationMillis: true,
  eventDateTime: true,
  messageText: true
});

function metrics(overrides = {}) {
  const value = {
    metricVersion: "lsa-responsiveness/v1",
    account: {
      key: "example-heating",
      name: "Synthetic Example Heating"
    },
    counts: {
      repliedMessages: 3,
      recentUnansweredMessages: 1,
      oldUnansweredMessages: 2,
      eligibleMessages: 4,
      eligiblePhoneCalls: 3,
      connectedCalls: 2,
      totalEligible: 7,
      totalResponded: 5
    },
    rates: {
      totalResponsiveness: 5 / 7,
      callsConnected: 2 / 3,
      messagesReplied: 3 / 4,
      repliedWithin24Hours: 2 / 4
    },
    replySpeed: {
      medianNanoseconds: "3900000000000",
      buckets: {
        within5m: 1,
        within1h: 1,
        within24h: 0,
        over24h: 1
      }
    },
    diagnostics: {
      incompleteWindowLeads: 2,
      excludedLeadTypes: {
        BOOKING: 1,
        SYNTHETIC_PRIVATE_LIKE_DYNAMIC_LABEL: 3
      }
    },
    recentUnanswered: [{
      leadId: "900000000001",
      firstContactEpochNanoseconds: 1_769_888_400_000_000_000n,
      messageText: "SYNTHETIC FOLLOW UP"
    }]
  };
  return {
    ...value,
    ...overrides,
    account: { ...value.account, ...overrides.account },
    counts: { ...value.counts, ...overrides.counts },
    rates: { ...value.rates, ...overrides.rates },
    replySpeed: {
      ...value.replySpeed,
      ...overrides.replySpeed,
      buckets: {
        ...value.replySpeed.buckets,
        ...overrides.replySpeed?.buckets
      }
    },
    diagnostics: {
      ...value.diagnostics,
      ...overrides.diagnostics,
      excludedLeadTypes: {
        ...value.diagnostics.excludedLeadTypes,
        ...overrides.diagnostics?.excludedLeadTypes
      }
    },
    recentUnanswered: overrides.recentUnanswered ?? value.recentUnanswered
  };
}

function historyPoint(overrides = {}) {
  return {
    accountKey: "example-heating",
    accountName: "Synthetic Example Heating",
    asOf: "2026-01-24T12:00:00-06:00",
    windowDays: 90,
    metricVersion: "lsa-responsiveness/v1",
    repliedMessages: 2,
    recentUnansweredMessages: 1,
    oldUnansweredMessages: 1,
    eligibleMessages: 3,
    eligiblePhoneCalls: 2,
    connectedCalls: 1,
    totalEligible: 5,
    totalResponded: 3,
    totalResponsiveness: 0.6,
    callsConnected: 0.5,
    messagesReplied: 2 / 3,
    repliedWithin24Hours: 1 / 3,
    medianReplyNanoseconds: "60000000000",
    replySpeedBuckets: {
      within5m: 1,
      within1h: 0,
      within24h: 0,
      over24h: 1
    },
    diagnostics: {
      incompleteWindowLeads: 1,
      bookingLeads: 0,
      unsupportedLeadTypes: 0
    },
    ...overrides
  };
}

function reportInput(overrides = {}) {
  const privacy = {
    includeLeadIds: true,
    includeMessageText: false,
    messageSnippetCharacters: 120,
    ...overrides.privacy
  };
  const output = {
    writeActionCsv: false,
    ...overrides.output
  };
  const accountResult = {
    metrics: metrics(),
    timeZone: "America/Chicago",
    capability: {
      supported: true,
      envelope: "columns-data",
      requiredFields: REQUIRED_FIELDS,
      rowContainerPresent: true,
      pagination: "not-declared"
    },
    completion: {
      method: "connector-complete-saved-result",
      pageCount: 1
    },
    ...overrides.accountResult
  };
  return {
    mode: overrides.mode ?? "synthetic",
    generatedAt: overrides.generatedAt ?? "2026-01-31T12:05:00-06:00",
    asOf: overrides.asOf ?? "2026-01-31T12:00:00-06:00",
    windowDays: overrides.windowDays ?? 90,
    privacy,
    output,
    accounts: overrides.accounts ?? [accountResult],
    historyPoints: overrides.historyPoints ?? []
  };
}

function reportModel(overrides = {}) {
  return buildReportModel(reportInput(overrides));
}

function assertNoBigInt(value) {
  if (typeof value === "bigint") assert.fail("report model retained a BigInt");
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) assertNoBigInt(child);
  }
}

test("buildReportModel is deeply JSON-safe and selects only aggregate fields", () => {
  const input = reportInput();
  input.accounts[0].metrics.replySpeed.medianNanoseconds = 3_900_000_000_000n;
  const model = buildReportModel(input);

  assertNoBigInt(model);
  assert.doesNotThrow(() => JSON.stringify(model));
  assert.equal(
    model.accounts[0].recentUnanswered[0].firstContactEpochNanoseconds,
    "1769888400000000000"
  );
  assert.equal(model.accounts[0].replySpeed.medianNanoseconds,
    "3900000000000");
  assert.equal(JSON.stringify(model).includes("customerId"), false);
  assert.deepEqual(model.accounts[0].diagnostics, {
    incompleteWindowLeads: 2,
    bookingLeads: 1,
    unsupportedLeadTypes: 3
  });
  assert.equal(
    JSON.stringify(model).includes("SYNTHETIC_PRIVATE_LIKE_DYNAMIC_LABEL"),
    false
  );
});

test("buildReportModel rejects raw events and unknown account-result fields", () => {
  for (const mutation of [
    (input) => { input.accounts[0].events = [{ leadId: "SYNTHETIC RAW" }]; },
    (input) => { input.accounts[0].rawPayload = { results: [] }; },
    (input) => { input.accounts[0].connectorRows = [["SYNTHETIC RAW"]]; },
    (input) => { input.privacy.customerId = "1000000001"; }
  ]) {
    const input = reportInput();
    mutation(input);
    assert.throws(() => buildReportModel(input), (error) => {
      assert.ok(error instanceof DataIntegrityError);
      assert.equal(error.message, "Report input is invalid.");
      assert.equal(error.message.includes("SYNTHETIC RAW"), false);
      return true;
    });
  }
});

test("privacy options independently omit IDs and text and truncate text by code point", () => {
  const message = "A😀B😀C<private>";
  const privateMetrics = metrics({
    recentUnanswered: [{
      leadId: "+900000000001",
      firstContactEpochNanoseconds: "1769888400000000000",
      messageText: message
    }]
  });

  const noIds = reportModel({
    privacy: {
      includeLeadIds: false,
      includeMessageText: true,
      messageSnippetCharacters: 4
    },
    accountResult: { metrics: privateMetrics }
  });
  assert.deepEqual(noIds.accounts[0].recentUnanswered, [{
    firstContactEpochNanoseconds: "1769888400000000000",
    messageText: "A😀B😀"
  }]);

  const noText = reportModel({
    privacy: {
      includeLeadIds: true,
      includeMessageText: false,
      messageSnippetCharacters: 500
    },
    accountResult: { metrics: privateMetrics }
  });
  assert.deepEqual(noText.accounts[0].recentUnanswered, [{
    leadId: "+900000000001",
    firstContactEpochNanoseconds: "1769888400000000000"
  }]);

  const missingText = reportModel({
    privacy: { includeLeadIds: true, includeMessageText: true },
    output: { writeActionCsv: true },
    accountResult: {
      metrics: metrics({
        recentUnanswered: [{
          leadId: "900000000001",
          firstContactEpochNanoseconds: "1769888400000000000"
        }]
      })
    }
  });
  assert.deepEqual(missingText.accounts[0].recentUnanswered, [{
    firstContactEpochNanoseconds: "1769888400000000000",
    leadId: "900000000001"
  }]);
  assert.doesNotMatch(renderHtml(missingText), /undefined/);
  assert.doesNotMatch(renderCsv(missingText), /undefined/);
});

test("capability and completion summaries reject arbitrary private metadata", () => {
  for (const accountResult of [
    { capability: {
      supported: true,
      envelope: "columns-data",
      requiredFields: REQUIRED_FIELDS,
      rowContainerPresent: true,
      pagination: "not-declared",
      connectorUrl: "SYNTHETIC PRIVATE CONNECTOR"
    } },
    { completion: {
      method: "connector-complete-saved-result",
      pageCount: 1,
      inputPath: "SYNTHETIC PRIVATE PATH"
    } }
  ]) {
    assert.throws(
      () => reportModel({ accountResult }),
      (error) => error instanceof DataIntegrityError &&
        error.message === "Report input is invalid."
    );
  }

  assert.throws(() => reportModel({
    privacy: { includeMessageText: true },
    accountResult: {
      capability: {
        supported: true,
        envelope: "columns-data",
        requiredFields: { ...REQUIRED_FIELDS, messageText: false },
        rowContainerPresent: true,
        pagination: "not-declared"
      }
    }
  }), (error) => error instanceof DataIntegrityError &&
    error.message === "Report input is invalid.");
});

test("single-page completion methods require exactly one validated page", () => {
  for (const method of [
    "single-page-no-continuation",
    "connector-complete-saved-result"
  ]) {
    assert.throws(() => reportModel({
      accountResult: { completion: { method, pageCount: 2 } }
    }), (error) => error instanceof DataIntegrityError &&
      error.message === "Report input is invalid.");
  }

  const paginated = reportModel({
    accountResult: {
      completion: { method: "all-page-tokens-consumed", pageCount: 2 }
    }
  });
  assert.deepEqual(paginated.accounts[0].completion, {
    method: "all-page-tokens-consumed",
    pageCount: 2
  });
  assert.match(
    renderHtml(paginated),
    /Validated pages<\/td><td>2<\/td>/
  );
});

test("report account zones require supported named IANA identifiers", () => {
  for (const timeZone of ["+05:00", "-03:30", "−05:00"]) {
    assert.throws(
      () => reportModel({ accountResult: { timeZone } }),
      (error) => error instanceof DataIntegrityError &&
        error.message === "Report input is invalid."
    );
  }

  for (const timeZone of ["America/Chicago", "UTC", "US/Eastern", "Etc/GMT+5"]) {
    assert.equal(
      reportModel({ accountResult: { timeZone } }).accounts[0].timeZone,
      timeZone
    );
  }
});

test("HTML is self-contained and carries the mode, methodology, and phone caveats", () => {
  const html = renderHtml(reportModel());
  assert.match(html, /Synthetic demonstration data/);
  assert.match(html, /response-time and lead-status proxy/i);
  assert.match(html, /phone connection is approximate/i);
  assert.match(html, /not Google(?:&#39;|')s official/i);
  assert.doesNotMatch(html, /https?:\/\//i);
  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(html, /\b(?:telemetry|analytics|chart\.js|cdn)\b/i);

  const privateHtml = renderHtml(reportModel({ mode: "private" }));
  assert.match(privateHtml, /Private report/);
  assert.doesNotMatch(privateHtml, /Synthetic demonstration data/);
});

test("HTML escapes every dynamic metacharacter and never renders disabled text", () => {
  const hostile = `Synthetic & < > " ' account`;
  const hostileMetrics = metrics({
    account: { name: hostile },
    recentUnanswered: [{
      leadId: `id&<>"'`,
      firstContactEpochNanoseconds: "1769888400000000000",
      messageText: `<script>PRIVATE & " '</script>`
    }]
  });
  const disabled = renderHtml(reportModel({
    privacy: { includeLeadIds: true, includeMessageText: false },
    accountResult: { metrics: hostileMetrics }
  }));

  assert.match(disabled, /Synthetic &amp; &lt; &gt; &quot; &#39; account/);
  assert.match(disabled, /id&amp;&lt;&gt;&quot;&#39;/);
  assert.equal(disabled.includes("PRIVATE"), false);
  assert.doesNotMatch(disabled, /<script\b/i);

  const enabled = renderHtml(reportModel({
    privacy: { includeLeadIds: true, includeMessageText: true },
    accountResult: { metrics: hostileMetrics }
  }));
  assert.match(enabled, /&lt;script&gt;PRIVATE &amp; &quot; &#39;&lt;\/script&gt;/);
  assert.doesNotMatch(enabled, /<script\b/i);
});

test("HTML renders No data, exact numerators and denominators, and no-activity state", () => {
  const emptyMetrics = metrics({
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
  const html = renderHtml(reportModel({ accountResult: { metrics: emptyMetrics } }));

  assert.match(html, /No eligible activity/);
  assert.equal((html.match(/No data/g) ?? []).length, 5);
  for (const counts of [
    "0 responded / 0 eligible",
    "0 connected / 0 eligible calls",
    "0 replied / 0 eligible messages",
    "0 within 24 hours / 0 eligible messages"
  ]) {
    assert.match(html, new RegExp(counts));
  }
  assert.match(html, /Median reply time/);
});

test("HTML renders fixed diagnostics, buckets, recent unanswered, and completion evidence", () => {
  const html = renderHtml(reportModel({
    privacy: { includeMessageText: true }
  }));
  for (const expected of [
    "Incomplete-window leads",
    "BOOKING leads",
    "Unsupported lead types",
    "Diagnostics are orthogonal",
    "Within 5 minutes",
    "Over 24 hours",
    "Recent unanswered messages",
    "connector-complete-saved-result",
    "columns-data"
  ]) {
    assert.match(html, new RegExp(expected, "i"));
  }
  assert.match(html, /1h 5m 0s/);
  assert.match(html, /SYNTHETIC FOLLOW UP/);
});

test("trend SVG appears only with at least two matching valid points", () => {
  const one = renderHtml(reportModel({ historyPoints: [historyPoint()] }));
  assert.doesNotMatch(one, /data-responsiveness-trend/);

  const twoPoints = [
    historyPoint(),
    historyPoint({
      asOf: "2026-01-24T17:30:00Z"
    }),
    historyPoint({
      asOf: "2026-01-31T12:00:00-06:00"
    }),
    historyPoint({
      accountKey: "other-account",
      accountName: "Synthetic Other"
    }),
    historyPoint({
      asOf: "2026-02-01T12:00:00-06:00"
    })
  ];
  const model = reportModel({ historyPoints: twoPoints });
  assert.deepEqual(model.accounts[0].trend.map((point) => point.asOf), [
    "2026-01-24T17:30:00Z",
    "2026-01-24T12:00:00-06:00",
    "2026-01-31T12:00:00-06:00"
  ]);
  const html = renderHtml(model);
  assert.match(html, /<svg[^>]+data-responsiveness-trend/);
  assert.match(html, /<polyline/);
  assert.doesNotMatch(html, /Synthetic Other/);
});

test("JSON is deterministic schema-versioned output with no dynamic diagnostic labels", () => {
  const model = reportModel();
  const json = renderJson(model);
  assert.equal(json.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(json), model);
  assert.match(json, /"product": "lsa-responsiveness-tracker"/);
  assert.match(json, /"schemaVersion": 1/);
  assert.equal(json.includes("SYNTHETIC_PRIVATE_LIKE_DYNAMIC_LABEL"), false);
  assert.equal(renderJson(model), json);
});

test("CSV is disabled by configuration", () => {
  assert.equal(renderCsv(reportModel()), null);
});

test("CSV is RFC 4180, deterministic, privacy-shaped, and formula-injection safe", () => {
  const csvMetrics = metrics({
    account: { name: "=Synthetic, Example" },
    recentUnanswered: [{
      leadId: "+900000000001",
      firstContactEpochNanoseconds: "1769888400000000000",
      messageText: "=SUM(1,2)\nsecond \"line\""
    }]
  });
  const model = reportModel({
    privacy: { includeLeadIds: true, includeMessageText: true },
    output: { writeActionCsv: true },
    accountResult: { metrics: csvMetrics }
  });
  const expected = [
    '"account","first_contact_epoch_nanoseconds","lead_id","message_text"',
    '"\'=Synthetic, Example","1769888400000000000","\'+900000000001","\'=SUM(1,2)\nsecond ""line"""',
    ""
  ].join("\r\n");
  assert.equal(renderCsv(model), expected);
  assert.equal(renderCsv(model), expected);

  const minimized = reportModel({
    privacy: { includeLeadIds: false, includeMessageText: false },
    output: { writeActionCsv: true },
    accountResult: { metrics: csvMetrics }
  });
  assert.equal(
    renderCsv(minimized),
    '"account","first_contact_epoch_nanoseconds"\r\n' +
      '"\'=Synthetic, Example","1769888400000000000"\r\n'
  );
});

test("renderers reject hand-crafted models carrying raw or non-JSON-safe data", () => {
  const model = reportModel();
  for (const candidate of [
    { ...model, events: [] },
    { ...model, rawPayload: { results: [] } },
    { ...model, generatedAt: 1n }
  ]) {
    for (const render of [renderHtml, renderJson, renderCsv]) {
      assert.throws(render.bind(null, candidate), (error) =>
        error instanceof DataIntegrityError &&
        error.message === "Report model is invalid.");
    }
  }
});
