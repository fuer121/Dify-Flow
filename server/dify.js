import { config, requireDifyConfig } from "./config.js";
import { sanitizeDetails, sanitizeText } from "./sanitize.js";

export function buildChapterBatches(startChapter, endChapter, batchSize = config.dify.batchSize) {
  const batches = [];
  for (let start = startChapter; start <= endChapter; start += batchSize) {
    batches.push({
      startChapter: start,
      endChapter: Math.min(endChapter, start + batchSize - 1)
    });
  }
  return batches;
}

export async function fetchChapterBatch({ bookId, startChapter, endChapter }) {
  requireDifyConfig();
  let response;
  try {
    response = await fetch(`${config.dify.base}/workflows/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.dify.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        inputs: {
          book_id: bookId,
          start_chapter: startChapter,
          end_chapter: endChapter
        },
        response_mode: "blocking",
        user: config.dify.user
      })
    });
  } catch (error) {
    const wrapped = new Error(`无法连接 Dify API：${config.dify.base}（${error.message}）`);
    wrapped.status = 502;
    throw wrapped;
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(sanitizeText(data?.message || data?.error || `Dify 调用失败：HTTP ${response.status}`));
    error.status = response.status;
    error.details = sanitizeDetails(data);
    throw error;
  }

  const outputs = data?.data?.outputs || {};
  const raw = outputs.result ?? outputs.text ?? outputs.chapters ?? outputs.output;
  return normalizeDifyChapterOutput(raw, { bookId, startChapter, endChapter });
}

export function normalizeDifyChapterOutput(raw, context = {}) {
  const value = parseJsonMaybe(raw);
  const chapters = extractChapters(value);
  return chapters.map((chapter, offset) => {
    const index = Number.parseInt(
      chapter.chapter_index ?? chapter.chapterIndex ?? chapter.index ?? chapter.sortid ?? chapter.sort_id ?? context.startChapter + offset,
      10
    );
    const content = String(
      chapter.content ?? chapter.text ?? chapter.chapter_content ?? chapter.chapterContent ?? ""
    );
    return {
      book_id: String(chapter.book_id ?? chapter.bookId ?? context.bookId ?? ""),
      chapter_index: Number.isFinite(index) ? index : context.startChapter + offset,
      chapter_title: String(chapter.chapter_title ?? chapter.title ?? ""),
      content,
      fetch_status: String(chapter.fetch_status ?? chapter.status ?? "ok")
    };
  });
}

function parseJsonMaybe(raw) {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return JSON.parse(fenced[1].trim());
    return trimmed;
  }
}

function extractChapters(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    for (const key of ["chapters", "data", "items", "result", "records"]) {
      if (Array.isArray(value[key])) return value[key];
    }
    if (typeof value.content === "string" || typeof value.text === "string") return [value];
  }
  if (typeof value === "string") {
    return [{ content: value }];
  }
  return [];
}
