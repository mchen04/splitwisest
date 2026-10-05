import { after, NextResponse } from "next/server";
import { ZodError } from "zod";
import { AuthError } from "./auth";
import { DomainError } from "./errors";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Defense-in-depth CSRF guard. sameSite=lax already blocks the cookie on cross-site
// POST/PATCH/DELETE, but we don't want that to be the single line of defense. When a
// browser supplies an `Origin` on a state-changing request, require it to match the
// request host; a forged cross-site form/fetch carries a foreign Origin and is
// rejected. Header-less server-to-server clients (no Origin) are unaffected, so the
// API and the live smokes keep working.
function blockedCrossOrigin(req: unknown): boolean {
  if (!(req instanceof Request)) return false;
  if (SAFE_METHODS.has(req.method)) return false;
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const host = req.headers.get("host");
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

// Wrap a route handler with uniform auth/validation error handling.
export function handler<T extends unknown[]>(
  fn: (...args: T) => Promise<NextResponse | Response>
) {
  return async (...args: T): Promise<NextResponse | Response> => {
    try {
      if (blockedCrossOrigin(args[0])) {
        return NextResponse.json({ error: "Cross-origin request blocked" }, { status: 403 });
      }
      const response = await fn(...args);
      const req = args[0];
      if (response.ok && process.env.VAPID_PUBLIC_KEY && req instanceof Request &&
        !new URL(req.url).pathname.startsWith("/api/push/") &&
        (!SAFE_METHODS.has(req.method) || /^\/api\/groups\/\d+(?:\/expenses|\/version)?$/.test(new URL(req.url).pathname))) {
        after(async () => {
          try {
            const { deliverNotifications } = await import("./notification-delivery");
            await deliverNotifications();
          } catch { console.error("Notification delivery remains queued for retry"); }
        });
      }
      return response;
    } catch (e) {
      if (e instanceof AuthError) {
        return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
      }
      if (e instanceof ZodError) {
        return NextResponse.json(
          { error: e.issues.map((i) => i.message).join("; ") },
          { status: 400 }
        );
      }
      if (e instanceof SyntaxError && /JSON/i.test(e.message)) {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
      }
      if (e instanceof DomainError) {
        return NextResponse.json({ error: e.message }, { status: e.status });
      }
      // Log only the error name + message, never the raw error object: a Neon
      // driver error carries the failing SQL text and its bound params (which can
      // include password / recovery-code hashes), and we must not leak those into
      // server logs. Clients already get a generic message.
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      console.error("Unhandled route error:", detail);
      return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
    }
  };
}

export class ApiError extends DomainError {
  constructor(message: string, status = 400) {
    super(message, status);
  }
}

export function notFound(msg = "Not found"): never {
  throw new ApiError(msg, 404);
}

export function forbidden(msg = "Not allowed"): never {
  throw new ApiError(msg, 403);
}

export function badRequest(msg: string): never {
  throw new ApiError(msg, 400);
}

// Escape LIKE/ILIKE wildcards (% _ \) in a user search term so they match
// literally instead of acting as wildcards. Callers must pair the bound value
// with `ESCAPE '\'`. Returns null for absent/blank input so the filter is skipped.
export function likeEscape(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.replace(/[\\%_]/g, "\\$&");
}

// Parse an integer query param. Returns null for absent/blank/non-integer input so
// a malformed filter (e.g. ?categoryId=abc) is ignored instead of binding NaN into
// a ::bigint cast and surfacing as an opaque 500.
export function intParam(v: string | null): number | null {
  if (v === null) return null;
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isInteger(n) ? n : null;
}

// Parse a YYYY-MM-DD date query param. Returns null for absent/blank/malformed
// input so a bad filter (e.g. ?from=notadate) is ignored instead of binding an
// invalid value into a ::date cast and surfacing as an opaque 500. The value must
// be a real calendar date (round-trips through Date), so 2026-13-40 is rejected.
export function dateParam(v: string | null): string | null {
  if (v === null) return null;
  const t = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  const d = new Date(t + "T00:00:00Z");
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== t ? null : t;
}
