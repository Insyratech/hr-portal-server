# HR Portal — API

Fastify service for the 30M Genomics HR / ERP portal. The browser never talks to Postgres. It signs in with Supabase Auth, then calls this API with the access token. This process uses the Supabase service role, checks the role, and writes the row.

```
Browser (Client :3000)
        │  Supabase Auth  →  access token
        ▼
Fastify  /api/v1/*   (:3001)
        │  Bearer JWT  →  employee + roles + permissions
        ▼
Supabase Postgres + Storage
        │
        ├── Brevo          mail (leave, work, payroll, reset)
        ├── Web Push       VAPID (optional)
        └── Finance GSP    e-invoice / e-way (sandbox unless live keys are set)
```

Pair this file with the web app: [`../Client/README.md`](../Client/README.md).

## Request path

```
HTTP
 │
 ▼
CORS + error handler
 │
 ▼
/api/v1 ? ──no──►  /health or /
 │
 yes
 │
 ▼
Authorization: Bearer <supabase access token>
 │
 ├── missing token ──► route may 401 (requireAuth / requirePermission)
 │
 ▼
verifyAccessToken(SUPABASE_JWT_SECRET)
 │
 ▼
resolveRequestUser  →  employee, roles, permissions
 │
 ▼
requirePermission(...) or domain owner (HR / GM / CSO / Finance / Inventory)
 │
 ▼
module service  →  Supabase  →  { success, data, meta }
```

Cron routes skip the user token. They accept header `x-cron-secret` matching `CRON_SECRET`.

Public inventory scan (`GET /api/v1/inventory/public/scan/:token`) is the other unauthenticated read. It returns the lot or station card for a QR, and rate-limits scans.

## Roles

Every person is an employee. Managerial hats are extra roles on the same profile. Super Admin creates the login as Employee only, then assigns hats later. Create ignores any managerial role sent with the person.

| Code | Home | Owns |
|---|---|---|
| `EMPLOYEE` | `/dashboard` | Own leave, permission, attendance view, work loop, payslips, grievances, indents, expense claims |
| `HR_MANAGER` | `/hr` | Directory staffing, companies, shifts, leave types, holidays, leave / permission / shift-change / grievance decisions, published slips (read) |
| `GENERAL_MANAGER` | `/gm` | Attendance import and confirm, payroll calculate and publish, who’s out, weekly PPT and JC inbox |
| `CSO` | `/cso/work` | Projects and leads, team week, priorities, insights. Still files personal priorities, daily notes, and PPTs |
| `FINANCE_MANAGER` | `/finance` | Sales, purchases, expenses, banking, GST, books |
| `INVENTORY_MANAGER` | `/inventory` | Catalog, lots, prep, plastic, stations, alerts |
| `SUPER_ADMIN` | `/super-admin` | Accounts, role assignment, directory unlock, audit, HR policy files. No employee self-service |

`ADMIN` is the old name of General Manager. Do not assign it.

Who skips the personal work loop (priorities, daily update, weekly PPT): Super Admin, HR, General Manager, Finance, Inventory. CSO stays in the loop even with another hat.

Domain checks live in `src/shared/domain-owners.ts`. A guessed URL still returns 403 when the role does not own that desk.

## Segments

### 1. Sign-in and account

```
Email + password
        │
        ▼
Supabase Auth          (browser; this API does not store the password)
        │
        ▼
GET /api/v1/me         Bearer token
        │
        ▼
employees row + user_roles + permissions
        │
        ├── no employee row ──► 403  (login exists, directory does not)
        ▼
Client shell for the highest hat
```

Password reset mail is sent by this API through Brevo. The link uses `PORTAL_PUBLIC_URL`.

| Step | Who | API area |
|---|---|---|
| Create person + login | Super Admin | `POST /api/v1/employees` — Employee role only |
| Company, shift, leave, pay, bank | HR Manager | employee staffing routes |
| Assign HR / GM / CSO / Finance / Inventory | Super Admin | `PATCH /api/v1/employees/:id/roles` |
| Change personal fields | HR asks, Super Admin unlocks that person | `src/modules/employees/edit-requests.ts` |
| Deactivate | Super Admin | lifecycle on the employee row |

Personal-field edits stay locked until an approved directory edit request is open for that employee. Company, compensation, bank, shift, and leave do not need that unlock. Role assignment does not need it either.

