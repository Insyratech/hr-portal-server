type NotificationPathInput = {
  referenceType: string;
  referenceId: string | null;
  title: string;
  message: string;
  roles: string[];
};

function isGeneralManager(roles: string[]): boolean {
  return (roles.includes('GENERAL_MANAGER') || roles.includes('ADMIN')) && !roles.includes('SUPER_ADMIN');
}

function isHrManager(roles: string[]): boolean {
  return roles.includes('HR_MANAGER') && !roles.includes('SUPER_ADMIN');
}

function isCso(roles: string[]): boolean {
  return roles.includes('CSO') && !roles.includes('SUPER_ADMIN');
}

function isFinanceManager(roles: string[]): boolean {
  return roles.includes('FINANCE_MANAGER') && !roles.includes('SUPER_ADMIN');
}

function leaveApprovalPath(roles: string[], id: string): string {
  if (roles.includes('HR_MANAGER')) {
    return `/hr/leaves/${encodeURIComponent(id)}`;
  }
  if (isGeneralManager(roles)) {
    return '/gm/leave-status';
  }
  if (roles.includes('SUPER_ADMIN')) {
    return '/super-admin';
  }
  return `/leave?applicationId=${encodeURIComponent(id)}`;
}

function isLeadPriorityReview(title: string): boolean {
  return /submitted for approval|resubmitted for approval/i.test(title);
}

/** Maps notification metadata to an in-app route for push deep links. */
export function pathForNotificationPush(input: NotificationPathInput): string {
  const { referenceType, referenceId: id, title, message, roles } = input;
  const superAdmin = roles.includes('SUPER_ADMIN');
  const hrManager = isHrManager(roles);
  const gm = isGeneralManager(roles);
  const cso = isCso(roles);
  const finance = isFinanceManager(roles);

  if (referenceType === 'leave_application' && id) {
    const handoverRequest = /handover requested/i.test(title) || /asked you to take handover/i.test(message);
    if (handoverRequest) {
      return `/leave/handover/${encodeURIComponent(id)}`;
    }
    const leadRequest = /project lead approval/i.test(title) || /project-lead approval/i.test(message);
    if (leadRequest) {
      return `/leave/lead/${encodeURIComponent(id)}`;
    }
    return leaveApprovalPath(roles, id);
  }

  if (referenceType === 'holiday') {
    if (gm) return '/gm/holidays';
    if (hrManager) return '/hr/holidays';
    if (superAdmin) return '/super-admin/holidays';
    return '/leave/holidays';
  }

  if (referenceType === 'leave_allocation') {
    return '/leave';
  }

  if (referenceType === 'hr_policy') {
    return superAdmin ? '/super-admin/hr-policies' : '/policies';
  }

  if (referenceType === 'attendance_import' || referenceType === 'attendance_record') {
    if (gm) {
      if (id && /^\d{4}-\d{2}$/.test(id)) {
        return `/gm/attendance?period=${encodeURIComponent(id)}`;
      }
      return '/gm/attendance';
    }
    if (id && /^\d{4}-\d{2}$/.test(id)) {
      return `/attendance?period=${encodeURIComponent(id)}`;
    }
    return '/attendance';
  }

  if (referenceType === 'shift_assignment') {
    return '/attendance';
  }

  if (referenceType === 'employee') {
    return superAdmin ? '/super-admin/profile' : '/dashboard';
  }

  if (referenceType === 'salary_slip' && id) {
    return `/payslips/${encodeURIComponent(id)}`;
  }

  if (referenceType === 'payroll_run') {
    if (gm) return '/gm/payroll';
    if (finance) return '/finance';
    return '/payslips';
  }

  if (referenceType === 'work_permission') {
    if (hrManager) return '/hr/permissions';
    if (gm) return '/gm/permissions';
    return id ? `/permission?permissionId=${encodeURIComponent(id)}` : '/permission';
  }

  if (
    referenceType === 'daily_work_day' ||
    referenceType === 'weekly_plan' ||
    referenceType === 'weekly_priority' ||
    referenceType === 'weekly_work_update' ||
    referenceType === 'weekly_ppt_desk' ||
    referenceType === 'weekly_ppt_share' ||
    referenceType === 'work_retention'
  ) {
    if (superAdmin && referenceType === 'work_retention') return '/super-admin/settings';
    if (referenceType === 'weekly_ppt_share') {
      return id ? `/gm/weekly-updates?shareId=${encodeURIComponent(id)}` : '/gm/weekly-updates';
    }
    if (referenceType === 'weekly_ppt_desk') {
      return id && /^\d{4}-\d{2}-\d{2}$/.test(id)
        ? `/cso/work/weekly-updates?weekStart=${encodeURIComponent(id)}`
        : '/cso/work/weekly-updates';
    }
    if (referenceType === 'weekly_work_update') {
      return '/work/weekly-update';
    }
    if (referenceType === 'weekly_priority' || referenceType === 'weekly_plan') {
      if (isLeadPriorityReview(title) && id) {
        return `/work/priorities/review?employeeId=${encodeURIComponent(id)}`;
      }
      if (cso && isLeadPriorityReview(title)) {
        return id ? `/cso/work/priorities?employeeId=${encodeURIComponent(id)}` : '/cso/work/priorities';
      }
      return '/work/priorities';
    }
    return '/work';
  }

  if (referenceType === 'project' && id) {
    if (/you are the project lead/i.test(title)) {
      return `/work/projects/${encodeURIComponent(id)}`;
    }
    if (/status update/i.test(title)) {
      const qs = `updatesProjectId=${encodeURIComponent(id)}`;
      if (cso) return `/cso/work/projects?${qs}`;
      if (superAdmin) return `/super-admin/work/projects?${qs}`;
    }
  }

  if (referenceType === 'grievance' && id) {
    if (hrManager) return `/hr/grievances?id=${encodeURIComponent(id)}`;
    return '/grievance';
  }

  if (referenceType === 'directory_edit_request') {
    if (superAdmin) return '/super-admin/edit-requests';
    if (hrManager) return '/hr/employees';
  }

  if (superAdmin) return '/super-admin';
  if (hrManager) return '/hr';
  if (gm) return '/gm';
  if (cso) return '/cso/work';
  if (finance) return '/finance';
  return '/dashboard';
}
