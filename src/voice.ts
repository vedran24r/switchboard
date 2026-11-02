import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { STATE_DIR, loadConfig } from "./config.ts";
import { listSessions } from "./sessions.ts";

/**
 * Speech to text on this Mac: whisper.cpp's server keeps the model loaded (Metal), so a clip takes
 * about a second. Any browser works, Firefox included: the page records WAV and posts it here.
 * Setup: brew install whisper-cpp, plus the model in ~/.switchboard/models (see README).
 */

const PORT = 8791;
const MODEL = process.env.SWITCHBOARD_WHISPER_MODEL ?? path.join(STATE_DIR, "models", "ggml-large-v3-turbo-q5_0.bin");
const BIN = ["/opt/homebrew/bin/whisper-server", "/usr/local/bin/whisper-server"].find(existsSync) ?? "whisper-server";

let starting: Promise<void> | undefined;

const up = () => fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(800) }).then(() => true, () => false);

async function ensureServer() {
  if (await up()) return;
  if (!existsSync(MODEL)) throw new Error(`Whisper model missing: ${MODEL}. See README → Voice.`);
  starting ??= (async () => {
    const child = spawn(BIN, ["-m", MODEL, "--host", "127.0.0.1", "--port", String(PORT), "-l", "auto"], { stdio: "ignore" });
    child.on("exit", () => (starting = undefined));
    for (let i = 0; i < 60; i++) {
      if (await up()) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("whisper-server didn't start");
  })().catch((error) => {
    starting = undefined;
    throw error;
  });
  await starting;
}

/** Start loading the model early (when the map starts), so the first clip isn't slow. */
export const warmUp = () => void ensureServer().catch(() => {});

/** Vedran speaks English or Bosnian (BCMS: Bosnian / Croatian / Serbian, one language). Nothing else, ever. */
const OURS = new Set(["en", "bs", "hr", "sr"]);
const CODES: Record<string, string> = { english: "en", bosnian: "bs", croatian: "hr", serbian: "sr" };
const CYRILLIC = /[\u0400-\u04FF]/;

/**
 * After an "auto" pass: which language to force on a second pass, or undefined to keep it.
 * Re-run when Whisper picked a language outside ours (Russian, Bulgarian, …) or wrote Cyrillic; force
 * Bosnian when BCMS is likelier than English by Whisper's own probabilities, else English.
 */
export function rerunLanguage(detected: string, probs: Record<string, number>, text: string): "en" | "bs" | undefined {
  const code = CODES[detected] ?? detected;
  if (OURS.has(code) && !CYRILLIC.test(text)) return;
  const bcms = (probs.bs ?? 0) + (probs.hr ?? 0) + (probs.sr ?? 0);
  return bcms > (probs.en ?? 0) ? "bs" : "en";
}

// Serbian Cyrillic → Latin (exact for BCMS), plus the Russian/Bulgarian letters Serbian doesn't have.
const LATIN: Record<string, string> = Object.fromEntries([..."абвгдђежзијклљмнњопрстћуфхцчџш"].map((c, i) =>
  [c, ["a","b","v","g","d","đ","e","ž","z","i","j","k","l","lj","m","n","nj","o","p","r","s","t","ć","u","f","h","c","č","dž","š"][i]]));
Object.assign(LATIN, { й: "j", ы: "i", э: "e", ю: "ju", я: "ja", ё: "jo", щ: "šč", ъ: "", ь: "", є: "je", і: "i", ї: "ji", ґ: "g" });

/** Last resort: any Cyrillic left is written in Latin letters (Bosnian Whisper wrote in Cyrillic reads right). */
export function toLatin(text: string): string {
  return text.replace(/[\u0400-\u04FF]/g, (c) => {
    const lower = c.toLowerCase(), l = LATIN[lower] ?? "";
    return c === lower ? l : l.charAt(0).toUpperCase() + l.slice(1);
  });
}

/** Your corrections map (heard → meant), whole words, any case. */
export function applyCorrections(text: string, corrections: Record<string, string> = {}): string {
  const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Longest first, so "bend joe smith" wins over "bend joe".
  for (const heard of Object.keys(corrections).sort((a, b) => b.length - a.length)) {
    if (!heard.trim()) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${esc(heard.trim()).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`, "giu");
    text = text.replace(re, () => corrections[heard]);
  }
  return text;
}

async function infer(wav: Buffer, language: string, prompt: string) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "clip.wav");
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");
  form.append("language", language);
  form.append("prompt", prompt);
  const res = await fetch(`http://127.0.0.1:${PORT}/inference`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`Whisper: ${data.error ?? res.status}`);
  return { text: String(data.text ?? ""), language: String(data.language ?? ""), probs: (data.language_probabilities ?? {}) as Record<string, number> };
}

export async function transcribe(wav: Buffer, language: string): Promise<string> {
  await ensureServer();
  // Words Whisper would otherwise mishear: your vocabulary (config) plus the live session names.
  const config = loadConfig();
  const names = listSessions(config).map((s) => s.name).join(", ");
  const prompt = `${config.vocabulary}, ${names}.`;
  const forced = ["en", "bs"].includes(language) ? language : undefined;
  let result = await infer(wav, forced ?? "auto", prompt);
  const again = forced ? undefined : rerunLanguage(result.language, result.probs, result.text);
  if (again) {
    result = await infer(wav, again, prompt);
    // With a prompt Whisper can keep writing Cyrillic even when told the language; without one it complies.
    if (CYRILLIC.test(result.text)) result = await infer(wav, again, "");
  }
  // Whisper marks silence as "[BLANK_AUDIO]" or similar.
  const text = result.text.replace(/\[[A-Z_ ]+\]|\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
  return applyCorrections(toLatin(text), config.corrections);
}
