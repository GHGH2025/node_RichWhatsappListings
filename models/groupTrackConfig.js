import mongoose from "mongoose";

const personSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true },
    name: { type: String, default: "" },
    active: { type: Boolean, default: true },
  },
  { _id: false }
);

const groupTrackConfigSchema = new mongoose.Schema(
  {
    group_jid: { type: String, required: true, unique: true, index: true },
    group_name: { type: String, default: "" },
    active: { type: Boolean, default: true },
    people: { type: [personSchema], default: [] },
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now },
  },
  { collection: "whatsapp_group_track_configs" }
);

groupTrackConfigSchema.pre("save", function (next) {
  this.updated_at = new Date();
  next();
});

export const GroupTrackConfig =
  mongoose.models.GroupTrackConfig ||
  mongoose.model("GroupTrackConfig", groupTrackConfigSchema);
