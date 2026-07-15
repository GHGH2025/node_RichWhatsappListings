import NodeCache from "node-cache";
import { GroupTrackConfig } from "../models/groupTrackConfig.js";
import { normalizePhone } from "../utils/phone.js";

const CACHE_KEY = "active_track_configs";

/** stdTTL: 0 = never expire; we refresh on CRUD + startup */
const cache = new NodeCache({ stdTTL: 0, checkperiod: 0 });

/**
 * Build Map: group_jid → Set(active phones as digits)
 * Only includes active configs and active people.
 */
function buildLookupMap(configs) {
  const map = new Map();

  for (const cfg of configs) {
    if (!cfg?.active || !cfg.group_jid) continue;

    const phones = new Set();
    for (const person of cfg.people || []) {
      if (!person?.active) continue;
      const phone = normalizePhone(person.phone);
      if (phone) phones.add(phone);
    }

    if (phones.size > 0) {
      map.set(cfg.group_jid, phones);
    }
  }

  return map;
}

export async function loadTrackConfigCache() {
  const configs = await GroupTrackConfig.find({ active: true }).lean();
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

export function isTrackedSender(groupJid, phone) {
  if (!groupJid || !phone) return false;
  const map = getMap();
  const phones = map.get(groupJid);
  if (!phones) return false;
  return phones.has(normalizePhone(phone));
}

export function getTrackedGroupName(groupJid) {
  const names = cache.get("group_names") || new Map();
  return names.get(groupJid) || "";
}
