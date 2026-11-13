/**
 * G1 provider sync: inbound, deterministic, and only through canonical authorities.
 *
 * Listings: (connection, externalRef) maps to exactly one canonical offer. The offer id
 * is derived from that pair, so a retry, a concurrent push or a crash between steps
 * always lands on the same row; a per-reference advisory lock serializes writers and
 * the mapping's unique index backs it. Creation goes through createListingForActor and
 * changes through updateOwnedListing / archiveOwnedListing, acting as the connection
 * owner in the connection's market, so every validation, policy, moderation and
 * inventory rule is the one the seller form uses. The payload schema is strict: owner,
 * market, status, sponsorship, payment or commission fields are rejected, never read.
 *
 * Drivers are LINK ONLY: a real DINAR account issues a short-lived link code for its
 * own DriverProfile and gives it to the provider. Nothing here creates accounts or
 * profiles, or changes approval, availability or assignments.
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { UpdateListingBody } from "@workspace/api-zod";
import { db, driverProfiles, markets, offers, providerResourceMappings, users } from "@workspace/db";
import { createListingForActor } from "../routes/marketplace";
import { archiveOwnedListing, updateOwnedListing } from "./listing-management";
import { listing } from "./marketplace-listings";
import { resolveMarketplaceCategory } from "./marketplace-categories";
import { isOwnedListingPhotoPath } from "./listing-photos";
import { resolveMarket } from "./markets";
import {
  type ProviderContext,
  assertProviderScope,
  assertProviderStillAuthorized,
  markProviderSync,
  providerAudit,
  providerError,
  ProviderError,
} from "./provider-connections";

export const PROVIDER_BATCH_MAX = 25;
export const EXTERNAL_REF_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;

const Attributes = z
  .record(z.string().trim().min(1).max(60), z.union([z.string().trim().max(160), z.number().finite()]))
  .refine((value) => Object.keys(value).length <= 30, "attributes: at most 30");

export const ProviderListingInput = z
  .object({
    title: z.string().trim().min(2).max(120),
    description: z.string().trim().min(10).max(5000),
    categoryId: z.string().trim().min(1).max(80).optional(),
    category: z.string().trim().min(1).max(80).optional(),
    unitPrice: z.string().regex(/^[0-9]{1,12}(?:\.[0-9]{1,3})?$/).nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    pricingMode: z.enum(["FIXED", "NEGOTIABLE", "OPEN_TO_OFFERS"]).optional(),
    /** Total stock including units already reserved by DINAR orders; null = not stock-limited. */
    quantity: z.number().int().min(1).max(1_000_000).nullable(),
    fulfilmentType: z.enum(["PICKUP", "DELIVERY", "DIGITAL", "SERVICE"]),
    city: z.string().trim().max(100).optional(),
    area: z.string().trim().min(1).max(100),
    attributes: Attributes.optional(),
    /** Photos already uploaded to the owner's DINAR listing storage; no external URLs. */
    images: z.array(z.string().max(500)).max(4).optional(),
  })
  .strict();
export type ProviderListingInput = z.infer<typeof ProviderListingInput>;

export const ProviderBatchInput = z
  .object({
    items: z
      .array(z.object({ externalRef: z.string(), listing: z.unknown() }).strict())
      .min(1)
      .max(PROVIDER_BATCH_MAX),
  })
  .strict();

const issuePaths = (error: z.ZodError) =>
  [...new Set(error.issues.map((issue) => (issue.path.length ? issue.path.join(".") : issue.message)))].slice(0, 20);

function assertExternalRef(externalRef: string) {
  if (!EXTERNAL_REF_PATTERN.test(externalRef))
    throw providerError(400, "INVALID_PAYLOAD", "المعرّف الخارجي غير صالح", ["externalRef"]);
}

