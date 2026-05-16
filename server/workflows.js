import {
  createAnalysisRun,
  decryptAnalysisPromptSnapshot,
  decryptChapterContent,
  decryptFinalAnalysisResult,
  ensureBook,
  getAnalysisRun,
  getExistingChapterIndexes,
  getPromptSettings,
  listAnalysisChapterMetadata,
  listChapterMetadata,
  normalizeBookId,
  normalizeBookName,
  normalizeChapterIndex,
  normalizePromptSettings,
  normalizeRange,
  promptHash,
  saveAnalysisChapter,
  saveEncryptedChapter,
  saveFinalAnalysisResult,
  schemaHash,
  updateAnalysisRun,
  updateBookImportStatus
} from "./db.js";
import { buildChapterBatches, fetchChapterBatch } from "./dify.js";
import {
  buildChapterInput,
  buildSummaryInput,
  callOpenAIJson,
  chapterResultSchema,
  parseOutputSchema,
  testOpenAIConnection
} from "./openai.js";
import {
  assertNotCancelled,
  completeTask,
  createTask,
  failTask,
  markTaskRunning,
  updateTask
} from "./tasks.js";
import { sanitizeText } from "./sanitize.js";

export function startImportTask(payload) {
  const bookId = normalizeBookId(payload.book_id ?? payload.bookId);
  const bookName = normalizeBookName(payload.book_name ?? payload.bookName);
  const range = normalizeRange(payload.start_chapter ?? payload.startChapter, payload.end_chapter ?? payload.endChapter);
  const force = Boolean(payload.force);
  const task = createTask("import", {
    bookId,
    bookName,
    startChapter: range.startChapter,
    endChapter: range.endChapter,
    force
  });

  void runImportTask(task, { bookId, bookName, ...range, force });
  return task;
}

export function startAnalysisTask(payload) {
  const bookId = normalizeBookId(payload.book_id ?? payload.bookId);
  const range = normalizeRange(payload.start_chapter ?? payload.startChapter, payload.end_chapter ?? payload.endChapter);
  const chapterIndexes = normalizeChapterIndexes(payload.chapter_indexes ?? payload.chapterIndexes);
  const name = String(payload.name || "").trim();
  const task = createTask("analysis", {
    name,
    bookId,
    startChapter: range.startChapter,
    endChapter: range.endChapter,
    chapterCount: chapterIndexes.length || range.total
  });

  void runAnalysisTask(task, {
    name,
    bookId,
    ...range,
    chapterIndexes,
    promptPatch: payload.prompt || {}
  });
  return task;
}

async function runImportTask(task, { bookId, bookName, startChapter, endChapter, total, force }) {
  try {
    ensureBook(bookId, bookName);
    updateBookImportStatus(bookId, "running");
    markTaskRunning(task, {
      progress: {
        total,
        completed: 0,
        failed: 0,
        skipped: 0,
        current: "准备导入"
      }
    });

    const existing = force ? new Set() : getExistingChapterIndexes(bookId, startChapter, endChapter);
    const batches = buildChapterBatches(startChapter, endChapter);

    for (const batch of batches) {
      assertNotCancelled(task);
      const indexes = rangeIndexes(batch.startChapter, batch.endChapter);
      const missing = indexes.filter((index) => !existing.has(index));
      if (missing.length === 0) {
        task.progress.skipped += indexes.length;
        task.progress.completed += indexes.length;
        updateTask(task, {
          progress: { ...task.progress, current: `跳过 ${batch.startChapter}-${batch.endChapter}` },
          message: `章节 ${batch.startChapter}-${batch.endChapter} 已存在，跳过。`
        });
        continue;
      }

      updateTask(task, {
        progress: { ...task.progress, current: `Dify 获取 ${batch.startChapter}-${batch.endChapter}` },
        message: `正在获取章节 ${batch.startChapter}-${batch.endChapter}`
      });

      try {
        const chapters = await fetchChapterBatch({
          bookId,
          startChapter: missing[0],
          endChapter: missing[missing.length - 1]
        });
        const byIndex = new Map(chapters.map((chapter) => [chapter.chapter_index, chapter]));

        for (const chapterIndex of missing) {
          assertNotCancelled(task);
          const chapter = byIndex.get(chapterIndex);
          if (!chapter || !chapter.content) {
            task.progress.failed += 1;
            updateTask(task, {
              progress: { ...task.progress, current: `章节 ${chapterIndex} 获取为空` },
              message: `章节 ${chapterIndex} 未返回正文。`
            }, "warning");
            continue;
          }

          await saveEncryptedChapter({
            bookId,
            chapterIndex,
            title: chapter.chapter_title,
            content: chapter.content,
            fetchStatus: chapter.fetch_status
          });
          task.progress.completed += 1;
          updateTask(task, {
            progress: { ...task.progress, current: `已保存章节 ${chapterIndex}` },
            message: `已加密保存章节 ${chapterIndex}`
          });
        }
      } catch (error) {
        task.progress.failed += missing.length;
        updateTask(task, {
          progress: { ...task.progress, current: `批次 ${batch.startChapter}-${batch.endChapter} 失败` },
          message: `批次失败：${sanitizeText(error.message)}`
        }, "warning");
      }
    }

    const savedCount = task.progress.completed - task.progress.skipped;
    if (task.progress.failed > 0 && savedCount <= 0) {
      updateBookImportStatus(bookId, "failed");
      throw new Error("所有待导入批次都失败了，请检查 Dify API Base、Workflow API Key 和 Dify 工作流输入字段。");
    }

    const finalStatus = task.progress.failed > 0 ? "completed_with_errors" : "completed";
    updateBookImportStatus(bookId, finalStatus);
    completeTask(task, {
      bookId,
      chapters: listChapterMetadata(bookId),
      status: finalStatus
    });
  } catch (error) {
    updateBookImportStatus(bookId, "failed");
    failTask(task, error);
  }
}

