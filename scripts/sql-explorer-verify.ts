/**
 * Self-check for the SQL Explorer correctness fixes.
 * Run: `npx tsx scripts/sql-explorer-verify.ts`.
 *
 * Two halves:
 *
 * 1. The host API the extension now depends on. `codeEditor` must expose
 *    `getSelection` / `getCursor` (run-only-the-selection) and a sidebar
 *    section must accept `onItemContextMenu` (the schema-tree right-click
 *    menu). Both are contract, not implementation: drop either and the
 *    extension degrades silently rather than erroring.
 *
 * 2. Source-level invariants in the `tedi-sql-helper` sidecar that a live
 *    database would catch but CI has none of. Each one is a bug that shipped
 *    and produced WRONG DATA or unbounded memory rather than an error, which
 *    is exactly the class that survives a manual smoke test:
 *      - PostgreSQL binds one database per connection, so browsing another
 *        one has to go through a per-database pool (`backend_for`). Reading
 *        the base pool's catalog instead answers for the wrong database.
 *      - PostgreSQL resolves unqualified names via `search_path`, which holds
 *        SCHEMAS; the database name resolves nothing. And because `SET` is
 *        session state on a POOLED connection, the no-schema case must reset
 *        it instead of inheriting the previous request's.
 *      - The row cap has to stream. `fetch_all().take(n)` pulls the whole
 *        result set into memory first, so the cap capped the display only.
 *      - A statement batch must be pinned to ONE connection or `BEGIN` /
 *        `COMMIT` land on different ones and the transaction silently breaks.
 */

export {}; // dynamic-import-only file; marks it a module so top-level await is legal.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The extension lives in its own repository and the core repo IGNORES
 * `extensions/*`, so a fresh checkout has no `tedi.sql-explorer` directory at
 * all. Everything that reads it is therefore skipped rather than crashing —
 * the host-API half above still runs, because that part IS core code and is
 * exactly what a core change could break.
 */
const EXT_DIR = join(import.meta.dirname, "../extensions/tedi.sql-explorer");
const hasExtension = existsSync(EXT_DIR);

let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ok: ${label}`);
  } else {
    console.error(`  FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

// ---------------------------------------------------------------- Host API ---

const codeEditorSrc = readFileSync(
  join(import.meta.dirname, "../src/modules/extensions/codeEditor.ts"),
  "utf8",
);
// Both the type and the implementation, so a handle can't claim a method it
// doesn't return (the extension optional-chains, so a missing one is silent).
for (const method of ["getSelection", "getCursor"]) {
  check(
    `codeEditor declares ${method} on CodeEditorHandle`,
    new RegExp(`${method}\\(\\)\\s*:`).test(codeEditorSrc),
  );
  check(
    `codeEditor implements ${method}`,
    new RegExp(`${method}\\(\\)\\s*\\{`).test(codeEditorSrc),
  );
}
check(
  "getSelection returns empty for a collapsed cursor",
  /from === to \? "" :/.test(codeEditorSrc),
);

const registriesSrc = readFileSync(
  join(import.meta.dirname, "../src/modules/extensions/registries.ts"),
  "utf8",
);
check(
  "SidebarSection declares onItemContextMenu",
  /onItemContextMenu\?:\s*\(itemId: string, at: \{ x: number; y: number \}\)/.test(registriesSrc),
);

