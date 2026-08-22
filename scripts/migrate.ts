import { loadEnv } from '../src/config/env';
import { assertEmployeesTable } from './assert-schema';
import { migrationHelp } from '../src/modules/organization/schema-ready';
import { createClient } from '@supabase/supabase-js';

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Backend/.env');
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    await assertEmployeesTable(supabase);
    console.log('Phase 1 tables are present. You can run npm run seed.');
  } catch {
    console.error(migrationHelp());
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
