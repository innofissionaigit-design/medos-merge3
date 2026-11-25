"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { FeeSection, feePayload, feeProblem, initialChoice, RegistrationDone, type FeeChoice, type FeeConfig, type RegistrationResult } from "./registration-fee";
import { patientName, type PatientRow } from "./shell";
import { Button, ErrorNote, Field, Input, Modal, Notice, Select, Table, Td } from "./ui";
import { api, ApiError, newKey } from "@/lib/api";
import { ageText } from "@/lib/format";
import { patientFormSchema, type PatientForm } from "@/lib/patient-form";
import { useMe } from "@/lib/me";

type Form = PatientForm;
// No gender is pre-selected: a desk in a hurry must choose one, so a wrong default never reaches the record (the form check says "Choose the gender").
const EMPTY_FORM: Form = { gender: "" as unknown as Form["gender"], ageMode: "age", firstName: "", lastName: "", mobile: "", age: "", dob: "", email: "", addressLine: "", city: "", postalCode: "" };

interface Candidate { patient: PatientRow; severity: string; reasons: string[]; similarity: number }

/** The patient chosen at the end: newly registered, or an existing patient picked from the possible duplicates. */
export interface ChosenPatient { id: string; mrn: string | null; name: string }

/**
 * Registers a new patient: duplicate check, registration fee, and the Patient ID. Used on the Patients page (opens the new record) and at the lab desk
 * ("Register test for new patient", which hands the patient back to the test booking through `onRegistered`).
 */
