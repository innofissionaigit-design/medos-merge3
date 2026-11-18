"use client";
import { useCallback, useEffect, useState } from "react";

export type TempUnit = "C" | "F";
const KEY = "medos.tempUnit";
const EVENT = "medos-temp-unit";

/** Temperatures are stored in °C. These are for showing and typing in °F. */
export const cToF = (c: number): number => (c * 9) / 5 + 32;
export const fToC = (f: number): number => ((f - 32) * 5) / 9;

/** A stored °C reading shown in the chosen unit, to one decimal place. */
export function showTemp(valueC: string | number, unit: TempUnit): string {
  const c = Number(valueC);
  if (!Number.isFinite(c)) return String(valueC);
  return (unit === "F" ? cToF(c) : c).toFixed(1);
}

const read = (): TempUnit => { try { return window.localStorage.getItem(KEY) === "F" ? "F" : "C"; } catch { return "C"; } };

/** The unit this person prefers for temperature (remembered in this browser, shared by every vitals screen). */
export function useTempUnit(): [TempUnit, (u: TempUnit) => void] {
  const [unit, setUnit] = useState<TempUnit>("C");
  useEffect(() => {
    setUnit(read());
    const on = () => setUnit(read());
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  const set = useCallback((u: TempUnit) => {
    try { window.localStorage.setItem(KEY, u); } catch { /* storage unavailable: the choice lasts for this screen only */ }
    setUnit(u);
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return [unit, set];
}
