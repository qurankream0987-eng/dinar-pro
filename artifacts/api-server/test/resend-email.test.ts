import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isStagingEmailRecipientAllowed,
  resendEmailConfiguration,
  sendResendEmail,
  stagingEmailAllowlist,
  ResendEmailError,
} from "../src/lib/resend-email";

const stagingEnv = {
  DINAR_DEPLOYMENT_ENV: "staging",
  DINAR_EMAIL_STAGING_ALLOWLIST: " qa@example.test,QA2@example.test ",
  RESEND_API_KEY: "re_test_only",
  RESEND_FROM_EMAIL: "jassim@example.test",
} as NodeJS.ProcessEnv;

test("Resend acceptance delivery requires staging and an explicit recipient allowlist", async () => {
  assert.deepEqual(stagingEmailAllowlist(stagingEnv), ["qa@example.test", "qa2@example.test"]);
  assert.equal(isStagingEmailRecipientAllowed("QA@example.test", stagingEnv), true);
  assert.equal(isStagingEmailRecipientAllowed("customer@example.test", stagingEnv), false);
  assert.deepEqual(
    stagingEmailAllowlist({ ...stagingEnv, DINAR_DEPLOYMENT_ENV: "production" }),
    [],
  );

  let networkCalls = 0;
  await assert.rejects(
    sendResendEmail({
      to: "qa@example.test",
      subject: "test",
      text: "test",
      html: "<p>test</p>",
      idempotencyKey: "email-test-prod",
    }, { ...stagingEnv, DINAR_DEPLOYMENT_ENV: "production" }, async () => {
      networkCalls += 1;
      return new Response(JSON.stringify({ id: "re_unexpected" }), { status: 200 });
    }),
    (error: unknown) => error instanceof ResendEmailError && error.code === "RESEND_STAGING_ONLY",
  );
  await assert.rejects(
    sendResendEmail({
      to: "customer@example.test",
      subject: "test",
      text: "test",
      html: "<p>test</p>",
      idempotencyKey: "email-test-not-allowed",
    }, stagingEnv, async () => {
      networkCalls += 1;
      return new Response(JSON.stringify({ id: "re_unexpected" }), { status: 200 });
    }),
    (error: unknown) =>
      error instanceof ResendEmailError &&
      error.code === "RESEND_STAGING_RECIPIENT_NOT_ALLOWED",
  );
  assert.equal(networkCalls, 0, "the guard must run before any network request");
});

test("Resend sends only to allowlisted staging addresses using the configured sender", async () => {
  assert.ok(resendEmailConfiguration(stagingEnv));
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const result = await sendResendEmail({
    to: "qa@example.test",
    subject: "مراجعة",
    text: "رسالة اختبار",
    html: "<p>رسالة اختبار</p>",
    idempotencyKey: "email-test-staging",
  }, stagingEnv, async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(JSON.stringify({ id: "re_test_message" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  assert.equal(capturedUrl, "https://api.resend.com/emails");
  assert.equal(result.providerMessageId, "re_test_message");
  assert.equal((capturedInit?.headers as Record<string, string>).Authorization, "Bearer re_test_only");
  assert.equal((capturedInit?.headers as Record<string, string>)["Idempotency-Key"], "email-test-staging");
  const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
  assert.equal(body.to, "qa@example.test");
  assert.equal(body.from, "jassim@example.test");
});
