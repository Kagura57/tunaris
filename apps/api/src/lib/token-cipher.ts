import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const CIPHER_PREFIX = "enc:v1:";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const FALLBACK_SECRET = "tunaris-dev-secret-change-this-in-production-1234";

function deriveKey() {
  const explicitCipherSecret = process.env.MUSIC_TOKEN_ENCRYPTION_KEY?.trim() ?? "";
  const authSecret = process.env.BETTER_AUTH_SECRET?.trim() ?? "";
  const secret = explicitCipherSecret || authSecret || FALLBACK_SECRET;
  return createHash("sha256").update(secret).digest();
}

export function encryptToken(plain: string) {
  const trimmed = plain.trim();
  if (trimmed.length <= 0) return "";
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(), iv);
  const encrypted = Buffer.concat([cipher.update(trimmed, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${CIPHER_PREFIX}${iv.toString("base64url")}.${authTag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptToken(value: string | null | undefined) {
  if (!value) return null;
  const raw = value.trim();
  if (raw.length <= 0) return null;
  if (!raw.startsWith(CIPHER_PREFIX)) return raw;
  const payload = raw.slice(CIPHER_PREFIX.length);
  const [ivPart, authTagPart, encryptedPart] = payload.split(".");
  if (!ivPart || !authTagPart || !encryptedPart) return null;

  try {
    const iv = Buffer.from(ivPart, "base64url");
    const authTag = Buffer.from(authTagPart, "base64url");
    const encrypted = Buffer.from(encryptedPart, "base64url");
    if (iv.byteLength !== IV_BYTES || authTag.byteLength !== AUTH_TAG_BYTES) {
      return null;
    }
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(), iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    const trimmed = decrypted.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
