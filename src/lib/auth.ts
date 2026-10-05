import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { sql } from "./db";

const SESSION_COOKIE = "sw_session";
const CACHE_OWNER_COOKIE = "sw_cache_owner";
const SESSION_DAYS = 30;
const DUMMY_HASH = "scrypt:0123456789abcdef0123456789abcdef:" + "ab".repeat(64);
const RECOVERY_CODE_CHECKS = 8;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function verifyPasswordForLogin(password: string, stored: string | null | undefined): boolean {
  return verifyPassword(password, stored ?? DUMMY_HASH) && !!stored;
}

export function newToken(): string {
  return randomBytes(32).toString("hex");
}

// Recovery codes are human-typable and shown to the user exactly once. We store
// only their scrypt hash, so a DB leak can't reveal them. 64 bits of entropy
// (16 hex chars, grouped) keeps them infeasible to guess even though the recover
// endpoint is only throttled by the shared per-account auth rate limit.
export function newRecoveryCode(): string {
  const raw = randomBytes(8).toString("hex").toUpperCase(); // 16 hex chars = 64 bits
  return raw.replace(/(.{4})(?=.)/g, "$1-"); // XXXX-XXXX-XXXX-XXXX
}

export function hashRecoveryCode(code: string): string {
  return hashPassword(code.trim().toUpperCase());
}

export function verifyRecoveryCode(code: string, stored: string): boolean {
  return verifyPassword(code.trim().toUpperCase(), stored);
}

export function matchingRecoveryCodeId(
  code: string,
  candidates: { id: number; codeHash: string }[],
): number | null {
  let match: number | null = null;
  const checks = Math.max(RECOVERY_CODE_CHECKS, candidates.length);
  for (let i = 0; i < checks; i++) {
    const candidate = candidates[i];
    const matched = verifyRecoveryCode(code, candidate?.codeHash ?? DUMMY_HASH);
    if (matched && candidate && match === null) match = candidate.id;
  }
  return match;
}

export function newInviteCode(): string {
  return randomBytes(16).toString("hex");
}

export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  inviteCode: string;
}

export async function createSession(userId: number): Promise<string> {
  const token = newToken();
  await sql`INSERT INTO sessions (token, user_id, expires_at)
            VALUES (${token}, ${userId}, now() + ${SESSION_DAYS + " days"}::interval)`;
  return token;
}

export async function setSessionCookie(token: string, userId: number) {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_DAYS * 86400,
    path: "/",
  });
  // This non-secret owner key lets the browser reject another account's
  // persistent read cache before it paints cached private data.
  store.set(CACHE_OWNER_COOKIE, String(userId), {
    httpOnly: false,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_DAYS * 86400,
    path: "/",
  });
}

export async function clearSession() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await sql`DELETE FROM sessions WHERE token = ${token}`;
  store.delete(SESSION_COOKIE);
  store.delete(CACHE_OWNER_COOKIE);
}

export async function revokeOtherSessions(userId: number) {
  const store = await cookies();
  const keep = store.get(SESSION_COOKIE)?.value;
  if (keep) {
    await sql`DELETE FROM sessions WHERE user_id = ${userId} AND token <> ${keep}`;
  }
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const rows = await sql`
    SELECT u.id, u.username, u.display_name, u.invite_code
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ${token} AND s.expires_at > now() AND u.deleted_at IS NULL`;
  if (rows.length === 0) return null;
  const r = rows[0];
  await markSessionOwner(Number(r.id));
  return {
    id: Number(r.id),
    username: r.username,
    displayName: r.display_name,
    inviteCode: r.invite_code,
  };
}

// Polling routes fold the session check (same token, expiry, and deleted-user
// rules as getSessionUser) into their own statement. They read the token here,
// fail with 401 when it is missing, and call markSessionOwner on success.
export async function requireSessionToken(): Promise<string> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) throw new AuthError();
  return token;
}

export async function markSessionOwner(userId: number) {
  const store = await cookies();
  if (store.get(CACHE_OWNER_COOKIE)?.value !== String(userId)) {
    store.set(CACHE_OWNER_COOKIE, String(userId), {
      httpOnly: false,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: SESSION_DAYS * 86400,
      path: "/",
    });
  }
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new AuthError();
  return user;
}

export class AuthError extends Error {
  constructor() {
    super("Not authenticated");
  }
}
