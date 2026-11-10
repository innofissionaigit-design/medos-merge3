export const PERMISSIONS = [
  "PATIENT_READ", "PATIENT_CREATE", "PATIENT_UPDATE", "DUPLICATE_OVERRIDE",
  "APPOINTMENT_READ", "APPOINTMENT_CREATE", "APPOINTMENT_UPDATE", "APPOINTMENT_CANCEL", "APPOINTMENT_OVERBOOK",
  // Book a follow-up from one's own consultation only (not general appointments).
  "FOLLOWUP_SCHEDULE",
  "QUEUE_READ", "QUEUE_MANAGE",
  // Change a waiting patient's priority or mark an emergency: reception for any queue, a doctor for their own.
  "QUEUE_PRIORITY",
  "CONSULTATION_READ", "CONSULTATION_CREATE", "CONSULTATION_SIGN", "CONSULTATION_AMEND",
  "VITALS_READ", "VITALS_CREATE", "ALLERGY_WRITE",
  "PRESCRIPTION_READ", "PRESCRIPTION_CREATE", "PRESCRIPTION_SIGN",
  "INVOICE_READ", "INVOICE_CREATE", "INVOICE_ISSUE", "INVOICE_DISCOUNT", "INVOICE_CANCEL", "INVOICE_ADJUST",
  "PAYMENT_CREATE", "PAYMENT_REFUND", "CASHIER_SHIFT_MANAGE",
  "PHARMACY_READ", "PHARMACY_DISPENSE", "PHARMACY_PURCHASE", "PHARMACY_ADJUST_STOCK", "PHARMACY_MASTERS",
  "ADMISSION_READ", "ADMISSION_CREATE", "ADMISSION_TRANSFER", "ADMISSION_DISCHARGE", "CHARGE_CREATE",
  "NURSING_READ", "NURSING_DOCUMENT", "NURSING_MEDICATION_ADMINISTER",
  // REPORT_READ grants every report; each REPORT_<AREA> grants that area's reports only.
  "REPORT_READ", "REPORT_OPD", "REPORT_FINANCE", "REPORT_IPD", "REPORT_PHARMACY",
  "ADMIN_USERS", "ADMIN_MASTERS", "ADMIN_SETTINGS", "AUDIT_READ",
  // Privacy: handle patients' data requests (recording consent only needs PATIENT_UPDATE).
  "PRIVACY_MANAGE",
  // Bulk import of patients, medicines, opening stock and the service price list from CSV (go-live and data migration).
  "DATA_IMPORT",
  // Link a duplicate patient record to the real one (docs/patient-merge.md).
  "PATIENT_MERGE",
  // Skip the booking fee of an appointment in a special case (docs/booking-fee.md).
  "BOOKING_FEE_SKIP",
  // Create and revoke API keys for outside systems and bots (docs/integration-api.md).
  "ADMIN_INTEGRATIONS",
  // For API clients (docs/integration-api.md): find a patient by mobile number with minimal details, and register a new patient, for booking only.
  "BOOKING_PATIENT_LOOKUP", "BOOKING_PATIENT_REGISTER",
  // Doctors: see only their own bookings and earnings (docs/earnings-and-reports.md).
  "REPORT_MY_PRACTICE",
  // Set how the amount collected for consultations is split between the hospital and each doctor.
  "EARNINGS_CONFIGURE",
  // Upload a handwritten prescription for a visit and review what OCR read from it (docs/prescriptions.md).
  "PRESCRIPTION_SCAN",
  // Give a patient a link to their signed prescription (docs/prescriptions.md).
  "PRESCRIPTION_SHARE",
  // Register a patient without paying the registration fee (with a listed reason; audited and reported).
  "REGISTRATION_FEE_EXEMPT",
  // Raise the final bill of an admission (billing staff and administrators; Reception collects payments but does not raise IPD bills).
  "IPD_FINAL_BILL",
  // See every department, doctor, patient, record and report of the organisation. Without it, a doctor sees only their own patients and a user assigned to departments sees only those departments (docs/data-access.md).
  "DATA_SCOPE_ALL",
  // Bill the tests the doctor advised (laboratory, imaging, cardiology, procedures), from the Cashier's queue (docs/test-orders.md).
  "TEST_BILL",
  // Email (docs/email.md): set up templates, the suppression list and test sends, and retry or cancel queued emails; read the delivery log. Whether email is on is the ADMIN_SETTINGS setting EMAIL_ENABLED.
  "EMAIL_MANAGE", "EMAIL_LOG_READ",
  // Laboratory (docs/lims.md): see the work list and results; take samples; type in results; verify and amend reports; set up the tests and their ranges.
  "LAB_READ", "LAB_COLLECT", "LAB_RESULT", "LAB_VERIFY", "LAB_MASTERS",
  // Radiology (docs/radiology.md): see studies and reports; perform a study; report and sign (and amend) it.
  "RAD_READ", "RAD_PERFORM", "RAD_REPORT",
  // LIMS portal (docs/lims-portal.md). LIMS_READ: see the LIMS queues for the departments one may read. LIMS_REPORTS: performance, workload and turnaround reports.
  // LIMS_ORDER: a doctor orders laboratory or imaging tests for a patient (IPD tests go straight to the lab). LIMS_REQUEST: reception launches an OPD test request once the patient agrees, and hands reports over.
  // LIMS_PRIORITY: mark a request urgent or emergency. LIMS_COLLECT: the nurse records the sample taken (or the patient made ready for a scan). LIMS_ASSIGN: assign nurses and technicians.
  // LIMS_ISSUE: the technician issues a report the pathologist or radiologist has passed. LIMS_QC: record quality-control runs. LIMS_MANAGE: the LIMS manager reviews QC, approves exceptions and keeps instruments.
  // LIMS_DEPARTMENTS: the administrator keeps the laboratory departments.
  "LIMS_READ", "LIMS_REPORTS", "LIMS_ORDER", "LIMS_REQUEST", "LIMS_PRIORITY", "LIMS_COLLECT", "LIMS_ASSIGN", "LIMS_ISSUE", "LIMS_QC", "LIMS_MANAGE", "LIMS_DEPARTMENTS",
  // Insurance claims (docs/claims.md): see claims; manage policies and move claims through their steps; record money received from the insurer; set up insurers.
  "CLAIM_READ", "CLAIM_MANAGE", "CLAIM_SETTLE", "CLAIM_MASTERS",
  // Payroll (docs/payroll.md): see salary data; keep employees, pay structures and draft runs; approve a run made by someone else and mark it paid.
  "PAYROLL_READ", "PAYROLL_MANAGE", "PAYROLL_APPROVE",
  // Attendance and leave (docs/payroll.md): mark and correct daily attendance and record leave for anyone; approve or reject leave (never your own).
  "ATTENDANCE_MANAGE", "LEAVE_APPROVE",
  // Telemedicine (docs/telemedicine.md): see video consultations; make an appointment a video consultation or cancel one; join and end a call as the doctor.
  "TELE_READ", "TELE_MANAGE", "TELE_CONDUCT",
  // AI assistant (docs/ai-assistant.md): ask for a draft summary or advice on a visit you are treating; connect the hospital's own AI provider.
  "AI_USE", "AI_CONFIGURE",
  // Emergency ward (docs/emergency.md). ER_READ: see the emergency board and a case (a doctor sees only the cases called to them). ER_REGISTER: the emergency desk registers an arriving patient and calls the doctor.
  // ER_TRIAGE: the emergency nurse records the triage record. ER_TREAT: the doctor accepts the patient, writes the assessment and decides where the patient goes (OT, ICU or home).
  // ER_BILL: the emergency desk issues the emergency bill and adds a charge to it (taking the payment itself needs PAYMENT_CREATE).
  "ER_READ", "ER_REGISTER", "ER_TRIAGE", "ER_TREAT", "ER_BILL",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const SYSTEM_ROLES: Record<string, readonly Permission[]> = {
  ADMINISTRATOR: ["ER_READ", "LIMS_READ", "LIMS_REPORTS", "LIMS_DEPARTMENTS", "EMAIL_MANAGE", "EMAIL_LOG_READ", "LEAVE_APPROVE", "AI_CONFIGURE", "TELE_READ", "TELE_MANAGE", "PAYROLL_READ", "PAYROLL_APPROVE", "CLAIM_READ", "CLAIM_MASTERS", "RAD_READ", "LAB_READ", "LAB_MASTERS", "DATA_SCOPE_ALL", "IPD_FINAL_BILL", "REGISTRATION_FEE_EXEMPT", "EARNINGS_CONFIGURE", "ADMIN_INTEGRATIONS", "BOOKING_FEE_SKIP", "PATIENT_MERGE", "DATA_IMPORT", "PRIVACY_MANAGE", "PHARMACY_MASTERS", "ADMIN_USERS", "ADMIN_MASTERS", "ADMIN_SETTINGS", "AUDIT_READ", "REPORT_READ", "PATIENT_READ", "APPOINTMENT_READ", "QUEUE_READ", "INVOICE_READ", "PHARMACY_READ", "ADMISSION_READ"],
  // Reception settles booking fees at the desk: takes the fee (with its own cash shift) or skips it with a reason (docs/booking-fee.md).
  RECEPTIONIST: ["LIMS_READ", "LIMS_REQUEST", "LIMS_PRIORITY", "TELE_READ", "TELE_MANAGE", "CLAIM_READ", "INVOICE_ISSUE", "REGISTRATION_FEE_EXEMPT", "PRESCRIPTION_SHARE", "PAYMENT_CREATE", "CASHIER_SHIFT_MANAGE", "BOOKING_FEE_SKIP", "CHARGE_CREATE", "ADMISSION_TRANSFER", "PATIENT_READ", "PATIENT_CREATE", "PATIENT_UPDATE", "DUPLICATE_OVERRIDE", "APPOINTMENT_READ", "APPOINTMENT_CREATE", "APPOINTMENT_UPDATE", "APPOINTMENT_CANCEL", "QUEUE_READ", "QUEUE_MANAGE", "QUEUE_PRIORITY", "ADMISSION_READ", "ADMISSION_CREATE", "INVOICE_READ", "INVOICE_CREATE", "REPORT_OPD", "REPORT_IPD"],
  DOCTOR: ["ER_READ", "ER_TREAT", "LIMS_READ", "LIMS_ORDER", "LIMS_PRIORITY", "AI_USE", "TELE_READ", "TELE_CONDUCT", "RAD_READ", "LAB_READ", "REPORT_MY_PRACTICE", "PRESCRIPTION_SCAN", "PRESCRIPTION_SHARE", "CHARGE_CREATE", "PATIENT_READ", "APPOINTMENT_READ", "QUEUE_READ", "QUEUE_PRIORITY", "CONSULTATION_READ", "CONSULTATION_CREATE", "CONSULTATION_SIGN", "CONSULTATION_AMEND", "VITALS_READ", "VITALS_CREATE", "ALLERGY_WRITE", "PRESCRIPTION_READ", "PRESCRIPTION_CREATE", "PRESCRIPTION_SIGN", "ADMISSION_READ", "ADMISSION_DISCHARGE", "NURSING_READ", "REPORT_OPD", "REPORT_IPD", "FOLLOWUP_SCHEDULE"],
  NURSE: ["LIMS_READ", "LIMS_COLLECT", "RAD_READ", "LAB_READ", "LAB_COLLECT", "CHARGE_CREATE", "ADMISSION_TRANSFER", "PATIENT_READ", "VITALS_READ", "VITALS_CREATE", "ALLERGY_WRITE", "NURSING_READ", "NURSING_DOCUMENT", "NURSING_MEDICATION_ADMINISTER", "ADMISSION_READ", "PRESCRIPTION_READ", "QUEUE_READ", "REPORT_IPD"],
  // The emergency ward (docs/emergency.md). The emergency nurse is an ordinary nurse who also keeps the emergency triage record. The emergency receptionist handles emergency arrivals only:
  // no appointments, no OPD queue; registers the patient, calls the doctor, and issues and collects the emergency bill.
  EMERGENCY_NURSE: ["ER_READ", "ER_TRIAGE", "LIMS_READ", "LIMS_COLLECT", "RAD_READ", "LAB_READ", "LAB_COLLECT", "CHARGE_CREATE", "ADMISSION_TRANSFER", "PATIENT_READ", "VITALS_READ", "VITALS_CREATE", "ALLERGY_WRITE", "NURSING_READ", "NURSING_DOCUMENT", "NURSING_MEDICATION_ADMINISTER", "ADMISSION_READ", "PRESCRIPTION_READ", "QUEUE_READ", "REPORT_IPD"],
  EMERGENCY_RECEPTIONIST: ["ER_READ", "ER_REGISTER", "ER_BILL", "PATIENT_READ", "PATIENT_CREATE", "PATIENT_UPDATE", "DUPLICATE_OVERRIDE", "REGISTRATION_FEE_EXEMPT", "INVOICE_READ", "PAYMENT_CREATE", "CASHIER_SHIFT_MANAGE"],
  PHARMACIST: ["ADMISSION_READ", "PATIENT_READ", "PRESCRIPTION_READ", "PHARMACY_READ", "PHARMACY_DISPENSE", "PHARMACY_PURCHASE", "PHARMACY_ADJUST_STOCK", "PHARMACY_MASTERS", "INVOICE_READ", "REPORT_PHARMACY"],
  // APPOINTMENT_READ: the Cashier takes the booking fee (docs/booking-fee.md) from the Appointments list, so it has to be able to open it. Read only: booking, changing and checking in stay with reception.
  CASHIER: ["APPOINTMENT_READ", "CLAIM_READ", "TEST_BILL", "IPD_FINAL_BILL", "CHARGE_CREATE", "ADMISSION_READ", "PATIENT_READ", "INVOICE_READ", "INVOICE_CREATE", "INVOICE_ISSUE", "PAYMENT_CREATE", "PAYMENT_REFUND", "CASHIER_SHIFT_MANAGE", "REPORT_FINANCE"],
  MANAGER: ["ER_READ", "LIMS_READ", "LIMS_REPORTS", "TELE_READ", "CLAIM_READ", "RAD_READ", "LAB_READ", "REGISTRATION_FEE_EXEMPT", "BOOKING_FEE_SKIP", "REPORT_READ", "PATIENT_READ", "INVOICE_READ", "INVOICE_DISCOUNT", "INVOICE_CANCEL", "INVOICE_ADJUST", "PHARMACY_READ", "ADMISSION_READ", "AUDIT_READ"],
  // The laboratory (docs/lims.md): the technician takes samples and types in results; the pathologist verifies reports and sets up the tests.
  LAB_TECHNICIAN: ["LAB_READ", "LAB_COLLECT", "LAB_RESULT", "PATIENT_READ"],
  PATHOLOGIST: ["LIMS_READ", "LAB_READ", "LAB_RESULT", "LAB_VERIFY", "LAB_MASTERS", "PATIENT_READ"],
  // Radiology (docs/radiology.md): the radiographer performs studies; the radiologist reports and signs them.
  RADIOGRAPHER: ["RAD_READ", "RAD_PERFORM", "PATIENT_READ"],
  RADIOLOGIST: ["LIMS_READ", "RAD_READ", "RAD_REPORT", "PATIENT_READ"],
  // The LIMS portal (docs/lims-portal.md). The LIMS manager runs the laboratory floor but has no LAB_VERIFY or RAD_REPORT: clinical results are passed only by a pathologist
  // or radiologist (a hospital may give a qualified manager those permissions through a custom role). The two technicians prepare reports and issue them once passed.
  LIMS_MANAGER: ["LIMS_READ", "LIMS_REPORTS", "LIMS_ASSIGN", "LIMS_PRIORITY", "LIMS_MANAGE", "LIMS_QC", "LAB_READ", "RAD_READ", "PATIENT_READ"],
  P_LAB_TECH: ["LIMS_READ", "LIMS_ISSUE", "LIMS_QC", "LAB_READ", "LAB_RESULT", "PATIENT_READ"],
  R_LAB_TECH: ["LIMS_READ", "LIMS_ISSUE", "LIMS_QC", "RAD_READ", "RAD_PERFORM", "PATIENT_READ"],
  // Insurance claims (docs/claims.md): the claims officer runs claims from policy to settlement.
  CLAIMS_OFFICER: ["CLAIM_READ", "CLAIM_MANAGE", "CLAIM_SETTLE", "CLAIM_MASTERS", "PATIENT_READ", "INVOICE_READ"],
  // Payroll (docs/payroll.md): prepares the monthly run; someone else (the administrator) approves it.
  PAYROLL_OFFICER: ["PAYROLL_READ", "PAYROLL_MANAGE", "ATTENDANCE_MANAGE"],
};
