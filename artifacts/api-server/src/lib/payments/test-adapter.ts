import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type {
  PaymentProviderAdapter,
  PaymentWebhookEvent,
  ProviderPaymentSnapshot,
  SignedPaymentWebhook,
} from "./contracts";
import { canonicalPaymentWebhook } from "./contracts";

type IntentRegistration = {
  amountMinor: number;
  currencyCode: string;
};

/**
 * Development/test-only simulator. It has no network client, API credential,
 * or ability to move money. Its ephemeral HMAC key is process-local.
 */
export class TestOnlyPaymentAdapter implements PaymentProviderAdapter {
  readonly providerKey = "TEST_ADAPTER";
  private readonly signingKey = randomBytes(32);
  private readonly snapshots = new Map<string, ProviderPaymentSnapshot>();
  private readonly refundRequests = new Map<string, SignedPaymentWebhook>();

  allocateIntentReference(): string {
    return `sim_intent_${randomUUID()}`;
  }

  registerIntent(providerIntentId: string, input: IntentRegistration): void {
    if (
      !Number.isSafeInteger(input.amountMinor) ||
      input.amountMinor < 1 ||
      !/^[A-Z]{3}$/.test(input.currencyCode)
    ) {
      throw new Error("Invalid simulated payment intent");
    }
    this.snapshots.set(providerIntentId, {
      status: "PENDING",
      amountMinor: input.amountMinor,
      capturedAmountMinor: 0,
      refundedAmountMinor: 0,
      currencyCode: input.currencyCode,
    });
  }

  createCaptureWebhook(providerIntentId: string): SignedPaymentWebhook {
    const snapshot = this.snapshots.get(providerIntentId);
    if (!snapshot || snapshot.status !== "PENDING")
      throw new Error("Simulated payment is not pending");

    const event: PaymentWebhookEvent = {
      id: `sim_event_${randomUUID()}`,
      type: "CAPTURE_SUCCEEDED",
      providerIntentId,
      amountMinor: snapshot.amountMinor,
      currencyCode: snapshot.currencyCode,
    };
    this.snapshots.set(providerIntentId, {
      ...snapshot,
      status: "CAPTURED",
      capturedAmountMinor: snapshot.amountMinor,
    });
    return this.sign(event);
  }

  /** Simulates the provider declining a pending intent; nothing is captured. */
  declineIntent(providerIntentId: string): void {
    const snapshot = this.snapshots.get(providerIntentId);
    if (!snapshot || snapshot.status !== "PENDING")
      throw new Error("Simulated payment is not pending");
    this.snapshots.set(providerIntentId, { ...snapshot, status: "DECLINED" });
  }

  createRefundWebhook(input: {
    providerIntentId: string;
    amountMinor: number;
    currencyCode: string;
    idempotencyKey: string;
  }): SignedPaymentWebhook {
    const prior = this.refundRequests.get(input.idempotencyKey);
    if (prior) {
      if (
        prior.event.type !== "REFUND_SUCCEEDED" ||
        prior.event.providerIntentId !== input.providerIntentId ||
        prior.event.amountMinor !== input.amountMinor ||
        prior.event.currencyCode !== input.currencyCode
      ) {
        throw new Error("Refund idempotency key was reused with new data");
      }
      return prior;
    }

    const snapshot = this.snapshots.get(input.providerIntentId);
    if (
      !snapshot ||
      !["CAPTURED", "PARTIALLY_REFUNDED"].includes(snapshot.status) ||
      snapshot.currencyCode !== input.currencyCode ||
      !Number.isSafeInteger(input.amountMinor) ||
      input.amountMinor < 1 ||
      input.amountMinor >
        snapshot.capturedAmountMinor - snapshot.refundedAmountMinor
    ) {
      throw new Error("Simulated refund exceeds captured balance");
    }

    const providerRefundId = `sim_refund_${randomUUID()}`;
    const event: PaymentWebhookEvent = {
      id: `sim_event_${randomUUID()}`,
      type: "REFUND_SUCCEEDED",
      providerIntentId: input.providerIntentId,
      providerRefundId,
      amountMinor: input.amountMinor,
      currencyCode: input.currencyCode,
    };
    const refundedAmountMinor =
      snapshot.refundedAmountMinor + input.amountMinor;
    this.snapshots.set(input.providerIntentId, {
      ...snapshot,
      status:
        refundedAmountMinor === snapshot.capturedAmountMinor
          ? "REFUNDED"
          : "PARTIALLY_REFUNDED",
      refundedAmountMinor,
    });
    const signed = this.sign(event);
    this.refundRequests.set(input.idempotencyKey, signed);
    return signed;
  }

  /** Simulates the provider declining a refund request; the captured balance is unchanged. */
  createRefundFailureWebhook(input: {
    providerIntentId: string;
    amountMinor: number;
    currencyCode: string;
    idempotencyKey: string;
  }): SignedPaymentWebhook {
    const snapshot = this.snapshots.get(input.providerIntentId);
    if (
      !snapshot ||
      !["CAPTURED", "PARTIALLY_REFUNDED"].includes(snapshot.status) ||
      snapshot.currencyCode !== input.currencyCode
    ) {
      throw new Error("Simulated refund has no captured balance to fail against");
    }
    return this.sign({
      id: `sim_event_${randomUUID()}`,
      type: "REFUND_FAILED",
      providerIntentId: input.providerIntentId,
      providerRefundId: `sim_refund_${randomUUID()}`,
      amountMinor: input.amountMinor,
      currencyCode: input.currencyCode,
    });
  }

  verifyWebhook(event: PaymentWebhookEvent, signature: string): boolean {
    if (!/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
    const expected = Buffer.from(this.signatureFor(event));
    const received = Buffer.from(signature);
    return (
      expected.length === received.length && timingSafeEqual(expected, received)
    );
  }

  async getSnapshot(
    providerIntentId: string,
  ): Promise<ProviderPaymentSnapshot | undefined> {
    const snapshot = this.snapshots.get(providerIntentId);
    return snapshot ? { ...snapshot } : undefined;
  }

  private sign(event: PaymentWebhookEvent): SignedPaymentWebhook {
    return { event, signature: this.signatureFor(event) };
  }

  private signatureFor(event: PaymentWebhookEvent): string {
    return `sha256=${createHmac("sha256", this.signingKey)
      .update(canonicalPaymentWebhook(event))
      .digest("hex")}`;
  }
}

export const testOnlyPaymentAdapter = new TestOnlyPaymentAdapter();