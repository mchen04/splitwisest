import { sql } from "@/lib/db";
import { AuthError, markSessionOwner, requireSessionToken, requireUser, type SessionUser } from "@/lib/auth";

type Query = ReturnType<typeof sql>;

export async function readSession(
  queries: (viewerId: Query) => Query[],
  checkAccessOnError?: (user: SessionUser) => Promise<unknown>,
) {
  const token = await requireSessionToken();
  const viewerId = sql`(SELECT s.user_id FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ${token} AND s.expires_at > now() AND u.deleted_at IS NULL)`;
  let result;
  try {
    result = await sql.transaction([
      sql`SELECT u.id, u.username, u.display_name, u.invite_code FROM users u WHERE u.id = ${viewerId}`,
      ...queries(viewerId),
    ], { isolationLevel: "RepeatableRead", readOnly: true });
  } catch (error) {
    const user = await requireUser();
    await checkAccessOnError?.(user);
    throw error;
  }
  const [users, ...rows] = result;
  if (!users[0]) throw new AuthError();
  const user: SessionUser = {
    id: Number(users[0].id),
    username: users[0].username,
    displayName: users[0].display_name,
    inviteCode: users[0].invite_code,
  };
  await markSessionOwner(user.id);
  return { user, rows };
}
