import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "novel-service-"));
process.env.NODE_ENV = "test";
process.env.DATA_DIR = tempDir;
process.env.NOVEL_SERVICE_TEST_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.DIFY_API_BASE = "http://127.0.0.1:9999/v1";
process.env.DIFY_CHAPTER_WORKFLOW_API_KEY = "app-test";
process.env.OPENAI_API_KEY = "sk-test";
process.env.OPENAI_RETENTION_MODE = "zdr";
process.env.OPENAI_MODEL = "gpt-5.5";
process.env.OPENAI_API_BASE = "";
process.env.OPENAI_PROXY_URL = "";
process.env.OPENAI_REQUEST_TIMEOUT_MS = "30000";

const db = await import("../server/db.js");
const dify = await import("../server/dify.js");
const openai = await import("../server/openai.js");
const tasks = await import("../server/tasks.js");
const workflows = await import("../server/workflows.js");

test.after(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

test("builds Dify batches and normalizes chapter output", () => {
  assert.deepEqual(dify.buildChapterBatches(1, 25, 10), [
    { startChapter: 1, endChapter: 10 },
    { startChapter: 11, endChapter: 20 },
    { startChapter: 21, endChapter: 25 }
  ]);

  const chapters = dify.normalizeDifyChapterOutput(
    JSON.stringify({
      chapters: [
        { chapter_index: 1, title: "第一章", content: "正文一" },
        { sortid: 2, chapter_title: "第二章", text: "正文二" }
      ]
    }),
    { bookId: "215243", startChapter: 1, endChapter: 2 }
  );

  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].chapter_title, "第一章");
  assert.equal(chapters[1].chapter_index, 2);
  assert.equal(chapters[1].content, "正文二");
});

test("encrypts chapter content and stores only metadata in plain SQLite rows", async () => {
  const secretText = "固定测试短句-不应该以明文写入数据库";
  await db.saveEncryptedChapter({
    bookId: "secure-book",
    chapterIndex: 1,
    title: "密文章",
    content: secretText
  });

  const meta = db.getChapterMetadata("secure-book", 1);
  assert.equal(meta.content_length, secretText.length);
  assert.equal(meta.title, "密文章");
  assert.notEqual(meta.content_hmac, secretText);
  assert.equal(await db.decryptChapterContent("secure-book", 1), secretText);

  const dbBytes = await fs.readFile(db.getDbPath());
  assert.equal(dbBytes.includes(Buffer.from(secretText)), false);
});

test("binds one book name to each novel id", () => {
  const first = db.ensureBook("named-book", "第一本书");
  assert.equal(first.book_name, "第一本书");

  const same = db.ensureBook("named-book", "第一本书");
  assert.equal(same.book_name, "第一本书");

  assert.throws(
    () => db.ensureBook("named-book", "另一个名字"),
    /已绑定书名/
  );
});

test("OpenAI request uses Responses API with store false and no background mode", async () => {
  const previousFetch = global.fetch;
  let capturedBody;
  global.fetch = async (_url, request) => {
    capturedBody = JSON.parse(request.body);
    return {
      ok: true,
      json: async () => ({
        id: "resp_test",
        output: [
          {
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  chapter_index: 1,
                  chapter_title: "第一章",
                  summary: "摘要",
                  key_points: [],
                  evidence_notes: []
                })
              }
            ]
          }
        ]
      })
    };
  };

  try {
    const result = await openai.callOpenAIJson({
      model: "gpt-5.5",
      reasoningEffort: "medium",
      instructions: "test",
      input: [{ role: "user", content: [{ type: "input_text", text: "test" }] }],
      schema: openai.chapterResultSchema(),
      schemaName: "chapter_result"
    });
    assert.equal(result.value.summary, "摘要");
    assert.equal(capturedBody.store, false);
    assert.equal(Object.hasOwn(capturedBody, "background"), false);
    assert.equal(capturedBody.model, "gpt-5.5");
    assert.equal(Object.hasOwn(capturedBody, "max_output_tokens"), false);
  } finally {
    global.fetch = previousFetch;
  }
});

test("OpenAI text request uses Responses API with store false and no schema format", async () => {
  const previousFetch = global.fetch;
  let capturedBody;
  global.fetch = async (_url, request) => {
    capturedBody = JSON.parse(request.body);
    return {
      ok: true,
      json: async () => ({
        id: "resp_text",
        output: [
          {
            content: [
              {
                type: "output_text",
                text: "纯文本汇总"
              }
            ]
          }
        ]
      })
    };
  };

  try {
    const result = await openai.callOpenAIText({
      model: "gpt-5.5",
      reasoningEffort: "medium",
      instructions: "test",
      input: [{ role: "user", content: [{ type: "input_text", text: "test" }] }]
    });
    assert.equal(result.value, "纯文本汇总");
    assert.equal(capturedBody.store, false);
    assert.equal(Object.hasOwn(capturedBody, "background"), false);
    assert.equal(Object.hasOwn(capturedBody, "text"), false);
    assert.equal(Object.hasOwn(capturedBody, "max_output_tokens"), false);
  } finally {
    global.fetch = previousFetch;
  }
});

test("task lifecycle supports pause, resume, and cancel states", async () => {
  const task = tasks.createTask("test-lifecycle");
  tasks.markTaskRunning(task);

  const paused = tasks.pauseTask(task.id);
  assert.equal(paused.status, "paused");

  let resumed = false;
  const waiting = tasks.waitIfPaused(task).then(() => {
    resumed = true;
  });
  setTimeout(() => tasks.resumeTask(task.id), 30);
  await waiting;
  assert.equal(resumed, true);
  assert.equal(task.status, "running");

  const cancelled = tasks.cancelTask(task.id);
  assert.equal(cancelled.status, "cancelled");
  assert.throws(() => tasks.assertNotCancelled(task), /任务已取消/);
});