export function RegisterPatient({ onClose, onRegistered, title = "Register new patient" }: { onClose: () => void; onRegistered?: (p: ChosenPatient) => void; title?: string }) {
  const router = useRouter();
  const { can } = useMe();
  const { register, handleSubmit, watch, reset, formState: { errors, isSubmitting, isDirty }, getValues } = useForm<Form>({ resolver: zodResolver(patientFormSchema), mode: "onTouched", defaultValues: EMPTY_FORM });
  const [error, setError] = useState<unknown>(null);
  const [dups, setDups] = useState<Candidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(newKey);
  const mode = watch("ageMode");
  // The registration fee is collected in the same step as the registration: the Patient ID is issued only once it is paid (or exempted by someone allowed to).
  const fee = useQuery({ queryKey: ["reg-fee-config"], queryFn: () => api.get<FeeConfig>("/patients/registration-fee/config") });
  const [choice, setChoice] = useState<FeeChoice | null>(null);
  const [done, setDone] = useState<{ id: string; mrn: string | null; name: string; registration: RegistrationResult | null } | null>(null);
  const feeOn = fee.data?.enabled === true;
  const feeChoice = choice ?? (fee.data ? initialChoice(fee.data) : null);
  const problem = feeOn && fee.data && feeChoice ? feeProblem(fee.data, feeChoice) : null;
  const openShift = useMutation({ mutationFn: () => api.post("/shifts/open", { openingCash: "0" }), onSuccess: () => { setError(null); void save(getValues()); } });
  /** Where the patient goes next: back to the caller, or to the patient's record. */
  /** Clears everything typed (and any message, and a changed fee choice) so the next patient starts from a blank form. */
  const clearAll = () => { reset(EMPTY_FORM); setError(null); setChoice(null); };
  const finish = (p: ChosenPatient) => (onRegistered ? onRegistered(p) : router.push(`/patients/${p.id}`));

  const body = (v: Form, override: boolean) => ({
    firstName: v.firstName, ...(v.lastName ? { lastName: v.lastName } : {}), gender: v.gender,
    ...(v.ageMode === "age" ? { estimatedAgeYears: Number(v.age) } : { dateOfBirth: v.dob }),
    ...(v.mobile ? { mobile: v.mobile } : {}), ...(v.email ? { email: v.email } : {}), ...(v.addressLine ? { addressLine: v.addressLine } : {}), ...(v.city ? { city: v.city } : {}), ...(v.postalCode ? { postalCode: v.postalCode } : {}),
    ...(override ? { duplicateOverride: { confirmedDistinct: true, reason: "Confirmed as a different person at registration" } } : {}),
    ...(feeOn && feeChoice ? { registration: feePayload(feeChoice) } : {}),
  });
  async function save(v: Form, override = false) {
    setError(null); setBusy(true);
    try {
      const p = await api.post<{ id: string; mrn: string | null; registration: RegistrationResult | null }>("/patients", body(v, override), override ? newKey() : key);
      const name = [v.firstName.trim(), v.lastName?.trim()].filter(Boolean).join(" ");
      if (p.registration) setDone({ id: p.id, mrn: p.mrn, name, registration: p.registration });
      else finish({ id: p.id, mrn: p.mrn, name });
    } catch (e) {
      if (e instanceof ApiError && e.code === "DUPLICATE_PATIENT_SUSPECTED") setDups(((e.details as { candidates?: Candidate[] } | undefined)?.candidates) ?? []);
      else setError(e);
    } finally { setBusy(false); }
  }

  if (done) {
    const next = () => finish({ id: done.id, mrn: done.mrn, name: done.name });
    return (
      <Modal title="Patient registered" onClose={next}>
        <div className="space-y-3">
          <RegistrationDone mrn={done.mrn} reg={done.registration} />
          <div className="flex justify-end"><Button onClick={next}>{onRegistered ? "Continue" : "Open the patient"}</Button></div>
        </div>
      </Modal>
    );
  }
  if (dups) {
    return (
      <Modal title="This patient may already be registered" onClose={onClose} wide>
        <div className="space-y-3">
          <Notice tone="warn">Please check these existing patients before creating a new record.</Notice>
          <Table head={["Patient", "MRN", "Mobile", "Match", ""]}>
            {dups.map((d) => (
              <tr key={d.patient.id}>
                <Td>{patientName(d.patient)} <span className="text-slate-500">· {d.patient.gender.toLowerCase()}{ageText(d.patient.age) ? `, ${ageText(d.patient.age)}` : ""}</span></Td>
                <Td>{d.patient.mrn}</Td><Td>{d.patient.mobile ?? "—"}</Td>
                <Td><span className="text-xs text-slate-600">{d.reasons.join(", ").replace(/_/g, " ").toLowerCase()}</span></Td>
                <Td><Button variant="secondary" onClick={() => finish({ id: d.patient.id, mrn: d.patient.mrn, name: patientName(d.patient) })}>Use this patient</Button></Td>
              </tr>
            ))}
          </Table>
          <ErrorNote error={error} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDups(null)}>Back</Button>
            {can("DUPLICATE_OVERRIDE")
              ? <Button loading={busy} onClick={() => save(getValues(), true)}>This is a different person — register</Button>
              : <span className="self-center text-sm text-slate-500">Ask a supervisor to register despite a possible duplicate.</span>}
          </div>
        </div>
      </Modal>
    );
  }
  const GENDERS: [string, string][] = [["MALE", "Male"], ["FEMALE", "Female"], ["OTHER", "Other"], ["UNKNOWN", "Unknown"]];
  const pill = "block cursor-pointer select-none whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 py-1.5 text-center text-sm font-medium text-slate-600 transition hover:bg-slate-50 peer-checked:border-brand-600 peer-checked:bg-brand-50 peer-checked:text-brand-700 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500";
  const section = (n: string, title: string, hint?: string) => (
    <div className="flex items-center gap-2.5 sm:col-span-2">
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white" aria-hidden>{n}</span>
      <span className="text-sm font-semibold text-slate-800">{title}</span>
      {hint && <span className="text-xs text-slate-500">{hint}</span>}
      <span className="h-px flex-1 bg-slate-100" aria-hidden />
    </div>
  );
  return (
    <Modal title={title} onClose={onClose} wide>
      <form onSubmit={handleSubmit((v) => save(v))} className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2" noValidate>
        {section("1", "Patient", "Name, gender and age")}
        <Field label="First name *" error={errors.firstName?.message}><Input autoFocus autoComplete="off" maxLength={60} placeholder="e.g. Anjali" {...register("firstName")} /></Field>
        <Field label="Last name" error={errors.lastName?.message}><Input autoComplete="off" maxLength={60} placeholder="e.g. Sen" {...register("lastName")} /></Field>
        <div>
          <span className="mb-1 block text-sm font-medium text-slate-700">Gender</span>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Gender">
            {GENDERS.map(([v, label]) => <label key={v} className="block"><input type="radio" value={v} className="peer sr-only" {...register("gender")} /><span className={pill}>{label}</span></label>)}
          </div>
          {errors.gender?.message && <span className="mt-1 block text-xs text-red-600" role="alert">{errors.gender.message}</span>}
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-sm font-medium text-slate-700">{mode === "age" ? "Age" : "Date of birth"}</span>
            <div className="inline-flex rounded-md bg-slate-100 p-0.5 text-xs font-medium" role="radiogroup" aria-label="Enter age or date of birth">
              <label><input type="radio" value="age" className="peer sr-only" {...register("ageMode")} /><span className="block cursor-pointer rounded px-2.5 py-0.5 text-slate-600 peer-checked:bg-white peer-checked:text-brand-700 peer-checked:shadow-sm peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500">Age</span></label>
              <label><input type="radio" value="dob" className="peer sr-only" {...register("ageMode")} /><span className="block cursor-pointer rounded px-2.5 py-0.5 text-slate-600 peer-checked:bg-white peer-checked:text-brand-700 peer-checked:shadow-sm peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500">Date of birth</span></label>
            </div>
          </div>
          {mode === "age" ? <Input inputMode="numeric" placeholder="Years" aria-label="Age in years" maxLength={3} {...register("age")} /> : <Input type="date" aria-label="Date of birth" max={new Date().toLocaleDateString("en-CA")} {...register("dob")} />}
          {(errors.age || errors.dob) && <span className="mt-1 block text-xs text-red-600" role="alert">{errors.age?.message ?? errors.dob?.message}</span>}
        </div>

        {section("2", "Contact")}
        <Field label="Mobile *" hint="10-digit Indian number" error={errors.mobile?.message}>
          <div className="flex">
            <span className="flex items-center rounded-l-md border border-r-0 border-slate-300 bg-slate-50 px-3 text-sm text-slate-500" aria-hidden>+91</span>
            <Input inputMode="tel" autoComplete="off" maxLength={16} className="rounded-l-none" placeholder="98300 00000" {...register("mobile")} />
          </div>
        </Field>
        <Field label="Email (optional)" hint="Used only if the patient agrees to be emailed" error={errors.email?.message}><Input type="email" autoComplete="off" placeholder="name@example.com" {...register("email")} /></Field>

        {section("3", "Address", "Optional")}
        <div className="sm:col-span-2"><Field label="Address" error={errors.addressLine?.message}><Input maxLength={200} placeholder="House, street, area" {...register("addressLine")} /></Field></div>
        <Field label="City" error={errors.city?.message}><Input maxLength={80} {...register("city")} /></Field>
        <Field label="PIN code" error={errors.postalCode?.message}><Input inputMode="numeric" maxLength={6} placeholder="6 digits" {...register("postalCode")} /></Field>

        {feeOn && fee.data && feeChoice && <><div className="sm:col-span-2">{section("4", "Registration fee")}</div><div className="sm:col-span-2"><FeeSection config={fee.data} value={feeChoice} onChange={setChoice} /></div></>}
        <div className="sm:col-span-2">
          <ErrorNote error={error instanceof ApiError && error.code === "SHIFT_NOT_OPEN" ? null : error} />
          {error instanceof ApiError && error.code === "SHIFT_NOT_OPEN" && (
            <div className="space-y-1"><Notice tone="warn">Open your cash shift before taking cash.</Notice>{can("CASHIER_SHIFT_MANAGE") && <Button variant="secondary" loading={openShift.isPending} onClick={() => openShift.mutate()}>Open my cash shift (₹0 opening) and register</Button>}</div>
          )}
          {problem && <p className="text-xs text-slate-500">{problem}</p>}
        </div>
        <div className="-mx-1 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-3 sm:col-span-2">
          <span className="text-xs text-slate-500">* Required. A possible duplicate is checked before the Patient ID is issued.</span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={clearAll} disabled={!isDirty && !error && !choice} className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-200/60 disabled:cursor-not-allowed disabled:opacity-40">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 12a8 8 0 1 0 2.600-5.900M4 4v4.500h4.500" /></svg>Reset
            </button>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={isSubmitting || busy} disabled={problem !== null}>{feeOn && feeChoice ? (feeChoice.kind === "PAY" ? "Collect fee and register" : "Register without fee") : "Register"}</Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
