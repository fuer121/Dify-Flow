import crypto from "node:crypto";

import {
  createAnalysisRun,
  decryptAnalysisChapterResult,
  decryptAnalysisSummaryPartResult,
  decryptCompletedAnalysisChapterResults,
  decryptAnalysisPromptSnapshot,
  decryptChapterContent,
  decryptFinalAnalysisResult,
  ensureBook,
  getBook,
  getBookIndexPrompts,
  getAnalysisChapterMetadata,
  getAnalysisSummaryPartMetadata,
  getAnalysisRun,
  getExistingChapterIndexes,
  getL1ChapterIndex,
  getL1Coverage,
  getL2ChapterStatus,
  getL2Coverage,
  getPromptSettings,
  bookL1IndexPromptHash,
  bookL2IndexPromptHash,
  listL2Facts,
  listAnalysisChapterMetadata,
  listAnalysisSummaryPartMetadata,
  listChapterMetadata,
  listL1ChapterIndexes,
  normalizeBookId,
  normalizeBookName,
  normalizeChapterIndex,
  normalizePromptSettings,
  normalizeRange,
  promptHash,
  saveAnalysisChapter,
  saveAnalysisSummaryPart,
  saveEncryptedChapter,
  saveFinalAnalysisResult,
  saveL1ChapterIndex,
  saveL2ChapterFacts,
  saveL2ChapterStatus,
  schemaHash,
  updateAnalysisRun,
  updateBookImportStatus
} from "./db.js";
import { buildChapterBatches, fetchChapterBatch, testDifyConnection } from "./dify.js";
import {
  buildChapterInput,
  buildL1ChapterInput,
  buildL2ChapterInput,
  callOpenAIJson,
  callOpenAIText,
  chapterResultSchema,
  l2ChapterFactsSchema,
  l1ChapterIndexSchema,
  testOpenAIConnection
} from "./openai.js";
import {
  assertNotCancelled,
  completeTask,
  createTask,
  failTask,
  findTask,
  isLiveTask,
  markTaskRunning,
  updateTask,
  waitIfPaused
} from "./tasks.js";
import { sanitizeText } from "./sanitize.js";

const SUMMARY_COMPACT_TARGET_CHARS = 18_000;
const SUMMARY_PART_INPUT_MAX_CHARS = 18_000;
const EVIDENCE_PACKET_CONTENT_CHARS = 260;
const EVIDENCE_PACKET_EVIDENCE_CHARS = 120;
const SUMMARY_FINAL_MAX_OUTPUT_TOKENS = 4500;
const CUSTOM_FIELD_SUMMARY_MAX_OUTPUT_TOKENS = 3000;
const SUMMARY_STAGE_MAX_ATTEMPTS = 3;
const SUMMARY_STAGE_RETRY_DELAY_MS = 1200;
const L2_SCHEMA_VERSION = "l2-facts-v1";

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
    force,
    autoL1Index: Boolean(payload.auto_l1_index ?? payload.autoL1Index)
  });

  void runImportTask(task, { bookId, bookName, ...range, force });
  return task;
}

export function startL1IndexTask(payload) {
  const bookId = normalizeBookId(payload.book_id ?? payload.bookId);
  const range = normalizeRange(payload.start_chapter ?? payload.startChapter, payload.end_chapter ?? payload.endChapter);
  const force = Boolean(payload.force);
  const task = createTask("l1-index", {
    bookId,
    startChapter: range.startChapter,
    endChapter: range.endChapter,
    force,
    mode: "chapter-only"
  });

  void runL1IndexTask(task, { bookId, ...range, force });
  return task;
}

export function startL2IndexTask(payload) {
  const bookId = normalizeBookId(payload.book_id ?? payload.bookId);
  const range = normalizeRange(payload.start_chapter ?? payload.startChapter, payload.end_chapter ?? payload.endChapter);
  const force = Boolean(payload.force);
  const mode = normalizeL2BuildMode(payload.mode || payload.build_mode || payload.buildMode);
  const task = createTask("l2-index", {
    bookId,
    startChapter: range.startChapter,
    endChapter: range.endChapter,
    force,
    mode
  });

  void runL2IndexTask(task, { bookId, ...range, force, mode });
  return task;
}

export function startAnalysisTask(payload) {
  const bookId = normalizeBookId(payload.book_id ?? payload.bookId);
  const range = normalizeRange(payload.start_chapter ?? payload.startChapter, payload.end_chapter ?? payload.endChapter);
  const chapterIndexes = normalizeChapterIndexes(payload.chapter_indexes ?? payload.chapterIndexes);
  const name = String(payload.name || "").trim();
  const analysisMode = normalizeAnalysisMode(payload.analysis_mode ?? payload.analysisMode);
  const sourceReviewBudget = normalizeOptionalBudget(payload.source_review_budget ?? payload.sourceReviewBudget);
  const task = createTask("analysis", {
    name,
    bookId,
    startChapter: range.startChapter,
    endChapter: range.endChapter,
    chapterCount: chapterIndexes.length || range.total,
    analysisMode
  });

  void runAnalysisTask(task, {
    name,
    bookId,
    ...range,
    chapterIndexes,
    promptPatch: payload.prompt || {},
    useL1Context: Boolean(payload.use_l1_context ?? payload.useL1Context),
    analysisMode,
    sourceReviewBudget
  });
  return task;
}

export function resumeAnalysisRunTask(id) {
  const analysisId = String(id || "");
  const existingTask = findTask(analysisId);
  if (isLiveTask(existingTask)) return existingTask;

  const run = getAnalysisRun(analysisId);
  if (!run) {
    const error = new Error("分析任务不存在。");
    error.status = 404;
    throw error;
  }
  if (run.ciphertext) {
    const error = new Error("分析任务已有最终结果，不需要续跑。");
    error.status = 409;
    throw error;
  }
  if (!run.prompt_ciphertext) {
    const error = new Error("旧任务缺少 Prompt 快照，无法安全续跑。请复制配置后新建分析任务。");
    error.status = 422;
    throw error;
  }

  const selection = parseChapterSelection(run);
  const task = createTask("analysis", {
    name: run.name,
    bookId: run.book_id,
    startChapter: run.start_chapter,
    endChapter: run.end_chapter,
    chapterCount: selection.chapter_indexes.length || run.chapter_count,
    resumeAnalysisId: analysisId
  }, { id: analysisId });

  void runAnalysisTask(task, {
    analysisId,
    resume: true,
    run
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
    updateTask(task, {
      progress: { ...task.progress, current: "检查 Dify 配置" },
      message: "正在检查 Dify 工作流 API Key"
    });
    await testDifyConnection();

    const existing = force ? new Set() : getExistingChapterIndexes(bookId, startChapter, endChapter);
    const batches = buildChapterBatches(startChapter, endChapter);
    let lastBatchError = "";

    for (const batch of batches) {
      await waitIfPaused(task);
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
          await waitIfPaused(task);
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
        if (error?.status === 499) throw error;
        lastBatchError = sanitizeText(error.message);
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
      const suffix = lastBatchError ? `最后一次 Dify 错误：${lastBatchError}` : "请检查 Dify API Base、Workflow API Key 和 Dify 工作流输入字段。";
      throw new Error(`所有待导入批次都失败了。${suffix}`);
    }

    const finalStatus = task.progress.failed > 0 ? "completed_with_errors" : "completed";
    updateBookImportStatus(bookId, finalStatus);
    completeTask(task, {
      bookId,
      chapters: listChapterMetadata(bookId),
      status: finalStatus
    });
  } catch (error) {
    if (error?.status === 499) {
      updateBookImportStatus(bookId, "cancelled");
      return;
    }
    updateBookImportStatus(bookId, "failed");
    failTask(task, error);
  }
}

async function runL1IndexTask(task, { bookId, startChapter, endChapter, force }) {
  const promptSettings = getPromptSettings();
  const bookPrompts = getBookIndexPrompts(bookId);
  const model = promptSettings.model;
  const reasoningEffort = promptSettings.reasoning_effort;
  const indexPromptHash = bookL1IndexPromptHash(bookPrompts);
  try {
    const chapters = listChapterMetadata(bookId)
      .filter((chapter) => chapter.chapter_index >= startChapter && chapter.chapter_index <= endChapter);
    if (!chapters.length) {
      const error = new Error("本地章节库没有可构建 L1 索引的章节，请先导入章节原文。");
      error.status = 422;
      throw error;
    }

    await testOpenAIConnection();
    markTaskRunning(task, {
      progress: {
        total: chapters.length,
        completed: 0,
        failed: 0,
        skipped: 0,
        current: "准备构建逐章 L1 索引"
      }
    });

    for (const chapter of chapters) {
      await waitIfPaused(task);
      const existing = getL1ChapterIndex(bookId, chapter.chapter_index);
      if (!force && existing?.status === "completed" && existing.source_hmac === chapter.content_hmac && existing.model === model && existing.prompt_hash === indexPromptHash) {
        task.progress.skipped += 1;
        updateTask(task, {
          progress: { ...task.progress, current: `跳过章节 ${chapter.chapter_index}` },
          message: `章节 ${chapter.chapter_index} L1 索引已存在，跳过。`
        });
        continue;
      }

      updateTask(task, {
        progress: { ...task.progress, current: `L1 章节索引 ${chapter.chapter_index}` },
        message: `正在构建章节 ${chapter.chapter_index} L1 索引`
      });

      try {
        assertNotCancelled(task);
        const content = await decryptChapterContent(bookId, chapter.chapter_index);
        const response = await callOpenAIJson({
          model,
          reasoningEffort,
          instructions: "你是小说 L1 基础索引引擎。只输出符合 Schema 的 JSON。",
          input: buildL1ChapterInput({
            chapterIndex: chapter.chapter_index,
            title: chapter.title,
            content,
            indexPrompt: bookPrompts.l1_index_prompt
          }),
          schema: l1ChapterIndexSchema(),
          schemaName: "l1_chapter_index"
        });
        saveL1ChapterIndex({
          bookId,
          chapterIndex: chapter.chapter_index,
          status: "completed",
          sourceHmac: chapter.content_hmac,
          model,
          promptHash: indexPromptHash,
          value: response.value
        });
        task.progress.completed += 1;
        updateTask(task, {
          progress: { ...task.progress, current: `章节 ${chapter.chapter_index} L1 完成` },
          message: `章节 ${chapter.chapter_index} L1 索引完成`
        });
        assertNotCancelled(task);
      } catch (error) {
        if (error?.status === 499) throw error;
        const safeMessage = sanitizeText(error.message);
        saveL1ChapterIndex({
          bookId,
          chapterIndex: chapter.chapter_index,
          status: "failed",
          sourceHmac: chapter.content_hmac,
          model,
          promptHash: indexPromptHash,
          errorSummary: safeMessage
        });
        task.progress.failed += 1;
        updateTask(task, {
          progress: { ...task.progress, current: `章节 ${chapter.chapter_index} L1 失败` },
          message: `章节 ${chapter.chapter_index} L1 失败：${safeMessage}`
        }, "warning");
        if (isFatalUpstreamError(safeMessage)) {
          throw new Error(`L1 构建已停止：${safeMessage}`, { cause: error });
        }
      }
    }

    completeTask(task, {
      bookId,
      coverage: getL1Coverage({ bookId, startChapter, endChapter, model, promptHash: indexPromptHash, includeWindows: false })
    });
  } catch (error) {
    if (error?.status === 499) return;
    failTask(task, error);
  }
}

async function runL2IndexTask(task, { bookId, startChapter, endChapter, force, mode }) {
  const promptSettings = getPromptSettings();
  const bookPrompts = getBookIndexPrompts(bookId);
  const model = promptSettings.model;
  const reasoningEffort = promptSettings.reasoning_effort;
  const indexPromptHash = bookL2IndexPromptHash(bookPrompts);
  try {
    const chapters = listChapterMetadata(bookId)
      .filter((chapter) => chapter.chapter_index >= startChapter && chapter.chapter_index <= endChapter);
    if (!chapters.length) {
      const error = new Error("本地章节库没有可构建 L2 索引的章节，请先导入章节原文。");
      error.status = 422;
      throw error;
    }

    await testOpenAIConnection();
    markTaskRunning(task, {
      progress: {
        total: chapters.length,
        completed: 0,
        failed: 0,
        skipped: 0,
        current: "准备构建 L2 类型化事实索引"
      }
    });

    for (const chapter of chapters) {
      await waitIfPaused(task);
      const existing = getL2ChapterStatus(bookId, chapter.chapter_index);
      const fresh = existing?.status === "completed"
        && existing.source_hmac === chapter.content_hmac
        && existing.model === model
        && existing.prompt_hash === indexPromptHash
        && existing.schema_version === L2_SCHEMA_VERSION;
      if (mode === "retry_failed" && existing?.status !== "failed") {
        task.progress.skipped += 1;
        updateTask(task, {
          progress: { ...task.progress, current: `跳过章节 ${chapter.chapter_index}` },
          message: `章节 ${chapter.chapter_index} 不是失败状态，跳过。`
        });
        continue;
      }
      if (mode === "missing" && existing) {
        task.progress.skipped += 1;
        updateTask(task, {
          progress: { ...task.progress, current: `跳过章节 ${chapter.chapter_index}` },
          message: `章节 ${chapter.chapter_index} 已有 L2 记录，跳过。`
        });
        continue;
      }
      if (!force && mode === "all" && fresh) {
        task.progress.skipped += 1;
        updateTask(task, {
          progress: { ...task.progress, current: `跳过章节 ${chapter.chapter_index}` },
          message: `章节 ${chapter.chapter_index} L2 索引已存在，跳过。`
        });
        continue;
      }

      updateTask(task, {
        progress: { ...task.progress, current: `L2 事实索引 ${chapter.chapter_index}` },
        message: `正在构建章节 ${chapter.chapter_index} L2 事实索引`
      });

      try {
        assertNotCancelled(task);
        const content = await decryptChapterContent(bookId, chapter.chapter_index);
        const l1Index = getL1ChapterIndex(bookId, chapter.chapter_index);
        const response = await callOpenAIJson({
          model,
          reasoningEffort,
          instructions: "你是小说 L2 类型化事实索引引擎。只输出符合 Schema 的 JSON。",
          input: buildL2ChapterInput({
            chapterIndex: chapter.chapter_index,
            title: chapter.title,
            content,
            l1Index,
            indexPrompt: bookPrompts.l2_index_prompt
          }),
          schema: l2ChapterFactsSchema(),
          schemaName: "l2_chapter_facts"
        });
        await saveL2ChapterFacts({
          bookId,
          chapterIndex: chapter.chapter_index,
          status: "completed",
          sourceHmac: chapter.content_hmac,
          model,
          promptHash: indexPromptHash,
          schemaVersion: L2_SCHEMA_VERSION,
          facts: response.value?.facts || []
        });
        task.progress.completed += 1;
        updateTask(task, {
          progress: { ...task.progress, current: `章节 ${chapter.chapter_index} L2 完成` },
          message: `章节 ${chapter.chapter_index} L2 索引完成`
        });
        assertNotCancelled(task);
      } catch (error) {
        if (error?.status === 499) throw error;
        const safeMessage = sanitizeText(error.message);
        saveL2ChapterStatus({
          bookId,
          chapterIndex: chapter.chapter_index,
          status: "failed",
          sourceHmac: chapter.content_hmac,
          model,
          promptHash: indexPromptHash,
          schemaVersion: L2_SCHEMA_VERSION,
          errorSummary: safeMessage
        });
        task.progress.failed += 1;
        updateTask(task, {
          progress: { ...task.progress, current: `章节 ${chapter.chapter_index} L2 失败` },
          message: `章节 ${chapter.chapter_index} L2 失败：${safeMessage}`
        }, "warning");
        if (isFatalUpstreamError(safeMessage)) {
          throw new Error(`L2 构建已停止：${safeMessage}`, { cause: error });
        }
      }
    }

    completeTask(task, {
      bookId,
      coverage: getL2Coverage({ bookId, startChapter, endChapter, model, promptHash: indexPromptHash, schemaVersion: L2_SCHEMA_VERSION })
    });
  } catch (error) {
    failTask(task, error);
  }
}

async function runAnalysisTask(task, options) {
  const resume = Boolean(options.resume);
  const analysisId = options.analysisId || task.id;

  try {
    const prepared = resume
      ? await prepareResumedAnalysis(options.run || getAnalysisRun(analysisId))
      : await prepareNewAnalysis(analysisId, options);
    await executeAnalysisTask(task, prepared);
  } catch (error) {
    if (getAnalysisRun(analysisId)) {
      updateAnalysisRun(analysisId, {
        status: error?.status === 499 ? "cancelled" : "failed",
        error_summary: sanitizeText(error.message)
      });
    }
    if (error?.status === 499) return;
    failTask(task, error);
  }
}

async function prepareNewAnalysis(analysisId, { name, bookId, startChapter, endChapter, chapterIndexes, promptPatch, useL1Context, analysisMode, sourceReviewBudget }) {
  const settings = normalizePromptSettings({ ...getPromptSettings(), ...promptPatch });
  validateAnalysisPromptBeforeRun({
    settings,
    bookId,
    taskName: name || settings.name || ""
  });
  const chapters = resolveSelectedChapters({ bookId, startChapter, endChapter, chapterIndexes });
  if (chapters.length === 0) {
    const error = new Error("本地章节库没有可分析的章节，请先导入章节原文。");
    error.status = 422;
    throw error;
  }

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
    model: settings.model,
    reasoningEffort: settings.reasoning_effort,
    promptHash: promptHash(settings),
    schemaHash: schemaHash(settings),
    chapterCount: chapters.length,
    promptSnapshot: { ...settings, use_l1_context: useL1Context, analysis_mode: analysisMode, source_review_budget: sourceReviewBudget }
  });

  return {
    analysisId,
    bookId,
    startChapter,
    endChapter,
    chapters,
    settings,
    useL1Context,
    analysisMode,
    sourceReviewBudget,
    chapterPromptHash: promptHash(settings),
    outputSchemaHash: schemaHash(settings),
    resume: false
  };
}

