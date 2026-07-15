/** Strip to digits only for matching Baileys JIDs vs config phones. */
export function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

/** Extract digits from a JID like `13095551234@s.whatsapp.net`. */
export function phoneFromJid(jid) {
  if (!jid) return "";
  const local = String(jid).split("@")[0] || "";
  return normalizePhone(local);
}
