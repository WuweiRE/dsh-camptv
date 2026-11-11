/**
 * dsh-camptv — CampTV image/video generation tools for DeepSeek Harness.
 *
 * The plugin wraps the CampTV CLI (`node cli.cjs <command> …`) and registers
 * four model-facing tools:
 *
 *   camptv_generate_image — text-to-image, downloads the result into the workspace
 *   camptv_generate_video — text-to-video (economy/priority channels)
 *   camptv_task           — check, wait for, and download a generation node
 *   camptv_projects       — list canvases and video-channel quota
 *
 * Unified path (preferred): tool definitions come from the CampTV unified Agent
 * tool catalog — the same list the server's MCP `tools/list` returns — shipped
 * as tools.snapshot.json (or the newer ~/.camptv/agent-tools.json written by
 * `cli.cjs agent tools --save`). Each call runs `cli.cjs agent call <tool>`;
 * generation tools return a quote first (requires_confirmation) unless the
 * token has the generation:auto-confirm scope. When the CLI has no `agent`
 * command or the server has no /mcp endpoint, the four tools fall back to the
 * legacy node/asset/job command flow with unchanged names and behavior.
 *
 * The CampTV account token never reaches this plugin: `camptv login` stores it in
 * the CLI's own config (~/.camptv/config.json) and every call reuses that file.
 *
 * @module dsh-camptv
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Cordis plugin name used by loader diagnostics. */
export const name = "dsh-camptv";

/** The model-facing tools require the tools registry. */
export const inject = ["tools"];

const DEFAULT_PROJECT_NAME = "DSH 生成";
const DEFAULT_PROJECT_KEY = "dsh-camptv-default";
const MAX_CLI_STDOUT = 8 * 1024 * 1024;
const MAX_CLI_STDERR = 256 * 1024;
const TERMINAL_FAILURES = new Set(["failed", "canceled", "cancelled"]);
const IMAGE_RATIOS = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "5:4",
  "4:5",
  "21:9",
  "9:21",
  "1:2",
  "2:1",
  "1:3",
  "3:1"
];
const VIDEO_RATIOS = ["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "21:9"];
const IMAGE_QUALITIES = ["low", "medium", "high", "xhigh", "max"];
const IMAGE_FORMATS = ["png", "jpeg", "webp"];
const IMAGE_RESOLUTIONS = ["1k", "2k", "4k", "1024px", "2048px", "4096px"];
const BACKGROUNDS = ["auto", "transparent", "opaque"];
const MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const CHANNELS = ["economy", "priority"];
/** Image execution routes: economy = 优惠渠道 (RH低价/shared), priority = 正价渠道 (RH官方/official). */
const IMAGE_CHANNEL_ROUTES = { economy: "RH低价", priority: "RH官方" };
const GPT_IMAGE25_MODELS = new Set([
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gpt-image-2",
  "gpt-image-2-official",
  "libtv-gpt-image-2"
]);
const BANANA_MODELS = new Set(["banana-2-pro", "banana-2"]);

const DEFAULTS = {
  cliPath: "",
  cliConfigPath: "",
  nodePath: "",
  outputDir: "camptv-output",
  project: "",
  imageModel: "gpt-image-2.5-flare",
  videoModel: "",
  imageChannel: "economy",
  videoChannel: "economy",
  imageWaitMs: 300000,
  videoWaitMs: 600000,
  taskWaitMs: 600000,
  pollIntervalMs: 2500,
  submitTimeoutMs: 90000,
  inlineImages: true,
  maxInlineImageBytes: 8 * 1024 * 1024,
  enableImage: true,
  enableVideo: true,
  enableTask: true,
  enableProjects: true,
  /** "auto": use the unified catalog when CLI + server support it, else legacy; "off": always legacy. */
  unifiedTools: "auto",
  /** Low-level catalog tools (create_node, canvas_edit, …): "auto" = when ~/.camptv/agent-tools.json exists. */
  canvasTools: "auto",
  toolsSnapshotPath: ""
};

/*
 * Settings are read from the row config in `cordis.patch.yml` (all fields are
 * optional; `normalizeSettings` applies the defaults above). The plugin does
 * not export a Config schema so it needs no module dependency on the Harness
 * package set: only the tool registry is injected by the Loader.
 */

/* -------------------------------------------------------------------------- */
/* small utilities                                                            */
/* -------------------------------------------------------------------------- */

function abortError() {
  const error = new Error("tool call aborted");
  error.name = "AbortError";
  return error;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function truncate(text, max) {
  const value = typeof text === "string" ? text.replace(/\s+/gu, " ").trim() : "";
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function requireText(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value, field, allowed) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (allowed !== undefined && !allowed.includes(trimmed)) {
    throw new Error(`${field} must be one of ${allowed.join(", ")}`);
  }
  return trimmed;
}

function optionalBoolean(value, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function optionalInteger(value, field, min, max) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value)) throw new Error(`${field} must be an integer`);
  if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
    throw new Error(`${field} must be between ${min} and ${max}`);
  }
  return value;
}

/**
 * Minimal local equivalent of the shipped `defineTool` helper: the definition
 * already uses the enforced raw JSON-Schema subset, so it can be registered
 * directly. Argument validation happens through the typed accessors above.
 */
function makeTool(options) {
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error(`dsh-camptv: tool "${options.name}" timeoutMs must be a positive finite number`);
  }
  const tool = {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: {
      schema: options.output.schema,
      render: options.output.render,
      ...(options.output.presentationMeta ? { presentationMeta: options.output.presentationMeta } : {})
    },
    execute: options.execute
  };
  if (options.timeoutMs !== undefined) tool.timeoutMs = options.timeoutMs;
  if (options.isConcurrencySafe) tool.isConcurrencySafe = options.isConcurrencySafe;
  if (options.presentCall) tool.presentCall = options.presentCall;
  if (options.presentResult) tool.presentResult = options.presentResult;
  return tool;
}

function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function stamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

function extensionForFormat(format) {
  if (format === "jpeg" || format === "jpg") return "jpg";
  if (format === "webp") return "webp";
  return "png";
}

function sniffImageMediaType(data) {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 12 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (data.length >= 6) {
    const head = data.toString("ascii", 0, 6);
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  return undefined;
}

/** True when a PNG has an alpha channel (color type 4 or 6 in IHDR). */
function pngHasAlpha(filePath) {
  try {
    const data = readFileSync(filePath);
    if (data.length < 26 || data[0] !== 0x89 || data[1] !== 0x50 || data[2] !== 0x4e || data[3] !== 0x47) return false;
    const colorType = data[25];
    return colorType === 4 || colorType === 6;
  } catch {
    return false;
  }
}

/**
 * Fail fast when the requested image settings cannot survive the chosen route.
 * CampTV GPT Image 2.5 economy (RH低价) only sends prompt/imageUrls/aspectRatio/resolution;
 * quality, background and outputFormat are dropped silently. Banana never supports true alpha.
 */
function assertImageRouteCapabilities({ model, channel, background, format, quality }) {
  const modelId = String(model ?? "").trim();
  if (background === "transparent" && format === "jpeg") {
    throw new Error("Transparent background requires PNG or WEBP, not JPEG.");
  }
  if (background === "transparent" && BANANA_MODELS.has(modelId)) {
    throw new Error(
      modelId + " does not support true transparent backgrounds. Ask for a flat chroma-key color in the prompt (for example #00FF00), or use gpt-image-2.5-flare with channel=priority, background=transparent, output_format=png."
    );
  }
  if (background === "transparent" && channel === "economy" && GPT_IMAGE25_MODELS.has(modelId)) {
    throw new Error(
      "GPT Image 2.5 on the economy channel (RH低价) silently drops background/quality/outputFormat. The model then paints a fake checkerboard instead of true alpha. Use channel=priority with background=transparent and output_format=png, or keep economy and ask for a flat chroma-key color in the prompt."
    );
  }
  if (channel === "economy" && GPT_IMAGE25_MODELS.has(modelId) && (quality || format === "jpeg" || format === "webp")) {
    return "GPT Image 2.5 economy (RH低价) does not send quality or outputFormat to the provider; only prompt, references, ratio and resolution apply.";
  }
  return undefined;
}

/** Align a downloaded image's extension with its actual bytes and return the final path. */
function normalizeImageExtension(filePath) {
  try {
    const mediaType = sniffImageMediaType(readFileSync(filePath));
    const extension =
      mediaType === "image/jpeg" ? "jpg" : mediaType === "image/webp" ? "webp" : mediaType === "image/gif" ? "gif" : mediaType === "image/png" ? "png" : undefined;
    if (extension === undefined) return filePath;
    const current = extname(filePath).slice(1).toLowerCase();
    const expected = extension === "jpg" ? ["jpg", "jpeg"] : [extension];
    if (expected.includes(current)) return filePath;
    const target = `${filePath.slice(0, filePath.length - extname(filePath).length)}.${extension}`;
    renameSync(filePath, target);
    return target;
  } catch {
    return filePath;
  }
}

/* -------------------------------------------------------------------------- */
/* subprocess plumbing                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Run one process to completion, capturing bounded stdout/stderr.
 * Resolves the parsed JSON stdout (or raw text with `parseJson: false`).
 */
function runProcess(command, args, options = {}) {
  const { signal, timeoutMs = 0, env, parseJson = true, rawExit = false, label = command } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    let child;
    try {
      child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      reject(new Error(`cannot start ${command}: ${error?.message ?? error}`));
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timer;
    const kill = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };
    const onAbort = () => {
      aborted = true;
      kill();
    };
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < MAX_CLI_STDOUT) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < MAX_CLI_STDERR) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => settle(reject, new Error(`cannot run ${command}: ${error.message}`)));
    child.on("close", (code, sig) => {
      if (aborted) return settle(reject, abortError());
      if (timedOut) return settle(reject, new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
      // rawExit: the caller interprets exit codes (`agent` uses 0/1/2/3/69).
      if (rawExit) return settle(resolve, { code, stdout: stdout.trim(), stderr: stderr.trim() });
      if (code !== 0) {
        const raw = stderr.trim() || stdout.trim();
        const detail = raw ? raw.slice(-2000) : `exit code ${code}${sig ? ` (${sig})` : ""}`;
        return settle(reject, new Error(detail));
      }
      const text = stdout.trim();
      if (!parseJson) return settle(resolve, { stdout: text, stderr: stderr.trim() });
      if (text === "") return settle(resolve, {});
      try {
        return settle(resolve, JSON.parse(text));
      } catch {
        return settle(reject, new Error(`camptv returned non-JSON output: ${text.slice(0, 500)}`));
      }
    });
  });
}

