import { randomFillSync } from "node:crypto";

// A minimal ULID.
//
// Why not a uuid: event ids are read in logs and in the delivery-log UI next to
// each other, and a v4 uuid sorts randomly, so two ids tell you nothing about
// which came first. A ULID's leading 48 bits are the timestamp, so lexical order
// is roughly chronological order and a human scanning a list gets that for free.
//
// Why not the `ulid` package: it is thirty lines, and this fork carries a
// package.json that has to survive an upstream merge on every sync. A dependency
// added here is a dependency to re-reconcile forever.
//
// Note that `event_outbox.id` remains the authoritative order. This is sortable
// enough to be useful, not precise enough to be trusted: two events emitted in
// the same millisecond by two processes can order either way.

// Crockford base32: no I, L, O or U, so an id read aloud or retyped cannot
// become a different valid id.
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = 0;
// The randomness of the last id issued in `lastTime`'s millisecond, kept so a
// second id in the same millisecond can increment it rather than re-randomise.
// Without this, ids generated inside one tight loop sort arbitrarily among
// themselves, which is the one case where sortability actually gets used.
let lastRandom: number[] = [];

function encodeTime(now: number): string {
  let out = "";
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = now % 32;
    out = ENCODING[mod] + out;
    now = (now - mod) / 32;
  }
  return out;
}

function randomChars(): number[] {
  const bytes = randomFillSync(new Uint8Array(RANDOM_LEN));
  // One byte per character, reduced to 5 bits. Wasteful of entropy and entirely
  // irrelevant: 80 bits of randomness per millisecond is far beyond what a
  // status page can collide.
  return Array.from(bytes, (b) => b % 32);
}

/** Increments the random half in place, carrying left. */
function incrementRandom(chars: number[]): number[] {
  for (let i = chars.length - 1; i >= 0; i--) {
    if (chars[i] < 31) {
      chars[i]++;
      return chars;
    }
    chars[i] = 0;
  }
  // All 80 bits rolled over inside one millisecond, which needs 2^80 ids. Start
  // fresh rather than pretend monotonicity we no longer have.
  return randomChars();
}

/** A new ULID: 26 Crockford base32 characters, monotonic within a millisecond. */
export function ulid(now: number = Date.now()): string {
  if (now === lastTime) {
    lastRandom = incrementRandom(lastRandom);
  } else {
    lastTime = now;
    lastRandom = randomChars();
  }
  return encodeTime(now) + lastRandom.map((c) => ENCODING[c]).join("");
}
