import {
  createAnalysisRun,
  decryptAnalysisChapterResult,
  decryptCompletedAnalysisChapterResults,
  decryptAnalysisPromptSnapshot,
  decryptChapterContent,
  decryptFinalAnalysisResult,
  ensureBook,
  getAnalysisChapterMetadata,
  getAnalysisRun,
  getExistingChapterIndexes,
  getL1ChapterIndex,
  getL1Coverage,
  getPromptSettings,
  listAnalysisChapterMetadata,
  listChapterMetadata,
  listL1ChapterIndexes,
  normalizeBookId,
  normalizeBookName,
  normalizeChapterIndex,
  normalizePromptSettings,
  normalizeRange,
  promptHash,
  saveAnalysisChapter,
  saveEncryptedChapter,
  saveFinalAnalysisResult,
  saveL1ChapterIndex,
  schemaHash,
  updateAnalysisRun,
  updateBookImportStatus
} from "./db.js";
import { buildChapterBatches, fetchChapterBatch } from "./dify.js";
import {
  buildChapterInput,
  buildCompressedSummaryInput,
  buildL1ChapterInput,
  buildSummaryCompressionInput,
  buildSummaryInput,
  callOpenAIJson,
  callOpenAIText,
  chapterResultSchema,
  l1ChapterIndexSchema,
  summaryCompressionSchema,
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

const DIRECT_SUMMARY_MAX_CHARS = 80_000;
const SUMMARY_COMPRESSION_BATCH_CHARS = 18_000;
const SUMMARY_STAGE_MAX_ATTEMPTS = 3;
const SUMMARY_STAGE_RETRY_DELAY_MS = 1200;

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
    promptPatch: payload.prompt || {},
    useL1Context: Boolean(payload.use_l1_context ?? payload.useL1Context)
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
  const model = promptSettings.model;
  const reasoningEffort = promptSettings.reasoning_effort;
  const indexPromptHash = l1PromptHash();
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
            content
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

async function prepareNewAnalysis(analysisId, { name, bookId, startChapter, endChapter, chapterIndexes, promptPatch, useL1Context }) {
  const settings = normalizePromptSettings({ ...getPromptSettings(), ...promptPatch });
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
    promptSnapshot: { ...settings, use_l1_context: useL1Context }
  });

  return {
    analysisId,
    bookId,
    startChapter,
    endChapter,
    chapters,
    settings,
    useL1Context,
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
    chapterPromptHash: run.prompt_hash || promptHash(normalizedSettings),
    outputSchemaHash: run.schema_hash || schemaHash(normalizedSettings),
    resume: true
  };
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
    task,
    model,
    reasoningEffort,
    chapterResults,
    failedChapters,
    userPrompt: settings.summary_prompt
  });

  assertNotCancelled(task);
  const finalResult = parseJsonOrText(summary.value);
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

async function reusableAnalysisChapter({ analysisId, chapter, promptHash }) {
  const existing = getAnalysisChapterMetadata(analysisId, chapter.chapter_index);
  if (!existing || existing.status !== "completed") return null;
  if (!existing.has_result) return null;
  if (existing.content_hmac !== chapter.content_hmac) return null;
  if (existing.prompt_hash !== promptHash) return null;
  return decryptAnalysisChapterResult(analysisId, chapter.chapter_index);
}

