import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import { maskAuditValues } from './mask-audit-values';

export type AuditInput = {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export async function writeAuditLog(supabase: SupabaseClient, input: AuditInput): Promise<void> {
  const { error } = await supabase.from('audit_logs').insert({
    actor_id: input.actorId,
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId,
    old_values: maskAuditValues(input.oldValues ?? null),
    new_values: maskAuditValues(input.newValues ?? null),
    ip_address: input.ipAddress ?? null,
    user_agent: input.userAgent ?? null,
  });

  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to write audit log.', 500);
  }
}

export type AuditLog = {
  id: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
};

type AuditRow = {
  id: string;
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
};

export async function listAuditLogs(
  supabase: SupabaseClient,
  filters: { entityId?: string; limit?: number },
): Promise<AuditLog[]> {
  let query = supabase
    .from('audit_logs')
    .select(
      'id, actor_id, action, entity_type, entity_id, old_values, new_values, ip_address, user_agent, created_at',
    )
    .order('created_at', { ascending: false })
    .limit(filters.limit ?? 50);

  if (filters.entityId) {
    query = query.eq('entity_id', filters.entityId);
  }

  const { data, error } = await query;
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load audit logs.', 500);
  }

  return ((data ?? []) as AuditRow[]).map((row) => ({
    id: row.id,
    actorId: row.actor_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    oldValues: row.old_values,
    newValues: row.new_values,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    createdAt: row.created_at,
  }));
}
