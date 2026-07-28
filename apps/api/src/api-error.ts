import { ZodError } from 'zod';

const authenticationErrors = new Set([
  'AUTH_REQUIRED',
  'INVALID_CREDENTIALS',
  'SESSION_INVALID',
  'INVALID_DEVICE_TOKEN',
]);
const permissionErrors = new Set([
  'ROOM_CREATE_FORBIDDEN',
  'ROOM_MEMBERSHIP_REQUIRED',
  'ADMIN_REQUIRED',
  'BANK_JOIN_REQUIRED',
  'BANK_REQUIRED',
  'PLAYER_IDENTITY_MISMATCH',
  'UNAUTHORIZED',
]);
const rateLimitErrors = new Set(['RATE_LIMITED']);

const fastifyParserErrors = new Map<string, { status: number; code: string }>([
  ['FST_ERR_CTP_EMPTY_TYPE', { status: 400, code: 'INVALID_REQUEST' }],
  ['FST_ERR_CTP_INVALID_CONTENT_LENGTH', { status: 400, code: 'INVALID_REQUEST' }],
  ['FST_ERR_CTP_EMPTY_JSON_BODY', { status: 400, code: 'INVALID_REQUEST' }],
  ['FST_ERR_CTP_INVALID_JSON_BODY', { status: 400, code: 'INVALID_REQUEST' }],
  ['FST_ERR_CTP_BODY_TOO_LARGE', { status: 413, code: 'PAYLOAD_TOO_LARGE' }],
  ['FST_ERR_CTP_INVALID_MEDIA_TYPE', { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' }],
]);

export class RuleError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'RuleError';
  }
}

export function mapApiError(error: unknown) {
  if (error instanceof ZodError) {
    return {
      status: 400,
      body: { error: 'INVALID_REQUEST' },
      expose: true,
    };
  }

  if (error instanceof RuleError) {
    const status = error.code === 'SETTLEMENT_INCONSISTENT'
      ? 500
      : authenticationErrors.has(error.code)
      ? 401
      : permissionErrors.has(error.code)
        ? 403
        : rateLimitErrors.has(error.code)
          ? 429
      : error.code.endsWith('_NOT_FOUND')
        ? 404
        : 409;
    return {
      status,
      body: { error: error.code },
      expose: true,
    };
  }

  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    const mapped = fastifyParserErrors.get(error.code);
    if (mapped) {
      return {
        status: mapped.status,
        body: { error: mapped.code },
        expose: true,
      };
    }
  }

  return {
    status: 500,
    body: { error: 'INTERNAL_ERROR' },
    expose: false,
  };
}
