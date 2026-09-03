import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { parsePeriod } from '../attendance/import/period';
import { currentPeriod } from '../leave/balance';
import { summarizeConfirmedAttendance, type AttendanceReviewStatRow } from './attendance-summary';

function requireReports(actor: RequestUser): void {
  if (!actor.permissions.includes(PERMISSIONS.REPORTS_VIEW) && !actor.permissions.includes(PERMISSIONS.SYSTEM_MANAGE)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view reports.', 403);
  }
}

type NameRel = { name?: string; company_id?: string } | { name?: string; company_id?: string }[] | null;

function firstName(rel: NameRel): string | null {
  if (!rel) return null;
  if (Array.isArray(rel)) return rel[0]?.name ?? null;
  return rel.name ?? null;
}

function nestedCompanyId(rel: NameRel): string | null {
  if (!rel) return null;
  const one = Array.isArray(rel) ? rel[0] : rel;
  return one?.company_id ?? null;
}

function firstRel<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function startOfIsoWeek(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  const day = date.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + diff);
  return date.toISOString().slice(0, 10);
}

const OPEN_GRIEVANCE_STATUSES = ['OPEN', 'UNDER_REVIEW', 'INVESTIGATING'] as const;

export function createReportService(supabase: SupabaseClient) {
  return {
    async overview(actor: RequestUser, opts?: { from?: string; to?: string; period?: string; companyId?: string }) {
      requireReports(actor);
      const period = opts?.period && /^\d{4}-\d{2}$/.test(opts.period) ? opts.period : currentPeriod();
      const bounds = parsePeriod(period);
      const from = opts?.from && /^\d{4}-\d{2}-\d{2}$/.test(opts.from) ? opts.from : bounds.start;
      const to = opts?.to && /^\d{4}-\d{2}-\d{2}$/.test(opts.to) ? opts.to : bounds.end;
      const companyId =
        opts?.companyId && /^[0-9a-f-]{36}$/i.test(opts.companyId) ? opts.companyId : undefined;
      const today = new Date().toISOString().slice(0, 10);
      const weekStart = startOfIsoWeek(today);

      let empQuery = supabase
        .from('employees')
        .select(
          'id, status, department_id, designation_id, company_id, departments (name), designations (name), companies (id, name)',
        )
        .is('deleted_at', null);
      if (companyId) empQuery = empQuery.eq('company_id', companyId);

      const [
        { data: employees, error: empError },
        { data: companies, error: companiesError },
        { data: allocations, error: allocError },
        { data: pendingLeaveRows, count: pendingLeaveCount, error: pendingError },
        { data: imports, error: importError },
        { data: grievances, error: grievError },
        { data: permissionRows, error: permissionError },
        { data: pendingPermissionRows, count: pendingPermissionCount, error: pendingPermError },
        { data: projects, error: projectsError },
        milestonesRes,
        statusUpdatesRes,
        prioritiesRes,
        dailyUpdatesRes,
        editRequestsRes,
        shiftChangesRes,
        membersRes,
        pendingShiftRowsRes,
        pendingEditRowsRes,
      ] = await Promise.all([
        empQuery,
        supabase.from('companies').select('id, name, status').order('name'),
        supabase
          .from('leave_allocations')
          .select(
            'leave_type_id, used, allocated, available, employees (id, full_name, employee_code, department_id, company_id, departments (name)), leave_types (name, code)',
          )
          .eq('period', period),
        supabase
          .from('leave_applications')
          .select(
            'id, status, start_date, end_date, duration, quantity, reason, created_at, employees!leave_applications_employee_id_fkey (full_name, employee_code, company_id), leave_types (name, code)',
            { count: 'exact' },
          )
          .eq('status', 'PENDING')
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('attendance_imports')
          .select('id, confirmed_at')
          .eq('period', period)
          .eq('status', 'CONFIRMED')
          .order('confirmed_at', { ascending: false })
          .limit(1),
        supabase
          .from('grievances')
          .select(
            'id, category, subject, status, created_at, resolved_at, employees!employee_id (full_name, employee_code)',
          ),
        supabase
          .from('work_permissions')
          .select(
            'id, status, minutes, permission_date, slot, reason, employees!work_permissions_employee_id_fkey (full_name, employee_code, company_id)',
          )
          .gte('permission_date', from)
          .lte('permission_date', to),
        supabase
          .from('work_permissions')
          .select(
            'id, status, minutes, permission_date, slot, reason, created_at, employees!work_permissions_employee_id_fkey (full_name, employee_code, company_id)',
            { count: 'exact' },
          )
          .eq('status', 'PENDING')
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('projects')
          .select('id, status, name, code, lead_employee_id')
          .order('name'),
        supabase.from('project_milestones').select('id, project_id, name').eq('status', 'ACTIVE'),
        supabase
          .from('project_status_updates')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', `${from}T00:00:00.000Z`)
          .lte('created_at', `${to}T23:59:59.999Z`),
        supabase.from('weekly_priorities').select('id, approval_status'),
        supabase
          .from('daily_work_days')
          .select('id', { count: 'exact', head: true })
          .not('submitted_at', 'is', null)
          .gte('work_date', weekStart)
          .lte('work_date', today),
        supabase
          .from('directory_edit_requests')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'PENDING'),
        supabase
          .from('shift_change_requests')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'PENDING'),
        supabase.from('project_members').select('project_id, employee_id'),
        supabase
          .from('shift_change_requests')
          .select(
            'id, status, start_date, end_date, reason, created_at, project_lead_accepted, project_lead_required, employees!employee_id (full_name, employee_code), projects (name, code), requested_shift:shifts!requested_shift_id (name), current_shift:shifts!current_shift_id (name)',
          )
          .eq('status', 'PENDING')
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('directory_edit_requests')
          .select(
            'id, status, reason, field_hints, created_at, employees!directory_edit_requests_target_employee_id_fkey (full_name, employee_code), requester:employees!directory_edit_requests_requester_id_fkey (full_name)',
          )
          .eq('status', 'PENDING')
          .order('created_at', { ascending: false })
          .limit(100),
      ]);

      if (
        empError ||
        companiesError ||
        allocError ||
        pendingError ||
        importError ||
        grievError ||
        permissionError ||
        pendingPermError ||
        projectsError
      ) {
        const detail =
          empError?.message ||
          companiesError?.message ||
          allocError?.message ||
          pendingError?.message ||
          importError?.message ||
          grievError?.message ||
          permissionError?.message ||
          pendingPermError?.message ||
          projectsError?.message ||
          'unknown';
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, `Failed to load report aggregates: ${detail}`, 500);
      }

      const pendingLeaves = pendingLeaveCount ?? pendingLeaveRows?.length ?? 0;
      const pendingPermissions = pendingPermissionCount ?? pendingPermissionRows?.length ?? 0;
      const activeMilestones = milestonesRes.error ? [] : (milestonesRes.data ?? []);
      const statusUpdatesThisPeriod = statusUpdatesRes.error ? 0 : (statusUpdatesRes.count ?? 0);
      const priorityRows = prioritiesRes.error ? [] : (prioritiesRes.data ?? []);
      const dailyUpdatesThisWeek = dailyUpdatesRes.error ? 0 : (dailyUpdatesRes.count ?? 0);
      const pendingEditRequests = editRequestsRes.error ? 0 : (editRequestsRes.count ?? 0);
      const pendingShiftChanges = shiftChangesRes.error ? 0 : (shiftChangesRes.count ?? 0);
      const memberRows = membersRes.error ? [] : (membersRes.data ?? []);
      const pendingShiftDetailRows = pendingShiftRowsRes.error ? [] : (pendingShiftRowsRes.data ?? []);
      const pendingEditDetailRows = pendingEditRowsRes.error ? [] : (pendingEditRowsRes.data ?? []);

      const confirmedImport = (imports ?? [])[0] as { id: string } | undefined;
      let reviewRows: AttendanceReviewStatRow[] = [];
      if (confirmedImport) {
        const { data: reviews, error: reviewError } = await supabase
          .from('attendance_day_reviews')
          .select('status, final_lop, employees (company_id)')
          .eq('import_id', confirmedImport.id);
        if (reviewError) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load confirmed attendance.', 500);
        }
        reviewRows = (reviews ?? []).map((row) => ({
          status: row.status as string,
          finalLop: Number(row.final_lop ?? 0),
          companyId: nestedCompanyId(row.employees as NameRel),
        }));
      }

      const stats = summarizeConfirmedAttendance(reviewRows, companyId);
      const attendanceCounts: Record<string, number> = {
        PRESENT: 0,
        ABSENT: 0,
        LATE: 0,
        MISSING_PUNCH: 0,
        HALF_DAY: 0,
        LEAVE: 0,
        WEEK_OFF: 0,
        HOLIDAY: 0,
      };
      const scoped = companyId ? reviewRows.filter((row) => row.companyId === companyId) : reviewRows;
      for (const row of scoped) {
        attendanceCounts[row.status] = (attendanceCounts[row.status] ?? 0) + 1;
      }

      const employeeRows = employees ?? [];
      const byDepartment = new Map<string, number>();
      const byDesignation = new Map<string, number>();
      const byCompany = new Map<
        string,
        { id: string; name: string; active: number; inactive: number; total: number }
      >();

      for (const company of companies ?? []) {
        byCompany.set(company.id as string, {
          id: company.id as string,
          name: (company.name as string) || 'Unnamed',
          active: 0,
          inactive: 0,
          total: 0,
        });
      }
      byCompany.set('unassigned', {
        id: 'unassigned',
        name: 'Unassigned',
        active: 0,
        inactive: 0,
        total: 0,
      });

      let active = 0;
      let inactive = 0;
      for (const row of employeeRows) {
        if (row.status === 'active') active += 1;
        else inactive += 1;
        const dept = firstName(row.departments as NameRel) ?? 'Unassigned';
        const desig = firstName(row.designations as NameRel) ?? 'Unassigned';
        byDepartment.set(dept, (byDepartment.get(dept) ?? 0) + 1);
        byDesignation.set(desig, (byDesignation.get(desig) ?? 0) + 1);

        const companyRel = row.companies as { id?: string; name?: string } | { id?: string; name?: string }[] | null;
        const companyOne = Array.isArray(companyRel) ? companyRel[0] : companyRel;
        const key = (row.company_id as string | null) ?? companyOne?.id ?? 'unassigned';
        const bucket =
          byCompany.get(key) ??
          ({
            id: key,
            name: companyOne?.name ?? 'Unassigned',
            active: 0,
            inactive: 0,
            total: 0,
          } as const);
        const next = {
          id: bucket.id,
          name: bucket.name,
          active: bucket.active + (row.status === 'active' ? 1 : 0),
          inactive: bucket.inactive + (row.status === 'active' ? 0 : 1),
          total: bucket.total + 1,
        };
        byCompany.set(key, next);
      }

      const leaveByType = new Map<string, { used: number; allocated: number; available: number }>();
      const leaveByDepartment = new Map<string, number>();
      const leaveByEmployee = new Map<
        string,
        {
          id: string;
          employeeName: string;
          employeeCode: string;
          used: number;
          allocated: number;
          available: number;
        }
      >();
      let leaveUsed = 0;
      let leaveAllocated = 0;
      for (const row of allocations ?? []) {
        const emp = row.employees as
          | {
              id?: string;
              full_name?: string;
              employee_code?: string;
              department_id?: string;
              company_id?: string;
              departments?: NameRel;
            }
          | {
              id?: string;
              full_name?: string;
              employee_code?: string;
              department_id?: string;
              company_id?: string;
              departments?: NameRel;
            }[]
          | null;
        const empOne = Array.isArray(emp) ? emp[0] : emp;
        if (companyId && empOne?.company_id !== companyId) continue;

        const typeRel = row.leave_types as { name?: string; code?: string } | { name?: string; code?: string }[] | null;
        const typeName = (Array.isArray(typeRel) ? typeRel[0]?.name : typeRel?.name) ?? 'Unknown';
        const used = Number(row.used);
        const allocated = Number(row.allocated);
        const available = Number(row.available);
        leaveUsed += used;
        leaveAllocated += allocated;
        const typeBucket = leaveByType.get(typeName) ?? { used: 0, allocated: 0, available: 0 };
        typeBucket.used += used;
        typeBucket.allocated += allocated;
        typeBucket.available += available;
        leaveByType.set(typeName, typeBucket);

        const deptName = firstName(empOne?.departments ?? null) ?? 'Unassigned';
        leaveByDepartment.set(deptName, (leaveByDepartment.get(deptName) ?? 0) + used);

        const employeeKey = empOne?.id ?? `${empOne?.employee_code ?? 'unknown'}`;
        const employeeBucket = leaveByEmployee.get(employeeKey) ?? {
          id: employeeKey,
          employeeName: empOne?.full_name ?? 'Employee',
          employeeCode: empOne?.employee_code ?? '—',
          used: 0,
          allocated: 0,
          available: 0,
        };
        employeeBucket.used += used;
        employeeBucket.allocated += allocated;
        employeeBucket.available += available;
        leaveByEmployee.set(employeeKey, employeeBucket);
      }

      const grievanceRows = grievances ?? [];
      let open = 0;
      let resolved = 0;
      let resolutionMs = 0;
      let resolutionSamples = 0;
      const byCategory = new Map<string, number>();
      const openGrievanceItems: {
        id: string;
        subject: string;
        category: string;
        status: string;
        employeeName: string | null;
        employeeCode: string | null;
        createdAt: string;
      }[] = [];
      for (const row of grievanceRows) {
        const status = row.status as string;
        if ((OPEN_GRIEVANCE_STATUSES as readonly string[]).includes(status)) {
          open += 1;
          const emp = firstRel(
            row.employees as
              | { full_name?: string; employee_code?: string }
              | { full_name?: string; employee_code?: string }[]
              | null,
          );
          openGrievanceItems.push({
            id: row.id as string,
            subject: (row.subject as string) || 'Grievance',
            category: row.category as string,
            status,
            employeeName: emp?.full_name ?? null,
            employeeCode: emp?.employee_code ?? null,
            createdAt: row.created_at as string,
          });
        }
        if (status === 'RESOLVED' || status === 'CLOSED') {
          resolved += 1;
          if (row.resolved_at && row.created_at) {
            resolutionMs += new Date(row.resolved_at as string).getTime() - new Date(row.created_at as string).getTime();
            resolutionSamples += 1;
          }
        }
        const category = row.category as string;
        byCategory.set(category, (byCategory.get(category) ?? 0) + 1);
      }
      openGrievanceItems.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      let permPending = 0;
      let permApproved = 0;
      let permRejected = 0;
      let minutesApproved = 0;
      for (const row of permissionRows ?? []) {
        const emp = row.employees as { company_id?: string } | { company_id?: string }[] | null;
        const empOne = Array.isArray(emp) ? emp[0] : emp;
        if (companyId && empOne?.company_id !== companyId) continue;
        const status = row.status as string;
        if (status === 'PENDING') permPending += 1;
        if (status === 'APPROVED') {
          permApproved += 1;
          minutesApproved += Number(row.minutes ?? 0);
        }
        if (status === 'REJECTED') permRejected += 1;
      }

      const leaveQueueItems = (pendingLeaveRows ?? [])
        .map((row) => {
          const emp = firstRel(
            row.employees as
              | { full_name?: string; employee_code?: string; company_id?: string }
              | { full_name?: string; employee_code?: string; company_id?: string }[]
              | null,
          );
          if (companyId && emp?.company_id !== companyId) return null;
          const type = firstRel(
            row.leave_types as { name?: string; code?: string } | { name?: string; code?: string }[] | null,
          );
          return {
            id: row.id as string,
            employeeName: emp?.full_name ?? 'Employee',
            employeeCode: emp?.employee_code ?? '—',
            leaveTypeName: type?.name ?? 'Leave',
            leaveTypeCode: type?.code ?? null,
            startDate: row.start_date as string,
            endDate: row.end_date as string,
            duration: row.duration as string,
            quantity: Number(row.quantity ?? 0),
            reason: (row.reason as string | null) ?? null,
            status: row.status as string,
            createdAt: row.created_at as string,
          };
        })
        .filter((row): row is NonNullable<typeof row> => Boolean(row));

      const permissionQueueItems = (pendingPermissionRows ?? [])
        .map((row) => {
          const emp = firstRel(
            row.employees as
              | { full_name?: string; employee_code?: string; company_id?: string }
              | { full_name?: string; employee_code?: string; company_id?: string }[]
              | null,
          );
          if (companyId && emp?.company_id !== companyId) return null;
          return {
            id: row.id as string,
            employeeName: emp?.full_name ?? 'Employee',
            employeeCode: emp?.employee_code ?? '—',
            permissionDate: row.permission_date as string,
            minutes: Number(row.minutes ?? 0),
            slot: (row.slot as string) === 'END' ? 'END' : 'START',
            reason: (row.reason as string | null) ?? null,
            status: row.status as string,
            createdAt: row.created_at as string,
          };
        })
        .filter((row): row is NonNullable<typeof row> => Boolean(row));

      const shiftChangeItems = pendingShiftDetailRows.map((row) => {
        const emp = firstRel(
          row.employees as
            | { full_name?: string; employee_code?: string }
            | { full_name?: string; employee_code?: string }[]
            | null,
        );
        const project = firstRel(
          row.projects as { name?: string; code?: string } | { name?: string; code?: string }[] | null,
        );
        const requested = firstRel(
          row.requested_shift as { name?: string } | { name?: string }[] | null,
        );
        const current = firstRel(row.current_shift as { name?: string } | { name?: string }[] | null);
        return {
          id: row.id as string,
          employeeName: emp?.full_name ?? 'Employee',
          employeeCode: emp?.employee_code ?? '—',
          projectName: project?.name ?? null,
          projectCode: project?.code ?? null,
          startDate: row.start_date as string,
          endDate: row.end_date as string,
          currentShiftName: current?.name ?? null,
          requestedShiftName: requested?.name ?? null,
          reason: (row.reason as string) || '',
          projectLeadRequired: Boolean(row.project_lead_required),
          projectLeadAccepted: Boolean(row.project_lead_accepted),
          status: row.status as string,
          createdAt: row.created_at as string,
        };
      });

      const editRequestItems = pendingEditDetailRows.map((row) => {
        const target = firstRel(
          row.employees as
            | { full_name?: string; employee_code?: string }
            | { full_name?: string; employee_code?: string }[]
            | null,
        );
        const requester = firstRel(row.requester as { full_name?: string } | { full_name?: string }[] | null);
        return {
          id: row.id as string,
          targetName: target?.full_name ?? 'Employee',
          targetCode: target?.employee_code ?? '—',
          requesterName: requester?.full_name ?? 'Requester',
          reason: (row.reason as string) || '',
          fieldHints: (row.field_hints as string | null) ?? null,
          status: row.status as string,
          createdAt: row.created_at as string,
        };
      });

      const projectRows = projects ?? [];
      const activeProjects = projectRows.filter((row) => row.status === 'active').length;
      const inactiveProjects = projectRows.length - activeProjects;
      const milestoneByProject = new Map<string, string>();
      for (const row of activeMilestones) {
        const projectId = row.project_id as string;
        if (!milestoneByProject.has(projectId)) {
          milestoneByProject.set(projectId, (row.name as string) || 'Active milestone');
        }
      }
      const memberCountByProject = new Map<string, number>();
      for (const row of memberRows) {
        const projectId = row.project_id as string;
        memberCountByProject.set(projectId, (memberCountByProject.get(projectId) ?? 0) + 1);
      }
      const leadIds = [
        ...new Set(
          projectRows
            .map((row) => row.lead_employee_id as string | null)
            .filter((id): id is string => Boolean(id)),
        ),
      ];
      const leadNameById = new Map<string, string>();
      if (leadIds.length > 0) {
        const { data: leads } = await supabase
          .from('employees')
          .select('id, full_name')
          .in('id', leadIds);
        for (const lead of leads ?? []) {
          leadNameById.set(lead.id as string, lead.full_name as string);
        }
      }
      const projectItems = projectRows
        .map((row) => {
          const id = row.id as string;
          const leadEmployeeId = (row.lead_employee_id as string | null) ?? null;
          return {
            id,
            name: row.name as string,
            code: row.code as string,
            status: row.status as string,
            leadEmployeeId,
            leadName: leadEmployeeId ? (leadNameById.get(leadEmployeeId) ?? null) : null,
            memberCount: memberCountByProject.get(id) ?? 0,
            activeMilestoneName: milestoneByProject.get(id) ?? null,
          };
        })
        .sort((a, b) => {
          if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      const approvalCounts: Record<string, number> = {
        DRAFT: 0,
        SUBMITTED: 0,
        APPROVED: 0,
        RESUBMIT_REQUESTED: 0,
      };
      for (const row of priorityRows) {
        const status = row.approval_status as string;
        approvalCounts[status] = (approvalCounts[status] ?? 0) + 1;
      }
      const prioritiesPending = approvalCounts.SUBMITTED ?? 0;

      const companyList = [...byCompany.values()]
        .filter((row) => row.id !== 'unassigned' || row.total > 0)
        .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

      return {
        period,
        attendanceRange: { from, to },
        employees: {
          total: employeeRows.length,
          active,
          inactive,
          byDepartment: [...byDepartment.entries()]
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => b.count - a.count),
          byDesignation: [...byDesignation.entries()]
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => b.count - a.count),
          byCompany: companyList,
        },
        leave: {
          period,
          used: leaveUsed,
          allocated: leaveAllocated,
          utilizationRate: leaveAllocated > 0 ? Number((leaveUsed / leaveAllocated).toFixed(4)) : 0,
          pendingApprovals: companyId ? leaveQueueItems.length : pendingLeaves,
          byType: [...leaveByType.entries()].map(([name, leaveStats]) => ({ name, ...leaveStats })),
          byDepartment: [...leaveByDepartment.entries()].map(([name, used]) => ({ name, used })),
          employeeStatus: [...leaveByEmployee.values()]
            .map((row) => ({
              ...row,
              utilizationRate:
                row.allocated > 0 ? Number((row.used / row.allocated).toFixed(4)) : 0,
            }))
            .sort((a, b) => b.used - a.used || a.employeeName.localeCompare(b.employeeName)),
        },
        attendance: {
          from,
          to,
          published: Boolean(confirmedImport),
          companyId: companyId ?? null,
          present: stats.present,
          absent: stats.absent,
          late: stats.late,
          missingPunches: stats.missPunch,
          lop: stats.lop,
          halfDay: stats.halfDay,
          onLeave: stats.onLeave,
          overtimeMinutes: 0,
          byStatus: Object.entries(attendanceCounts)
            .map(([status, count]) => ({ status, count }))
            .filter((row) => row.count > 0),
        },
        grievances: {
          open,
          resolved,
          averageResolutionHours:
            resolutionSamples > 0 ? Number((resolutionMs / resolutionSamples / 3_600_000).toFixed(2)) : null,
          byCategory: [...byCategory.entries()].map(([category, count]) => ({ category, count })),
        },
        permissions: {
          pending: companyId ? permissionQueueItems.length : pendingPermissions,
          approvedThisPeriod: permApproved,
          rejectedThisPeriod: permRejected,
          minutesApprovedThisPeriod: minutesApproved,
          byStatus: [
            {
              status: 'PENDING',
              count: companyId ? permissionQueueItems.length : pendingPermissions,
            },
            { status: 'APPROVED', count: permApproved },
            { status: 'REJECTED', count: permRejected },
          ].filter((row) => row.count > 0),
        },
        projects: {
          active: activeProjects,
          inactive: inactiveProjects,
          withActiveMilestone: milestoneByProject.size,
          statusUpdatesThisPeriod,
          items: projectItems,
          byStatus: [
            { status: 'active', count: activeProjects },
            { status: 'inactive', count: inactiveProjects },
          ].filter((row) => row.count > 0),
        },
        work: {
          prioritiesPendingApproval: prioritiesPending,
          dailyUpdatesThisWeek,
          weekStart,
          prioritiesByApproval: Object.entries(approvalCounts)
            .map(([status, count]) => ({ status, count }))
            .filter((row) => row.count > 0),
        },
        queues: {
          pendingLeaves: companyId ? leaveQueueItems.length : pendingLeaves,
          pendingPermissions: companyId ? permissionQueueItems.length : pendingPermissions,
          pendingEditRequests,
          pendingShiftChanges,
          openGrievances: open,
          leaves: leaveQueueItems,
          permissions: permissionQueueItems,
          shiftChanges: shiftChangeItems,
          editRequests: editRequestItems,
          grievances: openGrievanceItems,
        },
      };
    },
  };
}
