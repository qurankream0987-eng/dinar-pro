import { Router, type IRouter } from "express";
import {
  HealthCheckResponse,
  ReadinessCheckResponse,
} from "@workspace/api-zod";
import { pool } from "@workspace/db";
import { deploymentConfigurationProblems } from "../lib/deployment-configuration";
import { phoneVerificationStatus } from "../lib/phone-verification";
import {
  assessMigrationLedger,
  readExpectedMigrationJournal,
} from "./migration-readiness";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.setHeader("Cache-Control", "no-store");
  res.json(data);
});

router.get("/readyz", async (_req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  // Configuration and phone verification are checked even when the database is down, so one
  // probe names every area that blocks traffic.
  const configuration = deploymentConfigurationProblems().length ? "invalid" : "ready";
  const phoneVerification = phoneVerificationStatus();
  const respond = (checks: { database: "ready" | "unavailable"; migrations: "current" | "pending" | "unavailable" | "unchecked" }) => {
    const ready =
      checks.database === "ready" &&
      checks.migrations === "current" &&
      configuration === "ready" &&
      phoneVerification === "ready";
    res.status(ready ? 200 : 503).json(
      ReadinessCheckResponse.parse({
        status: ready ? "ready" : "not_ready",
        checks: { ...checks, configuration, phoneVerification },
      }),
    );
  };

  try {
    await pool.query("SELECT 1");
  } catch {
    respond({ database: "unavailable", migrations: "unchecked" });
    return;
  }

  try {
    const journal = await readExpectedMigrationJournal();
    const result = await pool.query<{ created_at: string; hash: string }>(
      "SELECT created_at::text, hash FROM drizzle.__drizzle_migrations ORDER BY created_at, id",
    );
    const state = assessMigrationLedger(journal, result.rows);
    respond({ database: "ready", migrations: state === "inconsistent" ? "unavailable" : state });
  } catch {
    respond({ database: "ready", migrations: "unavailable" });
  }
});

export default router;
