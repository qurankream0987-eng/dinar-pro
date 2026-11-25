import { randomUUID } from "node:crypto";
import { and, count, eq, gt, isNull, lte } from "drizzle-orm";
import { Router, type RequestHandler } from "express";
import {
  ConfirmAccountEmailVerificationBody,
  ConfirmAccountEmailVerificationResponse,
  GetAccountEmailResponse,
  RemoveAccountEmailResponse,
  RequestAccountEmailVerificationBody,
  RequestAccountEmailVerificationResponse,
} from "@workspace/api-zod";
import { db, emailVerificationChallenges, users } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { AUTH_RATE_LIMIT_SCOPE, consumeRateLimit } from "../lib/auth-rate-limiter";
import {
  emailVerificationDigest,
  isStagingEmailRecipientAllowed,
  newEmailVerificationCode,
  resendEmailConfiguration,
  ResendEmailError,
  secureDigestEqual,
  sendResendEmail,
  verifyEmailUnsubscribeToken,
} from "../lib/resend-email";
import { renderVerificationEmail } from "../lib/resend-notifications";
import { updatePrivacyPreferences } from "../lib/privacy-rights";
import { currentPolicy } from "../lib/policies";

const router = Router();
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;

const emailVerificationLimit = (max: number): RequestHandler => async (req, res, next) => {
  try {
    const limited = await consumeRateLimit(
      [{ scope: AUTH_RATE_LIMIT_SCOPE.privacyUser, value: `${req.actor!.id}:email-verification:${req.path}` }],
      3600,
      max,
    );
    if (limited) {
      res.setHeader("Retry-After", String(limited.retryAfterSeconds));
      res.status(429).json({ error: "طلبات كثيرة للتحقق من البريد. حاول لاحقًا." });
      return;
    }
  } catch {
    res.setHeader("Retry-After", "30");
    res.status(503).json({ error: "تعذر التحقق من المحاولات الآن. حاول لاحقًا." });
    return;
  }
  next();
};

function accountEmailView(email: string | null, verifiedAt: Date | null) {
  return GetAccountEmailResponse.parse({ email, verifiedAt });
}

router.get("/account/email", requireAuth, async (req, res): Promise<void> => {
  const [user] = await db
    .select({ email: users.email, verifiedAt: users.emailVerifiedAt })
    .from(users)
    .where(eq(users.id, req.actor!.id));
  if (!user) {
    res.status(404).json({ error: "الحساب غير موجود" });
    return;
  }
  res.json(accountEmailView(user.email, user.verifiedAt));
});

