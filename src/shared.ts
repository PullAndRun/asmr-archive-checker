import { isAbsolute, relative } from "node:path";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function containsPath(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`并发数必须是正整数，实际为 ${limit}`);
  }
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let next = 0;
  let hasFailure = false;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    while (!hasFailure && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        hasFailure = true;
        failure = error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (hasFailure) throw failure;
  return results;
}