test("task estimate uses processed units and excludes paused time", async () => {
  const task = tasks.createTask("test-estimate");
  tasks.markTaskRunning(task, {
    progress: {
      total: 5,
      completed: 0,
      failed: 0,
      skipped: 0,
      current: "开始"
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 25));
  tasks.updateTask(task, {
    progress: {
      ...task.progress,
      completed: 1,
      current: "完成 1"
    }
  });
  const firstEstimate = tasks.publicTask(task).estimate;
  assert.equal(firstEstimate.processed, 1);
  assert.equal(firstEstimate.total, 5);
  assert.equal(firstEstimate.remainingMs > 0, true);

  tasks.pauseTask(task.id);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const pausedEstimate = tasks.publicTask(task).estimate;
  tasks.resumeTask(task.id);

  await new Promise((resolve) => setTimeout(resolve, 20));
  tasks.updateTask(task, {
    progress: {
      ...task.progress,
      skipped: 2,
      current: "跳过 2"
    }
  });
  const afterSkipEstimate = tasks.publicTask(task).estimate;
  assert.equal(afterSkipEstimate.processed, 3);
  assert.equal(afterSkipEstimate.elapsedMs < pausedEstimate.elapsedMs + 45, true);
  assert.equal(afterSkipEstimate.sampleSize > 0, true);
});

test("generates output JSON Schema from table fields", () => {
  const prompt = db.normalizePromptSettings({
    schema_mode: "fields",
    schema_fields: [
      { name: "role_name", label: "角色名", type: "string", required: true, description: "角色名称" },
      { name: "chapter_refs", label: "章节", type: "integer[]", required: true, description: "相关章节" },
      { name: "confidence", label: "置信度", type: "number", required: false, description: "0-1" }
    ]
  });
  const schema = JSON.parse(prompt.output_schema);

  assert.equal(prompt.schema_mode, "fields");
  assert.equal(prompt.schema_fields.length, 3);
  assert.equal(schema.properties.items.items.properties.role_name.type, "string");
  assert.equal(schema.properties.items.items.properties.chapter_refs.items.type, "integer");
  assert.deepEqual(schema.properties.items.items.required, ["role_name", "chapter_refs"]);
});

test("builds L1 window ranges and reports coverage with stale indexes", async () => {
  assert.deepEqual(db.buildAlignedWindowRanges(1, 25, 10), [
    { startChapter: 1, endChapter: 10 },
    { startChapter: 11, endChapter: 20 },
    { startChapter: 21, endChapter: 30 }
  ]);
  assert.deepEqual(db.buildAlignedWindowRanges(8, 12, 10), [
    { startChapter: 1, endChapter: 10 },
    { startChapter: 11, endChapter: 20 }
  ]);

  await db.saveEncryptedChapter({
    bookId: "book-l1-coverage",
    chapterIndex: 1,
    title: "第一章",
    content: "第一章正文"
  });
  await db.saveEncryptedChapter({
    bookId: "book-l1-coverage",
    chapterIndex: 2,
    title: "第二章",
    content: "第二章正文"
  });
  const chapterOne = db.getChapterMetadata("book-l1-coverage", 1);
  const chapterTwo = db.getChapterMetadata("book-l1-coverage", 2);

  db.saveL1ChapterIndex({
    bookId: "book-l1-coverage",
    chapterIndex: 1,
    status: "completed",
    sourceHmac: chapterOne.content_hmac,
    model: "gpt-5.5",
    promptHash: "l1-v1-chapter-window-10",
    value: {
      summary: "第一章索引",
      keywords: ["第一章"],
      entities: ["角色甲"],
      key_events: ["事件甲"],
      items_places_orgs: [],
      open_questions: [],
      confidence: 0.9
    }
  });
  db.saveL1ChapterIndex({
    bookId: "book-l1-coverage",
    chapterIndex: 2,
    status: "failed",
    sourceHmac: chapterTwo.content_hmac,
    model: "gpt-5.5",
    promptHash: "l1-v1-chapter-window-10",
    errorSummary: "测试失败"
  });
  db.saveL1WindowIndex({
    bookId: "book-l1-coverage",
    windowStart: 1,
    windowEnd: 10,
    status: "completed",
    sourceHmac: `1:${chapterOne.content_hmac}`,
    model: "gpt-5.5",
    promptHash: "l1-v1-chapter-window-10",
    value: {
      summary: "窗口索引",
      timeline: [],
      entity_changes: [],
      relationship_changes: [],
      foreshadowing: [],
      covered_chapters: [1],
      missing_chapters: [2],
      confidence: 0.8
    }
  });

  const coverage = db.getL1Coverage({
    bookId: "book-l1-coverage",
    startChapter: 1,
    endChapter: 2,
    model: "gpt-5.5",
    promptHash: "l1-v1-chapter-window-10",
    windowSize: 10
  });
  assert.equal(coverage.chapters.completed, 1);
  assert.equal(coverage.chapters.failed, 1);
  assert.equal(coverage.windows.completed, 1);

  await db.saveEncryptedChapter({
    bookId: "book-l1-coverage",
    chapterIndex: 1,
    title: "第一章",
    content: "第一章正文-修订"
  });
  const staleCoverage = db.getL1Coverage({
    bookId: "book-l1-coverage",
    startChapter: 1,
    endChapter: 2,
    model: "gpt-5.5",
    promptHash: "l1-v1-chapter-window-10",
    windowSize: 10
  });
  assert.equal(staleCoverage.chapters.outdated, 1);
  assert.equal(staleCoverage.windows.outdated, 1);
});

test("builds chapter-only L1 indexes, skips fresh indexes, and keeps OpenAI requests ZDR-shaped", async () => {
  await db.saveEncryptedChapter({
    bookId: "book-l1-task",
    chapterIndex: 1,
    title: "第一章",
    content: "第一章正文"
  });
  await db.saveEncryptedChapter({
    bookId: "book-l1-task",
    chapterIndex: 2,
    title: "第二章",
    content: "第二章正文"
  });

  const previousFetch = global.fetch;
  let responseCalls = 0;
  const capturedBodies = [];

  global.fetch = async (url, request) => {
    if (String(url).includes("api.openai.com/v1/models")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [] })
      };
    }

    if (!String(url).includes("api.openai.com/v1/responses")) {
      throw new Error(`Unexpected fetch URL: ${url}`);
    }

    responseCalls += 1;
    const body = JSON.parse(request.body);
    capturedBodies.push(body);
    const outputValue = {
      summary: "章节摘要",
      keywords: ["关键词"],
      entities: ["角色"],
      key_events: ["事件"],
      items_places_orgs: ["地点"],
      open_questions: ["伏笔"],
      confidence: 0.9
    };
    return {
      ok: true,
      json: async () => ({
        id: `resp_l1_${responseCalls}`,
        output: [{ content: [{ type: "output_text", text: JSON.stringify(outputValue) }] }]
      })
    };
  };

  try {
    const task = workflows.startL1IndexTask({
      book_id: "book-l1-task",
      start_chapter: 1,
      end_chapter: 2
    });
    await waitForTask(task);
    assert.equal(task.status, "completed");
    assert.equal(responseCalls, 2);
    assert.equal(db.getL1ChapterIndex("book-l1-task", 1).summary, "章节摘要");
    assert.equal(db.getL1WindowIndex("book-l1-task", 1, 10), null);
    assert.equal(capturedBodies.every((body) => body.store === false), true);
    assert.equal(capturedBodies.every((body) => !Object.hasOwn(body, "background")), true);
    assert.equal(capturedBodies.every((body) => body.text?.format?.type === "json_schema"), true);
    assert.equal(capturedBodies.every((body) => body.text?.format?.name === "l1_chapter_index"), true);

    const skipped = workflows.startL1IndexTask({
      book_id: "book-l1-task",
      start_chapter: 1,
      end_chapter: 2
    });
    await waitForTask(skipped);
    assert.equal(skipped.progress.skipped, 2);
    assert.equal(responseCalls, 2);
  } finally {
    global.fetch = previousFetch;
  }
});

