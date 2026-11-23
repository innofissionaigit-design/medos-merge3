"use client";
import { useCallback, useEffect, useState, type ReactNode } from "react";

/**
 * The patient app (docs/patient-app.md). A phone-first page for patients: sign in with a code sent to the mobile number the hospital has on record, then see
 * appointments, visits and prescriptions, reports and bills, and ask for an appointment. It has its own cookie and talks only to /api/patient/*.
 */
interface Profile { id: string; name: string; mrn: string | null; gender: string | null; age: number | null; locked: boolean; canUnlock: boolean }
interface Me { hospital: string | null; patients: Profile[] }
interface Appt { id: string; startAt: string; status: string; type: string; doctor: string; specialty: string | null; video: { id: string; status: string; consented: boolean; waiting: boolean; doctorStarted: boolean; feeDue: string | null; opensAt: string; canJoin: boolean } | null }
interface Visit { id: string; visitNumber: string; date: string; doctor: string | null; diagnoses: string[]; advice: string | null; prescription: { number: string | null; medicines: { name: string; dose: string; frequency: string; days: number | null; food: string | null; note: string | null }[] } | null }
interface Reports { withheld: number; lab: { id: string; test: string; reportedAt: string; values: { name: string; unit: string | null; value: string; flag: string; range: string }[] }[]; radiology: { id: string; test: string; bodyPart: string; reportedAt: string; findings: string; impression: string }[] }
interface Bill { id: string; number: string | null; status: string; issuedAt: string; total: string; paid: string; due: string; receipts: { number: string; amount: string; at: string }[] }
interface Req { id: string; preferredDate: string; timeOfDay: string; reason: string; status: string; doctor: string | null; answer: string | null }
interface Doctor { id: string; name: string; specialty: string | null }

class Failure extends Error { constructor(readonly status: number, message: string) { super(message); } }

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/patient/${path}`, { method, headers: { "x-medos-csrf": "1", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : null, cache: "no-store" });
  const json = (await res.json().catch(() => ({}))) as { data?: T; error?: { message?: string } };
  if (!res.ok) throw new Failure(res.status, json.error?.message ?? "Something went wrong. Please try again");
  return json.data as T;
}
const data = <T,>(path: string) => call<T>("GET", `data/${path}`);

const rupees = (v: string) => `₹${Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
const dayOnly = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { dateStyle: "medium" });
const FLAG: Record<string, string> = { NORMAL: "bg-emerald-100 text-emerald-800", LOW: "bg-amber-100 text-amber-800", HIGH: "bg-amber-100 text-amber-800", CRITICAL_LOW: "bg-red-100 text-red-800", CRITICAL_HIGH: "bg-red-100 text-red-800" };

const Card = ({ title, children }: { title: string; children: ReactNode }) => <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><h2 className="mb-3 text-base font-semibold text-slate-900">{title}</h2>{children}</section>;
const Btn = ({ children, onClick, disabled, kind = "primary" }: { children: ReactNode; onClick?: () => void; disabled?: boolean; kind?: "primary" | "plain" }) => (
  <button type="button" onClick={onClick} disabled={disabled} className={`min-h-12 rounded-xl px-5 text-sm font-semibold transition focus:outline-none focus-visible:ring-4 focus-visible:ring-blue-200 disabled:cursor-not-allowed disabled:opacity-50 ${kind === "primary" ? "bg-gradient-to-b from-blue-600 to-blue-700 text-white shadow-sm hover:from-blue-700 hover:to-blue-800" : "border border-slate-300 bg-white text-slate-800 hover:bg-slate-50"}`}>{children}</button>
);
const field = "min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3.5 text-base text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-4 focus:ring-blue-100";

