const MODEL_ID = /^[A-Za-z0-9._:/-]{1,120}$/;

/**
 * Exact, owner-reviewed OpenRouter free-model allowlist. This deliberately does not accept
 * OpenRouter's dynamic "openrouter/free" alias; each model also needs an approved zero-price row.
 */
export function isApprovedFreeOpenRouterModel(
  provider: string,
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (
    provider !== "OPENROUTER" ||
    !MODEL_ID.test(model) ||
    model.toLowerCase() === "openrouter/free"
  )
    return false;
  const approved = (env.DINAR_APPROVED_FREE_OPENROUTER_MODELS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return approved.includes(model);
}

/**
 * Versioned, server-controlled activation of free-model enforcement (owner decision, Option A).
 *
 * Until it is active, free accounts and guests keep the existing routing, which still passes the
 * canonical usage reservation, price check and spend hold (no new paid path is opened). It becomes
 * active only when DINAR_FREE_ROUTING_POLICY names this exact policy version, the word «enforce»
 * and the current DINAR_DEPLOYMENT_ENV, and at least one exact model is on the allowlist. Binding
 * the environment name into the value means a staging value copied to production does nothing.
 */
export const FREE_ROUTING_POLICY_VERSION = "2026-11-13.v1";

export type FreeRoutingPolicy =
  | { mode: "COMPAT"; reason: "NOT_REQUESTED" | "OTHER_ENVIRONMENT" | "UNKNOWN_VERSION" | "NO_APPROVED_MODEL" }
  | { mode: "ENFORCE"; version: string };

export function freeRoutingPolicy(env: NodeJS.ProcessEnv = process.env): FreeRoutingPolicy {
  const raw = env.DINAR_FREE_ROUTING_POLICY?.trim();
  if (!raw) return { mode: "COMPAT", reason: "NOT_REQUESTED" };
  const [version, action, deployment, ...rest] = raw.split(":");
  if (version !== FREE_ROUTING_POLICY_VERSION || action !== "enforce" || rest.length)
    return { mode: "COMPAT", reason: "UNKNOWN_VERSION" };
  const current = (env.DINAR_DEPLOYMENT_ENV?.trim().toLowerCase() || "development");
  if (!deployment || deployment.toLowerCase() !== current) return { mode: "COMPAT", reason: "OTHER_ENVIRONMENT" };
  const approved = (env.DINAR_APPROVED_FREE_OPENROUTER_MODELS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!approved.some((model) => isApprovedFreeOpenRouterModel("OPENROUTER", model, env)))
    return { mode: "COMPAT", reason: "NO_APPROVED_MODEL" };
  return { mode: "ENFORCE", version };
}

export const freeRoutingEnforced = (env: NodeJS.ProcessEnv = process.env) => freeRoutingPolicy(env).mode === "ENFORCE";