test("creates, edits, lists, and deletes prompt groups with categories", () => {
  const created = db.createPromptGroup({
    name: "角色定位 Prompt",
    category: "测试书籍",
    chapter_prompt: "逐章提取角色身份",
    summary_prompt: "汇总角色身份"
  });

  assert.equal(created.name, "角色定位 Prompt");
  assert.equal(created.category, "测试书籍");
  assert.equal(db.listPromptGroups("测试书籍").some((group) => group.id === created.id), true);

  const updated = db.updatePromptGroup(created.id, {
    name: "角色定位 Prompt v2",
    category: "通用",
    summary_prompt: "重新汇总角色身份"
  });
  assert.equal(updated.name, "角色定位 Prompt v2");
  assert.equal(updated.category, "通用");
  assert.equal(updated.chapter_prompt, "逐章提取角色身份");
  assert.equal(updated.summary_prompt, "重新汇总角色身份");

  assert.equal(db.deletePromptGroup(created.id).deleted, true);
  assert.equal(db.getPromptGroup(created.id), undefined);
});

test("imports once, skips stored chapters, and analyzes from encrypted local store", async () => {
  const previousFetch = global.fetch;
  let difyCalls = 0;
  let openaiCalls = 0;

  global.fetch = async (url, request) => {
    if (String(url).includes("/workflows/run")) {
      difyCalls += 1;
      const body = JSON.parse(request.body);
      const chapters = [];
      for (let index = body.inputs.start_chapter; index <= body.inputs.end_chapter; index += 1) {
        chapters.push({
          chapter_index: index,
          chapter_title: `第${index}章`,
          content: `测试章节 ${index} 的原文`
        });
      }
      return {
        ok: true,
        json: async () => ({ data: { outputs: { result: JSON.stringify({ chapters }) } } })
      };
    }

    if (String(url).includes("api.openai.com/v1/models")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [] })
      };
    }

    if (String(url).includes("api.openai.com/v1/responses")) {
      openaiCalls += 1;
      const body = JSON.parse(request.body);
      const formatName = body.text?.format?.name || "";
      const text = body.input[0].content[0].text;
      const chapterIndex = Number(text.match(/章节编号：(\d+)/)?.[1]);
      const outputValue = formatName === "final_analysis"
        ? { title: "汇总", summary: "全书摘要", items: [], failed_chapters: [] }
        : { chapter_index: chapterIndex, chapter_title: `第${chapterIndex}章`, summary: "章节摘要", key_points: [], evidence_notes: [] };
      if (formatName !== "final_analysis") {
        assert.equal(formatName, "chapter_result");
      }
      return {
        ok: true,
        json: async () => ({
          id: `resp_${openaiCalls}`,
          output: [{ content: [{ type: "output_text", text: JSON.stringify(outputValue) }] }]
        })
      };
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  try {
    const firstImport = workflows.startImportTask({
      book_id: "book-e2e",
      start_chapter: 1,
      end_chapter: 3
    });
    await waitForTask(firstImport);
    assert.equal(firstImport.status, "completed");
    assert.equal(difyCalls, 1);
    assert.equal(db.listChapterMetadata("book-e2e").length, 3);

    const secondImport = workflows.startImportTask({
      book_id: "book-e2e",
      start_chapter: 1,
      end_chapter: 3
    });
    await waitForTask(secondImport);
    assert.equal(secondImport.progress.skipped, 3);
    assert.equal(difyCalls, 1);

    const analysis = workflows.startAnalysisTask({
      book_id: "book-e2e",
      start_chapter: 1,
      end_chapter: 3
    });
    await waitForTask(analysis);
    assert.equal(analysis.status, "completed");
    assert.equal(openaiCalls, 4);
    const result = await workflows.publicAnalysisRunWithResult(analysis.id);
    assert.equal(result.finalResult.summary, "全书摘要");
  } finally {
    global.fetch = previousFetch;
  }
});

test("analyzes selected non-contiguous chapters, preserves prompt snapshot, and deletes run", async () => {
  await db.saveEncryptedChapter({
    bookId: "book-selected",
    chapterIndex: 1,
    title: "第一章",
    content: "第一章正文"
  });
  await db.saveEncryptedChapter({
    bookId: "book-selected",
    chapterIndex: 2,
    title: "第二章",
    content: "第二章正文"
  });
  await db.saveEncryptedChapter({
    bookId: "book-selected",
    chapterIndex: 3,
    title: "第三章",
    content: "第三章正文"
  });

  const previousFetch = global.fetch;
  const requestedChapters = [];

  global.fetch = async (url, request) => {
    if (String(url).includes("api.openai.com/v1/models")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [] })
      };
    }

    if (!String(url).includes("api.openai.com/v1/responses")) {
      throw new Error(`Unexpected fetch URL: ${url}`);
    }
    const body = JSON.parse(request.body);
    const formatName = body.text?.format?.name || "";
    const text = body.input[0].content[0].text;
    if (formatName === "final_analysis" || (!formatName && !text.includes("章节编号："))) {
      return {
        ok: true,
        json: async () => ({
          id: "resp_summary",
          output: [{ content: [{ type: "output_text", text: JSON.stringify({ title: "汇总", summary: "选择章节", items: [], failed_chapters: [] }) }] }]
        })
      };
    }

    assert.equal(formatName, "chapter_result");
    const chapterIndex = Number(text.match(/章节编号：(\d+)/)?.[1]);
    requestedChapters.push(chapterIndex);
    return {
      ok: true,
      json: async () => ({
        id: `resp_${chapterIndex}`,
        output: [{
          content: [{
            type: "output_text",
            text: JSON.stringify({
              chapter_index: chapterIndex,
              chapter_title: `第${chapterIndex}章`,
              summary: "章节摘要",
              key_points: [],
              evidence_notes: []
            })
          }]
        }]
      })
    };
  };

  try {
    const prompt = db.normalizePromptSettings({
      name: "快照模板",
      chapter_prompt: "SNAPSHOT_A",
      summary_prompt: "SUMMARY_A",
      schema_mode: "fields",
      schema_fields: [{ name: "name", label: "名称", type: "string", required: true, description: "" }]
    });
    const analysis = workflows.startAnalysisTask({
      name: "非连续选择",
      book_id: "book-selected",
      start_chapter: 1,
      end_chapter: 3,
      chapter_indexes: [3, 1, 1],
      prompt
    });
    await waitForTask(analysis);

    assert.deepEqual(requestedChapters, [1, 3]);
    const result = await workflows.publicAnalysisRunWithResult(analysis.id);
    assert.equal(result.name, "非连续选择");
    assert.deepEqual(result.chapter_indexes, [1, 3]);
    assert.equal(result.prompt.chapter_prompt, "SNAPSHOT_A");

    db.savePromptSettings({ chapter_prompt: "CHANGED_PROMPT" });
    const snapshotAfterDefaultChange = await workflows.publicAnalysisRunWithResult(analysis.id);
    assert.equal(snapshotAfterDefaultChange.prompt.chapter_prompt, "SNAPSHOT_A");

    assert.equal(db.deleteAnalysisRun(analysis.id).deleted, true);
    assert.equal(db.getAnalysisRun(analysis.id), undefined);
  } finally {
    global.fetch = previousFetch;
  }
});

