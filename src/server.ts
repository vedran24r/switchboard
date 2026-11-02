import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { checkAccess, sameOrigin } from "./access.ts";
import { endSession, listFolders, renameSession, startFromPage, takeOver, trustSession, waitingForTrust } from "./actions.ts";
import { sessionChanges, sessionDiff } from "./changes.ts";
import { loadConfig } from "./config.ts";
import { acceptTrust, dispatcherFeed, isDispatcher, pressKey, say, sayTo, sessionChat, sessionScreen, startDispatcher } from "./dispatcher.ts";
import { listSessions } from "./sessions.ts";
import { answerPicker } from "./picker.ts";
import { transcribe, warmUp } from "./voice.ts";
import { MAX_UPLOAD_BYTES, pruneUploads, saveUpload, uploadFile } from "./uploads.ts";

/**
 * The map: one page plus a small JSON API. It listens on loopback only; the phone reaches it through
 * `tailscale serve` (see access.ts for who's let in). Anything that types into the dispatcher also needs
 * a same-origin JSON request with an x-switchboard header, so another website open in the browser can't drive it.
 */

const PAGE = path.join(import.meta.dirname, "..", "web", "index.html");

/** "Look at these": recent `sb pulse` requests, kept two minutes so every open tab can animate them once. */
const PULSE_KINDS = ["needs-you", "continue", "info"];
let pulses: { id: string; at: number; names: string[]; kind: string }[] = [];

/**
 * Messages already typed (or being typed), by the page's message id, for 10 minutes. On a phone the response can be
 * lost after the text was typed; the page then retries with the same id, and this makes sure it's typed once.
 */
const typed = new Map<string, number>();
export async function typeOnce(id: unknown, type: () => Promise<void>): Promise<{ ok: true; duplicate?: true }> {
  const key = typeof id === "string" && /^[\w-]{6,64}$/.test(id) ? id : "";
  for (const [k, at] of typed) if (Date.now() - at > 600_000) typed.delete(k);
  if (key && typed.has(key)) return { ok: true, duplicate: true };
  if (key) typed.set(key, Date.now());
  try { await type(); } catch (error) { if (key) typed.delete(key); throw error; }
  return { ok: true };
}

function readRaw(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) return req.destroy(Object.assign(new Error("too large"), { status: 413 }));
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const raw = (await readRaw(req, 64_000)).toString("utf8");
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw Object.assign(new Error("bad JSON"), { status: 400 });
  }
}

