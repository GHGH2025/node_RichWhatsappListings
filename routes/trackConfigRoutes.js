import express from "express";
import { getSock } from "../services/whatsappService.js";
import { WhatsappGroupTrackConfigs } from "../models/whatsapp_group_track_configs.js";
import { WhatsappTrackedMessages } from "../models/whatsapp_tracked_messages.js";
import { refreshTrackConfigCache } from "../services/trackConfigCache.js";
import { normalizePhone, phoneFromJid } from "../utils/phone.js";

const router = express.Router();

function normalizeGroupJid(jid) {
  if (!jid) return "";
  return String(jid).includes("@") ? String(jid) : `${jid}@g.us`;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizePeople(people) {
  if (!Array.isArray(people)) return [];
  return people
    .map((p) => ({
      phone: normalizePhone(p?.phone),
      name: String(p?.name || "").trim(),
      email: normalizeEmail(p?.email),
      active: p?.active !== false,
      // Accept either `participant` or participants API `jid`
      participant: String(p?.participant || p?.jid || "").trim(),
    }))
    .filter((p) => p.phone);
}

/** GET /groups — list joined WhatsApp groups */
router.get("/groups", async (_req, res) => {
  try {
    const sock = getSock();
    if (!sock) return res.status(503).json({ error: "not connected" });

    const groups = await sock.groupFetchAllParticipating();
    const list = Object.values(groups).map((g) => ({
      jid: g.id,
      subject: g.subject || "",
      size: Array.isArray(g.participants) ? g.participants.length : 0,
    }));

    list.sort((a, b) => a.subject.localeCompare(b.subject));
    res.json(list);
  } catch (e) {
    console.error("GET /groups error:", e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/** GET /groups/:jid/participants */
router.get("/groups/:jid/participants", async (req, res) => {
  try {
    const sock = getSock();
    if (!sock) return res.status(503).json({ error: "not connected" });

    const jid = normalizeGroupJid(decodeURIComponent(req.params.jid));
    const meta = await sock.groupMetadata(jid);
    const participants = (meta.participants || []).map((p) => {
      // Prefer PN JID (phoneNumber); never treat @lid id digits as a phone
      const pnJid = p.phoneNumber || (String(p.id || "").endsWith("@s.whatsapp.net") ? p.id : "");
      return {
        jid: p.id,
        phone: phoneFromJid(pnJid),
        admin: p.admin || null,
        
      };
    });

    res.json({
      jid,
      subject: meta.subject || "",
      participants,
    });
  } catch (e) {
    console.error("GET /groups/:jid/participants error:", e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/** GET /track-configs */
router.get("/track-configs", async (_req, res) => {
  try {
    const configs = await WhatsappGroupTrackConfigs.find().sort({ updated_at: -1 }).lean();
    res.json(configs);
  } catch (e) {
    console.error("GET /track-configs error:", e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/** GET /track-configs/:id */
router.get("/track-configs/:id", async (req, res) => {
  try {
    const config = await WhatsappGroupTrackConfigs.findById(req.params.id).lean();
    if (!config) return res.status(404).json({ error: "not found" });
    res.json(config);
  } catch (e) {
    console.error("GET /track-configs/:id error:", e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/** POST /track-configs */
router.post("/track-configs", async (req, res) => {
  try {
    const group_jid = normalizeGroupJid(req.body?.group_jid);
    if (!group_jid) {
      return res.status(400).json({ error: "group_jid is required" });
    }

    const people = normalizePeople(req.body?.people);
    const doc = await WhatsappGroupTrackConfigs.create({
      group_jid,
      group_name: String(req.body?.group_name || "").trim(),
      active: req.body?.active !== false,
      people,
    });

    await refreshTrackConfigCache();
    res.status(201).json(doc);
  } catch (e) {
    if (e?.code === 11000) {
      return res.status(409).json({ error: "config already exists for this group_jid" });
    }
    console.error("POST /track-configs error:", e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/** PUT /track-configs/:id */
router.put("/track-configs/:id", async (req, res) => {
  try {
    const updates = { updated_at: new Date() };

    if (req.body?.group_name !== undefined) {
      updates.group_name = String(req.body.group_name || "").trim();
    }
    if (req.body?.active !== undefined) {
      updates.active = Boolean(req.body.active);
    }
    if (req.body?.people !== undefined) {
      updates.people = normalizePeople(req.body.people);
    }
    if (req.body?.group_jid !== undefined) {
      updates.group_jid = normalizeGroupJid(req.body.group_jid);
    }

    const doc = await WhatsappGroupTrackConfigs.findByIdAndUpdate(req.params.id, updates, {
      new: true,
      runValidators: true,
    });

    if (!doc) return res.status(404).json({ error: "not found" });

    await refreshTrackConfigCache();
    res.json(doc);
  } catch (e) {
    if (e?.code === 11000) {
      return res.status(409).json({ error: "config already exists for this group_jid" });
    }
    console.error("PUT /track-configs/:id error:", e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/** DELETE /track-configs/:id */
router.delete("/track-configs/:id", async (req, res) => {
  try {
    const doc = await WhatsappGroupTrackConfigs.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ error: "not found" });

    await refreshTrackConfigCache();
    res.json({ ok: true, id: req.params.id });
  } catch (e) {
    console.error("DELETE /track-configs/:id error:", e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/** GET /tracked-messages?group_jid=&since= ISO date or ms */
router.get("/tracked-messages", async (req, res) => {
  try {
    const filter = {};
    if (req.query.group_jid) {
      filter.group_jid = normalizeGroupJid(String(req.query.group_jid));
    }
    if (req.query.since) {
      const sinceRaw = String(req.query.since);
      const sinceDate = /^\d+$/.test(sinceRaw)
        ? new Date(Number(sinceRaw))
        : new Date(sinceRaw);
      if (!Number.isNaN(sinceDate.getTime())) {
        filter.timestamp = { $gt: sinceDate };
      }
    }

    const limit = Math.min(parseInt(req.query.limit || "100", 10) || 100, 500);
    const messages = await WhatsappTrackedMessages.find(filter)
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();

    res.json({ count: messages.length, messages });
  } catch (e) {
    console.error("GET /tracked-messages error:", e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

export default router;
