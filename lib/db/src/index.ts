import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as coreSchema from "./schema";
import * as courierDeliverySchema from "./schema/r5-delivery";
import { resolveDatabaseUrl } from "./database-url";
import { verifiedDevelopmentCredentials } from "./development-tls";

const { Pool } = pg;
const readPositiveInt = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
};
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
  connectionTimeoutMillis: readPositiveInt(process.env.DINAR_DB_CONNECTION_TIMEOUT_MS) ?? (isRailwayDevelopment ? 15_000 : 2_000),
  // A replica's ceiling on concurrent PostgreSQL backends is a deployment fact, not a guess; the
  // D13 load harness measures what the library default costs under concurrency before it is raised.
  max: readPositiveInt(process.env.DINAR_DB_POOL_MAX) ?? 10,
});
export const db = drizzle(pool, { schema });

export * from "./schema";
export * from "./schema/r5-delivery";
