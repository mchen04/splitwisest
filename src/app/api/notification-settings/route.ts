import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handler } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { sql } from "@/lib/db";
import { notificationSettings } from "@/lib/notifications";
import { NOTIFICATION_CATEGORIES } from "@/lib/notification-types";

export const GET = handler(async () => NextResponse.json(await notificationSettings((await requireUser()).id),
  { headers: { "Cache-Control": "private, no-store" } }));

const Body = z.object({ pushEnabled: z.boolean().optional(),
  categories: z.partialRecord(z.enum(Object.keys(NOTIFICATION_CATEGORIES) as [keyof typeof NOTIFICATION_CATEGORIES, ...Array<keyof typeof NOTIFICATION_CATEGORIES>]), z.boolean()).optional(),
}).strict();

export const PATCH = handler(async (req: NextRequest) => {
  const user = await requireUser();
  const body = Body.parse(await req.json());
  await sql`INSERT INTO notification_preferences(user_id, push_enabled, categories)
    VALUES (${user.id}, ${body.pushEnabled ?? true}, ${JSON.stringify(body.categories ?? {})}::jsonb)
    ON CONFLICT(user_id) DO UPDATE SET
      push_enabled = COALESCE(${body.pushEnabled ?? null}::boolean, notification_preferences.push_enabled),
      categories = notification_preferences.categories || ${JSON.stringify(body.categories ?? {})}::jsonb,
      updated_at = now()`;
  return NextResponse.json(await notificationSettings(user.id));
});
