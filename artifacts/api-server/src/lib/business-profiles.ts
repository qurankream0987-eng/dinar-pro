/**
 * D2 — DINAR Business identity: the one authority for business records, their verification
 * documents and their review.
 *
 *  - The applicant is always the authenticated session's account; nothing in a request names an owner.
 *  - A record starts as DRAFT and moves only through `transition()` below:
 *      DRAFT → DOCUMENTS_REQUIRED → PENDING_REVIEW → VERIFIED | REJECTED | DOCUMENTS_REQUIRED
 *      VERIFIED ⇄ SUSPENDED
 *    VERIFIED, REJECTED, SUSPENDED and the reinstatement are written by a DINAR reviewer (ADMIN),
 *    never the applicant (also a database CHECK), never a payment, never model output.
 *  - Documents are private objects under business-documents/<owner>/; no public route serves the
 *    prefix; a document is reviewable only after a registered scanner reports CLEAN. Without a
 *    scanner nothing can be verified — the record waits, it is never marked verified.
 *  - Every move is an append-only business_verification_events row (actor, reason).
 *  - Strangers get 404 for every record, document and action; the record is bound to its market.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  businessMemberships,
  businessProfiles,
  businessVerificationDocuments,
  businessVerificationEvents,
  db,
  offers,
  users,
} from "@workspace/db";
import { foldArabicLetters, normalizeDigits } from "../ai/arabic-normalization";
import { ObjectNotFoundError, ObjectStorageService } from "./objectStorage";
import { logger } from "./logger";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Profile = typeof businessProfiles.$inferSelect;
type DocumentRow = typeof businessVerificationDocuments.$inferSelect;
type MarketRef = { id: string; countryCode?: string; name?: string };

const fail = (status: number, message: string, code?: string) => Object.assign(new Error(message), { status, expose: true, ...(code ? { code } : {}) });
const notFound = () => fail(404, "النشاط التجاري غير موجود", "BUSINESS_NOT_FOUND");

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export const BUSINESS_CATEGORIES: Record<string, string> = {
  RESTAURANT: "مطعم",
  GRILL_RESTAURANT: "مطعم ومشاوي",
  CAFE: "مقهى",
  BAKERY: "مخبز وحلويات",
  GROCERY: "بقالة وتموينات",
  RETAIL: "متجر",
  FASHION: "أزياء",
  ELECTRONICS: "إلكترونيات",
  BEAUTY: "تجميل وصالون",
  AUTOMOTIVE: "سيارات وخدمات سيارات",
  HOME_SERVICES: "خدمات منزلية",
  SERVICES: "خدمات",
  OTHER: "نشاط آخر",
};
export const LEGAL_FORMS = ["SOLE_PROPRIETORSHIP", "COMPANY", "PARTNERSHIP", "OTHER"] as const;
export const LEGAL_FORM_LABELS: Record<(typeof LEGAL_FORMS)[number], string> = {
  SOLE_PROPRIETORSHIP: "مؤسسة فردية",
  COMPANY: "شركة",
  PARTNERSHIP: "شركة تضامن أو توصية",
  OTHER: "شكل قانوني آخر",
};
export const DOCUMENT_KINDS = ["COMMERCIAL_REGISTRATION", "COMMERCIAL_LICENSE", "MUNICIPALITY_LICENSE", "AUTHORIZATION_LETTER", "OWNER_IDENTITY"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  COMMERCIAL_REGISTRATION: "السجل التجاري",
  COMMERCIAL_LICENSE: "الرخصة التجارية",
  MUNICIPALITY_LICENSE: "ترخيص البلدية",
  AUTHORIZATION_LETTER: "تفويض بالتمثيل",
  OWNER_IDENTITY: "إثبات هوية صاحب النشاط",
};
export const STATUS_LABELS: Record<string, string> = {
  DRAFT: "مسودة",
  DOCUMENTS_REQUIRED: "بانتظار المستندات",
  PENDING_REVIEW: "بانتظار التحقق",
  VERIFIED: "نشاط موثّق",
  REJECTED: "مرفوض",
  SUSPENDED: "موقوف",
};

/**
 * Document requirements per market and legal form: every group must be satisfied by one document
 * of any kind in it. Configurable here (code review), not by the model. NOT legally reviewed: the
 * precise documents depend on legal form, activity and local rules (owner/legal decision D2-1).
 */
export const BUSINESS_DOCUMENT_POLICY: {
  legallyReviewed: false;
  maxDocumentBytes: number;
  retentionDaysAfterDecision: number;
  markets: Record<string, Partial<Record<(typeof LEGAL_FORMS)[number] | "UNSPECIFIED", DocumentKind[][]>>>;
  fallback: DocumentKind[][];
} = {
  legallyReviewed: false,
  maxDocumentBytes: 10 * 1024 * 1024,
  retentionDaysAfterDecision: 365,
  markets: {
    KW: {
      SOLE_PROPRIETORSHIP: [["COMMERCIAL_LICENSE", "COMMERCIAL_REGISTRATION"]],
      COMPANY: [["COMMERCIAL_REGISTRATION"]],
      PARTNERSHIP: [["COMMERCIAL_REGISTRATION"]],
      OTHER: [["COMMERCIAL_REGISTRATION", "COMMERCIAL_LICENSE"]],
      UNSPECIFIED: [["COMMERCIAL_REGISTRATION", "COMMERCIAL_LICENSE"]],
    },
  },
  fallback: [["COMMERCIAL_REGISTRATION", "COMMERCIAL_LICENSE"]],
};

export function documentRequirements(marketId: string, legalForm: string | null): DocumentKind[][] {
  const market = BUSINESS_DOCUMENT_POLICY.markets[marketId];
  return (market?.[(legalForm ?? "UNSPECIFIED") as keyof typeof market] ?? market?.UNSPECIFIED ?? BUSINESS_DOCUMENT_POLICY.fallback).map((group) => [...group]);
}

