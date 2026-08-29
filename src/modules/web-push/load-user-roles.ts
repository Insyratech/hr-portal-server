import type { SupabaseClient } from '@supabase/supabase-js';

export async function loadUserRoles(supabase: SupabaseClient, userId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('employees')
    .select('employee_roles ( roles ( code ) )')
    .eq('user_id', userId)
    .maybeSingle();

  if (error || !data) {
    return ['EMPLOYEE'];
  }

  const roleRows = (data.employee_roles ?? []) as { roles?: { code?: string } | { code?: string }[] | null }[];
  const roles: string[] = [];
  for (const row of roleRows) {
    const role = row.roles;
    if (!role) continue;
    if (Array.isArray(role)) {
      for (const item of role) {
        if (item.code) roles.push(item.code);
      }
      continue;
    }
    if (role.code) roles.push(role.code);
  }

  return roles.length > 0 ? roles : ['EMPLOYEE'];
}
