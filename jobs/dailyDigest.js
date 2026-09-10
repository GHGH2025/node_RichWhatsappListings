const DIGEST_UTC_HOUR = 3;
const DIGEST_UTC_MINUTE = 30;
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

export function msUntilNextDigest(now = new Date()) {
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      DIGEST_UTC_HOUR,
      DIGEST_UTC_MINUTE,
      0,
      0
    )
  );
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
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
  R2: "2-bed over $150k rest of FL",
  R3: "condo over $250k",
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
    console.log(`📬 Daily digest armed; next fire in ${Math.round(wait / 60000)} min (03:30 UTC)`);
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
