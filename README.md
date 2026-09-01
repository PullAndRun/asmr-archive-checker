# 音声归档检查与批量下载工具

这是一个 Bun 命令行程序，既能检查本地音声归档是否完整，也能按作者获取作品列表，将本地遗漏或不完整的音声加入队列后批量下载。

程序提供七个独立模式：

- `author`：按作者检查全部作品，汇总遗漏作品、不完整的 7z 和本地非该作者作品，并生成批量下载队列；
- `archives`：检查指定目录内的所有 7z，汇总不完整作品；
- `delete`：读取 `author` 或 `archives` 的已有检查结果，展示删除统计和文件列表，确认后删除不完整作品；
- `delete-non-author`：读取 `author` 生成的非该作者作品清单，确认后删除其中的压缩包和作品文件夹；
- `download`（旧版汇总模式）：读取 `author`/`archives` 检查阶段生成的汇总文件，批量下载完整作品；命令入口为 `bun run download-legacy` 或 `bun run check -- download`；
- `find`：扫描 `asmrDir` 下的多作者库存，用 API 文件树核对现有 7z 的文件是否完整，只生成多作者下载队列，不执行下载；
- `download-authors`：读取 `find` 生成的多作者队列，按作者目录下载完整作品。

检查阶段只用 7-Zip 读取压缩包内的文件名，不会解压，也不会自动下载。下载后的文件夹统一使用 API 返回的真实来源编号（`*J`），例如 `RJ328352`、`RJ01602072`、`VJ01005847` 或 `BJ633449`。

## 环境要求