test("analysis keeps default input without L1 and appends L1 context only when enabled", async () => {
  await db.saveEncryptedChapter({
    bookId: "book-l1-analysis",
    chapterIndex: 1,
    title: "第一章",
    content: "第一章正文"
  });
  const chapter = db.getChapterMetadata("book-l1-analysis", 1);
  db.saveL1ChapterIndex({
    bookId: "book-l1-analysis",
    chapterIndex: 1,
    status: "completed",
    sourceHmac: chapter.content_hmac,
    model: "gpt-5.5",
    promptHash: "l1-v1-chapter-window-10",
    value: {
      summary: "L1 章节摘要",
      keywords: ["L1关键词"],
      entities: ["L1角色"],
      key_events: ["L1事件"],
      items_places_orgs: ["L1地点"],
      open_questions: ["L1伏笔"],
      confidence: 0.9
    }
  });
  db.saveL1WindowIndex({
    bookId: "book-l1-analysis",
    windowStart: 1,
    windowEnd: 10,
    status: "completed",
    sourceHmac: `1:${chapter.content_hmac}`,
    model: "gpt-5.5",
    promptHash: "l1-v1-chapter-window-10",
    value: {
      summary: "L1 窗口摘要",
      timeline: ["L1时间线"],
      entity_changes: [],
      relationship_changes: [],
      foreshadowing: ["L1伏笔线索"],
      covered_chapters: [1],
      missing_chapters: [],
      confidence: 0.8
    }
  });

  const previousFetch = global.fetch;
  const chapterPrompts = [];
  const summaryPrompts = [];

  global.fetch = async (url, request) => {
    if (String(url).includes("api.openai.com/v1/models")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [] })
      };
    }

    if (!String(url).includes("api.openai.com/v1/responses")) {
      throw new Error(`Unexpected fetch URL: ${url}`);
    }
    const body = JSON.parse(request.body);
    const text = body.input[0].content[0].text;
    const formatName = body.text?.format?.name || "";
    if (formatName === "final_analysis") {
      summaryPrompts.push(text);
      return {
        ok: true,
        json: async () => ({
          id: "resp_summary_l1",
          output: [{ content: [{ type: "output_text", text: JSON.stringify({ title: "汇总", summary: "汇总摘要", items: [], failed_chapters: [] }) }] }]
        })
      };
    }

    assert.equal(formatName, "chapter_result");
    chapterPrompts.push(text);
    return {
      ok: true,
      json: async () => ({
        id: "resp_chapter_l1",
        output: [{
          content: [{
            type: "output_text",
            text: JSON.stringify({
              chapter_index: 1,
              chapter_title: "第一章",
              summary: "章节摘要",
              key_points: [],
              evidence_notes: []
            })
          }]
        }]
      })
    };
  };

  try {
    const withoutL1 = workflows.startAnalysisTask({
      book_id: "book-l1-analysis",
      start_chapter: 1,
      end_chapter: 1
    });
    await waitForTask(withoutL1);
    assert.equal(chapterPrompts[0].includes("可选 L1 章节上下文 JSON"), false);
    assert.equal(summaryPrompts[0].includes("可选 L1 窗口上下文 JSON"), false);

    const withL1 = workflows.startAnalysisTask({
      book_id: "book-l1-analysis",
      start_chapter: 1,
      end_chapter: 1,
      use_l1_context: true
    });
    await waitForTask(withL1);
    assert.equal(chapterPrompts[1].includes("可选 L1 章节上下文 JSON"), true);
    assert.equal(chapterPrompts[1].includes("L1 章节摘要"), true);
    assert.equal(summaryPrompts[1].includes("可选 L1 窗口上下文 JSON"), false);
    assert.equal(summaryPrompts[1].includes("L1 窗口摘要"), false);
    const result = await workflows.publicAnalysisRunWithResult(withL1.id);
    assert.equal(result.prompt.use_l1_context, true);
  } finally {
    global.fetch = previousFetch;
  }
});

test("stores plain text final analysis result when summary is not JSON", async () => {
  await db.saveEncryptedChapter({
    bookId: "book-text-result",
    chapterIndex: 1,
    title: "第一章",
    content: "第一章正文"
  });

  const previousFetch = global.fetch;

  global.fetch = async (url, request) => {
    if (String(url).includes("api.openai.com/v1/models")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [] })
      };
    }

    if (!String(url).includes("api.openai.com/v1/responses")) {
      throw new Error(`Unexpected fetch URL: ${url}`);
    }
    const body = JSON.parse(request.body);
    const formatName = body.text?.format?.name || "";
    const isSummary = !formatName;
    const outputValue = isSummary
      ? "这是纯文本最终汇总"
      : JSON.stringify({
        chapter_index: 1,
        chapter_title: "第一章",
        summary: "章节摘要",
        key_points: [],
        evidence_notes: []
      });
    return {
      ok: true,
      json: async () => ({
        id: isSummary ? "resp_text_summary" : "resp_chapter",
        output: [{ content: [{ type: "output_text", text: outputValue }] }]
      })
    };
  };

  try {
    const analysis = workflows.startAnalysisTask({
      name: "纯文本结果",
      book_id: "book-text-result",
      start_chapter: 1,
      end_chapter: 1,
      prompt: {
        summary_prompt: "请直接输出一段中文结论，不要 JSON。"
      }
    });
    await waitForTask(analysis);
    const result = await workflows.publicAnalysisRunWithResult(analysis.id);
    assert.equal(result.finalResult, "这是纯文本最终汇总");
  } finally {
    global.fetch = previousFetch;
  }
});

