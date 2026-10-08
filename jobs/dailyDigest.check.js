import assert from "node:assert/strict";
import {
  formatDigestDate,
  formatDigestMessage,
  formatSkipLabel,
  msUntilNextDigest,
  yesterdayUtcDateParam,
} from "./dailyDigest.js";

assert.equal(yesterdayUtcDateParam(new Date("2026-09-09T03:30:00.000Z")), "08-09-2026");
// 6:00 PM America/New_York is 22:00 UTC while on EDT (UTC-4).
assert.equal(msUntilNextDigest(new Date("2026-10-08T21:59:00.000Z")), 60_000);
assert.equal(
  msUntilNextDigest(new Date("2026-10-08T22:00:00.000Z")),
  24 * 60 * 60 * 1000
);
// DST ends Nov 1 2026: 6:00 PM on Oct 31 (EDT) to 6:00 PM on Nov 1 (EST, UTC-5) is 25 hours.
assert.equal(
  msUntilNextDigest(new Date("2026-10-31T22:00:00.000Z")),
  25 * 60 * 60 * 1000
);

const text = formatDigestMessage({
  date: "08-09-2026",
  counts: { posted: 40, whatsapp: 38, wordpress: 36, podio: 12 },
  skip_counts: [
    { label: "price not low enough", n: 18 },
    { label: "R3", n: 7 },
  ],
  pageBase: "https://deals.wholesaledealfinder.ai",
});

assert.equal(formatDigestDate("08-09-2026"), "08 Sep 2026");
assert.equal(formatDigestDate("bad"), "bad");
assert.equal(formatSkipLabel("R1"), "R1 (2-bed over $250k in tri-county)");
assert.equal(formatSkipLabel("r6"), "R6 (3/1 over $375k in tri-county)");
assert.equal(formatSkipLabel("other"), "other");

assert.equal(
  text,
  [
    "📊 Daily Summary — 08 Sep 2026",
    "",
    "Posted: 40",
    "WhatsApp: 38",
    "WordPress: 36",
    "Podio: 12",
    "",
    "Skipped: 25",
    "• price not low enough (dup drop under 6%): 18",
    "• R3 (condo over $279k): 7",
    "",
    "For complete details, please visit the link:",
    "https://deals.wholesaledealfinder.ai/date/08-09-2026",
  ].join("\n")
);

console.log("dailyDigest ok");