router.post(
  "/account/email/verification",
  requireAuth,
  emailVerificationLimit(5),
  async (req, res): Promise<void> => {
    const parsed = RequestAccountEmailVerificationBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "أدخل بريدًا إلكترونيًا صالحًا." });
      return;
    }
    if (!resendEmailConfiguration() || !process.env.SESSION_SECRET) {
      res.status(503).json({ error: "إرسال البريد غير مهيأ في هذه البيئة بعد." });
      return;
    }
    const email = parsed.data.email.trim().toLowerCase();
    if (!isStagingEmailRecipientAllowed(email)) {
      res.status(403).json({ error: "التحقق بالبريد متاح فقط لعناوين الاختبار المصرّح بها في بيئة القبول." });
      return;
    }
    const now = new Date();
    const challengeId = randomUUID();
    const code = newEmailVerificationCode();
    let challenge: { id: string; expiresAt: Date } | undefined;

    try {
      const outcome = await db.transaction(async (tx) => {
        const [currentUser] = await tx
          .select({ email: users.email, verifiedAt: users.emailVerifiedAt })
          .from(users)
          .where(eq(users.id, req.actor!.id))
          .for("update");
        if (!currentUser) return { kind: "missing" as const };
        if (currentUser.email === email && currentUser.verifiedAt)
          return { kind: "already-verified" as const };

        const [existing] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, email))
          .limit(1);
        if (existing && existing.id !== req.actor!.id) return { kind: "taken" as const };

        const [recent] = await tx
          .select({ total: count() })
          .from(emailVerificationChallenges)
          .where(and(
            eq(emailVerificationChallenges.email, email),
            gt(emailVerificationChallenges.createdAt, new Date(now.getTime() - 60 * 60 * 1000)),
          ));
        if (Number(recent?.total ?? 0) >= 5) return { kind: "email-limited" as const };

        await tx.update(emailVerificationChallenges)
          .set({ consumedAt: now })
          .where(and(
            eq(emailVerificationChallenges.email, email),
            isNull(emailVerificationChallenges.consumedAt),
            lte(emailVerificationChallenges.expiresAt, now),
          ));
        const [emailChallenge] = await tx
          .select({ userId: emailVerificationChallenges.userId })
          .from(emailVerificationChallenges)
          .where(and(
            eq(emailVerificationChallenges.email, email),
            isNull(emailVerificationChallenges.consumedAt),
          ))
          .limit(1);
        if (emailChallenge && emailChallenge.userId !== req.actor!.id)
          return { kind: "taken" as const };

        await tx
          .update(emailVerificationChallenges)
          .set({ consumedAt: now })
          .where(and(
            eq(emailVerificationChallenges.userId, req.actor!.id),
            isNull(emailVerificationChallenges.consumedAt),
          ));
        const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
        await tx.insert(emailVerificationChallenges).values({
          id: challengeId,
          userId: req.actor!.id,
          email,
          codeDigest: emailVerificationDigest(req.actor!.id, email, challengeId, code),
          failedAttempts: 0,
          expiresAt,
        });
        return { kind: "created" as const, challenge: { id: challengeId, expiresAt } };
      });

      if (outcome.kind === "already-verified") {
        res.status(409).json({ error: "هذا البريد موثّق بالفعل." });
        return;
      }
      if (outcome.kind === "taken") {
        res.status(409).json({ error: "تعذر استخدام هذا البريد لهذا الحساب." });
        return;
      }
      if (outcome.kind === "email-limited") {
        res.setHeader("Retry-After", "3600");
        res.status(429).json({ error: "وصل هذا البريد إلى حد طلبات التحقق. حاول بعد ساعة." });
        return;
      }
      if (outcome.kind === "missing") {
        res.status(404).json({ error: "الحساب غير موجود" });
        return;
      }
      challenge = outcome.challenge;
      const message = renderVerificationEmail(code);
      await sendResendEmail({
        to: email,
        ...message,
        idempotencyKey: `email-verification:${challenge.id}`,
      });
      res.status(202).json(
        RequestAccountEmailVerificationResponse.parse({
          challengeId: challenge.id,
          expiresAt: challenge.expiresAt,
        }),
      );
    } catch (error) {
      if (challenge) {
        await db
          .update(emailVerificationChallenges)
          .set({ consumedAt: new Date() })
          .where(and(eq(emailVerificationChallenges.id, challenge.id), isNull(emailVerificationChallenges.consumedAt)))
          .catch(() => undefined);
      }
      const codeName = error instanceof ResendEmailError ? error.code : "EMAIL_DELIVERY_ERROR";
      req.log.warn({ event: "email_verification_delivery_failed", code: codeName }, "Email verification delivery failed");
      res.status(503).json({ error: "تعذر إرسال رمز التحقق الآن. لم يُحفظ البريد في حسابك." });
    }
  },
);

router.post(
  "/account/email/verification/confirm",
  requireAuth,
  emailVerificationLimit(12),
  async (req, res): Promise<void> => {
    const parsed = ConfirmAccountEmailVerificationBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "أدخل رمز التحقق المكوّن من ستة أرقام." });
      return;
    }
    const { challengeId, code } = parsed.data;
    const now = new Date();
    const outcome = await db.transaction(async (tx) => {
      const [challenge] = await tx
        .select()
        .from(emailVerificationChallenges)
        .where(and(
          eq(emailVerificationChallenges.id, challengeId),
          eq(emailVerificationChallenges.userId, req.actor!.id),
          isNull(emailVerificationChallenges.consumedAt),
        ))
        .for("update");
      if (!challenge || challenge.expiresAt <= now || challenge.failedAttempts >= MAX_CODE_ATTEMPTS)
        return { kind: "invalid" as const };

      const expected = emailVerificationDigest(
        req.actor!.id,
        challenge.email,
        challenge.id,
        code,
      );
      if (!secureDigestEqual(challenge.codeDigest, expected)) {
        const attempts = challenge.failedAttempts + 1;
        await tx
          .update(emailVerificationChallenges)
          .set({ failedAttempts: attempts, ...(attempts >= MAX_CODE_ATTEMPTS ? { consumedAt: now } : {}) })
          .where(eq(emailVerificationChallenges.id, challenge.id));
        return { kind: attempts >= MAX_CODE_ATTEMPTS ? "locked" as const : "invalid" as const };
      }

      const [existing] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, challenge.email))
        .limit(1);
      if (existing && existing.id !== req.actor!.id) {
        await tx.update(emailVerificationChallenges).set({ consumedAt: now }).where(eq(emailVerificationChallenges.id, challenge.id));
        return { kind: "taken" as const };
      }

      await tx
        .update(users)
        .set({ email: challenge.email, emailVerifiedAt: now, updatedAt: now })
        .where(eq(users.id, req.actor!.id));
      await tx
        .update(emailVerificationChallenges)
        .set({ consumedAt: now })
        .where(eq(emailVerificationChallenges.id, challenge.id));
      return { kind: "verified" as const, email: challenge.email, verifiedAt: now };
    });

    if (outcome.kind === "taken") {
      res.status(409).json({ error: "تعذر استخدام هذا البريد لهذا الحساب." });
      return;
    }
    if (outcome.kind !== "verified") {
      res.status(400).json({
        error: outcome.kind === "locked"
          ? "انتهت صلاحية هذا الرمز بعد محاولات كثيرة. اطلب رمزًا جديدًا."
          : "رمز التحقق غير صحيح أو منتهي الصلاحية.",
      });
      return;
    }
    res.json(ConfirmAccountEmailVerificationResponse.parse({
      email: outcome.email,
      verifiedAt: outcome.verifiedAt,
    }));
  },
);

