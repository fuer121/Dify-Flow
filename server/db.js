import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";
import { decryptText, encryptText, hmacText, sha256 } from "./crypto.js";
import {
  defaultSchemaFields,
  normalizeSchemaFields,
  normalizeSchemaMode,
  parseSchemaOrThrow,
  schemaFromFields
} from "./schema.js";

const dbPath = path.join(config.dataDir, "novel-chapters.sqlite");
const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS books (
    book_id TEXT PRIMARY KEY,
    book_name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_import_status TEXT NOT NULL DEFAULT 'idle'
  );

  CREATE TABLE IF NOT EXISTS chapters (
    book_id TEXT NOT NULL,
    chapter_index INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    content_length INTEGER NOT NULL DEFAULT 0,
    content_hmac TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    tag TEXT NOT NULL,
    algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm',
    fetch_status TEXT NOT NULL DEFAULT 'ok',
    fetched_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (book_id, chapter_index),
    FOREIGN KEY (book_id) REFERENCES books(book_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS prompt_settings (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    model TEXT NOT NULL,
    reasoning_effort TEXT NOT NULL,
    chapter_prompt TEXT NOT NULL,
    summary_prompt TEXT NOT NULL,
    output_schema TEXT NOT NULL,
    schema_mode TEXT NOT NULL DEFAULT 'fields',
    schema_fields TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS prompt_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '未分类',
    chapter_prompt TEXT NOT NULL,
    summary_prompt TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS analysis_runs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    book_id TEXT NOT NULL,
    start_chapter INTEGER NOT NULL,
    end_chapter INTEGER NOT NULL,
    chapter_selection TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL,
    reasoning_effort TEXT NOT NULL,
    prompt_hash TEXT NOT NULL,
    schema_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    chapter_count INTEGER NOT NULL DEFAULT 0,
    error_summary TEXT NOT NULL DEFAULT '',
    prompt_ciphertext TEXT,
    prompt_iv TEXT,
    prompt_tag TEXT,
    prompt_algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm',
    ciphertext TEXT,
    iv TEXT,
    tag TEXT,
    algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (book_id) REFERENCES books(book_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS analysis_chapters (
    analysis_id TEXT NOT NULL,
    chapter_index INTEGER NOT NULL,
    status TEXT NOT NULL,
    content_hmac TEXT,
    prompt_hash TEXT NOT NULL,
    ciphertext TEXT,
    iv TEXT,
    tag TEXT,
    algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm',
    error_summary TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (analysis_id, chapter_index),
    FOREIGN KEY (analysis_id) REFERENCES analysis_runs(id) ON DELETE CASCADE
  );
`);

migrateSchema();
seedDefaultPrompts();
seedDefaultPromptGroups();

export function getDbPath() {
  return dbPath;
}

export function nowIso() {
  return new Date().toISOString();
}

export function ensureBook(bookId, bookName = "") {
  const id = normalizeBookId(bookId);
  const name = normalizeBookName(bookName);
  const now = nowIso();
  const existing = getBook(id);

  if (existing) {
    if (name && existing.book_name && existing.book_name !== name) {
      const error = new Error(`小说 ID ${id} 已绑定书名《${existing.book_name}》，不能再绑定为《${name}》。`);
      error.status = 409;
      throw error;
    }
    db.prepare("UPDATE books SET book_name = ?, updated_at = ? WHERE book_id = ?")
      .run(existing.book_name || name, now, id);
    return getBook(id);
  }

  db.prepare(`
    INSERT INTO books (book_id, book_name, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(id, name, now, now);
  return getBook(id);
}

export function getBook(bookId) {
  return db.prepare("SELECT * FROM books WHERE book_id = ?").get(normalizeBookId(bookId));
}

export function listBooks() {
  return db.prepare(`
    SELECT
      b.book_id,
      b.book_name,
      b.created_at,
      b.updated_at,
      b.last_import_status,
      COUNT(c.chapter_index) AS chapter_count,
      MIN(c.chapter_index) AS first_chapter,
      MAX(c.chapter_index) AS last_chapter
    FROM books b
    LEFT JOIN chapters c ON c.book_id = b.book_id
    GROUP BY b.book_id
    ORDER BY b.updated_at DESC
  `).all();
}

export function updateBookImportStatus(bookId, status) {
  db.prepare("UPDATE books SET last_import_status = ?, updated_at = ? WHERE book_id = ?")
    .run(String(status || "idle"), nowIso(), normalizeBookId(bookId));
}

export function listChapterMetadata(bookId) {
  return db.prepare(`
    SELECT book_id, chapter_index, title, content_length, content_hmac, fetch_status, fetched_at, updated_at
    FROM chapters
    WHERE book_id = ?
    ORDER BY chapter_index ASC
  `).all(normalizeBookId(bookId));
}

export function getChapterMetadata(bookId, chapterIndex) {
  return db.prepare(`
    SELECT book_id, chapter_index, title, content_length, content_hmac, fetch_status, fetched_at, updated_at
    FROM chapters
    WHERE book_id = ? AND chapter_index = ?
  `).get(normalizeBookId(bookId), normalizeChapterIndex(chapterIndex));
}

export function getExistingChapterIndexes(bookId, startChapter, endChapter) {
  const rows = db.prepare(`
    SELECT chapter_index
    FROM chapters
    WHERE book_id = ? AND chapter_index BETWEEN ? AND ?
  `).all(normalizeBookId(bookId), normalizeChapterIndex(startChapter), normalizeChapterIndex(endChapter));
  return new Set(rows.map((row) => row.chapter_index));
}

export async function saveEncryptedChapter({ bookId, chapterIndex, title = "", content, fetchStatus = "ok" }) {
  const normalizedBookId = normalizeBookId(bookId);
  const normalizedIndex = normalizeChapterIndex(chapterIndex);
  const text = String(content || "");
  const aad = chapterAad(normalizedBookId, normalizedIndex);
  const encrypted = await encryptText(text, aad);
  const contentHmac = await hmacText(text);
  const now = nowIso();

  ensureBook(normalizedBookId);
  db.prepare(`
    INSERT INTO chapters (
      book_id, chapter_index, title, content_length, content_hmac,
      ciphertext, iv, tag, algorithm, fetch_status, fetched_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(book_id, chapter_index) DO UPDATE SET
      title = excluded.title,
      content_length = excluded.content_length,
      content_hmac = excluded.content_hmac,
      ciphertext = excluded.ciphertext,
      iv = excluded.iv,
      tag = excluded.tag,
      algorithm = excluded.algorithm,
      fetch_status = excluded.fetch_status,
      fetched_at = excluded.fetched_at,
      updated_at = excluded.updated_at
  `).run(
    normalizedBookId,
    normalizedIndex,
    String(title || ""),
    text.length,
    contentHmac,
    encrypted.ciphertext,
    encrypted.iv,
    encrypted.tag,
    encrypted.algorithm,
    String(fetchStatus || "ok"),
    now,
    now
  );

  return getChapterMetadata(normalizedBookId, normalizedIndex);
}

export async function decryptChapterContent(bookId, chapterIndex) {
  const normalizedBookId = normalizeBookId(bookId);
  const normalizedIndex = normalizeChapterIndex(chapterIndex);
  const row = db.prepare(`
    SELECT ciphertext, iv, tag, algorithm
    FROM chapters
    WHERE book_id = ? AND chapter_index = ?
  `).get(normalizedBookId, normalizedIndex);

  if (!row) {
    const error = new Error(`章节不存在：${normalizedBookId} #${normalizedIndex}`);
    error.status = 404;
    throw error;
  }

  return decryptText(row, chapterAad(normalizedBookId, normalizedIndex));
}

export function deleteBook(bookId) {
  const id = normalizeBookId(bookId);
  const result = db.prepare("DELETE FROM books WHERE book_id = ?").run(id);
  return { deleted: result.changes > 0, bookId: id };
}

export function getPromptSettings() {
  return publicPromptSettings(db.prepare("SELECT * FROM prompt_settings WHERE id = 'default'").get());
}

export function savePromptSettings(settings) {
  const next = normalizePromptSettings(settings);
  db.prepare(`
    INSERT INTO prompt_settings (
      id, name, model, reasoning_effort, chapter_prompt, summary_prompt,
      output_schema, schema_mode, schema_fields, updated_at
    )
    VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      model = excluded.model,
      reasoning_effort = excluded.reasoning_effort,
      chapter_prompt = excluded.chapter_prompt,
      summary_prompt = excluded.summary_prompt,
      output_schema = excluded.output_schema,
      schema_mode = excluded.schema_mode,
      schema_fields = excluded.schema_fields,
      updated_at = excluded.updated_at
  `).run(
    next.name,
    next.model,
    next.reasoning_effort,
    next.chapter_prompt,
    next.summary_prompt,
    next.output_schema,
    next.schema_mode,
    JSON.stringify(next.schema_fields),
    nowIso()
  );
  return getPromptSettings();
}

export function listPromptGroups(category) {
  if (category) {
    return db.prepare(`
      SELECT id, name, category, chapter_prompt, summary_prompt, created_at, updated_at
      FROM prompt_groups
      WHERE category = ?
      ORDER BY category ASC, updated_at DESC
    `).all(normalizePromptCategory(category));
  }

  return db.prepare(`
    SELECT id, name, category, chapter_prompt, summary_prompt, created_at, updated_at
    FROM prompt_groups
    ORDER BY category ASC, updated_at DESC
  `).all();
}

export function getPromptGroup(id) {
  return db.prepare(`
    SELECT id, name, category, chapter_prompt, summary_prompt, created_at, updated_at
    FROM prompt_groups
    WHERE id = ?
  `).get(String(id || ""));
}

export function createPromptGroup(payload = {}) {
  const group = normalizePromptGroup(payload);
  const id = crypto.randomUUID();
  const now = nowIso();
  db.prepare(`
    INSERT INTO prompt_groups (id, name, category, chapter_prompt, summary_prompt, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, group.name, group.category, group.chapter_prompt, group.summary_prompt, now, now);
  return getPromptGroup(id);
}

export function updatePromptGroup(id, payload = {}) {
  const current = getPromptGroup(id);
  if (!current) {
    const error = new Error("Prompt 组不存在。");
    error.status = 404;
    throw error;
  }
  const next = normalizePromptGroup({ ...current, ...payload });
  db.prepare(`
    UPDATE prompt_groups
    SET name = ?, category = ?, chapter_prompt = ?, summary_prompt = ?, updated_at = ?
    WHERE id = ?
  `).run(next.name, next.category, next.chapter_prompt, next.summary_prompt, nowIso(), current.id);
  return getPromptGroup(current.id);
}

export function deletePromptGroup(id) {
  const result = db.prepare("DELETE FROM prompt_groups WHERE id = ?").run(String(id || ""));
  return { deleted: result.changes > 0, id: String(id || "") };
}

export async function createAnalysisRun({
  id,
  name,
  bookId,
  startChapter,
  endChapter,
  chapterSelection,
  model,
  reasoningEffort,
  promptHash,
  schemaHash,
  chapterCount,
  promptSnapshot
}) {
  const now = nowIso();
  const promptEncrypted = promptSnapshot
    ? await encryptText(JSON.stringify(promptSnapshot), analysisPromptAad(id))
    : null;
  db.prepare(`
    INSERT INTO analysis_runs (
      id, name, book_id, start_chapter, end_chapter, chapter_selection,
      model, reasoning_effort, prompt_hash, schema_hash, status, chapter_count,
      prompt_ciphertext, prompt_iv, prompt_tag, prompt_algorithm, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    normalizeAnalysisName(name, bookId, startChapter, endChapter),
    normalizeBookId(bookId),
    normalizeChapterIndex(startChapter),
    normalizeChapterIndex(endChapter),
    JSON.stringify(chapterSelection || {}),
    model,
    reasoningEffort,
    promptHash,
    schemaHash,
    chapterCount,
    promptEncrypted?.ciphertext || null,
    promptEncrypted?.iv || null,
    promptEncrypted?.tag || null,
    promptEncrypted?.algorithm || "aes-256-gcm",
    now,
    now
  );
  return getAnalysisRun(id);
}

export function updateAnalysisRun(id, patch = {}) {
  const current = getAnalysisRun(id);
  if (!current) return null;
  const next = { ...current, ...patch, updated_at: nowIso() };
  db.prepare(`
    UPDATE analysis_runs
    SET status = ?, error_summary = ?, ciphertext = ?, iv = ?, tag = ?, algorithm = ?, updated_at = ?
    WHERE id = ?
  `).run(
    next.status,
    next.error_summary || "",
    next.ciphertext || null,
    next.iv || null,
    next.tag || null,
    next.algorithm || "aes-256-gcm",
    next.updated_at,
    id
  );
  return getAnalysisRun(id);
}

export function getAnalysisRun(id) {
  return db.prepare("SELECT * FROM analysis_runs WHERE id = ?").get(String(id || ""));
}

export function listAnalysisRuns(bookId) {
  if (bookId) {
    return db.prepare(`
      SELECT id, name, book_id, start_chapter, end_chapter, chapter_selection,
        model, reasoning_effort, prompt_hash, schema_hash, status, chapter_count,
        error_summary, created_at, updated_at
      FROM analysis_runs
      WHERE book_id = ?
      ORDER BY created_at DESC
    `).all(normalizeBookId(bookId));
  }

  return db.prepare(`
    SELECT id, name, book_id, start_chapter, end_chapter, chapter_selection,
      model, reasoning_effort, prompt_hash, schema_hash, status, chapter_count,
      error_summary, created_at, updated_at
    FROM analysis_runs
    ORDER BY created_at DESC
    LIMIT 100
  `).all();
}

export function deleteAnalysisRun(id) {
  const result = db.prepare("DELETE FROM analysis_runs WHERE id = ?").run(String(id || ""));
  return { deleted: result.changes > 0, id: String(id || "") };
}

export async function saveAnalysisChapter({ analysisId, chapterIndex, status, contentHmac, promptHash, result, errorSummary = "" }) {
  const encrypted = result === undefined ? null : await encryptText(JSON.stringify(result), analysisChapterAad(analysisId, chapterIndex));
  db.prepare(`
    INSERT INTO analysis_chapters (
      analysis_id, chapter_index, status, content_hmac, prompt_hash,
      ciphertext, iv, tag, algorithm, error_summary, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(analysis_id, chapter_index) DO UPDATE SET
      status = excluded.status,
      content_hmac = excluded.content_hmac,
      prompt_hash = excluded.prompt_hash,
      ciphertext = excluded.ciphertext,
      iv = excluded.iv,
      tag = excluded.tag,
      algorithm = excluded.algorithm,
      error_summary = excluded.error_summary,
      updated_at = excluded.updated_at
  `).run(
    analysisId,
    normalizeChapterIndex(chapterIndex),
    status,
    contentHmac || "",
    promptHash,
    encrypted?.ciphertext || null,
    encrypted?.iv || null,
    encrypted?.tag || null,
    encrypted?.algorithm || "aes-256-gcm",
    String(errorSummary || "").slice(0, 1000),
    nowIso()
  );
}

export function listAnalysisChapterMetadata(analysisId) {
  return db.prepare(`
    SELECT analysis_id, chapter_index, status, content_hmac, prompt_hash, error_summary, updated_at
    FROM analysis_chapters
    WHERE analysis_id = ?
    ORDER BY chapter_index ASC
  `).all(String(analysisId || ""));
}

export async function decryptAnalysisChapterResult(analysisId, chapterIndex) {
  const row = db.prepare(`
    SELECT ciphertext, iv, tag
    FROM analysis_chapters
    WHERE analysis_id = ? AND chapter_index = ?
  `).get(String(analysisId || ""), normalizeChapterIndex(chapterIndex));
  if (!row?.ciphertext) return null;
  return JSON.parse(await decryptText(row, analysisChapterAad(analysisId, chapterIndex)));
}

export async function saveFinalAnalysisResult(analysisId, result) {
  const encrypted = await encryptText(JSON.stringify(result), analysisRunAad(analysisId));
  return updateAnalysisRun(analysisId, {
    status: "completed",
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    tag: encrypted.tag,
    algorithm: encrypted.algorithm
  });
}

export async function decryptFinalAnalysisResult(analysisId) {
  const row = getAnalysisRun(analysisId);
  if (!row?.ciphertext) return null;
  return JSON.parse(await decryptText(row, analysisRunAad(analysisId)));
}

export async function decryptAnalysisPromptSnapshot(analysisId) {
  const row = getAnalysisRun(analysisId);
  if (!row?.prompt_ciphertext) return null;
  return JSON.parse(await decryptText({
    ciphertext: row.prompt_ciphertext,
    iv: row.prompt_iv,
    tag: row.prompt_tag,
    algorithm: row.prompt_algorithm
  }, analysisPromptAad(analysisId)));
}

export function normalizeBookId(bookId) {
  const value = String(bookId || "").trim();
  if (!value) {
    const error = new Error("book_id 不能为空。");
    error.status = 400;
    throw error;
  }
  return value;
}

export function normalizeBookName(bookName) {
  return String(bookName || "").trim().slice(0, 120);
}

export function normalizePromptCategory(category) {
  return String(category || "未分类").trim().slice(0, 80) || "未分类";
}

export function normalizeChapterIndex(value) {
  const index = Number.parseInt(value, 10);
  if (!Number.isFinite(index) || index <= 0) {
    const error = new Error("章节编号必须是大于 0 的整数。");
    error.status = 400;
    throw error;
  }
  return index;
}

export function normalizeRange(startChapter, endChapter) {
  const start = normalizeChapterIndex(startChapter);
  const end = normalizeChapterIndex(endChapter);
  return {
    startChapter: start,
    endChapter: end < start ? start : end,
    total: Math.max(1, (end < start ? start : end) - start + 1)
  };
}

export function promptHash(settings) {
  return sha256(`${settings.chapter_prompt}\n---SUMMARY---\n${settings.summary_prompt}`);
}

export function schemaHash(settings) {
  return sha256(settings.output_schema);
}

export function normalizePromptSettings(settings = {}) {
  const schemaMode = normalizeSchemaMode(settings.schema_mode);
  const schemaFields = normalizeSchemaFields(settings.schema_fields);
  const schema = schemaMode === "fields"
    ? schemaFromFields(schemaFields)
    : parseSchemaOrThrow(settings.output_schema || defaultOutputSchema());
  return {
    name: String(settings.name || "默认小说理解模板").trim() || "默认小说理解模板",
    model: String(settings.model || config.openai.model || "gpt-5.5").trim(),
    reasoning_effort: normalizeReasoningEffort(settings.reasoning_effort || "medium"),
    chapter_prompt: String(settings.chapter_prompt || defaultChapterPrompt()).trim(),
    summary_prompt: String(settings.summary_prompt || defaultSummaryPrompt()).trim(),
    output_schema: JSON.stringify(schema, null, 2),
    schema_mode: schemaMode,
    schema_fields: schemaFields
  };
}

function normalizeReasoningEffort(value) {
  return ["none", "low", "medium", "high", "xhigh"].includes(value) ? value : "medium";
}

function migrateSchema() {
  ensureColumn("books", "book_name", "book_name TEXT NOT NULL DEFAULT ''");
  ensureColumn("prompt_settings", "schema_mode", "schema_mode TEXT NOT NULL DEFAULT 'fields'");
  ensureColumn("prompt_settings", "schema_fields", "schema_fields TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("analysis_runs", "name", "name TEXT NOT NULL DEFAULT ''");
  ensureColumn("analysis_runs", "chapter_selection", "chapter_selection TEXT NOT NULL DEFAULT ''");
  ensureColumn("analysis_runs", "prompt_ciphertext", "prompt_ciphertext TEXT");
  ensureColumn("analysis_runs", "prompt_iv", "prompt_iv TEXT");
  ensureColumn("analysis_runs", "prompt_tag", "prompt_tag TEXT");
  ensureColumn("analysis_runs", "prompt_algorithm", "prompt_algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm'");
}

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((entry) => entry.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function seedDefaultPrompts() {
  const exists = db.prepare("SELECT id FROM prompt_settings WHERE id = 'default'").get();
  if (exists) return;
  savePromptSettings({});
}

function seedDefaultPromptGroups() {
  const exists = db.prepare("SELECT id FROM prompt_groups LIMIT 1").get();
  if (exists) return;
  const settings = getPromptSettings();
  createPromptGroup({
    name: settings.name || "默认小说理解 Prompt",
    category: "通用",
    chapter_prompt: settings.chapter_prompt,
    summary_prompt: settings.summary_prompt
  });
}

function normalizePromptGroup(payload = {}) {
  return {
    name: String(payload.name || "未命名 Prompt 组").trim().slice(0, 120) || "未命名 Prompt 组",
    category: normalizePromptCategory(payload.category),
    chapter_prompt: String(payload.chapter_prompt || defaultChapterPrompt()).trim(),
    summary_prompt: String(payload.summary_prompt || defaultSummaryPrompt()).trim()
  };
}

function publicPromptSettings(row) {
  if (!row) return normalizePromptSettings({});
  return {
    ...row,
    schema_mode: normalizeSchemaMode(row.schema_mode),
    schema_fields: normalizeSchemaFields(row.schema_fields)
  };
}

function normalizeAnalysisName(name, bookId, startChapter, endChapter) {
  const value = String(name || "").trim();
  if (value) return value.slice(0, 120);
  return `${normalizeBookId(bookId)} ${normalizeChapterIndex(startChapter)}-${normalizeChapterIndex(endChapter)}`;
}

function chapterAad(bookId, chapterIndex) {
  return `chapter:${bookId}:${chapterIndex}`;
}

function analysisChapterAad(analysisId, chapterIndex) {
  return `analysis-chapter:${analysisId}:${chapterIndex}`;
}

function analysisRunAad(analysisId) {
  return `analysis-final:${analysisId}`;
}

function analysisPromptAad(analysisId) {
  return `analysis-prompt:${analysisId}`;
}

function defaultChapterPrompt() {
  return [
    "你是小说章节理解助手。请只根据当前章节原文，提取与用户目标有关的信息。",
    "不要引用大段原文，不要补充后续剧情，不要输出 Markdown。",
    "请输出 JSON 对象，包含 chapter_index、chapter_title、summary、key_points、evidence_notes。"
  ].join("\n");
}

function defaultSummaryPrompt() {
  return [
    "你是小说多章节汇总助手。请基于逐章理解结果进行合并，去重、归纳并输出用户指定内容。",
    "不要输出 Markdown，不要复述长段原文。最终输出必须匹配给定 JSON Schema。"
  ].join("\n");
}

function defaultOutputSchema() {
  return JSON.stringify(schemaFromFields(defaultSchemaFields()), null, 2);
}
