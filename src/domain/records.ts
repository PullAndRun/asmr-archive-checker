import { formatWorkId, normalizeWorkCode, workCodeOf, type WorkCode, type WorkReference } from "./work-code.ts";

export type IncompleteArchive = WorkReference & {
  archivePath: string;
  missingFiles: string[];
  error?: string;
};

export type LocalWork = WorkReference & {
  path: string;
};

export type CodedLocalWork = LocalWork & {
  workCode: WorkCode;
};

export type NonAuthorWork = LocalWork & {
  type: "压缩包" | "文件夹";
};

export function sanitizeColumn(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\t\r\n]+/g, " ") : "";
}

export function parseDownloadQueue(text: string): Array<number | WorkCode> {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines[0] !== "作品ID\t原因\t来源") {
    throw new Error("待下载汇总格式无效，请重新运行 author 或 archives 模式");
  }
  const workCodes = lines.slice(1).flatMap((line) => {
    const columns = line.split("\t");
    if (columns.length !== 3) throw new Error(`待下载汇总中存在无效记录：${line}`);
    const value = columns[0].trim();
    const workCode = normalizeWorkCode(value);
    if (!workCode) throw new Error(`待下载汇总中存在无效作品编号：${value}`);
    return [workCode];
  });
  return [...new Set(workCodes)].map((workCode) =>
    workCode.startsWith("RJ") ? Number(workCode.slice(2)) : workCode
  );
}

/** Remove a completed work from a legacy download queue while preserving its format. */
export function removeDownloadQueueEntry(text: string, completed: string | number): string {
  const completedCode = typeof completed === "number" ? formatWorkId(completed) : normalizeWorkCode(completed);
  if (!completedCode) throw new Error(`无法识别已完成的作品编号：${completed}`);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  parseDownloadQueue(text);
  const records = lines.slice(1);
  const remainingRecords = records.filter((line) => normalizeWorkCode(line.split("\t", 1)[0].trim()) !== completedCode);
  if (remainingRecords.length === records.length) return text;
  const remaining = [
    lines[0],
    ...remainingRecords,
  ];
  return `${remaining.join(newline)}${newline}`;
}

/** Remove a completed work from the legacy missing-work list. */
export function removeMissingWorkEntry(text: string, completed: string | number): string {
  const completedCode = typeof completed === "number" ? formatWorkId(completed) : normalizeWorkCode(completed);
  if (!completedCode) throw new Error(`无法识别已完成的作品编号：${completed}`);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) return text;
  const records = lines.slice(1);
  const remainingRecords = records.filter((line) => normalizeWorkCode(line.split("\t", 1)[0].trim()) !== completedCode);
  if (remainingRecords.length === records.length) return text;
  const remaining = [
    lines[0],
    ...remainingRecords,
  ];
  return `${remaining.join(newline)}${newline}`;
}

export function parseDeletionQueue(text: string): IncompleteArchive[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines[0] !== "作品ID\t压缩包路径") {
    throw new Error("待删除清单格式无效，请重新运行 author 或 archives 模式");
  }
  return lines.slice(1).map((line) => {
    const separator = line.indexOf("\t");
    if (separator < 0) throw new Error(`待删除清单中存在无效记录：${line}`);
    const workCode = normalizeWorkCode(line.slice(0, separator).trim());
    const archivePath = line.slice(separator + 1).trim();
    if (!workCode || !archivePath) throw new Error(`待删除清单中存在无效记录：${line}`);
    return {
      archivePath,
      workCode,
      ...(workCode.startsWith("RJ") ? { workId: Number(workCode.slice(2)) } : {}),
      missingFiles: ["来自检查结果"],
    };
  });
}

export function buildDeletionQueue(incomplete: IncompleteArchive[]): string {
  const lines = [
    "作品ID\t压缩包路径",
    ...incomplete
      .filter((item) => !item.error && item.missingFiles.length > 0)
      .map((item) => `${workCodeOf(item)}\t${sanitizeColumn(item.archivePath)}`),
  ];
  return `${lines.join("\n")}\n`;
}

export function findNonAuthorWorks(
  authorWorkCodes: Iterable<string | number>,
  archives: LocalWork[],
  folders: LocalWork[],
): NonAuthorWork[] {
  const codeOf = (work: LocalWork): WorkCode => workCodeOf(work);
  const authorCodes = new Set([...authorWorkCodes].flatMap((value) => {
    const workCode = typeof value === "number" ? formatWorkId(value) : normalizeWorkCode(value);
    return workCode ? [workCode] : [];
  }));
  return [
    ...archives.map((archive) => ({ ...archive, type: "压缩包" as const })),
    ...folders.map((folder) => ({ ...folder, type: "文件夹" as const })),
  ]
    .filter((item) => !authorCodes.has(codeOf(item)))
    .toSorted((left, right) =>
      codeOf(left).localeCompare(codeOf(right)) ||
      (left.type === right.type ? 0 : left.type === "压缩包" ? -1 : 1) ||
      left.path.localeCompare(right.path)
    );
}

export function buildNonAuthorWorkList(works: NonAuthorWork[]): string {
  const lines = [
    "作品ID\t类型\t路径",
    ...works.map((work) => `${workCodeOf(work)}\t${work.type}\t${sanitizeColumn(work.path)}`),
  ];
  return `${lines.join("\n")}\n`;
}

export function parseNonAuthorWorkList(text: string): NonAuthorWork[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines[0] !== "作品ID\t类型\t路径") {
    throw new Error("非该作者作品清单格式无效，请重新运行 author 模式");
  }
  return lines.slice(1).map((line) => {
    const columns = line.split("\t");
    if (columns.length !== 3) throw new Error(`非该作者作品清单中存在无效记录：${line}`);
    const [displayId, type, targetPath] = columns.map((column) => column.trim());
    const workCode = normalizeWorkCode(displayId);
    if (!workCode || (type !== "压缩包" && type !== "文件夹") || !targetPath) {
      throw new Error(`非该作者作品清单中存在无效记录：${line}`);
    }
    return { path: targetPath, workCode, type };
  });
}