async function prepareResumedAnalysis(run) {
  if (!run) {
    const error = new Error("分析任务不存在。");
    error.status = 404;
    throw error;
  }
  if (run.ciphertext) {
    const error = new Error("分析任务已有最终结果，不需要续跑。");
    error.status = 409;
    throw error;
  }
  const settings = await decryptAnalysisPromptSnapshot(run.id);
  if (!settings) {
    const error = new Error("旧任务缺少 Prompt 快照，无法安全续跑。请复制配置后新建分析任务。");
    error.status = 422;
    throw error;
  }
  const normalizedSettings = normalizePromptSettings(settings);
  validateAnalysisPromptBeforeRun({
    settings: normalizedSettings,
    bookId: run.book_id,
    taskName: run.name || normalizedSettings.name || ""
  });
  const selection = parseChapterSelection(run);
  const chapters = resolveSelectedChapters({
    bookId: run.book_id,
    startChapter: run.start_chapter,
    endChapter: run.end_chapter,
    chapterIndexes: selection.chapter_indexes
  });
  return {
    analysisId: run.id,
    bookId: run.book_id,
    startChapter: run.start_chapter,
    endChapter: run.end_chapter,
    chapters,
    settings: normalizedSettings,
    useL1Context: Boolean(settings.use_l1_context),
    analysisMode: normalizeAnalysisMode(settings.analysis_mode || "full_text"),
    sourceReviewBudget: normalizeOptionalBudget(settings.source_review_budget),
    chapterPromptHash: run.prompt_hash || promptHash(normalizedSettings),
    outputSchemaHash: run.schema_hash || schemaHash(normalizedSettings),
    resume: true
  };
}

function validateAnalysisPromptBeforeRun({ settings, bookId, taskName }) {
  const finalSchema = deriveFinalSummarySchema({
    userPrompt: settings.summary_prompt,
    configuredSchema: parseOutputSchemaOrNull(settings.output_schema)
  });
  if (!shouldSplitCustomFinalSummary(finalSchema)) return;
  const properties = finalSchema.schema?.properties || {};
  const analysisContext = {
    bookId,
    bookName: getBook(bookId)?.book_name || "",
    taskName
  };
  for (const [fieldName, fieldSchema] of Object.entries(properties)) {
    if (!isAnalysisParameterField(fieldName, fieldSchema)) continue;
    deterministicFinalFieldValue(fieldName, analysisContext, {
      userPrompt: settings.summary_prompt,
      fieldSchema
    });
  }
}

