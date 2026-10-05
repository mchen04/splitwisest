"use client";

import { useCallback, useState } from "react";
import { useApiData, useSync } from "@/lib/client";
import type { Member } from "@/components/expense-form";

export interface GroupDetail {
  group: { id: number; name: string; currency: string; inviteCode: string; createdBy: number };
  version: string;
  members: (Member & { username: string })[];
  balances: { userId: number; displayName: string; netCents: number }[];
  suggestions: { from: number; to: number; amountCents: number }[];
}

export interface Expense {
  id: number;
  title: string;
  amountCents: number;
  currency: string;
  convertedCents: number;
  date: string;
  payerId: number;
  payerName: string;
  categoryName: string | null;
  updatedAt: string;
  attachmentCount: number;
  shares: { userId: number; shareCents: number; convertedShareCents: number }[];
}

export interface Recurring {
  id: number;
  title: string;
  amountCents: number;
  currency: string;
  payerId: number;
  payerName: string;
  categoryId: number | null;
  participantIds: number[];
  notes: string;
  cadence: string;
  nextDate: string;
  anchorDay: number | null;
  active: boolean;
  updatedAt: string;
}

export interface Settlement {
  id: number;
  payerId: number;
  recipientId: number;
  payerName: string;
  recipientName: string;
  amountCents: number;
  currency: string;
  date: string;
  note: string;
  updatedAt: string;
}

export interface GroupActivity {
  id: number;
  actorId: number;
  actorName: string;
  actionText: string;
  summary: string;
  createdAt: string;
}

function expenseQuery(filters: { q: string; cat: string; payer: string; from: string; to: string }, limit: number) {
  const p = new URLSearchParams();
  if (filters.q.trim()) p.set("q", filters.q.trim());
  if (filters.cat) p.set("categoryId", filters.cat);
  if (filters.payer) p.set("payerId", filters.payer);
  if (filters.from) p.set("from", filters.from);
  if (filters.to) p.set("to", filters.to);
  p.set("limit", String(limit));
  return p;
}

interface ExpenseResponse { expenses: Expense[]; hasMore: boolean }
interface InsightExpense {
  categoryName: string | null;
  date: string;
  payerName: string;
  convertedCents: number;
}

function useExpenses(
  groupId: number,
  filters: { q: string; cat: string; payer: string; from: string; to: string },
  limit: number,
) {
  const { data, reload } = useApiData<ExpenseResponse>(
    `/api/groups/${groupId}/expenses?${expenseQuery(filters, limit)}`,
    filters.q ? 250 : 0,
    { sync: false },
  );
  return {
    expenses: data?.expenses ?? null,
    hasMoreExpenses: data?.hasMore ?? false,
    reloadExpenses: reload,
  };
}

function useInsightExpenses(groupId: number, enabled: boolean) {
  const path = `/api/groups/${groupId}/expenses?all=1`;
  const { data, error, reload } = useApiData<{ expenses: InsightExpense[]; hasMore: false }>(path, 0, { sync: false, enabled });
  const reloadInsightExpenses = useCallback(() => {
    if (enabled) reload();
  }, [enabled, reload]);
  return { insightExpenses: data?.expenses ?? null, insightError: error, reloadInsightExpenses };
}

function useSettlements(groupId: number, limit: number) {
  const { data, reload } = useApiData<{ settlements: Settlement[]; hasMore: boolean }>(
    `/api/groups/${groupId}/settlements?limit=${limit}`,
    0,
    { sync: false }
  );
  return { settlements: data?.settlements ?? null, hasMoreSettlements: data?.hasMore ?? false, reloadSettlements: reload };
}

export function useGroupPageData({
  groupId,
  filters,
  expenseLimit,
  settlementLimit,
  insightsEnabled,
}: {
  groupId: number;
  filters: { q: string; cat: string; payer: string; from: string; to: string };
  expenseLimit: number;
  settlementLimit: number;
  insightsEnabled: boolean;
}) {
  const detailState = useApiData<GroupDetail>(`/api/groups/${groupId}`, 0, { sync: false });
  const recurringState = useApiData<{ recurring: Recurring[] }>(`/api/groups/${groupId}/recurring`, 0, { sync: false });
  const activityState = useApiData<{ activity: GroupActivity[] }>(`/api/groups/${groupId}/activity`, 0, { sync: false });
  const { expenses, hasMoreExpenses, reloadExpenses } = useExpenses(groupId, filters, expenseLimit);
  const { insightExpenses, insightError, reloadInsightExpenses } = useInsightExpenses(groupId, insightsEnabled);
  const { settlements, hasMoreSettlements, reloadSettlements } = useSettlements(groupId, settlementLimit);
  const [refreshKey, setRefreshKey] = useState(0);
  // Wait for the group detail before blaming a side request, so a missing or
  // forbidden group always reports the detail's own error.
  const loadError = detailState.error
    ? detailState.error
    : detailState.data && (recurringState.error || activityState.error) ? "Some group data could not be refreshed" : null;

  const reloadOverview = useCallback((freshDetail = false) => {
    if (freshDetail) detailState.reloadFresh();
    else detailState.reload();
    recurringState.reload();
    activityState.reload();
    reloadSettlements();
  }, [detailState, recurringState, activityState, reloadSettlements]);

  const refreshAll = useCallback((freshDetail = false) => {
    reloadOverview(freshDetail);
    reloadExpenses();
    reloadInsightExpenses();
  }, [reloadOverview, reloadExpenses, reloadInsightExpenses]);

  useSync((c, prev) => {
    if (c.activityCursor !== prev.activityCursor) refreshAll(true);
    if (c.messageCursor !== prev.messageCursor) setRefreshKey((k) => k + 1);
  });

  return {
    detail: detailState.data,
    expenses,
    insightExpenses,
    insightError,
    hasMoreExpenses,
    recurring: recurringState.data?.recurring.filter((x) => x.active) ?? [],
    settlements,
    hasMoreSettlements,
    activity: activityState.data?.activity ?? null,
    refreshKey,
    loadError,
    loadDetail: reloadOverview,
    refreshBalancePreview: detailState.reloadFresh,
    pollBalancePreview: detailState.reloadFreshCoalesced,
    refreshGroupBalanceMutation: () => refreshAll(true),
    reloadInsights: reloadInsightExpenses,
    refreshAll,
  };
}
