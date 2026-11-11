# dsh-camptv

[English](README.md) | 简体中文

面向 DeepSeek Harness 的 CampTV 图像与视频生成工具。该插件封装了
[CampTV CLI](https://aivideobox.mammothble.com/cli)，为 profile 中的每个模型
提供四个工具：

| 工具 | 作用 |
|---|---|
| `camptv_generate_image` | 在 CampTV 画布上做文生图与图生图，可选用 economy 或 priority 渠道；上传可选参考图，把结果下载到工作区并返回其路径（对支持图像输入的模型还会附带图像本身）。 |
| `camptv_generate_video` | 在 economy 或 priority 渠道上做文生视频/参考生视频；接受参考图片、参考视频以及首帧/尾帧图片，在预算时间内等待完成，或返回 id 供 `camptv_task` 继续处理。 |
| `camptv_task` | 稍后查询、等待并下载某个生成节点。 |
| `camptv_projects` | 列出画布 id、视频渠道配额与生成并发数。 |

## 统一工具目录

CampTV 只暴露一套 Agent 工具目录：服务端的 MCP `tools/list`
（`POST <server>/mcp`，`Authorization: Bearer ctv_…`）。MCP 客户端、CampTV
CLI（`agent tools` / `agent call`）与本插件使用相同的工具名、参数和结果。
插件会：

- 从内置的 `tools.snapshot.json` 同步注册工具；当
  `~/.camptv/agent-tools.json` 比它更新时，改用该文件。CLI 通过
  `node cli.cjs agent tools --save` 写入这个文件；插件在首次成功探测能力后
  也会刷新它。
- 每次调用都执行为 `node cli.cjs agent call <tool> --args-file <tmp>
  [--wait --wait-ms <budget>] [--download-dir <outputDir>]`。参数经私有临时
  文件传递，调用结束后即删除。文件参数（由目录中的
  `_meta["camptv/fileArgs"]` 指定）先相对于会话工作目录解析，然后由 CLI
  内联读取（每个文件最多 20 MB）。画布节点 UUID 原样透传。
- 保留此前已有的宿主能力：会话当前目录、`outputDir`、内联图像附件、
  透明 PNG 路由检查与 alpha 警告，以及调用卡片。
- 同时注册底层目录工具（`camptv_whoami`、`camptv_get_canvas`、
  `camptv_create_node`、`camptv_canvas_edit` 等）。在 `canvasTools: auto`
  下，只有 `~/.camptv/agent-tools.json` 存在时才会注册，因为该文件表明 CLI
  与服务端都支持这套目录。改动在插件重载后生效。

若要针对升级后的服务端重新生成内置快照：

```sh
node ~/.camptv/bin/cli.cjs agent tools --save --out <plugin-dir>/tools.snapshot.json
```

### 两步式费用确认

`camptv_generate_image` / `camptv_generate_video` 首次调用会返回
`status: "requires_confirmation"`，附带 `summary`、`estimatedCredits`
（平台无法估算时可能缺省）、`estimateNote` 与 `confirm_token`。此步骤不会
创建任何内容，也不扣费。模型会把费用告知用户。用户同意后，模型以**完全相同的
参数**再次调用，并加上 `confirm_token`（有效期约 10 分钟；参数变化会使令牌
失效并返回新的报价）。

带有 `generation:auto-confirm` 作用域的令牌会跳过报价环节：服务端在首次调用
时直接提交。请只为用户已事先接受平台计费的无人工介入自动化场景签发该作用域。

### 回退到旧流程

插件按 CLI 文件版本探测一次（`agent tools --json --save`）。在以下情况会回退
到后文的旧流程（`node create` → `node submit` → `node wait --download`，
工具名与结果保持一致）：

- CLI 没有 `agent` 命令（统一目录之前的版本）。该结果会缓存，直到
  `cli.cjs` 发生变化。
- 服务端没有 `/mcp` 端点，或其目录中没有该工具。CLI 以退出码 `69` 和
  `status: "unavailable"` 结束，结果缓存 10 分钟。退出码 69 只会在提交任何
  内容之前抛出，因此回退不会造成重复提交。
- 探测遇到网络或鉴权错误。此时会走旧流程，让常见的错误信息显现出来，同时
  探测在 60 秒后重试。
- 设置了 `unifiedTools: off`。

旧流程没有报价步骤；`confirm_token` 会被忽略，生成直接提交，行为与以往
一致。统一调用如果已提交后才失败（例如生成本身失败），会作为错误上报，绝不
会再经旧流程重试。

## 前置条件

1. Node.js 20+（插件也会探测 DSH 桌面应用内置的 Node 运行时，因此通常无需
   单独安装）。
2. CampTV CLI，需下载并校验校验和，且已登录一次：

   ```sh
   mkdir -p ~/.camptv/bin
   cd ~/.camptv/bin
   curl -fL https://aivideobox.mammothble.com/cli/download/cli.cjs -o cli.cjs
   curl -fL https://aivideobox.mammothble.com/cli/download/manifest.json -o manifest.json
   node -e "const fs=require('node:fs'),c=require('node:crypto'),m=JSON.parse(fs.readFileSync('manifest.json'));if(c.createHash('sha256').update(fs.readFileSync('cli.cjs')).digest('hex')!==m.sha256)process.exit(1)"
   node cli.cjs login --url https://aivideobox.mammothble.com --token-file /path/to/token.txt
   node cli.cjs whoami
   ```

   账户令牌由 CLI 保存在 `~/.camptv/config.json`；本插件从不读取、复制或
   记录它。从 CampTV `/cli` 页面自助创建的凭据有效期为 30 天，且可在该页面
   吊销；带 `generation:auto-confirm` 作用域的令牌还可以设置每日积分上限
   （默认 2,000，最高 1,000,000，以 Asia/Shanghai 时区划分日期）。

## 安装

本仓库即插件源码，未发布到 npm。克隆仓库，并把检出目录添加到 DSH profile：

```sh
git clone https://github.com/WuweiRE/dsh-camptv.git
dsh plugin --profile <profile> add ./dsh-camptv
```

随后重启 Harness；bundle 行会被写入 profile patch，工具会为 profile 中的
每个 agent 注册。日后更新时，拉取检出目录并重启即可。

## 配置

所有字段都是可选的。在 profile 的 `cordis.patch.yml` 中插入行的位置设置：

```yaml
- id: dsh-camptv
  name: dsh-camptv
  config:
    imageChannel: economy
    videoChannel: economy
    outputDir: camptv-output
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `cliPath` | `~/.camptv/bin/cli.cjs` | 已验证的 CLI 入口路径。 |
| `cliConfigPath` | CLI 默认（`~/.camptv/config.json`） | 设置后以 `CAMPTV_CLI_CONFIG` 传入。 |
| `nodePath` | 自动检测 | Node.js 可执行文件；自动检测覆盖 DSH 内置运行时、常见安装位置、`PATH` 以及 Electron 即 Node 的情况。 |
| `outputDir` | `camptv-output` | 结果目录；相对路径相对于会话工作目录解析。 |
| `project` | 自动 | 默认画布 id。为空时，插件复用/创建 `DSH 生成` 项目（使用稳定的 client key）。 |
| `imageModel` | `gpt-image-2.5-flare` | 默认图像模型；留空则由 CLI 选择。 |
| `videoModel` | 空 | 默认视频模型；留空则使用渠道默认值（economy: MiniMax H3，priority: Seedance 2.0）。 |
| `imageChannel` | `economy` | 图像路由：`economy` = 优惠渠道（`RH低价`/shared），`priority` = 正价渠道（`RH官方`/official）。 |
| `videoChannel` | `economy` | `economy`（优惠渠道 / LibTV，有月度配额）或 `priority`（正价渠道 / RunningHub）。 |
| `imageWaitMs` | `300000` | 单次图像生成的等待预算（priority/正价渠道可能需要数分钟）。 |
| `videoWaitMs` | `600000` | 单次视频生成的等待预算。 |
| `taskWaitMs` | `600000` | `camptv_task` 的默认等待预算。 |
| `pollIntervalMs` | `2500` | 节点状态轮询间隔。 |
| `submitTimeoutMs` | `90000` | 非生成等待的单次 CLI 调用超时。 |
| `inlineImages` | `true` | 当前模型接受图像输入时，把生成的图像附加到工具结果中。 |
| `maxInlineImageBytes` | `8388608` | 图像文件大于该值时不再内联附加。 |
| `enableImage` / `enableVideo` / `enableTask` / `enableProjects` | `true` | 注册或省略对应工具。 |
| `unifiedTools` | `auto` | `auto`：CLI 与服务端都支持时使用统一目录，否则走旧流程。`off`：始终走旧流程。 |
| `canvasTools` | `auto` | 底层目录工具。`auto`：用户快照存在时注册。`on` / `off`：始终 / 从不。 |
| `toolsSnapshotPath` | `~/.camptv/agent-tools.json` | 加载时读取的用户级目录快照，由探测刷新。 |

## 使用示例

```text
camptv_generate_image({ prompt: "A serene Chinese ink painting of mountains at sunrise", ratio: "16:9" })
camptv_generate_image({ prompt: "Turn this into a warm autumn poster", reference_images: ["refs/lantern.png"], channel: "economy" })
camptv_generate_image({ prompt: "High-end product shot of the reference object", reference_images: ["refs/product.png"], channel: "priority" })
camptv_generate_video({ prompt: "A slow cinematic drone shot over misty green mountains at dawn", channel: "economy", duration: 5, ratio: "16:9", resolution: "768P" })
camptv_generate_video({ prompt: "Same character and camera move as the references", reference_images: ["refs/hero.png"], reference_videos: ["refs/move.mp4"], channel: "economy", duration: 5, resolution: "768P" })
camptv_generate_video({ prompt: "The lantern slowly rises into the dusk sky", first_frame: "refs/lantern.png", duration: 5, resolution: "768P" })
camptv_task({ project: "<project-id>", node: "<node-id>", wait: true })
camptv_projects({})
```

### 旧流程细节

CampTV 平台的生成是异步的。`camptv_generate_*` 会提交任务、轮询节点并下载
完成的文件；如果等待预算耗尽，它会返回 `status: "pending"` 以及
`projectId` 和 `nodeId`，模型随后用 `camptv_task` 继续处理，而不是重新提交
（提交是计费的）。

两个生成工具都使用两步 CLI 调用——先用全部设置与参考上传执行
`node create`，再在不覆盖 config 的情况下执行 `node submit`。这源于两个平台
限制：在 create-node 的 submit 覆盖中 `outputFormat` 会被拒绝；参考必须在
节点提交前连接到该节点。参考文件通过 `asset upload --create-node` 上传，并用
`--source <asset-node>:<slot>` 连接（`referenceImages`、`referenceVideo`、
`firstFrame`、`lastFrame`）。下载文件的扩展名会根据其实际字节内容归一化。
`quality` 和 `output_format` 只是建议值：某些图像模型会保留自己的质量档位
（`gpt-image-2.5-flare` 无论请求哪一档都报告 `high`）。

图像渠道映射：`economy` → `RH低价`（`runninghub-global:shared`），
`priority` → `RH官方`（`runninghub-global:official`）。视频渠道映射使用
CLI 自身的 `economy` → LibTV、`priority` → RunningHub。

### 透明精灵图与 GPT Image 2.5

CampTV GPT Image 2.5 economy 只发送 prompt、imageUrls、aspectRatio 与
resolution。该路由会丢弃 quality、background 与 outputFormat（CampTV
gpt-image25.ts 的 buildGptImage25EconomyBody）。如果提示词随后仍写着透明背景，
模型会在 RGB 文件中画出棋盘格，而不是返回真正的 alpha。

真正的透明 PNG 需要 gpt-image-2.5-flare、channel=priority、
background=transparent、output_format=png、quality=high。当 background 已设置
时，不要在提示词中再写透明背景。Banana 从不返回真正的 alpha；请使用 chroma-key
颜色。插件现在会拒绝在 economy GPT Image 2.5 与 Banana 上使用
background=transparent，并在请求的透明 PNG 没有 alpha 通道时于下载后发出警告。
GPT Image 2.5 还接受额外的长条画幅比例 3:1、2:1、1:3、1:2、9:21，以及
1k/2k/4k 分辨率。

## 已验证行为

已在本 profile 上通过注册的工具做过端到端验证：

- `camptv_projects` 返回画布列表以及视频渠道配额。
- `camptv_generate_image` 文生图创建了节点、提交任务、等待完成，把 PNG
  下载到 `camptv-output/`，并以原生图像块返回给支持图像输入的模型。
- `camptv_generate_image` 图生图使用本地 `reference_images` 文件上传素材、
  连接到 `referenceImages`，并在 **economy** 渠道（`executionRoute:
  runninghub-global:shared`）上生成了换风格后的图像。
- 同样的参考图请求在 **priority** 渠道上生成了
  `executionRoute: runninghub-global:official` 的图像；由于该路由耗时超过了
  旧的 180 秒预算，工具返回 `pending`，由 `camptv_task` 完成并下载（现在的
  默认图像预算为 300 秒）。
- `camptv_generate_video` 在 economy 渠道使用 `reference_images` +
  `reference_videos`，上传了两个素材并分别连接到 `referenceImages` /
  `referenceVideo`，生成了 5 秒 768P 视频（`videoMode: reference-video`、
  `videoModelSupplier: libtv`），并下载了 MP4。
- `first_frame` / `last_frame` 输入使用相同的上传并连接路径（已在节点创建
  阶段验证；没有为其额外执行计费生成）。
- CLI 完整性：`cli.cjs` 的 sha256 与 `manifest.json` 匹配（v0.6.432）；
  `whoami` 报告了 `read:self` + `generation:submit` 作用域。

## 耦合与限制

- 插件刻意**不导入** Harness 包集合中的任何模块（只用 `node:` 内置模块）：
  工具定义以原始、经注册表校验的 JSON Schema 注册。这使本地 bundle 不受
  profile 导入路由的影响，始终可加载。
- 参考数量取决于模型（例如 GPT Image 最多 16 张参考图、Seedance 2.0 最多 9
  张图、economy MiniMax H3 最多 9 张图和 3 段视频）。工具会拦截明显的超限，
  但精确的模型限制由平台校验。
- economy 渠道受月度配额与各渠道并发数限制；`camptv_projects` 会在提交前
  报告这两项。
- 自测（mock 服务端、统一与旧流程两条路径）位于 CampTV 开发仓库，不在本插件
  内。
- 生成与快速处理均按登录账户的平台规则通过 CampTV 计费。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
