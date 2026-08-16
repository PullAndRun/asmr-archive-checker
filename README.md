# 音声归档检查与批量下载工具

这是一个 Bun 命令行程序，既能检查本地音声归档是否完整，也能按作者获取作品列表，将本地遗漏或不完整的音声加入队列后批量下载。

程序提供五个独立模式：

- `author`：按作者检查全部作品，汇总遗漏作品、不完整的 7z 和本地非该作者作品，并生成批量下载队列；
- `archives`：检查指定目录内的所有 7z，汇总不完整作品；
- `delete`：读取 `author` 或 `archives` 的已有检查结果，展示删除统计和文件列表，确认后删除不完整作品；
- `delete-non-author`：读取 `author` 生成的非该作者作品清单，确认后删除其中的压缩包和作品文件夹；
- `download`：读取检查阶段生成的汇总文件，批量下载完整作品。

检查阶段只用 7-Zip 读取压缩包内的文件名，不会解压，也不会自动下载。下载后的文件夹统一使用 API 返回的真实来源编号（`*J`），例如 `RJ328352`、`RJ01602072`、`VJ01005847` 或 `BJ633449`。

## 环境要求

- [Bun](https://bun.sh/)；
- 7-Zip，命令行可运行 `7z`。

文件查询由程序直接使用系统目录枚举完成，不依赖 Everything。安装或未安装 Everything 都不影响运行；当 `archiveDir` 位于 `asmrDir` 内时，两个范围会合并为一次根目录扫描，再在内存中按路径分组，避免重复读取硬盘。`author` 模式还会让网站查询和本地文件扫描同时进行。

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
  "maxWorkers": 4,
  "maxRetries": 3,
  "proxyUrl": "",
  "syncQps": 2,
  "requestTimeoutMs": 30000,
  "archiveTimeoutMs": 300000
}
```

- `author`：`author` 模式使用的社团或声优名称。程序只会分别按 asmr.one 的精确 `circle` 和 `va` 字段搜索，即 `$circle:名称$`、`$va:名称$`，并合并去重两边的作品；
- `archiveDir`：递归扫描 7z 的目录；
- `asmrDir`：保存已下载音声压缩包的资料库根目录。目录下可按任意作者分文件夹，程序会递归全局查找所有能识别 `*J` 编号的 `.7z`，不依赖当前 `author` 的目录名；
- `downloadDir`：完整作品保存目录。`download` 模式要求明确填写，`delete-non-author` 也会将其作为允许删除作品文件夹的目录；
- `outputDir`：检查结果和待下载汇总所在目录；
- `sevenZipPath`：7-Zip 命令或完整路径；
- `maxDownloadSize`：单次运行允许完成下载的最大总体积，例如 `"100 GB"`。支持 B、KB、MB、GB、TB（按 1024 换算）；设为 `""` 表示不限制；
- `concurrency`：API 和压缩包检查的并发数，范围 1–20；
- `maxWorkers`：同一部作品内同时下载的最大文件数，范围 1–20；
- `maxRetries`：API 或单个文件请求失败后的最大重试次数，范围 0–20；
- `proxyUrl`：API 和文件下载使用的代理地址；设为 `""` 表示不使用代理；
- `syncQps`：API 请求速率上限，范围大于 0 且不超过 100；
- `requestTimeoutMs`：API 请求以及每个文件分段的连接/无数据等待超时毫秒数。
- `archiveTimeoutMs`：单个压缩包执行 7-Zip 列表检查的超时毫秒数，默认 300000（5 分钟）。

相对路径均以配置文件所在目录为基准。

每次运行都会清理 `outputDir` 中的其他文件。`archives` 检查生成四个结果文件，`author` 还会额外生成非该作者作品清单；下载模式会先读取并保留这些结果文件，再清理其他内容。安全校验会阻止把 `outputDir` 配置为磁盘根目录、项目目录、音声目录或其上级目录。

`author` 和 `archives` 启动时会先只读检查 `archiveDir` 和 `asmrDir`。如果待扫描目录不存在或不是文件夹，程序会立即报错，不会创建该目录、清空 `outputDir`、请求 API 或执行其他操作。项目内已提供空的 `./asmr` 目录；使用其他资料库时请修改配置。验证通过后才会创建 `outputDir`。下载模式会自动创建缺失的 `outputDir`、`downloadDir` 和下载临时目录。

## 运行流程

### 批量下载某位作者的音声

在 `config.json` 中填写社团或声优名称 `author`、`archiveDir`、`asmrDir` 和 `downloadDir`。程序会分别搜索同名 `circle` 和 `va`，再将作品列表与本地已有的 7z、ASMR 资料库和已下载文件夹进行比较：

```powershell
bun run author
```

确认 `output/待下载的音声.txt` 后，批量下载其中遗漏或不完整的作品：

```powershell
bun run download
```

因此，同一作品即使属于多个作者，只要它的压缩包存在于 `asmrDir` 下任意作者目录，就不会被重复加入待下载队列。`archiveDir` 中本次确认不完整、且资料库中没有另一份压缩包的作品仍会保留在队列中，以便重新下载。

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

第二步，确认 `output/待下载的音声.txt` 后手动执行下载：

```powershell
bun run download
```

如果 `config.json` 没有填写 `downloadDir`，可在命令中指定：

```powershell
bun run download -- --download-dir "D:\音声\补全"
```

也可以只为本次运行设置下载体积上限：

```powershell
bun run download -- --max-download-size "100 GB"
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
- 搜索结果存在、但站点文件列表返回 404 的作品会标记为“站点暂无资源”并跳过，不会作为普通失败重复下载；
- 文件资源使用 8 MiB 的有界 HTTP Range 分段下载；每段独立校验 `Content-Range`、声明大小和实际大小，临时错误只重试当前分段；不支持 Range 的普通服务器仍可返回一次完整的 `200` 响应；
- 设置下载体积限制后，每部作品完成时累计其文件夹体积；达到限制后停止开始下一部作品，不会切断当前作品；
- 下载先进入 `downloadDir/.asmr-archive-checker-downloads` 下的临时目录，成功后移动并改名为真实来源编号；Windows 非法文件名字符会替换为 `_`；
- 标准名称的目标文件夹已经存在时会跳过，不覆盖已有文件；失败时保留每部作品固定的临时目录，再次运行会校验文件大小并续传尚未完成的文件。旧版本生成的随机临时目录也会自动选择数据最多的一份继续下载。