function SignIn({ onDone }: { onDone: () => void }) {
  const [hospital, setHospital] = useState("");
  const [mobile, setMobile] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { try { setHospital(localStorage.getItem("medos_patient_hospital") ?? ""); } catch { /* private window: fine */ } }, []);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(null); try { await fn(); } catch (e) { setErr(e instanceof Error ? e.message : "Something went wrong"); } finally { setBusy(false); } };
  const send = () => run(async () => { await call("POST", "code", { hospitalCode: hospital.trim(), mobile: mobile.replace(/\D/g, "").slice(-10) }); try { localStorage.setItem("medos_patient_hospital", hospital.trim()); } catch { /* ignore */ } setSent(true); });
  const verify = () => run(async () => { await call("POST", "verify", { hospitalCode: hospital.trim(), mobile: mobile.replace(/\D/g, "").slice(-10), code }); onDone(); });
  const digits = mobile.replace(/\D/g, "").slice(-10);
  const step = (n: number, label: string) => (
    <div className="flex items-center gap-2">
      <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${(n === 1 && !sent) || (n === 2 && sent) ? "bg-blue-600 text-white" : n === 1 && sent ? "bg-emerald-500 text-white" : "bg-slate-200 text-slate-500"}`}>{n === 1 && sent ? "✓" : n}</span>
      <span className={`text-xs font-medium ${(n === 1 && !sent) || (n === 2 && sent) ? "text-slate-900" : "text-slate-500"}`}>{label}</span>
    </div>
  );
  return (
    <main className="min-h-screen bg-gradient-to-b from-blue-50 via-white to-slate-50">
      <div className="mx-auto max-w-md px-4 pb-10 pt-10">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-blue-700 text-lg font-bold text-white shadow-md" aria-hidden>M</span>
          <div><div className="text-base font-semibold leading-tight text-slate-900">MedOS</div><div className="text-xs text-slate-500">Patient app</div></div>
        </div>
        <h1 className="mt-8 text-3xl font-semibold tracking-tight text-slate-900">My health records</h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">See your appointments, prescriptions, reports and bills, and join a video consultation. Sign in with the mobile number you gave the hospital.</p>

        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-lg shadow-slate-200/60" aria-label="Sign in">
          <div className="mb-4 flex items-center justify-between">{step(1, "Your details")}<span className="h-px flex-1 bg-slate-200 mx-3" aria-hidden />{step(2, "Enter the code")}</div>
          <div className="space-y-4">
            {!sent ? (
              <>
                <label className="block text-sm font-medium text-slate-700">Hospital code
                  <input className={`${field} mt-1.5`} value={hospital} onChange={(e) => setHospital(e.target.value)} autoCapitalize="none" autoComplete="off" placeholder="e.g. your hospital's code" />
                </label>
                <label className="block text-sm font-medium text-slate-700">Mobile number
                  <div className="mt-1.5 flex">
                    <span className="flex min-h-12 items-center rounded-l-xl border border-r-0 border-slate-300 bg-slate-50 px-3.5 text-base text-slate-500" aria-hidden>+91</span>
                    <input className={`${field} rounded-l-none`} inputMode="numeric" autoComplete="tel" value={mobile} onChange={(e) => setMobile(e.target.value)} placeholder="10-digit number" />
                  </div>
                </label>
              </>
            ) : (
              <>
                <p className="rounded-xl bg-blue-50 p-3 text-sm text-blue-900">If <b>+91 {digits.slice(0, 5)} {digits.slice(5)}</b> is registered with the hospital, a 6-digit code is on its way. It works for 5 minutes.</p>
                <label className="block text-sm font-medium text-slate-700">The 6-digit code we sent you
                  <input className={`${field} mt-1.5 text-center text-2xl font-semibold tracking-[0.5em]`} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="••••••" autoFocus />
                </label>
              </>
            )}
            {err && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{err}</p>}
            {!sent ? <div className="[&>button]:w-full"><Btn disabled={busy || hospital.trim().length < 2 || digits.length < 10} onClick={() => void send()}>{busy ? "Sending…" : "Send me a code"}</Btn></div>
              : <div className="grid grid-cols-2 gap-2"><Btn disabled={busy || code.length !== 6} onClick={() => void verify()}>{busy ? "Checking…" : "Sign in"}</Btn><Btn kind="plain" disabled={busy} onClick={() => void send()}>Send again</Btn></div>}
            {sent && <button type="button" className="w-full text-center text-sm text-slate-500 underline" onClick={() => { setSent(false); setCode(""); setErr(null); }}>Use a different number</button>}
          </div>
        </section>

        <ul className="mt-6 grid grid-cols-3 gap-2 text-center text-xs text-slate-600">
          {[["Visits and prescriptions", "bg-blue-50 text-blue-700"], ["Reports and bills", "bg-emerald-50 text-emerald-700"], ["Video consultations", "bg-violet-50 text-violet-700"]].map(([t, tone]) => <li key={t} className={`rounded-xl px-2 py-3 font-medium ${tone}`}>{t}</li>)}
        </ul>
        <p className="mt-6 text-center text-xs text-slate-500">Your records are private. The code works once and only for your number.</p>
      </div>
    </main>
  );
}

function Unlock({ profile, onDone }: { profile: Profile; onDone: () => void }) {
  const [dob, setDob] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => { setBusy(true); setErr(null); try { await call("POST", "unlock", { patientId: profile.id, dateOfBirth: dob }); onDone(); } catch (e) { setErr(e instanceof Error ? e.message : "Something went wrong"); } finally { setBusy(false); } };
  if (!profile.canUnlock) return <Card title={profile.name}><p className="text-sm text-slate-600">To protect your records, please ask the hospital front desk to add your date of birth. Then you can open them here.</p></Card>;
  return (
    <Card title={`Open ${profile.name}'s records`}>
      <div className="space-y-3">
        <p className="text-sm text-slate-600">Several people use this mobile number. To protect your records, please confirm your date of birth.</p>
        <label className="block text-sm">Date of birth<input type="date" className={field} max={new Date().toISOString().slice(0, 10)} value={dob} onChange={(e) => setDob(e.target.value)} /></label>
        {err && <p role="alert" className="rounded-lg bg-red-50 p-2 text-sm text-red-800">{err}</p>}
        <Btn disabled={busy || !dob} onClick={() => void submit()}>Open records</Btn>
      </div>
    </Card>
  );
}

