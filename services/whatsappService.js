// services/whatsappService.js
import "dotenv/config"; // NEW: loads .env
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import fs from "fs";

const authDir = "./auth";
fs.mkdirSync(authDir, { recursive: true });

let sock;
const msgs = [];
let nextId = 1;

// NEW: webhook + base URL
const WEBHOOK_URL = process.env.WHATSAPP_STATUS_WEBHOOK_URL || "";
const APP_BASE_URL = process.env.APP_BASE_URL || "http://localhost:3001";

// NEW: helper to notify external webhook
async function notifyStatusWebhook(event, extra = {}) {
  if (!WEBHOOK_URL) {
    console.warn("⚠️ WHATSAPP_STATUS_WEBHOOK_URL not set, skipping webhook:", event);
    return;
  }

  try {
    const payload = {
      event,                         // 'connected', 'disconnected', 'logged_out', 'qr'
      timestamp: new Date().toISOString(),
      ...extra
    };

    // Node 18+ has global fetch. If you're on Node <18, install node-fetch and import it.
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

// 🔹 helper: delete auth folder & recreate it
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

export async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    auth: state,
    version,
    browser: ["Chrome", "Windows", "10"],
    printQRInTerminal: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
    if (qr) {
      console.log("📲 QR code received, saving to ,/public/qr.png");
      await QRCode.toFile("./public/qr.png", qr, { width: 300 });
    }
    // if (connection === "open") console.log("✅ WhatsApp connected");
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

sock.ev.on("messages.upsert", async ({ messages }) => {

  const m = messages[0];
  if (!m?.message) return;

  const msgTypeKey = Object.keys(m.message)[0]; // Baileys key
  const jid = m.key.remoteJid;

  let text = "";
  let type = "";
  let filePath = null;

  // Simplified type + text extraction
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
    text = ""; // no caption in audio
    type = "audio";
  } else if (msgTypeKey === "documentMessage") {
    text = m.message.documentMessage.fileName || "";
    type = "document";
  }
  else if(msgTypeKey === "reactionMessage"){
       const reaction = m.message.reactionMessage;
        text = reaction.text;
        type = "reaction";
    }
  else {
    type = msgTypeKey;
  }

  // Media download
  if (["imageMessage", "videoMessage", "documentMessage", "audioMessage"].includes(msgTypeKey)) {
    try {
      const buffer = await downloadMediaMessage(m, "buffer", {}, { logger: sock.logger });

      // determine extension based on mimetype or fileName
      let ext = "bin";
      if (msgTypeKey === "imageMessage") {
        ext = "jpg";
      } else if (msgTypeKey === "videoMessage") {
        const mime = m.message.videoMessage?.mimetype || "";
        if (mime.includes("mp4")) ext = "mp4";
        else if (mime.includes("3gpp")) ext = "3gp";
        else ext = "mp4";
      } else if (msgTypeKey === "audioMessage") {
        const mime = m.message.audioMessage?.mimetype || "";
        if (mime.includes("ogg")) ext = "ogg";
        else if (mime.includes("mp3")) ext = "mp3";
        else if (mime.includes("wav")) ext = "wav";
        else ext = "opus"; // WhatsApp voice notes
      } else if (msgTypeKey === "documentMessage") {
        ext = m.message.documentMessage?.fileName?.split(".").pop() || "bin";
      }

      // save file
      // const mediaDir = "./public/media";
      // fs.mkdirSync(mediaDir, { recursive: true });
      // filePath = `${mediaDir}/${Date.now()}_${jid}.${ext}`;
      // fs.writeFileSync(filePath, buffer);
      // console.log(`💾 Saved media to ${filePath}`);
    } catch (err) {
      console.error("Media download error:", err);
    }
  }

  // Save entry in memory
  const entry = {
    id: nextId++,
    jid,
    text,
    type,
    filePath,
    timestamp: Date.now()
  };

  addMessage(entry);
  console.log(`📥 [${jid}] (${type}) ${text}`);
});


}

export async function findGroupJidByName(sock, name) {
  if (!sock) throw new Error("Socket not connected");

  // fetch joined groups
  const groups = await sock.groupFetchAllParticipating();
  const values = Object.values(groups);

  const group = values.find(g => g.subject.toLowerCase() === name.toLowerCase());
  if (!group) throw new Error(`Group '${name}' not found`);

  return group.id; // this is the JID like 1203630xxxxx@g.us
}

