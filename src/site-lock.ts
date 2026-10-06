import { createHmac, timingSafeEqual } from "crypto";
import type { NextFunction, Request, Response } from "express";

const COOKIE_NAME = "poly_gate";
const COOKIE_PURPOSE = "poly-recorder-site-gate-v1";
const COOKIE_MAX_AGE_SEC = 30 * 24 * 60 * 60;
const MAX_FAILURES = 5;
const WINDOW_MS = 60_000;

const failuresByIp = new Map<string, number[]>();

function sitePassword(): string {
  return String(process.env.SITE_PASSWORD ?? "").trim();
}

export function isSiteLockEnabled(): boolean {
  return sitePassword().length > 0;
}

function gateToken(password: string): string {
  return createHmac("sha256", password).update(COOKIE_PURPOSE).digest("base64url");
}

function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function passwordMatches(input: string): boolean {
  const expected = sitePassword();
  if (!expected) return false;
  return tokensEqual(gateToken(input), gateToken(expected));
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function isSecureRequest(req: Request): boolean {
  const forwarded = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof proto === "string") return proto.split(",")[0].trim() === "https";
  return req.protocol === "https";
}

function hasValidGateCookie(req: Request): boolean {
  const expected = sitePassword();
  if (!expected) return false;
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies[COOKIE_NAME];
  if (!raw) return false;
  return tokensEqual(raw, gateToken(expected));
}

function wantsJson(req: Request): boolean {
  if (req.path === "/api/site-unlock") {
    return String(req.headers["content-type"] ?? "").includes("application/json");
  }
  if (req.path.startsWith("/api/")) return true;
  const accept = String(req.headers.accept ?? "");
  return accept.includes("application/json") && !accept.includes("text/html");
}

function clientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof raw === "string" && raw.trim()) {
    return raw.split(",")[0]?.trim() || "unknown";
  }
  return req.ip || req.socket.remoteAddress || "unknown";
}

function recentFailures(ip: string, now: number): number[] {
  const kept = (failuresByIp.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (kept.length) failuresByIp.set(ip, kept);
  else failuresByIp.delete(ip);
  return kept;
}

function isRateLimited(ip: string, now = Date.now()): boolean {
  return recentFailures(ip, now).length >= MAX_FAILURES;
}

function recordFailure(ip: string, now = Date.now()): void {
  const kept = recentFailures(ip, now);
  kept.push(now);
  failuresByIp.set(ip, kept);
}

function buildGateCookie(secure: boolean): string {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(gateToken(sitePassword()))}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${COOKIE_MAX_AGE_SEC}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function lockPage(error: string | null): string {
  const err = error ? `<p class="err">${escapeHtml(error)}</p>` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Poly Recorder</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0d1117;
      color: #e6edf3;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    form {
      width: min(320px, calc(100% - 32px));
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    input, button {
      height: 36px;
      border-radius: 6px;
      border: 1px solid #30363d;
      font: inherit;
    }
    input {
      padding: 0 10px;
      background: #161b22;
      color: #e6edf3;
    }
    button {
      background: #238636;
      border-color: #238636;
      color: #fff;
      cursor: pointer;
    }
    .err { color: #f85149; font-size: 13px; }
  </style>
</head>
<body>
  <form method="post" action="/api/site-unlock" autocomplete="current-password">
    ${err}
    <input type="password" name="password" placeholder="Password" autofocus required />
    <button type="submit">Enter</button>
  </form>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sendLocked(req: Request, res: Response, status: number, error: string | null): void {
  if (wantsJson(req)) {
    res.status(status).json({ error: error || "Site locked" });
    return;
  }
  res.status(status).type("html").send(lockPage(error));
}

function readUnlockPassword(req: Request): string {
  const body = req.body as { password?: unknown } | undefined;
  if (body && typeof body.password === "string") return body.password;
  return "";
}

function handleUnlock(req: Request, res: Response): void {
  const ip = clientIp(req);
  if (isRateLimited(ip)) {
    sendLocked(req, res, 429, "Too many tries. Wait a minute.");
    return;
  }
  const submitted = readUnlockPassword(req);
  if (!passwordMatches(submitted)) {
    recordFailure(ip);
    sendLocked(req, res, 401, "Wrong password.");
    return;
  }
  res.setHeader("Set-Cookie", buildGateCookie(isSecureRequest(req)));
  if (wantsJson(req) && String(req.headers["content-type"] ?? "").includes("application/json")) {
    res.json({ ok: true });
    return;
  }
  res.redirect(303, "/");
}

/** Browser gate. Recording continues either way. /api/health stays open for the deploy check. */
export function siteLockMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!isSiteLockEnabled()) {
    next();
    return;
  }
  if (req.method === "GET" && req.path === "/api/health") {
    next();
    return;
  }
  if (hasValidGateCookie(req)) {
    next();
    return;
  }
  if (req.method === "POST" && req.path === "/api/site-unlock") {
    handleUnlock(req, res);
    return;
  }
  sendLocked(req, res, 401, null);
}
