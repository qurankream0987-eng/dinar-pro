import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as coreSchema from "./schema";
import * as courierDeliverySchema from "./schema/r5-delivery";
import { resolveDatabaseUrl } from "./database-url";
import { verifiedDevelopmentCredentials } from "./development-tls";

const { Pool } = pg;
const schema = { ...coreSchema, ...courierDeliverySchema };
const databaseUrl = resolveDatabaseUrl();
const isRailwayDevelopment = process.env.NODE_ENV === "development" &&
  databaseUrl === process.env.DINAR_DEV_DATABASE_URL &&
  new URL(databaseUrl).hostname.endsWith(".proxy.rlwy.net");

export const pool = new Pool({
  ...(isRailwayDevelopment
    ? verifiedDevelopmentCredentials(databaseUrl)
    : { connectionString: databaseUrl }),
  // Verified remote TLS needs more time than a loopback acquisition.
  connectionTimeoutMillis: isRailwayDevelopment ? 15_000 : 2_000,
});
// pg.Pool emits errors for idle clients; an unhandled error event would terminate the process.
// Log only the driver code so connection details cannot leak into platform logs.
pool.on("error", (error) => {
  const code = "code" in error && typeof error.code === "string" ? error.code : "UNKNOWN";
  console.error(JSON.stringify({ event: "postgres_idle_connection_error", code }));
});

export const db = drizzle(pool, { schema });

export * from "./schema";
export * from "./schema/r5-delivery";
