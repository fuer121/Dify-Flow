import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { config, requireOpenAIConfig } from "./config.js";
import { sanitizeDetails, sanitizeText } from "./sanitize.js";

export async function callOpenAIJson({ model, reasoningEffort, instructions, input, schema, schemaName = "result" }) {
  requireOpenAIConfig();
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
        strict: true
      }
    }
  };

  const response = await postOpenAIJson("responses", body);

  if (!response.ok) {
    const error = new Error(sanitizeText(response.data?.error?.message || response.data?.message || `OpenAI 调用失败：HTTP ${response.status}`));
    error.status = response.status;
    error.details = sanitizeDetails(response.data);
    throw error;
  }

  const text = extractResponseText(response.data);
  try {
    return {
      value: JSON.parse(text),
      responseId: response.data?.id || null
    };
  } catch (error) {
    const wrapped = new Error(`OpenAI 返回不是合法 JSON：${error.message}`);
    wrapped.status = 502;
    throw wrapped;
  }
}

async function postOpenAIJson(path, body) {
  const endpoint = `${config.openai.base}/${path.replace(/^\/+/, "")}`;
  const headers = {
    Authorization: `Bearer ${config.openai.apiKey}`,
    "Content-Type": "application/json"
  };
  const payload = JSON.stringify(body);

  try {
    if (config.openai.proxyUrl) {
      return await postJsonViaHttpProxy(endpoint, headers, payload);
    }
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
  } catch (error) {
    throw openAINetworkError(error);
  }
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
