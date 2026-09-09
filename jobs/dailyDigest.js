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

export function formatDigestMessage({ date, counts, skip_counts, pageBase }) {
  const skipLines =
    skip_counts.length === 0
      ? "none"
      : skip_counts.map((row) => `${row.label}: ${row.n}`).join("\n");
  return [
    "Today's update",
    "",
    `Posted: ${counts.posted}`,
    `WhatsApp: ${counts.whatsapp}`,
    `WordPress: ${counts.wordpress}`,
    `Podio: ${counts.podio}`,
    "",
    "Skipped:",
    skipLines,
    "",
    `${pageBase.replace(/\/$/, "")}/date/${date}`,
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
