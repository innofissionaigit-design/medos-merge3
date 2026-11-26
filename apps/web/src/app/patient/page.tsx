"use client";
import { useCallback, useEffect, useState, type ReactNode } from "react";

/**
 * The patient app (docs/patient-app.md). A phone-first page for patients: sign in with a code sent to the mobile number the hospital has on record, then see
 * appointments, visits and prescriptions, reports and bills, and ask for an appointment. It has its own cookie and talks only to /api/patient/*.
 */
interface Profile { id: string; name: string; mrn: string | null; gender: string | null; age: number | null; locked: boolean; canUnlock: boolean }
interface Me { hospital: string | null; patients: Profile[] }
interface Appt { id: string; startAt: string; status: string; type: string; doctor: string; specialty: string | null; video: { id: string; status: string; consented: boolean; waiting: boolean; doctorStarted: boolean; feeDue: string | null; payFirst: boolean; opensAt: string; canJoin: boolean } | null }
interface Visit { id: string; visitNumber: string; date: string; doctor: string | null; diagnoses: string[]; advice: string | null; prescription: { number: string | null; medicines: { name: string; dose: string; frequency: string; days: number | null; food: string | null; note: string | null }[] } | null }
interface Reports { withheld: number; lab: { id: string; test: string; reportedAt: string; values: { name: string; unit: string | null; value: string; flag: string; range: string }[] }[]; radiology: { id: string; test: string; bodyPart: string; reportedAt: string; findings: string; impression: string }[] }
interface Bill { id: string; number: string | null; status: string; issuedAt: string; total: string; paid: string; due: string; receipts: { number: string; amount: string; at: string }[] }
interface Req { mode?: string; id: string; preferredDate: string; timeOfDay: string; reason: string; status: string; doctor: string | null; answer: string | null }
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

const GENDERS = [["MALE", "Male"], ["FEMALE", "Female"], ["OTHER", "Other"]] as const;

