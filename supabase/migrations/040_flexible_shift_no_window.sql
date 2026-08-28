-- Flexible shifts: no fixed start/end window — only required hours matter.

update public.shifts
set
  start_time = '00:00',
  end_time = '23:59',
  grace_period_minutes = 0,
  late_threshold_minutes = 0,
  early_exit_threshold_minutes = 0
where flexible = true;

notify pgrst, 'reload schema';
