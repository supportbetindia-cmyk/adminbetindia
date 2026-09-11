'use server';

/**
 * Server Actions behind the admin forms.
 *
 * Each one is a thin wrapper over the same service the REST API calls, so
 * permission checks, validation and audit logging happen once and cannot
 * diverge between the two transports.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { cookies, headers } from 'next/headers';
import { db } from '@/db';
import { requireActorOrThrow } from '@/lib/auth/current';
import { SESSION_COOKIE } from '@/lib/auth/session';
import { clientIpFrom } from '@/lib/client-signals';
import { hashIp } from '@/lib/privacy';
import { login, logout } from '@/services/auth';
import { createPublisher, updatePublisher } from '@/services/publishers';
import { createCampaign, updateCampaign } from '@/services/campaigns';
import { createCreative } from '@/services/creatives';
import {
  approveDestination, createDestination, rejectDestination, revokeDestination,
} from '@/services/destinations';
import { changeSmartLinkDestination, createSmartLink, updateSmartLink } from '@/services/smart-links';
import { createUser, updateUser } from '@/services/users';
import { recordCampaignCost } from '@/services/costs';
import { runAction, toPayload, type FormState } from './form-state';

// ── Authentication ───────────────────────────────────────────

export async function signInAction(_prev: FormState, data: FormData): Promise<FormState> {
  const headerList = await headers();

  const result = await login(db, {
    email: String(data.get('email') ?? ''),
    password: String(data.get('password') ?? ''),
    ipHash: hashIp(clientIpFrom(headerList)),
    userAgent: headerList.get('user-agent'),
  });

  if (result.status === 'rate_limited') {
    return {
      ok: false,
      message: `Too many attempts. Try again in ${Math.ceil(result.retryAfterSeconds / 60)} minute(s).`,
      values: { email: String(data.get('email') ?? '') },
    };
  }

  // A suspended account and a wrong password give the same answer, so this
  // form cannot be used to discover which emails have accounts.
  if (result.status !== 'ok') {
    return {
      ok: false,
      message: 'Email or password is incorrect.',
      values: { email: String(data.get('email') ?? '') },
    };
  }

  const jar = await cookies();
  jar.set(SESSION_COOKIE, result.session.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    expires: result.session.expiresAt,
  });

  const next = String(data.get('next') ?? '/dashboard');
  // Only same-origin paths, so `next` cannot be turned into an open redirect.
  redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard');
}

export async function signOutAction(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    const headerList = await headers();
    const { currentActor } = await import('@/lib/auth/current');
    const actor = await currentActor();
    await logout(db, token, actor?.user ?? null, hashIp(clientIpFrom(headerList)));
  }
  jar.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 });
  redirect('/login');
}

// ── Publishers ───────────────────────────────────────────────

const PUBLISHER_BOOLEANS = ['trackingUrlApproved', 'scriptsAllowed', 'postbacksAllowed'];
const PUBLISHER_ARRAYS = ['permittedDestinationTypes'];

export async function createPublisherAction(_prev: FormState, data: FormData): Promise<FormState> {
  return runAction(data, async () => {
    const actor = await requireActorOrThrow();
    const payload = toPayload(data, { booleans: PUBLISHER_BOOLEANS, arrays: PUBLISHER_ARRAYS });
    payload.trackingMacros = splitList(data.get('trackingMacros'));
    const publisher = await createPublisher(db, actor, payload);
    revalidatePath('/publishers');
    redirect(`/publishers/${publisher.id}`);
  });
}

export async function updatePublisherAction(_prev: FormState, data: FormData): Promise<FormState> {
  return runAction(data, async () => {
    const actor = await requireActorOrThrow();
    const id = String(data.get('id'));
    const payload = toPayload(data, { booleans: PUBLISHER_BOOLEANS, arrays: PUBLISHER_ARRAYS });
    delete payload.id;
    payload.trackingMacros = splitList(data.get('trackingMacros'));
    await updatePublisher(db, actor, id, payload);
    revalidatePath(`/publishers/${id}`);
    revalidatePath('/publishers');
    return { ok: true, message: 'Publisher updated.' };
  });
}

// ── Campaigns ────────────────────────────────────────────────

export async function createCampaignAction(_prev: FormState, data: FormData): Promise<FormState> {
  return runAction(data, async () => {
    const actor = await requireActorOrThrow();
    const campaign = await createCampaign(db, actor, toPayload(data, { numbers: ['attributionWindowDays'] }));
    revalidatePath('/campaigns');
    redirect(`/campaigns/${campaign.id}`);
  });
}

export async function updateCampaignAction(_prev: FormState, data: FormData): Promise<FormState> {
  return runAction(data, async () => {
    const actor = await requireActorOrThrow();
    const id = String(data.get('id'));
    const payload = toPayload(data, { numbers: ['attributionWindowDays'] });
    delete payload.id;
    await updateCampaign(db, actor, id, payload);
    revalidatePath(`/campaigns/${id}`);
    revalidatePath('/campaigns');
    return { ok: true, message: 'Campaign updated.' };
  });
}

export async function setCampaignStatusAction(_prev: FormState, data: FormData): Promise<FormState> {
  return runAction(data, async () => {
    const actor = await requireActorOrThrow();
    const id = String(data.get('id'));
    await updateCampaign(db, actor, id, { status: String(data.get('status')) });
    revalidatePath(`/campaigns/${id}`);
    revalidatePath('/campaigns');
    return { ok: true, message: `Campaign is now ${data.get('status')}.` };
  });
}

export async function createCreativeAction(_prev: FormState, data: FormData): Promise<FormState> {
  return runAction(data, async () => {
    const actor = await requireActorOrThrow();
    await createCreative(db, actor, toPayload(data));
    revalidatePath(`/campaigns/${data.get('campaignId')}`);
    return { ok: true, message: 'Creative added.' };
  });
}

export async function recordCostAction(_prev: FormState, data: FormData): Promise<FormState> {
  return runAction(data, async () => {
    const actor = await requireActorOrThrow();
    await recordCampaignCost(db, actor, toPayload(data));
    revalidatePath(`/campaigns/${data.get('campaignId')}`);
    revalidatePath('/reports');
    return { ok: true, message: 'Spend recorded.' };
  });
}

// ── Destinations ─────────────────────────────────────────────

export async function createDestinationAction(_prev: FormState, data: FormData): Promise<FormState> {
  return runAction(data, async () => {
    const actor = await requireActorOrThrow();
    const payload = toPayload(data);
    if (payload.publisherId === '') payload.publisherId = null;
    await createDestination(db, actor, payload);
    revalidatePath('/destinations');
    return { ok: true, message: 'Destination registered. It cannot be used until approved.' };
  });
}

export async function approveDestinationAction(_prev: FormState, data: FormData): Promise<FormState> {
  return runAction(data, async () => {
    const actor = await requireActorOrThrow();
    await approveDestination(db, actor, String(data.get('id')), toPayload(data));
    revalidatePath('/destinations');
    return { ok: true, message: 'Destination approved.' };
  });
}

export async function rejectDestinationAction(_prev: FormState, data: FormData): Promise<FormState> {
  return runAction(data, async () => {
    const actor = await requireActorOrThrow();
    await rejectDestination(db, actor, String(data.get('id')), toPayload(data));
    revalidatePath('/destinations');
    return { ok: true, message: 'Destination rejected.' };
  });
}

export async function revokeDestinationAction(_prev: FormState, data: FormData): Promise<FormState> {
  return runAction(data, async () => {
    const actor = await requireActorOrThrow();
    await revokeDestination(db, actor, String(data.get('id')), toPayload(data));
    revalidatePath('/destinations');
    revalidatePath('/smart-links');
    return { ok: true, message: 'Approval withdrawn. Links using it have stopped redirecting.' };
  });
}

// ── Smart links ──────────────────────────────────────────────

export async function createSmartLinkAction(_prev: FormState, data: FormData): Promise<FormState> {
  return runAction(data, async () => {
    const actor = await requireActorOrThrow();
    const payload = toPayload(data);
    if (payload.creativeId === '') payload.creativeId = null;
    const link = await createSmartLink(db, actor, payload);
    revalidatePath('/smart-links');
    redirect(`/smart-links/${link.id}`);
  });
}

export async function setSmartLinkStatusAction(_prev: FormState, data: FormData): Promise<FormState> {
  return runAction(data, async () => {
    const actor = await requireActorOrThrow();
    const id = String(data.get('id'));
    await updateSmartLink(db, actor, id, { status: String(data.get('status')) });
    revalidatePath(`/smart-links/${id}`);
    revalidatePath('/smart-links');
    return { ok: true, message: `Link is now ${data.get('status')}.` };
  });
}

export async function changeDestinationAction(_prev: FormState, data: FormData): Promise<FormState> {
  return runAction(data, async () => {
    const actor = await requireActorOrThrow();
    const id = String(data.get('id'));
    const result = await changeSmartLinkDestination(db, actor, id, toPayload(data));
    revalidatePath(`/smart-links/${id}`);
    revalidatePath('/smart-links');
    return { ok: true, message: `Destination moved to version ${result.version}. Historical clicks are unchanged.` };
  });
}

// ── Users ────────────────────────────────────────────────────

export async function createUserAction(_prev: FormState, data: FormData): Promise<FormState> {
  return runAction(data, async () => {
    const actor = await requireActorOrThrow();
    await createUser(db, actor, toPayload(data));
    revalidatePath('/settings');
    return { ok: true, message: 'User created.' };
  });
}

export async function updateUserAction(_prev: FormState, data: FormData): Promise<FormState> {
  return runAction(data, async () => {
    const actor = await requireActorOrThrow();
    const payload = toPayload(data);
    delete payload.id;
    if (payload.password === '') delete payload.password;
    await updateUser(db, actor, String(data.get('id')), payload);
    revalidatePath('/settings');
    return { ok: true, message: 'User updated. Their existing sessions were signed out.' };
  });
}

/** "pcid, click_id" → ["pcid", "click_id"] for the macro list field. */
function splitList(value: FormDataEntryValue | null): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  return value.split(',').map((v) => v.trim()).filter(Boolean);
}
