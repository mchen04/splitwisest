"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ScrollText } from "lucide-react";
import { fmtTime, markRead, useApiData, useSync } from "@/lib/client";
import { AppShell } from "@/components/shell";
import { Card, EmptyState, Button, LoadError, SectionLabel } from "@/components/ui";
import { ActivitySummary } from "@/components/activity-summary";

// Calendar-day bucket for the feed, so events scan by day instead of as one wall.
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    year: d.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

function timeOnly(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

interface Activity {
  id: number;
  groupId: number | null;
  groupName: string | null;
  actorId: number;
  actorName: string;
  actionText: string;
  type: string;
  summary: string;
  createdAt: string;
}

export default function ActivityPage() {
  const [limit, setLimit] = useState(50);
  const { data, error, reload } = useApiData<{ activity: Activity[]; hasMore: boolean }>(
    `/api/activity?limit=${limit}`, 0, { sync: false }
  );
  const activity = data?.activity ?? null;
  const hasMore = data?.hasMore ?? false;

  useEffect(() => {
    const maxId = activity?.reduce((max, item) => Math.max(max, item.id), 0) ?? 0;
    if (maxId > 0) markRead("activity", maxId);
  }, [activity]);
  useSync((c, prev) => {
    if (c.activityCursor !== prev.activityCursor) reload();
  });

  return (
    <AppShell title="Activity">
      <Card className="flex flex-col md:min-h-0 md:flex-1">
        <div className="md:min-h-0 md:flex-1 md:overflow-y-auto">
          {activity === null && error ? (
            <LoadError what="activity" message={error} onRetry={reload} />
          ) : activity === null ? (
            <div className="space-y-2 p-3">{[...Array(6)].map((_, i) => <div key={i} className="skeleton h-8 w-full" />)}</div>
          ) : activity.length === 0 ? (
            <EmptyState icon={<ScrollText className="h-6 w-6" />} title="Nothing yet" hint="Expenses, payments, and group changes will show up here." />
          ) : (
            <ul>
              {activity.map((a, i) => {
                const showDay = i === 0 || dayLabel(a.createdAt) !== dayLabel(activity[i - 1].createdAt);
                return (
                  <li key={a.id} className="border-b border-line last:border-0">
                    {showDay && (
                      <SectionLabel className="border-b border-line bg-subtle px-4 py-1">{dayLabel(a.createdAt)}</SectionLabel>
                    )}
                    <div className="px-4 py-2">
                      <ActivitySummary activity={a} />
                      <p className="text-meta text-ink-faint">
                        {/* The group opens on its own activity, where this event sits in context. */}
                        {a.groupName && a.groupId ? (
                          <><Link href={`/groups/${a.groupId}?tab=activity`} className="font-medium text-ink-soft hover:text-accent-dark hover:underline">{a.groupName}</Link>{" · "}</>
                        ) : a.groupName ? `${a.groupName} · ` : ""}
                        <time dateTime={a.createdAt} title={fmtTime(a.createdAt)}>{timeOnly(a.createdAt)}</time>
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {activity && activity.length > 0 && hasMore && (
            <div className="border-t border-line p-3 text-center">
              <Button variant="secondary" onClick={() => setLimit((l) => l + 50)}>Load more</Button>
            </div>
          )}
        </div>
      </Card>
    </AppShell>
  );
}
