/**
 * What a person sees from `tedi <verb>`: tables and plain text in place of JSON.
 *
 * Pure, so `cli-verify` can read the output with no app and no terminal. A view picks the
 * columns worth a glance and leaves the rest to `--json`; anything without a view still
 * reads sensibly through `pretty`, so a new tool never prints raw JSON at someone.
 */

const clean = (v) => String(v ?? "").replace(/\s*\n\s*/g, " ");

function ago(ms) {
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** `D:/Users/me/x` -> `~/x`, and the same with backslashes. */
function shortPath(p, home) {
  const path = String(p ?? "").replaceAll("\\", "/");
  return home && (path === home || path.startsWith(`${home}/`))
    ? `~${path.slice(home.length)}`
    : path;
}

/**
 * Columns are `[header, value]` or `[header, value, "right"]`. The last one is cut to what
 * the terminal has left, because the alternative is a wrapped table nobody can read.
 */
export function table(rows, cols, o = {}) {
  if (!rows.length) return "(none)";
  const cells = rows.map((row) => cols.map(([, get]) => clean(get(row))));
  const widths = cols.map(([h], i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const last = cols.length - 1;
  const room = o.width
    ? Math.max(o.width - widths.slice(0, last).reduce((sum, w) => sum + w + 2, 0), 12)
    : Infinity;
  const line = (values) =>
    values
      .map((value, i) => {
        if (i === last) return value.length > room ? `${value.slice(0, room - 1)}…` : value;
        return cols[i][2] === "right" ? value.padStart(widths[i]) : value.padEnd(widths[i]);
      })
      .join("  ")
      .trimEnd();
  const head = line(cols.map(([h]) => h));
  return [o.color ? `\x1b[1m${head}\x1b[0m` : head, ...cells.map(line)].join("\n");
}

const isRow = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isScalar = (x) => x === null || typeof x !== "object";

/** Anything at all, readably: rows as a table, an object as aligned `key  value`. */
export function pretty(value, o = {}) {
  if (value === null || value === undefined) return "(nothing)";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) {
    if (!value.length) return "(none)";
    if (!value.every(isRow)) {
      return value.map((x) => (isScalar(x) ? String(x) : JSON.stringify(x))).join("\n");
    }
    const keys = [...new Set(value.flatMap(Object.keys))].filter((k) =>
      value.every((row) => isScalar(row[k])),
    );
    if (!keys.length) return value.map((x) => JSON.stringify(x)).join("\n");
    return table(
      value,
      keys.slice(0, 7).map((k) => [k.toUpperCase(), (row) => row[k]]),
      o,
    );
  }
  const entries = Object.entries(value).filter(
    ([k, v]) => k !== "ok" && v !== null && v !== undefined,
  );
  if (!entries.length) return "(nothing)";
  const width = Math.max(...entries.map(([k]) => k.length));
  const room = o.width ? Math.max(o.width - width - 2, 12) : Infinity;
  return entries
    .map(([k, v]) => {
      const text = isScalar(v) ? clean(v) : JSON.stringify(v);
      return `${k.padEnd(width)}  ${text.length > room ? `${text.slice(0, room - 1)}…` : text}`;
    })
    .join("\n");
}

const panes = (rows, o) =>
  table(
    rows,
    [
      ["", (p) => (p.active ? "*" : "")],
      ["LEAF", (p) => p.leafId, "right"],
      [
        "KIND",
        (p) =>
          p.agent ??
          (p.kind === "terminal" && p.ssh
            ? "ssh"
            : p.kind === "extension-panel"
              ? "panel"
              : p.kind),
      ],
      [
        "STATE",
        (p) =>
          p.kind === "terminal"
            ? p.running
              ? "running"
              : p.atPrompt
                ? "idle"
                : ""
            : p.kind === "editor"
              ? p.dirty
                ? "unsaved"
                : ""
              : (p.state ?? ""),
      ],
      ["TAB", (p) => p.tabTitle],
      ["WHERE", (p) => p.name || shortPath(p.cwd ?? p.path, o.home) || (p.title ?? p.extensionId)],
    ],
    o,
  );

/** The tails someone asked for, under the table that has no room for them. */
const withTails = (rows, o) =>
  [
    panes(rows, o),
    ...rows.filter((p) => p.tail).map((p) => `\n--- leaf ${p.leafId}\n${p.tail}`),
  ].join("\n");

const INSPECT = {
  commands: (rows) => (rows.length ? rows.join("\n") : "(none)"),
  extensions: (rows, o) =>
    table(
      rows,
      [
        ["", (e) => (e.enabled ? "on" : "off")],
        ["ID", (e) => e.id],
        ["VERSION", (e) => e.version],
        ["TOOLS", (e) => e.aiTools?.length ?? 0, "right"],
        ["CMDS", (e) => e.commands?.length ?? 0, "right"],
        ["NAME", (e) => e.name],
      ],
      o,
    ),
  workspaces: (rows, o) =>
    table(
      rows,
      [
        ["", (w) => (w.active ? "*" : "")],
        ["ID", (w) => w.id],
        ["VIEW", (w) => w.view],
        ["TABS", (w) => w.tabCount, "right"],
        ["NAME", (w) => w.name],
      ],
      o,
    ),
  status: (rows, o) =>
    table(
      rows,
      [
        ["EXTENSION", (s) => s.extensionId],
        ["SHOWS", (s) => s.label],
        ["WHAT", (s) => s.title],
      ],
      o,
    ),
  sessions: (v, o) =>
    [
      ...(v.errors ?? []).map(
        (e) => `could not read: ${typeof e === "string" ? e : JSON.stringify(e)}`,
      ),
    ]
      .concat(sessionTable(v, o))
      .join("\n"),
  logs: (rows) =>
    rows.length
      ? rows.map((l) => `${l.level}: ${l.text}`).join("\n")
      : "(nothing logged while this was listening)",
};

function sessionTable(v, o) {
  return table(
    v.sessions ?? [],
    [
      ["AGENT", (s) => s.agent],
      ["WHEN", (s) => (s.live ? "live" : ago(s.modifiedMs))],
      ["BRANCH", (s) => s.branch ?? ""],
      ["FOLDER", (s) => shortPath(s.cwd, o.home).split("/").pop()],
      ["ID", (s) => s.id],
      ["TITLE", (s) => s.title],
    ],
    o,
  );
}

const VIEWS = {
  panes: (v, _a, o) => (Array.isArray(v) ? withTails(v, o) : undefined),
  state: (v, _a, o) =>
    [
      `window ${v.window?.w}x${v.window?.h}, ${v.tabs?.length ?? 0} tabs, focus ${v.focusLeaf ?? "none"}` +
        `${v.dialog ? `, dialog ${v.dialog}` : ""}${v.toasts ? `, ${v.toasts} toasts` : ""}`,
      "",
      withTails(v.panes ?? [], o),
      ...(v.buttons?.length ? ["", "Buttons:", ...v.buttons] : []),
      ...(v.tediError ? ["", `Could not read the panes: ${v.tediError}`] : []),
    ].join("\n"),
  inspect: (v, a, o) => (INSPECT[a.what] ?? pretty)(v, o),
  read: (v, a) =>
    a.source === "editors"
      ? v.length
        ? v
            .map(
              (e) =>
                `--- leaf ${e.leafId}: ${e.path}${e.truncated ? " (truncated)" : ""}\n${e.text}`,
            )
            .join("\n\n")
        : "(no editor panes open)"
      : v.text,
  wait_for_terminal: (v) =>
    `leaf ${v.leafId}: ${v.done ? "done" : "NOT done"} (${v.reason})${v.tail ? `\n${v.tail}` : ""}`,
  sh: (v) => {
    if (v.typed) return `typed into leaf ${v.leafId} without running it`;
    return v.timedOut ? `${v.text}\n\n[leaf ${v.leafId}: still running after the timeout]` : v.text;
  },
  ssh: (v, a, o) =>
    a.action === "list"
      ? table(
          v,
          [
            ["NAME", (c) => c.name],
            ["ADDRESS", (c) => `${c.user}@${c.host}:${c.port}`],
            ["AUTH", (c) => c.authMode],
            ["ID", (c) => c.id],
          ],
          o,
        )
      : pretty(v, o),
  schedule: (v, a, o) => (a.action === "list" ? pretty(v?.schedules ?? v, o) : pretty(v, o)),
  ai: (v, a, o) => {
    if (a.action === "read") {
      return (v.messages ?? []).map((m) => `${m.role}: ${m.text}`).join("\n\n") || "(no messages)";
    }
    if (a.action !== "status") return pretty(v, o);
    const { sessions = [], ...rest } = v;
    const chats = table(
      sessions,
      [
        ["", (s) => (s.active ? "*" : "")],
        ["ID", (s) => s.id],
        ["WHEN", (s) => ago(s.updatedAt)],
        ["TITLE", (s) => s.title],
      ],
      o,
    );
    return `${pretty(rest, o)}\n\n${chats}`;
  },
};

/** A tool's answer for a person. `found` is what `resolveVerb` returned. */
export function humanize(found, args, value, o = {}) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return pretty(value);
  const view = VIEWS[found.verb] ?? VIEWS[found.tool];
  const text = view?.(value, args, o);
  // A view that got an answer it did not expect still owes the reader something readable.
  return typeof text === "string" ? text : pretty(value, o);
}
