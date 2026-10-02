import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handler } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { sql } from "@/lib/db";
import { mapNotification } from "@/lib/notifications";

export const GET = handler(async (req: NextRequest) => {
  const user = await requireUser();
  const before = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional().parse(req.nextUrl.searchParams.get("before") ?? undefined);
  const unread = req.nextUrl.searchParams.get("unread") === "1";
  const [items, counts] = await sql.transaction((tx) => [
    tx`SELECT * FROM notifications n WHERE user_id = ${user.id} AND notification_visible(n)
      AND (${before ?? null}::bigint IS NULL OR id < ${before ?? null})
      AND (NOT ${unread} OR read_at IS NULL) ORDER BY id DESC LIMIT 51`,
    tx`SELECT count(*)::int AS unread FROM notifications n
      WHERE user_id = ${user.id} AND read_at IS NULL AND notification_visible(n)`,
  ]);
  return NextResponse.json({ notifications: items.slice(0, 50).map(mapNotification),
    unreadCount: counts[0].unread, nextBefore: items.length > 50 ? Number(items[49].id) : null },
    { headers: { "Cache-Control": "private, no-store" } });
});

const ReadBody = z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  throughId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(), read: z.boolean() })
  .refine((v) => Boolean(v.id) !== Boolean(v.throughId) && (!v.throughId || v.read), "Choose one notification or mark earlier notifications read");

export const PATCH = handler(async (req: NextRequest) => {
  const user = await requireUser();
  const body = ReadBody.parse(await req.json());
  await sql`UPDATE notifications n SET read_at = CASE WHEN ${body.read} THEN now() ELSE NULL END
    WHERE user_id = ${user.id} AND notification_visible(n)
      AND (id = ${body.id ?? null} OR (${body.throughId ?? null}::bigint IS NOT NULL AND id <= ${body.throughId ?? null}))`;
  return NextResponse.json({ ok: true });
});
