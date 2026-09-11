import Link from 'next/link';

export default function AdminNotFound() {
  return (
    <div className="content">
      <div className="card">
        <div className="card__body">
          <div className="state">
            <span className="state__icon" aria-hidden>◌</span>
            <p className="state__title">Not found</p>
            <p className="state__body">That record does not exist, or it was never created.</p>
            <Link href="/dashboard" className="btn btn--primary">Back to dashboard</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
