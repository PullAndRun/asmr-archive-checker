import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDownloadFilePlan,
  buildDeletionPlan,
  buildDeletionQueue,
  buildNonAuthorDeletionPlan,
  buildSearchUrl,
  buildWorkSearchUrl,
  createRequestThrottle,
  deleteArchives,
  deleteNonAuthorWorks,
  downloadWorks,
  buildNonAuthorWorkList,
  findMissingFiles,
  findNonAuthorWorks,
  flattenTrackTree,
  formatFileSize,
  formatWorkId,
  hasReachedDownloadSizeLimit,
  isCompleteDownloadFile,
  parseArgs,
  parseDeletionQueue,
  parseDownloadQueue,
  parseFileSize,
  parseNonAuthorWorkList,
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
    expect(workIdFromArchiveName("RJ328352.7z")).toBe(328352);
    expect(workIdFromArchiveName("RJ00328352.7z")).toBe(328352);
    expect(workIdFromArchiveName("RJ1602072.7z")).toBe(1602072);
    expect(workIdFromArchiveName("作品-RJ01602072.7z")).toBe(1602072);
    expect(workIdFromArchiveName("no-id.7z")).toBeUndefined();
  });
});

describe("非该作者作品清单", () => {
  test("列出作者作品集合之外的压缩包和文件夹", () => {
    const works = findNonAuthorWorks(
      [1602072, 1616933],
      [
        { path: "D:/voice/RJ01602072.7z", workId: 1602072 },
        { path: "D:/voice/RJ02000000.7z", workId: 2000000 },
      ],
      [
        { path: "D:/download/RJ02000000", workId: 2000000 },
        { path: "D:/download/RJ03000000", workId: 3000000 },
      ],
    );

    expect(works).toEqual([
      { path: "D:/voice/RJ02000000.7z", workId: 2000000, type: "压缩包" },
      { path: "D:/download/RJ02000000", workId: 2000000, type: "文件夹" },
      { path: "D:/download/RJ03000000", workId: 3000000, type: "文件夹" },
    ]);
    expect(buildNonAuthorWorkList(works)).toBe([
      "作品ID\t类型\t路径",
      "RJ02000000\t压缩包\tD:/voice/RJ02000000.7z",
      "RJ02000000\t文件夹\tD:/download/RJ02000000",
      "RJ03000000\t文件夹\tD:/download/RJ03000000",
      "",
    ].join("\n"));
  });

  test("没有非该作者作品时仍生成带表头的空清单", () => {
    expect(buildNonAuthorWorkList([])).toBe("作品ID\t类型\t路径\n");
  });
});

