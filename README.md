# mysql-to-bigquery-schema

Convert MySQL `CREATE TABLE` statements (from `SHOW CREATE TABLE` or `mysqldump --no-data`) into BigQuery DDL or a JSON schema for `bq mk`, with a type mapping that handles the edge cases: unsigned `BIGINT`, wide `DECIMAL`s, `ENUM`/`SET`, `TIME`, spatial types and identifiers BigQuery won't accept.

No dependencies. Prefer a browser? Use the [web version](https://quayen.com/tools/mysql-to-bigquery-schema-converter).

## Usage

```sh
npx mysql-to-bigquery-schema schema.sql
mysqldump --no-data mydb | npx mysql-to-bigquery-schema --dataset analytics
npx mysql-to-bigquery-schema --format json orders.sql > orders.json && bq mk --table analytics.orders orders.json
npx mysql-to-bigquery-schema --format table schema.sql   # see the mapping and why
```

Input:

```sql
CREATE TABLE `orders` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `status` enum('pending','paid','shipped') NOT NULL,
  `total` decimal(12,2) NOT NULL,
  `created_at` datetime NOT NULL,
  PRIMARY KEY (`id`)
);
```

Output:

```sql
CREATE TABLE `analytics.orders` (
  id NUMERIC NOT NULL,
  status STRING NOT NULL,
  total NUMERIC NOT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (id) NOT ENFORCED
)
CLUSTER BY id;
```

## Type mapping

| MySQL | BigQuery | Notes |
|---|---|---|
| `TINYINT`, `SMALLINT`, `MEDIUMINT`, `INT`, `BIGINT`, `YEAR`, `BIT` | `INT64` | `TINYINT(1)`/`BOOLEAN` stays 0/1 |
| `BIGINT UNSIGNED`, `SERIAL` | `NUMERIC` | values above 2^63 − 1 don't fit `INT64` |
| `DECIMAL(p,s)` | `NUMERIC` if p − s ≤ 29 and s ≤ 9, else `BIGNUMERIC` | |
| `FLOAT`, `DOUBLE`, `REAL` | `FLOAT64` | |
| `DATE` / `DATETIME` / `TIMESTAMP` | `DATE` / `DATETIME` / `TIMESTAMP` | `DATETIME` has no time zone; `TIMESTAMP` is UTC |
| `JSON` | `JSON` | |
| `CHAR`, `VARCHAR`, `*TEXT`, `ENUM`, `SET`, `TIME` | `STRING` | `TIME` can exceed 24 hours |
| `BINARY`, `VARBINARY`, `*BLOB`, spatial types | `BYTES` | |

Column and table names are sanitized to letters, digits and underscores. BigQuery primary keys are declared `NOT ENFORCED`, and tables are clustered by the primary key (up to four clusterable columns).

## Library

```ts
import { parseCreateTables, toBigQueryDDL, toJSONSchema } from "mysql-to-bigquery-schema";
const { tables, errors } = parseCreateTables(sql);
console.log(toBigQueryDDL(tables[0], "analytics"));
```

## Keeping the table in sync

This creates empty tables. To fill them and keep them current with every insert, update and delete from MySQL, you need change data capture from the binary log. [Quayen](https://quayen.com) does that as a managed service (the type mapping here is the one it uses); see also [how MySQL to BigQuery CDC works](https://quayen.com/docs/how-it-works).

## License

MIT
