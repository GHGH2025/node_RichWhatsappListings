import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { initAuthCreds, BufferJSON, proto } from "@whiskeysockets/baileys";

const AUTH_COLLECTION = "whatsapp_baileys_auth";
const MIGRATED_MARKER = ".migrated-to-mongo";

function authCol() {
  return mongoose.connection.collection(AUTH_COLLECTION);
}

function authDocId(name) {
  return String(name || "")
    .replace(/\.json$/i, "")
    .replace(/\//g, "__")
    .replace(/:/g, "-");
}

function serialize(data) {
  return JSON.parse(JSON.stringify(data, BufferJSON.replacer));
}

function deserialize(data) {
  if (data == null) return null;
  return JSON.parse(JSON.stringify(data), BufferJSON.reviver);
}

async function migrateFromFiles(authDir) {
  const marker = path.join(authDir, MIGRATED_MARKER);
  if (fs.existsSync(marker)) return;

  const col = authCol();
  const existing = await col.findOne({ _id: "creds" });
  if (existing) {
    fs.writeFileSync(marker, new Date().toISOString());
    return;
  }
  if (!fs.existsSync(authDir)) return;

  const files = fs.readdirSync(authDir).filter((f) => f.endsWith(".json"));
  if (!files.length) return;

  const ops = [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(authDir, file), "utf8");
    const parsed = JSON.parse(raw, BufferJSON.reviver);
    ops.push({
      updateOne: {
        filter: { _id: authDocId(file) },
        update: { $set: { data: serialize(parsed) } },
        upsert: true,
      },
    });
  }
  if (ops.length) {
    await col.bulkWrite(ops, { ordered: false });
    console.log(`🔑 Migrated ${ops.length} Baileys auth file(s) → Mongo`);
  }
  fs.writeFileSync(marker, new Date().toISOString());
}

export async function clearMongoAuthState() {
  try {
    const result = await authCol().deleteMany({});
    console.log(`🧹 Cleared Baileys Mongo auth (${result.deletedCount || 0} docs)`);
  } catch (err) {
    console.error("❌ Failed to clear Baileys Mongo auth:", err.message || err);
  }
}

/**
 * Mongo-backed Baileys auth. Same shape as useMultiFileAuthState.
 * Migrates ./auth/*.json once if Mongo has no creds yet.
 */
export async function useMongoAuthState(authDir = "./auth") {
  fs.mkdirSync(authDir, { recursive: true });
  await migrateFromFiles(authDir);

  const col = authCol();
  const credsDoc = await col.findOne({ _id: "creds" });
  const creds = credsDoc?.data ? deserialize(credsDoc.data) : initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          const docIds = ids.map((id) => authDocId(`${type}-${id}`));
          const docs = await col.find({ _id: { $in: docIds } }).toArray();
          const byId = new Map(docs.map((d) => [String(d._id), d.data]));
          for (const id of ids) {
            let value = deserialize(byId.get(authDocId(`${type}-${id}`)));
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.create(value);
            }
            data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          const ops = [];
          for (const category of Object.keys(data || {})) {
            for (const id of Object.keys(data[category] || {})) {
              const value = data[category][id];
              const _id = authDocId(`${category}-${id}`);
              if (value) {
                ops.push({
                  updateOne: {
                    filter: { _id },
                    update: { $set: { data: serialize(value) } },
                    upsert: true,
                  },
                });
              } else {
                ops.push({ deleteOne: { filter: { _id } } });
              }
            }
          }
          if (ops.length) await col.bulkWrite(ops, { ordered: false });
        },
      },
    },
    saveCreds: async () => {
      await col.updateOne(
        { _id: "creds" },
        { $set: { data: serialize(creds) } },
        { upsert: true }
      );
    },
  };
}
