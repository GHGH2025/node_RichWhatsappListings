import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";
import path from "path";

const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const S3_BUCKET = (process.env.LISTINGS_S3_BUCKET || "").trim();
const S3_PREFIX = (process.env.LISTINGS_S3_PREFIX || "images/whatsapp/").replace(
  /^\/+|\/+$/g,
  ""
);

let client;

function getClient() {
  if (!client) {
    client = new S3Client({ region: AWS_REGION });
  }
  return client;
}

function extFromMime(mimetype = "") {
  const map = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
  };
  return map[String(mimetype).toLowerCase()] || ".jpg";
}

/**
 * Upload a buffer to S3 and return a public HTTPS URL.
 * Returns null if S3 is not configured or upload fails.
 */
export async function uploadBufferToS3(buffer, { mimetype = "image/jpeg", ext } = {}) {
  if (!S3_BUCKET) {
    console.warn("⚠️ LISTINGS_S3_BUCKET not set; skipping WhatsApp media upload");
    return null;
  }
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    return null;
  }

  const suffix = ext || extFromMime(mimetype);
  const key = path.posix.join(S3_PREFIX, `${randomUUID()}${suffix}`);

  await getClient().send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimetype || "image/jpeg",
    })
  );

  return `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${key}`;
}