/** The canonical offer id for (connection, externalRef): a name-based (v5-style) UUID. */
export function providerListingId(connectionId: string, externalRef: string) {
  const bytes = createHash("sha256").update(`dinar-provider-listing\0${connectionId}\0${externalRef}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Canonical authority errors become safe provider errors; anything unexpected stays generic. */
function asProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const status = (error as { status?: number })?.status;
  const message = (error as { message?: string })?.message ?? "";
  if (error instanceof z.ZodError) return providerError(400, "INVALID_PAYLOAD", "بيانات العرض غير صالحة", issuePaths(error));
  if (status === 400) return providerError(400, "INVALID_PAYLOAD", message || "بيانات العرض غير صالحة");
  if (status === 404) return providerError(404, "RESOURCE_NOT_FOUND", "المورد غير موجود");
  if (status === 403 || status === 409 || status === 422)
    return providerError(409, "RESOURCE_CONFLICT", message || "تعذر تطبيق التغيير على المورد الحالي");
  throw error;
}

/**
 * A provider write transaction may briefly need a second pool connection, because the
 * canonical listing authorities it calls read through `db`. Bounding how many run at once
 * keeps a burst of pushes from holding every pool connection while each waits for one
 * more. Waiting here holds no connection; a released slot passes straight to the next.
 */
const MAX_CONCURRENT_PROVIDER_WRITES = 4;
let activeProviderWrites = 0;
const providerWriteQueue: (() => void)[] = [];
async function withWriteSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeProviderWrites < MAX_CONCURRENT_PROVIDER_WRITES) activeProviderWrites++;
  else await new Promise<void>((resolve) => providerWriteQueue.push(resolve));
  try {
    return await work();
  } finally {
    const next = providerWriteQueue.shift();
    if (next) next();
    else activeProviderWrites--;
  }
}

/**
 * Runs `work` in one transaction holding the reference's advisory lock. Waiting is done
 * outside any transaction, so concurrent pushes never pin pool connections.
 */
async function withReferenceLock<T>(key: string, work: (tx: any) => Promise<T>): Promise<T> {
  const BUSY = Symbol("busy");
  for (let attempt = 0; attempt < 60; attempt++) {
    const outcome = await withWriteSlot(() =>
      db.transaction(async (tx) => {
        const locked = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as locked`);
        if (!(locked.rows[0] as { locked: boolean }).locked) return BUSY;
        return { value: await work(tx) };
      }),
    );
    if (outcome !== BUSY) return (outcome as { value: T }).value;
    await new Promise((resolve) => setTimeout(resolve, 20 + Math.floor(Math.random() * 30)));
  }
  throw providerError(409, "RESOURCE_CONFLICT", "المورد قيد التحديث الآن؛ أعد المحاولة");
}

async function connectionMarket(context: ProviderContext, tx: any = db) {
  const [row] = await tx.select().from(markets).where(eq(markets.id, context.connection.marketId));
  return resolveMarket(row, tx);
}

/** Validates a provider listing and maps it onto the seller form's create/update body. */
async function canonicalBody(context: ProviderContext, raw: unknown) {
  const parsed = ProviderListingInput.safeParse(raw);
  if (!parsed.success) throw providerError(400, "INVALID_PAYLOAD", "بيانات العرض غير صالحة", issuePaths(parsed.error));
  const input = parsed.data;
  const market = await connectionMarket(context);
  if (input.currency !== market.currencyCode)
    throw providerError(400, "INVALID_PAYLOAD", `عملة السوق هي ${market.currencyCode}`, ["currency"]);
  // An unknown category falls back to the generic «other»; a known but disabled one does not.
  const named = input.categoryId ?? input.category;
  let category = named ? await resolveMarketplaceCategory(input.categoryId, input.categoryId ? undefined : input.category, db, true) : undefined;
  if (category && !category.isActive) throw providerError(400, "INVALID_PAYLOAD", "التصنيف غير نشط", ["category"]);
  category ??= await resolveMarketplaceCategory("other", undefined);
  if (!category) throw providerError(400, "INVALID_PAYLOAD", "لا يوجد تصنيف عام نشط", ["category"]);
  const images = input.images ?? [];
  if (images.some((path) => !isOwnedListingPhotoPath(path, context.owner.id)))
    throw providerError(400, "INVALID_PAYLOAD", "الصور تُرفع إلى تخزين جاسم أولًا؛ لا تُقبل روابط خارجية", ["images"]);
  const body = {
    title: input.title,
    description: input.description,
    category: category.label,
    categoryId: category.id,
    area: input.area,
    city: input.city ?? "",
    attributes: input.attributes ?? {},
    unitPrice: input.unitPrice,
    pricingMode: input.pricingMode ?? (input.unitPrice === null ? "OPEN_TO_OFFERS" : "FIXED"),
    inventoryMode: input.quantity === null ? ("UNLIMITED" as const) : ("LIMITED" as const),
    availableQuantity: input.quantity,
    fulfilmentType: input.fulfilmentType,
    imageUrl: images[0] ?? "",
    imageUrls: images.slice(1),
    contactPhone: null,
  };
  const payloadHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return { body, payloadHash, market };
}

