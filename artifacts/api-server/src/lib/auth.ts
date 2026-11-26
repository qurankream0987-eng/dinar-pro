import {
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
} from "node:crypto";

import { Router, type RequestHandler } from "express";
import {
  db,
  accountIdentities,
  users,
  sessions,
  markets,
  policyAcceptances,
  policyConsentEvents,
  phoneVerificationChallenges,
} from "@workspace/db";
import {
  LoginAccountBody,
  RegisterAccountBody,
  RequestPhoneVerificationChallengeBody,
  RequestPhoneVerificationChallengeResponse,
  VerifyPhoneVerificationChallengeBody,
  VerifyPhoneVerificationChallengeResponse,
} from "@workspace/api-zod";
import { canHoldSession, SESSION_STATUSES } from "./account-status";
import { grantPremiumTrialAtSignup } from "./ai-premium-trial";
import { signupConsentRows } from "./policy-lifecycle";
import { and, eq, gt, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import { providerDeploymentEnvironment } from "./market-capability-registry";
import { z } from "zod";
import {
  GOOGLE_PENDING_COOKIE,
  GOOGLE_PROVIDER,
  PENDING_TICKET_TTL_MS,
  googleClientId,
  issuePendingTicket,
  readPendingTicket,
  verifyGoogleIdToken,
} from "./google-identity";
import { countries, countryByCode } from "@workspace/global";
import {
  allMarkets,
  GUEST_MARKET_COOKIE,
  isMarketAvailable,
  marketFor,
  resolveMarket,
} from "./markets";
import {
  invalidateSellerEmployeeSessionsForActor,
  invalidateSellerEmployeeSessionsForActorTx,
} from "./business-delegations";
import { DEFAULT_MARKET } from "@workspace/global";
import {
  AUTH_RATE_LIMIT_SCOPE,
  createAuthRateLimitMiddleware,
} from "./auth-rate-limiter";
import {
  getPhoneVerificationProvider,
  matchesPhoneVerificationCode,
  newPhoneVerificationCode,
  newRegistrationVerificationToken,
  phoneVerificationDigest,
  PHONE_VERIFICATION_CODE_TTL_MS,
  PHONE_VERIFICATION_MAX_ATTEMPTS,
} from "./phone-verification";
const scrypt = (password: string, salt: string, length: number, options: any) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCallback(password, salt, length, options, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
const phoneVerificationRequired = () =>
  process.env.NODE_ENV !== "development" ||
  process.env.BDINAR_REQUIRE_PHONE_VERIFICATION === "1";
/**
 * Owner decision 2026-11-26 (no SMS provider at launch): DINAR_PHONE_VERIFICATION_MODE=
 * DEFERRED_WITH_VERIFIED_EMAIL lets an account hold a session when its EMAIL is verified (by Google)
 * even though its phone is not. The phone is still required (typed twice) as an unverified contact
 * number: it is never used to link or take over another account, and unverified buyers have a
 * limit on open cash orders. Any other value keeps phone ownership mandatory.
 */
export const phoneVerificationDeferred = () =>
  process.env.DINAR_PHONE_VERIFICATION_MODE === "DEFERRED_WITH_VERIFIED_EMAIL";
export function canIssueSession(user: { phoneVerified: boolean; emailVerifiedAt: Date | null }): boolean {
  if (!phoneVerificationRequired() || user.phoneVerified) return true;
  return phoneVerificationDeferred() && user.emailVerifiedAt !== null;
}
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = (await scrypt(password, salt, 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 67108864,
  })) as Buffer;
  return `scrypt:${salt}:${key.toString("hex")}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [, salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const key = (await scrypt(password, salt, 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 67108864,
  })) as Buffer;
  const expected = Buffer.from(hash, "hex");
  return key.length === expected.length && timingSafeEqual(key, expected);
}
export function normalizePhone(prefix: unknown, number: unknown) {
  if (typeof prefix !== "string" || typeof number !== "string" || number.length > 100) throw new Error("PHONE");
  const convert = (s: string) => s.replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-1632)).replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-1776)).replace(/[\s()-]/g,"");
  const code = convert(prefix).replace(/^\+/, "");
  let local = convert(number).replace(/^00/, "+");
  if (!/^\d{1,3}$/.test(code)) throw new Error("PHONE");
  const parsed = parsePhoneNumberFromString(local.startsWith("+") ? local : `+${code}${local}`, { extract: false });
  if (!parsed || !parsed.isValid() || parsed.ext || parsed.countryCallingCode !== code) throw new Error("PHONE");
  return { normalizedPhone: parsed.number, phoneNumber: parsed.nationalNumber, phoneCountryCode: `+${parsed.countryCallingCode}` };
}
export const safeUser = (u: typeof users.$inferSelect) => {
  const { passwordHash, email: _email, emailVerifiedAt: _emailVerifiedAt, ...safe } = u;
  return safe;
};
declare global {
  namespace Express {
    interface Request {
      actor?: typeof users.$inferSelect;
      sessionHash?: string;
    }
  }
}
export const sessionMiddleware: RequestHandler = async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  const token = req.cookies?.bdinar_session;
  if (typeof token === "string" && /^[a-f0-9]{64}$/.test(token)) {
    const rows = await db
      .select({ user: users })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(
        and(
          eq(sessions.id, digest(token)),
          gt(sessions.expiresAt, new Date()),
          inArray(users.status, [...SESSION_STATUSES]),
          !phoneVerificationRequired()
            ? undefined
            : phoneVerificationDeferred()
              ? or(eq(users.phoneVerified, true), isNotNull(users.emailVerifiedAt))
              : eq(users.phoneVerified, true),
        ),
      );
    if (rows[0]) {
      req.actor = rows[0].user;
      req.sessionHash = digest(token);
    }
  }
  next();
};
export const requireAuth: RequestHandler = (req, res, next) => {
  if (!req.actor) {
    res.status(401).json({ error: "سجّل الدخول للمتابعة" });
    return;
  }
  next();
};
const registrationLimit = createAuthRateLimitMiddleware((req) => {
  try {
    const phone = normalizePhone(
      req.body?.phoneCountryCode,
      req.body?.phoneNumber,
    );
    return {
      scope: AUTH_RATE_LIMIT_SCOPE.registrationPhone,
      value: phone.normalizedPhone,
    };
  } catch {
    return undefined;
  }
});
const loginLimit = createAuthRateLimitMiddleware((req) => {
  try {
    const phone = normalizePhone(
      req.body?.phoneCountryCode,
      req.body?.phoneNumber,
    );
    return {
      scope: AUTH_RATE_LIMIT_SCOPE.loginPhone,
      value: phone.normalizedPhone,
    };
  } catch {
    return undefined;
  }
});
const passwordChangeLimit = createAuthRateLimitMiddleware((req) =>
  req.actor
    ? {
        scope: AUTH_RATE_LIMIT_SCOPE.passwordUser,
        value: req.actor.id,
      }
    : undefined,
);
const router = Router();
const cookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
};
async function startSession(
  res: any,
  user: typeof users.$inferSelect,
  guestMarketId?: unknown,
) {
  let sessionUser = user;
  if (
    typeof guestMarketId === "string" &&
    guestMarketId.length <= 32 &&
    guestMarketId !== user.activeMarketId
  ) {
    const [selectedMarket] = await db
      .select()
      .from(markets)
      .where(eq(markets.id, guestMarketId));
    if (
      selectedMarket &&
      isMarketAvailable(await resolveMarket(selectedMarket))
    ) {
      const [updatedUser] = await db
        .update(users)
        .set({ activeMarketId: selectedMarket.id, updatedAt: new Date() })
        .where(eq(users.id, user.id))
        .returning();
      if (updatedUser) sessionUser = updatedUser;
    }
  }
  if (!canIssueSession(user))
    throw new Error("Cannot issue a session before phone ownership (or, in deferred mode, the email) is verified");
  const token = randomBytes(32).toString("hex");
  await db.insert(sessions).values({
    id: digest(token),
    userId: sessionUser.id,
    expiresAt: new Date(Date.now() + 7 * 86400000),
  });
  res.cookie("bdinar_session", token, {
    ...cookieOptions,
    maxAge: 7 * 86400000,
  });
  res.clearCookie(GUEST_MARKET_COOKIE, cookieOptions);
  return safeUser(sessionUser);
}
router.get("/auth/me", async (req, res): Promise<void> => {
  const market = await marketFor(req);
  res.json({
    user: req.actor ? safeUser(req.actor) : null,
    marketId: market.id,
  });
});
const phoneVerificationChallengeLimit = createAuthRateLimitMiddleware((req) => {
  try {
    const phone = normalizePhone(
      req.body?.phoneCountryCode,
      req.body?.phoneNumber,
    );
    return {
      scope: AUTH_RATE_LIMIT_SCOPE.phoneVerificationPhone,
      value: phone.normalizedPhone,
    };
  } catch {
    return undefined;
  }
});
const phoneVerificationCodeLimit = createAuthRateLimitMiddleware((req) =>
  typeof req.body?.challengeId === "string" &&
  /^[0-9a-f-]{36}$/i.test(req.body.challengeId)
    ? {
        scope: AUTH_RATE_LIMIT_SCOPE.phoneVerificationChallenge,
        value: req.body.challengeId,
      }
    : undefined,
);

router.post(
  "/auth/phone-verification/challenges",
  phoneVerificationChallengeLimit,
  async (req, res): Promise<void> => {
    const parsed = RequestPhoneVerificationChallengeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "أدخل رقم هاتف صالحًا" });
      return;
    }
    let phone;
    try {
      phone = normalizePhone(
        parsed.data.phoneCountryCode,
        parsed.data.phoneNumber,
      );
    } catch {
      res.status(400).json({ error: "رقم الهاتف غير صالح للدولة المختارة" });
      return;
    }
    const provider = getPhoneVerificationProvider();
    if (!provider) {
      res.status(503).json({ error: "خدمة التحقق من الهاتف غير مهيأة" });
      return;
    }

    const now = new Date();
    const challengeId = randomUUID();
    const code = newPhoneVerificationCode();
    const expiresAt = new Date(now.getTime() + PHONE_VERIFICATION_CODE_TTL_MS);
    await db
      .delete(phoneVerificationChallenges)
      .where(
        lte(
          phoneVerificationChallenges.expiresAt,
          new Date(now.getTime() - 24 * 60 * 60 * 1000),
        ),
      );
    await db.insert(phoneVerificationChallenges).values({
      id: challengeId,
      phoneHash: phoneVerificationDigest("phone", phone.normalizedPhone),
      codeHash: phoneVerificationDigest("code", `${challengeId}\0${code}`),
      expiresAt,
    });

    try {
      const delivery = await provider.sendCode(phone.normalizedPhone, code);
      const response = RequestPhoneVerificationChallengeResponse.parse({
        challengeId,
        expiresAt: expiresAt.toISOString(),
        // The development code is returned only by a development deployment, never by one
        // labelled staging or production (DINAR_DEPLOYMENT_ENV), whatever NODE_ENV says.
        ...((process.env.NODE_ENV === "development" ||
        process.env.NODE_ENV === "test") && providerDeploymentEnvironment() === "development"
          ? delivery
          : {}),
      });
      res.status(202).json(response);
    } catch {
      await db
        .update(phoneVerificationChallenges)
        .set({ codeHash: null, expiresAt: new Date(), updatedAt: new Date() })
        .where(eq(phoneVerificationChallenges.id, challengeId));
      req.log.warn(
        { provider: "phone-verification" },
        "Phone verification delivery failed",
      );
      res.status(503).json({ error: "تعذر إرسال رمز التحقق حاليًا" });
    }
  },
);

router.post(
  "/auth/phone-verification/challenges/verify",
  phoneVerificationCodeLimit,
  async (req, res): Promise<void> => {
    const parsed = VerifyPhoneVerificationChallengeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "رمز التحقق غير صالح أو منتهي الصلاحية" });
      return;
    }

    const now = new Date();
    const verificationToken = newRegistrationVerificationToken();
    const verified = await db.transaction(async (tx) => {
      const [challenge] = await tx
        .select()
        .from(phoneVerificationChallenges)
        .where(
          and(
            eq(phoneVerificationChallenges.id, parsed.data.challengeId),
            isNull(phoneVerificationChallenges.verifiedAt),
            isNull(phoneVerificationChallenges.consumedAt),
            isNotNull(phoneVerificationChallenges.codeHash),
            gt(phoneVerificationChallenges.expiresAt, now),
          ),
        )
        .for("update");
      if (
        !challenge?.codeHash ||
        challenge.attempts >= PHONE_VERIFICATION_MAX_ATTEMPTS
      ) {
        return false;
      }

      if (
        !matchesPhoneVerificationCode(
          challenge.codeHash,
          challenge.id,
          parsed.data.code,
        )
      ) {
        await tx
          .update(phoneVerificationChallenges)
          .set({
            attempts: challenge.attempts + 1,
            updatedAt: now,
          })
          .where(eq(phoneVerificationChallenges.id, challenge.id));
        return false;
      }

      await tx
        .update(phoneVerificationChallenges)
        .set({
          codeHash: null,
          registrationTokenHash: phoneVerificationDigest(
            "registration-token",
            verificationToken,
          ),
          verifiedAt: now,
          updatedAt: now,
        })
        .where(eq(phoneVerificationChallenges.id, challenge.id));
      return true;
    });

    if (!verified) {
      res.status(400).json({ error: "رمز التحقق غير صالح أو منتهي الصلاحية" });
      return;
    }
    res.json(
      VerifyPhoneVerificationChallengeResponse.parse({ verificationToken }),
    );
  },
);

/** The market a new account starts in (shared by password and Google sign-up). */
async function resolveSignupMarket(accountCountry: unknown): Promise<{ country: { countryCode: string }; activeMarketId: string } | { status: number; error: string }> {
  const country = typeof accountCountry === "string" ? countryByCode.get(accountCountry) : undefined;
  if (!country?.isSelectable) return { status: 400, error: "الدولة غير متاحة للتسجيل" };
  const [market] = await db
    .select()
    .from(markets)
    .where(
      and(
        eq(markets.countryCode, country.countryCode),
      ),
    );
  const [fallback] = await db.select().from(markets).where(eq(markets.id, DEFAULT_MARKET));
  let activeMarketId = market?.id;
  if (market) {
    const selectedMarket = await resolveMarket(market);
    if (!isMarketAvailable(selectedMarket) && fallback) {
      const fallbackMarket = await resolveMarket(fallback);
      if (isMarketAvailable(fallbackMarket)) activeMarketId = fallback.id;
    }
  } else if (fallback) {
    // Market launch must not gate account creation. If the requested country
    // has no row yet, attach the account to the configured default market even
    // while it is still preparing; transactional routes remain market-gated.
    activeMarketId = fallback.id;
  }
  if (!activeMarketId) return { status: 503, error: "لا يوجد سوق افتراضي متاح حاليًا للتسجيل" };
  return { country, activeMarketId };
}

/** Consumes one verified, unexpired phone challenge for exactly this phone; false if none. */
async function consumePhoneVerification(tx: any, verificationToken: string, normalizedPhone: string, now: Date) {
  const tokenHash = phoneVerificationDigest("registration-token", verificationToken);
  const phoneHash = phoneVerificationDigest("phone", normalizedPhone);
  const [challenge] = await tx
    .select()
    .from(phoneVerificationChallenges)
    .where(
      and(
        eq(phoneVerificationChallenges.registrationTokenHash, tokenHash),
        eq(phoneVerificationChallenges.phoneHash, phoneHash),
        isNotNull(phoneVerificationChallenges.verifiedAt),
        isNull(phoneVerificationChallenges.consumedAt),
        gt(phoneVerificationChallenges.expiresAt, now),
      ),
    )
    .for("update");
  if (!challenge) return false;
  await tx
    .update(phoneVerificationChallenges)
    .set({ consumedAt: now, updatedAt: now })
    .where(eq(phoneVerificationChallenges.id, challenge.id));
  return true;
}

router.post("/auth/register", registrationLimit, async (req, res) => {
  const parsed = RegisterAccountBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "راجع بيانات التسجيل وتحقق من ملكية رقم الهاتف",
    });
    return;
  }
  const b = parsed.data;
  let phone;
  try {
    phone = normalizePhone(b.phoneCountryCode, b.phoneNumber);
  } catch {
    res.status(400).json({ error: "رقم الهاتف غير صالح للدولة المختارة" });
    return;
  }
  if (
    typeof b.displayName !== "string" ||
    b.displayName.trim().length < 2 ||
    b.displayName.length > 80 ||
    typeof b.password !== "string" ||
    b.password.length < 12 ||
    b.password.length > 128 ||
    b.password !== b.confirmPassword ||
    b.acceptTerms !== true
  ) {
    res.status(400).json({
      error:
        "راجع الاسم وكلمة المرور (12 حرفًا على الأقل) وتأكيدها والموافقة على الشروط",
    });
    return;
  }
  // Owner decision 2026-11-25: every country may use Jassim (marketplace, cash sales). Provider
  // restrictions apply only where that provider is used (Whop payments check the country there).
  const signupMarket = await resolveSignupMarket(b.accountCountry);
  if ("error" in signupMarket) {
    res.status(signupMarket.status).json({ error: signupMarket.error });
    return;
  }
  const { country, activeMarketId } = signupMarket;
  const passwordHash = await hashPassword(b.password);
  const user = await db.transaction(async (tx) => {
    const now = new Date();
    let phoneVerified = false;
    if (b.verificationToken) {
      if (!(await consumePhoneVerification(tx, b.verificationToken, phone.normalizedPhone, now))) return { kind: "unverified" as const };
      phoneVerified = true;
    } else if (phoneVerificationRequired()) {
      return { kind: "unverified" as const };
    }

    const [created] = await tx
      .insert(users)
      .values({
        id: randomUUID(),
        displayName: b.displayName.trim(),
        ...phone,
        accountCountry: country.countryCode,
        activeMarketId,
        passwordHash,
        phoneVerified,
      })
      .onConflictDoNothing({ target: users.normalizedPhone })
      .returning();
    if (!created) return { kind: "duplicate" as const };
    await grantPremiumTrialAtSignup(tx, created.id, now);
    // acceptTerms covers every policy version that requires acceptance; the append-only
    // consent ledger records the same explicit signup decision with its content hash.
    const consentRows = await signupConsentRows(created.id, tx, "PHONE");
    await tx.insert(policyAcceptances).values(
      consentRows.map((row) => ({
        userId: created.id,
        policyKey: row.policyKey,
        policyVersion: row.policyVersion,
      })),
    );
    await tx.insert(policyConsentEvents).values(consentRows);
    return { kind: "created" as const, user: created };
  });
  if (user.kind === "unverified") {
    res.status(400).json({
      error: "يلزم التحقق من ملكية رقم الهاتف قبل إنشاء الحساب",
    });
    return;
  }
  if (user.kind === "duplicate") {
    res.status(409).json({
      error:
        "تعذر إكمال التسجيل بهذه البيانات. تحقق من البيانات أو استخدم تسجيل الدخول.",
    });
    return;
  }
  if (req.actor && req.actor.id !== user.user.id)
    await invalidateSellerEmployeeSessionsForActor(req.actor.id, "ACCOUNT_SWITCH");
  res.status(201).json({
    user: await startSession(
      res,
      user.user,
      req.cookies?.[GUEST_MARKET_COOKIE],
    ),
  });
});
// ─── Sign in with Google (identity only; phone ownership is still verified by SMS) ──────────────
const GoogleSignInBody = z.object({ idToken: z.string().min(20).max(4096) }).strict();
const GoogleCompleteBody = z
  .object({
    displayName: z.string().trim().min(2).max(80).optional(),
    phoneCountryCode: z.string().min(1).max(5),
    phoneNumber: z.string().min(1).max(32),
    accountCountry: z.string().min(2).max(3),
    acceptTerms: z.literal(true),
    verificationToken: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    phoneNumberConfirm: z.string().min(1).max(32).optional(),
  })
  .strict();
const pendingCookieOptions = { ...cookieOptions, sameSite: "strict" as const, maxAge: PENDING_TICKET_TTL_MS };

function requireGoogle() {
  const clientId = googleClientId();
  if (!clientId) throw Object.assign(new Error("تسجيل الدخول بحساب Google غير مفعّل."), { status: 503, code: "GOOGLE_SIGN_IN_DISABLED", expose: true });
  return clientId;
}

router.post("/auth/google", registrationLimit, async (req, res): Promise<void> => {
  const clientId = requireGoogle();
  const body = GoogleSignInBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "طلب Google غير صالح" });
    return;
  }
  const identity = await verifyGoogleIdToken(body.data.idToken, { clientId });
  const [linked] = await db
    .select({ user: users, identityId: accountIdentities.id })
    .from(accountIdentities)
    .innerJoin(users, eq(users.id, accountIdentities.userId))
    .where(and(eq(accountIdentities.provider, GOOGLE_PROVIDER), eq(accountIdentities.subject, identity.subject)))
    .limit(1);
  res.set("Cache-Control", "no-store");
  if (linked) {
    if (!canHoldSession(linked.user.status) || !canIssueSession(linked.user)) {
      res.status(403).json({ error: "لا يمكن تسجيل الدخول بهذا الحساب حاليًا." });
      return;
    }
    await db.update(accountIdentities).set({ lastUsedAt: new Date(), updatedAt: new Date() }).where(eq(accountIdentities.id, linked.identityId));
    res.clearCookie(GOOGLE_PENDING_COOKIE, pendingCookieOptions);
    if (req.actor && req.actor.id !== linked.user.id) await invalidateSellerEmployeeSessionsForActor(req.actor.id, "ACCOUNT_SWITCH");
    res.json({ status: "SIGNED_IN", user: await startSession(res, linked.user, req.cookies?.[GUEST_MARKET_COOKIE]) });
    return;
  }
  // Not linked yet: nothing is created. The browser keeps a short-lived signed ticket and must
  // now prove phone ownership through the existing SMS challenge.
  res.cookie(GOOGLE_PENDING_COOKIE, issuePendingTicket(identity), pendingCookieOptions);
  res.json({ status: "PHONE_VERIFICATION_REQUIRED", email: identity.email, name: identity.name, phoneMode: phoneVerificationDeferred() ? "CONFIRM_TWICE" : "SMS" });
});

router.post("/auth/google/complete", registrationLimit, async (req, res): Promise<void> => {
  requireGoogle();
  res.set("Cache-Control", "no-store");
  const identity = readPendingTicket(req.cookies?.[GOOGLE_PENDING_COOKIE]);
  if (!identity) {
    res.status(401).json({ error: "انتهت جلسة Google. سجّل الدخول بحساب Google من جديد." });
    return;
  }
  const parsed = GoogleCompleteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "راجع رقم الهاتف ورمز التحقق والموافقة على الشروط" });
    return;
  }
  const b = parsed.data;
  let phone;
  try {
    phone = normalizePhone(b.phoneCountryCode, b.phoneNumber);
  } catch {
    res.status(400).json({ error: "رقم الهاتف غير صالح للدولة المختارة" });
    return;
  }
  // Deferred mode: no SMS. The phone is typed twice and kept as an UNVERIFIED contact number; the
  // Google-verified email is the account's proof of identity. Without a verified Google email there
  // is no account.
  const deferred = phoneVerificationDeferred() && !b.verificationToken;
  if (deferred) {
    let confirm;
    try {
      confirm = b.phoneNumberConfirm ? normalizePhone(b.phoneCountryCode, b.phoneNumberConfirm) : undefined;
    } catch {
      confirm = undefined;
    }
    if (!confirm || confirm.normalizedPhone !== phone.normalizedPhone) {
      res.status(400).json({ error: "رقما الهاتف غير متطابقين. اكتب رقمك مرتين بنفس الطريقة.", code: "PHONE_CONFIRMATION_MISMATCH" });
      return;
    }
    if (!identity.email) {
      res.status(400).json({ error: "حساب Google هذا بلا بريد موثّق. استخدم حسابًا آخر.", code: "GOOGLE_EMAIL_REQUIRED" });
      return;
    }
  } else if (!b.verificationToken) {
    res.status(400).json({ error: "يلزم التحقق من ملكية رقم الهاتف برمز SMS صالح" });
    return;
  }
  const signupMarket = await resolveSignupMarket(b.accountCountry);
  if ("error" in signupMarket) {
    res.status(signupMarket.status).json({ error: signupMarket.error });
    return;
  }
  // Google users sign in with Google; the password is random and unknown (reset sets a real one).
  const passwordHash = await hashPassword(randomBytes(32).toString("base64url"));
  const result = await db.transaction(async (tx) => {
    const now = new Date();
    if (!deferred && !(await consumePhoneVerification(tx, b.verificationToken!, phone.normalizedPhone, now))) return { kind: "unverified" as const };
    const [existing] = await tx.select().from(users).where(eq(users.normalizedPhone, phone.normalizedPhone)).for("update").limit(1);
    let user = existing;
    let kind: "LINKED" | "CREATED" = "LINKED";
    // An unverified phone proves nothing: it never links to (or takes over) an existing account.
    if (existing && deferred) return { kind: "phone_taken" as const };
    if (deferred) {
      const [emailOwner] = await tx.select({ id: users.id }).from(users).where(eq(users.email, identity.email!.toLowerCase())).limit(1);
      if (emailOwner) return { kind: "conflict" as const };
    }
    if (existing) {
      // The SMS code just proved ownership of this account's phone: linking is allowed, once.
      if (!canHoldSession(existing.status)) return { kind: "blocked" as const };
      if (!existing.phoneVerified) await tx.update(users).set({ phoneVerified: true }).where(eq(users.id, existing.id));
    } else {
      const displayName = (b.displayName ?? identity.name ?? "").trim();
      if (displayName.length < 2) return { kind: "name" as const };
      const [created] = await tx
        .insert(users)
        .values({
          id: randomUUID(),
          displayName: displayName.slice(0, 80),
          ...phone,
          accountCountry: signupMarket.country.countryCode,
          activeMarketId: signupMarket.activeMarketId,
          passwordHash,
          phoneVerified: !deferred,
          ...(deferred ? { email: identity.email!.toLowerCase(), emailVerifiedAt: now } : {}),
        })
        .onConflictDoNothing({ target: users.normalizedPhone })
        .returning();
      if (!created) return { kind: "duplicate" as const };
      await grantPremiumTrialAtSignup(tx, created.id, now);
      const consentRows = await signupConsentRows(created.id, tx, "GOOGLE");
      await tx.insert(policyAcceptances).values(consentRows.map((row) => ({ userId: created.id, policyKey: row.policyKey, policyVersion: row.policyVersion })));
      await tx.insert(policyConsentEvents).values(consentRows);
      user = created;
      kind = "CREATED";
    }
    const [identityRow] = await tx
      .insert(accountIdentities)
      .values({ id: randomUUID(), userId: user!.id, provider: GOOGLE_PROVIDER, subject: identity.subject, email: identity.email, emailVerified: true, lastUsedAt: now })
      .onConflictDoNothing()
      .returning();
    // The Google account is already linked elsewhere, or this account already has another one.
    if (!identityRow) return { kind: "conflict" as const };
    return { kind, user: user! };
  });
  if (result.kind === "unverified") {
    res.status(400).json({ error: "يلزم التحقق من ملكية رقم الهاتف برمز SMS صالح" });
    return;
  }
  if (result.kind === "phone_taken") {
    res.status(409).json({ error: "رقم الهاتف هذا مسجّل بحساب آخر. إن كان حسابك فسجّل الدخول بكلمة المرور، أو تواصل مع الدعم.", code: "PHONE_ALREADY_REGISTERED" });
    return;
  }
  if (result.kind === "name") {
    res.status(400).json({ error: "اكتب اسمك (حرفان على الأقل)" });
    return;
  }
  if (result.kind === "blocked") {
    res.status(403).json({ error: "لا يمكن ربط هذا الحساب حاليًا." });
    return;
  }
  if (result.kind === "duplicate" || result.kind === "conflict") {
    res.status(409).json({ error: "حساب Google هذا أو رقم الهاتف مرتبط بحساب آخر. سجّل الدخول بالطريقة المعتادة." });
    return;
  }
  res.clearCookie(GOOGLE_PENDING_COOKIE, pendingCookieOptions);
  if (req.actor && req.actor.id !== result.user.id) await invalidateSellerEmployeeSessionsForActor(req.actor.id, "ACCOUNT_SWITCH");
  res.status(result.kind === "CREATED" ? 201 : 200).json({ status: result.kind, user: await startSession(res, result.user, req.cookies?.[GUEST_MARKET_COOKIE]) });
});

router.post("/auth/login", loginLimit, async (req, res): Promise<void> => {
  const parsed = LoginAccountBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(401).json({ error: "رقم الهاتف أو كلمة المرور غير صحيحة" });
    return;
  }
  let phone;
  try {
    phone = normalizePhone(
      parsed.data.phoneCountryCode,
      parsed.data.phoneNumber,
    );
  } catch {
    res.status(401).json({ error: "رقم الهاتف أو كلمة المرور غير صحيحة" });
    return;
  }
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.normalizedPhone, phone.normalizedPhone));
  const password = parsed.data.password;
  const valid =
    typeof password === "string" &&
    password.length <= 128 &&
    (await verifyPassword(
      password,
      user?.passwordHash ??
        "scrypt:00000000000000000000000000000000:" + "00".repeat(64),
    ));
  if (!user || !canHoldSession(user.status) || !valid) {
    res.status(401).json({ error: "رقم الهاتف أو كلمة المرور غير صحيحة" });
    return;
  }
  let sessionUser = user;
  if (!user.phoneVerified && phoneVerificationRequired() && !canIssueSession(user)) {
    if (!parsed.data.verificationToken) {
      res.status(401).json({ error: "رقم الهاتف أو كلمة المرور غير صحيحة" });
      return;
    }
    const tokenHash = phoneVerificationDigest(
      "registration-token",
      parsed.data.verificationToken,
    );
    const phoneHash = phoneVerificationDigest("phone", phone.normalizedPhone);
    const now = new Date();
    const verifiedUser = await db.transaction(async (tx) => {
      const [challenge] = await tx
        .select()
        .from(phoneVerificationChallenges)
        .where(
          and(
            eq(phoneVerificationChallenges.registrationTokenHash, tokenHash),
            eq(phoneVerificationChallenges.phoneHash, phoneHash),
            isNotNull(phoneVerificationChallenges.verifiedAt),
            isNull(phoneVerificationChallenges.consumedAt),
            gt(phoneVerificationChallenges.expiresAt, now),
          ),
        )
        .for("update");
      if (!challenge) return undefined;
      await tx
        .update(phoneVerificationChallenges)
        .set({ consumedAt: now, updatedAt: now })
        .where(eq(phoneVerificationChallenges.id, challenge.id));
      const [verified] = await tx
        .update(users)
        .set({ phoneVerified: true, updatedAt: now })
        .where(eq(users.id, user.id))
        .returning();
      return verified;
    });
    if (!verifiedUser) {
      res.status(401).json({ error: "رقم الهاتف أو كلمة المرور غير صحيحة" });
      return;
    }
    sessionUser = verifiedUser;
  }
  if (req.actor && req.actor.id !== sessionUser.id)
    await invalidateSellerEmployeeSessionsForActor(req.actor.id, "ACCOUNT_SWITCH");
  else if (
    req.actor &&
    typeof req.cookies?.[GUEST_MARKET_COOKIE] === "string" &&
    req.cookies[GUEST_MARKET_COOKIE] !== req.actor.activeMarketId
  )
    await invalidateSellerEmployeeSessionsForActor(req.actor.id, "MARKET_CHANGE");
  if (req.sessionHash)
    await db.delete(sessions).where(eq(sessions.id, req.sessionHash));
  res.json({
    user: await startSession(
      res,
      sessionUser,
      req.cookies?.[GUEST_MARKET_COOKIE],
    ),
  });
});
router.post("/auth/logout", async (req, res) => {
  if (req.actor)
    await invalidateSellerEmployeeSessionsForActor(req.actor.id, "LOGOUT");
  if (req.sessionHash)
    await db.delete(sessions).where(eq(sessions.id, req.sessionHash));
  res.clearCookie("bdinar_session", cookieOptions);
  res.json({ ok: true });
});
router.get("/countries", (_req, res) => res.json(countries));
router.get("/markets", async (_req, res) => res.json(await allMarkets()));
router.patch("/account/market", async (req, res): Promise<void> => {
  const marketId =
    typeof req.body?.marketId === "string" ? req.body.marketId.trim() : "";
  if (!marketId || marketId.length > 32) {
    res.status(400).json({ error: "السوق غير موجود" });
    return;
  }
  const [market] = await db
    .select()
    .from(markets)
    .where(eq(markets.id, marketId));
  if (!market) {
    res.status(400).json({ error: "السوق غير موجود" });
    return;
  }
  const resolved = await resolveMarket(market);
  if (!isMarketAvailable(resolved)) {
    res.status(409).json({ error: "هذا السوق غير متاح للتصفح حاليًا. اختر سوقًا نشطًا بسعر وحدة معتمد." });
    return;
  }
  if (!req.actor) {
    res.cookie(GUEST_MARKET_COOKIE, market.id, {
      ...cookieOptions,
      maxAge: 30 * 86400000,
    });
    res.json({ marketId: market.id });
    return;
  }
  if (req.actor.activeMarketId !== market.id)
    await invalidateSellerEmployeeSessionsForActor(req.actor.id, "MARKET_CHANGE");
  const [user] = await db
    .update(users)
    .set({ activeMarketId: market.id, updatedAt: new Date() })
    .where(eq(users.id, req.actor!.id))
    .returning();
  res.json({ user: safeUser(user) });
});
router.patch("/account/profile", requireAuth, async (req, res) => {
  const { displayName, city, area } = req.body;
  if (
    typeof displayName !== "string" ||
    displayName.trim().length < 2 ||
    displayName.length > 80 ||
    typeof city !== "string" ||
    city.length > 100 ||
    typeof area !== "string" ||
    area.length > 100
  ) {
    res.status(400).json({ error: "راجع الاسم والمدينة والمنطقة" });
    return;
  }
  const [user] = await db
    .update(users)
    .set({
      displayName: displayName.trim(),
      city: city.trim(),
      area: area.trim(),
      updatedAt: new Date(),
    })
    .where(eq(users.id, req.actor!.id))
    .returning();
  res.json({ user: safeUser(user) });
});
router.post(
  "/account/password",
  requireAuth,
  passwordChangeLimit,
  async (req, res) => {
  const { currentPassword, password, confirmPassword } = req.body;
  if (
    typeof currentPassword !== "string" ||
    currentPassword.length > 128 ||
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 128 ||
    password !== confirmPassword
  ) {
    res
      .status(400)
      .json({
        error:
          "راجع كلمة المرور الحالية والجديدة وتأكيدها (12 حرفًا على الأقل)",
      });
    return;
  }
  if (!(await verifyPassword(currentPassword, req.actor!.passwordHash))) {
    res.status(400).json({ error: "كلمة المرور الحالية غير صحيحة" });
    return;
  }
  const passwordHash = await hashPassword(password);
  await db.transaction(async (tx) => {
    await invalidateSellerEmployeeSessionsForActorTx(tx, req.actor!.id, "LOGOUT");
    await tx
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, req.actor!.id));
    await tx.delete(sessions).where(eq(sessions.userId, req.actor!.id));
  });
  res.clearCookie("bdinar_session", cookieOptions);
  res.json({ ok: true });
  },
);
export default router;
