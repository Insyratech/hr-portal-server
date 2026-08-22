import type { SupabaseClient } from '@supabase/supabase-js';

export async function notifyUser(
  supabase: SupabaseClient,
  input: {
    userId: string | null | undefined;
    type: string;
    title: string;
    message: string;
    referenceType: string;
    referenceId: string;
  },
): Promise<void> {
  if (!input.userId) return;
  await supabase.from('notifications').insert({
    user_id: input.userId,
    type: input.type,
    title: input.title,
    message: input.message,
    reference_type: input.referenceType,
    reference_id: input.referenceId,
  });
}