export type ProviderListingOutcome = {
  externalRef: string;
  result: "CREATED" | "UPDATED" | "UNCHANGED";
  listing: ReturnType<typeof listing>;
};

/** PUT semantics: create once, update the same canonical listing afterwards. */
export async function upsertProviderListing(context: ProviderContext, externalRef: string, raw: unknown): Promise<ProviderListingOutcome> {
  assertProviderScope(context, "listings:write");
  assertExternalRef(externalRef);
  const connectionId = context.connection.id;
  try {
    const { body, payloadHash, market } = await canonicalBody(context, raw);
    const listingId = providerListingId(connectionId, externalRef);
    return await withReferenceLock(`provider:${connectionId}:LISTING:${externalRef}`, async (tx) => {
      await assertProviderStillAuthorized(tx, context);
      const [owner] = await tx.select().from(users).where(eq(users.id, context.owner.id));
      let [mapping] = await tx
        .select()
        .from(providerResourceMappings)
        .where(
          and(
            eq(providerResourceMappings.connectionId, connectionId),
            eq(providerResourceMappings.resourceType, "LISTING"),
            eq(providerResourceMappings.externalRef, externalRef),
          ),
        );
      if (!mapping) {
        const [existing] = await tx.select({ id: offers.id, sellerId: offers.sellerId }).from(offers).where(eq(offers.id, listingId));
        if (existing && existing.sellerId !== owner.id) throw providerError(409, "RESOURCE_CONFLICT", "تعذر ربط المعرّف الخارجي");
        if (!existing) {
          // The derived id is the Block B publish idempotency key: a retry returns this listing.
          const created = await createListingForActor(owner, body, listingId);
          await tx.insert(providerResourceMappings).values({
            id: randomUUID(),
            connectionId,
            resourceType: "LISTING",
            externalRef,
            resourceId: created.listing.id,
            payloadHash,
          });
          await markProviderSync(tx, connectionId);
          await providerAudit(tx, market.id, owner.id, "PROVIDER_LISTING_CREATED", { connectionId, externalRef, listingId: created.listing.id });
          return { externalRef, result: "CREATED" as const, listing: created.listing };
        }
        // A listing left by an interrupted earlier push: adopt it, then update it below.
        [mapping] = await tx
          .insert(providerResourceMappings)
          .values({ id: randomUUID(), connectionId, resourceType: "LISTING", externalRef, resourceId: listingId, payloadHash: null })
          .returning();
      }
      if (mapping.payloadHash === payloadHash) {
        const [row] = await tx.select().from(offers).where(eq(offers.id, mapping.resourceId));
        await markProviderSync(tx, connectionId);
        return { externalRef, result: "UNCHANGED" as const, listing: listing(row, owner, market) };
      }
      const updated = await updateOwnedListing(
        { listingId: mapping.resourceId, ownerId: owner.id, market, body: UpdateListingBody.parse(body), source: "PROVIDER" },
        tx,
      );
      await tx
        .update(providerResourceMappings)
        .set({ payloadHash, updatedAt: new Date() })
        .where(eq(providerResourceMappings.id, mapping.id));
      await markProviderSync(tx, connectionId);
      await providerAudit(tx, market.id, owner.id, "PROVIDER_LISTING_UPDATED", { connectionId, externalRef, listingId: mapping.resourceId });
      return { externalRef, result: "UPDATED" as const, listing: listing(updated.row, updated.seller, updated.market) };
    });
  } catch (error) {
    const safe = asProviderError(error);
    if (["INVALID_PAYLOAD", "RESOURCE_CONFLICT"].includes(safe.code))
      await providerAudit(db, context.connection.marketId, context.owner.id, "PROVIDER_RESOURCE_REJECTED", {
        connectionId,
        externalRef: EXTERNAL_REF_PATTERN.test(externalRef) ? externalRef : null,
        code: safe.code,
      }).catch(() => undefined);
    throw safe;
  }
}

