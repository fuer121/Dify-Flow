import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { config, requireOpenAIConfig } from "./config.js";
import { sanitizeDetails, sanitizeText } from "./sanitize.js";

export async function callOpenAIJson({ model, reasoningEffort, instructions, input, schema, schemaName = "result", maxOutputTokens, strict = true }) {
  requireOpenAIConfig();
  const body = buildOpenAIJsonBody({ model, reasoningEffort, instructions, input, schema, schemaName, maxOutputTokens, strict });

  const response = await postOpenAIJson("responses", body);

  if (!response.ok) {
    const error = new Error(sanitizeText(response.data?.error?.message || response.data?.message || `OpenAI 调用失败：HTTP ${response.status}`));
    error.status = response.status;
    error.details = sanitizeDetails(response.data);
    throw error;
  }

  const text = extractResponseText(response.data);
  const parsed = parseJsonOrNull(text);
  if (parsed !== null) {
    return {
      value: parsed,
      responseId: response.data?.id || null
    };
  }

  const repaired = await repairOpenAIJsonOutput({
    model,
    reasoningEffort,
    schema,
    schemaName,
    strict,
    originalText: text
  });
  return {
    value: repaired.value,
    responseId: [response.data?.id, repaired.responseId].filter(Boolean).join(",") || null
  };
}

function buildOpenAIJsonBody({ model, reasoningEffort, instructions, input, schema, schemaName = "result", maxOutputTokens, strict = true }) {
  const body = {
    model: model || config.openai.model,
    store: false,
    reasoning: {
      effort: reasoningEffort || "medium"
    },
    instructions,
    input,
    text: {
      format: {
        type: "json_schema",
        name: schemaName,
        schema,
        strict: Boolean(strict)
      }
    }
  };
  if (Number.isFinite(Number(maxOutputTokens)) && Number(maxOutputTokens) > 0) {
    body.max_output_tokens = Number(maxOutputTokens);
  }
  return body;
}

async function repairOpenAIJsonOutput({ model, schema, schemaName, strict, originalText }) {
  if (!String(originalText || "").trim()) {
    const wrapped = new Error("OpenAI 返回不是合法 JSON：空响应");
    wrapped.status = 502;
    throw wrapped;
  }
  const repairBody = buildOpenAIJsonBody({
    model,
    reasoningEffort: "low",
    instructions: "你是 JSON 修复器。请只把用户提供的破损 JSON 修复为符合目标 Schema 的合法 JSON。不得添加解释、Markdown 或额外字段；缺失且无法恢复的字段使用符合 Schema 的空值。",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              "目标 Schema JSON：",
              JSON.stringify(schema || {}),
              "",
              "破损 JSON 文本：",
              clipRepairText(originalText)
            ].join("\n")
          }
        ]
      }
    ],
    schema,
    schemaName: safeRepairSchemaName(schemaName),
    strict,
    maxOutputTokens: 2000
  });
  const repairResponse = await postOpenAIJson("responses", repairBody);
  if (!repairResponse.ok) {
    const error = new Error(sanitizeText(repairResponse.data?.error?.message || repairResponse.data?.message || `OpenAI JSON 修复失败：HTTP ${repairResponse.status}`));
    error.status = repairResponse.status;
    error.details = sanitizeDetails(repairResponse.data);
    throw error;
  }
  const repairedText = extractResponseText(repairResponse.data);
  const repairedValue = parseJsonOrNull(repairedText);
  if (repairedValue !== null) {
    return {
      value: repairedValue,
      responseId: repairResponse.data?.id || null
    };
  }
  const wrapped = new Error("OpenAI 返回不是合法 JSON，自动修复后仍失败。");
  wrapped.status = 502;
  throw wrapped;
}

function safeRepairSchemaName(schemaName) {
  return `${String(schemaName || "result").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48) || "result"}_repair`;
}

function clipRepairText(value) {
  const text = String(value || "");
  if (text.length <= 12_000) return text;
  return `${text.slice(0, 10_000)}\n...\n${text.slice(-2000)}`;
}

export async function callOpenAIText({ model, reasoningEffort, instructions, input, maxOutputTokens }) {
  requireOpenAIConfig();
  const body = {
    model: model || config.openai.model,
    store: false,
    reasoning: {
      effort: reasoningEffort || "medium"
    },
    instructions,
    input
  };
  if (Number.isFinite(Number(maxOutputTokens)) && Number(maxOutputTokens) > 0) {
    body.max_output_tokens = Number(maxOutputTokens);
  }

  const response = await postOpenAIJson("responses", body);

  if (!response.ok) {
    const error = new Error(sanitizeText(response.data?.error?.message || response.data?.message || `OpenAI 调用失败：HTTP ${response.status}`));
    error.status = response.status;
    error.details = sanitizeDetails(response.data);
    throw error;
  }

  return {
    value: extractResponseText(response.data),
    responseId: response.data?.id || null
  };
}