### 2. Leave

Leave types decide the chain. Each type can require a handover colleague, a project lead, HR, or a combination. An applicant who belongs to an active project with a lead picks that project when the type requires project-lead approval. If they are the lead, that step is already accepted. If the handover person is the lead, those two steps collapse.

```
Employee applies
        │
        ▼
Policy engine
  balance, notice, half-day, attachment, working days
        │
        ▼
Steps written to leave_approvals, in order:

   [Handover colleague]  →  [Project lead]  →  [HR Manager]
        │                         │                    │
        └──── skipped when the leave type does not require that step
                                  │
                                  ▼
                    finalise_leave_application
                                  │
                                  ▼
                         APPROVED or REJECTED
                                  │
                                  ▼
              Attendance overlay + payroll LOP inputs
```

| Path | Module |
|---|---|
| Apply, cancel, balances | `src/modules/leave/application-service.ts` |
| Which steps to insert | `src/modules/leave/project-lead-approval.ts` |
| Notice and day count | `src/modules/leave/notice-deadline.ts`, `day-count` |
| Types, policies, allocations, holidays | `src/modules/leave/routes.ts` |
| Annual allocation and carry-forward | `src/jobs/leave-jobs.ts` |

Holidays and working-day settings are HR configuration. General Manager reads holidays and the who’s-out board.

### 3. Work permission (1 hour)

Two uses a month. Each use is 1 hour (60 minutes), at the start of the shift or the end. Pending and approved uses both count toward the 120-minute quota. Rejected or cancelled uses return the day.

```
Employee picks a date + START or END
        │
        ▼
Quota check (2 days, 120 minutes, one open request per date)
        │
        ▼
PENDING  ──►  HR approve or reject
        │
        ├── APPROVED ──► that day’s attendance treats the hour as covered
        └── REJECTED / CANCELLED ──► quota restored
```

Code: `src/modules/work-permissions/`.

### 4. Shift change

```
Employee picks dates + requested shift + project (when they have a lead)
        │
        ▼
Project lead accept     (skipped when they are the lead, or have no led project)
        │
        ▼
HR approve or reject
        │
        ▼
Approved row overrides the shift assignment for those dates
        │
        ▼
Attendance import uses the override when it scores that day
```

Code: `src/modules/shift-changes/`.

### 5. Compensatory work

An employee asks to work a holiday or week-off and earn COMP leave. Credit happens after the work day is confirmed, inside the annual earn cap.

```
EARN request (work date + project when they have a lead)
        │
        ▼
Project lead          (waitingOn = PROJECT_LEAD)
        │
        ▼
HR                    (waitingOn = HR)
        │
        ▼
Work day confirmed    (waitingOn = WORK_CONFIRM)
        │
        ▼
COMP allocation credited
```

Status is `PENDING`, `APPROVED`, `REJECTED`, or `CANCELLED`. A second path adjusts an existing approved leave day onto the compensatory balance. Code: `src/modules/comp-off-work/`. Confirmed compensatory dates are removed from LOP when attendance is scored (`compensated-dates.ts`).

### 6. Attendance

There is no in-app punch. The biometric workbook is the clock. The machine runs 9 minutes fast (`PUNCH_CLOCK_SKEW_MINUTES`). Every shift has at least 15 minutes of grace.

```
GM uploads the month’s Excel
        │
        ▼
Parse grid → match employee code / name
        │
        ▼
For each day:
   holiday / week-off / approved leave / no shift
        or
   first punch + last punch
        │  minus 9 minutes
        ▼
Rule engine → PRESENT | LATE | ABSENT | HALF_DAY | MISSING_PUNCH | LEAVE | HOLIDAY | WEEK_OFF | NO_SHIFT
        │
        ▼
LOP proposal
   approved permission minutes cover a short start or end
   compensated comp-off dates are not LOP
   MISSING_PUNCH is a flag — it does not become a half-day by itself
        │
        ▼
GM reviews flags and confirms the import
        │
        ├── employees can open Attendance for that month
        └── payroll can calculate from the confirmed days

Payroll PUBLISHED ──► that month cannot be re-uploaded
```

| Piece | Path |
|---|---|
| Clock skew and grace | `src/modules/attendance/punch-clock.ts` |
| Day outcome | `src/modules/attendance/rule-engine.ts` |
| Workbook, match, LOP, confirm | `src/modules/attendance/import/` |
| Shifts and assignments | `src/modules/attendance/shift-service.ts` |

