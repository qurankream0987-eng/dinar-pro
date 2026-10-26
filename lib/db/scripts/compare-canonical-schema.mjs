import pg from "pg";
import { verifiedDevelopmentCredentials } from "../src/development-tls.ts";
const referenceUrl = process.env.DINAR_SCHEMA_REFERENCE_URL;
if (!referenceUrl || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(referenceUrl).hostname)) {
  throw new Error("DINAR_SCHEMA_REFERENCE_URL must explicitly name a disposable loopback database.");
}
const local = new pg.Client({ connectionString: referenceUrl });
const remote = new pg.Client(verifiedDevelopmentCredentials(process.env.DINAR_DEV_DATABASE_URL));
const queries = {
  columns: `select table_schema,table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default,character_maximum_length,numeric_precision,numeric_scale,is_identity,is_generated from information_schema.columns where table_schema in ('public','drizzle') order by 1,2,4`,
  // PG18 adds NOT NULL entries to pg_constraint; PG16 represents them only
  // on columns. is_nullable above compares their semantics on both versions.
  constraints: `select n.nspname,c.relname,p.conname,pg_get_constraintdef(p.oid) as definition from pg_constraint p join pg_class c on c.oid=p.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','drizzle') and p.contype <> 'n' order by 1,2,3`,
  indexes: `select schemaname,tablename,indexname,indexdef from pg_indexes where schemaname in ('public','drizzle') order by 1,2,3`,
  enums: `select n.nspname,t.typname,e.enumlabel,e.enumsortorder from pg_enum e join pg_type t on t.oid=e.enumtypid join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' order by 1,2,4`,
  triggers: `select n.nspname,c.relname,t.tgname,pg_get_triggerdef(t.oid) as definition from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and n.nspname='public' order by 1,2,3`,
  functions: `select n.nspname,p.proname,pg_get_functiondef(p.oid) as definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' order by 1,2,3`,
  sequences: `select schemaname,sequencename,data_type,start_value,min_value,max_value,increment_by,cycle,cache_size from pg_sequences where schemaname in ('public','drizzle') order by 1,2`,
  views: `select schemaname,viewname,definition from pg_views where schemaname='public' order by 1,2`,
};
try {
  await Promise.all([local.connect(), remote.connect()]);
  await Promise.all([local.query("BEGIN READ ONLY"), remote.query("BEGIN READ ONLY")]);
  let drift = false;
  for (const [name, sql] of Object.entries(queries)) {
    const [a, b] = await Promise.all([local.query(sql), remote.query(sql)]);
    const matches = JSON.stringify(a.rows) === JSON.stringify(b.rows);
    console.log(JSON.stringify({ section: name, referenceCount: a.rowCount, canonicalCount: b.rowCount, matches }));
    drift ||= !matches;
  }
  console.log(JSON.stringify({ schemaDrift: drift ? "DETECTED" : "NONE" }));
  process.exitCode = drift ? 1 : 0;
} catch (e) {
  console.log(JSON.stringify({ failed: true, code: e.code || "AUDIT_FAILED" }));
  process.exitCode = 1;
} finally {
  await Promise.all([local.end().catch(() => {}), remote.end().catch(() => {})]);
}
