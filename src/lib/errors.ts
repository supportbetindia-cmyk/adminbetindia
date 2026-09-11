/**
 * Service-layer errors.
 *
 * Services throw these; the transport (REST route or Server Action) maps them
 * to a status code or a form error. Keeping them transport-free means one
 * implementation serves both the API in TRD §6 and the admin UI.
 */

export type ServiceErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'conflict'
  | 'precondition_failed'
  | 'rate_limited';

const STATUS: Record<ServiceErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 422,
  conflict: 409,
  precondition_failed: 412,
  rate_limited: 429,
};

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  readonly status: number;
  /** Field-level messages for form rendering (UI/UX §6: "Show validation inline"). */
  readonly fields: Record<string, string>;

  constructor(code: ServiceErrorCode, message: string, fields: Record<string, string> = {}) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.status = STATUS[code];
    this.fields = fields;
  }
}

export const unauthenticated = (msg = 'Sign in required') =>
  new ServiceError('unauthenticated', msg);

export const forbidden = (msg = 'You do not have permission to do that') =>
  new ServiceError('forbidden', msg);

export const notFound = (what = 'Record') =>
  new ServiceError('not_found', `${what} not found`);

export const invalid = (msg: string, fields: Record<string, string> = {}) =>
  new ServiceError('validation_failed', msg, fields);

export const conflict = (msg: string, fields: Record<string, string> = {}) =>
  new ServiceError('conflict', msg, fields);

export const precondition = (msg: string, fields: Record<string, string> = {}) =>
  new ServiceError('precondition_failed', msg, fields);
