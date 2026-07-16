import mongoose from "mongoose";

const whatsappTrackedMessagesSchema = new mongoose.Schema(
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
    status: { type: String, enum: ["pending", "processing", "processed", "error"], default: "pending" },
    errorMessage: { type: String, default: "" },
  },
  { collection: "whatsapp_tracked_messages" }
);

whatsappTrackedMessagesSchema.index({ group_jid: 1, message_id: 1 }, { unique: true });

export const WhatsappTrackedMessages =
  mongoose.models.WhatsappTrackedMessages ||
  mongoose.model("WhatsappTrackedMessages", whatsappTrackedMessagesSchema);

whatsappTrackedMessagesSchema.index({ status: 1 });
