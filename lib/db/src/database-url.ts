import { resolveDatabaseUrl as resolve } from "./database-url-resolver.mjs";

export function resolveDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolve(env);
}

export function resolveMigrationDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.NODE_ENV !== "development") {
    throw new Error(
      "Refusing to run development migrations unless NODE_ENV=development.",
    );
  }

  if (env.DINAR_MIGRATION_TARGET !== undefined) {
    throw new Error(
      "Explicit migration target modes must use their dedicated runner; refusing canonical fallback.",
    );
  }

  if (!env.DINAR_DEV_DATABASE_URL) {
    throw new Error(
      "Refusing to run migrations without DINAR_DEV_DATABASE_URL; the managed legacy DATABASE_URL is not a migration target.",
    );
  }

  return env.DINAR_DEV_DATABASE_URL;
}