无法从文件名识别 `*J` 来源编号的 7z 无法自动检查或加入下载汇总，程序会在命令行提示数量。

## 程序架构

项目使用函数式模块组织，不使用类或可变领域对象：

- `src/domain/work-code.ts`：`*J` 来源编号规范化、文件名识别和 API 元数据映射；
- `src/domain/archive.ts`：7-Zip 清单解析、网站文件树展开、文件名清洗和完整性比较；
- `src/domain/records.ts`：下载/删除清单解析与生成、非作者作品集合运算；
- `src/application.ts`：组合 author、archives、delete 和 download 用例，不实现底层 I/O；
- `src/api.ts`、`src/archive-service.ts`、`src/results-store.ts`：API、归档扫描和结果文件适配器；
- `src/downloader.ts`、`src/deletion.ts`：下载与删除副作用边界；
- `src/logger.ts`：Winston 日志格式、级别和 Console transport；
- `src/config.ts`：参数解析、配置加载和目录前置条件；
- `src/index.ts`：仅负责公开 API 重导出和进程启动。

依赖方向固定为 `index -> application -> adapters -> domain`。`domain` 下的函数只根据输入计算输出，不访问文件系统、网络、环境变量或进程状态；副作用按功能集中在适配器中，并通过函数参数注入下载执行器，便于独立测试领域规则。

## 输出

`outputDir` 中只生成：

- `不完整的压缩包.txt`：不完整或检查失败的 7z 绝对路径；
- `遗漏下载的音声.txt`：`author` 模式发现的遗漏作品；
- `待下载的音声.txt`：下载模式读取的汇总，包含作品编号、原因和来源。
- `待删除的不完整压缩包.txt`：删除模式读取的专用清单，仅包含检查确认不完整的压缩包，不包含检查失败项。
- `非该作者的作品.txt`：仅由 `author` 模式生成，包含不属于当前作者作品列表的 `*J` 来源编号、类型和本地路径，也是 `delete-non-author` 的删除依据。

API/7-Zip 检查错误或下载失败时，进程退出码为 2。

## 测试

```powershell
bun test
```