/** Candidate Node.js executables, most reliable first. */
function nodeCandidates(settings) {
  const list = [];
  const seen = new Set();
  const add = (command, prefixArgs = [], env = {}) => {
    if (!command) return;
    const key = `${command}\u0000${prefixArgs.join("\u0000")}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ command, prefixArgs, env });
  };
  if (settings.nodePath) add(settings.nodePath);
  if (process.env.CAMPTV_NODE) add(process.env.CAMPTV_NODE);
  // The desktop app ships a Node runtime beside its executable.
  try {
    const resources = join(dirname(process.execPath), "..", "Resources");
    add(join(resources, "runtime", "primary-runtime", "dependencies", "node", "bin", "node"));
    add(join(resources, "runtime", "bin", "node"));
  } catch {
    /* not a packaged desktop app */
  }
  add(join(homedir(), ".local", "node", "bin", "node"));
  add("/opt/homebrew/bin/node");
  add("/usr/local/bin/node");
  add("/usr/bin/node");
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir) add(join(dir, "node"));
  }
  // Last resort: run the Electron binary in Node mode.
  if (process.versions.electron) add(process.execPath, [], { ELECTRON_RUN_AS_NODE: "1" });
  return list;
}

async function detectNode(settings) {
  const failures = [];
  for (const candidate of nodeCandidates(settings)) {
    try {
      const env = { ...process.env, ...candidate.env };
      if (settings.cliConfigPath) env.CAMPTV_CLI_CONFIG = settings.cliConfigPath;
      const probe = await runProcess(candidate.command, [...candidate.prefixArgs, "--version"], {
        env,
        timeoutMs: 10000,
        parseJson: false,
        label: `${candidate.command} --version`
      });
      if (!/^v\d+\./u.test(probe.stdout)) throw new Error(`unexpected version output: ${probe.stdout.slice(0, 80)}`);
      return { command: candidate.command, prefixArgs: candidate.prefixArgs, env };
    } catch (error) {
      failures.push(`${candidate.command}: ${error?.message ?? error}`);
    }
  }
  throw new Error(
    `dsh-camptv: no usable Node.js runtime found (CampTV CLI needs Node.js 20+). Install Node.js or set the plugin config "nodePath". Tried:\n${failures.join("\n")}`
  );
}

/** The CLI runner: resolves Node once, then runs `node cli.cjs …`. */
function createCliRunner(settings) {
  let nodePlan;
  const plan = async () => {
    if (!nodePlan) {
      nodePlan = detectNode(settings);
      nodePlan.catch(() => {
        nodePlan = undefined;
      });
    }
    return await nodePlan;
  };
  return {
    settings,
    async run(args, options = {}) {
      if (!existsSync(settings.cliPath)) {
        throw new Error(
          `dsh-camptv: CampTV CLI not found at ${settings.cliPath}. Download cli.cjs and manifest.json from https://aivideobox.mammothble.com/cli, verify the sha256 from manifest.json, and point the plugin config "cliPath" at cli.cjs.`
        );
      }
      const node = await plan();
      return runProcess(node.command, [...node.prefixArgs, settings.cliPath, ...args], {
        env: { ...node.env, ...(options.env ?? {}) },
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? settings.submitTimeoutMs,
        rawExit: options.rawExit === true,
        label: `camptv ${args.slice(0, 2).join(" ")}`
      });
    }
  };
}

/* -------------------------------------------------------------------------- */
/* projects and workspace output                                              */
/* -------------------------------------------------------------------------- */

function createProjectManager(runner, settings) {
  let cached = settings.project || undefined;
  let pending;
  return {
    async resolve(override, signal) {
      const explicit = typeof override === "string" ? override.trim() : "";
      if (explicit) return explicit;
      if (cached) return cached;
      if (!pending) {
        pending = (async () => {
          if (settings.project) return settings.project;
          const listed = await runner.run(["project", "list"], { signal, timeoutMs: settings.submitTimeoutMs });
          const match = (Array.isArray(listed?.projects) ? listed.projects : []).find((project) => project?.name === DEFAULT_PROJECT_NAME);
          if (match?.id) return match.id;
          const created = await runner.run(
            ["project", "create", "--name", DEFAULT_PROJECT_NAME, "--client-project-key", DEFAULT_PROJECT_KEY],
            { signal, timeoutMs: settings.submitTimeoutMs }
          );
          const id = created?.project?.id;
          if (!id) throw new Error("dsh-camptv: could not create the default CampTV project");
          return id;
        })().finally(() => {
          pending = undefined;
        });
      }
      cached = await pending;
      return cached;
    }
  };
}

function sessionCwd(ctx, exec) {
  let base = process.cwd();
  try {
    const workingDirectory = ctx.get("workingDirectory");
    if (workingDirectory) {
      const session = exec?.agent?.session;
      const sessionDir = session && typeof workingDirectory.get === "function" ? workingDirectory.get(session) : undefined;
      base = sessionDir || workingDirectory.defaultDirectory || base;
    }
  } catch {
    /* keep the process cwd */
  }
  return base;
}

function resolveOutputDir(ctx, settings, exec) {
  return isAbsolute(settings.outputDir) ? settings.outputDir : join(sessionCwd(ctx, exec), settings.outputDir);
}

/** Resolve one model-supplied reference path against the session working directory. */
function resolveInputPath(ctx, exec, value, field) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "") throw new Error(`${field} must be a non-empty file path`);
  const expanded = expandHome(raw);
  const target = isAbsolute(expanded) ? expanded : join(sessionCwd(ctx, exec), expanded);
  let info;
  try {
    info = statSync(target);
  } catch {
    throw new Error(`${field} file not found: ${target}`);
  }
  if (!info.isFile()) throw new Error(`${field} is not a regular file: ${target}`);
  return target;
}

