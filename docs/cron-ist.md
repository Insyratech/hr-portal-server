# Work jobs — IST cron schedule

All work reminder / digests use **Asia/Kolkata (IST)**. Cron runners should call the job endpoints with header `x-cron-secret: $CRON_SECRET` every hour (or at the listed IST hours). Each handler no-ops when the current IST hour/day does not match.

## Endpoints

| Method | Path | When it acts (IST) | What it does |
|--------|------|--------------------|--------------|
| `POST` | `/api/v1/jobs/work/monday-priorities` | **Monday 16:00** | Remind employees (work loop only) to set / submit weekly priorities. **Reminder only** — there is no 6pm (or other) submit cutoff. |
| `POST` | `/api/v1/jobs/work/daily-reminders` | **Daily 20:00 & 22:00** (org-configurable hours) | Daily update reminders if priorities are fully approved; on **Sunday** also employee PPT reminders after 18:00 and **CSO PPT digest at 22:00** |
| `POST` | `/api/v1/jobs/work/weekly-ppt-reminders` | Same Sunday gates as above | PPT employee reminders + CSO digest only (alias for PPT slice) |
| `POST` | `/api/v1/jobs/reminders/daily` | Morning-style bundle | Leave daily reminders + Monday priorities (if Mon 16) + close missing work days |
| `POST` | `/api/v1/jobs/work/close-days` | After midnight IST (ops choice) | Close previous calendar day’s missing daily updates |
| `POST` | `/api/v1/jobs/work/retention-purge` | Weekly / nightly (ops) | Purge work data past retention |

## Monday priorities — leave and submit window

- The Monday 16:00 IST job **skips** people on **approved leave** that day (`onApprovedLeave` / not required). They are not mailed.
- After they return, they may **submit any day** that week. Create/submit APIs have **no Monday-only lock**.
- Soft product copy: “submit before end of Monday”; if on leave Monday, “submit when you are back.”
- **≥ 1 work goal** is required at submit (R&D project or regular). Skill is optional. About 3–5 is suggested, not enforced.

## Suggested external cron (example)

Fire hourly; handlers self-gate on IST:

```text
0 * * * *  curl -X POST -H "x-cron-secret: $CRON_SECRET" "$API/api/v1/jobs/work/daily-reminders"
0 * * * *  curl -X POST -H "x-cron-secret: $CRON_SECRET" "$API/api/v1/jobs/work/monday-priorities"
15 0 * * * curl -X POST -H "x-cron-secret: $CRON_SECRET" "$API/api/v1/jobs/work/close-days"
```

UTC equivalents shift with DST elsewhere — prefer an IST-aware scheduler, or convert:

| IST | ≈ UTC (no DST in India) |
|-----|-------------------------|
| Mon 16:00 | Mon 10:30 |
| Daily 20:00 | 14:30 |
| Daily / Sun 22:00 | 16:30 |
| Sun PPT late gate 18:00 | 12:30 |

## Who is in the loop

Reminders and Team week / PPT desks **exclude** Super Admin, HR Manager, General Manager, and Finance Manager. **CSO still participates** as an employee (personal priorities, daily, PPT) and owns the managerial PPT desk + Sunday digest.

## Source of truth

- Hours: `Backend/src/modules/work/ist-clock.ts`
- Jobs: `Backend/src/modules/work/work-jobs.ts`
- Routes: `Backend/src/jobs/routes.ts`
- SA UI labels: Client work retention settings
