import { createClient } from '@supabase/supabase-js';
import { loadEnv } from '../src/config/env';
import { migrationHelp, schemaMissingError } from '../src/modules/organization/schema-ready';
import { assertEmployeesTable } from './assert-schema';

const ROLE_IDS = {
  SUPER_ADMIN: '00000000-0000-4000-8000-000000000001',
  ADMIN: '00000000-0000-4000-8000-000000000002',
  EMPLOYEE: '00000000-0000-4000-8000-000000000003',
} as const;

async function ensureAuthUser(
  supabase: ReturnType<typeof createClient>,
  email: string,
  password: string,
): Promise<string> {
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (data.user) {
    return data.user.id;
  }

  if (!error?.message.toLowerCase().includes('already')) {
    throw error ?? new Error(`Failed to create ${email}`);
  }

  const { data: list, error: listError } = await supabase.auth.admin.listUsers();
  if (listError) {
    throw listError;
  }

  const existing = list.users.find((user) => user.email === email);
  if (!existing) {
    throw new Error(`User ${email} already exists but could not be loaded.`);
  }

  return existing.id;
}

async function upsertEmployee(
  supabase: ReturnType<typeof createClient>,
  input: {
    userId: string;
    employeeCode: string;
    fullName: string;
    email: string;
    roleId: string;
  },
): Promise<void> {
  const { data: existing } = await supabase
    .from('employees')
    .select('id')
    .eq('email', input.email)
    .maybeSingle();

  let employeeId = existing?.id as string | undefined;

  if (!employeeId) {
    const { data, error } = await supabase
      .from('employees')
      .insert({
        user_id: input.userId,
        employee_code: input.employeeCode,
        full_name: input.fullName,
        email: input.email,
        joining_date: '2026-01-01',
        employment_type: 'full_time',
        status: 'active',
      })
      .select('id')
      .single();

    if (error || !data) {
      throw error ?? new Error(`Failed to insert ${input.email}`);
    }
    employeeId = data.id as string;
  }

  await supabase.from('employee_roles').delete().eq('employee_id', employeeId);
  const { error: roleError } = await supabase.from('employee_roles').insert({
    employee_id: employeeId,
    role_id: input.roleId,
  });
  if (roleError) {
    throw roleError;
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  const password = process.env.SEED_PASSWORD ?? '';

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !password) {
    throw new Error('Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SEED_PASSWORD before seeding.');
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  await assertEmployeesTable(supabase);

  const seeds = [
    {
      email: process.env.SEED_SUPER_ADMIN_EMAIL ?? 'superadmin@example.com',
      employeeCode: 'SA-001',
      fullName: 'Super Admin',
      roleId: ROLE_IDS.SUPER_ADMIN,
    },
    {
      email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com',
      employeeCode: 'AD-001',
      fullName: 'Admin User',
      roleId: ROLE_IDS.ADMIN,
    },
    {
      email: process.env.SEED_EMPLOYEE_EMAIL ?? 'employee@example.com',
      employeeCode: 'EMP-001',
      fullName: 'Employee User',
      roleId: ROLE_IDS.EMPLOYEE,
    },
  ];

  for (const seed of seeds) {
    const userId = await ensureAuthUser(supabase, seed.email, password);
    await upsertEmployee(supabase, { ...seed, userId });
    console.log(`Seeded ${seed.email}`);
  }

  const flexibleShiftId = '00000000-0000-4000-8000-000000000401';
  const { data: employees } = await supabase.from('employees').select('id').in('email', seeds.map((s) => s.email));
  for (const employee of employees ?? []) {
    const { data: existing } = await supabase
      .from('shift_assignments')
      .select('id')
      .eq('employee_id', employee.id)
      .eq('effective_from', '2026-01-01')
      .maybeSingle();
    if (existing) continue;
    const { error } = await supabase.from('shift_assignments').insert({
      employee_id: employee.id,
      shift_id: flexibleShiftId,
      effective_from: '2026-01-01',
    });
    if (error && error.code !== 'PGRST205' && !error.message.includes('shift_assignments')) {
      console.warn(`Shift assignment skipped for ${employee.id}: ${error.message}`);
    } else if (!error) {
      console.log(`Assigned Flexible 9H to ${employee.id}`);
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (schemaMissingError(message)) {
    console.error(migrationHelp());
  } else {
    console.error(error);
  }
  process.exit(1);
});
