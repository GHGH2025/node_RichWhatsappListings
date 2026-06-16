// services/whatsappService.js
import "dotenv/config";
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authDir = process.env.WHATSAPP_AUTH_DIR
  ? path.resolve(process.env.WHATSAPP_AUTH_DIR)
  : path.join(appRoot, "auth");

fs.mkdirSync(authDir, { recursive: true });

let sock;
let isStarting = false;
let startPromise = null;
let reconnectTimer = null;
let sessionRegistered = false;
let connectionOpen = false;
let pairingActive = false;
let shuttingDown = false;
let latestQr = null;
const qrWaiters = [];
const msgs = [];
let nextId = 1;

const RECONNECT_MS = Number(process.env.WHATSAPP_RECONNECT_MS || 5000);
const REPLACED_RECONNECT_MS = Number(process.env.WHATSAPP_REPLACED_RECONNECT_MS || 15000);
const QR_REQUEST_TIMEOUT_MS = Number(process.env.WHATSAPP_QR_REQUEST_TIMEOUT_MS || 90000);

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

function hasRegisteredSession() {
  const credsPath = path.join(authDir, "creds.json");
  if (!fs.existsSync(credsPath)) return false;

  try {
    const creds = JSON.parse(fs.readFileSync(credsPath, "utf8"));
    return !!creds.registered;
  } catch {
    return false;
  }
}

function deliverQr(qr) {
  latestQr = qr;
  while (qrWaiters.length) {
    const waiter = qrWaiters.shift();
    waiter.resolve(qr);
  }
}

function rejectQrWaiters(err) {
  latestQr = null;
  while (qrWaiters.length) {
    const waiter = qrWaiters.shift();
    waiter.reject(err);
  }
}

export function getSock() {
  return sock;
}

export function isWhatsAppConnected() {
  return connectionOpen;
}

export function getMessages(since = 0) {
  return msgs.filter(m => m.id > since);
}

