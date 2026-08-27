# Light QA — project lead (Phases 0–4)

Manual / smoke checklist after migrations `036`–`038`. Use seeded Employee + CSO (`scripts/SEED.md`). Assign the employee as lead of an active project before leave tests.

## 1. Create / assign lead (CSO)

- [ ] **Projects** → Add project: name, code, required lead → lead appears in Lead column and is a member.
- [ ] Assign people: change lead → old lead loses **My projects**; new lead gains it on next load (+ notify).
- [ ] Cannot save members without a lead; lead must stay in the member list.
- [ ] Removing someone who is still lead on another path (employee projects) is blocked until a new lead is chosen on Projects.

## 2. Desk visibility + updates

- [ ] As lead: **My projects** lists only projects where `lead_employee_id = me` and status is **active**.
- [ ] Desk shows members (Lead label), week priorities for that `project_id`, daily notes for that project, status updates composer.
- [ ] Non-lead member: no desk for that project (403 / empty list).
- [ ] CSO/SA: **Updates** on Projects is read-only; members do not see updates.
- [ ] Mark project **inactive** → disappears from My projects and leave project picker; Assign people disabled; Reactivate restores (needs a lead).
- [ ] Posting a status update on an inactive project is blocked.

## 3. Leave — pick project

- [ ] Employee on ≥1 active project with a lead, approval-required leave → **Project** select required.
- [ ] Not on any project (e.g. Testing-only) → no project field; flow stays Handover? → HR.
- [ ] Auto-approved type (e.g. ML with approval off) → no project / no PROJECT_LEAD step.

## 4. Step graph

| Case | Expect |
|------|--------|
| Handover, lead ≠ handover | Handover accept → Project lead approve → HR |
| Handover = lead | One **Accept handover & lead** → HR |
| No handover, on a project | Project lead → HR |
| Applicant is the project lead | Project-lead step auto-done; copy explains skip |

- [ ] Journey UI shows Handover → Project lead → Under review → Approved.
- [ ] HR Approve stays disabled until prior steps are done.

## 5. Lead change mid-pending leave

- [ ] Leave waiting on PROJECT_LEAD; CSO changes lead → new lead gets notify / inbox; old lead can no longer approve.
- [ ] New lead’s **Approve as project lead** succeeds; HR can then approve.

## 6. Copy / UX smoke

- [ ] Apply form hints: project pick, self-as-lead skip, handover=lead combo.
- [ ] Leave page sections: Handover requests + Project lead approvals.
- [ ] Notification deep links: handover → `/leave/handover/:id`; project lead → `/leave/lead/:id`.

## Quick API smoke (optional)

```bash
curl -s -H "Authorization: Bearer $LEAD_TOKEN" "$API/api/v1/work/lead/projects"
curl -s -H "Authorization: Bearer $LEAD_TOKEN" "$API/api/v1/leave-projects"
curl -s -X PATCH -H "Authorization: Bearer $CSO_TOKEN" -H "Content-Type: application/json" \
  -d '{"status":"inactive"}' "$API/api/v1/work/projects/$PROJECT_ID/status"
```
