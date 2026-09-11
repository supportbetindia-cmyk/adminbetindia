import { redirect } from 'next/navigation';
import { currentActor } from '@/lib/auth/current';
import { LoginForm } from './login-form';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Sign in — BetIndia Smart Link Manager' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  if (await currentActor()) redirect('/dashboard');

  const { next } = await searchParams;
  // Only same-origin paths survive, so this cannot become an open redirect.
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';

  return (
    <main className="login">
      <div className="login__card">
        <div className="login__brand">BetIndia</div>
        <h1 className="login__title">Smart Link Manager</h1>
        <LoginForm next={safeNext} />
      </div>
    </main>
  );
}
