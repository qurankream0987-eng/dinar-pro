import { defineConfig } from "drizzle-kit";
import path from "path";
import { verifiedDevelopmentCredentials } from "./src/development-tls";
import {
  resolveDatabaseUrl,
  resolveMigrationDatabaseUrl,
} from "./src/database-url";

if (process.argv.some((argument) => argument === "push")) {
  throw new Error(
    "Drizzle schema push is disabled. Apply checked-in SQL migrations with `pnpm --filter @workspace/db run migrate`.",
  );
}

const isMigrationCommand = process.argv.some(
  (argument) => argument === "migrate",
);
const databaseUrl = isMigrationCommand
  ? resolveMigrationDatabaseUrl()
  : resolveDatabaseUrl();

export default defineConfig({
  schema: [
    path.join(__dirname, "./src/schema/index.ts"),
    path.join(__dirname, "./src/schema/r5-delivery.ts"),
  ],
  dialect: "postgresql",
  dbCredentials: {
    ...(process.env.NODE_ENV === "development" &&
      databaseUrl === process.env.DINAR_DEV_DATABASE_URL &&
      databaseUrl.includes(".proxy.rlwy.net")
      ? verifiedDevelopmentCredentials(databaseUrl)
      : { url: databaseUrl }),
  },
});
