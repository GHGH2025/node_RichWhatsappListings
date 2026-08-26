import mongoose from "mongoose";
import { ensureDirectWholesalersFromPeople } from "./direct_wholesaler.js";

const personSchema = new mongoose.Schema(
  {
    phone: { type: String, default: "" },
    name: { type: String, default: "" },
    email: { type: String, default: "" },
    active: { type: Boolean, default: true },
    participant: { type: String, default: "" },
    participant_lid: { type: String, default: "" },
    participant_pn: { type: String, default: "" },
  },
  { _id: false }
);

const whatsappGroupTrackConfigsSchema = new mongoose.Schema(
  {
    group_jid: { type: String, required: true, unique: true, index: true },
    group_name: { type: String, default: "" },
    active: { type: Boolean, default: true },
    people: { type: [personSchema], default: [] },
  },
  {
    collection: "whatsapp_group_track_configs",
    timestamps: true,
  }
);

async function syncDirectWholesalers(doc) {
  if (!doc) return;
  try {
    await ensureDirectWholesalersFromPeople(doc.people);
  } catch (err) {
    console.error("syncDirectWholesalers error:", err);
  }
}

whatsappGroupTrackConfigsSchema.post("save", async function (doc) {
  await syncDirectWholesalers(doc);
});

// PUT /track-configs uses findByIdAndUpdate, which does not run save hooks.
whatsappGroupTrackConfigsSchema.post("findOneAndUpdate", async function (doc) {
  await syncDirectWholesalers(doc);
});

export const WhatsappGroupTrackConfigs =
  mongoose.models.WhatsappGroupTrackConfigs ||
  mongoose.model("WhatsappGroupTrackConfigs", whatsappGroupTrackConfigsSchema);