test("exposes partial analysis results and resumes by skipping completed chapters", async () => {
  for (const chapterIndex of [1, 2, 3]) {
    await db.saveEncryptedChapter({
      bookId: "book-resume",
      chapterIndex,
      title: `第${chapterIndex}章`,
      content: `第${chapterIndex}章正文`
    });
  }

  const previousFetch = global.fetch;
  const requestedChapters = [];
  let failChapterTwo = true;
  let summaryCalls = 0;

  global.fetch = async (url, request) => {
    if (String(url).includes("api.openai.com/v1/models")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [] })
      };
    }

    if (!String(url).includes("api.openai.com/v1/responses")) {
      throw new Error(`Unexpected fetch URL: ${url}`);
    }
    const body = JSON.parse(request.body);
    const formatName = body.text?.format?.name || "";
    if (formatName === "final_analysis") {
      summaryCalls += 1;
      if (failChapterTwo) {
        throw new Error("summary interrupted");
      }
      assert.equal(body.max_output_tokens > 0, true);
      return {
        ok: true,
        json: async () => ({
          id: `resp_resume_summary_${summaryCalls}`,
          output: [{ content: [{ type: "output_text", text: JSON.stringify({ title: "续跑汇总", summary: "完成", items: [], failed_chapters: [] }) }] }]
        })
      };
    }

    assert.equal(formatName, "chapter_result");
    const text = body.input[0].content[0].text;
    const chapterIndex = Number(text.match(/章节编号：(\d+)/)?.[1]);
    requestedChapters.push(chapterIndex);
    if (chapterIndex === 2 && failChapterTwo) {
      return {
        ok: true,
        json: async () => ({
          id: "resp_bad_json",
          output: [{ content: [{ type: "output_text", text: "" }] }]
        })
      };
    }
    return {
      ok: true,
      json: async () => ({
        id: `resp_resume_${chapterIndex}`,
        output: [{
          content: [{
            type: "output_text",
            text: JSON.stringify({
              chapter_index: chapterIndex,
              chapter_title: `第${chapterIndex}章`,
              summary: `章节${chapterIndex}摘要`,
              key_points: [],
              evidence_notes: []
            })
          }]
        }]
      })
    };
  };

  try {
    const analysis = workflows.startAnalysisTask({
      name: "断点续跑",
      book_id: "book-resume",
      start_chapter: 1,
      end_chapter: 3
    });
    await assert.rejects(() => waitForTask(analysis), /summary interrupted/);

    assert.equal(analysis.status, "failed");
    assert.deepEqual(requestedChapters, [1, 2, 3]);
    let partial = await workflows.publicAnalysisRunWithResult(analysis.id);
    assert.equal(partial.finalResult, null);
    assert.equal(partial.chapterResults.length, 2);
    assert.deepEqual(partial.failedChapterIndexes, [2]);
    assert.equal(partial.canResume, true);

    failChapterTwo = false;
    const resumed = workflows.resumeAnalysisRunTask(analysis.id);
    await waitForTask(resumed);

    assert.equal(resumed.status, "completed");
    assert.deepEqual(requestedChapters, [1, 2, 3, 2]);
    assert.equal(resumed.progress.skipped, 2);
    partial = await workflows.publicAnalysisRunWithResult(analysis.id);
    assert.equal(partial.finalResult.summary, "完成");
    assert.equal(partial.chapterResults.length, 3);
    assert.equal(partial.canResume, false);
  } finally {
    global.fetch = previousFetch;
  }
});

test("resumes summary failure without rerunning completed chapters", async () => {
  for (const chapterIndex of [1, 2]) {
    await db.saveEncryptedChapter({
      bookId: "book-summary-resume",
      chapterIndex,
      title: `第${chapterIndex}章`,
      content: `第${chapterIndex}章正文`
    });
  }

  const previousFetch = global.fetch;
  const requestedChapters = [];
  let failSummary = true;

  global.fetch = async (url, request) => {
    if (String(url).includes("api.openai.com/v1/models")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [] })
      };
    }

    if (!String(url).includes("api.openai.com/v1/responses")) {
      throw new Error(`Unexpected fetch URL: ${url}`);
    }
    const body = JSON.parse(request.body);
    const formatName = body.text?.format?.name || "";
    if (formatName === "final_analysis") {
      if (failSummary) {
        throw new Error("summary network fail");
      }
      assert.equal(body.max_output_tokens > 0, true);
      return {
        ok: true,
        json: async () => ({
          id: "resp_summary_resume_ok",
          output: [{ content: [{ type: "output_text", text: JSON.stringify({ title: "汇总", summary: "续跑成功", items: [], failed_chapters: [] }) }] }]
        })
      };
    }

    assert.equal(formatName, "chapter_result");
    const text = body.input[0].content[0].text;
    const chapterIndex = Number(text.match(/章节编号：(\d+)/)?.[1]);
    requestedChapters.push(chapterIndex);
    return {
      ok: true,
      json: async () => ({
        id: `resp_summary_resume_${chapterIndex}`,
        output: [{
          content: [{
            type: "output_text",
            text: JSON.stringify({
              chapter_index: chapterIndex,
              chapter_title: `第${chapterIndex}章`,
              summary: `章节${chapterIndex}摘要`,
              key_points: [],
              evidence_notes: []
            })
          }]
        }]
      })
    };
  };

  try {
    const analysis = workflows.startAnalysisTask({
      name: "汇总失败续跑",
      book_id: "book-summary-resume",
      start_chapter: 1,
      end_chapter: 2
    });
    await assert.rejects(() => waitForTask(analysis), /summary network fail/);
    const partial = await workflows.publicAnalysisRunWithResult(analysis.id);
    assert.equal(partial.chapterResults.length, 2);
    assert.equal(partial.finalResult, null);

    failSummary = false;
    const resumed = workflows.resumeAnalysisRunTask(analysis.id);
    await waitForTask(resumed);

    assert.deepEqual(requestedChapters, [1, 2]);
    assert.equal(resumed.progress.skipped, 2);
    const result = await workflows.publicAnalysisRunWithResult(analysis.id);
    assert.equal(result.finalResult.summary, "续跑成功");
  } finally {
    global.fetch = previousFetch;
  }
});

