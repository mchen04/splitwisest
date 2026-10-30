import { privateHandler, privateJson } from "@/app/api/_lib/private-json";
import { readSession } from "@/app/api/_lib/read-session";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { handler, badRequest } from "@/lib/api";
import { requireUser } from "@/lib/auth";

export const GET = privateHandler(async (req?: NextRequest) => {
  const { rows: [rows] } = await readSession((userId) => [sql`
    SELECT id, name, icon, owner_id FROM categories
    WHERE owner_id IS NULL OR owner_id = ${userId}
    ORDER BY owner_id NULLS FIRST, name`]);
  return privateJson(req, {
    categories: rows.map((c) => ({
      id: Number(c.id),
      name: c.name,
      icon: c.icon,
      custom: c.owner_id !== null,
    })),
  });
});

const Body = z.object({ name: z.string().trim().min(1, "Name is required").max(40) });

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error
    && ("code" in err ? (err as { code?: unknown }).code === "23505" : /duplicate key/i.test(err.message));
}

export const POST = handler(async (req: NextRequest) => {
  const user = await requireUser();
  const { name } = Body.parse(await req.json());
  try {
    const rows = await sql`
      INSERT INTO categories (name, icon, owner_id)
      SELECT ${name}, 'tag', ${user.id}
      WHERE NOT EXISTS (
        SELECT 1 FROM categories
        WHERE owner_id IS NULL AND lower(name) = lower(${name})
      )
      RETURNING id`;
    if (rows.length === 0) badRequest("A category with that name already exists");
    return NextResponse.json({ id: Number(rows[0].id), name, icon: "tag", custom: true });
  } catch (err) {
    if (isUniqueViolation(err)) badRequest("A category with that name already exists");
    throw err;
  }
});
