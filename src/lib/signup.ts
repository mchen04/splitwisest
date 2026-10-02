import { sql } from "./db";
import { newInviteCode } from "./auth";
import { activityData } from "./activity";
import { badRequest } from "./api";

export async function createSignupAccount({
  username,
  displayName,
  passwordHash,
  inviterId,
  joinGroupId,
}: {
  username: string;
  displayName: string;
  passwordHash: string;
  inviterId: number | null;
  joinGroupId: number | null;
}): Promise<number> {
  const inviteCode = newInviteCode();
  const joinedSummary = `${displayName} joined SplitWisest`;
  if (inviterId) {
    const rows = await sql`
      WITH RECURSIVE u AS (
        INSERT INTO users (username, display_name, password_hash, invite_code)
        VALUES (${username.toLowerCase()}, ${displayName}, ${passwordHash}, ${inviteCode})
        ON CONFLICT (username) DO NOTHING
        RETURNING id
      ),
      f AS (
        INSERT INTO friendships (user_a, user_b)
        SELECT LEAST(${inviterId}, u.id), GREATEST(${inviterId}, u.id) FROM u
        ON CONFLICT DO NOTHING
        RETURNING 1
      ),
      r AS (
        DELETE FROM friend_requests fr
        USING u
        WHERE (fr.from_id = ${inviterId} AND fr.to_id = u.id)
           OR (fr.from_id = u.id AND fr.to_id = ${inviterId})
        RETURNING 1
      ),
      a AS (
        INSERT INTO activity (group_id, actor_id, type, summary, data)
        SELECT null, u.id, 'user.joined', ${joinedSummary}, ${JSON.stringify({ actionText: "joined SplitWisest", visibleUserIds: [String(inviterId)] })}::jsonb
        FROM u
        RETURNING 1
      )
      SELECT id FROM u`;
    if (rows.length === 0) badRequest("That username is taken");
    return Number(rows[0].id);
  }

  if (joinGroupId) {
    const groupSummary = `${displayName} joined the group`;
    const [, rows] = await sql.transaction((tx) => [
      tx`SELECT pg_advisory_xact_lock(${joinGroupId}::int)`,
      tx`
      WITH RECURSIVE u AS (
        INSERT INTO users (username, display_name, password_hash, invite_code)
        SELECT ${username.toLowerCase()}, ${displayName}, ${passwordHash}, ${inviteCode}
        WHERE EXISTS (SELECT 1 FROM groups WHERE id = ${joinGroupId})
        ON CONFLICT (username) DO NOTHING
        RETURNING id
      ),
      group_state AS (
        SELECT EXISTS (SELECT 1 FROM groups WHERE id = ${joinGroupId}) AS group_exists
      ),
      existing_members AS MATERIALIZED (
        SELECT gm.user_id, row_number() OVER (ORDER BY gm.user_id) AS lock_order
        FROM group_members gm
        JOIN u ON true
        WHERE gm.group_id = ${joinGroupId} AND gm.user_id <> u.id
      ),
      pair_locks(lock_order, user_id, locked) AS (
        SELECT lock_order, user_id,
          pg_advisory_xact_lock(LEAST((SELECT id FROM u)::bigint, user_id)::int, GREATEST((SELECT id FROM u)::bigint, user_id)::int) AS locked
        FROM existing_members
        WHERE lock_order = 1
        UNION ALL
        SELECT em.lock_order, em.user_id,
          pg_advisory_xact_lock(LEAST((SELECT id FROM u)::bigint, em.user_id)::int, GREATEST((SELECT id FROM u)::bigint, em.user_id)::int) AS locked
        FROM pair_locks pl
        JOIN existing_members em ON em.lock_order = pl.lock_order + 1
      ),
      locked_members AS (
        SELECT count(*) FROM pair_locks
      ),
      gm AS (
        INSERT INTO group_members (group_id, user_id)
        SELECT ${joinGroupId}, u.id
        FROM u CROSS JOIN locked_members
        ON CONFLICT DO NOTHING
        RETURNING user_id
      ),
      f AS (
        INSERT INTO friendships (user_a, user_b)
        SELECT LEAST(u.id, em.user_id), GREATEST(u.id, em.user_id)
        FROM u CROSS JOIN existing_members em CROSS JOIN locked_members
        ON CONFLICT DO NOTHING
        RETURNING 1
      ),
      r AS (
        DELETE FROM friend_requests fr
        USING u, existing_members em, locked_members
        WHERE (fr.from_id = u.id AND fr.to_id = em.user_id)
           OR (fr.from_id = em.user_id AND fr.to_id = u.id)
        RETURNING 1
      ),
      ga AS (
        INSERT INTO activity (group_id, actor_id, type, summary, data)
        SELECT ${joinGroupId}, gm.user_id, 'group.joined', ${groupSummary},
          ${activityData({}, "joined the group")}::jsonb
        FROM gm
        RETURNING 1
      ),
      ua AS (
        INSERT INTO activity (group_id, actor_id, type, summary, data)
        SELECT null, u.id, 'user.joined', ${joinedSummary}, ${JSON.stringify({ actionText: "joined SplitWisest" })}::jsonb
        FROM u CROSS JOIN locked_members
        RETURNING 1
      )
      SELECT (SELECT id FROM u) AS id, (SELECT group_exists FROM group_state) AS group_exists`,
    ]);
    if (!rows[0]?.group_exists) badRequest("Invalid invite code");
    if (!rows[0]?.id) badRequest("That username is taken");
    return Number(rows[0].id);
  }

  const rows = await sql`
    WITH u AS (
      INSERT INTO users (username, display_name, password_hash, invite_code)
      VALUES (${username.toLowerCase()}, ${displayName}, ${passwordHash}, ${inviteCode})
      ON CONFLICT (username) DO NOTHING
      RETURNING id
    ),
    a AS (
      INSERT INTO activity (group_id, actor_id, type, summary, data)
      SELECT null, id, 'user.joined', ${joinedSummary}, ${JSON.stringify({ actionText: "joined SplitWisest" })}::jsonb
      FROM u
      RETURNING 1
    )
    SELECT id FROM u`;
  if (rows.length === 0) badRequest("That username is taken");
  return Number(rows[0].id);
}
