import { createClient } from '@supabase/supabase-js';
import { loadEnv } from '../src/config/env';
import { migrationHelp, schemaMissingError } from '../src/modules/organization/schema-ready';
import { assertEmployeesTable } from './assert-schema';

const ROLE_IDS = {
  SUPER_ADMIN: '00000000-0000-4000-8000-000000000001',
  GENERAL_MANAGER: '00000000-0000-4000-8000-000000000002',
  EMPLOYEE: '00000000-0000-4000-8000-000000000003',
  HR_MANAGER: '00000000-0000-4000-8000-000000000004',
  CSO: '00000000-0000-4000-8000-000000000005',
  FINANCE_MANAGER: '00000000-0000-4000-8000-000000000006',
} as const;

type SeedSpec = {
  email: string;
  employeeCode: string;
  fullName: string;
  roleId: string;
  optional?: boolean;
};

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

function truthy(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
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

  const includeOptional = truthy(process.env.SEED_OPTIONAL_ROLES ?? 'true');

  const seeds: SeedSpec[] = [
    {
      email: process.env.SEED_SUPER_ADMIN_EMAIL ?? 'superadmin@example.com',
      employeeCode: 'SA-001',
      fullName: 'Super Admin',
      roleId: ROLE_IDS.SUPER_ADMIN,
    },
    {
      // Legacy SEED_ADMIN_EMAIL → General Manager (ex-ADMIN).
      email: process.env.SEED_GM_EMAIL ?? process.env.SEED_ADMIN_EMAIL ?? 'gm@example.com',
      employeeCode: 'GM-001',
      fullName: 'General Manager',
      roleId: ROLE_IDS.GENERAL_MANAGER,
    },
    {
      email: process.env.SEED_HR_EMAIL ?? 'hr@example.com',
      employeeCode: 'HR-001',
      fullName: 'HR Manager',
      roleId: ROLE_IDS.HR_MANAGER,
    },
    {
      email: process.env.SEED_EMPLOYEE_EMAIL ?? 'employee@example.com',
      employeeCode: 'EMP-001',
      fullName: 'Employee User',
      roleId: ROLE_IDS.EMPLOYEE,
    },
    {
      email: process.env.SEED_CSO_EMAIL ?? 'cso@example.com',
      employeeCode: 'CSO-001',
      fullName: 'CSO User',
      roleId: ROLE_IDS.CSO,
      optional: true,
    },
    {
      email: process.env.SEED_FINANCE_EMAIL ?? 'finance@example.com',
      employeeCode: 'FIN-001',
      fullName: 'Finance Manager',
      roleId: ROLE_IDS.FINANCE_MANAGER,
      optional: true,
    },
  ];

  const active = seeds.filter((seed) => !seed.optional || includeOptional);

  for (const seed of active) {
    const userId = await ensureAuthUser(supabase, seed.email, password);
    await upsertEmployee(supabase, { ...seed, userId });
    console.log(`Seeded ${seed.email} (${seed.fullName})`);
  }

  const flexibleShiftId = '00000000-0000-4000-8000-000000000401';
  const { data: employees } = await supabase
    .from('employees')
    .select('id')
    .in(
      'email',
      active.map((s) => s.email),
    );
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
