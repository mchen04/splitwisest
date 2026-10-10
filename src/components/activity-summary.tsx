"use client";

import Link from "next/link";
import { activityAfterActor } from "@/lib/activity";

export interface ActivitySummaryData {
  actorId: number;
  actorName: string;
  actionText: string;
  type?: string;
}

export function ActivitySummary({ activity }: { activity: ActivitySummaryData }) {
  return (
    <p className="text-body leading-snug">
      <Link href={`/people/${activity.actorId}`} className="font-medium hover:text-accent-dark hover:underline">
        {activity.actorName}
      </Link>
      <span className="text-ink-soft">{activityAfterActor(activity)}</span>
    </p>
  );
}
