import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, markets, users } from "@workspace/db";
import { countryByCode } from "@workspace/global";
import { hashPassword, normalizePhone } from "./auth";
import { recordModerationAudit } from "./moderation";

/**
 * First-administrator bootstrap for a newly migrated environment. It is an operator command
 * (src/bin/bootstrap-admin.ts), never an HTTP route: no request can reach it, and the normal
 * authorization contract (role ADMIN, checked per route) is unchanged.
 *
 * - An existing ACTIVE account with the given phone is promoted; otherwise an account is created
 *   with an operator-supplied password (stdin only), the registration limits, and
 *   phoneVerified=false — the bootstrap proves nothing about phone ownership.
 * - It refuses while any administrator exists, so it cannot add a second admin or take over a
 *   live environment; re-running for the sole admin it created is a no-op (ALREADY_ADMIN).
 * - One append-only moderation_audit row records the outcome, without any credential.
 */
export type BootstrapOutcome = "CREATED" | "PROMOTED" | "ALREADY_ADMIN";

export class AdminBootstrapError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "AdminBootstrapError";
  }
}
const refuse = (code: string, message: string): never => {
  throw new AdminBootstrapError(code, message);
};

export interface AdminBootstrapInput {
  phoneCountryCode: string;
  phoneNumber: string;
  /** Required only when the account does not exist yet. */
  displayName?: string;
  accountCountry?: string;
  password?: string;
}

export async function bootstrapFirstAdmin(
  input: AdminBootstrapInput,
): Promise<{ outcome: BootstrapOutcome; userId: string; marketId: string }> {
  let phone: ReturnType<typeof normalizePhone>;
  try {
    phone = normalizePhone(input.phoneCountryCode, input.phoneNumber);
  } catch {
    return refuse("PHONE", "The phone number is not valid for its country code.");
  }
  // Hash outside the transaction: scrypt is slow and the lock below should stay short.
  const passwordHash =
    input.password === undefined ? undefined : await hashPassword(validPassword(input.password));

  return db.transaction(async (tx) => {
    // Serialises concurrent bootstraps: the second one sees the first one's administrator.
    // Transaction-scoped, so it lives on this transaction's connection and ends with it.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('dinar:first-admin-bootstrap'))`);
    const admins = await tx.select({ id: users.id }).from(users).where(eq(users.role, "ADMIN"));
    const [existing] = await tx.select().from(users).where(eq(users.normalizedPhone, phone.normalizedPhone));

    if (admins.length) {
      if (existing && admins.length === 1 && admins[0]!.id === existing.id)
        return { outcome: "ALREADY_ADMIN" as const, userId: existing.id, marketId: existing.activeMarketId };
      return refuse("ADMIN_EXISTS", "An administrator already exists; the bootstrap never adds another.");
    }

    if (existing) {
      if (existing.status !== "ACTIVE") refuse("ACCOUNT_NOT_ACTIVE", "Only an ACTIVE account can become the first administrator.");
      if (passwordHash) refuse("PASSWORD_UNUSED", "The account exists; its password is never replaced by the bootstrap.");
      await tx.update(users).set({ role: "ADMIN", updatedAt: new Date() }).where(and(eq(users.id, existing.id), eq(users.role, "USER")));
      await recordModerationAudit(tx, {
        actor: { id: existing.id, role: "OPERATOR_BOOTSTRAP" } as any,
        action: "FIRST_ADMIN_BOOTSTRAP",
        targetType: "USER",
        targetId: existing.id,
        reason: "First administrator promoted by the operator bootstrap command.",
        before: { role: "USER" },
        after: { role: "ADMIN", phoneVerified: existing.phoneVerified, outcome: "PROMOTED" },
      });
      return { outcome: "PROMOTED" as const, userId: existing.id, marketId: existing.activeMarketId };
    }

    if (!passwordHash) refuse("PASSWORD_REQUIRED", "A new account needs a password on standard input.");
    const displayName = input.displayName?.trim() ?? "";
    if (displayName.length < 2 || displayName.length > 80) refuse("DISPLAY_NAME", "The display name must have 2–80 characters.");
    const country = countryByCode.get(input.accountCountry ?? "");
    if (!country?.isSelectable) refuse("COUNTRY", "The account country is not selectable.");
    // The administrator belongs to their country's market; the bootstrap never activates it.
    const [market] = await tx.select({ id: markets.id }).from(markets).where(eq(markets.countryCode, country!.countryCode));
    if (!market) refuse("MARKET", "No market exists for the account country.");

    const id = randomUUID();
    await tx.insert(users).values({
      id,
      displayName,
      ...phone,
      accountCountry: country!.countryCode,
      activeMarketId: market!.id,
      passwordHash: passwordHash!,
      phoneVerified: false,
      role: "ADMIN",
    });
    await recordModerationAudit(tx, {
      actor: { id, role: "OPERATOR_BOOTSTRAP" } as any,
      action: "FIRST_ADMIN_BOOTSTRAP",
      targetType: "USER",
      targetId: id,
      reason: "First administrator created by the operator bootstrap command.",
      before: null,
      after: { role: "ADMIN", phoneVerified: false, outcome: "CREATED" },
    });
    return { outcome: "CREATED" as const, userId: id, marketId: market!.id };
  });
}

/** The registration limits (auth.ts): 12–128 characters. */
function validPassword(password: string): string {
  if (typeof password !== "string" || password.length < 12 || password.length > 128)
    refuse("PASSWORD", "The password must have 12–128 characters.");
  return password;
}
