import mongoose from "mongoose";

const whatsappTrackJobRunSchema = new mongoose.Schema(
  {
    run_at: { type: Date, default: Date.now, index: true },
    ok: { type: Boolean, default: true },
    skipped: { type: Boolean, default: false },
    reason: { type: String, default: "" },
    groups_targeted: { type: Number, default: 0 },
    groups_fetched: { type: Number, default: 0 },
    added: { type: Number, default: 0 },
    groups: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  { collection: "whatsapp_track_job_runs" }
);

whatsappTrackJobRunSchema.index({ run_at: -1 });

export const WhatsappTrackJobRun =
  mongoose.models.WhatsappTrackJobRun ||
  mongoose.model("WhatsappTrackJobRun", whatsappTrackJobRunSchema);
