import { describe, expect, it } from "vitest";
import { deriveAssistantKeyKey, keyLast4, openSecret, redactSecret, sealSecret } from "./assistant-crypto";

describe("assistant key sealing", () => {
  const key = deriveAssistantKeyKey("a-server-secret-of-sufficient-length");
  const ctx = "user-1:claude";

  it("round-trips a key and never stores it in the clear", () => {
    const sealed = sealSecret(key, "sk-ant-secret-value-123", ctx);
    expect(sealed).not.toContain("sk-ant-secret-value-123");
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(openSecret(key, sealed, ctx)).toBe("sk-ant-secret-value-123");
  });

  it("uses a fresh IV, so the same key seals differently each time", () => {
    expect(sealSecret(key, "same", ctx)).not.toBe(sealSecret(key, "same", ctx));
  });

  it("refuses a different server secret, a different owner or provider, and tampering", () => {
    const sealed = sealSecret(key, "sk-ant-secret-value-123", ctx);
    expect(
      openSecret(deriveAssistantKeyKey("another-server-secret-of-sufficient-len"), sealed, ctx),
    ).toBeNull();
    expect(openSecret(key, sealed, "user-2:claude")).toBeNull();
    expect(openSecret(key, sealed, "user-1:openai")).toBeNull();
    const [v, iv, tag, body] = sealed.split(".");
    const flipped = `${v}.${iv}.${tag}.${body!.slice(0, -2)}${body!.endsWith("AA") ? "BB" : "AA"}`;
    expect(openSecret(key, flipped, ctx)).toBeNull();
    // A truncated auth tag is refused rather than accepted as a shorter check.
    expect(openSecret(key, `${v}.${iv}.${tag!.slice(0, 8)}.${body}`, ctx)).toBeNull();
    expect(openSecret(key, "garbage", ctx)).toBeNull();
    expect(openSecret(key, "v2.a.b.c", ctx)).toBeNull();
  });

  it("shows only the last four characters and redacts a key from text", () => {
    expect(keyLast4("sk-ant-secret-value-1234")).toBe("1234");
    expect(
      redactSecret(
        "bad key sk-ant-secret-value-1234 sent; sk-ant-secret-value-1234",
        "sk-ant-secret-value-1234",
      ),
    ).toBe("bad key [key] sent; [key]");
    expect(redactSecret("nothing to hide", undefined)).toBe("nothing to hide");
  });
});
