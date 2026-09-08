import assert from "node:assert/strict";
import {
  formatDigestMessage,
  msUntilNextDigest,
  yesterdayUtcDateParam,
} from "./dailyDigest.js";

assert.equal(yesterdayUtcDateParam(new Date("2026-09-09T03:30:00.000Z")), "08-09-2026");
assert.equal(msUntilNextDigest(new Date("2026-09-09T03:29:00.000Z")), 60_000);
assert.equal(
  msUntilNextDigest(new Date("2026-09-09T03:30:00.000Z")),
  24 * 60 * 60 * 1000
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

assert.equal(
  text,
  [
    "Today's update",
    "",
    "Posted: 40",
    "WhatsApp: 38",
    "WordPress: 36",
    "Podio: 12",
    "",
    "Skipped:",
    "price not low enough: 18",
    "R3: 7",
    "",
    "https://deals.wholesaledealfinder.ai/date/08-09-2026",
  ].join("\n")
);

console.log("dailyDigest ok");
