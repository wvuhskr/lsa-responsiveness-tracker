import assert from "node:assert/strict";
import test from "node:test";

import { DataIntegrityError } from "../src/errors.js";
import * as timestampApi from "../src/timestamps.js";
import {
  parseTimestamp,
  subtractExactDays,
  windowStartFor
} from "../src/timestamps.js";

function assertDataIntegrityError(action, message) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof DataIntegrityError);
    assert.match(error.message, message);
    return true;
  });
}

test("preserves zero through nine fractional digits as nanoseconds", () => {
  const cases = [
    ["", 0, 0n],
    [".1", 1, 100_000_000n],
    [".12", 2, 120_000_000n],
    [".123", 3, 123_000_000n],
    [".1234", 4, 123_400_000n],
    [".12345", 5, 123_450_000n],
    [".123456", 6, 123_456_000n],
    [".1234567", 7, 123_456_700n],
    [".12345678", 8, 123_456_780n],
    [".123456789", 9, 123_456_789n]
  ];

  for (const [fraction, fractionalDigits, nanoseconds] of cases) {
    const parsed = parseTimestamp(`2026-01-10T12:00:00${fraction}Z`);
    assert.deepEqual(parsed, {
      epochNanoseconds: 1_768_046_400_000_000_000n + nanoseconds,
      fractionalDigits,
      hadExplicitOffset: true
    });
  }
});

test("distinguishes adjacent six-digit fractional timestamps", () => {
  const first = parseTimestamp("2026-08-29 12:00:00.123456", {
    timeZone: "America/New_York",
    disambiguation: "reject"
  });
  const second = parseTimestamp("2026-08-29 12:00:00.123457", {
    timeZone: "America/New_York",
    disambiguation: "reject"
  });

  assert.equal(second.epochNanoseconds - first.epochNanoseconds, 1_000n);
  assert.equal(first.fractionalDigits, 6);
  assert.equal(first.hadExplicitOffset, false);
});

test("honors an explicit offset independently of the account zone", () => {
  const parsed = parseTimestamp("2026-01-10T12:00:00.000000001-05:00", {
    timeZone: "Not/A_Real_Zone",
    disambiguation: "reject"
  });

  assert.deepEqual(parsed, {
    epochNanoseconds: 1_768_064_400_000_000_001n,
    fractionalDigits: 9,
    hadExplicitOffset: true
  });
});

test("accepts the largest lexically valid UTC offset", () => {
  const parsed = parseTimestamp("2026-01-10 23:59:00+23:59");

  assert.equal(parsed.epochNanoseconds, 1_768_003_200_000_000_000n);
  assert.equal(parsed.hadExplicitOffset, true);
});

test("accepts a valid leap-day calendar date", () => {
  const parsed = parseTimestamp("2024-02-29T12:34:56.123456789Z");

  assert.equal(parsed.epochNanoseconds, 1_709_210_096_123_456_789n);
});

test("rejects malformed timestamp text", () => {
  const malformed = [
    "2026-1-01 00:00:00",
    "2026-01-01T00:00",
    "2026-01-01T00:00:00.",
    "2026-01-01T00:00:00.1234567890",
    "2026-01-01T00:00:00z",
    "2026-01-01T00:00:00+0500",
    "2026-01-01T00:00:00Z ",
    "2026-01-01"
  ];

  for (const value of malformed) {
    assertDataIntegrityError(
      () => parseTimestamp(value, { timeZone: "UTC" }),
      /invalid timestamp format/
    );
  }
});

test("rejects invalid calendar dates before epoch conversion", () => {
  const invalidDates = [
    "2026-00-01T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-01-00T00:00:00Z",
    "2026-02-29T00:00:00Z",
    "2024-04-31T00:00:00Z"
  ];

  for (const value of invalidDates) {
    assertDataIntegrityError(
      () => parseTimestamp(value),
      /invalid calendar date/
    );
  }
});