const CONTENT_SIGNATURES: Record<string, (bytes: Buffer) => boolean> = {
  "application/pdf": (bytes) => bytes.subarray(0, 5).toString("latin1") === "%PDF-",
  "image/jpeg": (bytes) => bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  "image/png": (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
};
const EXTENSIONS: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" };

// ─── Scanner (malware / quarantine) ──────────────────────────────────────────

/** A malware scanner adapter. None is registered in any environment today. */
export interface BusinessDocumentScanner {
  readonly scannerKey: string;
  scan(input: { bytes: Buffer; contentType: string }): Promise<"CLEAN" | "INFECTED">;
}
let scanner: BusinessDocumentScanner | undefined;
/** Registration is server code only (never a request or a policy row). */
export function registerBusinessDocumentScanner(adapter: BusinessDocumentScanner) {
  if (process.env.NODE_ENV === "production" && process.env.DINAR_LIVE_PROVIDERS_ENABLED !== "true") throw new Error("Live document scanners are disabled");
  scanner = adapter;
}
export function unregisterBusinessDocumentScanner() {
  scanner = undefined;
}
export function businessVerificationReadiness() {
  return {
    scanner: scanner ? ("REGISTERED" as const) : ("NOT_CONNECTED" as const),
    privateStorage: process.env.OBJECT_STORAGE_PROVIDER === "s3" || Boolean(process.env.PRIVATE_OBJECT_DIR) ? ("CONFIGURED" as const) : ("NOT_CONFIGURED" as const),
    humanReview: "ADMIN_REVIEWER" as const,
    legallyReviewedRequirements: BUSINESS_DOCUMENT_POLICY.legallyReviewed,
    note: scanner
      ? "يُفحص كل مستند قبل أن يصل إلى المراجع."
      : "لا يوجد فاحص برمجيات خبيثة موصول؛ تبقى المستندات في الحجر ولا يمكن توثيق أي نشاط حتى يُوصل الفاحص.",
  };
}

// ─── Normalisation and input ─────────────────────────────────────────────────

export function normalizeBusinessName(name: string): string {
  return foldArabicLetters(normalizeDigits(name))
    .toLowerCase()
    .replace(/ة/gu, "ه")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/(?:^|\s)(?:مطعم|مطاعم|شركه|مؤسسه|محل|متجر|مقهى|كافيه)(?=\s|$)/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 120) || foldArabicLetters(name).trim().slice(0, 120);
}

function registrationDigest(number: string) {
  const normalized = normalizeDigits(number).replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  if (normalized.length < 4 || normalized.length > 40) throw fail(400, "رقم السجل التجاري غير صالح", "REGISTRATION_NUMBER_INVALID");
  return { sha256: createHash("sha256").update(`dinar-business-registration:v1:${normalized}`).digest("hex"), last4: normalized.slice(-4) };
}

const plainText = (max: number) => z.string().trim().max(max).refine((value) => !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value), "نص غير صالح");
const Hours = z
  .array(z.object({ day: z.number().int().min(0).max(6), opens: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), closes: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/) }).strict())
  .max(21);
const Contact = z
  .object({
    phone: z.string().regex(/^\+?[0-9 ]{6,20}$/).optional(),
    email: z.string().email().max(160).optional(),
    website: z.string().url().max(200).refine((url) => url.startsWith("https://"), "https فقط").optional(),
  })
  .strict();
const Address = z.object({ city: plainText(60).optional(), area: plainText(60).optional(), line: plainText(160).optional() }).strict();
const ServicePreferences = z
  .object({
    delivery: z.boolean().optional(),
    pickup: z.boolean().optional(),
    dineIn: z.boolean().optional(),
    inquiries: z.enum(["OPEN", "CLOSED"]).optional(),
  })
  .strict();

export const BusinessDraftInput = z
  .object({
    displayName: plainText(120).pipe(z.string().min(2)),
    categoryKey: z.enum(Object.keys(BUSINESS_CATEGORIES) as [string, ...string[]]),
    description: plainText(1000).optional(),
    legalName: plainText(200).pipe(z.string().min(2)).optional(),
    legalForm: z.enum(LEGAL_FORMS).optional(),
    address: Address.optional(),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
  })
  .strict();
export const BusinessUpdateInput = z
  .object({
    expectedRevision: z.number().int().min(1),
    displayName: plainText(120).pipe(z.string().min(2)).optional(),
    categoryKey: z.enum(Object.keys(BUSINESS_CATEGORIES) as [string, ...string[]]).optional(),
    description: plainText(1000).optional(),
    legalName: plainText(200).pipe(z.string().min(2)).optional(),
    legalForm: z.enum(LEGAL_FORMS).optional(),
    registrationNumber: z.string().trim().min(4).max(60).optional(),
    address: Address.optional(),
    contact: Contact.optional(),
    openingHours: Hours.optional(),
    servicePreferences: ServicePreferences.optional(),
  })
  .strict();

/** Fields that describe the legal identity: frozen once a reviewer has looked at them. */
const IDENTITY_FIELDS = ["displayName", "legalName", "legalForm", "registrationNumber"] as const;
const EDITABLE_STATUSES = ["DRAFT", "DOCUMENTS_REQUIRED"];
const MAX_OPEN_BUSINESSES_PER_OWNER = 5;

// ─── Views ───────────────────────────────────────────────────────────────────

export type BusinessAction =
  | "COMPLETE_INFO"
  | "START_VERIFICATION"
  | "UPLOAD_DOCUMENTS"
  | "SUBMIT_FOR_REVIEW"
  | "VIEW_STATUS"
  | "ADD_CATALOG"
  | "REVIEW_PLANS"
  | "PUBLISH"
  | "UNPUBLISH"
  | "CONNECT_SYSTEM";

/** What the reviewer needs to compare with the document, before the request can be submitted. */
function missingInfo(profile: Profile): string[] {
  const missing: string[] = [];
  if (!profile.legalName) missing.push("الاسم القانوني كما في السجل");
  if (!profile.registrationNumberSha256) missing.push("رقم السجل التجاري");
  return missing;
}

function requirementState(profile: Profile, documents: readonly DocumentRow[]) {
  const usable = documents.filter((doc) => ["UPLOADED", "ACCEPTED"].includes(doc.status) && doc.scanStatus !== "INFECTED");
  return documentRequirements(profile.marketId, profile.legalForm).map((group) => ({
    anyOf: group,
    labels: group.map((kind) => DOCUMENT_KIND_LABELS[kind]),
    satisfied: usable.some((doc) => (group as string[]).includes(doc.kind)),
  }));
}

/** Actions are derived from the stored state and the viewer's role, never from the request. */
export function businessActions(profile: Profile, documents: readonly DocumentRow[]): BusinessAction[] {
  const actions: BusinessAction[] = [];
  const status = profile.verificationStatus;
  if (EDITABLE_STATUSES.includes(status) && missingInfo(profile).length) actions.push("COMPLETE_INFO");
  if (status === "DRAFT") actions.push("START_VERIFICATION");
  if (status === "DOCUMENTS_REQUIRED") {
    actions.push("UPLOAD_DOCUMENTS");
    if (!missingInfo(profile).length && requirementState(profile, documents).every((group) => group.satisfied)) actions.push("SUBMIT_FOR_REVIEW");
  }
  actions.push("VIEW_STATUS");
  if (status !== "REJECTED" && status !== "SUSPENDED") actions.push("ADD_CATALOG");
  actions.push("REVIEW_PLANS");
  if (status === "VERIFIED") actions.push(profile.publicationStatus === "PUBLISHED" ? "UNPUBLISH" : "PUBLISH", "CONNECT_SYSTEM");
  return actions;
}

