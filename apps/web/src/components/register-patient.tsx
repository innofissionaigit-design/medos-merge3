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
  const { register, handleSubmit, watch, formState: { errors, isSubmitting }, getValues } = useForm<Form>({ resolver: zodResolver(patientFormSchema), mode: "onTouched", defaultValues: { gender: "FEMALE", ageMode: "age", firstName: "", lastName: "", mobile: "", age: "", dob: "", email: "", addressLine: "", city: "", postalCode: "" } });
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
  return (
    <Modal title={title} onClose={onClose} wide>
      <form onSubmit={handleSubmit((v) => save(v))} className="grid grid-cols-1 gap-3 sm:grid-cols-2" noValidate>
        <Field label="First name" hint="Required" error={errors.firstName?.message}><Input autoFocus autoComplete="off" maxLength={60} {...register("firstName")} /></Field>
        <Field label="Last name" error={errors.lastName?.message}><Input autoComplete="off" maxLength={60} {...register("lastName")} /></Field>
        <Field label="Gender" error={errors.gender?.message}><Select {...register("gender")}><option value="FEMALE">Female</option><option value="MALE">Male</option><option value="OTHER">Other</option><option value="UNKNOWN">Unknown</option></Select></Field>
        <Field label="Mobile" hint="Required: 10-digit Indian number" error={errors.mobile?.message}><Input inputMode="tel" autoComplete="off" maxLength={16} {...register("mobile")} /></Field>
        <Field label="Email (optional)" hint="Used only if the patient agrees to be emailed" error={errors.email?.message}><Input type="email" autoComplete="off" {...register("email")} /></Field>
        <div>
          <div className="mb-1 flex gap-3 text-sm font-medium text-slate-700">
            <label className="flex items-center gap-1"><input type="radio" value="age" {...register("ageMode")} /> Age</label>
            <label className="flex items-center gap-1"><input type="radio" value="dob" {...register("ageMode")} /> Date of birth</label>
          </div>
          {mode === "age" ? <Input inputMode="numeric" placeholder="Years" aria-label="Age in years" maxLength={3} {...register("age")} /> : <Input type="date" aria-label="Date of birth" max={new Date().toLocaleDateString("en-CA")} {...register("dob")} />}
          {(errors.age || errors.dob) && <span className="mt-1 block text-xs text-red-600" role="alert">{errors.age?.message ?? errors.dob?.message}</span>}
        </div>
        <Field label="Address" error={errors.addressLine?.message}><Input maxLength={200} {...register("addressLine")} /></Field>
        <Field label="City" error={errors.city?.message}><Input maxLength={80} {...register("city")} /></Field>
        <Field label="PIN code" error={errors.postalCode?.message}><Input inputMode="numeric" maxLength={6} {...register("postalCode")} /></Field>
        {feeOn && fee.data && feeChoice && <div className="sm:col-span-2"><FeeSection config={fee.data} value={feeChoice} onChange={setChoice} /></div>}
        <div className="sm:col-span-2">
          <ErrorNote error={error instanceof ApiError && error.code === "SHIFT_NOT_OPEN" ? null : error} />
          {error instanceof ApiError && error.code === "SHIFT_NOT_OPEN" && (
            <div className="space-y-1"><Notice tone="warn">Open your cash shift before taking cash.</Notice>{can("CASHIER_SHIFT_MANAGE") && <Button variant="secondary" loading={openShift.isPending} onClick={() => openShift.mutate()}>Open my cash shift (₹0 opening) and register</Button>}</div>
          )}
          {problem && <p className="text-xs text-slate-500">{problem}</p>}
        </div>
        <div className="flex justify-end gap-2 sm:col-span-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" loading={isSubmitting || busy} disabled={problem !== null}>{feeOn && feeChoice ? (feeChoice.kind === "PAY" ? "Collect fee and register" : "Register without fee") : "Register"}</Button></div>
      </form>
    </Modal>
  );
}
