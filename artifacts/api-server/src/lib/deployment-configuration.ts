import { existsSync } from "node:fs";
import path from "node:path";
import { validateObjectStorageConfiguration } from "./objectStorage";

/**
 * Settings a deployed (NODE_ENV=production) service cannot run correctly without. Returns the
 * names of the settings at fault, never their values. Development keeps its own defaults.
 */
export function deploymentConfigurationProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.NODE_ENV !== "production") return [];
  const problems: string[] = [];
  // Signs phone-verification digests, rate-limit keys and policy tokens.
  if ((env.SESSION_SECRET ?? "").length < 32) problems.push("SESSION_SECRET");
  // Provider adapters fail closed without an explicit environment label.
  if (env.DINAR_DEPLOYMENT_ENV !== "staging" && env.DINAR_DEPLOYMENT_ENV !== "production")
    problems.push("DINAR_DEPLOYMENT_ENV");
  try {
    validateObjectStorageConfiguration(env);
  } catch {
    problems.push("OBJECT_STORAGE_PROVIDER");
  }
  if (env.APP_ORIGIN !== undefined) {
    let valid = false;
    try {
      const url = new URL(env.APP_ORIGIN);
      valid = (url.protocol === "https:" || url.protocol === "http:") && url.origin === env.APP_ORIGIN.replace(/\/$/, "");
    } catch {
      valid = false;
    }
    if (!valid) problems.push("APP_ORIGIN");
  }
  if (env.APP_ADDITIONAL_ORIGINS !== undefined && additionalAppOrigins(env) === undefined) problems.push("APP_ADDITIONAL_ORIGINS");
  if (env.DINAR_WEB_DIST !== undefined && !existsSync(path.join(env.DINAR_WEB_DIST, "index.html")))
    problems.push("DINAR_WEB_DIST");
  return problems;
}

/**
 * Extra exact origins that may send state-changing requests, besides APP_ORIGIN (for example a
 * custom domain alongside the platform URL during a domain move). HTTPS only, exact origins, at
 * most five; any malformed entry makes the whole setting invalid (undefined) rather than partly used.
 */
export function additionalAppOrigins(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const raw = env.APP_ADDITIONAL_ORIGINS;
  if (raw === undefined || raw.trim() === "") return [];
  const entries = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length > 5) return undefined;
  const origins: string[] = [];
  for (const entry of entries) {
    try {
      const url = new URL(entry);
      if (url.protocol !== "https:" || url.origin !== entry.replace(/\/$/, "") || !/^[a-z0-9.-]+$/.test(url.hostname)) return undefined;
      origins.push(url.origin);
    } catch {
      return undefined;
    }
  }
  return origins;
}
