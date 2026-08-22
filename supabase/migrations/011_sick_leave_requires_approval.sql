update public.leave_types
set requires_approval = true
where code = 'SL';

update public.leave_policy_rules as r
set rules = jsonb_set(coalesce(r.rules, '{}'::jsonb), '{requires_approval}', 'true'::jsonb)
from public.leave_policy_versions as v
join public.leave_policies as p on p.id = v.policy_id
join public.leave_types as t on t.id = p.leave_type_id
where r.version_id = v.id
  and t.code = 'SL'
  and v.status = 'published';

notify pgrst, 'reload schema';
