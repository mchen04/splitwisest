// Remembers, on this device only, the group the user last added an expense to,
// so the next Add can open straight to the form for that group. The value is a
// group id the user could see; it is ignored unless it is still in their list.
export const LAST_GROUP_KEY = "splitwisest.lastExpenseGroup";

export function rememberExpenseGroup(groupId: number) {
  try {
    window.localStorage.setItem(LAST_GROUP_KEY, String(groupId));
  } catch {
    // Storage can be unavailable (private mode). Add then shows the picker.
  }
}

export function defaultExpenseGroup(groupIds: number[], stored: string | null): number | null {
  const remembered = Number(stored);
  if (Number.isInteger(remembered) && groupIds.includes(remembered)) return remembered;
  return groupIds[0] ?? null;
}

export function readExpenseGroup(): string | null {
  try {
    return window.localStorage.getItem(LAST_GROUP_KEY);
  } catch {
    return null;
  }
}
