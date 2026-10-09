"use client";

import {
  cloneElement, isValidElement, ReactNode, useEffect, useRef, useState, useSyncExternalStore,
  ButtonHTMLAttributes, InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes,
} from "react";
import Link from "next/link";
import { X, Loader2, Inbox, ChevronDown, MoreHorizontal, Check, AlertCircle } from "lucide-react";

/* ── Buttons ───────────────────────────────────────────────────────────── */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent-dark",
  secondary: "bg-card border border-line text-ink hover:bg-subtle hover:border-line-strong",
  ghost: "text-ink-soft hover:bg-subtle hover:text-ink",
  danger: "bg-danger-soft text-danger hover:bg-danger hover:text-on-danger",
};

export function Button({
  variant = "primary",
  busy = false,
  size = "md",
  className = "",
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  busy?: boolean;
  size?: "md" | "sm";
}) {
  const sizing = size === "sm"
    ? "min-h-[var(--control-h-sm)] px-2.5 gap-1"
    : "min-h-[var(--control-h)] px-3.5 gap-1.5";
  return (
    <button
      className={`inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-lg py-1.5 text-body font-semibold transition-colors focus-visible:outline-none focus-visible:ring-[var(--focus-ring)] focus-visible:ring-accent-soft disabled:pointer-events-none ${
        // Busy keeps the variant color (with a spinner); a genuinely-disabled
        // (invalid) button uses a readable neutral instead of a low-contrast 50%
        // tint so its label stays legible.
        busy ? "opacity-80" : "disabled:bg-subtle disabled:text-ink-soft disabled:shadow-none"
      } ${sizing} ${BUTTON_VARIANTS[variant]} ${className}`}
      disabled={disabled || busy}
      {...rest}
    >
      {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

/** Icon-only action. Always labeled (aria + tooltip). The hit area is a full
 *  control on phones; `sm` is a compact 32px target on desktop only. */
export function IconButton({
  label,
  variant = "ghost",
  size = "md",
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  variant?: "ghost" | "danger" | "accent";
  size?: "md" | "sm";
}) {
  const styles = variant === "danger"
    ? "text-ink-faint hover:bg-danger-soft hover:text-danger"
    : variant === "accent"
      ? "text-ink-faint hover:bg-accent-soft hover:text-accent-dark"
      : "text-ink-soft hover:bg-subtle hover:text-ink";
  const box = size === "sm"
    ? "h-[var(--control-h-sm)] w-[var(--control-h-sm)]"
    : "h-[var(--control-h)] w-[var(--control-h)]";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`inline-flex shrink-0 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-[var(--focus-ring)] focus-visible:ring-accent-soft disabled:pointer-events-none disabled:opacity-40 ${box} ${styles} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ── Overflow menu ─────────────────────────────────────────────────────── */

/** Lightweight popover menu for secondary / overflow actions. Closes on
 *  outside-click and Escape. Pass a custom trigger or get a default ⋯ button. */
export function Menu({
  label = "More actions",
  trigger,
  children,
  align = "end",
  size = "md",
}: {
  label?: string;
  trigger?: ReactNode;
  children: ReactNode;
  align?: "start" | "end";
  size?: "md" | "sm";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.querySelector<HTMLElement>("button")?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus());
  }, [open]);
  const triggerNode = trigger && isValidElement<ButtonHTMLAttributes<HTMLButtonElement>>(trigger)
    ? cloneElement(trigger, { "aria-haspopup": "menu", "aria-expanded": open })
    : trigger;
  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const current = items.indexOf(document.activeElement as HTMLElement);
    let next = current;
    if (e.key === "ArrowDown") next = current < items.length - 1 ? current + 1 : 0;
    else if (e.key === "ArrowUp") next = current > 0 ? current - 1 : items.length - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else return;
    e.preventDefault();
    items[next]?.focus();
  };
  const restoreTriggerIfFocusWasLost = () => {
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) {
        triggerRef.current?.querySelector<HTMLElement>("button")?.focus();
      }
    });
  };
  return (
    <div ref={ref} className="relative shrink-0">
      <div
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (!open && e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {triggerNode ?? (
          <IconButton label={label} size={size} aria-haspopup="menu" aria-expanded={open}>
            <MoreHorizontal className="h-4.5 w-4.5" />
          </IconButton>
        )}
      </div>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          className={`fade-in absolute z-50 mt-1 min-w-52 overflow-hidden rounded-xl border border-line bg-card p-1 shadow-pop ${align === "end" ? "right-0" : "left-0"}`}
          onClick={() => {
            setOpen(false);
            restoreTriggerIfFocusWasLost();
          }}
          onKeyDown={onMenuKeyDown}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  icon,
  danger = false,
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon?: ReactNode; danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`flex min-h-[var(--control-h)] w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-body font-medium transition-colors focus-visible:outline-none focus-visible:bg-subtle disabled:pointer-events-none disabled:text-ink-faint ${danger ? "text-danger hover:bg-danger-soft" : "text-ink hover:bg-subtle"} ${className}`}
      {...rest}
    >
      {icon && <span className={`shrink-0 ${danger ? "" : "text-ink-faint"}`}>{icon}</span>}
      <span className="flex-1">{children}</span>
    </button>
  );
}

/* ── Form controls ─────────────────────────────────────────────────────── */

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-body font-medium text-ink-soft">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-meta text-ink-faint">{hint}</span>}
    </label>
  );
}

// 16px on phones (iOS zooms into anything smaller), 14px from sm up.
const inputCls =
  "w-full min-h-[var(--control-h)] rounded-lg border border-line-strong bg-card py-1.5 text-base text-ink placeholder:text-ink-faint transition-colors focus:border-accent focus:outline-none focus:ring-[var(--focus-ring)] focus:ring-accent-soft disabled:bg-subtle disabled:text-ink-soft read-only:bg-subtle sm:text-sm";

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  // A date field is laid out from fixed internal segments that never shrink, so
  // it needs tighter padding than a text field — and min-w-0, because a grid
  // item defaults to min-width:auto and would otherwise refuse to shrink below
  // that intrinsic width and spill out of its column.
  const dateCls = props.type === "date" ? "px-2 min-w-0" : "px-3";
  return <input {...props} className={`${inputCls} ${dateCls} ${props.className ?? ""}`} />;
}

/**
 * A date filter that always reads as a labelled control.
 *
 * iOS Safari paints nothing at all for an empty `input[type=date]`, so a bare
 * one renders as a blank rectangle with no hint of what it is. This owns its
 * empty-state text instead of trusting the platform: when there is no date we
 * draw "From"/"To" ourselves and hide whatever the engine would have drawn.
 */
export function DateField({
  label,
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const empty = props.value === "" || props.value == null;
  return (
    <span className="relative block w-full min-w-0">
      <Input
        {...props}
        type="date"
        aria-label={props["aria-label"] ?? label}
        className={`${empty ? "text-transparent" : ""} ${className}`}
      />
      {empty && (
        <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-base text-ink-faint sm:text-sm">
          {label}
        </span>
      )}
    </span>
  );
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${inputCls} px-3 ${props.className ?? ""}`} />;
}

/** Native select, but with the raw OS arrow replaced by a consistent chevron. */
export function Select({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="relative block w-full min-w-0">
      <select
        {...props}
        className={`${inputCls} cursor-pointer appearance-none truncate pl-3 pr-9 ${className}`}
      />
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" aria-hidden />
    </span>
  );
}

/** One row of mutually exclusive choices (filters, split methods, theme). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className = "",
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={`inline-flex max-w-full gap-1 overflow-x-auto rounded-xl border border-line bg-card p-1 ${className}`}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={`min-h-[var(--control-h-sm)] min-w-[var(--control-h-sm)] shrink-0 whitespace-nowrap rounded-lg px-3 text-body font-medium transition-colors focus-visible:outline-none focus-visible:ring-[var(--focus-ring)] focus-visible:ring-accent-soft ${
            value === option.value ? "bg-accent-soft text-accent-dark" : "text-ink-soft hover:bg-subtle hover:text-ink"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* ── Containers & text roles ───────────────────────────────────────────── */

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-line bg-card shadow-card ${className}`}>{children}</div>
  );
}

export function CardHeader({ title, action, meta }: { title: ReactNode; action?: ReactNode; meta?: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-2 border-b border-line px-4 py-1.5">
      <h2 className="flex min-w-0 items-baseline gap-2 text-section font-semibold tracking-tight">
        <span className="truncate">{title}</span>
        {meta !== undefined && <span className="shrink-0 text-meta font-medium text-ink-faint">{meta}</span>}
      </h2>
      {action}
    </div>
  );
}

/** Small uppercase label that groups rows inside a card (a day, a month, a status). */
export function SectionLabel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <p className={`text-meta font-semibold uppercase tracking-wide text-ink-faint ${className}`}>{children}</p>
  );
}

export function RowTitle({ children, className = "", title }: { children: ReactNode; className?: string; title?: string }) {
  return <span className={`block truncate text-row font-medium ${className}`} title={title}>{children}</span>;
}

export function RowMeta({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`block truncate text-meta text-ink-faint ${className}`}>{children}</span>;
}

/** A card-header link to the full view of a preview list. */
export function HeaderLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="inline-flex min-h-[var(--control-h-sm)] items-center rounded-lg px-2 text-body font-medium text-accent hover:bg-accent-soft">
      {children}
    </Link>
  );
}

/** Small inline tag — group names, categories, quiet metadata. */
export function Chip({
  children,
  tone = "neutral",
  className = "",
}: {
  children: ReactNode;
  tone?: "neutral" | "accent";
  className?: string;
}) {
  const tones = {
    neutral: "bg-subtle text-ink-soft",
    accent: "bg-accent-soft text-accent-dark",
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-meta font-medium ${tones} ${className}`}>
      {children}
    </span>
  );
}