const sidebarSrc = readFileSync(
  join(import.meta.dirname, "../src/modules/extensions/components/ExtensionSidebarSection.tsx"),
  "utf8",
);
check("sidebar row wires onContextMenu", /onContextMenu=\{/.test(sidebarSrc));
check(
  "sidebar row suppresses the native menu",
  /onContextMenu[\s\S]{0,220}e\.preventDefault\(\)/.test(sidebarSrc),
);

// A managed database usually only accepts connections from a jump host, so
// without a tunnel the extension cannot reach it at all. The credentials must
// stay on the host side: the extension names a SAVED connection by id and gets
// back a loopback port, exactly as `openConnection` already works.
const tunnelSrc = readFileSync(
  join(import.meta.dirname, "../src/modules/ssh/tunnel.ts"),
  "utf8",
);
check(
  "ctx.ssh exposes openForward / closeForward",
  /openForward\(\s*\n?\s*connectionId: string/.test(hostSrcForSsh()) &&
    /closeForward\(connectionId: string/.test(hostSrcForSsh()),
);
check("both forward calls require ssh:connections", forwardPermChecks() === 2);
check(
  "a forward refuses a connection with no pinned host key",
  /if \(!conn\.lastFingerprint\)/.test(tunnelSrc),
);
check(
  "secrets are read inside the host, never returned to the caller",
  /getConnectionSecrets\(connectionId\)/.test(tunnelSrc) &&
    !/return[^;]*secrets/.test(tunnelSrc),
);
check(
  "sessions are shared per SSH host and closed with their last forward",
  /refs \+= 1/.test(tunnelSrc) && /live\.refs -= 1/.test(tunnelSrc),
);
check(
  "a dead session is forgotten so the next connect reopens it",
  /onExit: \(\) => dropSession\(connectionId\)/.test(tunnelSrc),
);

function hostSrcForSsh(): string {
  return readFileSync(join(import.meta.dirname, "../src/modules/extensions/host.ts"), "utf8");
}
function forwardPermChecks(): number {
  const src = hostSrcForSsh();
  const start = src.indexOf("      openForward(connectionId");
  return (src.slice(start, start + 900).match(/requirePermission\(ext\.id, declared, "ssh:connections"\)/g) ?? [])
    .length;
}

if (!hasExtension) {
  console.log(
    "  skip: extensions/tedi.sql-explorer is not checked out (separate repo), " +
      "so the sidecar and extension checks cannot run.",
  );
} else {
  // ------------------------------------------------------------ Sidecar (Rust) --

  const sidecar = (name: string) =>
    readFileSync(
      join(import.meta.dirname, `../extensions/tedi.sql-explorer/sidecar-src/src/${name}`),
      "utf8",
    );

  const stateRs = sidecar("state.rs");
  check(
    "Connection exposes backend_for (per-database PostgreSQL pool)",
    /pub async fn backend_for\(/.test(stateRs),
  );
  check(
    "backend_for short-circuits for non-PostgreSQL engines",
    /if self\.kind != "postgres"/.test(stateRs),
  );
  // Read-then-write: the read is the cache hit, the write publishes a newly
  // opened pool. Losing either turns every tree expand into a fresh connection.
  check(
    "backend_for caches the per-database pool",
    /extra_pools\.read\(\)/.test(stateRs) && /extra_pools\.write\(\)/.test(stateRs),
  );
  check("teardown closes every pool, not just the base one", /fn all_backends\(/.test(stateRs));

  // Handlers live in `routes.rs`; `main.rs` is process bootstrap only.
  const mainRs = sidecar("routes.rs");
  // Every schema-browsing handler must resolve its pool through browse_target;
  // reading conn.backend directly is the wrong-database bug.
  check("browse_target routes schema reads through backend_for", /backend_for\(Some\(&database\)\)/.test(mainRs));
  for (const handler of ["handle_schemas", "handle_tables", "handle_columns", "handle_indexes"]) {
    const body = mainRs.slice(mainRs.indexOf(`async fn ${handler}(`)).slice(0, 600);
    check(`${handler} uses browse_target`, /browse_target\(&conn, &q\)/.test(body));
    check(`${handler} does not read conn.backend directly`, !/&conn\.backend/.test(body));
  }
  check(
    "PostgreSQL default schema is public, never the database name",
    /if conn\.kind == "postgres"[\s\S]{0,90}"public"\.to_string\(\)/.test(mainRs),
  );
  check(
    "row mutations resolve their own pool",
    (mainRs.match(/backend_for\(Some\(&req\.database\)\)/g) ?? []).length >= 4,
  );
  check(
    "MySQL falls back to the pool's real database so USE always runs",
    /\.or\(conn\.current_database\.as_deref\(\)\)/.test(mainRs),
  );
  check("cancel reaches the server, not just the future", /cancel_on_server\(&conn\.backend, pid\)/.test(mainRs));

  const queryRs = sidecar("query.rs");
  check(
    "PostgreSQL search_path is built from the SCHEMA",
    /SET search_path TO \{\}, public[\s\S]{0,40}escape_pg_ident\(sc\)/.test(queryRs),
  );
  check(
    "no-schema requests RESET search_path instead of inheriting it",
    /None => "SET search_path TO DEFAULT"/.test(queryRs),
  );
  check(
    "the batch pins a connection unconditionally (transactions)",
    /Backend::Mysql\(pool\) => \{\s*\n\s*let mut conn = pool\.acquire/.test(queryRs) &&
      /Backend::Postgres\(pool\) => \{\s*\n\s*let mut conn = pool\.acquire/.test(queryRs),
  );
  check("the row cap streams rather than materialising", /macro_rules! fetch_capped/.test(queryRs));
  check(
    "query.rs no longer fetch_all's a result set",
    !/fetch_all\(/.test(queryRs.slice(queryRs.indexOf("async fn run_one"))),
  );
  check("cancel_on_server issues a real server cancel", /KILL QUERY \{backend_pid\}/.test(queryRs) && /pg_cancel_backend/.test(queryRs));
  // A timeout that only drops the future leaves the server running the
  // statement AND the pinned connection stuck behind it, so every later
  // statement in the batch timed out too.
  check(
    "a timed-out statement is cancelled server-side as well",
    /Err\(AppError::Timeout\) => \{[\s\S]{0,700}cancel_on_server\(backend, pid\)/.test(queryRs),
  );

  // The UI must not report a write it did not make.
  const cellEditJs = readFileSync(
    join(import.meta.dirname, "../extensions/tedi.sql-explorer/src/gridedit/cellEdit.js"),
    "utf8",
  );
  check(
    "an inline edit that matched no row is not reported as saved",
    /resp\?\.affected === 0/.test(cellEditJs) && /revert\(\)/.test(cellEditJs),
  );
  const rowOpsJs = readFileSync(
    join(import.meta.dirname, "../extensions/tedi.sql-explorer/src/gridedit/rowOps.js"),
    "utf8",
  );
  check("a delete that matched no row is not reported as deleted", /resp\?\.affected === 0/.test(rowOpsJs));

  const exportRs = sidecar("export.rs");
  check("export streams to its row limit", /macro_rules! stream_rows/.test(exportRs));
  check("export no longer fetch_all's", !/fetch_all\(/.test(exportRs));
  // The export dialog sends BOTH `database` and `schema` for an open table, so
  // picking the quote style from whichever field is set made every PostgreSQL
  // table export emit MySQL backticks and fail to parse.
  check(
    "export quotes identifiers by the connection's engine, not by which field is set",
    /fn build_sql\(req: &ExportRequest, dialect: SqlDialect\)/.test(exportRs) &&
      /SqlDialect::Postgres => \(req\.schema\.as_deref\(\), escape_pg_ident\)/.test(exportRs) &&
      /SqlDialect::Mysql => \(req\.database\.as_deref\(\), escape_mysql_ident\)/.test(exportRs),
  );

  // Browsing (`/table-rows`) lives in `rows.rs`; `edit.rs` is mutations only.
  const rowsRs = sidecar("rows.rs");
  check("COUNT(*) is gated behind want_total", /pub want_total: bool/.test(rowsRs));
  check(
    "every backend honours want_total",
    (rowsRs.match(/if req\.want_total \{/g) ?? []).length === 3,
  );

  const schemaRs = sidecar("schema.rs");
  // `relkind` is Postgres' internal `"char"` type; decoding it as String fails
  // and the fallback made every view look like a table.
  check(
    "PostgreSQL casts relkind to text so a view is reported as one",
    /c\.relkind::text AS kind/.test(schemaRs),
  );
  check(
    "a never-analysed reltuples (-1) is reported as unknown, not a negative count",
    /\.filter\(\|n\| \*n >= 0\)/.test(schemaRs),
  );

  const valueRs = sidecar("value.rs");
  // Past 2^53 the client's JSON.parse rounds, so two distinct bigint keys
  // rendered identically and an edit keyed on the rounded value matched nothing.
  check("integers outside JS's safe range are sent as strings", /fn json_int\(/.test(valueRs));
  check(
    "every 64-bit integer path goes through json_int",
    !/try_get::<i64, _>\(idx\)\s*\n\s*\.map\(Value::from\)/.test(valueRs),
  );
  // Arrays / enums / intervals used to decode to NULL, which reads as "empty".
  check("PostgreSQL decodes arrays", /if type_name\.ends_with\("\[\]"\)/.test(valueRs));
  check(
    "array elements are Option<T> so a NULL inside an array doesn't fail the row",
    /try_get::<Vec<Option<\$t>>, _>\(idx\)/.test(valueRs),
  );
  check("PostgreSQL renders INTERVAL", /fn format_interval/.test(valueRs));
  // try_get_unchecked runs the String decoder over raw bytes, so it "succeeds"
  // on binary encodings that happen to be valid UTF-8.
  check(
    "the unchecked-String escape hatch is guarded against binary mojibake",
    /fn looks_like_text/.test(valueRs) &&
      /try_get_unchecked::<String, _>\(idx\)[\s\S]{0,120}looks_like_text/.test(valueRs),
  );
  check(
    "an unrenderable value reports its type instead of a false NULL",
    /"unsupported"/.test(valueRs) && /"pg_type"/.test(valueRs),
  );

  // PostgreSQL type-checks parameters, so a composite or a NULL bound as text is
  // rejected by the column. Both were real: no array column could be written at
  // all, and clearing ANY non-text cell to NULL failed.
  const bindRs = sidecar("bind.rs");
  check(
    "PostgreSQL casts the placeholder to the column's declared type",
    /fn pg_cast_types\(/.test(bindRs) && /\$\{idx\}::\{ty\}/.test(bindRs),
  );
  check(
    "NULL goes through the cast too, so any column can be cleared",
    /Value::Null \| Value::Array\(_\) => true/.test(bindRs),
  );
  check(
    "a NULL keeps binding as a real NULL, not the text \"null\"",
    /\(true, Value::Null\) => q\.bind\(None::<String>\)/.test(bindRs),
  );
  check(
    "the cast type name is validated before being inlined",
    /fn pg_type_is_safe/.test(bindRs) && /pg_type_is_safe\(&ty\)/.test(bindRs),
  );
  check(
    "the catalog lookup is skipped when no value needs a cast",
    /if !values\.values\(\)\.any\(pg_needs_cast\) \{[\s\S]{0,60}return HashMap::new\(\)/.test(bindRs),
  );
  check(
    "array elements are quoted, so a comma or brace in a value is safe",
    /Value::String\(s\) => format!\("\\"\{\}\\"", s\.replace/.test(bindRs),
  );

  const metaRs = sidecar("meta.rs");
  for (const fn of ["list_indexes", "list_foreign_keys", "table_ddl"]) {
    check(`meta.rs exposes ${fn}`, new RegExp(`pub async fn ${fn}\\(`).test(metaRs));
  }
  check("PostgreSQL FK actions decode from their catalog char", /fn pg_fk_action/.test(metaRs));

  // ------------------------------------------------- Extension logic (live) ----
  //
  // The sidecar is covered by a live probe against a real database; the
  // extension's own SQL building is not, and it is where a quoting or
  // table-resolution slip writes to the WRONG PLACE rather than erroring. These
  // modules are pure (no import-time DOM), so they run here directly.

  const ext = "../extensions/tedi.sql-explorer/src";
  const { state } = await import(`${ext}/runtime.js`);
  const sql = await import(`${ext}/sql.js`);
  const refs = await import(`${ext}/query/sqlRefs.js`);
  const cols = await import(`${ext}/columns.js`);
  const dialects = await import(`${ext}/dialects/index.js`);
  const tree = await import(`${ext}/tree/data.js`);

  state.connections = [
    { id: "m", kind: "mysql", allow_writes: true },
    { id: "p", kind: "postgres", allow_writes: true },
    { id: "ro", kind: "mysql", allow_writes: false },
    { id: "slite", kind: "sqlite", allow_writes: true, sqliteReadOnly: true },
  ];

  // Quoting follows the engine, and an embedded quote char is doubled rather
  // than ending the identifier early.
  check(
    "qualified names use the engine's quote char",
    sql.qualifiedTableName("m", { schema: "db", table: "tbl" }) === "`db`.`tbl`" &&
      sql.qualifiedTableName("p", { schema: "s", table: "t" }) === '"s"."t"',
    `${sql.qualifiedTableName("m", { schema: "db", table: "tbl" })} / ${sql.qualifiedTableName("p", { schema: "s", table: "t" })}`,
  );
  check(
    "an embedded quote char is doubled, not escaped away",
    sql.qualifiedTableName("m", { schema: "d`b", table: "t" }) === "`d``b`.`t`" &&
      sql.qualifiedTableName("p", { schema: 's"s', table: "t" }) === '"s""s"."t"',
  );
  // Display SQL reaches the clipboard and the confirm preview, so a value with a
  // quote in it must not look like it terminates the literal.
  check(
    "string literals double an embedded apostrophe",
    sql.buildUpdateSql("p", { schema: "s", table: "t" }, { id: 1 }, { name: "O'Hara" }) ===
      `UPDATE "s"."t" SET "name" = 'O''Hara' WHERE "id" = 1;`,
    sql.buildUpdateSql("p", { schema: "s", table: "t" }, { id: 1 }, { name: "O'Hara" }),
  );
  check(
    "NULL is a keyword, not the string 'null'",
    sql.buildInsertSql("p", { schema: "s", table: "t" }, { a: null, b: 2 }) ===
      `INSERT INTO "s"."t" ("a", "b") VALUES (NULL, 2);`,
  );
  check(
    "DELETE keys on every pk column",
    sql.buildDeleteSql("m", { schema: "d", table: "t" }, { a: 1, b: "x" }) ===
      "DELETE FROM `d`.`t` WHERE `a` = 1 AND `b` = 'x';",
  );

  // The read-only gate hides every write affordance in the UI.
  check(
    "isReadOnly covers allow_writes and a read-only SQLite file",
    sql.isReadOnly("ro") === true && sql.isReadOnly("slite") === true && sql.isReadOnly("m") === false,
  );
  // What earns a confirmation modal before Run sends it. Too eager and users
  // click through it; too lax and `DELETE FROM users` runs on a keystroke.
  for (const [label, q, wanted] of [
    ["plain SELECT", "SELECT * FROM users", false],
    ["targeted DELETE", "DELETE FROM users WHERE id = 1", false],
    ["targeted UPDATE", "UPDATE users SET a = 1 WHERE id = 2", false],
    ["INSERT", "INSERT INTO users (a) VALUES (1)", false],
    ["DELETE with no WHERE", "DELETE FROM users", true],
    ["UPDATE with no WHERE", "UPDATE users SET active = false", true],
    ["DROP TABLE", "drop table users", true],
    ["TRUNCATE", "TRUNCATE TABLE t", true],
    // A keyword inside a literal or a comment decides nothing.
    ["'dropped' as a column name", "SELECT dropped FROM t", false],
    ["WHERE inside a string", "DELETE FROM t WHERE note = 'no where here'", false],
    ["DROP inside a comment", "SELECT 1 -- drop table users", false],
    // The bare-WHERE check has to be per statement, not per script.
    ["safe statement before an unsafe one", "SELECT 1; DELETE FROM users", true],
  ] as const) {
    const got = sql.destructiveReason(q) !== null;
    check(`destructiveReason: ${label} ${wanted ? "asks" : "does not ask"}`, got === wanted, sql.destructiveReason(q) ?? "null");
  }

  // Inline edit of a free-form result hangs off this test. A false positive
  // means editing a cell UPDATEs a base table the rows did not come from.
  for (const [label, q, want] of [
    ["plain select", "SELECT * FROM users", true],
    ["join", "SELECT * FROM a JOIN b ON a.id=b.id", false],
    ["comma join", "SELECT * FROM a, b", false],
    ["group by", "SELECT c, count(*) FROM t GROUP BY c", false],
    ["union", "SELECT 1 UNION SELECT 2", false],
    ["distinct", "SELECT DISTINCT a FROM t", false],
    // A keyword inside a string literal must not decide this either way.
    ["JOIN inside a literal", "SELECT * FROM t WHERE s = 'a JOIN b'", true],
  ] as const) {
    check(`isSingleTableSelect: ${label}`, refs.isSingleTableSelect(q) === want);
  }
  check(
    "table refs resolve to the CURRENT database when the name is ambiguous",
    refs.findCachedMatch(
      {
        currentDatabase: "app",
        schemaCache: new Map([
          ["other.other.users", { database: "other", schema: "other", table: "users", columns: [] }],
          ["app.app.users", { database: "app", schema: "app", table: "users", columns: [] }],
        ]),
      },
      refs.parseSqlReferences("SELECT * FROM users"),
    )?.database === "app",
  );

  // Typed cell editors + the no-op guard on save.
  for (const [label, info, want] of [
    ["mysql bool", { data_type: "tinyint", full_type: "tinyint(1)" }, "boolean"],
    ["mysql int", { data_type: "int", full_type: "int(11)" }, "integer"],
    ["pg bool", { data_type: "bool", full_type: "boolean" }, "boolean"],
    ["pg jsonb", { data_type: "jsonb", full_type: "jsonb" }, "json"],
    ["pg bytea", { data_type: "bytea", full_type: "bytea" }, "bytes"],
    ["timestamptz", { data_type: "timestamptz", full_type: "timestamptz" }, "datetime"],
    ["varchar", { data_type: "varchar", full_type: "varchar(255)" }, "text"],
  ] as const) {
    check(`classifyColumnType: ${label}`, cols.classifyColumnType(info) === want, String(cols.classifyColumnType(info)));
  }
  const enumType = cols.classifyColumnType({ data_type: "enum", full_type: "enum('a','b')" });
  check("classifyColumnType reads enum options", enumType?.kind === "enum" && enumType.options.join(",") === "a,b");
  // A tinyint(1) round-trips as 1/0 but may arrive as true/false; treating that
  // as a change fires a spurious UPDATE on mere click-away.
  check(
    "deepEqual treats 1 / true / '1' as the same boolean",
    cols.deepEqual(1, true) && cols.deepEqual("0", false) && !cols.deepEqual(1, false),
  );

  // Explain must never be ANALYZE: that RUNS the statement.
  for (const id of ["mysql", "postgres", "sqlite"]) {
    const prefix = dialects.getDialect(id).explainPrefix;
    check(`${id} has an explainPrefix and it is not ANALYZE`, !!prefix && !/ANALY[SZ]E/i.test(prefix), prefix);
  }

  // The extension must never hold the SSH credentials: it names a saved
  // connection and receives a port.
  const extTunnel = readFileSync(
    join(import.meta.dirname, "../extensions/tedi.sql-explorer/src/connections/tunnel.js"),
    "utf8",
  );
  // Comments stripped: the prose explains why credentials stay on the host side,
  // so the words appear there legitimately. Only the CODE must be free of them.
  const extTunnelCode = extTunnel.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  check(
    "the extension tunnels by saved-connection id, never by key or password",
    /ctx\.ssh\.openForward\(form\.sshTunnel/.test(extTunnelCode) &&
      !/privateKey|\.pem|password/i.test(extTunnelCode),
  );
  check(
    "the connect URL is built against the forwarded loopback port",
    /host: "127\.0\.0\.1", port: String\(localPort\)/.test(extTunnel),
  );
  const extManifest = readFileSync(
    join(import.meta.dirname, "../extensions/tedi.sql-explorer/manifest.json"),
    "utf8",
  );
  check("the extension declares ssh:connections", /"ssh:connections"/.test(extManifest));

  // The date/time picker's conversions. A misparse here writes the WRONG DATE
  // to the database, silently, which is why they live in a pure module.
  const dateParts = await import(`${ext}/dom/dateParts.js`);
  for (const [label, type, value, want] of [
    ["date", "date", "2026-08-04", "2026-08-04"],
    ["datetime with a space separator", "datetime", "2026-08-04 13:05:09", "2026-08-04T13:05:09"],
    ["datetime with a T separator", "datetime", "2026-08-04T13:05:09", "2026-08-04T13:05:09"],
    // A timestamptz arrives with an offset; the picker edits the local parts.
    ["timestamptz suffix is ignored", "datetime", "2026-08-04T13:05:09+07:00", "2026-08-04T13:05:09"],
    ["time without seconds", "time", "13:05", "13:05:00"],
    ["time with seconds", "time", "13:05:09", "13:05:09"],
    // Single-digit month/day must not shift the date.
    ["single-digit parts", "date", "2026-1-2", "2026-01-02"],
    // A time-only value must not be read as a date, nor the reverse.
    ["a date value in a time field ignores the date", "time", "2026-08-04", "00:00:00"],
  ] as const) {
    const got = dateParts.formatState(type, dateParts.parseState(type, value));
    check(`date round-trip: ${label}`, got === want, `${value} -> ${got} (want ${want})`);
  }
  check(
    "an out-of-range month is clamped rather than rolling over",
    dateParts.formatState("date", dateParts.parseState("date", "2026-99-99")) === "2026-12-31",
  );

  // PostgreSQL's `database` is the maintenance database it connects to, not a
  // filter. Treating it as one hid every database the user keeps data in, since
  // the maintenance database is usually the empty `postgres`.
  check(
    "the PostgreSQL database field is a connect target, not a tree filter",
    dialects.getDialect("postgres").databaseIsConnectTarget === true &&
      !dialects.getDialect("mysql").databaseIsConnectTarget,
  );

  // Tree node ids are packed into one string; a name containing the separator
  // character or a dot must survive the round-trip.
  const packed = tree.nid("table", "conn-1", "my.db", "sch", "tbl.name");
  const parsed = tree.parseNid(packed);
  check(
    "tree node ids round-trip names containing dots",
    parsed.kind === "table" && parsed.connId === "conn-1" && parsed.db === "my.db" && parsed.schema === "sch" && parsed.table === "tbl.name",
    JSON.stringify(parsed),
  );
}

// ------------------------------------------------------------------ Result ---

if (failed > 0) {
  console.error(`\nsql-explorer-verify: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nsql-explorer-verify: all checks passed");
