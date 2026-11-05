#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseCreateTables, toBigQueryDDL, toJSONSchema, type BQTable } from "./index.js";

const HELP = `mysql2bq: convert MySQL CREATE TABLE statements to BigQuery schemas

Usage:
  mysql2bq [options] [file.sql ...]        read files (or stdin when none are given)
  mysqldump --no-data mydb | mysql2bq --dataset analytics

Options:
  -f, --format ddl|json|table   output: BigQuery DDL (default), JSON schema for "bq mk", or a mapping table
  -d, --dataset NAME            dataset used in the DDL (default: analytics)
  -h, --help                    show this help

Web version: https://quayen.com/tools/mysql-to-bigquery-schema-converter`;

const args = process.argv.slice(2);
let format = "ddl";
let dataset = "analytics";
const files: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-h" || a === "--help") {
    console.log(HELP);
    process.exit(0);
  } else if (a === "-f" || a === "--format") format = args[++i] ?? "";
  else if (a.startsWith("--format=")) format = a.slice(9);
  else if (a === "-d" || a === "--dataset") dataset = args[++i] ?? "";
  else if (a.startsWith("--dataset=")) dataset = a.slice(10);
  else files.push(a);
}
if (!["ddl", "json", "table"].includes(format)) {
  console.error(`Unknown format "${format}". Use ddl, json or table.`);
  process.exit(2);
}

const input = files.length ? files.map((f) => readFileSync(f, "utf8")).join("\n") : readFileSync(0, "utf8");
const { tables, errors } = parseCreateTables(input);
for (const e of errors) console.error(`warning: ${e}`);
for (const t of tables) if (!t.primaryKey.length) console.error(`warning: ${t.name} has no primary key; CDC tools need one to apply updates and deletes.`);
if (!tables.length) process.exit(1);

const table = (t: BQTable) =>
  [`${t.name}`, ...t.columns.map((c) => `  ${c.name.padEnd(24)} ${c.mysqlType.padEnd(28)} ${c.bqType.padEnd(10)}${c.note ? ` ${c.note}` : ""}`)].join("\n");

if (format === "json") {
  const out = tables.length === 1 ? JSON.parse(toJSONSchema(tables[0])) : Object.fromEntries(tables.map((t) => [t.bqName, JSON.parse(toJSONSchema(t))]));
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(tables.map((t) => (format === "ddl" ? toBigQueryDDL(t, dataset) : table(t))).join("\n\n"));
}