async function executeAnalysisTask(task, prepared) {
  const {
    analysisId,
    bookId,
    startChapter,
    endChapter,
    chapters,
    settings,
    useL1Context,
    analysisMode,
    sourceReviewBudget,
    chapterPromptHash,
    outputSchemaHash,
    resume
  } = prepared;
  const model = settings.model;
  const reasoningEffort = settings.reasoning_effort;

  await testOpenAIConnection();
  updateAnalysisRun(analysisId, {
    status: "running",
    error_summary: ""
  });
  markTaskRunning(task, {
    result: { analysisId },
    progress: {
      total: chapters.length + 1,
      completed: 0,
      failed: 0,
      skipped: 0,
      current: resume ? "准备续跑分析" : "准备逐章分析"
    }
  });

  if (analysisMode !== "full_text") {
    return executeIndexAnalysisTask(task, {
      analysisId,
      bookId,
      startChapter,
      endChapter,
      chapters,
      settings,
      model,
      reasoningEffort,
      outputSchemaHash,
      analysisMode,
      sourceReviewBudget
    });
  }

  const chapterResults = [];
  const failedChapters = [];
  const l1Context = useL1Context ? buildL1AnalysisContext({ bookId, chapters, startChapter, endChapter }) : null;
  if (useL1Context && l1Context?.missingChapters?.length) {
    updateTask(task, {
      progress: { ...task.progress, current: "L1 覆盖不完整" },
      message: `L1 上下文缺失章节：${l1Context.missingChapters.slice(0, 20).join(", ")}`
    }, "warning");
  }

  for (const chapter of chapters) {
    await waitIfPaused(task);
    const reusable = await reusableAnalysisChapter({
      analysisId,
      chapter,
      promptHash: chapterPromptHash
    });
    if (reusable) {
      chapterResults.push(reusable);
      task.progress.skipped += 1;
      updateTask(task, {
        progress: { ...task.progress, current: `跳过章节 ${chapter.chapter_index}` },
        message: `章节 ${chapter.chapter_index} 已有可复用结果，跳过。`
      });
      continue;
    }

    updateTask(task, {
      progress: { ...task.progress, current: `GPT 理解章节 ${chapter.chapter_index}` },
      message: `正在分析章节 ${chapter.chapter_index}`
    });

    try {
      assertNotCancelled(task);
      const content = await decryptChapterContent(bookId, chapter.chapter_index);
      const response = await callOpenAIJson({
        model,
        reasoningEffort,
        instructions: "你是严谨的小说章节理解引擎。只输出符合 Schema 的 JSON。",
        input: buildChapterInput({
          chapterIndex: chapter.chapter_index,
          title: chapter.title,
          content,
          userPrompt: withL1ChapterContext(settings.chapter_prompt, l1Context?.chaptersByIndex.get(chapter.chapter_index))
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
      assertNotCancelled(task);
    } catch (error) {
      if (error?.status === 499) throw error;
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

  chapterResults.sort((left, right) => Number(left.chapter_index || 0) - Number(right.chapter_index || 0));
  await waitIfPaused(task);
  updateTask(task, {
    progress: { ...task.progress, current: "GPT 汇总分析结果" },
    message: "正在汇总逐章结果"
  });

  const summary = await summarizeAnalysisResults({
    analysisId,
    task,
    analysisContext: { bookId, bookName: getBook(bookId)?.book_name || "", taskName: task.payload?.name || settings.name || "" },
    model,
    reasoningEffort,
    chapterResults,
    failedChapters,
    userPrompt: settings.summary_prompt,
    outputSchema: settings.output_schema,
    sourceChapterCount: chapterResults.length
  });

  assertNotCancelled(task);
  const finalResult = parseJsonOrText(summary.value);
  assertFinalSummaryUseful(finalResult, chapterResults.length);
  await saveFinalAnalysisResult(analysisId, finalResult);
  task.progress.completed += 1;
  const run = updateAnalysisRun(analysisId, {
    status: "completed",
    error_summary: failedChapters.length ? `失败章节：${failedChapters.join(", ")}` : ""
  });
  completeTask(task, {
    analysisId,
    run: publicAnalysisRun(run),
    finalResult,
    failedChapters,
    schemaHash: outputSchemaHash
  });
}

async function executeIndexAnalysisTask(task, { analysisId, bookId, startChapter, endChapter, chapters, settings, model, reasoningEffort, outputSchemaHash, analysisMode, sourceReviewBudget }) {
  const selectedIndexes = chapters.map((chapter) => chapter.chapter_index);
  const categories = inferL2CategoriesFromPrompt(settings.summary_prompt);
  const entityQueries = inferEntityQueriesFromPrompt(settings.summary_prompt, bookId);
  const primaryEntityQuery = entityQueries[0] || "";
  const bookPrompts = getBookIndexPrompts(bookId);
  const l1PromptHash = bookL1IndexPromptHash(bookPrompts);
  const indexPromptHash = bookL2IndexPromptHash(bookPrompts);
  await waitIfPaused(task);
  updateTask(task, {
    progress: { ...task.progress, current: "L1 路标扫描" },
    message: "正在按 L1 路标筛选相关章节"
  });

  const l1Indexes = listL1ChapterIndexes(bookId, startChapter, endChapter)
    .filter((index) => selectedIndexes.includes(index.chapter_index));
  const l1FreshChapterSet = new Set(l1Indexes
    .filter((index) => {
      const chapter = chapters.find((entry) => entry.chapter_index === index.chapter_index);
      return index.status === "completed"
        && chapter
        && index.source_hmac === chapter.content_hmac
        && index.model === model
        && index.prompt_hash === l1PromptHash;
    })
    .map((index) => index.chapter_index));
  const l1MatchedIndexes = selectChaptersByL1Route({
    l1Indexes: l1Indexes.filter((index) => l1FreshChapterSet.has(index.chapter_index)),
    selectedIndexes,
    categories,
    entityQueries
  });
  const useL1Route = Boolean(l1MatchedIndexes.length);
  await waitIfPaused(task);
  updateTask(task, {
    progress: { ...task.progress, current: "L2 召回事实" },
    message: useL1Route
      ? `正在按 L1 命中章节召回 L2 事实（${l1MatchedIndexes.length} 章）`
      : "L1 未命中相关章节，正在从本地 L2 索引兜底召回事实"
  });
  const initialFacts = await listL2Facts({
    bookId,
    startChapter,
    endChapter,
    chapterIndexes: l1MatchedIndexes,
    categories,
    entities: useL1Route ? [] : entityQueries,
    limit: 1000,
    includeContent: true
  });
  const fallbackFacts = shouldFallbackL2Recall(initialFacts, entityQueries, useL1Route)
    ? await listL2Facts({
      bookId,
      startChapter,
      endChapter,
      categories,
      limit: 500,
      includeContent: true
    })
    : [];
  const facts = mergeFacts([...initialFacts, ...fallbackFacts], { chronological: useL1Route })
    .filter((fact) => selectedIndexes.includes(fact.chapter_index));
  const indexedChapters = new Set(facts.map((fact) => fact.chapter_index));
  const unrecalledChapters = selectedIndexes.filter((index) => !indexedChapters.has(index));
  const l2Coverage = getL2Coverage({
    bookId,
    startChapter,
    endChapter,
    model,
    promptHash: indexPromptHash,
    schemaVersion: L2_SCHEMA_VERSION
  });
  const l2MissingChapters = selectedIndexes.filter((index) => {
    const chapter = chapters.find((entry) => entry.chapter_index === index);
    if (!chapter) return true;
    const status = getL2ChapterStatus(bookId, index);
    return !status
      || status.status !== "completed"
      || status.source_hmac !== chapter.content_hmac
      || status.model !== model
      || status.prompt_hash !== indexPromptHash
      || status.schema_version !== L2_SCHEMA_VERSION;
  });
  const sourceStats = {
    analysis_mode: analysisMode,
    recalled_facts: facts.length,
    recalled_chapters: indexedChapters.size,
    l1_route_enabled: useL1Route,
    l1_matched_chapters: l1MatchedIndexes,
    l1_fresh_chapters: l1FreshChapterSet.size,
    source_review_chapters: 0,
    source_review_budget: sourceReviewBudgetForMode(analysisMode, chapters.length, sourceReviewBudget),
    missing_chapters: unrecalledChapters,
    unrecalled_chapters: unrecalledChapters,
    l2_missing_chapters: l2MissingChapters,
    l2_coverage: l2Coverage.chapters,
    categories,
    entity_query: primaryEntityQuery,
    entity_queries: entityQueries,
    recall_fallback_used: Boolean(fallbackFacts.length)
  };

  const reviewedChapters = [];
  const reviewCandidates = analysisMode === "fast_index"
    ? []
    : selectSourceReviewCandidates({ facts, chapters, budget: sourceStats.source_review_budget });
  for (const chapter of reviewCandidates) {
    await waitIfPaused(task);
    updateTask(task, {
      progress: { ...task.progress, current: `原文复核 ${chapter.chapter_index}` },
      message: `正在按预算复核章节 ${chapter.chapter_index}`
    });
    const content = await decryptChapterContent(bookId, chapter.chapter_index);
    const response = await callOpenAIJson({
      model,
      reasoningEffort: "low",
      instructions: "你是小说事实复核引擎。只针对用户汇总目标补充本章关键事实，输出符合 Schema 的 JSON。",
      input: buildL2ChapterInput({
        chapterIndex: chapter.chapter_index,
        title: chapter.title,
        content,
        l1Index: null,
        indexPrompt: bookPrompts.l2_index_prompt
      }),
      schema: l2ChapterFactsSchema(),
      schemaName: "l2_source_review"
    });
    const reviewFacts = (response.value?.facts || []).map((fact) => ({ ...fact, review_source: "source_review" }));
    await saveL2ChapterFacts({
      bookId,
      chapterIndex: chapter.chapter_index,
      status: "completed",
      sourceHmac: chapter.content_hmac,
      model,
      promptHash: indexPromptHash,
      schemaVersion: L2_SCHEMA_VERSION,
      facts: reviewFacts
    });
    reviewedChapters.push({
      chapter_index: chapter.chapter_index,
      title: chapter.title,
      facts: reviewFacts
    });
    sourceStats.source_review_chapters += 1;
  }

  await waitIfPaused(task);
  updateTask(task, {
    progress: { ...task.progress, current: "GPT 索引汇总结果" },
    message: "正在基于 L2 召回事实生成最终汇总"
  });
  const finalSchema = deriveFinalSummarySchema({
    userPrompt: settings.summary_prompt,
    configuredSchema: parseOutputSchemaOrNull(settings.output_schema)
  });
  const indexSummaryPayload = {
    facts,
    reviewedChapters,
    missingChapters: unrecalledChapters,
    userPrompt: settings.summary_prompt,
    sourceStats
  };
  const finalPrepared = shouldSplitCustomFinalSummary(finalSchema)
    ? null
    : prepareEvidenceSourceMaterial({
      sourceMaterial: indexSummaryPayload,
      fieldName: "final",
      fieldSchema: finalSchema?.schema || null,
      userPrompt: settings.summary_prompt,
      materialLabel: "索引召回素材",
      budget: SUMMARY_PART_INPUT_MAX_CHARS
    });
  const summary = shouldSplitCustomFinalSummary(finalSchema)
    ? await runCustomFieldSummaryCalls({
      analysisId,
      task,
      analysisContext: { bookId, bookName: getBook(bookId)?.book_name || "", taskName: task.payload?.name || settings.name || "" },
      model,
      reasoningEffort: "low",
      userPrompt: settings.summary_prompt,
      sourceMaterial: indexSummaryPayload,
      materialLabel: "索引召回素材",
      schema: finalSchema,
      sourceChapterCount: Math.max(facts.length, reviewedChapters.length, 1)
    })
    : await runFinalSummaryCall({
      analysisId,
      task,
      partKey: "json.final.merge",
      stageLabel: "GPT 索引汇总结果",
      model,
      reasoningEffort,
      userPrompt: settings.summary_prompt,
      input: buildEvidenceSummaryInput({
        userPrompt: settings.summary_prompt,
        sourceMaterial: finalPrepared.material,
        materialLabel: "索引召回素材",
        contextLabel: "最终汇总"
      }),
      schema: finalSchema,
      sourceChapterCount: Math.max(facts.length, reviewedChapters.length, 1),
      traceSummary: sourceTraceFromMaterial({
        partKey: "json.final.merge",
        stage: "json_final_merge",
        fieldName: "final",
        material: finalPrepared.material
      })
    });

  assertNotCancelled(task);
  const finalResult = parseJsonOrText(summary.value);
  assertFinalSummaryUseful(finalResult, Math.max(facts.length, reviewedChapters.length, 1));
  await saveFinalAnalysisResult(analysisId, finalResult);
  task.progress.completed = task.progress.total;
  const run = updateAnalysisRun(analysisId, {
    status: "completed",
    source_stats: JSON.stringify(sourceStats),
    error_summary: sourceStats.l2_missing_chapters.length
      ? `L2 覆盖缺口章节：${sourceStats.l2_missing_chapters.slice(0, 30).join(", ")}`
      : sourceStats.unrecalled_chapters.length
        ? `L2 未召回章节：${sourceStats.unrecalled_chapters.slice(0, 30).join(", ")}`
        : ""
  });
  completeTask(task, {
    analysisId,
    run: publicAnalysisRun(run),
    finalResult,
    failedChapters: [],
    schemaHash: outputSchemaHash,
    sourceStats
  });
}

function selectSourceReviewCandidates({ facts, chapters, budget }) {
  if (!budget) return [];
  const byIndex = new Map(chapters.map((chapter) => [chapter.chapter_index, chapter]));
  const scores = new Map();
  for (const fact of facts) {
    const confidence = Number(fact.confidence || 0);
    const importance = Number(fact.importance || 0);
    if (importance < 0.65 && confidence >= 0.55) continue;
    const score = (importance * 2) + (1 - confidence);
    scores.set(fact.chapter_index, Math.max(scores.get(fact.chapter_index) || 0, score));
  }
  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([chapterIndex]) => byIndex.get(chapterIndex))
    .filter(Boolean)
    .slice(0, budget);
}

function selectChaptersByL1Route({ l1Indexes, selectedIndexes, categories, entityQueries }) {
  const selectedSet = new Set(selectedIndexes);
  const queries = entityQueries.map(normalizeRouteToken).filter(Boolean);
  const categorySet = new Set(categories || []);
  if (!queries.length && !categorySet.size) return [];
  return l1Indexes
    .filter((index) => selectedSet.has(index.chapter_index))
    .filter((index) => index.status === "completed")
    .filter((index) => {
      const routeText = l1RouteText(index);
      return queries.some((query) => routeText.includes(query)) || l1MatchesCategories(index, categorySet);
    })
    .map((index) => index.chapter_index)
    .sort((left, right) => left - right);
}

function l1MatchesCategories(index, categories) {
  if (!categories.size) return false;
  if (categories.has("character") && Array.isArray(index.entities) && index.entities.length) return true;
  if (categories.has("relationship") && /关系|师徒|亲缘|恩怨|承诺|交易|敌对|隐瞒/.test(l1RouteText(index))) return true;
  if (categories.has("cultivation") && /境界|修炼|剑道|武学|术法|文脉|儒|释|道|兵法/.test(l1RouteText(index))) return true;
  if (categories.has("item") && /剑|本命物|法宝|武器|物品/.test(l1RouteText(index))) return true;
  if (categories.has("force") && /宗门|势力|组织|门派|家族/.test(l1RouteText(index))) return true;
  if (categories.has("location") && /地点|空间|秘境|城|山|洲|地图/.test(l1RouteText(index))) return true;
  if (categories.has("event") && Array.isArray(index.key_events) && index.key_events.length) return true;
  if (categories.has("foreshadowing") && Array.isArray(index.open_questions) && index.open_questions.length) return true;
  return false;
}

function l1RouteText(index) {
  return [
    index.summary,
    ...(index.keywords || []),
    ...(index.entities || []),
    ...(index.key_events || []),
    ...(index.items_places_orgs || []),
    ...(index.open_questions || [])
  ].map(normalizeRouteToken).join(" ");
}

function normalizeRouteToken(value) {
  return String(value || "").trim().toLowerCase();
}

function mergeFacts(facts, { chronological = false } = {}) {
  const seen = new Set();
  const merged = [];
  for (const fact of facts) {
    const key = fact?.id || [
      fact?.book_id,
      fact?.chapter_index,
      fact?.category,
      fact?.entity,
      fact?.fact_type,
      fact?.fact
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(fact);
  }
  const sorted = chronological
    ? merged.sort((left, right) => Number(left.chapter_index || 0) - Number(right.chapter_index || 0)
      || (Number(right.importance || 0) + Number(right.confidence || 0)) - (Number(left.importance || 0) + Number(left.confidence || 0)))
    : merged.sort((left, right) => {
      const leftScore = Number(left.importance || 0) * 2 + Number(left.confidence || 0);
      const rightScore = Number(right.importance || 0) * 2 + Number(right.confidence || 0);
      return rightScore - leftScore || Number(left.chapter_index || 0) - Number(right.chapter_index || 0);
    });
  return sorted.slice(0, 1200);
}

function shouldFallbackL2Recall(facts, entityQueries, usedL1Route = false) {
  if (usedL1Route) return false;
  if (!entityQueries.length) return false;
  return facts.length < 30 || new Set(facts.map((fact) => fact.chapter_index)).size < 8;
}

async function reusableAnalysisChapter({ analysisId, chapter, promptHash }) {
  const existing = getAnalysisChapterMetadata(analysisId, chapter.chapter_index);
  if (!existing || existing.status !== "completed") return null;
  if (!existing.has_result) return null;
  if (existing.content_hmac !== chapter.content_hmac) return null;
  if (existing.prompt_hash !== promptHash) return null;
  return decryptAnalysisChapterResult(analysisId, chapter.chapter_index);
}

async function summarizeAnalysisResults({ analysisId, task, analysisContext = {}, model, reasoningEffort, chapterResults, failedChapters, userPrompt, outputSchema, sourceChapterCount }) {
  const finalSchema = deriveFinalSummarySchema({
    userPrompt,
    configuredSchema: parseOutputSchemaOrNull(outputSchema)
  });
  const rawSummaryLength = summaryRawMaterialLength({ chapterResults, failedChapters, userPrompt });
  const directTargetChars = finalSchema?.schema ? 12_000 : SUMMARY_COMPACT_TARGET_CHARS;
  const compactDirectResults = compactChapterResultsForSummary({
    chapterResults,
    failedChapters,
    userPrompt,
    targetChars: directTargetChars
  });
  if (shouldSplitCustomFinalSummary(finalSchema) && rawSummaryLength > SUMMARY_PART_INPUT_MAX_CHARS) {
    await waitIfPaused(task);
    updateTask(task, {
      progress: { ...task.progress, current: "GPT 分字段汇总" },
      message: "正在按字段拆分最终汇总"
    });
    return runCustomFieldSummaryCalls({
      analysisId,
      task,
      analysisContext,
      model,
      reasoningEffort: "low",
      userPrompt,
      sourceMaterial: {
        compressedResults: compactDirectResults,
        failedChapters
      },
      materialLabel: "逐章理解素材",
      schema: finalSchema,
      sourceChapterCount
    });
  }
  const directPrepared = prepareEvidenceSourceMaterial({
    sourceMaterial: {
      compressedResults: compactDirectResults,
      failedChapters
    },
    fieldName: "final",
    fieldSchema: finalSchema?.schema || null,
    userPrompt,
    materialLabel: "逐章理解素材",
    budget: SUMMARY_PART_INPUT_MAX_CHARS
  });
  const directInput = buildEvidenceSummaryInput({
    userPrompt,
    sourceMaterial: directPrepared.material,
    materialLabel: "逐章理解素材",
    contextLabel: "最终汇总"
  });
  if (inputTextLength(directInput) <= SUMMARY_PART_INPUT_MAX_CHARS) {
    return runFinalSummaryCall({
      analysisId,
      task,
      partKey: finalSchema?.schema ? "json.final.merge" : "text.final.merge",
      stageLabel: "GPT 汇总分析结果",
      model,
      reasoningEffort,
      userPrompt,
      input: directInput,
      schema: finalSchema,
      sourceChapterCount,
      traceSummary: sourceTraceFromMaterial({
        partKey: finalSchema?.schema ? "json.final.merge" : "text.final.merge",
        stage: finalSchema?.schema ? "json_final_merge" : "text_final_merge",
        fieldName: "final",
        material: directPrepared.material
      })
    });
  }

  await waitIfPaused(task);
  updateTask(task, {
    progress: { ...task.progress, current: "本地整理汇总素材" },
    message: "正在本地整理长输入汇总素材"
  });
  const compressedResults = compactChapterResultsForSummary({
    chapterResults,
    failedChapters,
    userPrompt,
    targetChars: finalSchema?.schema ? 12_000 : SUMMARY_COMPACT_TARGET_CHARS
  });

  await waitIfPaused(task);
  updateTask(task, {
    progress: { ...task.progress, current: "GPT 汇总压缩结果" },
    message: "正在基于压缩素材生成最终汇总"
  });
  if (shouldSplitCustomFinalSummary(finalSchema)) {
    return runCustomFieldSummaryCalls({
      analysisId,
      task,
      analysisContext,
      model,
      reasoningEffort: "low",
      userPrompt,
      sourceMaterial: {
        compressedResults,
        failedChapters
      },
      materialLabel: "压缩摘要素材",
      schema: finalSchema,
      sourceChapterCount
    });
  }
  const compressedPrepared = prepareEvidenceSourceMaterial({
    sourceMaterial: {
      compressedResults,
      failedChapters
    },
    fieldName: "final",
    fieldSchema: finalSchema?.schema || null,
    userPrompt,
    materialLabel: "压缩摘要素材",
    budget: SUMMARY_PART_INPUT_MAX_CHARS
  });
  const compressedInput = buildEvidenceSummaryInput({
    userPrompt,
    sourceMaterial: compressedPrepared.material,
    materialLabel: "压缩摘要素材",
    contextLabel: "最终汇总"
  });
  return runFinalSummaryCall({
    analysisId,
    task,
    partKey: finalSchema?.schema ? "json.final.merge" : "text.final.merge",
    stageLabel: "GPT 汇总压缩结果",
    model,
    reasoningEffort: "low",
    userPrompt,
    input: compressedInput,
    schema: finalSchema,
    sourceChapterCount,
    traceSummary: sourceTraceFromMaterial({
      partKey: finalSchema?.schema ? "json.final.merge" : "text.final.merge",
      stage: finalSchema?.schema ? "json_final_merge" : "text_final_merge",
      fieldName: "final",
      material: compressedPrepared.material
    })
  });
}

function summaryRawMaterialLength({ chapterResults, failedChapters, userPrompt }) {
  return String(userPrompt || "").length
    + JSON.stringify(chapterResults || []).length
    + JSON.stringify(failedChapters || []).length;
}

async function runFinalSummaryCall({ analysisId, task, partKey, stageLabel, model, reasoningEffort, userPrompt = "", input, schema, sourceChapterCount, traceSummary = null }) {
  assertSummaryInputWithinBudget(input, stageLabel);
  const contentHash = summaryContentHash({ input, schema: schema?.schema || null, userPrompt });
  const basePart = {
    analysisId,
    partKey: partKey || (schema?.schema ? "json.final.merge" : "text.final.merge"),
    parentKey: "",
    stage: schema?.schema ? "json_final_merge" : "text_final_merge",
    contentHash,
    promptHash: shaString(userPrompt || ""),
    schemaHash: shaString(schema?.schema ? JSON.stringify(schema.schema) : ""),
    model,
    reasoningEffort,
    inputSummary: `${stageLabel} · 输入 ${inputTextLength(input)} 字`,
    traceSummary
  };
  if (schema?.schema) {
    return runPersistedSummaryNode(task, basePart, async () => {
      const response = await callOpenAIJson({
        model,
        reasoningEffort,
        instructions: [
          "你是严谨的小说多章节汇总引擎。按用户汇总 Prompt 输出最终结果；如果用户要求 JSON，则只输出合法 JSON，否则直接输出文本，不要添加无关解释。",
          schema?.unwrapField ? `结构化输出时请先用 ${schema.unwrapField} 字段承载用户要求的数组，系统保存前会自动解包为用户要求的数组。` : ""
        ].filter(Boolean).join("\n"),
        input,
        schema: schema.schema,
        schemaName: schema.schemaName,
        maxOutputTokens: SUMMARY_FINAL_MAX_OUTPUT_TOKENS,
        strict: schema.strict
      });
      const finalValue = normalizeFinalSchemaValue(response.value, schema);
      assertFinalSummaryUseful(parseJsonOrText(finalValue), sourceChapterCount, {
        schema: schema.schema,
        schemaName: schema.schemaName,
        userPrompt
      });
      return { ...response, value: finalValue };
    });
  }
  return runPersistedSummaryNode(task, basePart, async () => {
    const response = await callOpenAIText({
      model,
      reasoningEffort,
      instructions: "你是严谨的小说多章节汇总引擎。按用户汇总 Prompt 输出最终结果；如果用户要求 JSON，则只输出合法 JSON，否则直接输出文本，不要添加无关解释。",
      input,
      maxOutputTokens: SUMMARY_FINAL_MAX_OUTPUT_TOKENS
    });
    assertFinalSummaryUseful(parseJsonOrText(response.value), sourceChapterCount, {
      schema: schema?.schema || null,
      schemaName: schema?.schemaName || "",
      userPrompt
    });
    return response;
  });
}

function shouldSplitCustomFinalSummary(schema) {
  if (schema?.schemaName !== "custom_final_analysis") return false;
  if (schema?.unwrapField) return false;
  const properties = schema.schema?.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return false;
  return Object.keys(properties).length >= 2;
}

function normalizeFinalSchemaValue(value, schemaConfig) {
  const unwrapField = schemaConfig?.unwrapField;
  if (!unwrapField) return value;
  if (value && typeof value === "object" && !Array.isArray(value) && Array.isArray(value[unwrapField])) {
    return value[unwrapField];
  }
  return value;
}

async function runCustomFieldSummaryCalls({ analysisId, task, analysisContext = {}, model, reasoningEffort, userPrompt, sourceMaterial, materialLabel, schema, sourceChapterCount }) {
  const properties = schema.schema.properties || {};
  const finalValue = {};
  const responseIds = [];
  const fieldNames = Object.keys(properties);
  const primaryContentFieldCount = fieldNames
    .filter((fieldName) => isPotentialPrimaryContentField(fieldName, properties[fieldName]))
    .length;

  for (const fieldName of fieldNames) {
    const deterministicValue = deterministicFinalFieldValue(fieldName, analysisContext, {
      userPrompt,
      fieldSchema: properties[fieldName]
    });
    if (deterministicValue !== undefined) {
      await saveAnalysisSummaryPart({
        analysisId,
        partKey: `meta.${fieldName}`,
        stage: "meta",
        status: "completed",
        contentHash: summaryContentHash({ fieldName, value: deterministicValue }),
        promptHash: shaString(userPrompt || ""),
        schemaHash: shaString(JSON.stringify(properties[fieldName] || {})),
        model,
        reasoningEffort,
        inputSummary: `元信息字段 ${fieldName}`,
        result: { [fieldName]: deterministicValue }
      });
      finalValue[fieldName] = deterministicValue;
      continue;
    }
    await waitIfPaused(task);
    updateTask(task, {
      progress: { ...task.progress, current: `GPT 分字段汇总 ${fieldName}` },
      message: `正在生成最终 JSON 字段：${fieldName}`
    });

    const fieldSchema = buildSingleFieldSummarySchema({
      fieldName,
      fieldSchema: properties[fieldName]
    });
    const fieldResult = await runJsonFieldSummaryParts({
      analysisId,
      task,
      model,
      reasoningEffort,
      userPrompt,
      sourceMaterial: scopedSourceMaterialForField({ sourceMaterial, fieldName, userPrompt }),
      materialLabel,
      fieldName,
      fieldSchema: properties[fieldName],
      wrapperSchema: fieldSchema,
      sourceChapterCount,
      primaryContentFieldCount
    });

    finalValue[fieldName] = fieldResult.value;
    if (fieldResult.responseId) responseIds.push(fieldResult.responseId);
  }

  assertFinalSummaryUseful(finalValue, sourceChapterCount, {
    schema: schema.schema,
    schemaName: schema.schemaName,
    userPrompt
  });
  await saveAnalysisSummaryPart({
    analysisId,
    partKey: "json.final.merge",
    stage: "json_final_merge",
    status: "completed",
    contentHash: summaryContentHash(finalValue),
    promptHash: shaString(userPrompt || ""),
    schemaHash: shaString(JSON.stringify(schema.schema || {})),
    model,
    reasoningEffort,
    inputSummary: `最终 JSON 合并 · ${fieldNames.length} 字段`,
    traceSummary: mergeSourceTraces(listAnalysisSummaryPartMetadata(analysisId)
      .filter((part) => part.stage === "json_field_batch")
      .map((part) => part.trace_summary), {
      partKey: "json.final.merge",
      stage: "json_final_merge",
      fieldName: "final"
    }),
    result: finalValue
  });
  return {
    value: finalValue,
    responseId: responseIds.join(",") || null
  };
}

function deterministicFinalFieldValue(fieldName, analysisContext = {}, options = {}) {
  if (fieldName === "book_id") return analysisContext.bookId || "";
  if (fieldName === "book_name") return analysisContext.bookName || "";
  if (fieldName === "task") return analysisContext.taskName || "";
  const promptTemplateValue = promptJsonTemplateFieldValue(options.userPrompt, fieldName);
  if (promptTemplateValue !== undefined && isDeterministicTemplateField(fieldName, options.fieldSchema, promptTemplateValue)) {
    if (isTemplatePlaceholderText(promptTemplateValue) && isAnalysisParameterField(fieldName, options.fieldSchema)) {
      const inferred = inferAnalysisParameterValue(fieldName, options.userPrompt, analysisContext);
      assertAnalysisParameterReady(fieldName, inferred);
      return inferred;
    }
    assertTemplateFieldReady(fieldName, promptTemplateValue);
    return promptTemplateValue;
  }
  if (isAnalysisParameterField(fieldName, options.fieldSchema)) {
    const inferred = inferAnalysisParameterValue(fieldName, options.userPrompt, analysisContext);
    assertAnalysisParameterReady(fieldName, inferred);
    return inferred;
  }
  return undefined;
}

function promptJsonTemplateFieldValue(userPrompt, fieldName) {
  const template = extractLastJsonObjectTemplate(userPrompt);
  if (!template || !Object.hasOwn(template, fieldName)) return undefined;
  return template[fieldName];
}

function isDeterministicTemplateField(fieldName, fieldSchema, templateValue) {
  if (!isScalarFieldSchema(fieldSchema)) return false;
  if (typeof templateValue !== "string") return true;
  const trimmed = templateValue.trim();
  if (!trimmed) return true;
  if (isAnalysisParameterField(fieldName, fieldSchema)) return true;
  if (isTemplatePlaceholderText(trimmed)) return false;
  return isMetadataLikeFieldName(fieldName);
}

function isAnalysisParameterField(fieldName, fieldSchema) {
  if (!isScalarFieldSchema(fieldSchema)) return false;
  return /^(target|target_subject|subject|analysis_subject|analysis_goal|task_goal|scope|range|stage|phase|period|era|context|dimension|dimensions|目标主体|分析主体|分析目标|任务目标|范围|分析范围|阶段|时期|时代|上下文|维度)$/i.test(String(fieldName || ""));
}

function isMetadataLikeFieldName(fieldName) {
  return /^(version|schema_version|language|locale|format|output_format|analysis_mode|mode|source|source_type|stage|phase|period|era)$/i.test(String(fieldName || ""));
}

function isScalarFieldSchema(schema) {
  if (!schema) return true;
  if (schema.type === "array" || schema.type === "object") return false;
  if (schema.anyOf) return schema.anyOf.every(isScalarFieldSchema);
  return true;
}

function inferAnalysisParameterValue(fieldName, userPrompt, analysisContext = {}) {
  const fromTemplate = promptJsonTemplateFieldValue(userPrompt, fieldName);
  if (fromTemplate !== undefined && !isTemplatePlaceholderText(fromTemplate)) return fromTemplate;
  const prompt = String(userPrompt || "");
  const field = String(fieldName || "").toLowerCase();
  if (/target|subject|主体/.test(field)) return inferAnalysisTargetFromPrompt(prompt);
  const taskGoal = prompt.match(/(?:任务目标|分析目标)[：:]\s*([^\n。；]{2,80})/);
  if (/goal|目标/.test(field) && taskGoal) return taskGoal[1].trim();
  const scope = prompt.match(/(?:筛选范围|分析范围|范围)[：:]\s*([^\n。；]{2,80})/);
  if (/scope|range|范围/.test(field) && scope) return scope[1].trim();
  const stage = prompt.match(/(?:阶段|时期|stage|phase|period)[：:]\s*([^\n。；]{2,80})/i)
    || prompt.match(/[“"「『]([^”"」』]{1,60}(?:阶段|时期))[”"」』]/);
  if (/stage|phase|period|era|阶段|时期|时代/.test(field) && stage) return stage[1].trim();
  if (/task|goal|目标/.test(field)) return analysisContext.taskName || "";
  return "";
}

function inferAnalysisTargetFromPrompt(prompt) {
  const text = stripLastJsonObjectTemplate(prompt);
  const patterns = [
    /(?:目标主体|分析主体|指定主体|分析对象|分析目标|目标范围|目标类别|目标角色|核心角色)[^。；\n]{0,40}?[“"「『]([^”"」』]{1,60})[”"」』]/,
    /[“"「『]([^”"」』]{1,60})[”"」』][^。；\n]{0,24}?(?:为目标主体|为分析主体|作为目标主体|作为分析对象|作为分析目标|作为目标范围)/,
    /(?:目标主体|分析主体|指定主体|分析对象|分析目标|目标范围|目标类别|目标角色)[：:]\s*([^\n。；]{1,80})/,
    /(?:任务目标|分析目标)[：:]\s*(?:分析|梳理|整理|提炼|归纳)([^\n。；]{1,80})/,
    /(?:分析|梳理|整理|提炼|归纳)(?:小说中|全书中|本书中|这本书中|《[^》]+》中)?(?:的)?([^\n。；]{2,80})/
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = normalizeAnalysisTargetCandidate(match?.[1]);
    if (value && !isTemplatePlaceholderText(value) && !isReservedTemplateToken(value)) return value;
  }
  return "";
}

function normalizeAnalysisTargetCandidate(value) {
  let text = String(value || "").trim();
  if (!text) return "";
  text = text
    .replace(/^(?:分析|梳理|整理|提炼|归纳|研究)\s*/, "")
    .replace(/^(?:小说中|全书中|本书中|这本书中|《[^》]+》中)?(?:的)?/, "")
    .replace(/(?:相关内容|相关资料|相关事实|资料|内容|信息|情况)$/g, "")
    .replace(/[，,、]\s*(?:并|以及|同时).+$/g, "")
    .trim();
  return text.slice(0, 80);
}

function stripLastJsonObjectTemplate(value) {
  const text = String(value || "");
  const range = lastJsonObjectTemplateRange(text);
  if (!range) return text;
  return `${text.slice(0, range.start)}\n${text.slice(range.end + 1)}`;
}

function isReservedTemplateToken(value) {
  return /^(book_id|book_name|task|target_subject|summary|items|title|version|schema|json)$/i.test(String(value || "").trim());
}

function assertTemplateFieldReady(fieldName, value) {
  if (!isTemplatePlaceholderText(value)) return;
  const error = new Error(`分析 Prompt 的字段 ${fieldName} 仍是占位内容，请在 Prompt 管理中填写具体分析对象/目标范围，或删除该字段。`);
  error.status = 422;
  throw error;
}

function assertAnalysisParameterReady(fieldName, value) {
  if (String(value || "").trim() && !isTemplatePlaceholderText(value)) return;
  const error = new Error(`分析 Prompt 的字段 ${fieldName} 缺少具体分析对象/目标范围，请在 Prompt 管理中填写具体值或删除该字段。`);
  error.status = 422;
  throw error;
}

function isTemplatePlaceholderText(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  return /用户指定|指定主体|目标主体|待填写|请填写|请输入|占位|placeholder|todo/i.test(text);
}

function buildSingleFieldSummarySchema({ fieldName, fieldSchema }) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      [fieldName]: fieldSchema || looseJsonValueSchema()
    },
    required: [fieldName]
  };
}

async function runJsonFieldSummaryParts({
  analysisId,
  task,
  model,
  reasoningEffort,
  userPrompt,
  sourceMaterial,
  materialLabel,
  fieldName,
  fieldSchema,
  wrapperSchema,
  sourceChapterCount,
  primaryContentFieldCount = 0
}) {
  const chunks = splitSourceMaterialForField({
    sourceMaterial,
    fieldName,
    fieldSchema,
    userPrompt,
    materialLabel
  });
  const batchValues = [];
  const responseIds = [];
  const reusableBatchValues = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const batchNumber = String(index + 1).padStart(3, "0");
    const partKey = chunks.length > 1
      ? `json.${fieldName}.batch.${batchNumber}`
      : `json.${fieldName}.merge`;
    const traceSummary = sourceTraceFromMaterial({
      partKey,
      parentKey: chunks.length > 1 ? `json.${fieldName}.merge` : "",
      stage: "json_field_batch",
      fieldName,
      material: chunk.material
    });
    const requireNonEmpty = shouldRequireNonEmptyField({
      fieldName,
      fieldSchema,
      sourceMaterial: chunk.material,
      userPrompt,
      sourceChapterCount,
      primaryContentFieldCount
    });
    const fieldBatchMetadata = {
      analysisId,
      partKey,
      parentKey: chunks.length > 1 ? `json.${fieldName}.merge` : "",
      stage: "json_field_batch",
      contentHash: summaryContentHash({ fieldName, chunk, fieldSchema }),
      promptHash: shaString(userPrompt || ""),
      schemaHash: shaString(JSON.stringify(wrapperSchema || {})),
      model,
      reasoningEffort,
      inputSummary: `${fieldName} · ${chunk.label} · ${JSON.stringify(chunk.material).length} 字`,
      traceSummary
    };
    const reusable = await getReusableSummaryPart(fieldBatchMetadata);
    if (reusable) reusableBatchValues.push(reusable.value[fieldName]);
    updateTask(task, {
      progress: {
        ...task.progress,
        current: chunks.length > 1 ? `GPT 分字段汇总 ${fieldName} ${batchNumber}/${chunks.length}` : `GPT 分字段汇总 ${fieldName}`,
        summary_parts: await summaryProgressForAnalysis(analysisId)
      },
      message: chunks.length > 1
        ? `正在生成最终 JSON 字段：${fieldName}（${index + 1}/${chunks.length}）`
        : `正在生成最终 JSON 字段：${fieldName}`
    });
    const response = await runPersistedSummaryNode(task, fieldBatchMetadata, async () => {
      const input = buildCustomFieldSummaryInput({
        userPrompt,
        sourceMaterial: chunk.material,
        materialLabel,
        fieldName,
        fieldSchema
      });
      assertSummaryInputWithinBudget(input, `${fieldName} · ${chunk.label}`);
      const result = await callOpenAIJson({
        model,
        reasoningEffort,
        instructions: "你是严谨的小说多章节汇总引擎。当前只生成用户最终 JSON 模板中的一个顶层字段；只输出合法 JSON，不要添加无关解释。",
        input,
        schema: wrapperSchema,
        schemaName: safeSchemaName(`custom_field_${fieldName}`),
        maxOutputTokens: outputTokensForFieldSchema(fieldSchema),
        strict: false
      });
      assertFieldResponse(fieldName, fieldSchema, result.value, { requireNonEmpty });
      return result;
    });
    batchValues.push(response.value[fieldName]);
    if (response.responseId) responseIds.push(response.responseId);
  }

  if (chunks.length === 1) {
    const value = mergeFieldBatchValues(batchValues, fieldSchema, { fieldName, userPrompt });
    assertFieldValueUseful(fieldName, fieldSchema, value, sourceChapterCount, {
      requireNonEmpty: shouldRequireNonEmptyField({
        fieldName,
        fieldSchema,
        sourceMaterial,
        userPrompt,
        sourceChapterCount,
        primaryContentFieldCount
      })
    });
    return {
      value,
      responseId: responseIds.join(",") || null
    };
  }

  const existingMerge = await getReusableSummaryPart({
    analysisId,
    partKey: `json.${fieldName}.merge`,
    stage: "json_field_merge",
    contentHash: summaryContentHash({ fieldName, batchValues: reusableBatchValues.length === chunks.length ? reusableBatchValues : batchValues }),
    promptHash: shaString(userPrompt || ""),
    schemaHash: shaString(JSON.stringify(fieldSchema || {})),
    model,
    reasoningEffort
  });
  if (existingMerge) {
    return {
      value: existingMerge.value[fieldName],
      responseId: responseIds.join(",") || null
    };
  }

  const mergedValue = mergeFieldBatchValues(batchValues, fieldSchema, { fieldName, userPrompt });
  assertFieldValueUseful(fieldName, fieldSchema, mergedValue, sourceChapterCount, {
    requireNonEmpty: shouldRequireNonEmptyField({
      fieldName,
      fieldSchema,
      sourceMaterial,
      userPrompt,
      sourceChapterCount,
      primaryContentFieldCount
    })
  });
  await saveAnalysisSummaryPart({
    analysisId,
    partKey: `json.${fieldName}.merge`,
    stage: "json_field_merge",
    status: "completed",
    contentHash: summaryContentHash({ fieldName, batchValues }),
    promptHash: shaString(userPrompt || ""),
    schemaHash: shaString(JSON.stringify(fieldSchema || {})),
    model,
    reasoningEffort,
    inputSummary: `${fieldName} · 合并 ${chunks.length} 个分块`,
    traceSummary: mergeSourceTraces(chunks.map((chunk, index) => sourceTraceFromMaterial({
      partKey: `json.${fieldName}.batch.${String(index + 1).padStart(3, "0")}`,
      parentKey: `json.${fieldName}.merge`,
      stage: "json_field_batch",
      fieldName,
      material: chunk.material
    })), {
      partKey: `json.${fieldName}.merge`,
      stage: "json_field_merge",
      fieldName
    }),
    result: { [fieldName]: mergedValue }
  });
  return {
    value: mergedValue,
    responseId: responseIds.join(",") || null
  };
}

function splitSourceMaterialForField({ sourceMaterial, fieldName, fieldSchema, userPrompt, materialLabel }) {
  const base = sourceMaterial && typeof sourceMaterial === "object" ? sourceMaterial : {};
  const prepared = prepareEvidenceSourceMaterial({
    sourceMaterial: base,
    fieldName,
    fieldSchema,
    userPrompt,
    materialLabel,
    budget: SUMMARY_PART_INPUT_MAX_CHARS
  });
  if (prepared.chunks.length <= 1) {
    return [{ label: `${fieldName} 全量素材`, material: prepared.material }];
  }
  return prepared.chunks.map((material, index) => ({
    label: `${fieldName} 分块 ${index + 1}/${prepared.chunks.length}`,
    material
  }));
}

function isLargeFieldSchema(schema) {
  if (!schema) return true;
  if (schema.type === "array") return true;
  if (schema.type === "object") return true;
  if (schema.anyOf) return schema.anyOf.some(isLargeFieldSchema);
  return false;
}

function outputTokensForFieldSchema(schema) {
  if (!schema) return CUSTOM_FIELD_SUMMARY_MAX_OUTPUT_TOKENS;
  if (schema.type === "array") return CUSTOM_FIELD_SUMMARY_MAX_OUTPUT_TOKENS;
  if (schema.type === "object") return CUSTOM_FIELD_SUMMARY_MAX_OUTPUT_TOKENS;
  return Math.min(1200, CUSTOM_FIELD_SUMMARY_MAX_OUTPUT_TOKENS);
}

function shouldRequireNonEmptyField({ fieldName, fieldSchema, sourceMaterial, userPrompt, sourceChapterCount = 0, primaryContentFieldCount = 0 }) {
  if (Number(sourceChapterCount || 0) < 3) return false;
  if (!materialHasEvidence(sourceMaterial)) return false;
  if (sourceMaterial?.sourceStats?.recalled_facts === 0 && !sourceMaterial?.sourceStats?.source_review_chapters) return false;
  if (isMetadataOnlyFieldName(fieldName)) return false;
  if (!isLargeFieldSchema(fieldSchema)) return false;
  const field = String(fieldName || "");
  if (!isRequiredPrimaryContentField(field)) return false;
  if (Number(primaryContentFieldCount || 0) > 1) return false;
  if (isOptionalSummaryFieldName(field)) {
    return false;
  }
  const prompt = String(userPrompt || "");
  if (new RegExp(`${escapeRegExp(field)}[^\\n。；]{0,80}(?:可为空|允许为空|没有则为空|没有则写空|没有则输出空)`, "i").test(prompt)) {
    return false;
  }
  return true;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertSummaryInputWithinBudget(input, label) {
  const length = inputTextLength(input);
  if (length <= SUMMARY_PART_INPUT_MAX_CHARS) return;
  const error = new Error(`最终汇总分块输入超过预算：${label || "unknown"} ${length}/${SUMMARY_PART_INPUT_MAX_CHARS} 字。`);
  error.status = 502;
  throw error;
}

function assertFieldResponse(fieldName, fieldSchema, value, options = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, fieldName)) {
    const error = new Error(`分字段汇总缺少字段：${fieldName}`);
    error.status = 502;
    throw error;
  }
  assertFieldValueUseful(fieldName, fieldSchema, value[fieldName], 3, options);
}

function assertFieldValueUseful(fieldName, fieldSchema, value, sourceChapterCount, options = {}) {
  if (sourceChapterCount < 3) return;
  if (fieldSchema?.type === "array") {
    if (!Array.isArray(value)) {
      const error = new Error(`分字段汇总字段 ${fieldName} 必须是数组。`);
      error.status = 502;
      throw error;
    }
    if (!value.length && options.requireNonEmpty) {
      throw emptyContentFieldError(fieldName);
    }
    return;
  }
  if (fieldSchema?.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      const error = new Error(`分字段汇总字段 ${fieldName} 必须是对象。`);
      error.status = 502;
      throw error;
    }
    if (options.requireNonEmpty && !isUsefulFinalValue(value)) {
      throw emptyContentFieldError(fieldName);
    }
    return;
  }
  if (typeof value === "string" && isPlaceholderText(value)) {
    const error = new Error(`分字段汇总字段 ${fieldName} 是占位内容。`);
    error.status = 502;
    throw error;
  }
}

function mergeFieldBatchValues(values, fieldSchema, options = {}) {
  if (fieldSchema?.type === "array") {
    const mergedByKey = new Map();
    const fallbackItems = [];
    const fallbackSeen = new Set();
    for (const value of values) {
      const items = Array.isArray(value) ? value : [];
      for (const item of items) {
        const subjectKey = arrayItemSubjectKey(item);
        if (!subjectKey) {
          const fallbackKey = stableStringify(item);
          if (fallbackSeen.has(fallbackKey)) continue;
          fallbackSeen.add(fallbackKey);
          fallbackItems.push(item);
          continue;
        }
        const existing = mergedByKey.get(subjectKey);
        mergedByKey.set(subjectKey, existing ? mergeArrayItems(existing, item, subjectKey) : cloneJsonValue(item));
      }
    }
    return applyArrayMergeConstraints([...mergedByKey.values(), ...fallbackItems], {
      userPrompt: options.userPrompt,
      fieldName: options.fieldName
    });
  }
  if (fieldSchema?.type === "object") {
    return Object.assign({}, ...values.filter((value) => value && typeof value === "object" && !Array.isArray(value)));
  }
  return values.find((value) => value !== undefined && value !== null && value !== "") ?? values[0] ?? "";
}

function arrayItemSubjectKey(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return "";
  const entries = Object.entries(item);
  for (const preferred of ARRAY_ITEM_KEY_FIELDS) {
    const match = entries.find(([key, value]) => normalizeFieldKey(key) === preferred && usefulKeyValue(value));
    if (match) return normalizeArrayItemKey(match[1]);
  }
  for (const [key, value] of entries) {
    const normalized = normalizeFieldKey(key);
    if (!usefulKeyValue(value)) continue;
    if (/(^|_)(name|title|entity|subject|label)(_|$)/.test(normalized)) return normalizeArrayItemKey(value);
    if (/名称|名字|姓名|标题|主体|实体|对象/.test(String(key))) return normalizeArrayItemKey(value);
  }
  return "";
}

const ARRAY_ITEM_KEY_FIELDS = [
  "name",
  "title",
  "entity",
  "subject",
  "label",
  "character_name",
  "role_name",
  "item_name",
  "force_name",
  "faction_name",
  "system_name",
  "cultivation_name",
  "relationship_name",
  "角色名称",
  "角色名",
  "姓名",
  "名称",
  "名字",
  "物品名称",
  "势力名称",
  "宗门名称",
  "体系名称",
  "境界名称",
  "关系名称",
  "主体",
  "实体",
  "对象",
  "标题"
].map(normalizeFieldKey);

function usefulKeyValue(value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value) || typeof value === "object") return false;
  const text = String(value).trim();
  return Boolean(text) && !isPlaceholderText(text) && !isTemplatePlaceholderText(text);
}

