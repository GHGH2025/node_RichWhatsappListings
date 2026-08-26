// services/whatsappService.js
import "dotenv/config";
import makeWASocket, {
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
  extractMessageContent as baileysExtractMessageContent,
  getContentType,
  WAMessageStubType,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import cron from "node-cron";
import fs from "fs";
import {
  isTrackedParticipant,
  getTrackedGroupName,
  getTrackedParticipantEmail,
  getTrackedGroupJids,
} from "./trackConfigCache.js";
import { WhatsappTrackedMessages } from "../models/whatsapp_tracked_messages.js";
import { WhatsappTrackJobRun } from "../models/whatsapp_track_job_runs.js";
import { phoneFromJid } from "../utils/phone.js";
import { uploadBufferToS3 } from "../utils/s3Upload.js";
import { useMongoAuthState, clearMongoAuthState } from "../utils/mongoAuthState.js";

const authDir = "./auth";
fs.mkdirSync(authDir, { recursive: true });

let sock;
const msgs = [];
let nextId = 1;
const MSGS_MAX = 500;

const JOB_CRON = "*/5 * * * *";
const JOB_HISTORY_COUNT = 50;
const JOB_MAX_PAGES = 3;
const JOB_PAGE_WAIT_MS = 15_000;
const JOB_PAGE_QUIET_MS = 2_500;
const JOB_MAX_AGE_MS = 12 * 60 * 60 * 1000;
/** group_jid → { key, timestampMs } newest inbound we have seen */
const lastGroupMsgAnchor = new Map();
/** groups whose in-flight history fetch was started by the 5-min job */
const jobRescanGroups = new Set();
/** group_jid → { push(messages) } waiter for the current on-demand page */
const pendingHistoryWaits = new Map();
let jobTask = null;
let jobRunning = false;
/** In-flight 5-min job telemetry, filled while history upserts land. */
let activeJobStats = null;

let startingSock = false;
let sockGeneration = 0;
let reconnectTimer = null;
let reconnectAttempt = 0;
let historyProcessChain = Promise.resolve();

const WEBHOOK_URL = process.env.WHATSAPP_STATUS_WEBHOOK_URL || "";

async function notifyStatusWebhook(event, extra = {}) {
  if (!WEBHOOK_URL) {
    console.warn("⚠️ WHATSAPP_STATUS_WEBHOOK_URL not set, skipping webhook:", event);
    return;
  }

  try {
    const payload = {
      event,
      timestamp: new Date().toISOString(),
      ...extra
    };

    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    console.log(`🌍 Webhook (${event}) status:`, res.status);
  } catch (err) {
    console.error("❌ Error sending status webhook:", err.message || err);
  }
}

function resetAuthFolder() {
  try {
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
      console.log("🧹 Deleted auth folder");
    }
    fs.mkdirSync(authDir, { recursive: true });
    console.log("📁 Re-created auth folder");
  } catch (err) {
    console.error("❌ Failed to reset auth folder:", err.message || err);
  }
}

function teardownSock() {
  const prev = sock;
  sock = null;
  if (!prev) return;
  try {
    prev.ev.removeAllListeners();
  } catch {
    /* ignore */
  }
  try {
    prev.end?.(undefined);
  } catch {
    /* ignore */
  }
}

