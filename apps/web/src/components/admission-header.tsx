"use client";
import Link from "next/link";
import clsx from "clsx";
import { PrintLink } from "@/components/print-link";
import { printUrl } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useMe } from "@/lib/me";

export interface AdmissionHeaderData {
  id: string; admissionNumber: string; status: string; patientId: string; patientName: string; mrn: string | null; consultantName: string; reason: string | null;
  admittedAt: string; dischargedAt: string | null; lengthOfStayDays: number;
  bed: { code: string; ward: string; room: string } | null;
  planned?: { id: string; requestNumber: string; estimate: string; depositHeld: string } | null;
}

const STATUS: Record<string, { label: string; tone: string }> = {
  ADMITTED: { label: "Admitted", tone: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  DISCHARGED: { label: "Discharged", tone: "bg-slate-100 text-slate-700 ring-slate-300" },
  CANCELLED: { label: "Cancelled", tone: "bg-red-50 text-red-700 ring-red-200" },
};

/** A small labelled fact: what it is above, the value below. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  const t = useT();
  return <div className="min-w-0"><dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{t(label)}</dt><dd className="mt-0.5 break-words text-sm font-medium text-slate-900">{children}</dd></div>;
}

/**
 * The top of an admission: who the patient is, where they are and with whom, why they were admitted, the forms to print, and the planned admission it came from.
 * It only shows what the admission already holds; every action below it is unchanged.
 */
export function AdmissionHeader({ a }: { a: AdmissionHeaderData }) {
  const t = useT();
  const { dateTime, date, money } = useMe();
  const st = STATUS[a.status] ?? { label: a.status.toLowerCase(), tone: "bg-slate-100 text-slate-700 ring-slate-300" };
  const initials = a.patientName.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
  const form = printUrl(`admission-forms/${a.id}`);
  const day = a.status === "ADMITTED" ? `${t("Day")} ${a.lengthOfStayDays + 1}` : a.dischargedAt ? `${a.lengthOfStayDays} ${a.lengthOfStayDays === 1 ? t("day") : t("days")}` : `${a.lengthOfStayDays} ${t("days")}`;
  const chip = "inline-flex items-center rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm transition hover:border-blue-300 hover:bg-blue-50/50 hover:text-blue-700";
  return (
    <header className="mb-6 overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_8px_24px_-12px_rgba(16,24,40,0.12)]">
      <div className="h-1 bg-gradient-to-r from-blue-500 via-blue-400 to-sky-300" aria-hidden />
      <div className="flex flex-wrap items-start justify-between gap-4 px-6 pt-5">
        <div className="flex min-w-0 items-center gap-4">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-blue-700 text-lg font-semibold text-white shadow-md shadow-blue-600/20" aria-hidden>{initials}</span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="truncate text-2xl font-semibold tracking-tight text-slate-900">{a.patientName}</h1>
              <span className={clsx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1", st.tone)}><span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />{t(st.label)}</span>
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-500"><span>{`${t("Admission")} ${a.admissionNumber}`}</span>{a.mrn && <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">{`MRN ${a.mrn}`}</span>}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/patients/${a.patientId}`} className="inline-flex items-center rounded-lg bg-blue-600 px-3.5 py-1.5 text-sm font-medium text-white shadow-sm shadow-blue-600/20 hover:bg-blue-700">{t("Patient record")}</Link>
          {a.status !== "CANCELLED" && (
            <span className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("Admission form")}>
              <PrintLink className={chip} href={form}>{t("Print admission form")}</PrintLink>
              <a download className={chip} href={`${form}?format=pdf&download=1`}>PDF</a>
              <PrintLink className={chip} href={`${form}?lang=bn`}>বাংলা</PrintLink>
              <PrintLink className={chip} href={`${form}?lang=hi`}>हिन्दी</PrintLink>
            </span>
          )}
        </div>
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-slate-100 bg-slate-50/50 px-6 py-4 sm:grid-cols-4">
        <Fact label="Bed">{a.bed ? <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5"><span className="rounded-md bg-slate-900 px-2 py-0.5 text-xs font-semibold text-white">{a.bed.code}</span><span className="font-normal text-slate-600">{a.bed.ward}</span></span> : <span className="font-normal text-slate-500">{a.status === "ADMITTED" ? t("No bed") : t("Bed released")}</span>}</Fact>
        <Fact label="Consultant">{a.consultantName}</Fact>
        <Fact label="Admitted">{dateTime(a.admittedAt)}</Fact>
        <Fact label="Stay"><span className="inline-flex items-center rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-semibold text-blue-700 ring-1 ring-blue-200">{day}</span></Fact>
      </dl>

      {a.reason && (
        <figure className="flex items-start gap-3 border-t border-slate-100 px-6 py-3.5">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600" aria-hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M12 8v5m0 3.5h.01M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg></span>
          <div className="min-w-0"><figcaption className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{t("Reason for admission")}</figcaption><blockquote className="mt-0.5 whitespace-pre-wrap text-sm text-slate-800">{a.reason}</blockquote></div>
        </figure>
      )}

      {a.planned && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-blue-100 bg-blue-50/60 px-6 py-3 text-sm text-blue-900">
          <span>
            <b>{`${t("Planned admission")} ${a.planned.requestNumber}`}</b>
            <span className="ml-2 text-blue-800">{`${t("Estimate")} ${money(a.planned.estimate)} · ${t("deposit held")} ${money(a.planned.depositHeld)}`}</span>
            <span className="mt-0.5 block text-xs text-blue-700">{t("The deposit is set against the final bill by the cashier (advance payments).")}</span>
          </span>
          <Link className="whitespace-nowrap rounded-lg border border-blue-200 bg-white px-3 py-1.5 text-sm font-medium text-blue-700 shadow-sm hover:bg-blue-50" href={`/planned/${a.planned.id}`}>{t("Open the request")}</Link>
        </div>
      )}
      {a.status === "DISCHARGED" && a.dischargedAt && <p className="border-t border-slate-100 px-6 py-3 text-sm text-slate-600">{`${t("Discharged on")} ${date(a.dischargedAt)}.`}</p>}
    </header>
  );
}
