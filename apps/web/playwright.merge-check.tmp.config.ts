// Temporary (merge verification only): the repository's Playwright config, run in the Google Chrome installed on this PC
// instead of Playwright's downloaded Chromium. Delete after use.
import base from "./playwright.config";
import { defineConfig } from "@playwright/test";

const servers = (Array.isArray(base.webServer) ? base.webServer : [base.webServer!]).map((s) => ({ ...s, env: { ...s.env, PRISMA_ENGINES_CACHE_DIR: process.env["LOCALAPPDATA"] + "\\prisma-cache" } }));
export default defineConfig({ ...base, webServer: servers, projects: [{ name: "chrome", use: { browserName: "chromium", channel: "chrome" } }] });
