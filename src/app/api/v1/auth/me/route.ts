/** GET /api/v1/auth/me — the signed-in user and everything their role permits. */

import { json, route } from '@/lib/api';
import { permissionsFor, ROLE_DESCRIPTIONS, ROLE_LABELS } from '@/lib/auth/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(({ actor }) =>
  json({
    user: actor.user,
    role: {
      key: actor.user.role,
      label: ROLE_LABELS[actor.user.role],
      description: ROLE_DESCRIPTIONS[actor.user.role],
    },
    permissions: permissionsFor(actor.user.role),
    // TRD §14 requires MFA for privileged users; enrolment is not built yet.
    warnings: actor.user.mfaEnrolled ? [] : ['mfa_not_enrolled'],
  }),
);
