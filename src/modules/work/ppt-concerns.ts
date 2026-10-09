import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS, ROLE_CODES } from '../../shared/constants/permissions';
import { assertCsoDomainOwner, isCsoDomainOwner, isGmDomainOwner } from '../../shared/domain-owners';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { portalUrl } from '../notifications/mail';
import { listStaffByRole, loadStaffById, notifyStaff } from '../notifications/notify-staff';
import { formatIsoDateInZone } from './ist-clock';
import { skipsWorkApprovalLoop } from './approval';
import { pptWeekBounds, weeklyPptUploadWindowState } from './ppt-week';

type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

export type PptConcernKind = 'weekly' | 'jc';
export type PptConcernStatus = 'pending' | 'approved' | 'rejected';

const SCREENSHOT_BUCKET = 'ppt-concern-screenshots';
const SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;
const SCREENSHOT_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

type ConcernRow = {
  id: string;
  kind: PptConcernKind;
  employee_id: string;
  week_start: string;
  week_end: string;
  reason: string;
  screenshot_path: string | null;
  screenshot_file_name: string | null;
  screenshot_content_type: string | null;
  status: PptConcernStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string;
  late_upload_used: boolean;
  created_at: string;
  updated_at: string;
};

function mapConcern(
  row: ConcernRow,
  extras?: { employeeName?: string; screenshotUrl?: string | null; reviewerName?: string | null },
) {
  return {
    id: row.id,
    kind: row.kind,
    employeeId: row.employee_id,
    employeeName: extras?.employeeName ?? null,
    weekStart: String(row.week_start).slice(0, 10),
    weekEnd: String(row.week_end).slice(0, 10),
    reason: row.reason,
    hasScreenshot: Boolean(row.screenshot_path),
    screenshotFileName: row.screenshot_file_name,
    screenshotUrl: extras?.screenshotUrl ?? null,
    status: row.status,
    reviewedBy: row.reviewed_by,
    reviewerName: extras?.reviewerName ?? null,
    reviewedAt: row.reviewed_at,
    reviewNote: row.review_note ?? '',
    lateUploadUsed: row.late_upload_used,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertWorkLoopEmployee(actor: RequestUser): void {
  if (!actor.permissions.includes(PERMISSIONS.WORK_OWN)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot raise a PPT upload concern.', 403);
  }
  if (skipsWorkApprovalLoop(actor.roles)) {
    throw new AppError(
      API_ERROR_CODES.FORBIDDEN,
      'PPT upload concerns are for employees on the work loop.',
      403,
    );
  }
}

function canReviewConcerns(actor: RequestUser): boolean {
  return (
    (isCsoDomainOwner(actor) || isGmDomainOwner(actor)) &&
    (actor.permissions.includes(PERMISSIONS.WORK_VIEW) ||
      actor.permissions.includes(PERMISSIONS.WORK_ASSIGN))
  );
}

export function createPptConcernsService(supabase: SupabaseClient) {
  async function loadName(employeeId: string): Promise<string> {
    const { data } = await supabase.from('employees').select('full_name').eq('id', employeeId).maybeSingle();
    return (data?.full_name as string) || 'Employee';
  }

  async function signedScreenshot(path: string | null): Promise<string | null> {
    if (!path) return null;
    const { data, error } = await supabase.storage.from(SCREENSHOT_BUCKET).createSignedUrl(path, 60 * 30);
    if (error || !data) return null;
    return data.signedUrl;
  }

  /** Approved, unused reopen for late upload outside the Sat–Sun window. */
  async function findApprovedReopen(
    employeeId: string,
    weekStart: string,
    kind: PptConcernKind,
  ): Promise<ConcernRow | null> {
    const { data, error } = await supabase
      .from('ppt_upload_concerns')
      .select('*')
      .eq('employee_id', employeeId)
      .eq('week_start', weekStart)
      .eq('kind', kind)
      .eq('status', 'approved')
      .eq('late_upload_used', false)
      .maybeSingle();
    if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to check late-upload approval.', 500);
    return (data as ConcernRow | null) ?? null;
  }

  return {
    findApprovedReopen,

    async consumeApprovedReopen(concernId: string): Promise<void> {
      const { error } = await supabase
        .from('ppt_upload_concerns')
        .update({ late_upload_used: true })
        .eq('id', concernId)
        .eq('status', 'approved')
        .eq('late_upload_used', false);
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to record late-upload use.', 500);
      }
    },

    /**
     * Gate for uploads outside Sat 14:00–Sun 23:59 IST.
     * Before the window opens → hard block.
     * After the window → require CSO-approved unused concern.
     */
    async assertUploadAllowed(input: {
      now: Date;
      weekStart: string;
      employeeId: string;
      kind: PptConcernKind;
    }): Promise<{ timingIsLate: boolean; reopenConcernId: string | null }> {
      const state = weeklyPptUploadWindowState(input.now, input.weekStart);
      if (state === 'open') {
        return { timingIsLate: false, reopenConcernId: null };
      }
      if (state === 'before') {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Upload opens Saturday 2:00 pm IST. Raise a concern only if you miss the Sunday 11:59 pm deadline.',
          400,
        );
      }
      const reopen = await findApprovedReopen(input.employeeId, input.weekStart, input.kind);
      if (!reopen) {
        throw new AppError(
          API_ERROR_CODES.FORBIDDEN,
          'Upload window closed (Sunday 11:59 pm IST). Raise a concern for CSO approval to reopen one late upload for this week.',
          403,
        );
      }
      return { timingIsLate: true, reopenConcernId: reopen.id };
    },

    async listMine(actor: RequestUser) {
      assertWorkLoopEmployee(actor);
      const { data, error } = await supabase
        .from('ppt_upload_concerns')
        .select('*')
        .eq('employee_id', actor.employeeId)
        .order('created_at', { ascending: false })
        .limit(40);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load concerns.', 500);
      return Promise.all(
        ((data ?? []) as ConcernRow[]).map(async (row) =>
          mapConcern(row, { screenshotUrl: await signedScreenshot(row.screenshot_path) }),
        ),
      );
    },

    async listDesk(actor: RequestUser, status?: PptConcernStatus) {
      if (!canReviewConcerns(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot review PPT upload concerns.', 403);
      }
      let query = supabase
        .from('ppt_upload_concerns')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);
      if (status) query = query.eq('status', status);
      const { data, error } = await query;
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load concerns.', 500);
      const rows = (data ?? []) as ConcernRow[];
      const empIds = [...new Set(rows.map((r) => r.employee_id))];
      const reviewerIds = [...new Set(rows.map((r) => r.reviewed_by).filter(Boolean))] as string[];
      const [{ data: emps }, { data: reviewers }] = await Promise.all([
        empIds.length
          ? supabase.from('employees').select('id, full_name').in('id', empIds)
          : Promise.resolve({ data: [] as { id: string; full_name: string }[] }),
        reviewerIds.length
          ? supabase.from('employees').select('id, full_name').in('id', reviewerIds)
          : Promise.resolve({ data: [] as { id: string; full_name: string }[] }),
      ]);
      const empName = new Map((emps ?? []).map((e) => [e.id as string, e.full_name as string]));
      const revName = new Map((reviewers ?? []).map((e) => [e.id as string, e.full_name as string]));
      return Promise.all(
        rows.map(async (row) =>
          mapConcern(row, {
            employeeName: empName.get(row.employee_id),
            reviewerName: row.reviewed_by ? revName.get(row.reviewed_by) ?? null : null,
            screenshotUrl: await signedScreenshot(row.screenshot_path),
          }),
        ),
      );
    },

    /** Red-flag rows for GM monthly report: pending or rejected concerns in the month. */
    async listRedFlagsForMonth(employeeId: string, monthStart: string, monthEnd: string) {
      const { data, error } = await supabase
        .from('ppt_upload_concerns')
        .select('*')
        .eq('employee_id', employeeId)
        .in('status', ['pending', 'rejected'])
        .gte('week_start', monthStart)
        .lte('week_start', monthEnd)
        .order('week_start', { ascending: true });
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load PPT red flags.', 500);
      return ((data ?? []) as ConcernRow[]).map((row) => mapConcern(row));
    },

    async create(
      actor: RequestUser,
      input: {
        kind: PptConcernKind;
        weekStart?: string;
        reason: string;
        screenshotFileName?: string;
        screenshotContentType?: string;
        screenshotSizeBytes?: number;
      },
      meta: RequestMeta,
    ) {
      assertWorkLoopEmployee(actor);
      const reason = input.reason.trim();
      if (reason.length < 10) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Describe the issue in at least 10 characters.',
          400,
        );
      }
      const today = formatIsoDateInZone(new Date());
      const week =
        input.weekStart && /^\d{4}-\d{2}-\d{2}$/.test(input.weekStart)
          ? pptWeekBounds(input.weekStart)
          : pptWeekBounds(today);

      const window = weeklyPptUploadWindowState(new Date(), week.start);
      if (window === 'open') {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Upload window is still open (Saturday 2:00 pm – Sunday 11:59 pm IST). Upload your PPT instead of raising a concern.',
          400,
        );
      }
      if (window === 'before') {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Upload has not opened yet (Saturday 2:00 pm IST). Raise a concern only after you miss Sunday 11:59 pm.',
          400,
        );
      }

      let screenshotPath: string | null = null;
      let screenshotFileName: string | null = null;
      let screenshotContentType: string | null = null;
      let uploadUrl: string | null = null;
      let token: string | null = null;

      if (input.screenshotFileName) {
        const size = input.screenshotSizeBytes ?? 0;
        const contentType = (input.screenshotContentType || '').trim() || 'image/png';
        if (size <= 0 || size > SCREENSHOT_MAX_BYTES) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Screenshot must be 5 MB or smaller.', 400);
        }
        if (!SCREENSHOT_MIME.has(contentType)) {
          throw new AppError(
            API_ERROR_CODES.VALIDATION_ERROR,
            'Screenshot must be JPEG, PNG, WebP, or GIF.',
            400,
          );
        }
        const safeName = input.screenshotFileName.replace(/[^\w.\-]+/g, '_').slice(0, 80);
        screenshotPath = `${actor.employeeId}/${week.start}/${crypto.randomUUID()}-${safeName}`;
        screenshotFileName = input.screenshotFileName;
        screenshotContentType = contentType;
        const { data: signed, error: signError } = await supabase.storage
          .from(SCREENSHOT_BUCKET)
          .createSignedUploadUrl(screenshotPath);
        if (signError || !signed) {
          throw new AppError(
            API_ERROR_CODES.INTERNAL_ERROR,
            'Failed to create screenshot upload URL.',
            500,
          );
        }
        uploadUrl = signed.signedUrl;
        token = signed.token;
      }

      const { data, error } = await supabase
        .from('ppt_upload_concerns')
        .insert({
          kind: input.kind,
          employee_id: actor.employeeId,
          week_start: week.start,
          week_end: week.end,
          reason,
          screenshot_path: screenshotPath,
          screenshot_file_name: screenshotFileName,
          screenshot_content_type: screenshotContentType,
          status: 'pending',
        })
        .select('*')
        .single();
      if (error || !data) {
        if (error?.code === '23505') {
          throw new AppError(
            API_ERROR_CODES.CONFLICT,
            'You already have an open concern for this week. Wait for CSO review.',
            409,
          );
        }
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create concern.', 500);
      }

      const mapped = mapConcern(data as ConcernRow, {
        employeeName: await loadName(actor.employeeId),
      });
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'ppt_upload_concern.create',
        entityType: 'ppt_upload_concern',
        entityId: mapped.id,
        newValues: mapped,
        ...meta,
      });

      const kindLabel = input.kind === 'jc' ? 'JC PPT' : 'weekly PPT';
      const csoStaff = await listStaffByRole(supabase, ROLE_CODES.CSO);
      if (csoStaff.length > 0) {
        await notifyStaff(supabase, csoStaff, {
          type: 'work',
          title: `Late ${kindLabel} concern`,
          message: `${mapped.employeeName ?? 'An employee'} raised a late-upload concern for ${kindLabel}.`,
          referenceType: 'ppt_upload_concern',
          referenceId: mapped.id,
          eyebrow: 'PPT concern',
          paragraphs: [
            `${mapped.employeeName ?? 'An employee'} missed the Sunday 11:59 pm IST window for ${kindLabel}.`,
            'Approve to reopen one late upload for that week, or reject — unapproved concerns appear as RED FLAG on the GM monthly report.',
            reason.length > 280 ? `${reason.slice(0, 277)}…` : reason,
          ],
          details: [
            { label: 'Employee', value: mapped.employeeName ?? 'Employee' },
            { label: 'Type', value: kindLabel },
            { label: 'Week', value: `${week.start} → ${week.end}` },
          ],
          ctaLabel: 'Review concerns',
          ctaHref: portalUrl(input.kind === 'jc' ? '/cso/work/jc' : '/cso/work/weekly-updates'),
        });
      }

      return {
        concern: mapped,
        screenshotUpload: uploadUrl
          ? { uploadUrl, token, path: screenshotPath, bucket: SCREENSHOT_BUCKET }
          : null,
      };
    },

    async review(
      actor: RequestUser,
      concernId: string,
      input: { status: 'approved' | 'rejected'; reviewNote?: string },
      meta: RequestMeta,
    ) {
      assertCsoDomainOwner(actor, 'review PPT upload concerns');
      if (!actor.permissions.includes(PERMISSIONS.WORK_VIEW) && !actor.permissions.includes(PERMISSIONS.WORK_ASSIGN)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot review PPT upload concerns.', 403);
      }
      const { data: existing, error: loadError } = await supabase
        .from('ppt_upload_concerns')
        .select('*')
        .eq('id', concernId)
        .maybeSingle();
      if (loadError || !existing) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Concern not found.', 404);
      }
      const row = existing as ConcernRow;
      if (row.status !== 'pending') {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'This concern was already reviewed.', 409);
      }

      const { data, error } = await supabase
        .from('ppt_upload_concerns')
        .update({
          status: input.status,
          reviewed_by: actor.employeeId,
          reviewed_at: new Date().toISOString(),
          review_note: (input.reviewNote ?? '').trim(),
        })
        .eq('id', concernId)
        .select('*')
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to review concern.', 500);
      }

      const mapped = mapConcern(data as ConcernRow, {
        employeeName: await loadName(row.employee_id),
        reviewerName: await loadName(actor.employeeId),
        screenshotUrl: await signedScreenshot((data as ConcernRow).screenshot_path),
      });
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: `ppt_upload_concern.${input.status}`,
        entityType: 'ppt_upload_concern',
        entityId: mapped.id,
        newValues: mapped,
        ...meta,
      });

      const employee = await loadStaffById(supabase, row.employee_id);
      if (employee) {
        const kindLabel = row.kind === 'jc' ? 'JC PPT' : 'weekly PPT';
        const approved = input.status === 'approved';
        await notifyStaff(supabase, [employee], {
          type: 'work',
          title: approved ? `Late ${kindLabel} upload reopened` : `Late ${kindLabel} concern rejected`,
          message: approved
            ? `CSO approved one late ${kindLabel} upload for week ${row.week_start}.`
            : `CSO rejected your late ${kindLabel} concern for week ${row.week_start}.`,
          referenceType: 'ppt_upload_concern',
          referenceId: mapped.id,
          eyebrow: 'PPT concern',
          paragraphs: approved
            ? [
                `Your late-upload concern for ${kindLabel} (${row.week_start} → ${row.week_end}) was approved.`,
                'You may upload once for that week now. The upload will be marked late.',
              ]
            : [
                `Your late-upload concern for ${kindLabel} (${row.week_start} → ${row.week_end}) was rejected.`,
                'This remains a RED FLAG on the General Manager monthly report.',
                mapped.reviewNote ? `Note: ${mapped.reviewNote}` : '',
              ].filter(Boolean),
          details: [
            { label: 'Type', value: kindLabel },
            { label: 'Week', value: `${row.week_start} → ${row.week_end}` },
            { label: 'Decision', value: approved ? 'Approved' : 'Rejected' },
          ],
          ctaLabel: row.kind === 'jc' ? 'Open JC' : 'Open weekly update',
          ctaHref: portalUrl(row.kind === 'jc' ? '/work/jc' : '/work/weekly-update'),
        });
      }

      return mapped;
    },
  };
}
