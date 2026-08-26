import NodeCache from "node-cache";
import { jidNormalizedUser } from "@whiskeysockets/baileys";
import { WhatsappGroupTrackConfigs } from "../models/whatsapp_group_track_configs.js";
import { normalizePhone } from "../utils/phone.js";

const CACHE_KEY = "active_track_configs";
const EMAILS_KEY = "participant_emails";
const NAMES_KEY = "group_names";

/** stdTTL: 0 = never expire; we refresh on CRUD + startup */
const cache = new NodeCache({ stdTTL: 0, checkperiod: 0 });

/** Strip linked-device suffix (`user:12@…` → `user@…`). */
export function normalizeParticipantJid(jid) {
  if (!jid) return "";
  return jidNormalizedUser(String(jid).trim()) || "";
}

function addJid(setOrMap, jid, email) {
  const normalized = normalizeParticipantJid(jid);
  const raw = String(jid || "").trim();
  const keys = [normalized, raw].filter(Boolean);
  for (const key of keys) {
    if (setOrMap instanceof Set) setOrMap.add(key);
    else if (email) setOrMap.set(key, email);
  }
}

function personJids(person) {
  const jids = [];
  for (const value of [
    person?.participant,
    person?.participant_lid,
    person?.participant_pn,
  ]) {
    if (value) jids.push(value);
  }
  const phone = normalizePhone(person?.phone);
  if (phone) jids.push(`${phone}@s.whatsapp.net`);
  return jids;
}

/**
 * Build Map: group_jid → Set(active participant JIDs)
 * Stores LID, PN, and device-stripped forms so live messages match.
 */
function buildLookupMap(configs) {
  const map = new Map();

  for (const cfg of configs) {
    if (!cfg?.active || !cfg.group_jid) continue;

    const participants = new Set();
    for (const person of cfg.people || []) {
      if (!person?.active) continue;
      for (const jid of personJids(person)) addJid(participants, jid);
    }

    if (participants.size > 0) {
      map.set(cfg.group_jid, participants);
    }
  }

  return map;
}

/**
 * Build Map: group_jid → Map(participantJid → email)
 */
function buildEmailMap(configs) {
  const map = new Map();

  for (const cfg of configs) {
    if (!cfg?.active || !cfg.group_jid) continue;

    const byParticipant = new Map();
    for (const person of cfg.people || []) {
      if (!person?.active) continue;
      const email = String(person.email || "").trim().toLowerCase();
      if (!email) continue;
      for (const jid of personJids(person)) addJid(byParticipant, jid, email);
    }

    if (byParticipant.size > 0) {
      map.set(cfg.group_jid, byParticipant);
    }
  }

  return map;
}

export async function loadTrackConfigCache() {
  const configs = await WhatsappGroupTrackConfigs.find({ active: true }).lean();
  const map = buildLookupMap(configs);
  cache.set(CACHE_KEY, map);

  const emails = buildEmailMap(configs);
  cache.set(EMAILS_KEY, emails);

  const names = new Map();
  for (const cfg of configs) {
    if (cfg?.group_jid) names.set(cfg.group_jid, cfg.group_name || "");
  }
  cache.set(NAMES_KEY, names);

  console.log(`📦 Track config cache loaded (${map.size} active groups)`);
  return map;
}

export async function refreshTrackConfigCache() {
  return loadTrackConfigCache();
}

function getMap() {
  return cache.get(CACHE_KEY) || new Map();
}

/** True if group is tracked and participant or participantAlt matches a configured person. */
export function isTrackedParticipant(groupJid, participantJid, participantAlt) {
  if (!groupJid) return false;
  const map = getMap();
  const participants = map.get(groupJid);
  if (!participants) return false;
  for (const raw of [participantJid, participantAlt]) {
    const normalized = normalizeParticipantJid(raw);
    if (normalized && participants.has(normalized)) return true;
    const trimmed = String(raw || "").trim();
    if (trimmed && participants.has(trimmed)) return true;
  }
  return false;
}

export function getTrackedGroupName(groupJid) {
  const names = cache.get(NAMES_KEY) || new Map();
  return names.get(groupJid) || "";
}

/** Active tracked group JIDs from config cache. */
export function getTrackedGroupJids() {
  return [...getMap().keys()];
}

/** Configured seller email for a tracked participant (lowercase), or "". */
export function getTrackedParticipantEmail(groupJid, participantJid, participantAlt) {
  if (!groupJid) return "";
  const emails = cache.get(EMAILS_KEY) || new Map();
  const byParticipant = emails.get(groupJid);
  if (!byParticipant) return "";
  for (const raw of [participantJid, participantAlt]) {
    const normalized = normalizeParticipantJid(raw);
    if (normalized && byParticipant.has(normalized)) {
      return byParticipant.get(normalized) || "";
    }
    const trimmed = String(raw || "").trim();
    if (trimmed && byParticipant.has(trimmed)) {
      return byParticipant.get(trimmed) || "";
    }
  }
  return "";
}
