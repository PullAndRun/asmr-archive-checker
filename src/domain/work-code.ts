import { basename } from "node:path";

export type WorkCode = `${string}J${number}`;
export const MAX_RJ_ID = 99_999_999;

export type WorkMetadata = {
  id: number;
  source_id?: string;
};

export function formatWorkId(id: number): WorkCode {
  if (!Number.isSafeInteger(id) || id < 1 || id > MAX_RJ_ID) {
    throw new Error(`无效的 RJ 数字 ID：${id}`);
  }
  const digits = String(id);
  const prefix = digits.length === 7 ? "0" : "";
  return `RJ${prefix}${digits}` as WorkCode;
}

export function normalizeWorkCode(value: string): WorkCode | undefined {
  const match = value.trim().match(/^([A-Z]J)(\d+)$/i);
  if (!match) return undefined;
  const id = Number(match[2]);
  if (!Number.isSafeInteger(id) || id < 1) return undefined;
  const prefix = match[1].toUpperCase();
  if (prefix === "RJ" && id > MAX_RJ_ID) return undefined;
  const digits = String(id);
  const padding = digits.length === 7 ? "0" : "";
  return `${prefix}${padding}${digits}` as WorkCode;
}

export function workCodeFromMetadata(work: WorkMetadata): WorkCode {
  if (typeof work.source_id === "string" && work.source_id.trim()) {
    const sourceCode = normalizeWorkCode(work.source_id);
    if (!sourceCode) throw new Error(`API 返回了不支持的来源编号：${work.source_id}`);
    return sourceCode;
  }
  throw new Error(`API 没有返回内部 ID ${work.id} 的来源编号，无法确定作品前缀`);
}

export function workCodeFromArchiveName(path: string): WorkCode | undefined {
  const match = basename(path).match(/[A-Z]J\d+/i);
  return match ? normalizeWorkCode(match[0]) : undefined;
}

export function workIdFromArchiveName(path: string): number | undefined {
  const workCode = workCodeFromArchiveName(path);
  if (!workCode?.startsWith("RJ")) return undefined;
  return Number(workCode.slice(2));
}

export function workIdFromCode(workCode: WorkCode): number | undefined {
  return workCode.startsWith("RJ") ? Number(workCode.slice(2)) : undefined;
}

export type WorkReference =
  | { workCode: WorkCode; workId?: number }
  | { workCode?: undefined; workId: number };

export function workCodeOf(work: WorkReference): WorkCode {
  return work.workCode ?? formatWorkId(work.workId);
}
