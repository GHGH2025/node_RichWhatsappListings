// server.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import { startSock } from "./services/whatsappService.js";
import messageRoutes from "./routes/messageRoutes.js";
import trackConfigRoutes from "./routes/trackConfigRoutes.js";
import { connectMongo } from "./db/mongo.js";
import { loadTrackConfigCache } from "./services/trackConfigCache.js";
import morgan from "morgan";

const PORT = 3001;
const app = express();

app.use(cors());
app.use(express.json());
app.use("/public", express.static("public"));
app.use("/", messageRoutes);
app.use("/", trackConfigRoutes);
app.use(morgan("dev"));
async function main() {
  await connectMongo();
  await loadTrackConfigCache();
  startSock();

  app.listen(PORT, () => {
    console.log(`🌐 HTTP API running on http://localhost:${PORT}`);
    console.log(`📂 Public folder served at  http://localhost:${PORT}/public/qr.png`);
  });
}

main().catch((err) => {
  console.error("❌ Failed to start server:", err);
  process.exit(1);
});
