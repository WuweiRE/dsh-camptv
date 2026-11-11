# dsh-camptv

English | [简体中文](README.zh.md)

CampTV image and video generation tools for DeepSeek Harness. The bundle wraps
the [CampTV CLI](https://aivideobox.mammothble.com/cli) and gives every model in
the profile four tools:

| Tool | What it does |
|---|---|
| `camptv_generate_image` | Text-to-image and image-to-image on a CampTV canvas, economy or priority channel; uploads optional reference images, downloads the result into the workspace and returns its path (plus the image itself for image-capable models). |
| `camptv_generate_video` | Text/reference-to-video on the economy or priority channel; accepts reference images, reference videos, and first/last frame images, waits within its budget, or returns ids for `camptv_task`. |
| `camptv_task` | Check, wait for, and download a generation node later. |
| `camptv_projects` | List canvas ids, video-channel quota, and generation concurrency. |

## Unified tool catalog

CampTV exposes one Agent tool catalog: the server's MCP `tools/list`
(`POST <server>/mcp`, `Authorization: Bearer ctv_…`). MCP clients, the CampTV
CLI (`agent tools` / `agent call`) and this plugin use the same tool names,
parameters and results. The plugin:

- Registers tools synchronously from `tools.snapshot.json` (bundled), or from
  `~/.camptv/agent-tools.json` when that file is at least as new. The CLI
  writes that file with `node cli.cjs agent tools --save`; the plugin also
  refreshes it on its first successful capability probe.
- Runs every call as `node cli.cjs agent call <tool> --args-file <tmp>
  [--wait --wait-ms <budget>] [--download-dir <outputDir>]`. Arguments go
  through a private temp file that is deleted after the call. File arguments
  (named by the catalog's `_meta["camptv/fileArgs"]`) are resolved against the
  session working directory, then the CLI reads them inline (at most 20 MB
  each). Canvas node UUIDs pass through unchanged.
- Keeps host features from before: session cwd, `outputDir`, inline image
  attachments, the transparent-PNG route checks and alpha warning, and call cards.
- Also registers the low-level catalog tools (`camptv_whoami`,
  `camptv_get_canvas`, `camptv_create_node`, `camptv_canvas_edit`, …). With
  `canvasTools: auto` this happens once `~/.camptv/agent-tools.json` exists,
  which shows the CLI and server support the catalog. Changes take effect after
  the plugin reloads.

Regenerate the bundled snapshot against an upgraded server with:

```sh
node ~/.camptv/bin/cli.cjs agent tools --save --out <plugin-dir>/tools.snapshot.json
```

### Two-step cost confirmation

`camptv_generate_image` / `camptv_generate_video` first return
`status: "requires_confirmation"` with `summary`, `estimatedCredits` (may be
absent when the platform cannot estimate), `estimateNote` and `confirm_token`.
Nothing is created or charged at this step. The model tells the user the cost.
After the user agrees, it calls again with **the same arguments** plus
`confirm_token` (valid about 10 minutes; changing arguments invalidates it and
returns a fresh quote).

Tokens issued with the `generation:auto-confirm` scope skip the quote: the
server submits on the first call. Issue that scope only for unattended
automation where the user has accepted platform billing up front.

### Fallback to the legacy flow

The plugin probes once per CLI file version with `agent tools --json --save`.
It falls back to the legacy flow below (`node create` → `node submit` →
`node wait --download`, same tool names and results) in these cases:

- The CLI has no `agent` command (CLI before the unified catalog). Cached
  until `cli.cjs` changes.
- The server has no `/mcp` endpoint, or the tool is not in its catalog. The CLI
  exits with code `69` and `status: "unavailable"`, and the result is cached
  for 10 minutes. Exit 69 is only raised before anything is submitted, so the
  fallback cannot double-submit.
- The probe hits a network or auth error. The legacy path runs so its usual
  error shows up, and the probe retries after 60 s.
- `unifiedTools: off` is set.

On the legacy path there is no quote step; `confirm_token` is ignored and
generation submits directly, as before. A unified call that fails after
submission (for example, the generation failed) is reported as an error and
never retried through the legacy path.

## Prerequisites

1. Node.js 20+ (the plugin also probes the Node runtime bundled with the DSH
   desktop app, so a separate install is usually not needed).
2. The CampTV CLI, downloaded and checksum-verified, logged in once:

   ```sh
   mkdir -p ~/.camptv/bin
   cd ~/.camptv/bin
   curl -fL https://aivideobox.mammothble.com/cli/download/cli.cjs -o cli.cjs
   curl -fL https://aivideobox.mammothble.com/cli/download/manifest.json -o manifest.json
   node -e "const fs=require('node:fs'),c=require('node:crypto'),m=JSON.parse(fs.readFileSync('manifest.json'));if(c.createHash('sha256').update(fs.readFileSync('cli.cjs')).digest('hex')!==m.sha256)process.exit(1)"
   node cli.cjs login --url https://aivideobox.mammothble.com --token-file /path/to/token.txt
   node cli.cjs whoami
   ```

   The account token is stored by the CLI in `~/.camptv/config.json`; this
   plugin never reads, copies, or logs it. Self-serve credentials created on the
   CampTV `/cli` page are valid for 30 days and can be revoked there, and a
   token issued with the `generation:auto-confirm` scope can be given a daily
   credit limit (default 2,000, maximum 1,000,000, with the day boundary in
   Asia/Shanghai).

## Install

This repository is the plugin source; it is not published to npm. Clone it and
add the checkout to a DSH profile:

```sh
git clone https://github.com/WuweiRE/dsh-camptv.git
dsh plugin --profile <profile> add ./dsh-camptv
```

Restart the Harness afterwards; the bundle row is added to the profile patch
and the tools are registered for every agent in the profile. To update later,
pull the checkout and restart.

## Configuration

All fields are optional. Set them on the inserted row in the profile's
`cordis.patch.yml`:

```yaml
- id: dsh-camptv
  name: dsh-camptv
  config:
    imageChannel: economy
    videoChannel: economy
    outputDir: camptv-output
```

| Field | Default | Meaning |
|---|---|---|
| `cliPath` | `~/.camptv/bin/cli.cjs` | Path to the verified CLI entry. |
| `cliConfigPath` | CLI default (`~/.camptv/config.json`) | Passed as `CAMPTV_CLI_CONFIG` when set. |
| `nodePath` | auto-detect | Node.js executable; auto-detection covers the bundled DSH runtime, common install locations, `PATH`, and Electron-as-Node. |
| `outputDir` | `camptv-output` | Result directory; relative paths resolve against the session working directory. |
| `project` | auto | Default canvas id. When empty, the plugin reuses/creates the `DSH 生成` project (stable client key). |
| `imageModel` | `gpt-image-2.5-flare` | Default image model; empty lets the CLI choose. |
| `videoModel` | empty | Default video model; empty uses the channel default (economy: MiniMax H3, priority: Seedance 2.0). |
| `imageChannel` | `economy` | Image route: `economy` = 优惠渠道 (`RH低价`/shared) or `priority` = 正价渠道 (`RH官方`/official). |
| `videoChannel` | `economy` | `economy` (优惠渠道 / LibTV, monthly quota) or `priority` (正价渠道 / RunningHub). |
| `imageWaitMs` | `300000` | Wait budget for one image generation (the priority/official route can take a few minutes). |
| `videoWaitMs` | `600000` | Wait budget for one video generation. |
| `taskWaitMs` | `600000` | Default wait budget for `camptv_task`. |
| `pollIntervalMs` | `2500` | Node status polling interval. |
| `submitTimeoutMs` | `90000` | Timeout for a single CLI call that is not a generation wait. |
| `inlineImages` | `true` | Attach generated images to the tool result when the current model accepts image input. |
| `maxInlineImageBytes` | `8388608` | Skip inline attachment for larger image files. |
| `enableImage` / `enableVideo` / `enableTask` / `enableProjects` | `true` | Register or omit the corresponding tool. |
| `unifiedTools` | `auto` | `auto`: use the unified catalog when CLI and server support it, else legacy. `off`: always legacy. |
| `canvasTools` | `auto` | Low-level catalog tools. `auto`: register when the user snapshot exists. `on` / `off`: always / never. |
| `toolsSnapshotPath` | `~/.camptv/agent-tools.json` | User-level catalog snapshot read at load and refreshed by the probe. |

## Usage examples

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

### Legacy flow details

Generation is asynchronous on the CampTV platform. `camptv_generate_*` submits a
job, polls the node, and downloads the finished file; if its wait budget expires
it returns `status: "pending"` with `projectId` and `nodeId`, and the model
continues with `camptv_task` instead of resubmitting (submissions are billed).

Both generation tools use two CLI steps — `node create` with all settings and
reference uploads, then `node submit` without a config override. Two platform
constraints drive this: `outputFormat` is rejected inside a create-node submit
override, and references must be connected to the node before it is submitted.
Reference files are uploaded through `asset upload --create-node` and wired with
`--source <asset-node>:<slot>` (`referenceImages`, `referenceVideo`, `firstFrame`,
`lastFrame`). The downloaded file's extension is normalized from its actual
bytes. `quality` and `output_format` are advisory: some image models keep their
own quality tier (`gpt-image-2.5-flare` reports `high` regardless of the
requested tier).

Image channel mapping: `economy` → `RH低价` (`runninghub-global:shared`),
`priority` → `RH官方` (`runninghub-global:official`). Video channel mapping is
the CLI's own `economy` → LibTV, `priority` → RunningHub.

### Transparent sprites and GPT Image 2.5

CampTV GPT Image 2.5 economy only sends prompt, imageUrls, aspectRatio and resolution.
quality, background and outputFormat are dropped on that route (CampTV gpt-image25.ts
buildGptImage25EconomyBody). If the prompt then says transparent background, the model
paints a checkerboard into an RGB file instead of returning true alpha.

True transparent PNG requires gpt-image-2.5-flare, channel=priority, background=transparent,
output_format=png, quality=high. Do not write transparent background in the prompt when
background is already set. Banana never returns true alpha; use a chroma-key color.
The plugin now refuses background=transparent on economy GPT Image 2.5 and on Banana,
and warns after download if a requested transparent PNG has no alpha channel.
GPT Image 2.5 also accepts extra strip ratios 3:1, 2:1, 1:3, 1:2, 9:21 plus resolution 1k/2k/4k.

## Verified behavior

Checked end-to-end through the registered tools on this profile:

- `camptv_projects` returns the canvas list plus the video-channel quota.
- `camptv_generate_image` text-to-image created a node, submitted the job, waited,
  downloaded a PNG into `camptv-output/`, and returned it as a native image block
  to an image-capable model.
- `camptv_generate_image` image-to-image with a local `reference_images` file
  uploaded the asset, wired it to `referenceImages`, and produced a restyled
  image on **economy** (`executionRoute: runninghub-global:shared`).
- The same reference request on **priority** produced an image with
  `executionRoute: runninghub-global:official`; because that route took over the
  old 180 s budget, the tool returned `pending` and `camptv_task` completed and
  downloaded it (default image budget is now 300 s).
- `camptv_generate_video` with `reference_images` + `reference_videos` on the
  economy channel uploaded both assets, wired them to `referenceImages` /
  `referenceVideo`, generated a 5 s 768P video (`videoMode: reference-video`,
  `videoModelSupplier: libtv`), and downloaded the MP4.
- `first_frame` / `last_frame` inputs use the same upload-and-connect path
  (verified at node creation; no extra billed generation was run for them).
- CLI integrity: `cli.cjs` sha256 matched `manifest.json` (v0.6.432); `whoami`
  reported `read:self` + `generation:submit` scopes.

## Coupling and limits

- The plugin intentionally has **no module imports** from the Harness package
  set (only `node:` built-ins): tool definitions are registered as raw, registry-validated JSON Schema.
  This keeps the local bundle loadable regardless of the profile's import
  routing.
- Reference counts are model-dependent (for example GPT Image up to 16 reference
  images, Seedance 2.0 up to 9 images, economy MiniMax H3 up to 9 images and 3
  videos). The tool caps obvious overflows but the platform validates the exact
  model limits.
- The economy channel is subject to monthly quota and per-channel concurrency;
  `camptv_projects` reports both before you submit.
- The self-test (mock server, unified and legacy paths) lives in the CampTV
  development repository, not in this plugin.
- Generation and quick-processing are billed through CampTV under the signed-in
  account's platform rules.

## License

MIT — see [LICENSE](LICENSE).