function documentView(doc: DocumentRow) {
  return {
    id: doc.id,
    kind: doc.kind,
    kindLabel: DOCUMENT_KIND_LABELS[doc.kind as DocumentKind] ?? doc.kind,
    status: doc.status,
    scanStatus: doc.scanStatus,
    contentType: doc.contentType,
    sizeBytes: doc.sizeBytes,
    uploadedAt: doc.createdAt.toISOString(),
    ...(doc.reviewNote ? { reviewNote: doc.reviewNote } : {}),
  };
}

/** The owner's view. No object path, no registration number (last four only), no reviewer identity. */
export function businessOwnerView(profile: Profile, documents: readonly DocumentRow[], extra: { listingCount?: number; lastDecisionReason?: string | null } = {}) {
  return {
    id: profile.id,
    marketId: profile.marketId,
    displayName: profile.displayName,
    legalName: profile.legalName,
    legalForm: profile.legalForm,
    legalFormLabel: profile.legalForm ? LEGAL_FORM_LABELS[profile.legalForm as (typeof LEGAL_FORMS)[number]] : null,
    categoryKey: profile.categoryKey,
    categoryLabel: BUSINESS_CATEGORIES[profile.categoryKey] ?? profile.categoryKey,
    description: profile.description,
    address: profile.address,
    contact: profile.contact,
    openingHours: profile.openingHours,
    servicePreferences: profile.servicePreferences,
    registrationNumberLast4: profile.registrationNumberLast4,
    verificationStatus: profile.verificationStatus,
    statusLabel: STATUS_LABELS[profile.verificationStatus] ?? profile.verificationStatus,
    verified: profile.verificationStatus === "VERIFIED",
    publicationStatus: profile.publicationStatus,
    revision: profile.revision,
    missingInfo: missingInfo(profile),
    requirements: requirementState(profile, documents),
    requirementsLegallyReviewed: BUSINESS_DOCUMENT_POLICY.legallyReviewed,
    documents: documents.filter((doc) => doc.status !== "UPLOAD_PENDING").map(documentView),
    actions: businessActions(profile, documents),
    listingCount: extra.listingCount ?? 0,
    salesHistory: "NONE_IN_DINAR" as const,
    ...(extra.lastDecisionReason ? { lastDecisionReason: extra.lastDecisionReason } : {}),
    verification: businessVerificationReadiness(),
    integrations: integrationView(profile),
    updatedAt: profile.updatedAt.toISOString(),
  };
}
export type BusinessOwnerView = ReturnType<typeof businessOwnerView>;

/** What anyone may see: a published, verified business only. No legal or registration data. */
export function businessPublicView(profile: Profile) {
  return {
    id: profile.id,
    marketId: profile.marketId,
    displayName: profile.displayName,
    categoryLabel: BUSINESS_CATEGORIES[profile.categoryKey] ?? profile.categoryKey,
    description: profile.description,
    city: profile.address.city ?? null,
    area: profile.address.area ?? null,
    openingHours: profile.openingHours,
    servicePreferences: profile.servicePreferences,
    verified: true as const,
    verifiedLabel: "نشاط تجاري موثّق",
  };
}

// ─── Reads ───────────────────────────────────────────────────────────────────

async function documentsOf(businessId: string, tx: Tx | typeof db = db) {
  return tx.select().from(businessVerificationDocuments).where(eq(businessVerificationDocuments.businessId, businessId)).orderBy(asc(businessVerificationDocuments.createdAt));
}

/** The record if the actor is its applicant in the active market; otherwise 404 (never 403). */
async function ownedProfile(actorId: string, market: MarketRef, businessId: string, tx: Tx | typeof db = db, lock = false) {
  if (!/^[0-9a-f-]{36}$/.test(businessId)) throw notFound();
  const query = tx.select().from(businessProfiles).where(and(eq(businessProfiles.id, businessId), eq(businessProfiles.ownerUserId, actorId), eq(businessProfiles.marketId, market.id)));
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw notFound();
  return row;
}

async function ownerViewOf(profile: Profile) {
  const documents = await documentsOf(profile.id);
  const [{ count }] = (await db
    .select({ count: sql<number>`count(*)::int` })
    .from(offers)
    .where(and(eq(offers.sellerId, profile.ownerUserId), eq(offers.marketId, profile.marketId), inArray(offers.status, ["DRAFT", "PUBLISHED", "PAUSED", "SOLD_OUT"])))) as Array<{ count: number }>;
  const [decision] = await db
    .select({ reason: businessVerificationEvents.reason })
    .from(businessVerificationEvents)
    .where(and(eq(businessVerificationEvents.businessId, profile.id), eq(businessVerificationEvents.actorKind, "REVIEWER")))
    .orderBy(desc(businessVerificationEvents.createdAt))
    .limit(1);
  return businessOwnerView(profile, documents, { listingCount: count, lastDecisionReason: decision?.reason ?? null });
}

export async function listOwnBusinesses(actorId: string, market: MarketRef) {
  const rows = await db
    .select()
    .from(businessProfiles)
    .where(and(eq(businessProfiles.ownerUserId, actorId), eq(businessProfiles.marketId, market.id)))
    .orderBy(desc(businessProfiles.updatedAt))
    .limit(20);
  return Promise.all(rows.map(ownerViewOf));
}

export async function getOwnBusiness(actorId: string, market: MarketRef, businessId: string) {
  return ownerViewOf(await ownedProfile(actorId, market, businessId));
}

/** The actor's business that a DINAR Business subscription may serve: owned, in market, VERIFIED. */
export async function verifiedBusinessForSubscription(actorId: string, market: MarketRef, businessId: string) {
  const profile = await ownedProfile(actorId, market, businessId);
  if (profile.verificationStatus !== "VERIFIED")
    throw fail(409, "جاسم بزنس يتطلب نشاطًا تجاريًا موثّقًا من مراجع دينار؛ الدفع لا يوثّق النشاط", "BUSINESS_NOT_VERIFIED");
  return profile;
}

/** Is this business VERIFIED (not suspended) and still the subscriber's? Used at entitlement time. */
export async function isVerifiedBusinessOf(userId: string, marketId: string, businessId: string | null | undefined): Promise<boolean> {
  if (!businessId) return false;
  const [row] = await db
    .select({ status: businessProfiles.verificationStatus })
    .from(businessProfiles)
    .where(and(eq(businessProfiles.id, businessId), eq(businessProfiles.ownerUserId, userId), eq(businessProfiles.marketId, marketId)));
  return row?.status === "VERIFIED";
}

