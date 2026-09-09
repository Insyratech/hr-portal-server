# Work jobs — IST cron schedule

All work reminder / digests use **Asia/Kolkata (IST)**. Each handler self-gates on the current IST hour and day, and every send is claimed once per person per day in `work_reminder_log`, so calling a job more often than its slot hours is safe.

## The API sends these itself

`startWorkJobScheduler` (`Backend/src/jobs/scheduler.ts`) runs the full reminder sweep from inside the API process every 5 minutes, so reminders do not depend on an external scheduler existing. Set `WORK_CRON_ENABLED=false` to turn it off and hand the schedule back to cron.

Because a slot is claimed at the **latest due hour**, a slot missed while the process was down is still sent on the next tick rather than skipped.

## Slots

| What | IST hours | Configurable |
|------|-----------|--------------|
| Monday priority reminder | 16:00 | no |
| Daily work-update reminder | 17:00, 20:00, 23:00 | yes — Super Admin → work settings |
| Sunday weekly-PPT reminder | 18:00, 20:00, 22:00 | no (`WEEKLY_PPT_REMINDER_HOURS`) |
| Sunday CSO PPT digest | from 22:00 | no (`WEEKLY_PPT_CSO_DIGEST_HOUR`) |

Daily reminders go only to people who are **not on approved leave**, whose priorities are **fully approved**, and whose update for the day is **still missing**.

## Endpoints

Still available for an external scheduler; they do the same work as a scheduler tick.

| Method | Path | When it acts (IST) | What it does |
|--------|------|--------------------|--------------|
| `POST` | `/api/v1/jobs/work/monday-priorities` | **Monday 16:00** | Remind employees (work loop only) to set / submit weekly priorities. **Reminder only** — there is no 6pm (or other) submit cutoff. |
| `POST` | `/api/v1/jobs/work/daily-reminders` | Daily reminder hours; Sunday PPT hours | Full sweep: Monday priorities, daily update reminders, Sunday PPT reminders, CSO digest |
| `POST` | `/api/v1/jobs/work/weekly-ppt-reminders` | Same Sunday gates as above | PPT employee reminders + CSO digest only (alias for PPT slice) |
| `POST` | `/api/v1/jobs/reminders/daily` | Morning-style bundle | Leave daily reminders + Monday priorities (if Mon 16) + close missing work days |
| `POST` | `/api/v1/jobs/work/close-days` | After midnight IST (ops choice) | Close previous calendar day’s missing daily updates |
| `POST` | `/api/v1/jobs/work/retention-purge` | Weekly / nightly (ops) | Purge work data past retention |

## Monday priorities — leave and submit window

- The Monday 16:00 IST job **skips** people on **approved leave** that day (`onApprovedLeave` / not required). They are not mailed.
- After they return, they may **submit any day** that week. Create/submit APIs have **no Monday-only lock**.
- Soft product copy: “submit before end of Monday”; if on leave Monday, “submit when you are back.”
- **≥ 1 work goal** is required at submit (R&D project or regular). Skill is optional. About 3–5 is suggested, not enforced.

## Suggested external cron (only if `WORK_CRON_ENABLED=false`)

Fire hourly; handlers self-gate on IST:

```text
0 * * * *  curl -X POST -H "x-cron-secret: $CRON_SECRET" "$API/api/v1/jobs/work/daily-reminders"
15 0 * * * curl -X POST -H "x-cron-secret: $CRON_SECRET" "$API/api/v1/jobs/work/close-days"
```

`close-days` is the only job the in-process scheduler does not run, because it is a data-closing job rather than a reminder.

UTC equivalents shift with DST elsewhere — prefer an IST-aware scheduler, or convert:

| IST | ≈ UTC (no DST in India) |
|-----|-------------------------|
| Mon 16:00 | Mon 10:30 |
| Daily 17:00 | 11:30 |
| Daily 20:00 | 14:30 |
| Daily 23:00 | 17:30 |
| Sun PPT 18:00 / 20:00 / 22:00 | 12:30 / 14:30 / 16:30 |

## Weekly PPT lateness

| Submitted (IST) | Tag |
|-----------------|-----|
| up to Sun 22:59 | On time |
| Sun 23:00–23:59 | Last hour submission |
| Mon 00:00 onwards | Late |

Stored in `weekly_work_updates.submission_timing`; the `late` boolean is derived from it.

## Who is in the loop

Reminders and Team week / PPT desks **exclude** Super Admin, HR Manager, General Manager, and Finance Manager. **CSO still participates** as an employee (personal priorities, daily, PPT) and owns the managerial PPT desk + Sunday digest.

## Source of truth

- Daily hours + defaults: `Backend/src/modules/work/ist-clock.ts`
- PPT hours + lateness rule: `Backend/src/modules/work/ppt-week.ts`
- Jobs: `Backend/src/modules/work/work-jobs.ts`
- In-process scheduler: `Backend/src/jobs/scheduler.ts`
- Routes: `Backend/src/jobs/routes.ts`
- SA UI labels: Client work retention settings
