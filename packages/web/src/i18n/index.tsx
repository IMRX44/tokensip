import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { ar } from "./ar";
import { en, type MessageKey, type Messages } from "./en";
import { fa } from "./fa";
import { ru } from "./ru";
import { zh } from "./zh";

export type Lang = "en" | "fa" | "ru" | "ar" | "zh";

export const LANGUAGES: { id: Lang; label: string; dir: "ltr" | "rtl"; locale: string }[] = [
  { id: "en", label: "English", dir: "ltr", locale: "en-US" },
  { id: "fa", label: "فارسی", dir: "rtl", locale: "fa-IR" },
  { id: "ru", label: "Русский", dir: "ltr", locale: "ru-RU" },
  { id: "ar", label: "العربية", dir: "rtl", locale: "ar" },
  { id: "zh", label: "简体中文", dir: "ltr", locale: "zh-CN" },
];

const DICTS: Record<Lang, Messages> = { en, fa, ru, ar, zh };
const STORAGE_KEY = "tokensip.lang";

function detect(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) as Lang | null;
    if (saved && DICTS[saved]) return saved;
  } catch {
    /* storage unavailable */
  }
  const nav = (navigator.language || "en").slice(0, 2).toLowerCase();
  return (LANGUAGES.find((l) => l.id === nav)?.id ?? "en") as Lang;
}

interface I18n {
  lang: Lang;
  dir: "ltr" | "rtl";
  locale: string;
  setLang(lang: Lang): void;
  t(key: MessageKey, vars?: Record<string, string | number>): string;
  num(n: number, opts?: Intl.NumberFormatOptions): string;
  compact(n: number): string;
  usd(n: number): string;
  pct(n: number): string;
  date(ts: number, opts?: Intl.DateTimeFormatOptions): string;
  bytes(n: number): string;
}

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detect);
  const meta = LANGUAGES.find((l) => l.id === lang) ?? (LANGUAGES[0] as (typeof LANGUAGES)[number]);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = meta.dir;
  }, [lang, meta.dir]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo<I18n>(() => {
    const dict = DICTS[lang];
    // Western digits read better for metrics in every supported locale.
    const nf = (opts?: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat(meta.locale, { numberingSystem: "latn", ...opts });
    return {
      lang,
      dir: meta.dir,
      locale: meta.locale,
      setLang,
      t: (key, vars) => {
        let s = dict[key] ?? en[key] ?? key;
        if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
        return s;
      },
      num: (n, opts) => nf(opts).format(n),
      compact: (n) => nf({ notation: "compact", maximumFractionDigits: 1 }).format(n),
      usd: (n) => {
        const abs = Math.abs(n);
        const digits = abs === 0 ? 2 : abs < 0.01 ? 4 : abs < 1 ? 3 : 2;
        return nf({
          style: "currency",
          currency: "USD",
          currencyDisplay: "narrowSymbol",
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        }).format(n);
      },
      pct: (n) => nf({ style: "percent", maximumFractionDigits: 1 }).format(n),
      date: (ts, opts) =>
        new Intl.DateTimeFormat(meta.locale, {
          numberingSystem: "latn",
          dateStyle: "medium",
          timeStyle: "short",
          ...opts,
        }).format(ts),
      bytes: (n) => {
        const units = ["B", "KB", "MB", "GB"];
        let i = 0;
        let v = n;
        while (v >= 1024 && i < units.length - 1) {
          v /= 1024;
          i++;
        }
        return `${nf({ maximumFractionDigits: 1 }).format(v)} ${units[i]}`;
      },
    };
  }, [lang, meta, setLang]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useI18n outside provider");
  return ctx;
}

export type { MessageKey };
