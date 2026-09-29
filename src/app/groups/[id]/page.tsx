"use client";

import { useEffect, useLayoutEffect, useRef, useState, use } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Plus, HandCoins, Download, Pencil, Trash2, Receipt, Paperclip,
  RefreshCcw, MessageSquare, ScrollText, Scale, Search, X, PieChart, Settings, Copy, ChevronDown, Users,
  SlidersHorizontal, MoreHorizontal,
} from "lucide-react";
import { api, ApiClientError, fmtMoney, fmtDate, fmtTime, useMe, useFilters, useApiData, useSync } from "@/lib/client";
import { AppShell } from "@/components/shell";
import { Card, CardHeader, Money, EmptyState, Button, Avatar, Input, Select, Modal, Menu, MenuItem, DateField } from "@/components/ui";
import { ExpenseForm } from "@/components/expense-form";
import { GroupBalanceForm, ExistingGroupBalance } from "@/components/group-balance-form";
import { SettleModal } from "@/components/settle-modal";
import { RecurringModal, ExistingRecurring } from "@/components/recurring-modal";
import { GroupSettingsModal } from "@/components/group-settings-modal";
import { ExpenseDetailModal } from "@/components/expense-detail";
import { ChatPane } from "@/components/chat";
import { SpendCharts } from "@/components/spend-charts";
import { ActivitySummary } from "@/components/activity-summary";
import { Expense, Settlement, useGroupPageData } from "./use-group-page-data";

type Tab = "expenses" | "balances" | "insights" | "chat" | "activity";
type GroupBalanceSummary = { id: number; title: string; amountCents: number; updatedAt: string };
type GroupBalancePage = { balances: GroupBalanceSummary[]; hasMore: boolean; changeCursor: number };

