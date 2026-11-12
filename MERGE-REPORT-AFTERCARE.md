# Merge report: chakrabardhan's after-care work into rajarshee

Date: 12 Nov 2026 · Branch: `merge-2-aftercare` (in `medos-rajarshee`) · Not committed yet.

| | Folder | Scope |
|---|---|---|
| **R** (target, kept as the base) | `medos-rajarshee` (git, branch `medos--merge1`, HEAD `923ac6a`) | Admission to ongoing care: LIMS portal, emergency ward, ICU (+ billing, equipment), planned admission, ward rounds, manager overview |
| **C** (source of the extra features) | `medos-chakrabardhan/medos-testing-medos_code_merge` (no git) | After care: 12-stage discharge, OT / procedures, housekeeping, procurement to consumption, cashless-insurance completion, post-discharge / MRD, after-discharge journey (aftercare) |

Neither source folder was changed apart from the merge branch in R. `medos--merge1` is untouched; a rollback is `git checkout medos--merge1`.

---

## 1. How the merge was done

1. **Common ancestor found.** C is exactly R's commit `21b3b8c "merge 1"` plus C's own changes (every file C did not touch is byte-identical to `21b3b8c`; C deleted nothing). So a real **3-way merge** was possible, instead of copying files.
2. C's tree was committed as branch `chakrabardhan-aftercare` on top of `21b3b8c` (157 files, +17,067 / −940).
3. New branch `merge-2-aftercare` from R's HEAD, then `git merge --no-commit chakrabardhan-aftercare`.
4. Git merged 140 files by itself; **17 files conflicted** and were resolved by hand, keeping both sides (section 3).
5. Then the **semantic** clashes that git cannot see were found and fixed (section 4): same names used for different things, and one place where R's and C's workflows disagree.

## 2. What came from chakrabardhan (now in rajarshee)

| Area | Backend | Screen(s) |
|---|---|---|
| 12-stage discharge (decision, summary draft/sign/verify, nursing, charges, pharmacy, lab/radiology, OT, insurance, final billing, financial release, physical exit, bed turnover, post-discharge) | `modules/discharge/*` (+ `admission-tests.service`, `post-discharge.*`, `record-retention.*`) | Admission → *Discharge* tab; *Post-discharge* |
| OT / procedures: plan, perform, implants (serial no.), consumables, finalise, charges | `modules/procedures/*` | Admission → Discharge tab → *Procedures, implants and consumables* |
| Bed turnover + housekeeping requests | `modules/ipd/bed-turnover.*`, `modules/housekeeping/*` | *Housekeeping* |
| Procurement to consumption: reorder suggestions, indents (separate approver), POs (second approval above a value), goods receipt matched to PO, QC rejection + debit note, transfers, ward/OT issue, consumption, balanced cost ledger, supplier payments, stock counts | `modules/procurement/*` | *Procurement* |
| Cashless insurance completion: payer verification, enhancements, non-payables, rate cards and packages, several invoices per claim, co-pay/deductible, appeals, TDS on settlement, FHIR/CSV export and transmit | `modules/claims/*` (`claim-exchange`, `claim-fhir`, `claim-transport`) | *Insurance claims* |
| After discharge: review task from the signed summary, reminders, call list with script/timer/outcomes and daily targets, booking, auto-complete on the visit, staff and one-time-link feedback, complaints with SLA and escalation | `modules/aftercare/*` | *After discharge*, public `/feedback/<token>` |
| New roles | `RMO`, `OT_COORDINATOR`, `PATIENT_TRANSPORT`, `HOUSEKEEPING`, `MEDICAL_RECORDS`, `PROCUREMENT`, `CARE_COORDINATOR`, `PATIENT_RELATIONS` (+ new permissions) | role-based menus |
| Database | 17 migrations (`20261109150000_discharge_summary_verification` … `20261116090000_ledger_sales_scripts`), new schema files `aftercare`, `housekeeping`, `procedures`, `procurement` | |
| Docs | `aftercare.md`, `discharge-stages.md`, `housekeeping.md`, `procedures.md`, `procurement.md`, `record-retention.md`, `local-windows.md`, `MedOS-workflow-status.xlsx` | |

Everything R had (LIMS, emergency, ICU, planned admission, ward rounds, overview, and all earlier work) is kept unchanged except where listed in section 4.

## 3. Conflicts resolved (17 files)