export async function publicBusiness(businessId: string) {
  if (!/^[0-9a-f-]{36}$/.test(businessId)) throw notFound();
  const [row] = await db
    .select()
    .from(businessProfiles)
    .where(and(eq(businessProfiles.id, businessId), eq(businessProfiles.publicationStatus, "PUBLISHED"), eq(businessProfiles.verificationStatus, "VERIFIED")));
  if (!row) throw notFound();
  return businessPublicView(row);
}

// ─── Writes (owner) ──────────────────────────────────────────────────────────

async function recordEvent(
  tx: Tx,
  input: { businessId: string; actorKind: "OWNER" | "REVIEWER" | "SYSTEM"; actorId: string | null; action: string; fromStatus: string | null; toStatus: string; reason?: string | null; documentIds?: string[] },
) {
  await tx.insert(businessVerificationEvents).values({
    id: randomUUID(),
    businessId: input.businessId,
    actorKind: input.actorKind,
    actorId: input.actorId,
    action: input.action,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    reason: input.reason ?? null,
    documentIds: input.documentIds ?? [],
  });
}

async function activeActor(tx: Tx, actorId: string) {
  const [actor] = await tx.select({ status: users.status }).from(users).where(eq(users.id, actorId)).for("share");
  if (actor?.status !== "ACTIVE") throw fail(403, "حسابك مقيّد حاليًا.", "ACCOUNT_RESTRICTED");
}

/**
 * Creates the applicant's DRAFT. A retry (same key) or a repeated introduction of the same name in
 * the same market returns the existing record instead of a second one. Never verified, never paid.
 */
export async function createBusinessDraft(actorId: string, market: MarketRef, raw: unknown) {
  const input = BusinessDraftInput.parse(raw);
  const normalizedName = normalizeBusinessName(input.displayName);
  const result = await db.transaction(async (tx) => {
    await activeActor(tx, actorId);
    const [prior] = await tx.select().from(businessProfiles).where(and(eq(businessProfiles.ownerUserId, actorId), eq(businessProfiles.idempotencyKey, input.idempotencyKey)));
    if (prior) {
      if (prior.marketId !== market.id || prior.normalizedName !== normalizedName) throw fail(409, "مفتاح عدم التكرار مستخدم لطلب مختلف", "IDEMPOTENCY_KEY_REUSED");
      return { profile: prior, created: false };
    }
    const [same] = await tx
      .select()
      .from(businessProfiles)
      .where(and(eq(businessProfiles.ownerUserId, actorId), eq(businessProfiles.marketId, market.id), eq(businessProfiles.normalizedName, normalizedName), ne(businessProfiles.verificationStatus, "REJECTED")));
    if (same) return { profile: same, created: false };
    const [{ open }] = (await tx
      .select({ open: sql<number>`count(*)::int` })
      .from(businessProfiles)
      .where(and(eq(businessProfiles.ownerUserId, actorId), ne(businessProfiles.verificationStatus, "REJECTED")))) as Array<{ open: number }>;
    if (open >= MAX_OPEN_BUSINESSES_PER_OWNER) throw fail(409, "وصلت إلى الحد الأقصى لعدد الأنشطة قيد الإنشاء", "BUSINESS_LIMIT_REACHED");
    const id = randomUUID();
    const [profile] = await tx
      .insert(businessProfiles)
      .values({
        id,
        ownerUserId: actorId,
        marketId: market.id,
        displayName: input.displayName,
        normalizedName,
        legalName: input.legalName ?? null,
        legalForm: input.legalForm ?? null,
        categoryKey: input.categoryKey,
        description: input.description ?? "",
        address: input.address ?? {},
        idempotencyKey: input.idempotencyKey,
      })
      .onConflictDoNothing()
      .returning();
    if (!profile) {
      // A concurrent request for the same owner, market and name won the race: return its record.
      const [winner] = await tx
        .select()
        .from(businessProfiles)
        .where(and(eq(businessProfiles.ownerUserId, actorId), eq(businessProfiles.marketId, market.id), eq(businessProfiles.normalizedName, normalizedName), ne(businessProfiles.verificationStatus, "REJECTED")));
      if (!winner) throw fail(409, "تعذر إنشاء المسودة؛ أعد المحاولة", "BUSINESS_CREATE_CONFLICT");
      return { profile: winner, created: false };
    }
    await tx.insert(businessMemberships).values({ id: randomUUID(), businessId: id, userId: actorId, role: "APPLICANT", status: "ACTIVE" });
    await recordEvent(tx, { businessId: id, actorKind: "OWNER", actorId, action: "CREATED", fromStatus: null, toStatus: "DRAFT" });
    return { profile, created: true };
  });
  if (result.created) logger.info({ event: "business_profile_created", marketId: market.id }, "business draft created");
  return { created: result.created, business: await ownerViewOf(result.profile) };
}

export async function updateBusinessProfile(actorId: string, market: MarketRef, businessId: string, raw: unknown) {
  const input = BusinessUpdateInput.parse(raw);
  const profile = await db.transaction(async (tx) => {
    await activeActor(tx, actorId);
    const current = await ownedProfile(actorId, market, businessId, tx, true);
    if (current.revision !== input.expectedRevision) throw fail(409, "تغيّرت بيانات النشاط منذ آخر قراءة؛ راجعها ثم أعد المحاولة", "REVISION_CONFLICT");
    const status = current.verificationStatus;
    if (status === "REJECTED") throw fail(409, "هذا الطلب مرفوض؛ أنشئ طلبًا جديدًا لتعديل البيانات", "BUSINESS_REJECTED");
    const touchesIdentity = IDENTITY_FIELDS.some((field) => input[field] !== undefined) || input.categoryKey !== undefined;
    if (touchesIdentity && !EDITABLE_STATUSES.includes(status))
      throw fail(409, "لا يمكن تغيير الاسم أو البيانات القانونية بعد إرسال الطلب للتحقق", "IDENTITY_FROZEN");
    const registration = input.registrationNumber ? registrationDigest(input.registrationNumber) : undefined;
    const [row] = await tx
      .update(businessProfiles)
      .set({
        ...(input.displayName ? { displayName: input.displayName, normalizedName: normalizeBusinessName(input.displayName) } : {}),
        ...(input.categoryKey ? { categoryKey: input.categoryKey } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.legalName ? { legalName: input.legalName } : {}),
        ...(input.legalForm ? { legalForm: input.legalForm } : {}),
        ...(registration ? { registrationNumberSha256: registration.sha256, registrationNumberLast4: registration.last4 } : {}),
        ...(input.address ? { address: { ...current.address, ...input.address } } : {}),
        ...(input.contact ? { contact: input.contact as Record<string, string> } : {}),
        ...(input.openingHours ? { openingHours: input.openingHours } : {}),
        ...(input.servicePreferences ? { servicePreferences: { ...current.servicePreferences, ...input.servicePreferences } } : {}),
        revision: current.revision + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(businessProfiles.id, current.id), eq(businessProfiles.revision, current.revision)))
      .returning();
    if (!row) throw fail(409, "تغيّرت بيانات النشاط منذ آخر قراءة", "REVISION_CONFLICT");
    await recordEvent(tx, { businessId: row.id, actorKind: "OWNER", actorId, action: "UPDATED", fromStatus: status, toStatus: status });
    return row;
  });
  return ownerViewOf(profile);
}

