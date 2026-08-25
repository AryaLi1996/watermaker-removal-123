/**
 * Translation lookup.
 *
 * Small enough not to need a library: dotted keys into a JSON tree, a
 * {placeholder} substitution, and a locale kept in localStorage so the choice
 * survives a restart.
 */
import en from './en.json';
import zh from './zh.json';

export const LOCALES = ['en', 'zh'] as const;
export type Locale = (typeof LOCALES)[number];

/** Shown in the language picker, in the language itself. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  zh: '中文',
};

const resources: Record<Locale, unknown> = { en, zh };

const STORAGE_KEY = 'watermark-remover:locale';
export const LOCALE_CHANGED = 'watermark-remover:locale-changed';

function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * The locale to start in: a previous choice, else the system language, else
 * English. Storage can be unavailable, which must not stop the app loading.
 */
function initialLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // no stored preference available
  }
  const system = typeof navigator === 'undefined' ? '' : navigator.language;
  return system.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

let current: Locale = initialLocale();

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale): void {
  if (!isLocale(locale) || locale === current) return;
  current = locale;
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // The choice still applies for this session.
  }
  window.dispatchEvent(new CustomEvent(LOCALE_CHANGED, { detail: locale }));
}

function lookup(locale: Locale, key: string): string | undefined {
  let node: unknown = resources[locale];
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/**
 * Translate `key`, filling any {placeholders} from `vars`.
 *
 * A key missing from the active locale falls back to English rather than
 * showing the user a blank or a raw key.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const template = lookup(current, key) ?? lookup('en', key) ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}

/** Every dotted key in a resource tree — used to check the locales match. */
export function collectKeys(tree: unknown, prefix = ''): string[] {
  if (typeof tree !== 'object' || tree === null) return [];
  return Object.entries(tree as Record<string, unknown>).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'string' ? [path] : collectKeys(value, path);
  });
}

export const RESOURCES = resources;
