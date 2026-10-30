import { sql } from "../src/lib/db";

export type Json = Record<string, unknown>;

export { sql };
export const baseUrl = process.env.SPLITWISEST_BASE_URL ?? "http://localhost:3000";

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertNoSecretText(value: unknown, label: string) {
  const text = JSON.stringify(value);
  for (const secret of ["invite_code", "password", "password_hash", "recovery", "recovery_codes", "sessions", "sw_session"]) {
    assert(!text.includes(secret), `${label} leaked ${secret}`);
  }
}

export function jsonObject(value: unknown, label: string): Json {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as Json;
}

export function jsonArray(value: unknown, label: string): unknown[] {
  assert(Array.isArray(value), `${label} must be an array`);
  return value;
}

export function jsonNumber(value: unknown, label: string): number {
  const n = Number(value);
  assert(Number.isFinite(n), `${label} must be numeric`);
  return n;
}

export function jsonString(value: unknown, label: string): string {
  assert(typeof value === "string", `${label} must be a string`);
  return value;
}

export async function request(path: string, opts: { cookie?: string; method?: string; body?: unknown; form?: FormData } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: opts.method ?? (opts.body || opts.form ? "POST" : "GET"),
    headers: {
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.body ? { "content-type": "application/json" } : {}),
    },
    body: opts.form ?? (opts.body ? JSON.stringify(opts.body) : undefined),
  });
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text().catch(() => "");
  const json = contentType.includes("json") ? JSON.parse(text || "{}") : {};
  return { res, json: json as Json, text };
}

export async function signup(role: string, suffix: string, password: string, prefix = "qa") {
  const label = prefix === "core" ? "Core" : "QA";
  const username = `${prefix}_${role}_${suffix}`;
  const displayName = `${label} ${role} ${suffix}`;
  const res = await fetch(`${baseUrl}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password, displayName }),
  });
  assert(res.ok, `signup failed for ${role}: ${res.status} ${await res.text()}`);
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  assert(cookie, `signup did not set cookie for ${role}`);
  const me = await request("/api/me", { cookie });
  assert(me.res.ok, `me failed for ${role}`);
  const user = jsonObject(me.json.user, "me.user");
  return {
    id: Number(user.id),
    username,
    displayName,
    inviteCode: String(user.inviteCode),
    cookie,
  };
}

export async function login(username: string, password: string) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return {
    res,
    text: await res.text(),
    cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "",
  };
}

export async function cleanupQaUsers(suffix: string, prefix = "qa") {
  const escapedSuffix = suffix.replace(/[\\_%]/g, "\\$&");
  const users = await sql`SELECT id FROM users WHERE username LIKE ${`${prefix}\\_%\\_${escapedSuffix}`} ESCAPE '\\'`;
  await sql`CREATE TABLE IF NOT EXISTS auth_rate_limits (
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    PRIMARY KEY (scope, key)
  )`;
  await sql`DELETE FROM auth_rate_limits WHERE key LIKE ${`${prefix}\\_%\\_${escapedSuffix}`} ESCAPE '\\'`;
  const userIds = users.map((u) => Number(u.id));
  if (userIds.length === 0) return;
  const groupNamePrefix = prefix === "core" ? "Core Flow " : "QA ";
  const groups = await sql`
    SELECT id FROM groups
    WHERE created_by = ANY(${userIds}) AND name LIKE ${`${groupNamePrefix}%${escapedSuffix}`} ESCAPE '\\'`;
  const groupIds = groups.map((g) => Number(g.id));
  if (groupIds.length > 0) await sql`DELETE FROM groups WHERE id = ANY(${groupIds})`;
  await sql`DELETE FROM group_members WHERE user_id = ANY(${userIds})`;
  await sql`DELETE FROM activity WHERE actor_id = ANY(${userIds})`;
  await sql`DELETE FROM messages WHERE sender_id = ANY(${userIds}) OR dm_a = ANY(${userIds}) OR dm_b = ANY(${userIds})`;
  await sql`DELETE FROM settlements WHERE payer_id = ANY(${userIds}) OR recipient_id = ANY(${userIds}) OR created_by = ANY(${userIds})`;
  await sql`DELETE FROM nudges WHERE from_id = ANY(${userIds}) OR to_id = ANY(${userIds})`;
  await sql`DELETE FROM friend_requests WHERE from_id = ANY(${userIds}) OR to_id = ANY(${userIds})`;
  await sql`DELETE FROM friendships WHERE user_a = ANY(${userIds}) OR user_b = ANY(${userIds})`;
  await sql`DELETE FROM recovery_codes WHERE user_id = ANY(${userIds})`;
  await sql`DELETE FROM users WHERE id = ANY(${userIds})`;
}
