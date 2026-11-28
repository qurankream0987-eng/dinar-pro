import { createHmac, timingSafeEqual } from "node:crypto";
import {
  adapterSupports,
  isSimulatedStoreGatewayEnabled,
  type CreateCheckoutInput,
  type CreateCheckoutResult,
  type StoreCheckoutAdapter,
  type StoreCheckoutAdapterRecord,
  type StoreCheckoutWebhookVerification,
} from "./types";

interface SimulatedSessionState {
  providerSessionId: string;
  orderId: string;
  amountMinor: number;
  currencyCode: string;
  status: "PENDING" | "PAID" | "FAILED" | "EXPIRED" | "CANCELLED";
}

const simulatedSessions = new Map<string, SimulatedSessionState>();

export function setSimulatedGatewaySessionState(
  providerSessionId: string,
  patch: Partial<SimulatedSessionState>,
): void {
  const existing = simulatedSessions.get(providerSessionId);
  if (!existing) {
    simulatedSessions.set(providerSessionId, {
      providerSessionId,
      orderId: patch.orderId ?? "",
      amountMinor: patch.amountMinor ?? 0,
      currencyCode: patch.currencyCode ?? "JOD",
      status: patch.status ?? "PENDING",
    });
    return;
  }
  simulatedSessions.set(providerSessionId, { ...existing, ...patch });
}

export function clearSimulatedGatewaySessions(): void {
  simulatedSessions.clear();
}

export function signSimulatedStoreWebhook(secret: string, rawBody: string | Buffer): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function webhookSecret(record: StoreCheckoutAdapterRecord): string {
  const raw = typeof record.config.webhookSecret === "string" ? record.config.webhookSecret.trim() : "";
  return raw || "dinar-simulated-store-webhook-secret";
}

export class SimulatedStoreGatewayAdapter implements StoreCheckoutAdapter {
  readonly kind = "SIMULATED_GATEWAY" as const;

  constructor(readonly record: StoreCheckoutAdapterRecord) {
    if (!isSimulatedStoreGatewayEnabled()) {
      throw new Error("SimulatedStoreGateway is disabled outside test/dev.");
    }
  }

  supports(input: { country: string; currency: string; amountMinor: number }): boolean {
    return isSimulatedStoreGatewayEnabled() && adapterSupports(this.record, input);
  }

  async createSession(input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
    if (!isSimulatedStoreGatewayEnabled()) {
      throw new Error("SimulatedStoreGateway is disabled.");
    }
    const providerSessionId = `sim_sess_${input.sessionId}`;
    simulatedSessions.set(providerSessionId, {
      providerSessionId,
      orderId: input.orderId,
      amountMinor: input.amountMinor,
      currencyCode: input.currencyCode.toUpperCase(),
      status: "PENDING",
    });
    const base =
      typeof this.record.config.baseUrl === "string" && this.record.config.baseUrl.startsWith("https://")
        ? this.record.config.baseUrl.replace(/\/+$/, "")
        : "https://simulated-gateway.dinar.test/checkout";
    return {
      providerSessionId,
      checkoutUrl: `${base}/${encodeURIComponent(providerSessionId)}`,
    };
  }

  async verifyWebhook(input: {
    headers: Record<string, string | string[] | undefined>;
    rawBody: Buffer;
    parsedBody: Record<string, unknown>;
  }): Promise<StoreCheckoutWebhookVerification> {
    if (!isSimulatedStoreGatewayEnabled()) {
      return { valid: false, reason: "SIMULATED_GATEWAY_DISABLED" };
    }
    const headerVal = input.headers["x-store-checkout-signature"];
    const sig = Array.isArray(headerVal) ? headerVal[0] : headerVal;
    if (!sig || typeof sig !== "string") {
      return { valid: false, reason: "MISSING_SIGNATURE" };
    }
    const expected = signSimulatedStoreWebhook(webhookSecret(this.record), input.rawBody);
    const sigBuf = Buffer.from(sig.trim(), "utf8");
    const expBuf = Buffer.from(expected, "utf8");
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      return { valid: false, reason: "INVALID_SIGNATURE" };
    }
    const eventId = typeof input.parsedBody.eventId === "string" ? input.parsedBody.eventId.trim() : "";
    const providerSessionId =
      typeof input.parsedBody.providerSessionId === "string" ? input.parsedBody.providerSessionId.trim() : "";
    const orderId = typeof input.parsedBody.orderId === "string" ? input.parsedBody.orderId.trim() : "";
    const currencyCode =
      typeof input.parsedBody.currencyCode === "string" ? input.parsedBody.currencyCode.trim().toUpperCase() : "";
    const amountMinor = typeof input.parsedBody.amountMinor === "number" ? input.parsedBody.amountMinor : NaN;
    const rawType = typeof input.parsedBody.eventType === "string" ? input.parsedBody.eventType.trim().toUpperCase() : "";
    const eventType =
      rawType === "PAID" || rawType === "FAILED" || rawType === "EXPIRED" || rawType === "CANCELLED"
        ? rawType
        : "IGNORED";
    if (!eventId || !providerSessionId) {
      return { valid: false, reason: "MALFORMED_EVENT" };
    }
    return {
      valid: true,
      eventId,
      eventType,
      providerSessionId,
      orderId: orderId || undefined,
      amountMinor: Number.isFinite(amountMinor) ? amountMinor : undefined,
      currencyCode: currencyCode || undefined,
      providerStatus: typeof input.parsedBody.status === "string" ? input.parsedBody.status : eventType,
    };
  }

  async fetchSessionState(providerSessionId: string) {
    const state = simulatedSessions.get(providerSessionId);
    if (!state) {
      return {
        providerSessionId,
        status: "PENDING" as const,
      };
    }
    return { ...state };
  }
}
