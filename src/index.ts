// MySQL → BigQuery schema conversion. The type mapping is the one Quayen (https://quayen.com) uses when it
// creates BigQuery tables for replicated MySQL tables.

export type BQColumn = { name: string; bqName: string; mysqlType: string; bqType: string; required: boolean; note?: string };
export type BQTable = { name: string; bqName: string; columns: BQColumn[]; primaryKey: string[] };

const precisionRe = /\((\d+)(?:\s*,\s*(\d+))?\)/;
const SPATIAL = ["geometry", "point", "linestring", "polygon", "multipoint", "multilinestring", "multipolygon", "geometrycollection", "geomcollection"];
const BINARY = ["binary", "varbinary", "tinyblob", "blob", "mediumblob", "longblob", "vector"];
const BOOL_NOTE = "MySQL BOOLEAN is TINYINT(1); values stay 0 and 1.";

export function mapType(rawType: string): { bqType: string; note?: string } {
  const raw = rawType.toLowerCase().trim();
  const base = raw.split(/[( ]/)[0];
  switch (base) {
    case "tinyint":
      return { bqType: "INT64", note: /^tinyint\s*\(\s*1\s*\)/.test(raw) ? BOOL_NOTE : undefined };
    case "bool":
    case "boolean":
      return { bqType: "INT64", note: BOOL_NOTE };
    case "smallint":
    case "mediumint":
    case "int":
    case "integer":
    case "year":
    case "bit":
      return { bqType: "INT64" };
    case "bigint":
      return raw.includes("unsigned") ? { bqType: "NUMERIC", note: "Unsigned BIGINT can exceed INT64's maximum (2^63 − 1), so it becomes NUMERIC." } : { bqType: "INT64" };
    case "serial":
      return { bqType: "NUMERIC", note: "SERIAL is BIGINT UNSIGNED, which can exceed INT64's maximum." };
    case "float":
    case "double":
    case "real":
      return { bqType: "FLOAT64" };
    case "decimal":
    case "numeric":
    case "dec":
    case "fixed": {
      const m = precisionRe.exec(raw);
      const p = m ? Number(m[1]) : 10;
      const s = m?.[2] ? Number(m[2]) : 0;
      return p - s <= 29 && s <= 9 ? { bqType: "NUMERIC" } : { bqType: "BIGNUMERIC", note: "More than 29 integer digits or 9 decimal places doesn't fit NUMERIC." };
    }
    case "date":
      return { bqType: "DATE" };
    case "datetime":
      return { bqType: "DATETIME", note: "No time zone, like MySQL DATETIME." };
    case "timestamp":
      return { bqType: "TIMESTAMP", note: "An absolute point in time, shown in UTC." };
    case "json":
      return { bqType: "JSON" };
    case "time":
      return { bqType: "STRING", note: "Stored as text, for example '13:45:00'." };
    case "enum":
      return { bqType: "STRING", note: "Stored as the value's text." };
    case "set":
      return { bqType: "STRING", note: "Stored as text, for example 'a,b'." };
    default:
      if (SPATIAL.includes(base)) return { bqType: "BYTES", note: "Spatial values are stored as bytes, not GEOGRAPHY." };
      if (BINARY.includes(base)) return { bqType: "BYTES" };
      return { bqType: "STRING" };
  }
}

export function sanitizeIdent(s: string): string {
  const out = s.replace(/[^A-Za-z0-9_]/g, "_");
  return out === "" || /^[0-9]/.test(out) ? `_${out}` : out;
}

const IDENT = String.raw`(?:\x60[^\x60]+\x60|"[^"]+"|[A-Za-z0-9_$]+)`;
const unquote = (s: string) => s.trim().replace(/^[\x60"]|[\x60"]$/g, "");

function closingParen(s: string, open: number): number {
  let depth = 0;
  let quote = "";
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return -1;
}

function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

const keyColumns = (def: string) => {
  const open = def.indexOf("(");
  const close = open < 0 ? -1 : closingParen(def, open);
  if (close < 0) return [];
  return splitTopLevel(def.slice(open + 1, close)).map((c) => unquote(c.replace(/\s*\(\d+\)|\s+(ASC|DESC)$/gi, "")));
};

/** Parses one or more MySQL CREATE TABLE statements (as printed by SHOW CREATE TABLE or mysqldump). */
export function parseCreateTables(sql: string): { tables: BQTable[]; errors: string[] } {
  const tables: BQTable[] = [];
  const errors: string[] = [];
  const cleaned = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*(--|#).*$/gm, "");
  const re = new RegExp(String.raw`CREATE\s+(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT}(?:\s*\.\s*${IDENT})?)\s*\(`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned))) {
    const name = unquote(m[1].split(/\s*\.\s*/).pop() ?? m[1]);
    const open = m.index + m[0].length - 1;
    const close = closingParen(cleaned, open);
    if (close < 0) {
      errors.push(`Couldn't find the closing parenthesis of CREATE TABLE ${name}.`);
      break;
    }
    re.lastIndex = close;
    const columns: BQColumn[] = [];
    const primaryKey: string[] = [];
    for (const part of splitTopLevel(cleaned.slice(open + 1, close))) {
      if (/^(CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY/i.test(part)) {
        primaryKey.push(...keyColumns(part));
        continue;
      }
      if (/^(KEY|INDEX|UNIQUE|CONSTRAINT|FOREIGN|FULLTEXT|SPATIAL|CHECK|PERIOD)\b/i.test(part)) continue;
      const cm = new RegExp(String.raw`^(${IDENT})\s+([\s\S]*)$`).exec(part);
      const tm = cm && /^([a-z]+(?:\s+precision)?)(\s*\((?:'(?:[^']|'')*'|[^)'])*\))?((?:\s+(?:unsigned|signed|zerofill))*)/i.exec(cm[2]);
      if (!cm || !tm) {
        errors.push(`Skipped a line in ${name} that doesn't look like a column: ${part.slice(0, 60)}`);
        continue;
      }
      const colName = unquote(cm[1]);
      const mysqlType = tm[0].replace(/\s+/g, " ").trim();
      if (/\bPRIMARY\s+KEY\b/i.test(cm[2])) primaryKey.push(colName);
      const { bqType, note } = mapType(mysqlType);
      const bqName = sanitizeIdent(colName);
      const notes = [note, bqName !== colName ? "Renamed: BigQuery column names allow only letters, digits and underscores." : undefined].filter(Boolean);
      columns.push({ name: colName, bqName, mysqlType, bqType, required: /\bNOT\s+NULL\b/i.test(cm[2]), note: notes.join(" ") || undefined });
    }
    for (const c of columns) if (primaryKey.includes(c.name)) c.required = true;
    tables.push({ name, bqName: sanitizeIdent(name), columns, primaryKey });
  }
  if (!tables.length && !errors.length) errors.push("No CREATE TABLE statement found. Paste the output of SHOW CREATE TABLE.");
  return { tables, errors };
}

