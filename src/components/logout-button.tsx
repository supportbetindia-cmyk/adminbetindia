'use client';

import { useFormStatus } from 'react-dom';
import { signOutAction } from '@/server/actions';

function Button() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn--sm" disabled={pending}>
      {pending ? 'Signing out…' : 'Sign out'}
    </button>
  );
}

export function LogoutButton() {
  return (
    <form action={signOutAction}>
      <Button />
    </form>
  );
}
