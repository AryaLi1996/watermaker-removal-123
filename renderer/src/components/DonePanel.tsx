/**
 * DonePanel — shown after a successful export (State 4).
 * Auto-transitions back to loaded state after 5 seconds.
 */
import { useEffect, useState } from 'react';

interface DonePanelProps {
  outputPath: string;
  onReveal: () => void;
  onReset: () => void;
}

export default function DonePanel({ outputPath, onReveal, onReset }: DonePanelProps) {
  const [countdown, setCountdown] = useState(5);

  useEffect(() => {
    const interval = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) { clearInterval(interval); onReset(); return 0; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [onReset]);

  const filename = outputPath.split(/[\\/]/).pop() ?? outputPath;

  return (
    <div data-testid="done-panel" className="flex flex-col gap-3 pt-2">
      {/* Success banner */}
      <div style={{
        background: '#14532d',
        border: '1px solid #16a34a',
        borderRadius: 6,
        padding: '8px 12px',
        color: '#86efac',
        fontSize: 13,
      }}>
        ✓ Export complete
      </div>

      <p style={{ color: '#a1a1aa', fontSize: 11, wordBreak: 'break-all' }}>{filename}</p>

      <button
        data-testid="btn-reveal"
        onClick={onReveal}
        style={{
          background: 'transparent',
          border: '1px solid #3f3f46',
          borderRadius: 6,
          padding: '6px 12px',
          color: '#d4d4d8',
          fontSize: 12,
          cursor: 'pointer',
        }}
      >
        Reveal in Finder
      </button>

      <p style={{ color: '#52525b', fontSize: 11 }}>
        Returning to editor in {countdown}s…
      </p>
    </div>
  );
}