function normalizeArrayItemKey(value) {
  return normalizeRouteToken(value)
    .replace(/[“”"'`‘’「」『』《》（）()[\]{}<>]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function normalizeFieldKey(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function mergeArrayItems(left, right, subjectKey) {
  if (!left || typeof left !== "object" || Array.isArray(left)) return cloneJsonValue(right);
  if (!right || typeof right !== "object" || Array.isArray(right)) return cloneJsonValue(left);
  const output = cloneJsonValue(left);
  for (const [key, value] of Object.entries(right)) {
    if (value === undefined || value === null || value === "") continue;
    if (!Object.hasOwn(output, key) || output[key] === undefined || output[key] === null || output[key] === "" || isPlaceholderText(output[key])) {
      output[key] = cloneJsonValue(value);
      continue;
    }
    output[key] = mergeArrayItemValue(output[key], value, {
      fieldKey: key,
      subjectKey
    });
  }
  return output;
}

function mergeArrayItemValue(left, right, { fieldKey, subjectKey }) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return mergeJsonArrays(Array.isArray(left) ? left : [left], Array.isArray(right) ? right : [right]);
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    return mergeArrayItems(left, right, subjectKey);
  }
  if (typeof left === "string" || typeof right === "string") {
    return mergeTextValue(left, right, { fieldKey, subjectKey });
  }
  if (typeof left === "number" && typeof right === "number") return Math.max(left, right);
  if (typeof left === "boolean" && typeof right === "boolean") return left || right;
  return left;
}

