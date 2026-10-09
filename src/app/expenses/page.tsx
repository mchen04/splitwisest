"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Receipt, Search, SlidersHorizontal, X } from "lucide-react";
import { fmtMoney, fmtDate, useApiData, useFilters } from "@/lib/client";
import { AppShell } from "@/components/shell";
import { Card, EmptyState, Input, Select, Button, Chip, DateField, RowMeta, RowTitle, SectionLabel } from "@/components/ui";

interface Expense {
  id: number;
  groupId: number;
  groupName: string;
  title: string;
  amountCents: number;
  currency: string;
  date: string;
  payerName: string;
  categoryName: string | null;
  splitMethod: string;
}

const EMPTY_FILTERS = { q: "", groupId: "", categoryId: "", friendId: "", from: "", to: "" };

const monthOf = (date: string) => new Date(String(date).slice(0, 10) + "T00:00:00")
  .toLocaleDateString("en-US", { month: "long", year: "numeric" });

export default function ExpensesPage() {
  const { filters, setFilter, reset, active: filtersActive } = useFilters(EMPTY_FILTERS);
  const [limit, setLimit] = useState(50);
  const [showFilters, setShowFilters] = useState(false);

  // Reset to the first page whenever the filters change.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLimit(50);
  }, [filters]);

  const params = new URLSearchParams();
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.groupId) params.set("groupId", filters.groupId);
  if (filters.categoryId) params.set("categoryId", filters.categoryId);
  if (filters.friendId) params.set("friendId", filters.friendId);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  params.set("limit", String(limit));
  const { data } = useApiData<{ expenses: Expense[]; hasMore: boolean }>(`/api/expenses?${params}`, filters.q.trim() ? 250 : 0);
  const expenses = data?.expenses ?? null;
  const hasMore = data?.hasMore ?? false;
  const { data: groupsData } = useApiData<{ groups: { id: number; name: string }[] }>("/api/groups", 0, { sync: false });
  const { data: friendsData } = useApiData<{ friends: { id: number; displayName: string }[] }>("/api/friends", 0, { sync: false });
  const { data: categoriesData } = useApiData<{ categories: { id: number; name: string }[] }>("/api/categories", 0, { sync: false });
  const groups = groupsData?.groups ?? [];
  const friends = friendsData?.friends ?? [];
  const categories = categoriesData?.categories ?? [];
  const filterCount = [filters.groupId, filters.categoryId, filters.friendId, filters.from, filters.to].filter(Boolean).length;
  const filtersShown = showFilters || filterCount > 0;

  return (
    <AppShell title="All expenses">
      <Card className="mb-3 md:shrink-0">
        <div className="flex items-center gap-1.5 p-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
            <Input value={filters.q} onChange={setFilter("q")} placeholder="Search all expenses" className="pl-8" aria-label="Search expenses" enterKeyHint="search" />
          </div>
          {/* Phones fold the five filters away until asked for; desktop keeps them in one row. */}
          <Button
            variant={filtersShown ? "secondary" : "ghost"}
            onClick={() => setShowFilters((v) => !v)}
            aria-expanded={filtersShown}
            aria-label={filterCount ? `Filters, ${filterCount} on` : "Filters"}
            className="min-w-[var(--control-h)] !px-2.5 md:hidden"
          >
            <SlidersHorizontal className="h-4 w-4" />
            {filterCount > 0 && <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-meta font-bold text-on-accent">{filterCount}</span>}
          </Button>
        </div>
        <div className={`${filtersShown ? "grid" : "hidden"} grid-cols-2 gap-2 border-t border-line p-2 md:grid md:grid-cols-3 lg:grid-cols-5`}>
          <Select value={filters.groupId} onChange={setFilter("groupId")} aria-label="Filter by group">
            <option value="">All groups</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </Select>
          <Select value={filters.categoryId} onChange={setFilter("categoryId")} aria-label="Filter by category">
            <option value="">All categories</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <div className="col-span-2 md:col-span-1">
            <Select value={filters.friendId} onChange={setFilter("friendId")} aria-label="Filter by friend">
              <option value="">Any friend</option>
              {friends.map((f) => <option key={f.id} value={f.id}>{f.displayName}</option>)}
            </Select>
          </div>
          <DateField label="From" value={filters.from} onChange={setFilter("from")} aria-label="From date" />
          <DateField label="To" value={filters.to} onChange={setFilter("to")} aria-label="To date" />
        </div>
        {filtersActive && (
          <div className="border-t border-line px-2 py-1">
            <button
              onClick={reset}
              className="inline-flex min-h-[var(--control-h-sm)] items-center gap-1 rounded-lg px-1 text-body font-medium text-accent hover:bg-accent-soft"
            >
              <X className="h-4 w-4" /> Clear search and filters
            </button>
          </div>
        )}
      </Card>

      <Card className="flex flex-col md:min-h-0 md:flex-1">
        <div className="md:min-h-0 md:flex-1 md:overflow-y-auto">
        {expenses === null ? (
          <div className="space-y-2 p-3">{[...Array(5)].map((_, i) => <div key={i} className="skeleton h-12 w-full" />)}</div>
        ) : expenses.length === 0 ? (
          <EmptyState
            icon={<Receipt className="h-6 w-6" />}
            title={filtersActive ? "No expenses match" : "No expenses yet"}
            hint={filtersActive ? "Try loosening the filters." : "Expenses you add in any group will appear here."}
            action={filtersActive ? <Button variant="secondary" onClick={reset}><X className="h-4 w-4" /> Clear search and filters</Button> : undefined}
          />
        ) : (
          <ul>
            {expenses.map((e, index) => {
              const month = monthOf(e.date);
              const newMonth = index === 0 || month !== monthOf(expenses[index - 1].date);
              return (
                <li key={e.id}>
                  {newMonth && <SectionLabel className="border-b border-line bg-subtle px-4 py-1">{month}</SectionLabel>}
                  <Link href={`/groups/${e.groupId}?expense=${e.id}`} className="flex min-h-[var(--row-h)] items-center gap-3 border-b border-line px-4 py-1.5 hover:bg-subtle">
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <RowTitle className="min-w-0">{e.title}</RowTitle>
                        <Chip className="max-w-[45%] shrink-0 truncate">{e.groupName}</Chip>
                      </span>
                      <RowMeta>
                        {fmtDate(e.date)} · {e.payerName} paid{e.categoryName ? ` · ${e.categoryName}` : ""}
                      </RowMeta>
                    </span>
                    <span className="tnum shrink-0 text-body font-semibold">{fmtMoney(e.amountCents, e.currency)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        {expenses && expenses.length > 0 && hasMore && (
          <div className="p-3 text-center">
            <Button variant="secondary" onClick={() => setLimit((l) => l + 50)}>Load more</Button>
          </div>
        )}
        </div>
      </Card>
    </AppShell>
  );
}
