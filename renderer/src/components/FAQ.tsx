/**
 * FAQ — the three questions people actually write in about, at the foot of
 * the subscription page.
 *
 * Plain disclosure elements rather than cards: this is the last thing on the
 * page, and it should read as a list of links, not compete with the plans
 * above it. `<details>` also means it works before any script runs and takes
 * the keyboard for free.
 */
import { useTranslation } from '../hooks/useTranslation';

/** Question, and the answer it opens onto. */
const QUESTIONS = [
  { q: 'subscription.faqTrial', a: 'subscription.faqTrialBody' },
  { q: 'subscription.faqUpgrade', a: 'subscription.faqUpgradeBody' },
  { q: 'subscription.faqMethods', a: 'subscription.faqMethodsBody' },
];

export default function FAQ() {
  const { t } = useTranslation();

  return (
    <div data-testid="faq" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <p style={{ color: 'var(--text-muted)', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 4 }}>
        ❓ {t('subscription.faqHeading')}
      </p>
      {QUESTIONS.map(({ q, a }) => (
        <details key={q} className="faq-item" data-testid={`faq-${q.split('.')[1]}`}>
          <summary
            style={{
              color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer',
              padding: '6px 0', listStyle: 'none',
            }}
          >
            · {t(q)}
          </summary>
          <p style={{ color: 'var(--text-faint)', fontSize: 11, padding: '0 0 8px 12px' }}>{t(a)}</p>
        </details>
      ))}
    </div>
  );
}