function mergeJsonArrays(left, right) {
  const output = [];
  const seen = new Set();
  for (const item of [...left, ...right]) {
    const key = arrayItemSubjectKey(item) || stableStringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(cloneJsonValue(item));
  }
  return output;
}

function mergeTextValue(left, right, { fieldKey, subjectKey }) {
  const leftText = String(left || "").trim();
  const rightText = String(right || "").trim();
  if (!leftText) return rightText;
  if (!rightText) return leftText;
  if (leftText === rightText) return leftText;
  if (normalizeArrayItemKey(leftText) === subjectKey) return leftText;
  if (normalizeArrayItemKey(rightText) === subjectKey) return leftText;
  if (isPlaceholderText(leftText) || isTemplatePlaceholderText(leftText)) return rightText;
  if (isPlaceholderText(rightText) || isTemplatePlaceholderText(rightText)) return leftText;
  if (leftText.includes(rightText)) return leftText;
  if (rightText.includes(leftText)) return rightText;
  if (isIdentityLikeField(fieldKey)) return leftText.length >= rightText.length ? leftText : rightText;
  return `${leftText}；${rightText}`;
}

function isIdentityLikeField(key) {
  return /^(name|title|entity|subject|label)$/i.test(String(key || ""))
    || /名称|名字|姓名|标题|主体|实体|对象/.test(String(key || ""));
}

function applyArrayMergeConstraints(items, { userPrompt, fieldName }) {
  const constraints = parseArrayMergeConstraints(userPrompt, fieldName);
  let output = items.map((item) => applyItemTextConstraints(item, constraints.textFieldLimits));
  if (constraints.labeledLimits.length) {
    output = applyLabeledItemLimits(output, constraints.labeledLimits);
  }
  if (constraints.maxItems && output.length > constraints.maxItems) {
    output = output.slice(0, constraints.maxItems);
  }
  return output;
}

function applyItemTextConstraints(item, limits) {
  if (!limits.length || !item || typeof item !== "object" || Array.isArray(item)) return item;
  const output = cloneJsonValue(item);
  for (const [key, value] of Object.entries(output)) {
    if (typeof value === "string") {
      const limit = textLimitForField(key, limits);
      if (limit) output[key] = clipText(value, limit);
    } else if (Array.isArray(value)) {
      output[key] = value.map((entry) => typeof entry === "string"
        ? clipText(entry, textLimitForField(key, limits) || entry.length)
        : entry);
    }
  }
  return output;
}

function applyLabeledItemLimits(items, labeledLimits) {
  const keptByLabel = new Map();
  const output = [];
  for (const item of items) {
    const text = arrayItemLabelText(item);
    const matched = labeledLimits.find((limit) => text.includes(limit.label));
    if (!matched) {
      output.push(item);
      continue;
    }
    const count = keptByLabel.get(matched.label) || 0;
    if (count >= matched.maxItems) continue;
    keptByLabel.set(matched.label, count + 1);
    output.push(item);
  }
  return output;
}

function arrayItemLabelText(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return "";
  return Object.values(item)
    .filter((value) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    .map(normalizeRouteToken)
    .join(" ");
}

function textLimitForField(fieldKey, limits) {
  const normalized = normalizeFieldKey(fieldKey);
  const fieldText = normalizeRouteToken(fieldKey);
  const matched = limits
    .filter((limit) => {
      if (limit.field && normalized === limit.field) return true;
      if (limit.field && normalized.includes(limit.field)) return true;
      if (limit.label && fieldText.includes(limit.label)) return true;
      return limit.aliases.some((alias) => normalized.includes(alias) || fieldText.includes(alias));
    })
    .sort((left, right) => left.maxChars - right.maxChars)[0];
  return matched?.maxChars || 0;
}

function parseArrayMergeConstraints(userPrompt, fieldName) {
  const text = String(userPrompt || "");
  return {
    maxItems: parseGlobalArrayItemLimit(text, fieldName),
    labeledLimits: parseLabeledArrayItemLimits(text),
    textFieldLimits: parseTextFieldLimits(text)
  };
}

function parseGlobalArrayItemLimit(text, fieldName) {
  const normalizedField = normalizeFieldKey(fieldName);
  const candidates = [];
  const patterns = [
    /(?:最多|至多|不超过|上限|限制为|控制在)\s*([0-9一二两三四五六七八九十百〇零]+)\s*(?:个|条|项)/g,
    /(?:输出|保留|收录)[^。；\n]{0,12}?([0-9一二两三四五六七八九十百〇零]+)\s*(?:个|条|项)(?:以内|以下|之内)/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const number = parseLooseNumber(match[1]);
      if (!number) continue;
      const context = text.slice(Math.max(0, match.index - 24), Math.min(text.length, match.index + match[0].length + 24));
      if (/非核心|次要|每个|每条|每项/.test(context)) continue;
      const fieldRelevant = !normalizedField || normalizeRouteToken(context).includes(normalizeRouteToken(fieldName));
      candidates.push({ number, fieldRelevant });
    }
  }
  const relevant = candidates.filter((candidate) => candidate.fieldRelevant);
  const values = (relevant.length ? relevant : candidates).map((candidate) => candidate.number);
  return values.length ? Math.min(...values) : 0;
}

function parseLabeledArrayItemLimits(text) {
  const limits = [];
  const pattern = /([\u4e00-\u9fa5A-Za-z_]{2,16})[^。；\n]{0,12}?(?:最多|至多|不超过|上限|限制为|控制在)\s*([0-9一二两三四五六七八九十百〇零]+)\s*(?:个|条|项)/g;
  for (const match of text.matchAll(pattern)) {
    const label = normalizeRouteToken(match[1]);
    const maxItems = parseLooseNumber(match[2]);
    if (!label || !maxItems) continue;
    if (/字段|输出|结果|json|每个|每条|每项/.test(label)) continue;
    limits.push({ label, maxItems });
  }
  return limits;
}

function parseTextFieldLimits(text) {
  const limits = [];
  const pattern = /([A-Za-z_][A-Za-z0-9_]{1,40}|[\u4e00-\u9fa5]{2,12})[^。；\n]{0,20}?(?:控制在|不超过|最多|限制在|限制为)\s*([0-9一二两三四五六七八九十百〇零]+)\s*(?:字|字符)(?:以内|以下|之内)?/g;
  for (const match of text.matchAll(pattern)) {
    const rawField = normalizeLimitFieldCandidate(match[1]);
    const maxChars = parseLooseNumber(match[2]);
    if (!rawField || !maxChars) continue;
    limits.push({
      field: /^[A-Za-z_]/.test(rawField) ? normalizeFieldKey(rawField) : "",
      label: /^[A-Za-z_]/.test(rawField) ? "" : normalizeRouteToken(rawField),
      aliases: fieldLimitAliases(rawField),
      maxChars
    });
  }
  return limits;
}

function normalizeLimitFieldCandidate(value) {
  const text = String(value || "").trim();
  const ascii = text.match(/[A-Za-z_][A-Za-z0-9_]{1,40}/g);
  if (ascii?.length) return ascii.at(-1);
  const cjk = text.match(/[\u4e00-\u9fa5]{2,12}/g);
  return cjk?.at(-1) || text;
}

function fieldLimitAliases(field) {
  const normalized = normalizeRouteToken(field);
  const aliases = new Set([normalizeFieldKey(field), normalized]);
  if (/appearance|外貌|形象|描述/.test(normalized)) {
    aliases.add("appearance");
    aliases.add("外貌");
    aliases.add("形象");
    aliases.add("描述");
  }
  if (/identity|身份|定位/.test(normalized)) {
    aliases.add("identity");
    aliases.add("身份");
    aliases.add("定位");
  }
  if (/summary|note|说明|总结/.test(normalized)) {
    aliases.add("summary");
    aliases.add("note");
    aliases.add("说明");
    aliases.add("总结");
  }
  return [...aliases].filter(Boolean);
}

function parseLooseNumber(value) {
  const text = String(value || "").trim();
  const direct = Number(text);
  if (Number.isFinite(direct) && direct > 0) return Math.floor(direct);
  return parseChineseNumber(text);
}

function parseChineseNumber(text) {
  const chars = String(text || "").replace(/两/g, "二").replace(/〇/g, "零");
  if (!chars) return 0;
  const digits = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if ([...chars].every((char) => Object.hasOwn(digits, char))) {
    return Number([...chars].map((char) => digits[char]).join(""));
  }
  if (chars.includes("百")) {
    const [head, tail = ""] = chars.split("百");
    return (digits[head] || 1) * 100 + parseChineseNumber(tail);
  }
  if (chars.includes("十")) {
    const [head, tail = ""] = chars.split("十");
    return (head ? digits[head] : 1) * 10 + (tail ? digits[tail] : 0);
  }
  return digits[chars] || 0;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJsonValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

async function runPersistedSummaryNode(task, metadata, operation) {
  const existing = await getReusableSummaryPart(metadata);
  if (existing) {
    await saveAnalysisSummaryPart({
      ...metadata,
      status: "completed",
      result: existing
    });
    updateTask(task, {
      progress: {
        ...task.progress,
        current: `复用汇总分块 ${metadata.partKey}`,
        summary_parts: await summaryProgressForAnalysis(metadata.analysisId)
      },
      message: `复用已完成汇总分块：${metadata.partKey}`
    });
    return existing;
  }
  await saveAnalysisSummaryPart({
    ...metadata,
    status: "running"
  });
  try {
    const result = await runSummaryStageWithRetry(task, metadata.partKey, operation);
    await saveAnalysisSummaryPart({
      ...metadata,
      status: "completed",
      result
    });
    updateTask(task, {
      progress: {
        ...task.progress,
        summary_parts: await summaryProgressForAnalysis(metadata.analysisId)
      },
      message: `汇总分块完成：${metadata.partKey}`
    });
    return result;
  } catch (error) {
    await saveAnalysisSummaryPart({
      ...metadata,
      status: "failed",
      errorSummary: sanitizeText(error.message)
    });
    throw error;
  }
}

async function getReusableSummaryPart(metadata) {
  const existing = getAnalysisSummaryPartMetadata(metadata.analysisId, metadata.partKey);
  if (!existing || existing.status !== "completed" || !existing.has_result) return null;
  if (existing.content_hash !== metadata.contentHash) return null;
  if (existing.prompt_hash !== metadata.promptHash) return null;
  if (existing.schema_hash !== metadata.schemaHash) return null;
  if (existing.model !== metadata.model) return null;
  if (existing.reasoning_effort !== metadata.reasoningEffort) return null;
  return decryptAnalysisSummaryPartResult(metadata.analysisId, metadata.partKey);
}

async function summaryProgressForAnalysis(analysisId) {
  const parts = listAnalysisSummaryPartMetadata(analysisId);
  return {
    total: parts.length,
    completed: parts.filter((part) => part.status === "completed").length,
    failed: parts.filter((part) => part.status === "failed").length,
    running: parts.filter((part) => part.status === "running").length
  };
}

function summaryContentHash(value) {
  return shaString(stableStringify(value));
}

function shaString(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function scopedSourceMaterialForField({ sourceMaterial, fieldName, userPrompt }) {
  const material = sourceMaterial && typeof sourceMaterial === "object" ? sourceMaterial : {};
  const facts = Array.isArray(material.facts) ? material.facts : [];
  const reviewedChapters = Array.isArray(material.reviewedChapters) ? material.reviewedChapters : [];
  const compressedResults = Array.isArray(material.compressedResults) ? material.compressedResults : [];
  const field = String(fieldName || "").toLowerCase();
  const metadataOnly = isMetadataOnlyFieldName(fieldName);
  const categories = summaryFieldCategories(field);
  const entityQueries = field.includes("core") ? inferEntityQueriesFromPrompt(userPrompt || material.userPrompt || "", "") : [];
  const riskOnly = /uncertain|uncertainties|conflict|风险|不确定/.test(field);
  let scopedFacts = metadataOnly
    ? []
    : categories.length
      ? facts.filter((fact) => categories.includes(String(fact.category || "")))
      : facts;
  if (!metadataOnly && categories.length && !scopedFacts.length && facts.length) {
    scopedFacts = facts;
  }
  if (entityQueries.length) {
    const matched = scopedFacts.filter((fact) => factMatchesAnyEntity(fact, entityQueries));
    if (matched.length) scopedFacts = matched;
  }
  if (riskOnly) {
    scopedFacts = facts.filter((fact) => {
      const confidence = Number(fact.confidence || 0);
      const text = factSearchText(fact);
      return confidence < 0.65 || /冲突|不确定|未知|缺失|矛盾|存疑|待确认/.test(text);
    });
  }

  const maxFacts = maxFactsForSummaryField(field);
  const compactFacts = scopedFacts
    .sort((left, right) => Number(right.importance || 0) * 2 + Number(right.confidence || 0)
      - (Number(left.importance || 0) * 2 + Number(left.confidence || 0)))
    .slice(0, maxFacts)
    .sort((left, right) => Number(left.chapter_index || 0) - Number(right.chapter_index || 0))
    .map(compactFactForFinalSummary);

  return {
    userPrompt: material.userPrompt,
    sourceStats: material.sourceStats,
    failedChapters: Array.isArray(material.failedChapters) ? material.failedChapters.slice(0, 120) : [],
    missingChapters: Array.isArray(material.missingChapters) ? material.missingChapters.slice(0, 120) : [],
    compressedResults: metadataOnly ? [] : compressedResults,
    reviewedChapters: metadataOnly ? [] : reviewedChapters.map((chapter) => ({
      chapter_index: chapter.chapter_index,
      title: chapter.title,
      facts: (chapter.facts || [])
        .filter((fact) => !categories.length || categories.includes(String(fact.category || "")))
        .slice(0, 20)
        .map(compactFactForFinalSummary)
    })).filter((chapter) => chapter.facts.length),
    facts: compactFacts
  };
}

function isMetadataOnlyFieldName(fieldName) {
  return /^(book_id|book_name|task|title|version|schema_version|metadata|language|locale|format|output_format|analysis_mode|mode|source|source_type|stage|phase|period|era|阶段|时期|时代)$/i.test(String(fieldName || ""));
}

function prepareEvidenceSourceMaterial({ sourceMaterial, fieldName, fieldSchema, userPrompt, materialLabel, budget }) {
  const base = sourceMaterial && typeof sourceMaterial === "object" ? sourceMaterial : {};
  const packets = buildEvidencePacketsForField({
    sourceMaterial: base,
    fieldName,
    fieldSchema,
    userPrompt
  });
  const rankedPackets = rankEvidencePackets({
    packets,
    fieldName,
    fieldSchema,
    userPrompt
  });
  const baseMaterial = evidenceBaseMaterial({ sourceMaterial: base, fieldName, materialLabel });
  const fullMaterial = {
    ...baseMaterial,
    sourceStats: {
      ...(baseMaterial.sourceStats || {}),
      evidence_packet_count: rankedPackets.length
    },
    evidence_packets: rankedPackets
  };
  if (!rankedPackets.length && Array.isArray(base.compressedResults) && base.compressedResults.length) {
    return {
      material: fullMaterial,
      chunks: [fullMaterial]
    };
  }
  if (rankedPackets.length && rankedPackets.every((packet) => packet.source_type === "chapter_summary")) {
    const material = ensureEvidenceInputWithinBudget({
      material: fullMaterial,
      userPrompt,
      fieldName,
      fieldSchema,
      materialLabel,
      budget,
      preserveCoverage: true
    });
    return {
      material,
      chunks: [material]
    };
  }
  if (fieldName === "final") {
    const material = ensureEvidenceInputWithinBudget({
      material: fullMaterial,
      userPrompt,
      fieldName,
      fieldSchema,
      materialLabel,
      budget,
      preserveCoverage: true
    });
    return {
      material,
      chunks: [material]
    };
  }
  const forceChunk = isLargeFieldSchema(fieldSchema)
    && rankedPackets.length > 8
    && !rankedPackets.every((packet) => packet.source_type === "chapter_summary");
  if (!forceChunk && inputTextLength(buildCustomFieldSummaryInput({
    userPrompt,
    sourceMaterial: fullMaterial,
    materialLabel,
    fieldName,
    fieldSchema
  })) <= budget) {
    return {
      material: fullMaterial,
      chunks: [fullMaterial]
    };
  }

  const chunks = splitEvidencePacketsIntoBudgetedChunks({
    baseMaterial,
    packets: rankedPackets,
    userPrompt,
    fieldName,
    fieldSchema,
    materialLabel,
    budget
  });
  return {
    material: chunks[0] || fullMaterial,
    chunks: chunks.length ? chunks : [fullMaterial]
  };
}

function sourceTraceFromMaterial({ partKey, parentKey = "", stage, fieldName, material }) {
  const safeMaterial = material && typeof material === "object" ? material : {};
  const packets = Array.isArray(safeMaterial.evidence_packets) ? safeMaterial.evidence_packets : [];
  const compressedResults = Array.isArray(safeMaterial.compressedResults) ? safeMaterial.compressedResults : [];
  const chapters = [...new Set(packets
    .map((packet) => Number(packet.chapter_index || 0))
    .filter((chapterIndex) => Number.isFinite(chapterIndex) && chapterIndex > 0))]
    .sort((left, right) => left - right);
  const subjects = uniqueCompact(packets.map((packet) => packet.subject), 12);
  const relatedSubjects = uniqueCompact(packets.flatMap((packet) => packet.related_subjects || []), 8);
  const sourceStats = safeMaterial.sourceStats && typeof safeMaterial.sourceStats === "object" ? safeMaterial.sourceStats : {};
  return {
    part_key: String(partKey || ""),
    parent_key: String(parentKey || ""),
    stage: String(stage || ""),
    field_name: String(fieldName || safeMaterial.split?.fieldName || ""),
    batch: Number(safeMaterial.split?.batch || 1),
    total_batches: Number(safeMaterial.split?.total || 1),
    evidence_packet_count: packets.length,
    source_types: countValues(packets.map((packet) => packet.source_type || "unknown")),
    chapters: {
      count: chapters.length,
      min: chapters[0] || null,
      max: chapters[chapters.length - 1] || null,
      sample: compactChapterSample(chapters)
    },
    categories: countValues(packets.map((packet) => packet.category).filter(Boolean)),
    fact_types: countValues(packets.map((packet) => packet.fact_type).filter(Boolean)),
    subjects,
    related_subjects: relatedSubjects,
    compressed_results_count: compressedResults.length,
    trimmed_by_budget: Boolean(sourceStats.evidence_packets_trimmed_by_budget),
    omitted_by_budget: Number(sourceStats.evidence_packets_omitted_by_budget || 0)
  };
}

function mergeSourceTraces(traces, overrides = {}) {
  const normalized = (traces || []).filter((trace) => trace && typeof trace === "object");
  const chapters = new Set();
  const sourceTypes = new Map();
  const categories = new Map();
  const factTypes = new Map();
  const subjects = [];
  const relatedSubjects = [];
  let packetCount = 0;
  let compressedResultsCount = 0;
  let omittedByBudget = 0;
  let trimmedByBudget = false;
  for (const trace of normalized) {
    packetCount += Number(trace.evidence_packet_count || 0);
    compressedResultsCount += Number(trace.compressed_results_count || 0);
    omittedByBudget += Number(trace.omitted_by_budget || 0);
    trimmedByBudget = trimmedByBudget || Boolean(trace.trimmed_by_budget);
    mergeCountMap(sourceTypes, trace.source_types);
    mergeCountMap(categories, trace.categories);
    mergeCountMap(factTypes, trace.fact_types);
    for (const chapterIndex of trace.chapters?.sample || []) {
      const number = Number(chapterIndex || 0);
      if (Number.isFinite(number) && number > 0) chapters.add(number);
    }
    if (trace.chapters?.min) chapters.add(Number(trace.chapters.min));
    if (trace.chapters?.max) chapters.add(Number(trace.chapters.max));
    subjects.push(...(Array.isArray(trace.subjects) ? trace.subjects : []));
    relatedSubjects.push(...(Array.isArray(trace.related_subjects) ? trace.related_subjects : []));
  }
  const chapterList = [...chapters].filter(Boolean).sort((left, right) => left - right);
  return {
    part_key: String(overrides.partKey || ""),
    parent_key: String(overrides.parentKey || ""),
    stage: String(overrides.stage || ""),
    field_name: String(overrides.fieldName || ""),
    batch: 1,
    total_batches: normalized.length || 1,
    evidence_packet_count: packetCount || compressedResultsCount,
    source_types: Object.fromEntries(sourceTypes),
    chapters: {
      count: chapterList.length,
      min: chapterList[0] || null,
      max: chapterList[chapterList.length - 1] || null,
      sample: compactChapterSample(chapterList)
    },
    categories: Object.fromEntries(categories),
    fact_types: Object.fromEntries(factTypes),
    subjects: uniqueCompact(subjects, 12),
    related_subjects: uniqueCompact(relatedSubjects, 8),
    compressed_results_count: compressedResultsCount,
    trimmed_by_budget: trimmedByBudget,
    omitted_by_budget: omittedByBudget
  };
}

function mergeCountMap(target, source) {
  if (!source || typeof source !== "object") return;
  for (const [key, value] of Object.entries(source)) {
    if (!key) continue;
    target.set(key, (target.get(key) || 0) + Number(value || 0));
  }
}

function countValues(values) {
  const counts = {};
  for (const value of values || []) {
    const key = String(value || "").trim();
    if (!key) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function uniqueCompact(values, limit) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))]
    .slice(0, limit);
}

