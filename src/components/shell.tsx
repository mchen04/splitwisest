"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useEffect, useState } from "react";
import {
  LayoutDashboard, Users, Scale, Receipt, LogOut, Wallet,
  MessageSquare, ScrollText, Moon, Sun, Plus, ChevronDown, Bell,
} from "lucide-react";
import { api, useApiData, useMe, useUnread, type Unread } from "@/lib/client";
import { useTheme } from "@/lib/theme";
import { syncExistingPush } from "@/lib/push-client";
import { defaultExpenseGroup, readExpenseGroup } from "@/lib/last-group";
import { Avatar, ConfirmHost, IconButton, ToastRegion } from "./ui";
import { QuickAddExpense } from "./quick-add-expense";

interface GroupRef {
  id: number;
  name: string;
  currency: string;
  memberCount: number;
  myNetCents: number;
  unreadMessages?: number;
}

type BadgeKey = keyof Unread;

const NAV: { href: string; label: string; icon: typeof LayoutDashboard; badge?: BadgeKey }[] = [
  { href: "/", label: "Home", icon: LayoutDashboard },
  { href: "/groups", label: "Groups", icon: Users },
  { href: "/balances", label: "Balances", icon: Scale, badge: "balances" },
  { href: "/expenses", label: "Expenses", icon: Receipt },
  { href: "/chat", label: "Chat", icon: MessageSquare, badge: "messages" },
  { href: "/activity", label: "Activity", icon: ScrollText, badge: "activity" },
  { href: "/notifications", label: "Notifications", icon: Bell, badge: "notifications" },
];

const MOBILE_NAV: { href: string; label: string; icon: typeof LayoutDashboard; badge?: BadgeKey }[] = [
  { href: "/", label: "Home", icon: LayoutDashboard, badge: "notifications" },
  { href: "/groups", label: "Groups", icon: Users },
  { href: "/balances", label: "Balances", icon: Scale, badge: "balances" },
  { href: "/chat", label: "Chat", icon: MessageSquare, badge: "messages" },
];

function Badge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-meta font-bold leading-none text-on-accent">
      {count > 9 ? "9+" : count}
    </span>
  );
}

function MobileNavLink({ href, label, icon: Icon, badge, active, count }: {
  href: string; label: string; icon: typeof LayoutDashboard; badge?: BadgeKey; active: boolean; count: number;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      aria-label={badge && count > 0 ? `${label}, ${count > 9 ? "9+" : count} new` : label}
      className={`relative flex min-h-[var(--control-h)] flex-col items-center justify-center gap-0.5 py-1.5 text-meta font-medium ${
        active ? "text-accent" : "text-ink-faint"
      }`}
    >
      <span className="relative">
        <Icon className="h-5 w-5" aria-hidden />
        {badge && count > 0 && (
          <span aria-hidden className="absolute -right-2.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-meta font-bold leading-none text-on-accent">
            {count > 9 ? "9+" : count}
          </span>
        )}
      </span>
      <span aria-hidden>{label}</span>
    </Link>
  );
}

