import NodeCache from "node-cache";
import { WhatsappGroupTrackConfigs } from "../models/whatsapp_group_track_configs.js";

const CACHE_KEY = "active_track_configs";

/** stdTTL: 0 = never expire; we refresh on CRUD + startup */
const cache = new NodeCache({ stdTTL: 0, checkperiod: 0 });

/**
 * Build Map: group_jid → Set(active participant JIDs)
 * Only includes active configs and active people.
 */
function buildLookupMap(configs) {
  const map = new Map();

  for (const cfg of configs) {
    if (!cfg?.active || !cfg.group_jid) continue;

    const participants = new Set();
    for (const person of cfg.people || []) {
      if (!person?.active) continue;
      const participant = String(person.participant || "").trim();
      if (participant) participants.add(participant);
    }

    if (participants.size > 0) {
      map.set(cfg.group_jid, participants);
    }
  }

  return map;
}

export async function loadTrackConfigCache() {
  const configs = await WhatsappGroupTrackConfigs.find({ active: true }).lean();
  const map = buildLookupMap(configs);
  cache.set(CACHE_KEY, map);

  // Also keep group_name lookup for persist path
  const names = new Map();
  for (const cfg of configs) {
    if (cfg?.group_jid) names.set(cfg.group_jid, cfg.group_name || "");
  }
  cache.set("group_names", names);

  console.log(`📦 Track config cache loaded (${map.size} active groups)`);
  return map;
}

export async function refreshTrackConfigCache() {
  return loadTrackConfigCache();
}

function getMap() {
  return cache.get(CACHE_KEY) || new Map();
}

/** True if group_jid is tracked and participant JID is in that group's people. */
export function isTrackedParticipant(groupJid, participantJid) {
  if (!groupJid || !participantJid) return false;
  const map = getMap();
  const participants = map.get(groupJid);
  if (!participants) return false;
  return participants.has(String(participantJid).trim());
}

export function getTrackedGroupName(groupJid) {
  const names = cache.get("group_names") || new Map();
  return names.get(groupJid) || "";
}