| File | Resolution |
|---|---|
| `packages/shared/src/permissions.ts` | Per role: **union** of R's and C's permissions (R's order kept, C's additions appended). C's new roles added. R's derived roles (`EMERGENCY_DOCTOR`, `ICU_NURSE`, …) unchanged. |
| 7 Prisma schema files (`base`, `billing`, `claims`, `ipd`, `nursing`, `opd`, `patients`) | C had re-formatted these files, so the merge was done **field by field** with a script: R's model text kept, C's new fields/relations/indexes added, C's changed fields applied where R had not changed them. Result validated by `prisma validate`. |
| `apps/api/src/app.module.ts` | Union of controllers and providers from both. |
| `apps/api/src/cli/seed.ts` | All users from both seeds; all services from both price lists (R's ER/ICU items + C's OT, implant and consumable items); combined login help text. |
| `ipd/admissions.service.ts` `releaseBed` | Both: R stops ICU equipment billing on release **and** C returns the released bed id (needed for bed turnover). |
| `numbering/numbering.service.ts` | Both sets of sequences: R's `EMERGENCY`, `PLANNED_ADMISSION`, `LIMS_REQUEST` + C's `INDENT`, `PURCHASE_ORDER`, `STOCK_REQUEST`, `DEBIT_NOTE`, `STOCK_COUNT`, `COMPLAINT`. |
| `pharmacy/dispensing.service.ts` | Both return paths kept: R's "return from an open emergency bill" and C's "return of billed IPD medicines raises a credit note". |
| `web/src/lib/nav.ts` | R's menu (LIMS, Ward board, My rounds, Planned admissions, hide rules for ICU roles) + C's *Housekeeping*, *After discharge*, *Post-discharge*; role menu order merged per role and C's new roles added. |
| `common/tenant-sweep.spec.ts` | Both sides' sweep bodies (with R's procedure routes renamed, see 4.1). |
| `docs/api-routes.md` | Regenerated from the merged controllers (`node scripts/gen-route-docs.mjs`, **690 routes**). |
| `docs/backlog.md` | Both follow-up lists kept. |

## 4. Semantic clashes found and fixed

### 4.1 Two different "procedures" with the same names (would have broken both)
R (ward rounds) has *bedside procedure records* (`ProcedureRecord`, a dressing or line insertion with an optional charge). C has *OT procedures* (`Procedure`: plan → perform → implants/consumables → finalise). They collided on:

| Clash | Fix |
|---|---|
| Prisma relation `procedures` on `Admission` and `Patient` (two types) | R's relation renamed `procedureRecords`; C's stays `procedures`. |
| Two Nest classes named `ProceduresService` registered in one module | R's class renamed `ProcedureRecordsService` (`modules/rounds/procedures.service.ts`). |
| Same HTTP routes `GET/POST /admissions/:id/procedures` and `POST /procedures/:id/...` | R's bedside routes moved to `/admissions/:id/procedure-records` and `/procedure-records/:id/enter-in-error` (controller, web `rounds.tsx`, `rounds.spec.ts`, tenant sweep, `docs/ward-rounds.md`). C's OT routes keep their paths. |
| Same React component name `ProceduresCard` and same React Query cache key `["procedures", id]` on the admission page | R's card imported as `ProcedureRecordsCard`; its cache key is now `["procedure-records", id]`. |

### 4.2 Seed login `coordinator1` used for two roles
R: ward coordinator; C: care coordinator. R keeps `coordinator1`; C's care coordinator is now **`carecoord1`** (seed, `docs/aftercare.md`).

### 4.3 Discharge "Laboratory / radiology" stage did not know R's LIMS (would block every discharge)
R's LIMS sends an **admitted patient's** test straight to the laboratory and charges the admission when the report is issued; the test order is never billed by the cashier. C's stage only knew the cashier path, so it showed "ordered but not yet billed — the cashier bills it", while the cashier's *Bill* was (correctly) refused for that test → **the stage could never clear without a waiver**. Found in the browser on the first discharge.

Fix (`apps/api/src/modules/discharge/lims-test-state.ts`, used by `discharge.service.ts` and `admission-tests.service.ts`): for a test with a LIMS request of origin IPD or EMERGENCY, **performed** = report issued/handed over; **billed** = the admission has its `LIMS:<request>` charge (or the emergency bill has its line). The admission's test list shows *In the laboratory · charged when the report is issued* instead of *To be billed by the cashier*, and *Report issued · charge not on the bill* if the charge is missing. Non-LIMS tests (C's own "Order test" from the Discharge tab) behave exactly as before. Two regression tests added to `lims.spec.ts`; documented in `docs/discharge-stages.md`.

