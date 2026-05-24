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
process.env.OPENAI_MAX_RETRIES = "0";

const db = await import("../server/db.js");
const dify = await import("../server/dify.js");
const appConfig = await import("../server/config.js");
const openai = await import("../server/openai.js");
const promptGuides = await import("../server/promptGuides.js");
const schemaTools = await import("../src/schemaTools.js");
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

test("stores summary parts encrypted and exposes resumable metadata", async () => {
  const secretPart = { value: "汇总分块密文内容" };
  await db.ensureBook("summary-part-book", "分块测试书");
  await db.createAnalysisRun({
    id: "analysis-summary-part-secure",
    name: "分块测试",
    bookId: "summary-part-book",
    startChapter: 1,
    endChapter: 1,
    chapterSelection: { mode: "range", chapter_indexes: [1] },
    model: "gpt-5.5",
    reasoningEffort: "medium",
    promptHash: "prompt-hash",
    schemaHash: "schema-hash",
    chapterCount: 1,
    promptSnapshot: db.normalizePromptSettings({})
  });

  await db.saveAnalysisSummaryPart({
    analysisId: "analysis-summary-part-secure",
    partKey: "json.field.batch.001",
    parentKey: "json.field.merge",
    stage: "json_field_batch",
    status: "completed",
    contentHash: "content-hash",
    promptHash: "prompt-hash",
    schemaHash: "schema-hash",
    model: "gpt-5.5",
    reasoningEffort: "low",
    inputSummary: "测试分块",
    result: secretPart
  });

  const meta = db.getAnalysisSummaryPartMetadata("analysis-summary-part-secure", "json.field.batch.001");
  assert.equal(meta.status, "completed");
  assert.equal(meta.has_result, true);
  assert.equal(meta.input_summary, "测试分块");
  assert.deepEqual(await db.decryptAnalysisSummaryPartResult("analysis-summary-part-secure", "json.field.batch.001"), secretPart);
  const dbBytes = await fs.readFile(db.getDbPath());
  assert.equal(dbBytes.includes(Buffer.from(secretPart.value)), false);
});

test("analysis summary parts expose source trace metadata without raw evidence text", async () => {
  await db.saveAnalysisSummaryPart({
    analysisId: "analysis-summary-part-secure",
    partKey: "json.trace.batch.001",
    parentKey: "json.trace.merge",
    stage: "json_field_batch",
    status: "completed",
    contentHash: "trace-content-hash",
    promptHash: "prompt-hash",
    schemaHash: "schema-hash",
    model: "gpt-5.5",
    reasoningEffort: "low",
    inputSummary: "追踪分块",
    traceSummary: {
      field_name: "characters",
      evidence_packet_count: 2,
      source_types: { l2_fact: 1, source_review: 1 },
      chapters: { count: 2, min: 1, max: 8, sample: [1, 8] },
      categories: { character: 2 },
      subjects: ["云筝"]
    },
    result: { characters: [{ name: "云筝" }] }
  });

  const meta = db.getAnalysisSummaryPartMetadata("analysis-summary-part-secure", "json.trace.batch.001");
  assert.equal(meta.trace_summary.evidence_packet_count, 2);
  assert.deepEqual(meta.trace_summary.source_types, { l2_fact: 1, source_review: 1 });
  assert.equal(JSON.stringify(meta.trace_summary).includes("characters"), true);
  assert.equal(JSON.stringify(meta.trace_summary).includes("云筝"), true);
});

test("database diagnostics expose metadata without plaintext chapter content", async () => {
  const secretText = "诊断接口不应泄露的章节正文";
  await db.saveEncryptedChapter({
    bookId: "diagnostic-book",
    chapterIndex: 1,
    title: "诊断章节",
    content: secretText
  });
  const chapter = db.getChapterMetadata("diagnostic-book", 1);
  db.saveL1ChapterIndex({
    bookId: "diagnostic-book",
    chapterIndex: 1,
    status: "completed",
    sourceHmac: chapter.content_hmac,
    model: "gpt-5.5",
    promptHash: "l1-v1-chapter-window-10",
    value: {
      summary: "不应出现在诊断中的 L1 摘要",
      keywords: ["秘密关键词"],
      entities: ["秘密人物"],
      key_events: [],
      items_places_orgs: [],
      open_questions: [],
      confidence: 0.9
    }
  });
  await db.saveL2ChapterFacts({
    bookId: "diagnostic-book",
    chapterIndex: 1,
    status: "completed",
    sourceHmac: chapter.content_hmac,
    model: "gpt-5.5",
    promptHash: "l2-v1-typed-facts",
    schemaVersion: "l2-facts-v1",
    facts: [{
      category: "character",
      entity: "公开主体",
      fact: "不应出现在诊断中的 L2 事实正文",
      evidence: ["不应出现在诊断中的证据摘记"],
      importance: 0.8,
      confidence: 0.8
    }]
  });

  const diagnostics = db.getDatabaseDiagnostics();
  const serialized = JSON.stringify(diagnostics);
  assert.equal(diagnostics.totals.books >= 1, true);
  assert.equal(diagnostics.totals.chapters >= 1, true);
  assert.equal(serialized.includes("diagnostic-book"), true);
  assert.equal(serialized.includes(secretText), false);
  assert.equal(serialized.includes("不应出现在诊断中的 L1 摘要"), false);
  assert.equal(serialized.includes("不应出现在诊断中的 L2 事实正文"), false);
  assert.equal(serialized.includes("不应出现在诊断中的证据摘记"), false);
});

