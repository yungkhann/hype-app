"use client";

import { useSyncExternalStore } from "react";

/**
 * The active dataset id lives in localStorage so every page (and a reload) shares it.
 * Server snapshot is `undefined` ("not known yet") so prerendered HTML shows a neutral skeleton
 * instead of a misleading empty state.
 */
const KEY = "atlas.activeDataset";
const listeners = new Set<() => void>();

function read(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function setActiveDataset(id: string | null) {
  try {
    if (id) window.localStorage.setItem(KEY, id);
    else window.localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable (private mode); selection lasts for this page only */
  }
  listeners.forEach((listener) => listener());
}

export function useActiveDatasetId(): string | null | undefined {
  return useSyncExternalStore(subscribe, read, () => undefined);
}