test("compresses large summary inputs before final analysis", async () => {
  const chapterCount = 90;
  for (let chapterIndex = 1; chapterIndex <= chapterCount; chapterIndex += 1) {
    await db.saveEncryptedChapter({
      bookId: "book-large-summary",
      chapterIndex,
      title: `第${chapterIndex}章`,
      content: `第${chapterIndex}章正文`
    });
  }

  const previousFetch = global.fetch;
  let finalSummaryCalls = 0;
  let largestSummaryInput = 0;
  let finalSummaryUsedSchema = false;

  global.fetch = async (url, request) => {
    if (String(url).includes("api.openai.com/v1/models")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [] })
      };
    }

    if (!String(url).includes("api.openai.com/v1/responses")) {
      throw new Error(`Unexpected fetch URL: ${url}`);
    }
    const body = JSON.parse(request.body);
    const text = body.input[0].content[0].text;
    const formatName = body.text?.format?.name || "";
    if (formatName === "final_analysis") {
      finalSummaryUsedSchema = true;
      largestSummaryInput = Math.max(largestSummaryInput, text.length);
      if (text.includes("分批压缩摘要 JSON")) {
        finalSummaryCalls += 1;
        assert.match(text, /"chapter_index":1/);
        assert.match(text, /"chapter_index":90/);
        assert.equal(body.max_output_tokens > 0, true);
        return {
          ok: true,
          json: async () => ({
            id: "resp_large_final",
            output: [{ content: [{ type: "output_text", text: JSON.stringify({ title: "大汇总", summary: "压缩后完成", items: [], failed_chapters: [] }) }] }]
          })
        };
      }
      throw new Error("Large summary should use compression before final summary");
    }

    if (!formatName) {
      throw new Error("JSON summary tasks should use final_analysis schema");
    }

    if (formatName === "summary_compression") {
      throw new Error("Large summary should use local compaction instead of OpenAI compression");
    }

    assert.equal(formatName, "chapter_result");
    const chapterIndex = Number(text.match(/章节编号：(\d+)/)?.[1]);
    return {
      ok: true,
      json: async () => ({
        id: `resp_large_chapter_${chapterIndex}`,
        output: [{
          content: [{
            type: "output_text",
            text: JSON.stringify({
              chapter_index: chapterIndex,
              chapter_title: `第${chapterIndex}章`,
              summary: `章节${chapterIndex}摘要${"长摘要".repeat(140)}`,
              key_points: [`关键点${chapterIndex}${"内容".repeat(120)}`],
              evidence_notes: [`证据${chapterIndex}${"线索".repeat(120)}`]
            })
          }]
        }]
      })
    };
  };

  try {
    const analysis = workflows.startAnalysisTask({
      name: "大输入汇总",
      book_id: "book-large-summary",
      start_chapter: 1,
      end_chapter: chapterCount
    });
    await waitForTask(analysis);
    assert.equal(analysis.status, "completed");
    assert.equal(finalSummaryCalls, 1);
    assert.equal(finalSummaryUsedSchema, true);
    assert.ok(largestSummaryInput < 30_000);
    const result = await workflows.publicAnalysisRunWithResult(analysis.id);
    assert.equal(result.finalResult.summary, "压缩后完成");
  } finally {
    global.fetch = previousFetch;
  }
});

test("keeps custom non-JSON summary format when compacting large inputs", async () => {
  const chapterCount = 90;
  for (let chapterIndex = 1; chapterIndex <= chapterCount; chapterIndex += 1) {
    await db.saveEncryptedChapter({
      bookId: "book-large-text-summary",
      chapterIndex,
      title: `第${chapterIndex}章`,
      content: `第${chapterIndex}章正文`
    });
  }

  const previousFetch = global.fetch;
  let finalSummaryCalls = 0;
  let largestSummaryInput = 0;

  global.fetch = async (url, request) => {
    if (String(url).includes("api.openai.com/v1/models")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [] })
      };
    }

    if (!String(url).includes("api.openai.com/v1/responses")) {
      throw new Error(`Unexpected fetch URL: ${url}`);
    }
    const body = JSON.parse(request.body);
    const text = body.input[0].content[0].text;
    const formatName = body.text?.format?.name || "";

    if (!formatName && text.includes("分批压缩摘要 JSON")) {
      finalSummaryCalls += 1;
      largestSummaryInput = Math.max(largestSummaryInput, text.length);
      assert.equal(Object.hasOwn(body, "text"), false);
      assert.equal(body.max_output_tokens > 0, true);
      return {
        ok: true,
        json: async () => ({
          id: "resp_large_text_final",
          output: [{ content: [{ type: "output_text", text: "## 角色定位\n- 按用户格式输出" }] }]
        })
      };
    }

    if (formatName === "final_analysis" || formatName === "summary_compression") {
      throw new Error("Custom non-JSON summary should not use final_analysis schema or model compression");
    }

    assert.equal(formatName, "chapter_result");
    const chapterIndex = Number(text.match(/章节编号：(\d+)/)?.[1]);
    return {
      ok: true,
      json: async () => ({
        id: `resp_large_text_chapter_${chapterIndex}`,
        output: [{
          content: [{
            type: "output_text",
            text: JSON.stringify({
              chapter_index: chapterIndex,
              chapter_title: `第${chapterIndex}章`,
              summary: `章节${chapterIndex}摘要${"长摘要".repeat(140)}`,
              key_points: [`关键点${chapterIndex}${"内容".repeat(120)}`],
              evidence_notes: [`证据${chapterIndex}${"线索".repeat(120)}`]
            })
          }]
        }]
      })
    };
  };

  try {
    const analysis = workflows.startAnalysisTask({
      name: "大输入文本汇总",
      book_id: "book-large-text-summary",
      start_chapter: 1,
      end_chapter: chapterCount,
      prompt: {
        summary_prompt: "请按照我指定的 Markdown 格式输出，保留标题和列表，不要输出 JSON。"
      }
    });
    await waitForTask(analysis);
    assert.equal(analysis.status, "completed");
    assert.equal(finalSummaryCalls, 1);
    assert.ok(largestSummaryInput < 30_000);
    const result = await workflows.publicAnalysisRunWithResult(analysis.id);
    assert.equal(result.finalResult, "## 角色定位\n- 按用户格式输出");
  } finally {
    global.fetch = previousFetch;
  }
});