function optionalPathList(value, field, max) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of file paths`);
  if (value.length > max) throw new Error(`${field} accepts at most ${max} files`);
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "") throw new Error(`${field}[${index}] must be a non-empty file path`);
    return entry.trim();
  });
}

/** Upload one local reference file as a completed asset node and return its node id. */
async function uploadReference(runner, settings, exec, projectId, filePath, field) {
  const result = await runner.run(["asset", "upload", "--project", projectId, "--file", filePath, "--create-node"], {
    signal: exec.signal,
    timeoutMs: 300000
  });
  const nodeId = result?.node?.id;
  if (typeof nodeId !== "string") {
    throw new Error(`CampTV did not return an asset node for ${field}: ${JSON.stringify(result).slice(0, 400)}`);
  }
  return nodeId;
}

/** Upload every reference and build the `--source nodeId:slot` pairs for node creation. */
async function buildReferenceSources(ctx, runner, settings, exec, projectId, references) {
  const args = [];
  for (const reference of references) {
    const absolute = resolveInputPath(ctx, exec, reference.path, reference.field);
    const nodeId = await uploadReference(runner, settings, exec, projectId, absolute, reference.field);
    args.push("--source", `${nodeId}:${reference.slot}`);
  }
  return args;
}

/* -------------------------------------------------------------------------- */
/* node polling / downloading                                                 */
/* -------------------------------------------------------------------------- */

async function readNode(runner, settings, exec, projectId, nodeId) {
  return runner.run(["node", "output", "--project", projectId, "--node", nodeId], {
    signal: exec.signal,
    timeoutMs: 60000
  });
}

async function generationFailure(runner, settings, exec, { projectId, nodeId, jobId }, output) {
  let detail = "";
  if (jobId) {
    try {
      const job = await runner.run(["job", "status", jobId], { signal: exec.signal, timeoutMs: 45000 });
      detail = [job?.errorTitle, job?.errorExplanation, job?.error, job?.rawError]
        .filter((value) => typeof value === "string" && value.trim())
        .join(" — ");
    } catch {
      /* fall through to node list */
    }
  }
  if (!detail) {
    try {
      const listed = await runner.run(["node", "list", "--project", projectId], { signal: exec.signal, timeoutMs: 60000 });
      const node = (Array.isArray(listed?.nodes) ? listed.nodes : []).find((entry) => entry?.id === nodeId);
      const config = node?.config ?? {};
      detail = [config.errorTitle, config.errorExplanation, config.error, config.rawError]
        .filter((value) => typeof value === "string" && value.trim())
        .join(" — ");
    } catch {
      /* keep the generic message */
    }
  }
  const status = output?.node?.status ?? "failed";
  return new Error(
    `CampTV generation ${status}${detail ? `: ${detail}` : ""} (project ${projectId}, node ${nodeId}). Do not resubmit blindly; inspect the node on the CampTV canvas or call camptv_task.`
  );
}

async function waitForNode(runner, settings, exec, projectId, nodeId, waitMs, initial, jobId) {
  const deadline = Date.now() + waitMs;
  let current = initial;
  while (true) {
    if (!current) current = await readNode(runner, settings, exec, projectId, nodeId);
    const status = current?.node?.status;
    if (status === "completed") return current;
    if (TERMINAL_FAILURES.has(status)) {
      throw await generationFailure(runner, settings, exec, { projectId, nodeId, jobId }, current);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return current;
    await sleep(Math.min(settings.pollIntervalMs, remaining), exec.signal);
    current = undefined;
  }
}

async function downloadNode(runner, settings, exec, projectId, nodeId, filePath) {
  ensureDir(dirname(filePath));
  const result = await runner.run(
    ["node", "wait", "--project", projectId, "--node", nodeId, "--download", filePath],
    { signal: exec.signal, timeoutMs: Math.max(120000, settings.submitTimeoutMs + 120000) }
  );
  return typeof result?.downloadedTo === "string" && result.downloadedTo ? result.downloadedTo : filePath;
}

/* -------------------------------------------------------------------------- */
/* optional inline image attachments                                          */
/* -------------------------------------------------------------------------- */

async function routeSupportsImage(ctx, exec) {
  try {
    const llm = ctx.get("llm");
    const agent = exec?.agent;
    if (!llm || !agent) return false;
    const routed = agent.session?.requestHeader?.()?.config;
    const provider = routed?.provider ?? agent.options?.provider;
    const model = routed?.model ?? agent.options?.model;
    if (typeof provider !== "string" || typeof model !== "string") return false;
    const info = await llm.resolveModelInfo(provider, model, exec.signal);
    return Array.isArray(info?.inputModalities) && info.inputModalities.includes("image");
  } catch {
    return false;
  }
}

async function attachImage(ctx, settings, exec, filePath) {
  if (!settings.inlineImages) return undefined;
  try {
    const attachments = ctx.get("attachments");
    if (!attachments) return undefined;
    const info = statSync(filePath);
    if (!info.isFile() || info.size <= 0 || info.size > settings.maxInlineImageBytes) return undefined;
    if (!(await routeSupportsImage(ctx, exec))) return undefined;
    const data = readFileSync(filePath);
    const mediaType = sniffImageMediaType(data);
    if (!mediaType) return undefined;
    const ref = await attachments.saveImage({ data, mediaType, name: basename(filePath) });
    return {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...(ref.name ? { name: ref.name } : {})
    };
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* result values and formatting                                               */
/* -------------------------------------------------------------------------- */

function buildGenerationValue(kind, fields) {
  const value = { status: fields.status, kind, projectId: fields.projectId, nodeId: fields.nodeId };
  for (const key of ["jobId", "file", "model", "channel", "duration", "ratio", "resolution", "message"]) {
    if (fields[key] !== undefined) value[key] = fields[key];
  }
  if (fields.image !== undefined) value.image = fields.image;
  return value;
}

const IMAGE_VALUE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["attachmentId", "mediaType", "bytes", "width", "height"],
  properties: {
    attachmentId: { type: "string" },
    mediaType: { type: "string", enum: MEDIA_TYPES },
    bytes: { type: "integer" },
    width: { type: "integer" },
    height: { type: "integer" },
    name: { type: "string" }
  }
};

const GENERATION_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "kind"],
  properties: {
    status: { type: "string", enum: ["completed", "pending", "requires_confirmation"] },
    kind: { type: "string", enum: ["image", "video", "audio"] },
    projectId: { type: "string" },
    nodeId: { type: "string" },
    jobId: { type: "string" },
    file: { type: "string" },
    model: { type: "string" },
    channel: { type: "string" },
    duration: { type: "integer" },
    ratio: { type: "string" },
    resolution: { type: "string" },
    message: { type: "string" },
    image: IMAGE_VALUE_SCHEMA,
    estimatedCredits: { type: "number" },
    estimateNote: { type: "string" },
    summary: { type: "string" },
    confirm_token: { type: "string" },
    tool: { type: "string" }
  }
};

const CONFIRM_TOKEN_PARAM = {
  type: "string",
  description:
    "Token from a previous requires_confirmation result. Pass it, with exactly the same other arguments, only after the user has agreed to the quoted cost."
};
const CONFIRM_NOTE =
  " Cost confirmation: unless the CampTV token has the generation:auto-confirm scope, the first call returns status requires_confirmation with a quote (estimatedCredits, summary, confirm_token) and nothing is charged; tell the user the cost, and only after they agree call again with the same arguments plus confirm_token.";
const PLUGIN_ONLY_ARGS = new Set(["wait", "auto_confirm_prompt", "download", "timeout_ms", "kind", "include_quota"]);

function withoutPluginArgs(args) {
  const out = {};
  for (const [key, value] of Object.entries(args ?? {})) if (!PLUGIN_ONLY_ARGS.has(key)) out[key] = value;
  return out;
}

function renderGeneration(value) {
  const blocks = [{ type: "text", text: formatGeneration(value) }];
  if (value.image) blocks.push({ type: "image", attachment: value.image });
  return blocks;
}

function formatGeneration(value) {
  if (value.status === "requires_confirmation") {
    const credits = value.estimatedCredits === undefined ? "unknown" : String(value.estimatedCredits);
    const lines = [
      "CampTV quote — nothing has been submitted or charged yet.",
      `Summary: ${value.summary || value.kind}`,
      `Estimated credits: ${credits}${value.estimateNote ? ` (${value.estimateNote})` : ""}`,
      `Tell the user this cost and ask whether to proceed. Only after they agree, call ${value.tool} again with exactly the same arguments plus confirm_token="${value.confirm_token}" (valid about 10 minutes). Never pass confirm_token without the user's consent.`
    ];
    if (value.message) lines.push(value.message);
    return lines.join("\n");
  }
  if (value.status === "pending") {
    const lines = [
      `CampTV ${value.kind} generation is still running (project ${value.projectId}, node ${value.nodeId}). Call camptv_task with these ids to wait for and download the result; do not resubmit.`
    ];
    if (value.message) lines.push(value.message);
    return lines.join("\n");
  }
  const lines = [`Generated ${value.kind} saved to ${value.file}`];
  const meta = [];
  if (value.model) meta.push(`model: ${value.model}`);
  if (value.channel) meta.push(`channel: ${value.channel}`);
  if (value.duration) meta.push(`duration: ${value.duration}s`);
  if (value.ratio) meta.push(`ratio: ${value.ratio}`);
  if (value.resolution) meta.push(`resolution: ${value.resolution}`);
  meta.push(`project: ${value.projectId}`, `node: ${value.nodeId}`);
  lines.push(meta.join(" · "));
  if (value.kind === "video") lines.push("The saved file can be previewed with present or opened from the workspace.");
  if (value.message) lines.push(value.message);
  return lines.join("\n");
}

function outputExtension(current, kind) {
  const url = current?.output?.history?.[0]?.url ?? current?.output?.assetUrl ?? "";
  const raw = typeof url === "string" ? url.split("?")[0] : "";
  const ext = extname(raw).toLowerCase();
  if (/^\.[a-z0-9]{2,5}$/u.test(ext)) return ext.slice(1);
  if (kind === "video") return "mp4";
  if (kind === "audio") return "mp3";
  return "png";
}

function kindFromOutput(current, fallback) {
  const type = current?.node?.type;
  if (type === "image" || type === "video" || type === "audio") return type;
  const historyType = current?.output?.history?.[0]?.type;
  if (historyType === "image" || historyType === "video" || historyType === "audio") return historyType;
  return fallback;
}

/**
 * Poll (when requested), then shape the terminal result: download the file and
 * attach the image when the current model accepts image input.
 */
async function collectGeneration(deps, exec, options) {
  const { ctx, settings, runner } = deps;
  const { kind, projectId, nodeId, jobId, model, channel, duration, ratio, resolution } = options;
  let current = options.initial;
  if (!current) current = await readNode(runner, settings, exec, projectId, nodeId);
  const firstStatus = current?.node?.status;
  if (options.wait && firstStatus !== "completed" && !TERMINAL_FAILURES.has(firstStatus)) {
    current = await waitForNode(runner, settings, exec, projectId, nodeId, options.waitMs, current, jobId);
  }
  const status = current?.node?.status;
  if (TERMINAL_FAILURES.has(status)) {
    throw await generationFailure(runner, settings, exec, { projectId, nodeId, jobId }, current);
  }
  const base = { projectId, nodeId, jobId, model, channel, duration, ratio, resolution };
  if (status !== "completed") {
    return buildGenerationValue(kind, {
      ...base,
      status: "pending",
      message: `Node status is "${status ?? "unknown"}". It is still queued or running; call camptv_task to collect the result later.`
    });
  }
  if (options.download === false) {
    return buildGenerationValue(kind, {
      ...base,
      status: "completed",
      message: "The result is ready but was not downloaded (download=false). Call camptv_task with download=true to save the file."
    });
  }
  const filePath = options.filePath ?? join(ensureDir(resolveOutputDir(ctx, settings, exec)), `${kind}-${stamp()}-${randomUUID().slice(0, 8)}.${kind === "video" ? "mp4" : "png"}`);
  const downloaded = await downloadNode(runner, settings, exec, projectId, nodeId, filePath);
  return completedValue(deps, exec, kind, base, downloaded, options);
}

