// routes/messageRoutes.js
import express from "express";
import { getSock, getMessages, addMessage ,findGroupJidByName } from "../services/whatsappService.js";

const router = express.Router();

// send message
// router.post("/send", async (req, res) => {
//   try {
//     const sock = getSock();
//     if (!sock) return res.status(503).send("not connected");

//     let { to, text } = req.body;
//     if (!to || !text) return res.status(400).send("need 'to' and 'text'");

//     // normalize: allow string or array
//     const recipients = Array.isArray(to) ? to : [to];

//     const results = [];

//     for (let r of recipients) {
//       // normalize to proper JID
//       let jid;
//       if (r.includes("@")) {
//         jid = r;
//       } else {
//         jid = `${r}@s.whatsapp.net`;
//       }

//       try {
//         await sock.sendMessage(jid, { text });
//         console.log(`📤 Sent to ${jid}: ${text}`);

//         addMessage({
//           id: Date.now(),
//           jid,
//           text: `(out) ${text}`,
//           timestamp: Date.now()
//         });

//         results.push({ to: jid, status: "sent" });
//       } catch (err) {
//         console.error(`❌ Failed to send to ${jid}:`, err.message);
//         results.push({ to: jid, status: "failed", error: err.message });
//       }
//     }

//     res.json({ results });
//   } catch (e) {
//     console.error("Send error:", e);
//     res.status(500).json({ error: e?.message || String(e) });
//   }
// });


router.post("/send", async (req, res) => {
  try {
    const sock = getSock();
    if (!sock) return res.status(503).send("not connected");

    let { to, text, imageUrl } = req.body;

    // require recipient + at least one of text or image
    if (!to || (!text && !imageUrl)) {
      return res.status(400).send("need 'to' and either 'text' or 'imageUrl'");
    }

    // quick public URL check for image
    const isHttpUrl = (u) => typeof u === "string" && /^https?:\/\/\S+$/i.test(u);
    if (imageUrl && !isHttpUrl(imageUrl)) {
      return res.status(400).send("'imageUrl' must be a public http(s) URL");
    }

    const recipients = Array.isArray(to) ? to : [to];
    const results = [];

    for (const r of recipients) {
      // normalize to proper JID (individual chat). For groups, pass "<id>@g.us".
      const jid = r.includes("@") ? r : `${r}@s.whatsapp.net`;

      // Build the message payload
      const msg =
        imageUrl
          ? { image: { url: imageUrl }, caption: text || undefined } // image + optional caption
          : { text };                                                // plain text

      try {
        await sock.sendMessage(jid, msg);

        console.log(
          `📤 Sent to ${jid}: ${imageUrl ? `[image: ${imageUrl}] ${text || ""}` : text}`
        );

        addMessage({
          id: Date.now(),
          jid,
          text: imageUrl ? `(out) [image] ${text || ""}` : `(out) ${text}`,
          timestamp: Date.now()
        });

        results.push({ to: jid, status: "sent" });
      } catch (err) {
        console.error(`❌ Failed to send to ${jid}:`, err.message);
        results.push({ to: jid, status: "failed", error: err.message });
      }
    }

    res.json({ results });
  } catch (e) {
    console.error("Send error:", e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// fetch messages since id
router.get("/messages", (req, res) => {
  const since = parseInt(req.query.since || "0", 10) || 0;
  const out = getMessages(since);
  res.json({ last: out.length ? out[out.length - 1].id : since, messages: out });
});

export default router;


//from a specific user/jid

router.get("/messages/:jid",(req,res) =>{

  const since = parseInt(req.query.since || '0',10) || 0;
  let jid = req.params.jid;

  //if user passed only number
  jid = jid.includes("@s.whatsapp.net") ? jid : `${jid}@s.whatsapp.net`

  const out = getMessages(since).filter(m => m.jid == jid);

 res.json({
    last: out.length ? out[out.length - 1].id : since,
    messages: out
  });

})

router.post("/group/send", async (req, res) => {
  try {
    const sock = getSock();
    if (!sock) return res.status(503).json({ error: "not connected" });

    let { jids, text, imageUrl } = req.body;

    // require jids + at least one of text or image
    if (!jids || (!text && !imageUrl)) {
      return res
        .status(400)
        .json({ error: "need 'jids' and either 'text' or 'imageUrl'" });
    }

    // normalize to array
    const groupJids = Array.isArray(jids) ? jids : [jids];

    // quick public URL check for image
    const isHttpUrl = (u) =>
      typeof u === "string" && /^https?:\/\/\S+$/i.test(u);

    if (imageUrl && !isHttpUrl(imageUrl)) {
      return res
        .status(400)
        .json({ error: "'imageUrl' must be a public http(s) URL" });
    }

    // Optional: normalize group JID (allow passing just numeric part)
    const normalizeGroupJid = (g) =>
      g.includes("@") ? g : `${g}@g.us`;

    const results = [];

    for (const g of groupJids) {
      const jid = normalizeGroupJid(g);

      // Build the message payload (same idea as /send)
      const msg = imageUrl
        ? { image: { url: imageUrl }, caption: text || undefined }
        : { text };

      try {
        await sock.sendMessage(jid, msg);

        console.log(
          `📤 Sent to group JID '${g}' (${jid}): ${
            imageUrl ? `[image: ${imageUrl}] ${text || ""}` : text
          }`
        );

        addMessage({
          id: Date.now(), // or your shared nextMessageId()
          jid,
          text: imageUrl
            ? `(out to group ${jid}) [image] ${text || ""}`
            : `(out to group ${jid}) ${text}`,
          timestamp: Date.now()
        });

        results.push({ jid, status: "sent" });
      } catch (err) {
        console.error(`❌ Failed to send to group '${jid}':`, err.message);
        results.push({
          jid,
          status: "failed",
          error: err.message
        });
      }
    }

    res.json({ results });
  } catch (e) {
    console.error("Group send error:", e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});


router.get("/group/:name", async (req, res) => {
  try {
    const sock = getSock();
    if (!sock) return res.status(503).json({ error: "not connected" });

    const since = parseInt(req.query.since || "0", 10) || 0;
    const groupName = req.params.name;

    try {
      const jid = await findGroupJidByName(sock, groupName);
      const out = getMessages(since).filter(m => m.jid === jid);

      res.json({
        jid:jid,
        last: out.length ? out[out.length - 1].id : since,
        messages: out
      });
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  } catch (e) {
    console.error("Group fetch error:", e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});