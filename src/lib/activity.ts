import { Change, feedLine } from "./activity-diff";

export function activityData(data: Record<string, unknown> = {}, actionText?: string): string {
  return JSON.stringify(actionText ? { ...data, actionText } : data);
}

/** Structured field changes, when the row was written by a build that records them.
 *  Rows from before that keep rendering from their stored summary. */
export function activityChanges(data: unknown): Change[] {
  if (!data || typeof data !== "object") return [];
  const raw = (data as Record<string, unknown>).changes;
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is Change => Boolean(c) && typeof c === "object" && "field" in c);
}

export function activityActionText(row: { summary: string; actorName: string; data?: unknown }): string {
  const data = row.data && typeof row.data === "object" ? row.data as Record<string, unknown> : {};
  const line = feedLine(activityChanges(data));
  if (line) return line;
  if (typeof data.actionText === "string") return data.actionText;
  return row.summary.startsWith(row.actorName) ? row.summary.slice(row.actorName.length).trimStart() : row.summary;
}

/** The words after the linked actor name in a feed line. A recorded payment's
 *  text is already a whole sentence naming the payer ("Diego paid Maya $120"), so
 *  the actor is named once: as the payer when they recorded it, otherwise as the
 *  person who recorded it. */
export function activityAfterActor(row: { actorName: string; actionText: string; type?: string }): string {
  const { actorName, actionText } = row;
  if (row.type !== "settlement.recorded") return ` ${actionText}`;
  if (actionText.startsWith(`${actorName} paid `)) return actionText.slice(actorName.length);
  // Rows from before payments stored their own sentence lost the payer's name.
  if (actionText.startsWith("paid ")) return ` ${actionText}`;
  return ` recorded that ${actionText}`;
}
