# Light QA — work loop (Phase 5)

Manual / smoke checklist after migrations `030`–`033`. Use seeded Employee + CSO + GM (`scripts/SEED.md`).

## 1. Exclude rules

- [ ] Log in as **HR / GM / Finance** → Employee sidebar has no Today / Priorities / My weekly update / Trends / History.
- [ ] Those roles cannot upload weekly PPT (API 403 / empty state).
- [ ] **CSO** still sees personal My work loop + managerial Team week / Weekly work updates.
- [ ] CSO Team week and Weekly work updates **do not** list SA/HR/GM/Finance as expected.

## 2. Approval → daily unlock

1. As Employee: add priorities → **Submit all** (or submit each line).
2. CSO gets in-app alert → opens **`/cso/work/priorities?employeeId=…`** (not the empty picker).
3. CSO approves each line.
4. Employee alert → **`/work/priorities`**.
5. Employee **Today’s update** unlocks; before approve it shows waiting-for-CSO.

## 3. Reminders (IST)

With `x-cron-secret`, call (or wait for cron):

- [ ] `POST /api/v1/jobs/work/monday-priorities` at Mon **16 IST** — only loop employees without submitted priorities.
- [ ] **Leave Monday:** employee on approved leave that Monday is **not** mailed; they can still submit later in the week (no Monday-only lock; no 6pm cutoff).
- [ ] Submit with **no work goal** (skill only) is rejected; ≥1 work goal is required.
- [ ] `POST /api/v1/jobs/work/daily-reminders` at **20 / 22 IST** — daily only if priorities approved; skip hats excluded.
- [ ] Sunday after **18 IST**: PPT reminders for missing decks; at **22 IST**: CSO digest only.

See `docs/cron-ist.md`.

## 4. PPT replace

1. Employee uploads `.pptx` ≤ 15 MB on **My weekly update**.
2. Upload again (2nd of 2) → first file replaced; `uploadCount` / late flag correct after Sunday 18 IST.
3. Download from employee page works.

## 5. Share → GM download

1. CSO **Weekly work updates** → **Share all to General Manager** (needs ≥1 file).
2. GM gets alert/email → **`/gm/weekly-updates?shareId=…`**.
3. GM downloads / emails / deletes a file → storage file removed; share + audit history remain.
4. Re-share same week → second timeline row (allowed).

## 6. JC PPT flow

1. Employee **Work → JC** uploads `.pptx` ≤ 15 MB.
2. CSO **Team JC** → Preview → **Transfer to GM**.
3. GM **Team JC** → Download / Email / Delete (or Download all / Delete all). File removed; audit history kept.
4. Employee / CSO / GM still see audit history rows after the file is gone.

## 7. Deep-links

- [ ] CSO personal daily/Monday mail → `/work` or `/work/priorities` (not Team week).
- [ ] CSO digest → `/cso/work/weekly-updates?weekStart=…`.
- [ ] Team week name → `/cso/work/priorities?employeeId=…`.
- [ ] Login `?next=/work/priorities` as CSO lands on priorities (not forced to `/cso`).
- [ ] JC alerts → `/work/jc` (employee), `/cso/work/jc` (CSO), `/gm/jc` (GM).

## Quick API smoke (optional)

```bash
# Replace tokens / ids
curl -s -H "Authorization: Bearer $EMP_TOKEN" "$API/api/v1/work/weekly-updates"
curl -s -H "Authorization: Bearer $CSO_TOKEN" "$API/api/v1/work/weekly-updates/admin"
curl -s -X POST -H "Authorization: Bearer $CSO_TOKEN" -H "Content-Type: application/json" \
  -d '{}' "$API/api/v1/work/weekly-updates/share-to-gm"
curl -s -H "Authorization: Bearer $GM_TOKEN" "$API/api/v1/work/weekly-updates/shares"
curl -s -H "Authorization: Bearer $EMP_TOKEN" "$API/api/v1/work/jc"
curl -s -H "Authorization: Bearer $CSO_TOKEN" "$API/api/v1/work/jc/admin"
curl -s -H "Authorization: Bearer $GM_TOKEN" "$API/api/v1/work/jc/gm"
```