/* -------------------------------------------------------------------------- */
/* unified tool catalog (CLI `agent` command + server /mcp)                    */
/* -------------------------------------------------------------------------- */

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const BUNDLED_SNAPSHOT = join(PLUGIN_DIR, "tools.snapshot.json");
const DEFAULT_USER_SNAPSHOT = join(homedir(), ".camptv", "agent-tools.json");
const HIGH_LEVEL_TOOLS = new Set(["camptv_projects", "camptv_generate_image", "camptv_generate_video", "camptv_task"]);
const GENERATION_TOOL_BY_KIND = { image: "camptv_generate_image", video: "camptv_generate_video" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** `cli.cjs agent` exit code: no /mcp endpoint or tool not in the catalog; raised only before anything is submitted. */
const AGENT_EXIT_UNAVAILABLE = 69;
/** Keywords kept when turning catalog schemas into registered tool parameters. */
const SCHEMA_KEYS = new Set(["type", "description", "enum", "items", "properties", "required", "additionalProperties"]);
const DEFAULT_FILE_ARGS = {
  camptv_generate_image: { reference_images: "image[]" },
  camptv_generate_video: { reference_images: "image[]", reference_videos: "video[]", first_frame: "image", last_frame: "image" }
};
const FILE_ARG_KINDS = new Set(["image", "image[]", "video", "video[]"]);
const FALLBACK = Symbol("dsh-camptv legacy fallback");

function tryParseJson(text) {
  if (typeof text !== "string" || text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function readSnapshotFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const list = Array.isArray(parsed) ? parsed : parsed?.tools;
    if (!Array.isArray(list)) return undefined;
    const tools = list.filter((tool) => tool && typeof tool.name === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(tool.name));
    if (tools.length === 0) return undefined;
    const generated = Date.parse(parsed?.generatedAt ?? "");
    return { path, tools, time: Number.isFinite(generated) ? generated : statSync(path).mtimeMs };
  } catch {
    return undefined;
  }
}

/**
 * Synchronous on purpose: tools are registered during apply(). The user-level
 * snapshot (written by `agent tools --save`) wins when it is at least as new
 * as the bundled one.
 */
function loadToolCatalog(settings) {
  const bundled = readSnapshotFile(BUNDLED_SNAPSHOT);
  const user = readSnapshotFile(settings.toolsSnapshotPath || DEFAULT_USER_SNAPSHOT);
  const chosen = user && (!bundled || user.time >= bundled.time) ? user : bundled;
  const tools = new Map();
  for (const tool of chosen?.tools ?? []) tools.set(tool.name, tool);
  return { source: chosen?.path, hasUserSnapshot: Boolean(user), tools };
}

function sanitizeSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return {};
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!SCHEMA_KEYS.has(key)) continue;
    if (key === "properties" && value && typeof value === "object") {
      out.properties = {};
      for (const [prop, sub] of Object.entries(value)) out.properties[prop] = sanitizeSchema(sub);
    } else if (key === "items") {
      out.items = sanitizeSchema(value);
    } else {
      out[key] = value;
    }
  }
  // Schemas without a plain type (for example oneOf FileRef) degrade to string.
  if (out.type === undefined && out.enum === undefined) out.type = "string";
  return out;
}

function fileArgsFor(catalog, name) {
  const meta = catalog.tools.get(name)?._meta?.["camptv/fileArgs"];
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const out = {};
    for (const [key, kind] of Object.entries(meta)) if (FILE_ARG_KINDS.has(kind)) out[key] = kind;
    return out;
  }
  return DEFAULT_FILE_ARGS[name] ?? {};
}

function localFileSchema(kind, description) {
  const base = kind.replace("[]", "");
  const text = `${description ? `${description} ` : ""}Local ${base} file path (workspace-relative or absolute) or a CampTV canvas node id. Local files are read by the CampTV CLI, at most 20 MB each.`;
  return kind.endsWith("[]") ? { type: "array", items: { type: "string" }, description: text } : { type: "string", description: text };
}

/** Parameters for a catalog tool: sanitized schema with file arguments as local paths. */
function catalogParameters(entry, fileArgs) {
  const input = sanitizeSchema(entry?.inputSchema ?? { type: "object", properties: {} });
  const properties = { ...(input.properties ?? {}) };
  for (const [key, kind] of Object.entries(fileArgs)) properties[key] = localFileSchema(kind, properties[key]?.description);
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(Array.isArray(input.required) && input.required.length ? { required: input.required } : {})
  };
}

/** Legacy parameters stay authoritative (names, enums, descriptions); the catalog adds new fields. */
function mergeParameters(legacy, entry, fileArgs, extra = {}) {
  if (!entry) return { ...legacy, properties: { ...legacy.properties, ...extra } };
  const fromCatalog = catalogParameters(entry, fileArgs);
  return { ...legacy, properties: { ...fromCatalog.properties, ...legacy.properties, ...extra } };
}

/** Argument names the server accepts for a tool; undefined means "unknown, send everything". */
function allowedArgs(catalog, name) {
  const properties = catalog.tools.get(name)?.inputSchema?.properties;
  return properties && typeof properties === "object" ? new Set(Object.keys(properties)) : undefined;
}

