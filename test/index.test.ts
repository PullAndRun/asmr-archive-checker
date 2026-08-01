import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  ensureSafeDownloadDirectory,
  buildNonAuthorWorkList,
  findMissingFiles,
  findNonAuthorWorks,
  findArchives,
  findDownloadedWorkFolders,
  fetchJson,
  flattenTrackTree,
  formatFileSize,
  formatWorkId,
  hasReachedDownloadSizeLimit,
  isCompleteDownloadFile,
  httpErrorFromResponse,
  isRetryableRequestError,
  loadConfig,
  parseArgs,
  parseDeletionQueue,
  parseDownloadQueue,
  parseFileSize,
  parseNonAuthorWorkList,
  parseSevenZipListing,
  prepareStagingPath,
  replaceOutputDirectory,
  retryAfterMilliseconds,
  scanLocalCollection,
  sanitizeDownloadPathSegment,
  normalizeWorkCode,
  workCodeFromArchiveName,
  workCodeFromSearchWork,
  workIdFromArchiveName,
  validateSearchResponse,
  writeResponseBodyToFile,
} from "../src/index.ts";
import { mapLimit } from "../src/shared.ts";

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

  test("超长文件名发生冲突时仍保持组件长度上限", () => {
    const title = `${"a".repeat(250)}.wav`;
    const files = buildDownloadFilePlan([
      { type: "audio", title, mediaDownloadUrl: "https://example.com/1" },
      { type: "audio", title, mediaDownloadUrl: "https://example.com/2" },
    ]);
    expect(files[0].relativePath).not.toBe(files[1].relativePath);
    expect(files.every((file) => [...file.relativePath].length <= 180)).toBeTrue();
  });

  test("多字节文件名按 UTF-8 字节限制并保留扩展名", () => {
    const sanitized = sanitizeDownloadPathSegment(`${"音".repeat(200)}.wav`);
    expect(new TextEncoder().encode(sanitized).byteLength).toBeLessThanOrEqual(180);
    expect(sanitized.endsWith(".wav")).toBeTrue();
  });

  test("保留所有音频格式和非音频资源", () => {
    const files = buildDownloadFilePlan([
      { type: "audio", title: "声音.wav", mediaDownloadUrl: "https://example.com/wav" },
      { type: "audio", title: "声音.mp3", mediaDownloadUrl: "https://example.com/mp3" },
      { type: "image", title: "封面.jpg", mediaDownloadUrl: "https://example.com/jpg" },
    ]);
    expect(files.map((file) => file.relativePath)).toEqual(["声音.wav", "声音.mp3", "封面.jpg"]);
  });

  test("大量同名资源在线性冲突分配中保持唯一", () => {
    const files = buildDownloadFilePlan(Array.from({ length: 1_000 }, (_, index) => ({
      type: "audio",
      title: "同名.wav",
      mediaDownloadUrl: `https://example.com/${index}`,
    })));
    expect(new Set(files.map((file) => file.relativePath)).size).toBe(1_000);
    expect(files.at(-1)?.relativePath).toBe("同名 (1000).wav");
  });

  test("忽略文件树中的无效空节点", () => {
    expect(buildDownloadFilePlan([
      null as never,
      { type: "audio", title: "声音.wav", mediaDownloadUrl: "https://example.com/audio" },
    ])).toEqual([{ url: "https://example.com/audio", relativePath: "声音.wav" }]);
  });

  test("只复用大小完整的已下载文件", () => {
    expect(isCompleteDownloadFile(1024, 1024)).toBeTrue();
    expect(isCompleteDownloadFile(512, 1024)).toBeFalse();
    expect(isCompleteDownloadFile(512)).toBeTrue();
  });

  test("复用旧版本中数据最多的随机临时目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "asmr-archive-checker-test-"));
    try {
      const smaller = join(root, "RJ01000000-small");
      const larger = join(root, "RJ01000000-large");
      await Promise.all([mkdir(smaller), mkdir(larger)]);
      await Promise.all([
        Bun.write(join(smaller, "file.txt"), "small"),
        Bun.write(join(larger, "file.txt"), "larger old download"),
      ]);

      const selected = await prepareStagingPath(root, "RJ01000000");
      expect(selected).toBe(join(root, "RJ01000000"));
      expect(await Bun.file(join(selected, "file.txt")).text()).toBe("larger old download");
      expect(await prepareStagingPath(root, "RJ01000000")).toBe(selected);
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

  test("响应数据超过预期大小时立即中止写入", async () => {
    const root = await mkdtemp(join(tmpdir(), "asmr-archive-checker-stream-limit-test-"));
    try {
      const path = join(root, "response.bin");
      const controller = new AbortController();
      const response = new Response(new Uint8Array([1, 2, 3, 4]));
      await expect(writeResponseBodyToFile(response, path, controller, 1_000, 3)).rejects.toThrow("超过预期大小");
      expect(controller.signal.aborted).toBeTrue();
      expect((await Bun.file(path).stat()).size).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("拒绝通过临时目录内的链接向外创建下载目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "asmr-archive-download-link-root-"));
    const outside = await mkdtemp(join(tmpdir(), "asmr-archive-download-link-outside-"));
    try {
      const linkedDirectory = join(root, "linked");
      await symlink(outside, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
      await expect(ensureSafeDownloadDirectory(root, join(linkedDirectory, "created"))).rejects.toThrow("链接");
      expect(await Bun.file(join(outside, "created")).exists()).toBeFalse();
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });
});

describe("编号识别", () => {
  test("读取旧文件名中的多余零并规范化为真实 RJ 编号", () => {
    expect(workIdFromArchiveName("RJ328352.7z")).toBe(328352);
    expect(workIdFromArchiveName("RJ00123.7z")).toBe(123);
    expect(workIdFromArchiveName("RJ1602072.7z")).toBe(1602072);
    expect(workIdFromArchiveName("作品-RJ01602072.7z")).toBe(1602072);
    expect(workIdFromArchiveName("no-id.7z")).toBeUndefined();
    expect(formatWorkId(123)).toBe("RJ123");
  });

  test("识别 BJ 来源编号而不把 API 内部 ID 伪装成 RJ", () => {
    expect(normalizeWorkCode("bj0633449")).toBe("BJ633449");
    expect(workCodeFromArchiveName("作品-BJ633449.7z")).toBe("BJ633449");
    expect(workIdFromArchiveName("BJ633449.7z")).toBeUndefined();
    expect(workCodeFromSearchWork({ id: 100000007, source_id: "BJ633449" })).toBe("BJ633449");
  });
});

describe("非该作者作品清单", () => {
  test("列出作者作品集合之外的压缩包和文件夹", () => {
    const works = findNonAuthorWorks(
      ["RJ01602072", "RJ01616933"],
      [
        { path: "D:/voice/RJ01602072.7z", workCode: "RJ01602072" },
        { path: "D:/voice/RJ02000000.7z", workCode: "RJ02000000" },
      ],
      [
        { path: "D:/download/RJ02000000", workCode: "RJ02000000" },
        { path: "D:/download/RJ03000000", workCode: "RJ03000000" },
      ],
    );

    expect(works).toEqual([
      { path: "D:/voice/RJ02000000.7z", workCode: "RJ02000000", type: "压缩包" },
      { path: "D:/download/RJ02000000", workCode: "RJ02000000", type: "文件夹" },
      { path: "D:/download/RJ03000000", workCode: "RJ03000000", type: "文件夹" },
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
    expect(formatWorkId(1)).toBe("RJ1");
    expect(formatWorkId(12345)).toBe("RJ12345");
    expect(formatWorkId(328352)).toBe("RJ328352");
    expect(formatWorkId(999999)).toBe("RJ999999");
    expect(formatWorkId(1000000)).toBe("RJ01000000");
    expect(formatWorkId(1602072)).toBe("RJ01602072");
    expect(formatWorkId(1616933)).toBe("RJ01616933");
    expect(decodeURIComponent(new URL(buildWorkSearchUrl("BJ633449")).pathname)).toBe("/api/search/BJ633449");
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

  test("迭代展开极深文件树而不耗尽调用栈", () => {
    let node: Parameters<typeof flattenTrackTree>[0][number] = {
      type: "audio",
      title: "声音.wav",
      mediaDownloadUrl: "https://example.com/audio",
    };
    for (let depth = 0; depth < 12_000; depth += 1) {
      node = { type: "folder", title: "层", children: [node] };
    }
    const paths = flattenTrackTree([node]);
    expect(paths).toHaveLength(1);
    expect(paths[0].endsWith("声音.wav")).toBeTrue();
    expect(buildDownloadFilePlan([node])).toHaveLength(1);
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
      "BJ633449\t遗漏\t标题三",
      "",
    ].join("\n"))).toEqual([1602072, 1616933, "BJ633449"]);
  });

  test("拒绝空白或损坏的待下载汇总", () => {
    expect(() => parseDownloadQueue("")).toThrow("格式无效");
    expect(() => parseDownloadQueue("作品ID\t原因\t来源\nRJ1\n")).toThrow("无效记录");
  });

  test("读取 author 和 archives 生成的待删除清单", () => {
    expect(parseDeletionQueue([
      "作品ID\t压缩包路径",
      "RJ01602072\tD:/voice/RJ01602072.7z",
      "",
    ].join("\n"))).toEqual([{
      archivePath: "D:/voice/RJ01602072.7z",
      workCode: "RJ01602072",
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

  test("BJ 编号在删除清单中保持来源编号", () => {
    expect(buildDeletionQueue([
      {
        archivePath: "D:/voice/BJ633449.7z",
        workCode: "BJ633449",
        workId: 100000007,
        missingFiles: ["missing.mp3"],
      },
    ])).toContain("BJ633449\tD:/voice/BJ633449.7z");
    expect(parseDeletionQueue("作品ID\t压缩包路径\nBJ633449\tD:/voice/BJ633449.7z\n")).toEqual([{
      archivePath: "D:/voice/BJ633449.7z",
      workCode: "BJ633449",
      missingFiles: ["来自检查结果"],
    }]);
  });
});

describe("配置与结果目录", () => {
  test("配置路径相对于配置文件解析并拒绝非对象根节点", async () => {
    const root = await mkdtemp(join(tmpdir(), "asmr-archive-config-test-"));
    try {
      const configPath = join(root, "config.json");
      await Bun.write(configPath, JSON.stringify({
        archiveDir: "./archives",
        outputDir: "./results",
        maxWorkers: 5,
        maxRetries: 6,
        proxyUrl: " http://127.0.0.1:7890 ",
        syncQps: 2.5,
      }));
      const config = await loadConfig({ mode: "archives", configPath, help: false });
      expect(config.archiveDir).toBe(resolve(root, "archives"));
      expect(config.outputDir).toBe(resolve(root, "results"));
      expect(config).toMatchObject({
        maxWorkers: 5,
        maxRetries: 6,
        proxyUrl: "http://127.0.0.1:7890",
        syncQps: 2.5,
      });

      await Bun.write(configPath, "[]");
      expect(loadConfig({ mode: "archives", configPath, help: false })).rejects.toThrow("根节点必须是 JSON 对象");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("拒绝无效的下载和 API 配置", async () => {
    const root = await mkdtemp(join(tmpdir(), "asmr-archive-config-validation-test-"));
    try {
      const configPath = join(root, "config.json");
      const load = (values: object) => {
        return Bun.write(configPath, JSON.stringify({ archiveDir: ".", ...values }))
          .then(() => loadConfig({ mode: "archives", configPath, help: false }));
      };
      await expect(load({ maxWorkers: 0 })).rejects.toThrow("maxWorkers");
      await expect(load({ maxRetries: -1 })).rejects.toThrow("maxRetries");
      await expect(load({ proxyUrl: 123 })).rejects.toThrow("proxyUrl");
      await expect(load({ proxyUrl: "socks5://127.0.0.1:1080" })).rejects.toThrow("只支持 HTTP 或 HTTPS");
      await expect(load({ syncQps: 0 })).rejects.toThrow("syncQps");
      await expect(load({ maxWokers: 4 })).rejects.toThrow("未知字段：maxWokers");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("结果目录写入失败时保留旧结果，成功时原子替换", async () => {
    const root = await mkdtemp(join(tmpdir(), "asmr-archive-results-test-"));
    const outputDir = join(root, "output");
    try {
      await mkdir(outputDir);
      await Bun.write(join(outputDir, "old.txt"), "old");
      expect(replaceOutputDirectory(outputDir, async (stagingDir) => {
        await Bun.write(join(stagingDir, "new.txt"), "new");
        throw new Error("模拟写入失败");
      })).rejects.toThrow("模拟写入失败");
      expect(await Bun.file(join(outputDir, "old.txt")).text()).toBe("old");

      await replaceOutputDirectory(outputDir, async (stagingDir) => {
        await Bun.write(join(stagingDir, "new.txt"), "new");
      });
      expect(await Bun.file(join(outputDir, "old.txt")).exists()).toBeFalse();
      expect(await Bun.file(join(outputDir, "new.txt")).text()).toBe("new");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("本地目录扫描", () => {
  test("并发扫描嵌套压缩包并识别标准作品文件夹", async () => {
    const root = await mkdtemp(join(tmpdir(), "asmr-archive-scan-test-"));
    try {
      const nested = join(root, "nested");
      const workFolder = join(nested, "RJ01000000");
      await mkdir(workFolder, { recursive: true });
      const archivePath = join(workFolder, "RJ01000001.7z");
      await Bun.write(archivePath, "archive");
      await Bun.write(join(nested, "ignored.zip"), "zip");
      expect(await findArchives(root)).toEqual([resolve(archivePath)]);
      expect(await findDownloadedWorkFolders(root)).toEqual([{
        path: resolve(workFolder),
        workCode: "RJ01000000",
      }]);
      expect(await scanLocalCollection(root)).toEqual({
        archives: [resolve(archivePath)],
        folders: [{ path: resolve(workFolder), workCode: "RJ01000000" }],
      });
      expect(await findDownloadedWorkFolders(join(root, "missing"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
      concurrency: 1,
      maxWorkers: 1,
      maxRetries: 3,
      proxyUrl: "",
      syncQps: 2,
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

  test("隔离下载执行器的意外抛错并完成一次重试", async () => {
    const config = {
      author: "",
      archiveDir: ".",
      downloadDir: ".",
      outputDir: "./output",
      sevenZipPath: "7z",
      concurrency: 1,
      maxWorkers: 1,
      maxRetries: 3,
      proxyUrl: "",
      syncQps: 2,
      requestTimeoutMs: 30_000,
      maxDownloadSize: "",
    };
    let attempts = 0;
    const batch = await downloadWorks([1], config, async () => {
      attempts += 1;
      throw new Error("执行器崩溃");
    });
    expect(attempts).toBe(2);
    expect(batch.results).toMatchObject([{ status: "failed", error: "执行器崩溃" }]);
  });
});

describe("API 请求", () => {
  test("拒绝 API 数组中的空值和无效作品记录", () => {
    expect(() => validateSearchResponse({
      works: [null],
      pagination: { currentPage: 1, pageSize: 100, totalCount: 1 },
    })).toThrow("无效的作品记录");
    expect(() => validateSearchResponse({
      works: [{ id: 1 }],
      pagination: { currentPage: 1, pageSize: 100, totalCount: 1 },
    })).not.toThrow();
  });

  test("按配置的 QPS 串行限制并发请求", async () => {
    const throttle = createRequestThrottle(20);
    const startedAt = performance.now();
    await Promise.all([throttle(), throttle(), throttle()]);
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(90);
  });

  test("拒绝无效的请求速率", () => {
    expect(() => createRequestThrottle(0)).toThrow("必须是正数");
    expect(() => createRequestThrottle(Number.NaN)).toThrow("必须是正数");
  });

  test("只重试临时 HTTP 错误并遵循 Retry-After", async () => {
    let notFoundRequests = 0;
    let retryRequests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/not-found") {
          notFoundRequests += 1;
          return new Response("missing", { status: 404 });
        }
        retryRequests += 1;
        return retryRequests === 1
          ? new Response("busy", { status: 503, headers: { "Retry-After": "0" } })
          : Response.json({ ok: true });
      },
    });
    const config = { requestTimeoutMs: 1_000, maxRetries: 3, proxyUrl: "" };
    try {
      await expect(fetchJson(`${server.url}not-found`, config)).rejects.toThrow("HTTP 404");
      expect(notFoundRequests).toBe(1);
      expect(await fetchJson<{ ok: boolean }>(`${server.url}retry`, config)).toEqual({ ok: true });
      expect(retryRequests).toBe(2);
    } finally {
      await server.stop(true);
    }
  });

  test("解析 Retry-After 并区分永久 HTTP 错误", () => {
    expect(retryAfterMilliseconds("1.5")).toBe(1_500);
    expect(retryAfterMilliseconds("999")).toBe(60_000);
    expect(isRetryableRequestError(httpErrorFromResponse(new Response(null, { status: 404 })))).toBeFalse();
    expect(isRetryableRequestError(httpErrorFromResponse(new Response(null, { status: 429 })))).toBeTrue();
  });
});

describe("受限并发", () => {
  test("映射器抛出 undefined 时也会正确拒绝", async () => {
    let rejected = false;
    try {
      await mapLimit([1], 1, async () => {
        throw undefined;
      });
    } catch (error) {
      rejected = true;
      expect(error).toBeUndefined();
    }
    expect(rejected).toBeTrue();
  });
});

describe("删除不完整作品", () => {
  test("同一文件的重复记录只规划一次", async () => {
    const root = await mkdtemp(join(tmpdir(), "asmr-archive-delete-deduplicate-test-"));
    try {
      const archivePath = join(root, "RJ01000000.7z");
      await Bun.write(archivePath, "x");
      const item = { archivePath, workCode: "RJ01000000" as const, workId: 1000000, missingFiles: ["missing.wav"] };
      expect(await buildDeletionPlan([item, item], root)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("只规划确认不完整且位于归档目录内的 7z", async () => {
    const root = await mkdtemp(join(tmpdir(), "asmr-archive-delete-test-"));
    try {
      const archivePath = join(root, "RJ01000000.7z");
      await Bun.write(archivePath, "incomplete archive");
      const plan = await buildDeletionPlan([
        { archivePath, workCode: "RJ01000000", workId: 1000000, missingFiles: ["missing.wav"] },
        { archivePath: join(root, "RJ01000001.7z"), workCode: "RJ01000001", workId: 1000001, missingFiles: [], error: "API 失败" },
      ], root);
      expect(plan).toEqual([{ archivePath, workCode: "RJ01000000", size: 18 }]);
      expect(formatFileSize(plan[0].size)).toBe("18 B");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("删除计划中的文件", async () => {
    const root = await mkdtemp(join(tmpdir(), "asmr-archive-delete-test-"));
    try {
      const archivePath = join(root, "RJ01000000.7z");
      await Bun.write(archivePath, "x".repeat(2048));
      const plan = await buildDeletionPlan([
        { archivePath, workCode: "RJ01000000", workId: 1000000, missingFiles: ["missing.wav"] },
      ], root);
      expect(formatFileSize(plan[0].size)).toBe("2.00 KB");
      expect(await deleteArchives(plan)).toEqual([]);
      expect(await Bun.file(archivePath).exists()).toBeFalse();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("拒绝删除确认期间被替换的同名文件", async () => {
    const root = await mkdtemp(join(tmpdir(), "asmr-archive-delete-replaced-test-"));
    try {
      const archivePath = join(root, "RJ01000000.7z");
      await Bun.write(archivePath, "old archive");
      const plan = await buildDeletionPlan([{
        archivePath,
        workCode: "RJ01000000",
        workId: 1000000,
        missingFiles: ["missing.wav"],
      }], root);
      await rm(archivePath, { force: true });
      await Bun.write(archivePath, "replacement archive");

      expect(await deleteArchives(plan)).toMatchObject([{ archivePath }]);
      expect(await Bun.file(archivePath).text()).toBe("replacement archive");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("拒绝规划归档目录之外的文件", async () => {
    const root = await mkdtemp(join(tmpdir(), "asmr-archive-delete-root-"));
    const outside = await mkdtemp(join(tmpdir(), "asmr-archive-delete-outside-"));
    try {
      const archivePath = join(outside, "RJ01000000.7z");
      await Bun.write(archivePath, "x");
      expect(buildDeletionPlan([
        { archivePath, workCode: "RJ01000000", workId: 1000000, missingFiles: ["missing.wav"] },
      ], root)).rejects.toThrow("archiveDir 之外");
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });

  test("拒绝通过目录链接逃逸到归档目录之外", async () => {
    const root = await mkdtemp(join(tmpdir(), "asmr-archive-delete-link-root-"));
    const outside = await mkdtemp(join(tmpdir(), "asmr-archive-delete-link-outside-"));
    try {
      const archivePath = join(outside, "RJ01000000.7z");
      const linkedDirectory = join(root, "linked");
      await Bun.write(archivePath, "x");
      await symlink(outside, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
      expect(buildDeletionPlan([{
        archivePath: join(linkedDirectory, "RJ01000000.7z"),
        workCode: "RJ01000000",
        workId: 1000000,
        missingFiles: ["missing.wav"],
      }], root)).rejects.toThrow("archiveDir 之外");
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
      { path: "D:/voice/RJ328352.7z", workCode: "RJ328352", type: "压缩包" },
      { path: "D:/download/RJ01602072", workCode: "RJ01602072", type: "文件夹" },
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
        { path: archivePath, workCode: "RJ328352", type: "压缩包" },
        { path: folderPath, workCode: "RJ01602072", type: "文件夹" },
      ], archiveRoot, downloadRoot);

      expect(plan).toEqual([
        { path: archivePath, workCode: "RJ328352", type: "压缩包", size: 7 },
        { path: folderPath, workCode: "RJ01602072", type: "文件夹", size: 16 },
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
        { path: outsidePath, workCode: "RJ328352", type: "压缩包" },
      ], root)).rejects.toThrow("允许目录之外");
      expect(buildNonAuthorDeletionPlan([
        { path: insidePath, workCode: "RJ123456", type: "压缩包" },
      ], root)).rejects.toThrow("作品编号与清单不一致");
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });
});
