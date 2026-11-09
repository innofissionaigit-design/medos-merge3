# ADR-014: The laboratory portal is a workflow layer over the existing laboratory and radiology modules, and it does not depend on billing

**Status:** Accepted.

## Context
MedOS already had a laboratory (samples, results, verification, amendments, critical values) and radiology (studies, signed reports, images), each gated on a *billed* test order. The hospital needs a laboratory information management view on top: who runs the floor (LIMS manager, two technicians, pathologist, radiologist, nurse, reception), an inpatient path with no consent step and an emergency priority, an outpatient path where reception launches the tests after the patient agrees, turnaround monitoring, quality control, and messages to the patient. Billing will be designed next and must not block clinical work. Consultations in MedOS are OPD only, so an admitted patient's doctor had no way to order a test.

## Decision
1. **A `LimsRequest` per test order**, with its own states, priority, due time, assignments and append-only history. Clinical records stay in `LabSample`, `LabResult`, `RadStudy` and their report versions; nothing clinical is copied.
2. **The existing laboratory and radiology services remain the single path** for samples, values and reports. They tell the LIMS inside their own transaction (`LimsCoreService`), so a request and its clinical record can never disagree, and the older screens obey the same order of steps for a request the LIMS manages. A test with no request behaves exactly as before.
3. **Billing is decoupled.** A request attaches to an order that is `ORDERED` or `BILLED`; database triggers were relaxed accordingly. The LIMS creates no invoice or charge. The cashier's existing flow still bills the test, and two guards stop the cashier from cancelling laboratory work. Where to add billing is written down in `docs/lims-portal.md`.
4. **Release is a separate step.** Passing (verify or sign) does not release a report; the technician issues it. A report not yet issued is hidden from the doctor, the patient app and the printed summary. Critical values still alert the doctor when passed.
5. **Direct ordering** (`POST /lims/orders`, `LIMS_ORDER`) gives doctors a way to order for admitted patients. Admitted patients' tests go straight into the queue (consent not required); outpatients' tests wait at reception until launched with a recorded agreement.
6. **Permission-based roles**, with the manager roles deliberately lacking `LAB_VERIFY`, `RAD_REPORT` and the technician permissions. Segregation is enforced in the API, not in the screens.
7. **Messages to patients** use the existing message provider and email outbox, name the department and never a test or a result, and are retried by the existing outbound worker.

## Alternatives considered
* **Rewrite laboratory and radiology inside a new module**: a large change to working, tested code and to the printed reports and the patient app, for no clinical gain.
* **Gate the laboratory on payment**: simple, but it would block emergencies and inpatients, and billing is not decided yet.
* **Keep release at verification**: fewer steps, but the technician's issue step is part of the hospital's process and gives reception a clear point to tell the outpatient.
* **A second ordering path for outpatients**: unnecessary; the consultation already creates the test orders and reception launches them.

## Consequences
* The laboratory is a page of the main app (no separate portal or sign-in); access is role based only.
* Three roles and eleven permissions were added; the migration adds them to existing hospitals.
* An outpatient's report reaches the doctor and the patient only after the technician issues it. Staff who work on a report see it earlier.
* When billing is added it can hook into `LimsService.order`, `launch`, `collect` and `issue` without touching the clinical modules.
