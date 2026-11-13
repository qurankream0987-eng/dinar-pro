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
