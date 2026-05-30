import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Index of the last element matching `pred`, or -1. Hand-rolled because the
 *  native `Array.prototype.findLastIndex` needs ES2023 and the lib target is
 *  ES2022. */
export function findLastIndex<T>(arr: readonly T[], pred: (x: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}
