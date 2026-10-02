import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { handler, badRequest } from "@/lib/api";
import { hashPassword, clearSession, createSession, setSessionCookie } from "@/lib/auth";
import { createSignupAccount } from "@/lib/signup";
import { assertAuthRateLimit, clearAuthRateLimit } from "@/lib/rate-limit";

const Body = z.object({
  username: z
    .string()
    .min(3, "Username must be at least 3 characters")
    .max(30, "Username must be at most 30 characters")
    .regex(/^[a-z0-9_]+$/i, "Username can only contain letters, numbers, and underscores"),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
  displayName: z.string().trim().min(1, "Display name is required").max(50),
  inviteCode: z.string().trim().optional().default(""),
});

export const POST = handler(async (req: NextRequest) => {
  const { username, password, displayName, inviteCode } = Body.parse(await req.json());
  await assertAuthRateLimit(req, "signup", username);

  // The invite code is optional. If provided it must be the app signup code,
  // a friend's personal code (creates the friendship), or a group's invite
  // code (joins that group and friends its members).
  let inviterId: number | null = null;
  let joinGroupId: number | null = null;
  if (inviteCode && inviteCode !== process.env.SIGNUP_CODE) {
    await assertAuthRateLimit(req, "invite", inviteCode);
    const inviter = await sql`SELECT id FROM users WHERE invite_code = ${inviteCode}`;
    if (inviter.length > 0) {
      inviterId = Number(inviter[0].id);
    } else {
      const group = await sql`SELECT id FROM groups WHERE invite_code = ${inviteCode}`;
      if (group.length === 0) badRequest("Invalid invite code");
      joinGroupId = Number(group[0].id);
    }
  }

  const existing = await sql`SELECT 1 FROM users WHERE lower(username) = lower(${username})`;
  if (existing.length > 0) badRequest("That username is taken");

  const userId = await createSignupAccount({
    username,
    displayName,
    passwordHash: hashPassword(password),
    inviterId,
    joinGroupId,
  });

  await clearSession();
  const token = await createSession(userId);
  await clearAuthRateLimit("signup", username);
  if (inviteCode && inviteCode !== process.env.SIGNUP_CODE) await clearAuthRateLimit("invite", inviteCode);
  await setSessionCookie(token, userId);
  return NextResponse.json({ ok: true });
});
