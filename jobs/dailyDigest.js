const DIGEST_TIME_ZONE = "America/New_York";
const DIGEST_LOCAL_HOUR = 18;
const DIGEST_LOCAL_MINUTE = 0;
const DEFAULT_DEAL_DETAILS_BASE = "https://deals.wholesaledealfinder.ai";

export function pad2(value) {
  return String(value).padStart(2, "0");
}

export function yesterdayUtcDateParam(now = new Date()) {
  const yesterday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)
  );
  return `${pad2(yesterday.getUTCDate())}-${pad2(yesterday.getUTCMonth() + 1)}-${yesterday.getUTCFullYear()}`;
}

function zonedWallClockParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return {
    year: get("year"),
    month: get("month") - 1,
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

// Offset (ms) between the wall clock in timeZone and UTC at the given instant.
function zonedOffsetMs(date, timeZone) {
  const p = zonedWallClockParts(date, timeZone);
  const wallAsUtc = Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second);
  return wallAsUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// Convert a wall-clock time in timeZone to a UTC epoch ms, accounting for DST.
function zonedTimeToUtc({ year, month, day }, hour, minute, timeZone) {
  const guess = Date.UTC(year, month, day, hour, minute);
  const firstOffset = zonedOffsetMs(new Date(guess), timeZone);
  let result = guess - firstOffset;
  const actualOffset = zonedOffsetMs(new Date(result), timeZone);
  if (actualOffset !== firstOffset) result = guess - actualOffset;
  return result;
}

export function msUntilNextDigest(now = new Date()) {
  const today = zonedWallClockParts(now, DIGEST_TIME_ZONE);
  let next = zonedTimeToUtc(today, DIGEST_LOCAL_HOUR, DIGEST_LOCAL_MINUTE, DIGEST_TIME_ZONE);
  if (next <= now.getTime()) {
    const tomorrow = new Date(Date.UTC(today.year, today.month, today.day + 1));
    next = zonedTimeToUtc(
      {
        year: tomorrow.getUTCFullYear(),
        month: tomorrow.getUTCMonth(),
        day: tomorrow.getUTCDate(),
      },
      DIGEST_LOCAL_HOUR,
      DIGEST_LOCAL_MINUTE,
      DIGEST_TIME_ZONE
    );
  }
  return next - now.getTime();
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function formatDigestDate(date) {
  const [dd, mm, yyyy] = String(date).split("-");
  const monthIdx = Number(mm) - 1;
  if (!dd || monthIdx < 0 || monthIdx > 11 || !yyyy) return date;
  return `${dd} ${MONTHS[monthIdx]} ${yyyy}`;
}

const RULE_SUMMARIES = {
  R1: "2-bed over $250k in tri-county",
  R2: "2-bed over $199k rest of FL",
  R3: "condo over $279k",
  R4: "HOA over $600 under $150k",
  R5: "land under 5k sqft",
  R6: "3/1 over $375k in tri-county",
  R7: "small 3/1 over $325k in tri-county",
  R8: "frame/wood house",
  R9: "under 900 sqft outside SFL",
  R10: "mobile home only",
};

const SKIP_SUMMARIES = {
  "price not low enough": "dup drop under 6%",
  "35% quota": "rest of FL daily cap",
  "35% quota cap": "rest of FL daily cap",
  "Do not post city": "city blocked from posting",
  "Do Not Post City": "city blocked from posting",
  "bad region": "outside allowed regions",
  "image failed": "image curation failed",
};

export function formatSkipLabel(label) {
  const raw = String(label || "").trim();
  const ruleId = raw.toUpperCase();
  if (RULE_SUMMARIES[ruleId]) return `${ruleId} (${RULE_SUMMARIES[ruleId]})`;
  if (SKIP_SUMMARIES[raw]) return `${raw} (${SKIP_SUMMARIES[raw]})`;
  return raw;
}

export function formatDigestMessage({ date, counts, skip_counts, pageBase }) {
  const skipTotal = skip_counts.reduce((sum, row) => sum + Number(row.n || 0), 0);
  const skipLines =
    skip_counts.length === 0
      ? "none"
      : skip_counts.map((row) => `• ${formatSkipLabel(row.label)}: ${row.n}`).join("\n");
  const link = `${pageBase.replace(/\/$/, "")}/date/${date}`;
  return [
    `📊 Daily Summary — ${formatDigestDate(date)}`,
    "",
    `Posted: ${counts.posted}`,
    `WhatsApp: ${counts.whatsapp}`,
    `WordPress: ${counts.wordpress}`,
    `Podio: ${counts.podio}`,
    "",
    `Skipped: ${skipTotal}`,
    skipLines,
    "",
    "For complete details, please visit the link:",
    link,
  ].join("\n");
}

function dealDetailsBase() {
  return (process.env.DEAL_DETAILS_BASE_URL || DEFAULT_DEAL_DETAILS_BASE).replace(/\/$/, "");
}

export async function fetchPostedByDate(date) {
  const url = `${dealDetailsBase()}/api/metrics/posted-by-date?date=${encodeURIComponent(date)}&page=1&limit=1`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`posted-by-date ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

export async function sendGroupText(jid, text) {
  const { getSock } = await import("../services/whatsappService.js");
  const sock = getSock();
  if (!sock) throw new Error("WhatsApp not connected");
  const groupJid = jid.includes("@") ? jid : `${jid}@g.us`;
  await sock.sendMessage(groupJid, { text });
}

export async function runDailyDigest(now = new Date()) {
  const jid = (process.env.DIGEST_WHATSAPP_GROUP_JID || "").trim();
  if (!jid) {
    console.warn("DIGEST_WHATSAPP_GROUP_JID not set; skipping digest");
    return { skipped: true };
  }

  const date = yesterdayUtcDateParam(now);
  const data = await fetchPostedByDate(date);
  const text = formatDigestMessage({
    date,
    counts: data.counts || { posted: 0, whatsapp: 0, wordpress: 0, podio: 0 },
    skip_counts: Array.isArray(data.skip_counts) ? data.skip_counts : [],
    pageBase: dealDetailsBase(),
  });
  await sendGroupText(jid, text);
  console.log(`Daily digest sent for ${date}`);
  return { date, text };
}

export function startDailyDigestJob() {
  if (!(process.env.DIGEST_WHATSAPP_GROUP_JID || "").trim()) {
    console.warn("DIGEST_WHATSAPP_GROUP_JID not set; daily digest disabled");
    return;
  }

  const arm = () => {
    const wait = msUntilNextDigest();
    console.log(`📬 Daily digest armed; next fire in ${Math.round(wait / 60000)} min (6:00 PM ${DIGEST_TIME_ZONE})`);
    setTimeout(async () => {
      try {
        await runDailyDigest();
      } catch (err) {
        console.error("Daily digest failed:", err?.message || err);
      }
      arm();
    }, wait);
  };
  arm();
}