function scheduleReconnect({ immediate = false } = {}) {
  if (reconnectTimer) return;
  const delay = immediate ? 500 : Math.min(30_000, 2_000 * 2 ** reconnectAttempt);
  reconnectAttempt += 1;
  console.log(`🔄 Reconnect scheduled in ${delay}ms (attempt ${reconnectAttempt})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (startingSock) {
      scheduleReconnect({ immediate: true });
      return;
    }
    startSock().catch((err) => {
      console.error("❌ Reconnect failed:", err.message || err);
      scheduleReconnect();
    });
  }, delay);
}

function enqueueHistoryProcess(work) {
  historyProcessChain = historyProcessChain.then(work).catch((err) => {
    console.error("❌ History batch processing failed:", err.message || err);
  });
  return historyProcessChain;
}

export function getSock() {
  return sock;
}
export function getMessages(since = 0) {
  return msgs.filter(m => m.id > since);
}
export function addMessage(msg) {
  msgs.push(msg);
  if (msgs.length > MSGS_MAX) {
    msgs.splice(0, msgs.length - MSGS_MAX);
  }
}

function extractMessageContent(m) {
  // Baileys unwraps ephemeral/view-once/etc and skips senderKeyDistributionMessage
  const content = baileysExtractMessageContent(m.message) || null;
  const msgTypeKey = getContentType(content) || "";
  let text = "";
  let type = "";

  if (!msgTypeKey || !content) {
    return { msgTypeKey: "", text: "", type: "", content: null };
  }

  if (msgTypeKey === "conversation") {
    text = content.conversation || "";
    type = "text";
  } else if (msgTypeKey === "extendedTextMessage") {
    text = content.extendedTextMessage?.text || "";
    type = "extendedText";
  } else if (msgTypeKey === "imageMessage") {
    text = content.imageMessage?.caption || "";
    type = "image";
  } else if (msgTypeKey === "videoMessage") {
    text = content.videoMessage?.caption || "";
    type = "video";
  } else if (msgTypeKey === "audioMessage") {
    text = "";
    type = "audio";
  } else if (msgTypeKey === "documentMessage") {
    text = content.documentMessage?.fileName || "";
    type = "document";
  } else if (msgTypeKey === "reactionMessage") {
    text = content.reactionMessage?.text || "";
    type = "reaction";
  } else {
    // Protocol / non-user types (protocolMessage, …)
    type = msgTypeKey;
  }

  return { msgTypeKey, text: String(text || ""), type, content };
}

const MEDIA_TYPES = new Set(["image", "video", "audio", "document"]);

function hasPersistableContent(text, mediaUrls = [], type = "") {
  return Boolean(
    (text || "").trim() ||
    (mediaUrls || []).length ||
    MEDIA_TYPES.has(type)
  );
}

function existingNeedsRetry(existing, type) {
  if (!existing) return false;
  if (existing.type === "ciphertext") return true;
  if (type === "image" && !(existing.media_urls || []).length) return true;
  const err = String(existing.errorMessage || "");
  if (existing.status === "error" && /image_upload_failed|ciphertext/i.test(err)) {
    return true;
  }
  return false;
}

/** Best-effort phone digits for storage (match uses participant JID, not phone). */
function resolveSenderPhone(m) {
  const senderJid = m.key?.participant || "";
  const altJid = m.key?.participantAlt || "";

  // participantAlt is PN JID, often with device suffix: 9186...:20@s.whatsapp.net
  if (altJid) {
    const local = String(altJid).split("@")[0] || "";
    const phone = phoneFromJid(local.split(":")[0]);
    if (phone) return phone;
  }

  if (String(senderJid).endsWith("@s.whatsapp.net")) {
    const local = String(senderJid).split("@")[0] || "";
    return phoneFromJid(local.split(":")[0]);
  }

  return "";
}

async function downloadImageToS3(m, content = null) {
  const unwrapped =
    content || baileysExtractMessageContent(m?.message) || null;
  const imageMeta = unwrapped?.imageMessage;
  if (!imageMeta) return null;

  // Prefer original message when image is top-level; else pass unwrapped content
  const downloadMsg = m?.message?.imageMessage
    ? m
    : { ...m, message: unwrapped };

  try {
    const buffer = await downloadMediaMessage(
      downloadMsg,
      "buffer",
      {},
      {
        logger: sock?.logger,
        reuploadRequest: sock?.updateMediaMessage?.bind(sock),
      }
    );
    if (!buffer) return null;

    const mimetype = imageMeta.mimetype || "image/jpeg";
    const url = await uploadBufferToS3(Buffer.from(buffer), { mimetype });
    if (url) {
      console.log(`🖼️ Uploaded WhatsApp image → ${url}`);
    }
    return url;
  } catch (err) {
    console.error("Media download/upload error:", err.message || err);
    return null;
  }
}

function toTimestampMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  return n < 1e12 ? n * 1000 : n;
}

function rememberGroupMsgAnchor(m) {
  const jid = m?.key?.remoteJid;
  if (typeof jid !== "string" || !jid.endsWith("@g.us") || !m?.key?.id) return;

  const timestampMs = toTimestampMs(m.messageTimestamp);
  const prev = lastGroupMsgAnchor.get(jid);
  if (prev && prev.timestampMs >= timestampMs) return;

  lastGroupMsgAnchor.set(jid, {
    key: {
      remoteJid: jid,
      id: m.key.id,
      fromMe: Boolean(m.key.fromMe),
      participant: m.key.participant,
    },
    timestampMs,
  });
}

function oldestInboundAnchor(messages, groupJid) {
  let oldest = null;
  for (const m of messages || []) {
    if (m?.key?.remoteJid !== groupJid || !m?.key?.id) continue;
    const timestampMs = toTimestampMs(m.messageTimestamp);
    if (!oldest || timestampMs < oldest.timestampMs) {
      oldest = {
        key: {
          remoteJid: groupJid,
          id: m.key.id,
          fromMe: Boolean(m.key.fromMe),
          participant: m.key.participant,
        },
        timestampMs,
      };
    }
  }
  return oldest;
}

async function resolveHistoryAnchor(groupJid) {
  const live = lastGroupMsgAnchor.get(groupJid);
  if (live?.key?.id) return live;

  const newest = await WhatsappTrackedMessages.findOne({ group_jid: groupJid })
    .sort({ timestamp: -1 })
    .lean();
  if (!newest?.message_id) return null;

  const ts = newest.timestamp ? new Date(newest.timestamp).getTime() : Date.now();
  return {
    key: {
      remoteJid: groupJid,
      id: newest.message_id,
      fromMe: Boolean(newest.raw?.fromMe),
    },
    timestampMs: Number.isFinite(ts) ? ts : Date.now(),
  };
}

function emptyGroupBucket(groupJid) {
  return {
    group_jid: groupJid,
    group_name: getTrackedGroupName(groupJid),
    seen: 0,
    added: 0,
    already: 0,
    skipped: 0,
    fetched: false,
    error: "",
  };
}

function startJobStats(groupJids) {
  const groups = new Map();
  for (const groupJid of groupJids) {
    groups.set(groupJid, emptyGroupBucket(groupJid));
  }
  activeJobStats = {
    run_at: new Date(),
    seen: 0,
    added: 0,
    already: 0,
    skipped: 0,
    groups_targeted: groupJids.length,
    groups_fetched: 0,
    groups,
  };
}

function groupBucket(groupJid) {
  if (!activeJobStats || !groupJid) return null;
  let bucket = activeJobStats.groups.get(groupJid);
  if (!bucket) {
    bucket = emptyGroupBucket(groupJid);
    activeJobStats.groups.set(groupJid, bucket);
  }
  return bucket;
}

function recordJobEvent(groupJid, kind) {
  const bucket = groupBucket(groupJid);
  if (!bucket || !activeJobStats) return;
  if (kind !== "seen" && kind !== "added" && kind !== "already" && kind !== "skipped") return;
  bucket[kind] += 1;
  activeJobStats[kind] += 1;
}

async function persistSkippedJobRun(reason, ok = true) {
  try {
    await WhatsappTrackJobRun.create({
      run_at: new Date(),
      ok,
      skipped: true,
      reason,
      groups_targeted: 0,
      groups_fetched: 0,
      seen: 0,
      added: 0,
      already: 0,
      skipped_count: 0,
      groups: [],
    });
    console.log(`📊 Sync job history skipped: ${reason}`);
  } catch (err) {
    console.error("❌ Failed to persist sync job history:", err.message || err);
  }
}

async function persistJobHistory({ ok = true, reason = "" } = {}) {
  const stats = activeJobStats;
  activeJobStats = null;
  const groups = stats
    ? [...stats.groups.values()].sort(
        (a, b) => (b.added || 0) - (a.added || 0) || (b.seen || 0) - (a.seen || 0)
      )
    : [];
  try {
    await WhatsappTrackJobRun.create({
      run_at: stats?.run_at || new Date(),
      ok,
      skipped: false,
      reason,
      groups_targeted: stats?.groups_targeted || 0,
      groups_fetched: stats?.groups_fetched || 0,
      seen: stats?.seen || 0,
      added: stats?.added || 0,
      already: stats?.already || 0,
      skipped_count: stats?.skipped || 0,
      groups,
    });
    console.log(
      `📊 Sync job history: added=${stats?.added || 0} already=${stats?.already || 0} seen=${stats?.seen || 0} groups=${groups.length}` +
        (reason ? ` reason=${reason}` : "")
    );
  } catch (err) {
    console.error("❌ Failed to persist sync job history:", err.message || err);
  }
}

function waitForGroupHistoryPage(groupJid) {
  return new Promise((resolve) => {
    const previous = pendingHistoryWaits.get(groupJid);
    if (previous) previous.finish({ messages: [], timedOut: true, superseded: true });

    const collected = [];
    let settled = false;
    let quietTimer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(maxTimer);
      clearTimeout(quietTimer);
      if (pendingHistoryWaits.get(groupJid) === waiter) {
        pendingHistoryWaits.delete(groupJid);
      }
      resolve({ messages: collected, timedOut: Boolean(result?.timedOut) });
    };

    const maxTimer = setTimeout(() => finish({ timedOut: true }), JOB_PAGE_WAIT_MS);

    const waiter = {
      push(messages) {
        collected.push(...(messages || []));
        clearTimeout(quietTimer);
        quietTimer = setTimeout(() => finish({ timedOut: false }), JOB_PAGE_QUIET_MS);
      },
      finish,
    };
    pendingHistoryWaits.set(groupJid, waiter);
  });
}

function notifyHistoryWaiters(batch) {
  const byGroup = new Map();
  for (const m of batch || []) {
    const jid = m?.key?.remoteJid;
    if (typeof jid !== "string" || !jid.endsWith("@g.us")) continue;
    if (!byGroup.has(jid)) byGroup.set(jid, []);
    byGroup.get(jid).push(m);
  }
  for (const [jid, messages] of byGroup) {
    pendingHistoryWaits.get(jid)?.push(messages);
  }
}

async function fetchHistoryPage(groupJid, anchor) {
  const waiter = waitForGroupHistoryPage(groupJid);
  await sock.fetchMessageHistory(
    JOB_HISTORY_COUNT,
    anchor.key,
    anchor.timestampMs
  );
  const result = await waiter;
  await historyProcessChain;
  return result;
}

async function syncGroupHistory(groupJid) {
  const bucket = activeJobStats?.groups.get(groupJid);
  let anchor = await resolveHistoryAnchor(groupJid);
  if (!anchor) {
    console.log(`⏭️ Sync job: no anchor yet for ${groupJid}`);
    if (bucket) bucket.error = "no_anchor";
    return;
  }

  jobRescanGroups.add(groupJid);

  try {
    for (let page = 0; page < JOB_MAX_PAGES; page += 1) {
      const addedBefore = bucket?.added || 0;
      let pageResult;
      try {
        pageResult = await fetchHistoryPage(groupJid, anchor);
      } catch (err) {
        if (bucket) bucket.error = String(err.message || err);
        console.error(`❌ Sync job fetch failed [${groupJid}]:`, err.message || err);
        return;
      }

      const { messages, timedOut } = pageResult;
      if (messages.length) {
        if (bucket && !bucket.fetched) {
          bucket.fetched = true;
          if (activeJobStats) activeJobStats.groups_fetched += 1;
        }
      } else if (timedOut) {
        if (bucket && !bucket.error) bucket.error = "history_timeout";
        console.warn(`⚠️ Sync job history timeout [${groupJid}] page=${page + 1}`);
        return;
      } else {
        return;
      }

      console.log(
        `📚 Sync job page ${page + 1}/${JOB_MAX_PAGES} [${groupJid}] batch=${messages.length}`
      );

      const addedThisPage = (bucket?.added || 0) - addedBefore;
      const pageIds = messages
        .map((m) => m?.key?.id)
        .filter(Boolean);
      const known = pageIds.length
        ? await WhatsappTrackedMessages.countDocuments({
            group_jid: groupJid,
            message_id: { $in: pageIds },
          })
        : 0;

      const oldest = oldestInboundAnchor(messages, groupJid);
      if (addedThisPage === 0 && known > 0) return;
      if (!oldest) return;
      if (Date.now() - oldest.timestampMs > JOB_MAX_AGE_MS) return;
      anchor = oldest;
    }
  } finally {
    jobRescanGroups.delete(groupJid);
    pendingHistoryWaits.get(groupJid)?.finish({ timedOut: true });
  }
}

async function runTrackedMessageSyncJob() {
  if (jobRunning) {
    console.log("⏭️ Sync job still running, skip");
    await persistSkippedJobRun("still_running");
    return;
  }
  if (!sock?.user) {
    console.log("⏭️ Sync job: socket not ready");
    await persistSkippedJobRun("socket_not_ready", false);
    return;
  }

  const groupJids = getTrackedGroupJids();
  if (!groupJids.length) {
    console.log("⏭️ Sync job: no tracked groups in config");
    await persistSkippedJobRun("no_tracked_groups");
    return;
  }

  jobRunning = true;
  startJobStats(groupJids);
  console.log(`⏱️ Sync job: fetching history for ${groupJids.length} tracked group(s)`);

  try {
    for (const groupJid of groupJids) {
      await syncGroupHistory(groupJid);
    }
  } finally {
    const hadError = [...(activeJobStats?.groups.values() || [])].some((g) => g.error);
    const noHistory =
      (activeJobStats?.groups_targeted || 0) > 0 &&
      (activeJobStats?.groups_fetched || 0) === 0;
    await persistJobHistory({
      ok: !hadError && !noHistory,
      reason: hadError ? "group_fetch_errors" : noHistory ? "no_history_received" : "",
    });
    jobRescanGroups.clear();
    jobRunning = false;
  }
}

function startTrackedMessageSyncJob() {
  if (jobTask) return;
  jobTask = cron.schedule(JOB_CRON, () => {
    runTrackedMessageSyncJob().catch((err) => {
      console.error("❌ Sync job crashed:", err.message || err);
    });
  });
  console.log("⏱️ Tracked-message sync job scheduled every 5 min (node-cron)");
}

async function persistTrackedMessage(m, {
  jid,
  text,
  type,
  mediaUrls = [],
  job = false,
  status,
  errorMessage = "",
} = {}) {
  const isGroup = typeof jid === "string" && jid.endsWith("@g.us");
  if (!isGroup) return;

  const senderJid = m.key?.participant || "";
  const senderAlt = m.key?.participantAlt || "";
  if (!isTrackedParticipant(jid, senderJid, senderAlt)) return;

  const messageId = m.key.id || "";
  if (!messageId) return;

  const senderPhone = resolveSenderPhone(m) || "unknown";
  const senderEmail = getTrackedParticipantEmail(jid, senderJid, senderAlt);
  const tsSeconds = m.messageTimestamp
    ? Number(m.messageTimestamp)
    : Math.floor(Date.now() / 1000);

  const urls = (mediaUrls || []).filter(
    (u) => typeof u === "string" && /^https?:\/\//i.test(u)
  );

  let nextStatus = status;
  let nextError = errorMessage;
  if (!nextStatus) {
    if (type === "ciphertext") {
      nextStatus = "error";
      nextError = nextError || "ciphertext";
    } else if (type === "image" && !urls.length && !(text || "").trim()) {
      nextStatus = "error";
      nextError = "image_upload_failed";
    } else {
      nextStatus = "pending";
    }
  }

  try {
    const existing = await WhatsappTrackedMessages.findOne({
      group_jid: jid,
      message_id: messageId,
    }).lean();

    if (existing) {
      const patch = {};
      if (urls.length && !(existing.media_urls || []).length) patch.media_urls = urls;
      if (senderEmail && !existing.sender_email) patch.sender_email = senderEmail;
      if (existing.type === "ciphertext" && type && type !== "ciphertext") {
        patch.type = type;
        patch.text = text || existing.text || "";
      }
      if ((text || "").trim() && !(existing.text || "").trim()) {
        patch.text = text;
      }
      const recoveredToPending =
        (existing.type === "ciphertext" && type !== "ciphertext") ||
        (existing.status === "error" &&
          type !== "ciphertext" &&
          (urls.length || (text || "").trim() || MEDIA_TYPES.has(type)));
      if (recoveredToPending) {
        patch.status = "pending";
        patch.errorMessage = "";
      }
      if (!Object.keys(patch).length) {
        if (job) recordJobEvent(jid, "already");
        return;
      }
      await WhatsappTrackedMessages.updateOne(
        { group_jid: jid, message_id: messageId },
        { $set: patch }
      );
      if (job) recordJobEvent(jid, recoveredToPending ? "added" : "already");
      if (recoveredToPending || patch.media_urls) {
        console.log(
          `💾 Tracked retry${job ? " [job]" : ""} [${jid}] ${senderJid}: (${type}) media=${urls.length} ${text}`
        );
      }
      return;
    }

    await WhatsappTrackedMessages.create({
      group_jid: jid,
      group_name: getTrackedGroupName(jid),
      sender_phone: senderPhone,
      sender_email: senderEmail,
      sender_jid: senderJid,
      message_id: messageId,
      type,
      text: text || "",
      media_urls: urls,
      timestamp: new Date(tsSeconds * 1000),
      status: nextStatus,
      errorMessage: String(nextError || "").slice(0, 500),
      job: Boolean(job),
      raw: {
        fromMe: Boolean(m.key.fromMe),
        pushName: m.pushName || "",
        participantAlt: senderAlt || "",
      },
    });
    if (job) recordJobEvent(jid, "added");
    console.log(
      `💾 Tracked${job ? " [job]" : ""} [${jid}] ${senderJid}: (${type}) media=${urls.length} ${text}`
    );
  } catch (err) {
    if (err?.code === 11000) {
      if (job) recordJobEvent(jid, "already");
      return;
    }
    console.error("❌ Failed to persist tracked message:", err.message || err);
  }
}

/**
 * Process one inbound WA message for tracking.
 * @param {"notify"|"append"|"history"} source
 *   - notify: live delivery (also fills in-memory buffer for GET /messages)
 *   - append: offline/reconnect catch-up (tracked only)
 *   - history: messaging-history.set sync (tracked only)
 */
async function processInboundMessage(m, source = "notify", { job = false } = {}) {
  if (!m?.key) return;
  if (m.key.fromMe) return;

  const jid = m.key.remoteJid;
  const isGroup = typeof jid === "string" && jid.endsWith("@g.us");
  const senderJid = m.key.participant || "";
  const senderAlt = m.key.participantAlt || "";
  const shouldTrack =
    isGroup &&
    (senderJid || senderAlt) &&
    isTrackedParticipant(jid, senderJid, senderAlt);
  const isLive = source === "notify";
  const isCiphertext = m.messageStubType === WAMessageStubType.CIPHERTEXT;

  if (!m.message) {
    if (isCiphertext && shouldTrack) {
      const reason = (m.messageStubParameters || []).filter(Boolean).join("; ") || "decrypt_failed";
      console.warn(
        `⚠️ Ciphertext inbound [${source}] [${jid}] ${senderJid} ${reason}`
      );
      await persistTrackedMessage(m, {
        jid,
        text: "",
        type: "ciphertext",
        mediaUrls: [],
        job,
        status: "error",
        errorMessage: `ciphertext: ${reason}`.slice(0, 500),
      });
      return;
    }
    if (job && isGroup) recordJobEvent(jid, "skipped");
    return;
  }

  const { msgTypeKey, text, type, content } = extractMessageContent(m);
  const mediaUrls = [];

  // Reconnect/history dumps can be huge — only care about tracked sellers
  if (!isLive && !shouldTrack) {
    if (job && isGroup) recordJobEvent(jid, "skipped");
    return;
  }

  const messageId = m.key?.id || "";
  if (shouldTrack && messageId && !isLive) {
    const existing = await WhatsappTrackedMessages.findOne({
      group_jid: jid,
      message_id: messageId,
    }).lean();
    if (existing && !existingNeedsRetry(existing, type)) {
      if (job) recordJobEvent(jid, "already");
      return;
    }
  }

  // Download images immediately (Baileys media keys expire) and mirror to S3
  if (shouldTrack && msgTypeKey === "imageMessage") {
    const url = await downloadImageToS3(m, content);
    if (url) mediaUrls.push(url);
  }

  if (shouldTrack && !hasPersistableContent(text, mediaUrls, type)) {
    if (job) recordJobEvent(jid, "skipped");
    console.log(
      `⏭️ Skip empty tracked msg [${source}] [${jid}] type=${type || msgTypeKey || "unknown"}`
    );
    return;
  }

  if (isLive) {
    addMessage({
      id: nextId++,
      jid,
      text,
      type,
      mediaUrls,
      timestamp: Date.now(),
    });
    console.log(`📥 [${jid}] (${type}) media=${mediaUrls.length} ${text}`);
  } else if (shouldTrack) {
    console.log(
      `📥 [${source}] [${jid}] (${type}) media=${mediaUrls.length} ${text}`
    );
  }

  if (shouldTrack) {
    await persistTrackedMessage(m, { jid, text, type, mediaUrls, job });
  }
}

export async function startSock() {
  if (startingSock) {
    console.log("⏭️ startSock already in progress");
    return;
  }
  startingSock = true;
  const generation = ++sockGeneration;

  try {
    teardownSock();
    const { state, saveCreds } = await useMongoAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      auth: state,
      version,
      browser: ["Chrome", "Windows", "10"],
      printQRInTerminal: false,
      qrTimeout: 600_000, // 10 min — keep each QR before regenerating
      syncFullHistory: true, // emit messaging-history.set for catch-up
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
      if (generation !== sockGeneration) return;

      if (qr) {
        console.log("📲 QR code received, saving to ,/public/qr.png");
        await QRCode.toFile("./public/qr.png", qr, { width: 300 });
      }
      if (connection === "open") {
        reconnectAttempt = 0;
        console.log("✅ WhatsApp connected");
        startTrackedMessageSyncJob();
        await notifyStatusWebhook("connected", {
          message: "WhatsApp session is connected"
        });
      }
      if (connection === "close") {
        const reason = lastDisconnect?.error?.output?.statusCode;
        console.log("❌ Disconnected:", reason, DisconnectReason[reason]);
        if (reason === DisconnectReason.loggedOut) {
          console.log("⚠️ Logged out — clearing auth, please rescan QR");
          await clearMongoAuthState();
          resetAuthFolder();
          await notifyStatusWebhook("logged_out", {
            message: "WhatsApp session logged out, please delete auth/ and rescan QR",
            needRescan: true,
            reasonCode: reason,
            reasonText: DisconnectReason[reason]
          });
          scheduleReconnect({ immediate: true });
        } else {
          scheduleReconnect();
        }
      }
    });

    // notify = live; append = offline/reconnect catch-up (same persist path)
    sock.ev.on("messages.upsert", async ({ messages, type: upsertType }) => {
      const source = upsertType === "append" ? "append" : "notify";
      for (const m of messages || []) {
        rememberGroupMsgAnchor(m);
        try {
          await processInboundMessage(m, source);
        } catch (err) {
          console.error(
            `❌ Failed processing inbound msg [${source}]:`,
            err.message || err
          );
        }
      }
    });

    // History sync batches (when WA sends them). Deduped by message_id in Mongo.
    sock.ev.on("messaging-history.set", async ({ messages, isLatest, syncType }) => {
      const batch = messages || [];
      if (!batch.length) return;

      console.log(
        `📚 History sync batch: ${batch.length} msgs` +
          (isLatest != null ? ` isLatest=${isLatest}` : "") +
          (syncType != null ? ` syncType=${syncType}` : "")
      );

      notifyHistoryWaiters(batch);
      await enqueueHistoryProcess(async () => {
        for (const m of batch) {
          rememberGroupMsgAnchor(m);
          const jid = m?.key?.remoteJid;
          const job = typeof jid === "string" && jobRescanGroups.has(jid);
          if (job && !m?.key?.fromMe) recordJobEvent(jid, "seen");
          try {
            await processInboundMessage(m, "history", { job });
          } catch (err) {
            console.error(
              "❌ Failed processing history msg:",
              err.message || err
            );
          }
        }
      });
    });
  } finally {
    startingSock = false;
  }
}

export async function findGroupJidByName(sock, name) {
  if (!sock) throw new Error("Socket not connected");

  const groups = await sock.groupFetchAllParticipating();
  const values = Object.values(groups);

  const group = values.find(g => g.subject.toLowerCase() === name.toLowerCase());
  if (!group) throw new Error(`Group '${name}' not found`);

  return group.id;
}
