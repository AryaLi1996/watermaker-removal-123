/**
 * LicenseInput — the other way in: a key somebody already has.
 *
 * It stands where the demo-licence card used to, and it is always on now
 * rather than hidden behind a build flag. The shop issues these keys, so a
 * box that appears only in some builds is a support question waiting to
 * happen.
 *
 * The verification is the online one, the same one a purchase goes through —
 * see `activate` in electron/subscription-monitor.js. Nothing here decides
 * whether a key is good.
 *
 * The placeholder says SOOTHEVOICE deliberately: the licence service is
 * shared with SootheVoice and issues keys under that prefix, so a key that
 * works here looks like that one.
 */
import { useCallback, useState } from 'react';
import { useTranslation } from '../hooks/useTranslation';
import { licenseErrorKey } from '../subscription';

interface LicenseInputProps {
  activate?: (code: string) => Promise<{ success: boolean; error?: string; code?: string }>;
  /** Called once a key has been accepted, so the page can say what it just
   *  unlocked. */
  onActivated?: () => void;
}

/** Where the box has got to. */
type Activation =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'ok' }
  | { kind: 'failed'; message: string; code?: string };

export default function LicenseInput({ activate, onActivated }: LicenseInputProps) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [activation, setActivation] = useState<Activation>({ kind: 'idle' });

  const submit = useCallback(async () => {
    const entered = code.trim();
    if (!entered || !activate) return;
    setActivation({ kind: 'working' });
    const result = await activate(entered);
    if (result.success) {
      setActivation({ kind: 'ok' });
      setCode('');
      onActivated?.();
      return;
    }
    setActivation({ kind: 'failed', message: result.error ?? '', code: result.code });
  }, [activate, code, onActivated]);

  /** The clipboard, for a token far too long to retype. Silently ignored
   *  where the browser refuses it: the field still accepts a paste. */
  const paste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setCode(text.trim());
    } catch {
      // No clipboard permission. Ctrl/Cmd-V still works.
    }
  }, []);

  // A failure with wording of its own — a licence belonging to another app,
  // or one whose period is already over — or null, in which case the reason
  // the service gave is what to show.
  const errorKey = activation.kind === 'failed' ? licenseErrorKey(activation.code) : null;
  const ready = !!code.trim() && activation.kind !== 'working';

  return (
    <div data-testid="license-input" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p style={{ color: 'var(--text-muted)', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        {t('subscription.activateHeading')}
      </p>
      <p style={{ color: 'var(--text-faint)', fontSize: 11 }}>{t('subscription.activateHint')}</p>

      <div style={{ display: 'flex', gap: 8 }}>
        <input
          className="license-key"
          data-testid="activation-code"
          aria-label={t('subscription.activateHeading')}
          value={code}
          onChange={(e) => { setCode(e.target.value); setActivation({ kind: 'idle' }); }}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          placeholder={t('subscription.activatePlaceholder')}
          spellCheck={false}
          autoComplete="off"
          style={{
            flex: 1, minWidth: 0, background: 'var(--bg)', color: 'var(--text)',
            border: '1px solid var(--border)', borderRadius: 8, padding: '9px 12px',
            fontSize: 12, fontFamily: 'monospace', letterSpacing: '0.04em',
          }}
        />
        <button
          data-testid="activation-paste"
          onClick={() => { void paste(); }}
          style={{
            background: 'transparent', border: '1px solid var(--border)', borderRadius: 8,
            padding: '9px 14px', color: 'var(--text-secondary)', fontSize: 11, cursor: 'pointer',
          }}
        >
          {t('subscription.activatePaste')}
        </button>
        <button
          data-testid="activation-submit"
          onClick={() => { void submit(); }}
          disabled={!ready}
          style={{
            background: ready ? 'var(--accent)' : 'var(--border)', border: 'none', borderRadius: 8,
            padding: '9px 20px', color: ready ? 'var(--accent-contrast)' : 'var(--text-disabled)',
            fontSize: 12, fontWeight: 500, cursor: ready ? 'pointer' : 'default',
          }}
        >
          {activation.kind === 'working' ? t('subscription.activateWorking') : t('subscription.activate')}
        </button>
      </div>

      {activation.kind === 'ok' && (
        <p data-testid="activation-success" style={{ color: 'var(--success-text)', fontSize: 11 }}>
          {t('subscription.activateSuccess')}
        </p>
      )}
      {activation.kind === 'failed' && (
        <p data-testid="activation-error" style={{ color: 'var(--danger-text)', fontSize: 11 }}>
          {errorKey ? t(errorKey) : t('subscription.activateFailed', { reason: activation.message })}
        </p>
      )}
    </div>
  );
}
