import type http from "node:http";

/**
 * Who may use the map. Three ways in, none of which opens a port to the network:
 * - local: a browser on this Mac at http://127.0.0.1:<port> (or localhost);
 * - SSH tunnel: `ssh -L 8790:127.0.0.1:8790 mac` from another machine arrives on loopback looking exactly like local,
 *   with whatever local port the tunnel uses (`127.0.0.1:9000`). A loopback literal can't be a DNS-rebinding name, so any port is fine;
 * - remote: through `tailscale serve` (HTTPS on the tailnet name). Tailscale's proxy connects from loopback and
 *   adds `Tailscale-User-Login`; that header is only trusted on a loopback connection, with a *.ts.net host,
 *   and for a login listed in `remoteLogins`. Nothing listens on a non-loopback address.
 * `origin` is what a same-origin POST from that page carries, so the POST checks work the same both ways.
 */
export type Access = { ok: true; remote: boolean; origin: string; login?: string } | { ok: false; why: string };

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOCAL_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/;
const TS_HOST = /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net(:\d{1,5})?$/i;

export function checkAccess(req: Pick<http.IncomingMessage, "headers" | "socket">, port: number, remoteLogins: string[]): Access {
  const host = String(req.headers.host ?? "");
  if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) return { ok: false, why: "not loopback" };
  if (LOCAL_HOST.test(host)) return { ok: true, remote: false, origin: `http://${host}` };
  if (!TS_HOST.test(host)) return { ok: false, why: "bad host" };
  const login = String(req.headers["tailscale-user-login"] ?? "").toLowerCase();
  if (!login) return { ok: false, why: "no Tailscale login (use tailscale serve, not funnel)" };
  if (!remoteLogins.map((l) => l.toLowerCase()).includes(login)) return { ok: false, why: `${login} isn't in remoteLogins` };
  return { ok: true, remote: true, origin: `https://${host.replace(/:443$/, "")}`, login };
}

/** Same-origin check for POSTs: a request without Origin (curl, the dispatcher's shell) is allowed except where noted. */
export const sameOrigin = (req: Pick<http.IncomingMessage, "headers">, access: Extract<Access, { ok: true }>) =>
  !req.headers.origin || req.headers.origin === access.origin ||
  (!access.remote && req.headers.origin === access.origin.replace("127.0.0.1", "localhost"));
