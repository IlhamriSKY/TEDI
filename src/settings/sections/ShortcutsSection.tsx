import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Input } from "@/components/ui/input";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { DESTRUCTIVE_ACTION } from "@/lib/toolbarButton";
import { cn } from "@/lib/utils";
import { commandsRegistry, keybindingsRegistry, useExtensionsStore } from "@/modules/extensions";
import { useRegistry } from "@/modules/extensions/useRegistry";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setExtensionShortcuts, setShortcuts } from "@/modules/settings/store";
import {
  canonicalKeyFromEvent,
  getBindingTokens,
  parseKeybindingString,
  SHORTCUTS,
  SHORTCUT_GROUPS,
  type KeyBinding,
  type Shortcut,
  type ShortcutId,
} from "@/modules/shortcuts/shortcuts";
import { useEffect, useRef, useState, useMemo } from "react";
import { SectionHeader } from "../components/SectionHeader";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { CornerUpLeft, Search, Trash2 } from "lucide-react";

/** Stable identity for a chord, so two bindings can be compared. */
function chordKey(b: KeyBinding): string {
  return [b.ctrl && "ctrl", b.shift && "shift", b.alt && "alt", b.meta && "meta"]
    .filter(Boolean)
    .concat(b.key.toLowerCase())
    .join("+");
}

/**
 * Every action that claims each chord, across the core catalog and every
 * extension keybinding, with the user's overrides applied to both.
 *
 * Rebinding had no feedback at all, so a user could hand the same chord to two
 * actions and only find out that one of them stopped working. At runtime core
 * wins a chord an extension also wants (`coreShortcutFor`), and among two core
 * actions the first in `SHORTCUTS` wins, so the loser is always silent.
 */
function chordOwners(
  userShortcuts: Partial<Record<ShortcutId, KeyBinding[]>>,
  extBindings: { extensionId: string; item: { command?: string; key?: string } }[],
  extOverrides: Record<string, KeyBinding[]>,
): Map<string, { id: string; label: string }[]> {
  const owners = new Map<string, { id: string; label: string }[]>();
  const add = (b: KeyBinding | null, id: string, label: string) => {
    if (!b) return;
    const k = chordKey(b);
    owners.set(k, [...(owners.get(k) ?? []), { id, label }]);
  };
  for (const s of SHORTCUTS) {
    for (const b of userShortcuts[s.id] ?? s.defaultBindings) add(b, s.id, s.label);
  }
  for (const { extensionId, item } of extBindings) {
    const id = item.command;
    if (!id) continue;
    const bindings = extOverrides[id] ?? (item.key ? [parseKeybindingString(item.key)] : []);
    for (const b of bindings) add(b, id, extensionId);
  }
  return owners;
}