// BigQuery can cluster by at most four columns of these types.
const CLUSTERABLE = ["INT64", "STRING", "NUMERIC", "BIGNUMERIC", "DATE", "DATETIME", "TIMESTAMP", "BOOL"];

export function toBigQueryDDL(t: BQTable, dataset: string): string {
  const pk = t.primaryKey.map(sanitizeIdent);
  const lines = t.columns.map((c) => `  ${c.bqName} ${c.bqType}${c.required ? " NOT NULL" : ""}`);
  if (pk.length) lines.push(`  PRIMARY KEY (${pk.join(", ")}) NOT ENFORCED`);
  const cluster = t.columns.filter((c) => t.primaryKey.includes(c.name) && CLUSTERABLE.includes(c.bqType)).slice(0, 4).map((c) => c.bqName);
  return `CREATE TABLE \`${sanitizeIdent(dataset || "analytics")}.${t.bqName}\` (\n${lines.join(",\n")}\n)${cluster.length ? `\nCLUSTER BY ${cluster.join(", ")}` : ""};`;
}

export function toJSONSchema(t: BQTable): string {
  return JSON.stringify(t.columns.map((c) => ({ name: c.bqName, type: c.bqType, mode: c.required ? "REQUIRED" : "NULLABLE" })), null, 2);
}
