import { tool } from "ai";
import { z } from "zod";
import { readSettings, writeSetting } from "@/modules/settings/preferences";
import { controlExtension, listExtensions } from "@/modules/extensions/store";

/**
 * TEDI's own configuration, for TEDI's own agent.
 *
 * These exist because of an asymmetry that was plainly backwards: the MCP server
 * let an OUTSIDE AI CLI read and change TEDI's settings and toggle its
 * extensions, while the agent living inside the app could do neither.
 *
 * WHY NOT JUST POINT THE BUILT-IN AGENT AT THE MCP SERVER? Because the MCP
 * server is a way IN from outside - it spawns node, attaches to the WebView2
 * DevTools socket, and evaluates JS in the page. For this agent that page is the
 * one it is already running in. Going through it would mean a subprocess and a
 * socket round trip to call a function in the same JS realm, it would only work
 * while the automation port is open (off by default), and a page target accepts
 * exactly ONE DevTools client - so the built-in agent would be competing for the
 * socket with the user's actual Claude Code session.
 *
 * So the transports stay separate and the DEFINITION is shared: both halves call
 * the same `readSettings` / `writeSetting` / `listExtensions` /
 * `controlExtension`. There is one implementation of each, and this file is a
 * schema over it, nothing more.
 *
 * TWO tools, not five, and the reason is the same one that shaped the MCP
 * surface: every schema here is sent on every turn. Read and write share a tool
 * because they share a subject - omit the value and it reads.
 */
export function buildTediTools() {
  return {
    tedi_settings: tool({
      description:
        "Read TEDI's own preferences, or change one. No `key`: returns every setting the app is " +
        "running on. With `key` + `value`: writes it, live. This is the only route - the Settings " +
        "page is a separate window. No API keys are here; those live in the OS keyring.",
      inputSchema: z.object({
        key: z.string().optional().describe("Omit to read everything."),
        value: z
          .unknown()
          .optional()
          .describe("Omit to read. Must match the preference's existing type."),
      }),
      // Reading is free; writing changes the user's app, so it goes through the
      // same approval gate as any other mutation.
      needsApproval: (input: { value?: unknown }) => input.value !== undefined,
      execute: async ({ key, value }) => {
        if (value === undefined) {
          const all = readSettings();
          return key ? { key, value: all[key] } : all;
        }
        if (!key) return { error: "a `value` needs a `key`" };
        const r = await writeSetting(key, value);
        return r === true ? { ok: true, key, value } : { error: r };
      },
    }),

    tedi_extensions: tool({
      description:
        "List installed TEDI extensions and what each contributes, or turn one on/off. No " +
        "`action`: lists them, enabled or not - a disabled extension and an absent one look " +
        "identical in the UI. With `action` + `id`: applies it. Installing is not available here; " +
        "it needs the user's permission review in Settings.",
      inputSchema: z.object({
        action: z.enum(["enable", "disable", "reload", "update", "uninstall"]).optional(),
        id: z.string().optional().describe("Required with `action`."),
      }),
      needsApproval: (input: { action?: string }) => input.action !== undefined,
      execute: async ({ action, id }) => {
        if (!action) return listExtensions();
        if (!id) return { error: "an `action` needs an `id`" };
        const r = await controlExtension(action, id);
        return r === true ? { ok: true, action, id } : { error: r };
      },
    }),
  };
}