function compactChapterSample(chapters, limit = 16) {
  const values = [...new Set(chapters || [])].filter(Boolean).sort((left, right) => left - right);
  if (values.length <= limit) return values;
  const headCount = Math.ceil(limit / 2);
  const tailCount = Math.floor(limit / 2);
  return [...values.slice(0, headCount), ...values.slice(-tailCount)];
}

function evidenceBaseMaterial({ sourceMaterial, fieldName, materialLabel }) {
  const base = sourceMaterial && typeof sourceMaterial === "object" ? sourceMaterial : {};
  return {
    sourceStats: base.sourceStats || {},
    failedChapters: Array.isArray(base.failedChapters) ? base.failedChapters.slice(0, 120) : [],
    missingChapters: Array.isArray(base.missingChapters) ? base.missingChapters.slice(0, 120) : [],
    split: {
      fieldName,
      materialLabel,
      batch: 1,
      total: 1
    }
  };
}

function splitEvidencePacketsIntoBudgetedChunks({ baseMaterial, packets, userPrompt, fieldName, fieldSchema, materialLabel, budget }) {
  if (!packets.length) {
    const emptyMaterial = { ...baseMaterial, evidence_packets: [] };
    return [ensureEvidenceInputWithinBudget({
      material: emptyMaterial,
      userPrompt,
      fieldName,
      fieldSchema,
      materialLabel,
      budget
    })];
  }

  const chunks = [];
  let current = [];
  for (const packet of packets) {
    const candidate = [...current, packet];
    const candidateMaterial = budgetEvidenceMaterial({
      baseMaterial,
      packets: candidate,
      userPrompt,
      fieldName,
      fieldSchema,
      materialLabel,
      budget,
      batch: chunks.length + 1,
      total: 1
    });
    if (current.length && candidateMaterial.evidence_packets.length < candidate.length) {
      chunks.push(current);
      current = [packet];
      continue;
    }
    if (current.length && inputTextLength(buildCustomFieldSummaryInput({
      userPrompt,
      sourceMaterial: candidateMaterial,
      materialLabel,
      fieldName,
      fieldSchema
    })) > budget) {
      chunks.push(current);
      current = [packet];
      continue;
    }
    current = candidate;
  }
  if (current.length) chunks.push(current);

  const total = chunks.length || 1;
  return (chunks.length ? chunks : [[]]).map((chunk, index) => budgetEvidenceMaterial({
    baseMaterial,
    packets: chunk,
    userPrompt,
    fieldName,
    fieldSchema,
    materialLabel,
    budget,
    batch: index + 1,
    total
  }));
}

function budgetEvidenceMaterial({ baseMaterial, packets, userPrompt, fieldName, fieldSchema, materialLabel, budget, batch, total }) {
  const material = {
    ...baseMaterial,
    split: {
      ...(baseMaterial.split || {}),
      fieldName,
      materialLabel,
      batch,
      total
    },
    sourceStats: {
      ...(baseMaterial.sourceStats || {}),
      evidence_packet_count: packets.length
    },
    evidence_packets: packets
  };
  return ensureEvidenceInputWithinBudget({
    material,
    userPrompt,
    fieldName,
    fieldSchema,
    materialLabel,
    budget
  });
}

function ensureEvidenceInputWithinBudget({ material, userPrompt, fieldName, fieldSchema, materialLabel, budget, preserveCoverage = false }) {
  let output = material;
  let packets = Array.isArray(output.evidence_packets) ? output.evidence_packets : [];
  if (preserveCoverage && inputTextLength(buildCustomFieldSummaryInput({
    userPrompt,
    sourceMaterial: output,
    materialLabel,
    fieldName,
    fieldSchema
  })) > budget) {
    const passOnePackets = packets.map((packet) => compactEvidencePacketForBudget(packet, {
      contentChars: 48,
      evidenceItems: 0,
      evidenceChars: 0,
      tagItems: 0,
      tagChars: 0
    }));
    output = {
      ...output,
      sourceStats: {
        ...(output.sourceStats || {}),
        evidence_packet_count: passOnePackets.length,
        evidence_packets_trimmed_by_budget: true
      },
      evidence_packets: passOnePackets
    };
    packets = passOnePackets;
  }
  if (preserveCoverage && inputTextLength(buildCustomFieldSummaryInput({
    userPrompt,
    sourceMaterial: output,
    materialLabel,
    fieldName,
    fieldSchema
  })) > budget) {
    const passTwoPackets = packets.map((packet) => compactEvidencePacketForBudget(packet, {
      contentChars: 16,
      evidenceItems: 0,
      evidenceChars: 0,
      tagItems: 0,
      tagChars: 0
    }));
    output = {
      ...output,
      sourceStats: {
        ...(output.sourceStats || {}),
        evidence_packet_count: passTwoPackets.length,
        evidence_packets_trimmed_by_budget: true
      },
      evidence_packets: passTwoPackets
    };
    packets = passTwoPackets;
  }
  while (packets.length && inputTextLength(buildCustomFieldSummaryInput({
    userPrompt,
    sourceMaterial: output,
    materialLabel,
    fieldName,
    fieldSchema
  })) > budget) {
    packets = packets.slice(0, -1);
    output = {
      ...output,
      sourceStats: {
        ...(output.sourceStats || {}),
        evidence_packet_count: packets.length,
        evidence_packets_omitted_by_budget: Math.max(0, (material.evidence_packets || []).length - packets.length)
      },
      evidence_packets: packets
    };
  }
  if (inputTextLength(buildCustomFieldSummaryInput({
    userPrompt,
    sourceMaterial: output,
    materialLabel,
    fieldName,
    fieldSchema
  })) <= budget) {
    return output;
  }

  const trimmedPackets = packets.map((packet) => ({
    ...packet,
    content: clipText(packet.content, 120),
    evidence: compactStringArray(packet.evidence, 1, 60)
  }));
  output = {
    ...output,
    sourceStats: {
      ...(output.sourceStats || {}),
      evidence_packet_count: trimmedPackets.length,
      evidence_packets_trimmed_by_budget: true
    },
    evidence_packets: trimmedPackets
  };
  while (trimmedPackets.length && inputTextLength(buildCustomFieldSummaryInput({
    userPrompt,
    sourceMaterial: output,
    materialLabel,
    fieldName,
    fieldSchema
  })) > budget) {
    trimmedPackets.pop();
    output = {
      ...output,
      sourceStats: {
        ...(output.sourceStats || {}),
        evidence_packet_count: trimmedPackets.length,
        evidence_packets_omitted_by_budget: Math.max(0, (material.evidence_packets || []).length - trimmedPackets.length),
        evidence_packets_trimmed_by_budget: true
      },
      evidence_packets: [...trimmedPackets]
    };
  }
  return output;
}

function compactEvidencePacketForBudget(packet, { contentChars, evidenceItems, evidenceChars, tagItems, tagChars }) {
  const compacted = {
    source_type: packet.source_type,
    chapter_index: packet.chapter_index,
    category: packet.category,
    subject: packet.subject,
    related_subjects: compactStringArray(packet.related_subjects, 2, 20),
    fact_type: packet.fact_type,
    content: clipText(packet.content, contentChars),
    evidence: compactStringArray(packet.evidence, evidenceItems, evidenceChars),
    importance: packet.importance,
    confidence: packet.confidence,
    tags: compactStringArray(packet.tags, tagItems, tagChars)
  };
  for (const [key, value] of Object.entries(compacted)) {
    if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) {
      delete compacted[key];
    }
  }
  return compacted;
}

function buildEvidencePacketsForField({ sourceMaterial, fieldName, fieldSchema, userPrompt }) {
  const material = sourceMaterial && typeof sourceMaterial === "object" ? sourceMaterial : {};
  const packets = [];
  for (const fact of Array.isArray(material.facts) ? material.facts : []) {
    const packet = factToEvidencePacket(fact);
    if (packet) packets.push(packet);
  }
  for (const chapter of Array.isArray(material.reviewedChapters) ? material.reviewedChapters : []) {
    packets.push(...reviewedChapterToEvidencePackets(chapter));
  }
  for (const result of Array.isArray(material.compressedResults) ? material.compressedResults : []) {
    const packet = compressedResultToEvidencePacket(result);
    if (packet) packets.push(packet);
  }
  return dedupeEvidencePackets(packets)
    .map((packet) => ({
      ...packet,
      relevance: evidenceRelevanceScore({ packet, fieldName, fieldSchema, userPrompt })
    }));
}

function materialHasEvidence(sourceMaterial) {
  const material = sourceMaterial && typeof sourceMaterial === "object" ? sourceMaterial : {};
  if (Array.isArray(material.evidence_packets) && material.evidence_packets.length) return true;
  if (Array.isArray(material.facts) && material.facts.length) return true;
  if (Array.isArray(material.reviewedChapters) && material.reviewedChapters.some((chapter) => Array.isArray(chapter?.facts) && chapter.facts.length)) return true;
  if (Array.isArray(material.compressedResults) && material.compressedResults.length) return true;
  return false;
}

function factToEvidencePacket(fact) {
  if (!fact || typeof fact !== "object") return null;
  return {
    source_type: fact.review_source === "source_review" ? "source_review" : "l2_fact",
    chapter_index: Number(fact.chapter_index || 0) || null,
    category: String(fact.category || ""),
    subject: String(fact.entity || ""),
    related_subjects: compactStringArray(fact.related_entities, 5, 40),
    fact_type: String(fact.fact_type || ""),
    content: clipText(fact.fact || "", EVIDENCE_PACKET_CONTENT_CHARS),
    evidence: compactStringArray(fact.evidence, 2, EVIDENCE_PACKET_EVIDENCE_CHARS),
    importance: numberOrNull(fact.importance),
    confidence: numberOrNull(fact.confidence),
    tags: compactStringArray(fact.tags, 6, 32)
  };
}

function reviewedChapterToEvidencePackets(chapter) {
  const chapterIndex = Number(chapter?.chapter_index || 0) || null;
  return (Array.isArray(chapter?.facts) ? chapter.facts : [])
    .map((fact) => factToEvidencePacket({ ...fact, chapter_index: chapterIndex, review_source: "source_review" }))
    .filter(Boolean)
    .map((packet) => ({
      ...packet,
      chapter_title: clipText(chapter?.title || "", 80)
    }));
}

function compressedResultToEvidencePacket(result) {
  if (!result || typeof result !== "object") return null;
  return {
    source_type: "chapter_summary",
    chapter_index: Number(result.chapter_index || 0) || null,
    chapter_title: clipText(result.chapter_title || result.title || "", 80),
    category: "",
    subject: "",
    related_subjects: [],
    fact_type: "chapter_summary",
    content: clipText(result.summary || summarizeUnknownResult(result, EVIDENCE_PACKET_CONTENT_CHARS), EVIDENCE_PACKET_CONTENT_CHARS),
    evidence: compactStringArray([
      ...(Array.isArray(result.key_points) ? result.key_points : []),
      ...(Array.isArray(result.evidence_notes) ? result.evidence_notes : [])
    ], 2, EVIDENCE_PACKET_EVIDENCE_CHARS),
    importance: null,
    confidence: null,
    tags: compactStringArray(result.key_points, 4, 32)
  };
}