export function AppShell({ title, children }: { title?: string; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const me = useMe();
  const unread = useUnread();
  const { theme, toggle } = useTheme();
  const {
    data: groupsData,
    error: groupsError,
    reload: reloadGroups,
  } = useApiData<{ groups: GroupRef[] }>("/api/groups");
  const groups = groupsData?.groups ?? [];
  const currentGroupId = pathname.match(/^\/groups\/(\d+)/)?.[1];
  const isChatPage = pathname === "/chat";
  const [quickAdd, setQuickAdd] = useState<{ step: "closed" | "pick" | "form"; groupId: number | null }>({ step: "closed", groupId: null });

  useEffect(() => {
    if (!me) return;
    const refresh = () => { void syncExistingPush(me.id).catch(() => {}); };
    refresh();
    window.addEventListener("pageshow", refresh);
    window.addEventListener("focus", refresh);
    return () => { window.removeEventListener("pageshow", refresh); window.removeEventListener("focus", refresh); };
  }, [me]);

  const [groupsOpen, setGroupsOpen] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGroupsOpen(localStorage.getItem("nav.groupsOpen") !== "0");
  }, []);
  const toggleGroups = () => {
    setGroupsOpen((o) => {
      localStorage.setItem("nav.groupsOpen", o ? "0" : "1");
      return !o;
    });
  };

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  function openForGroups(list: GroupRef[]) {
    if (list.length === 0) {
      setQuickAdd({ step: "closed", groupId: null });
      router.push("/groups");
      return;
    }
    const groupId = defaultExpenseGroup(list.map((group) => group.id), readExpenseGroup());
    setQuickAdd(groupId === null ? { step: "pick", groupId: null } : { step: "form", groupId });
  }

  function launchExpense() {
    if (currentGroupId) {
      router.push(`/groups/${currentGroupId}?add=1`);
      return;
    }
    if (groupsData === null) {
      setQuickAdd({ step: "pick", groupId: null });
      return;
    }
    openForGroups(groups);
  }

  useEffect(() => {
    const resolvedGroups = groupsData?.groups;
    if (quickAdd.step !== "pick" || quickAdd.groupId !== null || !resolvedGroups) return;
    // A quick tap can open the picker before groups load. Apply the same
    // remembered-group and zero/one-group shortcuts once that request resolves.
    const groupId = defaultExpenseGroup(resolvedGroups.map((group) => group.id), readExpenseGroup());
    if (resolvedGroups.length === 0 || groupId !== null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      openForGroups(resolvedGroups);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickAdd.step, groupsData]);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <div className="app-frame">
      {/* Desktop / tablet sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-56 flex-col border-r border-line bg-card md:flex">
        <Link href="/" className="flex items-center gap-2 px-4 pb-3 pt-4">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-on-accent">
            <Wallet className="h-4 w-4" />
          </span>
          <span className="font-wordmark text-title font-semibold tracking-tight">SplitWisest</span>
        </Link>
        <div className="px-3 pb-2">
          <button
            type="button"
            onClick={launchExpense}
            className="flex min-h-[var(--control-h)] w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-body font-semibold text-on-accent transition-colors hover:bg-accent-dark focus-visible:outline-none focus-visible:ring-[var(--focus-ring)] focus-visible:ring-accent-soft"
          >
            <Plus className="h-4 w-4" /> Add expense
          </button>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 py-1">
          {NAV.map(({ href, label, icon: Icon, badge }) => (
            <div key={href}>
              <div
                className={`flex items-center rounded-lg transition-colors ${
                  isActive(href)
                    ? "bg-accent-soft text-accent-dark"
                    : "text-ink-soft hover:bg-subtle hover:text-ink"
                }`}
              >
                <Link href={href} aria-current={isActive(href) ? "page" : undefined} className="flex min-h-[var(--nav-h)] min-w-0 flex-1 items-center gap-2.5 px-2.5 py-1.5 text-body font-medium">
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="flex-1 truncate">{label}</span>
                  {badge && <Badge count={unread[badge]} />}
                </Link>
                {href === "/groups" && (groupsData?.groups?.length ?? 0) > 0 && (
                  <IconButton
                    size="sm"
                    onClick={() => toggleGroups()}
                    label={groupsOpen ? "Collapse group list" : "Expand group list"}
                    aria-expanded={groupsOpen}
                    className="mr-0.5"
                  >
                    <ChevronDown className={`h-3.5 w-3.5 transition-transform ${groupsOpen ? "rotate-180" : ""}`} />
                  </IconButton>
                )}
              </div>
              {href === "/groups" && groupsOpen && (
                <div className="mt-0.5 flex flex-col gap-0.5">
                  {groupsData?.groups?.map((g) => (
                    <Link
                      key={g.id}
                      href={`/groups/${g.id}`}
                      className={`group-hue-${g.id % 6} flex min-h-[var(--nav-h)] items-center gap-2 rounded-lg py-1 pl-7 pr-2.5 text-body transition-colors ${
                        pathname === `/groups/${g.id}`
                          ? "bg-accent-soft font-medium text-accent-dark"
                          : "text-ink-soft hover:bg-subtle hover:text-ink"
                      }`}
                    >
                      <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--group-color)]" aria-hidden />
                      <span className="min-w-0 flex-1 truncate" title={g.name}>{g.name}</span>
                      {!!g.unreadMessages && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-label="Unread messages" />}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          ))}
        </nav>
        <div className="border-t border-line p-2.5">
          <button
            onClick={toggle}
            className="mb-1 flex min-h-[var(--nav-h)] w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-body font-medium text-ink-soft hover:bg-subtle hover:text-ink"
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            <span className="flex-1 text-left">{theme === "dark" ? "Light mode" : "Dark mode"}</span>
          </button>
          {me && (
            <div className="flex items-center gap-1.5">
              <Link href="/settings" className="flex min-h-[var(--control-h)] min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1 hover:bg-subtle" title="Account settings">
                <Avatar name={me.displayName} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-body font-medium" title={me.displayName}>{me.displayName}</p>
                  <p className="truncate text-meta text-ink-faint" title={`@${me.username}`}>@{me.username}</p>
                </div>
              </Link>
              <IconButton label="Log out" variant="danger" onClick={logout}>
                <LogOut className="h-4 w-4" />
              </IconButton>
            </div>
          )}
        </div>
      </aside>

      {/* No route shows a title, but every route still needs one: without it
          these pages have no heading at all, and a screen reader announces
          nothing on navigation. */}
      <main className={`px-4 pt-3 sm:px-6 md:ml-56 md:h-dvh md:overflow-y-auto md:pb-6 md:pt-6 lg:px-8 ${isChatPage ? "app-fixed flex min-h-0 flex-1 flex-col overflow-hidden" : "app-scroll pb-4"}`}>
        <div className={`mx-auto flex w-full max-w-6xl flex-col md:h-full md:min-h-0 ${isChatPage ? "min-h-0 flex-1" : ""}`}>
          {title && <h1 className="sr-only">{title}</h1>}
          {children}
        </div>
      </main>

      {/* Mobile bottom nav */}
      <nav aria-label="Main" className="mobile-nav relative z-40 grid grid-cols-5 border-t border-line bg-card md:hidden">
        {MOBILE_NAV.slice(0, 2).map((item) => (
          <MobileNavLink key={item.href} {...item} active={isActive(item.href)} count={item.badge ? unread[item.badge] : 0} />
        ))}
        <button
          type="button"
          onClick={launchExpense}
          aria-label="Add expense"
          className="relative flex flex-col items-center gap-0.5 py-1.5 text-meta font-semibold text-accent"
        >
          <span className="-mt-5 flex h-11 w-11 items-center justify-center rounded-full border-4 border-paper bg-accent text-on-accent shadow-pop">
            <Plus className="h-5 w-5" />
          </span>
          Add
        </button>
        {MOBILE_NAV.slice(2).map((item) => (
          <MobileNavLink key={item.href} {...item} active={isActive(item.href)} count={item.badge ? unread[item.badge] : 0} />
        ))}
      </nav>

      <QuickAddExpense
        step={quickAdd.step}
        groupId={quickAdd.groupId}
        groups={groupsData?.groups ?? null}
        groupsError={groupsError}
        onRetryGroups={reloadGroups}
        onPick={(groupId) => setQuickAdd({ step: "form", groupId })}
        onClose={() => setQuickAdd({ step: "closed", groupId: null })}
      />
      <ConfirmHost />
      <ToastRegion />
    </div>
  );
}