/** Bounded batch with an independent result per item; one item never rolls back another. */
export async function upsertProviderListingBatch(context: ProviderContext, raw: unknown) {
  assertProviderScope(context, "listings:write");
  const parsed = ProviderBatchInput.safeParse(raw);
  if (!parsed.success) throw providerError(400, "INVALID_PAYLOAD", `الدفعة من 1 إلى ${PROVIDER_BATCH_MAX} عناصر`, issuePaths(parsed.error));
  const refs = parsed.data.items.map((item) => item.externalRef);
  if (new Set(refs).size !== refs.length) throw providerError(400, "INVALID_PAYLOAD", "معرّف خارجي مكرر في الدفعة", ["items"]);
  const results = [];
  for (const item of parsed.data.items) {
    try {
      const outcome = await upsertProviderListing(context, item.externalRef, item.listing);
      results.push({ externalRef: item.externalRef, ok: true, result: outcome.result, listingId: outcome.listing.id });
    } catch (error) {
      const safe = asProviderError(error);
      // Authorization failures stop the batch: nothing later may run on a revoked key.
      if (["REVOKED_CREDENTIAL", "CONNECTION_UNAVAILABLE", "MARKET_MISMATCH", "SCOPE_DENIED"].includes(safe.code)) throw safe;
      results.push({ externalRef: item.externalRef, ok: false, code: safe.code, error: safe.message, ...(safe.issues ? { issues: safe.issues } : {}) });
    }
  }
  return { results };
}

async function mappedListing(context: ProviderContext, externalRef: string, tx: any = db) {
  assertExternalRef(externalRef);
  const [row] = await tx
    .select({ mapping: providerResourceMappings, offer: offers })
    .from(providerResourceMappings)
    .innerJoin(offers, eq(offers.id, providerResourceMappings.resourceId))
    .where(
      and(
        eq(providerResourceMappings.connectionId, context.connection.id),
        eq(providerResourceMappings.resourceType, "LISTING"),
        eq(providerResourceMappings.externalRef, externalRef),
      ),
    );
  if (!row) throw providerError(404, "RESOURCE_NOT_FOUND", "المورد غير موجود");
  return row as { mapping: typeof providerResourceMappings.$inferSelect; offer: typeof offers.$inferSelect };
}

export async function readProviderListing(context: ProviderContext, externalRef: string) {
  assertProviderScope(context, "listings:read");
  const { offer } = await mappedListing(context, externalRef);
  const market = await connectionMarket(context);
  return { externalRef, listing: listing(offer, context.owner, market) };
}

/** A provider deletion archives through the canonical lifecycle; nothing is hard-deleted. */
export async function archiveProviderListing(context: ProviderContext, externalRef: string) {
  assertProviderScope(context, "listings:write");
  assertExternalRef(externalRef);
  try {
    return await withReferenceLock(`provider:${context.connection.id}:LISTING:${externalRef}`, async (tx) => {
      await assertProviderStillAuthorized(tx, context);
      const { offer } = await mappedListing(context, externalRef, tx);
      const market = await connectionMarket(context, tx);
      const archived = await archiveOwnedListing({ listingId: offer.id, ownerId: context.owner.id, market }, tx);
      await markProviderSync(tx, context.connection.id);
      await providerAudit(tx, market.id, context.owner.id, "PROVIDER_LISTING_ARCHIVED", { connectionId: context.connection.id, externalRef, listingId: offer.id });
      return { externalRef, listing: listing(archived, context.owner, market) };
    });
  } catch (error) {
    throw asProviderError(error);
  }
}

