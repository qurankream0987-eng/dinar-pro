console.error(
  "Drizzle schema push is disabled because it can remove SQL-owned constraints and triggers. Use checked-in migrations with `pnpm --filter @workspace/db run migrate`.",
);
process.exitCode = 1;