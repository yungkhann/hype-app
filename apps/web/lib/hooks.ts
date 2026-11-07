"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

const memoryStore = new Map<string, string>();
const storeListeners = new Map<string, Set<() => void>>();

function notify(key: string) {
  storeListeners.get(key)?.forEach((listener) => listener());
}

/**
 * Per-browser convenience state (checklists, UI preferences) in localStorage. Never use it for
 * anything that must be shared with the team or survive a cleared browser: that belongs in the API.
 * Server snapshot is null, so prerendered HTML shows the fallback.
 */
export function useStoredJson<T>(key: string, fallback: T): [T, (value: T) => void] {
  const subscribe = useCallback(
    (listener: () => void) => {
      const set = storeListeners.get(key) ?? new Set();
      set.add(listener);
      storeListeners.set(key, set);
      const onStorage = (event: StorageEvent) => {
        if (event.key === key) listener();
      };
      window.addEventListener("storage", onStorage);
      return () => {
        set.delete(listener);
        window.removeEventListener("storage", onStorage);
      };
    },
    [key],
  );
  const raw = useSyncExternalStore(
    subscribe,
    () => {
      try {
        return window.localStorage.getItem(key) ?? memoryStore.get(key) ?? null;
      } catch {
        return memoryStore.get(key) ?? null;
      }
    },
    () => null,
  );
  const value = useMemo(() => {
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }, [raw, fallback]);
  const set = useCallback(
    (next: T) => {
      const text = JSON.stringify(next);
      // Kept in memory too: when storage is blocked or full the value still lasts for this page view.
      memoryStore.set(key, text);
      try {
        window.localStorage.setItem(key, text);
      } catch {
        /* storage unavailable: the in-memory copy is used */
      }
      notify(key);
    },
    [key],
  );
  return [value, set];
}

const subscribeNever = () => () => {};

/**
 * False on the server and during hydration, true afterwards (and immediately on later client mounts).
 * The studio page tree hydrates after the shell, which may already have filled the shared query cache;
 * gate query-derived markup on this so hydration renders the same pending state the server did.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribeNever, () => true, () => false);
}

