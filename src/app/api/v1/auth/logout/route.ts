/** POST /api/v1/auth/logout */

import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/db';
import { logout } from '@/services/auth';
import { currentActor } from '@/lib/auth/current';
import { SESSION_COOKIE } from '@/lib/auth/session';
import { toErrorResponse } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const token = request.cookies.get(SESSION_COOKIE)?.value;
    const actor = await currentActor();
    if (token) await logout(db, token, actor?.user ?? null, actor?.ipHash ?? null);

    const response = NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
    response.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 });
    return response;
  } catch (err) {
    return toErrorResponse(err);
  }
}