// ─── Drivers: link only ──────────────────────────────────────────────────────

export const DRIVER_LINK_CODE_TTL_MS = 10 * 60 * 1000;

function linkSignature(payload: string) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("Driver link signing key is unavailable");
  return createHmac("sha256", secret).update(`dinar-driver-link\0${payload}`).digest("base64url");
}

/**
 * The driver's own consent: a signed, short-lived code naming the driver's profile in
 * the driver's active market. Only the account itself can issue it.
 */
export async function createDriverLinkCode(input: { userId: string }) {
  const [user] = await db.select().from(users).where(eq(users.id, input.userId));
  if (!user || user.status !== "ACTIVE") throw Object.assign(new Error("حسابك غير نشط حاليًا"), { status: 403 });
  const [profile] = await db
    .select()
    .from(driverProfiles)
    .where(and(eq(driverProfiles.userId, user.id), eq(driverProfiles.marketId, user.activeMarketId)));
  if (!profile) throw Object.assign(new Error("سجّل كسائق في جاسم أولًا، ثم أنشئ رمز الربط."), { status: 409 });
  const expiresAt = Date.now() + DRIVER_LINK_CODE_TTL_MS;
  const payload = Buffer.from(`${profile.id}|${profile.marketId}|${expiresAt}|${randomBytes(6).toString("hex")}`).toString("base64url");
  return { linkCode: `dlk_${payload}.${linkSignature(payload)}`, expiresAt: new Date(expiresAt).toISOString() };
}

function verifyDriverLinkCode(code: unknown) {
  const invalid = () => providerError(400, "INVALID_PAYLOAD", "رمز ربط السائق غير صالح أو منتهي", ["linkCode"]);
  const match = typeof code === "string" ? /^dlk_([A-Za-z0-9_-]{20,200})\.([A-Za-z0-9_-]{43})$/.exec(code) : null;
  if (!match) throw invalid();
  const expected = Buffer.from(linkSignature(match[1]!));
  const given = Buffer.from(match[2]!);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw invalid();
  const [profileId, marketId, expiry] = Buffer.from(match[1]!, "base64url").toString("utf8").split("|");
  if (!profileId || !marketId || !(Number(expiry) > Date.now())) throw invalid();
  return { profileId, marketId };
}

const ProviderDriverLinkInput = z.object({ externalRef: z.string(), linkCode: z.string().max(400) }).strict();

function driverView(externalRef: string, profile: typeof driverProfiles.$inferSelect) {
  // Operational state only: no name, phone, location or assignment parties.
  return { externalRef, status: profile.status, availability: profile.availability, vehicleType: profile.vehicleType, serviceCity: profile.serviceCity };
}

export async function linkProviderDriver(context: ProviderContext, raw: unknown) {
  assertProviderScope(context, "drivers:link");
  const parsed = ProviderDriverLinkInput.safeParse(raw);
  if (!parsed.success) throw providerError(400, "INVALID_PAYLOAD", "بيانات ربط السائق غير صالحة", issuePaths(parsed.error));
  const { externalRef } = parsed.data;
  assertExternalRef(externalRef);
  const { profileId, marketId } = verifyDriverLinkCode(parsed.data.linkCode);
  if (marketId !== context.connection.marketId) throw providerError(409, "MARKET_MISMATCH", "السائق مسجل في سوق آخر");
  return withReferenceLock(`provider:${context.connection.id}:DRIVER_PROFILE:${externalRef}`, async (tx) => {
    await assertProviderStillAuthorized(tx, context);
    const [profile] = await tx.select().from(driverProfiles).where(eq(driverProfiles.id, profileId)).for("share");
    if (!profile || profile.marketId !== context.connection.marketId) throw providerError(400, "INVALID_PAYLOAD", "رمز ربط السائق غير صالح أو منتهي", ["linkCode"]);
    const [byRef] = await tx
      .select()
      .from(providerResourceMappings)
      .where(
        and(
          eq(providerResourceMappings.connectionId, context.connection.id),
          eq(providerResourceMappings.resourceType, "DRIVER_PROFILE"),
          eq(providerResourceMappings.externalRef, externalRef),
        ),
      );
    if (byRef && byRef.resourceId !== profile.id) throw providerError(409, "RESOURCE_CONFLICT", "المعرّف الخارجي مربوط بسائق آخر");
    if (!byRef) {
      const inserted = await tx
        .insert(providerResourceMappings)
        .values({ id: randomUUID(), connectionId: context.connection.id, resourceType: "DRIVER_PROFILE", externalRef, resourceId: profile.id })
        .onConflictDoNothing()
        .returning();
      if (!inserted.length) throw providerError(409, "RESOURCE_CONFLICT", "هذا السائق مربوط بجهة أخرى");
      await providerAudit(tx, profile.marketId, context.owner.id, "PROVIDER_DRIVER_LINKED", {
        connectionId: context.connection.id,
        externalRef,
        driverProfileId: profile.id,
      });
    }
    await markProviderSync(tx, context.connection.id);
    return driverView(externalRef, profile);
  });
}

