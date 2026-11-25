import { WhopClient, WhopEnvironment } from "@whop/sdk";
import type { WhopConfig } from "./config";
import { whopRefusal } from "./errors";

let cached: WhopClient | undefined;
let cachedIdentity = "";

/**
 * The SDK reads no environment variables and the key never leaves the server. The API
 * version is pinned explicitly: a silently moving provider version must not change
 * field meanings under a live checkout.
 */
export function whopClient(config: WhopConfig): WhopClient {
  if (!config.apiKey)
    throw whopRefusal(503, "Whop is not configured", "WHOP_NOT_CONFIGURED");
  const identity = `${config.environment}:${config.companyId ?? ""}:${config.apiKey}`;
  if (cached && cachedIdentity === identity) return cached;
  cached = new WhopClient({
    token: config.apiKey,
    environment:
      config.environment === "production"
        ? WhopEnvironment.Production
        : WhopEnvironment.Sandbox,
    apiVersionDate: "2026-10-28",
    timeoutInSeconds: 20,
    maxRetries: 1,
  });
  cachedIdentity = identity;
  return cached;
}

export function resetWhopClientForTests() {
  cached = undefined;
  cachedIdentity = "";
}
