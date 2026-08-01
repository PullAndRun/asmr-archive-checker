import { basename, dirname, extname, join } from "node:path";
import { formatWorkId, normalizeWorkCode, workCodeFromArchiveName } from "./work-code.ts";

export type ArchiveEntry = {
  path: string;
  attributes: string;
};

export type TrackNode = {
  type?: string;
  title?: string;
  children?: TrackNode[];
  mediaDownloadUrl?: string;
  size?: number;
};

export type DownloadFile = {
  url: string;
  relativePath: string;
  size?: number;
};

const MAX_PATH_SEGMENT_BYTES = 180;
const textEncoder = new TextEncoder();

const utf8Length = (value: string): number => textEncoder.encode(value).byteLength;
const utf8RuneLength = (rune: string): number => {
  const codePoint = rune.codePointAt(0) ?? 0;
  return codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
};

const truncateUtf8 = (value: string, maximumBytes: number): string => {
  let result = "";
  let bytes = 0;
  for (const rune of value) {
    const runeBytes = utf8RuneLength(rune);
    if (bytes + runeBytes > maximumBytes) break;
    result += rune;
    bytes += runeBytes;
  }
  return result;
};

type ParentPath = { value: string; parent?: ParentPath };

const parentSegments = (parent?: ParentPath): string[] => {
  const segments: string[] = [];
  for (let current = parent; current; current = current.parent) segments.push(current.value);
  segments.reverse();
  return segments;
};

export function parseSevenZipListing(output: string): ArchiveEntry[] {
  const marker = /\r?\n-{10,}\r?\n/;
  const markerMatch = marker.exec(output);
  if (!markerMatch || markerMatch.index === undefined) {
    throw new Error("无法解析 7-Zip 文件清单");
  }
  const body = output.slice(markerMatch.index + markerMatch[0].length);
  return body.split(/\r?\n\r?\n/).flatMap((block) => {
    const fields = new Map(
      block.split(/\r?\n/).flatMap((line) => {
        const separator = line.indexOf(" = ");
        return separator < 0 ? [] : [[line.slice(0, separator), line.slice(separator + 3)] as const];
      }),
    );
    const path = fields.get("Path");
    return path ? [{ path, attributes: fields.get("Attributes") ?? "" }] : [];
  });
}

export function flattenTrackTree(nodes: TrackNode[]): string[] {
  const paths: string[] = [];
  const pending: Array<{ node: TrackNode; parent?: ParentPath }> = nodes.toReversed().map((node) => ({ node }));
  while (pending.length > 0) {
    const { node, parent } = pending.pop()!;
    if (!node || typeof node !== "object") continue;
    const title = typeof node.title === "string" ? node.title : "";
    if (Array.isArray(node.children)) {
      const nextParent = title ? { value: title, parent } : parent;
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        pending.push({ node: node.children[index], parent: nextParent });
      }
    } else if (title && node.type !== "folder") {
      paths.push([...parentSegments(parent), title].join("/"));
    }
  }
  return paths;
}

function normalizePath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .normalize("NFC")
    .split("/")
    .map((part) => part.trimEnd())
    .join("/");
}

export function sanitizeDownloadPathSegment(value: string): string {
  let sanitized = value
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[ .]+$/g, "");
  if (!sanitized || sanitized === "." || sanitized === "..") sanitized = "_";

  const stem = sanitized.split(".", 1)[0];
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) sanitized = `_${sanitized}`;

  if (utf8Length(sanitized) > MAX_PATH_SEGMENT_BYTES) {
    const extension = extname(sanitized);
    const extensionLength = utf8Length(extension);
    if (extensionLength >= MAX_PATH_SEGMENT_BYTES) {
      sanitized = truncateUtf8(sanitized, MAX_PATH_SEGMENT_BYTES).replace(/[ .]+$/g, "");
    } else {
      const name = basename(sanitized, extension);
      sanitized = `${truncateUtf8(name, MAX_PATH_SEGMENT_BYTES - extensionLength)}${extension}`;
    }
  }
  return sanitized;
}

function comparisonKey(path: string): string {
  return normalizePath(path)
    .split("/")
    .map(sanitizeDownloadPathSegment)
    .join("/")
    .toLowerCase();
}

