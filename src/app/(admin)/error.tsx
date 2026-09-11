'use client';

/** Error state required for every screen by UI/UX §14. */

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="content">
      <div className="card">
        <div className="card__body">
          <div className="state">
            <span className="state__icon" aria-hidden>⚠</span>
            <p className="state__title">This screen could not load</p>
            <p className="state__body">
              The error has been logged. If it repeats, check that the database is reachable and that
              migrations have been applied.
            </p>
            {/* digest only — an internal message must not reach the browser. */}
            {error.digest && <p className="small subtle mono">Reference: {error.digest}</p>}
            <button type="button" className="btn btn--primary" onClick={reset}>Try again</button>
          </div>
        </div>
      </div>
    </div>
  );
}
