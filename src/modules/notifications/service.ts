import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';

export type NotificationRow = {
  id: string;
  user_id: string;
  type: string;
  title: string;
  message: string;
  reference_type: string | null;
  reference_id: string | null;
  read_at: string | null;
  created_at: string;
};

export function mapNotification(row: NotificationRow) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    message: row.message,
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    readAt: row.read_at,
    createdAt: row.created_at,
    unread: !row.read_at,
  };
}

export function createNotificationService(supabase: SupabaseClient) {
  return {
    async list(actor: RequestUser, unreadOnly = false) {
      let query = supabase
        .from('notifications')
        .select('*')
        .eq('user_id', actor.authUserId)
        .order('created_at', { ascending: false })
        .limit(50);
      if (unreadOnly) {
        query = query.is('read_at', null);
      }

      const { data, error } = await query;
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load notifications.', 500);
      return ((data ?? []) as NotificationRow[]).map(mapNotification);
    },

    async unreadCount(actor: RequestUser) {
      const { count, error } = await supabase
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', actor.authUserId)
        .is('read_at', null);
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to count notifications.', 500);
      return { count: count ?? 0 };
    },

    async markRead(actor: RequestUser, id: string) {
      const { data, error } = await supabase
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('id', id)
        .eq('user_id', actor.authUserId)
        .select('*')
        .maybeSingle();
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to mark notification read.', 500);
      if (!data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Notification not found.', 404);
      return mapNotification(data as NotificationRow);
    },

    async markAllRead(actor: RequestUser) {
      const { data, error } = await supabase
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('user_id', actor.authUserId)
        .is('read_at', null)
        .select('id');
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to mark notifications read.', 500);
      return { updated: (data ?? []).length };
    },
  };
}