async function summarizeAnalysisResults({ task, model, reasoningEffort, chapterResults, failedChapters, userPrompt }) {
  const directInput = buildSummaryInput({ chapterResults, failedChapters, userPrompt });
  if (inputTextLength(directInput) <= DIRECT_SUMMARY_MAX_CHARS) {
    return callOpenAIText({
      model,
      reasoningEffort,
      instructions: "你是严谨的小说多章节汇总引擎。按用户汇总 Prompt 输出最终结果；如果用户要求 JSON，则只输出合法 JSON，否则直接输出文本，不要添加无关解释。",
      input: directInput
    });
  }

  const batches = chunkChapterResults(chapterResults, SUMMARY_COMPRESSION_BATCH_CHARS);
  const compressedResults = [];
  for (let index = 0; index < batches.length; index += 1) {
    await waitIfPaused(task);
    updateTask(task, {
      progress: { ...task.progress, current: `压缩汇总素材 ${index + 1}/${batches.length}` },
      message: `正在压缩汇总素材 ${index + 1}/${batches.length}`
    });
    const batchIndexes = new Set(batches[index].map((entry) => Number(entry.chapter_index)));
    const batchFailedChapters = failedChapters.filter((chapterIndex) => batchIndexes.has(Number(chapterIndex)));
    const response = await runSummaryStageWithRetry(task, `压缩汇总素材 ${index + 1}/${batches.length}`, () => callOpenAIJson({
      model,
      reasoningEffort,
      instructions: "你是小说分析结果压缩器。请按 Schema 把当前批次逐章理解结果压缩成面向用户最终目标的结构化 JSON。",
      input: buildSummaryCompressionInput({
        chapterResults: batches[index],
        failedChapters: batchFailedChapters,
        batchIndex: index + 1,
        totalBatches: batches.length,
        userPrompt
      }),
      schema: summaryCompressionSchema(),
      schemaName: "summary_compression"
    }));
    const expectedChapters = batches[index].map((entry) => Number(entry.chapter_index)).filter(Number.isFinite);
    validateCompressedCoverage({
      batchIndex: index + 1,
      expectedChapters,
      compressed: response.value
    });
    compressedResults.push({
      batch_index: index + 1,
      chapter_indexes: expectedChapters,
      ...response.value
    });
  }

  await waitIfPaused(task);
  updateTask(task, {
    progress: { ...task.progress, current: "GPT 汇总压缩结果" },
    message: "正在基于压缩素材生成最终汇总"
  });
  return runSummaryStageWithRetry(task, "GPT 汇总压缩结果", () => callOpenAIText({
    model,
    reasoningEffort,
    instructions: "你是严谨的小说多章节汇总引擎。按用户汇总 Prompt 输出最终结果；如果用户要求 JSON，则只输出合法 JSON，否则直接输出文本，不要添加无关解释。",
    input: buildCompressedSummaryInput({
      compressedResults,
      failedChapters,
      userPrompt
    })
  }));
}

async function runSummaryStageWithRetry(task, stageLabel, operation) {
  let lastError;
  for (let attempt = 1; attempt <= SUMMARY_STAGE_MAX_ATTEMPTS; attempt += 1) {
    await waitIfPaused(task);
    try {
      return await operation();
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
  if (message.includes("汇总素材压缩覆盖")) return false;
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

function chunkChapterResults(chapterResults, maxChars) {
  const batches = [];
  let current = [];
  let currentSize = 2;
  for (const result of chapterResults) {
    const size = JSON.stringify(result).length + 1;
    if (current.length && currentSize + size > maxChars) {
      batches.push(current);
      current = [];
      currentSize = 2;
    }
    current.push(result);
    currentSize += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

function inputTextLength(input) {
  return input.reduce((sum, item) => (
    sum + (item.content || []).reduce((inner, content) => inner + String(content.text || "").length, 0)
  ), 0);
}

function validateCompressedCoverage({ batchIndex, expectedChapters, compressed }) {
  const covered = new Set((compressed.covered_chapters || []).map(Number).filter(Number.isFinite));
  const missing = expectedChapters.filter((chapterIndex) => !covered.has(chapterIndex));
  if (missing.length) {
    const error = new Error(`汇总素材压缩覆盖不完整：第 ${batchIndex} 批缺少章节 ${missing.join(", ")}`);
    error.status = 502;
    throw error;
  }
  const coveredOutsideBatch = [...covered].filter((chapterIndex) => !expectedChapters.includes(chapterIndex));
  if (coveredOutsideBatch.length) {
    const error = new Error(`汇总素材压缩覆盖异常：第 ${batchIndex} 批包含非本批章节 ${coveredOutsideBatch.join(", ")}`);
    error.status = 502;
    throw error;
  }
}

function parseJsonOrText(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
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
    prompt: await decryptAnalysisPromptSnapshot(id),
    finalResult: run.status === "completed" && run.ciphertext ? await decryptFinalAnalysisResult(id) : null
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

function l1PromptHash() {
  // Keep the legacy hash so already-built chapter L1 indexes remain reusable.
  return "l1-v1-chapter-window-10";
}

function isFatalUpstreamError(message) {
  return /成本保护|rate limit|quota|insufficient_quota|billing|429/i.test(String(message || ""));
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

function canResumeAnalysisRun(run, chapters, selection) {
  if (!run || run.ciphertext || !run.prompt_ciphertext) return false;
  if (run.status === "completed") return false;
  const selectedCount = selection.chapter_indexes.length || run.chapter_count || 0;
  if (!selectedCount) return false;
  const completed = chapters.filter((chapter) => chapter.status === "completed" && chapter.has_result).length;
  return completed < selectedCount || run.status === "failed" || run.status === "cancelled";
}