test("binds one book name to each novel id", () => {
  const first = db.ensureBook("named-book", "第一本书");
  assert.equal(first.book_name, "第一本书");
  assert.equal(db.getBookIndexPrompts("named-book").book_id, "named-book");

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

test("OpenAI JSON caller repairs truncated JSON once with store false", async () => {
  const previousFetch = global.fetch;
  const capturedBodies = [];
  global.fetch = async (_url, request) => {
    const body = JSON.parse(request.body);
    capturedBodies.push(body);
    if (capturedBodies.length === 1) {
      return {
        ok: true,
        json: async () => ({
          id: "resp_broken_json",
          output: [{ content: [{ type: "output_text", text: "{\"chapter_index\":1,\"chapter_title\":\"第一章\",\"summary\":\"半截\"" }] }]
        })
      };
    }
    return {
      ok: true,
      json: async () => ({
        id: "resp_repaired_json",
        output: [{ content: [{ type: "output_text", text: JSON.stringify({
          chapter_index: 1,
          chapter_title: "第一章",
          summary: "修复完成",
          key_points: [],
          evidence_notes: []
        }) }] }]
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
    assert.equal(result.value.summary, "修复完成");
    assert.equal(result.responseId, "resp_broken_json,resp_repaired_json");
    assert.equal(capturedBodies.length, 2);
    assert.equal(capturedBodies[0].store, false);
    assert.equal(capturedBodies[1].store, false);
    assert.equal(Object.hasOwn(capturedBodies[1], "background"), false);
    assert.equal(capturedBodies[1].reasoning.effort, "low");
    assert.equal(capturedBodies[1].text.format.name, "chapter_result_repair");
    assert.equal(JSON.stringify(capturedBodies[1].input).includes("破损 JSON 文本"), true);
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

test("OpenAI caller retries transient network failures when configured", async () => {
  const previousFetch = global.fetch;
  const previousMaxRetries = appConfig.config.openai.maxRetries;
  appConfig.config.openai.maxRetries = 2;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls < 2) {
      throw new Error("Client network socket disconnected before secure TLS connection was established");
    }
    return {
      ok: true,
      json: async () => ({
        id: "resp_retry_ok",
        output: [{ content: [{ type: "output_text", text: "ok" }] }]
      })
    };
  };

  try {
    const result = await openai.callOpenAIText({
      model: "gpt-5.5",
      reasoningEffort: "low",
      instructions: "test",
      input: [{ role: "user", content: [{ type: "input_text", text: "test" }] }],
      maxOutputTokens: 10
    });
    assert.equal(result.value, "ok");
    assert.equal(calls, 2);
  } finally {
    appConfig.config.openai.maxRetries = previousMaxRetries;
    global.fetch = previousFetch;
  }
});

test("prompt guide generation exposes templates and keeps OpenAI request ZDR-shaped", async () => {
  db.ensureBook("guide-book", "引导测试书");
  const templates = promptGuides.getPromptGuideTemplates();
  assert.equal(templates.l1.scope, "书籍级索引 Prompt");
  assert.equal(templates.l2.steps.length >= 3, true);
  assert.equal(templates.analysis.scope, "书籍级分析 Prompt");
  assert.equal(templates.analysis.steps.map((step) => step.title).join(","), "用途,输出");
  assert.equal(templates.analysisOptimization.label, "分析 Prompt 优化");
  assert.equal(templates.analysisOptimization.steps.length, 1);
  assert.equal(templates.analysisOptimization.builtInPrompt.includes("优化一条已经存在"), true);
  for (const template of Object.values(templates)) {
    for (const step of template.steps) {
      assert.equal(step.placeholder.includes("例如"), false);
      assert.equal(step.placeholder.includes("："), false);
      assert.equal(step.placeholder.length > 12, true);
    }
  }

  const previousFetch = global.fetch;
  let capturedBody;
  global.fetch = async (url, request) => {
    if (!String(url).includes("api.openai.com/v1/responses")) {
      throw new Error(`Unexpected fetch URL: ${url}`);
    }
    capturedBody = JSON.parse(request.body);
    return {
      ok: true,
      json: async () => ({
        id: "resp_prompt_guide",
        output: [{
          content: [{
            type: "output_text",
            text: JSON.stringify({
              title_suggestion: "人物关系分析",
              prompt_suggestion: "请基于 L2 事实分析人物关系。",
              rationale: "围绕用户目标生成。",
              usage_notes: ["套用后手动保存。"],
              quality_checklist: ["目标清晰。"]
            })
          }]
        }]
      })
    };
  };

  try {
    const result = await promptGuides.generatePromptGuideSuggestion({
      type: "analysis",
      book_id: "guide-book",
      answers: [{ id: "use_case", answer: "分析人物关系" }]
    });
    assert.equal(result.suggestion.title_suggestion, "人物关系分析");
    assert.equal(result.suggestion.prompt_suggestion, "请基于 L2 事实分析人物关系。");
    assert.equal(capturedBody.store, false);
    assert.equal(Object.hasOwn(capturedBody, "background"), false);
    assert.equal(capturedBody.text.format.name, "prompt_guide_result");
    assert.equal(JSON.stringify(capturedBody.input).includes("引导测试书"), true);
  } finally {
    global.fetch = previousFetch;
  }
});

test("analysis prompt optimization keeps OpenAI request ZDR-shaped and includes current prompt", async () => {
  db.ensureBook("guide-opt-book", "优化测试书");
  const previousFetch = global.fetch;
  let capturedBody;
  global.fetch = async (url, request) => {
    if (!String(url).includes("api.openai.com/v1/responses")) {
      throw new Error(`Unexpected fetch URL: ${url}`);
    }
    capturedBody = JSON.parse(request.body);
    return {
      ok: true,
      json: async () => ({
        id: "resp_prompt_optimize",
        output: [{
          content: [{
            type: "output_text",
            text: JSON.stringify({
              title_suggestion: "轻量人物形象分析",
              prompt_suggestion: "只输出角色、身份和形象描述。",
              rationale: "按优化诉求收窄字段。",
              usage_notes: ["套用后保存。"],
              quality_checklist: ["字段足够轻。"]
            })
          }]
        }]
      })
    };
  };

  try {
    const result = await promptGuides.optimizeAnalysisPromptSuggestion({
      book_id: "guide-opt-book",
      current_prompt: "当前 Prompt：输出角色关系和证据。",
      optimization_request: "删掉关系和证据，只保留形象字段。"
    });
    assert.equal(result.suggestion.title_suggestion, "轻量人物形象分析");
    assert.equal(result.suggestion.prompt_suggestion, "只输出角色、身份和形象描述。");
    assert.equal(capturedBody.store, false);
    assert.equal(Object.hasOwn(capturedBody, "background"), false);
    assert.equal(capturedBody.text.format.name, "prompt_optimization_result");
    const inputText = JSON.stringify(capturedBody.input);
    assert.equal(inputText.includes("优化测试书"), true);
    assert.equal(inputText.includes("当前 Prompt：输出角色关系和证据。"), true);
    assert.equal(inputText.includes("删掉关系和证据，只保留形象字段。"), true);
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

test("infers result tables from default and custom JSON result shapes", () => {
  const defaultTables = schemaTools.tableViewsFromJson({
    title: "人物汇总",
    summary: "摘要",
    items: [
      { name: "陈平安", chapters: [1, 2], confidence: 0.9 },
      { name: "齐静春", chapters: [3], note: "先生" }
    ],
    failed_chapters: []
  });
  assert.equal(defaultTables[0].key, "items");
  assert.deepEqual(defaultTables[0].columns.map((column) => column.key), ["name", "chapters", "confidence", "note"]);
  assert.equal(defaultTables[0].rows.length, 2);

  const customTables = schemaTools.tableViewsFromJson({
    roles: [{ name: "陈平安", identity: "少年" }],
    world_rules: ["规矩一", "规矩二"],
    note: "按自定义 JSON 输出"
  });
  assert.equal(customTables.length, 2);
  assert.equal(customTables.some((table) => table.key === "roles" && table.columns.some((column) => column.key === "identity")), true);
  assert.equal(customTables.some((table) => table.key === "world_rules" && table.columns[0].key === "value"), true);

  const stringTables = schemaTools.tableViewsFromJson(JSON.stringify([{ name: "宁姚", chapters: [10] }]));
  assert.equal(stringTables[0].rows[0].name, "宁姚");
  assert.deepEqual(schemaTools.tableViewsFromJson("纯文本结果"), []);
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

test("stores L2 facts with encrypted fact content and reports coverage", async () => {
  await db.saveEncryptedChapter({
    bookId: "book-l2-storage",
    chapterIndex: 1,
    title: "第一章",
    content: "陈平安得到木剑。"
  });
  const chapter = db.getChapterMetadata("book-l2-storage", 1);
  await db.saveL2ChapterFacts({
    bookId: "book-l2-storage",
    chapterIndex: 1,
    status: "completed",
    sourceHmac: chapter.content_hmac,
    model: "gpt-5.5",
    promptHash: "l2-v1-typed-facts",
    schemaVersion: "l2-facts-v1",
    facts: [{
      category: "character",
      entity: "陈平安",
      aliases: ["少年"],
      tags: ["木剑"],
      related_entities: ["木剑"],
      fact_type: "item_gain",
      fact: "陈平安得到木剑。",
      evidence: ["得到木剑"],
      importance: 0.8,
      confidence: 0.9
    }]
  });

  const facts = await db.listL2Facts({
    bookId: "book-l2-storage",
    startChapter: 1,
    endChapter: 1,
    categories: ["character"],
    entity: "陈平安"
  });
  assert.equal(facts.length, 1);
  assert.equal(facts[0].fact, "陈平安得到木剑。");
  assert.equal(facts[0].entity, "陈平安");
  const coverage = db.getL2Coverage({
    bookId: "book-l2-storage",
    startChapter: 1,
    endChapter: 1,
    model: "gpt-5.5",
    promptHash: "l2-v1-typed-facts",
    schemaVersion: "l2-facts-v1"
  });
  assert.equal(coverage.chapters.completed, 1);
  assert.equal(coverage.chapters.facts, 1);
  const dbBytes = await fs.readFile(db.getDbPath());
  assert.equal(dbBytes.includes(Buffer.from("陈平安得到木剑。")), false);
});

test("builds L2 indexes, skips fresh facts, and keeps requests ZDR-shaped", async () => {
  await db.saveEncryptedChapter({
    bookId: "book-l2-task",
    chapterIndex: 1,
    title: "第一章",
    content: "陈平安得到木剑。"
  });

  const previousFetch = global.fetch;
  let responseCalls = 0;
  const capturedBodies = [];
  global.fetch = async (url, request) => {
    if (String(url).includes("api.openai.com/v1/models")) {
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    if (!String(url).includes("api.openai.com/v1/responses")) {
      throw new Error(`Unexpected fetch URL: ${url}`);
    }
    responseCalls += 1;
    const body = JSON.parse(request.body);
    capturedBodies.push(body);
    return {
      ok: true,
      json: async () => ({
        id: `resp_l2_${responseCalls}`,
        output: [{ content: [{ type: "output_text", text: JSON.stringify({ facts: [{
          category: "character",
          entity: "陈平安",
          aliases: [],
          tags: ["木剑"],
          related_entities: ["木剑"],
          fact_type: "item_gain",
          fact: "陈平安得到木剑。",
          evidence: ["木剑"],
          importance: 0.8,
          confidence: 0.9
        }] }) }] }]
      })
    };
  };

  try {
    const task = workflows.startL2IndexTask({
      book_id: "book-l2-task",
      start_chapter: 1,
      end_chapter: 1
    });
    await waitForTask(task);
    assert.equal(task.status, "completed");
    assert.equal(responseCalls, 1);
    assert.equal(capturedBodies[0].store, false);
    assert.equal(Object.hasOwn(capturedBodies[0], "background"), false);
    assert.equal(capturedBodies[0].text.format.name, "l2_chapter_facts");

    const skipped = workflows.startL2IndexTask({
      book_id: "book-l2-task",
      start_chapter: 1,
      end_chapter: 1
    });
    await waitForTask(skipped);
    assert.equal(skipped.progress.skipped, 1);
    assert.equal(responseCalls, 1);
  } finally {
    global.fetch = previousFetch;
  }
});

test("L2 targeted modes ignore force and do not rebuild the whole range", async () => {
  for (const chapterIndex of [1, 2, 3]) {
    await db.saveEncryptedChapter({
      bookId: "book-l2-targeted-mode",
      chapterIndex,
      title: `第${chapterIndex}章`,
      content: `第${chapterIndex}章正文`
    });
  }
  const completedChapter = db.getChapterMetadata("book-l2-targeted-mode", 1);
  const failedChapter = db.getChapterMetadata("book-l2-targeted-mode", 2);
  await db.saveL2ChapterFacts({
    bookId: "book-l2-targeted-mode",
    chapterIndex: 1,
    status: "completed",
    sourceHmac: completedChapter.content_hmac,
    model: "gpt-5.5",
    promptHash: "l2-v1-typed-facts",
    schemaVersion: "l2-facts-v1",
    facts: [{
      category: "event",
      entity: "第一章",
      fact_type: "existing",
      fact: "第一章已有索引。",
      evidence: ["第一章"],
      importance: 0.8,
      confidence: 0.9
    }]
  });
  db.saveL2ChapterStatus({
    bookId: "book-l2-targeted-mode",
    chapterIndex: 2,
    status: "failed",
    sourceHmac: failedChapter.content_hmac,
    model: "gpt-5.5",
    promptHash: "l2-v1-typed-facts",
    schemaVersion: "l2-facts-v1",
    errorSummary: "previous failure"
  });

  const previousFetch = global.fetch;
  let responseCalls = 0;
  global.fetch = async (url, request) => {
    if (String(url).includes("api.openai.com/v1/models")) {
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    if (!String(url).includes("api.openai.com/v1/responses")) {
      throw new Error(`Unexpected fetch URL: ${url}`);
    }
    responseCalls += 1;
    const body = JSON.parse(request.body);
    const input = JSON.stringify(body.input);
    const chapterMatch = input.match(/章节\s*(\d+)/);
    const chapterIndex = Number(chapterMatch?.[1] || responseCalls);
    return {
      ok: true,
      json: async () => ({
        id: `resp_l2_targeted_${responseCalls}`,
        output: [{ content: [{ type: "output_text", text: JSON.stringify({ facts: [{
          category: "event",
          entity: `第${chapterIndex}章`,
          aliases: [],
          tags: [],
          related_entities: [],
          fact_type: "rebuilt",
          fact: `第${chapterIndex}章被处理。`,
          evidence: [`第${chapterIndex}章`],
          importance: 0.8,
          confidence: 0.9
        }] }) }] }]
      })
    };
  };

  try {
    const retryTask = workflows.startL2IndexTask({
      book_id: "book-l2-targeted-mode",
      start_chapter: 1,
      end_chapter: 3,
      force: true,
      mode: "retry_failed"
    });
    await waitForTask(retryTask);
    assert.equal(retryTask.progress.completed, 1);
    assert.equal(retryTask.progress.skipped, 2);
    assert.equal(responseCalls, 1);
    assert.equal(db.getL2ChapterStatus("book-l2-targeted-mode", 2).status, "completed");
    assert.equal(db.getL2ChapterStatus("book-l2-targeted-mode", 3), null);

    const missingTask = workflows.startL2IndexTask({
      book_id: "book-l2-targeted-mode",
      start_chapter: 1,
      end_chapter: 3,
      force: true,
      mode: "missing"
    });
    await waitForTask(missingTask);
    assert.equal(missingTask.progress.completed, 1);
    assert.equal(missingTask.progress.skipped, 2);
    assert.equal(responseCalls, 2);
    assert.equal(db.getL2ChapterStatus("book-l2-targeted-mode", 3).status, "completed");
  } finally {
    global.fetch = previousFetch;
  }
});

test("book index prompts are saved, used by L1/L2 tasks, and change freshness hash", async () => {
  const customL1 = "自定义 L1 Prompt：只提炼人物与事件。";
  const customL2 = "自定义 L2 Prompt：只提炼可检索事实。";
  await db.saveEncryptedChapter({
    bookId: "book-index-prompt",
    chapterIndex: 1,
    title: "第一章",
    content: "陈平安得到木剑。"
  });

  const saved = db.updateBookIndexPrompts("book-index-prompt", {
    l1_index_prompt: customL1,
    l2_index_prompt: customL2
  });
  assert.equal(saved.l1_index_prompt, customL1);
  assert.equal(saved.l2_index_prompt, customL2);
  assert.notEqual(saved.l1_index_prompt_hash, "l1-v1-chapter-window-10");
  assert.notEqual(saved.l2_index_prompt_hash, "l2-v1-typed-facts");

  const previousFetch = global.fetch;
  const capturedBodies = [];
  global.fetch = async (url, request) => {
    if (String(url).includes("api.openai.com/v1/models")) {
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    if (!String(url).includes("api.openai.com/v1/responses")) {
      throw new Error(`Unexpected fetch URL: ${url}`);
    }
    const body = JSON.parse(request.body);
    capturedBodies.push(body);
    const formatName = body.text?.format?.name;
    const outputValue = formatName === "l1_chapter_index"
      ? {
        summary: "章节摘要",
        keywords: [],
        entities: [],
        key_events: [],
        items_places_orgs: [],
        open_questions: [],
        confidence: 0.8
      }
      : {
        facts: [{
          category: "item",
          entity: "木剑",
          aliases: [],
          tags: [],
          related_entities: ["陈平安"],
          fact_type: "item_gain",
          fact: "陈平安得到木剑。",
          evidence: ["木剑"],
          importance: 0.8,
          confidence: 0.9
        }]
      };
    return {
      ok: true,
      json: async () => ({
        id: `resp_index_prompt_${capturedBodies.length}`,
        output: [{ content: [{ type: "output_text", text: JSON.stringify(outputValue) }] }]
      })
    };
  };

  try {
    const l1Task = workflows.startL1IndexTask({
      book_id: "book-index-prompt",
      start_chapter: 1,
      end_chapter: 1
    });
    await waitForTask(l1Task);
    assert.equal(l1Task.status, "completed");
    assert.equal(db.getL1ChapterIndex("book-index-prompt", 1).prompt_hash, saved.l1_index_prompt_hash);
    assert.equal(JSON.stringify(capturedBodies[0].input).includes(customL1), true);

    const l2Task = workflows.startL2IndexTask({
      book_id: "book-index-prompt",
      start_chapter: 1,
      end_chapter: 1
    });
    await waitForTask(l2Task);
    assert.equal(l2Task.status, "completed");
    assert.equal(db.getL2ChapterStatus("book-index-prompt", 1).prompt_hash, saved.l2_index_prompt_hash);
    assert.equal(JSON.stringify(capturedBodies[1].input).includes(customL2), true);

    const skippedL2 = workflows.startL2IndexTask({
      book_id: "book-index-prompt",
      start_chapter: 1,
      end_chapter: 1
    });
    await waitForTask(skippedL2);
    assert.equal(skippedL2.progress.skipped, 1);
    assert.equal(capturedBodies.length, 2);
  } finally {
    global.fetch = previousFetch;
  }
});

test("creates, edits, lists, and deletes prompt groups with categories", () => {
  db.ensureBook("prompt-book", "测试书籍");
  db.ensureBook("other-prompt-book", "另一书籍");
  const created = db.createPromptGroup({
    book_id: "prompt-book",
    name: "角色定位 Prompt",
    category: "测试书籍",
    chapter_prompt: "逐章提取角色身份",
    summary_prompt: "汇总角色身份"
  });

  assert.equal(created.name, "角色定位 Prompt");
  assert.equal(created.book_id, "prompt-book");
  assert.equal(created.category, "测试书籍");
  assert.equal(db.listPromptGroups({ bookId: "prompt-book" }).some((group) => group.id === created.id), true);
  assert.equal(db.listPromptGroups({ bookId: "other-prompt-book" }).some((group) => group.id === created.id), false);

  const updated = db.updatePromptGroup(created.id, {
    name: "角色定位 Prompt v2",
    book_id: "prompt-book",
    category: "测试书籍",
    summary_prompt: "重新汇总角色身份"
  });
  assert.equal(updated.name, "角色定位 Prompt v2");
  assert.equal(updated.book_id, "prompt-book");
  assert.equal(updated.category, "测试书籍");
  assert.equal(updated.chapter_prompt, "逐章提取角色身份");
  assert.equal(updated.summary_prompt, "重新汇总角色身份");

  assert.equal(db.deletePromptGroup(created.id).deleted, true);
  assert.equal(db.getPromptGroup(created.id), undefined);
});

test("analysis prompt groups can save summary prompt without chapter prompt", () => {
  db.ensureBook("analysis-prompt-book", "分析书籍");
  const created = db.createPromptGroup({
    book_id: "analysis-prompt-book",
    name: "势力关系分析",
    category: "分析书籍",
    summary_prompt: "只分析宗门势力关系"
  });

  assert.equal(created.name, "势力关系分析");
  assert.equal(created.book_id, "analysis-prompt-book");
  assert.equal(created.summary_prompt, "只分析宗门势力关系");
  assert.equal(created.chapter_prompt, "");

  const updated = db.updatePromptGroup(created.id, {
    summary_prompt: "改为分析人物关系"
  });
  assert.equal(updated.summary_prompt, "改为分析人物关系");
  assert.equal(updated.chapter_prompt, "");

  assert.equal(db.deletePromptGroup(created.id).deleted, true);
});

test("imports once, skips stored chapters, and analyzes from encrypted local store", async () => {
  const previousFetch = global.fetch;
  let difyCalls = 0;
  let openaiCalls = 0;

  global.fetch = async (url, request) => {
    if (String(url).includes("/parameters")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ user_input_form: [] })
      };
    }

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
      analysis_mode: "full_text",
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

test("import preflights Dify token before running chapter batches", async () => {
  const previousFetch = global.fetch;
  let workflowCalls = 0;

  global.fetch = async (url) => {
    if (String(url).includes("/parameters")) {
      return {
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ code: "unauthorized", message: "Access token is invalid" })
      };
    }
    if (String(url).includes("/workflows/run")) {
      workflowCalls += 1;
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  try {
    const task = workflows.startImportTask({
      book_id: "book-dify-token",
      start_chapter: 1,
      end_chapter: 3
    });
    await waitForTerminalTask(task);
    assert.equal(task.status, "failed");
    assert.equal(workflowCalls, 0);
    assert.match(task.error, /Dify .*鉴权失败/);
    assert.match(task.error, /DIFY_CHAPTER_WORKFLOW_API_KEY/);
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
      analysis_mode: "full_text",
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
      analysis_mode: "full_text",
      book_id: "book-l1-analysis",
      start_chapter: 1,
      end_chapter: 1
    });
    await waitForTask(withoutL1);
    assert.equal(chapterPrompts[0].includes("可选 L1 章节上下文 JSON"), false);
    assert.equal(summaryPrompts[0].includes("可选 L1 窗口上下文 JSON"), false);

    const withL1 = workflows.startAnalysisTask({
      analysis_mode: "full_text",
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

test("fast index analysis uses L2 facts without decrypting chapter text", async () => {
  await db.saveEncryptedChapter({
    bookId: "book-fast-index",
    chapterIndex: 1,
    title: "第一章",
    content: "如果读取原文测试应失败"
  });
  const chapter = db.getChapterMetadata("book-fast-index", 1);
  await db.saveL2ChapterFacts({
    bookId: "book-fast-index",
    chapterIndex: 1,
    status: "completed",
    sourceHmac: chapter.content_hmac,
    model: "gpt-5.5",
    promptHash: "l2-v1-typed-facts",
    schemaVersion: "l2-facts-v1",
    facts: [{
      category: "character",
      entity: "陈平安",
      fact_type: "identity",
      fact: "陈平安是关键人物。",
      evidence: ["关键人物"],
      importance: 0.8,
      confidence: 0.9
    }]
  });

  const previousFetch = global.fetch;
  let summaryCalls = 0;
  global.fetch = async (url, request) => {
    if (String(url).includes("api.openai.com/v1/models")) {
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    const body = JSON.parse(request.body);
    const text = body.input[0].content[0].text;
    assert.equal(text.includes("章节原文："), false);
    assert.equal(text.includes("如果读取原文测试应失败"), false);
    summaryCalls += 1;
    return {
      ok: true,
      json: async () => ({
        id: "resp_fast_index",
        output: [{ content: [{ type: "output_text", text: JSON.stringify({ title: "索引汇总", summary: "完成", items: [], failed_chapters: [] }) }] }]
      })
    };
  };

  try {
    const analysis = workflows.startAnalysisTask({
      analysis_mode: "fast_index",
      book_id: "book-fast-index",
      start_chapter: 1,
      end_chapter: 1
    });
    await waitForTask(analysis);
    assert.equal(summaryCalls, 1);
    const result = await workflows.publicAnalysisRunWithResult(analysis.id);
    assert.equal(result.finalResult.summary, "完成");
    assert.equal(result.finalResult.source_stats, undefined);
    assert.equal(result.source_stats.source_review_chapters, 0);
  } finally {
    global.fetch = previousFetch;
  }
});

test("balanced index analysis reviews only budgeted high-risk chapters", async () => {
  for (const chapterIndex of [1, 2, 3]) {
    await db.saveEncryptedChapter({
      bookId: "book-balanced-index",
      chapterIndex,
      title: `第${chapterIndex}章`,
      content: `第${chapterIndex}章原文`
    });
    const chapter = db.getChapterMetadata("book-balanced-index", chapterIndex);
    await db.saveL2ChapterFacts({
      bookId: "book-balanced-index",
      chapterIndex,
      status: "completed",
      sourceHmac: chapter.content_hmac,
      model: "gpt-5.5",
      promptHash: "l2-v1-typed-facts",
      schemaVersion: "l2-facts-v1",
      facts: [{
        category: "character",
        entity: "陈平安",
        fact_type: "risk",
        fact: `第${chapterIndex}章事实`,
        evidence: [`证据${chapterIndex}`],
        importance: chapterIndex === 2 ? 0.95 : 0.4,
        confidence: chapterIndex === 2 ? 0.2 : 0.9
      }]
    });
  }

  const previousFetch = global.fetch;
  const reviewedInputs = [];
  global.fetch = async (url, request) => {
    if (String(url).includes("api.openai.com/v1/models")) {
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    const body = JSON.parse(request.body);
    const formatName = body.text?.format?.name || "";
    const text = body.input[0].content[0].text;
    if (formatName === "l2_source_review") {
      reviewedInputs.push(text);
      return {
        ok: true,
        json: async () => ({
          id: "resp_review",
          output: [{ content: [{ type: "output_text", text: JSON.stringify({ facts: [{
            category: "character",
            entity: "陈平安",
            aliases: [],
            tags: [],
            related_entities: [],
            fact_type: "review",
            fact: "复核事实",
            evidence: ["复核"],
            importance: 0.9,
            confidence: 0.9
          }] }) }] }]
        })
      };
    }
    return {
      ok: true,
      json: async () => ({
        id: "resp_balanced_summary",
        output: [{ content: [{ type: "output_text", text: JSON.stringify({ title: "平衡汇总", summary: "完成", items: [], failed_chapters: [] }) }] }]
      })
    };
  };

  try {
    const analysis = workflows.startAnalysisTask({
      analysis_mode: "balanced",
      source_review_budget: 1,
      book_id: "book-balanced-index",
      start_chapter: 1,
      end_chapter: 3
    });
    await waitForTask(analysis);
    assert.equal(reviewedInputs.length, 1);
    assert.equal(reviewedInputs[0].includes("第2章原文"), true);
    assert.equal(reviewedInputs[0].includes("第1章原文"), false);
    const result = await workflows.publicAnalysisRunWithResult(analysis.id);
    assert.equal(result.finalResult.source_stats, undefined);
    assert.equal(result.source_stats.source_review_chapters, 1);
    assert.equal(result.source_stats.source_review_budget, 1);
  } finally {
    global.fetch = previousFetch;
  }
});

test("balanced index analysis recalls multiple prompt entities and falls back when first quoted term is book title", async () => {
  for (const chapterIndex of [1, 2, 3, 4]) {
    await db.saveEncryptedChapter({
      bookId: "book-multi-entity-index",
      chapterIndex,
      title: `第${chapterIndex}章`,
      content: `第${chapterIndex}章原文`
    });
    const chapter = db.getChapterMetadata("book-multi-entity-index", chapterIndex);
    const facts = chapterIndex === 1
      ? [{
        category: "character",
        entity: "剑来",
        fact_type: "book_title_noise",
        fact: "书名噪音事实。",
        evidence: ["剑来"],
        importance: 0.2,
        confidence: 0.9
      }]
      : [{
        category: chapterIndex === 4 ? "item" : "character",
        entity: chapterIndex === 4 ? "本命飞剑" : "陈平安",
        tags: chapterIndex === 4 ? ["飞剑"] : ["本命飞剑"],
        related_entities: ["陈平安"],
        fact_type: "target_fact",
        fact: `第${chapterIndex}章陈平安本命飞剑事实`,
        evidence: [`证据${chapterIndex}`],
        importance: 0.85,
        confidence: 0.85
      }];
    await db.saveL2ChapterFacts({
      bookId: "book-multi-entity-index",
      chapterIndex,
      status: "completed",
      sourceHmac: chapter.content_hmac,
      model: "gpt-5.5",
      promptHash: "l2-v1-typed-facts",
      schemaVersion: "l2-facts-v1",
      facts
    });
  }

  const previousFetch = global.fetch;
  let summaryInput = "";
  global.fetch = async (url, request) => {
    if (String(url).includes("api.openai.com/v1/models")) {
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    const body = JSON.parse(request.body);
    const formatName = body.text?.format?.name || "";
    if (formatName === "l2_source_review") {
      return {
        ok: true,
        json: async () => ({
          id: "resp_multi_entity_review",
          output: [{ content: [{ type: "output_text", text: JSON.stringify({ facts: [] }) }] }]
        })
      };
    }
    summaryInput = body.input[0].content[0].text;
    return {
      ok: true,
      json: async () => ({
        id: "resp_multi_entity_summary",
        output: [{ content: [{ type: "output_text", text: JSON.stringify({ title: "多主体汇总", summary: "完成", items: [], failed_chapters: [] }) }] }]
      })
    };
  };

  try {
    const analysis = workflows.startAnalysisTask({
      analysis_mode: "balanced",
      source_review_budget: 0,
      book_id: "book-multi-entity-index",
      start_chapter: 1,
      end_chapter: 4,
      prompt: {
        summary_prompt: "请分析《剑来》中陈平安本命飞剑相关信息，重点关注人物、物品、关系。"
      }
    });
    await waitForTask(analysis);
    const result = await workflows.publicAnalysisRunWithResult(analysis.id);
    assert.equal(result.source_stats.recalled_facts >= 3, true);
    assert.equal(result.source_stats.entity_queries.includes("陈平安本命飞剑"), true);
    assert.equal(result.source_stats.entity_query, "陈平安本命飞剑");
    assert.equal(result.source_stats.recall_fallback_used, true);
    assert.equal(summaryInput.includes("陈平安本命飞剑事实"), true);
  } finally {
    global.fetch = previousFetch;
  }
});

test("balanced index analysis routes through L1 matches before loading L2 facts", async () => {
  for (const chapterIndex of [1, 2, 3, 4]) {
    await db.saveEncryptedChapter({
      bookId: "book-l1-routed-index",
      chapterIndex,
      title: `第${chapterIndex}章`,
      content: `第${chapterIndex}章原文`
    });
    const chapter = db.getChapterMetadata("book-l1-routed-index", chapterIndex);
    db.saveL1ChapterIndex({
      bookId: "book-l1-routed-index",
      chapterIndex,
      status: "completed",
      sourceHmac: chapter.content_hmac,
      model: "gpt-5.5",
      promptHash: "l1-v1-chapter-window-10",
      value: {
        summary: chapterIndex === 2 || chapterIndex === 4 ? "陈平安本命飞剑相关路标" : "普通剧情路标",
        keywords: chapterIndex === 2 || chapterIndex === 4 ? ["陈平安", "本命飞剑"] : ["普通剧情"],
        entities: chapterIndex === 2 || chapterIndex === 4 ? ["陈平安", "本命飞剑"] : ["路人"],
        key_events: [],
        items_places_orgs: [],
        open_questions: [],
        confidence: 0.9
      }
    });
    await db.saveL2ChapterFacts({
      bookId: "book-l1-routed-index",
      chapterIndex,
      status: "completed",
      sourceHmac: chapter.content_hmac,
      model: "gpt-5.5",
      promptHash: "l2-v1-typed-facts",
      schemaVersion: "l2-facts-v1",
      facts: [{
        category: "character",
        entity: chapterIndex === 2 || chapterIndex === 4 ? "陈平安" : "路人",
        tags: chapterIndex === 2 || chapterIndex === 4 ? ["本命飞剑"] : ["普通剧情"],
        related_entities: [],
        fact_type: "route_fact",
        fact: `第${chapterIndex}章事实`,
        evidence: [`证据${chapterIndex}`],
        importance: 0.9,
        confidence: 0.9
      }]
    });
  }

  const previousFetch = global.fetch;
  let summaryInput = "";
  global.fetch = async (url, request) => {
    if (String(url).includes("api.openai.com/v1/models")) {
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    const body = JSON.parse(request.body);
    summaryInput = body.input[0].content[0].text;
    return {
      ok: true,
      json: async () => ({
        id: "resp_l1_routed_summary",
        output: [{ content: [{ type: "output_text", text: JSON.stringify({ title: "L1 路由汇总", summary: "完成", items: [], failed_chapters: [] }) }] }]
      })
    };
  };

  try {
    const analysis = workflows.startAnalysisTask({
      analysis_mode: "balanced",
      source_review_budget: 0,
      book_id: "book-l1-routed-index",
      start_chapter: 1,
      end_chapter: 4,
      prompt: {
        summary_prompt: "请分析陈平安本命飞剑相关信息。"
      }
    });
    await waitForTask(analysis);
    const result = await workflows.publicAnalysisRunWithResult(analysis.id);
    assert.deepEqual(result.source_stats.l1_matched_chapters, [2, 4]);
    assert.equal(result.source_stats.l1_route_enabled, true);
    assert.equal(result.source_stats.recalled_chapters, 2);
    assert.equal(summaryInput.includes("第2章事实"), true);
    assert.equal(summaryInput.includes("第4章事实"), true);
    assert.equal(summaryInput.includes("第1章事实"), false);
    assert.equal(summaryInput.includes("第3章事实"), false);
  } finally {
    global.fetch = previousFetch;
  }
});

test("balanced index analysis splits custom JSON final summary by top-level fields", async () => {
  await db.saveEncryptedChapter({
    bookId: "book-balanced-field-summary",
    chapterIndex: 1,
    title: "第一章",
    content: "云筝外貌描写。"
  });
  const chapter = db.getChapterMetadata("book-balanced-field-summary", 1);
  db.saveL1ChapterIndex({
    bookId: "book-balanced-field-summary",
    chapterIndex: 1,
    status: "completed",
    sourceHmac: chapter.content_hmac,
    model: "gpt-5.5",
    promptHash: "l1-v1-chapter-window-10",
    value: {
      summary: "云筝外貌资料路标",
      keywords: ["云筝", "外貌"],
      entities: ["云筝"],
      key_events: [],
      items_places_orgs: [],
      open_questions: [],
      confidence: 0.9
    }
  });
  await db.saveL2ChapterFacts({
    bookId: "book-balanced-field-summary",
    chapterIndex: 1,
    status: "completed",
    sourceHmac: chapter.content_hmac,
    model: "gpt-5.5",
    promptHash: "l2-v1-typed-facts",
    schemaVersion: "l2-facts-v1",
    facts: [{
      category: "character",
      entity: "云筝",
      tags: ["外貌"],
      related_entities: [],
      fact_type: "appearance",
      fact: "云筝具有可用于生图的外貌资料。",
      evidence: ["外貌描写"],
      importance: 0.9,
      confidence: 0.9
    }]
  });

  const previousFetch = global.fetch;
  const generatedFields = [];
  global.fetch = async (url, request) => {
    if (String(url).includes("api.openai.com/v1/models")) {
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    const body = JSON.parse(request.body);
    const text = body.input[0].content[0].text;
    const formatName = body.text?.format?.name || "";
    if (formatName === "custom_final_analysis" || formatName === "final_analysis") {
      throw new Error("Balanced custom JSON index analysis should split final summary by fields");
    }
    assert.equal(formatName.startsWith("custom_field_"), true);
    assert.equal(text.includes("证据包素材 JSON"), true);
    const fieldName = formatName.replace(/^custom_field_/, "");
    if (fieldName === "core_characters") {
      assert.equal(text.includes("云筝具有可用于生图的外貌资料"), true);
    }
    generatedFields.push(fieldName);
    const values = {
      core_characters: [{ name: "云筝" }],
      uncertainties: []
    };
    return {
      ok: true,
      json: async () => ({
        id: `resp_balanced_field_${fieldName}`,
        output: [{ content: [{ type: "output_text", text: JSON.stringify({ [fieldName]: values[fieldName] }) }] }]
      })
    };
  };

  try {
    const analysis = workflows.startAnalysisTask({
      analysis_mode: "balanced",
      source_review_budget: 0,
      book_id: "book-balanced-field-summary",
      start_chapter: 1,
      end_chapter: 1,
      prompt: {
        summary_prompt: [
          "请用 JSON 输出人物形象资料。",
          "{",
          "  \"core_characters\": [],",
          "  \"uncertainties\": []",
          "}"
        ].join("\n")
      }
    });
    await waitForTask(analysis);
    assert.deepEqual(generatedFields.sort(), ["core_characters", "uncertainties"]);
    const result = await workflows.publicAnalysisRunWithResult(analysis.id);
    assert.deepEqual(Object.keys(result.finalResult).sort(), ["core_characters", "uncertainties"]);
    assert.equal(result.finalResult.core_characters[0].name, "云筝");
  } finally {
    global.fetch = previousFetch;
  }
});

test("balanced index analysis infers declared JSON fields and ignores legacy output schema", async () => {
  for (const chapterIndex of [1, 2]) {
    await db.saveEncryptedChapter({
      bookId: "book-balanced-declared-fields",
      chapterIndex,
      title: `第${chapterIndex}章`,
      content: `第${chapterIndex}章原文`
    });
    const chapter = db.getChapterMetadata("book-balanced-declared-fields", chapterIndex);
    db.saveL1ChapterIndex({
      bookId: "book-balanced-declared-fields",
      chapterIndex,
      status: "completed",
      sourceHmac: chapter.content_hmac,
      model: "gpt-5.5",
      promptHash: "l1-v1-chapter-window-10",
      value: {
        summary: chapterIndex === 1 ? "云筝外貌资料路标" : "路人普通路标",
        keywords: chapterIndex === 1 ? ["云筝", "外貌"] : ["路人"],
        entities: chapterIndex === 1 ? ["云筝"] : ["路人"],
        key_events: [],
        items_places_orgs: [],
        open_questions: [],
        confidence: 0.9
      }
    });
    await db.saveL2ChapterFacts({
      bookId: "book-balanced-declared-fields",
      chapterIndex,
      status: "completed",
      sourceHmac: chapter.content_hmac,
      model: "gpt-5.5",
      promptHash: "l2-v1-typed-facts",
      schemaVersion: "l2-facts-v1",
      facts: [{
        category: "character",
        entity: chapterIndex === 1 ? "云筝" : "路人",
        tags: chapterIndex === 1 ? ["外貌"] : ["无关"],
        related_entities: [],
        fact_type: "appearance",
        fact: chapterIndex === 1 ? "云筝具有明确外貌资料。" : "路人事实不应进入核心字段素材。",
        evidence: [`证据${chapterIndex}`],
        importance: 0.9,
        confidence: 0.9
      }]
    });
  }

  const previousFetch = global.fetch;
  const generatedFields = [];
  const fieldInputs = new Map();
  global.fetch = async (url, request) => {
    if (String(url).includes("api.openai.com/v1/models")) {
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    const body = JSON.parse(request.body);
    const text = body.input[0].content[0].text;
    const formatName = body.text?.format?.name || "";
    if (formatName === "custom_final_analysis" || formatName === "final_analysis") {
      throw new Error("Declared JSON fields should split by fields instead of using legacy output schema");
    }
    assert.equal(formatName.startsWith("custom_field_"), true);
    const fieldName = formatName.replace(/^custom_field_/, "");
    generatedFields.push(fieldName);
    fieldInputs.set(fieldName, text);
    const values = {
      book_id: "book-balanced-declared-fields",
      book_name: "字段声明测试书",
      task: "人物外貌",
      core_characters: [{ name: "云筝" }],
      important_characters: [],
      minor_characters: [],
      uncertainties: []
    };
    return {
      ok: true,
      json: async () => ({
        id: `resp_declared_field_${fieldName}`,
        output: [{ content: [{ type: "output_text", text: JSON.stringify({ [fieldName]: values[fieldName] }) }] }]
      })
    };
  };

  try {
    db.ensureBook("book-balanced-declared-fields", "字段声明测试书");
    const legacySchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        summary: { type: "string" },
        items: { type: "array", items: { type: "object" } },
        failed_chapters: { type: "array", items: { type: "integer" } }
      },
      required: ["title", "summary", "items", "failed_chapters"]
    };
    const analysis = workflows.startAnalysisTask({
      name: "人物外貌",
      analysis_mode: "balanced",
      source_review_budget: 0,
      book_id: "book-balanced-declared-fields",
      start_chapter: 1,
      end_chapter: 2,
      prompt: {
        summary_prompt: [
          "请输出合法 JSON。",
          "核心角色“云筝”。",
          "字段包括：",
          "book_id、book_name、task、core_characters、important_characters、minor_characters、uncertainties。",
          "",
          "core_characters 每项包含角色名称和外貌描述。"
        ].join("\n"),
        output_schema: JSON.stringify(legacySchema)
      }
    });
    await waitForTask(analysis);
    assert.deepEqual(generatedFields.sort(), [
      "core_characters",
      "important_characters",
      "minor_characters",
      "uncertainties"
    ]);
    assert.equal(fieldInputs.get("core_characters").includes("云筝具有明确外貌资料"), true);
    assert.equal(fieldInputs.get("core_characters").includes("路人事实不应进入核心字段素材"), false);
    const result = await workflows.publicAnalysisRunWithResult(analysis.id);
    assert.equal(result.finalResult.book_id, "book-balanced-declared-fields");
    assert.equal(result.finalResult.book_name, "字段声明测试书");
    assert.equal(result.finalResult.task, "人物外貌");
    assert.equal(result.finalResult.core_characters[0].name, "云筝");
    assert.equal(Object.hasOwn(result.finalResult, "title"), false);
  } finally {
    global.fetch = previousFetch;
  }
});

test("balanced custom JSON summary persists and resumes failed field batches only", async () => {
  const factCount = 36;
  for (let chapterIndex = 1; chapterIndex <= factCount; chapterIndex += 1) {
    await db.saveEncryptedChapter({
      bookId: "book-summary-part-resume",
      chapterIndex,
      title: `第${chapterIndex}章`,
      content: `第${chapterIndex}章原文`
    });
    const chapter = db.getChapterMetadata("book-summary-part-resume", chapterIndex);
    db.saveL1ChapterIndex({
      bookId: "book-summary-part-resume",
      chapterIndex,
      status: "completed",
      sourceHmac: chapter.content_hmac,
      model: "gpt-5.5",
      promptHash: "l1-v1-chapter-window-10",
      value: {
        summary: "人物资料路标",
        keywords: ["人物", "外貌"],
        entities: [`角色${chapterIndex}`],
        key_events: [],
        items_places_orgs: [],
        open_questions: [],
        confidence: 0.9
      }
    });
    await db.saveL2ChapterFacts({
      bookId: "book-summary-part-resume",
      chapterIndex,
      status: "completed",
      sourceHmac: chapter.content_hmac,
      model: "gpt-5.5",
      promptHash: "l2-v1-typed-facts",
      schemaVersion: "l2-facts-v1",
      facts: [{
        category: "character",
        entity: `角色${chapterIndex}`,
        tags: ["外貌"],
        related_entities: [],
        fact_type: "appearance",
        fact: `角色${chapterIndex}外貌事实${"很长".repeat(180)}`,
        evidence: [`证据${chapterIndex}${"内容".repeat(80)}`],
        importance: 0.8,
        confidence: 0.85
      }]
    });
  }

  const previousFetch = global.fetch;
  let allowBatch2Success = false;
  const callCounts = new Map();
  global.fetch = async (url, request) => {
    if (String(url).includes("api.openai.com/v1/models")) {
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    const body = JSON.parse(request.body);
    const text = body.input[0].content[0].text;
    const formatName = body.text?.format?.name || "";
    if (!formatName.startsWith("custom_field_")) {
      throw new Error(`Unexpected format: ${formatName}`);
    }
    const splitMatch = text.match(/"batch":(\d+),"total":(\d+)/);
    const batch = Number(splitMatch?.[1] || 1);
    const fieldName = formatName.replace(/^custom_field_/, "");
    const key = `${fieldName}.${batch}`;
    callCounts.set(key, (callCounts.get(key) || 0) + 1);
    if (fieldName === "characters" && batch === 2 && !allowBatch2Success) {
      throw new Error("This operation was aborted");
    }
    return {
      ok: true,
      json: async () => ({
        id: `resp_${fieldName}_${batch}`,
        output: [{ content: [{ type: "output_text", text: JSON.stringify({ [fieldName]: [{ name: `${fieldName}-${batch}` }] }) }] }]
      })
    };
  };

  try {
    const analysis = workflows.startAnalysisTask({
      analysis_mode: "balanced",
      source_review_budget: 0,
      book_id: "book-summary-part-resume",
      start_chapter: 1,
      end_chapter: factCount,
      prompt: {
        summary_prompt: [
          "请输出合法 JSON。",
          "{",
          "  \"characters\": [],",
          "  \"notes\": []",
          "}"
        ].join("\n")
      }
    });
    await assert.rejects(() => waitForTask(analysis), /This operation was aborted/);
    const failed = await workflows.publicAnalysisRunWithResult(analysis.id);
    assert.equal(failed.canResumeSummary, true);
    assert.equal(failed.failedSummaryParts.length, 1);
    assert.equal(failed.summaryProgress.failed, 1);
    assert.equal(callCounts.get("characters.1"), 1);
    assert.equal(callCounts.get("characters.2"), 3);

    allowBatch2Success = true;
    const resumed = workflows.resumeAnalysisRunTask(analysis.id);
    await waitForTask(resumed);
    const result = await workflows.publicAnalysisRunWithResult(analysis.id);
    assert.equal(result.status, "completed");
    assert.equal(result.summaryProgress.failed, 0);
    assert.equal(result.summaryProgress.completed >= 3, true);
    assert.equal(callCounts.get("characters.1"), 1);
    assert.equal(callCounts.get("characters.2"), 4);
    assert.equal(result.finalResult.characters.some((item) => item.name === "characters-1"), true);
    assert.equal(result.finalResult.characters.some((item) => item.name === "characters-2"), true);
  } finally {
    global.fetch = previousFetch;
  }
});

test("analysis parameter scalar fields are filled deterministically instead of split as evidence fields", async () => {
  await db.saveEncryptedChapter({
    bookId: "book-deterministic-target-subject",
    chapterIndex: 1,
    title: "第一章",
    content: "云筝外貌描写。"
  });
  const chapter = db.getChapterMetadata("book-deterministic-target-subject", 1);
  db.saveL1ChapterIndex({
    bookId: "book-deterministic-target-subject",
    chapterIndex: 1,
    status: "completed",
    sourceHmac: chapter.content_hmac,
    model: "gpt-5.5",
    promptHash: "l1-v1-chapter-window-10",
    value: {
      summary: "核心角色云筝外貌资料路标",
      keywords: ["云筝", "外貌"],
      entities: ["云筝"],
      key_events: [],
      items_places_orgs: [],
      open_questions: [],
      confidence: 0.9
    }
  });
  await db.saveL2ChapterFacts({
    bookId: "book-deterministic-target-subject",
    chapterIndex: 1,
    status: "completed",
    sourceHmac: chapter.content_hmac,
    model: "gpt-5.5",
    promptHash: "l2-v1-typed-facts",
    schemaVersion: "l2-facts-v1",
    facts: [{
      category: "character",
      entity: "云筝",
      tags: ["外貌"],
      related_entities: [],
      fact_type: "appearance",
      fact: "云筝具有明确外貌资料。",
      evidence: ["外貌描写"],
      importance: 0.9,
      confidence: 0.9
    }]
  });

  const previousFetch = global.fetch;
  const generatedFields = [];
  global.fetch = async (url, request) => {
    if (String(url).includes("api.openai.com/v1/models")) {
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    const body = JSON.parse(request.body);
    const formatName = body.text?.format?.name || "";
    assert.equal(formatName.startsWith("custom_field_"), true);
    const fieldName = formatName.replace(/^custom_field_/, "");
    generatedFields.push(fieldName);
    return {
      ok: true,
      json: async () => ({
        id: `resp_deterministic_${fieldName}`,
        output: [{ content: [{ type: "output_text", text: JSON.stringify({ [fieldName]: [] }) }] }]
      })
    };
  };

  try {
    const analysis = workflows.startAnalysisTask({
      analysis_mode: "balanced",
      source_review_budget: 0,
      name: "主体分析",
      book_id: "book-deterministic-target-subject",
      start_chapter: 1,
      end_chapter: 1,
      prompt: {
        summary_prompt: [
          "请输出合法 JSON。",
          "核心角色“云筝”。",
          "{",
          "  \"task\": \"主体分析\",",
          "  \"target_subject\": \"用户指定主体\",",
          "  \"appearance_descriptions\": []",
          "}"
        ].join("\n")
      }
    });
    await waitForTask(analysis);
    assert.deepEqual(generatedFields, ["appearance_descriptions"]);
    const result = await workflows.publicAnalysisRunWithResult(analysis.id);
    assert.equal(result.finalResult.task, "主体分析");
    assert.equal(result.finalResult.target_subject, "云筝");
    assert.equal(result.summaryParts.some((part) => part.part_key === "meta.target_subject"), true);
    assert.equal(result.summaryParts.some((part) => part.part_key.startsWith("json.target_subject")), false);
  } finally {
    global.fetch = previousFetch;
  }
});

test("analysis target fields support category scoped tasks", async () => {
  await db.saveEncryptedChapter({
    bookId: "book-category-target",
    chapterIndex: 1,
    title: "第一章",
    content: "飞剑设定。"
  });
  const chapter = db.getChapterMetadata("book-category-target", 1);
  db.saveL1ChapterIndex({
    bookId: "book-category-target",
    chapterIndex: 1,
    status: "completed",
    sourceHmac: chapter.content_hmac,
    model: "gpt-5.5",
    promptHash: "l1-v1-chapter-window-10",
    value: {
      summary: "飞剑设定路标",
      keywords: ["飞剑", "本命物"],
      entities: ["飞剑"],
      key_events: [],
      items_places_orgs: ["飞剑"],
      open_questions: [],
      confidence: 0.9
    }
  });
  await db.saveL2ChapterFacts({
    bookId: "book-category-target",
    chapterIndex: 1,
    status: "completed",
    sourceHmac: chapter.content_hmac,
    model: "gpt-5.5",
    promptHash: "l2-v1-typed-facts",
    schemaVersion: "l2-facts-v1",
    facts: [{
      category: "item",
      entity: "飞剑",
      tags: ["本命物"],
      related_entities: [],
      fact_type: "item_setting",
      fact: "飞剑具有体系性设定。",
      evidence: ["飞剑设定"],
      importance: 0.9,
      confidence: 0.9
    }]
  });

  const previousFetch = global.fetch;
  const generatedFields = [];
  global.fetch = async (url, request) => {
    if (String(url).includes("api.openai.com/v1/models")) {
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    const body = JSON.parse(request.body);
    const formatName = body.text?.format?.name || "";
    assert.equal(formatName.startsWith("custom_field_"), true);
    const fieldName = formatName.replace(/^custom_field_/, "");
    generatedFields.push(fieldName);
    return {
      ok: true,
      json: async () => ({
        id: `resp_category_target_${fieldName}`,
        output: [{ content: [{ type: "output_text", text: JSON.stringify({ [fieldName]: [] }) }] }]
      })
    };
  };

  try {
    const analysis = workflows.startAnalysisTask({
      analysis_mode: "balanced",
      source_review_budget: 0,
      name: "飞剑设定",
      book_id: "book-category-target",
      start_chapter: 1,
      end_chapter: 1,
      prompt: {
        summary_prompt: [
          "请输出合法 JSON。",
          "分析目标：梳理小说中的所有飞剑。",
          "{",
          "  \"task\": \"飞剑设定\",",
          "  \"target_subject\": \"用户指定主体\",",
          "  \"items\": []",
          "}"
        ].join("\n")
      }
    });
    await waitForTask(analysis);
    assert.deepEqual(generatedFields, ["items"]);
    const result = await workflows.publicAnalysisRunWithResult(analysis.id);
    assert.equal(result.finalResult.target_subject, "所有飞剑");
  } finally {
    global.fetch = previousFetch;
  }
});

test("unfilled analysis parameter placeholders fail before expensive field generation", async () => {
  await db.saveEncryptedChapter({
    bookId: "book-unfilled-target-placeholder",
    chapterIndex: 1,
    title: "第一章",
    content: "外貌描写。"
  });
  const chapter = db.getChapterMetadata("book-unfilled-target-placeholder", 1);
  db.saveL1ChapterIndex({
    bookId: "book-unfilled-target-placeholder",
    chapterIndex: 1,
    status: "completed",
    sourceHmac: chapter.content_hmac,
    model: "gpt-5.5",
    promptHash: "l1-v1-chapter-window-10",
    value: {
      summary: "外貌资料路标",
      keywords: ["外貌"],
      entities: [],
      key_events: [],
      items_places_orgs: [],
      open_questions: [],
      confidence: 0.9
    }
  });
  await db.saveL2ChapterFacts({
    bookId: "book-unfilled-target-placeholder",
    chapterIndex: 1,
    status: "completed",
    sourceHmac: chapter.content_hmac,
    model: "gpt-5.5",
    promptHash: "l2-v1-typed-facts",
    schemaVersion: "l2-facts-v1",
    facts: [{
      category: "character",
      entity: "未指定人物",
      fact_type: "appearance",
      fact: "存在外貌事实。",
      evidence: ["外貌描写"],
      importance: 0.8,
      confidence: 0.8
    }]
  });

  const previousFetch = global.fetch;
  let fieldCalls = 0;
  global.fetch = async (url) => {
    if (String(url).includes("api.openai.com/v1/models")) {
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    fieldCalls += 1;
    throw new Error("field generation should not run");
  };

  try {
    const analysis = workflows.startAnalysisTask({
      analysis_mode: "balanced",
      source_review_budget: 0,
      book_id: "book-unfilled-target-placeholder",
      start_chapter: 1,
      end_chapter: 1,
      prompt: {
        summary_prompt: [
          "请输出合法 JSON。",
          "{",
          "  \"target_subject\": \"用户指定主体\",",
          "  \"appearance_descriptions\": []",
          "}"
        ].join("\n")
      }
    });
    await assert.rejects(() => waitForTask(analysis), /target_subject.*具体分析对象\/目标范围/);
    assert.equal(fieldCalls, 0);
  } finally {
    global.fetch = previousFetch;
  }
});

test("final summary field requests use budgeted evidence packets", async () => {
  const factCount = 28;
  for (let chapterIndex = 1; chapterIndex <= factCount; chapterIndex += 1) {
    await db.saveEncryptedChapter({
      bookId: "book-budgeted-evidence-packets",
      chapterIndex,
      title: `第${chapterIndex}章`,
      content: `第${chapterIndex}章原文`
    });
    const chapter = db.getChapterMetadata("book-budgeted-evidence-packets", chapterIndex);
    await db.saveL2ChapterFacts({
      bookId: "book-budgeted-evidence-packets",
      chapterIndex,
      status: "completed",
      sourceHmac: chapter.content_hmac,
      model: "gpt-5.5",
      promptHash: "l2-v1-typed-facts",
      schemaVersion: "l2-facts-v1",
      facts: [{
        category: "character",
        entity: `角色${chapterIndex}`,
        tags: ["外貌", "人物"],
        related_entities: ["云筝"],
        fact_type: "appearance",
        fact: `角色${chapterIndex}人物外貌事实${"内容".repeat(220)}`,
        evidence: [`证据${chapterIndex}${"摘记".repeat(100)}`],
        importance: 0.7,
        confidence: 0.8
      }]
    });
  }

  const previousFetch = global.fetch;
  const capturedMaterials = [];
  global.fetch = async (url, request) => {
    if (String(url).includes("api.openai.com/v1/models")) {
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    const body = JSON.parse(request.body);
    const text = body.input[0].content[0].text;
    const formatName = body.text?.format?.name || "";
    assert.equal(text.length <= 18_000, true);
    if (formatName.startsWith("custom_field_")) {
      const fieldName = formatName.replace(/^custom_field_/, "");
      const material = extractEvidenceMaterial(text);
      capturedMaterials.push(material);
      assert.equal(Object.hasOwn(material, "facts"), false);
      assert.equal(Object.hasOwn(material, "compressedResults"), false);
      assert.equal(Array.isArray(material.evidence_packets), true);
      assert.equal(material.evidence_packets.length > 0, true);
      assert.equal(material.evidence_packets[0].source_type, "l2_fact");
      assert.equal(typeof material.evidence_packets[0].chapter_index, "number");
      assert.equal(typeof material.evidence_packets[0].subject, "string");
      return {
        ok: true,
        json: async () => ({
          id: `resp_budgeted_${formatName}`,
          output: [{ content: [{ type: "output_text", text: JSON.stringify({ [fieldName]: fieldName === "characters" ? [{ name: "角色1" }] : ["已处理"] }) }] }]
        })
      };
    }
    throw new Error(`Unexpected format: ${formatName}`);
  };

  try {
    const analysis = workflows.startAnalysisTask({
      analysis_mode: "balanced",
      source_review_budget: 0,
      book_id: "book-budgeted-evidence-packets",
      start_chapter: 1,
      end_chapter: factCount,
      prompt: {
        summary_prompt: [
          "请用 JSON 输出人物外貌资料。",
          "{",
          "  \"characters\": [],",
          "  \"notes\": []",
          "}"
        ].join("\n")
      }
    });
    await waitForTask(analysis);
    assert.equal(capturedMaterials.length >= 2, true);
    const result = await workflows.publicAnalysisRunWithResult(analysis.id);
    assert.equal(result.sourceTraceSummary.evidence_packet_count > 0, true);
    assert.equal(result.sourceTraceSummary.source_types.l2_fact > 0, true);
    assert.equal(result.sourceTrace.some((trace) => trace.stage === "json_field_batch"), true);
    assert.equal(JSON.stringify(result.sourceTrace).includes("人物外貌事实"), false);
  } finally {
    global.fetch = previousFetch;
  }
});

test("final summary array batches merge duplicate subjects and apply global limits", async () => {
  const factCount = 24;
  for (let chapterIndex = 1; chapterIndex <= factCount; chapterIndex += 1) {
    await db.saveEncryptedChapter({
      bookId: "book-array-subject-merge",
      chapterIndex,
      title: `第${chapterIndex}章`,
      content: `第${chapterIndex}章原文`
    });
    const chapter = db.getChapterMetadata("book-array-subject-merge", chapterIndex);
    await db.saveL2ChapterFacts({
      bookId: "book-array-subject-merge",
      chapterIndex,
      status: "completed",
      sourceHmac: chapter.content_hmac,
      model: "gpt-5.5",
      promptHash: "l2-v1-typed-facts",
      schemaVersion: "l2-facts-v1",
      facts: [{
        category: "character",
        entity: chapterIndex % 2 ? "云筝" : "容烁",
        tags: ["外貌", "人物"],
        related_entities: [],
        fact_type: "appearance",
        fact: `人物形象事实${chapterIndex}${"内容".repeat(220)}`,
        evidence: [`证据${chapterIndex}${"摘记".repeat(100)}`],
        importance: 0.9,
        confidence: 0.85
      }]
    });
  }

  const previousFetch = global.fetch;
  global.fetch = async (url, request) => {
    if (String(url).includes("api.openai.com/v1/models")) {
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    const body = JSON.parse(request.body);
    const formatName = body.text?.format?.name || "";
    if (!formatName.startsWith("custom_field_")) {
      throw new Error(`Unexpected format: ${formatName}`);
    }
    const fieldName = formatName.replace(/^custom_field_/, "");
    if (fieldName === "characters") {
      return {
        ok: true,
        json: async () => ({
          id: `resp_array_merge_${formatName}`,
          output: [{ content: [{ type: "output_text", text: JSON.stringify({
            characters: [
              { name: "云筝", role_level: "核心角色", identity: "主角", appearance: `红衣少女，眼神凌厉，${"外貌".repeat(80)}`, reliability: "确定事实" },
              { name: "容烁", role_level: "核心角色", identity: "重要角色", appearance: "气质冷淡", reliability: "合理归纳" }
            ]
          }) }] }]
        })
      };
    }
    return {
      ok: true,
      json: async () => ({
        id: `resp_array_merge_${formatName}`,
        output: [{ content: [{ type: "output_text", text: JSON.stringify({ [fieldName]: "ok" }) }] }]
      })
    };
  };

  try {
    const analysis = workflows.startAnalysisTask({
      analysis_mode: "balanced",
      source_review_budget: 0,
      book_id: "book-array-subject-merge",
      start_chapter: 1,
      end_chapter: factCount,
      prompt: {
        summary_prompt: [
          "请用 JSON 输出人物资料。",
          "characters 最多 2 个。",
          "appearance 控制在 30 字以内。",
          "{",
          "  \"characters\": [],",
          "  \"notes\": \"\"",
          "}"
        ].join("\n")
      }
    });
    await waitForTask(analysis);
    const result = await workflows.publicAnalysisRunWithResult(analysis.id);
    assert.equal(result.finalResult.characters.length, 2);
    assert.deepEqual(result.finalResult.characters.map((item) => item.name).sort(), ["云筝", "容烁"]);
    assert.equal(result.finalResult.characters.every((item) => item.appearance.length <= 30), true);
  } finally {
    global.fetch = previousFetch;
  }
});

test("final summary array merge is generic for non-character entity fields", async () => {
  const factCount = 20;
  for (let chapterIndex = 1; chapterIndex <= factCount; chapterIndex += 1) {
    await db.saveEncryptedChapter({
      bookId: "book-generic-array-merge",
      chapterIndex,
      title: `第${chapterIndex}章`,
      content: `第${chapterIndex}章原文`
    });
    const chapter = db.getChapterMetadata("book-generic-array-merge", chapterIndex);
    await db.saveL2ChapterFacts({
      bookId: "book-generic-array-merge",
      chapterIndex,
      status: "completed",
      sourceHmac: chapter.content_hmac,
      model: "gpt-5.5",
      promptHash: "l2-v1-typed-facts",
      schemaVersion: "l2-facts-v1",
      facts: [{
        category: "item",
        entity: chapterIndex % 2 ? "笼中雀" : "井中月",
        tags: ["飞剑"],
        related_entities: [],
        fact_type: "item_setting",
        fact: `飞剑设定事实${chapterIndex}${"内容".repeat(220)}`,
        evidence: [`证据${chapterIndex}${"摘记".repeat(100)}`],
        importance: 0.9,
        confidence: 0.85
      }]
    });
  }

  const previousFetch = global.fetch;
  global.fetch = async (url, request) => {
    if (String(url).includes("api.openai.com/v1/models")) {
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    const body = JSON.parse(request.body);
    const formatName = body.text?.format?.name || "";
    if (!formatName.startsWith("custom_field_")) {
      throw new Error(`Unexpected format: ${formatName}`);
    }
    const fieldName = formatName.replace(/^custom_field_/, "");
    if (fieldName === "items") {
      return {
        ok: true,
        json: async () => ({
          id: `resp_generic_merge_${formatName}`,
          output: [{ content: [{ type: "output_text", text: JSON.stringify({
            items: [
              { item_name: "笼中雀", type: "飞剑", summary: "本命飞剑设定 A" },
              { item_name: "井中月", type: "飞剑", summary: "本命飞剑设定 B" }
            ]
          }) }] }]
        })
      };
    }
    return {
      ok: true,
      json: async () => ({
        id: `resp_generic_merge_${formatName}`,
        output: [{ content: [{ type: "output_text", text: JSON.stringify({ [fieldName]: "ok" }) }] }]
      })
    };
  };

  try {
    const analysis = workflows.startAnalysisTask({
      analysis_mode: "balanced",
      source_review_budget: 0,
      book_id: "book-generic-array-merge",
      start_chapter: 1,
      end_chapter: factCount,
      prompt: {
        summary_prompt: [
          "请用 JSON 输出所有飞剑。",
          "{",
          "  \"items\": [],",
          "  \"notes\": \"\"",
          "}"
        ].join("\n")
      }
    });
    await waitForTask(analysis);
    const result = await workflows.publicAnalysisRunWithResult(analysis.id);
    assert.deepEqual(result.finalResult.items.map((item) => item.item_name).sort(), ["井中月", "笼中雀"]);
  } finally {
    global.fetch = previousFetch;
  }
});

test("evidence packet ranking keeps target subject first under budget", async () => {
  const bookId = "book-evidence-packet-ranking";
  for (let chapterIndex = 1; chapterIndex <= 18; chapterIndex += 1) {
    await db.saveEncryptedChapter({
      bookId,
      chapterIndex,
      title: `第${chapterIndex}章`,
      content: `第${chapterIndex}章原文`
    });
    const chapter = db.getChapterMetadata(bookId, chapterIndex);
    const isTarget = chapterIndex === 18;
    await db.saveL2ChapterFacts({
      bookId,
      chapterIndex,
      status: "completed",
      sourceHmac: chapter.content_hmac,
      model: "gpt-5.5",
      promptHash: "l2-v1-typed-facts",
      schemaVersion: "l2-facts-v1",
      facts: [{
        category: "character",
        entity: isTarget ? "云筝" : `噪音角色${chapterIndex}`,
        tags: isTarget ? ["云筝", "外貌"] : ["背景"],
        related_entities: [],
        fact_type: isTarget ? "appearance" : "background",
        fact: isTarget ? "云筝具有高价值目标外貌事实。" : `噪音角色${chapterIndex}背景事实${"冗余".repeat(160)}`,
        evidence: [isTarget ? "云筝外貌证据" : `噪音证据${chapterIndex}`],
        importance: isTarget ? 0.95 : 0.2,
        confidence: isTarget ? 0.95 : 0.5
      }]
    });
  }

  const previousFetch = global.fetch;
  let firstCharacterPacket = null;
  global.fetch = async (url, request) => {
    if (String(url).includes("api.openai.com/v1/models")) {
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    const body = JSON.parse(request.body);
    const formatName = body.text?.format?.name || "";
    if (!formatName.startsWith("custom_field_")) {
      throw new Error(`Unexpected format: ${formatName}`);
    }
    const fieldName = formatName.replace(/^custom_field_/, "");
    const material = extractEvidenceMaterial(body.input[0].content[0].text);
    if (fieldName === "characters" && !firstCharacterPacket) {
      firstCharacterPacket = material.evidence_packets[0];
    }
    return {
      ok: true,
      json: async () => ({
        id: `resp_ranked_${fieldName}`,
        output: [{ content: [{ type: "output_text", text: JSON.stringify({ [fieldName]: fieldName === "characters" ? [{ name: "云筝" }] : ["已处理"] }) }] }]
      })
    };
  };

  try {
    const analysis = workflows.startAnalysisTask({
      analysis_mode: "balanced",
      source_review_budget: 0,
      book_id: bookId,
      start_chapter: 1,
      end_chapter: 18,
      prompt: {
        summary_prompt: [
          "请用 JSON 输出，重点分析云筝的人物外貌。",
          "{",
          "  \"characters\": [],",
          "  \"notes\": []",
          "}"
        ].join("\n")
      }
    });
    await waitForTask(analysis);
    assert.equal(firstCharacterPacket.subject, "云筝");
    assert.equal(firstCharacterPacket.content.includes("高价值目标外貌事实"), true);
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
      analysis_mode: "full_text",
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

test("chapter analysis repairs invalid JSON before marking chapter failed", async () => {
  await db.saveEncryptedChapter({
    bookId: "book-chapter-json-repair",
    chapterIndex: 1,
    title: "第一章",
    content: "第一章正文"
  });

  const previousFetch = global.fetch;
  const formatNames = [];
  global.fetch = async (url, request) => {
    if (String(url).includes("api.openai.com/v1/models")) {
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    const body = JSON.parse(request.body);
    const formatName = body.text?.format?.name || "";
    formatNames.push(formatName);
    if (formatName === "chapter_result") {
      return {
        ok: true,
        json: async () => ({
          id: "resp_chapter_broken",
          output: [{ content: [{ type: "output_text", text: "{\"chapter_index\":1,\"chapter_title\":\"第一章\",\"summary\":\"半截\"" }] }]
        })
      };
    }
    if (formatName === "chapter_result_repair") {
      return {
        ok: true,
        json: async () => ({
          id: "resp_chapter_repair",
          output: [{ content: [{ type: "output_text", text: JSON.stringify({
            chapter_index: 1,
            chapter_title: "第一章",
            summary: "修复后的章节摘要",
            key_points: [],
            evidence_notes: []
          }) }] }]
        })
      };
    }
    if (formatName === "final_analysis") {
      return {
        ok: true,
        json: async () => ({
          id: "resp_repaired_final",
          output: [{ content: [{ type: "output_text", text: JSON.stringify({ title: "汇总", summary: "完成", items: [], failed_chapters: [] }) }] }]
        })
      };
    }
    throw new Error(`Unexpected format: ${formatName}`);
  };

  try {
    const analysis = workflows.startAnalysisTask({
      analysis_mode: "full_text",
      name: "章节 JSON 修复",
      book_id: "book-chapter-json-repair",
      start_chapter: 1,
      end_chapter: 1
    });
    await waitForTask(analysis);
    const result = await workflows.publicAnalysisRunWithResult(analysis.id);
    assert.equal(result.finalResult.summary, "完成");
    assert.equal(result.chapterResults.length, 1);
    assert.equal(formatNames.includes("chapter_result_repair"), true);
    assert.equal(result.failedChapterIndexes.length, 0);
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
      analysis_mode: "full_text",
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
      analysis_mode: "full_text",
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
      if (text.includes("证据包素材 JSON")) {
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
      analysis_mode: "full_text",
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

    if (!formatName && text.includes("证据包素材 JSON")) {
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
      analysis_mode: "full_text",
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
      analysis_mode: "full_text",
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
  const finalFieldValues = {
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
  };
  const finalFieldNames = Object.keys(finalFieldValues);
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
  const generatedFields = [];

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

    if (formatName.startsWith("custom_field_")) {
      finalSummaryCalls += 1;
      largestSummaryInput = Math.max(largestSummaryInput, text.length);
      assert.equal(body.text.format.strict, false);
      const fieldName = formatName.replace(/^custom_field_/, "");
      generatedFields.push(fieldName);
      assert.ok(finalFieldNames.includes(fieldName));
      assert.match(text, new RegExp(`当前只生成最终 JSON 的一个顶层字段：${fieldName}`));
      assert.deepEqual(Object.keys(body.text.format.schema.properties), [fieldName]);
      assert.equal(body.max_output_tokens > 0, true);
      return {
        ok: true,
        json: async () => ({
          id: `resp_large_custom_template_${fieldName}`,
          output: [{
            content: [{
              type: "output_text",
              text: JSON.stringify({ [fieldName]: finalFieldValues[fieldName] })
            }]
          }]
        })
      };
    }

    if (formatName === "custom_final_analysis" || formatName === "final_analysis" || formatName === "summary_compression") {
      throw new Error("Large custom JSON template should use per-field derived schema, not one large final schema or model compression");
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
      analysis_mode: "full_text",
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
    assert.equal(finalSummaryCalls, finalFieldNames.length);
    assert.deepEqual(generatedFields.sort(), finalFieldNames.sort());
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
      analysis_mode: "full_text",
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
      analysis_mode: "full_text",
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
  await waitForTerminalTask(task);
  if (task.status === "failed") {
    throw new Error(task.error || "task failed");
  }
  return task;
}

function extractEvidenceMaterial(text) {
  const marker = "证据包素材 JSON：";
  const index = String(text || "").indexOf(marker);
  assert.notEqual(index, -1);
  return JSON.parse(String(text).slice(index + marker.length).trim());
}

async function waitForTerminalTask(task) {
  const started = Date.now();
  while (!["completed", "failed", "cancelled"].includes(task.status)) {
    if (Date.now() - started > 10000) {
      throw new Error(`Task timeout: ${task.id}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return task;
}