/** DRAFT → DOCUMENTS_REQUIRED: the owner asks to verify; documents can be uploaded from here. */
export async function startBusinessVerification(actorId: string, market: MarketRef, businessId: string) {
  const profile = await db.transaction(async (tx) => {
    await activeActor(tx, actorId);
    const current = await ownedProfile(actorId, market, businessId, tx, true);
    if (current.verificationStatus === "DOCUMENTS_REQUIRED") return current;
    if (current.verificationStatus !== "DRAFT") throw fail(409, `الطلب في حالة «${STATUS_LABELS[current.verificationStatus]}»`, "INVALID_TRANSITION");
    const [row] = await tx.update(businessProfiles).set({ verificationStatus: "DOCUMENTS_REQUIRED", revision: current.revision + 1, updatedAt: new Date() }).where(eq(businessProfiles.id, current.id)).returning();
    await recordEvent(tx, { businessId: current.id, actorKind: "OWNER", actorId, action: "UPDATED", fromStatus: "DRAFT", toStatus: "DOCUMENTS_REQUIRED" });
    return row!;
  });
  return ownerViewOf(profile);
}

export const DocumentUploadInput = z
  .object({
    kind: z.enum(DOCUMENT_KINDS),
    contentType: z.enum(["application/pdf", "image/jpeg", "image/png"]),
    size: z.number().int().min(1).max(BUSINESS_DOCUMENT_POLICY.maxDocumentBytes),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
  })
  .strict();

const MAX_DOCUMENTS_PER_BUSINESS = 12;

/** A signed, short-lived PUT for one private document of the actor's own business. */
export async function requestDocumentUpload(actorId: string, market: MarketRef, businessId: string, raw: unknown, storage = new ObjectStorageService()) {
  const input = DocumentUploadInput.parse(raw);
  const profile = await ownedProfile(actorId, market, businessId);
  if (profile.verificationStatus !== "DOCUMENTS_REQUIRED") throw fail(409, "رفع المستندات متاح عندما يطلبها التحقق فقط", "DOCUMENTS_NOT_REQUESTED");
  const existing = await documentsOf(profile.id);
  const prior = existing.find((doc) => doc.idempotencyKey === input.idempotencyKey);
  if (prior && (prior.kind !== input.kind || prior.contentType !== input.contentType || prior.sizeBytes !== input.size))
    throw fail(409, "مفتاح عدم التكرار مستخدم لطلب مختلف", "IDEMPOTENCY_KEY_REUSED");
  if (!prior && existing.length >= MAX_DOCUMENTS_PER_BUSINESS) throw fail(409, "وصلت إلى الحد الأقصى لعدد المستندات", "DOCUMENT_LIMIT_REACHED");
  const objectName = prior ? prior.objectPath.slice("/objects/".length) : `business-documents/${actorId}/${randomUUID()}.${EXTENSIONS[input.contentType]}`;
  const uploadURL = await storage.getObjectEntityUploadURL(objectName);
  const objectPath = `/objects/${objectName}`;
  const normalized = storage.normalizeObjectEntityPath(uploadURL);
  if (normalized.startsWith("/") && normalized !== objectPath) throw new Error("تعذر إنشاء مسار آمن للمستند");
  if (!prior)
    await db.insert(businessVerificationDocuments).values({
      id: randomUUID(),
      businessId: profile.id,
      ownerUserId: actorId,
      kind: input.kind,
      objectPath,
      contentType: input.contentType,
      sizeBytes: input.size,
      idempotencyKey: input.idempotencyKey,
    });
  const [doc] = await db.select().from(businessVerificationDocuments).where(eq(businessVerificationDocuments.objectPath, objectPath));
  return { documentId: doc!.id, uploadURL, expiresInSeconds: 900, maxBytes: BUSINESS_DOCUMENT_POLICY.maxDocumentBytes };
}

/**
 * Confirms an upload: the stored object must exist, match the declared size and type (by its
 * leading bytes) and be stable while read. Then it is scanned if a scanner is registered; without
 * one it stays NOT_SCANNED (quarantined). Bytes never leave this function except to the scanner.
 */
export async function completeDocumentUpload(actorId: string, market: MarketRef, businessId: string, documentId: string, storage = new ObjectStorageService()) {
  const profile = await ownedProfile(actorId, market, businessId);
  if (!/^[0-9a-f-]{36}$/.test(documentId)) throw notFound();
  const [doc] = await db.select().from(businessVerificationDocuments).where(and(eq(businessVerificationDocuments.id, documentId), eq(businessVerificationDocuments.businessId, profile.id), eq(businessVerificationDocuments.ownerUserId, actorId)));
  if (!doc) throw notFound();
  if (doc.status !== "UPLOAD_PENDING") return ownerViewOf(profile);
  if (profile.verificationStatus !== "DOCUMENTS_REQUIRED") throw fail(409, "رفع المستندات متاح عندما يطلبها التحقق فقط", "DOCUMENTS_NOT_REQUESTED");
  let file;
  try {
    file = await storage.getObjectEntityFile(doc.objectPath);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) throw fail(409, "لم يصل الملف بعد؛ ارفعه ثم أعد المحاولة", "UPLOAD_MISSING");
    throw error;
  }
  const [before] = await file.getMetadata();
  const generation = String(before.generation ?? "");
  if (!generation) throw fail(503, "تعذر التحقق من نسخة المستند", "STORAGE_GENERATION_MISSING");
  const size = Number(before.size);
  if (size !== doc.sizeBytes || size > BUSINESS_DOCUMENT_POLICY.maxDocumentBytes) throw fail(409, "حجم الملف لا يطابق المصرّح به", "UPLOAD_SIZE_MISMATCH");
  const [bytes] = await file.download();
  const [after] = await file.getMetadata();
  if (String(after.generation ?? "") !== generation || bytes.length !== size) throw fail(409, "تغيّر الملف أثناء التحقق؛ ارفعه مجددًا", "UPLOAD_CHANGED");
  if (!CONTENT_SIGNATURES[doc.contentType]?.(bytes)) {
    await file.delete({ ignoreNotFound: true });
    await db.delete(businessVerificationDocuments).where(and(eq(businessVerificationDocuments.id, doc.id), eq(businessVerificationDocuments.status, "UPLOAD_PENDING")));
    throw fail(400, "نوع الملف لا يطابق محتواه؛ ارفع PDF أو صورة JPEG أو PNG", "UPLOAD_TYPE_MISMATCH");
  }
  await storage.trySetObjectEntityAclPolicy(doc.objectPath, { owner: actorId, visibility: "private" }).catch(() => undefined);
  const scanStatus = scanner ? await scanner.scan({ bytes, contentType: doc.contentType }) : "NOT_SCANNED";
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(businessVerificationDocuments)
      .set({ status: "UPLOADED", scanStatus, objectGeneration: generation, updatedAt: new Date() })
      .where(and(eq(businessVerificationDocuments.id, doc.id), eq(businessVerificationDocuments.status, "UPLOAD_PENDING")))
      .returning();
    if (!updated) return;
    await recordEvent(tx, { businessId: profile.id, actorKind: "OWNER", actorId, action: "DOCUMENT_UPLOADED", fromStatus: profile.verificationStatus, toStatus: profile.verificationStatus, documentIds: [doc.id] });
    if (scanStatus !== "NOT_SCANNED")
      await recordEvent(tx, { businessId: profile.id, actorKind: "SYSTEM", actorId: null, action: "DOCUMENT_SCANNED", fromStatus: profile.verificationStatus, toStatus: profile.verificationStatus, reason: scanStatus, documentIds: [doc.id] });
  });
  if (scanStatus === "INFECTED") await file.delete({ ignoreNotFound: true }).catch(() => undefined);
  return ownerViewOf(await ownedProfile(actorId, market, businessId));
}

