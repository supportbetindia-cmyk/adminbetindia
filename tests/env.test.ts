/**
 * Tests for the boot-time production configuration check.
 *
 * These matter because every case here describes a deployment that would start
 * happily and be wrong in a way nobody notices — a short salt, an http base
 * URL that silently breaks Secure cookies, a wildcard destination allowlist
 * that disables open-redirect protection (TRD §5, §14).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { checkConfig } from '../src/lib/env';

const VALID = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://app:s3cr3t@db.example.com/smartlink?sslmode=verify-full',
  IP_HASH_SALT: 'a'.repeat(64),
  SMART_LINK_BASE_URL: 'https://go.betindia.games',
  DESTINATION_HOST_ALLOWLIST: 'betindia.bet,www.betindia.bet,wa.me',
  INTERAKT_WEBHOOK_SECRET: 'a-real-secret-value',
};

/** Runs checkConfig against an isolated environment. */
function check(overrides: Record<string, string | undefined>) {
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(VALID)) delete process.env[key];
    for (const key of ['PUBLIC_APP_URL']) delete process.env[key];
    Object.assign(process.env, { ...VALID, ...overrides });
    for (const [key, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[key];
    }
    return checkConfig();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

test('a correct production configuration passes', () => {
  const { errors } = check({});
  assert.deepEqual(errors, []);
});

test('a missing or placeholder salt is refused', () => {
  assert.match(check({ IP_HASH_SALT: undefined }).errors.join(' '), /IP_HASH_SALT must be set/);
  assert.match(check({ IP_HASH_SALT: 'short' }).errors.join(' '), /only 5 characters/);
  assert.match(check({ IP_HASH_SALT: `CHANGE_ME${'x'.repeat(40)}` }).errors.join(' '), /placeholder/);
});

test('an http base URL is refused, because Secure cookies will not be sent over it', () => {
  const { errors } = check({ SMART_LINK_BASE_URL: 'http://go.betindia.games' });
  assert.match(errors.join(' '), /must be https/);
});

test('a wildcard destination allowlist is refused', () => {
  const { errors } = check({ DESTINATION_HOST_ALLOWLIST: 'betindia.bet,*' });
  assert.match(errors.join(' '), /open-redirect/);
});

test('a well-known database password is refused', () => {
  const { errors } = check({
    DATABASE_URL: 'postgresql://postgres:postgres@db.example.com/smartlink?sslmode=verify-full',
  });
  assert.match(errors.join(' '), /well-known default password/);
});

test('a missing DATABASE_URL is refused even outside production', () => {
  const { errors } = check({ NODE_ENV: 'development', DATABASE_URL: undefined });
  assert.match(errors.join(' '), /DATABASE_URL is not set/);
});

test('development is not held to the production rules', () => {
  const { errors } = check({
    NODE_ENV: 'development',
    IP_HASH_SALT: undefined,
    SMART_LINK_BASE_URL: 'http://localhost:3000',
  });
  assert.deepEqual(errors, [], 'local development must not require production-grade config');
});

test('weaker-but-working settings warn rather than block', () => {
  const unauthenticatedWebhook = check({ INTERAKT_WEBHOOK_SECRET: undefined });
  assert.deepEqual(unauthenticatedWebhook.errors, []);
  assert.match(unauthenticatedWebhook.warnings.join(' '), /unauthenticated/);

  const noSsl = check({ DATABASE_URL: 'postgresql://app:pw@db.example.com/smartlink' });
  assert.deepEqual(noSsl.errors, []);
  assert.match(noSsl.warnings.join(' '), /sslmode/);
});
