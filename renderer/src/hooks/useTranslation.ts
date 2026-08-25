/**
 * Re-render a component when the language changes.
 *
 * `t` itself is a module function; subscribing to the change event is what
 * makes components pick up a new locale without a reload.
 */
import { useCallback, useEffect, useState } from 'react';
import { getLocale, LOCALE_CHANGED, setLocale, t, type Locale } from '../i18n';

export function useTranslation() {
  const [locale, setLocaleState] = useState<Locale>(getLocale);

  useEffect(() => {
    const onChange = () => setLocaleState(getLocale());
    window.addEventListener(LOCALE_CHANGED, onChange);
    return () => window.removeEventListener(LOCALE_CHANGED, onChange);
  }, []);

  // Identity changes with the locale, so memoised children re-render too.
  const translate = useCallback(
    (key: string, vars?: Record<string, string | number>) => t(key, vars),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locale],
  );

  return { t: translate, locale, setLocale };
}