### 4.5 Pharmacy "Receive purchase" dialog crashed (bug in C's code, found by the browser test)
Opening *Pharmacy → Purchases → Receive purchase* crashed the page (`.filter is not a function`): the dialog read the open purchase orders with `api.page()` and expected an array, but `/procurement/orders` answers `{ items, total, … }` (the Procurement screen reads it correctly). The same line is on C's branch, so this was C's bug, not caused by the merge. Fixed in `apps/web/src/components/pharmacy-extras.tsx` (read `.items`, like `procurement.tsx`); verified in the browser — the dialog opens with C's *Against purchase order* picker and *Rejected quantity* column.

### 4.6 Two browser tests made robust (test code only)
- *Appointments*: picked "the first doctor"; since R's emergency work that is *Dr. Emergency Doctor One*, who has no OPD hours ("This doctor does not see patients on that day"). The test now picks an OPD doctor.
- *Pharmacy*: C's dialog added a *Rejected quantity* field, so the label *Quantity* matched two inputs; the test now asks for the exact label.

### 4.4 Other checks
- Two migrations share each of the timestamps `20261110090000` and `20261111180000` (one from each side). Prisma orders by full name, so this is fine; a **fresh database built from all 101 migrations matches the merged schema exactly** (`prisma migrate diff` → empty).
- No dependency changes (`package.json` / `pnpm-lock.yaml` identical on both sides).

## 5. Verification

### 5.1 Build and static checks
| Check | Result |
|---|---|
| `prisma validate` | valid |
| Migrations on a fresh DB (`medos_merge2`) | all 101 applied |
| Migrated DB vs schema (`prisma migrate diff`) | **no drift** |
| API typecheck (incl. all tests) | 0 errors |
| Web typecheck | 0 errors |
| Web production build (`next build`) | success |
| Full demo seed through the real API (1,000 patients, 12 admissions, 50 invoices…) | success |

### 5.2 Automated API tests (real PostgreSQL, nothing mocked)
**Full suite on the merged code** (`pnpm --filter @medos/api test`, database `medos_merge2_test`, 297 suites):

| Tests | Passed | Failed | Skipped |
|---|---|---|---|
| 1,382 | **1,379** | 1 | 2 |

The one failure was the tenant-isolation sweep refusing to run on a nearly empty database ("only 38 foreign records … run the full suite first"); it ran first on a brand-new test database. Re-run after the fixes (files touched by the merge, on the now-populated database):