export function ShortcutsSection() {
  const userShortcuts = usePreferencesStore((s) => s.shortcuts);
  const extKeybindings = useRegistry(keybindingsRegistry);
  const extOverrides = usePreferencesStore((s) => s.extensionShortcuts);
  const [search, setSearch] = useState("");
  const [recordingId, setRecordingId] = useState<ShortcutId | null>(null);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);

  const filteredShortcuts = useMemo(() => {
    // Filter out non-overridable shortcuts like tab.selectByIndex.
    const base = SHORTCUTS.filter((s) => s.id !== "tab.selectByIndex");
    if (!search) return base;
    const lower = search.toLowerCase();
    return base.filter(
      (s) => s.label.toLowerCase().includes(lower) || s.group.toLowerCase().includes(lower),
    );
  }, [search]);

  // Recomputed per render: 43 catalog entries plus a handful of extension
  // bindings, and it has to follow both the overrides and a live install.
  const owners = chordOwners(userShortcuts, extKeybindings, extOverrides);

  const onRecord = (id: ShortcutId, binding: KeyBinding) => {
    const next = { ...userShortcuts, [id]: [binding] };
    void setShortcuts(next);
    setRecordingId(null);
  };

  const onClear = (id: ShortcutId) => {
    const next = { ...userShortcuts, [id]: [] };
    void setShortcuts(next);
  };

  const onResetShortcut = (id: ShortcutId) => {
    const next = { ...userShortcuts };
    delete next[id];
    void setShortcuts(next);
  };

  const onResetAll = () => {
    void setShortcuts({});
    setResetDialogOpen(false);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <SectionHeader title="Shortcuts" description="View and customize keyboard shortcuts." />
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 px-2.5 text-[11px]"
          onClick={() => setResetDialogOpen(true)}
        >
          <CornerUpLeft size={12} strokeWidth={2} />
          Reset All
        </Button>
      </div>

      <div className="relative">
        <Search
          size={14}
          strokeWidth={2}
          className="text-muted-foreground absolute top-1/2 left-3 -translate-y-1/2"
        />
        <Input
          placeholder="Search shortcuts..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-9 pl-9 text-[12.5px]"
        />
      </div>

      <div className="flex flex-col gap-8">
        <ExtensionShortcutsGroup search={search} owners={owners} />
        {SHORTCUT_GROUPS.map((group) => {
          const items = filteredShortcuts.filter((s) => s.group === group);
          if (items.length === 0) return null;

          return (
            <div key={group} className="flex flex-col gap-3">
              <h3 className="text-muted-foreground text-[11px] font-semibold tracking-wider uppercase">
                {group}
              </h3>
              <div className="divide-border/40 border-border/60 bg-card/40 flex flex-col divide-y overflow-hidden rounded-lg border">
                {items.map((s) => (
                  <ShortcutRow
                    key={s.id}
                    shortcut={s}
                    isRecording={recordingId === s.id}
                    onStartRecording={() => setRecordingId(s.id)}
                    onStopRecording={() => setRecordingId(null)}
                    onRecord={(b) => onRecord(s.id, b)}
                    onClear={() => onClear(s.id)}
                    onReset={() => onResetShortcut(s.id)}
                    userBindings={userShortcuts[s.id]}
                    owners={owners}
                    ownerId={s.id}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <AlertDialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset all shortcuts?</AlertDialogTitle>
            <AlertDialogDescription>
              This will revert all your custom keyboard shortcuts to their factory defaults. This
              action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={onResetAll}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Reset All
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ShortcutRow({
  shortcut,
  isRecording,
  onStartRecording,
  onStopRecording,
  onRecord,
  onClear,
  onReset,
  userBindings,
  owners,
  ownerId,
}: {
  shortcut: Shortcut;
  isRecording: boolean;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onRecord: (b: KeyBinding) => void;
  onClear: () => void;
  onReset: () => void;
  userBindings?: KeyBinding[];
  owners: Map<string, { id: string; label: string }[]>;
  /** This row's own owner id, excluded from its own clash list. */
  ownerId: string;
}) {
  const bindings = userBindings !== undefined ? userBindings : shortcut.defaultBindings;
  const isModified = userBindings !== undefined;
  const hasBindings = bindings && bindings.length > 0;
  const isReadOnly = !!shortcut.readOnly;
  // Anything else on this chord. Excluded by id, so a shortcut that lists the
  // same chord twice (zoomIn's `Mod+=` and `Mod+Shift+=`) is not its own clash.
  const clash = hasBindings
    ? [
        ...new Set(
          (owners.get(chordKey(bindings[0])) ?? [])
            .filter((o) => o.id !== ownerId)
            .map((o) => o.label),
        ),
      ]
    : [];

  return (
    <div className="group hover:bg-muted/30 flex items-center justify-between px-3 py-2.5 transition-colors">
      <div className="flex flex-col gap-0.5">
        <span className="text-[12.5px] font-medium">{shortcut.label}</span>
        {isReadOnly ? (
          <span className="text-muted-foreground text-[10.5px]">Built-in. Not rebindable.</span>
        ) : null}
        {clash.length > 0 ? (
          <span className="text-destructive text-[10.5px]">
            Also used by {clash.join(", ")}
          </span>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        {isRecording && !isReadOnly ? (
          <Recorder onRecord={onRecord} onCancel={onStopRecording} />
        ) : (
          <>
            <div
              role={isReadOnly ? undefined : "button"}
              tabIndex={isReadOnly ? undefined : 0}
              onClick={isReadOnly ? undefined : onStartRecording}
              onKeyDown={
                isReadOnly
                  ? undefined
                  : (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onStartRecording();
                      }
                    }
              }
              className={
                isReadOnly
                  ? "flex min-w-[100px] items-center justify-end gap-1"
                  : "flex min-w-[100px] cursor-pointer items-center justify-end gap-1"
              }
            >
              {hasBindings ? (
                <KbdGroup>
                  {getBindingTokens(bindings[0]).map((t, i) => (
                    <Kbd
                      key={i}
                      className={
                        isReadOnly
                          ? "opacity-80"
                          : "group-hover:bg-accent group-hover:text-accent-foreground transition-colors"
                      }
                    >
                      {t}
                    </Kbd>
                  ))}
                </KbdGroup>
              ) : (
                <span className="text-muted-foreground text-[11px] italic">Unassigned</span>
              )}
            </div>

            {isReadOnly ? null : (
              <div className="flex items-center gap-1">
                {isModified && (
                  <IconTooltip label="Reset to default" side="left">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-foreground size-7"
                      onClick={onReset}
                      aria-label="Reset to default"
                    >
                      <CornerUpLeft size={12} />
                    </Button>
                  </IconTooltip>
                )}
                <IconTooltip label="Clear shortcut" side="left">
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      DESTRUCTIVE_ACTION,
                      "size-7 opacity-0 transition-opacity group-hover:opacity-100",
                    )}
                    onClick={onClear}
                    aria-label="Clear shortcut"
                  >
                    <Trash2 size={12} />
                  </Button>
                </IconTooltip>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Recorder({
  onRecord,
  onCancel,
}: {
  onRecord: (b: KeyBinding) => void;
  onCancel: () => void;
}) {
  const onRecordRef = useRef(onRecord);
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    onRecordRef.current = onRecord;
    onCancelRef.current = onCancel;
  });

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        onCancelRef.current();
        return;
      }

      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;

      // Require at least one primary modifier (Ctrl, Alt, Meta). Reject
      // Shift-only shortcuts that would insert a character.
      const hasPrimaryModifier = e.ctrlKey || e.altKey || e.metaKey;
      const isCharacterKey = e.key.length === 1; // anything that types a glyph
      // Blocks shortcuts like Shift+2 ("@") and Shift+, ("<") on many layouts.
      if (!hasPrimaryModifier && (!e.shiftKey || isCharacterKey)) {
        return;
      }
      // Record the canonical, layout-independent key. Option+Z on macOS or
      // Ctrl+T on a Cyrillic layout would otherwise store the glyph and never re-fire.
      onRecordRef.current({
        key: canonicalKeyFromEvent(e),
        ctrl: e.ctrlKey,
        shift: e.shiftKey,
        alt: e.altKey,
        meta: e.metaKey,
      });
    };

    window.addEventListener("keydown", onDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onDown, { capture: true });
    };
  }, []);

  return (
    <div className="bg-accent/50 ring-accent flex items-center gap-2 rounded px-2 py-1 text-[11px] ring-1">
      <span className="animate-pulse font-medium">Recording…</span>
      <span className="text-muted-foreground">(Esc to cancel)</span>
    </div>
  );
}

/**
 * Renders one row per `keybindingsRegistry` entry. Row, recorder, and
 * persistence to `preferences.extensionShortcuts` are generic. Hidden when
 * no extension contributes shortcuts.
 */
function ExtensionShortcutsGroup({
  search,
  owners,
}: {
  search: string;
  owners: Map<string, { id: string; label: string }[]>;
}) {
  const keybindingEntries = useRegistry(keybindingsRegistry);
  const commandEntries = useRegistry(commandsRegistry);
  const extensions = useExtensionsStore((s) => s.list);
  const userOverrides = usePreferencesStore((s) => s.extensionShortcuts);
  const [recordingId, setRecordingId] = useState<string | null>(null);

  const rows = useMemo(() => {
    const lower = search.trim().toLowerCase();
    return keybindingEntries.flatMap(({ extensionId, item }) => {
      const command = commandEntries.find(
        (c) => c.extensionId === extensionId && c.item.id === item.command,
      );
      const ext = extensions.find((e) => e.id === extensionId);
      const title = command?.item.title ?? item.command;
      const extName = ext?.manifest.name ?? extensionId;
      if (
        lower.length > 0 &&
        !title.toLowerCase().includes(lower) &&
        !extName.toLowerCase().includes(lower)
      ) {
        return [];
      }
      const defaultBinding = parseKeybindingString(item.key);
      return [
        {
          // Composite key in case two extensions share a command id.
          rowId: `${extensionId}:${item.command}`,
          extensionId,
          commandId: item.command,
          title,
          extName,
          defaultBinding,
        },
      ];
    });
  }, [keybindingEntries, commandEntries, extensions, search]);

  if (rows.length === 0) return null;

  const writeOverrides = (next: Record<string, KeyBinding[]>): void => {
    void setExtensionShortcuts(next);
  };

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-muted-foreground text-[11px] font-semibold tracking-wider uppercase">
        Extensions
      </h3>
      <div className="divide-border/40 border-border/60 bg-card/40 flex flex-col divide-y overflow-hidden rounded-lg border">
        {rows.map((row) => {
          const userBindings = userOverrides[row.commandId];
          const effective = userBindings ?? (row.defaultBinding ? [row.defaultBinding] : []);
          const isModified = userBindings !== undefined;
          const isRecording = recordingId === row.rowId;
          // Reuse ShortcutRow with a synthetic Shortcut. The row only reads label, defaultBindings, and readOnly.
          const fakeShortcut: Shortcut = {
            id: row.rowId as ShortcutId, // typing only; never compared
            label: `${row.extName} · ${row.title}`,
            group: "General",
            defaultBindings: row.defaultBinding ? [row.defaultBinding] : [],
          };
          return (
            <ShortcutRow
              key={row.rowId}
              shortcut={fakeShortcut}
              isRecording={isRecording}
              onStartRecording={() => setRecordingId(row.rowId)}
              onStopRecording={() => setRecordingId(null)}
              onRecord={(b) => {
                writeOverrides({ ...userOverrides, [row.commandId]: [b] });
                setRecordingId(null);
              }}
              onClear={() => writeOverrides({ ...userOverrides, [row.commandId]: [] })}
              onReset={() => {
                const next = { ...userOverrides };
                delete next[row.commandId];
                writeOverrides(next);
              }}
              userBindings={isModified ? effective : undefined}
              owners={owners}
              ownerId={row.commandId}
            />
          );
        })}
      </div>
    </div>
  );
}
