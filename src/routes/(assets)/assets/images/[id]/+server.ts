import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import db from "$lib/server/db/db";

// Logos and favicons are stored as base64 TEXT, so serving one costs a query
// plus a decode. Image ids are content-addressed (`nanoid(16).ext`) and the
// images table is insert-and-delete only, never updated in place, so an id
// always denotes the same bytes. That is what makes both the immutable
// Cache-Control below and this memo safe.
//
// Bounded, because it holds decoded image bytes: a handful of entries covers a
// site's logo, favicon and monitor icons. The TTL is not about staleness, since
// the bytes cannot change, but about letting a deleted image fall out instead of
// being served from memory indefinitely.
const MEMO_MAX_ENTRIES = 32;
const MEMO_TTL_MS = 10 * 60_000;

interface MemoEntry {
  // Buffer.from() yields Buffer<ArrayBuffer>; the default Buffer<ArrayBufferLike>
  // is not a valid Response body, so keep the narrower type.
  buffer: Buffer<ArrayBuffer>;
  mimeType: string;
  expiresAt: number;
}

const memo = new Map<string, MemoEntry>();

function readMemo(id: string): MemoEntry | null {
  const entry = memo.get(id);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    memo.delete(id);
    return null;
  }
  // Refresh insertion order so the map's first key stays the coldest entry.
  memo.delete(id);
  memo.set(id, entry);
  return entry;
}

function writeMemo(id: string, entry: MemoEntry): void {
  memo.set(id, entry);
  while (memo.size > MEMO_MAX_ENTRIES) {
    const oldest = memo.keys().next();
    if (oldest.done) break;
    memo.delete(oldest.value);
  }
}

export const GET: RequestHandler = async ({ params, request }) => {
  const { id } = params;

  if (!id) {
    throw error(400, "Image ID is required");
  }

  // The id identifies the bytes, so it is a strong validator on its own. Answer
  // a revalidation without touching the database or the memo.
  const etag = `"${id}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }

  let entry = readMemo(id);

  if (!entry) {
    const image = await db.getImageById(id);

    if (!image) {
      throw error(404, "Image not found");
    }

    entry = {
      // Decode base64 data to binary
      buffer: Buffer.from(image.data, "base64"),
      mimeType: image.mime_type,
      expiresAt: Date.now() + MEMO_TTL_MS,
    };
    writeMemo(id, entry);
  }

  return new Response(entry.buffer, {
    status: 200,
    headers: {
      "Content-Type": entry.mimeType,
      "Content-Length": entry.buffer.length.toString(),
      "Cache-Control": "public, max-age=31536000, immutable", // Cache for 1 year
      ETag: etag,
    },
  });
};