describe("API 路径", () => {
  test("作者表达式被正确编码", () => {
    const url = buildSearchUrl("示例作者", 2, 20);
    expect(decodeURIComponent(new URL(url).pathname)).toBe("/api/search/ $va:示例作者$");
    expect(new URL(url).searchParams.get("page")).toBe("2");
  });

  test("作品编号按新旧格式精确搜索", () => {
    const oldUrl = buildWorkSearchUrl(328352);
    const newUrl = buildWorkSearchUrl(1602072);
    expect(decodeURIComponent(new URL(oldUrl).pathname)).toBe("/api/search/RJ328352");
    expect(decodeURIComponent(new URL(newUrl).pathname)).toBe("/api/search/RJ01602072");
    expect(formatWorkId(1)).toBe("RJ000001");
    expect(formatWorkId(328352)).toBe("RJ328352");
    expect(formatWorkId(999999)).toBe("RJ999999");
    expect(formatWorkId(1000000)).toBe("RJ01000000");
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
    expect(parseArgs(["delete"]).mode).toBe("delete");
    expect(parseArgs(["delete-non-author"]).mode).toBe("delete-non-author");
    expect(parseArgs(["download"]).mode).toBe("download");
  });

  test("支持临时设置下载体积限制", () => {
    expect(parseArgs(["download", "--max-download-size", "1.5 GB"])).toMatchObject({
      mode: "download",
      maxDownloadSize: "1.5 GB",
    });
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

  test("读取 author 和 archives 生成的待删除清单", () => {
    expect(parseDeletionQueue([
      "作品ID\t压缩包路径",
      "RJ01602072\tD:/voice/RJ01602072.7z",
      "",
    ].join("\n"))).toEqual([{
      archivePath: "D:/voice/RJ01602072.7z",
      workId: 1602072,
      missingFiles: ["来自检查结果"],
    }]);
    expect(() => parseDeletionQueue("D:/voice/RJ01602072.7z\n")).toThrow("重新运行 author 或 archives");
  });

  test("待删除清单排除检查失败项", () => {
    expect(buildDeletionQueue([
      { archivePath: "D:/voice/RJ01602072.7z", workId: 1602072, missingFiles: ["missing.wav"] },
      { archivePath: "D:/voice/RJ01616933.7z", workId: 1616933, missingFiles: [], error: "API 失败" },
    ])).toBe([
      "作品ID\t压缩包路径",
      "RJ01602072\tD:/voice/RJ01602072.7z",
      "",
    ].join("\n"));
  });

  test("旧制编号的不完整作品不生成不存在的八位编号", () => {
    expect(buildDeletionQueue([
      { archivePath: "D:/voice/RJ328352.7z", workId: 328352, missingFiles: ["missing.wav"] },
    ])).toBe([
      "作品ID\t压缩包路径",
      "RJ328352\tD:/voice/RJ328352.7z",
      "",
    ].join("\n"));
  });
});

describe("下载体积限制", () => {
  test("解析常用二进制体积单位", () => {
    expect(parseFileSize("512 MB")).toBe(512 * 1024 ** 2);
    expect(parseFileSize("1.5GiB")).toBe(1.5 * 1024 ** 3);
    expect(parseFileSize("2 TB")).toBe(2 * 1024 ** 4);
  });

  test("拒绝无单位、零值和未知单位", () => {
    expect(() => parseFileSize("100")).toThrow("请使用 B、KB、MB、GB 或 TB");
    expect(() => parseFileSize("0 GB")).toThrow("必须在");
    expect(() => parseFileSize("10 PB")).toThrow("请使用 B、KB、MB、GB 或 TB");
  });

  test("只在完成作品后累计值达到上限时停止", () => {
    const limit = parseFileSize("1 GB");
    expect(hasReachedDownloadSizeLimit(limit - 1, limit)).toBeFalse();
    expect(hasReachedDownloadSizeLimit(limit, limit)).toBeTrue();
    expect(hasReachedDownloadSizeLimit(limit + 1, limit)).toBeTrue();
    expect(hasReachedDownloadSizeLimit(limit + 1)).toBeFalse();
  });

  test("完成越过上限的当前作品后才停止后续队列", async () => {
    const started: number[] = [];
    const config = {
      author: "",
      archiveDir: ".",
      downloadDir: ".",
      outputDir: "./output",
      sevenZipPath: "7z",
      downloaderPath: "asmroner",
      concurrency: 1,
      requestTimeoutMs: 30_000,
      maxDownloadSize: "10 B",
      maxDownloadSizeBytes: 10,
    };
    const batch = await downloadWorks([1, 2, 3], config, async (workId) => {
      started.push(workId);
      return {
        workId,
        displayId: formatWorkId(workId),
        status: "downloaded",
        targetPath: `.\\${formatWorkId(workId)}`,
        size: 6,
      };
    });

    expect(started).toEqual([1, 2]);
    expect(batch.downloadedSize).toBe(12);
    expect(batch.stoppedByLimit).toBeTrue();
    expect(batch.remainingCount).toBe(1);
    expect(batch.results.map((result) => result.status)).toEqual(["downloaded", "downloaded"]);
  });
});

describe("API 请求", () => {
  test("按配置的 QPS 串行限制并发请求", async () => {
    const throttle = createRequestThrottle(20);
    const startedAt = performance.now();
    await Promise.all([throttle(), throttle(), throttle()]);
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(90);
  });
});

describe("删除不完整作品", () => {
  test("只规划确认不完整且位于归档目录内的 7z", async () => {
    const root = await mkdtemp(join(tmpdir(), "asmr-archive-delete-test-"));
    try {
      const archivePath = join(root, "RJ00000001.7z");
      await Bun.write(archivePath, "incomplete archive");
      const plan = await buildDeletionPlan([
        { archivePath, workId: 1, missingFiles: ["missing.wav"] },
        { archivePath: join(root, "RJ00000002.7z"), workId: 2, missingFiles: [], error: "API 失败" },
      ], root);
      expect(plan).toEqual([{ archivePath, workId: 1, size: 18 }]);
      expect(formatFileSize(plan[0].size)).toBe("18 B");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("删除计划中的文件", async () => {
    const root = await mkdtemp(join(tmpdir(), "asmr-archive-delete-test-"));
    try {
      const archivePath = join(root, "RJ00000001.7z");
      await Bun.write(archivePath, "x".repeat(2048));
      const plan = await buildDeletionPlan([
        { archivePath, workId: 1, missingFiles: ["missing.wav"] },
      ], root);
      expect(formatFileSize(plan[0].size)).toBe("2.00 KB");
      expect(await deleteArchives(plan)).toEqual([]);
      expect(await Bun.file(archivePath).exists()).toBeFalse();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("拒绝规划归档目录之外的文件", async () => {
    const root = await mkdtemp(join(tmpdir(), "asmr-archive-delete-root-"));
    const outside = await mkdtemp(join(tmpdir(), "asmr-archive-delete-outside-"));
    try {
      const archivePath = join(outside, "RJ00000001.7z");
      await Bun.write(archivePath, "x");
      expect(buildDeletionPlan([
        { archivePath, workId: 1, missingFiles: ["missing.wav"] },
      ], root)).rejects.toThrow("archiveDir 之外");
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });
});

describe("删除非该作者作品", () => {
  test("读取 author 生成的非作者作品清单", () => {
    expect(parseNonAuthorWorkList([
      "作品ID\t类型\t路径",
      "RJ328352\t压缩包\tD:/voice/RJ328352.7z",
      "RJ01602072\t文件夹\tD:/download/RJ01602072",
      "",
    ].join("\n"))).toEqual([
      { path: "D:/voice/RJ328352.7z", workId: 328352, type: "压缩包" },
      { path: "D:/download/RJ01602072", workId: 1602072, type: "文件夹" },
    ]);
    expect(() => parseNonAuthorWorkList("作品ID\t路径\nRJ328352\tD:/voice/RJ328352.7z\n"))
      .toThrow("重新运行 author");
  });

  test("规划并删除归档目录和下载目录内的非作者作品", async () => {
    const root = await mkdtemp(join(tmpdir(), "asmr-archive-delete-non-author-test-"));
    const archiveRoot = join(root, "archives");
    const downloadRoot = join(root, "downloads");
    const archivePath = join(archiveRoot, "RJ328352.7z");
    const folderPath = join(downloadRoot, "RJ01602072");
    try {
      await Promise.all([mkdir(archiveRoot), mkdir(folderPath, { recursive: true })]);
      await Promise.all([
        Bun.write(archivePath, "archive"),
        Bun.write(join(folderPath, "track.wav"), "downloaded audio"),
      ]);
      const plan = await buildNonAuthorDeletionPlan([
        { path: archivePath, workId: 328352, type: "压缩包" },
        { path: folderPath, workId: 1602072, type: "文件夹" },
      ], archiveRoot, downloadRoot);

      expect(plan).toEqual([
        { path: archivePath, workId: 328352, type: "压缩包", size: 7 },
        { path: folderPath, workId: 1602072, type: "文件夹", size: 16 },
      ]);
      expect(await deleteNonAuthorWorks(plan)).toEqual([]);
      expect(await Bun.file(archivePath).exists()).toBeFalse();
      expect(await Bun.file(folderPath).exists()).toBeFalse();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("拒绝越界目标和清单中不一致的 RJ 编号", async () => {
    const root = await mkdtemp(join(tmpdir(), "asmr-archive-delete-non-author-root-"));
    const outside = await mkdtemp(join(tmpdir(), "asmr-archive-delete-non-author-outside-"));
    const outsidePath = join(outside, "RJ328352.7z");
    const insidePath = join(root, "RJ328352.7z");
    try {
      await Promise.all([Bun.write(outsidePath, "x"), Bun.write(insidePath, "x")]);
      expect(buildNonAuthorDeletionPlan([
        { path: outsidePath, workId: 328352, type: "压缩包" },
      ], root)).rejects.toThrow("允许目录之外");
      expect(buildNonAuthorDeletionPlan([
        { path: insidePath, workId: 123456, type: "压缩包" },
      ], root)).rejects.toThrow("RJ 编号与清单不一致");
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });
});