async function runAnalysisTask(task, { name, bookId, startChapter, endChapter, chapterIndexes, promptPatch }) {
  const settings = normalizePromptSettings({ ...getPromptSettings(), ...promptPatch });
  const model = settings.model;
  const reasoningEffort = settings.reasoning_effort;
  const parsedOutputSchema = parseOutputSchema(settings.output_schema);
  const chapterPromptHash = promptHash(settings);
  const outputSchemaHash = schemaHash(settings);
  const analysisId = task.id;

  try {
    const chapters = resolveSelectedChapters({ bookId, startChapter, endChapter, chapterIndexes });
    if (chapters.length === 0) {
      const error = new Error("本地章节库没有可分析的章节，请先导入章节原文。");
      error.status = 422;
      throw error;
    }

    await testOpenAIConnection();

    await createAnalysisRun({
      id: analysisId,
      name,
      bookId,
      startChapter,
      endChapter,
      chapterSelection: {
        mode: chapterIndexes.length ? "indexes" : "range",
        chapter_indexes: chapters.map((chapter) => chapter.chapter_index)
      },
      model,
      reasoningEffort,
      promptHash: chapterPromptHash,
      schemaHash: outputSchemaHash,
      chapterCount: chapters.length,
      promptSnapshot: settings
    });

    markTaskRunning(task, {
      result: { analysisId },
      progress: {
        total: chapters.length + 1,
        completed: 0,
        failed: 0,
        skipped: 0,
        current: "准备逐章分析"
      }
    });

    const chapterResults = [];
    const failedChapters = [];

    for (const chapter of chapters) {
      assertNotCancelled(task);
      updateTask(task, {
        progress: { ...task.progress, current: `GPT 理解章节 ${chapter.chapter_index}` },
        message: `正在分析章节 ${chapter.chapter_index}`
      });

      try {
        const content = await decryptChapterContent(bookId, chapter.chapter_index);
        const response = await callOpenAIJson({
          model,
          reasoningEffort,
          instructions: "你是严谨的小说章节理解引擎。只输出符合 Schema 的 JSON。",
          input: buildChapterInput({
            chapterIndex: chapter.chapter_index,
            title: chapter.title,
            content,
            userPrompt: settings.chapter_prompt
          }),
          schema: chapterResultSchema(),
          schemaName: "chapter_result"
        });
        const value = {
          ...response.value,
          chapter_index: Number(response.value.chapter_index || chapter.chapter_index),
          chapter_title: String(response.value.chapter_title || chapter.title || "")
        };
        chapterResults.push(value);
        await saveAnalysisChapter({
          analysisId,
          chapterIndex: chapter.chapter_index,
          status: "completed",
          contentHmac: chapter.content_hmac,
          promptHash: chapterPromptHash,
          result: value
        });
        task.progress.completed += 1;
        updateTask(task, {
          progress: { ...task.progress, current: `章节 ${chapter.chapter_index} 完成` },
          message: `章节 ${chapter.chapter_index} 分析完成`
        });
      } catch (error) {
        failedChapters.push(chapter.chapter_index);
        task.progress.failed += 1;
        await saveAnalysisChapter({
          analysisId,
          chapterIndex: chapter.chapter_index,
          status: "failed",
          contentHmac: chapter.content_hmac,
          promptHash: chapterPromptHash,
          errorSummary: sanitizeText(error.message)
        });
        updateTask(task, {
          progress: { ...task.progress, current: `章节 ${chapter.chapter_index} 失败` },
          message: `章节 ${chapter.chapter_index} 失败：${sanitizeText(error.message)}`
        }, "warning");
      }
    }

    assertNotCancelled(task);
    updateTask(task, {
      progress: { ...task.progress, current: "GPT 汇总分析结果" },
      message: "正在汇总逐章结果"
    });

    const summary = await callOpenAIJson({
      model,
      reasoningEffort,
      instructions: "你是严谨的小说多章节汇总引擎。最终只输出符合用户 JSON Schema 的 JSON。",
      input: buildSummaryInput({
        chapterResults,
        failedChapters,
        userPrompt: settings.summary_prompt
      }),
      schema: parsedOutputSchema,
      schemaName: "final_result"
    });

    await saveFinalAnalysisResult(analysisId, summary.value);
    task.progress.completed += 1;
    const run = updateAnalysisRun(analysisId, {
      status: "completed",
      error_summary: failedChapters.length ? `失败章节：${failedChapters.join(", ")}` : ""
    });
    completeTask(task, {
      analysisId,
      run: publicAnalysisRun(run),
      finalResult: summary.value,
      failedChapters
    });
  } catch (error) {
    if (getAnalysisRun(analysisId)) {
      updateAnalysisRun(analysisId, {
        status: "failed",
        error_summary: sanitizeText(error.message)
      });
    }
    failTask(task, error);
  }
}

