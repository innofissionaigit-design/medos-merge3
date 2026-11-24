import { z } from "zod";
import { csrfOk, forbidden, PORTAL, setPatientSession } from "@/lib/patient-server";

const schema = z.object({ hospitalCode: z.string().min(2).max(40), username: z.string().min(1).max(64), password: z.string().min(1).max(128) }).strict();

/** Checks the username and password with the API and keeps the session token in an httpOnly cookie; the page only learns that it worked. */
export async function POST(req: Request): Promise<Response> {
  if (!csrfOk(req)) return forbidden();
  const input = schema.safeParse(await req.json().catch(() => null));
  if (!input.success) return Response.json({ error: { code: "VALIDATION_FAILED", message: "Enter your username and password" } }, { status: 400 });
  const forwardedFor = req.headers.get("x-forwarded-for")?.slice(0, 512);
  const res = await fetch(`${PORTAL}/auth/login`, { method: "POST", headers: { "content-type": "application/json", ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}) }, body: JSON.stringify(input.data), cache: "no-store" }).catch(() => null);
  if (!res) return Response.json({ error: { code: "UNAVAILABLE", message: "Please try again in a moment" } }, { status: 502 });
  const json = (await res.json().catch(() => ({}))) as { data?: { token: string; expiresAt: string }; error?: unknown };
  if (!res.ok || !json.data) return Response.json(json, { status: res.status });
  await setPatientSession(json.data.token, json.data.expiresAt);
  return Response.json({ data: { signedIn: true } });
}