function dedupeEvidencePackets(packets) {
  const seen = new Set();
  const output = [];
  for (const packet of packets) {
    const key = [
      packet.source_type,
      packet.chapter_index,
      packet.category,
      packet.subject,
      packet.fact_type,
      packet.content
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(packet);
  }
  return output;
}

function rankEvidencePackets({ packets, fieldName, fieldSchema, userPrompt }) {
  return [...packets].sort((left, right) => {
    const leftScore = evidenceRelevanceScore({ packet: left, fieldName, fieldSchema, userPrompt });
    const rightScore = evidenceRelevanceScore({ packet: right, fieldName, fieldSchema, userPrompt });
    return rightScore - leftScore
      || Number(left.chapter_index || 0) - Number(right.chapter_index || 0);
  });
}

function evidenceRelevanceScore({ packet, fieldName, fieldSchema, userPrompt }) {
  const haystack = evidencePacketSearchText(packet);
  const fieldTokens = tokenizeForRelevance(fieldName);
  const promptTokens = tokenizeForRelevance(userPrompt).slice(0, 80);
  let score = Number(packet.importance || 0) * 3 + Number(packet.confidence || 0) * 1.5;
  if (packet.source_type === "source_review") score += 1.2;
  if (fieldSchema?.type === "array") score += 0.15;
  for (const token of fieldTokens) {
    if (token.length >= 2 && haystack.includes(token)) score += 1.6;
  }
  for (const token of promptTokens) {
    if (token.length >= 2 && haystack.includes(token)) score += 0.45;
  }
  return score;
}

function evidencePacketSearchText(packet) {
  return [
    packet.source_type,
    packet.category,
    packet.subject,
    packet.fact_type,
    packet.content,
    ...(packet.related_subjects || []),
    ...(packet.tags || []),
    ...(packet.evidence || [])
  ].map(normalizeRouteToken).join(" ");
}

function tokenizeForRelevance(value) {
  const text = normalizeRouteToken(value);
  const ascii = text.match(/[a-z0-9_]{2,}/g) || [];
  const cjk = text.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  const fragments = [];
  for (const token of cjk) {
    fragments.push(token);
    for (let size = 2; size <= Math.min(4, token.length); size += 1) {
      for (let index = 0; index <= token.length - size; index += 1) {
        fragments.push(token.slice(index, index + size));
      }
    }
  }
  return [...new Set([...ascii, ...fragments])].filter((token) => !RELEVANCE_STOPWORDS.has(token));
}

const RELEVANCE_STOPWORDS = new Set([
  "json",
  "schema",
  "字段",
  "输出",
  "分析",
  "要求",
  "章节",
  "结果",
  "信息",
  "资料",
  "说明"
]);

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function summaryFieldCategories(field) {
  if (/character|角色|人物|appearance|外貌/.test(field)) return ["character", "relationship"];
  if (/relationship|关系/.test(field)) return ["relationship", "character"];
  if (/cultivation|修炼|境界|体系/.test(field)) return ["cultivation"];
  if (/item|weapon|物品|武器|法宝|剑/.test(field)) return ["item"];
  if (/force|faction|势力|宗门/.test(field)) return ["force"];
  if (/location|place|地点|空间/.test(field)) return ["location"];
  if (/event|事件|timeline|时间线/.test(field)) return ["event"];
  return [];
}

function maxFactsForSummaryField(field) {
  if (/core|核心/.test(field)) return 260;
  if (/important|重要/.test(field)) return 360;
  if (/minor|次要/.test(field)) return 220;
  if (/uncertain|uncertainties|conflict|风险|不确定/.test(field)) return 160;
  return 280;
}

function factMatchesAnyEntity(fact, entityQueries) {
  const text = factSearchText(fact);
  return entityQueries.some((entity) => text.includes(normalizeRouteToken(entity)));
}

function factSearchText(fact) {
  return [
    fact?.entity,
    fact?.fact_type,
    fact?.fact,
    ...(fact?.aliases || []),
    ...(fact?.tags || []),
    ...(fact?.related_entities || []),
    ...(fact?.evidence || [])
  ].map(normalizeRouteToken).join(" ");
}

function compactFactForFinalSummary(fact) {
  return {
    chapter_index: fact.chapter_index,
    category: fact.category,
    entity: fact.entity,
    related_entities: compactStringArray(fact.related_entities, 4, 40),
    fact_type: fact.fact_type,
    fact: clipText(fact.fact, 280),
    evidence: compactStringArray(fact.evidence, 2, 120),
    importance: fact.importance,
    confidence: fact.confidence
  };
}

function buildEvidenceSummaryInput({ userPrompt, sourceMaterial, materialLabel, contextLabel = "最终汇总" }) {
  return [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: [
            userPrompt,
            "",
            `以下是${materialLabel || "汇总素材"}的标准证据包 JSON。请基于这些证据包完成${contextLabel}。`,
            "要求：证据包已经包含来源类型、章节、主体、事实、证据摘记、重要度和置信度；不要要求重新读取原文。",
            "取舍：优先使用高相关、高重要度、高置信度证据；证据不足时保持不确定，不要补写不存在的信息。",
            "",
            "证据包素材 JSON：",
            JSON.stringify(sourceMaterial || {})
          ].join("\n")
        }
      ]
    }
  ];
}

function buildCustomFieldSummaryInput({ userPrompt, sourceMaterial, materialLabel, fieldName, fieldSchema }) {
  return [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: [
            userPrompt,
            "",
            `以下是${materialLabel || "汇总素材"}的标准证据包 JSON。请基于这些证据包进行最终汇总。`,
            "注意：证据包已经包含来源类型、章节、主体、事实、证据摘记、重要度和置信度；不要要求重新读取原文。",
            "取舍：优先使用高相关、高重要度、高置信度证据；证据不足时保持不确定，不要补写不存在的信息。",
            "",
            `当前只生成最终 JSON 的一个顶层字段：${fieldName}`,
            "输出要求：",
            `- 只输出一个 JSON 对象，且只包含 ${fieldName} 这一个顶层字段。`,
            "- 字段含义、颗粒度、命名和取舍标准必须服从用户汇总 Prompt 中同名字段。",
            "- 如果该字段确实没有可用信息，输出符合字段类型的空值；不要输出 N/A、暂无、占位说明。",
            "- 不要输出 Markdown，不要输出其他顶层字段。",
            "",
            "当前字段 Schema JSON：",
            JSON.stringify(fieldSchema || looseJsonValueSchema()),
            "",
            "证据包素材 JSON：",
            JSON.stringify(sourceMaterial || {})
          ].join("\n")
        }
      ]
    }
  ];
}

function safeSchemaName(value) {
  const normalized = String(value || "")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return normalized || "custom_field";
}

async function runSummaryStageWithRetry(task, stageLabel, operation) {
  let lastError;
  for (let attempt = 1; attempt <= SUMMARY_STAGE_MAX_ATTEMPTS; attempt += 1) {
    await waitIfPaused(task);
    try {
      const result = await operation();
      assertNotCancelled(task);
      return result;
    } catch (error) {
      lastError = error;
      if (!shouldRetrySummaryStage(error) || attempt >= SUMMARY_STAGE_MAX_ATTEMPTS) {
        throw error;
      }
      updateTask(task, {
        progress: { ...task.progress, current: stageLabel },
        message: `${stageLabel} 失败，准备重试 ${attempt + 1}/${SUMMARY_STAGE_MAX_ATTEMPTS}：${sanitizeText(error.message)}`
      }, "warning");
      await delay(SUMMARY_STAGE_RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError;
}

function shouldRetrySummaryStage(error) {
  const message = String(error?.message || "").toLowerCase();
  if (error?.status === 429 || error?.status >= 500) return true;
  return [
    "aborted",
    "timeout",
    "timed out",
    "fetch failed",
    "network",
    "网络连接失败",
    "unexpected end of json input",
    "不是合法 json"
  ].some((pattern) => message.includes(pattern));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseOutputSchemaOrNull(value) {
  try {
    const schema = JSON.parse(String(value || ""));
    return schema && typeof schema === "object" ? schema : null;
  } catch {
    return null;
  }
}

function deriveFinalSummarySchema({ userPrompt, configuredSchema }) {
  const promptSchema = schemaFromPromptJsonTemplate(userPrompt);
  if (promptSchema) {
    return {
      schema: promptSchema,
      schemaName: "custom_final_analysis",
      strict: false
    };
  }

  const arrayItemFieldSchema = schemaFromPromptJsonArrayFieldDeclaration(userPrompt);
  if (arrayItemFieldSchema) {
    return {
      schema: arrayItemFieldSchema,
      schemaName: "custom_final_analysis",
      strict: false,
      unwrapField: "items"
    };
  }

  const declaredFieldSchema = schemaFromPromptFieldDeclaration(userPrompt);
  if (declaredFieldSchema) {
    return {
      schema: declaredFieldSchema,
      schemaName: "custom_final_analysis",
      strict: false
    };
  }

  if (configuredSchema && shouldUseJsonFinalSummary(userPrompt)) {
    return {
      schema: configuredSchema,
      schemaName: "final_analysis",
      strict: true
    };
  }

  return null;
}

function shouldUseJsonFinalSummary(userPrompt) {
  const prompt = String(userPrompt || "");
  const lower = prompt.toLowerCase();
  if (
    /不要\s*(输出)?\s*json/i.test(prompt)
    || /不(?:要|用|需要)\s*(输出)?\s*json/i.test(prompt)
    || /禁止\s*(输出)?\s*json/i.test(prompt)
    || /纯文本/.test(prompt)
    || /(?<!不)(?<!不要)(?<!禁止)(?:输出|使用|采用|按照|按|以)[^。；\n]*markdown/i.test(prompt)
    || /(?<!不)(?<!不要)(?<!禁止)markdown[^。；\n]*(?:格式|输出|呈现)/i.test(prompt)
    || /(?<!不)(?<!不要)(?<!禁止)表格/.test(prompt)
    || /按(?:照)?[^。；\n]*(格式|模板)[^。；\n]*(输出|呈现)/.test(prompt)
    || lower.includes("plain text")
  ) {
    return false;
  }
  return /json\s*schema/i.test(prompt)
    || /schema\s*json/i.test(prompt)
    || /给定\s*(?:的)?\s*(?:json\s*)?schema/i.test(prompt)
    || /匹配[^。；\n]*(?:json\s*)?schema/i.test(prompt)
    || /符合[^。；\n]*(?:json\s*)?schema/i.test(prompt)
    || /按[^。；\n]*(?:json\s*)?schema/i.test(prompt)
    || /最终输出必须匹配给定\s*json\s*schema/i.test(prompt);
}

function schemaFromPromptJsonTemplate(userPrompt) {
  const template = extractLastJsonObjectTemplate(userPrompt);
  if (!template || Array.isArray(template)) return null;
  return schemaFromJsonTemplate(template);
}

function schemaFromPromptFieldDeclaration(userPrompt) {
  const text = String(userPrompt || "");
  if (!/json/i.test(text)) return null;
  const declaration = findTopLevelFieldDeclaration(text);
  if (!declaration) return null;
  const uniqueFields = declaredFieldsFromSegment(declaration[1]);
  if (uniqueFields.length < 2) return null;
  return schemaFromDeclaredFields(uniqueFields);
}

function schemaFromPromptJsonArrayFieldDeclaration(userPrompt) {
  const text = String(userPrompt || "");
  if (!/json/i.test(text)) return null;
  const declaration = findArrayItemFieldDeclaration(text);
  if (!declaration) return null;
  const fields = declaredFieldsFromSegment(declaration[1]);
  if (fields.length < 2) return null;
  return schemaFromDeclaredItemFields(fields);
}

function findTopLevelFieldDeclaration(text) {
  const pattern = /(?:字段包括|字段为|顶层字段(?:包括|为)?|JSON\s*字段(?:包括|为)?)[：:\s]*([\s\S]{0,600})/ig;
  for (const match of text.matchAll(pattern)) {
    const prefix = text.slice(Math.max(0, match.index - 24), match.index);
    if (/(?:每个|每一|每项|每条|每条记录|对象|条目|数组|元素|记录)\s*$/.test(prefix)) continue;
    return match;
  }
  return null;
}

function findArrayItemFieldDeclaration(text) {
  const patterns = [
    /(?:JSON\s*)?数组[^。；\n]{0,140}?(?:每(?:个|一)?(?:对象|条目|项|元素|记录)|数组(?:对象|条目|项|元素|记录)?)[^。；\n]{0,50}?(?:字段(?:包括|为)?|包含字段)[：:\s]*([\s\S]{0,600})/i,
    /(?:每(?:个|一)?(?:对象|条目|项|元素|记录)|数组(?:对象|条目|项|元素|记录)?)[^。；\n]{0,80}?(?:字段(?:包括|为)?|包含字段)[：:\s]*([\s\S]{0,600})/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const contextStart = Math.max(0, (match.index || 0) - 160);
    const context = text.slice(contextStart, (match.index || 0) + match[0].length);
    if (/json\s*数组|数组/i.test(context)) return match;
  }
  return null;
}

function declaredFieldsFromSegment(value) {
  const segment = String(value || "").split(/\n\s*\n|。|；|;/)[0] || "";
  const fields = segment
    .split(/[、,，\s]+/)
    .map(cleanDeclaredFieldToken)
    .filter(isValidDeclaredFieldName);
  return [...new Set(fields)];
}

function cleanDeclaredFieldToken(value) {
  return String(value || "")
    .trim()
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "")
    .replace(/[：:。；;,.，、]+$/g, "")
    .trim();
}

function isValidDeclaredFieldName(value) {
  return /^[A-Za-z_\u4e00-\u9fff][A-Za-z0-9_\u4e00-\u9fff]{0,80}$/.test(String(value || ""));
}

function schemaFromDeclaredFields(fields) {
  const properties = {};
  for (const field of fields) {
    properties[field] = schemaForDeclaredField(field);
  }
  return {
    type: "object",
    additionalProperties: true,
    properties,
    required: fields
  };
}

function schemaFromDeclaredItemFields(fields) {
  const properties = {};
  for (const field of fields) {
    properties[field] = schemaForDeclaredField(field);
  }
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties,
          required: fields
        }
      }
    },
    required: ["items"]
  };
}

function schemaForDeclaredField(fieldName) {
  const normalized = String(fieldName || "").toLowerCase();
  if (/characters|uncertainties|items|stages|evidence|chapters|facts|list|array/.test(normalized)) {
    return {
      type: "array",
      items: { type: "object", additionalProperties: true }
    };
  }
  if (/count|chapter_index|start_chapter|end_chapter/.test(normalized)) return { type: "integer" };
  if (/is_|has_|should_|重大|是否/.test(normalized)) return { type: "boolean" };
  return { type: "string" };
}

function extractLastJsonObjectTemplate(value) {
  const text = String(value || "");
  const range = lastJsonObjectTemplateRange(text);
  if (!range) return null;
  try {
    return JSON.parse(text.slice(range.start, range.end + 1));
  } catch {
    return null;
  }
}

function lastJsonObjectTemplateRange(value) {
  const text = String(value || "");
  for (let end = text.length - 1; end >= 0; end -= 1) {
    if (text[end] !== "}") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let start = end; start >= 0; start -= 1) {
      const char = text[start];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }
      if (char === "\"") {
        inString = true;
        continue;
      }
      if (char === "}") depth += 1;
      if (char === "{") {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(start, end + 1));
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { start, end };
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

function schemaFromJsonTemplate(value) {
  if (Array.isArray(value)) {
    return {
      type: "array",
      items: value.length ? schemaFromJsonTemplate(value[0]) : looseJsonValueSchema()
    };
  }
  if (value && typeof value === "object") {
    const properties = {};
    const required = [];
    for (const [key, entry] of Object.entries(value)) {
      properties[key] = schemaFromJsonTemplate(entry);
      required.push(key);
    }
    return {
      type: "object",
      additionalProperties: true,
      properties,
      required
    };
  }
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "number" };
  if (typeof value === "boolean") return { type: "boolean" };
  if (value === null) return looseJsonValueSchema();
  return { type: "string" };
}

function looseJsonValueSchema() {
  return {
    anyOf: [
      { type: "string" },
      { type: "number" },
      { type: "integer" },
      { type: "boolean" },
      { type: "object", additionalProperties: true },
      { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }, { type: "integer" }, { type: "boolean" }, { type: "object", additionalProperties: true } ] } }
    ]
  };
}

function inputTextLength(input) {
  return input.reduce((sum, item) => (
    sum + (item.content || []).reduce((inner, content) => inner + String(content.text || "").length, 0)
  ), 0);
}

function compactChapterResultsForSummary({ chapterResults, failedChapters, userPrompt, targetChars = SUMMARY_COMPACT_TARGET_CHARS }) {
  const count = Math.max(1, chapterResults.length);
  const promptReserve = String(userPrompt || "").length + JSON.stringify(failedChapters || []).length + 1500;
  const perChapterBudget = Math.max(80, Math.min(420, Math.floor((targetChars - promptReserve) / count)));
  return chapterResults.map((result) => compactChapterResult(result, perChapterBudget));
}

