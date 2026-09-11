'use client';

import { createUserAction, updateUserAction } from '@/server/actions';
import { ADMIN_ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS } from '@/lib/auth/rbac';
import { ActionForm, Field, Select, SubmitButton, TextInput } from './form';

const ROLE_OPTIONS = ADMIN_ROLES.map((role) => ({
  value: role,
  label: `${ROLE_LABELS[role]} — ${ROLE_DESCRIPTIONS[role]}`,
}));

export function CreateUserForm() {
  return (
    <ActionForm action={createUserAction}>
      {(state) => (
        <>
          <div className="form-grid">
            <Field label="Email" name="email" required error={state.fields?.email}>
              <TextInput name="email" type="email" required defaultValue={state.values?.email ?? ''} error={state.fields?.email} />
            </Field>
            <Field label="Name" name="name">
              <TextInput name="name" defaultValue={state.values?.name ?? ''} />
            </Field>
            <Field label="Role" name="role" required error={state.fields?.role}>
              <Select name="role" required placeholder="Select a role" options={ROLE_OPTIONS} error={state.fields?.role} />
            </Field>
            <Field
              label="Initial password"
              name="password"
              required
              error={state.fields?.password}
              hint="At least 12 characters. Stored as a scrypt hash and never shown again."
            >
              <TextInput name="password" type="password" required minLength={12} autoComplete="new-password" error={state.fields?.password} />
            </Field>
          </div>
          <div className="row"><SubmitButton>Create user</SubmitButton></div>
        </>
      )}
    </ActionForm>
  );
}

/**
 * Role, status and password changes all revoke the user's live sessions, so
 * the change takes effect immediately rather than at their next sign-in.
 */
export function EditUserForm({
  user,
}: {
  user: { id: string; email: string; name: string | null; role: string; status: string };
}) {
  return (
    <ActionForm action={updateUserAction} className="stack stack--tight">
      {(state) => (
        <>
          <input type="hidden" name="id" value={user.id} />
          <div className="row">
            <select name="role" defaultValue={user.role} aria-label={`Role for ${user.email}`}>
              {ADMIN_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </select>
            <select name="status" defaultValue={user.status} aria-label={`Status for ${user.email}`}>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
            </select>
            <input
              type="password"
              name="password"
              placeholder="New password (optional)"
              minLength={12}
              autoComplete="new-password"
              aria-label={`New password for ${user.email}`}
              style={{ maxWidth: 200 }}
            />
            <SubmitButton variant="default" confirm={`Update ${user.email}? Their current sessions will be signed out.`}>
              Save
            </SubmitButton>
          </div>
          {state.fields?.password && <span className="field__error">{state.fields.password}</span>}
        </>
      )}
    </ActionForm>
  );
}
