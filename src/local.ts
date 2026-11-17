import { loadConfig, type Config } from "./config.ts";

/**
 * The local model: a llama.cpp server on another machine (or this one) that `localModel.command` (e.g. claude-local)
 * points Claude Code at. Switchboard only asks whether it's up and which model it serves; it never starts or stops it
 * (that machine starts it itself, e.g. from its desktop session).
 */
export interface LocalStatus {
  configured: boolean;
  up: boolean;
  model?: string;
  /** The server's own chat page, to open in a browser. */
  chatUrl?: string;
  /** How to start it when it's down (shown as it is). */
  startHint?: string;
  error?: string;
}

export async function localStatus(config: Config = loadConfig()): Promise<LocalStatus> {
  const lm = config.localModel;
  if (!lm?.command || !lm.url) return { configured: false, up: false };
  const base = lm.url.replace(/\/+$/, "");
  const out: LocalStatus = { configured: true, up: false, chatUrl: base, startHint: lm.startHint || undefined };
  try {
    const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(3000) });
    // 401/403 = the server answers but has a password (llama-server --api-key): it's up, we just can't see the model name.
    if (res.status === 401 || res.status === 403) return { ...out, up: true };
    if (!res.ok) return { ...out, error: `HTTP ${res.status}` };
    const body: any = await res.json().catch(() => ({}));
    return { ...out, up: true, model: body?.data?.[0]?.id ?? body?.models?.[0]?.name };
  } catch (e: any) {
    return { ...out, error: e?.name === "TimeoutError" ? "no answer in 3 s" : String(e?.cause?.code ?? e?.message ?? e) };
  }
}