const NAME = /^\p{L}[\p{L}\p{M} .'’-]*$/u;
const USERNAME = /^[a-z0-9][a-z0-9._@+-]{3,63}$/;
/** Today in the phone's own time zone, and the earliest birth date accepted (120 years ago). */
const localDay = (yearsAgo = 0) => { const d = new Date(); return `${d.getFullYear() - yearsAgo}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const mobileDigits = (v: string) => { const d = v.replace(/\D/g, ""); return d.length === 12 && d.startsWith("91") ? d.slice(2) : d.length === 11 && d.startsWith("0") ? d.slice(1) : d; };

function Row({ label, error, hint, children }: { label: string; error?: string | undefined; hint?: string; children: ReactNode }) {
  return (
    <label className="block text-sm font-medium text-slate-700">{label}
      <div className="mt-1.5">{children}</div>
      {error ? <span role="alert" className="mt-1 block text-xs font-medium text-red-700">{error}</span> : hint ? <span className="mt-1 block text-xs font-normal text-slate-500">{hint}</span> : null}
    </label>
  );
}
const Part = ({ title, children }: { title: string; children: ReactNode }) => <fieldset className="space-y-4"><legend className="mb-3 w-full border-b border-slate-200 pb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</legend>{children}</fieldset>;

/** A new patient registers from the app: details, a username and a password, and they are signed in. The hospital's front desk sees them as a new patient. */
function Register({ hospital, setHospital, onDone }: { hospital: string; setHospital: (v: string) => void; onDone: () => void }) {
  const [f, setF] = useState({ firstName: "", lastName: "", gender: "" as "" | "MALE" | "FEMALE" | "OTHER", dateOfBirth: "", mobile: "", username: "", password: "", again: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [tried, setTried] = useState(false);
  const [show, setShow] = useState(false);
  const set = (k: keyof typeof f, v: string) => { setF((x) => ({ ...x, [k]: v })); setErr(null); };
  const touch = (k: string) => () => setTouched((x) => ({ ...x, [k]: true }));
  const digits = mobileDigits(f.mobile);
  const username = f.username.trim().toLowerCase();
  const name = (v: string, which: string) => (!v.trim() ? `Enter your ${which} name` : !NAME.test(v.trim()) ? "Use letters only" : v.trim().length > 60 ? "Use 60 letters or fewer" : undefined);
  const checks = [["At least 8 characters", f.password.length >= 8], ["A letter", /[A-Za-z]/.test(f.password)], ["A number", /\d/.test(f.password)]] as const;
  const errors: Record<string, string | undefined> = {
    hospital: hospital.trim().length < 2 ? "Enter your hospital's code" : undefined,
    firstName: name(f.firstName, "first"),
    lastName: name(f.lastName, "last"),
    gender: f.gender ? undefined : "Choose your gender",
    dateOfBirth: !f.dateOfBirth ? "Enter your date of birth" : f.dateOfBirth > localDay() ? "Date of birth cannot be in the future" : f.dateOfBirth < localDay(120) ? "Check the year of birth" : undefined,
    mobile: !f.mobile.trim() ? "Enter your mobile number" : !/^[6-9]\d{9}$/.test(digits) ? "Enter a 10-digit mobile number starting with 6, 7, 8 or 9" : undefined,
    username: !username ? "Choose a username" : !USERNAME.test(username) ? "4 or more letters, numbers or . _ @ + - (no spaces)" : undefined,
    password: checks.every(([, ok]) => ok) ? undefined : "Choose a stronger password",
    again: !f.again ? "Type the password again" : f.again !== f.password ? "The two passwords are not the same" : undefined,
  };
  const shown = (k: string) => (tried || touched[k] ? errors[k] : undefined);
  const box = (k: string) => `${field} ${shown(k) ? "!border-red-500 !ring-red-100" : ""}`;
  const create = async () => {
    setTried(true);
    if (Object.values(errors).some(Boolean)) { setTimeout(() => document.querySelector<HTMLElement>("[aria-invalid=true]")?.focus(), 0); return; }
    setBusy(true); setErr(null);
    try {
      await call("POST", "register", { hospitalCode: hospital.trim(), mobile: digits, firstName: f.firstName.trim(), lastName: f.lastName.trim(), gender: f.gender, dateOfBirth: f.dateOfBirth, username, password: f.password });
      try { localStorage.setItem("medos_patient_hospital", hospital.trim()); } catch { /* fine */ }
      onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : "Something went wrong"); } finally { setBusy(false); }
  };
  const input = (k: keyof typeof f | "hospital") => ({ className: box(k), "aria-invalid": !!shown(k), onBlur: touch(k) });
  return (
    <form noValidate className="space-y-6" onSubmit={(e) => { e.preventDefault(); if (!busy) void create(); }}>
      <Part title="Your details">
        <Row label="Hospital code" error={shown("hospital")}><input {...input("hospital")} value={hospital} onChange={(e) => { setHospital(e.target.value); setErr(null); }} autoCapitalize="none" autoComplete="off" placeholder="e.g. your hospital's code" /></Row>
        <div className="grid grid-cols-2 items-start gap-3">
          <Row label="First name" error={shown("firstName")}><input {...input("firstName")} autoComplete="given-name" maxLength={60} value={f.firstName} onChange={(e) => set("firstName", e.target.value)} /></Row>
          <Row label="Last name" error={shown("lastName")}><input {...input("lastName")} autoComplete="family-name" maxLength={60} value={f.lastName} onChange={(e) => set("lastName", e.target.value)} /></Row>
        </div>
        <div>
          <div className="text-sm font-medium text-slate-700">Gender</div>
          <div className="mt-1.5 grid grid-cols-3 gap-2" role="radiogroup" aria-label="Gender">
            {GENDERS.map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={f.gender === k} aria-invalid={!!shown("gender")} onClick={() => set("gender", k)} className={`min-h-12 rounded-xl border text-sm font-medium focus:outline-none focus-visible:ring-4 focus-visible:ring-blue-100 ${f.gender === k ? "border-blue-600 bg-blue-50 text-blue-700 ring-2 ring-blue-100" : shown("gender") ? "border-red-500 bg-white text-slate-700" : "border-slate-300 bg-white text-slate-700"}`}>{l}</button>)}
          </div>
          {shown("gender") && <span role="alert" className="mt-1 block text-xs font-medium text-red-700">{shown("gender")}</span>}
        </div>
        <Row label="Date of birth" error={shown("dateOfBirth")}><input {...input("dateOfBirth")} type="date" min={localDay(120)} max={localDay()} value={f.dateOfBirth} onChange={(e) => set("dateOfBirth", e.target.value)} /></Row>
        <Row label="Mobile number" error={shown("mobile")}>
          <div className="flex"><span className="flex min-h-12 items-center rounded-l-xl border border-r-0 border-slate-300 bg-slate-50 px-3.5 text-base text-slate-500" aria-hidden>+91</span><input {...input("mobile")} className={`${box("mobile")} rounded-l-none`} inputMode="numeric" autoComplete="tel-national" maxLength={14} value={f.mobile} onChange={(e) => set("mobile", e.target.value.replace(/[^\d +]/g, ""))} placeholder="10-digit number" /></div>
        </Row>
      </Part>
      <Part title="Your sign-in">
        <Row label="Choose a username" error={shown("username")} hint="4 or more letters, numbers or . _ @ + - (an email address is fine)"><input {...input("username")} autoCapitalize="none" autoCorrect="off" autoComplete="off" maxLength={64} value={f.username} onChange={(e) => set("username", e.target.value)} placeholder="e.g. nani.rupesh" /></Row>
        <Row label="Password" error={shown("password")}><input {...input("password")} type={show ? "text" : "password"} autoComplete="new-password" maxLength={128} value={f.password} onChange={(e) => set("password", e.target.value)} /></Row>
        <ul className="!mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Password rules">
          {checks.map(([l, ok]) => <li key={l} className={ok ? "font-medium text-emerald-700" : "text-slate-500"}><span aria-hidden>{ok ? "✓ " : "○ "}</span>{l}</li>)}
        </ul>
        <Row label="Type it again" error={shown("again")}><input {...input("again")} type={show ? "text" : "password"} autoComplete="new-password" maxLength={128} value={f.again} onChange={(e) => set("again", e.target.value)} /></Row>
        <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" className="h-4 w-4" checked={show} onChange={(e) => setShow(e.target.checked)} />Show password</label>
      </Part>
      {tried && Object.values(errors).some(Boolean) && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">Please correct the fields marked in red.</p>}
      {err && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{err}</p>}
      <div className="[&>button]:w-full"><Btn disabled={busy} onClick={() => void create()}>{busy ? "Creating…" : "Sign up"}</Btn></div>
      <p className="text-center text-xs text-slate-500">The hospital's front desk will see you as a new patient.</p>
    </form>
  );
}

function SignIn({ onDone }: { onDone: () => void }) {
  const [hospital, setHospital] = useState("");
  const [mobile, setMobile] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [mode, setMode] = useState<"password" | "code" | "new">("password");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { try { setHospital(localStorage.getItem("medos_patient_hospital") ?? ""); } catch { /* private window: fine */ } }, []);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(null); try { await fn(); } catch (e) { setErr(e instanceof Error ? e.message : "Something went wrong"); } finally { setBusy(false); } };
  const send = () => run(async () => { await call("POST", "code", { hospitalCode: hospital.trim(), mobile: mobile.replace(/\D/g, "").slice(-10) }); try { localStorage.setItem("medos_patient_hospital", hospital.trim()); } catch { /* ignore */ } setSent(true); });
  const verify = () => run(async () => { await call("POST", "verify", { hospitalCode: hospital.trim(), mobile: mobile.replace(/\D/g, "").slice(-10), code }); onDone(); });
  const login = () => run(async () => { await call("POST", "login", { hospitalCode: hospital.trim(), username: username.trim().toLowerCase(), password }); try { localStorage.setItem("medos_patient_hospital", hospital.trim()); } catch { /* fine */ } onDone(); });
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
          <div className="mb-4 grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1 text-sm" role="tablist">
            {([["password", "Password"], ["code", "SMS code"], ["new", "New patient"]] as const).map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={mode === k} onClick={() => { setMode(k); setErr(null); setSent(false); setCode(""); }} className={`min-h-10 rounded-lg font-medium ${mode === k ? "bg-white text-blue-700 shadow-sm" : "text-slate-600"}`}>{l}</button>)}
          </div>
          {mode === "code" && <div className="mb-4 flex items-center justify-between">{step(1, "Your details")}<span className="h-px flex-1 bg-slate-200 mx-3" aria-hidden />{step(2, "Enter the code")}</div>}
          {mode === "new" ? <Register hospital={hospital} setHospital={setHospital} onDone={onDone} /> : mode === "password" ? (
            <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (!busy && hospital.trim().length >= 2 && username.trim() && password) void login(); }}>
              <label className="block text-sm font-medium text-slate-700">Hospital code
                <input className={`${field} mt-1.5`} value={hospital} onChange={(e) => setHospital(e.target.value)} autoCapitalize="none" autoComplete="off" placeholder="e.g. your hospital's code" />
              </label>
              <label className="block text-sm font-medium text-slate-700">Username
                <input className={`${field} mt-1.5`} autoCapitalize="none" autoCorrect="off" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="e.g. nani.rupesh" />
              </label>
              <label className="block text-sm font-medium text-slate-700">Password
                <input className={`${field} mt-1.5`} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </label>
              {err && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{err}</p>}
              <div className="[&>button]:w-full"><Btn disabled={busy || hospital.trim().length < 2 || !username.trim() || !password} onClick={() => void login()}>{busy ? "Signing in…" : "Sign in"}</Btn></div>
              <p className="text-center text-xs text-slate-500">No password yet? Use <b>SMS code</b> once, then choose a username and password inside the app.</p>
            </form>
          ) : (
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
          )}
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

/** The day of an appointment as a small calendar block: weekday, day number, month. */
function DateBlock({ iso, tone = "blue" }: { iso: string; tone?: "blue" | "slate" }) {
  const d = new Date(iso);
  return (
    <div className={`flex h-16 w-14 shrink-0 flex-col items-center justify-center rounded-xl ${tone === "blue" ? "bg-blue-50 text-blue-700" : "bg-slate-100 text-slate-600"}`} aria-hidden>
      <span className="text-[10px] font-semibold uppercase tracking-wide">{d.toLocaleDateString("en-IN", { weekday: "short" })}</span>
      <span className="text-2xl font-semibold leading-none">{d.getDate()}</span>
      <span className="text-[10px] font-medium uppercase">{d.toLocaleDateString("en-IN", { month: "short" })}</span>
    </div>
  );
}
const timeOnly = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
const REQUEST_TONE: Record<string, string> = { PENDING: "bg-amber-100 text-amber-800", ACCEPTED: "bg-emerald-100 text-emerald-800", BOOKED: "bg-emerald-100 text-emerald-800", DECLINED: "bg-red-100 text-red-800", CANCELLED: "bg-slate-100 text-slate-600" };

/** The video call of one appointment, as steps: the time it opens, agreeing, "I am here", the waiting room, then Join. */
function VideoJoin({ video, appointmentId, patientId, onJoined }: { video: NonNullable<Appt["video"]>; appointmentId: string; patientId: string; onJoined: () => void }) {
  const [options, setOptions] = useState<PayOptions | null>(null);
  const [paying, setPaying] = useState(false);
  useEffect(() => { if (video.feeDue) void data<PayOptions>("payments/options").then(setOptions).catch(() => setOptions(null)); }, [video.feeDue]);
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
  const box = "mt-3 rounded-xl border p-3 text-sm";
  const online = options?.available === true;
  const feeCard = video.feeDue ? (
    <div className={`${box} border-amber-200 bg-amber-50 text-amber-900`} role="status">
      <div className="flex items-center justify-between gap-3"><div><div className="font-medium">Video consultation fee: ₹{video.feeDue}</div><p className="mt-0.5 text-xs">{video.payFirst ? "Please pay before the call." : "Please pay before or after the call."}{online ? "" : " Pay at the hospital counter."}</p></div>{online && !paying && <Btn onClick={() => setPaying(true)}>Pay online</Btn>}</div>
      {online && options && paying && <PayPanel kind="video" bill={{ id: appointmentId, due: video.feeDue }} patientId={patientId} options={options} onClose={() => setPaying(false)} onDone={() => { setPaying(false); onJoined(); }} />}
    </div>
  ) : null;
  if (!video.canJoin) return <>{feeCard}<div className={`${box} border-slate-200 bg-slate-50 text-slate-600`}><div className="font-medium text-slate-800">Video call opens soon</div><p className="mt-0.5 text-xs">You can join from {when(video.opensAt)}. A button will appear here.</p></div></>;
  if (video.feeDue && video.payFirst) return feeCard;
  return (
    <>
      {feeCard}
    <div className={`${box} border-blue-200 bg-blue-50/60`}>
      {video.doctorStarted ? (
        <div className="flex items-center justify-between gap-3">
          <div><div className="flex items-center gap-2 font-medium text-emerald-800"><span className="relative flex h-2.5 w-2.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" /></span>The doctor has started the call</div><p className="mt-0.5 text-xs text-slate-600">Tap Join to open the video room.</p></div>
          <Btn disabled={busy || !agree} onClick={() => void run("join")}>Join video call</Btn>
        </div>
      ) : waiting ? (
        <div role="status"><div className="flex items-center gap-2 font-medium text-blue-900"><span className="relative flex h-2.5 w-2.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-blue-500" /></span>You are in the waiting room</div><p className="mt-0.5 text-xs text-slate-600">The doctor has been told you are here. A Join button appears as soon as the doctor starts.</p></div>
      ) : (
        <div className="space-y-3">
          <div><div className="font-medium text-blue-900">Ready to join</div><p className="mt-0.5 text-xs text-slate-600">Press <b>I am here</b> to tell the doctor you are waiting.</p></div>
          {!video.consented && <label className="flex items-start gap-2 rounded-lg bg-white p-2.5 text-xs text-slate-700"><input type="checkbox" className="mt-0.5 h-4 w-4" checked={agree} onChange={(e) => setAgree(e.target.checked)} /><span>I agree to be consulted by video. I understand the doctor may advise me to visit the hospital if needed.</span></label>}
          <div className="[&>button]:w-full"><Btn disabled={busy || !agree} onClick={() => void run("arrive")}>{busy ? "Please wait…" : "I am here"}</Btn></div>
        </div>
      )}
      {err && <p role="alert" className="mt-2 rounded-lg bg-red-50 p-2 text-xs text-red-800">{err}</p>}
    </div>
    </>
  );
}

const TIMES: [string, string][] = [["ANY", "Any time"], ["MORNING", "Morning"], ["AFTERNOON", "Afternoon"], ["EVENING", "Evening"]];
const REASONS = ["Follow-up", "Fever", "Check-up", "Report review"];
/** A day counted from today in the phone's own time zone, as yyyy-mm-dd. */
const localDayPlus = (days: number) => { const d = new Date(); d.setDate(d.getDate() + days); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const chip = (on: boolean) => `rounded-full border px-3 py-1.5 text-xs font-medium transition ${on ? "border-blue-600 bg-blue-50 text-blue-700" : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"}`;

function Appointments({ patientId }: { patientId: string }) {
  const [appts, setAppts] = useState<{ upcoming: Appt[]; past: Appt[] } | null>(null);
  const [reqs, setReqs] = useState<Req[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [form, setForm] = useState({ practitionerId: "", preferredDate: "", timeOfDay: "ANY", reason: "", mode: "IN_PERSON" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentNote, setSentNote] = useState(false);
  const [fee, setFee] = useState<{ amount: string | null; online: boolean } | null>(null);
  const [payOpts, setPayOpts] = useState<PayOptions | null>(null);
  const [paying, setPaying] = useState(false);
  const load = useCallback(() => { void data<{ upcoming: Appt[]; past: Appt[] }>(`appointments?patientId=${patientId}`).then(setAppts); void data<Req[]>(`appointment-requests?patientId=${patientId}`).then(setReqs); }, [patientId]);
  useEffect(() => { load(); void data<Doctor[]>("doctors").then(setDoctors).catch(() => undefined); void data<PayOptions>("payments/options").then(setPayOpts).catch(() => setPayOpts(null)); }, [load]);
  useEffect(() => { setFee(null); void data<{ amount: string | null; online: boolean }>(`appointment-requests/fee?mode=${form.mode}${form.practitionerId ? `&practitionerId=${form.practitionerId}` : ""}`).then(setFee).catch(() => setFee(null)); }, [form.mode, form.practitionerId]);
  const mustPay = fee?.amount != null && fee.online && payOpts?.available === true;
  const submit = async () => { setBusy(true); setErr(null); setSentNote(false); try { await call("POST", "data/appointment-requests", { patientId, mode: form.mode, preferredDate: form.preferredDate, timeOfDay: form.timeOfDay, reason: form.reason.trim(), ...(form.practitionerId ? { practitionerId: form.practitionerId } : {}) }); setForm({ ...form, reason: "" }); setSentNote(true); load(); } catch (e) { setErr(e instanceof Error ? e.message : "Something went wrong"); } finally { setBusy(false); } };
  const cancel = async (id: string) => { try { await call("POST", `data/appointment-requests/${id}/cancel`, {}); load(); } catch (e) { setErr(e instanceof Error ? e.message : "Something went wrong"); } };
  const min = localDayPlus(0);
  const [next, ...later] = appts?.upcoming ?? [];
  return (
    <div className="space-y-4">
      <Card title="Coming up">
        {!appts ? <p className="text-sm text-slate-500">Loading…</p> : !next ? (
          <div className="flex items-center gap-3 rounded-xl bg-slate-50 p-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-700" aria-hidden>{svg(ICON.calendar)}</span>
            <div className="min-w-0 flex-1"><p className="text-sm font-semibold text-slate-800">No appointments booked</p><p className="text-xs text-slate-500">Ask for one below. The hospital will confirm a time.</p></div>
            <button type="button" onClick={() => document.getElementById("ask")?.scrollIntoView({ behavior: "smooth" })} className="shrink-0 rounded-lg bg-white px-3 py-2 text-xs font-semibold text-blue-700 shadow-sm ring-1 ring-slate-200">Book</button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-2xl border border-blue-200 bg-gradient-to-b from-blue-50/70 to-white p-3.5">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-blue-700">Your next visit</div>
              <div className="flex items-center gap-3">
                <DateBlock iso={next.startAt} />
                <div className="min-w-0"><div className="text-lg font-semibold text-slate-900">{timeOnly(next.startAt)}</div><div className="truncate text-sm font-medium text-slate-800">{next.doctor}</div>{next.specialty && <div className="truncate text-xs text-slate-500">{next.specialty}</div>}{next.video && <span className="mt-1 inline-block rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-800">Video consultation</span>}</div>
              </div>
              {next.video && <VideoJoin video={next.video} appointmentId={next.id} patientId={patientId} onJoined={load} />}
            </div>
            {later.length > 0 && <ul className="space-y-2">{later.map((a) => (
              <li key={a.id} className="rounded-xl border border-slate-200 p-3">
                <div className="flex items-center gap-3"><DateBlock iso={a.startAt} tone="slate" /><div className="min-w-0"><div className="font-semibold text-slate-900">{timeOnly(a.startAt)}</div><div className="truncate text-sm text-slate-700">{a.doctor}{a.specialty ? ` · ${a.specialty}` : ""}</div>{a.video && <span className="mt-1 inline-block rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-800">Video consultation</span>}</div></div>
                {a.video && <VideoJoin video={a.video} appointmentId={a.id} patientId={patientId} onJoined={load} />}
              </li>))}</ul>}
          </div>
        )}
      </Card>

      <div id="ask" className="scroll-mt-20">
      <Card title="Ask for an appointment">
        <div className="space-y-5">
          <div role="radiogroup" aria-label="Type of visit" className="grid grid-cols-2 gap-2">
            {([["IN_PERSON", "Visit the hospital", "See the doctor in person", ICON.hospital], ["VIDEO", "Video consultation", "Talk from home", ICON.video]] as const).map(([k, l, sub, icon]) => <button key={k} type="button" role="radio" aria-label={l} aria-checked={form.mode === k} onClick={() => setForm({ ...form, mode: k })} className={`flex flex-col items-start gap-1 rounded-2xl border p-3 text-left transition focus:outline-none focus-visible:ring-4 focus-visible:ring-blue-200 ${form.mode === k ? "border-blue-600 bg-blue-50 ring-2 ring-blue-100" : "border-slate-200 bg-white hover:bg-slate-50"}`}><span className={`mb-1 flex h-9 w-9 items-center justify-center rounded-lg ${form.mode === k ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-500"}`} aria-hidden>{svg(icon)}</span><span className={`text-sm font-semibold ${form.mode === k ? "text-blue-800" : "text-slate-800"}`}>{l}</span><span className="text-xs text-slate-500">{sub}</span></button>)}
          </div>
          {form.mode === "VIDEO" && <p className="rounded-xl bg-violet-50 p-3 text-xs text-violet-900">{fee === null ? "Checking the fee…" : fee.amount ? (fee.online ? `A video consultation is paid for online: ₹${fee.amount}. You pay, then the request is sent.` : `The video consultation fee is ₹${fee.amount}. Pay at the hospital counter.`) : "There is no fee for a video consultation."}</p>}
          <label className="block text-sm font-medium text-slate-700">Doctor <span className="font-normal text-slate-400">(optional)</span><select className={`${field} mt-1.5`} value={form.practitionerId} onChange={(e) => setForm({ ...form, practitionerId: e.target.value })}><option value="">Any doctor</option>{doctors.map((d) => <option key={d.id} value={d.id}>{d.name}{d.specialty ? ` · ${d.specialty}` : ""}</option>)}</select></label>
          <div>
            <label className="block text-sm font-medium text-slate-700">Preferred day<input type="date" min={min} className={`${field} mt-1.5`} value={form.preferredDate} onChange={(e) => setForm({ ...form, preferredDate: e.target.value })} /></label>
            <div className="mt-2 flex gap-1.5">{([["Today", 0], ["Tomorrow", 1], ["In a week", 7]] as const).map(([l, n]) => <button key={l} type="button" aria-pressed={form.preferredDate === localDayPlus(n)} onClick={() => setForm({ ...form, preferredDate: localDayPlus(n) })} className={chip(form.preferredDate === localDayPlus(n))}>{l}</button>)}</div>
          </div>
          <div>
            <span className="block text-sm font-medium text-slate-700">Time of day</span>
            <div className="mt-1.5 grid grid-cols-4 gap-1.5" role="radiogroup" aria-label="Time of day">
              {TIMES.map(([v, l]) => <button key={v} type="button" role="radio" aria-checked={form.timeOfDay === v} onClick={() => setForm({ ...form, timeOfDay: v })} className={`min-h-11 rounded-xl border px-1 text-[13px] font-medium transition ${form.timeOfDay === v ? "border-blue-600 bg-blue-50 text-blue-700" : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"}`}>{l}</button>)}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700">Reason<textarea rows={2} maxLength={300} className={`${field} mt-1.5 resize-none py-3`} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="For example: follow-up for fever" /></label>
            <div className="mt-2 flex flex-wrap gap-1.5">{REASONS.map((r) => <button key={r} type="button" onClick={() => setForm({ ...form, reason: r })} className={chip(form.reason === r)}>{r}</button>)}</div>
          </div>
          {err && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{err}</p>}
          {sentNote && <p role="status" className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">Your request was sent. The hospital will call or message you to confirm a time.</p>}
          {mustPay && payOpts && paying ? (
            <PayPanel kind="request" bill={{ id: patientId, due: fee!.amount! }} extra={{ patientId, mode: form.mode, preferredDate: form.preferredDate, timeOfDay: form.timeOfDay, reason: form.reason.trim(), ...(form.practitionerId ? { practitionerId: form.practitionerId } : {}) }} patientId={patientId} options={payOpts} onClose={() => setPaying(false)} onDone={() => { setPaying(false); setForm({ ...form, reason: "" }); setSentNote(true); load(); }} />
          ) : (
            <div className="[&>button]:w-full"><Btn disabled={busy || !form.preferredDate || form.reason.trim().length < 3} onClick={() => (mustPay ? setPaying(true) : void submit())}>{busy ? "Sending…" : mustPay ? `Pay ₹${fee!.amount} and send ${form.mode === "VIDEO" ? "video request" : "request"}` : "Send request"}</Btn></div>
          )}
          <p className="text-center text-xs text-slate-500">{!form.preferredDate ? "Choose a day to continue." : form.reason.trim().length < 3 ? "Write a short reason to continue." : "This is a request, not a booking yet."}</p>
        </div>
      </Card>
      </div>

      {reqs.length > 0 && (
        <Card title="Your requests">
          <ul className="space-y-2">{reqs.map((r) => (
            <li key={r.id} className="rounded-xl border border-slate-200 p-3 text-sm">
              <div className="flex items-center justify-between gap-2"><span className="font-semibold text-slate-900">{dayOnly(r.preferredDate)} · {r.timeOfDay.toLowerCase()}</span><span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${REQUEST_TONE[r.status] ?? "bg-slate-100 text-slate-600"}`}>{r.status === "PENDING" ? "waiting" : r.status.toLowerCase()}</span></div>
              <div className="mt-0.5 text-slate-700">{r.mode === "VIDEO" ? "Video · " : ""}{r.reason}{r.doctor ? ` · ${r.doctor}` : ""}</div>
              {r.answer && <div className="mt-2 rounded-lg bg-slate-50 p-2 text-slate-700"><span className="font-medium">Hospital:</span> {r.answer}</div>}
              {r.status === "PENDING" && <div className="mt-2"><Btn kind="plain" onClick={() => void cancel(r.id)}>Cancel request</Btn></div>}
            </li>))}</ul>
        </Card>
      )}
      {appts && appts.past.length > 0 && <Card title="Earlier"><ul className="divide-y divide-slate-100 text-sm">{appts.past.map((a) => <li key={a.id} className="flex items-center justify-between gap-2 py-2"><span><span className="font-medium text-slate-800">{dayOnly(a.startAt)}</span><span className="block text-xs text-slate-500">{a.doctor}</span></span><span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-600">{a.status.toLowerCase().replace(/_/g, " ")}</span></li>)}</ul></Card>}
    </div>
  );
}

const Loading = () => <p className="py-6 text-center text-sm text-slate-500">Loading…</p>;
function Empty({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return (
    <section className="flex flex-col items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-10 text-center shadow-sm">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400" aria-hidden>{icon}</span>
      <p className="text-sm font-medium text-slate-800">{title}</p>
      <p className="max-w-xs text-xs text-slate-500">{text}</p>
    </section>
  );
}
const svg = (d: string) => <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>;
const ICON = { calendar: "M7 3v3m10-3v3M4 8h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z", hospital: "M4 21V6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v15M3 21h18M12 8v6m-3-3h6M10 21v-3h4v3", video: "M4 7h11v10H4zM15 10l5-3v10l-5-3", pill: "M10.500 20.500a4.950 4.950 0 0 1-7-7l10-10a4.950 4.950 0 0 1 7 7zM8.500 8.500l7 7", flask: "M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.800 3h10.400a2 2 0 0 0 1.800-3l-5-9V3M7.500 15h9", bill: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6m-6 4h6m-6 4h3" };
/** A small coloured label that tells how a value sits against its range. */
const FLAG_LABEL: Record<string, string> = { NORMAL: "Normal", LOW: "Low", HIGH: "High", CRITICAL_LOW: "Very low", CRITICAL_HIGH: "Very high" };

/** Each signed visit: the doctor, the diagnosis and advice, and the prescription as one card per medicine. */
function Visits({ patientId }: { patientId: string }) {
  const [rows, setRows] = useState<Visit[] | null>(null);
  useEffect(() => { void data<Visit[]>(`visits?patientId=${patientId}`).then(setRows); }, [patientId]);
  if (!rows) return <Loading />;
  if (rows.length === 0) return <Empty icon={svg(ICON.pill)} title="No prescriptions yet" text="Your doctor's signed visits and prescriptions appear here after a consultation." />;
  return (
    <div className="space-y-4">{rows.map((v) => (
      <section key={v.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center gap-3">
          <DateBlock iso={v.date} tone="slate" />
          <div className="min-w-0"><div className="truncate text-base font-semibold text-slate-900">{v.doctor ?? "Doctor"}</div><div className="text-xs text-slate-500">Visit {v.visitNumber}</div></div>
        </div>
        {v.diagnoses.length > 0 && <div className="mt-3"><div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Diagnosis</div><div className="mt-1 flex flex-wrap gap-1.5">{v.diagnoses.map((d) => <span key={d} className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-800">{d}</span>)}</div></div>}
        {v.advice && <div className="mt-3 rounded-xl bg-slate-50 p-3"><div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Doctor's advice</div><p className="mt-1 text-sm text-slate-800">{v.advice}</p></div>}
        {v.prescription && (
          <div className="mt-4">
            <div className="flex items-center justify-between"><div className="text-sm font-semibold text-slate-900">Prescription</div>{v.prescription.number && <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-600">{v.prescription.number}</span>}</div>
            <ul className="mt-2 space-y-2">{v.prescription.medicines.map((m, i) => (
              <li key={i} className="flex gap-3 rounded-xl border border-slate-200 p-3">
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600" aria-hidden><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={ICON.pill} /></svg></span>
                <div className="min-w-0">
                  <div className="font-semibold text-slate-900">{m.name}</div>
                  <div className="mt-1 flex flex-wrap gap-1.5 text-xs">
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-700">{m.dose}</span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-700">{m.frequency}</span>
                    {m.days ? <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-700">{m.days} {m.days === 1 ? "day" : "days"}</span> : null}
                    {m.food && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-800">{m.food.toLowerCase().replace(/_/g, " ")}</span>}
                  </div>
                  {m.note && <p className="mt-1.5 text-xs text-slate-600">{m.note}</p>}
                </div>
              </li>))}</ul>
          </div>
        )}
      </section>))}</div>
  );
}

/** Lab values with a coloured label for how they sit against the range, and scan reports as findings and impression. */
function ReportsTab({ patientId }: { patientId: string }) {
  const [r, setR] = useState<Reports | null>(null);
  useEffect(() => { void data<Reports>(`reports?patientId=${patientId}`).then(setR); }, [patientId]);
  if (!r) return <Loading />;
  const none = r.lab.length === 0 && r.radiology.length === 0;
  return (
    <div className="space-y-4">
      {r.withheld > 0 && <p role="status" className="flex gap-2 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><span aria-hidden>⚠</span><span>{r.withheld === 1 ? "One report needs" : `${r.withheld} reports need`} your doctor to look at it first. The hospital will contact you.</span></p>}
      {none && <Empty icon={svg(ICON.flask)} title="No reports yet" text="Your lab and scan reports appear here once they are ready and released." />}
      {r.lab.map((l) => {
        const off = l.values.filter((v) => v.flag !== "NORMAL").length;
        return (
          <section key={l.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600" aria-hidden>{svg(ICON.flask)}</span><div><div className="font-semibold text-slate-900">{l.test}</div><div className="text-xs text-slate-500">Reported {dayOnly(l.reportedAt)}</div></div></div>
              <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${off === 0 ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>{off === 0 ? "All normal" : `${off} to note`}</span>
            </div>
            <ul className="mt-3 divide-y divide-slate-100">{l.values.map((v, i) => (
              <li key={i} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0"><div className="text-sm text-slate-800">{v.name}</div><div className="text-xs text-slate-500">Normal range {v.range}</div></div>
                <div className="shrink-0 text-right"><div className={`text-sm font-semibold ${v.flag === "NORMAL" ? "text-slate-900" : v.flag.startsWith("CRITICAL") ? "text-red-700" : "text-amber-700"}`}>{v.value} <span className="text-xs font-normal text-slate-500">{v.unit ?? ""}</span></div><span className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${FLAG[v.flag] ?? "bg-slate-100"}`}>{FLAG_LABEL[v.flag] ?? v.flag.replace("_", " ").toLowerCase()}</span></div>
              </li>))}</ul>
          </section>
        );
      })}
      {r.radiology.map((x) => (
        <section key={x.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-50 text-violet-600" aria-hidden>{svg("M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v8M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16")}</span><div><div className="font-semibold text-slate-900">{x.test}</div><div className="text-xs text-slate-500">{x.bodyPart} · Reported {dayOnly(x.reportedAt)}</div></div></div>
          <div className="mt-3"><div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Findings</div><p className="mt-1 text-sm text-slate-800">{x.findings}</p></div>
          <div className="mt-3 rounded-xl bg-blue-50 p-3"><div className="text-[11px] font-semibold uppercase tracking-wide text-blue-700">Impression</div><p className="mt-1 text-sm font-medium text-slate-900">{x.impression}</p></div>
        </section>))}
    </div>
  );
}

interface PayOptions { available: boolean; mode: "test" | null; methods: ("UPI" | "CARD")[] }
interface PaidReceipt { receiptNumber: string; amount: string; method: "UPI" | "CARD"; reference: string; mode: "test" }

const METHOD_NAME = { UPI: "UPI", CARD: "Debit or credit card" } as const;
const METHOD_ICON = {
  UPI: "M7 4h10a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm4 14h2M9 7h6",
  CARD: "M3.500 7a1.500 1.500 0 0 1 1.500-1.500h14A1.500 1.500 0 0 1 20.500 7v10a1.500 1.500 0 0 1-1.500 1.500H5A1.500 1.500 0 0 1 3.500 17zM3.500 10h17M7 15h3",
} as const;

/** Paying one bill online: choose UPI or card, pay, and get a receipt with what to do next (go to the reception). */
function PayPanel({ bill, patientId, options, onDone, onClose, kind = "bill", extra }: { bill: { id: string; due: string; number?: string | null }; patientId: string; options: PayOptions; onDone: () => void; onClose: () => void; kind?: "bill" | "video" | "request"; extra?: Record<string, unknown> }) {
  const [method, setMethod] = useState<"UPI" | "CARD">(options.methods[0] ?? "UPI");
  const [phase, setPhase] = useState<"choose" | "processing" | "paid">("choose");
  const [receipt, setReceipt] = useState<PaidReceipt | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // One key per bill: a second tap (or a retry after a bad connection) returns the same receipt and never charges twice.
  const [key] = useState(() => `${bill.id.slice(0, 8)}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`);
  const pay = async () => {
    setErr(null); setPhase("processing");
    try {
      // In test mode the checkout is simulated; the short wait mimics approving the payment in the UPI app or on the bank's page.
      await new Promise((r) => setTimeout(r, 1400));
      const r = await call<PaidReceipt>("POST", kind === "video" ? "data/payments/video-fee" : kind === "request" ? "data/appointment-requests/paid" : "data/payments/online", kind === "video" ? { patientId, appointmentId: bill.id, method, key } : kind === "request" ? { ...extra, method, key } : { patientId, invoiceId: bill.id, method, key });
      setReceipt(r); setPhase("paid");
    } catch (e) { setErr(e instanceof Error ? e.message : "The payment could not be made. Nothing was charged."); setPhase("choose"); }
  };
  if (phase === "paid" && receipt) {
    return (
      <div className="mt-3 rounded-2xl border border-emerald-200 bg-gradient-to-b from-emerald-50 to-white p-4" role="status">
        <div className="flex items-center gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-full bg-emerald-500 text-xl text-white" aria-hidden>✓</span><div><div className="text-base font-semibold text-slate-900">{kind === "request" ? "Paid and request sent" : "Payment received"}</div><div className="text-xs text-slate-600">{rupees(receipt.amount)} paid by {METHOD_NAME[receipt.method]}</div></div></div>
        <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-lg bg-white p-2.5 ring-1 ring-slate-200"><dt className="text-slate-500">Receipt number</dt><dd className="mt-0.5 text-sm font-semibold text-slate-900">{receipt.receiptNumber}</dd></div>
          <div className="rounded-lg bg-white p-2.5 ring-1 ring-slate-200"><dt className="text-slate-500">Payment reference</dt><dd className="mt-0.5 break-all text-sm font-semibold text-slate-900">{receipt.reference}</dd></div>
        </dl>
        <div className="mt-3 rounded-xl bg-blue-50 p-3 text-sm text-blue-900"><div className="font-semibold">What to do next</div>{kind === "request" ? <p className="mt-0.5 text-xs">Your request is sent (receipt <b>{receipt.receiptNumber}</b>). The front desk will book a time and you will see it here under <b>Your requests</b>. You do not need to go to the reception to pay.</p> : kind === "video" ? <p className="mt-0.5 text-xs">Your video consultation fee is paid (receipt <b>{receipt.receiptNumber}</b>). Nothing to do at the reception. When the call time comes, open this page and tap <b>Join video call</b>.</p> : <p className="mt-0.5 text-xs">Please go to the <b>reception</b> and say your name or show the receipt number <b>{receipt.receiptNumber}</b>. The reception will see this bill as paid and help you with the rest of your visit.</p>}</div>
        {receipt.mode === "test" && <p className="mt-2 text-center text-[11px] text-slate-500">Test mode: no real money was taken.</p>}
        <div className="mt-3 [&>button]:w-full"><Btn onClick={onDone}>Done</Btn></div>
      </div>
    );
  }
  return (
    <div className="mt-3 rounded-2xl border border-blue-200 bg-blue-50/40 p-4">
      <div className="flex items-start justify-between gap-2"><div><div className="text-base font-semibold text-slate-900">Pay {rupees(bill.due)} online</div><div className="text-xs text-slate-500">{kind === "video" ? "Video consultation fee" : kind === "request" ? (extra?.mode === "VIDEO" ? "Video consultation fee" : "Appointment request fee") : `Bill ${bill.number ?? ""}`}</div></div><button type="button" className="text-xs text-slate-500 underline" onClick={onClose} disabled={phase === "processing"}>Close</button></div>
      {options.mode === "test" && <p className="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-900">Test mode: this is a practice checkout. No real money moves.</p>}
      <div className="mt-3 grid grid-cols-2 gap-2" role="radiogroup" aria-label="How do you want to pay">
        {options.methods.map((m) => (
          <button key={m} type="button" role="radio" aria-checked={method === m} disabled={phase === "processing"} onClick={() => setMethod(m)} className={`flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border p-2 text-sm font-medium transition ${method === m ? "border-blue-600 bg-white text-blue-700 ring-2 ring-blue-100" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={METHOD_ICON[m]} /></svg>{m === "UPI" ? "UPI" : "Card"}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-slate-600">{method === "UPI" ? "You will approve this payment in your UPI app (Google Pay, PhonePe, Paytm or any other)." : "Your card details are entered only on your bank's secure page, never here."}</p>
      {err && <p role="alert" className="mt-2 rounded-lg bg-red-50 p-2 text-xs text-red-800">{err}</p>}
      <div className="mt-3 [&>button]:w-full"><Btn disabled={phase === "processing"} onClick={() => void pay()}>{phase === "processing" ? (method === "UPI" ? "Waiting for your approval…" : "Contacting your bank…") : `Pay ${rupees(bill.due)} by ${method === "UPI" ? "UPI" : "card"}`}</Btn></div>
    </div>
  );
}

/** What is owed across all bills first, then each bill with its split and a bar of how much is paid, and a way to pay online. */
function Bills({ patientId }: { patientId: string }) {
  const [rows, setRows] = useState<Bill[] | null>(null);
  const [options, setOptions] = useState<PayOptions | null>(null);
  const [paying, setPaying] = useState<string | null>(null);
  const load = useCallback(() => { void data<Bill[]>(`bills?patientId=${patientId}`).then(setRows); }, [patientId]);
  useEffect(() => { load(); void data<PayOptions>("payments/options").then(setOptions).catch(() => setOptions({ available: false, mode: null, methods: [] })); }, [load]);
  if (!rows) return <Loading />;
  if (rows.length === 0) return <Empty icon={svg(ICON.bill)} title="No bills yet" text="Your bills and receipts appear here after a visit." />;
  const owed = rows.reduce((n, b) => n + Number(b.due), 0);
  const online = options?.available === true;
  return (
    <div className="space-y-4">
      <section className={`rounded-2xl border p-4 ${owed > 0 ? "border-red-200 bg-gradient-to-b from-red-50 to-white" : "border-emerald-200 bg-gradient-to-b from-emerald-50 to-white"}`}>
        <div className={`text-[11px] font-semibold uppercase tracking-wide ${owed > 0 ? "text-red-700" : "text-emerald-700"}`}>{owed > 0 ? "Amount to pay" : "All paid"}</div>
        <div className="mt-1 text-3xl font-semibold tracking-tight text-slate-900">{rupees(String(owed))}</div>
        <p className="mt-1 text-xs text-slate-600">{owed > 0 ? (online ? "Pay online with UPI or card, or at the hospital counter." : "To pay a bill, please visit the hospital counter.") : "You have nothing to pay. Thank you."}</p>
      </section>
      {rows.map((b) => {
        const total = Number(b.total); const paid = Number(b.paid); const pct = total > 0 ? Math.min(100, Math.round((paid / total) * 100)) : 100; const due = Number(b.due) > 0;
        return (
          <section key={b.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-2"><div><div className="font-semibold text-slate-900">{b.number ?? "Bill"}</div><div className="text-xs text-slate-500">Issued {dayOnly(b.issuedAt)}</div></div><span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${due ? "bg-red-100 text-red-800" : "bg-emerald-100 text-emerald-800"}`}>{due ? "To pay" : "Paid"}</span></div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100" role="img" aria-label={`${pct}% paid`}><span className={`block h-full rounded-full ${due ? "bg-blue-500" : "bg-emerald-500"}`} style={{ width: `${pct}%` }} /></div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
              <div><div className="text-xs text-slate-500">Total</div><div className="font-medium text-slate-900">{rupees(b.total)}</div></div>
              <div><div className="text-xs text-slate-500">Paid</div><div className="font-medium text-slate-900">{rupees(b.paid)}</div></div>
              <div><div className="text-xs text-slate-500">To pay</div><div className={`font-semibold ${due ? "text-red-700" : "text-slate-900"}`}>{rupees(b.due)}</div></div>
            </div>
            {due && online && paying !== b.id && <div className="mt-3 [&>button]:w-full"><Btn onClick={() => setPaying(b.id)}>Pay {rupees(b.due)} online</Btn></div>}
            {due && online && options && paying === b.id && <PayPanel bill={b} patientId={patientId} options={options} onClose={() => setPaying(null)} onDone={() => { setPaying(null); load(); }} />}
            {b.receipts.length > 0 && <div className="mt-3 rounded-xl bg-slate-50 p-3"><div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Receipts</div><ul className="mt-1.5 space-y-1 text-xs text-slate-700">{b.receipts.map((r) => <li key={r.number} className="flex justify-between gap-2"><span>{r.number} · {dayOnly(r.at)}</span><span className="font-medium">{rupees(r.amount)}</span></li>)}</ul></div>}
          </section>
        );
      })}
    </div>
  );
}

/** Lets a signed-in patient choose (or change) a password, so next time the mobile number and the password are enough. */
function PasswordCard() {
  const [set, setSet] = useState<boolean | null>(null);
  const [uname, setUname] = useState("");
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { data<{ set: boolean; username: string | null }>("password").then((r) => { setSet(r.set); setUname(r.username ?? ""); }).catch(() => setSet(null)); }, []);
  if (set === null) return null;
  const save = async () => {
    setMsg(null);
    if (pw !== again) { setMsg({ ok: false, text: "The two passwords are not the same" }); return; }
    setBusy(true);
    try { await call("POST", "data/password", { username: uname.trim().toLowerCase(), password: pw }); setSet(true); setOpen(false); setPw(""); setAgain(""); setMsg({ ok: true, text: "Password saved. Next time sign in with your username and this password." }); }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : "The password could not be saved" }); } finally { setBusy(false); }
  };
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 text-sm shadow-sm" aria-label="Password">
      <div className="flex items-center justify-between gap-3">
        <div><div className="font-semibold text-slate-900">{set ? "Password sign-in is on" : "Sign in faster next time"}</div><div className="text-xs text-slate-500">{set ? `Your username is ${uname}.` : "Choose a username and password and skip the SMS code."}</div></div>
        {!open && <Btn kind="plain" onClick={() => { setOpen(true); setMsg(null); }}>{set ? "Change" : "Set password"}</Btn>}
      </div>
      {open && (
        <form className="mt-3 space-y-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <label className="block font-medium text-slate-700">Username<input className={`${field} mt-1.5`} autoCapitalize="none" autoCorrect="off" autoComplete="username" value={uname} onChange={(e) => setUname(e.target.value)} placeholder="e.g. nani.rupesh" /></label>
          <label className="block font-medium text-slate-700">New password<input className={`${field} mt-1.5`} type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
          <label className="block font-medium text-slate-700">Type it again<input className={`${field} mt-1.5`} type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></label>
          <p className="text-xs text-slate-500">Username: 4 or more letters, numbers or . _ @ + -. Password: at least 8 characters, with letters and a number.</p>
          <div className="grid grid-cols-2 gap-2"><Btn disabled={busy || pw.length < 8 || uname.trim().length < 4} onClick={() => void save()}>{busy ? "Saving…" : "Save password"}</Btn><Btn kind="plain" disabled={busy} onClick={() => { setOpen(false); setPw(""); setAgain(""); setMsg(null); }}>Cancel</Btn></div>
        </form>
      )}
      {msg && <p role={msg.ok ? "status" : "alert"} className={`mt-3 rounded-lg p-2 text-xs ${msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"}`}>{msg.text}</p>}
    </section>
  );
}

