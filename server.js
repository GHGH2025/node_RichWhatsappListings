// server.js
import express from "express";
import bodyParser from "body-parser";
import { startSock, getSock, getMessages, addMessage } from "./services/whatsappService.js";  
import messageRoutes from "./routes/messageRoutes.js";


const PORT = 3001;
const app = express();
app.use(bodyParser.json());

//share folder
app.use("/public",express.static("public"))

// mount routes
app.use("/", messageRoutes);

// start whatsapp socket
startSock();

// HTTP server
app.listen(PORT, () => {
  console.log(`🌐 HTTP API running on http://localhost:${PORT}`);
  console.log(`📂 Public folder served at  http://localhost:${PORT}/public/qr.png`);
});