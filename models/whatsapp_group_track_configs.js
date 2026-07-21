import mongoose from "mongoose";

const personSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true },
    name: { type: String, default: "" },
    email: { type: String, default: "" },
    active: { type: Boolean, default: true },
    participant: { type: String, default: "" },
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

export const WhatsappGroupTrackConfigs =
  mongoose.models.WhatsappGroupTrackConfigs ||
  mongoose.model("WhatsappGroupTrackConfigs", whatsappGroupTrackConfigsSchema);
