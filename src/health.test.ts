import { SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadEnv } from './config/env';
import { verifyAccessToken } from './modules/auth/verify-access-token';
import { API_ERROR_CODES } from './shared/constants/error-codes';
import { AppError } from './shared/errors/app-error';
import type { FastifyInstance } from 'fastify';

describe('Phase 6 API', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('GET /health returns phase 6', async () => {
    app = await buildApp(loadEnv({ NODE_ENV: 'test' }));
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.phase).toBe(6);
  });

  it('POST job routes reject missing cron secret', async () => {
    app = await buildApp(loadEnv({ NODE_ENV: 'test', CRON_SECRET: 'test-cron' }));
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs/attendance/finalize',
      payload: {},
    });
    expect(response.statusCode).toBe(401);
  });

  it('GET /api/v1/me without a token returns 401', async () => {
    app = await buildApp(loadEnv({ NODE_ENV: 'test' }));
    const response = await app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe(API_ERROR_CODES.UNAUTHORIZED);
  });

  it('POST /api/v1/employees without users.manage returns 401 when unauthenticated', async () => {
    app = await buildApp(loadEnv({ NODE_ENV: 'test' }));
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/employees',
      payload: {
        employeeCode: 'X-1',
        fullName: 'Test',
        email: 'test@example.com',
        joiningDate: '2026-01-01',
        employmentType: 'full_time',
        roleId: '00000000-0000-4000-8000-000000000003',
        password: 'password1',
      },
    });
    expect(response.statusCode).toBe(401);
  });

  it('error handler still returns AppError as a failure envelope', async () => {
    app = await buildApp(loadEnv({ NODE_ENV: 'test' }));
    app.get('/boom', async () => {
      throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Invalid payload', 400);
    });

    const response = await app.inject({ method: 'GET', url: '/boom' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      success: false,
      error: {
        code: API_ERROR_CODES.VALIDATION_ERROR,
        message: 'Invalid payload',
      },
    });
  });
});

describe('verifyAccessToken', () => {
  const secret = 'test-jwt-secret-value';

  it('accepts a valid HS256 token', async () => {
    const token = await new SignJWT({ email: 'person@example.com' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-1')
      .sign(new TextEncoder().encode(secret));

    await expect(verifyAccessToken(token, { jwtSecret: secret, supabaseUrl: 'https://example.supabase.co' })).resolves.toEqual({
      sub: 'user-1',
      email: 'person@example.com',
    });
  });

  it('rejects a token signed with the wrong secret', async () => {
    const token = await new SignJWT({ email: 'person@example.com' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-1')
      .sign(new TextEncoder().encode('other-secret'));

    await expect(
      verifyAccessToken(token, { jwtSecret: secret, supabaseUrl: 'https://example.supabase.co' }),
    ).rejects.toMatchObject({
      code: API_ERROR_CODES.UNAUTHORIZED,
      statusCode: 401,
    });
  });
});
