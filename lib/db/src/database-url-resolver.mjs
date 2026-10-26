export function resolveDatabaseUrl(env = process.env) {
  if (env.NODE_ENV === "development") {
    if (!env.DINAR_DEV_DATABASE_URL) {
      throw new Error(
        "Refusing development runtime database fallback: DINAR_DEV_DATABASE_URL must explicitly select the canonical development database.",
      );
    }
    return env.DINAR_DEV_DATABASE_URL;
  }

  if (env.DATABASE_URL) return env.DATABASE_URL;

  throw new Error("DATABASE_URL must be set.");
}