test("rejects invalid clock fields", () => {
  const invalidTimes = [
    "2026-01-01T24:00:00Z",
    "2026-01-01T23:60:00Z",
    "2026-01-01T23:59:60Z"
  ];

  for (const value of invalidTimes) {
    assertDataIntegrityError(
      () => parseTimestamp(value),
      /invalid clock time/
    );
  }
});

test("rejects out-of-range explicit UTC offsets", () => {
  const invalidOffsets = [
    "2026-01-01T00:00:00+24:00",
    "2026-01-01T00:00:00-24:00",
    "2026-01-01T00:00:00+23:60"
  ];

  for (const value of invalidOffsets) {
    assertDataIntegrityError(
      () => parseTimestamp(value),
      /invalid UTC offset/
    );
  }
});

test("requires a valid IANA zone for a naive timestamp", () => {
  assertDataIntegrityError(
    () => parseTimestamp("2026-01-01 00:00:00"),
    /valid IANA time zone/
  );
  assertDataIntegrityError(
    () => parseTimestamp("2026-01-01 00:00:00", {
      timeZone: "Not/A_Real_Zone"
    }),
    /valid IANA time zone/
  );
});

test("exports one positive validator for supported named IANA zones", () => {
  assert.equal(typeof timestampApi.isNamedIanaTimeZone, "function");
  for (const timeZone of ["America/New_York", "UTC", "US/Eastern", "Etc/GMT+5"]) {
    assert.equal(timestampApi.isNamedIanaTimeZone(timeZone), true);
  }
  for (const timeZone of [
    "+05:00",
    "-03:30",
    "−05:00",
    "Not/A_Real_Zone",
    ""
  ]) {
    assert.equal(timestampApi.isNamedIanaTimeZone(timeZone), false);
  }
});

test("rejects numeric offset identifiers as naive account time zones", () => {
  for (const timeZone of ["+05:00", "-03:30"]) {
    assertDataIntegrityError(
      () => parseTimestamp("2026-01-01 00:00:00", { timeZone }),
      /valid IANA time zone/
    );
  }
});

test("rejects numeric offset identifiers as window account time zones", () => {
  for (const timeZone of ["+05:00", "-03:30"]) {
    assertDataIntegrityError(
      () => windowStartFor(
        "2026-01-02T12:00:00Z",
        timeZone,
        1,
        "reject"
      ),
      /valid IANA time zone/
    );
  }
});

test("rejects Unicode-minus numeric zones for naive account time", () => {
  assertDataIntegrityError(
    () => parseTimestamp("2026-01-01 00:00:00", {
      timeZone: "−05:00"
    }),
    /valid IANA time zone/
  );
});

test("rejects Unicode-minus numeric zones for account windows", () => {
  assertDataIntegrityError(
    () => windowStartFor(
      "2026-01-02T12:00:00Z",
      "−05:00",
      1,
      "reject"
    ),
    /valid IANA time zone/
  );
});

test("keeps explicit timestamp offsets independent of account-zone text", () => {
  const parsed = parseTimestamp("2026-01-01T00:00:00+05:00", {
    timeZone: "+05:00",
    disambiguation: "reject"
  });

  assert.equal(parsed.epochNanoseconds, 1_767_207_600_000_000_000n);
  assert.equal(parsed.hadExplicitOffset, true);
});

test("accepts a supported IANA zone whose name contains a plus sign", () => {
  const parsed = parseTimestamp("2026-01-01 00:00:00", {
    timeZone: "Etc/GMT+5",
    disambiguation: "reject"
  });

  assert.equal(parsed.epochNanoseconds, 1_767_243_600_000_000_000n);
  assert.equal(parsed.hadExplicitOffset, false);
});

