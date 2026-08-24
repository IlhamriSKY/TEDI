/** Human-readable byte size: `n B` / `x.x KB` / `x.x MB` / `x.x GB`
 *  (1024-based). GB matters for SFTP transfers, where "4300.2 MB" is not a
 *  size anyone reads at a glance. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
