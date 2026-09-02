/**
 * Sidebar — the rail down the left, and the only way between screens.
 *
 * Three entries, because there are three screens. It is deliberately not a
 * place features get parked: anything that belongs to a job belongs in the
 * editor's own panel, which sits to the right of this one.
 */
import { useTranslation } from '../hooks/useTranslation';

/** Which screen the app is showing. */
export type Screen = 'editor' | 'subscription' | 'settings';

/** The screens, in the order they appear. `editor` is what the interface
 *  calls the workbench — the id is the one the rest of the app already uses,
 *  so only the label reads "Workbench". */
const NAV_ITEMS: { id: Screen; labelKey: string; icon: string }[] = [
  { id: 'editor', labelKey: 'nav.workbench', icon: '🏠' },
  { id: 'subscription', labelKey: 'nav.subscription', icon: '💎' },
  { id: 'settings', labelKey: 'nav.settings', icon: '⚙️' },
];

interface SidebarProps {
  current: Screen;
  onSelect: (screen: Screen) => void;
}

export default function Sidebar({ current, onSelect }: SidebarProps) {
  const { t } = useTranslation();

  return (
    <nav
      className="app-nav"
      data-testid="app-nav"
      aria-label={t('nav.label')}
      style={{
        width: 168, minWidth: 168, background: 'var(--surface)',
        borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column',
        gap: 2, padding: 10,
      }}
    >
      {/* The product's name. It used to sit in the top bar; the rail is
          where it belongs now that the top bar is about the person using
          the app rather than the app itself — and on macOS, where the
          window has no system title bar, it is the only place it appears. */}
      <p
        data-testid="app-name"
        style={{ color: 'var(--text)', fontSize: 12, fontWeight: 600, padding: '4px 10px 10px' }}
      >
        {t('app.name')}
      </p>

      {NAV_ITEMS.map(({ id, labelKey, icon }) => {
        const active = current === id;
        return (
          <button
            key={id}
            className="app-nav-item"
            data-testid={`nav-${id}`}
            aria-current={active ? 'page' : undefined}
            onClick={() => onSelect(id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, width: '100%',
              background: active ? 'var(--accent-soft)' : 'transparent',
              border: 'none', borderRadius: 6, padding: '8px 10px', textAlign: 'left',
              color: active ? 'var(--accent-soft-text)' : 'var(--text-muted)',
              fontSize: 12, fontWeight: active ? 500 : 400, cursor: 'pointer',
            }}
          >
            <span aria-hidden="true" style={{ fontSize: 14 }}>{icon}</span>
            {t(labelKey)}
          </button>
        );
      })}
    </nav>
  );
}
