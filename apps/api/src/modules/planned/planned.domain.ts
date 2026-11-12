import { Decimal } from "@medos/shared";

/** The steps of a planned admission (docs/planned-admission.md). Nothing else is allowed, and an admitted or closed request goes nowhere. */
export type PlannedStatus = "ADVISED" | "DOCTOR_REVIEW" | "AWAITING_PATIENT" | "DESK_REVIEW" | "TARIFF_PAYER" | "PREAUTH" | "DEPOSIT" | "BED_ALLOCATION" | "READY" | "ADMITTED" | "CLOSED";
export type PlannedStep =
  | "CONSENT" | "PATIENT_DECLINE" | "ASK_PATIENT" | "PATIENT_READY" | "ACCEPT" | "OTHER_TREATMENT" | "DOCTOR_DECLINE" | "VERIFY"
  | "TARIFF_DONE" | "PREAUTH_DONE" | "FINANCIAL_CLEARED" | "BED_ALLOCATED" | "ADMIT" | "NO_SHOW" | "CANCEL";

const NEXT: Record<PlannedStatus, Partial<Record<PlannedStep, PlannedStatus[]>>> = {
  ADVISED: { CONSENT: ["DESK_REVIEW"], PATIENT_DECLINE: ["CLOSED"], CANCEL: ["CLOSED"] },
  DOCTOR_REVIEW: { ASK_PATIENT: ["AWAITING_PATIENT"], ACCEPT: ["DESK_REVIEW"], OTHER_TREATMENT: ["CLOSED"], DOCTOR_DECLINE: ["CLOSED"], CANCEL: ["CLOSED"] },
  AWAITING_PATIENT: { PATIENT_READY: ["DOCTOR_REVIEW"], CANCEL: ["CLOSED"] },
  DESK_REVIEW: { VERIFY: ["TARIFF_PAYER"], CANCEL: ["CLOSED"] },
  TARIFF_PAYER: { TARIFF_DONE: ["PREAUTH", "DEPOSIT"], CANCEL: ["CLOSED"] },
  PREAUTH: { PREAUTH_DONE: ["DEPOSIT"], CANCEL: ["CLOSED"] },
  DEPOSIT: { FINANCIAL_CLEARED: ["BED_ALLOCATION"], CANCEL: ["CLOSED"] },
  BED_ALLOCATION: { BED_ALLOCATED: ["READY"], CANCEL: ["CLOSED"] },
  READY: { ADMIT: ["ADMITTED"], NO_SHOW: ["CLOSED"], CANCEL: ["CLOSED"] },
  ADMITTED: {},
  CLOSED: {},
};

export const FINISHED: PlannedStatus[] = ["ADMITTED", "CLOSED"];
export const isOpen = (s: PlannedStatus): boolean => !FINISHED.includes(s);

/** The status a step leads to from a status, or null when the step is not allowed there. `to` picks between the possible outcomes. */
export function nextStatus(from: PlannedStatus, step: PlannedStep, to?: PlannedStatus): PlannedStatus | null {
  const options = NEXT[from][step];
  if (!options) return null;
  if (to === undefined) return options.length === 1 ? options[0]! : null;
  return options.includes(to) ? to : null;
}

/** Who has the request in their hands in each status, in plain words for the lists. */
export const WAITING_FOR: Record<PlannedStatus, string> = {
  ADVISED: "Reception: the patient's consent",
  DOCTOR_REVIEW: "The doctor's review",
  AWAITING_PATIENT: "Reception: the patient to come or send reports",
  DESK_REVIEW: "Admission desk: verify the details",
  TARIFF_PAYER: "Billing and insurance: estimate and payer",
  PREAUTH: "Insurance: the insurer's pre-authorisation",
  DEPOSIT: "Billing: the deposit, or an approval",
  BED_ALLOCATION: "Bed management: hold a bed",
  READY: "Admission desk: admit the patient on the day",
  ADMITTED: "Admitted",
  CLOSED: "Closed",
};

/** The title of the nursing task made when the patient is admitted; the nurse completes it as the nursing admission assessment. */
export const NURSING_ASSESSMENT_TITLE = "Nursing admission assessment";

export interface EstimateLine { description: string; quantity: Decimal; unitPrice: Decimal }
/** The estimate: each line is quantity times price rounded to the paisa, and the total is their sum. */
export const lineAmount = (l: EstimateLine): Decimal => l.quantity.times(l.unitPrice).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
export const estimateTotal = (lines: EstimateLine[]): Decimal => lines.reduce((a, l) => a.plus(lineAmount(l)), new Decimal(0));

/** The deposit billing is advised to ask for when the insurer has approved part of the estimate: the rest. */
export const suggestedDeposit = (estimate: Decimal, insurerApproved: Decimal | null): Decimal => Decimal.max(new Decimal(0), estimate.minus(insurerApproved ?? 0));
