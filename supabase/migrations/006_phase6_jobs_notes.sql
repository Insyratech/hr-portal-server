-- Phase 6: no schema changes required.
-- Notifications (Phase 1), leave_allocations unique (employee, leave_type, period) (Phase 2),
-- and attendance_records unique (employee, attendance_date) (Phase 3) already support
-- in-app notifications, idempotent annual allocation, and attendance finalization.
--
-- Wire Supabase Cron (or any scheduler) to HTTP endpoints with header:
--   x-cron-secret: <CRON_SECRET>
--
-- Suggested schedules (UTC):
--   00:05 daily  → POST /api/v1/jobs/attendance/finalize
--   09:00 daily  → POST /api/v1/jobs/reminders/daily
--   00:10 Jan 1  → POST /api/v1/jobs/leave/annual-allocation
--                  (also applies carry-forward / expiry; alias /api/v1/jobs/leave/carry-forward)

notify pgrst, 'reload schema';
