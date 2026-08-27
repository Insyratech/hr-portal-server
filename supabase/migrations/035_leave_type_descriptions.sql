-- Clearer employee-facing leave descriptions; ML notice 1 hour (calendar start of leave day).

update public.leave_types set description = 'Short planned absence. Apply with the required notice. Handover and HR approval are required.'
where code = 'CL';

update public.leave_types set description = 'Unplanned illness. Short notice is allowed. HR approval is required.'
where code = 'SL';

update public.leave_types set description = 'Privilege leave. Usually available after about one year of service. Handover and HR approval are required.'
where code = 'EL';

update public.leave_types set description = 'For employees who need menstrual leave. Apply at least 1 hour before the leave day starts. Half day allowed; one day per request. No HR approval — HR is notified automatically.'
where code = 'ML';

update public.leave_types set description = 'Unpaid leave. Negative balance may be allowed. HR approval is required.'
where code = 'LOP';

update public.leave_types set description = 'Compensatory off for extra work already done. HR approval is required.'
where code = 'COMP';

update public.leave_types set description = 'Maternity leave. Attachment and handover are required. HR approval is required.'
where code = 'MAT';

update public.leave_types set description = 'Paternity leave. Handover and HR approval are required.'
where code = 'PAT';

update public.leave_types set description = 'Other leave when no standard type fits. HR approval is required.'
where code = 'OTH';

update public.leave_types set description = 'Vacation leave. Follow notice and approval rules for this type.'
where code = 'VC';

-- Enforce 1-hour notice on published ML policy rules (any version status so drafts stay consistent).
update public.leave_policy_rules as r
set rules = jsonb_set(
  jsonb_set(coalesce(r.rules, '{}'::jsonb), '{notice_period,value}', '1'::jsonb),
  '{notice_period,unit}',
  '"hours"'::jsonb
)
from public.leave_policy_versions as v
join public.leave_policies as p on p.id = v.policy_id
join public.leave_types as t on t.id = p.leave_type_id
where r.version_id = v.id
  and t.code = 'ML';

notify pgrst, 'reload schema';
