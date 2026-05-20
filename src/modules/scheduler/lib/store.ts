import { LazyStore } from "@tauri-apps/plugin-store";
import type { Schedule } from "../types";

const STORE_PATH = "tedi-schedules.json";
const KEY_SCHEDULES = "schedules";

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

export async function loadSchedules(): Promise<Schedule[]> {
  const list = (await store.get<Schedule[]>(KEY_SCHEDULES)) ?? [];
  return Array.isArray(list) ? list : [];
}

export async function saveSchedules(items: Schedule[]): Promise<void> {
  await store.set(KEY_SCHEDULES, items);
}

export function newScheduleId(): string {
  return `sch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
