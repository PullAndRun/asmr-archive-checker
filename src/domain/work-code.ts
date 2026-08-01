import { basename } from "node:path";

export type WorkCode = `RJ${number}` | `BJ${number}`;
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
  const match = value.trim().match(/^(RJ|BJ)(\d+)$/i);
  if (!match) return undefined;
  const id = Number(match[2]);
  if (!Number.isSafeInteger(id) || id < 1) return undefined;
  return match[1].toUpperCase() === "RJ"
    ? id <= MAX_RJ_ID ? formatWorkId(id) : undefined
    : `BJ${id}` as WorkCode;
}

export function workCodeFromMetadata(work: WorkMetadata): WorkCode {
  if (typeof work.source_id === "string" && work.source_id.trim()) {
    const sourceCode = normalizeWorkCode(work.source_id);
    if (!sourceCode) throw new Error(`API 返回了不支持的来源编号：${work.source_id}`);
    return sourceCode;
  }
  return formatWorkId(work.id);
}

export function workCodeFromArchiveName(path: string): WorkCode | undefined {
  const match = basename(path).match(/(?:RJ|BJ)\d+/i);
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
