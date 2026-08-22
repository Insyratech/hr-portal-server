import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';

export type AccessTokenPayload = {
  sub: string;
  email: string;
};

export type VerifyAccessTokenOptions = {
  jwtSecret: string;
  supabaseUrl: string;
};

const jwksByUrl = new Map<string, JWTVerifyGetKey>();

function jwksFor(supabaseUrl: string): JWTVerifyGetKey {
  const origin = supabaseUrl.replace(/\/$/, '');
  const cached = jwksByUrl.get(origin);
  if (cached) {
    return cached;
  }

  const jwks = createRemoteJWKSet(new URL(`${origin}/auth/v1/.well-known/jwks.json`));
  jwksByUrl.set(origin, jwks);
  return jwks;
}

export async function verifyAccessToken(
  token: string,
  options: VerifyAccessTokenOptions,
): Promise<AccessTokenPayload> {
  try {
    const header = decodeProtectedHeader(token);
    const key =
      header.alg === 'HS256'
        ? new TextEncoder().encode(options.jwtSecret)
        : jwksFor(options.supabaseUrl);

    const { payload } = await jwtVerify(token, key);
    const sub = typeof payload.sub === 'string' ? payload.sub : '';
    const email = typeof payload.email === 'string' ? payload.email : '';

    if (!sub) {
      throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Invalid access token.', 401);
    }

    return { sub, email };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Invalid or expired access token.', 401);
  }
}
