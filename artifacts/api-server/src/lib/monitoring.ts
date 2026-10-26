/**
 * External error reporting through the MONITORING provider family.
 *
 * The API error handler reports each unexpected 5xx here after logging it. A report holds an
 * event name, a bounded error code, the request id and the release — never a message, stack,
 * URL, body, user id or secret (MonitoringProvider's contract). Monitoring is platform-wide,
 * so a vendor is chosen by DINAR_MONITORING_PROVIDER rather than per market.
 *
 * Nothing is sent until a vendor adapter is registered at startup (registerMonitoringProvider)
 * under the key DINAR_MONITORING_PROVIDER names, for the current deployment environment, and —
 * in production — DINAR_LIVE_PROVIDERS_ENABLED=true. Reporting never fails a request.
 */
import { logger, serializeSafeError } from "./logger";
import { providerDeploymentEnvironment } from "./market-capability-registry";
import type { MonitoringProvider, ProviderRegistration } from "./provider-boundaries";

const registrations = new Map<string, ProviderRegistration<"MONITORING">>();
let active: { key: string; provider: Promise<MonitoringProvider> } | undefined;
/** Concurrent reports in flight; beyond this, an error storm is dropped rather than queued. */
const MAX_IN_FLIGHT = 20;
let inFlight = 0;

/** Registration is server code, never configuration from a request. */
export function registerMonitoringProvider(registration: ProviderRegistration<"MONITORING">) {
  registrations.set(registration.providerKey, registration);
  active = undefined;
}
export function unregisterMonitoringProvider(providerKey: string) {
  registrations.delete(providerKey);
  active = undefined;
}

function resolveMonitoringProvider(): Promise<MonitoringProvider> | undefined {
  const key = process.env.DINAR_MONITORING_PROVIDER;
  const environment = providerDeploymentEnvironment();
  if (!key || !environment) return undefined;
  const mode = environment === "development" ? "DEVELOPMENT" : environment === "staging" ? "SANDBOX" : "LIVE";
  if (mode === "LIVE" && process.env.DINAR_LIVE_PROVIDERS_ENABLED !== "true") return undefined;
  const registration = registrations.get(key);
  if (!registration || registration.mode !== mode || !registration.environments.includes(environment)) return undefined;
  if (active?.key !== key) active = { key, provider: Promise.resolve(registration.create()) };
  return active.provider;
}

export function monitoringStatus() {
  return { connected: resolveMonitoringProvider() !== undefined, providers: [...registrations.keys()] };
}

const CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;
const RELEASE = /^[A-Za-z0-9_.-]{1,40}$/;

/** Reports one unexpected server error; returns once the provider settles (tests await it). */
export async function reportServerError(error: unknown, requestId?: unknown): Promise<"SENT" | "NOT_CONNECTED" | "DROPPED" | "FAILED"> {
  const provider = resolveMonitoringProvider();
  if (!provider) return "NOT_CONNECTED";
  if (inFlight >= MAX_IN_FLIGHT) return "DROPPED";
  inFlight += 1;
  try {
    const safe = serializeSafeError(error) as { type: string; code?: string };
    const code = safe.code ?? safe.type;
    const release = process.env.DINAR_RELEASE;
    await (await provider).captureError({
      event: "api_request_failed",
      code: CODE.test(code) ? code : "Error",
      ...(typeof requestId === "string" && REQUEST_ID.test(requestId) ? { requestId } : {}),
      ...(release && RELEASE.test(release) ? { release } : {}),
    });
    return "SENT";
  } catch (failure) {
    // Logged locally only; a failing monitor must never report itself.
    logger.warn({ event: "dinar_monitoring_failed", err: failure }, "Monitoring report failed");
    return "FAILED";
  } finally {
    inFlight -= 1;
  }
}