/** DOCUMENTS_REQUIRED → PENDING_REVIEW when every required document group has an upload. */
export async function submitBusinessForReview(actorId: string, market: MarketRef, businessId: string) {
  const profile = await db.transaction(async (tx) => {
    await activeActor(tx, actorId);
    const current = await ownedProfile(actorId, market, businessId, tx, true);
    if (current.verificationStatus === "PENDING_REVIEW") return current;
    if (current.verificationStatus !== "DOCUMENTS_REQUIRED") throw fail(409, `الطلب في حالة «${STATUS_LABELS[current.verificationStatus]}»`, "INVALID_TRANSITION");
    const missing = missingInfo(current);
    if (missing.length) throw fail(409, `أكمل أولًا: ${missing.join("، ")}`, "INFO_INCOMPLETE");
    const documents = await documentsOf(current.id, tx);
    const unmet = requirementState(current, documents).filter((group) => !group.satisfied);
    if (unmet.length) throw fail(409, `ينقص: ${unmet.map((group) => group.labels.join(" أو ")).join("، ")}`, "DOCUMENTS_MISSING");
    try {
      const [row] = await tx.update(businessProfiles).set({ verificationStatus: "PENDING_REVIEW", revision: current.revision + 1, updatedAt: new Date() }).where(eq(businessProfiles.id, current.id)).returning();
      await recordEvent(tx, { businessId: current.id, actorKind: "OWNER", actorId, action: "SUBMITTED", fromStatus: "DOCUMENTS_REQUIRED", toStatus: "PENDING_REVIEW", documentIds: documents.filter((doc) => doc.status === "UPLOADED").map((doc) => doc.id) });
      return row!;
    } catch (error) {
      if ((error as { code?: string; cause?: { code?: string } }).code === "23505" || (error as { cause?: { code?: string } }).cause?.code === "23505")
        throw fail(409, "رقم السجل هذا مرتبط بنشاط آخر قيد المراجعة أو موثّق في هذا السوق؛ تواصل مع دعم جاسم", "REGISTRATION_ALREADY_CLAIMED");
      throw error;
    }
  });
  return ownerViewOf(profile);
}

/** Publication is the owner's choice, and only for a VERIFIED business (also a DB CHECK). */
export async function setBusinessPublication(actorId: string, market: MarketRef, businessId: string, publish: boolean) {
  const profile = await db.transaction(async (tx) => {
    const current = await ownedProfile(actorId, market, businessId, tx, true);
    if (publish && current.verificationStatus !== "VERIFIED") throw fail(409, "النشر متاح للنشاط الموثّق فقط", "BUSINESS_NOT_VERIFIED");
    const target = publish ? "PUBLISHED" : "UNPUBLISHED";
    if (current.publicationStatus === target) return current;
    const [row] = await tx.update(businessProfiles).set({ publicationStatus: target, revision: current.revision + 1, updatedAt: new Date() }).where(eq(businessProfiles.id, current.id)).returning();
    await recordEvent(tx, { businessId: current.id, actorKind: "OWNER", actorId, action: publish ? "PUBLISHED" : "UNPUBLISHED", fromStatus: current.verificationStatus, toStatus: current.verificationStatus });
    return row!;
  });
  return ownerViewOf(profile);
}

// ─── Review authority (DINAR reviewer) ───────────────────────────────────────

export const ReviewDecisionInput = z
  .object({
    decision: z.enum(["VERIFY", "REJECT", "REQUEST_DOCUMENTS", "SUSPEND", "REINSTATE"]),
    reason: plainText(500).optional(),
    expectedRevision: z.number().int().min(1),
  })
  .strict();

const DECISIONS: Record<z.infer<typeof ReviewDecisionInput>["decision"], { from: string[]; to: string; action: string; needsReason: boolean }> = {
  VERIFY: { from: ["PENDING_REVIEW"], to: "VERIFIED", action: "VERIFIED", needsReason: false },
  REJECT: { from: ["PENDING_REVIEW", "DOCUMENTS_REQUIRED"], to: "REJECTED", action: "REJECTED", needsReason: true },
  REQUEST_DOCUMENTS: { from: ["PENDING_REVIEW"], to: "DOCUMENTS_REQUIRED", action: "DOCUMENTS_REQUESTED", needsReason: true },
  SUSPEND: { from: ["VERIFIED"], to: "SUSPENDED", action: "SUSPENDED", needsReason: true },
  REINSTATE: { from: ["SUSPENDED"], to: "VERIFIED", action: "REINSTATED", needsReason: true },
};

export function isBusinessReviewer(role: string | undefined) {
  return role === "ADMIN";
}

/**
 * The only writer of VERIFIED, REJECTED, SUSPENDED and reinstatement. The reviewer is a DINAR
 * ADMIN who is not the applicant; VERIFY requires every required document group to have a CLEAN,
 * scanned upload (so without a scanner nothing is ever verified), and no other verified business
 * in the market may carry the same name.
 */
