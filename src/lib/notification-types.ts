export const NOTIFICATION_CATEGORIES = {
  expenses: "Expenses and receipts",
  settlements: "Payments and group balances",
  comments: "Expense comments",
  messages: "Group and direct messages",
  reminders: "Settle-up reminders",
  groups: "Group changes",
  friends: "Friends and requests",
} as const;

export type NotificationCategory = keyof typeof NOTIFICATION_CATEGORIES;
export interface NotificationPreferences {
  pushEnabled: boolean;
  categories: Record<NotificationCategory, boolean>;
}
export interface NotificationItem {
  id: number;
  category: NotificationCategory | "test";
  title: string;
  body: string;
  href: string;
  createdAt: string;
  readAt: string | null;
}
export interface NotificationDevice {
  id: number;
  label: string;
  updatedAt: string;
}
export interface NotificationSettings {
  preferences: NotificationPreferences;
  devices: NotificationDevice[];
  publicKey: string | null;
}

export function safeNotificationPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || /[\\\u0000-\u0020]/.test(value)) return "/notifications";
  const url = new URL(value, "https://splitwisest.invalid");
  if (url.origin !== "https://splitwisest.invalid") return "/notifications";
  if (!/^\/(?:notifications(?:\/\d+)?|groups(?:\/\d+)?|chat(?:\/\d+)?|balances|activity)$/.test(url.pathname)) return "/notifications";
  return url.pathname + url.search;
}
