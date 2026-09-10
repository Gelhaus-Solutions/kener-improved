import { createWriteStream, createReadStream } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Where generated report files live (F4).
 *
 * **A small interface over the filesystem, so S3 can replace it without the
 * scheduler noticing.** Everything above this file deals in a `storage_key` and
 * never in a path, which is also why the key stored in `report_artifacts` is
 * relative: the root is an environment variable, and an absolute path in the
 * database would break the first time the volume moved.
 *
 * **Nothing here trusts a key from the outside.** `resolvePath` refuses any key
 * that escapes the root once normalised, so a `storage_key` that somehow came to
 * read `../../etc/passwd` yields an error rather than a file. The keys are all
 * generated here today, but the download path reads one out of the database and
 * hands it straight back, and that is exactly the shape that becomes a path
 * traversal the moment anything else can write the column.
 */

/** Default sits beside the SQLite database, so one volume covers both. */
const DEFAULT_ROOT = "./data/reports";

export function artifactRoot(): string {
  return path.resolve(process.env.KENER_REPORT_DIR || DEFAULT_ROOT);
}

/** A URL-safe, high-entropy download token. This is a bearer credential. */
export function generateDownloadToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The key for a new artifact.
 *
 * Sharded by org and by month so a long-lived instance does not end up with one
 * directory holding tens of thousands of entries, which some filesystems handle
 * poorly and every `ls` handles slowly.
 */
export function buildStorageKey(orgId: number, filename: string): string {
  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const unique = randomBytes(8).toString("hex");
  const safe = filename.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-100);
  return path.posix.join(String(orgId), month, `${unique}-${safe}`);
}

/** Resolves a key under the root, refusing anything that escapes it. */
export function resolvePath(storageKey: string): string {
  const root = artifactRoot();
  const resolved = path.resolve(root, storageKey);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new Error("Refusing a report storage key that escapes the artifact root");
  }
  return resolved;
}

/** Writes a whole buffer. Used by the PDF path, which is a bounded summary. */
export async function writeArtifact(storageKey: string, data: Buffer): Promise<number> {
  const target = resolvePath(storageKey);
  await mkdir(path.dirname(target), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(target);
    out.on("error", reject);
    out.on("finish", () => resolve());
    out.end(data);
  });
  return data.byteLength;
}

/**
 * Writes from a web `ReadableStream`, which is what the CSV export produces.
 *
 * Streamed to disk rather than buffered, for the same reason the HTTP response
 * is: a scheduled CSV over a year of history is the same hundreds of megabytes
 * whether a browser or a scheduler asked for it, and the scheduler runs in the
 * process that also does the monitoring.
 */
export async function writeArtifactStream(storageKey: string, stream: ReadableStream<Uint8Array>): Promise<number> {
  const target = resolvePath(storageKey);
  await mkdir(path.dirname(target), { recursive: true });

  const out = createWriteStream(target);
  const reader = stream.getReader();
  let bytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      // Honour the write stream's backpressure, or a fast database read fills
      // memory with pending writes and the streaming was for nothing.
      if (!out.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => out.once("drain", () => resolve()));
      }
    }
  } catch (error) {
    out.destroy();
    await unlink(target).catch(() => {});
    throw error;
  }

  await new Promise<void>((resolve, reject) => {
    out.on("error", reject);
    out.on("finish", () => resolve());
    out.end();
  });

  return bytes;
}

/** A read stream for the download endpoint, or null when the file is gone. */
export async function readArtifactStream(storageKey: string): Promise<NodeJS.ReadableStream | null> {
  const target = resolvePath(storageKey);
  try {
    await stat(target);
  } catch {
    // The row outliving its file is expected: a volume can be restored from a
    // backup that predates it, or a sweep can race a download. A missing file is
    // a 404, not a 500.
    return null;
  }
  return createReadStream(target);
}

/** Best-effort delete. A missing file is success, since the goal is absence. */
export async function deleteArtifact(storageKey: string): Promise<void> {
  try {
    await unlink(resolvePath(storageKey));
  } catch {
    /* already gone, or never written */
  }
}