async function postOpenAIJson(path, body) {
  const endpoint = `${config.openai.base}/${path.replace(/^\/+/, "")}`;
  const headers = {
    Authorization: `Bearer ${config.openai.apiKey}`,
    "Content-Type": "application/json"
  };
  const payload = JSON.stringify(body);

  let lastError = null;
  for (let attempt = 0; attempt <= config.openai.maxRetries; attempt += 1) {
    try {
      const result = config.openai.proxyUrl
        ? await postJsonViaHttpProxy(endpoint, headers, payload)
        : await postJsonDirect(endpoint, headers, payload);
      if (!isRetryableOpenAIStatus(result.status) || attempt >= config.openai.maxRetries) {
        return result;
      }
      lastError = new Error(`OpenAI 临时失败：HTTP ${result.status}`);
    } catch (error) {
      if (!isRetryableOpenAIError(error) || attempt >= config.openai.maxRetries) {
        throw openAINetworkError(error);
      }
      lastError = error;
    }
    await delay(openAIRetryDelayMs(attempt));
  }
  throw openAINetworkError(lastError);
}

async function postJsonDirect(endpoint, headers, payload) {
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers,
    body: payload
  });
  return {
    ok: response.ok,
    status: response.status,
    data: await response.json().catch(() => null)
  };
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.openai.requestTimeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function postJsonViaHttpProxy(endpoint, headers, payload) {
  const target = new URL(endpoint);
  const proxy = new URL(config.openai.proxyUrl);
  if (proxy.protocol !== "http:") {
    const error = new Error("OPENAI_PROXY_URL 目前仅支持 http:// 代理地址。");
    error.status = 500;
    throw error;
  }
  if (target.protocol !== "https:") {
    const error = new Error("通过 OPENAI_PROXY_URL 调用时，OPENAI_API_BASE 必须是 https:// 地址。");
    error.status = 500;
    throw error;
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`OpenAI 代理请求超时：${Math.round(config.openai.requestTimeoutMs / 1000)} 秒`));
    }, config.openai.requestTimeoutMs);

    const finish = (callback, value) => {
      clearTimeout(timeout);
      callback(value);
    };

    const targetPort = target.port || 443;
    const connectRequest = http.request({
      host: proxy.hostname,
      port: proxy.port || 80,
      method: "CONNECT",
      path: `${target.hostname}:${targetPort}`,
      headers: proxyAuthorizationHeaders(proxy)
    });

    connectRequest.once("connect", (connectResponse, socket) => {
      if (connectResponse.statusCode !== 200) {
        socket.destroy();
        finish(reject, new Error(`OpenAI 代理连接失败：HTTP ${connectResponse.statusCode}`));
        return;
      }

      const secureSocket = tls.connect({
        socket,
        servername: target.hostname
      });

      secureSocket.once("secureConnect", () => {
        const request = https.request({
          host: target.hostname,
          port: targetPort,
          path: `${target.pathname}${target.search}`,
          method: "POST",
          headers: {
            ...headers,
            "Content-Length": Buffer.byteLength(payload)
          },
          createConnection: () => secureSocket
        }, (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.once("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            finish(resolve, {
              ok: response.statusCode >= 200 && response.statusCode < 300,
              status: response.statusCode,
              data: parseJsonOrNull(text)
            });
          });
        });

        request.once("error", (error) => finish(reject, error));
        request.end(payload);
      });

      secureSocket.once("error", (error) => finish(reject, error));
    });

    connectRequest.once("timeout", () => {
      connectRequest.destroy(new Error("OpenAI 代理连接超时。"));
    });
    connectRequest.once("error", (error) => finish(reject, error));
    connectRequest.setTimeout(config.openai.requestTimeoutMs);
    connectRequest.end();
  });
}

function proxyAuthorizationHeaders(proxy) {
  if (!proxy.username) return {};
  const credentials = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64");
  return { "Proxy-Authorization": `Basic ${credentials}` };
}

