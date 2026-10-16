import { useCallback, useEffect, useState } from "react";

export type ThemePref = "system" | "dark" | "light";
const KEY = "tokensip.theme";

function apply(pref: ThemePref): void {
  const dark = pref === "dark" || (pref === "system" && !window.matchMedia("(prefers-color-scheme: light)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function initTheme(): void {
  apply(readPref());
}

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "dark" || v === "light" || v === "system") return v;
  } catch {
    /* ignore */
  }
  return "system";
}

export function useTheme(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(readPref);
  useEffect(() => {
    apply(pref);
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const on = () => pref === "system" && apply(pref);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [pref]);
  const set = useCallback((p: ThemePref) => {
    setPref(p);
    try {
      localStorage.setItem(KEY, p);
    } catch {
      /* ignore */
    }
  }, []);
  return [pref, set];
}
