/**
 * Authenticated shell for every admin screen.
 *
 * The session check lives here rather than in middleware so it runs against
 * the database on every request — a revoked session or a suspended user must
 * stop working immediately, which a cookie-only check in middleware cannot
 * guarantee.
 */

import { headers } from 'next/headers';
import { requireActor } from '@/lib/auth/current';
import { Sidebar } from '@/components/app-shell';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // `x-pathname` is not a standard header; Next sets `x-invoke-path` only in
  // some runtimes, so the current path comes from the referer-free header the
  // middleware sets. Falls back to the dashboard for highlight purposes only.
  const headerList = await headers();
  const pathname = headerList.get('x-pathname') ?? '/dashboard';

  const actor = await requireActor(pathname);

  return (
    <div className="shell">
      <Sidebar role={actor.user.role} pathname={pathname} />
      <div className="main">{children}</div>
    </div>
  );
}