| File(s) | Result |
|---|---|
| `discharge.spec` (12-stage discharge, final bill, summary) | ✔ all pass |
| `lims.spec` (R's LIMS, incl. admitted patients' billing, **+ the 2 new regression tests for 4.3**) | ✔ all pass (50/50 with the sweep) |
| `procedures.spec` (C's OT) | ✔ all pass |
| `rounds.spec` (R's ward rounds, incl. renamed procedure-record routes) | ✔ all pass |
| `claims.spec` (cashless insurance end to end) | ✔ all pass |
| `aftercare.spec` (post-discharge journey) | ✔ all pass |
| `tenant-sweep.spec` (every route × every foreign record) | ✔ all pass (re-run alone with a 2-hour token lifetime: every route × every foreign record answers 404, bad input never crashes) |

214 of 216 passed in that run; the 2 sweep "failures" were all `401` (expired access token, never a `200` or `500`): the sweep made 141,877 requests in 19.6 minutes while the browser suite ran in parallel, longer than the 15-minute token lifetime.

### 5.3 Browser end-to-end (Playwright, real Chrome, production build)
The project's own Playwright suite (`apps/web/e2e`), run against the production build, its own freshly migrated and seeded database (`medos_e2e`), the real API, in Google Chrome:

| Test | Result |
|---|---|
| **OPD: register → check in → queue → consult → sign → dispense → pay** (mandatory OPD flow) | ✅ |
| **IPD: admit → medication given → note → every discharge stage → departure frees the bed → housekeeping → MRD sign-off** (mandatory IPD flow, C's version) | ✅ |
| Receptionist cannot reach clinical/admin screens; duplicate-patient warning | ✅ ✅ |
| Accessibility rules for 6 roles; keyboard focus | ✅ ×7 |
| Patient edit + photo/document; Bengali/Hindi switch; bill edit/issue/PDF; consultation amendment; admin schedule + custom role; change password; CSV report | ✅ ×7 |
| Appointments: book then reschedule | ❌ → ✅ after fix (see 4.6) |
| Pharmacy: add supplier, receive purchase, return, adjust stock | ❌ → ✅ after fix (see 4.5, 4.6) |

**Final: 20 of 20 pass.**

### 5.4 Flows walked by hand in the browser (merged app on :3100 / :4100, demo data)
Each step done as the responsible role (signing in through the app's own login gateway); key screens clicked in the UI, the rest through the same browser gateway the UI uses.

| # | Flow | Result | What was done |
|---|---|---|---|
| 10 | **Discharge to bed-ready** (Riya Roy, ADM-2026-000001) | ✅ | Doctor cleared *Discharge decision* in the UI → RMO drafted summary → consultant signed → RMO verified → nurse, cashier, pharmacist cleared their stages → CBC went through **LIMS** (nurse collect, technician accept/result/submit, pathologist pass, technician issue) and the lab stage cleared **by itself** → cashier made final bill INV-2026-000051 (₹1,050) and took payment → OT/insurance/financial release cleared by themselves → doctor clicked *Discharge patient* in the UI → patient transport clicked *Confirm departure* → housekeeping *Start cleaning* / *Mark ready* in the UI (turnaround 1 min; housekeeping sees the bed, never the patient) → bed G1 **available** on R's bed board → MRD received the file and signed off with ICD-10 Z48.8. |
| 12 | **Post-discharge journey** | ✅ (review visit itself: next day) | Discharge created the review task (due 19 Nov = 7 days from the signed summary). Care coordinator UI: call list, call script with doctor and date, call timer, *no answer* outcome recorded, daily targets (calls 2/30, bookings 1/5), review **booked** for 13 Nov 11:30 with Dr. Soumen Chakraborty. One-time feedback link made; opened **signed out**; patient rated 2 with a complaint → **CMP-2026-000001** (due in 3 days, MEDIUM) → patient relations took it up, noted, resolved, closed. The review consultation and the automatic task completion need the visit on 13 Nov; that part is covered by `aftercare.spec.ts` (passing). |
| 5 | **Surgery / OT** (Arjun Mukherjee) | ✅ | Doctor planned *Hernia repair* in the UI; OT coordinator *Mark performed*, added implant *Surgical mesh* with lot no. MESH-LOT-55821 and a *Suture pack*, *Finalise* (confirm) — all in the UI. Charges on the admission: ₹18,000 + ₹3,500 + ₹600. OT stage checks all ✓. R's bedside procedure record and round note on the same admission still work (renamed route) and show on *Rounds and procedures*. |
| 9 | **Cashless insurance** (Mousumi Ghosh, ADM-2026-000003) | ✅ | Insurer + policy (10 % co-pay) → payer verification (ref ELIG-55120) → pre-auth ₹20,000 asked, ₹15,000 approved → enhancement ₹4,000 approved (authorised ₹19,000) → claim document (PDF) attached → discharge *Insurance* stage cleared by itself → final bill INV-2026-000052 → claim submitted → approved; co-pay preview: insurer ₹945, **patient ₹105** → patient paid ₹105 → all 9 stages cleared → discharged → insurer settlement ₹850.50 + **TDS ₹94.50** → **SETTLED** → claim exported as **FHIR Bundle** and **CSV**. Claims screen shows it settled. |
| 11 | **Procurement to consumption** | ✅ | Pharmacist ticked 2 of 5 reorder suggestions in the UI → indent IND-2026-000001 → submitted → approved by the manager → procurement made PO-2026-000001 and issued it → goods receipt PUR-2026-000001 against the PO with 4 strips rejected (damaged) → PO *partially received*, debit note **SDN-2026-000001** raised automatically → manager paid the supplier (bank transfer) → cost ledger **balanced: true**. OT consumption and billing to the patient shown in flow 5. |
| 6 | Laboratory investigation (inpatient, LIMS) | ✅ | Twice, as part of flows 10 and 9 (order → collection → accession LAB-2026-000001 → result → pathologist verification → issue → charge on the admission). |
| — | R's screens with the merged code | ✅ | Hospital status (overview), Emergency board, ICU board, Planned admissions, Ward board (round times), LIMS monitoring (shows the 2 reports issued above), Admissions bed board, Dashboard. Menus per role show both sides' modules (e.g. TPA desk: Insurance claims + Planned admissions + Post-discharge). |

### 5.5 API health probe (every GET route, 30 seeded roles)
Re-run with a 2-hour token lifetime on the local API: **all 32 role logins PASS**, **205 routes PASS**, the 5 scripted flows (patients, appointments + OPD queue, billing, admissions, integration key) **all steps PASS**, website/gateway checks **21/21 PASS**. The few non-passes are by design: 74 routes skipped (no sample record of that kind in the demo data), 4 need query parameters, `/notifications/stream` is a live stream that never ends (times out by nature), 7 `/patient-portal/*` routes refuse staff logins (patient app only), `/booking/patients` needs an integration key, and the sample admission has no discharge summary to print (404).

## 6. The required discharge stages ↔ what the merged system does
| Stage | Responsible | In the merged system |
|---|---|---|
| Discharge decision | Treating doctor | *Clear* button (doctor); nothing else starts before it |
| Summary preparation | RMO / treating team | Draft (RMO) → signed (consultant) → verified (RMO, not the signer) |
| Nursing clearance | Ward nurse | Medication, documentation, handover checks + *Clear* |
| Pharmacy | Inpatient pharmacist | Issues, returns, eligible credits reconciled + *Clear* |
| Laboratory / radiology | Departments | Reconciles itself (cashier-billed tests **and** R's LIMS tests, see 4.3) |
| OT / procedure | OT coordinator | Reconciles itself from procedures, implants, consumables |
| Insurance | TPA desk + payer | Reconciles itself from the claim (documents + authorisation) |
| Final billing | IP billing | Final bill, deposits, credit notes, patient liability (bill − insurer share) |
| Financial release | Billing / finance | Automatic when settled, or an authorised exception with a reason |
| Physical exit | Ward nurse / transport | *Confirm departure* (mode, escort); the bed is freed here |
| Bed turnover | Housekeeping | Vacated → cleaning → ready, with turnaround time |
| Post-discharge | MRD, claims, finance | Record file received, ICD-10 coding, sign-off; claim and receivables tracked; retention rules |

## 7. Known limitations / notes
- **Nothing is committed.** The merge is staged on branch `merge-2-aftercare` (merge in progress, `MERGE_HEAD` set). Commit when you are happy: `git commit` (the message is pre-filled by git).
- The demo seed has **no supplier**; procurement needs one created first (*Pharmacy → Suppliers*). This was true on both sides before the merge.
- The *review consultation completes the after-care task* step could not be clicked today (the earliest free slot was tomorrow); it is covered by the passing `aftercare.spec.ts`.
- The emergency → admission, planned admission, ICU and ward-round flows were not re-walked by hand; they are covered by R's own API test files (all passing in 5.2) and the screens were checked.
- An API process from another folder (`medos-final-merged-code`) is running on port 4000 against `medos_dev`; it was not touched. The merged app runs on **3100/4100** against its own databases `medos_merge2` (demo), `medos_merge2_test` (tests) and `medos_e2e` (browser tests).
- `.local/merge-api.env`, `.local/merge-web.env`, `.local/merge-seed-password.txt` hold this machine's local settings (`.local` is git-ignored). Sign in at http://localhost:3100 with hospital code `demo-hospital` and the password in `.local/merge-seed-password.txt`.

## 8. How to run the merged app here
```
cd medos-rajarshee
pnpm install --frozen-lockfile --store-dir C:/Users/Rajarshree/AppData/Local/pnpm-store
pnpm --filter @medos/database build && pnpm --filter @medos/shared build && pnpm --filter @medos/api build
node --env-file=.local/merge-api.env apps/api/dist/main.js            # API on :4100
cd apps/web && node --env-file=../../.local/merge-web.env node_modules/next/dist/bin/next dev -p 3100   # web on :3100
```
(The `node_modules` that came with the folder were a flat copy from another folder; they were reinstalled from the unchanged lockfile.)

## 9. Files changed by the merge beyond the two sides' own code
- `apps/api/src/modules/discharge/lims-test-state.ts` (new), `discharge.service.ts`, `admission-tests.service.ts` — 4.3
- `apps/api/src/modules/lims/lims.spec.ts` — 2 regression tests for 4.3
- `apps/web/src/components/pharmacy-extras.tsx` — 4.5
- `apps/web/e2e/features.spec.ts` — 4.6
- `apps/api/src/modules/rounds/{procedures.service,rounds.controller,rounds.spec}.ts`, `apps/web/src/components/rounds.tsx`, `apps/web/src/app/(app)/ipd/[id]/page.tsx`, `apps/api/src/common/tenant-sweep.spec.ts` — 4.1
- `apps/api/src/cli/seed.ts`, `docs/aftercare.md` — 4.2
- `docs/discharge-stages.md`, `docs/ward-rounds.md`, `docs/api-routes.md` (regenerated)
