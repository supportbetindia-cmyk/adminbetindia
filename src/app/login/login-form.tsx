'use client';

import { signInAction } from '@/server/actions';
import { ActionForm, Field, SubmitButton, TextInput } from '@/components/form';

export function LoginForm({ next }: { next: string }) {
  return (
    <ActionForm action={signInAction}>
      {(state) => (
        <>
          <input type="hidden" name="next" value={next} />

          <Field label="Email" name="email" required>
            <TextInput
              name="email"
              type="email"
              autoComplete="username"
              required
              autoFocus
              defaultValue={state.values?.email ?? ''}
            />
          </Field>

          <Field label="Password" name="password" required>
            <TextInput name="password" type="password" autoComplete="current-password" required />
          </Field>

          <SubmitButton>Sign in</SubmitButton>

          <p className="small muted">
            Accounts are created by a Super Admin. TRD §14 requires MFA for privileged
            users — enrolment is not built yet and is tracked as an open item.
          </p>
        </>
      )}
    </ActionForm>
  );
}
