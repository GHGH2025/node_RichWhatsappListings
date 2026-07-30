// services/whatsappService.js
import "dotenv/config";
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
  extractMessageContent as baileysExtractMessageContent,
  getContentType,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import fs from "fs";
import {
  isTrackedParticipant,
  getTrackedGroupName,
  getTrackedParticipantEmail,
} from "./trackConfigCache.js";
import { WhatsappTrackedMessages } from "../models/whatsapp_tracked_messages.js";
import { phoneFromJid } from "../utils/phone.js";
import { uploadBufferToS3 } from "../utils/s3Upload.js";

const authDir = "./auth";
fs.mkdirSync(authDir, { recursive: true });

let sock;
const msgs = [];
let nextId = 1;

const WEBHOOK_URL = process.env.WHATSAPP_STATUS_WEBHOOK_URL || "";
const APP_BASE_URL = process.env.APP_BASE_URL || "http://localhost:3001";

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

export function getSock() {
  return sock;
}
export function getMessages(since = 0) {
  return msgs.filter(m => m.id > since);
}
export function addMessage(msg) {
  msgs.push(msg);
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

function hasPersistableContent(text, mediaUrls = []) {
  return Boolean((text || "").trim() || (mediaUrls || []).length);
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

async function persistTrackedMessage(m, { jid, text, type, mediaUrls = [] }) {
  const isGroup = typeof jid === "string" && jid.endsWith("@g.us");
  if (!isGroup) return;

  const senderJid = m.key?.participant || "";
  if (!senderJid || !isTrackedParticipant(jid, senderJid)) return;

  if (!hasPersistableContent(text, mediaUrls)) return;

  const messageId = m.key.id || "";
  if (!messageId) return;

  const senderPhone = resolveSenderPhone(m) || "unknown";
  const senderEmail = getTrackedParticipantEmail(jid, senderJid);
  const tsSeconds = m.messageTimestamp
    ? Number(m.messageTimestamp)
    : Math.floor(Date.now() / 1000);

  const urls = (mediaUrls || []).filter(
    (u) => typeof u === "string" && /^https?:\/\//i.test(u)
  );

  try {
    const result = await WhatsappTrackedMessages.updateOne(
      { group_jid: jid, message_id: messageId },
      {
        $setOnInsert: {
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
          status: "pending",
          raw: {
            fromMe: Boolean(m.key.fromMe),
            pushName: m.pushName || "",
          },
        },
      },
      { upsert: true }
    );
    if (result.upsertedCount > 0) {
      console.log(
        `💾 Tracked [${jid}] ${senderJid}: (${type}) media=${urls.length} ${text}`
      );
    }
  } catch (err) {
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
async function processInboundMessage(m, source = "notify") {
  if (!m?.message) return;
  if (m.key?.fromMe) return;

  const jid = m.key.remoteJid;
  const { msgTypeKey, text, type, content } = extractMessageContent(m);
  const mediaUrls = [];

  const isGroup = typeof jid === "string" && jid.endsWith("@g.us");
  const senderJid = m.key?.participant || "";
  const shouldTrack =
    isGroup && senderJid && isTrackedParticipant(jid, senderJid);

  // Reconnect/history dumps can be huge — only care about tracked sellers
  const isLive = source === "notify";
  if (!isLive && !shouldTrack) return;

  const messageId = m.key?.id || "";
  if (shouldTrack && messageId && !isLive) {
    const existing = await WhatsappTrackedMessages.exists({
      group_jid: jid,
      message_id: messageId,
    });
    if (existing) return;
  }

  // Download images immediately (Baileys media keys expire) and mirror to S3
  if (shouldTrack && msgTypeKey === "imageMessage") {
    const url = await downloadImageToS3(m, content);
    if (url) mediaUrls.push(url);
  }

  if (shouldTrack && !hasPersistableContent(text, mediaUrls)) {
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
    await persistTrackedMessage(m, { jid, text, type, mediaUrls });
  }
}

export async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    auth: state,
    version,
    browser: ["Chrome", "Windows", "10"],
    printQRInTerminal: false,
    qrTimeout: 600_000, // 10 min — keep each QR before regenerating
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
    if (qr) {
      console.log("📲 QR code received, saving to ,/public/qr.png");
      await QRCode.toFile("./public/qr.png", qr, { width: 300 });
    }
    if (connection === "open") {
      console.log("✅ WhatsApp connected");
      await notifyStatusWebhook("connected", {
        message: "WhatsApp session is connected"
      });
    }
    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log("❌ Disconnected:", reason, DisconnectReason[reason]);
      if (reason !== DisconnectReason.loggedOut) {
        console.log("🔄 Restarting...");
        startSock();
      } else {
        console.log("⚠️ Logged out — delete auth/ and rescan QR");

        resetAuthFolder();

        await notifyStatusWebhook("logged_out", {
          message: "WhatsApp session logged out, please delete auth/ and rescan QR",
          needRescan: true,
          reasonCode: reason,
          reasonText: DisconnectReason[reason]
        });

        console.log("🔄 Starting new session for fresh QR...");
        startSock();
      }
    }
  });

  // notify = live; append = offline/reconnect catch-up (same persist path)
  sock.ev.on("messages.upsert", async ({ messages, type: upsertType }) => {
    const source = upsertType === "append" ? "append" : "notify";
    for (const m of messages || []) {
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

    for (const m of batch) {
      try {
        await processInboundMessage(m, "history");
      } catch (err) {
        console.error(
          "❌ Failed processing history msg:",
          err.message || err
        );
      }
    }
  });
}

export async function findGroupJidByName(sock, name) {
  if (!sock) throw new Error("Socket not connected");

  const groups = await sock.groupFetchAllParticipating();
  const values = Object.values(groups);

  const group = values.find(g => g.subject.toLowerCase() === name.toLowerCase());
  if (!group) throw new Error(`Group '${name}' not found`);

  return group.id;
}
