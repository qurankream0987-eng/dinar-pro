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
import { signupConsentRows } from "./policy-lifecycle";
import { and, eq, gt, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import { countries, countryByCode } from "@workspace/global";
import {
  allMarkets,
  GUEST_MARKET_COOKIE,
  isMarketAvailable,
  marketFor,
  resolveMarket,
} from "./markets";
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
  const { passwordHash, ...safe } = u;
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
          phoneVerificationRequired()
            ? eq(users.phoneVerified, true)
            : undefined,
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
  if (phoneVerificationRequired() && !user.phoneVerified)
    throw new Error("Cannot issue a session before phone ownership is verified");
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
        ...(process.env.NODE_ENV === "development" ||
        process.env.NODE_ENV === "test"
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
  const country = countryByCode.get(b.accountCountry);
  if (!country?.isSelectable) { res.status(400).json({ error: "الدولة غير متاحة للتسجيل" }); return; }
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
  if (!activeMarketId) {
    res.status(503).json({ error: "لا يوجد سوق افتراضي متاح حاليًا للتسجيل" });
    return;
  }
  const passwordHash = await hashPassword(b.password);
  const user = await db.transaction(async (tx) => {
    const now = new Date();
    let phoneVerified = false;
    if (b.verificationToken) {
      const tokenHash = phoneVerificationDigest(
        "registration-token",
        b.verificationToken,
      );
      const phoneHash = phoneVerificationDigest("phone", phone.normalizedPhone);
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
      if (!challenge) return { kind: "unverified" as const };

      await tx
        .update(phoneVerificationChallenges)
        .set({ consumedAt: now, updatedAt: now })
        .where(eq(phoneVerificationChallenges.id, challenge.id));
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
    // acceptTerms covers every policy version that requires acceptance; the append-only
    // consent ledger records the same explicit signup decision with its content hash.
    const consentRows = await signupConsentRows(created.id, tx);
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
  res.status(201).json({
    user: await startSession(
      res,
      user.user,
      req.cookies?.[GUEST_MARKET_COOKIE],
    ),
  });
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
  if (!user.phoneVerified && phoneVerificationRequired()) {
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
