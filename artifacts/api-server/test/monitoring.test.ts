/**
 * External error reporting from the API error boundary. The monitoring provider here is a
 * MOCKED in-process adapter: it proves the contract and its privacy limits, not a live vendor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { apiErrorHandler } from "../src/app";
import { logger } from "../src/lib/logger";
import { monitoringStatus, registerMonitoringProvider, reportServerError, unregisterMonitoringProvider } from "../src/lib/monitoring";
import type { MonitoringProvider } from "../src/lib/provider-boundaries";

type Report = Parameters<MonitoringProvider["captureError"]>[0];
const reports: Report[] = [];
let failNext = false;
const provider: MonitoringProvider = {
  async captureError(input) {
    if (failNext) {
      failNext = false;
      throw new Error("monitor down: token sk-live-SECRET");
    }
    reports.push(input);
  },
};
const registration = { family: "MONITORING" as const, providerKey: "mock-monitor", mode: "DEVELOPMENT" as const, environments: ["development" as const], marketIds: ["*"], create: () => provider };

// A minimal app around the real error boundary: one route fails like an unexpected DB error.
const app = express();
app.use((req: any, _res, next) => {
  req.id = "req-0b5e2c1a";
  req.log = logger;
  next();
});
app.get("/boom", () => {
  throw Object.assign(new Error('insert into users values ($1) -- +962790000000 at 31.95,35.93'), { code: "23505", query: "insert into users", params: ["+962790000000"] });
});
app.get("/refused", () => {
  throw Object.assign(new Error("الخدمة غير موصولة"), { status: 503, expose: true, code: "PROVIDER_NOT_CONNECTED" });
});
app.get("/bad-input", () => {
  throw Object.assign(new Error("bad"), { status: 400 });
});
app.use(apiErrorHandler);
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

await test("M-01 with no vendor registered and selected, nothing is reported and the response is unchanged", async () => {
  delete process.env.DINAR_MONITORING_PROVIDER;
  const response = await fetch(`${base}/boom`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "تعذر إتمام العملية. حاول لاحقًا." });
  assert.equal(await reportServerError(new Error("x")), "NOT_CONNECTED");
  registerMonitoringProvider(registration);
  assert.equal(monitoringStatus().connected, false, "registered but not selected");
  process.env.DINAR_MONITORING_PROVIDER = "another-vendor";
  assert.equal(monitoringStatus().connected, false, "selection must name the registered adapter");
  await fetch(`${base}/boom`);
  await settle();
  assert.equal(reports.length, 0);
});

await test("M-02 an unexpected 5xx sends event, code, request id and release only", async () => {
  process.env.DINAR_MONITORING_PROVIDER = "mock-monitor";
  process.env.DINAR_RELEASE = "2026.10.22-rc1";
  assert.equal(monitoringStatus().connected, true);
  const response = await fetch(`${base}/boom`);
  assert.equal(response.status, 500);
  await settle();
  assert.deepEqual(reports, [{ event: "api_request_failed", code: "23505", requestId: "req-0b5e2c1a", release: "2026.10.22-rc1" }]);
  assert.ok(!/962790000000|31\.95|insert into|SECRET/.test(JSON.stringify(reports)));
});

await test("M-03 deliberate refusals and client errors are not incidents", async () => {
  reports.length = 0;
  assert.equal((await fetch(`${base}/refused`)).status, 503);
  assert.equal((await fetch(`${base}/bad-input`)).status, 400);
  await settle();
  assert.equal(reports.length, 0);
});

await test("M-04 a failing monitor never fails the request or reports itself; malformed fields are dropped", async () => {
  failNext = true;
  assert.equal((await fetch(`${base}/boom`)).status, 500);
  await settle();
  assert.equal(reports.length, 0);
  assert.equal(await reportServerError(Object.assign(new Error("x"), { code: "has spaces and +962" }), "id with spaces"), "SENT");
  assert.deepEqual(reports.at(-1), { event: "api_request_failed", code: "Error", release: "2026.10.22-rc1" });
  process.env.DINAR_RELEASE = "release with spaces";
  await reportServerError(new Error("x"), "req-1");
  assert.equal("release" in reports.at(-1)!, false);
});

await test("M-05 a live monitor additionally needs production to be labelled and live providers enabled", async () => {
  unregisterMonitoringProvider("mock-monitor");
  registerMonitoringProvider({ ...registration, mode: "LIVE", environments: ["production"] });
  const previous = process.env.DINAR_DEPLOYMENT_ENV;
  process.env.DINAR_DEPLOYMENT_ENV = "production";
  delete process.env.DINAR_LIVE_PROVIDERS_ENABLED;
  assert.equal(monitoringStatus().connected, false);
  process.env.DINAR_LIVE_PROVIDERS_ENABLED = "true";
  assert.equal(monitoringStatus().connected, true);
  delete process.env.DINAR_LIVE_PROVIDERS_ENABLED;
  if (previous === undefined) delete process.env.DINAR_DEPLOYMENT_ENV;
  else process.env.DINAR_DEPLOYMENT_ENV = previous;
  unregisterMonitoringProvider("mock-monitor");
  delete process.env.DINAR_MONITORING_PROVIDER;
});

server.close();