export function addMessage(msg) {
  msgs.push(msg);
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(delayMs, label) {
  if (shuttingDown) return;
  clearReconnectTimer();
  console.log(`⏳ Reconnect scheduled in ${delayMs}ms (${label})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startSock({ pairing: false });
  }, delayMs);
}

async function stopSock() {
  clearReconnectTimer();
  const current = sock;
  sock = null;
  connectionOpen = false;
  if (!current) return;

  try {
    current.ev.removeAllListeners("connection.update");
    current.ev.removeAllListeners("creds.update");
    current.ev.removeAllListeners("messages.upsert");
    await current.end(undefined);
  } catch (err) {
    console.warn("⚠️ Error while closing WhatsApp socket:", err?.message || err);
  }
}

export async function shutdownSock() {
  shuttingDown = true;
  rejectQrWaiters(new Error("SERVICE_SHUTTING_DOWN"));
  pairingActive = false;
  await stopSock();
}

function handleDisconnect(reason) {
  const reasonText = DisconnectReason[reason] || "unknown";
  console.log("❌ Disconnected:", reason, reasonText);
  connectionOpen = false;

  if (reason === DisconnectReason.loggedOut) {
    console.log("⚠️ Logged out — auth cleared. Open /public/qr.png to pair again.");
    resetAuthFolder();
    sessionRegistered = false;
    pairingActive = false;
    rejectQrWaiters(new Error("LOGGED_OUT"));
    notifyStatusWebhook("logged_out", {
      message: "WhatsApp session logged out, open /public/qr.png to pair again",
      needRescan: true,
      reasonCode: reason,
      reasonText
    });
    return;
  }

  if (!sessionRegistered) {
    pairingActive = false;
    latestQr = null;
    rejectQrWaiters(new Error("QR_PAIRING_ENDED"));
    console.log(
      `⏹️ QR pairing ended (${reasonText}). Open ${APP_BASE_URL}/public/qr.png to generate a new QR.`
    );
    return;
  }

  if (reason === DisconnectReason.connectionReplaced) {
    console.log("⚠️ Another WhatsApp connection replaced this session");
    scheduleReconnect(REPLACED_RECONNECT_MS, "connection_replaced");
    return;
  }

  scheduleReconnect(RECONNECT_MS, reasonText);
}

export async function bootWhatsApp() {
  if (hasRegisteredSession()) {
    console.log(`🔑 Found saved session in ${authDir} — connecting automatically`);
    await startSock({ pairing: false });
    return;
  }

  console.log(
    `💤 No saved WhatsApp session. QR will only be generated when ${APP_BASE_URL}/public/qr.png is requested.`
  );
}

export async function requestQrCode(timeoutMs = QR_REQUEST_TIMEOUT_MS) {
  if (connectionOpen) {
    const err = new Error("WhatsApp is already connected");
    err.code = "ALREADY_CONNECTED";
    throw err;
  }

  if (latestQr && pairingActive) {
    return latestQr;
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = qrWaiters.findIndex((w) => w.resolve === resolve);
      if (idx >= 0) qrWaiters.splice(idx, 1);
      reject(new Error("QR_GENERATION_TIMEOUT"));
    }, timeoutMs);

    const wrappedResolve = (qr) => {
      clearTimeout(timer);
      resolve(qr);
    };
    const wrappedReject = (err) => {
      clearTimeout(timer);
      reject(err);
    };

    qrWaiters.push({ resolve: wrappedResolve, reject: wrappedReject });

    startSock({ pairing: true }).catch((err) => {
      const idx = qrWaiters.findIndex((w) => w.resolve === wrappedResolve);
      if (idx >= 0) qrWaiters.splice(idx, 1);
      wrappedReject(err);
    });
  });
}

export async function getQrPngBuffer() {
  const qr = await requestQrCode();
  return QRCode.toBuffer(qr, { width: 300, type: "png" });
}

export async function startSock({ pairing = false } = {}) {
  if (shuttingDown) return;

  if (!pairing && !hasRegisteredSession()) {
    console.log("Skipping socket start — no saved session (use GET /public/qr.png to pair)");
    return;
  }

  if (startPromise) return startPromise;

  startPromise = (async () => {
    if (isStarting) return;
    isStarting = true;
    pairingActive = pairing;

    try {
      await stopSock();

      const { state, saveCreds } = await useMultiFileAuthState(authDir);
      sessionRegistered = !!state.creds?.registered;

      if (pairing && !sessionRegistered) {
        console.log("📲 QR pairing requested — connecting to WhatsApp...");
      } else if (sessionRegistered) {
        console.log(`🔑 Restoring registered session from ${authDir}`);
      }

      const { version } = await fetchLatestBaileysVersion();

      sock = makeWASocket({
        auth: state,
        version,
        browser: ["Chrome", "Windows", "10"],
        printQRInTerminal: false
      });

      sock.ev.on("creds.update", (creds) => {
        if (creds?.registered) sessionRegistered = true;
        return saveCreds();
      });

      sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
        if (qr && pairingActive) {
          console.log("📲 QR code generated (on-demand)");
          deliverQr(qr);
          await notifyStatusWebhook("qr", {
            message: "Scan QR to connect WhatsApp",
            qrUrl: `${APP_BASE_URL}/public/qr.png`
          });
        }

        if (connection === "open") {
          console.log("✅ WhatsApp connected");
          connectionOpen = true;
          pairingActive = false;
          latestQr = null;
          sessionRegistered = true;
          await notifyStatusWebhook("connected", {
            message: "WhatsApp session is connected"
          });
        }

        if (connection === "close") {
          const reason = lastDisconnect?.error?.output?.statusCode;
          handleDisconnect(reason);
        }
      });

      sock.ev.on("messages.upsert", async ({ messages }) => {
        const m = messages[0];
        if (!m?.message) return;

        const msgTypeKey = Object.keys(m.message)[0];
        const jid = m.key.remoteJid;

        let text = "";
        let type = "";
        let filePath = null;

        if (msgTypeKey === "conversation") {
          text = m.message.conversation;
          type = "text";
        } else if (msgTypeKey === "extendedTextMessage") {
          text = m.message.extendedTextMessage.text;
          type = "extendedText";
        } else if (msgTypeKey === "imageMessage") {
          text = m.message.imageMessage.caption || "";
          type = "image";
        } else if (msgTypeKey === "videoMessage") {
          text = m.message.videoMessage.caption || "";
          type = "video";
        } else if (msgTypeKey === "audioMessage") {
          type = "audio";
        } else if (msgTypeKey === "documentMessage") {
          text = m.message.documentMessage.fileName || "";
          type = "document";
        } else if (msgTypeKey === "reactionMessage") {
          text = m.message.reactionMessage.text;
          type = "reaction";
        } else {
          type = msgTypeKey;
        }

        if (["imageMessage", "videoMessage", "documentMessage", "audioMessage"].includes(msgTypeKey)) {
          try {
            await downloadMediaMessage(m, "buffer", {}, { logger: sock.logger });
          } catch (err) {
            console.error("Media download error:", err);
          }
        }

        addMessage({
          id: nextId++,
          jid,
          text,
          type,
          filePath,
          timestamp: Date.now()
        });
        console.log(`📥 [${jid}] (${type}) ${text}`);
      });
    } finally {
      isStarting = false;
      startPromise = null;
    }
  })();

  return startPromise;
}

export async function findGroupJidByName(sock, name) {
  if (!sock) throw new Error("Socket not connected");

  const groups = await sock.groupFetchAllParticipating();
  const values = Object.values(groups);

  const group = values.find(g => g.subject.toLowerCase() === name.toLowerCase());
  if (!group) throw new Error(`Group '${name}' not found`);

  return group.id;
}
