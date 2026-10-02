import { sql } from "./db";

export async function insertExpenseAttachment({
  expenseId,
  userId,
  filename,
  mime,
  data,
}: {
  expenseId: number;
  userId: number;
  filename: string;
  mime: string;
  data: Buffer;
}): Promise<number | null> {
  const [, rows] = await sql.transaction((tx) => [
    tx`SELECT pg_advisory_xact_lock(group_id::int) FROM expenses WHERE id = ${expenseId}`,
    tx`
    WITH accessible_expense AS (
      SELECT e.id, e.group_id
      FROM expenses e
      WHERE e.id = ${expenseId}
        AND EXISTS (
          SELECT 1 FROM group_members
          WHERE group_id = e.group_id AND user_id = ${userId}
        )
    ), inserted AS (
      INSERT INTO attachments (expense_id, filename, mime, data)
      SELECT id, ${filename}, ${mime}, ${data}
      FROM accessible_expense
      RETURNING id
    ), activity_row AS (
      INSERT INTO activity(group_id, actor_id, type, summary, data)
      SELECT e.group_id, ${userId}, 'expense.receipt_added', u.display_name || ' added a receipt',
        jsonb_build_object('expenseId', e.id, 'actionText', 'added a receipt')
      FROM accessible_expense e, inserted, users u WHERE u.id = ${userId}
      RETURNING id
    ) SELECT id FROM inserted`,
  ]);
  return rows[0] ? Number(rows[0].id) : null;
}

export async function deleteExpenseAttachment(
  attachmentId: number,
  userId: number
): Promise<"deleted" | "forbidden" | "not-found"> {
  const [, rows] = await sql.transaction((tx) => [
    tx`
    SELECT pg_advisory_xact_lock(e.group_id::int)
    FROM attachments a
    JOIN expenses e ON e.id = a.expense_id
    WHERE a.id = ${attachmentId}`,
    tx`
    WITH attachment_row AS (
      SELECT a.id, e.group_id, e.id AS expense_id
      FROM attachments a
      JOIN expenses e ON e.id = a.expense_id
      WHERE a.id = ${attachmentId}
    ),
    authorized AS (
      SELECT id
      FROM attachment_row
      WHERE EXISTS (
        SELECT 1 FROM group_members
        WHERE group_id = attachment_row.group_id AND user_id = ${userId}
      )
    ),
    deleted AS (
      DELETE FROM attachments a
      USING authorized
      WHERE a.id = authorized.id
      RETURNING a.id
    ), activity_row AS (
      INSERT INTO activity(group_id, actor_id, type, summary, data)
      SELECT ar.group_id, ${userId}, 'expense.receipt_removed', u.display_name || ' removed a receipt',
        jsonb_build_object('expenseId', ar.expense_id, 'actionText', 'removed a receipt')
      FROM attachment_row ar, deleted, users u WHERE u.id = ${userId}
      RETURNING id
    )
    SELECT
      EXISTS (SELECT 1 FROM attachment_row) AS existed,
      EXISTS (SELECT 1 FROM deleted) AS deleted`,
  ]);
  if (!rows[0]?.existed) return "not-found";
  return rows[0].deleted ? "deleted" : "forbidden";
}
