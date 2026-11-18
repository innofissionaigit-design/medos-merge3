"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Gate } from "@/components/gate";
import { RegisterPatient } from "@/components/register-patient";
import { patientName, type PatientRow } from "@/components/shell";
import { Button, Card, ErrorNote, Input, PageHeader, Spinner, Table, Td, useDebounced } from "@/components/ui";
import { api } from "@/lib/api";
import { ageText } from "@/lib/format";
import { useMe } from "@/lib/me";

export default function PatientsPage() {
  const { can, date } = useMe();
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  // "Register a new patient" in the appointment booking search opens this page with the form already open.
  useEffect(() => { if (can("PATIENT_CREATE") && new URLSearchParams(window.location.search).get("register") === "1") setAdding(true); }, [can]);
  const term = useDebounced(q.trim(), 250);
  const res = useQuery({ queryKey: ["patients", term], queryFn: () => api.page<PatientRow & { createdAt: string }>("/patients", { q: term, pageSize: 25 }), enabled: term.length >= 2 });
  return (
    <Gate anyOf={["PATIENT_READ"]}>
      <PageHeader title="Patients" subtitle="Search by MRN, mobile number or name" actions={can("PATIENT_CREATE") ? <Button onClick={() => setAdding(true)}>Register patient</Button> : undefined} />
      <Card>
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type at least 2 characters…" aria-label="Search patients" className="mb-3 max-w-md" />
        {term.length < 2 ? <p className="py-6 text-center text-sm text-slate-500">Start typing to find a patient.</p>
          : res.isLoading ? <Spinner />
          : <>
            <ErrorNote error={res.error} />
            <Table head={["Name", "MRN", "Gender / age", "Mobile", "Registered"]} {...(res.data?.data.length === 0 ? { empty: "No patients match. Check the spelling or register a new patient." } : {})}>
              {res.data?.data.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50">
                  <Td><Link className="font-medium text-brand-700 hover:underline" href={`/patients/${p.id}`}>{patientName(p)}</Link></Td>
                  <Td>{p.mrn}</Td><Td>{p.gender.toLowerCase()}{ageText(p.age) ? `, ${ageText(p.age)}` : ""}</Td><Td>{p.mobile ?? "—"}</Td><Td>{date(p.createdAt)}</Td>
                </tr>
              ))}
            </Table>
          </>}
      </Card>
      {adding && <RegisterPatient onClose={() => setAdding(false)} />}
    </Gate>
  );
}