### 7. Payroll

HR stores the monthly package (basic, DA, HRA, fuel, incentives, other, and the deduction lines). General Manager calculates a month and publishes it. Employees see a slip only after publish. HR can read published slips.

```
Confirmed attendance for YYYY-MM
        │
        ▼
DRAFT run
        │
        ▼
Calculate
   daily rate = monthly gross ÷ calendar days in the month
   full calendar month of payable days → pay the monthly gross (no round-off residue)
   LOP amount = daily rate × final LOP days
   net = payable − PT − TDS − welfare − KPI − other − LOP
        │
        ▼
CALCULATED     GM may still override pay lines for this run
        │
        ▼
PUBLISHED      slips visible, attendance month locked
```

Code: `src/modules/payroll/calc.ts`, `service.ts`, `routes.ts`.

### 8. Work loop

Two calendars:

| Calendar | Used for |
|---|---|
| Organisation week | Weekly priorities and the daily note |
| Tuesday–Monday | Weekly work-update PPT and Journal Club PPT. Upload opens Saturday 14:00 IST. Monday is the meeting day |

```
Monday
  Employee writes priorities (at least one R&D project or regular goal)
        │
        ▼
  Project lead: DRAFT → SUBMITTED → APPROVED or RESUBMIT_REQUESTED
        │
        ▼
Each working day (priorities must already be APPROVED)
  Daily note
        │
        ▼
Saturday 14:00 IST → Sunday 23:59 IST
  Weekly PPT upload
        │
        ├── on time     Sat 14:00 – Sun 22:59 IST
        ├── last hour   Sun 23:00 – 23:59 IST
        └── late        after that, still inside the Tue–Mon week
        │
        ▼
  File goes straight into that week’s GM inbox
        │
        ▼
Journal Club PPT (separate file, same week window)
  Employee upload → GM inbox (with_gm)
  GM download or email removes the stored file
```

People on approved leave are skipped by the Monday reminder. They can submit priorities on any later day that week. There is no Monday cutoff in the API.

Reminders run inside this process every 5 minutes and self-gate on Asia/Kolkata. A missed slot is sent on the next tick. Set `WORK_CRON_ENABLED=false` only when an external cron owns the same routes. Schedule detail: [`docs/cron-ist.md`](docs/cron-ist.md).

| Job | When it acts (IST) |
|---|---|
| `POST /api/v1/jobs/work/monday-priorities` | Monday 16:00 |
| `POST /api/v1/jobs/work/daily-reminders` | Daily 17:00, 20:00, 23:00, plus the Sunday PPT hours |
| `POST /api/v1/jobs/work/weekly-ppt-reminders` | Sunday 18:00, 20:00, 22:00; CSO digest from 22:00 |
| `POST /api/v1/jobs/work/close-days` | After midnight — closes a missing daily note. Not run by the in-process scheduler |
| `POST /api/v1/jobs/work/retention-purge` | Drops work rows past retention |
| `POST /api/v1/jobs/leave/annual-allocation` | Leave grant |
| `POST /api/v1/jobs/leave/carry-forward` | Carry forward |
| `POST /api/v1/jobs/inventory/alerts/daily` | Reorder, velocity, expiry |
| `POST /api/v1/jobs/reminders/daily` | Leave reminders + Monday priorities + close missing days |

Code: `src/modules/work/`, `src/jobs/`.

### 9. Projects

```
CSO creates a project and sets one lead
        │
        ▼
Lead’s desk (members, project priorities, daily notes, status updates)
        │
        ▼
Leave, shift change, and comp-off requests from members
route to that lead before HR
```

Inactive projects drop out of the picker. A lead change is told about leave still waiting on the old lead. Code: `src/modules/work/` project sections and `src/modules/leave/project-lead-approval.ts`.

### 10. Finance

One company profile, then documents. Number series allocate the next document number. Period lock stops edits in a closed month.

```
Purchases
  Indent (any employee with finance.indent.apply)
      → Finance approve
      → RFQ → Purchase order → Receipt → Bill → Payment
      → Vendor credit

Sales
  Quote → Sales order → Delivery note → Invoice
      → Payment received → Credit note

Books
  Chart of accounts → Journal → General ledger → Trial balance
      → Opening balances → Period lock

Bank
  Statement import → match to payments → reconciliation

GST
  Outward, inward / ITC, HSN, workbooks, TDS
  GSP sandbox (default) or live IRP for e-invoice and e-way
```

