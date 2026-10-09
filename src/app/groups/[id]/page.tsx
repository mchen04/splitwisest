"use client";

import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, use } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Plus, HandCoins, Download, Pencil, Trash2, Receipt, Paperclip,
  RefreshCcw, MessageSquare, ScrollText, Scale, Search, X, PieChart, Settings, Copy, ChevronDown, Users,
  SlidersHorizontal, MoreHorizontal,
} from "lucide-react";
import { api, ApiClientError, fmtMoney, fmtDate, fmtTime, useMe, useFilters, useApiData, useSync } from "@/lib/client";
import { AppShell } from "@/components/shell";
import {
  Card, CardHeader, Money, EmptyState, Button, Avatar, Input, Select, Modal, Menu, MenuItem, DateField, IconButton,
  RowMeta, RowTitle, SectionLabel, toast, confirmAction,
} from "@/components/ui";
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
type GroupBalancePage = { version: string; balances: GroupBalanceSummary[]; hasMore: boolean; changeCursor: number };

// Reads deep-link query params inside its own Suspense boundary, so the rest of
// the page renders into the statically generated per-id shell.
function GroupQuery({ onQuery }: { onQuery: (searchParams: URLSearchParams) => void }) {
  const searchParams = useSearchParams();
  useEffect(() => onQuery(searchParams), [searchParams, onQuery]);
  return null;
}

