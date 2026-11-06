import { useEffect, useState } from "react";
import { storage } from "./storage";

export type ThemePreference = "light" | "dark" | "system";
const KEY = "dinar-theme";
const CHANGE_EVENT = "dinar-theme-change";

export function readTheme(): ThemePreference {
  const saved = storage.get(KEY);
  return saved === "light" || saved === "dark" ? saved : "system";
}

function systemDark() {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

export function applyTheme(pref: ThemePreference = readTheme()) {
  const dark = pref === "dark" || (pref === "system" && systemDark());
  document.documentElement.classList.toggle("dark", dark);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", dark ? "#0b1119" : "#f5f8fc");
}

function persist(pref: ThemePreference) {
  if (pref === "system") storage.remove(KEY);
  else storage.set(KEY, pref);
}

/**
 * The one way to change the theme outside the settings control (e.g. from the DINAR
 * conversation). Persists, applies, tells every useTheme in this tab, and reports whether the
 * document now shows the requested appearance and the preference survives a reload.
 */
export function setThemePreference(pref: ThemePreference): boolean {
  persist(pref);
  applyTheme(pref);
  window.dispatchEvent(new CustomEvent<ThemePreference>(CHANGE_EVENT, { detail: pref }));
  const dark = pref === "dark" || (pref === "system" && systemDark());
  return readTheme() === pref && document.documentElement.classList.contains("dark") === dark;
}

/** Other tabs follow a change made here (the storage event fires only in the other tabs). */
export function followThemeAcrossTabs() {
  // System appearance belongs to the app lifecycle, not just the mounted settings page.
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (readTheme() === "system") applyTheme("system");
  });
  window.addEventListener("storage", (event) => {
    if (event.key === KEY || event.key === null) {
      applyTheme();
      window.dispatchEvent(new CustomEvent<ThemePreference>(CHANGE_EVENT, { detail: readTheme() }));
    }
  });
}

export function useTheme() {
  const [pref, setPref] = useState<ThemePreference>(readTheme);
  useEffect(() => {
    const onChange = (event: Event) => setPref((event as CustomEvent<ThemePreference>).detail);
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);
  useEffect(() => {
    applyTheme(pref);
    persist(pref);
  }, [pref]);
  return [pref, setPref] as const;
}
