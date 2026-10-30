import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { handler, notFound, forbidden } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { readSession } from "@/app/api/_lib/read-session";
import { attachmentContentDisposition } from "@/lib/attachments";
import { deleteExpenseAttachment } from "@/lib/attachment-writes";

type Ctx = { params: Promise<{ id: string }> };

async function loadWithAccess(rawId: string) {
  const id = Number(rawId);
  if (!Number.isInteger(id)) {
    await requireUser();
    notFound();
  }
  const { rows: [rows] } = await readSession((userId) => [sql`
    SELECT a.id, a.filename, a.mime, CASE WHEN access.is_member THEN a.data END AS data,
      e.group_id, access.is_member
    FROM attachments a JOIN expenses e ON e.id = a.expense_id
    CROSS JOIN LATERAL (
      SELECT EXISTS (SELECT 1 FROM group_members gm
        WHERE gm.group_id = e.group_id AND gm.user_id = ${userId}) AS is_member
    ) access
    WHERE a.id = ${id}`]);
  if (rows.length === 0) notFound("Attachment not found");
  if (!rows[0].is_member) forbidden();
  return rows[0];
}

export const GET = handler(async (_req: NextRequest, { params }: Ctx) => {
  const a = await loadWithAccess((await params).id);
  // neon returns bytea as \x-prefixed hex string
  const raw = a.data as unknown;
  const buf =
    typeof raw === "string"
      ? Buffer.from(raw.startsWith("\\x") ? raw.slice(2) : raw, "hex")
      : Buffer.from(raw as Uint8Array);
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": a.mime,
      "Content-Disposition": attachmentContentDisposition(a.filename),
      "Cache-Control": "private, max-age=3600",
      // Receipts are served inline for in-app preview; stop the browser from
      // MIME-sniffing a mislabeled upload into executable HTML (stored-XSS guard).
      "X-Content-Type-Options": "nosniff",
    },
  });
});

export const DELETE = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await requireUser();
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const result = await deleteExpenseAttachment(id, user.id);
  if (result === "not-found") notFound("Attachment not found");
  if (result === "forbidden") forbidden();
  return NextResponse.json({ ok: true });
});
