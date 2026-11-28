import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, storeIntegrations, storeIntegrationTools } from "@workspace/db";
import { executeConnectOperation } from "../../connect/api-connector";
import type { ConnectNetwork } from "../../connect/network";
import { liveConnectNetwork } from "../../connect/network";
import {
  adapterSupports,
  type CreateCheckoutInput,
  type CreateCheckoutResult,
  type StoreCheckoutAdapter,
  type StoreCheckoutAdapterRecord,
  type StoreCheckoutWebhookVerification,
} from "./types";

function readJsonPointer(obj: unknown, pointer: string | undefined): unknown {
  if (!pointer || !pointer.startsWith("/")) return undefined;
  const parts = pointer
    .slice(1)
    .split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export class CustomOpenApiStoreAdapter implements StoreCheckoutAdapter {
  readonly kind = "CUSTOM_OPENAPI" as const;

  constructor(
    readonly record: StoreCheckoutAdapterRecord,
    private readonly network: ConnectNetwork = liveConnectNetwork,
  ) {}

  supports(input: { country: string; currency: string; amountMinor: number }): boolean {
    return adapterSupports(this.record, input);
  }

  private async loadIntegrationAndTool(toolNameConfigKey: string) {
    const integrationId = String(this.record.config.integrationId ?? "");
    const toolName = String(this.record.config[toolNameConfigKey] ?? "");
    if (!integrationId || !toolName) {
      throw new Error(`CustomOpenApi adapter missing ${toolNameConfigKey}`);
    }
    const [integration] = await db
      .select()
      .from(storeIntegrations)
      .where(and(eq(storeIntegrations.id, integrationId), eq(storeIntegrations.businessId, this.record.businessId)))
      .limit(1);
    if (!integration || integration.status !== "APPROVED") {
      throw new Error("Store integration is not approved.");
    }
    const [tool] = await db
      .select()
      .from(storeIntegrationTools)
      .where(and(eq(storeIntegrationTools.integrationId, integrationId), eq(storeIntegrationTools.name, toolName)))
      .limit(1);
    if (!tool || tool.status !== "APPROVED") {
      throw new Error(`Store checkout tool ${toolName} is not approved.`);
    }
    return { integration, tool };
  }

  async createSession(input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
    const { integration, tool } = await this.loadIntegrationAndTool("createSessionToolName");
    const result = await executeConnectOperation(
      this.network,
      integration,
      tool,
      {
        body: {
          sessionId: input.sessionId,
          orderId: input.orderId,
          amountMinor: input.amountMinor,
          currencyCode: input.currencyCode,
          buyerId: input.buyerId,
          returnUrl: input.returnUrl,
        },
      },
      `store-checkout:${input.sessionId}`,
    );
    const idPointer = String(this.record.config.sessionIdPointer ?? "/id");
    const urlPointer = String(this.record.config.checkoutUrlPointer ?? "/checkoutUrl");
    const providerSessionId = String(readJsonPointer(result.data, idPointer) ?? "");
    const checkoutUrl = String(readJsonPointer(result.data, urlPointer) ?? "");
    if (!providerSessionId || !checkoutUrl.startsWith("https://")) {
      throw new Error("CustomOpenApi createSession response missing sessionId or HTTPS checkoutUrl");
    }
    return { providerSessionId, checkoutUrl };
  }

  async verifyWebhook(input: {
    headers: Record<string, string | string[] | undefined>;
    rawBody: Buffer;
    parsedBody: Record<string, unknown>;
  }): Promise<StoreCheckoutWebhookVerification> {
    const secret = String(this.record.config.webhookSecret ?? "");
    if (!secret) return { valid: false, reason: "MISSING_WEBHOOK_SECRET" };
    const sigHeaderName = String(this.record.config.signatureHeader ?? "x-store-checkout-signature").toLowerCase();
    const rawSig = input.headers[sigHeaderName];
    const sig = Array.isArray(rawSig) ? rawSig[0] : rawSig;
    if (!sig) return { valid: false, reason: "MISSING_SIGNATURE" };
    const expected = createHmac("sha256", secret).update(input.rawBody).digest("hex");
    const sigBuf = Buffer.from(sig.trim(), "utf8");
    const expBuf = Buffer.from(expected, "utf8");
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      return { valid: false, reason: "INVALID_SIGNATURE" };
    }
    const eventId = String(readJsonPointer(input.parsedBody, String(this.record.config.webhookEventIdPointer ?? "/eventId")) ?? "");
    const providerSessionId = String(
      readJsonPointer(input.parsedBody, String(this.record.config.webhookSessionIdPointer ?? "/providerSessionId")) ?? "",
    );
    const orderId = readJsonPointer(input.parsedBody, String(this.record.config.webhookOrderIdPointer ?? "/orderId"));
    const currencyCode = readJsonPointer(input.parsedBody, String(this.record.config.webhookCurrencyPointer ?? "/currencyCode"));
    const amountMinor = readJsonPointer(input.parsedBody, String(this.record.config.webhookAmountPointer ?? "/amountMinor"));
    const rawStatus = String(
      readJsonPointer(input.parsedBody, String(this.record.config.webhookStatusPointer ?? "/status")) ?? "",
    ).toUpperCase();
    if (!eventId || !providerSessionId) return { valid: false, reason: "MALFORMED_EVENT" };
    const eventType =
      rawStatus === "PAID" || rawStatus === "FAILED" || rawStatus === "EXPIRED" || rawStatus === "CANCELLED"
        ? rawStatus
        : "IGNORED";
    return {
      valid: true,
      eventId,
      eventType,
      providerSessionId,
      orderId: typeof orderId === "string" ? orderId : undefined,
      amountMinor: typeof amountMinor === "number" ? amountMinor : undefined,
      currencyCode: typeof currencyCode === "string" ? currencyCode.toUpperCase() : undefined,
      providerStatus: rawStatus,
    };
  }

  async fetchSessionState(providerSessionId: string) {
    const { integration, tool } = await this.loadIntegrationAndTool("getSessionToolName");
    const result = await executeConnectOperation(this.network, integration, tool, { sessionId: providerSessionId });
    const statusPointer = String(this.record.config.statusPointer ?? "/status");
    const orderIdPointer = String(this.record.config.orderIdPointer ?? "/orderId");
    const amountPointer = String(this.record.config.amountPointer ?? "/amountMinor");
    const currencyPointer = String(this.record.config.currencyPointer ?? "/currencyCode");
    const rawStatus = String(readJsonPointer(result.data, statusPointer) ?? "PENDING").toUpperCase();
    const status =
      rawStatus === "PAID" || rawStatus === "FAILED" || rawStatus === "EXPIRED" || rawStatus === "CANCELLED"
        ? rawStatus
        : "PENDING";
    const orderId = readJsonPointer(result.data, orderIdPointer);
    const amountMinor = readJsonPointer(result.data, amountPointer);
    const currencyCode = readJsonPointer(result.data, currencyPointer);
    return {
      providerSessionId,
      status,
      orderId: typeof orderId === "string" ? orderId : undefined,
      amountMinor: typeof amountMinor === "number" ? amountMinor : undefined,
      currencyCode: typeof currencyCode === "string" ? currencyCode.toUpperCase() : undefined,
    };
  }
}
