/**
 * Small pure formatting helpers, kept dependency-free so they can be unit
 * tested (and reused) without pulling the Tauri download stack along.
 */

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatSpeed(bps: number): string {
  return `${formatBytes(bps)}/s`;
}

export function formatEta(secs: number): string {
  if (!secs || !isFinite(secs) || secs <= 0) return '';
  if (secs < 60) return `${Math.ceil(secs)}s left`;
  const m = Math.floor(secs / 60);
  const s = Math.ceil(secs % 60);
  if (m < 60) return `${m}m ${s}s left`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m left`;
}