export default function GroupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const groupId = Number(id);
  const router = useRouter();
  const me = useMe();
  const [expenseLimit, setExpenseLimit] = useState(50);
  const [settlementLimit, setSettlementLimit] = useState(50);
  const [tab, setTab] = useState<Tab>("expenses");

  // filters
  const { filters, setFilter, reset: resetFilters, active: filtersActive } =
    useFilters({ q: "", cat: "", payer: "", from: "", to: "" });
  const { data: categoriesData, reload: reloadCategories } = useApiData<{ categories: { id: number; name: string }[] }>(
    "/api/categories", 0, { sync: false }
  );
  const categories = categoriesData?.categories ?? [];
  const {
    detail, expenses, insightExpenses, insightError, hasMoreExpenses, recurring, settlements, hasMoreSettlements,
    activity, refreshKey, loadError, loadDetail, reloadInsights, refreshAll, refreshBalancePreview, pollBalancePreview, detailSettled,
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
  const { data: groupBalancesData, error: groupBalancesError, settled: groupBalancesSettled,
    reloadFresh: reloadGroupBalancesFresh, reloadFreshCoalesced: pollGroupBalanceList } = useApiData<GroupBalancePage>(
    `/api/groups/${groupId}/group-balances?limit=50`, 0, { sync: false });
  // Each tick asks for the group's content fingerprints and refetches only the
  // detail or list whose fingerprint differs from the one it was served with.
  // Responses carry a fingerprint no newer than their data, so a missed, failed,
  // or stale read is retried on the next tick. An open group-balance form keeps
  // reading the detail every tick for its live preview. While the first load of
  // the detail or list is still in flight, its tick result waits for that load
  // and refetches only if the loaded fingerprint differs.
  const versionCheck = useRef(false);
  const latest = useRef({ groupId, detail, detailSettled, list: groupBalancesData, listSettled: groupBalancesSettled });
  const deferred = useRef<{ groupId: number; detail?: { version: string; due: boolean }; list?: string }>({ groupId });
  useLayoutEffect(() => {
    latest.current = { groupId, detail, detailSettled, list: groupBalancesData, listSettled: groupBalancesSettled };
    const waiting = deferred.current;
    if (waiting.groupId !== groupId) { deferred.current = { groupId }; return; }
    if (waiting.detail && detailSettled) {
      if (waiting.detail.due || waiting.detail.version !== detail?.version) pollBalancePreview();
      waiting.detail = undefined;
    }
    if (waiting.list !== undefined && groupBalancesSettled) {
      if (waiting.list !== groupBalancesData?.version) pollGroupBalanceList();
      waiting.list = undefined;
    }
  }, [groupId, detail, detailSettled, groupBalancesData, groupBalancesSettled, pollBalancePreview, pollGroupBalanceList]);
  useSync((c, prev) => {
    if (groupBalanceOpen) pollBalancePreview();
    if (c.activityCursor !== prev.activityCursor) pollGroupBalanceList();
    if (versionCheck.current) return;
    versionCheck.current = true;
    const tickGroup = groupId;
    api<{ detail: string; list: string; recurringDue: boolean }>(`/api/groups/${tickGroup}/version`)
      .then((v) => {
        const now = latest.current;
        if (now.groupId !== tickGroup) return;
        if (!now.detailSettled) deferred.current.detail = { version: v.detail, due: v.recurringDue };
        else if (v.recurringDue || v.detail !== now.detail?.version) pollBalancePreview();
        if (!now.listSettled) deferred.current.list = v.list;
        else if (v.list !== now.list?.version) pollGroupBalanceList();
      })
      .catch(() => {
        pollBalancePreview();
        pollGroupBalanceList();
      })
      .finally(() => { versionCheck.current = false; });
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
  const [settleChooserOpen, setSettleChooserOpen] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [recurringOpen, setRecurringOpen] = useState(false);
  const [recurringListOpen, setRecurringListOpen] = useState(false);
  const [editingRecurring, setEditingRecurring] = useState<ExistingRecurring | null>(null);
  const [editingSettlement, setEditingSettlement] = useState<Settlement | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [memberQuery, setMemberQuery] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  function copyInviteLink() {
    if (!detail) return;
    navigator.clipboard.writeText(`${window.location.origin}/signup?invite=${detail.group.inviteCode}`)
      .then(() => toast("Invite link copied. Anyone who opens it can join this group."))
      .catch(() => toast("Could not copy the invite link. Try again.", { tone: "error" }));
  }

  // Reset to the first page whenever the filters change.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setExpenseLimit(50);
  }, [filters]);

  const applyQuery = useCallback((searchParams: URLSearchParams) => {
    if (searchParams.get("add") === "1") {
      // Deep links may request the add-expense modal.
      setEditing(null);
      setExpenseOpen(true);
    }
    const t = searchParams.get("tab");
    if (t && ["expenses", "balances", "insights", "chat", "activity"].includes(t)) {
      setTab(t as Tab);
    }
    const expenseId = Number(searchParams.get("expense"));
    if (Number.isInteger(expenseId) && expenseId > 0) {
      setTab("expenses");
      setDetailId(expenseId);
    }
    if (searchParams.get("add") === "1" || t || expenseId > 0) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

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
      toast(e instanceof ApiClientError ? e.message : "Could not open group balance", { tone: "error" });
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
      toast(e instanceof ApiClientError ? e.message : "Could not load group balances", { tone: "error" });
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
    if (!(await confirmAction({
      title: "Delete group balance?",
      message: `Delete “${row.title}”? Group debts will update. This does not record a payment.`,
      confirmLabel: "Delete group balance",
      danger: true,
    }))) return;
    try {
      await api(`/api/group-balances/${row.id}?expectedUpdatedAt=${encodeURIComponent(row.updatedAt)}`, { method: "DELETE" });
      afterGroupBalanceMutation();
      toast("Group balance deleted");
    } catch (e) {
      toast(e instanceof ApiClientError ? e.message : "Could not delete group balance", { tone: "error" });
    }
  }

  async function deleteExpense(expense: Expense) {
    if (!(await confirmAction({
      title: "Delete expense?",
      message: <>Delete <strong className="text-ink">{expense.title}</strong> ({fmtMoney(expense.amountCents, expense.currency)})? Balances will update for everyone. This can&apos;t be undone.</>,
      confirmLabel: "Delete expense",
      danger: true,
    }))) return;
    try {
      await api(`/api/expenses/${expense.id}?expectedUpdatedAt=${encodeURIComponent(expense.updatedAt)}`, { method: "DELETE" });
      toast("Expense deleted");
      refreshAll();
    } catch (err) {
      // A concurrent edit (stale version → 400), a delete by another member (404),
      // or a network error must surface.
      toast(err instanceof ApiClientError ? err.message : "Could not delete this expense", { tone: "error" });
      refreshAll();
    }
  }

  async function stopRecurring(r: { id: number; title: string; updatedAt: string }) {
    if (!(await confirmAction({
      title: "Stop recurring expense?",
      message: `Stop “${r.title}”? Expenses it already added are kept.`,
      confirmLabel: "Stop recurring",
      danger: true,
    }))) return;
    try {
      await api(`/api/recurring/${r.id}?expectedUpdatedAt=${encodeURIComponent(r.updatedAt)}`, { method: "DELETE" });
      toast("Recurring expense stopped");
      loadDetail();
    } catch (e) {
      toast(e instanceof ApiClientError ? e.message : "Could not stop the recurring expense", { tone: "error" });
    }
  }

  async function deletePayment(s: Settlement) {
    if (!(await confirmAction({
      title: "Delete payment?",
      message: `Delete the recorded payment of ${fmtMoney(s.amountCents, s.currency)} from ${s.payerName} to ${s.recipientName}? Balances will update.`,
      confirmLabel: "Delete payment",
      danger: true,
    }))) return;
    try {
      await api(`/api/settlements/${s.id}?expectedUpdatedAt=${encodeURIComponent(s.updatedAt)}`, { method: "DELETE" });
      toast("Payment deleted");
      refreshAll();
    } catch (e) {
      toast(e instanceof ApiClientError ? e.message : "Could not delete the payment", { tone: "error" });
    }
  }

  const query = <Suspense fallback={null}><GroupQuery onQuery={applyQuery} /></Suspense>;

  if (loadError) {
    return (
      <AppShell title="Group">
        {query}
        <EmptyState title={loadError} action={<Link href="/groups"><Button variant="secondary">Back to groups</Button></Link>} />
      </AppShell>
    );
  }

  const memberName = (uid: number) => detail?.members.find((m) => m.id === uid)?.displayName ?? "Someone";
  const visibleBalances = detail?.balances.filter((b) => {
    const q = memberQuery.trim().toLowerCase();
    return !q || b.displayName.toLowerCase().includes(q);
  }) ?? [];

  // Every section stays one tap away on every screen size; the least-used one goes last.
  const TABS: { key: Tab; label: string; icon: typeof Receipt }[] = [
    { key: "expenses", label: "Expenses", icon: Receipt },
    { key: "balances", label: "Balances", icon: Scale },
    { key: "chat", label: "Chat", icon: MessageSquare },
    { key: "activity", label: "Activity", icon: ScrollText },
    { key: "insights", label: "Insights", icon: PieChart },
  ];
  function moveTabFocus(event: React.KeyboardEvent<HTMLButtonElement>, key: Tab) {
    const index = TABS.findIndex((item) => item.key === key);
    let nextIndex = index;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = TABS.length - 1;
    else return;
    event.preventDefault();
    const next = TABS[nextIndex].key;
    const tablist = event.currentTarget.closest('[role="tablist"]');
    setTab(next);
    requestAnimationFrame(() => tablist?.querySelector<HTMLButtonElement>(`[data-group-tab="${next}"]`)?.focus());
  }
  const canSettle = (detail?.members.length ?? 0) >= 2;
  const myGroupBalance = me && detail
    ? detail.balances.find((balance) => balance.userId === me.id)?.netCents ?? 0
    : 0;
  const mySuggestions = me && detail ? detail.suggestions.filter((s) => s.from === me.id || s.to === me.id) : [];
  const currency = detail?.group.currency ?? "USD";

  function openSettle() {
    // The suggested payments already know who pays whom and how much. With one,
    // open it ready to record; with several, let the user pick; with none, start blank.
    if (mySuggestions.length === 1) {
      const s = mySuggestions[0];
      setSettlePrefill({ payerId: s.from, recipientId: s.to, amountCents: s.amountCents });
      setSettleOpen(true);
    } else if (mySuggestions.length > 1) {
      setSettleChooserOpen(true);
    } else {
      setSettlePrefill(null);
      setSettleOpen(true);
    }
  }
  function settleCustom() {
    setSettleChooserOpen(false);
    setSettlePrefill(null);
    setSettleOpen(true);
  }

  const monthOf = (date: string) => new Date(String(date).slice(0, 10) + "T00:00:00")
    .toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const filterCount = [filters.cat, filters.payer, filters.from, filters.to].filter(Boolean).length;

  const suggestionText = (s: { from: number; to: number }) => (
    <>
      <Link href={`/people/${s.from}`} className="font-semibold hover:text-accent-dark hover:underline">{s.from === me?.id ? "You" : memberName(s.from)}</Link>
      {s.from === me?.id ? " pay " : " should pay "}
      <Link href={`/people/${s.to}`} className="font-semibold hover:text-accent-dark hover:underline">{s.to === me?.id ? "you" : memberName(s.to)}</Link>
    </>
  );

  return (
    <AppShell title={detail?.group.name ?? "Group"}>
      {query}
      <section className={`group-context group-hue-${groupId % 6} mb-2.5 md:shrink-0 lg:grid lg:grid-cols-[minmax(0,1fr)_auto_minmax(9rem,auto)] lg:items-center lg:gap-x-4`} aria-label="Current group">
        <div className="flex items-center gap-1.5">
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
            {/* Items that need the loaded group stay disabled until it arrives,
                instead of silently doing nothing on a fresh page. */}
            <MenuItem icon={<Copy className="h-4 w-4" />} onClick={copyInviteLink} disabled={!detail}>Copy invite link</MenuItem>
            <MenuItem icon={<RefreshCcw className="h-4 w-4" />} onClick={() => setRecurringListOpen(true)}>Recurring expenses</MenuItem>
            <MenuItem icon={<Download className="h-4 w-4" />} onClick={() => { window.location.href = `/api/groups/${groupId}/export`; }}>Export CSV</MenuItem>
            <MenuItem icon={<Settings className="h-4 w-4" />} onClick={() => setSettingsOpen(true)} disabled={!detail}>Group settings</MenuItem>
          </Menu>
        </div>

        {/* Below lg the balance and the action it justifies share one row.
            `lg:contents` hands both straight to the section's grid at lg. */}
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 lg:mt-0 lg:contents">
          {detail ? (
            <p className={`tnum whitespace-nowrap text-amount font-semibold tracking-tight ${myGroupBalance > 0 ? "text-owed" : myGroupBalance < 0 ? "text-owe" : "text-[var(--group-ink)]"}`}>
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
            onClick={openSettle}
          >
            <HandCoins className="h-4 w-4" /> Settle up
          </Button>
        </div>
      </section>

      {/* Members rail (wide screens) — a nested sidebar instead of a full-width
          horizontal strip. Below lg it would squeeze the list, so member nets
          move into the Balances tab there, as on phones. */}
      <div className="md:flex md:min-h-0 md:flex-1 md:gap-2.5">
      <Card className="hidden lg:flex lg:min-h-0 lg:w-52 lg:shrink-0 lg:flex-col">
        <CardHeader title="Members" meta={detail ? detail.members.length : undefined} />
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
        <div className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          {detail === null ? (
            <div className="space-y-2 p-3">
              {[...Array(4)].map((_, i) => <div key={i} className="skeleton h-8 w-full" />)}
            </div>
          ) : visibleBalances.length === 0 ? (
            <p className="px-3 py-3 text-body text-ink-faint">No members match.</p>
          ) : (
            <MemberNets balances={visibleBalances} currency={detail.group.currency} meId={me?.id} compact />
          )}
        </div>
      </Card>

      <div className="flex min-w-0 flex-col md:min-h-0 md:flex-1">
      <div role="tablist" aria-label="Group sections" className="mb-2 grid grid-cols-5 gap-0.5 rounded-xl border border-line bg-card p-1 md:shrink-0">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            aria-controls="group-tab-panel"
            data-group-tab={key}
            tabIndex={tab === key ? 0 : -1}
            onClick={() => setTab(key)}
            onKeyDown={(event) => moveTabFocus(event, key)}
            className={`flex min-h-[var(--control-h)] min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg px-0.5 py-1 text-meta font-medium transition-colors focus-visible:outline-none focus-visible:ring-[var(--focus-ring)] focus-visible:ring-accent-soft sm:flex-row sm:gap-1.5 sm:text-body ${
              tab === key ? "bg-accent-soft text-accent-dark" : "text-ink-soft hover:bg-subtle hover:text-ink"
            }`}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden />
            <span className="max-w-full truncate">{label}</span>
          </button>
        ))}
      </div>

      <div id="group-tab-panel" role="tabpanel" aria-label={`${TABS.find(({ key }) => key === tab)?.label} section`} className="md:min-h-0 md:flex-1 md:overflow-hidden">
      {tab === "expenses" && (
        <Card className="flex flex-col md:h-full md:min-h-0">
          {/* Search, filters, and the group's repeating expenses sit on the list
              they act on, not in a card of their own above it. */}
          <div className="flex items-center gap-1.5 border-b border-line p-2 md:shrink-0">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
              <Input value={filters.q} onChange={setFilter("q")} placeholder="Search expenses" className="pl-8" aria-label="Search expenses" />
            </div>
            <Button
              variant={showFilters || filtersActive ? "secondary" : "ghost"}
              onClick={() => setShowFilters((v) => !v)}
              aria-expanded={showFilters || filterCount > 0}
              aria-label={filterCount ? `Filters, ${filterCount} on` : "Filters"}
              className="min-w-[var(--control-h)] !px-2.5"
            >
              <SlidersHorizontal className="h-4 w-4" />
              <span className="hidden sm:inline">Filters</span>
              {filterCount > 0 && <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-meta font-bold text-on-accent">{filterCount}</span>}
            </Button>
            <Button
              variant="ghost"
              onClick={() => setRecurringListOpen(true)}
              aria-label={`Recurring expenses${recurring.length ? `, ${recurring.length}` : ""}`}
              className="min-w-[var(--control-h)] !px-2.5"
            >
              <RefreshCcw className="h-4 w-4" />
              <span className="hidden sm:inline">Recurring</span>
              {recurring.length > 0 && <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-subtle px-1 text-meta font-semibold text-ink-soft">{recurring.length}</span>}
            </Button>
          </div>
          {(showFilters || filterCount > 0) && (
            <div className="grid grid-cols-2 gap-2 border-b border-line p-2 md:shrink-0 lg:grid-cols-4">
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
              {filtersActive && (
                <button
                  onClick={resetFilters}
                  className="col-span-2 inline-flex min-h-[var(--control-h-sm)] items-center gap-1 justify-self-start rounded-lg px-1 text-body font-medium text-accent hover:bg-accent-soft lg:col-span-4"
                >
                  <X className="h-4 w-4" /> Clear filters
                </button>
              )}
            </div>
          )}
          <div className="md:min-h-0 md:flex-1 md:overflow-y-auto">
          {expenses === null ? (
            <div className="space-y-2 p-3">
              {[...Array(4)].map((_, i) => <div key={i} className="skeleton h-12 w-full" />)}
            </div>
          ) : expenses.length === 0 ? (
            <EmptyState
              icon={<Receipt className="h-6 w-6" />}
              title={filtersActive ? "No expenses match your filters" : "No expenses yet"}
              hint={filtersActive ? "Try clearing the filters." : "Add the first shared expense to get rolling."}
              action={
                filtersActive ? (
                  <Button variant="secondary" onClick={resetFilters}><X className="h-4 w-4" /> Clear filters</Button>
                ) : (
                  <Button onClick={() => { setEditing(null); setExpenseOpen(true); }}>
                    <Plus className="h-4 w-4" /> Add expense
                  </Button>
                )
              }
            />
          ) : (
            <ul>
              {expenses.map((e, index) => {
                const myShare = me ? (e.shares.find((s) => s.userId === me.id)?.convertedShareCents ?? 0) : 0;
                const month = monthOf(e.date);
                const newMonth = index === 0 || month !== monthOf(expenses[index - 1].date);
                const day = new Date(String(e.date).slice(0, 10) + "T00:00:00");
                return (
                  <li key={e.id}>
                    {newMonth && <SectionLabel className="border-b border-line bg-subtle px-3.5 py-1">{month}</SectionLabel>}
                    <div className="group flex min-h-[var(--row-h)] items-stretch gap-2 border-b border-line px-3.5">
                      <button
                        onClick={() => setDetailId(e.id)}
                        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg py-1.5 text-left focus-visible:outline-none focus-visible:ring-[var(--focus-ring)] focus-visible:ring-accent-soft"
                        aria-label={`View ${e.title}`}
                      >
                        <span className="w-9 shrink-0 text-center" aria-hidden>
                          <span className="block text-meta font-semibold uppercase text-ink-faint">{day.toLocaleDateString("en-US", { month: "short" })}</span>
                          <span className="block text-row font-semibold leading-none">{day.getDate()}</span>
                        </span>
                        <span className="min-w-0 flex-1">
                          <RowTitle>
                            {e.title}
                            {e.attachmentCount > 0 && <Paperclip className="ml-1.5 inline h-3.5 w-3.5 text-ink-faint" aria-label="Has receipt" />}
                          </RowTitle>
                          <RowMeta>
                            {e.payerId === me?.id ? "You" : e.payerName} paid
                            {e.categoryName ? ` · ${e.categoryName}` : ""}
                            {e.currency !== detail?.group.currency && ` · ${fmtMoney(e.amountCents, e.currency)}`}
                          </RowMeta>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="tnum block text-body font-semibold">{fmtMoney(e.convertedCents, detail?.group.currency ?? e.currency)}</span>
                          <span className={`block text-meta font-medium ${
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
                          </span>
                        </span>
                      </button>
                      <div className="hidden shrink-0 items-center gap-0.5 sm:flex">
                        <IconButton size="sm" variant="accent" label={`Edit ${e.title}`} onClick={() => openEdit(e.id)}>
                          <Pencil className="h-4 w-4" />
                        </IconButton>
                        <IconButton size="sm" variant="danger" label={`Delete ${e.title}`} onClick={() => deleteExpense(e)}>
                          <Trash2 className="h-4 w-4" />
                        </IconButton>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {expenses && expenses.length > 0 && hasMoreExpenses && (
            <div className="p-3 text-center">
              <Button variant="secondary" onClick={() => setExpenseLimit((l) => l + 50)}>
                Load more
              </Button>
            </div>
          )}
          </div>
        </Card>
      )}

      {tab === "insights" && (
        <div className="md:h-full md:overflow-y-auto">
          {insightExpenses === null && !insightError && (
            <div role="status" className="grid grid-cols-1 gap-3 lg:grid-cols-3">
              <span className="sr-only">Loading insights…</span>
              {[...Array(3)].map((_, index) => <Card key={index} className="p-4"><div className="skeleton h-40 w-full" /></Card>)}
            </div>
          )}
          {insightError && (
            <Card className="p-4">
              <div role="alert" className="flex flex-wrap items-center justify-between gap-3 text-body text-danger">
                <p>{insightError}</p>
                <Button variant="secondary" onClick={reloadInsights}>Try again</Button>
              </div>
            </Card>
          )}
          {insightExpenses && insightExpenses.length > 0 && detail && (
            <SpendCharts expenses={insightExpenses} currency={detail.group.currency} />
          )}
          {insightExpenses?.length === 0 && (
            <Card><EmptyState icon={<PieChart className="h-6 w-6" />} title="No insights yet" hint="Add a few expenses to see spending by category, over time, and by person." /></Card>
          )}
        </div>
      )}

      {tab === "balances" && detail && (
        <div className="space-y-2.5 md:h-full md:overflow-y-auto">
        <Card>
          <CardHeader title="Who owes who" />
          {detail.suggestions.length === 0 ? (
            <EmptyState icon={<Scale className="h-6 w-6" />} title="All settled up" hint="Nobody owes anything in this group right now." />
          ) : (
            <ul className="divide-y divide-line">
              {detail.suggestions.map((s, i) => {
                const mine = me?.id === s.from || me?.id === s.to;
                return (
                  <li key={i} className="flex min-h-[var(--row-h)] items-center gap-3 px-4 py-1.5">
                    <Avatar name={memberName(s.from)} size="sm" />
                    <span className="min-w-0 flex-1 text-body">{suggestionText(s)}</span>
                    <span className={`tnum shrink-0 text-row font-semibold ${s.from === me?.id ? "text-owe" : s.to === me?.id ? "text-owed" : ""}`}>{fmtMoney(s.amountCents, detail.group.currency)}</span>
                    {mine && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setSettlePrefill({ payerId: s.from, recipientId: s.to, amountCents: s.amountCents });
                          setSettleOpen(true);
                        }}
                        aria-label={`Record payment: ${memberName(s.from)} pays ${memberName(s.to)}`}
                      >
                        <HandCoins className="h-4 w-4" /> <span className="hidden sm:inline">Record payment</span><span className="sm:hidden">Record</span>
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {/* Below lg there is no members rail, so each member's net lives here. */}
        <Card className="lg:hidden">
          <CardHeader title="Member balances" meta={detail.members.length} />
          <MemberNets balances={detail.balances} currency={detail.group.currency} meId={me?.id} />
        </Card>

        <Card>
          <CardHeader title="Group balances" action={
            <Button size="sm" variant="ghost" onClick={() => {
              setEditingGroupBalance(null); setGroupBalanceOpen(true);
            }}>
              <Plus className="h-4 w-4" /> Add group balance
            </Button>
          } />
          {groupBalancesError ? (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-body text-danger">
              <p>{groupBalancesError}</p>
              <Button variant="secondary" onClick={reloadGroupBalanceList}>Try again</Button>
            </div>
          ) : groupBalancesData === null ? (
            <div className="space-y-2 p-3"><div className="skeleton h-10 w-full" /></div>
          ) : groupBalancesData.balances.length === 0 ? (
            <p className="px-4 py-3 text-body text-ink-faint">No group balances yet. Add obligations without recording a payment.</p>
          ) : <>
            <ul className="divide-y divide-line">
              {[...groupBalancesData.balances, ...(activeExtraGroupBalancePage?.balances ?? [])].map((row) => <li key={row.id} className="flex min-h-[var(--row-h)] items-center gap-2 px-4 py-1.5">
                <button type="button" onClick={() => openGroupBalance(row.id)} className="min-h-[var(--control-h)] min-w-0 flex-1 truncate rounded-lg text-left text-row font-medium hover:text-accent-dark">
                  {row.title}
                </button>
                <span className="tnum shrink-0 text-body font-semibold">{fmtMoney(row.amountCents, detail.group.currency)}</span>
                <IconButton size="sm" variant="accent" label={`Edit ${row.title}`} onClick={() => openGroupBalance(row.id)}><Pencil className="h-4 w-4" /></IconButton>
                <IconButton size="sm" variant="danger" label={`Delete ${row.title}`} onClick={() => removeGroupBalance(row)}><Trash2 className="h-4 w-4" /></IconButton>
              </li>)}
            </ul>
            {(activeExtraGroupBalancePage?.hasMore ?? groupBalancesData.hasMore) && <div className="border-t border-line p-3 text-center"><Button variant="secondary" busy={loadingGroupBalances} onClick={loadMoreGroupBalances}>Load more</Button></div>}
          </>}
        </Card>

        <Card>
          <CardHeader title="Recorded payments" />
          {settlements === null ? (
            <div className="space-y-2 p-3">{[...Array(2)].map((_, i) => <div key={i} className="skeleton h-10 w-full" />)}</div>
          ) : settlements.length === 0 ? (
            <p className="px-4 py-3 text-body text-ink-faint">No payments recorded yet. When someone settles up offline, record it here so balances stay accurate.</p>
          ) : (
            <ul className="divide-y divide-line">
              {settlements.map((s) => (
                <li key={s.id} className="flex min-h-[var(--row-h)] items-center gap-2 px-4 py-1.5">
                  <HandCoins className="h-4 w-4 shrink-0 text-owed" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-body">
                      <Link href={`/people/${s.payerId}`} className="font-semibold hover:text-accent-dark hover:underline">{s.payerName}</Link>{" "}
                      paid{" "}
                      <Link href={`/people/${s.recipientId}`} className="font-semibold hover:text-accent-dark hover:underline">{s.recipientName}</Link>
                    </span>
                    <RowMeta>
                      {fmtDate(s.date)}
                      {s.note ? ` · ${s.note}` : ""}
                      {s.currency !== detail.group.currency ? ` · ${fmtMoney(s.amountCents, s.currency)}` : ""}
                    </RowMeta>
                  </span>
                  <span className="tnum shrink-0 text-body font-semibold">{fmtMoney(s.amountCents, s.currency)}</span>
                  <IconButton size="sm" variant="accent" label="Edit payment" onClick={() => setEditingSettlement(s)}>
                    <Pencil className="h-4 w-4" />
                  </IconButton>
                  <IconButton size="sm" variant="danger" label="Delete payment" onClick={() => deletePayment(s)}>
                    <Trash2 className="h-4 w-4" />
                  </IconButton>
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
            <EmptyState icon={<ScrollText className="h-6 w-6" />} title="No activity yet" />
          ) : (
            <ul className="divide-y divide-line">
              {activity.map((a) => (
                <li key={a.id} className="px-4 py-2">
                  <ActivitySummary activity={a} />
                  <RowMeta>{fmtTime(a.createdAt)}</RowMeta>
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

      {/* Settle up with several suggested payments: pick one, or record another. */}
      <Modal open={settleChooserOpen} onClose={() => setSettleChooserOpen(false)} title="Settle up">
        <p className="mb-2 text-body text-ink-soft">These payments clear your balance in this group.</p>
        <ul className="divide-y divide-line rounded-xl border border-line">
          {mySuggestions.map((s, i) => (
            <li key={i} className="flex min-h-[var(--row-h)] items-center gap-3 px-3 py-1.5">
              <span className="min-w-0 flex-1 text-body">{suggestionText(s)}</span>
              <span className={`tnum shrink-0 text-row font-semibold ${s.from === me?.id ? "text-owe" : "text-owed"}`}>{fmtMoney(s.amountCents, currency)}</span>
              <Button
                size="sm"
                onClick={() => {
                  setSettleChooserOpen(false);
                  setSettlePrefill({ payerId: s.from, recipientId: s.to, amountCents: s.amountCents });
                  setSettleOpen(true);
                }}
                aria-label={`Record payment: ${memberName(s.from)} pays ${memberName(s.to)}`}
              >
                Record
              </Button>
            </li>
          ))}
        </ul>
        <button type="button" onClick={settleCustom} className="mt-2 inline-flex min-h-[var(--control-h-sm)] items-center rounded-lg px-1 text-body font-medium text-accent hover:bg-accent-soft">
          Record a different payment
        </button>
      </Modal>

      {/* The group's repeating expenses, managed next to the list they add to. */}
      <Modal
        open={recurringListOpen}
        onClose={() => setRecurringListOpen(false)}
        title="Recurring expenses"
        footer={<Button onClick={() => setRecurringOpen(true)}><Plus className="h-4 w-4" /> Add recurring</Button>}
      >
        {recurring.length === 0 ? (
          <p className="text-body text-ink-faint">No recurring expenses. Rent, subscriptions, and bills can repeat weekly or monthly.</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {recurring.map((r) => (
              <li key={r.id} className="flex min-h-[var(--row-h)] items-center gap-2 px-3 py-1.5">
                <RefreshCcw className="h-4 w-4 shrink-0 text-ink-faint" />
                <span className="min-w-0 flex-1">
                  <RowTitle>{r.title}</RowTitle>
                  <RowMeta>{r.cadence === "weekly" ? "Weekly" : "Monthly"} · next {fmtDate(r.nextDate)} · {r.payerName} pays</RowMeta>
                </span>
                <span className="tnum shrink-0 text-body font-semibold">{fmtMoney(r.amountCents, r.currency)}</span>
                <IconButton
                  size="sm"
                  variant="accent"
                  label={`Edit ${r.title}`}
                  onClick={() => setEditingRecurring({
                    id: r.id, title: r.title, amountCents: r.amountCents, payerId: r.payerId,
                    currency: r.currency, categoryId: r.categoryId, participantIds: r.participantIds,
                    notes: r.notes, cadence: r.cadence as "weekly" | "monthly", nextDate: r.nextDate,
                    anchorDay: r.anchorDay, active: r.active, updatedAt: r.updatedAt,
                  })}
                >
                  <Pencil className="h-4 w-4" />
                </IconButton>
                <IconButton size="sm" variant="danger" label={`Stop ${r.title}`} onClick={() => stopRecurring(r)}>
                  <Trash2 className="h-4 w-4" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Modal>

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
            balanceListCursor={groupBalancesData?.changeCursor ?? null}
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
            onCustom={settleCustom}
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
            if (exp) void deleteExpense(exp);
          }}
        />
      )}
    </AppShell>
  );
}

/** Each member's net in the group: sign, word for screen readers, and color. */
function MemberNets({ balances, currency, meId, compact = false }: {
  balances: { userId: number; displayName: string; netCents: number }[];
  currency: string;
  meId?: number;
  compact?: boolean;
}) {
  return (
    <ul className="divide-y divide-line">
      {balances.map((b) => (
        <li key={b.userId}>
          <Link href={`/people/${b.userId}`} className={`flex min-h-[var(--control-h)] items-center gap-2 hover:bg-subtle ${compact ? "px-3 py-1" : "px-4 py-1.5"}`}>
            <Avatar name={b.displayName} size="sm" />
            <span className={`min-w-0 flex-1 truncate font-medium ${compact ? "text-body" : "text-row"}`} title={b.displayName}>
              {b.displayName}{b.userId === meId && !compact ? " (you)" : ""}
            </span>
            <span className="tnum shrink-0 text-body font-semibold">
              {b.netCents === 0 ? (
                <span className="font-normal text-ink-faint">settled</span>
              ) : (
                <>
                  <span className="sr-only">{b.netCents > 0 ? "is owed " : "owes "}</span>
                  <Money cents={b.netCents} currency={currency} signed />
                </>
              )}
            </span>
          </Link>
        </li>
      ))}
    </ul>
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
        {/* From sm up, name and metadata share one baseline. On a phone the
            metadata would leave the name no width, so it drops below it. */}
        <span className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-baseline sm:gap-1.5">
          <span className="min-w-0 truncate text-title font-semibold tracking-tight">{currentName}</span>
          <span className="shrink-0 text-meta font-medium text-[var(--group-muted)]">{memberCount} {memberCount === 1 ? "member" : "members"} · {currency}</span>
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
              <p role="status" className="px-3 py-2.5 text-body text-ink-faint">Loading groups…</p>
            ) : groups.map((g) => (
              <Link
                key={g.id}
                href={`/groups/${g.id}`}
                role="option"
                aria-selected={g.id === currentId}
                tabIndex={g.id === currentId ? 0 : -1}
                onClick={() => setOpen(false)}
                className={`group-hue-${g.id % 6} flex min-h-[var(--row-h)] items-center gap-3 rounded-lg px-2.5 py-1.5 hover:bg-subtle focus-visible:bg-subtle focus-visible:outline-none ${g.id === currentId ? "bg-subtle" : ""}`}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--group-soft)] text-[var(--group-ink)]">
                  <Users className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <RowTitle>{g.name}</RowTitle>
                  <RowMeta>{g.memberCount} {g.memberCount === 1 ? "member" : "members"} · {g.currency}</RowMeta>
                </span>
                <span className={`tnum text-body font-semibold ${g.myNetCents > 0 ? "text-owed" : g.myNetCents < 0 ? "text-owe" : "text-ink-faint"}`}>
                  {g.myNetCents === 0 ? "settled" : <Money cents={g.myNetCents} currency={g.currency} signed />}
                </span>
                {!!g.unreadMessages && <span className="h-2 w-2 shrink-0 rounded-full bg-accent" aria-label="Unread messages" />}
              </Link>
            ))}
          </div>
          <Link href="/groups" className="mt-1 flex min-h-[var(--control-h)] items-center border-t border-line px-3 text-body font-medium text-accent hover:bg-subtle">
            All groups
          </Link>
        </div>
      )}
    </div>
  );
}
