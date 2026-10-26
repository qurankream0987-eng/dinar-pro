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
  if (env.DINAR_WEB_DIST !== undefined && !existsSync(path.join(env.DINAR_WEB_DIST, "index.html")))
    problems.push("DINAR_WEB_DIST");
  return problems;
}
