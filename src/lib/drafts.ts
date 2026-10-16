import { useState } from "react";

const PREFIX = "splitwisest.draft.";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface StoredDraft<T> {
  value: T;
  savedAt: number;
}

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

function storage(): DraftStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function storageKey(ownerId: number, key: string) {
  return `${PREFIX}${ownerId}.${key}`;
}

export function readDraft<T>(ownerId: number, key: string, now = Date.now(), store = storage()): T | null {
  if (!store) return null;
  try {
    const raw = store.getItem(storageKey(ownerId, key));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredDraft<T>;
    if (typeof parsed?.savedAt !== "number" || now - parsed.savedAt > MAX_AGE_MS || parsed.value === undefined) {
      store.removeItem(storageKey(ownerId, key));
      return null;
    }
    return parsed.value;
  } catch {
    return null;
  }
}

export function writeDraft(ownerId: number, key: string, value: unknown, now = Date.now(), store = storage()) {
  if (!store) return;
  try {
    if (value === null || value === "") store.removeItem(storageKey(ownerId, key));
    else store.setItem(storageKey(ownerId, key), JSON.stringify({ value, savedAt: now }));
  } catch {
    return;
  }
}

export function clearDraft(ownerId: number, key: string, store = storage()) {
  writeDraft(ownerId, key, null, Date.now(), store);
}

export function clearAllDrafts(store = storage()) {
  if (!store) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch {
    return;
  }
}

export function useTextDraft(ownerId: number, key: string): [string, (value: string) => void] {
  const [state, setState] = useState(() => ({ ownerId, key, value: readDraft<string>(ownerId, key) ?? "" }));
  let current = state;
  if (state.key !== key || state.ownerId !== ownerId) {
    current = { ownerId, key, value: readDraft<string>(ownerId, key) ?? "" };
    setState(current);
  }
  const set = (value: string) => {
    setState({ ownerId, key, value });
    writeDraft(ownerId, key, value);
  };
  return [current.value, set];
}
