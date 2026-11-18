# Flow trace (one browser tab, step by step)

Date 13 Nov 2026 · App http://localhost:3100 · One tab; profiles switched by Sign out / Sign in. I advance only when told "move".

## Pipeline 1: OPD patient journey

### Step 1: Reception registers a new patient
* **Who:** reception1 (Reception One), hospital code demo-hospital
* **Where:** Patients → Register patient
* **Entered:** Meera Tracewell, female, mobile 9830417265, age 34, 12 Lake Road, Kolkata, 700029 (5 fields plus address)
* **Result:** patient created at once, opened on her own page. **MRN DEMO-001105**, "female, 34 y (est.)".
* **Page shows:** buttons Start OPD visit, New bill, Admit, Edit details, Print label, Label PDF; Allergies "none recorded"; Advance payments "No advance taken" with a Take an advance button; Account statement (ledger).
* **Patient id:** bb539f06-6a7e-4c4b-a8c0-6b8ea1bb52d0
* **Verdict:** works. No duplicate warning (new name and mobile).

*(waiting for "move")*