function parseJsonOrNull(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function openAINetworkError(error) {
  if (error?.status) return error;
  const wrapped = new Error(sanitizeText(
    [
      `OpenAI 网络连接失败：无法连接 ${config.openai.base}。`,
      config.openai.proxyUrl ? `当前已配置代理 ${config.openai.proxyUrl}。` : "当前未配置 OPENAI_PROXY_URL。",
      "请确认代理/VPN 可用，或将 OPENAI_API_BASE 指向可访问且合规的 OpenAI 兼容地址。",
      `底层错误：${error?.message || "fetch failed"}`
    ].join(" ")
  ));
  wrapped.status = 502;
  wrapped.details = sanitizeDetails({
    openaiBase: config.openai.base,
    proxyConfigured: Boolean(config.openai.proxyUrl)
  });
  return wrapped;
}

function isRetryableOpenAIStatus(status) {
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

function isRetryableOpenAIError(error) {
  if (error?.status && !isRetryableOpenAIStatus(error.status)) return false;
  const message = String(error?.message || "").toLowerCase();
  return [
    "aborted",
    "aborterror",
    "timeout",
    "timed out",
    "socket",
    "tls",
    "econnreset",
    "econnrefused",
    "enotfound",
    "etimedout",
    "fetch failed",
    "proxy",
    "network",
    "超时",
    "代理",
    "连接失败",
    "网络"
  ].some((token) => message.includes(token));
}

function openAIRetryDelayMs(attempt) {
  return Math.min(12_000, 1000 * 2 ** attempt);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function testOpenAIConnection() {
  requireOpenAIConfig();
  try {
    const response = config.openai.proxyUrl
      ? await getJsonViaHttpProxy(`${config.openai.base}/models`, {
        Authorization: `Bearer ${config.openai.apiKey}`
      })
      : await fetchWithTimeout(`${config.openai.base}/models`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${config.openai.apiKey}`
        }
      }).then(async (httpResponse) => ({
        ok: httpResponse.ok,
        status: httpResponse.status,
        data: await httpResponse.json().catch(() => null)
      }));
    if (!response.ok) {
      const error = new Error(sanitizeText(response.data?.error?.message || response.data?.message || `OpenAI 连通性测试失败：HTTP ${response.status}`));
      error.status = response.status;
      error.details = sanitizeDetails(response.data);
      throw error;
    }
    return { ok: true, status: response.status };
  } catch (error) {
    throw openAINetworkError(error);
  }
}

function getJsonViaHttpProxy(endpoint, headers) {
  const target = new URL(endpoint);
  const proxy = new URL(config.openai.proxyUrl);
  if (proxy.protocol !== "http:" || target.protocol !== "https:") {
    const error = new Error("OpenAI 代理连通性测试需要 http:// 代理和 https:// API Base。");
    error.status = 500;
    throw error;
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`OpenAI 代理请求超时：${Math.round(config.openai.requestTimeoutMs / 1000)} 秒`));
    }, config.openai.requestTimeoutMs);
    const finish = (callback, value) => {
      clearTimeout(timeout);
      callback(value);
    };
    const targetPort = target.port || 443;
    const connectRequest = http.request({
      host: proxy.hostname,
      port: proxy.port || 80,
      method: "CONNECT",
      path: `${target.hostname}:${targetPort}`,
      headers: proxyAuthorizationHeaders(proxy)
    });
    connectRequest.once("connect", (connectResponse, socket) => {
      if (connectResponse.statusCode !== 200) {
        socket.destroy();
        finish(reject, new Error(`OpenAI 代理连接失败：HTTP ${connectResponse.statusCode}`));
        return;
      }
      const secureSocket = tls.connect({ socket, servername: target.hostname });
      secureSocket.once("secureConnect", () => {
        const request = https.request({
          host: target.hostname,
          port: targetPort,
          path: `${target.pathname}${target.search}`,
          method: "GET",
          headers,
          createConnection: () => secureSocket
        }, (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.once("end", () => {
            finish(resolve, {
              ok: response.statusCode >= 200 && response.statusCode < 300,
              status: response.statusCode,
              data: parseJsonOrNull(Buffer.concat(chunks).toString("utf8"))
            });
          });
        });
        request.once("error", (error) => finish(reject, error));
        request.end();
      });
      secureSocket.once("error", (error) => finish(reject, error));
    });
    connectRequest.once("timeout", () => connectRequest.destroy(new Error("OpenAI 代理连接超时。")));
    connectRequest.once("error", (error) => finish(reject, error));
    connectRequest.setTimeout(config.openai.requestTimeoutMs);
    connectRequest.end();
  });
}

/*
  The code below keeps schema and input builders close to the OpenAI caller.
*/

function extractResponseText(data) {
  if (typeof data?.output_text === "string") return data.output_text;
  const pieces = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        pieces.push(content.text);
      }
    }
  }
  return pieces.join("\n").trim();
}

/*
  Public builder helpers.
*/

export function buildChapterInput({ chapterIndex, title, content, userPrompt }) {
  return [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: [
            userPrompt,
            "",
            `章节编号：${chapterIndex}`,
            `章节标题：${title || ""}`,
            "",
            "章节原文：",
            content
          ].join("\n")
        }
      ]
    }
  ];
}

export function buildSummaryInput({ chapterResults, failedChapters, userPrompt }) {
  return [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: [
            userPrompt,
            "",
            "逐章理解结果 JSON：",
            JSON.stringify(chapterResults),
            "",
            "失败章节：",
            JSON.stringify(failedChapters)
          ].join("\n")
        }
      ]
    }
  ];
}

export function buildSummaryCompressionInput({ chapterResults, failedChapters, batchIndex, totalBatches, userPrompt }) {
  return [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: [
            "你正在为小说分析任务压缩逐章理解结果，供最终汇总使用。",
            "请严格围绕用户最终分析目标进行压缩，保留与目标有关的事实、角色、关系、事件、线索、证据和章节引用。",
            "不要添加原文长引用，不要输出 Markdown。",
            `当前批次：${batchIndex}/${totalBatches}`,
            "",
            "用户最终汇总 Prompt：",
            userPrompt,
            "",
            "逐章理解结果 JSON：",
            JSON.stringify(chapterResults),
            "",
            "本批失败章节：",
            JSON.stringify(failedChapters)
          ].join("\n")
        }
      ]
    }
  ];
}

export function summaryCompressionSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      covered_chapters: {
        type: "array",
        items: { type: "integer" }
      },
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            topic: { type: "string" },
            facts: {
              type: "array",
              items: { type: "string" }
            },
            chapter_refs: {
              type: "array",
              items: { type: "integer" }
            },
            evidence_notes: {
              type: "array",
              items: { type: "string" }
            },
            uncertainty: { type: "string" }
          },
          required: ["topic", "facts", "chapter_refs", "evidence_notes", "uncertainty"]
        }
      },
      must_keep: {
        type: "array",
        items: { type: "string" }
      },
      possible_conflicts: {
        type: "array",
        items: { type: "string" }
      },
      missing_or_failed_chapters: {
        type: "array",
        items: { type: "integer" }
      }
    },
    required: ["covered_chapters", "items", "must_keep", "possible_conflicts", "missing_or_failed_chapters"]
  };
}

export function buildCompressedSummaryInput({ compressedResults, failedChapters, userPrompt }) {
  return [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: [
            userPrompt,
            "",
            "以下是逐章理解结果的分批压缩摘要 JSON。请基于这些中间摘要进行最终汇总。",
            "注意：中间摘要已经包含章节引用和关键证据线索；不要要求重新读取原文。",
            "",
            "分批压缩摘要 JSON：",
            JSON.stringify(compressedResults),
            "",
            "失败章节：",
            JSON.stringify(failedChapters)
          ].join("\n")
        }
      ]
    }
  ];
}

export function buildL1ChapterInput({ chapterIndex, title, content, indexPrompt }) {
  return [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: [
            indexPrompt || defaultL1IndexPrompt(),
            "",
            `章节编号：${chapterIndex}`,
            `章节标题：${title || ""}`,
            "",
            "章节原文：",
            content
          ].join("\n")
        }
      ]
    }
  ];
}

export function buildL2ChapterInput({ chapterIndex, title, content, l1Index, indexPrompt }) {
  return [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: [
            indexPrompt || defaultL2IndexPrompt(),
            "",
            `章节编号：${chapterIndex}`,
            `章节标题：${title || ""}`,
            "",
            "可选 L1 路标 JSON：",
            JSON.stringify(l1Index || null),
            "",
            "章节原文：",
            content
          ].join("\n")
        }
      ]
    }
  ];
}

export function defaultL1IndexPrompt() {
  return [
    "请为当前小说章节建立可复用 L1 基础索引。",
    "要求：只依据本章原文；不要输出 Markdown；不要引用长段原文；实体和事件尽量短句化，保留可用于后续分析的事实。"
  ].join("\n");
}

export function defaultL2IndexPrompt() {
  return [
    "请为当前小说章节建立 L2 类型化事实索引。",
    "目标：提取可复用、可检索、可追溯的事实单元，不要写长摘要，不要输出 Markdown。",
    "分类只能使用：character、relationship、cultivation、force、item、location、event、foreshadowing、other。",
    "每条事实必须短而明确，保留主体、相关主体、事实类型、重要度、置信度和少量证据摘记。",
    "不要补充本章原文之外的信息；如果本章没有可复用事实，facts 输出空数组。"
  ].join("\n");
}

export function buildIndexSummaryInput({ facts, reviewedChapters, missingChapters, userPrompt, sourceStats }) {
  return [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: [
            userPrompt,
            "",
            "以下是从本地 L2 类型化事实索引召回的事实。请基于这些事实完成最终汇总。",
            "要求：尊重事实的章节引用、重要度和置信度；不要虚构未出现的信息；如信息不足，可以在结果中体现不确定性。",
            "",
            "召回统计 JSON：",
            JSON.stringify(sourceStats || {}),
            "",
            "L2 事实 JSON：",
            JSON.stringify(facts || []),
            "",
            "原文复核补充 JSON：",
            JSON.stringify(reviewedChapters || []),
            "",
            "索引缺口章节：",
            JSON.stringify(missingChapters || [])
          ].join("\n")
        }
      ]
    }
  ];
}

export function l2ChapterFactsSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      facts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            category: {
              type: "string",
              enum: ["character", "relationship", "cultivation", "force", "item", "location", "event", "foreshadowing", "other"]
            },
            entity: { type: "string" },
            aliases: {
              type: "array",
              items: { type: "string" }
            },
            tags: {
              type: "array",
              items: { type: "string" }
            },
            related_entities: {
              type: "array",
              items: { type: "string" }
            },
            fact_type: { type: "string" },
            fact: { type: "string" },
            evidence: {
              type: "array",
              items: { type: "string" }
            },
            importance: { type: "number" },
            confidence: { type: "number" }
          },
          required: ["category", "entity", "aliases", "tags", "related_entities", "fact_type", "fact", "evidence", "importance", "confidence"]
        }
      }
    },
    required: ["facts"]
  };
}

export function buildL1WindowInput({ windowStart, windowEnd, chapterIndexes }) {
  return [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: [
            "请基于以下逐章 L1 索引，生成 10 章窗口级基础索引。",
            "要求：不要补充原文之外的信息；聚合时间线、实体变化、关系变化和伏笔线索；不要输出 Markdown。",
            "",
            `窗口范围：${windowStart}-${windowEnd}`,
            "逐章 L1 索引 JSON：",
            JSON.stringify(chapterIndexes)
          ].join("\n")
        }
      ]
    }
  ];
}

export function chapterResultSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      chapter_index: { type: "integer" },
      chapter_title: { type: "string" },
      summary: { type: "string" },
      key_points: {
        type: "array",
        items: { type: "string" }
      },
      evidence_notes: {
        type: "array",
        items: { type: "string" }
      }
    },
    required: ["chapter_index", "chapter_title", "summary", "key_points", "evidence_notes"]
  };
}

export function l1ChapterIndexSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: { type: "string" },
      keywords: {
        type: "array",
        items: { type: "string" }
      },
      entities: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            type: { type: "string" },
            aliases: {
              type: "array",
              items: { type: "string" }
            },
            note: { type: "string" }
          },
          required: ["name", "type", "aliases", "note"]
        }
      },
      key_events: {
        type: "array",
        items: { type: "string" }
      },
      items_places_orgs: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            type: { type: "string" },
            note: { type: "string" }
          },
          required: ["name", "type", "note"]
        }
      },
      open_questions: {
        type: "array",
        items: { type: "string" }
      },
      confidence: { type: "number" }
    },
    required: ["summary", "keywords", "entities", "key_events", "items_places_orgs", "open_questions", "confidence"]
  };
}

export function l1WindowIndexSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: { type: "string" },
      timeline: {
        type: "array",
        items: { type: "string" }
      },
      entity_changes: {
        type: "array",
        items: { type: "string" }
      },
      relationship_changes: {
        type: "array",
        items: { type: "string" }
      },
      foreshadowing: {
        type: "array",
        items: { type: "string" }
      },
      covered_chapters: {
        type: "array",
        items: { type: "integer" }
      },
      missing_chapters: {
        type: "array",
        items: { type: "integer" }
      },
      confidence: { type: "number" }
    },
    required: ["summary", "timeline", "entity_changes", "relationship_changes", "foreshadowing", "covered_chapters", "missing_chapters", "confidence"]
  };
}

export function parseOutputSchema(value) {
  if (!value) {
    const error = new Error("输出 JSON Schema 不能为空。");
    error.status = 400;
    throw error;
  }
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== "object") throw new Error("schema must be object");
    return parsed;
  } catch (error) {
    const wrapped = new Error(`输出 JSON Schema 无效：${error.message}`);
    wrapped.status = 400;
    throw wrapped;
  }
}
