# 音声 7z 完整性检查与补全工具

这是一个 Bun 命令行程序，提供三个独立模式：

- `author`：按作者检查全部作品，汇总遗漏作品和不完整的 7z；
- `archives`：检查指定目录内的所有 7z，汇总不完整作品；
- `download`：读取检查阶段生成的汇总文件，用 `asmroner` 下载完整作品。

检查阶段只用 7-Zip 读取压缩包内的文件名，不会解压，也不会自动下载。下载后的文件夹统一改名为八位编号格式，例如 `RJ01602072`。

## 环境要求

- [Bun](https://bun.sh/)；
- 7-Zip，命令行可运行 `7z`；
- [asmr-downloader](https://github.com/fireinrain/asmr-downloader/releases)，命令行可运行 `asmroner`，并且已执行 `asmroner config` 完成初始化。

`asmroner` 的媒体格式、代理、限流等行为沿用它自己的配置。下载模式会在 `downloadDir` 下的临时目录中调用 `asmroner`，每次下载整部作品，不会只补缺失文件。程序只会向 `asmroner -d` 传入不含 Windows 盘符的相对路径，避免它把绝对路径写成项目根目录下的 `C_`。

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
  "downloadDir": "D:/path/to/downloads",
  "outputDir": "./output",
  "sevenZipPath": "7z",
  "downloaderPath": "asmroner",
  "concurrency": 4,
  "requestTimeoutMs": 30000
}
```

- `author`：`author` 模式使用的作者名；
- `archiveDir`：递归扫描 7z 的目录；
- `downloadDir`：完整作品保存目录。只在 `download` 模式中要求明确填写；
- `outputDir`：检查结果和待下载汇总所在目录；
- `sevenZipPath`：7-Zip 命令或完整路径；
- `downloaderPath`：`asmroner` 命令或完整路径；
- `concurrency`：API 和压缩包检查的并发数，范围 1–20；
- `requestTimeoutMs`：单次 API 请求超时毫秒数。

相对路径均以配置文件所在目录为基准。

每次运行都会清理 `outputDir` 中的其他文件。检查模式重新生成三个结果文件；下载模式会先读取并保留这三个文件，再清理其他内容。安全校验会阻止把 `outputDir` 配置为磁盘根目录、项目目录、音声目录或其上级目录。

程序启动时会先只读检查 `archiveDir`。如果待扫描目录不存在或不是文件夹，程序会立即报错，不会创建该目录、清空 `outputDir`、请求 API 或执行其他操作。验证通过后才会创建 `outputDir`。下载模式会自动创建缺失的 `outputDir`、`downloadDir` 和下载临时目录。

## 运行流程

第一步，选择一种检查方式。

按作者检查：

```powershell
bun run author
```

检查目录内的所有 7z：

```powershell
bun run archives
```

第二步，确认 `output/待下载的音声.txt` 后手动执行下载：

```powershell
bun run download
```

如果 `config.json` 没有填写 `downloadDir`，可在命令中指定：

```powershell
bun run download -- --download-dir "D:\音声\补全"
```

其他临时配置示例：

```powershell
bun run author -- --author "作者名" --dir "D:\音声\作者"
bun run archives -- --dir "D:\音声\待检查" --output "D:\检查结果"
```

其他选项可通过 `bun run check -- --help` 查看。`bun run check` 默认等同于 `author` 模式。

## 检查与下载规则

- `RJ1602072.7z`、`RJ01602072.7z` 和名称中包含该编号的 7z 都映射到 API ID `1602072`；
- `archives` 模式以 `RJ01602072` 作为搜索词，并要求 API 返回的 ID 精确匹配；
- 比较时优先匹配完整相对路径；若目录名被清理过，再按尚未匹配的文件名和重复数量核对；
- 网站列出的任何文件缺失都会判为不完整；压缩包内的额外文件不影响结果；
- 待下载汇总会把遗漏作品和不完整作品按编号去重；
- `download` 模式逐行读取汇总，下载完整作品；
- 下载先进入 `downloadDir/.asmr-archive-checker-downloads` 下的临时目录，成功后移动并改名为八位 RJ 编号；
- 标准名称的目标文件夹已经存在时会跳过，不覆盖已有文件；失败时保留临时目录以便检查或续传。

无法从文件名识别 RJ 编号的 7z 无法自动检查或加入下载汇总，程序会在命令行提示数量。

## 输出

`outputDir` 中只生成：

- `不完整的压缩包.txt`：不完整或检查失败的 7z 绝对路径；
- `遗漏下载的音声.txt`：`author` 模式发现的遗漏作品；
- `待下载的音声.txt`：下载模式读取的汇总，包含作品编号、原因和来源。

API/7-Zip 检查错误或下载失败时，进程退出码为 2。

## 测试

```powershell
bun test
```
