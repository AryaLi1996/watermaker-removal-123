/**
 * EmptyState — shown when no video is loaded.
 * Clicking anywhere triggers the file picker.
 */
interface EmptyStateProps {
  onSelectFile: () => void;
}

export default function EmptyState({ onSelectFile }: EmptyStateProps) {
  return (
    <div
      data-testid="empty-state"
      className="flex flex-col items-center justify-center h-full cursor-pointer select-none"
      style={{ background: '#000' }}
      onClick={onSelectFile}
    >
      {/* Film-strip icon */}
      <svg
        width="56"
        height="56"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#3f3f46"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
        <line x1="7" y1="2" x2="7" y2="22" />
        <line x1="17" y1="2" x2="17" y2="22" />
        <line x1="2" y1="12" x2="22" y2="12" />
        <line x1="2" y1="7" x2="7" y2="7" />
        <line x1="2" y1="17" x2="7" y2="17" />
        <line x1="17" y1="17" x2="22" y2="17" />
        <line x1="17" y1="7" x2="22" y2="7" />
      </svg>
      <p className="mt-4 text-sm" style={{ color: '#52525b' }}>
        Click to browse for a video file
      </p>
      <p className="mt-1 text-xs" style={{ color: '#3f3f46' }}>
        MP4 · MKV · MOV · AVI
      </p>
    </div>
  );
}
