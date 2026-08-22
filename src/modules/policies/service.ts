import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { listActiveStaff, notifyStaff } from '../notifications/notify-staff';
import { assertPublishDoesNotRewrite, nextVersionLabel } from './versioning';

type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

type VersionRow = {
  id: string;
  policy_id: string;
  version_label: string;
  effective_date: string | null;
  content: string;
  status: 'draft' | 'published';
  acknowledgement_required: boolean;
  published_at: string | null;
  created_at: string;
};

function canManage(user: RequestUser): boolean {
  return user.permissions.includes(PERMISSIONS.POLICIES_MANAGE);
}

function canView(user: RequestUser): boolean {
  return (
    user.permissions.includes(PERMISSIONS.POLICIES_VIEW) ||
    canManage(user) ||
    user.permissions.includes(PERMISSIONS.REPORTS_VIEW)
  );
}

function mapVersion(row: VersionRow) {
  return {
    id: row.id,
    versionLabel: row.version_label,
    effectiveDate: row.effective_date,
    content: row.content,
    status: row.status,
    acknowledgementRequired: row.acknowledgement_required,
    publishedAt: row.published_at,
    createdAt: row.created_at,
  };
}

function pickCurrent(versions: VersionRow[]): VersionRow | null {
  const published = versions
    .filter((item) => item.status === 'published')
    .sort((a, b) => {
      const aDate = a.effective_date ?? a.published_at ?? a.created_at;
      const bDate = b.effective_date ?? b.published_at ?? b.created_at;
      return bDate.localeCompare(aDate);
    });
  return published[0] ?? null;
}

