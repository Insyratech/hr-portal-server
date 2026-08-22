import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@supabase/supabase-js';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { isSupabaseConfigured, type Env } from '../config/env';

declare module 'fastify' {
  interface FastifyInstance {
    supabase: SupabaseClient | null;
  }
}

export const supabasePlugin = fp(async (app: FastifyInstance, env: Env) => {
  const supabase = isSupabaseConfigured(env)
    ? createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      })
    : null;

  app.decorate('supabase', supabase);
});
