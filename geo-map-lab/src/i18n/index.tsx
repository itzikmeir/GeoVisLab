import React, { createContext, useContext, useState, useCallback } from 'react';
import heTranslations from './he.json';
import enTranslations from './en.json';

// ─── Registry ────────────────────────────────────────────────────────────────
// To add a new language: import its JSON and add it here.
const TRANSLATIONS: Record<string, Record<string, any>> = {
  he: heTranslations,
  en: enTranslations,
};

// ─── Types ───────────────────────────────────────────────────────────────────
export interface LangCtx {
  lang: string;
  dir: 'rtl' | 'ltr';
  t: (key: string, vars?: Record<string, string | number>) => string;
  setLang: (code: string) => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function resolvePath(obj: Record<string, any>, path: string): string {
  const parts = path.split('.');
  let cur: any = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return path;
    cur = cur[part];
  }
  if (typeof cur === 'string') return cur;
  return path; // fallback: return the key itself
}

function interpolate(str: string, vars?: Record<string, string | number>): string {
  if (!vars) return str;
  return str.replace(/\{(\w+)\}/g, (_, key) =>
    vars[key] !== undefined ? String(vars[key]) : `{${key}}`
  );
}

const STORAGE_KEY = 'geovislab_lang';

// ─── Context ─────────────────────────────────────────────────────────────────
const LanguageContext = createContext<LangCtx>({
  lang: 'he',
  dir: 'rtl',
  t: (key) => key,
  setLang: () => {},
});

// ─── Provider ─────────────────────────────────────────────────────────────────
export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<string>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored && TRANSLATIONS[stored] ? stored : 'he';
  });

  const setLang = useCallback((code: string) => {
    if (!TRANSLATIONS[code]) return;
    localStorage.setItem(STORAGE_KEY, code);
    setLangState(code);
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>): string => {
      const translations = TRANSLATIONS[lang] ?? TRANSLATIONS['he'];
      const raw = resolvePath(translations, key);
      return interpolate(raw, vars);
    },
    [lang]
  );

  const dir: 'rtl' | 'ltr' =
    (TRANSLATIONS[lang]?.dir as 'rtl' | 'ltr') ?? 'rtl';

  return (
    <LanguageContext.Provider value={{ lang, dir, t, setLang }}>
      {children}
    </LanguageContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
export function useLanguage(): LangCtx {
  return useContext(LanguageContext);
}