export function createPolicyService(supabase: SupabaseClient) {
  return {
    async list(actor: RequestUser) {
      if (!canView(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view HR policies.', 403);
      }

      const { data, error } = await supabase
        .from('hr_policies')
        .select(
          'id, title, created_at, updated_at, hr_policy_versions (id, policy_id, version_label, effective_date, content, status, acknowledgement_required, published_at, created_at)',
        )
        .order('title');
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load policies.', 500);

      const manage = canManage(actor);
      const items = [];
      for (const row of data ?? []) {
        const versions = ((row.hr_policy_versions ?? []) as VersionRow[]).filter(
          (version) => manage || version.status === 'published',
        );
        const current = pickCurrent(versions);
        let acknowledged = false;
        let acknowledgedAt: string | null = null;
        if (current) {
          const { data: ack } = await supabase
            .from('policy_acknowledgements')
            .select('accepted_at')
            .eq('employee_id', actor.employeeId)
            .eq('version_id', current.id)
            .maybeSingle();
          acknowledged = Boolean(ack);
          acknowledgedAt = (ack?.accepted_at as string | undefined) ?? null;
        }

        const drafts = versions
          .filter((item) => item.status === 'draft')
          .sort((a, b) => b.created_at.localeCompare(a.created_at));

        items.push({
          id: row.id as string,
          title: row.title as string,
          createdAt: row.created_at as string,
          updatedAt: row.updated_at as string,
          currentVersion: current
            ? {
                id: current.id,
                versionLabel: current.version_label,
                effectiveDate: current.effective_date,
                acknowledgementRequired: current.acknowledgement_required,
                status: current.status,
                publishedAt: current.published_at,
              }
            : null,
          draftVersion: manage && drafts[0] ? mapVersion(drafts[0]) : null,
          acknowledged,
          acknowledgedAt,
          versions: manage
            ? versions.map(mapVersion)
            : versions.filter((item) => item.status === 'published').map(mapVersion),
        });
      }
      return items;
    },

    async get(actor: RequestUser, id: string) {
      const list = await this.list(actor);
      const item = list.find((policy) => policy.id === id);
      if (!item) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Policy not found.', 404);

      const { data: versions, error } = await supabase
        .from('hr_policy_versions')
        .select('*')
        .eq('policy_id', id)
        .order('created_at', { ascending: false });
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load policy versions.', 500);

      const manage = canManage(actor);
      const visible = ((versions ?? []) as VersionRow[]).filter(
        (version) => manage || version.status === 'published',
      );
      const current = pickCurrent(visible);

      return {
        ...item,
        content: current?.content ?? item.draftVersion?.content ?? '',
        versions: visible.map(mapVersion),
      };
    },

    async create(
      actor: RequestUser,
      input: {
        title: string;
        content: string;
        versionLabel?: string;
        effectiveDate?: string;
        acknowledgementRequired?: boolean;
      },
      meta: RequestMeta,
    ) {
      if (!canManage(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage HR policies.', 403);
      }

      const { data: policy, error } = await supabase
        .from('hr_policies')
        .insert({ title: input.title.trim() })
        .select('id, title')
        .single();
      if (error || !policy) {
        if (error?.code === '23505') throw new AppError(API_ERROR_CODES.CONFLICT, 'A policy with this title already exists.', 409);
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to create policy.', 500);
      }

      const versionLabel = input.versionLabel?.trim() || '1.0';
      const { data: version, error: versionError } = await supabase
        .from('hr_policy_versions')
        .insert({
          policy_id: policy.id,
          version_label: versionLabel,
          effective_date: input.effectiveDate ?? null,
          content: input.content,
          status: 'draft',
          acknowledgement_required: input.acknowledgementRequired ?? true,
        })
        .select('*')
        .single();
      if (versionError || !version) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to create policy draft.', 500);
      }

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'hr_policy.create',
        entityType: 'hr_policy',
        entityId: policy.id as string,
        newValues: { title: policy.title, versionId: version.id },
        ...meta,
      });

      return this.get(actor, policy.id as string);
    },

    async publish(
      actor: RequestUser,
      id: string,
      input: {
        content?: string;
        versionLabel?: string;
        effectiveDate?: string;
        acknowledgementRequired?: boolean;
      },
      meta: RequestMeta,
    ) {
      if (!canManage(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot publish HR policies.', 403);
      }

      const { data: existingPublished } = await supabase
        .from('hr_policy_versions')
        .select('*')
        .eq('policy_id', id)
        .eq('status', 'published')
        .order('published_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      let versionId: string;

      if (input.content !== undefined) {
        const { data: labels } = await supabase
          .from('hr_policy_versions')
          .select('version_label')
          .eq('policy_id', id);
        const versionLabel =
          input.versionLabel?.trim() ||
          nextVersionLabel(((labels ?? []) as { version_label: string }[]).map((row) => row.version_label));

        const { data: created, error } = await supabase
          .from('hr_policy_versions')
          .insert({
            policy_id: id,
            version_label: versionLabel,
            effective_date: input.effectiveDate ?? new Date().toISOString().slice(0, 10),
            content: input.content,
            status: 'draft',
            acknowledgement_required: input.acknowledgementRequired ?? true,
          })
          .select('*')
          .single();
        if (error || !created) {
          if (error?.code === '23505') {
            throw new AppError(API_ERROR_CODES.CONFLICT, 'That version label already exists.', 409);
          }
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to create policy version.', 500);
        }
        versionId = created.id as string;
      } else {
        const { data: draft } = await supabase
          .from('hr_policy_versions')
          .select('*')
          .eq('policy_id', id)
          .eq('status', 'draft')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!draft) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'No draft version to publish.', 400);
        }
        versionId = draft.id as string;
        if (input.effectiveDate || input.acknowledgementRequired !== undefined) {
          await supabase
            .from('hr_policy_versions')
            .update({
              effective_date: input.effectiveDate ?? draft.effective_date,
              acknowledgement_required: input.acknowledgementRequired ?? draft.acknowledgement_required,
            })
            .eq('id', versionId)
            .eq('status', 'draft');
        }
      }

      const { data: toPublish, error: loadError } = await supabase
        .from('hr_policy_versions')
        .select('*')
        .eq('id', versionId)
        .maybeSingle();
      if (loadError || !toPublish) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Policy version not found.', 404);
      }

      if (existingPublished) {
        try {
          assertPublishDoesNotRewrite(
            {
              id: existingPublished.id as string,
              versionLabel: existingPublished.version_label as string,
              content: existingPublished.content as string,
              status: 'published',
              acknowledgementRequired: Boolean(existingPublished.acknowledgement_required),
              effectiveDate: (existingPublished.effective_date as string | null) ?? null,
            },
            {
              id: toPublish.id as string,
              versionLabel: toPublish.version_label as string,
              content: toPublish.content as string,
              status: 'draft',
              acknowledgementRequired: Boolean(toPublish.acknowledgement_required),
              effectiveDate: (toPublish.effective_date as string | null) ?? null,
            },
          );
        } catch {
          throw new AppError(
            API_ERROR_CODES.CONFLICT,
            'Publishing cannot rewrite a previously published version.',
            409,
          );
        }
      }

      const { data: published, error: publishError } = await supabase
        .from('hr_policy_versions')
        .update({
          status: 'published',
          published_at: new Date().toISOString(),
          effective_date:
            (toPublish.effective_date as string | null) ?? new Date().toISOString().slice(0, 10),
        })
        .eq('id', versionId)
        .eq('status', 'draft')
        .select('*')
        .single();
      if (publishError || !published) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to publish policy version.', 500);
      }

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'hr_policy.publish',
        entityType: 'hr_policy',
        entityId: id,
        newValues: {
          versionId: published.id,
          versionLabel: published.version_label,
          previousVersionId: existingPublished?.id ?? null,
        },
        ...meta,
      });

      if (published.acknowledgement_required) {
        const { data: policy } = await supabase.from('hr_policies').select('title').eq('id', id).maybeSingle();
        const title = policy?.title ?? 'A policy';
        await notifyStaff(supabase, await listActiveStaff(supabase), {
          type: 'policy',
          title: 'Policy acknowledgement required',
          message: `${title} v${published.version_label} requires your acknowledgement.`,
          referenceType: 'hr_policy',
          referenceId: id,
          eyebrow: 'Policy',
          paragraphs: [
            `${title} (version ${published.version_label}) requires your acknowledgement.`,
            'Sign in to read and acknowledge the policy.',
          ],
          ctaLabel: 'Review policy',
        });
      }

      return this.get(actor, id);
    },

    async acknowledge(actor: RequestUser, id: string, meta: RequestMeta) {
      if (!actor.permissions.includes(PERMISSIONS.POLICIES_VIEW) && !canManage(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot acknowledge policies.', 403);
      }

      const { data: versions, error } = await supabase
        .from('hr_policy_versions')
        .select('*')
        .eq('policy_id', id)
        .eq('status', 'published');
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load policy.', 500);
      const current = pickCurrent((versions ?? []) as VersionRow[]);
      if (!current) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'No published version to acknowledge.', 400);
      }
      if (!current.acknowledgement_required) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'This policy does not require acknowledgement.', 400);
      }

      const { data, error: ackError } = await supabase
        .from('policy_acknowledgements')
        .insert({
          employee_id: actor.employeeId,
          version_id: current.id,
        })
        .select('id, accepted_at')
        .single();
      if (ackError || !data) {
        if (ackError?.code === '23505') {
          throw new AppError(API_ERROR_CODES.CONFLICT, 'You already acknowledged this version.', 409);
        }
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to acknowledge policy.', 500);
      }

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'hr_policy.acknowledge',
        entityType: 'hr_policy_version',
        entityId: current.id,
        newValues: { policyId: id, acceptedAt: data.accepted_at },
        ...meta,
      });

      return this.get(actor, id);
    },

    async acknowledgementReport(actor: RequestUser, id: string, versionLabel?: string) {
      if (!canManage(actor) && !actor.permissions.includes(PERMISSIONS.REPORTS_VIEW)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view acknowledgement reports.', 403);
      }

      let versionQuery = supabase
        .from('hr_policy_versions')
        .select('*')
        .eq('policy_id', id)
        .eq('status', 'published');
      if (versionLabel) {
        versionQuery = versionQuery.eq('version_label', versionLabel);
      }

      const { data: versions, error } = await versionQuery.order('published_at', { ascending: false });
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load versions.', 500);

      const version = versionLabel
        ? ((versions ?? []) as VersionRow[])[0]
        : pickCurrent((versions ?? []) as VersionRow[]);
      if (!version) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Published policy version not found.', 404);
      }

      const [{ data: employees }, { data: acks }] = await Promise.all([
        supabase.from('employees').select('id, full_name, email, status').eq('status', 'active').order('full_name'),
        supabase.from('policy_acknowledgements').select('employee_id, accepted_at').eq('version_id', version.id),
      ]);

      const ackMap = new Map(
        ((acks ?? []) as { employee_id: string; accepted_at: string }[]).map((row) => [
          row.employee_id,
          row.accepted_at,
        ]),
      );

      const rows = ((employees ?? []) as { id: string; full_name: string; email: string }[]).map((employee) => ({
        employeeId: employee.id,
        fullName: employee.full_name,
        email: employee.email,
        acknowledged: ackMap.has(employee.id),
        acceptedAt: ackMap.get(employee.id) ?? null,
      }));

      return {
        policyId: id,
        version: mapVersion(version),
        acknowledgedCount: rows.filter((row) => row.acknowledged).length,
        pendingCount: rows.filter((row) => !row.acknowledged).length,
        employees: rows,
      };
    },
  };
}
