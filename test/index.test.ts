import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDownloadFilePlan,
  buildSearchUrl,
  buildWorkSearchUrl,
  findMissingFiles,
  flattenTrackTree,
  formatWorkId,
  isCompleteDownloadFile,
  parseArgs,
  parseDownloadQueue,
  parseSevenZipListing,
  prepareBuiltinStagingPath,
  sanitizeDownloadPathSegment,
  workIdFromArchiveName,
  writeResponseBodyToFile,
} from "../src/index.ts";

describe("下载器调用", () => {
  test("清理 Windows 非法文件名和保留扩展名", () => {
    expect(sanitizeDownloadPathSegment("04_リベンジ成功…?.wav")).toBe("04_リベンジ成功…_.wav");
    expect(sanitizeDownloadPathSegment("CON.txt")).toBe("_CON.txt");
    expect(sanitizeDownloadPathSegment("结尾. ")).toBe("结尾");
  });

  test("生成安全且不冲突的下载路径", () => {
    expect(buildDownloadFilePlan([
      {
        type: "folder",
        title: "文本:目录",
        children: [
          { type: "text", title: "问题?.txt", mediaDownloadUrl: "https://example.com/1" },
          { type: "text", title: "问题*.txt", mediaDownloadUrl: "https://example.com/2" },
        ],
      },
    ])).toEqual([
      { url: "https://example.com/1", relativePath: "文本_目录\\问题_.txt" },
      { url: "https://example.com/2", relativePath: "文本_目录\\问题_ (2).txt" },
    ]);
  });

  test("遵循 asmroner 的媒体格式偏好并保留非音频文件", () => {
    const files = buildDownloadFilePlan([
      { type: "audio", title: "声音.wav", mediaDownloadUrl: "https://example.com/wav" },
      { type: "audio", title: "声音.mp3", mediaDownloadUrl: "https://example.com/mp3" },
      { type: "image", title: "封面.jpg", mediaDownloadUrl: "https://example.com/jpg" },
    ], "mp3>wav>flac");
    expect(files.map((file) => file.relativePath)).toEqual(["声音.mp3", "封面.jpg"]);
  });

  test("只复用大小完整的已下载文件", () => {
    expect(isCompleteDownloadFile(1024, 1024)).toBeTrue();
    expect(isCompleteDownloadFile(512, 1024)).toBeFalse();
    expect(isCompleteDownloadFile(512)).toBeTrue();
  });

  test("复用旧版本中数据最多的随机临时目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "asmr-archive-checker-test-"));
    try {
      const smaller = join(root, "RJ00000001-small");
      const larger = join(root, "RJ00000001-large");
      await Promise.all([mkdir(smaller), mkdir(larger)]);
      await Promise.all([
        Bun.write(join(smaller, "file.txt"), "small"),
        Bun.write(join(larger, "file.txt"), "larger old download"),
      ]);

      const selected = await prepareBuiltinStagingPath(root, "RJ00000001");
      expect(selected).toBe(join(root, "RJ00000001"));
      expect(await Bun.file(join(selected, "file.txt")).text()).toBe("larger old download");
      expect(await prepareBuiltinStagingPath(root, "RJ00000001")).toBe(selected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("以分块流方式写入下载响应", async () => {
    const root = await mkdtemp(join(tmpdir(), "asmr-archive-checker-stream-test-"));
    try {
      const path = join(root, "response.bin");
      const controller = new AbortController();
      const response = new Response(new ReadableStream({
        start(stream) {
          stream.enqueue(new Uint8Array([1, 2, 3]));
          stream.enqueue(new Uint8Array([4, 5]));
          stream.close();
        },
      }));
      await writeResponseBodyToFile(response, path, controller, 1_000);
      expect([...new Uint8Array(await Bun.file(path).arrayBuffer())]).toEqual([1, 2, 3, 4, 5]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
