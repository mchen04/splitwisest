import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { handler, badRequest } from "@/lib/api";
import {
  hashPassword,
  matchingRecoveryCodeId,
  clearSession,
  createSession,
  setSessionCookie,
} from "@/lib/auth";
import { assertAuthRateLimit, clearAuthRateLimit } from "@/lib/rate-limit";

const Body = z.object({
  username: z.string().trim().min(1, "Username is required"),
  code: z.string().trim().min(1, "Recovery code is required"),
  newPassword: z.string().min(8, "Password must be at least 8 characters").max(200),
});

// Regain access with a one-time recovery code. Verifies the code, resets the
// password, consumes that single code, and logs the user in.
export const POST = handler(async (req: NextRequest) => {
  const { username, code, newPassword } = Body.parse(await req.json());
  await assertAuthRateLimit(req, "recover", username);
  const users = await sql`SELECT id FROM users WHERE lower(username) = lower(${username})`;
  const userId = users.length > 0 ? Number(users[0].id) : null;

  const codes = userId ? await sql`
    SELECT id, code_hash FROM recovery_codes
    WHERE user_id = ${userId} AND used_at IS NULL`
    : [];
  const matchId = matchingRecoveryCodeId(
    code,
    codes.map((c) => ({ id: Number(c.id), codeHash: c.code_hash })),
  );
  if (!userId || !matchId) badRequest("Invalid username or recovery code");

  const passwordHash = hashPassword(newPassword);
  const reset = await sql`
    WITH consumed AS (
      UPDATE recovery_codes SET used_at = now()
      WHERE id = ${matchId} AND user_id = ${userId} AND used_at IS NULL
      RETURNING user_id
    ),
    reset_user AS (
      UPDATE users SET password_hash = ${passwordHash}
      WHERE id = (SELECT user_id FROM consumed)
      RETURNING id
    ),
    deleted_sessions AS (
      DELETE FROM sessions WHERE user_id = (SELECT id FROM reset_user)
    )
    SELECT id FROM reset_user`;
  if (reset.length === 0) badRequest("Invalid username or recovery code");

  await clearAuthRateLimit("recover", username);
  await clearSession();
  const token = await createSession(userId);
  await setSessionCookie(token, userId);
  return NextResponse.json({ ok: true });
});
