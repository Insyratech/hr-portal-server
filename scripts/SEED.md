# Seed users

Run from `Backend/` after migrations (especially `027_role_restructure.sql` and `029_directory_edit_requests.sql`):

```bash
npm run seed
```

Requires `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SEED_PASSWORD` in `.env`.

## Default accounts

| Role | Default email | Env override | Home |
|------|---------------|--------------|------|
| Super Admin | `superadmin@example.com` | `SEED_SUPER_ADMIN_EMAIL` | `/super-admin` |
| General Manager (ex-ADMIN) | `gm@example.com` | `SEED_GM_EMAIL` or legacy `SEED_ADMIN_EMAIL` | `/gm` |
| HR Manager | `hr@example.com` | `SEED_HR_EMAIL` | `/hr` |
| Employee | `employee@example.com` | `SEED_EMPLOYEE_EMAIL` | `/dashboard` |
| CSO (optional) | `cso@example.com` | `SEED_CSO_EMAIL` | `/cso` |
| Finance Manager (optional) | `finance@example.com` | `SEED_FINANCE_EMAIL` | `/finance` |

Optional roles (CSO, Finance) seed when `SEED_OPTIONAL_ROLES` is unset, `true`, `1`, or `yes`. Set `SEED_OPTIONAL_ROLES=false` to skip them.

All seeded accounts share `SEED_PASSWORD`.

## Regression smoke (after seed)

1. Employee: Today / Priorities unchanged under `/work`
2. Leave apply → HR Manager approve on `/hr/leaves`
3. Permission apply → HR Manager approve on `/hr/permissions`
4. Grievance → HR Manager resolve on `/hr/grievances`
5. Attendance upload → General Manager on `/gm/attendance`
6. Work team desk → CSO on `/cso/work` (approval + PPT columns; names open priorities)
7. Account create → Super Admin only on `/super-admin/employees/new`
8. Edit employee X → HR request on profile → SA approve on `/super-admin/edit-requests` → SA edits only X

Work-loop polish checklist: `docs/qa-work-loop.md`. IST cron: `docs/cron-ist.md`.
