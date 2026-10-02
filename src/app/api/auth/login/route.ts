import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { handler, badRequest } from "@/lib/api";
import { verifyPasswordForLogin, clearSession, createSession, setSessionCookie } from "@/lib/auth";
import { assertAuthRateLimit, clearAuthRateLimit } from "@/lib/rate-limit";

const Body = z.object({
  username: z.string().trim().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

export const POST = handler(async (req: NextRequest) => {
  const { username, password } = Body.parse(await req.json());
  await assertAuthRateLimit(req, "login", username);
  const rows = await sql`SELECT id, password_hash FROM users WHERE lower(username) = lower(${username})`;
  const ok = verifyPasswordForLogin(password, rows[0]?.password_hash);
  if (!ok) badRequest("Incorrect username or password");
  await clearAuthRateLimit("login", username);
  await clearSession();
  const token = await createSession(Number(rows[0].id));
  await setSessionCookie(token, Number(rows[0].id));
  return NextResponse.json({ ok: true });
});
