import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { startDinarBrowserTestWeb } from "./browser-test-web-server";
import { pool } from "@workspace/db";
import app from "../src/app";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_TEST_DATABASE");
let release!: () => void;
const gate = new Promise<void>((resolve) => { release = resolve; });
let modelCalls = 0;
app.locals.conversationModelGateway = {
  async proposeToolCall() {
    modelCalls++;
    await gate;
    return { id: "offline-answer", name: "dinarConversationTurn", arguments: JSON.stringify({
      responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.9,
      conversationalReply: "هذه إجابة عامة محفوظة بعد توقف استقبال الرد.",
    }) };
  },
};
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
async function call(path: string, cookie = "", body?: unknown) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  return { response, data };
}
async function register() {
  const result = await call("/auth/register", "", {
    displayName: "اختبار استعادة الرد", phoneCountryCode: "+962",
    phoneNumber: `79${Math.floor(Math.random() * 10_000_000).toString().padStart(7, "0")}`,
    accountCountry: "JO", password: "offline-recovery-password-1", confirmPassword: "offline-recovery-password-1", acceptTerms: true,
  });
  assert.equal(result.response.status, 201);
  return result.response.headers.getSetCookie().find((value) => value.startsWith("bdinar_session="))!.split(";")[0]!;
}
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("The stopped turn did not reach its expected server state");
}

await test("a stopped connection preserves one owned server turn and exposes its correlated durable outcome", async () => {
  const cookie = await register();
  const stranger = await register();
  const created = await call("/ai/conversations", cookie, {});
  assert.equal(created.response.status, 201);
  const id = created.data.id ?? created.data.conversation?.id;
  assert.equal(typeof id, "string");
  const messageId = randomUUID();
  const controller = new AbortController();
  const response = await fetch(`${base}/ai/conversations/${id}/turns`, {
    method: "POST", headers: { cookie, "content-type": "application/json" }, signal: controller.signal,
    body: JSON.stringify({ message: "اشرح لي مفهوم الاستدامة بشكل عام", clientMessageId: messageId }),
  });
  assert.equal(response.status, 200);
  controller.abort();
  try {
    const pending = await call(`/ai/conversations/${id}`, cookie);
    const user = pending.data.messages.find((item: any) => item.id === messageId);
    assert.equal(user.turnStatus, "pending", "reload must distinguish an unfinished server turn from an unsent message");
    assert.equal(pending.data.messages.some((item: any) => item.replyToMessageId === messageId), false);
    assert.equal((await call(`/ai/conversations/${id}`, stranger)).response.status, 404);
    const duplicate = await call(`/ai/conversations/${id}/turns`, cookie, { message: user.body, clientMessageId: messageId });
    assert.equal(duplicate.response.status, 409, "a pending turn is not dispatched twice");
    release();
    const finished = await until(() => call(`/ai/conversations/${id}`, cookie), (value) =>
      value.data.messages.some((item: any) => item.replyToMessageId === messageId));
    assert.equal(finished.data.messages.find((item: any) => item.id === messageId).turnStatus, "completed");
    const replies = finished.data.messages.filter((item: any) => item.replyToMessageId === messageId);
    assert.equal(replies.length, 1);
    assert.match(replies[0].body, /إجابة عامة محفوظة/u);
    assert.equal(replies[0].metadata, undefined, "transport recovery exposes no private raw metadata");
    assert.equal(modelCalls, 1);
    const duplicateAfter = await call(`/ai/conversations/${id}/turns`, cookie, { message: user.body, clientMessageId: messageId });
    assert.equal(duplicateAfter.response.status, 409);
    assert.equal(modelCalls, 1);
  } finally {
    release();
    await until(() => pool.query("select metadata->>'turnStatus' as status from messages where id=$1", [messageId]),
      (result) => result.rows[0]?.status === "completed");
  }
});
for (const outcome of ["completed", "failed"] as const) await test(`the real browser stops reception and recovers the authoritative ${outcome} outcome`, async () => {
  let releaseBrowser!: () => void;
  const pending = new Promise<void>(resolve => { releaseBrowser = resolve; });
  let calls = 0;
  app.locals.conversationModelGateway = { async proposeToolCall() {
    calls++;
    await pending;
    return { id: "browser-offline-answer", name: "dinarConversationTurn", arguments: JSON.stringify({
      responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.9,
      conversationalReply: "هذه إجابة عامة محفوظة بعد توقف استقبال الرد.",
    }) };
  } };
  const cookie = await register();
  if (outcome === "failed") await pool.query(`
    CREATE FUNCTION stop_recovery_reply_fault() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.actor = 'ASSISTANT' THEN RAISE EXCEPTION 'controlled assistant persistence interruption'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER stop_recovery_reply_fault BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION stop_recovery_reply_fault();
  `);
  const web = await startDinarBrowserTestWeb(base.replace(/\/api$/, ""));
  const resultPath = `/tmp/dinar-stop-${randomUUID()}.json`;
  const child = fork(`${process.cwd()}/../dinar/test/conversation-stop-recovery-ui.mjs`, [], {
    cwd: `${process.cwd()}/../dinar`,
    env: { ...process.env, STOP_WEB_BASE: web.baseUrl, STOP_COOKIE: cookie, STOP_RESULT_PATH: resultPath, STOP_OUTCOME: outcome },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.on("data", chunk => { stderr += chunk; });
  child.on("message", (message: any) => { if (message?.type === "release-turn") releaseBrowser(); });
  const deadline = setTimeout(() => child.kill("SIGTERM"), 180_000);
  try {
    const code = await new Promise<number | null>(resolve => child.once("close", resolve));
    const report = JSON.parse(await readFile(resultPath, "utf8"));
    console.log("STOP_BROWSER", JSON.stringify(report));
    assert.equal(code, 0, stderr.slice(0, 500));
    assert.equal(report.failure, undefined, report.failure);
    assert.equal(report.checks.length, 3);
    assert.equal(report.turns.length, 1);
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.consoleErrors, []);
    assert.deepEqual(report.externalRequests, []);
    assert.equal(calls, 1);
    const stored = await pool.query("select metadata->>'turnStatus' as status from messages where id=$1", [report.turns[0]]);
    assert.equal(stored.rows[0]?.status, outcome);
  } finally {
    clearTimeout(deadline);
    releaseBrowser();
    child.kill("SIGTERM");
    await web.stop();
    if (outcome === "failed") await pool.query("DROP TRIGGER IF EXISTS stop_recovery_reply_fault ON messages; DROP FUNCTION IF EXISTS stop_recovery_reply_fault()");
    await unlink(resultPath).catch(() => undefined);
  }
});
after(async () => {
  release();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});
