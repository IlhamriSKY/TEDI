import { loadSchedules, newScheduleId, saveSchedules } from "./store";
import type {
  Schedule,
  ScheduleAction,
  TerminalInfo,
  TerminalTarget,
} from "../types";

/**
 * App glue the engine needs. App.tsx wires it once via `setSchedulerBridge`.
 * Defaults are no-ops so importing before wiring is safe.
 */
export type SchedulerBridge = {
  /** Snapshot of terminal leaves in tab order. */
  listTerminals: () => TerminalInfo[];
  /** Type `text` into a terminal without Enter. Returns false on failure. */
  injectIntoTerminal: (target: TerminalTarget, text: string) => boolean;
  /** Type and submit (CR) into a terminal. Returns false on failure. */
  runInTerminal: (target: TerminalTarget, command: string) => boolean;
  /** Short user-visible toast or status update. */
  notify: (message: string, level: "info" | "success" | "warning" | "error") => void;
};

const NOOP_BRIDGE: SchedulerBridge = {
  listTerminals: () => [],
  injectIntoTerminal: () => false,
  runInTerminal: () => false,
  notify: () => {},
};

type Listener = (schedules: Schedule[]) => void;

class SchedulerEngine {
  private schedules: Schedule[] = [];
  // Cached copy of `schedules`. Mutators reassign the array, so identity
  // comparison detects change. `useSyncExternalStore` needs a stable reference
  // between renders; returning a fresh array would loop. Don't expose the live
  // array directly so callers can't mutate engine state.
  private snapshotFor: Schedule[] | null = null;
  private snapshotCache: Schedule[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private bridge: SchedulerBridge = NOOP_BRIDGE;
  private listeners = new Set<Listener>();
  private booted = false;

  setBridge(bridge: SchedulerBridge): void {
    this.bridge = bridge;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => {
      this.listeners.delete(fn);
    };
  }

  getAll(): Schedule[] {
    return this.snapshot();
  }

  private snapshot(): Schedule[] {
    if (this.snapshotFor !== this.schedules) {
      this.snapshotCache = this.schedules.slice();
      this.snapshotFor = this.schedules;
    }
    return this.snapshotCache;
  }

  /** Idempotent boot. Loads persisted schedules, arms timers, fires past-due. */
  async boot(): Promise<void> {
    if (this.booted) return;
    this.booted = true;
    const loaded = await loadSchedules();
    this.schedules = loaded;
    const now = Date.now();
    for (const s of loaded) {
      if (s.status !== "pending") continue;
      // Past-due schedules wait 1.5s so terminals can mount and to bunch
      // multiple stale schedules.
      const delay = Math.max(0, s.fireAt - now);
      this.arm(s.id, delay > 0 ? delay : 1500);
    }
    this.emit();
  }

  /** Schedules a deferred command. */
  async create(input: {
    fireAt: number;
    command: string;
    action: ScheduleAction;
    target: TerminalTarget;
    label?: string;
  }): Promise<Schedule> {
    const schedule: Schedule = {
      id: newScheduleId(),
      fireAt: input.fireAt,
      command: input.command,
      action: input.action,
      target: input.target,
      label: input.label,
      createdAt: Date.now(),
      status: "pending",
    };
    this.schedules = [...this.schedules, schedule];
    await this.persist();
    const delay = Math.max(0, schedule.fireAt - Date.now());
    this.arm(schedule.id, delay);
    this.emit();
    return schedule;
  }

  async cancel(id: string): Promise<boolean> {
    const idx = this.schedules.findIndex((s) => s.id === id);
    if (idx < 0) return false;
    const cur = this.schedules[idx];
    if (cur.status !== "pending") return false;
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    const updated: Schedule = { ...cur, status: "cancelled" };
    this.schedules = [
      ...this.schedules.slice(0, idx),
      updated,
      ...this.schedules.slice(idx + 1),
    ];
    await this.persist();
    this.emit();
    return true;
  }

  /** Drops completed/cancelled rows older than `maxAgeMs`. */
  async pruneHistory(maxAgeMs = 30 * 60_000): Promise<void> {
    const now = Date.now();
    const next = this.schedules.filter((s) => {
      if (s.status === "pending") return true;
      const at = s.firedAt ?? s.createdAt;
      return now - at < maxAgeMs;
    });
    if (next.length === this.schedules.length) return;
    this.schedules = next;
    await this.persist();
    this.emit();
  }

  private arm(id: string, delayMs: number): void {
    const existing = this.timers.get(id);
    if (existing) clearTimeout(existing);
    // setTimeout caps at ~24.8 days (i32 ms); longer values coerce to 1ms. Clamp and re-arm.
    const MAX_DELAY = 2_147_000_000;
    if (delayMs > MAX_DELAY) {
      const t = setTimeout(() => this.arm(id, delayMs - MAX_DELAY), MAX_DELAY);
      this.timers.set(id, t);
      return;
    }
    const t = setTimeout(() => {
      this.timers.delete(id);
      void this.fire(id);
    }, delayMs);
    this.timers.set(id, t);
  }

  private async fire(id: string): Promise<void> {
    const idx = this.schedules.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const cur = this.schedules[idx];
    if (cur.status !== "pending") return;
    let ok = false;
    let error: string | undefined;
    try {
      if (cur.action === "submit") {
        ok = this.bridge.runInTerminal(cur.target, cur.command);
      } else {
        ok = this.bridge.injectIntoTerminal(cur.target, cur.command);
      }
      if (!ok) error = "no matching terminal";
    } catch (e) {
      ok = false;
      error = e instanceof Error ? e.message : String(e);
    }
    const updated: Schedule = {
      ...cur,
      status: ok ? "fired" : "failed",
      firedAt: Date.now(),
      error,
    };
    this.schedules = [
      ...this.schedules.slice(0, idx),
      updated,
      ...this.schedules.slice(idx + 1),
    ];
    await this.persist();
    this.emit();
    const label = cur.label ?? truncate(cur.command, 60);
    if (ok) {
      this.bridge.notify(`Scheduled command sent: ${label}`, "success");
    } else {
      this.bridge.notify(`Schedule failed: ${error ?? "unknown error"}`, "error");
    }
  }

  private async persist(): Promise<void> {
    await saveSchedules(this.schedules);
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const l of this.listeners) l(snap);
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** One engine per process. */
export const scheduler = new SchedulerEngine();

export function setSchedulerBridge(bridge: SchedulerBridge): void {
  scheduler.setBridge(bridge);
}