function pickArgs(values, allowed) {
  const out = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (allowed && !allowed.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/** Make local file arguments absolute against the session cwd; node ids pass through. */
function resolveUnifiedFileArgs(ctx, exec, args, fileArgs) {
  const out = { ...args };
  const one = (value, field) => {
    const raw = typeof value === "string" ? value.trim() : "";
    return UUID_RE.test(raw) ? raw : resolveInputPath(ctx, exec, raw, field);
  };
  for (const [field, kind] of Object.entries(fileArgs)) {
    const value = out[field];
    if (value === undefined || value === null) continue;
    if (kind.endsWith("[]")) {
      if (!Array.isArray(value)) throw new Error(`${field} must be an array of file paths or node ids`);
      out[field] = value.map((entry, index) => one(entry, `${field}[${index}]`));
    } else {
      out[field] = one(value, field);
    }
  }
  return out;
}

/**
 * Decide once (per CLI file version) whether the unified path works. The probe
 * `agent tools --json --save` also refreshes the user-level snapshot.
 */
function createUnifiedState(runner, settings) {
  let state;
  let pending;
  const cliMtime = () => {
    try {
      return statSync(settings.cliPath).mtimeMs;
    } catch {
      return -1;
    }
  };
  const set = (ok, ttlMs, reason, mtime = cliMtime()) => {
    state = { ok, until: Date.now() + ttlMs, mtime, reason };
    return ok;
  };
  async function probe(mtime) {
    let result;
    try {
      const out = settings.toolsSnapshotPath ? ["--out", settings.toolsSnapshotPath] : [];
      result = await runner.run(["agent", "tools", "--json", "--save", ...out], { rawExit: true, timeoutMs: 45000 });
    } catch (error) {
      return set(false, 60000, `probe failed: ${error?.message ?? error}`, mtime);
    }
    const parsed = tryParseJson(result.stdout);
    if (result.code === 0 && Array.isArray(parsed)) return set(true, 30 * 60000, "", mtime);
    if (result.code === AGENT_EXIT_UNAVAILABLE) return set(false, 10 * 60000, parsed?.error ?? "server has no /mcp endpoint", mtime);
    // Old CLIs reject the unknown command with plain-text usage and no JSON on stdout.
    if (parsed === undefined) return set(false, Number.POSITIVE_INFINITY, "CampTV CLI has no agent command (update cli.cjs)", mtime);
    // Network/auth trouble: use the legacy path now so its usual error surfaces, retry soon.
    return set(false, 60000, parsed?.error ?? `agent tools exited ${result.code}`, mtime);
  }
  return {
    get reason() {
      return state?.reason ?? "";
    },
    markUnavailable(reason) {
      set(false, 10 * 60000, reason);
    },
    async available() {
      if (settings.unifiedTools === "off") return false;
      const mtime = cliMtime();
      if (mtime < 0) return false;
      if (state && state.mtime === mtime && Date.now() < state.until) return state.ok;
      if (!pending) {
        pending = probe(mtime).finally(() => {
          pending = undefined;
        });
      }
      return await pending;
    }
  };
}

/** Run `cli.cjs agent call`; arguments travel in a private temp file, never on the command line. */
async function runAgentCall(deps, exec, toolName, args, options) {
  const { ctx, settings, runner } = deps;
  const dir = ensureDir(join(tmpdir(), "dsh-camptv"));
  const argsFile = join(dir, `args-${randomUUID()}.json`);
  writeFileSync(argsFile, JSON.stringify(args), { mode: 0o600 });
  try {
    const cli = ["agent", "call", toolName, "--args-file", argsFile];
    if (options.wait) cli.push("--wait", "--wait-ms", String(options.waitMs));
    if (options.download) cli.push("--download-dir", ensureDir(resolveOutputDir(ctx, settings, exec)));
    const result = await runner.run(cli, {
      signal: exec.signal,
      rawExit: true,
      timeoutMs: (options.wait ? options.waitMs : 0) + settings.submitTimeoutMs + 90000
    });
    return { code: result.code, value: tryParseJson(result.stdout), stderr: result.stderr };
  } finally {
    try {
      unlinkSync(argsFile);
    } catch {
      /* already gone */
    }
  }
}

function agentCallError(toolName, outcome) {
  const value = outcome.value;
  const detail = (value && typeof value === "object" && typeof value.error === "string" && value.error) || outcome.stderr?.slice(-1500) || `exit code ${outcome.code}`;
  return new Error(`${toolName} failed: ${detail}`);
}

/** True when the call never reached the server's tool (safe to retry on the legacy path). */
function isUnavailable(outcome) {
  return outcome.code === AGENT_EXIT_UNAVAILABLE && outcome.value?.status === "unavailable";
}

/** Shape a completed, downloaded file the same way for both paths. */
async function completedValue(deps, exec, kind, base, downloaded, options = {}) {
  const { ctx, settings } = deps;
  const saved = kind === "image" ? normalizeImageExtension(downloaded) : downloaded;
  const image = kind === "image" ? await attachImage(ctx, settings, exec, saved) : undefined;
  const notes = [];
  if (options.message) notes.push(options.message);
  if (kind === "image" && options.background === "transparent" && !pngHasAlpha(saved)) {
    notes.push(
      "Requested a transparent background, but the downloaded file has no alpha channel. For GPT Image 2.5 use channel=priority with background=transparent and output_format=png, and do not write 'transparent background' in the prompt."
    );
  }
  return buildGenerationValue(kind, {
    ...base,
    status: "completed",
    file: saved,
    ...(image ? { image } : {}),
    ...(notes.length ? { message: notes.join(" ") } : {})
  });
}

/** Map one `agent call` generation/task result onto the plugin's generation value. */
async function unifiedGenerationValue(deps, exec, toolName, fallbackKind, outcome, options = {}) {
  const value = outcome.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw agentCallError(toolName, outcome);
  const kind = options.kindOverride ?? (["image", "video", "audio"].includes(value.kind) ? value.kind : fallbackKind);
  const base = {
    projectId: typeof value.projectId === "string" ? value.projectId : "",
    nodeId: typeof value.nodeId === "string" ? value.nodeId : "",
    jobId: typeof value.jobId === "string" ? value.jobId : undefined,
    model: options.model,
    channel: options.channel,
    duration: options.duration,
    ratio: options.ratio,
    resolution: options.resolution
  };
  switch (value.status) {
    case "requires_confirmation":
      return {
        status: "requires_confirmation",
        kind,
        ...(typeof value.estimatedCredits === "number" ? { estimatedCredits: value.estimatedCredits } : {}),
        ...(typeof value.estimateNote === "string" ? { estimateNote: value.estimateNote } : {}),
        summary: typeof value.summary === "string" ? value.summary : "",
        confirm_token: String(value.confirm_token ?? ""),
        tool: GENERATION_TOOL_BY_KIND[kind] ?? toolName,
        ...(typeof value.note === "string" ? { message: value.note } : {})
      };
    case "pending":
      return buildGenerationValue(kind, {
        ...base,
        status: "pending",
        message: [value.message, value.waitError ? `Polling error: ${value.waitError}` : ""].filter(Boolean).join(" ") || undefined
      });
    case "completed": {
      if (typeof value.downloadedTo === "string" && value.downloadedTo) {
        return completedValue(deps, exec, kind, base, value.downloadedTo, options);
      }
      const reason = value.downloadError
        ? `The result is ready but the download failed (${value.downloadError}). Call camptv_task again to retry the download.`
        : "The result is ready but was not downloaded (download=false). Call camptv_task with download=true to save the file.";
      return buildGenerationValue(kind, { ...base, status: "completed", message: reason });
    }
    case "failed":
      throw new Error(
        `CampTV generation failed${value.error ? `: ${value.error}` : ""} (project ${base.projectId}, node ${base.nodeId}). Do not resubmit blindly; inspect the node on the CampTV canvas or call camptv_task.`
      );
    default:
      throw agentCallError(toolName, outcome);
  }
}

/** Generic wrapper for the low-level catalog tools (create_node, canvas_edit, …). */
function createCatalogTool(deps, entry) {
  const { ctx, settings, catalog, unified } = deps;
  const fileArgs = fileArgsFor(catalog, entry.name);
  const readOnly = entry.annotations?.readOnlyHint === true;
  return makeTool({
    name: entry.name,
    description: `${entry.description ?? entry.name} (CampTV unified tool via the CampTV CLI; same contract as the CampTV MCP server.)`,
    parameters: catalogParameters(entry, fileArgs),
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: truncateBlock(JSON.stringify(value, null, 2), 20000) }]
    },
    timeoutMs: settings.submitTimeoutMs + 180000,
    isConcurrencySafe: () => readOnly,
    async execute(args, exec) {
      if (!(await unified.available())) {
        throw new Error(
          `${entry.name} needs a CampTV server with the unified tool catalog (/mcp) and a CampTV CLI with the agent command${unified.reason ? ` (${unified.reason})` : ""}.`
        );
      }
      const callArgs = resolveUnifiedFileArgs(ctx, exec, args ?? {}, fileArgs);
      const outcome = await runAgentCall(deps, exec, entry.name, callArgs, { wait: false, download: false });
      const value = outcome.value;
      if (outcome.code !== 0 || !value || typeof value !== "object" || ["error", "unavailable"].includes(value.status)) {
        if (isUnavailable(outcome)) unified.markUnavailable(value.error);
        throw agentCallError(entry.name, outcome);
      }
      return Array.isArray(value) ? { items: value } : value;
    },
    presentCall: () => ({ card: "generic", title: `CampTV · ${entry.title ?? entry.name}`, kind: readOnly ? "read" : "execute" })
  });
}

