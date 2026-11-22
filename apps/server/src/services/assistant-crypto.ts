import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

/**
 * Seals members' provider API keys at rest: AES-256-GCM under a key derived from the server secret
 * (`BETTER_AUTH_SECRET`), like the kiosk PIN and attachment-link keys. Each value gets a fresh
 * 96-bit IV and is bound to its owner and provider (the "context"), so a ciphertext copied to
 * another row fails to open. Rotating the server secret makes stored keys unreadable; members then
 * enter them again. See docs/assistant.md.
 */

const VERSION = "v1";

export const deriveAssistantKeyKey = (secret: string) =>
  createHmac("sha256", secret).update("knotworking:assistant-key:v1").digest();

/** `v1.<iv>.<tag>.<ciphertext>`, each part base64url. */
export function sealSecret(key: Buffer, plaintext: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    body.toString("base64url"),
  ].join(".");
}

/** The plaintext, or `null` when the value is malformed, was sealed under another secret or context, or was altered. */
export function openSecret(key: Buffer, sealed: string, context: string): string | null {
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || body === undefined) return null;
  try {
    const authTag = Buffer.from(tag, "base64url");
    if (authTag.length !== 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"), {
      authTagLength: 16,
    });
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    return null;
  }
}

/** The last four characters of a key, for showing which one is saved. */
export const keyLast4 = (key: string) => key.slice(-4);

/** Replaces every occurrence of a secret in text (provider errors sometimes echo the key). */
export function redactSecret(text: string, secret: string | undefined): string {
  if (!secret || secret.length < 8) return text;
  return text.split(secret).join("[key]");
}