test("keeps custom JSON prompt shape instead of forcing default final schema", async () => {
  for (let chapterIndex = 1; chapterIndex <= 3; chapterIndex += 1) {
    await db.saveEncryptedChapter({
      bookId: "book-custom-json-summary",
      chapterIndex,
      title: `第${chapterIndex}章`,
      content: `第${chapterIndex}章正文`
    });
  }

  const previousFetch = global.fetch;
  let finalSummaryCalls = 0;

  global.fetch = async (url, request) => {
    if (String(url).includes("api.openai.com/v1/models")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [] })
      };
    }

    if (!String(url).includes("api.openai.com/v1/responses")) {
      throw new Error(`Unexpected fetch URL: ${url}`);
    }
    const body = JSON.parse(request.body);
    const text = body.input[0].content[0].text;
    const formatName = body.text?.format?.name || "";

    if (formatName === "custom_final_analysis") {
      finalSummaryCalls += 1;
      assert.equal(body.max_output_tokens > 0, true);
      assert.equal(body.text.format.strict, false);
      assert.equal(body.text.format.schema.properties.roles.type, "array");
      return {
        ok: true,
        json: async () => ({
          id: "resp_custom_json_final",
          output: [{ content: [{ type: "output_text", text: JSON.stringify({ roles: [{ name: "陈平安", chapters: [1, 2, 3] }], note: "按自定义 JSON 输出" }) }] }]
        })
      };
    }

    if (formatName === "final_analysis") {
      throw new Error("Custom JSON prompt should not be forced into final_analysis schema");
    }

    if (!formatName && !text.includes("章节编号：")) {
      throw new Error("Custom JSON prompt should use schema derived from prompt template");
    }

    assert.equal(formatName, "chapter_result");
    const chapterIndex = Number(text.match(/章节编号：(\d+)/)?.[1]);
    return {
      ok: true,
      json: async () => ({
        id: `resp_custom_json_chapter_${chapterIndex}`,
        output: [{
          content: [{
            type: "output_text",
            text: JSON.stringify({
              chapter_index: chapterIndex,
              chapter_title: `第${chapterIndex}章`,
              summary: `章节${chapterIndex}摘要`,
              key_points: [],
              evidence_notes: []
            })
          }]
        }]
      })
    };
  };

  try {
    const analysis = workflows.startAnalysisTask({
      name: "自定义 JSON 汇总",
      book_id: "book-custom-json-summary",
      start_chapter: 1,
      end_chapter: 3,
      prompt: {
        summary_prompt: "请用 JSON 输出，格式为 {\"roles\":[{\"name\":\"\",\"chapters\":[]}],\"note\":\"\"}。不要套用其他字段。"
      }
    });
    await waitForTask(analysis);
    assert.equal(finalSummaryCalls, 1);
    const result = await workflows.publicAnalysisRunWithResult(analysis.id);
    assert.deepEqual(Object.keys(result.finalResult).sort(), ["note", "roles"]);
    assert.equal(result.finalResult.roles[0].name, "陈平安");
  } finally {
    global.fetch = previousFetch;
  }
});

test("derives final schema from large custom JSON prompt template", async () => {
  const chapterCount = 90;
  for (let chapterIndex = 1; chapterIndex <= chapterCount; chapterIndex += 1) {
    await db.saveEncryptedChapter({
      bookId: "book-large-custom-json-template",
      chapterIndex,
      title: `第${chapterIndex}章`,
      content: `第${chapterIndex}章正文`
    });
  }

  const previousFetch = global.fetch;
  let finalSummaryCalls = 0;
  let largestSummaryInput = 0;

  global.fetch = async (url, request) => {
    if (String(url).includes("api.openai.com/v1/models")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [] })
      };
    }

    if (!String(url).includes("api.openai.com/v1/responses")) {
      throw new Error(`Unexpected fetch URL: ${url}`);
    }
    const body = JSON.parse(request.body);
    const text = body.input[0].content[0].text;
    const formatName = body.text?.format?.name || "";

    if (formatName === "custom_final_analysis") {
      finalSummaryCalls += 1;
      largestSummaryInput = Math.max(largestSummaryInput, text.length);
      assert.equal(body.text.format.strict, false);
      assert.equal(body.text.format.schema.properties.major_characters.type, "array");
      assert.equal(body.text.format.schema.properties.tone_and_style.type, "object");
      assert.equal(body.max_output_tokens > 0, true);
      return {
        ok: true,
        json: async () => ({
          id: "resp_large_custom_template_final",
          output: [{
            content: [{
              type: "output_text",
              text: JSON.stringify({
                major_characters: [{ name: "陈平安", chapters: [1, 2, 3] }],
                world_rules: ["规矩一"],
                major_relationships: [],
                major_locations: [],
                major_forces: [],
                cultivation_system: [],
                important_items: [],
                major_events: [],
                major_foreshadowing: [],
                core_themes: [],
                visual_assets: [],
                ip_assets: [],
                tone_and_style: { overall: "克制" },
                corrected_understanding: []
              })
            }]
          }]
        })
      };
    }

    if (formatName === "final_analysis" || formatName === "summary_compression") {
      throw new Error("Large custom JSON template should use derived schema, not default schema or model compression");
    }

    assert.equal(formatName, "chapter_result");
    const chapterIndex = Number(text.match(/章节编号：(\d+)/)?.[1]);
    return {
      ok: true,
      json: async () => ({
        id: `resp_large_custom_template_chapter_${chapterIndex}`,
        output: [{
          content: [{
            type: "output_text",
            text: JSON.stringify({
              chapter_index: chapterIndex,
              chapter_title: `第${chapterIndex}章`,
              summary: `章节${chapterIndex}摘要${"长摘要".repeat(140)}`,
              key_points: [`关键点${chapterIndex}${"内容".repeat(120)}`],
              evidence_notes: [`证据${chapterIndex}${"线索".repeat(120)}`]
            })
          }]
        }]
      })
    };
  };

  try {
    const analysis = workflows.startAnalysisTask({
      name: "大输入自定义 JSON 模板",
      book_id: "book-large-custom-json-template",
      start_chapter: 1,
      end_chapter: chapterCount,
      prompt: {
        summary_prompt: [
          "请用 JSON 输出，严格使用下面模板字段。",
          "{",
          "  \"major_characters\": [],",
          "  \"world_rules\": [],",
          "  \"major_relationships\": [],",
          "  \"major_locations\": [],",
          "  \"major_forces\": [],",
          "  \"cultivation_system\": [],",
          "  \"important_items\": [],",
          "  \"major_events\": [],",
          "  \"major_foreshadowing\": [],",
          "  \"core_themes\": [],",
          "  \"visual_assets\": [],",
          "  \"ip_assets\": [],",
          "  \"tone_and_style\": {},",
          "  \"corrected_understanding\": []",
          "}"
        ].join("\n")
      }
    });
    await waitForTask(analysis);
    assert.equal(finalSummaryCalls, 1);
    assert.ok(largestSummaryInput < 30_000);
    const result = await workflows.publicAnalysisRunWithResult(analysis.id);
    assert.deepEqual(Object.keys(result.finalResult).sort(), [
      "core_themes",
      "corrected_understanding",
      "cultivation_system",
      "important_items",
      "ip_assets",
      "major_characters",
      "major_events",
      "major_forces",
      "major_foreshadowing",
      "major_locations",
      "major_relationships",
      "tone_and_style",
      "visual_assets",
      "world_rules"
    ]);
    assert.equal(result.finalResult.major_characters[0].name, "陈平安");
  } finally {
    global.fetch = previousFetch;
  }
});