function addCollisionSuffix(path: string, sequence: number): string {
  const directory = dirname(path);
  const extension = extname(path);
  const name = basename(path, extension);
  const suffix = ` (${sequence})`;
  const suffixLength = utf8Length(suffix);
  const keptExtension = truncateUtf8(extension, Math.max(0, MAX_PATH_SEGMENT_BYTES - suffixLength - 1));
  const nameLength = Math.max(1, MAX_PATH_SEGMENT_BYTES - suffixLength - utf8Length(keptExtension));
  const suffixed = `${truncateUtf8(name, nameLength)}${suffix}${keptExtension}`;
  return directory === "." ? suffixed : join(directory, suffixed);
}

export function buildDownloadFilePlan(nodes: TrackNode[]): DownloadFile[] {
  const files: DownloadFile[] = [];
  const pending: Array<{ node: TrackNode; parent?: ParentPath }> = nodes.toReversed().map((node) => ({ node }));
  while (pending.length > 0) {
    const { node, parent } = pending.pop()!;
    if (!node || typeof node !== "object") continue;
    const title = typeof node.title === "string" ? node.title : "";
    if (Array.isArray(node.children)) {
      const nextParent = title ? { value: sanitizeDownloadPathSegment(title), parent } : parent;
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        pending.push({ node: node.children[index], parent: nextParent });
      }
    } else if (title && typeof node.mediaDownloadUrl === "string" && node.mediaDownloadUrl) {
      files.push({
        url: node.mediaDownloadUrl,
        relativePath: join(parentSegments(parent).join("/"), sanitizeDownloadPathSegment(title)),
        ...(Number.isSafeInteger(node.size) && node.size! >= 0 ? { size: node.size } : {}),
      });
    }
  }

  const planned: DownloadFile[] = [];
  const used = new Set<string>();
  const nextCollisionSequence = new Map<string, number>();
  for (const file of files) {
    let relativePath = file.relativePath;
    const originalKey = comparisonKey(relativePath);
    let key = originalKey;
    let sequence = nextCollisionSequence.get(originalKey) ?? 2;
    while (used.has(key)) {
      relativePath = addCollisionSuffix(file.relativePath, sequence);
      sequence += 1;
      key = comparisonKey(relativePath);
    }
    nextCollisionSequence.set(originalKey, sequence);
    used.add(key);
    planned.push({ ...file, relativePath });
  }
  return planned;
}

function stripWorkRoot(path: string, work: number | string): string {
  const normalized = normalizePath(path);
  const separator = normalized.indexOf("/");
  if (separator < 0) return normalized;
  const firstCode = workCodeFromArchiveName(`${normalized.slice(0, separator)}.7z`);
  const workCode = typeof work === "number" ? formatWorkId(work) : normalizeWorkCode(work);
  return firstCode === workCode ? normalized.slice(separator + 1) : normalized;
}

export function findMissingFiles(
  archiveEntries: ArchiveEntry[],
  expectedPaths: string[],
  work: number | string,
): string[] {
  const actualPathCounts = new Map<string, number>();
  const actualNameCounts = new Map<string, number>();
  for (const entry of archiveEntries) {
    if (/(^|\s)D($|\s)/.test(entry.attributes)) continue;
    const normalized = stripWorkRoot(entry.path, work);
    const pathKey = comparisonKey(normalized);
    const nameKey = comparisonKey(normalized.split("/").at(-1) ?? normalized);
    actualPathCounts.set(pathKey, (actualPathCounts.get(pathKey) ?? 0) + 1);
    actualNameCounts.set(nameKey, (actualNameCounts.get(nameKey) ?? 0) + 1);
  }

  const unmatched = expectedPaths.map(normalizePath).filter((normalized) => {
    const pathKey = comparisonKey(normalized);
    const pathCount = actualPathCounts.get(pathKey) ?? 0;
    if (pathCount === 0) return true;
    actualPathCounts.set(pathKey, pathCount - 1);
    const nameKey = comparisonKey(normalized.split("/").at(-1) ?? normalized);
    actualNameCounts.set(nameKey, (actualNameCounts.get(nameKey) ?? 1) - 1);
    return false;
  });

  return unmatched.filter((expected) => {
    const nameKey = comparisonKey(expected.split("/").at(-1) ?? expected);
    const nameCount = actualNameCounts.get(nameKey) ?? 0;
    if (nameCount === 0) return true;
    actualNameCounts.set(nameKey, nameCount - 1);
    return false;
  });
}
