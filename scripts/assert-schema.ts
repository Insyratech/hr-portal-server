import type { SupabaseClient } from '@supabase/supabase-js';
import { migrationHelp, schemaMissingError } from '../src/modules/organization/schema-ready';

export async function assertEmployeesTable(supabase: SupabaseClient): Promise<void> {
  const { error } = await supabase.from('employees').select('id').limit(1);
  if (error && schemaMissingError(error.message)) {
    throw new Error(migrationHelp());
  }
  if (error) {
    throw error;
  }
}