export async function publicAnalysisRunWithResult(id) {
  const run = getAnalysisRun(id);
  if (!run) {
    const error = new Error("分析任务不存在。");
    error.status = 404;
    throw error;
  }
  return {
    ...publicAnalysisRun(run),
    chapters: listAnalysisChapterMetadata(id),
    prompt: await decryptAnalysisPromptSnapshot(id),
    finalResult: run.status === "completed" ? await decryptFinalAnalysisResult(id) : null
  };
}

export function publicAnalysisRun(run) {
  if (!run) return null;
  const selection = parseChapterSelection(run);
  return {
    id: run.id,
    name: run.name || `${run.book_id} ${run.start_chapter}-${run.end_chapter}`,
    book_id: run.book_id,
    start_chapter: run.start_chapter,
    end_chapter: run.end_chapter,
    chapter_indexes: selection.chapter_indexes,
    selection_mode: selection.mode,
    model: run.model,
    reasoning_effort: run.reasoning_effort,
    prompt_hash: run.prompt_hash,
    schema_hash: run.schema_hash,
    status: run.status,
    chapter_count: run.chapter_count,
    error_summary: run.error_summary,
    created_at: run.created_at,
    updated_at: run.updated_at
  };
}

function rangeIndexes(start, end) {
  const indexes = [];
  for (let index = start; index <= end; index += 1) indexes.push(index);
  return indexes;
}

function normalizeChapterIndexes(value) {
  if (!Array.isArray(value)) return [];
  const indexes = value.map((entry) => normalizeChapterIndex(entry));
  return [...new Set(indexes)].sort((left, right) => left - right);
}

function resolveSelectedChapters({ bookId, startChapter, endChapter, chapterIndexes }) {
  const metadata = listChapterMetadata(bookId);
  const byIndex = new Map(metadata.map((chapter) => [chapter.chapter_index, chapter]));
  const selectedIndexes = chapterIndexes.length
    ? chapterIndexes
    : metadata
      .filter((chapter) => chapter.chapter_index >= startChapter && chapter.chapter_index <= endChapter)
      .map((chapter) => chapter.chapter_index);

  const outsideRange = selectedIndexes.filter((index) => index < startChapter || index > endChapter);
  if (outsideRange.length) {
    const error = new Error(`选择章节超出范围：${outsideRange.join(", ")}`);
    error.status = 422;
    throw error;
  }

  const missing = selectedIndexes.filter((index) => !byIndex.has(index));
  if (missing.length) {
    const error = new Error(`本地章节库缺少已选择章节：${missing.join(", ")}`);
    error.status = 422;
    throw error;
  }

  return selectedIndexes.map((index) => byIndex.get(index));
}

function parseChapterSelection(run) {
  try {
    const parsed = run.chapter_selection ? JSON.parse(run.chapter_selection) : null;
    if (parsed?.chapter_indexes?.length) {
      return {
        mode: parsed.mode || "indexes",
        chapter_indexes: parsed.chapter_indexes
      };
    }
  } catch {
    // Old runs have no selection snapshot.
  }
  return {
    mode: "range",
    chapter_indexes: rangeIndexes(run.start_chapter, run.end_chapter)
  };
}
