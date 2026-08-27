/**
 * Compact browser/search mark used by acquisition controls and result cards.
 * It is intentionally local (rather than a remote catalog image) so keyword
 * search never hotlinks third-party assets and the mark remains available
 * before the lazy results chunk loads. Keep this as a generic visual cue; it is
 * not a claim that catalog metadata or mirror transport came from Google.
 */
export function ChromeMark({ size = 22 }: { size?: number } = {}) {
  return (
    <svg aria-hidden="true" className="chrome-mark" height={size} viewBox="0 0 24 24" width={size}>
      <circle cx="12" cy="12" fill="#4285f4" r="10" />
      <path d="M12 12h10a10 10 0 0 0-17.32-6.66L9.5 12Z" fill="#ea4335" />
      <path d="M12 12 7 3.34A10 10 0 0 0 2 12h10Z" fill="#fbbc05" />
      <path d="M12 12 7 20.66A10 10 0 0 0 22 12H12Z" fill="#34a853" />
      <circle cx="12" cy="12" fill="#fff" r="4.1" />
      <circle cx="12" cy="12" fill="#4285f4" r="2.8" />
    </svg>
  );
}
