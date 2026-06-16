// server.js
import express from "express";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import {
  bootWhatsApp,
  shutdownSock,
  getQrPngBuffer,
  isWhatsAppConnected
} from "./services/whatsappService.js";
import messageRoutes from "./routes/messageRoutes.js";

const PORT = 3001;
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(appRoot, "public");

const app = express();
app.use(bodyParser.json());

// On-demand QR — only generated when this URL is requested
app.get("/public/qr.png", async (req, res) => {
  try {
    if (isWhatsAppConnected()) {
      return res.status(409).type("text/plain").send("WhatsApp is already connected");
    }

    console.log("🌐 GET /public/qr.png — starting QR pairing");
    const png = await getQrPngBuffer();
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.send(png);
  } catch (err) {
    console.error("❌ Failed to serve QR:", err.message || err);
    const status = err.code === "ALREADY_CONNECTED" ? 409 : 503;
    res.status(status).type("text/plain").send(err.message || "Failed to generate QR code");
  }
});

// Other static assets (not qr.png)
app.use("/public", express.static(publicDir));

app.use("/", messageRoutes);

bootWhatsApp();

const server = app.listen(PORT, () => {
  console.log(`🌐 HTTP API running on http://localhost:${PORT}`);
  console.log(`📲 QR pairing URL: http://localhost:${PORT}/public/qr.png (on-demand only)`);
});

async function gracefulShutdown(signal) {
  console.log(`${signal} received — closing WhatsApp session and HTTP server`);
  await shutdownSock();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