export function serve(port = loadConfig().port) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      const access = checkAccess(req, port, loadConfig().remoteLogins);
      if (!access.ok) return json(403, { error: access.why });
      // Test mode only (npm test): the browser test page, its audio fixtures, and a place to post results.
      if (process.env.SWITCHBOARD_TEST === "1" && url.pathname.startsWith("/test/")) {
        const file = url.pathname.slice("/test/".length);
        if (!/^[\w.-]+$/.test(file)) return json(400, { error: "bad path" });
        if (req.method === "POST" && file === "results") {
          writeFileSync(process.env.SWITCHBOARD_TEST_RESULTS!, (await readRaw(req, 1_000_000)).toString("utf8"));
          return json(200, { ok: true });
        }
        const dir = file.endsWith(".b64") ? process.env.SWITCHBOARD_TEST_FIXTURES! : path.join(import.meta.dirname, "..", "test", "web");
        let body: Buffer;
        try { body = readFileSync(path.join(dir, file)); } catch { return json(404, { error: "not found" }); } // before the headers, or a missing file crashes the server
        res.writeHead(200, { "content-type": file.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain", "cache-control": "no-store" });
        return res.end(body);
      }
      if (req.method === "POST") {
        if (!sameOrigin(req, access) || req.headers["x-switchboard"] !== "1") return json(403, { error: "forbidden" });
        if (url.pathname === "/api/upload") {
          const file = saveUpload(await readRaw(req, MAX_UPLOAD_BYTES + 1), String(req.headers["content-type"] ?? ""));
          return json(200, { path: file, url: `/api/upload/${path.basename(file)}` });
        }
        if (url.pathname === "/api/transcribe") {
          // 10 minutes of 16 kHz mono 16-bit audio is ~19 MB.
          return json(200, { text: await transcribe(await readRaw(req, 25_000_000), url.searchParams.get("lang") ?? "auto") });
        }
        if (!String(req.headers["content-type"]).startsWith("application/json")) return json(403, { error: "forbidden" });
        const body = await readBody(req);
        if (url.pathname === "/api/pulse") {
          const names = Array.isArray(body.names) ? body.names.map(String).slice(0, 20) : [];
          const kind = PULSE_KINDS.includes(body.kind) ? body.kind : "info";
          const live = new Set(listSessions(loadConfig()).map((s) => s.name.toLowerCase()));
          const known = names.filter((n: string) => live.has(n.toLowerCase())), unknown = names.filter((n: string) => !live.has(n.toLowerCase()));
          if (known.length) pulses = [...pulses.filter((p) => Date.now() - p.at < 120_000), { id: `p${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: Date.now(), names: known, kind }].slice(-50);
          return json(200, { pulsed: known, unknown });
        }
        if (url.pathname === "/api/say") return json(200, await typeOnce(body.id, () => say(String(body.text ?? ""))));
        // Typing into a session (popup reply, quick replies) only from the map page in a browser: a command-line
        // client (curl, the dispatcher's shell) sends no Origin header, so it can't press these for Vedran.
        if (url.pathname === "/api/session/say" || url.pathname === "/api/session/key") {
          if (!req.headers.origin) return json(403, { error: "only from the map page" });
          if (url.pathname === "/api/session/key") return json(200, { ok: (await pressKey(String(body.sessionId ?? ""), String(body.key ?? "")), true) });
          return json(200, await typeOnce(body.id, () => sayTo(String(body.sessionId ?? ""), String(body.text ?? ""), undefined, { quick: !!body.quick })));
        }
        // Starting a session from "＋ New": only from the map page too (the dispatcher's shell has `sb spawn`).
        if (url.pathname === "/api/spawn") {
          if (!req.headers.origin) return json(403, { error: "only from the map page" });
          return json(200, await startFromPage(body));
        }
        // The question form: presses the keys in the session's real picker, checking its screen after each (picker.ts).
        if (url.pathname === "/api/session/answer") {
          if (!req.headers.origin) return json(403, { error: "only from the map page" });
          return json(200, await answerPicker(String(body.sessionId ?? ""), body.questions, body.answers));
        }
        // Session actions from the sheet (each refuses on its own: blocked folders, names other than sb-*/pk-*, …).
        if (url.pathname === "/api/session/trust") {
          if (!req.headers.origin) return json(403, { error: "only from the map page" });
          return json(200, trustSession(String(body.tmux ?? "")));
        }
        if (url.pathname === "/api/session/rename" || url.pathname === "/api/session/end" || url.pathname === "/api/session/takeover") {
          if (!req.headers.origin) return json(403, { error: "only from the map page" });
          const id = String(body.sessionId ?? "");
          if (url.pathname === "/api/session/rename") return json(200, await renameSession(id, body.name));
          if (url.pathname === "/api/session/end") return json(200, endSession(id));
          return json(200, takeOver(id));
        }
        if (url.pathname === "/api/dispatcher/start") return json(200, { message: await startDispatcher() });
        if (url.pathname === "/api/dispatcher/trust") return json(200, { ok: (acceptTrust(), true) });
        return json(404, { error: "not found" });
      }
      if (url.pathname.startsWith("/api/upload/")) {
        const file = uploadFile(decodeURIComponent(url.pathname.slice("/api/upload/".length)));
        if (!file) return json(404, { error: "not found" });
        const ext = path.extname(file).slice(1);
        res.writeHead(200, { "content-type": { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" }[ext] ?? "application/octet-stream", "cache-control": "private, max-age=86400" });
        return res.end(readFileSync(file));
      }
      // The read-only terminal view; refused for blocked folders (see sessionScreen).
      if (url.pathname === "/api/session/screen") return json(200, sessionScreen(url.searchParams.get("id") ?? ""));
      // The read-only Changes view (git status, one file's diff); refused for blocked folders before git runs.
      if (url.pathname === "/api/session/changes") return json(200, sessionChanges(url.searchParams.get("id") ?? ""));
      if (url.pathname === "/api/session/diff") return json(200, sessionDiff(url.searchParams.get("id") ?? "", url.searchParams.get("file") ?? ""));
      if (url.pathname === "/api/folders") return json(200, { folders: listFolders() });
      if (url.pathname === "/api/session") return json(200, sessionChat(url.searchParams.get("id") ?? ""));
      if (url.pathname === "/api/state") {
        const config = loadConfig();
        const sessions = listSessions(config);
        return json(200, {
          now: Date.now(),
          handoffTokens: config.handoffTokens,
          sessions: sessions.filter((s) => !isDispatcher(s)),
          trustWaits: waitingForTrust(config, sessions),
          dispatcher: dispatcherFeed(config),
          pulses: pulses.filter((p) => Date.now() - p.at < 120_000),
        });
      }
      // App icons: SVG for Chrome/Firefox tabs, PNGs for Safari, bookmarks and the home screen (/favicon.ico is the 32px PNG).
      const STATIC: Record<string, string> = { "/manifest.webmanifest": "application/manifest+json", "/icon.svg": "image/svg+xml",
        "/favicon.ico": "image/png", "/icon-32.png": "image/png", "/icon-180.png": "image/png", "/icon-192.png": "image/png", "/icon-512.png": "image/png" };
      if (STATIC[url.pathname]) {
        const file = path.join(import.meta.dirname, "..", "web", url.pathname === "/favicon.ico" ? "icon-32.png" : url.pathname.slice(1));
        res.writeHead(200, { "content-type": STATIC[url.pathname], "cache-control": "max-age=86400" });
        return res.end(readFileSync(file));
      }
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(readFileSync(PAGE));
      }
      json(404, { error: "not found" });
    } catch (error: any) {
      json(error.gone ? 410 : error.status ?? 500, { error: String(error?.message ?? error), ...(error.gone ? { gone: true } : {}), ...(error.blocked ? { blocked: true } : {}), ...(error.detail ? { detail: String(error.detail) } : {}) });
    }
  });
  server.listen(port, "127.0.0.1", () => console.log(`Switchboard: http://127.0.0.1:${port}`));
  warmUp();
  // Old attached images: on start, then every 6 hours.
  const prune = () => { try { pruneUploads(); } catch {} };
  prune(); setInterval(prune, 6 * 3_600_000).unref();
  return server;
}