/* ── Modal ─────────────────────────────────────────────────────────────── */

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Dialogs can stack (a confirmation over a form). Only the top one answers
// Escape and Tab, so one key press never closes two layers.
const modalStack: object[] = [];

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide = false,
  closeDisabled = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  closeDisabled?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusables = () =>
      [...(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
        .filter((element) => element.getClientRects().length > 0);
    // With a mouse or keyboard, start in the field the dialog exists for. On a
    // touch screen a programmatic focus cannot raise the keyboard, so the panel
    // takes focus and the first Tab still lands on the first control.
    const preferred = panelRef.current?.querySelector<HTMLElement>("[data-autofocus]");
    const finePointer = typeof window.matchMedia === "function" && window.matchMedia("(pointer: fine)").matches;
    if (preferred && finePointer && preferred.getClientRects().length > 0) preferred.focus();
    else panelRef.current?.focus();
    const layer = {};
    modalStack.push(layer);
    const onKey = (e: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== layer) return;
      if (e.key === "Escape") onCloseRef.current();
      if (e.key === "Tab") {
        const els = focusables();
        if (els.length === 0) return;
        const idx = els.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && (idx <= 0 || idx === -1)) {
          e.preventDefault();
          els[els.length - 1].focus();
        } else if (!e.shiftKey && idx === els.length - 1) {
          e.preventDefault();
          els[0].focus();
        } else if (!e.shiftKey && idx === -1) {
          e.preventDefault();
          els[0].focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      modalStack.splice(modalStack.indexOf(layer), 1);
      if (modalStack.length === 0) document.body.style.overflow = "";
      previouslyFocused?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div
      className="fade-in fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-0 backdrop-blur-[var(--overlay-blur)] sm:items-center sm:p-6"
      onMouseDown={(e) => e.target === e.currentTarget && !closeDisabled && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`rise-in flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-2xl bg-card pb-[var(--safe-area-bottom)] shadow-pop outline-none sm:rounded-2xl sm:pb-0 ${wide ? "sm:max-w-2xl" : "sm:max-w-md"}`}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line py-1.5 pl-4 pr-2">
          <h2 className="min-w-0 truncate text-title font-semibold tracking-tight">{title}</h2>
          <IconButton label="Close" onClick={onClose} disabled={closeDisabled}>
            <X className="h-5 w-5" />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-4">{children}</div>
        {footer && (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-2.5">{footer}</div>
        )}
      </div>
    </div>
  );
}

/* ── Identity & money ──────────────────────────────────────────────────── */

export function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" | "lg" }) {
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const cls = { sm: "h-6 w-6 text-meta", md: "h-8 w-8 text-meta", lg: "h-10 w-10 text-body" }[size];
  // Deterministic per-name hue — the one sanctioned hard-coded color in the app.
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${cls}`}
      style={{ background: `hsl(${hue} 52% 45%)` }}
    >
      {initials || "?"}
    </span>
  );
}

export function Money({
  cents,
  currency,
  signed = false,
  className = "",
}: {
  cents: number;
  currency: string;
  signed?: boolean;
  className?: string;
}) {
  const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency }).format(Math.abs(cents) / 100);
  const color = !signed ? "" : cents > 0 ? "text-owed" : cents < 0 ? "text-owe" : "text-ink-faint";
  return (
    <span className={`tnum ${color} ${className}`}>
      {signed && cents > 0 ? "+" : signed && cents < 0 ? "−" : ""}
      {fmt}
    </span>
  );
}

/* ── States ────────────────────────────────────────────────────────────── */

export function EmptyState({ icon, title, hint, action }: { icon?: ReactNode; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1.5 px-6 py-8 text-center">
      <span className="text-ink-faint">{icon ?? <Inbox className="h-6 w-6" />}</span>
      <p className="text-row font-medium text-ink">{title}</p>
      {hint && <p className="max-w-sm text-body text-ink-faint">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-body text-danger">
      {message}
    </p>
  );
}

/* ── Toasts ────────────────────────────────────────────────────────────── */

type ToastItem = { id: number; message: string; tone: "success" | "error"; action?: { label: string; href: string } };
let toasts: ToastItem[] = [];
let toastSeq = 0;
const toastListeners = new Set<() => void>();
const emitToasts = () => { for (const listener of toastListeners) listener(); };

/** Confirms a finished action (or reports a failure) without moving the page. */
export function toast(message: string, opts: { tone?: "success" | "error"; action?: { label: string; href: string } } = {}) {
  const id = ++toastSeq;
  toasts = [...toasts.slice(-2), { id, message, tone: opts.tone ?? "success", action: opts.action }];
  emitToasts();
  window.setTimeout(() => dismissToast(id), opts.tone === "error" ? 6000 : 3500);
}

function dismissToast(id: number) {
  toasts = toasts.filter((item) => item.id !== id);
  emitToasts();
}

const subscribeToasts = (listener: () => void) => {
  toastListeners.add(listener);
  return () => { toastListeners.delete(listener); };
};
const EMPTY_TOASTS: ToastItem[] = [];

export function ToastRegion() {
  const items = useSyncExternalStore(subscribeToasts, () => toasts, () => EMPTY_TOASTS);
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {items.map((item) => (
        <div
          key={item.id}
          className={`rise-in pointer-events-auto flex max-w-sm items-center gap-2 rounded-xl py-1.5 pl-3 pr-1.5 text-body font-medium shadow-pop ${
            item.tone === "error" ? "bg-danger text-on-danger" : "bg-ink text-paper"
          }`}
        >
          {item.tone === "error" ? <AlertCircle className="h-4 w-4 shrink-0" aria-hidden /> : <Check className="h-4 w-4 shrink-0" aria-hidden />}
          <span className="min-w-0 flex-1 py-1">{item.message}</span>
          {item.action && (
            <Link href={item.action.href} onClick={() => dismissToast(item.id)} className="inline-flex min-h-[var(--control-h-sm)] items-center rounded-lg px-2 font-semibold underline-offset-2 hover:underline">
              {item.action.label}
            </Link>
          )}
          <button type="button" onClick={() => dismissToast(item.id)} aria-label="Dismiss" className="inline-flex h-[var(--control-h-sm)] w-[var(--control-h-sm)] shrink-0 items-center justify-center rounded-lg opacity-80 hover:opacity-100">
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}

/* ── Confirmation dialog ───────────────────────────────────────────────── */

type ConfirmRequest = {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
};
let confirmRequest: ConfirmRequest | null = null;
const confirmListeners = new Set<() => void>();
const emitConfirm = () => { for (const listener of confirmListeners) listener(); };

/** In-app replacement for window.confirm: same promise-style flow, styled and
 *  keyboard-safe, and never shows the browser's origin banner in a web app. */
export function confirmAction(opts: Omit<ConfirmRequest, "resolve">): Promise<boolean> {
  confirmRequest?.resolve(false);
  return new Promise((resolve) => {
    confirmRequest = { ...opts, resolve };
    emitConfirm();
  });
}

function settleConfirm(ok: boolean) {
  const request = confirmRequest;
  confirmRequest = null;
  emitConfirm();
  request?.resolve(ok);
}

const subscribeConfirm = (listener: () => void) => {
  confirmListeners.add(listener);
  return () => { confirmListeners.delete(listener); };
};

export function ConfirmHost() {
  const request = useSyncExternalStore(subscribeConfirm, () => confirmRequest, () => null);
  return (
    <Modal
      open={request !== null}
      onClose={() => settleConfirm(false)}
      title={request?.title ?? ""}
      footer={request && (
        <>
          <Button variant="secondary" onClick={() => settleConfirm(false)}>Cancel</Button>
          <Button variant={request.danger ? "danger" : "primary"} data-autofocus onClick={() => settleConfirm(true)}>
            {request.confirmLabel}
          </Button>
        </>
      )}
    >
      <div className="text-body text-ink-soft">{request?.message}</div>
    </Modal>
  );
}