export default function GroupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const groupId = Number(id);
  const router = useRouter();
  const searchParams = useSearchParams();
  const me = useMe();
  const [expenseLimit, setExpenseLimit] = useState(50);
  const [settlementLimit, setSettlementLimit] = useState(50);
  const [tab, setTab] = useState<Tab>("expenses");
  const [mobileTabStop, setMobileTabStop] = useState<Tab | "more">("expenses");

  // filters
  const { filters, setFilter, reset: resetFilters, active: filtersActive } =
    useFilters({ q: "", cat: "", payer: "", from: "", to: "" });
  const { data: categoriesData, reload: reloadCategories } = useApiData<{ categories: { id: number; name: string }[] }>(
    "/api/categories", 0, { sync: false }
  );
  const categories = categoriesData?.categories ?? [];
  const {
    detail, expenses, insightExpenses, insightError, hasMoreExpenses, recurring, settlements, hasMoreSettlements,
    activity, refreshKey, loadError, loadDetail, reloadInsights, refreshAll, refreshBalancePreview, pollBalancePreview,
    refreshGroupBalanceMutation,
  } = useGroupPageData({ groupId, filters, expenseLimit, settlementLimit, insightsEnabled: tab === "insights" });

  // modals
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [groupBalanceOpen, setGroupBalanceOpen] = useState(false);
  const [editingGroupBalance, setEditingGroupBalance] = useState<ExistingGroupBalance | null>(null);
  const [extraGroupBalancePage, setExtraGroupBalancePage] = useState<{
    groupId: number; changeCursor: number; balances: GroupBalanceSummary[]; hasMore: boolean;
  } | null>(null);
  const [loadingGroupBalances, setLoadingGroupBalances] = useState(false);
  const { data: groupBalancesData, error: groupBalancesError, reloadFresh: reloadGroupBalancesFresh,
    reloadFreshCoalesced: pollGroupBalanceList } = useApiData<GroupBalancePage>(
    `/api/groups/${groupId}/group-balances?limit=50`, 0, { sync: false });
  useSync(() => {
    pollGroupBalanceList();
    pollBalancePreview();
  }, true);
  const observedBalanceChange = useRef<{ groupId: number; cursor: number } | null>(null);
  useEffect(() => {
    if (!groupBalancesData) return;
    const previous = observedBalanceChange.current;
    observedBalanceChange.current = { groupId, cursor: groupBalancesData.changeCursor };
    if (previous?.groupId === groupId && previous.cursor !== groupBalancesData.changeCursor) {
      refreshBalancePreview();
    }
  }, [groupId, groupBalancesData, refreshBalancePreview]);
  const activeExtraGroupBalancePage = extraGroupBalancePage?.groupId === groupId &&
    extraGroupBalancePage.changeCursor === groupBalancesData?.changeCursor ? extraGroupBalancePage : null;
  const [editing, setEditing] = useState<Parameters<typeof ExpenseForm>[0]["existing"]>(null);
  const [settleOpen, setSettleOpen] = useState(false);
  const [settlePrefill, setSettlePrefill] = useState<{ payerId: number; recipientId: number; amountCents: number } | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<Expense | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [recurringOpen, setRecurringOpen] = useState(false);
  const [editingRecurring, setEditingRecurring] = useState<ExistingRecurring | null>(null);
  const [editingSettlement, setEditingSettlement] = useState<Settlement | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [memberQuery, setMemberQuery] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  function copyInviteLink() {
    if (!detail) return;
    navigator.clipboard.writeText(`${window.location.origin}/signup?invite=${detail.group.inviteCode}`).catch(() => {});
  }

  // Reset to the first page whenever the filters change.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setExpenseLimit(50);
  }, [filters]);

  useEffect(() => {
    if (searchParams.get("add") === "1") {
      // Deep links may request the add-expense modal.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEditing(null);
      setExpenseOpen(true);
    }
    const t = searchParams.get("tab");
    if (t && ["expenses", "balances", "insights", "chat", "activity"].includes(t)) {
      const next = t as Tab;
      setTab(next);
      setMobileTabStop(next === "insights" || next === "activity" ? "more" : next);
    }
    const expenseId = Number(searchParams.get("expense"));
    if (Number.isInteger(expenseId) && expenseId > 0) {
      setTab("expenses");
      setMobileTabStop("expenses");
      setDetailId(expenseId);
    }
    if (searchParams.get("add") === "1" || t || expenseId > 0) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, [searchParams]);

  async function openEdit(expenseId: number) {
    try {
      const r = await api<{ expense: NonNullable<typeof editing> }>(`/api/expenses/${expenseId}`);
      setEditing(r.expense);
      setExpenseOpen(true);
    } catch (e) {
      // A 404 means another member deleted it — refresh the list to drop it.
      // Anything else is unexpected and should surface, not vanish.
      if (e instanceof ApiClientError) refreshAll();
      else throw e;
    }
  }

  async function openGroupBalance(id: number) {
    try {
      const result = await api<{ balance: ExistingGroupBalance }>(`/api/group-balances/${id}`);
      setEditingGroupBalance(result.balance);
      setGroupBalanceOpen(true);
    } catch (e) {
      if (e instanceof ApiClientError && e.status === 404) {
        reloadGroupBalanceList();
        refreshBalancePreview();
      }
      window.alert(e instanceof ApiClientError ? e.message : "Could not open group balance");
    }
  }

  async function loadMoreGroupBalances() {
    const firstPage = groupBalancesData;
    const last = activeExtraGroupBalancePage?.balances.at(-1) ?? firstPage?.balances.at(-1);
    if (!firstPage || !last || loadingGroupBalances) return;
    setLoadingGroupBalances(true);
    try {
      const next = await api<GroupBalancePage>(
        `/api/groups/${groupId}/group-balances?limit=50&before=${last.id}`);
      if (next.changeCursor !== firstPage.changeCursor) {
        setExtraGroupBalancePage(null);
        reloadGroupBalancesFresh();
        return;
      }
      setExtraGroupBalancePage({ groupId, changeCursor: firstPage.changeCursor,
        balances: [...(activeExtraGroupBalancePage?.balances ?? []), ...next.balances], hasMore: next.hasMore });
    } catch (e) {
      window.alert(e instanceof ApiClientError ? e.message : "Could not load group balances");
    } finally {
      setLoadingGroupBalances(false);
    }
  }

  function reloadGroupBalanceList() {
    setExtraGroupBalancePage(null);
    reloadGroupBalancesFresh();
  }

  function afterGroupBalanceMutation() {
    reloadGroupBalanceList();
    refreshGroupBalanceMutation();
  }

  async function removeGroupBalance(row: GroupBalanceSummary) {
    if (!window.confirm(`Delete group balance "${row.title}"? Group debts will update.`)) return;
    try {
      await api(`/api/group-balances/${row.id}?expectedUpdatedAt=${encodeURIComponent(row.updatedAt)}`, { method: "DELETE" });
      afterGroupBalanceMutation();
    } catch (e) {
      window.alert(e instanceof ApiClientError ? e.message : "Could not delete group balance");
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await api(`/api/expenses/${deleting.id}?expectedUpdatedAt=${encodeURIComponent(deleting.updatedAt)}`, { method: "DELETE" });
      setDeleting(null);
      refreshAll();
    } catch (err) {
      // A concurrent edit (stale version → 400), a delete by another member (404),
      // or a network error must surface — otherwise the modal just sits there.
      window.alert(err instanceof ApiClientError ? err.message : "Could not delete this expense");
      refreshAll();
    } finally {
      setDeleteBusy(false);
    }
  }

  if (loadError) {
    return (
      <AppShell title="Group">
        <EmptyState title={loadError} action={<Link href="/groups"><Button variant="secondary">Back to groups</Button></Link>} />
      </AppShell>
    );
  }

  const memberName = (uid: number) => detail?.members.find((m) => m.id === uid)?.displayName ?? "Someone";
  const visibleBalances = detail?.balances.filter((b) => {
    const q = memberQuery.trim().toLowerCase();
    return !q || b.displayName.toLowerCase().includes(q);
  }) ?? [];

  const TABS: { key: Tab; label: string; icon: typeof Receipt }[] = [
    { key: "expenses", label: "Expenses", icon: Receipt },
    { key: "balances", label: "Balances", icon: Scale },
    { key: "insights", label: "Insights", icon: PieChart },
    { key: "chat", label: "Chat", icon: MessageSquare },
    { key: "activity", label: "Activity", icon: ScrollText },
  ];
  const PRIMARY_TABS = TABS.filter(({ key }) => ["expenses", "balances", "chat"].includes(key));
  const MORE_TABS = TABS.filter(({ key }) => ["insights", "activity"].includes(key));
  const moreTabActive = MORE_TABS.some(({ key }) => key === tab);
  function moveTabFocus(event: React.KeyboardEvent<HTMLButtonElement>, key: Tab, tabs: { key: Tab }[]) {
    const index = tabs.findIndex((item) => item.key === key);
    let nextIndex = index;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    else return;
    event.preventDefault();
    const next = tabs[nextIndex].key;
    const tablist = event.currentTarget.closest('[role="tablist"]');
    setTab(next);
    setMobileTabStop(next === "insights" || next === "activity" ? "more" : next);
    requestAnimationFrame(() => tablist?.querySelector<HTMLButtonElement>(`[data-group-tab="${next}"]`)?.focus());
  }
  function moveMobileTabFocus(event: React.KeyboardEvent<HTMLButtonElement>, key: Tab | "more") {
    const tabs: (Tab | "more")[] = [...PRIMARY_TABS.map((item) => item.key), "more"];
    const index = tabs.indexOf(key);
    let nextIndex = index;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    else return;
    event.preventDefault();
    const next = tabs[nextIndex];
    const tablist = event.currentTarget.closest('[role="tablist"]');
    setMobileTabStop(next);
    if (next !== "more") setTab(next);
    requestAnimationFrame(() => tablist?.querySelector<HTMLButtonElement>(`[data-group-tab="${next}"]`)?.focus());
  }
  const canSettle = (detail?.members.length ?? 0) >= 2;
  const myGroupBalance = me && detail
    ? detail.balances.find((balance) => balance.userId === me.id)?.netCents ?? 0
    : 0;

  return (
    <AppShell title={detail?.group.name ?? "Group"}>
      <section className={`group-context group-hue-${groupId % 6} mb-3 md:shrink-0 lg:grid lg:grid-cols-[minmax(0,1fr)_auto_minmax(10rem,auto)] lg:items-center lg:gap-x-5`} aria-label="Current group">
        <div className="flex items-center gap-2">
          {detail ? (
            <div className="min-w-0 flex-1">
              <GroupSwitcher
                currentId={groupId}
                currentName={detail.group.name}
                currency={detail.group.currency}
                memberCount={detail.members.length}
              />
            </div>
          ) : (
            <div className="min-w-0 flex-1">
              <div className="skeleton h-8 w-56" />
            </div>
          )}
          <Menu
            label="Group menu"
            trigger={
              <button type="button" aria-label="Group menu" className="group-context-control">
                <MoreHorizontal className="h-5 w-5" />
              </button>
            }
          >
            <MenuItem icon={<Copy className="h-4 w-4" />} onClick={copyInviteLink}>Copy invite link</MenuItem>
            <MenuItem icon={<Download className="h-4 w-4" />} onClick={() => { window.location.href = `/api/groups/${groupId}/export`; }}>Export CSV</MenuItem>
            <MenuItem icon={<Settings className="h-4 w-4" />} onClick={() => setSettingsOpen(true)}>Group settings</MenuItem>
          </Menu>
        </div>

        {/* Below lg the balance and the action it justifies share one row.
            `lg:contents` hands both straight to the section's grid at lg.
            Adding an expense here is already one tap away — the bottom nav's "+"
            and the desktop sidebar both target the current group — so settling is
            the only action this panel needs to carry. */}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 lg:mt-0 lg:contents">
          {detail ? (
            <p className={`tnum whitespace-nowrap text-2xl font-semibold tracking-tight ${myGroupBalance > 0 ? "text-owed" : myGroupBalance < 0 ? "text-owe" : "text-[var(--group-ink)]"}`}>
              {myGroupBalance === 0 ? "Settled up" : (
                <>{myGroupBalance > 0 ? "Owed " : "You owe "}<Money cents={Math.abs(myGroupBalance)} currency={detail.group.currency} /></>
              )}
            </p>
          ) : (
            <div className="skeleton h-8 w-44" />
          )}
          <Button
            /* The group color is per-instance, so it comes in as an inline style:
               a utility class for it loses to the shared disabled: styling that every
               Button carries. Dropping the style when disabled lets that grey show. */
            variant="ghost"
            /* opacity is the one hover affordance an inline background cannot swallow. */
            className="shrink-0 hover:opacity-90 lg:w-full"
            style={canSettle ? { background: "var(--group-color)", color: "var(--color-white)" } : undefined}
            disabled={!canSettle}
            title={canSettle ? undefined : "Invite a friend first"}
            onClick={() => { setSettlePrefill(null); setSettleOpen(true); }}
          >
            <HandCoins className="hidden h-4 w-4 sm:block" /> Settle up
          </Button>
        </div>
      </section>

      {/* Members rail (desktop) — a nested sidebar instead of a full-width
          horizontal strip, so member balances stop eating vertical space. */}
      <div className="md:flex md:min-h-0 md:flex-1 md:gap-2.5">
      <Card className="hidden md:flex md:min-h-0 md:w-52 md:shrink-0 md:flex-col">
        <CardHeader title={`Members${detail ? ` · ${detail.members.length}` : ""}`} />
        {detail && detail.balances.length > 8 && (
          <div className="border-b border-line p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
              <Input
                value={memberQuery}
                onChange={(e) => setMemberQuery(e.target.value)}
                placeholder="Search members"
                aria-label="Search group members"
                className="!min-h-[var(--control-h-sm)] !py-1 pl-8"
              />
            </div>
          </div>
        )}
        <div className="md:min-h-0 md:flex-1 md:overflow-y-auto">
          {detail === null ? (
            <div className="space-y-2 p-3">
              {[...Array(4)].map((_, i) => <div key={i} className="skeleton h-8 w-full" />)}
            </div>
          ) : visibleBalances.length === 0 ? (
            <p className="px-3 py-3 text-sm text-ink-faint">No members match.</p>
          ) : (
            <ul className="divide-y divide-line">
              {visibleBalances.map((b) => (
                <li key={b.userId}>
                  <Link href={`/people/${b.userId}`} className="flex items-center gap-2 px-3 py-1.5 hover:bg-subtle">
                    <Avatar name={b.displayName} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium" title={b.displayName}>{b.displayName}</span>
                    <span className="tnum text-xs font-semibold">
                      {b.netCents === 0 ? (
                        <span className="font-normal text-ink-faint">settled</span>
                      ) : (
                        <Money cents={b.netCents} currency={detail.group.currency} signed />
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <div className="flex min-w-0 flex-col md:min-h-0 md:flex-1">
      {/* Three common destinations stay visible on mobile. Less-used views live
          under More, while desktop keeps the full set in one scan. */}
      <div role="tablist" aria-label="Group sections" className="mb-2 grid grid-cols-4 gap-1 rounded-xl border border-line bg-card p-1 sm:hidden">
        {PRIMARY_TABS.map(({ key, label }) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            aria-controls="group-tab-panel"
            data-group-tab={key}
            tabIndex={mobileTabStop === key ? 0 : -1}
            onClick={() => { setTab(key); setMobileTabStop(key); }}
            onKeyDown={(event) => moveMobileTabFocus(event, key)}
            className={`flex min-h-[var(--control-h)] min-w-0 items-center justify-center rounded-lg px-0.5 py-1.5 text-xs font-medium transition-colors ${
              tab === key ? "bg-accent-soft text-accent-dark" : "text-ink-soft hover:text-ink"
            }`}
          >
            <span className="truncate">{label}</span>
          </button>
        ))}
        <Menu
          label="More group sections"
          trigger={
            <button
              type="button"
              id="group-more-tab"
              role="tab"
              aria-selected={moreTabActive}
              aria-controls="group-tab-panel"
              aria-label={moreTabActive ? `More group sections, ${TABS.find(({ key }) => key === tab)?.label} selected` : "More group sections"}
              data-group-tab="more"
              tabIndex={mobileTabStop === "more" ? 0 : -1}
              onKeyDown={(event) => moveMobileTabFocus(event, "more")}
              className={`flex min-h-[var(--control-h)] w-full min-w-0 items-center justify-center rounded-lg px-0.5 py-1.5 text-xs font-medium transition-colors ${
                moreTabActive ? "bg-accent-soft text-accent-dark" : "text-ink-soft hover:text-ink"
              }`}
            >
              <span className="truncate">More</span>
            </button>
          }
        >
          {MORE_TABS.map(({ key, label, icon: Icon }) => (
            <MenuItem key={key} icon={<Icon className="h-4 w-4" />} onClick={() => { setTab(key); setMobileTabStop("more"); }}>{label}</MenuItem>
          ))}
        </Menu>
      </div>

      <div role="tablist" aria-label="Group sections" className="mb-2 hidden grid-cols-5 gap-1 rounded-xl border border-line bg-card p-1 sm:grid md:shrink-0">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            aria-controls="group-tab-panel"
            data-group-tab={key}
            tabIndex={tab === key ? 0 : -1}
            onClick={() => { setTab(key); setMobileTabStop(key === "insights" || key === "activity" ? "more" : key); }}
            onKeyDown={(event) => moveTabFocus(event, key, TABS)}
            className={`flex min-h-[var(--control-h)] min-w-0 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              tab === key ? "bg-accent-soft text-accent-dark" : "text-ink-soft hover:text-ink"
            }`}
          >
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>

      <div id="group-tab-panel" role="tabpanel" aria-label={`${TABS.find(({ key }) => key === tab)?.label} section`} className="md:min-h-0 md:flex-1 md:overflow-hidden">
      {tab === "expenses" && (
        <div className="flex flex-col md:h-full md:min-h-0">
          <Card className="mb-2.5 p-2 md:shrink-0">
            {/* Search is always visible; category/payer/date filters fold away so
                they don't push the expense list down the first viewport. */}
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
                <Input value={filters.q} onChange={setFilter("q")} placeholder="Search expenses" className="pl-8" aria-label="Search expenses" />
              </div>
              <Button
                variant={showFilters || filtersActive ? "secondary" : "ghost"}
                onClick={() => setShowFilters((v) => !v)}
                aria-expanded={showFilters || filtersActive}
                aria-label="Toggle filters"
              >
                <SlidersHorizontal className="h-4 w-4" />
                <span className="hidden sm:inline">Filters</span>
                {filtersActive && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
              </Button>
            </div>
            {(showFilters || filtersActive) && (
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Select value={filters.cat} onChange={setFilter("cat")} aria-label="Filter by category">
                  <option value="">All categories</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
                <Select value={filters.payer} onChange={setFilter("payer")} aria-label="Filter by payer">
                  <option value="">All payers</option>
                  {detail?.members.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
                </Select>
                <DateField label="From" value={filters.from} onChange={setFilter("from")} aria-label="From date" />
                <DateField label="To" value={filters.to} onChange={setFilter("to")} aria-label="To date" />
              </div>
            )}
            {filtersActive && (
              <button
                onClick={resetFilters}
                className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
              >
                <X className="h-3.5 w-3.5" /> Clear filters
              </button>
            )}
          </Card>

          <Card className="flex flex-col md:min-h-0 md:flex-1">
            <CardHeader
              title="Expenses"
              action={
                recurring.length > 0 ? (
                  <span className="flex items-center gap-1 text-xs text-ink-faint">
                    <RefreshCcw className="h-3.5 w-3.5" /> {recurring.length} recurring
                  </span>
                ) : undefined
              }
            />
            <div className="md:min-h-0 md:flex-1 md:overflow-y-auto">
            {expenses === null ? (
              <div className="space-y-2 p-3">
                {[...Array(4)].map((_, i) => <div key={i} className="skeleton h-12 w-full" />)}
              </div>
            ) : expenses.length === 0 ? (
              <EmptyState
                icon={<Receipt className="h-8 w-8" />}
                title={filtersActive ? "No expenses match your filters" : "No expenses yet"}
                hint={filtersActive ? "Try clearing the filters." : "Add the first shared expense to get rolling."}
                action={
                  !filtersActive ? (
                    <Button onClick={() => { setEditing(null); setExpenseOpen(true); }}>
                      <Plus className="h-4 w-4" /> Add expense
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <ul className="divide-y divide-line">
                {expenses.map((e) => {
                  const myShare = me ? (e.shares.find((s) => s.userId === me.id)?.convertedShareCents ?? 0) : 0;
                  return (
                    <li key={e.id} className="group flex min-h-[var(--row-h)] items-center gap-2.5 px-3.5 py-1.5">
                      <button
                        onClick={() => setDetailId(e.id)}
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                        aria-label={`View ${e.title}`}
                      >
                      <div className="hidden w-12 shrink-0 text-center sm:block">
                        <p className="text-xs font-semibold uppercase text-ink-faint">
                          {new Date(String(e.date).slice(0, 10) + "T00:00:00").toLocaleDateString("en-US", { month: "short" })}
                        </p>
                        <p className="font-display text-base font-semibold leading-none">
                          {new Date(String(e.date).slice(0, 10) + "T00:00:00").getDate()}
                        </p>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">
                          {e.title}
                          {e.attachmentCount > 0 && <Paperclip className="ml-1.5 inline h-3.5 w-3.5 text-ink-faint" />}
                        </p>
                        <p className="truncate text-xs text-ink-faint">
                          <span className="sm:hidden">{fmtDate(e.date)} · </span>
                          {e.payerName} paid
                          {e.currency !== detail?.group.currency && ` · ${fmtMoney(e.amountCents, e.currency)}`}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="tnum text-sm font-semibold">{fmtMoney(e.convertedCents, detail?.group.currency ?? e.currency)}</p>
                        <p className={`text-xs font-medium ${
                          me && e.payerId === me.id && e.convertedCents - myShare > 0
                            ? "text-owed"
                            : myShare > 0
                              ? "text-owe"
                              : "text-ink-faint"
                        }`}>
                          {me && e.payerId === me.id
                            ? `you lent ${fmtMoney(e.convertedCents - myShare, detail?.group.currency ?? e.currency)}`
                            : myShare > 0
                              ? `your share ${fmtMoney(myShare, detail?.group.currency ?? e.currency)}`
                              : "not involved"}
                        </p>
                      </div>
                      </button>
                      <div className="hidden shrink-0 gap-0.5 sm:flex">
                        <button onClick={() => openEdit(e.id)} aria-label={`Edit ${e.title}`} className="rounded-lg p-2.5 text-ink-faint hover:bg-accent-soft hover:text-accent-dark">
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button onClick={() => setDeleting(e)} aria-label={`Delete ${e.title}`} className="rounded-lg p-2.5 text-ink-faint hover:bg-danger-soft hover:text-danger">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {expenses && expenses.length > 0 && hasMoreExpenses && (
              <div className="border-t border-line p-3 text-center">
                <Button variant="secondary" onClick={() => setExpenseLimit((l) => l + 50)}>
                  Load more
                </Button>
              </div>
            )}
            </div>
          </Card>
        </div>
      )}

      {tab === "insights" && (
        <div className="space-y-4 md:h-full md:overflow-y-auto">
          {/* Recurring */}
          <Card>
            <CardHeader
              title="Recurring expenses"
              action={
                <Button variant="ghost" className="!min-h-8 !px-2.5 !py-1 text-xs" onClick={() => setRecurringOpen(true)}>
                  <Plus className="h-3.5 w-3.5" /> Add recurring
                </Button>
              }
            />
            {recurring.length === 0 ? (
              <p className="px-3.5 py-3 text-sm text-ink-faint">No recurring expenses. Rent, subscriptions, and bills can repeat weekly or monthly.</p>
            ) : (
              <ul className="divide-y divide-line">
                {recurring.map((r) => (
                  <li key={r.id} className="flex min-h-10 items-center gap-2.5 px-3.5 py-1.5 text-sm">
                    <RefreshCcw className="h-4 w-4 shrink-0 text-ink-faint" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{r.title}</span>
                      <span className="block text-xs text-ink-faint">
                        {r.cadence} · next {fmtDate(r.nextDate)} · {r.payerName} pays
                      </span>
                    </span>
                    <span className="tnum font-medium">{fmtMoney(r.amountCents, r.currency)}</span>
                    <button
                      aria-label={`Edit ${r.title}`}
                      onClick={() => setEditingRecurring({
                        id: r.id, title: r.title, amountCents: r.amountCents, payerId: r.payerId,
                        currency: r.currency, categoryId: r.categoryId, participantIds: r.participantIds,
                        notes: r.notes, cadence: r.cadence as "weekly" | "monthly", nextDate: r.nextDate,
                        anchorDay: r.anchorDay, active: r.active, updatedAt: r.updatedAt,
                      })}
                      className="inline-flex h-[var(--control-h)] w-[var(--control-h)] items-center justify-center rounded-lg text-ink-faint hover:bg-accent-soft hover:text-accent-dark"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      aria-label={`Stop ${r.title}`}
                      onClick={async () => {
                        if (!window.confirm(`Stop the recurring expense "${r.title}"? Existing expenses are kept.`)) return;
                        try {
                          await api(`/api/recurring/${r.id}?expectedUpdatedAt=${encodeURIComponent(r.updatedAt)}`, { method: "DELETE" });
                          loadDetail();
                        } catch (e) {
                          window.alert(e instanceof ApiClientError ? e.message : "Could not stop the recurring expense");
                        }
                      }}
                      className="inline-flex h-[var(--control-h)] w-[var(--control-h)] items-center justify-center rounded-lg text-ink-faint hover:bg-danger-soft hover:text-danger"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Charts */}
          {insightExpenses === null && !insightError && (
            <div role="status" className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
              <span className="sr-only">Loading insights…</span>
              {[...Array(3)].map((_, index) => <Card key={index} className="p-4"><div className="skeleton h-40 w-full" /></Card>)}
            </div>
          )}
          {insightError && (
            <Card className="mt-4 p-4">
              <div role="alert" className="flex flex-wrap items-center justify-between gap-3 text-sm text-danger">
                <p>{insightError}</p>
                <Button variant="secondary" onClick={reloadInsights}>Try again</Button>
              </div>
            </Card>
          )}
          {insightExpenses && insightExpenses.length > 0 && detail && (
            <SpendCharts expenses={insightExpenses} currency={detail.group.currency} />
          )}
          {insightExpenses?.length === 0 && (
            <EmptyState icon={<PieChart className="h-8 w-8" />} title="No insights yet" hint="Add a few expenses to see spending by category, over time, and by person." />
          )}
        </div>
      )}

      {tab === "balances" && detail && (
        <div className="space-y-4 md:h-full md:overflow-y-auto">
        <Card>
          <CardHeader title="Group balances" action={
            <Button variant="ghost" className="!min-h-8 !px-2.5 !py-1 text-xs" onClick={() => {
              setEditingGroupBalance(null); setGroupBalanceOpen(true);
            }}>
              <Plus className="h-3.5 w-3.5" /> Add group balance
            </Button>
          } />
          {groupBalancesError ? (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-3 text-sm text-danger">
              <p>{groupBalancesError}</p>
              <Button variant="secondary" onClick={reloadGroupBalanceList}>Try again</Button>
            </div>
          ) : groupBalancesData === null ? (
            <div className="space-y-2 p-3"><div className="skeleton h-10 w-full" /></div>
          ) : groupBalancesData.balances.length === 0 ? (
            <p className="px-3.5 py-3 text-sm text-ink-faint">No group balances yet. Add obligations without recording a payment.</p>
          ) : <>
            <ul className="divide-y divide-line">
              {[...groupBalancesData.balances, ...(activeExtraGroupBalancePage?.balances ?? [])].map((row) => <li key={row.id} className="flex min-h-[var(--row-h)] items-center gap-2.5 px-3.5 py-1.5">
                <button type="button" onClick={() => openGroupBalance(row.id)} className="min-w-0 flex-1 truncate text-left text-sm font-medium hover:text-accent-dark">
                  {row.title}
                </button>
                <span className="tnum shrink-0 text-sm font-semibold">{fmtMoney(row.amountCents, detail.group.currency)}</span>
                <button type="button" onClick={() => openGroupBalance(row.id)} aria-label={`Edit ${row.title}`} className="rounded-lg p-2.5 text-ink-faint hover:bg-accent-soft hover:text-accent-dark"><Pencil className="h-4 w-4" /></button>
                <button type="button" onClick={() => removeGroupBalance(row)} aria-label={`Delete ${row.title}`} className="rounded-lg p-2.5 text-ink-faint hover:bg-danger-soft hover:text-danger"><Trash2 className="h-4 w-4" /></button>
              </li>)}
            </ul>
            {(activeExtraGroupBalancePage?.hasMore ?? groupBalancesData.hasMore) && <div className="border-t border-line p-3 text-center"><Button variant="secondary" busy={loadingGroupBalances} onClick={loadMoreGroupBalances}>Load more</Button></div>}
          </>}
        </Card>
        <Card>
          <CardHeader title="Who owes who" />
          {detail.suggestions.length === 0 ? (
            <EmptyState icon={<Scale className="h-8 w-8" />} title="All settled up" hint="Nobody owes anything in this group right now." />
          ) : (
            <ul className="divide-y divide-line">
              {detail.suggestions.map((s, i) => (
                <li key={i} className="flex min-h-[var(--row-h)] flex-wrap items-center gap-2.5 px-3.5 py-1.5">
                  <Link href={`/people/${s.from}`} aria-label={`Open ${memberName(s.from)}'s profile`}>
                    <Avatar name={memberName(s.from)} size="sm" />
                  </Link>
                  <span className="text-sm">
                    <Link href={`/people/${s.from}`} className="font-semibold hover:text-accent-dark hover:underline">{memberName(s.from)}</Link>{" "}
                    should pay{" "}
                    <Link href={`/people/${s.to}`} className="font-semibold hover:text-accent-dark hover:underline">{memberName(s.to)}</Link>
                  </span>
                  <span className="tnum ml-auto font-display text-base font-semibold">{fmtMoney(s.amountCents, detail.group.currency)}</span>
                  {(me?.id === s.from || me?.id === s.to) && (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setSettlePrefill({ payerId: s.from, recipientId: s.to, amountCents: s.amountCents });
                        setSettleOpen(true);
                      }}
                    >
                      <HandCoins className="h-4 w-4" /> Record payment
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Recorded payments" />
          {settlements === null ? (
            <div className="space-y-2 p-3">{[...Array(2)].map((_, i) => <div key={i} className="skeleton h-10 w-full" />)}</div>
          ) : settlements.length === 0 ? (
            <p className="px-3.5 py-3 text-sm text-ink-faint">No payments recorded yet. When someone settles up offline, record it here so balances stay accurate.</p>
          ) : (
            <ul className="divide-y divide-line">
              {settlements.map((s) => (
                <li key={s.id} className="flex min-h-[var(--row-h)] flex-wrap items-center gap-2.5 px-3.5 py-1.5">
                  <HandCoins className="h-4 w-4 shrink-0 text-owed" />
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="block">
                      <Link href={`/people/${s.payerId}`} className="font-semibold hover:text-accent-dark hover:underline">{s.payerName}</Link>{" "}
                      paid{" "}
                      <Link href={`/people/${s.recipientId}`} className="font-semibold hover:text-accent-dark hover:underline">{s.recipientName}</Link>
                    </span>
                    <span className="block text-xs text-ink-faint">
                      {fmtDate(s.date)}
                      {s.note ? ` · ${s.note}` : ""}
                      {s.currency !== detail.group.currency ? ` · ${fmtMoney(s.amountCents, s.currency)}` : ""}
                    </span>
                  </span>
                  <span className="tnum font-semibold">{fmtMoney(s.amountCents, s.currency)}</span>
                  <div className="flex shrink-0 gap-0.5">
                    <button
                      onClick={() => setEditingSettlement(s)}
                      aria-label="Edit payment"
                      className="inline-flex h-[var(--control-h)] w-[var(--control-h)] items-center justify-center rounded-lg text-ink-faint hover:bg-accent-soft hover:text-accent-dark"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      aria-label="Delete payment"
                      onClick={async () => {
                        if (!window.confirm(`Delete this recorded payment (${fmtMoney(s.amountCents, s.currency)} from ${s.payerName} to ${s.recipientName})? Balances will update.`)) return;
                        try {
                          await api(`/api/settlements/${s.id}?expectedUpdatedAt=${encodeURIComponent(s.updatedAt)}`, { method: "DELETE" });
                          refreshAll();
                        } catch (e) {
                          window.alert(e instanceof ApiClientError ? e.message : "Could not delete the payment");
                        }
                      }}
                      className="inline-flex h-[var(--control-h)] w-[var(--control-h)] items-center justify-center rounded-lg text-ink-faint hover:bg-danger-soft hover:text-danger"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {settlements && settlements.length > 0 && hasMoreSettlements && (
            <div className="border-t border-line p-3 text-center">
              <Button variant="secondary" onClick={() => setSettlementLimit((l) => l + 50)}>Load more</Button>
            </div>
          )}
        </Card>
        </div>
      )}

      {tab === "chat" && me && (
        <Card className="md:flex md:h-full md:min-h-0 md:flex-col">
          <ChatPane
            endpoint={`/api/groups/${groupId}/messages`}
            meId={me.id}
            refreshKey={refreshKey}
            emptyHint="No messages yet. Say hi or hash out that bill."
            readScope={`msg:group:${groupId}`}
          />
        </Card>
      )}

      {tab === "activity" && (
        <Card className="md:flex md:h-full md:min-h-0 md:flex-col">
          <CardHeader title="Activity log" />
          <div className="md:min-h-0 md:flex-1 md:overflow-y-auto">
          {activity === null ? (
            <div className="space-y-2 p-3">{[...Array(4)].map((_, i) => <div key={i} className="skeleton h-8 w-full" />)}</div>
          ) : activity.length === 0 ? (
            <EmptyState icon={<ScrollText className="h-8 w-8" />} title="No activity yet" />
          ) : (
            <ul className="divide-y divide-line">
              {activity.map((a) => (
                <li key={a.id} className="px-3.5 py-1.5">
                  <ActivitySummary activity={a} />
                  <p className="mt-0.5 text-xs text-ink-faint">{fmtTime(a.createdAt)}</p>
                </li>
              ))}
            </ul>
          )}
          </div>
        </Card>
      )}
      </div>
      </div>
      </div>

      {/* Modals */}
      {detail && me && (
        <>
          <ExpenseForm
            groupId={groupId}
            groupName={detail.group.name}
            groupCurrency={detail.group.currency}
            members={detail.members}
            meId={me.id}
            existing={editing}
            open={expenseOpen}
            onClose={() => setExpenseOpen(false)}
            onSaved={refreshAll}
            onCategoryAdded={reloadCategories}
          />
          <GroupBalanceForm
            groupId={groupId} groupName={detail.group.name} currency={detail.group.currency}
            members={detail.members} meId={me.id} balances={detail.balances}
            existing={editingGroupBalance} open={groupBalanceOpen}
            onClose={() => setGroupBalanceOpen(false)}
            onSaved={afterGroupBalanceMutation}
            onRefresh={() => { reloadGroupBalanceList(); refreshBalancePreview(); }}
          />
          <SettleModal
            open={settleOpen}
            onClose={() => setSettleOpen(false)}
            onSaved={refreshAll}
            groupId={groupId}
            members={detail.members}
            meId={me.id}
            defaultCurrency={detail.group.currency}
            prefill={settlePrefill}
          />
          <SettleModal
            open={!!editingSettlement}
            onClose={() => setEditingSettlement(null)}
            onSaved={refreshAll}
            groupId={groupId}
            members={detail.members}
            meId={me.id}
            defaultCurrency={detail.group.currency}
            existing={editingSettlement}
          />
          <RecurringModal
            open={recurringOpen || !!editingRecurring}
            onClose={() => { setRecurringOpen(false); setEditingRecurring(null); }}
            onSaved={loadDetail}
            groupId={groupId}
            members={detail.members}
            meId={me.id}
            defaultCurrency={detail.group.currency}
            existing={editingRecurring}
          />
          <GroupSettingsModal
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            group={{ id: groupId, name: detail.group.name, createdBy: detail.group.createdBy }}
            members={detail.members}
            meId={me.id}
            onChanged={() => { loadDetail(); }}
            onGone={() => router.push("/groups")}
          />
        </>
      )}

      {me && (
        <ExpenseDetailModal
          expenseId={detailId}
          meId={me.id}
          open={detailId !== null}
          onClose={() => setDetailId(null)}
          onEdit={(eid) => { setDetailId(null); openEdit(eid); }}
          onDelete={(eid) => {
            const exp = expenses?.find((x) => x.id === eid) ?? null;
            setDetailId(null);
            if (exp) setDeleting(exp);
          }}
        />
      )}

      <Modal open={!!deleting} onClose={() => setDeleting(null)} title="Delete expense?">
        <p className="text-sm text-ink-soft">
          Delete <strong>{deleting?.title}</strong> ({deleting && fmtMoney(deleting.amountCents, deleting.currency)})?
          Balances will update for everyone. This can&apos;t be undone.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setDeleting(null)}>Cancel</Button>
          <Button variant="danger" busy={deleteBusy} onClick={confirmDelete}>Delete expense</Button>
        </div>
      </Modal>
    </AppShell>
  );
}

// Inline dropdown so users can jump between groups without going back to the
// index — groups behave like switchable workspaces.
function GroupSwitcher({
  currentId,
  currentName,
  currency,
  memberCount,
}: {
  currentId: number;
  currentName: string;
  currency: string;
  memberCount: number;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { data } = useApiData<{ groups: {
    id: number;
    name: string;
    currency: string;
    memberCount: number;
    myNetCents: number;
    unreadMessages?: number;
  }[] }>("/api/groups");
  const groups = data?.groups ?? [];

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onClick = () => setOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClick);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || groups.length === 0) return;
    const selected = listRef.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
    (selected ?? listRef.current?.querySelector<HTMLElement>('[role="option"]'))?.focus();
  }, [open, groups.length]);

  function moveOptionFocus(event: React.KeyboardEvent<HTMLDivElement>) {
    const options = [...(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    const current = options.indexOf(document.activeElement as HTMLElement);
    let next = current;
    if (event.key === "ArrowDown") next = current < options.length - 1 ? current + 1 : 0;
    else if (event.key === "ArrowUp") next = current > 0 ? current - 1 : options.length - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = options.length - 1;
    else return;
    event.preventDefault();
    options[next]?.focus();
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="group-switcher-listbox"
        aria-label={`Switch group (current: ${currentName})`}
        className="flex w-full items-center gap-2 rounded-lg text-left text-[var(--group-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--group-color)]"
      >
        {/* Name and metadata sit on one baseline. Stacked, they made a two-line
            block, and both 32px controls centred against it instead of against
            the name — which is what read as misalignment. */}
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="min-w-0 truncate text-xl font-semibold tracking-tight">{currentName}</span>
          <span className="shrink-0 text-xs font-medium text-[var(--group-muted)]">{memberCount} {memberCount === 1 ? "member" : "members"} · {currency}</span>
        </span>
        <span className="group-context-control shrink-0">
          <ChevronDown className={`h-5 w-5 transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>
      {open && (
        <div
          className="absolute left-0 right-0 top-full z-50 mt-2 max-h-[60dvh] overflow-y-auto rounded-xl border border-line bg-card p-1.5 text-ink shadow-pop"
        >
          <div
            ref={listRef}
            id="group-switcher-listbox"
            role="listbox"
            aria-label="Your groups"
            onKeyDown={moveOptionFocus}
          >
            {groups.length === 0 ? (
              <p role="status" className="px-3 py-2.5 text-sm text-ink-faint">Loading groups…</p>
            ) : groups.map((g) => (
              <Link
                key={g.id}
                href={`/groups/${g.id}`}
                role="option"
                aria-selected={g.id === currentId}
                tabIndex={g.id === currentId ? 0 : -1}
                onClick={() => setOpen(false)}
                className={`group-hue-${g.id % 6} flex items-center gap-3 rounded-lg px-2.5 py-2.5 text-sm hover:bg-subtle ${g.id === currentId ? "bg-subtle" : ""}`}
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--group-soft)] text-[var(--group-ink)]">
                  <Users className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{g.name}</span>
                  <span className="block text-xs text-ink-faint">{g.memberCount} {g.memberCount === 1 ? "member" : "members"} · {g.currency}</span>
                </span>
                <span className={`tnum text-xs font-semibold ${g.myNetCents > 0 ? "text-owed" : g.myNetCents < 0 ? "text-owe" : "text-ink-faint"}`}>
                  {g.myNetCents === 0 ? "settled" : <Money cents={g.myNetCents} currency={g.currency} signed />}
                </span>
                {!!g.unreadMessages && <span className="h-2 w-2 shrink-0 rounded-full bg-accent" aria-label="Unread messages" />}
              </Link>
            ))}
          </div>
          <Link href="/groups" className="mt-1 block border-t border-line px-3 py-2 text-sm font-medium text-accent hover:bg-subtle">
            All groups
          </Link>
        </div>
      )}
    </div>
  );
}
