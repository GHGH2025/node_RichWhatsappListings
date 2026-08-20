import mongoose from "mongoose";

// Keep in sync with py_RichListings/models/direct_wholesaler.py
const directWholesalerSchema = new mongoose.Schema(
  {
    sender_email: { type: String, required: true },
    email: { type: String, required: true },
    name: { type: String, required: true },
    phone: { type: String, default: "" },
    updateFlagForPodio: { type: Boolean, default: true },
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now },
  },
  {
    collection: "direct_wholesalers",
    versionKey: false,
    strict: true,
    autoIndex: false,
  }
);

directWholesalerSchema.index({ sender_email: 1 }, { unique: true, name: "uniq_sender_email" });
directWholesalerSchema.index({ email: 1 }, { name: "contact_email_idx" });

export const DirectWholesaler =
  mongoose.models.DirectWholesaler ||
  mongoose.model("DirectWholesaler", directWholesalerSchema);

function sellerEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return email.includes("@") ? email : "";
}

/**
 * Insert missing direct_wholesalers rows from WhatsApp group people.
 * Existing sender_email rows are left unchanged.
 */
export async function ensureDirectWholesalersFromPeople(people) {
  if (!Array.isArray(people) || people.length === 0) return;

  const seen = new Set();
  const ops = [];

  for (const person of people) {
    const email = sellerEmail(person?.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);

    const name = String(person?.name || "").trim() || email.split("@")[0];
    const phone = String(person?.phone || "").trim();
    const now = new Date();

    ops.push({
      updateOne: {
        filter: { sender_email: email },
        update: {
          $setOnInsert: {
            sender_email: email,
            email,
            name,
            phone,
            updateFlagForPodio: true,
            created_at: now,
            updated_at: now,
          },
        },
        upsert: true,
      },
    });
  }

  if (!ops.length) return;

  try {
    await DirectWholesaler.bulkWrite(ops, { ordered: false });
  } catch (err) {
    console.error("ensureDirectWholesalersFromPeople error:", err);
  }
}
