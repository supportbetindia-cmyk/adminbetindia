/**
 * Production configuration checks.
 *
 * Run once at server start (see src/instrumentation.ts). The point is to fail
 * loudly at boot rather than quietly at runtime: a missing salt or an http://
 * base URL produces a system that appears to work and is silently wrong — a
 * plaintext session cookie, or short URLs no publisher can use.
 *
 * Errors stop the process. Warnings are printed and allow start, because they
 * describe a weaker configuration rather than a broken one.
 */

export interface ConfigReport {
  errors: string[];
  warnings: string[];
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function value(name: string): string | undefined {
  const raw = process.env[name];
  return raw && raw.trim() ? raw.trim() : undefined;
}

export function checkConfig(): ConfigReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  const databaseUrl = value('DATABASE_URL');
  if (!databaseUrl) {
    errors.push('DATABASE_URL is not set.');
  }

  if (!isProduction()) {
    return { errors, warnings };
  }

  // ── Secrets ────────────────────────────────────────────────

  const salt = value('IP_HASH_SALT');
  if (!salt) {
    errors.push('IP_HASH_SALT must be set in production (no raw IP is ever stored, only a salted hash).');
  } else if (salt.length < 32) {
    errors.push(`IP_HASH_SALT is only ${salt.length} characters. Use at least 32 random characters — a short salt is brute-forceable over the IP space.`);
  } else if (/^(change[_-]?me|test|dev|secret|placeholder)/i.test(salt)) {
    errors.push('IP_HASH_SALT still looks like a placeholder value.');
  }

  // ── Public URLs ────────────────────────────────────────────

  const base = value('SMART_LINK_BASE_URL');
  if (!base) {
    warnings.push('SMART_LINK_BASE_URL is not set; falling back to the built-in default. Set it so publishers get the right domain.');
  } else if (!base.startsWith('https://')) {
    errors.push(`SMART_LINK_BASE_URL must be https in production, got "${base}". Session cookies are Secure and will not be sent over http.`);
  }

  const publicUrl = value('PUBLIC_APP_URL');
  if (publicUrl && !publicUrl.startsWith('https://')) {
    errors.push(`PUBLIC_APP_URL must be https in production, got "${publicUrl}".`);
  }

  // ── Destination allowlist (TRD §5) ─────────────────────────

  const allowlist = value('DESTINATION_HOST_ALLOWLIST');
  if (!allowlist) {
    warnings.push('DESTINATION_HOST_ALLOWLIST is not set; using the built-in default. Set it explicitly so the approved destinations are visible in config rather than in code.');
  } else if (allowlist.split(',').some((host) => host.trim() === '*')) {
    errors.push('DESTINATION_HOST_ALLOWLIST contains "*". That disables open-redirect protection, which TRD §5 requires.');
  }

  // ── Webhook authentication (TRD §6) ────────────────────────

  if (!value('INTERAKT_WEBHOOK_SECRET')) {
    warnings.push('INTERAKT_WEBHOOK_SECRET is not set: the Interakt capture endpoint accepts unauthenticated requests. Events are recorded as unverified and shown as such on the Integrations screen.');
  }

  // ── Database ───────────────────────────────────────────────

  if (databaseUrl) {
    if (/localhost|127\.0\.0\.1/.test(databaseUrl)) {
      warnings.push('DATABASE_URL points at localhost while NODE_ENV=production. Confirm that is intended.');
    }
    if (/^postgres(ql)?:\/\/[^:]+:(postgres|password|admin|root|changeme)@/i.test(databaseUrl)) {
      errors.push('DATABASE_URL uses a well-known default password.');
    }
    if (!/sslmode=/i.test(databaseUrl) && !/localhost|127\.0\.0\.1/.test(databaseUrl)) {
      warnings.push('DATABASE_URL has no sslmode parameter. For a remote database, use sslmode=verify-full.');
    }
  }

  return { errors, warnings };
}

/**
 * Prints the report and exits on any error.
 *
 * Refusing to start is the right response: every error here describes a
 * configuration that would run, serve traffic, and be wrong in a way nobody
 * notices until the data is already bad.
 */
export function assertConfig(): void {
  const { errors, warnings } = checkConfig();

  for (const warning of warnings) {
    console.warn(`[config] warning: ${warning}`);
  }

  if (errors.length === 0) {
    if (isProduction()) console.log('[config] production configuration checks passed');
    return;
  }

  console.error('\n[config] refusing to start — production configuration is not valid:\n');
  for (const error of errors) console.error(`  • ${error}`);
  console.error('');

  throw new Error(`Invalid configuration: ${errors.length} error(s). See the list above.`);
}