async function mappedDriver(context: ProviderContext, externalRef: string, tx: any = db) {
  assertExternalRef(externalRef);
  const [row] = await tx
    .select({ mapping: providerResourceMappings, profile: driverProfiles })
    .from(providerResourceMappings)
    .innerJoin(driverProfiles, eq(driverProfiles.id, providerResourceMappings.resourceId))
    .where(
      and(
        eq(providerResourceMappings.connectionId, context.connection.id),
        eq(providerResourceMappings.resourceType, "DRIVER_PROFILE"),
        eq(providerResourceMappings.externalRef, externalRef),
      ),
    );
  if (!row) throw providerError(404, "RESOURCE_NOT_FOUND", "المورد غير موجود");
  return row as { mapping: typeof providerResourceMappings.$inferSelect; profile: typeof driverProfiles.$inferSelect };
}

export async function readProviderDriver(context: ProviderContext, externalRef: string) {
  assertProviderScope(context, "drivers:link");
  const { profile } = await mappedDriver(context, externalRef);
  return driverView(externalRef, profile);
}

/** Ends only the relationship; the account, profile and assignments are untouched. */
export async function unlinkProviderDriver(context: ProviderContext, externalRef: string) {
  assertProviderScope(context, "drivers:link");
  return withReferenceLock(`provider:${context.connection.id}:DRIVER_PROFILE:${externalRef}`, async (tx) => {
    await assertProviderStillAuthorized(tx, context);
    const { mapping, profile } = await mappedDriver(context, externalRef, tx);
    await tx.delete(providerResourceMappings).where(eq(providerResourceMappings.id, mapping.id));
    await providerAudit(tx, profile.marketId, context.owner.id, "PROVIDER_DRIVER_UNLINKED", {
      connectionId: context.connection.id,
      externalRef,
      driverProfileId: profile.id,
      reason: "PROVIDER",
    });
    return { externalRef, linked: false };
  });
}

/** The driver withdraws consent from every provider link on its own profiles. */
export async function unlinkOwnDriverProfile(input: { userId: string }) {
  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(providerResourceMappings)
      .where(
        and(
          eq(providerResourceMappings.resourceType, "DRIVER_PROFILE"),
          sql`${providerResourceMappings.resourceId} in (select id from driver_profiles where user_id = ${input.userId})`,
        ),
      )
      .returning();
    for (const mapping of removed) {
      const [profile] = await tx.select({ marketId: driverProfiles.marketId }).from(driverProfiles).where(eq(driverProfiles.id, mapping.resourceId));
      await providerAudit(tx, profile!.marketId, input.userId, "PROVIDER_DRIVER_UNLINKED", {
        connectionId: mapping.connectionId,
        externalRef: mapping.externalRef,
        driverProfileId: mapping.resourceId,
        reason: "DRIVER",
      });
    }
    return { unlinked: removed.length };
  });
}
