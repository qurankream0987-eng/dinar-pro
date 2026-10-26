/**
 * Operator command: create or promote the first administrator of a freshly migrated environment.
 *
 *   DINAR_BOOTSTRAP_TARGET=staging DINAR_BOOTSTRAP_ACK=BOOTSTRAP_STAGING_ADMIN \
 *   DINAR_BOOTSTRAP_EXPECTED_DATABASE=<name> NODE_ENV=production DINAR_DEPLOYMENT_ENV=staging \
 *   pnpm --filter @workspace/api-server run admin:bootstrap -- \
 *     --phone-country-code +962 --phone-number 7XXXXXXXX \
 *     [--display-name "…" --account-country JO --password-stdin]
 *
 * The password (only for a new account) is read from standard input, never from arguments or
 * the environment, and is never printed. Output is one JSON line without credentials.
 */
import { parseArgs } from "node:util";
import { resolveDeployedTarget, TargetRefusedError } from "@workspace/db/deployed-target";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw Object.assign(new Error("Pipe the password on standard input."), { code: "PASSWORD_STDIN" });
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text.replace(/\r?\n$/, "");
}

let phase = "configuration";
try {
  // The target is verified before @workspace/db is loaded: its pool reads DATABASE_URL at import.
  const target = resolveDeployedTarget(process.env, {
    prefix: "DINAR_BOOTSTRAP",
    acknowledgements: { staging: "BOOTSTRAP_STAGING_ADMIN", production: "BOOTSTRAP_PRODUCTION_ADMIN" },
  });
  if (process.env.NODE_ENV === "development")
    throw Object.assign(new Error("NODE_ENV=development resolves the development database."), { code: "NODE_ENV" });
  const { values } = parseArgs({
    options: {
      "phone-country-code": { type: "string" },
      "phone-number": { type: "string" },
      "display-name": { type: "string" },
      "account-country": { type: "string" },
      "password-stdin": { type: "boolean", default: false },
    },
    strict: true,
  });
  const password = values["password-stdin"] ? await readStdin() : undefined;

  phase = "identity";
  const { pool } = await import("@workspace/db");
  const identity = await pool.query<{ database: string }>("SELECT current_database() AS database");
  if (identity.rows[0]?.database !== target.expectedDatabase)
    throw Object.assign(new Error("The connected database is not the expected database."), { code: "IDENTITY" });

  phase = "bootstrap";
  const { bootstrapFirstAdmin } = await import("../lib/admin-bootstrap");
  const result = await bootstrapFirstAdmin({
    phoneCountryCode: values["phone-country-code"] ?? "",
    phoneNumber: values["phone-number"] ?? "",
    displayName: values["display-name"],
    accountCountry: values["account-country"],
    password,
  });
  console.log(JSON.stringify({ adminBootstrap: { target: target.target, ...result } }));
  await pool.end();
} catch (error: any) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "FAILED";
  const known = error instanceof TargetRefusedError || error?.name === "AdminBootstrapError" || code !== "FAILED";
  console.error(JSON.stringify({ adminBootstrap: { status: "REFUSED_OR_FAILED", phase, code, message: known ? String(error.message).slice(0, 200) : "see server logs" } }));
  process.exitCode = 1;
  // An open pool would keep the process alive after a refusal.
  await import("@workspace/db").then(({ pool }) => pool.end()).catch(() => {});
}
