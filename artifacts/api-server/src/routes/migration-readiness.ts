import { readFile } from "node:fs/promises";
import path from "node:path";

type JournalEntry = { when: number; tag: string };
type AppliedMigration = { created_at: string; hash: string };

export type MigrationLedgerState = "current" | "pending" | "inconsistent";

export async function readExpectedMigrationJournal(): Promise<JournalEntry[]> {
  const journalPath = path.resolve(
    process.cwd(),
    "../../lib/db/drizzle/meta/_journal.json",
  );
  return parseExpectedMigrationJournal(
    JSON.parse(await readFile(journalPath, "utf8")),
  );
}

export function parseExpectedMigrationJournal(parsed: unknown): JournalEntry[] {
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("entries" in parsed) ||
    !Array.isArray(parsed.entries)
  ) {
    throw new Error("migration journal is unavailable");
  }
  const entries = parsed.entries as JournalEntry[];
  let previous = 0;
  for (const entry of entries) {
    if (
      !entry ||
      !Number.isSafeInteger(entry.when) ||
      entry.when <= previous ||
      typeof entry.tag !== "string" ||
      !entry.tag
    ) {
      throw new Error("migration journal is inconsistent");
    }
    previous = entry.when;
  }
  if (entries.length === 0) throw new Error("migration journal is empty");
  return entries;
}

export function assessMigrationLedger(
  journal: JournalEntry[],
  applied: AppliedMigration[],
): MigrationLedgerState {
  const expected = journal.map((entry) => String(entry.when));
  const actual = applied.map((entry) => entry.created_at);

  if (applied.some((entry) => !entry.hash)) return "inconsistent";
  if (actual.length > expected.length) return "inconsistent";
  if (actual.some((timestamp, index) => timestamp !== expected[index])) {
    return "inconsistent";
  }
  return actual.length === expected.length ? "current" : "pending";
}
