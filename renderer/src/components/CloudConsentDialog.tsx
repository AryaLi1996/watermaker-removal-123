/**
 * Asking, before any part of the user's picture leaves their machine.
 *
 * Three things here are not styling decisions:
 *
 * The checkbox arrives **unticked** and the agree button is dead until it is
 * set. A pre-ticked box is not consent in any jurisdiction that has thought
 * about it, and it is the single easiest way to turn a lawful notice into an
 * unlawful one.
 *
 * Declining is a **real** choice, spelled out as one: the local filler
 * finishes the same export. A dialog whose refusal button means "you cannot
 * use this app" is not asking anything.
 *
 * And where the notice cannot name who is processing the upload or where to
 * write about it, this **refuses to ask at all** rather than showing an
 * incomplete one. That is what keeps a build with those fields still blank
 * from collecting agreements to nothing — see CLOUD_PARTIES.
 */
import { useState } from 'react';
import { useTranslation } from '../hooks/useTranslation';
import { CLOUD_PARTIES, consentIsComplete } from '../cloud';

interface CloudConsentDialogProps {
  onAgree: () => void;
  onDecline: () => void;
}

function Field({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation();
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 11, lineHeight: 1.6 }}>
      <span style={{ color: 'var(--text-faint)', minWidth: 96 }}>{label}</span>
      <span style={{ color: value ? 'var(--text-secondary)' : 'var(--danger, #f87171)' }}>
        {value || t('cloud.placeholder')}
      </span>
    </div>
  );
}

export default function CloudConsentDialog({ onAgree, onDecline }: CloudConsentDialogProps) {
  const { t } = useTranslation();
  const [agreed, setAgreed] = useState(false);
  const complete = consentIsComplete();

  const panel: React.CSSProperties = {
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 8, padding: 16, maxWidth: 560, maxHeight: '80vh',
    overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10,
  };
  const backdrop: React.CSSProperties = {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
  };
  const body: React.CSSProperties = {
    color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.65, margin: 0,
  };

  if (!complete) {
    return (
      <div style={backdrop} data-testid="cloud-consent">
        <div style={panel}>
          <h2 style={{ margin: 0, fontSize: 14, color: 'var(--text)' }}>
            {t('cloud.incompleteTitle')}
          </h2>
          <p data-testid="cloud-consent-incomplete" style={body}>{t('cloud.incomplete')}</p>
          <button
            type="button"
            data-testid="cloud-consent-decline"
            onClick={onDecline}
            style={{
              alignSelf: 'flex-end', background: 'var(--accent)', border: 'none',
              borderRadius: 4, color: '#fff', padding: '6px 12px', fontSize: 12,
              cursor: 'pointer',
            }}
          >
            {t('cloud.decline')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={backdrop} data-testid="cloud-consent">
      <div style={panel}>
        <h2 style={{ margin: 0, fontSize: 14, color: 'var(--text)' }}>{t('cloud.title')}</h2>
        <p style={body}>{t('cloud.why')}</p>
        <p style={body}>{t('cloud.whatSent')}</p>
        <p style={body}>{t('cloud.whatStays')}</p>
        <p data-testid="cloud-consent-warning"
           style={{ ...body, color: 'var(--text)', fontWeight: 500 }}>
          {t('cloud.warning')}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 0' }}>
          <Field label={t('cloud.processorLabel')}
                 value={[CLOUD_PARTIES.processorName, CLOUD_PARTIES.processorEmail]
                   .filter(Boolean).join(' · ')} />
          <Field label={t('cloud.recipientLabel')}
                 value={[CLOUD_PARTIES.recipientName, CLOUD_PARTIES.recipientContact]
                   .filter(Boolean).join(' · ')} />
          <Field label={t('cloud.regionLabel')} value={CLOUD_PARTIES.recipientRegion} />
          <Field label={t('cloud.purposeLabel')} value={t('cloud.purpose')} />
          <Field label={t('cloud.categoriesLabel')} value={t('cloud.categories')} />
          <Field label={t('cloud.retentionLabel')} value={t('cloud.retention')} />
          <Field label={t('cloud.rightsLabel')} value={t('cloud.rights')} />
        </div>

        <p style={body}>{t('cloud.alternative')}</p>

        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start',
                        fontSize: 12, color: 'var(--text)', cursor: 'pointer' }}>
          <input
            type="checkbox"
            data-testid="cloud-consent-agree"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            style={{ marginTop: 3, cursor: 'pointer' }}
          />
          <span>{t('cloud.agreeLabel')}</span>
        </label>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <button
            type="button"
            data-testid="cloud-consent-decline"
            onClick={onDecline}
            style={{
              background: 'transparent', border: '1px solid var(--border)',
              borderRadius: 4, color: 'var(--text-secondary)', padding: '6px 12px',
              fontSize: 12, cursor: 'pointer',
            }}
          >
            {t('cloud.decline')}
          </button>
          <button
            type="button"
            data-testid="cloud-consent-accept"
            disabled={!agreed}
            onClick={onAgree}
            style={{
              background: agreed ? 'var(--accent)' : 'var(--border)', border: 'none',
              borderRadius: 4, color: '#fff', padding: '6px 12px', fontSize: 12,
              cursor: agreed ? 'pointer' : 'not-allowed',
            }}
          >
            {t('cloud.accept')}
          </button>
        </div>
        <p style={{ ...body, color: 'var(--text-faint)', fontSize: 11 }}>
          {t('cloud.withdraw')}
        </p>
      </div>
    </div>
  );
}
