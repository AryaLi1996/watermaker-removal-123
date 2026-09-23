/**
 * The switch for the filler that is not on this machine, and what it costs.
 *
 * The allowance and the price are rendered from what the service said, never
 * from anything in this app — see cloud-quota.js. So this file has no number
 * in it, and a change to the commercial terms does not touch it.
 *
 * When the switch is on but the service will not be used — the allowance is
 * spent, or it could not be reached — that says so here rather than surprising
 * the user with a result that is not the one they picked. The export still
 * finishes either way, which is the sentence those cases lead with.
 */
import { useTranslation } from '../hooks/useTranslation';
import type { CloudQuotaReply } from '../types';
import { consentIsComplete, hasConsented, type CloudConsent } from '../cloud';

interface CloudFillCardProps {
  enabled: boolean;
  consent: CloudConsent;
  quota: CloudQuotaReply | null;
  disabled: boolean;
  onToggle: (next: boolean) => void;
}

export default function CloudFillCard({
  enabled, consent, quota, disabled, onToggle,
}: CloudFillCardProps) {
  const { t } = useTranslation();

  // Nothing to offer from a build that cannot name who receives the upload.
  if (!consentIsComplete()) return null;

  const agreed = hasConsented(consent);
  const live = enabled && agreed;

  return (
    <div data-testid="cloud-fill-card"
         style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8,
                      cursor: disabled ? 'not-allowed' : 'pointer' }}>
        <input
          type="checkbox"
          data-testid="cloud-fill-toggle"
          checked={enabled}
          disabled={disabled}
          onChange={(e) => onToggle(e.target.checked)}
          style={{ cursor: disabled ? 'not-allowed' : 'pointer' }}
        />
        <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
          {t('cloud.toggle')}
        </span>
      </label>

      <p style={{ color: 'var(--text-faint)', fontSize: 11, lineHeight: 1.5, margin: 0 }}>
        {live ? t('cloud.toggleHint') : t('cloud.off')}
      </p>

      {live && quota && quota.allowed && quota.remaining !== null && quota.limit !== null && (
        <p data-testid="cloud-fill-quota"
           style={{ color: 'var(--text-muted)', fontSize: 11, margin: 0 }}>
          {t('cloud.quotaRemaining', { remaining: quota.remaining, limit: quota.limit })}
          {quota.overagePrice ? ` ${t('cloud.quotaOverage', { price: quota.overagePrice })}` : ''}
        </p>
      )}

      {live && quota && !quota.allowed && (
        <p data-testid="cloud-fill-unavailable"
           style={{ color: 'var(--text-muted)', fontSize: 11, margin: 0, lineHeight: 1.5 }}>
          {t(quota.reason === 'unreachable'
            ? 'cloud.quotaUnreachable'
            : 'cloud.quotaNotAllowed')}
        </p>
      )}
    </div>
  );
}