export async function decideBusinessVerification(reviewer: { id: string; role: string }, businessId: string, raw: unknown) {
  if (!isBusinessReviewer(reviewer.role)) throw notFound();
  const input = ReviewDecisionInput.parse(raw);
  const rule = DECISIONS[input.decision];
  if (rule.needsReason && !input.reason?.trim()) throw fail(400, "اكتب سبب القرار", "REASON_REQUIRED");
  if (!/^[0-9a-f-]{36}$/.test(businessId)) throw notFound();
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(businessProfiles).where(eq(businessProfiles.id, businessId)).for("update");
    if (!current) throw notFound();
    if (current.ownerUserId === reviewer.id) throw fail(403, "لا يمكنك مراجعة نشاط تقدّمت به بنفسك", "SELF_REVIEW_FORBIDDEN");
    if (current.revision !== input.expectedRevision) throw fail(409, "تغيّر الطلب منذ آخر قراءة", "REVISION_CONFLICT");
    if (!rule.from.includes(current.verificationStatus)) throw fail(409, `لا يمكن «${input.decision}» من حالة ${current.verificationStatus}`, "INVALID_TRANSITION");
    const documents = await documentsOf(current.id, tx);
    const now = new Date();
    let acceptedIds: string[] = [];
    if (input.decision === "VERIFY") {
      const clean = documents.filter((doc) => doc.status === "UPLOADED" && doc.scanStatus === "CLEAN");
      const unmet = documentRequirements(current.marketId, current.legalForm).filter((group) => !clean.some((doc) => (group as string[]).includes(doc.kind)));
      if (unmet.length)
        throw fail(409, scanner ? "لا توجد مستندات مفحوصة وسليمة تغطي كل المتطلبات" : "لا يمكن التوثيق: لا يوجد فاحص للمستندات موصول؛ تبقى المستندات في الحجر", scanner ? "DOCUMENTS_NOT_CLEAN" : "SCANNER_NOT_CONNECTED");
      const [twin] = await tx
        .select({ id: businessProfiles.id })
        .from(businessProfiles)
        .where(and(eq(businessProfiles.marketId, current.marketId), eq(businessProfiles.normalizedName, current.normalizedName), ne(businessProfiles.ownerUserId, current.ownerUserId), inArray(businessProfiles.verificationStatus, ["VERIFIED", "SUSPENDED"])));
      if (twin) throw fail(409, "يوجد نشاط موثّق آخر بالاسم نفسه في هذا السوق؛ تحقّق من انتحال محتمل قبل التوثيق", "NAME_ALREADY_VERIFIED");
      acceptedIds = clean.map((doc) => doc.id);
      await tx.update(businessVerificationDocuments).set({ status: "ACCEPTED", retainUntil: new Date(now.getTime() + BUSINESS_DOCUMENT_POLICY.retentionDaysAfterDecision * 86_400_000), updatedAt: now }).where(inArray(businessVerificationDocuments.id, acceptedIds));
      await tx
        .insert(businessMemberships)
        .values({ id: randomUUID(), businessId: current.id, userId: current.ownerUserId, role: "VERIFIED_OWNER", status: "ACTIVE", grantedBy: reviewer.id })
        .onConflictDoUpdate({ target: [businessMemberships.businessId, businessMemberships.userId], set: { role: "VERIFIED_OWNER", status: "ACTIVE", grantedBy: reviewer.id, updatedAt: now } });
    }
    if (input.decision === "REJECT" || input.decision === "REQUEST_DOCUMENTS") {
      const reviewed = documents.filter((doc) => doc.status === "UPLOADED").map((doc) => doc.id);
      if (reviewed.length)
        await tx
          .update(businessVerificationDocuments)
          .set({ status: input.decision === "REJECT" ? "REJECTED" : "SUPERSEDED", reviewNote: input.reason ?? null, retainUntil: new Date(now.getTime() + BUSINESS_DOCUMENT_POLICY.retentionDaysAfterDecision * 86_400_000), updatedAt: now })
          .where(inArray(businessVerificationDocuments.id, reviewed));
      acceptedIds = reviewed;
    }
    const [row] = await tx
      .update(businessProfiles)
      .set({
        verificationStatus: rule.to,
        revision: current.revision + 1,
        updatedAt: now,
        ...(input.decision === "VERIFY" ? { verifiedAt: now, verifiedBy: reviewer.id } : {}),
        ...(input.decision === "SUSPEND" ? { suspendedAt: now, publicationStatus: "UNPUBLISHED" } : {}),
        ...(input.decision === "REINSTATE" ? { suspendedAt: null } : {}),
      })
      .where(eq(businessProfiles.id, current.id))
      .returning();
    await recordEvent(tx, { businessId: current.id, actorKind: "REVIEWER", actorId: reviewer.id, action: rule.action, fromStatus: current.verificationStatus, toStatus: rule.to, reason: input.reason ?? null, documentIds: acceptedIds });
    logger.info({ event: "business_verification_decided", decision: input.decision, marketId: current.marketId }, "business verification decided");
    return reviewerView(row!, await documentsOf(row!.id, tx));
  });
}

function reviewerView(profile: Profile, documents: readonly DocumentRow[]) {
  return {
    ...businessOwnerView(profile, documents),
    ownerUserId: profile.ownerUserId,
    normalizedName: profile.normalizedName,
    verifiedAt: profile.verifiedAt?.toISOString() ?? null,
  };
}

export async function businessReviewQueue(reviewer: { id: string; role: string }, status = "PENDING_REVIEW") {
  if (!isBusinessReviewer(reviewer.role)) throw notFound();
  const statusValue = (["PENDING_REVIEW", "DOCUMENTS_REQUIRED", "VERIFIED", "SUSPENDED", "REJECTED", "DRAFT"] as const).find((value) => value === status) ?? "PENDING_REVIEW";
  const rows = await db.select().from(businessProfiles).where(eq(businessProfiles.verificationStatus, statusValue)).orderBy(asc(businessProfiles.updatedAt)).limit(50);
  return Promise.all(rows.map(async (row) => reviewerView(row, await documentsOf(row.id))));
}

export async function businessForReviewer(reviewer: { id: string; role: string }, businessId: string) {
  if (!isBusinessReviewer(reviewer.role) || !/^[0-9a-f-]{36}$/.test(businessId)) throw notFound();
  const [row] = await db.select().from(businessProfiles).where(eq(businessProfiles.id, businessId));
  if (!row) throw notFound();
  const events = await db.select().from(businessVerificationEvents).where(eq(businessVerificationEvents.businessId, row.id)).orderBy(asc(businessVerificationEvents.createdAt));
  return {
    ...reviewerView(row, await documentsOf(row.id)),
    history: events.map((event) => ({ action: event.action, actorKind: event.actorKind, fromStatus: event.fromStatus, toStatus: event.toStatus, reason: event.reason, at: event.createdAt.toISOString() })),
  };
}

