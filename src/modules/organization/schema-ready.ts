import { loadEnv } from '../../config/env';

export function schemaMissingError(message: string): boolean {
  return message.includes('schema cache') || message.includes("Could not find the table 'public.employees'");
}

export function migrationHelp(): string {
  const env = loadEnv();
  let projectRef = 'YOUR_PROJECT';
  try {
    projectRef = new URL(env.SUPABASE_URL).hostname.split('.')[0] || projectRef;
  } catch {
    // keep fallback
  }

  return [
    'Phase 1 tables are missing. Seed cannot run until the migration is applied.',
    '',
    '1. Open the SQL editor:',
    `   https://supabase.com/dashboard/project/${projectRef}/sql/new`,
    '2. Paste supabase/migrations/001_phase1_foundation.sql',
    '3. Click Run',
    '4. Run npm run seed again',
  ].join('\n');
}
