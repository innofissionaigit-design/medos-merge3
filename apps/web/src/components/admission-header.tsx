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

const button = "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50";

/** A small labelled fact: what it is above, the value below. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  const t = useT();
  return <div className="min-w-0"><dt className="text-xs uppercase tracking-wide text-slate-500">{t(label)}</dt><dd className="mt-0.5 break-words text-sm font-medium text-slate-900">{children}</dd></div>;
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
  return (
    <header className="mb-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand-50 text-base font-semibold text-brand-700 ring-1 ring-brand-200" aria-hidden>{initials}</span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-2xl font-semibold tracking-tight text-slate-900">{a.patientName}</h1>
              <span className={clsx("rounded-full px-2.5 py-0.5 text-xs font-medium ring-1", st.tone)}>{t(st.label)}</span>
            </div>
            <p className="mt-1 text-sm text-slate-600">{`${t("Admission")} ${a.admissionNumber}${a.mrn ? ` · MRN ${a.mrn}` : ""}`}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/patients/${a.patientId}`} className={button}>{t("Patient record")}</Link>
          {a.status !== "CANCELLED" && (
            <span className="flex flex-wrap items-center gap-2" role="group" aria-label={t("Admission form")}>
              <PrintLink className={button} href={form}>{t("Print admission form")}</PrintLink>
              <a download className={button} href={`${form}?format=pdf&download=1`}>PDF</a>
              <PrintLink className={button} href={`${form}?lang=bn`}>বাংলা</PrintLink>
              <PrintLink className={button} href={`${form}?lang=hi`}>हिन्दी</PrintLink>
            </span>
          )}
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-4">
        <Fact label="Bed">{a.bed ? <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5"><span className="rounded-md bg-slate-900 px-2 py-0.5 text-xs font-semibold text-white">{a.bed.code}</span><span className="font-normal text-slate-600">{a.bed.ward}</span></span> : <span className="font-normal text-slate-500">{a.status === "ADMITTED" ? t("No bed") : t("Bed released")}</span>}</Fact>
        <Fact label="Consultant">{a.consultantName}</Fact>
        <Fact label="Admitted">{dateTime(a.admittedAt)}</Fact>
        <Fact label="Stay">{day}</Fact>
      </dl>

      {a.reason && (
        <figure className="mt-3 rounded-md border-l-4 border-brand-300 bg-slate-50 px-4 py-3">
          <figcaption className="text-xs font-medium uppercase tracking-wide text-slate-500">{t("Reason for admission")}</figcaption>
          <blockquote className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{a.reason}</blockquote>
        </figure>
      )}

      {a.planned && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-900">
          <span>
            <b>{`${t("Planned admission")} ${a.planned.requestNumber}`}</b>
            <span className="ml-2 text-brand-800">{`${t("Estimate")} ${money(a.planned.estimate)} · ${t("deposit held")} ${money(a.planned.depositHeld)}`}</span>
            <span className="mt-0.5 block text-xs text-brand-700">{t("The deposit is set against the final bill by the cashier (advance payments).")}</span>
          </span>
          <Link className="whitespace-nowrap rounded-md border border-brand-300 bg-white px-3 py-1.5 text-sm font-medium text-brand-700 hover:bg-brand-50" href={`/planned/${a.planned.id}`}>{t("Open the request")}</Link>
        </div>
      )}
      {a.status === "DISCHARGED" && a.dischargedAt && <p className="mt-3 text-sm text-slate-600">{`${t("Discharged on")} ${date(a.dischargedAt)}.`}</p>}
    </header>
  );
}
