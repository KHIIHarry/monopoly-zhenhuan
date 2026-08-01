import Fastify from 'fastify';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { mapApiError, RuleError, TransferRuleError } from './api-error.js';

async function parserResponse(input: { contentType: string; payload: string; bodyLimit?: number }) {
  const app = Fastify({ bodyLimit: input.bodyLimit });
  app.setErrorHandler((error, _request, reply) => {
    const mapped = mapApiError(error);
    reply.status(mapped.status).send(mapped.body);
  });
  app.post('/payload', async (request) => request.body);

  try {
    return await app.inject({
      method: 'POST',
      url: '/payload',
      headers: { 'content-type': input.contentType },
      payload: input.payload,
    });
  } finally {
    await app.close();
  }
}

describe('mapApiError', () => {
  it('maps invalid request bodies to a public 400 response', () => {
    const parsed = z.object({ amount: z.number().int().positive() }).safeParse({ amount: '500' });
    if (parsed.success) throw new Error('expected validation failure');

    expect(mapApiError(parsed.error)).toEqual({
      status: 400,
      body: { error: 'INVALID_REQUEST' },
      expose: true,
    });
  });

  it.each(['INVALID_DEVICE_TOKEN'])(
    'maps %s to 401',
    (code) => {
      expect(mapApiError(new RuleError(code))).toEqual({
        status: 401,
        body: { error: code },
        expose: true,
      });
    },
  );

  it.each(['UNAUTHORIZED', 'BANK_REQUIRED', 'PLAYER_IDENTITY_MISMATCH', 'ROOM_MEMBERSHIP_REQUIRED', 'ADMIN_REQUIRED'])(
    'maps %s to 403',
    (code) => {
      expect(mapApiError(new RuleError(code))).toEqual({
        status: 403,
        body: { error: code },
        expose: true,
      });
    },
  );

  it('keeps missing resources and rule conflicts distinct', () => {
    expect(mapApiError(new RuleError('ROOM_NOT_FOUND'))).toEqual({
      status: 404,
      body: { error: 'ROOM_NOT_FOUND' },
      expose: true,
    });
    expect(mapApiError(new RuleError('PROPERTY_LOCKED'))).toEqual({
      status: 409,
      body: { error: 'PROPERTY_LOCKED' },
      expose: true,
    });
    expect(mapApiError(new RuleError('LEGACY_SETTLEMENT_UNAVAILABLE'))).toEqual({
      status: 409,
      body: { error: 'LEGACY_SETTLEMENT_UNAVAILABLE' },
      expose: true,
    });
    expect(mapApiError(new RuleError('SETTLEMENT_INCONSISTENT'))).toEqual({
      status: 500,
      body: { error: 'SETTLEMENT_INCONSISTENT' },
      expose: true,
    });
  });

  it('maps room permissions and password throttling to their HTTP status classes', () => {
    expect(mapApiError(new RuleError('ROOM_CREATE_FORBIDDEN'))).toEqual({
      status: 403,
      body: { error: 'ROOM_CREATE_FORBIDDEN' },
      expose: true,
    });
    expect(mapApiError(new RuleError('RATE_LIMITED'))).toEqual({
      status: 429,
      body: { error: 'RATE_LIMITED' },
      expose: true,
    });
  });

  it('does not expose unknown exception messages', () => {
    expect(mapApiError(new Error('postgresql://user:secret@db/internal'))).toEqual({
      status: 500,
      body: { error: 'INTERNAL_ERROR' },
      expose: false,
    });
  });

  it('exposes the authoritative transfer approval mode only for transfer rule errors', () => {
    expect(mapApiError(new TransferRuleError('INSUFFICIENT_BALANCE', true))).toEqual({
      status: 409,
      body: { error: 'INSUFFICIENT_BALANCE', transferApprovalRequired: true },
      expose: true,
    });
    expect(mapApiError(new TransferRuleError('PLAYER_NOT_FOUND', false))).toEqual({
      status: 404,
      body: { error: 'PLAYER_NOT_FOUND', transferApprovalRequired: false },
      expose: true,
    });
    expect(mapApiError(new RuleError('INSUFFICIENT_BALANCE')).body).toEqual({
      error: 'INSUFFICIENT_BALANCE',
    });
    expect(mapApiError(new TransferRuleError('INTERNAL_ERROR', true))).toEqual({
      status: 500,
      body: { error: 'INTERNAL_ERROR', transferApprovalRequired: true },
      expose: true,
    });
  });

  it('maps malformed JSON from the Fastify parser to a public 400 response', async () => {
    const response = await parserResponse({
      contentType: 'application/json',
      payload: '{"amount":',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'INVALID_REQUEST' });
  });

  it('preserves 413 and 415 semantics for Fastify content parser errors', async () => {
    const oversized = await parserResponse({
      contentType: 'application/json',
      payload: JSON.stringify({ value: 'too long' }),
      bodyLimit: 8,
    });
    const unsupported = await parserResponse({
      contentType: 'application/xml',
      payload: '<value />',
    });

    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toEqual({ error: 'PAYLOAD_TOO_LARGE' });
    expect(unsupported.statusCode).toBe(415);
    expect(unsupported.json()).toEqual({ error: 'UNSUPPORTED_MEDIA_TYPE' });
  });
});
