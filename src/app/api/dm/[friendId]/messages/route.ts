import { privateHandler, privateJson } from "@/app/api/_lib/private-json";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handler, forbidden, notFound } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { insertDirectMessage, loadDirectMessages } from "@/lib/messages";
import { readSession } from "@/app/api/_lib/read-session";
import { sql } from "@/lib/db";

type Ctx = { params: Promise<{ friendId: string }> };

export const GET = privateHandler(async (req: NextRequest, { params }: Ctx) => {
  const friendId = Number((await params).friendId);
  if (!Number.isInteger(friendId)) {
    await requireUser();
    notFound();
  }
  const { user, rows: [friends] } = await readSession((userId) => [sql`
    SELECT 1 FROM friendships
    WHERE user_a = LEAST(${userId}, ${friendId}::bigint)
      AND user_b = GREATEST(${userId}, ${friendId}::bigint)`]);
  if (!friends.length) forbidden("You are not friends with this user");
  const a = Math.min(user.id, friendId);
  const b = Math.max(user.id, friendId);
  return privateJson(req, await loadDirectMessages(a, b, req.nextUrl.searchParams));
});

const Body = z.object({ body: z.string().trim().min(1, "Message is empty").max(4000) });

export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await requireUser();
  const friendId = Number((await params).friendId);
  if (!Number.isInteger(friendId)) notFound();
  const { body } = Body.parse(await req.json());
  const id = await insertDirectMessage(user.id, friendId, body);
  if (id === null) forbidden("You are not friends with this user");
  return NextResponse.json({ id });
});