- [Bun](https://bun.sh/)；
- 7-Zip，命令行可运行 `7z`。

文件查询由程序直接使用系统目录枚举完成，不依赖 Everything。安装或未安装 Everything 都不影响运行；当 `archiveDir` 位于 `asmrDir` 内时，`author`/`archives` 两个范围会合并为一次根目录扫描，再在内存中按路径分组，避免重复读取硬盘。`author` 模式还会让网站查询和本地文件扫描同时进行。

下载模式在所有平台都直接读取网站文件树，并下载其中的全部资源，不会在 MP3、WAV、FLAC 或其他资源之间做互斥筛选。文件响应以分块流直接写入磁盘，避免并发下载大文件时占用过多内存；文件名会经过安全清洗。代理、重试、下载并发和 API 限速均通过项目的 `config.json` 配置。502、503、504 和 429 会使用较长的指数退避；资源服务器持续返回 503 时，本轮下载会停止并保留临时文件，稍后重新运行即可续传。每次下载的都是整部作品，不会只补缺失文件。

## 日志

程序使用 Winston 输出带时间戳和级别的日志，默认级别为 `info`。可通过 `LOG_LEVEL` 设置 `error`、`warn`、`info`、`http`、`verbose`、`debug` 或 `silly`；错误写入 stderr，警告和普通日志写入对应的控制台流。

## 配置

复制配置模板并编辑根目录的 `config.json`。该文件包含本机路径，不会被 Git 跟踪：

```powershell
Copy-Item config.example.json config.json
```

模板内容如下：

```json
{
  "author": "作者名",
  "archiveDir": "D:/path/to/archives",
  "asmrDir": "D:/path/to/asmr",
  "downloadDir": "D:/path/to/downloads",
  "outputDir": "./output",
  "sevenZipPath": "7z",
  "maxDownloadSize": "100 GB",
  "concurrency": 4,
  "maxWorkers": 1,
  "maxRetries": 3,
  "proxyUrl": "",
  "apiUrls": ["https://api.asmr-200.com", "https://api.asmr-100.com"],
  "syncQps": 2,
  "requestTimeoutMs": 30000,
  "archiveTimeoutMs": 300000
}
```

- `author`：`author` 模式使用的社团或声优名称。程序只会分别按 asmr.one 的精确 `circle` 和 `va` 字段搜索，即 `$circle:名称$`、`$va:名称$`，并合并去重两边的作品；
- `archiveDir`：递归扫描 7z 的目录；
- `asmrDir`：保存已下载音声压缩包的资料库根目录。`author`/`archives` 会递归全局查找能识别 `*J` 编号的 `.7z`；`find` 将其每个一级子文件夹视为一个作者，并检查这些作者目录内的 7z；
- `downloadDir`：完整作品保存目录。`download` 和 `download-authors` 模式要求明确填写，`find` 如果配置了该目录还会扫描其中已有的作者作品文件夹；`delete-non-author` 也会将其作为允许删除作品文件夹的目录；
- `outputDir`：检查结果和待下载汇总所在目录；
- `sevenZipPath`：7-Zip 命令或完整路径；
- `maxDownloadSize`：单次运行允许完成下载的最大总体积，例如 `"100 GB"`。支持 B、KB、MB、GB、TB（按 1024 换算）；设为 `""` 表示不限制；
- `concurrency`：API 和压缩包检查的并发数，范围 1–20；
- `maxWorkers`：保留的并发配置项；网页式媒体下载固定按文件顺序串行请求，建议设为 `1`；
- `maxRetries`：API 请求失败后的最大重试次数，范围 0–20；网页式媒体文件请求不自动重试；
- `proxyUrl`：API 和文件下载使用的代理地址；设为 `""` 表示不使用代理；
- `syncQps`：API 请求速率上限，范围大于 0 且不超过 100；
- `requestTimeoutMs`：API 请求以及每个完整媒体文件的连接/无数据等待超时毫秒数。
- `archiveTimeoutMs`：单个压缩包执行 7-Zip 列表检查的超时毫秒数，默认 300000（5 分钟）。

相对路径均以配置文件所在目录为基准。

`author` 和 `archives` 会原子替换检查结果并清理 `outputDir` 中的其他文件；`download` 会先读取并保留这些结果文件，再清理其他内容。`find` 和 `download-authors` 只覆盖各自的结果文件，不会清理 `outputDir` 中的其他内容。安全校验会阻止把 `outputDir` 配置为磁盘根目录、项目目录、音声目录或其上级目录。

`author` 和 `archives` 启动时会先只读检查 `archiveDir` 和 `asmrDir`；`find` 至少要求 `asmrDir` 存在且包含作者子目录。如果待扫描目录不存在或不是文件夹，程序会立即报错，不会创建该目录、清空 `outputDir`、请求 API 或执行其他操作。项目内已提供空的 `./asmr` 目录；使用其他资料库时请修改配置。验证通过后才会创建 `outputDir`。`download` 和 `download-authors` 会自动创建缺失的 `outputDir`、`downloadDir` 和下载临时目录。

## 运行流程

### 批量下载某位作者的音声

在 `config.json` 中填写社团或声优名称 `author`、`archiveDir`、`asmrDir` 和 `downloadDir`。程序会分别搜索同名 `circle` 和 `va`，再将作品列表与本地已有的 7z、ASMR 资料库和已下载文件夹进行比较：

```powershell
bun run author
```

确认 `output/待下载的音声.txt` 后，批量下载其中遗漏或不完整的作品：

```powershell
bun run download-legacy
```

也可以使用 `bun run check -- download`；这两个命令读取的是 `output/待下载的音声.txt`，不是多作者模式的 JSON 队列。
旧版汇总下载会将作品保存到 `downloadDir/<作者>/<作品编号>`，其中作者名来自当前配置的 `author`；可用 `--author` 临时覆盖。
每部作品完整下载并移动到作者目录后，会立即从 `待下载的音声.txt` 和 `遗漏下载的音声.txt` 中移除；失败或尚未开始的作品会保留，方便下次继续。这样即使之后把已完成作品文件夹移走，重新运行也不会再次下载它。
每次启动下载前也会扫描作者目录，把清单中已经存在的完整作品文件夹先移除并跳过。

因此，同一作品即使属于多个作者，只要它的压缩包存在于 `asmrDir` 下任意作者目录，就不会被重复加入待下载队列。`archiveDir` 中本次确认不完整、且资料库中没有另一份压缩包的作品仍会保留在队列中，以便重新下载。

### 多作者库存筛选与下载

多作者模式要求 `asmrDir` 使用“一级目录名为作者名”的布局，例如：

```text
asmrDir/
├─ 作者甲/
│  ├─ RJ123456.7z
│  └─ VJ01000001.7z
└─ 作者乙/
   └─ RJ234567.7z
```

先运行 `find`。它会查询每个一级作者目录对应的 `circle` 和 `va` 作品列表，解决重复作品的作者归属，然后读取作者目录中的 7z 清单，并与 API 文件树逐项比较。API 列出的任意文件缺失时，作品会按“整部作品”加入队列；`find` 只筛选和写入结果，不会下载或删除本地文件。核对期间终端会显示当前处理的 7z 路径、进度和完整性结果：

```powershell
bun run find
```

`find` 生成以下多作者结果：

- `output/author-download-queue.json`：`download-authors` 使用的 JSON 队列；
- `output/作者待下载的音声.txt`：供人工查看的制表符分隔清单，包含作者、作品编号、遗漏/不完整原因、来源和缺失文件；
- `output/author-find-report.json`：完整的作者、遗漏、不完整、队列和错误报告；
- `output/author-skipped.json`：无法获取 API 作品列表的作者及重试信息。

确认队列后运行 `download-authors` 下载整部作品：

```powershell
bun run download-authors
```

当前 `bun run download` 是这个多作者下载入口的兼容别名；旧版 `待下载的音声.txt` 汇总下载请使用上文的 `bun run download-legacy`。

作品保存到 `downloadDir/<作者>/<作品编号>`。是否已下载按这个精确的作者目录判断，其他作者目录中的同编号作品不会抑制当前下载。每部作品的文件按 API 文件树全部下载，只有全部文件成功后才移动到最终目录；失败会保留临时目录，下一次运行可以继续。下载结果写入 `output/author-download-failures.json`，媒体服务器返回 429 或 Cloudflare 1015 时本轮队列会停止，等待限流窗口结束后重新运行即可。
每部作品完整下载并移动到最终目录后，会立即从 `author-download-queue.json` 和 `作者待下载的音声.txt` 中移除；已经存在而被跳过的作品也会从队列中清理。下载中断时，尚未完成的作品仍会保留在队列中。

### 分步使用

第一步，选择一种检查方式。

按作者检查：

```powershell
bun run author
```

检查目录内的所有 7z：

```powershell
bun run archives
```

检查并删除不完整的 7z：

```powershell
bun run delete
```

先运行 `author` 或 `archives` 生成检查结果，再运行 `delete`。`delete` 不会重新请求 API 或运行 7-Zip，只读取 `outputDir/待删除的不完整压缩包.txt`，然后列出确认不完整的文件、各自大小和总大小。只有准确输入 `DELETE` 才会永久删除这些文件；检查失败、无法识别来源编号以及被判定完整的文件不会写入待删除清单。旧版本生成的结果没有这份专用清单，需要先重新运行一次检查。清单会保留在 `outputDir` 中作为操作记录。

检查并删除非该作者的作品：

```powershell
bun run author
bun run delete-non-author
```

`delete-non-author` 只读取 `outputDir/非该作者的作品.txt`，不会重新请求 API。删除前会列出每个目标的来源编号、类型、路径和大小，并分别统计压缩包和文件夹；只有准确输入 `DELETE` 才会永久删除。压缩包必须是 `archiveDir` 内编号一致的普通 7z，作品文件夹必须是 `archiveDir` 或 `downloadDir` 内编号一致的标准 `*J` 文件夹；路径越界、符号链接、类型或编号不符以及目标不存在都会在删除任何内容前终止操作。结果清单会保留作为操作记录，删除后如需再次操作，应先重新运行 `author` 刷新清单。

第二步，确认 `output/待下载的音声.txt` 后手动执行旧版汇总下载：

```powershell
bun run download-legacy
```

如果 `config.json` 没有填写 `downloadDir`，可在命令中指定：

```powershell
bun run download-legacy -- --download-dir "D:\音声\补全"
```

也可以只为本次运行设置下载体积上限：

```powershell
bun run download-legacy -- --max-download-size "100 GB"
```

体积按本次成功完成的作品文件夹累计。达到或超过上限时，程序会先让当前作品完整下载并移动到最终目录，再停止队列中的后续作品；已经存在而被跳过的作品不计入本次体积。

其他临时配置示例：

```powershell
bun run author -- --author "作者名" --dir "D:\音声\作者"
bun run archives -- --dir "D:\音声\待检查" --output "D:\检查结果"
bun run author -- --asmr-dir "D:\asmr"
```

其他选项可通过 `bun run check -- --help` 查看。`bun run check` 默认等同于 `author` 模式。

## 检查与下载规则

- `RJ1602072.7z`、`RJ01602072.7z` 和名称中包含该编号的 7z 都映射到 API ID `1602072`；
- `VJ01005847` 和 `BJ633449` 分别使用 API 内部 ID `100000063` 和 `100000007` 获取文件列表，但清单、搜索词和下载目录始终保留真实来源编号，不会生成不存在的 `RJ100000063` 或 `RJ100000007`；
- `archives` 模式按编号制式使用 `RJ123`、`RJ328352`、`RJ01602072`、`VJ01005847` 或 `BJ633449` 作为搜索词，并要求 API 返回的来源编号精确匹配；旧文件名中的多余前导零会被规范化；
- `delete` 模式不重复检查，只删除最近一次 `author` 或 `archives` 确认缺少文件且位于 `archiveDir` 内的 7z；
- `delete-non-author` 模式不重复检查，只删除最近一次 `author` 清单中位于允许目录内的非该作者压缩包和作品文件夹；
- 比较时优先匹配完整相对路径；若目录名被清理过，再按尚未匹配的文件名和重复数量核对；
- 网站列出的任何文件缺失都会判为不完整；压缩包内的额外文件不影响结果；
- 待下载汇总会把遗漏作品和不完整作品按编号去重；
- `author` 和 `archives` 都会递归扫描整个 `asmrDir`，并按作品编号从待下载汇总中剔除资料库任意作者目录下已有的 `.7z`；
- 重叠的 `archiveDir` 与 `asmrDir` 会复用同一次原生目录扫描，查询结果在内存中分组；无需 Everything 索引；
- `author` 模式会把作者作品列表之外、且能从名称识别 `*J` 来源编号的本地压缩包和作品文件夹写入单独清单；
- `download` 模式逐行读取汇总，下载完整作品；
- `find` 模式把 `asmrDir` 下每个一级作者目录作为独立作者，使用 API 作品列表和 API 文件树核对本地 7z；不完整 7z 会把整部作品加入 `author-download-queue.json`，不会只下载缺失文件；
- `find` 模式的重复作品归属于作品数量更多的作者；数量相同时按作者名称排序后选择，队列按作者和作品编号排序；
- `download-authors` 模式只读取 `author-download-queue.json`，不重新查询作者列表或 7z；
- `download-authors` 模式按 `downloadDir/<作者>/<作品编号>` 判断目标是否已存在，已有目标目录会跳过，不会覆盖；
- 搜索结果存在、但站点文件列表返回 404 的作品会标记为“站点暂无资源”并跳过，不会作为普通失败重复下载；
- 文件资源按网页下载器方式逐个使用完整 HTTP GET 流式下载，不发送 Range，也不在媒体请求失败后自动重试；每个文件都会校验声明大小和实际写入大小，单个文件失败即停止当前作品；
- 设置下载体积限制后，每部作品完成时累计其文件夹体积；达到限制后停止开始下一部作品，不会切断当前作品；
- 下载先进入 `downloadDir/.asmr-archive-checker-downloads` 下的临时目录，成功后移动并改名为真实来源编号；Windows 非法文件名字符会替换为 `_`；
- 标准名称的目标文件夹已经存在时会跳过，不覆盖已有文件；失败时保留每部作品固定的临时目录，再次运行会校验文件大小并续传尚未完成的文件。旧版本生成的随机临时目录也会自动选择数据最多的一份继续下载。

无法从文件名识别 `*J` 来源编号的 7z 无法自动检查或加入下载汇总，程序会在命令行提示数量。

## 程序架构

项目使用函数式模块组织，不使用类或可变领域对象：

- `src/domain/work-code.ts`：`*J` 来源编号规范化、文件名识别和 API 元数据映射；
- `src/domain/archive.ts`：7-Zip 清单解析、网站文件树展开、文件名清洗和完整性比较；
- `src/domain/records.ts`：下载/删除清单解析与生成、非作者作品集合运算；
- `src/application.ts`：组合 author、archives、delete、download 和 find 用例，不实现底层 I/O；
- `src/api.ts`、`src/archive-service.ts`、`src/results-store.ts`：API、归档扫描和结果文件适配器；
- `src/author-sync.ts`：多作者 API 查询、7z 完整性核对、作者归属和多作者下载队列；
- `src/downloader.ts`、`src/deletion.ts`：下载与删除副作用边界；
- `src/logger.ts`：Winston 日志格式、级别和 Console transport；
- `src/config.ts`：参数解析、配置加载和目录前置条件；
- `src/index.ts`、`src/find.ts`、`src/download.ts`：命令入口；其中 `find.ts` 只筛选，`download.ts` 负责多作者队列下载，旧版汇总下载由 `application.ts` 负责。

依赖方向固定为 `index -> application -> adapters -> domain`。`domain` 下的函数只根据输入计算输出，不访问文件系统、网络、环境变量或进程状态；副作用按功能集中在适配器中，并通过函数参数注入下载执行器，便于独立测试领域规则。

## 输出

不同模式会在 `outputDir` 中生成或更新以下文件：

- `不完整的压缩包.txt`：不完整或检查失败的 7z 绝对路径；
- `遗漏下载的音声.txt`：`author` 模式发现的遗漏作品；
- `待下载的音声.txt`：下载模式读取的汇总，包含作品编号、原因和来源；
- `待删除的不完整压缩包.txt`：删除模式读取的专用清单，仅包含检查确认不完整的压缩包，不包含检查失败项。
- `非该作者的作品.txt`：仅由 `author` 模式生成，包含不属于当前作者作品列表的 `*J` 来源编号、类型和本地路径，也是 `delete-non-author` 的删除依据。
- `author-download-queue.json`：仅由 `find` 生成，包含作者、作品编号、API ID、队列原因和来源。
- `作者待下载的音声.txt`：仅由 `find` 生成的可读队列清单。
- `author-find-report.json`：仅由 `find` 生成的多作者筛选完整报告。
- `author-skipped.json`：仅由 `find` 生成的 API 查询失败或无作品作者清单。
- `author-download-failures.json`：由多作者下载脚本（`download-authors` 或其 `download` 兼容别名）生成的下载失败、站点暂无资源和限流信息。

API/7-Zip 检查错误或下载失败时，相关进程退出码为 2。`find` 的 API 查询失败会写入 `author-skipped.json`；`download-authors` 的失败会写入 `author-download-failures.json`，不会从队列中静默删除。

## 测试

```powershell
bun test
```
