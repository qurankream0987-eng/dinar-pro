/**
 * Operator command: append a commercial policy version (e.g. the AI spend policy) without an admin
 * session, with the same validation as POST /admin/commercial-policies.
 *
 *   DINAR_POLICY_TARGET=staging DINAR_POLICY_ACK=APPLY_STAGING_POLICY \
 *   DINAR_POLICY_EXPECTED_DATABASE=<name> NODE_ENV=production DINAR_DEPLOYMENT_ENV=staging \
 *   DINAR_POLICY_JSON='{"aiUsage":{...}}' [DINAR_POLICY_MARKET=JO] node dist/apply-commercial-policy.mjs
 *
 * Output is one JSON line.
 */
import { resolveDeployedTarget, TargetRefusedError } from "@workspace/db/deployed-target";

let phase = "configuration";
try {
  const target = resolveDeployedTarget(process.env, {
    prefix: "DINAR_POLICY",
    acknowledgements: { staging: "APPLY_STAGING_POLICY", production: "APPLY_PRODUCTION_POLICY" },
  });
  if (process.env.NODE_ENV === "development")
    throw Object.assign(new Error("NODE_ENV=development resolves the development database."), { code: "NODE_ENV" });
  const raw = process.env.DINAR_POLICY_JSON;
  if (!raw) throw Object.assign(new Error("DINAR_POLICY_JSON is required."), { code: "POLICY_JSON" });
  let policy: unknown;
  try { policy = JSON.parse(raw); } catch { throw Object.assign(new Error("DINAR_POLICY_JSON is not JSON."), { code: "POLICY_JSON" }); }
  const marketId = process.env.DINAR_POLICY_MARKET || undefined;

  phase = "identity";
  const { pool } = await import("@workspace/db");
  const identity = await pool.query<{ database: string }>("SELECT current_database() AS database");
  if (identity.rows[0]?.database !== target.expectedDatabase)
    throw Object.assign(new Error("The connected database is not the expected database."), { code: "IDENTITY" });

  phase = "apply";
  const { appendCommercialPolicy } = await import("../lib/commercial-policy-append");
  const row = await appendCommercialPolicy({ marketId, policy, actorId: null });
  console.log(JSON.stringify({ commercialPolicy: { target: target.target, id: row.id, marketId: row.marketId, version: row.version } }));
  await pool.end();
} catch (error: any) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : error?.name === "ZodError" ? "POLICY_INVALID" : "FAILED";
  const known = error instanceof TargetRefusedError || code !== "FAILED";
  console.error(JSON.stringify({ commercialPolicy: { status: "REFUSED_OR_FAILED", phase, code, message: known ? String(error.message).slice(0, 300) : "see server logs" } }));
  process.exitCode = 1;
  await import("@workspace/db").then(({ pool }) => pool.end()).catch(() => {});
}
