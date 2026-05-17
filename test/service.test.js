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
  } finally {
    global.fetch = previousFetch;
  }
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
      const isSummary = body.text.format.name === "final_result";
      const outputValue = isSummary
        ? { title: "汇总", summary: "全书摘要", items: [], failed_chapters: [] }
        : { chapter_index: openaiCalls, chapter_title: `第${openaiCalls}章`, summary: "章节摘要", key_points: [], evidence_notes: [] };
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
    const isSummary = body.text.format.name === "final_result";
    if (isSummary) {
      return {
        ok: true,
        json: async () => ({
          id: "resp_summary",
          output: [{ content: [{ type: "output_text", text: JSON.stringify({ title: "汇总", summary: "选择章节", items: [], failed_chapters: [] }) }] }]
        })
      };
    }

    const text = body.input[0].content[0].text;
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

async function waitForTask(task) {
  const started = Date.now();
  while (!["completed", "failed", "cancelled"].includes(task.status)) {
    if (Date.now() - started > 3000) {
      throw new Error(`Task timeout: ${task.id}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (task.status === "failed") {
    throw new Error(task.error || "task failed");
  }
  return task;
}
