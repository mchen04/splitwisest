import { privateHandler, privateJson } from "@/app/api/_lib/private-json";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { handler, badRequest } from "@/lib/api";
import { requireUser } from "@/lib/auth";

export const GET = privateHandler(async (req?: NextRequest) => {
  const user = await requireUser();
  return privateJson(req, { user });
});

const PatchBody = z.object({
  displayName: z.string().trim().min(1, "Display name is required").max(50),
  username: z
    .string()
    .trim()
    .min(3, "Username must be at least 3 characters")
    .max(30, "Username must be at most 30 characters")
    .regex(/^[a-z0-9_]+$/i, "Username can only contain letters, numbers, and underscores"),
});

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error
    && ("code" in err ? (err as { code?: unknown }).code === "23505" : /duplicate key/i.test(err.message));
}

// Update the caller's display name and username (username uniqueness enforced).
export const PATCH = handler(async (req: NextRequest) => {
  const user = await requireUser();
  const { displayName, username } = PatchBody.parse(await req.json());
  const taken = await sql`
    SELECT 1 FROM users WHERE lower(username) = lower(${username}) AND id <> ${user.id}`;
  if (taken.length > 0) badRequest("That username is taken");
  try {
    await sql`
      UPDATE users SET display_name = ${displayName}, username = ${username.toLowerCase()}
      WHERE id = ${user.id}`;
  } catch (err) {
    if (isUniqueViolation(err)) badRequest("That username is taken");
    throw err;
  }
  return NextResponse.json({
    user: { ...user, displayName, username: username.toLowerCase() },
  });
});