function truncateBlock(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (truncated)`;
}

/* -------------------------------------------------------------------------- */
/* model-facing tools                                                         */
/* -------------------------------------------------------------------------- */

async function unifiedImageCall(deps, args, exec) {
  const { ctx, settings, catalog, unified } = deps;
  if (!(await unified.available())) return FALLBACK;
  const name = "camptv_generate_image";
  const prompt = requireText(args.prompt, "prompt");
  const model = optionalString(args.model, "model") || settings.imageModel || undefined;
  const channel = optionalString(args.channel, "channel", CHANNELS) || settings.imageChannel;
  const referenceImages = optionalPathList(args.reference_images, "reference_images", 16);
  const ratio = optionalString(args.ratio, "ratio", IMAGE_RATIOS);
  const quality = optionalString(args.quality, "quality", IMAGE_QUALITIES);
  const format = optionalString(args.output_format, "output_format", IMAGE_FORMATS) || "png";
  const background = optionalString(args.background, "background", BACKGROUNDS);
  const resolution = optionalString(args.resolution, "resolution", IMAGE_RESOLUTIONS);
  const routeNote = assertImageRouteCapabilities({ model, channel, background, format, quality });
  const wait = optionalBoolean(args.wait, "wait");
  const callArgs = resolveUnifiedFileArgs(
    ctx,
    exec,
    pickArgs(
      {
        ...withoutPluginArgs(args),
        prompt,
        model,
        channel,
        ratio,
        quality,
        output_format: format,
        background,
        resolution,
        reference_images: referenceImages.length ? referenceImages : undefined,
        title: optionalString(args.title, "title"),
        project: optionalString(args.project, "project") || settings.project || undefined,
        confirm_token: optionalString(args.confirm_token, "confirm_token")
      },
      allowedArgs(catalog, name)
    ),
    fileArgsFor(catalog, name)
  );
  const outcome = await runAgentCall(deps, exec, name, callArgs, { wait: wait !== false, waitMs: settings.imageWaitMs, download: true });
  if (isUnavailable(outcome)) {
    unified.markUnavailable(outcome.value.error);
    return FALLBACK;
  }
  return unifiedGenerationValue(deps, exec, name, "image", outcome, { model, channel, ratio, resolution, background, message: routeNote });
}

async function unifiedVideoCall(deps, args, exec) {
  const { ctx, settings, catalog, unified } = deps;
  if (!(await unified.available())) return FALLBACK;
  const name = "camptv_generate_video";
  const prompt = requireText(args.prompt, "prompt");
  const model = optionalString(args.model, "model") || settings.videoModel || undefined;
  const channel = optionalString(args.channel, "channel", CHANNELS) || settings.videoChannel;
  const duration = optionalInteger(args.duration, "duration", 1, 60);
  const ratio = optionalString(args.ratio, "ratio", VIDEO_RATIOS);
  const resolution = optionalString(args.resolution, "resolution");
  const referenceImages = optionalPathList(args.reference_images, "reference_images", 12);
  const referenceVideos = optionalPathList(args.reference_videos, "reference_videos", 3);
  const wait = optionalBoolean(args.wait, "wait");
  const callArgs = resolveUnifiedFileArgs(
    ctx,
    exec,
    pickArgs(
      {
        ...withoutPluginArgs(args),
        prompt,
        model,
        channel,
        duration,
        ratio,
        resolution,
        reference_images: referenceImages.length ? referenceImages : undefined,
        reference_videos: referenceVideos.length ? referenceVideos : undefined,
        first_frame: optionalString(args.first_frame, "first_frame"),
        last_frame: optionalString(args.last_frame, "last_frame"),
        title: optionalString(args.title, "title"),
        project: optionalString(args.project, "project") || settings.project || undefined,
        confirm_token: optionalString(args.confirm_token, "confirm_token")
      },
      allowedArgs(catalog, name)
    ),
    fileArgsFor(catalog, name)
  );
  const outcome = await runAgentCall(deps, exec, name, callArgs, { wait: wait !== false, waitMs: settings.videoWaitMs, download: true });
  if (isUnavailable(outcome)) {
    unified.markUnavailable(outcome.value.error);
    return FALLBACK;
  }
  return unifiedGenerationValue(deps, exec, name, "video", outcome, { model, channel, duration, ratio, resolution });
}

async function unifiedTaskCall(deps, args, exec) {
  const { settings, unified } = deps;
  if (!(await unified.available())) return FALLBACK;
  const project = requireText(args.project, "project");
  const node = requireText(args.node, "node");
  const kind = optionalString(args.kind, "kind", ["image", "video", "audio"]);
  const wait = optionalBoolean(args.wait, "wait");
  const download = optionalBoolean(args.download, "download");
  const timeoutArg = optionalInteger(args.timeout_ms, "timeout_ms", 1000, 1800000);
  const outcome = await runAgentCall(deps, exec, "camptv_task", { project, node, wait_seconds: 0 }, {
    wait: wait !== false,
    waitMs: timeoutArg ?? settings.taskWaitMs,
    download: download !== false
  });
  if (isUnavailable(outcome)) {
    unified.markUnavailable(outcome.value.error);
    return FALLBACK;
  }
  return unifiedGenerationValue(deps, exec, "camptv_task", kind ?? "image", outcome, { kindOverride: kind });
}

async function unifiedProjectsCall(deps, args, exec) {
  const { unified } = deps;
  if (!(await unified.available())) return FALLBACK;
  const includeQuota = optionalBoolean(args.include_quota, "include_quota");
  const outcome = await runAgentCall(deps, exec, "camptv_projects", {}, { wait: false, download: false });
  if (isUnavailable(outcome)) {
    unified.markUnavailable(outcome.value.error);
    return FALLBACK;
  }
  const value = outcome.value;
  if (outcome.code !== 0 || !value || !Array.isArray(value.projects)) throw agentCallError("camptv_projects", outcome);
  const projects = value.projects
    .map((project) => ({
      id: String(project?.id ?? ""),
      ...(typeof project?.name === "string" ? { name: project.name } : {}),
      ...(typeof project?.updatedAt === "string" ? { updatedAt: project.updatedAt } : {}),
      ...(typeof project?.writable === "boolean" ? { writable: project.writable } : {})
    }))
    .filter((project) => project.id.length > 0);
  if (includeQuota === false) return { projects };
  const raw = value.quota && typeof value.quota === "object" ? { ...value.quota } : {};
  if (!raw.generationConcurrency && value.generation && typeof value.generation === "object") {
    const limit = Number(value.generation.limit ?? 0);
    const activeJobs = Number(value.generation.running ?? value.generation.activeJobs ?? 0);
    raw.generationConcurrency = { limit, activeJobs, remaining: Math.max(0, limit - activeJobs) };
  }
  return { projects, quota: compactQuota(raw) };
}

function createImageTool(deps) {
  const { ctx, settings, runner, projects } = deps;
  return makeTool({
    name: "camptv_generate_image",
    description:
      "Generate an image from a text prompt with CampTV and save it into the workspace. Optionally upload reference images for image-to-image generation. Returns the saved file path and, when the current model accepts images, the image itself. Usually takes 10–90 seconds; pass wait=false to return immediately and collect later with camptv_task. For true transparent PNG sprites use gpt-image-2.5-flare, channel=priority, background=transparent, output_format=png. Economy GPT Image 2.5 drops those fields and paints a fake checkerboard; Banana never returns true alpha." + CONFIRM_NOTE,
    parameters: mergeParameters({
      type: "object",
      additionalProperties: false,
      required: ["prompt"],
      properties: {
        prompt: {
          type: "string",
          description: "Text description of the image. Be specific about subject, style, lighting, and composition."
        },
        model: {
          type: "string",
          description: `Image model id. Omit for the configured default (${settings.imageModel || "CLI default"}). Common ids: gpt-image-2.5-flare (fast), gpt-image-2.5-sunburst, seedream-v5-pro, banana-2-pro, banana-2, midjourney-v8.2.`
        },
        channel: {
          type: "string",
          enum: CHANNELS,
          description:
            "Image channel. economy = 优惠渠道 (RH低价/shared, default); priority = 正价渠道 (RH官方/official). GPT Image 2.5 economy silently drops quality, background and outputFormat — true transparent PNG needs channel=priority. Banana never returns true alpha on either channel."
        },
        reference_images: {
          type: "array",
          items: { type: "string" },
          description:
            "Local reference image files (workspace-relative or absolute) for image-to-image. Each is uploaded to the canvas and wired into the node's referenceImages input. Model limits vary (GPT Image up to 16, Seedream up to 10)."
        },
        ratio: {
          type: "string",
          enum: IMAGE_RATIOS,
          description: "Aspect ratio. GPT Image 2.5 also accepts 1:2, 2:1, 1:3, 3:1 and 9:21 (sprite strips). Omit for the model default."
        },
        quality: {
          type: "string",
          enum: IMAGE_QUALITIES,
          description: "Quality tier. Sent only on the GPT Image 2.5 priority/official route. Economy (RH低价) drops this field."
        },
        output_format: {
          type: "string",
          enum: IMAGE_FORMATS,
          description: "Output file format. Default png. Transparent backgrounds require png or webp. Economy GPT Image 2.5 drops this field."
        },
        background: {
          type: "string",
          enum: BACKGROUNDS,
          description: "Background handling. True transparent PNG requires GPT Image 2.5 on channel=priority. Do not write 'transparent background' in the prompt — the model may paint a fake checkerboard. Economy GPT Image 2.5 and Banana cannot produce real alpha."
        },
        resolution: {
          type: "string",
          enum: IMAGE_RESOLUTIONS,
          description: "Image resolution for GPT Image 2.5 and Seedream (1k/2k/4k or 1024px/2048px/4096px). Omit for the model default (GPT Image 2.5: 2k)."
        },
        auto_confirm_prompt: {
          type: "boolean",
          description: "Legacy path only: let the platform auto-confirm and refine the prompt. Ignored by the unified catalog path."
        },
        title: { type: "string", description: "Optional node title shown on the CampTV canvas." },
        project: {
          type: "string",
          description: "Optional CampTV project (canvas) id. Omit to use the configured or auto-created default project."
        },
        wait: {
          type: "boolean",
          description: "Wait for the image and download it (default true). Set false to submit and return immediately, then call camptv_task."
        }
      }
    }, deps.catalog.tools.get("camptv_generate_image"), fileArgsFor(deps.catalog, "camptv_generate_image"), { confirm_token: CONFIRM_TOKEN_PARAM }),
    output: {
      schema: GENERATION_OUTPUT_SCHEMA,
      render: (_args, value) => renderGeneration(value)
    },
    timeoutMs: settings.imageWaitMs + settings.submitTimeoutMs + 120000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const viaAgent = await unifiedImageCall(deps, args, exec);
      if (viaAgent !== FALLBACK) return viaAgent;
      // Legacy path: CLI without `agent` or server without /mcp (no quote step).
      const prompt = requireText(args.prompt, "prompt");
      const model = optionalString(args.model, "model") || settings.imageModel;
      const channel = optionalString(args.channel, "channel", CHANNELS) || settings.imageChannel;
      const referenceImages = optionalPathList(args.reference_images, "reference_images", 16);
      const ratio = optionalString(args.ratio, "ratio", IMAGE_RATIOS);
      const quality = optionalString(args.quality, "quality", IMAGE_QUALITIES);
      const format = optionalString(args.output_format, "output_format", IMAGE_FORMATS) || "png";
      const background = optionalString(args.background, "background", BACKGROUNDS);
      const resolution = optionalString(args.resolution, "resolution", IMAGE_RESOLUTIONS);
      const routeNote = assertImageRouteCapabilities({ model, channel, background, format, quality });
      const autoConfirm = optionalBoolean(args.auto_confirm_prompt, "auto_confirm_prompt");
      const wait = optionalBoolean(args.wait, "wait");
      const title = optionalString(args.title, "title");
      const projectArg = optionalString(args.project, "project");
      const projectId = await projects.resolve(projectArg, exec.signal);
      const sourceArgs = await buildReferenceSources(
        ctx,
        runner,
        settings,
        exec,
        projectId,
        referenceImages.map((path) => ({ path, slot: "referenceImages", field: "reference_images" }))
      );
      const outputDir = ensureDir(resolveOutputDir(ctx, settings, exec));
      const filePath = join(outputDir, `image-${stamp()}-${randomUUID().slice(0, 8)}.${extensionForFormat(format)}`);
      // Create the image node with every setting, then submit it without a
      // configOverride: the platform rejects `outputFormat` inside a create-node
      // submit override, while the node-create payload accepts it. Reference
      // sources are attached during node creation, before submission.
      const created = await runner.run(
        [
          "node",
          "create",
          "--project",
          projectId,
          "--type",
          "image",
          "--title",
          truncate(title || prompt, 60),
          "--prompt",
          prompt,
          ...(model ? ["--model", model] : []),
          ...(ratio ? ["--ratio", ratio] : []),
          ...(quality ? ["--image-quality", quality] : []),
          ...(background ? ["--background", background] : []),
          ...(format ? ["--output-format", format] : []),
          ...(resolution ? ["--resolution", resolution] : []),
          "--channel",
          IMAGE_CHANNEL_ROUTES[channel],
          ...sourceArgs
        ],
        { signal: exec.signal, timeoutMs: settings.submitTimeoutMs }
      );
      const nodeId = created?.node?.id;
      if (typeof nodeId !== "string") {
        throw new Error(`CampTV did not return an image node id: ${JSON.stringify(created).slice(0, 500)}`);
      }
      const submitted = await runner.run(
        ["node", "submit", "--project", projectId, "--node", nodeId, "--request-id", randomUUID(), "--prompt", prompt, ...(autoConfirm === true ? ["--auto-confirm-prompt"] : [])],
        { signal: exec.signal, timeoutMs: settings.submitTimeoutMs }
      );
      const jobId = submitted?.submitted?.jobId;
      return collectGeneration(deps, exec, {
        kind: "image",
        projectId,
        nodeId,
        jobId,
        model,
        channel,
        ratio,
        resolution,
        background,
        format,
        wait: wait !== false,
        waitMs: settings.imageWaitMs,
        filePath,
        message: routeNote
      });
    },
    presentCall: (args) => ({
      card: "generic",
      title: `CampTV image · ${truncate(args?.prompt, 60)}`,
      kind: "execute",
      rawInput: truncate(args?.prompt, 300)
    })
  });
}

function createVideoTool(deps) {
  const { ctx, settings, runner, projects } = deps;
  return makeTool({
    name: "camptv_generate_video",
    description:
      "Generate a video from a text prompt with CampTV and save it into the workspace. Optionally upload reference images/videos or first/last frame images; they are attached to the canvas node before submission. Video usually takes 1–10 minutes; this tool waits within its budget by default, otherwise returns project and node ids for camptv_task. The economy channel is cheaper but has monthly quota and concurrency limits." + CONFIRM_NOTE,
    parameters: mergeParameters({
      type: "object",
      additionalProperties: false,
      required: ["prompt"],
      properties: {
        prompt: {
          type: "string",
          description: "Text description of the video: subject, motion, camera, style, and mood."
        },
        model: {
          type: "string",
          description:
            "Video model id. Common ids: seedance-2.0, seedance-2.0-fast, seedance-2.5, kling-o3-std-t2v, kling-o3-pro-t2v, kling-o3-4k-t2v. Omit for the channel default (economy: MiniMax H3; priority: Seedance 2.0)."
        },
        channel: {
          type: "string",
          enum: CHANNELS,
          description:
            "Generation channel. economy = discounted LibTV channel (优惠渠道, default, lower price, monthly quota); priority = standard RunningHub channel (正价渠道). Omit to use the configured default."
        },
        duration: {
          type: "integer",
          description: "Clip length in seconds. Model-dependent (MiniMax H3 5–15, Seedance 2.0 4–15, Seedance 2.5 up to 30). Omit for the model default."
        },
        ratio: {
          type: "string",
          enum: VIDEO_RATIOS,
          description: "Aspect ratio. Supported sets vary by model; omit for the model default."
        },
        resolution: {
          type: "string",
          description: "Output resolution such as 480p, 720p, 768P, 1080p, or 2K. Values vary by model; the economy MiniMax H3 supports 768P/2K only."
        },
        reference_images: {
          type: "array",
          items: { type: "string" },
          description:
            "Local reference images (workspace-relative or absolute) for reference-to-video / image-to-video, wired into the node's referenceImages input. Model support varies (economy MiniMax H3 up to 9; Seedance 2.0 up to 9)."
        },
        reference_videos: {
          type: "array",
          items: { type: "string" },
          description:
            "Local reference videos wired into the node's referenceVideo input. Model support varies (economy MiniMax H3 up to 3)."
        },
        first_frame: {
          type: "string",
          description: "Local image used as the first frame (firstFrame input); selects image-to-video when the model supports it."
        },
        last_frame: {
          type: "string",
          description: "Local image used as the last frame (lastFrame input); requires a model that accepts a last frame."
        },
        title: { type: "string", description: "Optional node title shown on the CampTV canvas." },
        project: {
          type: "string",
          description: "Optional CampTV project (canvas) id. Omit to use the configured or auto-created default project."
        },
        wait: {
          type: "boolean",
          description: "Wait for the video and download it (default true). Set false to submit and return immediately, then call camptv_task."
        }
      }
    }, deps.catalog.tools.get("camptv_generate_video"), fileArgsFor(deps.catalog, "camptv_generate_video"), { confirm_token: CONFIRM_TOKEN_PARAM }),
    output: {
      schema: GENERATION_OUTPUT_SCHEMA,
      render: (_args, value) => renderGeneration(value)
    },
    timeoutMs: settings.videoWaitMs + settings.submitTimeoutMs + 120000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const viaAgent = await unifiedVideoCall(deps, args, exec);
      if (viaAgent !== FALLBACK) return viaAgent;
      // Legacy path: CLI without `agent` or server without /mcp (no quote step).
      const prompt = requireText(args.prompt, "prompt");
      const model = optionalString(args.model, "model") || settings.videoModel;
      const channel = optionalString(args.channel, "channel", CHANNELS) || settings.videoChannel;
      const duration = optionalInteger(args.duration, "duration", 1, 60);
      const ratio = optionalString(args.ratio, "ratio", VIDEO_RATIOS);
      const resolution = optionalString(args.resolution, "resolution");
      const referenceImages = optionalPathList(args.reference_images, "reference_images", 12);
      const referenceVideos = optionalPathList(args.reference_videos, "reference_videos", 3);
      const firstFrame = optionalString(args.first_frame, "first_frame");
      const lastFrame = optionalString(args.last_frame, "last_frame");
      const title = optionalString(args.title, "title");
      const wait = optionalBoolean(args.wait, "wait");
      const projectArg = optionalString(args.project, "project");
      const projectId = await projects.resolve(projectArg, exec.signal);
      const references = [
        ...referenceImages.map((path) => ({ path, slot: "referenceImages", field: "reference_images" })),
        ...referenceVideos.map((path) => ({ path, slot: "referenceVideo", field: "reference_videos" })),
        ...(firstFrame ? [{ path: firstFrame, slot: "firstFrame", field: "first_frame" }] : []),
        ...(lastFrame ? [{ path: lastFrame, slot: "lastFrame", field: "last_frame" }] : [])
      ];
      const sourceArgs = await buildReferenceSources(ctx, runner, settings, exec, projectId, references);
      const outputDir = ensureDir(resolveOutputDir(ctx, settings, exec));
      const filePath = join(outputDir, `video-${stamp()}-${randomUUID().slice(0, 8)}.mp4`);
      // Two steps: create the video node with its references and settings, then
      // submit it. This mirrors the image flow and keeps the submit payload free
      // of a configOverride.
      const created = await runner.run(
        [
          "node",
          "create",
          "--project",
          projectId,
          "--type",
          "video",
          "--title",
          truncate(title || prompt, 60),
          "--prompt",
          prompt,
          ...(channel ? ["--channel", channel] : []),
          ...(model ? ["--model", model] : []),
          ...(duration !== undefined ? ["--duration", String(duration)] : []),
          ...(ratio ? ["--ratio", ratio] : []),
          ...(resolution ? ["--resolution", resolution] : []),
          ...sourceArgs
        ],
        { signal: exec.signal, timeoutMs: settings.submitTimeoutMs }
      );
      const nodeId = created?.node?.id;
      if (typeof nodeId !== "string") {
        throw new Error(`CampTV did not return a video node id: ${JSON.stringify(created).slice(0, 500)}`);
      }
      const submitted = await runner.run(
        ["node", "submit", "--project", projectId, "--node", nodeId, "--request-id", randomUUID(), "--prompt", prompt],
        { signal: exec.signal, timeoutMs: settings.submitTimeoutMs }
      );
      const jobId = submitted?.submitted?.jobId;
      return collectGeneration(deps, exec, {
        kind: "video",
        projectId,
        nodeId,
        jobId,
        model,
        channel,
        duration,
        ratio,
        resolution,
        wait: wait !== false,
        waitMs: settings.videoWaitMs,
        filePath
      });
    },
    presentCall: (args) => ({
      card: "generic",
      title: `CampTV video · ${truncate(args?.prompt, 60)}`,
      kind: "execute",
      rawInput: truncate(args?.prompt, 300)
    })
  });
}

function createTaskTool(deps) {
  const { ctx, settings, runner } = deps;
  return makeTool({
    name: "camptv_task",
    description:
      "Check, wait for, and download a CampTV generation result by project and node id. Use the ids returned by camptv_generate_image or camptv_generate_video when those tools returned a pending result, or to re-download an earlier result. Never resubmit a generation that is already running.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["project", "node"],
      properties: {
        project: { type: "string", description: "CampTV project (canvas) id." },
        node: { type: "string", description: "Generation node id." },
        kind: {
          type: "string",
          enum: ["image", "video", "audio"],
          description: "Result type, used for the download file name. Omit to infer it from the node."
        },
        wait: {
          type: "boolean",
          description: "Wait for the node to finish within timeout_ms (default true). Set false for a single status check."
        },
        download: {
          type: "boolean",
          description: "Download the result file when the node is completed (default true)."
        },
        timeout_ms: {
          type: "integer",
          description: "Maximum time to wait in this call, 1000–1800000 ms. Defaults to the configured task wait budget."
        }
      }
    },
    output: {
      schema: GENERATION_OUTPUT_SCHEMA,
      render: (_args, value) => renderGeneration(value)
    },
    timeoutMs: settings.taskWaitMs + settings.submitTimeoutMs + 120000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const viaAgent = await unifiedTaskCall(deps, args, exec);
      if (viaAgent !== FALLBACK) return viaAgent;
      const projectId = requireText(args.project, "project");
      const nodeId = requireText(args.node, "node");
      const kindArg = optionalString(args.kind, "kind", ["image", "video", "audio"]);
      const wait = optionalBoolean(args.wait, "wait");
      const download = optionalBoolean(args.download, "download");
      const timeoutArg = optionalInteger(args.timeout_ms, "timeout_ms", 1000, 1800000);
      const first = await readNode(runner, settings, exec, projectId, nodeId);
      const kind = kindArg ?? kindFromOutput(first, "image");
      const timeoutMs = timeoutArg ?? settings.taskWaitMs;
      const extension = outputExtension(first, kind);
      const filePath = join(
        ensureDir(resolveOutputDir(ctx, settings, exec)),
        `${kind}-${stamp()}-${randomUUID().slice(0, 8)}.${extension}`
      );
      return collectGeneration(deps, exec, {
        kind,
        projectId,
        nodeId,
        wait: wait !== false,
        waitMs: timeoutMs,
        download: download !== false,
        filePath,
        initial: first
      });
    },
    presentCall: (args) => ({
      card: "generic",
      title: `CampTV task · ${truncate(args?.node, 40)}`,
      kind: "read",
      rawInput: `project ${args?.project ?? ""} node ${args?.node ?? ""}`
    })
  });
}

const PROJECTS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["projects"],
  properties: {
    projects: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          updatedAt: { type: "string" },
          writable: { type: "boolean" }
        }
      }
    },
    quota: { type: "object", additionalProperties: true }
  }
};

function renderProjects(value) {
  const lines = [`CampTV projects (${value.projects.length}):`];
  if (value.projects.length === 0) lines.push("- (none)");
  for (const project of value.projects) {
    lines.push(`- ${project.id}  ${project.name || "(unnamed)"}${project.writable === false ? "  (read-only)" : ""}${project.updatedAt ? `  updated ${project.updatedAt}` : ""}`);
  }
  if (value.quota) {
    const quota = value.quota;
    const economy = quota.economy;
    const priority = quota.priority;
    const generation = quota.generation;
    lines.push("", "Video channels:");
    if (economy) {
      lines.push(
        `- economy: ${economy.available ? "available" : "unavailable"}, credits ${economy.remainingCredits}/${economy.monthlyQuotaCredits}, jobs ${economy.activeJobs}/${economy.maxConcurrentJobs}${economy.resetsAt ? `, resets ${economy.resetsAt}` : ""}`
      );
    }
    if (priority) lines.push(`- priority: ${priority.available ? "available" : "unavailable"}`);
    if (generation) lines.push(`- generation concurrency: ${generation.activeJobs}/${generation.limit}`);
  }
  return lines.join("\n");
}

function compactQuota(status) {
  const channels = status?.videoChannels ?? {};
  const economy = channels.economy ?? {};
  const priority = channels.priority ?? {};
  const generation = status?.generationConcurrency ?? {};
  return {
    economy: {
      available: economy.available === true,
      enabled: economy.enabled === true,
      remainingCredits: Number(economy.remainingCredits ?? 0),
      monthlyQuotaCredits: Number(economy.monthlyQuotaCredits ?? 0),
      activeJobs: Number(economy.activeJobs ?? 0),
      maxConcurrentJobs: Number(economy.maxConcurrentJobs ?? 0),
      ...(typeof economy.resetsAt === "string" ? { resetsAt: economy.resetsAt } : {})
    },
    priority: {
      available: priority.available !== false,
      ...(typeof priority.resetsAt === "string" ? { resetsAt: priority.resetsAt } : {})
    },
    generation: {
      limit: Number(generation.limit ?? 0),
      activeJobs: Number(generation.activeJobs ?? 0),
      remaining: Number(generation.remaining ?? 0)
    }
  };
}

function createProjectsTool(deps) {
  const { settings, runner } = deps;
  return makeTool({
    name: "camptv_projects",
    description:
      "List the CampTV projects (canvas ids) owned by the signed-in account, plus video-channel quota and generation concurrency. Use a project id in the generation tools to target a specific canvas; omit it there to use the default project.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        include_quota: {
          type: "boolean",
          description: "Include video channel quota and generation concurrency (default true)."
        }
      }
    },
    output: {
      schema: PROJECTS_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: "text", text: renderProjects(value) }]
    },
    timeoutMs: settings.submitTimeoutMs + 60000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const viaAgent = await unifiedProjectsCall(deps, args, exec);
      if (viaAgent !== FALLBACK) return viaAgent;
      const includeQuota = optionalBoolean(args.include_quota, "include_quota");
      const listed = await runner.run(["project", "list"], { signal: exec.signal, timeoutMs: 60000 });
      const projects = (Array.isArray(listed?.projects) ? listed.projects : []).map((project) => ({
        id: String(project?.id ?? ""),
        ...(typeof project?.name === "string" ? { name: project.name } : {}),
        ...(typeof project?.updatedAt === "string" ? { updatedAt: project.updatedAt } : {})
      })).filter((project) => project.id.length > 0);
      let quota;
      if (includeQuota !== false) {
        const status = await runner.run(["quota", "status"], { signal: exec.signal, timeoutMs: 60000 });
        quota = compactQuota(status);
      }
      return { projects, ...(quota ? { quota } : {}) };
    },
    presentCall: () => ({ card: "generic", title: "CampTV projects and quota", kind: "read" })
  });
}

/* -------------------------------------------------------------------------- */
/* plugin entry                                                               */
/* -------------------------------------------------------------------------- */

function normalizeSettings(config) {
  const raw = config && typeof config === "object" ? config : {};
  const merged = { ...DEFAULTS, ...raw };
  for (const key of ["imageWaitMs", "videoWaitMs", "taskWaitMs", "pollIntervalMs", "submitTimeoutMs", "maxInlineImageBytes"]) {
    const value = merged[key];
    if (!Number.isInteger(value) || value <= 0) throw new Error(`dsh-camptv: ${key} must be a positive integer`);
  }
  const channel = typeof merged.videoChannel === "string" ? merged.videoChannel.trim().toLowerCase() : "";
  merged.videoChannel = channel === "priority" ? "priority" : "economy";
  const imageChannel = typeof merged.imageChannel === "string" ? merged.imageChannel.trim().toLowerCase() : "";
  merged.imageChannel = imageChannel === "priority" ? "priority" : "economy";
  const cliPath = typeof merged.cliPath === "string" ? merged.cliPath.trim() : "";
  merged.cliPath = cliPath ? expandHome(cliPath) : join(homedir(), ".camptv", "bin", "cli.cjs");
  const cliConfigPath = typeof merged.cliConfigPath === "string" ? merged.cliConfigPath.trim() : "";
  merged.cliConfigPath = cliConfigPath ? expandHome(cliConfigPath) : "";
  merged.nodePath = typeof merged.nodePath === "string" ? expandHome(merged.nodePath.trim()) : "";
  merged.outputDir = (typeof merged.outputDir === "string" && merged.outputDir.trim()) || DEFAULTS.outputDir;
  merged.project = typeof merged.project === "string" ? merged.project.trim() : "";
  merged.imageModel = typeof merged.imageModel === "string" ? merged.imageModel.trim() : "";
  merged.videoModel = typeof merged.videoModel === "string" ? merged.videoModel.trim() : "";
  merged.unifiedTools = merged.unifiedTools === "off" ? "off" : "auto";
  merged.canvasTools = merged.canvasTools === "on" || merged.canvasTools === "off" ? merged.canvasTools : "auto";
  merged.toolsSnapshotPath = typeof merged.toolsSnapshotPath === "string" && merged.toolsSnapshotPath.trim() ? expandHome(merged.toolsSnapshotPath.trim()) : "";
  return merged;
}

export function apply(ctx, config) {
  const settings = normalizeSettings(config);
  const runner = createCliRunner(settings);
  const projects = createProjectManager(runner, settings);
  const catalog = loadToolCatalog(settings);
  const unified = createUnifiedState(runner, settings);
  const deps = { ctx, settings, runner, projects, catalog, unified };
  if (settings.enableImage) ctx.tools.register(createImageTool(deps));
  if (settings.enableVideo) ctx.tools.register(createVideoTool(deps));
  if (settings.enableTask) ctx.tools.register(createTaskTool(deps));
  if (settings.enableProjects) ctx.tools.register(createProjectsTool(deps));
  const canvasTools = settings.unifiedTools !== "off" && (settings.canvasTools === "on" || (settings.canvasTools === "auto" && catalog.hasUserSnapshot));
  if (canvasTools) {
    for (const entry of catalog.tools.values()) {
      if (!HIGH_LEVEL_TOOLS.has(entry.name)) ctx.tools.register(createCatalogTool(deps, entry));
    }
  }
}
