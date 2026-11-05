import assert from "node:assert/strict";
import { test } from "node:test";
import { mapType, parseCreateTables, sanitizeIdent, toBigQueryDDL, toJSONSchema } from "../src/index.ts";

test("maps MySQL types", () => {
  assert.equal(mapType("int(11)").bqType, "INT64");
  assert.equal(mapType("bigint unsigned").bqType, "NUMERIC");
  assert.equal(mapType("bigint").bqType, "INT64");
  assert.equal(mapType("decimal(12,2)").bqType, "NUMERIC");
  assert.equal(mapType("decimal(40, 2)").bqType, "BIGNUMERIC");
  assert.equal(mapType("decimal(20,10)").bqType, "BIGNUMERIC");
  assert.equal(mapType("datetime(6)").bqType, "DATETIME");
  assert.equal(mapType("timestamp").bqType, "TIMESTAMP");
  assert.equal(mapType("json").bqType, "JSON");
  assert.equal(mapType("enum('a','b')").bqType, "STRING");
  assert.equal(mapType("time").bqType, "STRING");
  assert.equal(mapType("point").bqType, "BYTES");
  assert.equal(mapType("longblob").bqType, "BYTES");
  assert.equal(mapType("tinyint(1)").bqType, "INT64");
  assert.equal(mapType("double").bqType, "FLOAT64");
});

test("sanitizes identifiers", () => {
  assert.equal(sanitizeIdent("order items"), "order_items");
  assert.equal(sanitizeIdent("2nd"), "_2nd");
});

const SQL = `-- dump
/*!40101 SET NAMES utf8mb4 */;
CREATE TABLE IF NOT EXISTS \`shop\`.\`orders\` (
  \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
  \`status\` enum('new','paid)','x''y') NOT NULL DEFAULT 'new',
  \`total\` decimal(12,2) DEFAULT NULL COMMENT 'a, b (c)',
  \`created_at\` datetime NOT NULL,
  PRIMARY KEY (\`id\`),
  KEY \`idx\` (\`status\`),
  CONSTRAINT fk FOREIGN KEY (id) REFERENCES x(id)
) ENGINE=InnoDB;
CREATE TABLE logs (msg text, ts timestamp(3) NOT NULL);`;

test("parses dumps with several tables", () => {
  const { tables, errors } = parseCreateTables(SQL);
  assert.deepEqual(errors, []);
  assert.equal(tables.length, 2);
  const [orders, logs] = tables;
  assert.deepEqual(orders.columns.map((c) => c.name), ["id", "status", "total", "created_at"]);
  assert.deepEqual(orders.primaryKey, ["id"]);
  assert.equal(orders.columns[0].required, true);
  assert.equal(orders.columns[2].required, false);
  assert.equal(logs.primaryKey.length, 0);
});

test("renders DDL and JSON schema", () => {
  const [orders] = parseCreateTables(SQL).tables;
  const ddl = toBigQueryDDL(orders, "analytics");
  assert.match(ddl, /CREATE TABLE `analytics\.orders`/);
  assert.match(ddl, /id NUMERIC NOT NULL/);
  assert.match(ddl, /PRIMARY KEY \(id\) NOT ENFORCED/);
  assert.match(ddl, /CLUSTER BY id;$/);
  assert.deepEqual(JSON.parse(toJSONSchema(orders))[0], { name: "id", type: "NUMERIC", mode: "REQUIRED" });
});

test("reports input without CREATE TABLE", () => {
  assert.equal(parseCreateTables("SELECT 1").errors.length, 1);
});