test("retries transient compacted final summary failures", async () => {
  const chapterCount = 90;
  for (let chapterIndex = 1; chapterIndex <= chapterCount; chapterIndex += 1) {
    await db.saveEncryptedChapter({
      bookId: "book-large-summary-retry",
      chapterIndex,
      title: `第${chapterIndex}章`,
      content: `第${chapterIndex}章正文`
    });
  }

  const previousFetch = global.fetch;
  let finalSummaryCalls = 0;

  global.fetch = async (url, request) => {
    if (String(url).includes("api.openai.com/v1/models")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [] })
      };
    }

    if (!String(url).includes("api.openai.com/v1/responses")) {
      throw new Error(`Unexpected fetch URL: ${url}`);
    }
    const body = JSON.parse(request.body);
    const text = body.input[0].content[0].text;
    const formatName = body.text?.format?.name || "";

    if (formatName === "summary_compression") {
      throw new Error("Large summary should use local compaction instead of OpenAI compression");
    }

    if (formatName === "final_analysis") {
      finalSummaryCalls += 1;
      assert.equal(body.max_output_tokens > 0, true);
      if (finalSummaryCalls === 1) {
        throw new Error("This operation was aborted");
      }
      return {
        ok: true,
        json: async () => ({
          id: "resp_large_retry_final",
          output: [{ content: [{ type: "output_text", text: JSON.stringify({ title: "大汇总", summary: "重试后完成", items: [], failed_chapters: [] }) }] }]
        })
      };
    }

    if (!formatName) {
      throw new Error("JSON summary tasks should use final_analysis schema");
    }

    assert.equal(formatName, "chapter_result");
    const chapterIndex = Number(text.match(/章节编号：(\d+)/)?.[1]);
    return {
      ok: true,
      json: async () => ({
        id: `resp_large_retry_chapter_${chapterIndex}`,
        output: [{
          content: [{
            type: "output_text",
            text: JSON.stringify({
              chapter_index: chapterIndex,
              chapter_title: `第${chapterIndex}章`,
              summary: `章节${chapterIndex}摘要${"长摘要".repeat(140)}`,
              key_points: [`关键点${chapterIndex}${"内容".repeat(120)}`],
              evidence_notes: [`证据${chapterIndex}${"线索".repeat(120)}`]
            })
          }]
        }]
      })
    };
  };

  try {
    const analysis = workflows.startAnalysisTask({
      name: "大输入汇总重试",
      book_id: "book-large-summary-retry",
      start_chapter: 1,
      end_chapter: chapterCount
    });
    await waitForTask(analysis);
    assert.equal(analysis.status, "completed");
    assert.equal(finalSummaryCalls, 2);
    const result = await workflows.publicAnalysisRunWithResult(analysis.id);
    assert.equal(result.finalResult.summary, "重试后完成");
  } finally {
    global.fetch = previousFetch;
  }
});

test("rejects placeholder final summary and keeps run resumable", async () => {
  for (let chapterIndex = 1; chapterIndex <= 3; chapterIndex += 1) {
    await db.saveEncryptedChapter({
      bookId: "book-placeholder-summary",
      chapterIndex,
      title: `第${chapterIndex}章`,
      content: `第${chapterIndex}章正文`
    });
  }

  const previousFetch = global.fetch;
  let finalSummaryCalls = 0;

  global.fetch = async (url, request) => {
    if (String(url).includes("api.openai.com/v1/models")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [] })
      };
    }

    if (!String(url).includes("api.openai.com/v1/responses")) {
      throw new Error(`Unexpected fetch URL: ${url}`);
    }
    const body = JSON.parse(request.body);
    const text = body.input[0].content[0].text;
    const formatName = body.text?.format?.name || "";

    if (formatName === "final_analysis") {
      finalSummaryCalls += 1;
      return {
        ok: true,
        json: async () => ({
          id: "resp_placeholder_summary",
          output: [{ content: [{ type: "output_text", text: JSON.stringify({ title: "N/A", summary: "N/A", items: [], failed_chapters: [] }) }] }]
        })
      };
    }

    assert.equal(formatName, "chapter_result");
    const chapterIndex = Number(text.match(/章节编号：(\d+)/)?.[1]);
    return {
      ok: true,
      json: async () => ({
        id: `resp_placeholder_chapter_${chapterIndex}`,
        output: [{
          content: [{
            type: "output_text",
            text: JSON.stringify({
              chapter_index: chapterIndex,
              chapter_title: `第${chapterIndex}章`,
              summary: `章节${chapterIndex}摘要`,
              key_points: [],
              evidence_notes: []
            })
          }]
        }]
      })
    };
  };

  try {
    const analysis = workflows.startAnalysisTask({
      name: "占位汇总",
      book_id: "book-placeholder-summary",
      start_chapter: 1,
      end_chapter: 3
    });
    await assert.rejects(() => waitForTask(analysis), /最终汇总结果疑似占位或为空/);
    assert.equal(analysis.status, "failed");
    assert.equal(finalSummaryCalls, 3);
    const result = await workflows.publicAnalysisRunWithResult(analysis.id);
    assert.equal(result.finalResult, null);
    assert.equal(result.chapterResults.length, 3);
    assert.equal(result.canResume, true);
  } finally {
    global.fetch = previousFetch;
  }
});

async function waitForTask(task) {
  const started = Date.now();
  while (!["completed", "failed", "cancelled"].includes(task.status)) {
    if (Date.now() - started > 10000) {
      throw new Error(`Task timeout: ${task.id}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (task.status === "failed") {
    throw new Error(task.error || "task failed");
  }
  return task;
}
