import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expand, loadConfig, type Config } from "./config.ts";

/**
 * Images (screenshots) attached in the map. Saved next to Pocket's uploads (~/.pocket-sessions/uploads,
 * already an extra working folder for Pocket-started sessions), in a "switchboard" subfolder; the message
 * carries "[image: /absolute/path]" and Claude reads the file with its Read tool.
 * Only files named switchboard-*.{png,jpg,webp,gif} are ever served or cleaned up.
 */

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const FILE_RE = /^switchboard-[\w-]+\.(png|jpg|webp|gif)$/;

export const uploadDir = (config: Config = loadConfig()) => path.join(expand(config.uploadsDir), "switchboard");

export function saveUpload(data: Buffer, contentType: string, config: Config = loadConfig()): string {
  const ext = TYPES[contentType.split(";")[0].trim()];
  if (!ext) throw Object.assign(new Error("Only PNG, JPEG, WebP and GIF images can be attached"), { status: 415 });
  if (!data.length) throw Object.assign(new Error("Empty image"), { status: 400 });
  if (data.length > MAX_UPLOAD_BYTES) throw Object.assign(new Error("Image is over 20 MB"), { status: 413 });
  const dir = uploadDir(config);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const file = path.join(dir, `switchboard-${stamp}-${randomBytes(3).toString("hex")}.${ext}`);
  writeFileSync(file, data, { mode: 0o600 });
  return file;
}

/** The file behind /api/upload/<name>, or undefined for anything that isn't one of ours. */
export function uploadFile(name: string, config: Config = loadConfig()): string | undefined {
  return FILE_RE.test(name) ? path.join(uploadDir(config), name) : undefined;
}

/** Delete our own uploads older than uploadKeepDays (0 = keep forever). Never touches other files. */
export function pruneUploads(config: Config = loadConfig(), now = Date.now()): string[] {
  if (!(config.uploadKeepDays > 0)) return [];
  const cutoff = now - config.uploadKeepDays * 86_400_000, removed: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(uploadDir(config)); } catch { return removed; }
  for (const name of names) {
    if (!FILE_RE.test(name)) continue;
    const file = path.join(uploadDir(config), name);
    try {
      if (statSync(file).mtimeMs < cutoff) { rmSync(file); removed.push(name); }
    } catch {}
  }
  return removed;
}
