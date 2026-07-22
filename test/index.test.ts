import { describe, expect, test } from "bun:test";
import { isAbsolute, resolve } from "node:path";
import {
  buildDownloaderInvocation,
  buildSearchUrl,
  buildWorkSearchUrl,
  findMissingFiles,
  flattenTrackTree,
  formatWorkId,
  parseArgs,
  parseDownloadQueue,
  parseSevenZipListing,
  workIdFromArchiveName,
} from "../src/index.ts";

describe("下载器调用", () => {
  test("不将 Windows 绝对路径作为 -d 参数传给 asmroner", () => {
    const workingDirectory = resolve("test-project");
    const stagingPath = resolve(workingDirectory, "download", ".staging", "RJ01602072-test");
    const invocation = buildDownloaderInvocation("asmroner", "RJ01602072", stagingPath, workingDirectory);

    expect(invocation.cwd).toBe(workingDirectory);
    expect(invocation.command.slice(0, 4)).toEqual(["asmroner", "download", "RJ01602072", "-d"]);
    expect(isAbsolute(invocation.command[4])).toBe(false);
    expect(resolve(invocation.cwd, invocation.command[4])).toBe(stagingPath);
  });
});

describe("编号识别", () => {
  test("兼容有无前导零的 RJ 编号", () => {
    expect(workIdFromArchiveName("RJ1602072.7z")).toBe(1602072);
    expect(workIdFromArchiveName("作品-RJ01602072.7z")).toBe(1602072);
    expect(workIdFromArchiveName("no-id.7z")).toBeUndefined();
  });
});

describe("API 路径", () => {
  test("作者表达式被正确编码", () => {
    const url = buildSearchUrl("示例作者", 2, 20);
    expect(decodeURIComponent(new URL(url).pathname)).toBe("/api/search/ $va:示例作者$");
    expect(new URL(url).searchParams.get("page")).toBe("2");
  });

  test("作品编号使用八位 RJ 格式精确搜索", () => {
    const url = buildWorkSearchUrl(1602072);
    expect(decodeURIComponent(new URL(url).pathname)).toBe("/api/search/RJ01602072");
    expect(formatWorkId(1602072)).toBe("RJ01602072");
    expect(formatWorkId(1616933)).toBe("RJ01616933");
  });
});

describe("文件树和 7z 清单", () => {
  test("递归展开 API 文件树", () => {
    expect(flattenTrackTree([
      {
        type: "folder",
        title: "目录",
        children: [
          { type: "audio", title: "声音.wav" },
          { type: "folder", title: "空目录", children: [] },
        ],
      },
      { type: "image", title: "封面.jpg" },
    ])).toEqual(["目录/声音.wav", "封面.jpg"]);
  });

  test("解析技术模式清单并比较缺失文件", () => {
    const listing = `7-Zip\n\n----------\nPath = RJ01602072\\目录\nAttributes = D\n\nPath = RJ01602072\\目录\\声音.WAV\nAttributes = A\n\nPath = RJ01602072\\Read_me\\说明.png\nAttributes = A\n\n`;
    const entries = parseSevenZipListing(listing);
    expect(entries).toHaveLength(3);
    expect(findMissingFiles(entries, ["目录　/声音.wav", "Read me/说明.png", "目录/缺少.txt"], 1602072)).toEqual([
      "目录/缺少.txt",
    ]);
    expect(findMissingFiles(entries, ["甲/说明.png", "乙/说明.png"], 1602072)).toEqual(["乙/说明.png"]);
  });
});

describe("命令行参数", () => {
  test("支持配置覆盖", () => {
    expect(parseArgs(["--author", "甲", "--dir", "D:/voice", "--concurrency", "3"])).toMatchObject({
      author: "甲",
      archiveDir: "D:/voice",
      concurrency: 3,
    });
  });

  test("区分作者和全压缩包模式", () => {
    expect(parseArgs(["author"]).mode).toBe("author");
    expect(parseArgs(["archives"]).mode).toBe("archives");
    expect(parseArgs(["download"]).mode).toBe("download");
  });

  test("读取并去重待下载汇总", () => {
    expect(parseDownloadQueue([
      "作品ID\t原因\t来源",
      "RJ01602072\t不完整\tD:/RJ01602072.7z",
      "RJ01602072\t遗漏\t标题",
      "RJ01616933\t遗漏\t标题二",
      "",
    ].join("\n"))).toEqual([1602072, 1616933]);
  });
});