router.delete("/account/email", requireAuth, async (req, res): Promise<void> => {
  const now = new Date();
  const user = await db.transaction(async (tx) => {
    await updatePrivacyPreferences(
      req.actor!.id,
      { marketing: { email: false } },
      "API",
      currentPolicy("privacy")?.version,
      tx,
    );
    const [updated] = await tx
      .update(users)
      .set({ email: null, emailVerifiedAt: null, updatedAt: now })
      .where(eq(users.id, req.actor!.id))
      .returning({ email: users.email, verifiedAt: users.emailVerifiedAt });
    await tx
      .update(emailVerificationChallenges)
      .set({ consumedAt: now })
      .where(and(
        eq(emailVerificationChallenges.userId, req.actor!.id),
        isNull(emailVerificationChallenges.consumedAt),
      ));
    return updated;
  });
  res.json(RemoveAccountEmailResponse.parse(user ?? { email: null, verifiedAt: null }));
});

function unsubscribeHtml(token: string) {
  const escaped = token.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
  return `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>إلغاء رسائل العروض</title><body style="font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:1rem"><h1>إلغاء رسائل العروض</h1><p>اضغط الزر لإيقاف رسائل العروض التسويقية. ستبقى تنبيهات الطلبات الضرورية داخل جاسم.</p><form method="post" action="/api/email/unsubscribe?token=${encodeURIComponent(escaped)}"><button name="unsubscribe" value="1" type="submit">إيقاف رسائل العروض</button></form></body></html>`;
}

async function applyUnsubscribe(token: string | undefined) {
  if (!token || token.length > 256) return false;
  const [userId] = token.split(".");
  if (!userId || userId.length > 80) return false;
  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  if (!user?.email || !verifyEmailUnsubscribeToken(token, user.id, user.email)) return false;
  await updatePrivacyPreferences(user.id, { marketing: { email: false } }, "API");
  return true;
}

router.get("/email/unsubscribe", async (req, res): Promise<void> => {
  const token = typeof req.query.token === "string" ? req.query.token : undefined;
  if (!token) {
    res.status(400).type("text/plain").send("رابط إلغاء الاشتراك غير صالح.");
    return;
  }
  const [userId] = token.split(".");
  const [user] = userId
    ? await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, userId))
    : [];
  if (!user?.email || !verifyEmailUnsubscribeToken(token, user.id, user.email)) {
    res.status(400).type("text/plain").send("رابط إلغاء الاشتراك غير صالح أو منتهي.");
    return;
  }
  res.type("html").send(unsubscribeHtml(token));
});

router.post("/email/unsubscribe", async (req, res): Promise<void> => {
  const token = typeof req.query.token === "string" ? req.query.token : undefined;
  const oneClick = req.body?.["List-Unsubscribe"] === "One-Click";
  const formConfirm = req.body?.unsubscribe === "1";
  if ((!oneClick && !formConfirm) || !(await applyUnsubscribe(token))) {
    res.status(400).type("text/plain").send("تعذر إيقاف رسائل العروض بهذا الرابط.");
    return;
  }
  res.type("html").send("<!doctype html><html lang=\"ar\" dir=\"rtl\"><meta charset=\"utf-8\"><title>تم إيقاف الرسائل</title><body><p>تم إيقاف رسائل العروض التسويقية. ستبقى تنبيهات الطلبات الضرورية داخل جاسم.</p></body></html>");
});

export default router;
