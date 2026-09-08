import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  seal,
  open,
  isSealed,
  sealIfPlain,
  openOrPlain,
  secretHint,
  safeEqual,
  resetSecretBoxKeys,
} from "./secretBox.js";

const ORIGINAL_KEY = process.env.KENER_SECRET_KEY;

describe("secretBox", () => {
  beforeEach(() => {
    process.env.KENER_SECRET_KEY = "test-key-for-secretbox";
    resetSecretBoxKeys();
  });

  afterAll(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.KENER_SECRET_KEY;
    else process.env.KENER_SECRET_KEY = ORIGINAL_KEY;
    resetSecretBoxKeys();
  });

  it("round trips", () => {
    const sealed = seal("hunter2", "purpose-a");
    expect(sealed).not.toContain("hunter2");
    expect(open(sealed, "purpose-a")).toBe("hunter2");
  });

  it("uses a fresh nonce, so the same plaintext never produces the same ciphertext", () => {
    expect(seal("same", "p")).not.toBe(seal("same", "p"));
  });

  it("keeps purposes separate, so a ciphertext moved between columns is useless", () => {
    const sealed = seal("hunter2", "webhook");
    expect(open(sealed, "oidc")).toBeNull();
  });

  it("detects tampering instead of decrypting to something else", () => {
    const sealed = seal("hunter2", "p");
    const parts = sealed.split(".");
    // Flip a byte of the ciphertext.
    const data = Buffer.from(parts[3], "base64url");
    data[0] ^= 0xff;
    parts[3] = data.toString("base64url");
    expect(open(parts.join("."), "p")).toBeNull();
  });

  it("cannot be opened after the master key changes", () => {
    const sealed = seal("hunter2", "p");
    process.env.KENER_SECRET_KEY = "a-different-key";
    resetSecretBoxKeys();
    expect(open(sealed, "p")).toBeNull();
  });

  it("recognises its own output and nothing else", () => {
    expect(isSealed(seal("x", "p"))).toBe(true);
    expect(isSealed("plaintext")).toBe(false);
    expect(isSealed("v1.a.b.c")).toBe(false);
    expect(isSealed("")).toBe(false);
    expect(isSealed(null)).toBe(false);
  });

  it("supports a mixed column during migration", () => {
    // The property that lets a plaintext value written before encryption existed
    // keep working until something rewrites it.
    expect(openOrPlain("legacy-plaintext", "p")).toBe("legacy-plaintext");
    const sealed = sealIfPlain("legacy-plaintext", "p");
    expect(isSealed(sealed)).toBe(true);
    expect(sealIfPlain(sealed, "p")).toBe(sealed);
    expect(openOrPlain(sealed, "p")).toBe("legacy-plaintext");
  });

  it("returns empty rather than ciphertext when a sealed value cannot be opened", () => {
    const sealed = seal("hunter2", "p");
    // Callers treat "" as unusable; leaking the ciphertext to a caller expecting
    // a secret would put it somewhere a plaintext secret goes.
    expect(openOrPlain(sealed, "other-purpose")).toBe("");
  });

  it("hints at a secret without describing it", () => {
    expect(secretHint("whsec_abcdefghijkl")).toBe("…ijkl");
    expect(secretHint("short")).toBe("…");
  });

  it("compares in constant time without throwing on a length mismatch", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});
