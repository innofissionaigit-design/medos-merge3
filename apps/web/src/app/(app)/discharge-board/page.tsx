"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Gate } from "@/components/gate";
import { Icon, type IconName, PANEL } from "@/components/desk-ui";
import { FlowReportView, InsurerBoard, MyWorkList, WaitingBoard, type Flow } from "@/components/discharge-flow";
import { PageHeader } from "@/components/ui";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useMe } from "@/lib/me";

type Tab = "waiting" | "mine" | "insurer" | "report";

/** 125 minutes -> "2h 5m": the longest wait reads at a glance. */
const hm = (m: number): string => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);

/**
 * Going home (docs/discharge-flow.md): everyone who has been told they may go and has not yet left, longest wait first, with what is holding each
 * one up; each person's own pending items; the insurers still to reply; and the management figures.
 */
export default function DischargeBoardPage() {
  const { can } = useMe();
  const t = useT();
  const [tab, setTab] = useState<Tab>("waiting");
  // The same request the "Waiting to go home" tab makes (one shared copy), counted for the tiles above the tabs.
  const board = useQuery({ queryKey: ["flow-board"], queryFn: () => api.get<{ waiting: Flow[]; insurerWaiting: Flow[]; capped: boolean }>("/discharge-flow/board"), refetchInterval: 20_000 });
  const waiting = board.data?.waiting ?? [];
  const overdue = waiting.filter((w) => w.clock.state === "OVERDUE").length;
  const longest = Math.max(0, ...waiting.map((w) => w.clock.elapsedMinutes));
  const tiles: { label: string; value: string; icon: IconName; tone: string }[] = [
    { label: "Waiting to go home", value: String(waiting.length), icon: "bed", tone: "bg-teal-50 text-teal-700" },
    { label: "Overdue", value: String(overdue), icon: "alert", tone: overdue > 0 ? "bg-red-50 text-red-700" : "bg-teal-50 text-teal-700" },
    { label: "Longest wait", value: waiting.length ? hm(longest) : "—", icon: "clock", tone: "bg-amber-50 text-amber-700" },
    { label: "Insurer replies pending", value: String(board.data?.insurerWaiting.length ?? 0), icon: "chart", tone: "bg-blue-50 text-blue-700" },
  ];
  const tabs: { id: Tab; label: string }[] = [
    { id: "waiting", label: "Waiting to go home" }, { id: "mine", label: "My work" }, { id: "insurer", label: "Insurer replies" },
    ...(can("REPORT_READ", "REPORT_IPD") ? [{ id: "report" as const, label: "Report" }] : []),
  ];
  return (
    <Gate anyOf={["ADMISSION_READ"]} feature="IPD_ENABLED">
      <div className="-mx-4 -mb-4 min-h-[calc(100vh-8rem)] bg-white p-4 md:-mx-6 md:-mb-6 md:px-6 md:py-4">
        <PageHeader title="Going home" subtitle="Patients cleared to leave, and what is holding each one up" />
        <div className="mb-3 grid grid-cols-2 gap-2.5 md:grid-cols-4">
          {tiles.map((x) => (
            <div key={x.label} className={`${PANEL} flex items-center gap-2.5 px-3.5 py-2`}>
              <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${x.tone}`}><Icon name={x.icon} /></span>
              <div className="min-w-0">
                <div className="text-[10.5px] font-medium uppercase leading-tight tracking-wider text-slate-500">{t(x.label)}</div>
                <div className="text-lg font-semibold tabular-nums leading-tight text-slate-900">{board.data ? x.value : "—"}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="mb-3 flex flex-wrap gap-1 rounded-lg bg-slate-100 p-0.5" role="tablist">
          {tabs.map((x) => (
            <button key={x.id} type="button" role="tab" aria-selected={tab === x.id} onClick={() => setTab(x.id)} className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${tab === x.id ? "bg-white text-brand-700 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}>{t(x.label)}</button>
          ))}
        </div>
        {/* The tabs' own cards and tables take the same soft look, without changing what they show or do. */}
        <div className="space-y-4 [&_section]:rounded-xl [&_section]:border-slate-100 [&_section]:shadow-[0_1px_3px_rgba(15,23,42,0.06)] [&_section>header]:border-slate-100 [&_thead]:border-slate-100 [&_thead]:text-[11px] [&_thead]:tracking-wider [&_thead]:text-slate-400 [&_tbody_tr:hover]:bg-slate-50/70">
          {tab === "waiting" && <WaitingBoard />}
          {tab === "mine" && <MyWorkList />}
          {tab === "insurer" && <InsurerBoard />}
          {tab === "report" && <FlowReportView />}
        </div>
      </div>
    </Gate>
  );
}
