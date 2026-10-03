// Snapshot-before-apply guard for one-transaction SQL migrations.
// It checks only the existing tables a migration writes, so live tables such as
// sessions never cause a false failure. Added rows are allowed; a changed or
// deleted pre-existing row fails the transaction, which rolls the migration back.

const DOLLAR = /\$[A-Za-z_]*\$/g;
const IDENT = String.raw`((?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))?)`;
const WRITES = [
  String.raw`INSERT\s+INTO\s+${IDENT}`,
  String.raw`UPDATE\s+(?:ONLY\s+)?${IDENT}(?:\s+(?:AS\s+)?\w+)?\s+SET\b`,
  String.raw`DELETE\s+FROM\s+(?:ONLY\s+)?${IDENT}`,
  String.raw`TRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?${IDENT}`,
  String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${IDENT}`,
  String.raw`DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${IDENT}`,
  String.raw`MERGE\s+INTO\s+${IDENT}`,
  String.raw`COPY\s+${IDENT}\s+FROM\b`,
].map((source) => new RegExp(String.raw`\b${source}`, "gi"));

/** Splits SQL into top-level statements, keeping dollar-quoted bodies intact and dropping BEGIN/COMMIT. */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let index = 0;
  while (index < sql.length) {
    DOLLAR.lastIndex = index;
    const open = DOLLAR.exec(sql);
    const end = open ? open.index : sql.length;
    const plain = sql.slice(index, end).replace(/--[^\n]*/g, "").split(";");
    current += plain.shift();
    for (const fragment of plain) { statements.push(current); current = fragment; }
    if (!open) break;
    const close = sql.indexOf(open[0], open.index + open[0].length);
    if (close < 0) throw new Error(`Unterminated ${open[0]} quote`);
    current += sql.slice(open.index, close + open[0].length);
    index = close + open[0].length;
  }
  statements.push(current);
  return statements.map((s) => s.trim()).filter((s) => s && !/^(BEGIN|COMMIT)$/i.test(s));
}

function normalize(name: string) {
  return name.replace(/"/g, "").replace(/^public\./i, "").toLowerCase();
}

/** Existing tables the migration writes directly. Function bodies are skipped: they do not run during the migration. */
export function writtenTables(statements: string[], declared: string[] = []): string[] {
  const tables = new Set(declared.map(normalize));
  for (const statement of statements) {
    const executed = /^CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE)\b/i.test(statement)
      ? statement.replace(/(\$[A-Za-z_]*\$)[\s\S]*?\1/g, "")
      : statement;
    if (/^DO\b/i.test(statement) && /\bEXECUTE\s+(?!FUNCTION\b|PROCEDURE\b)/i.test(executed) && !declared.length) {
      throw new Error("A DO block runs dynamic SQL. Name the tables it writes with --writes <table>.");
    }
    for (const pattern of WRITES) {
      for (const match of executed.matchAll(pattern)) tables.add(normalize(match[1]));
    }
  }
  for (const table of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`Unsupported table name: ${table}`);
  }
  return [...tables].sort();
}

/** SQL that snapshots row hashes of `tables` before the migration statements run. */
export function snapshotBefore(tables: string[]): string[] {
  const list = tables.map((t) => `'${t}'`).join(",");
  return [
    "CREATE TEMP TABLE migration_row_guard (tbl text, cols text, h text) ON COMMIT DROP",
    `DO $guard$ DECLARE t text; c text; BEGIN
  FOREACH t IN ARRAY ARRAY[${list}]::text[] LOOP
    CONTINUE WHEN to_regclass(format('%I', t)) IS NULL;
    SELECT string_agg(format('%I', column_name), ',' ORDER BY ordinal_position) INTO c
      FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = t;
    EXECUTE format('INSERT INTO migration_row_guard SELECT %L, %L, md5(ROW(%s)::text) FROM %I', t, c, c, t);
  END LOOP;
END $guard$`,
  ];
}

/** SQL that fails the transaction if any snapshotted row was changed or deleted. Added rows pass. */
export function checkAfter(): string {
  return `DO $guard$ DECLARE r record; lost boolean; changed text[] := '{}'; BEGIN
  FOR r IN SELECT DISTINCT tbl, cols FROM migration_row_guard ORDER BY tbl LOOP
    BEGIN
      EXECUTE format('SELECT EXISTS (SELECT h FROM migration_row_guard WHERE tbl = %L EXCEPT ALL SELECT md5(ROW(%s)::text) FROM %I)',
        r.tbl, r.cols, r.tbl) INTO lost;
    EXCEPTION WHEN undefined_table OR undefined_column THEN lost := true;
    END;
    IF lost THEN changed := changed || r.tbl; END IF;
  END LOOP;
  IF cardinality(changed) > 0 THEN
    RAISE EXCEPTION 'Migration changed or deleted existing rows in: %', array_to_string(changed, ', ');
  END IF;
END $guard$`;
}

export type MigrationPlan = { statements: string[]; guarded: string[]; unguarded: string[]; transaction: string[] };

export function planMigration(sql: string, options: { writes?: string[]; expectChange?: string[] } = {}): MigrationPlan {
  const statements = splitStatements(sql);
  const written = writtenTables(statements, options.writes);
  const unguarded = (options.expectChange ?? []).map(normalize);
  const guarded = written.filter((t) => !unguarded.includes(t));
  return { statements, guarded, unguarded, transaction: [...snapshotBefore(guarded), ...statements, checkAfter()] };
}
