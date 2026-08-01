export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "未知";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const nextUnit of units) {
    value /= 1024;
    unit = nextUnit;
    if (value < 1024 || nextUnit === units.at(-1)) break;
  }
  return `${value.toFixed(2)} ${unit}`;
}

export function parseFileSize(value: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(B|K(?:I)?B|M(?:I)?B|G(?:I)?B|T(?:I)?B)$/i);
  if (!match) {
    throw new Error(`无法识别下载体积“${value}”；请使用 B、KB、MB、GB 或 TB，例如 100 GB`);
  }
  const powers: Record<string, number> = {
    B: 0, KB: 1, KIB: 1, MB: 2, MIB: 2, GB: 3, GIB: 3, TB: 4, TIB: 4,
  };
  const bytes = Number(match[1]) * 1024 ** powers[match[2].toUpperCase()];
  if (!Number.isFinite(bytes) || bytes < 1 || bytes > Number.MAX_SAFE_INTEGER) {
    throw new Error(`下载体积必须在 1 B 到 ${Number.MAX_SAFE_INTEGER} B 之间`);
  }
  return Math.floor(bytes);
}

export function hasReachedDownloadSizeLimit(downloadedSize: number, maxDownloadSize?: number): boolean {
  return maxDownloadSize !== undefined && downloadedSize >= maxDownloadSize;
}