/** A number can be shared by a family: the code proves the phone, so each person confirms their own date of birth before their records open. */
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
      <header className="rounded-2xl bg-gradient-to-br from-blue-600 to-blue-800 p-4 text-white shadow-md">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 truncate text-xs font-medium text-blue-100">{me.hospital}</div>
          <button type="button" onClick={() => void signOut()} className="shrink-0 rounded-lg bg-white/15 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/25 focus:outline-none focus-visible:ring-4 focus-visible:ring-white/40">Sign out</button>
        </div>
        <div className="mt-3 flex min-w-0 items-center gap-3">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-white text-lg font-bold text-blue-700 shadow-sm" aria-hidden>{(current?.name ?? "P").split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("")}</span>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold">{current?.name ?? "Patient"}</h1>
            {current && !current.locked && <div className="mt-1 flex flex-wrap gap-1.5 text-xs">{[current.mrn, current.age !== null ? `${current.age} yrs` : null].filter(Boolean).map((v) => <span key={v} className="rounded-full bg-white/15 px-2.5 py-0.5">{v}</span>)}</div>}
          </div>
        </div>
      </header>
      {me.patients.length > 1 && <label className="block text-sm">Showing records of<select className={field} value={pid} onChange={(e) => setPid(e.target.value)}>{me.patients.map((p) => <option key={p.id} value={p.id}>{p.name}{p.mrn ? ` · ${p.mrn}` : ""}</option>)}</select></label>}
      {current?.locked && <Unlock profile={current} key={`u${current.id}`} onDone={load} />}
      {!current?.locked && <nav className="sticky top-0 z-10 grid grid-cols-4 gap-1 rounded-2xl border border-slate-200 bg-white/95 p-1.5 text-xs shadow-sm backdrop-blur" role="tablist">
        {([["appointments", "Visits to come", ICON.calendar], ["visits", "Prescriptions", ICON.pill], ["reports", "Reports", ICON.flask], ["bills", "Bills", ICON.bill]] as const).map(([k, l, icon]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl px-0.5 transition ${tab === k ? "bg-blue-50 font-semibold text-blue-700" : "text-slate-500 hover:bg-slate-50 hover:text-slate-800"}`}><span aria-hidden>{svg(icon)}</span>{l}</button>)}
      </nav>}
      {pid && !current?.locked && tab === "appointments" && <Appointments patientId={pid} key={`a${pid}`} />}
      {pid && !current?.locked && tab === "visits" && <Visits patientId={pid} key={`v${pid}`} />}
      {pid && !current?.locked && tab === "reports" && <ReportsTab patientId={pid} key={`r${pid}`} />}
      {pid && !current?.locked && tab === "bills" && <Bills patientId={pid} key={`b${pid}`} />}
      <PasswordCard />
    </main>
  );
}
