import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(__dirname, "..");

export const config = {
  host: process.env.HOST || "0.0.0.0",
  port: Number(process.env.PORT || 5174),
  dataDir: path.resolve(rootDir, process.env.DATA_DIR || "data"),
  staticDir: path.resolve(rootDir, process.env.STATIC_DIR || "dist"),
  appEnv: process.env.APP_ENV || "production",
  appLabel: process.env.APP_LABEL || "",
  dify: {
    base: normalizeBase(process.env.DIFY_API_BASE || ""),
    apiKey: process.env.DIFY_CHAPTER_WORKFLOW_API_KEY || "",
    user: process.env.DIFY_USER || "local-secure-importer",
    batchSize: clampInteger(process.env.IMPORT_BATCH_SIZE, 1, 50, 10)
  },
  openai: {
    base: normalizeBase(process.env.OPENAI_API_BASE || "https://api.openai.com/v1"),
    apiKey: process.env.OPENAI_API_KEY || "",
    model: process.env.OPENAI_MODEL || "gpt-5.5",
    retentionMode: String(process.env.OPENAI_RETENTION_MODE || "").toLowerCase(),
    chapterConcurrency: clampInteger(process.env.OPENAI_CHAPTER_CONCURRENCY, 1, 5, 1),
    proxyUrl: process.env.OPENAI_PROXY_URL || "",
    requestTimeoutMs: clampInteger(process.env.OPENAI_REQUEST_TIMEOUT_MS, 30_000, 600_000, 180_000),
    maxRetries: clampInteger(process.env.OPENAI_MAX_RETRIES, 0, 5, 2)
  },
  keychain: {
    service: process.env.KEYCHAIN_SERVICE || "novel-chapter-gpt-service",
    account: process.env.KEYCHAIN_ACCOUNT || "master-key"
  }
};

fs.mkdirSync(config.dataDir, { recursive: true });

export function publicRuntimeConfig() {
  return {
    host: config.host,
    difyConfigured: Boolean(config.dify.base && config.dify.apiKey),
    difyBase: maskUrl(config.dify.base),
    openaiConfigured: Boolean(config.openai.apiKey),
    openaiBase: maskUrl(config.openai.base),
    openaiModel: config.openai.model,
    openaiRetentionMode: config.openai.retentionMode || "unset",
    retentionConfirmed: isRetentionModeConfirmed(),
    dataDir: config.dataDir,
    staticDir: config.staticDir,
    appEnv: config.appEnv,
    appLabel: config.appLabel || defaultAppLabel(config.appEnv),
    isPreview: config.appEnv === "preview",
    importBatchSize: config.dify.batchSize,
    chapterConcurrency: config.openai.chapterConcurrency,
    openaiMaxRetries: config.openai.maxRetries
  };
}

export function requireDifyConfig() {
  if (!config.dify.base || !config.dify.apiKey) {
    const error = new Error("缺少 DIFY_API_BASE 或 DIFY_CHAPTER_WORKFLOW_API_KEY。");
    error.status = 500;
    throw error;
  }
}

export function requireOpenAIConfig() {
  if (!config.openai.apiKey) {
    const error = new Error("缺少 OPENAI_API_KEY。");
    error.status = 500;
    throw error;
  }

  if (!isRetentionModeConfirmed()) {
    const error = new Error("OPENAI_RETENTION_MODE 必须设置为 zdr 或 mam，确认项目已启用 ZDR/MAM 后才能分析真实章节。");
    error.status = 403;
    throw error;
  }
}

export function isRetentionModeConfirmed() {
  return ["zdr", "mam"].includes(config.openai.retentionMode);
}

function normalizeBase(value) {
  return String(value || "").replace(/\/+$/, "");
}

function maskUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return String(value).replace(/(app-|sk-)[A-Za-z0-9_-]+/g, "$1***");
  }
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function defaultAppLabel(appEnv) {
  return appEnv === "preview" ? "本机预览" : "正式环境";
}
