import mongoose from "mongoose";

const trackedMessageSchema = new mongoose.Schema(
  {
    group_jid: { type: String, required: true, index: true },
    group_name: { type: String, default: "" },
    sender_phone: { type: String, required: true, index: true },
    sender_jid: { type: String, default: "" },
    message_id: { type: String, required: true },
    type: { type: String, default: "text" },
    text: { type: String, default: "" },
    timestamp: { type: Date, default: Date.now, index: true },
    raw: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { collection: "whatsapp_tracked_messages" }
);

trackedMessageSchema.index({ group_jid: 1, message_id: 1 }, { unique: true });

export const TrackedMessage =
  mongoose.models.TrackedMessage ||
  mongoose.model("TrackedMessage", trackedMessageSchema);
