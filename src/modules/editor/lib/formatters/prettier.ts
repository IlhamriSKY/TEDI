/**
 * Prettier standalone wrapper.
 *
 * Prettier and its plugins are dynamic-imported on first use so the editor
 * bundle stays lean for users who don't format. Once loaded, the
 * standalone module and the plugins for a parser are cached for the
 * session — repeated formats of the same language pay no import cost.
 *
 * Project config resolution (in order of precedence, last wins):
 *
 *   1. Bundled defaults (mirror this repo's `.prettierrc.json`).
 *   2. `.editorconfig` walked up from the file's directory (only the keys
 *      we can map to Prettier options — see `editorConfig.ts`).
 *   3. `.prettierrc` / `.prettierrc.json` / `.prettierrc.json5` /
 *      `package.json#prettier` walked up from the file's directory
 *      (see `projectConfig.ts`).
 *
 * Per-extension overrides we hard-code for Markdown / JSON exist as a
 * last safety net when the project ships no config; project config
 * always beats them.
 *
 * Not supported in built-in mode: `.prettierrc.{js,cjs,mjs}` and
 * `.prettierrc.{yaml,yml}`. Users with those configs should switch the
 * language's type to `external` with `prettier --stdin-filepath ${file}`
 * which respects every flavour natively.
 */

import { resolveEditorConfig } from "./editorConfig";
import { resolvePrettierConfig } from "./projectConfig";

type Plugin = unknown;
type PrettierStandalone = {
  format(source: string, options: PrettierOptions): Promise<string>;
};

type PrettierOptions = {
  filepath?: string;
  parser: string;
  plugins: Plugin[];
  semi?: boolean;
  singleQuote?: boolean;
  tabWidth?: number;
  useTabs?: boolean;
  printWidth?: number;
  trailingComma?: "all" | "none" | "es5";
  bracketSpacing?: boolean;
  bracketSameLine?: boolean;
  arrowParens?: "always" | "avoid";
  endOfLine?: "lf" | "crlf" | "auto" | "cr";
  proseWrap?: "always" | "never" | "preserve";
};

const PARSER_BY_LANGUAGE: Record<string, string> = {
  javascript: "babel",
  jsx: "babel",
  typescript: "typescript",
  tsx: "typescript",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  vue: "vue",
  yaml: "yaml",
  markdown: "markdown",
  graphql: "graphql",
};

/** Plugin modules each parser needs. `estree` is the shared printer for
 *  babel/typescript. */
const PLUGINS_BY_PARSER: Record<string, (() => Promise<Plugin>)[]> = {
  babel: [
    () => import("prettier/plugins/babel").then((m) => m.default ?? m),
    () => import("prettier/plugins/estree").then((m) => m.default ?? m),
  ],
  typescript: [
    () => import("prettier/plugins/typescript").then((m) => m.default ?? m),
    () => import("prettier/plugins/estree").then((m) => m.default ?? m),
  ],
  json: [
    () => import("prettier/plugins/babel").then((m) => m.default ?? m),
    // The `json` parser emits an estree AST, so standalone needs the estree
    // printer too — without it prettier.format throws "Couldn't find plugin
    // for AST format estree".
    () => import("prettier/plugins/estree").then((m) => m.default ?? m),
  ],
  css: [() => import("prettier/plugins/postcss").then((m) => m.default ?? m)],
  scss: [() => import("prettier/plugins/postcss").then((m) => m.default ?? m)],
  less: [() => import("prettier/plugins/postcss").then((m) => m.default ?? m)],
  html: [() => import("prettier/plugins/html").then((m) => m.default ?? m)],
  vue: [() => import("prettier/plugins/html").then((m) => m.default ?? m)],
  yaml: [() => import("prettier/plugins/yaml").then((m) => m.default ?? m)],
  markdown: [() => import("prettier/plugins/markdown").then((m) => m.default ?? m)],
  graphql: [() => import("prettier/plugins/graphql").then((m) => m.default ?? m)],
};

let standalonePromise: Promise<PrettierStandalone> | null = null;
const pluginCache = new Map<string, Promise<Plugin>>();
const pluginsForParserCache = new Map<string, Promise<Plugin[]>>();

function loadStandalone(): Promise<PrettierStandalone> {
  if (!standalonePromise) {
    standalonePromise = import("prettier/standalone").then(
      (m) => (m.default ?? m) as PrettierStandalone,
    );
  }
  return standalonePromise;
}

function loadPluginsFor(parser: string): Promise<Plugin[]> {
  let cached = pluginsForParserCache.get(parser);
  if (cached) return cached;
  const loaders = PLUGINS_BY_PARSER[parser];
  if (!loaders) {
    cached = Promise.reject(new Error(`prettier: no plugins registered for parser "${parser}"`));
    pluginsForParserCache.set(parser, cached);
    return cached;
  }
  cached = Promise.all(
    loaders.map((load, i) => {
      const key = `${parser}:${i}`;
      let p = pluginCache.get(key);
      if (!p) {
        p = load();
        pluginCache.set(key, p);
      }
      return p;
    }),
  );
  pluginsForParserCache.set(parser, cached);
  return cached;
}

export function prettierSupports(language: string): boolean {
  return language in PARSER_BY_LANGUAGE;
}

export async function formatWithPrettier(args: {
  language: string;
  content: string;
  filepath?: string;
}): Promise<string> {
  const parser = PARSER_BY_LANGUAGE[args.language];
  if (!parser) {
    throw new Error(`prettier does not support language "${args.language}"`);
  }
  const [prettier, plugins, editorConfig, projectConfig] = await Promise.all([
    loadStandalone(),
    loadPluginsFor(parser),
    args.filepath ? resolveEditorConfig(args.filepath) : Promise.resolve({}),
    args.filepath ? resolvePrettierConfig(args.filepath) : Promise.resolve(null),
  ]);

  // Defaults match the repo's `.prettierrc.json`. The per-extension
  // overrides below act as last-resort safety nets when the project has
  // no config; both `.editorconfig` and `.prettierrc` override them.
  const opts: PrettierOptions = {
    parser,
    plugins,
    filepath: args.filepath,
    semi: true,
    singleQuote: false,
    tabWidth: 2,
    useTabs: false,
    printWidth: 100,
    trailingComma: "all",
    bracketSpacing: true,
    bracketSameLine: false,
    arrowParens: "always",
    endOfLine: "lf",
  };
  if (args.language === "markdown") {
    opts.printWidth = 80;
    opts.proseWrap = "preserve";
  } else if (args.language === "json" || args.language === "jsonc") {
    opts.trailingComma = "none";
  }
  // Layer .editorconfig first (lower priority), then .prettierrc so the
  // explicit prettier config always wins. parser/plugins/filepath are
  // re-pinned at the bottom so a wayward project config can't clobber them.
  Object.assign(opts, editorConfig);
  if (projectConfig) Object.assign(opts, projectConfig);
  opts.parser = parser;
  opts.plugins = plugins;
  opts.filepath = args.filepath;
  return prettier.format(args.content, opts);
}
