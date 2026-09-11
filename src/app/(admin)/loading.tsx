/** Loading skeleton required by UI/UX §13. */

export default function AdminLoading() {
  return (
    <div className="content" aria-busy="true" aria-live="polite">
      <span className="visually-hidden">Loading</span>
      <div className="metrics">
        {Array.from({ length: 8 }).map((_, i) => (
          <div className="metric" key={i}>
            <span className="metric__label" style={{ background: 'var(--neutral-bg)', height: 12, borderRadius: 4, width: '60%' }} />
            <span className="metric__value" style={{ background: 'var(--neutral-bg)', height: 28, borderRadius: 6, width: '45%' }} />
          </div>
        ))}
      </div>
      <div className="card">
        <div className="card__body">
          <div style={{ background: 'var(--neutral-bg)', height: 160, borderRadius: 'var(--r-card)' }} />
        </div>
      </div>
    </div>
  );
}