function compactChapterResult(result, budget) {
  const chapterIndex = Number(result?.chapter_index || 0);
  const title = clipText(result?.chapter_title || result?.title || "", 80);
  const summaryBudget = Math.max(80, Math.floor(budget * 0.48));
  const keyPointBudget = Math.max(55, Math.floor(budget * 0.22));
  const evidenceBudget = Math.max(40, Math.floor(budget * 0.12));
  const fallback = summarizeUnknownResult(result, Math.max(100, Math.floor(budget * 0.7)));
  return {
    chapter_index: chapterIndex,
    chapter_title: title,
    summary: clipText(result?.summary || fallback, summaryBudget),
    key_points: compactStringArray(result?.key_points, 2, keyPointBudget),
    evidence_notes: compactStringArray(result?.evidence_notes, 1, evidenceBudget)
  };
}

function compactStringArray(value, maxItems, maxChars) {
  const items = Array.isArray(value) ? value : [];
  return items
    .map((item) => clipText(item, maxChars))
    .filter(Boolean)
    .slice(0, maxItems);
}

function summarizeUnknownResult(value, maxChars) {
  if (!value || typeof value !== "object") return clipText(value, maxChars);
  const fragments = [];
  for (const [key, entry] of Object.entries(value)) {
    if (["chapter_index", "chapter_title", "title"].includes(key)) continue;
    if (typeof entry === "string") {
      fragments.push(`${key}: ${entry}`);
    } else if (Array.isArray(entry)) {
      fragments.push(`${key}: ${entry.slice(0, 3).map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("; ")}`);
    }
    if (fragments.join(" ").length >= maxChars) break;
  }
  return clipText(fragments.join(" "), maxChars);
}

function clipText(value, maxChars) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function parseJsonOrText(value) {
  if (value && typeof value === "object") return value;
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseJsonObject(value) {
  if (!value) return null;
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function assertFinalSummaryUseful(finalResult, sourceChapterCount, options = {}) {
  if (sourceChapterCount < 3) return;

  if (typeof finalResult === "string") {
    const text = finalResult.trim();
    if (text && !isPlaceholderText(text)) return;
    throw finalSummaryQualityError();
  }

  if (!finalResult || typeof finalResult !== "object") {
    throw finalSummaryQualityError();
  }

  const summary = String(finalResult.summary || "").trim();
  const title = String(finalResult.title || "").trim();
  const items = Array.isArray(finalResult.items) ? finalResult.items : [];
  const hasUsefulSummary = Boolean(summary) && !isPlaceholderText(summary);
  const hasUsefulTitle = Boolean(title) && !isPlaceholderText(title);
  if (items.length || hasUsefulSummary || hasUsefulTitle || hasAnyUsefulCustomValue(finalResult, options)) return;
  throw finalSummaryQualityError();
}

function hasAnyUsefulCustomValue(value, options = {}) {
  let hasContentField = false;
  let hasUsefulContentField = false;
  const properties = options.schema?.properties && typeof options.schema.properties === "object"
    ? options.schema.properties
    : {};
  for (const [key, entry] of Object.entries(value)) {
    if (["title", "summary", "items", "failed_chapters"].includes(key)) continue;
    const schema = properties[key];
    const isContentField = isFinalContentField(key, schema, entry);
    if (isContentField) {
      hasContentField = true;
      if (isUsefulFinalValue(entry)) hasUsefulContentField = true;
      continue;
    }
    if (isUsefulFinalValue(entry)) return true;
  }
  return hasContentField ? hasUsefulContentField : false;
}

function isFinalContentField(fieldName, fieldSchema, value) {
  if (isMetadataOnlyFieldName(fieldName)) return false;
  if (isAnalysisParameterField(fieldName, fieldSchema)) return false;
  if (isOptionalSummaryFieldName(fieldName)) {
    return false;
  }
  return isPotentialPrimaryContentField(fieldName, fieldSchema, value);
}

function isRequiredPrimaryContentField(fieldName) {
  return /timeline|records|entries|results|characters|subjects|entities|时间线|记录|结果|人物|角色|主体|实体/i.test(String(fieldName || ""));
}

function isPotentialPrimaryContentField(fieldName, fieldSchema, value) {
  return isPrimaryContentFieldName(fieldName) && (isLargeFieldSchema(fieldSchema) || Array.isArray(value) || (value && typeof value === "object"));
}

function isPrimaryContentFieldName(fieldName) {
  return /timeline|records|entries|items|results|facts|events|characters|subjects|entities|stages|chapters|assets|list|array|时间线|记录|结果|事实|事件|人物|角色|主体|实体|阶段|章节|资产|列表/i.test(String(fieldName || ""));
}

function isOptionalSummaryFieldName(fieldName) {
  return /uncertain|uncertainties|conflict|risk|warning|error|failed|missing|important|minor|secondary|optional|note|notes|不确定|冲突|风险|失败|缺失|重要|次要|可选|备注/i.test(String(fieldName || ""));
}

function isUsefulFinalValue(value) {
  if (typeof value === "string") return Boolean(value.trim()) && !isPlaceholderText(value);
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some((item) => isUsefulFinalValue(item));
  if (value && typeof value === "object") return Object.values(value).some((entry) => isUsefulFinalValue(entry));
  return false;
}

function isPlaceholderText(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["", "n/a", "na", "null", "none", "无", "暂无", "空"].includes(normalized);
}

function finalSummaryQualityError() {
  const error = new Error("最终汇总结果疑似占位或为空，已拒绝保存。请续跑最终汇总。");
  error.status = 502;
  return error;
}

function emptyContentFieldError(fieldName) {
  const error = new Error(`最终汇总字段 ${fieldName} 有可用证据但结果为空，已拒绝保存。请续跑最终汇总。`);
  error.status = 502;
  return error;
}

function buildL1AnalysisContext({ bookId, chapters, startChapter, endChapter }) {
  const chapterIndexes = listL1ChapterIndexes(bookId, startChapter, endChapter)
    .filter((chapter) => chapter.status === "completed");
  const chaptersByIndex = new Map(chapterIndexes.map((chapter) => [chapter.chapter_index, chapter]));
  const missingChapters = chapters
    .filter((chapter) => !chaptersByIndex.has(chapter.chapter_index))
    .map((chapter) => chapter.chapter_index);
  return {
    chaptersByIndex,
    missingChapters
  };
}

function withL1ChapterContext(userPrompt, chapterIndex) {
  if (!chapterIndex) return userPrompt;
  return [
    userPrompt,
    "",
    "可选 L1 章节上下文 JSON：",
    JSON.stringify({
      summary: chapterIndex.summary,
      keywords: chapterIndex.keywords,
      entities: chapterIndex.entities,
      key_events: chapterIndex.key_events,
      items_places_orgs: chapterIndex.items_places_orgs,
      open_questions: chapterIndex.open_questions
    })
  ].join("\n");
}

export async function publicAnalysisRunWithResult(id) {
  const run = getAnalysisRun(id);
  if (!run) {
    const error = new Error("分析任务不存在。");
    error.status = 404;
    throw error;
  }
  const chapters = listAnalysisChapterMetadata(id);
  const summaryParts = listAnalysisSummaryPartMetadata(id);
  const promptConfigError = isAnalysisPromptConfigError(run.error_summary);
  const visibleSummaryParts = promptConfigError ? [] : summaryParts;
  const sourceTrace = sourceTraceFromSummaryParts(summaryParts);
  const chapterResults = await decryptCompletedAnalysisChapterResults(id);
  const resultIndexes = new Set(chapterResults.map((entry) => entry.chapter_index));
  const selection = parseChapterSelection(run);
  const byChapter = new Map(chapters.map((chapter) => [chapter.chapter_index, chapter]));
  const failedChapterIndexes = chapters
    .filter((chapter) => chapter.status === "failed")
    .map((chapter) => chapter.chapter_index);
  const pendingChapterIndexes = selection.chapter_indexes.filter((chapterIndex) => {
    const entry = byChapter.get(chapterIndex);
    return !entry || entry.status !== "completed" || !entry.has_result;
  });
  return {
    ...publicAnalysisRun(run),
    chapters,
    chapterResults,
    failedChapterIndexes,
    pendingChapterIndexes,
    completedChapterIndexes: [...resultIndexes].sort((left, right) => left - right),
    canResume: canResumeAnalysisRun(run, chapters, selection),
    summaryParts: visibleSummaryParts,
    summaryProgress: summaryProgressFromParts(visibleSummaryParts),
    failedSummaryParts: visibleSummaryParts.filter((part) => part.status === "failed"),
    canResumeSummary: visibleSummaryParts.some((part) => part.status === "failed"),
    sourceTrace,
    sourceTraceSummary: sourceTraceSummary(sourceTrace),
    prompt: await decryptAnalysisPromptSnapshot(id),
    finalResult: run.status === "completed" && run.ciphertext ? await decryptFinalAnalysisResult(id) : null
  };
}

function isAnalysisPromptConfigError(message) {
  return /分析 Prompt 的字段 .*?(缺少具体分析对象|目标范围|仍是占位内容)/.test(String(message || ""));
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
    source_stats: parseJsonObject(run.source_stats),
    created_at: run.created_at,
    updated_at: run.updated_at
  };
}

export function getL2IndexCoverageForBook({ bookId, startChapter, endChapter }) {
  const settings = getPromptSettings();
  const bookPrompts = getBookIndexPrompts(bookId);
  return getL2Coverage({
    bookId,
    startChapter,
    endChapter,
    model: settings.model,
    promptHash: bookL2IndexPromptHash(bookPrompts),
    schemaVersion: L2_SCHEMA_VERSION
  });
}

export async function listL2FactsForBook({ bookId, startChapter, endChapter, category, entity, limit }) {
  return listL2Facts({
    bookId,
    startChapter,
    endChapter,
    categories: category ? String(category).split(",") : [],
    entity,
    limit,
    includeContent: true
  });
}

function rangeIndexes(start, end) {
  const indexes = [];
  for (let index = start; index <= end; index += 1) indexes.push(index);
  return indexes;
}

function isFatalUpstreamError(message) {
  return /成本保护|rate limit|quota|insufficient_quota|billing|429/i.test(String(message || ""));
}

function normalizeChapterIndexes(value) {
  if (!Array.isArray(value)) return [];
  const indexes = value.map((entry) => normalizeChapterIndex(entry));
  return [...new Set(indexes)].sort((left, right) => left - right);
}

function normalizeAnalysisMode(value) {
  return ["fast_index", "balanced", "precision", "full_text"].includes(value) ? value : "balanced";
}

function normalizeL2BuildMode(value) {
  return ["all", "missing", "retry_failed"].includes(value) ? value : "all";
}

function normalizeOptionalBudget(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.min(100, number);
}

function sourceReviewBudgetForMode(mode, chapterCount, override) {
  if (Number.isInteger(override)) return override;
  if (mode === "fast_index") return 0;
  if (mode === "precision") return Math.min(30, Math.max(5, Math.ceil(chapterCount * 0.03)));
  if (mode === "balanced") return Math.min(10, Math.max(3, Math.ceil(chapterCount * 0.01)));
  return 0;
}

function inferL2CategoriesFromPrompt(prompt) {
  const text = String(prompt || "").toLowerCase();
  const categories = new Set();
  if (/人物|角色|主角|配角|身份|character|role/.test(text)) categories.add("character");
  if (/关系|羁绊|师徒|敌友|relationship/.test(text)) categories.add("relationship");
  if (/境界|修炼|功法|体系|cultivation/.test(text)) categories.add("cultivation");
  if (/宗门|势力|门派|组织|force|faction|sect/.test(text)) categories.add("force");
  if (/武器|法宝|物品|道具|item|weapon/.test(text)) categories.add("item");
  if (/地点|地图|空间|location|place/.test(text)) categories.add("location");
  if (/事件|剧情|时间线|event|timeline/.test(text)) categories.add("event");
  if (/伏笔|线索|foreshadow/.test(text)) categories.add("foreshadowing");
  return categories.size ? [...categories] : [];
}

function inferEntityQueriesFromPrompt(prompt, bookId = "") {
  const text = String(prompt || "");
  const stopwords = new Set([
    "json",
    "schema",
    "markdown",
    "剑来",
    "第一瞳术师",
    "废材那又怎样",
    String(bookId || "")
  ].filter(Boolean));
  const candidates = [
    ...[...text.matchAll(/[《“「『]([^》”」』]{1,24})[》”」』]/g)].map((match) => match[1]),
    ...[...text.matchAll(/(?:主体|对象|关键词|关键主体|分析对象|围绕|关于|聚焦|只看|查询)[:：为是\s]*([^\n，。；;、]{2,40})/g)].flatMap((match) => splitEntityCandidates(match[1])),
    ...[...text.matchAll(/[\u4e00-\u9fa5A-Za-z0-9]{2,12}(?:本命飞剑|飞剑|本命物|佩剑|剑|法宝|境界|关系)/g)].map((match) => match[0]),
    ...[...text.matchAll(/(?:陈平安|齐静春|宁姚|阮邛|阿良|崔瀺|陆沉|老秀才|左右|裴钱|魏檗|宋集薪|顾璨|刘羡阳|飞剑|本命飞剑|本命物)/g)].map((match) => match[0])
  ];
  const normalized = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const value = normalizeEntityCandidate(candidate);
    if (!value || stopwords.has(value) || /json|schema|markdown/i.test(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized.slice(0, 6);
}

function splitEntityCandidates(value) {
  return String(value || "")
    .split(/[、,，/和与及\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeEntityCandidate(value) {
  return String(value || "")
    .replace(/[。；;：:，,、]/g, " ")
    .trim()
    .replace(/^(请|要|需要|分析|总结|整理|输出|围绕|关于|聚焦|只看|中|里|其中|有关|关于)+/, "")
    .replace(/(相关|有关|的信息|的内容|资料|设定|分析|总结|输出)+$/, "")
    .trim()
    .slice(0, 24);
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

function canResumeAnalysisRun(run, chapters, selection) {
  if (!run || run.ciphertext || !run.prompt_ciphertext) return false;
  if (run.status === "completed") return false;
  const selectedCount = selection.chapter_indexes.length || run.chapter_count || 0;
  if (!selectedCount) return false;
  const completed = chapters.filter((chapter) => chapter.status === "completed" && chapter.has_result).length;
  return completed < selectedCount || run.status === "failed" || run.status === "cancelled";
}

function summaryProgressFromParts(parts = []) {
  return {
    total: parts.length,
    completed: parts.filter((part) => part.status === "completed").length,
    failed: parts.filter((part) => part.status === "failed").length,
    running: parts.filter((part) => part.status === "running").length
  };
}

function sourceTraceFromSummaryParts(parts = []) {
  return parts
    .map((part) => {
      const trace = part.trace_summary || {};
      if (!trace || typeof trace !== "object" || !Number(trace.evidence_packet_count || 0)) return null;
      return {
        part_key: part.part_key,
        parent_key: part.parent_key || "",
        stage: part.stage,
        status: part.status,
        field_name: trace.field_name || inferFieldNameFromPartKey(part.part_key),
        batch: Number(trace.batch || 1),
        total_batches: Number(trace.total_batches || 1),
        evidence_packet_count: Number(trace.evidence_packet_count || 0),
        source_types: trace.source_types || {},
        chapters: trace.chapters || { count: 0, sample: [] },
        categories: trace.categories || {},
        fact_types: trace.fact_types || {},
        subjects: Array.isArray(trace.subjects) ? trace.subjects : [],
        related_subjects: Array.isArray(trace.related_subjects) ? trace.related_subjects : [],
        trimmed_by_budget: Boolean(trace.trimmed_by_budget),
        omitted_by_budget: Number(trace.omitted_by_budget || 0)
      };
    })
    .filter(Boolean);
}

function sourceTraceSummary(traces = []) {
  const sourceTypes = new Map();
  const categories = new Map();
  const chapters = new Set();
  const subjects = [];
  const preferred = traces.some((trace) => trace.stage === "json_field_batch")
    ? traces.filter((trace) => trace.stage === "json_field_batch")
    : traces.filter((trace) => trace.part_key !== "json.final.merge" || traces.length === 1);
  for (const trace of preferred) {
    mergeCountMap(sourceTypes, trace.source_types);
    mergeCountMap(categories, trace.categories);
    subjects.push(...(trace.subjects || []));
    for (const chapterIndex of trace.chapters?.sample || []) {
      const number = Number(chapterIndex || 0);
      if (Number.isFinite(number) && number > 0) chapters.add(number);
    }
    if (trace.chapters?.min) chapters.add(Number(trace.chapters.min));
    if (trace.chapters?.max) chapters.add(Number(trace.chapters.max));
  }
  const chapterList = [...chapters].sort((left, right) => left - right);
  return {
    parts: traces.length,
    evidence_packet_count: preferred.reduce((sum, trace) => sum + Number(trace.evidence_packet_count || 0), 0),
    source_types: Object.fromEntries(sourceTypes),
    categories: Object.fromEntries(categories),
    chapters: {
      count: chapterList.length,
      min: chapterList[0] || null,
      max: chapterList[chapterList.length - 1] || null,
      sample: compactChapterSample(chapterList)
    },
    subjects: uniqueCompact(subjects, 12),
    trimmed_by_budget: preferred.some((trace) => trace.trimmed_by_budget),
    omitted_by_budget: preferred.reduce((sum, trace) => sum + Number(trace.omitted_by_budget || 0), 0)
  };
}

function inferFieldNameFromPartKey(partKey) {
  const match = String(partKey || "").match(/^json\.([^.]+)\./);
  return match?.[1] || "final";
}