test("accepts supported IANA aliases and the UTC special identifier", () => {
  const cases = [
    ["US/Eastern", 1_767_243_600_000_000_000n],
    ["UTC", 1_767_225_600_000_000_000n]
  ];

  for (const [timeZone, epochNanoseconds] of cases) {
    const parsed = parseTimestamp("2026-01-01 00:00:00", {
      timeZone,
      disambiguation: "reject"
    });
    assert.equal(parsed.epochNanoseconds, epochNanoseconds);
    assert.equal(parsed.hadExplicitOffset, false);
  }
});

test("rejects an unsupported DST disambiguation policy", () => {
  assertDataIntegrityError(
    () => parseTimestamp("2026-01-01 00:00:00", {
      timeZone: "America/New_York",
      disambiguation: "compatible"
    }),
    /disambiguation/
  );
});

test("rejects a nonexistent spring-forward wall time for every policy", () => {
  for (const disambiguation of ["reject", "earlier", "later"]) {
    assertDataIntegrityError(
      () => parseTimestamp("2026-03-08 02:30:00", {
        timeZone: "America/New_York",
        disambiguation
      }),
      /nonexistent local time/
    );
  }
});

test("rejects an ambiguous fall-back wall time by default", () => {
  assertDataIntegrityError(
    () => parseTimestamp("2026-11-01 01:30:00", {
      timeZone: "America/New_York"
    }),
    /ambiguous local time/
  );
});

test("selects the requested occurrence of an ambiguous fall-back time", () => {
  const earlier = parseTimestamp("2026-11-01 01:30:00", {
    timeZone: "America/New_York",
    disambiguation: "earlier"
  });
  const later = parseTimestamp("2026-11-01 01:30:00", {
    timeZone: "America/New_York",
    disambiguation: "later"
  });

  assert.equal(earlier.epochNanoseconds, 1_793_511_000_000_000_000n);
  assert.equal(later.epochNanoseconds, 1_793_514_600_000_000_000n);
  assert.equal(later.epochNanoseconds - earlier.epochNanoseconds,
    3_600_000_000_000n);
});

test("subtracts recent days as exact 24-hour periods", () => {
  const asOf = parseTimestamp("2026-11-03T12:00:00-05:00");

  assert.equal(
    asOf.epochNanoseconds - subtractExactDays(asOf.epochNanoseconds, 7),
    604_800_000_000_000n
  );
  assert.equal(subtractExactDays(123n, 0), 123n);
});

test("rejects lossy or negative exact-day inputs", () => {
  assertDataIntegrityError(
    () => subtractExactDays(1, 1),
    /epochNanoseconds must be a bigint/
  );
  for (const days of [-1, 1.5, Number.NaN]) {
    assertDataIntegrityError(
      () => subtractExactDays(0n, days),
      /days must be a non-negative integer/
    );
  }
});

test("starts a window at account-local midnight across spring DST", () => {
  const start = windowStartFor(
    "2026-03-10T12:00:00-04:00",
    "America/New_York",
    2,
    "reject"
  );

  assert.equal(start, 1_772_946_000_000_000_000n);
  assert.equal(
    1_773_158_400_000_000_000n - start,
    59n * 3_600_000_000_000n
  );
});

test("derives the window date in the account zone, not the offset date", () => {
  const start = windowStartFor(
    "2026-01-02T01:00:00Z",
    "America/New_York",
    1,
    "reject"
  );

  assert.equal(start, 1_767_157_200_000_000_000n);
});

test("uses calendar arithmetic across leap day for window starts", () => {
  const start = windowStartFor(
    "2024-03-01T18:00:00Z",
    "UTC",
    1,
    "reject"
  );

  assert.equal(start, 1_709_164_800_000_000_000n);
});

test("rejects invalid window-day counts", () => {
  for (const days of [-1, 0.5, Number.POSITIVE_INFINITY]) {
    assertDataIntegrityError(
      () => windowStartFor(
        "2026-01-01T12:00:00Z",
        "America/New_York",
        days,
        "reject"
      ),
      /windowDays must be a non-negative integer/
    );
  }
});
