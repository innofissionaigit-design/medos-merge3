"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Gate } from "@/components/gate";
import { FeeSection, feePayload, feeProblem, initialChoice, RegistrationDone, type FeeChoice, type FeeConfig, type RegistrationResult } from "@/components/registration-fee";
import { patientName, type PatientRow } from "@/components/shell";
import { Icon, PANEL, useDeskKeys } from "@/components/desk-ui";
import { Button, ErrorNote, Field, Input, Modal, Notice, PageHeader, Select, Spinner, Table, Td, useDebounced } from "@/components/ui";
import { useT } from "@/lib/i18n";
import { api, ApiError, newKey } from "@/lib/api";
import { ageText } from "@/lib/format";
import { patientFormSchema, type PatientForm } from "@/lib/patient-form";
import { useMe } from "@/lib/me";

type Form = PatientForm;

interface Candidate { patient: PatientRow; severity: string; reasons: string[]; similarity: number }

function RegisterPatient({ onClose }: { onClose: () => void }) {
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
  const [done, setDone] = useState<{ id: string; mrn: string | null; registration: RegistrationResult | null } | null>(null);
  const feeOn = fee.data?.enabled === true;
  const feeChoice = choice ?? (fee.data ? initialChoice(fee.data) : null);
  const problem = feeOn && fee.data && feeChoice ? feeProblem(fee.data, feeChoice) : null;
  const openShift = useMutation({ mutationFn: () => api.post("/shifts/open", { openingCash: "0" }), onSuccess: () => { setError(null); void save(getValues()); } });

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
      if (p.registration) setDone({ id: p.id, mrn: p.mrn, registration: p.registration });
      else router.push(`/patients/${p.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === "DUPLICATE_PATIENT_SUSPECTED") setDups(((e.details as { candidates?: Candidate[] } | undefined)?.candidates) ?? []);
      else setError(e);
    } finally { setBusy(false); }
  }

  if (done) {
    return (
      <Modal title="Patient registered" onClose={() => router.push(`/patients/${done.id}`)}>
        <div className="space-y-3">
          <RegistrationDone mrn={done.mrn} reg={done.registration} />
          <div className="flex justify-end"><Button onClick={() => router.push(`/patients/${done.id}`)}>Open the patient</Button></div>
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
                <Td><Button variant="secondary" onClick={() => router.push(`/patients/${d.patient.id}`)}>Use this patient</Button></Td>
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
    <Modal title="Register new patient" onClose={onClose} wide>
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

const initials = (name: string): string => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
// A soft tint per patient (from the name), so rows are easy to tell apart at a glance.
const TINTS = ["bg-teal-50 text-teal-700", "bg-blue-50 text-blue-700", "bg-indigo-50 text-indigo-700", "bg-sky-50 text-sky-700", "bg-emerald-50 text-emerald-700"];
const tintOf = (name: string): string => TINTS[[...name].reduce((n, c) => n + c.charCodeAt(0), 0) % TINTS.length]!;

interface MineEntry { id: string; tokenNumber: number; patientName: string; mrn: string | null; patientId?: string; encounterId?: string | null; waitingMinutes: number | null }
interface MineView { current: MineEntry | null; waiting: MineEntry[]; completed: MineEntry[] }

/**
 * For a doctor, the Patients screen opens on their own patients of the day (who is with them now, who is waiting, who they have seen), so most of the time
 * nothing needs searching. It reads the same request as the doctor's dashboard.
 */
function MyPatientsToday() {
  const t = useT();
  const view = useQuery({ queryKey: ["doctor-view"], queryFn: () => api.get<MineView>("/queue/doctor"), refetchInterval: 20_000 });
  const d = view.data;
  const groups: { label: string; tone: string; rows: MineEntry[]; visit: boolean }[] = [
    { label: "With you now", tone: "bg-blue-100 text-blue-800", rows: d?.current ? [d.current] : [], visit: true },
    { label: "Waiting", tone: "bg-teal-50 text-teal-700", rows: d?.waiting ?? [], visit: false },
    { label: "Seen today", tone: "bg-emerald-50 text-emerald-700", rows: d?.completed ?? [], visit: true },
  ];
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  return (
    <section className={PANEL}>
      <header className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5"><h2 className="text-sm font-semibold text-slate-800">{t("My patients today")} <span className="ml-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">{total}</span></h2><Link href="/queue" className="text-sm font-medium text-brand-600 hover:underline">{t("Open the queue")}</Link></header>
      {view.isLoading ? <div className="p-4"><Spinner /></div> : total === 0 ? <p className="px-4 py-8 text-center text-sm text-slate-500">{t("No patients of yours today yet. Search above to find any patient.")}</p> : (
        <div className="space-y-3 px-4 py-3">
          {groups.filter((g) => g.rows.length > 0).map((g) => (
            <div key={g.label}>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-teal-700">{t(g.label)}</div>
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-100">
                {g.rows.map((e) => (
                  <li key={e.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span className="flex min-w-0 items-center gap-2.5"><span className={`inline-flex h-8 min-w-[2rem] items-center justify-center rounded-full px-2 text-sm font-semibold tabular-nums ${g.tone}`}>{e.tokenNumber}</span><span className="min-w-0 truncate"><span className="font-semibold text-slate-900">{e.patientName}</span> <span className="text-slate-400">· {e.mrn}</span>{g.label === "Waiting" && e.waitingMinutes !== null ? <span className="ml-2 text-xs text-slate-500">{e.waitingMinutes} {t("min")}</span> : null}</span></span>
                    <span className="flex shrink-0 gap-1.5">
                      {g.visit && e.encounterId && <Link href={`/visits/${e.encounterId}`} className="rounded-md bg-brand-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-brand-700">{t("Open visit")}</Link>}
                      {e.patientId && <Link href={`/patients/${e.patientId}`} className="rounded-md border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">{t("Open chart")}</Link>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default function PatientsPage() {
  const { can, date } = useMe();
  const t = useT();
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  // "Register a new patient" in the appointment booking search opens this page with the form already open.
  useEffect(() => { if (can("PATIENT_CREATE") && new URLSearchParams(window.location.search).get("register") === "1") setAdding(true); }, [can]);
  // N opens the registration form (ignored while typing or when a form is already open).
  useDeskKeys((k, e) => { if (k === "N" && can("PATIENT_CREATE") && !adding) { e.preventDefault(); setAdding(true); } });
  const term = useDebounced(q.trim(), 250);
  const res = useQuery({ queryKey: ["patients", term], queryFn: () => api.page<PatientRow & { createdAt: string }>("/patients", { q: term, pageSize: 25 }), enabled: term.length >= 2 });
  const rows = res.data?.data ?? [];
  // A doctor sees their own patients of the day before they type anything.
  const doctorView = can("CONSULTATION_CREATE") && can("QUEUE_READ");
  return (
    <Gate anyOf={["PATIENT_READ"]}>
      <div className="-mx-4 -mb-4 min-h-[calc(100vh-8rem)] bg-white p-4 md:-mx-6 md:-mb-6 md:px-6 md:py-4">
        <PageHeader title="Patients" subtitle="Search by MRN, mobile number or name" actions={can("PATIENT_CREATE") ? <Button className="gap-2 rounded-lg px-4 py-2 shadow-sm" onClick={() => setAdding(true)}><Icon name="plus" />Register patient<kbd className="rounded bg-white/20 px-1.5 text-[11px]">N</kbd></Button> : undefined} />
        <div className="relative mb-3">
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"><Icon name="search" className="h-[18px] w-[18px]" /></span>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Type at least 2 characters…")} aria-label="Search patients" className="w-full rounded-xl border border-slate-200 bg-white py-3 pl-11 pr-10 text-base shadow-[0_1px_3px_rgba(15,23,42,0.06)] placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20" />
          {q && <button type="button" aria-label={t("Clear search")} onClick={() => setQ("")} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700">✕</button>}
        </div>
        {term.length < 2 && doctorView ? <MyPatientsToday /> : (
        <section className={PANEL}>
          {term.length < 2 ? (
            <div className="px-4 py-10 text-center">
              <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-teal-50 text-teal-600"><Icon name="patients" className="h-5 w-5" /></span>
              <p className="text-sm font-medium text-slate-800">{t("Start typing to find a patient.")}</p>
              <div className="mt-3 flex flex-wrap justify-center gap-2 text-xs text-slate-500">
                {["Patient ID, e.g. DEMO-000203", "Mobile number", "First name"].map((x) => <span key={x} className="rounded-full bg-slate-100 px-3 py-1">{t(x)}</span>)}
              </div>
            </div>
          ) : res.isLoading ? <div className="p-4"><Spinner /></div> : (
            <>
              <header className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5"><h2 className="text-sm font-semibold text-slate-800">{t("Results")} <span className="ml-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">{rows.length}</span></h2></header>
              <div className="px-4 py-1"><ErrorNote error={res.error} /></div>
              {rows.length === 0 ? <p className="px-4 py-8 text-center text-sm text-slate-500">{t("No patients match. Check the spelling or register a new patient.")}</p> : (
                <div className="overflow-x-auto px-4 pb-1">
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-[11px] uppercase tracking-wider text-slate-400"><th className="py-2 pr-3 font-medium">{t("Name")}</th><th className="py-2 pr-3 font-medium">{t("MRN")}</th><th className="py-2 pr-3 font-medium">{t("Gender / age")}</th><th className="py-2 pr-3 font-medium">{t("Mobile")}</th><th className="hidden py-2 pr-3 font-medium md:table-cell">{t("Registered")}</th><th className="w-44" /></tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {rows.map((pt) => {
                        const name = patientName(pt);
                        return (
                          <tr key={pt.id} className="hover:bg-slate-50/70">
                            <td className="py-2.5 pr-3"><Link className="flex items-center gap-2.5" href={`/patients/${pt.id}`}><span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${tintOf(name)}`}>{initials(name)}</span><span className="font-semibold text-slate-900 hover:text-brand-700 hover:underline">{name}</span></Link></td>
                            <td className="whitespace-nowrap py-2.5 pr-3 tabular-nums text-slate-600">{pt.mrn}</td>
                            <td className="whitespace-nowrap py-2.5 pr-3 text-slate-700">{pt.gender.toLowerCase()}{ageText(pt.age) ? `, ${ageText(pt.age)}` : ""}</td>
                            <td className="whitespace-nowrap py-2.5 pr-3 tabular-nums text-slate-700">{pt.mobile ?? "—"}</td>
                            <td className="hidden whitespace-nowrap py-2.5 pr-3 text-xs text-slate-500 md:table-cell">{date(pt.createdAt)}</td>
                            <td className="py-2.5 text-right">
                              <div className="flex justify-end gap-1.5">
                                {can("INVOICE_CREATE") && <Link href={`/billing?patient=${pt.id}`} className="whitespace-nowrap rounded-md bg-brand-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-brand-700">{t("New bill")}</Link>}
                                <Link href={`/patients/${pt.id}`} className="whitespace-nowrap rounded-md border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">{t(doctorView ? "Open chart" : "Open")}</Link>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </section>
        )}
      </div>
      {adding && <RegisterPatient onClose={() => setAdding(false)} />}
    </Gate>
  );
}