/** Reviewer-only bytes of one CLEAN document, with an access event. Never cached, never public. */
export async function documentContentForReviewer(reviewer: { id: string; role: string }, documentId: string, storage = new ObjectStorageService()) {
  if (!isBusinessReviewer(reviewer.role) || !/^[0-9a-f-]{36}$/.test(documentId)) throw notFound();
  const [doc] = await db.select().from(businessVerificationDocuments).where(eq(businessVerificationDocuments.id, documentId));
  if (!doc || !["UPLOADED", "ACCEPTED"].includes(doc.status)) throw notFound();
  if (doc.ownerUserId === reviewer.id) throw fail(403, "لا يمكنك مراجعة مستنداتك", "SELF_REVIEW_FORBIDDEN");
  if (doc.scanStatus !== "CLEAN") throw fail(409, "المستند في الحجر حتى يُفحص", "DOCUMENT_QUARANTINED");
  const file = await storage.getObjectEntityFile(doc.objectPath);
  const [bytes] = await file.download();
  await db.transaction(async (tx) => {
    const [profile] = await tx.select({ status: businessProfiles.verificationStatus }).from(businessProfiles).where(eq(businessProfiles.id, doc.businessId));
    await recordEvent(tx, { businessId: doc.businessId, actorKind: "REVIEWER", actorId: reviewer.id, action: "DOCUMENT_ACCESSED", fromStatus: profile!.status, toStatus: profile!.status, documentIds: [doc.id] });
  });
  return { contentType: doc.contentType, bytes };
}

// ─── External integration foundation (contracts only in D2) ──────────────────

/**
 * Outbound integrations with the owner's own systems (POS, store, accounting). Distinct from
 * DINAR-issued inbound provider keys (provider-connections.ts), which never grant DINAR access to
 * anyone's external system. D2 records a read-only request only: no adapter is registered, no
 * credential is accepted or stored (no secret manager is connected), nothing is fetched.
 */
export const INTEGRATION_KINDS = ["POS", "ONLINE_STORE", "ACCOUNTING", "DELIVERY_PLATFORM", "CUSTOM_API"] as const;
export const INTEGRATION_KIND_LABELS: Record<(typeof INTEGRATION_KINDS)[number], string> = {
  POS: "نظام نقاط البيع",
  ONLINE_STORE: "متجر إلكتروني",
  ACCOUNTING: "نظام محاسبة",
  DELIVERY_PLATFORM: "منصة توصيل",
  CUSTOM_API: "واجهة برمجية خاصة",
};
export const IntegrationRequestInput = z
  .object({
    kind: z.enum(INTEGRATION_KINDS),
    systemName: plainText(80).pipe(z.string().min(2)),
    endpointUrl: z.string().max(300).optional(),
    scopes: z.array(z.enum(["CATALOG_READ", "ORDERS_READ", "INVENTORY_READ"])).min(1).max(3),
  })
  .strict();

/**
 * SSRF guard for an owner-typed endpoint: https on 443, a public DNS name (no IP literals, no
 * loopback/private/link-local names, no credentials, no fragments). Resolution-time checks belong
 * to the future adapter, which must re-validate every resolved address.
 */
export function validateIntegrationEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw fail(400, "رابط النظام غير صالح", "ENDPOINT_INVALID");
  }
  const host = url.hostname.toLowerCase();
  const refused =
    url.protocol !== "https:" ||
    (url.port !== "" && url.port !== "443") ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    /^\[|^\d{1,3}(?:\.\d{1,3}){3}$|^0x|^\d+$/.test(host) ||
    !host.includes(".") ||
    /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|corp|localdomain|in-addr\.arpa|ip6\.arpa)$/.test(host) ||
    /(?:^|\.)(?:metadata|metadata\.google\.internal)$/.test(host);
  if (refused) throw fail(400, "يُقبل رابط https عام فقط (دون عناوين داخلية أو أرقام IP أو بيانات دخول)", "ENDPOINT_REFUSED");
  return url.toString();
}

type IntegrationRequest = { id: string; kind: string; systemName: string; endpointHost: string | null; scopes: string[]; status: "ADAPTER_UNAVAILABLE"; requestedAt: string };

function integrationView(profile: Profile) {
  const requests = (Array.isArray((profile.integrationPreferences as { requests?: unknown }).requests) ? (profile.integrationPreferences as { requests: IntegrationRequest[] }).requests : []).slice(-5);
  return {
    adaptersAvailable: [] as string[],
    requests: requests.map((item) => ({ ...item, kindLabel: INTEGRATION_KIND_LABELS[item.kind as (typeof INTEGRATION_KINDS)[number]] ?? item.kind, statusLabel: "لا يوجد موصّل جاهز لهذا النظام بعد" })),
    note: "مفتاح مزوّد جاسم يسمح لنظامك بإرسال إعلاناته إلى دينار فقط، ولا يمنح دينار وصولًا إلى نظامك. الربط بنظامك يحتاج موصّلًا معتمدًا وصلاحيات قراءة فقط تمنحها أنت.",
  };
}

export async function requestBusinessIntegration(actorId: string, market: MarketRef, businessId: string, raw: unknown) {
  const input = IntegrationRequestInput.parse(raw);
  const endpoint = input.endpointUrl ? validateIntegrationEndpoint(input.endpointUrl) : null;
  const profile = await db.transaction(async (tx) => {
    const current = await ownedProfile(actorId, market, businessId, tx, true);
    if (current.verificationStatus !== "VERIFIED") throw fail(409, "ربط الأنظمة متاح للنشاط الموثّق فقط", "BUSINESS_NOT_VERIFIED");
    const prefs = current.integrationPreferences as { requests?: IntegrationRequest[] };
    const requests = [
      ...(prefs.requests ?? []).slice(-9),
      { id: randomUUID(), kind: input.kind, systemName: input.systemName, endpointHost: endpoint ? new URL(endpoint).hostname : null, scopes: [...new Set(input.scopes)], status: "ADAPTER_UNAVAILABLE" as const, requestedAt: new Date().toISOString() },
    ];
    const [row] = await tx.update(businessProfiles).set({ integrationPreferences: { ...prefs, requests }, revision: current.revision + 1, updatedAt: new Date() }).where(eq(businessProfiles.id, current.id)).returning();
    await recordEvent(tx, { businessId: current.id, actorKind: "OWNER", actorId, action: "UPDATED", fromStatus: current.verificationStatus, toStatus: current.verificationStatus, reason: "INTEGRATION_REQUESTED" });
    return row!;
  });
  return ownerViewOf(profile);
}
