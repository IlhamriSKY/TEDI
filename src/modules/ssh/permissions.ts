// Pure unix-mode helpers behind the SSH permissions dialog. They live outside
// the .tsx so `scripts/ssh-transfer-verify.ts` can import and exercise them
// without pulling React and Radix into a node process.

/** One permission class, and how far its three bits sit in the mode. */
export const PERMISSION_CLASSES = [
  { key: "owner", label: "Owner", shift: 6 },
  { key: "group", label: "Group", shift: 3 },
  { key: "other", label: "Other", shift: 0 },
] as const;

export const PERMISSION_BITS = [
  { key: "r", label: "Read", bit: 4 },
  { key: "w", label: "Write", bit: 2 },
  { key: "x", label: "Execute", bit: 1 },
] as const;

export const SPECIAL_BITS = [
  { label: "Set UID", bit: 0o4000, hint: "Executes as the file's owner" },
  { label: "Set GID", bit: 0o2000, hint: "Executes as the file's group" },
  { label: "Sticky", bit: 0o1000, hint: "Only an item's owner may delete it" },
] as const;

/**
 * `rwxr-sr-t` exactly as `ls -l` renders it, special bits included: a setuid
 * or sticky bit replaces the class's `x` with `s`/`t`, and uppercases it when
 * the execute bit underneath is off. Reading `rwSr--r--` and knowing it means
 * "setuid but not executable" is the whole point of showing the string.
 */
export function modeString(mode: number): string {
  const trio = (shift: number, specialBit: number, mark: string) => {
    const bits = (mode >> shift) & 7;
    const exec = (bits & 1) !== 0;
    const special = (mode & specialBit) !== 0;
    const third = special ? (exec ? mark : mark.toUpperCase()) : exec ? "x" : "-";
    return `${bits & 4 ? "r" : "-"}${bits & 2 ? "w" : "-"}${third}`;
  };
  return `${trio(6, 0o4000, "s")}${trio(3, 0o2000, "s")}${trio(0, 0o1000, "t")}`;
}

/** Four-digit octal, the form a chmod is normally typed in. */
export function octal(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, "0");
}

/** Parse typed octal, or null while the text is not (yet) a valid mode. Used
 *  to keep a half-typed "7" on the way to "755" from snapping to 0007. */
export function parseOctal(text: string): number | null {
  return /^[0-7]{1,4}$/.test(text) ? parseInt(text, 8) : null;
}