Vendor registration collects GSTIN, addresses, and documents before a vendor is used on a bill. GSTIN lookup decodes state and PAN from the number. A live name and address needs `FINANCE_GSTIN_LOOKUP_API_KEY`.

Code: `src/modules/finance/`. Operator notes for the GSP: [`../docs/finance_gsp_runbook.md`](../docs/finance_gsp_runbook.md).

### 11. Inventory

Stock is a lot with a QR token, or plastic boxes on a station QR. Scanning does not require a portal login when the token is opened on `/scan`.

```
Masters
  Locations → Categories → Catalog items → who may issue

Materials / chemicals / solvents / reagents
  Receive lot (qty, cost, expiry, location)
        │
        ▼
  QR label
        │
        ├── staff issue / adjust
        └── public scan issue (remaining qty falls)

Prep
  Open session → consume input lots → completed session creates a prep-origin lot

Plastic
  Receive boxes onto a station
        │
        ▼
  Station QR → issue boxes
```

Lot and plastic stock status: `active`, `depleted`, `void`. Movements are `receive`, `issue`, `adjust`. Prep status: `open`, `completed`, `cancelled`.

Alerts (reorder level, use velocity, expiry lead) run on the daily inventory job. Code: `src/modules/inventory/`.

### 12. Grievances, policies, FAQ, notifications

```
Grievance
  Employee opens a case → handler (HR) comments and attaches files → closed

Policy
  Super Admin publishes an HR policy file
  Employee reads it and acknowledges

FAQ
  In-app answers plus a contact target (HR / GM / CSO) for the topic

Notification
  Row in notifications
        │
        ├── bell in the web app
        ├── Brevo email when the event has a mail body
        └── Web Push when the browser subscribed and VAPID keys are set
```

Mail bodies put links as plain text so Brevo click-tracking does not rewrite them.

## Layout

| Area | Path |
|---|---|
| Process entry | `src/server.ts` |
| Route registration | `src/app.ts` |
| Env | `src/config/env.ts` |
| Auth plugin | `src/plugins/auth.ts` |
| Permission guards | `src/plugins/permissions.ts` |
| Role and permission constants | `src/shared/constants/permissions.ts` |
| Domain owners | `src/shared/domain-owners.ts` |
| Modules | `src/modules/<segment>/` |
| Cron routes and scheduler | `src/jobs/` |
| SQL migrations | `supabase/migrations/` |
| One-off data fixes | `supabase/one-off/` (do not re-run as schema) |
| Seed | `scripts/seed-users.ts`, `scripts/SEED.md` |

## Setup

```bash
cd "HR Portal/Backend"
cp .env.example .env
npm install
# apply supabase/migrations in order on the Supabase project
npm run seed          # needs SEED_PASSWORD and the seed emails in .env
npm run dev           # http://127.0.0.1:3001
```

`GET /health` returns `supabaseConfigured`. The web app expects this process on `NEXT_PUBLIC_API_URL` (default `http://localhost:3001`) and CORS must allow the web origin.

## Verify

```bash
npm run typecheck
npm run test
```

## Environment

Server-only. Never copy these into the Client or into a `NEXT_PUBLIC_` variable.

```bash
PORT=3001
HOST=127.0.0.1
CORS_ORIGIN=http://localhost:3000
PORTAL_PUBLIC_URL=http://localhost:3000
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_JWT_SECRET=
CRON_SECRET=
WORK_CRON_ENABLED=true
BREVO_API_KEY=
BREVO_SENDER_EMAIL=
BREVO_SENDER_NAME=ERP Portal
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:hr@yourcompany.com
```

Finance GSP, GSTIN lookup, payment gateway, and bank-feed keys are optional. `FINANCE_GSP_MODE` defaults to `sandbox`, which does not call the live IRP. The full list is in `src/config/env.ts` and `.env.example`.

## Deliberately separate

The web app (`../Client`) holds the anon Supabase key and the screens. This API holds the service role. Inventory QR pages are the only public data read. Mobile shells live in `../Mobile` and call the same `/api/v1` routes.