function VideoJoin({ video, onJoined }: { video: NonNullable<Appt["video"]>; onJoined: () => void }) {
  const [agree, setAgree] = useState(video.consented);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const waiting = video.waiting && !video.doctorStarted;
  // In the waiting room the page checks every few seconds whether the doctor has started.
  useEffect(() => { if (!waiting) return; const timer = setInterval(onJoined, 5000); return () => clearInterval(timer); }, [waiting, onJoined]);
  const run = async (what: "arrive" | "join") => {
    setBusy(true); setErr(null);
    try {
      const r = await call<{ url?: string }>("POST", `data/teleconsults/${video.id}/${what}`, { consent: agree });
      if (what === "join" && r.url) window.open(r.url, "_blank", "noopener,noreferrer");
      onJoined();
    } catch (e) { setErr(e instanceof Error ? e.message : "Something went wrong"); } finally { setBusy(false); }
  };
  if (!video.canJoin) return <p className="mt-1 text-xs text-slate-500">You can join from {when(video.opensAt)}. A button will appear here.</p>;
  if (video.feeDue) return <p role="status" className="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-900">A fee of ₹{video.feeDue} must be paid at the hospital counter before you can join. Please ask the front desk.</p>;
  return (
    <div className="mt-2 space-y-2">
      {!video.consented && <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" checked={agree} onChange={(e) => setAgree(e.target.checked)} /><span>I agree to be consulted by video. I understand the doctor may advise me to visit the hospital if needed.</span></label>}
      {err && <p role="alert" className="rounded-lg bg-red-50 p-2 text-xs text-red-800">{err}</p>}
      {video.doctorStarted
        ? <><p role="status" className="text-xs font-medium text-green-800">The doctor has started the call.</p><Btn disabled={busy || !agree} onClick={() => void run("join")}>Join video call</Btn></>
        : waiting
          ? <p role="status" className="rounded-lg bg-blue-50 p-2 text-xs text-blue-900">You are in the waiting room. The doctor has been told you are here. This page will show a Join button as soon as the doctor starts.</p>
          : <Btn disabled={busy || !agree} onClick={() => void run("arrive")}>I am here</Btn>}
    </div>
  );
}

function Appointments({ patientId }: { patientId: string }) {
  const [appts, setAppts] = useState<{ upcoming: Appt[]; past: Appt[] } | null>(null);
  const [reqs, setReqs] = useState<Req[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [form, setForm] = useState({ practitionerId: "", preferredDate: "", timeOfDay: "ANY", reason: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { void data<{ upcoming: Appt[]; past: Appt[] }>(`appointments?patientId=${patientId}`).then(setAppts); void data<Req[]>(`appointment-requests?patientId=${patientId}`).then(setReqs); }, [patientId]);
  useEffect(() => { load(); void data<Doctor[]>("doctors").then(setDoctors).catch(() => undefined); }, [load]);
  const submit = async () => { setBusy(true); setErr(null); try { await call("POST", "data/appointment-requests", { patientId, preferredDate: form.preferredDate, timeOfDay: form.timeOfDay, reason: form.reason.trim(), ...(form.practitionerId ? { practitionerId: form.practitionerId } : {}) }); setForm({ ...form, reason: "" }); load(); } catch (e) { setErr(e instanceof Error ? e.message : "Something went wrong"); } finally { setBusy(false); } };
  const cancel = async (id: string) => { try { await call("POST", `data/appointment-requests/${id}/cancel`, {}); load(); } catch (e) { setErr(e instanceof Error ? e.message : "Something went wrong"); } };
  const min = new Date().toISOString().slice(0, 10);
  return (
    <div className="space-y-4">
      <Card title="Coming up">
        {!appts ? <p className="text-sm text-slate-500">Loading…</p> : appts.upcoming.length === 0 ? <p className="text-sm text-slate-500">No appointments booked.</p> : (
          <ul className="space-y-2">{appts.upcoming.map((a) => <li key={a.id} className="rounded-lg border border-slate-200 p-3 text-sm"><div className="font-medium">{when(a.startAt)}{a.video ? " · video consultation" : ""}</div><div>{a.doctor}{a.specialty ? ` · ${a.specialty}` : ""}</div>{a.video && <VideoJoin video={a.video} onJoined={load} />}</li>)}</ul>
        )}
      </Card>
      <Card title="Ask for an appointment">
        <div className="space-y-3">
          <label className="block text-sm">Doctor (optional)<select className={field} value={form.practitionerId} onChange={(e) => setForm({ ...form, practitionerId: e.target.value })}><option value="">Any doctor</option>{doctors.map((d) => <option key={d.id} value={d.id}>{d.name}{d.specialty ? ` · ${d.specialty}` : ""}</option>)}</select></label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-sm">Preferred day<input type="date" min={min} className={field} value={form.preferredDate} onChange={(e) => setForm({ ...form, preferredDate: e.target.value })} /></label>
            <label className="block text-sm">Time<select className={field} value={form.timeOfDay} onChange={(e) => setForm({ ...form, timeOfDay: e.target.value })}><option value="ANY">Any time</option><option value="MORNING">Morning</option><option value="AFTERNOON">Afternoon</option><option value="EVENING">Evening</option></select></label>
          </div>
          <label className="block text-sm">Reason<input className={field} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="For example: follow-up for fever" /></label>
          {err && <p role="alert" className="rounded-lg bg-red-50 p-2 text-sm text-red-800">{err}</p>}
          <Btn disabled={busy || !form.preferredDate || form.reason.trim().length < 3} onClick={() => void submit()}>Send request</Btn>
          <p className="text-xs text-slate-500">The hospital will call or message you to confirm a time. This is not a booking yet.</p>
        </div>
      </Card>
      {reqs.length > 0 && (
        <Card title="Your requests">
          <ul className="space-y-2">{reqs.map((r) => (
            <li key={r.id} className="rounded-lg border border-slate-200 p-3 text-sm">
              <div className="flex items-center justify-between gap-2"><span className="font-medium">{dayOnly(r.preferredDate)} · {r.timeOfDay.toLowerCase()}</span><span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">{r.status === "PENDING" ? "waiting" : r.status.toLowerCase()}</span></div>
              <div>{r.reason}{r.doctor ? ` · ${r.doctor}` : ""}</div>
              {r.answer && <div className="mt-1 text-slate-700">Hospital: {r.answer}</div>}
              {r.status === "PENDING" && <div className="mt-2"><Btn kind="plain" onClick={() => void cancel(r.id)}>Cancel request</Btn></div>}
            </li>))}</ul>
        </Card>
      )}
      {appts && appts.past.length > 0 && <Card title="Earlier"><ul className="space-y-1 text-sm">{appts.past.map((a) => <li key={a.id} className="flex justify-between gap-2"><span>{dayOnly(a.startAt)} · {a.doctor}</span><span className="text-slate-500">{a.status.toLowerCase().replace(/_/g, " ")}</span></li>)}</ul></Card>}
    </div>
  );
}

function Visits({ patientId }: { patientId: string }) {
  const [rows, setRows] = useState<Visit[] | null>(null);
  useEffect(() => { void data<Visit[]>(`visits?patientId=${patientId}`).then(setRows); }, [patientId]);
  if (!rows) return <p className="text-sm text-slate-500">Loading…</p>;
  if (rows.length === 0) return <Card title="Visits"><p className="text-sm text-slate-500">No signed visits yet.</p></Card>;
  return (
    <div className="space-y-4">{rows.map((v) => (
      <Card key={v.id} title={`${dayOnly(v.date)} · ${v.doctor ?? "Doctor"}`}>
        {v.diagnoses.length > 0 && <p className="text-sm"><span className="font-medium">Diagnosis:</span> {v.diagnoses.join(", ")}</p>}
        {v.advice && <p className="mt-1 text-sm"><span className="font-medium">Advice:</span> {v.advice}</p>}
        {v.prescription && (
          <div className="mt-3">
            <div className="text-sm font-medium">Prescription {v.prescription.number}</div>
            <ul className="mt-1 space-y-1 text-sm">{v.prescription.medicines.map((m, i) => <li key={i} className="rounded-lg bg-slate-50 p-2"><span className="font-medium">{m.name}</span>: {m.dose}, {m.frequency}{m.days ? ` for ${m.days} days` : ""}{m.food ? ` · ${m.food.toLowerCase().replace(/_/g, " ")}` : ""}{m.note ? ` · ${m.note}` : ""}</li>)}</ul>
          </div>
        )}
      </Card>))}</div>
  );
}

function ReportsTab({ patientId }: { patientId: string }) {
  const [r, setR] = useState<Reports | null>(null);
  useEffect(() => { void data<Reports>(`reports?patientId=${patientId}`).then(setR); }, [patientId]);
  if (!r) return <p className="text-sm text-slate-500">Loading…</p>;
  return (
    <div className="space-y-4">
      {r.withheld > 0 && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{r.withheld === 1 ? "One report needs" : `${r.withheld} reports need`} your doctor to look at it first. The hospital will contact you.</p>}
      {r.lab.length === 0 && r.radiology.length === 0 && <Card title="Reports"><p className="text-sm text-slate-500">No reports yet.</p></Card>}
      {r.lab.map((l) => (
        <Card key={l.id} title={`${l.test} · ${dayOnly(l.reportedAt)}`}>
          <ul className="space-y-1 text-sm">{l.values.map((v, i) => <li key={i} className="flex flex-wrap items-center justify-between gap-2"><span>{v.name}</span><span><span className="font-medium">{v.value} {v.unit ?? ""}</span> <span className="text-xs text-slate-500">({v.range})</span> <span className={`rounded-full px-2 py-0.5 text-xs ${FLAG[v.flag] ?? "bg-slate-100"}`}>{v.flag.replace("_", " ").toLowerCase()}</span></span></li>)}</ul>
        </Card>))}
      {r.radiology.map((x) => <Card key={x.id} title={`${x.test} · ${x.bodyPart} · ${dayOnly(x.reportedAt)}`}><p className="text-sm">{x.findings}</p><p className="mt-1 text-sm font-medium">Impression: {x.impression}</p></Card>)}
    </div>
  );
}

function Bills({ patientId }: { patientId: string }) {
  const [rows, setRows] = useState<Bill[] | null>(null);
  useEffect(() => { void data<Bill[]>(`bills?patientId=${patientId}`).then(setRows); }, [patientId]);
  if (!rows) return <p className="text-sm text-slate-500">Loading…</p>;
  if (rows.length === 0) return <Card title="Bills"><p className="text-sm text-slate-500">No bills yet.</p></Card>;
  return (
    <div className="space-y-4">{rows.map((b) => (
      <Card key={b.id} title={`${b.number ?? "Bill"} · ${dayOnly(b.issuedAt)}`}>
        <div className="grid grid-cols-3 gap-2 text-sm"><div><div className="text-xs text-slate-500">Total</div>{rupees(b.total)}</div><div><div className="text-xs text-slate-500">Paid</div>{rupees(b.paid)}</div><div><div className="text-xs text-slate-500">To pay</div><span className={Number(b.due) > 0 ? "font-semibold text-red-700" : ""}>{rupees(b.due)}</span></div></div>
        {b.receipts.length > 0 && <ul className="mt-2 space-y-1 text-xs text-slate-600">{b.receipts.map((r) => <li key={r.number}>Receipt {r.number}: {rupees(r.amount)} on {dayOnly(r.at)}</li>)}</ul>}
      </Card>))}
      <p className="text-xs text-slate-500">To pay a bill, please visit the hospital counter.</p>
    </div>
  );
}

export default function PatientApp() {
  const [me, setMe] = useState<Me | null | "none">(null);
  const [pid, setPid] = useState("");
  const [tab, setTab] = useState<"appointments" | "visits" | "reports" | "bills">("appointments");
  const load = useCallback(() => { data<Me>("me").then((m) => { setMe(m); setPid((cur) => cur || m.patients[0]?.id || ""); }).catch(() => setMe("none")); }, []);
  useEffect(() => { load(); }, [load]);
  const signOut = async () => { await call("POST", "logout", {}).catch(() => undefined); setMe("none"); setPid(""); };
  if (me === null) return <p className="p-6 text-center text-sm text-slate-500">Loading…</p>;
  if (me === "none") return <SignIn onDone={() => { setMe(null); load(); }} />;
  const current = me.patients.find((p) => p.id === pid);
  return (
    <main className="mx-auto min-h-screen max-w-md space-y-4 bg-slate-50 p-4 pb-16">
      <header className="flex items-center justify-between gap-3 pt-2">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-700 text-base font-semibold text-white shadow-sm" aria-hidden>{(current?.name ?? "P").split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("")}</span>
          <div className="min-w-0"><div className="truncate text-xs text-slate-500">{me.hospital}</div><h1 className="truncate text-xl font-semibold text-slate-900">{current?.name ?? "Patient"}</h1>{current && !current.locked && <div className="text-xs text-slate-500">{current.mrn}{current.age !== null ? ` · ${current.age} yrs` : ""}</div>}</div>
        </div>
        <Btn kind="plain" onClick={() => void signOut()}>Sign out</Btn>
      </header>
      {me.patients.length > 1 && <label className="block text-sm">Showing records of<select className={field} value={pid} onChange={(e) => setPid(e.target.value)}>{me.patients.map((p) => <option key={p.id} value={p.id}>{p.name}{p.mrn ? ` · ${p.mrn}` : ""}</option>)}</select></label>}
      {current?.locked && <Unlock profile={current} key={`u${current.id}`} onDone={load} />}
      {!current?.locked && <nav className="sticky top-0 z-10 grid grid-cols-4 gap-1 rounded-2xl bg-slate-200/80 p-1 text-[13px] backdrop-blur" role="tablist">
        {([["appointments", "Visits to come"], ["visits", "Prescriptions"], ["reports", "Reports"], ["bills", "Bills"]] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`min-h-11 rounded-xl px-1 transition ${tab === k ? "bg-white font-semibold text-blue-700 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}>{l}</button>)}
      </nav>}
      {pid && !current?.locked && tab === "appointments" && <Appointments patientId={pid} key={`a${pid}`} />}
      {pid && !current?.locked && tab === "visits" && <Visits patientId={pid} key={`v${pid}`} />}
      {pid && !current?.locked && tab === "reports" && <ReportsTab patientId={pid} key={`r${pid}`} />}
      {pid && !current?.locked && tab === "bills" && <Bills patientId={pid} key={`b${pid}`} />}
    </main>
  );
}
