import type { SupabaseClient } from '@supabase/supabase-js';

/** Map employee id → role codes (multi-role supported). */
export async function loadEmployeeRoleMap(supabase: SupabaseClient): Promise<Map<string, string[]>> {
  const { data } = await supabase.from('employee_roles').select('employee_id, roles ( code )');
  const map = new Map<string, string[]>();
  for (const row of data ?? []) {
    const employeeId = row.employee_id as string;
    const roles = row.roles as { code?: string } | { code?: string }[] | null;
    const code = Array.isArray(roles) ? roles[0]?.code : roles?.code;
    if (!employeeId || !code) continue;
    const list = map.get(employeeId) ?? [];
    list.push(code);
    map.set(employeeId, list);
  }
  return map;
}
