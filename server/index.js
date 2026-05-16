import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, publicRuntimeConfig } from "./config.js";
import {
  deleteBook,
  deleteAnalysisRun,
  createPromptGroup,
  deletePromptGroup,
  getPromptGroup,
  getPromptSettings,
  listAnalysisRuns,
  listBooks,
  listChapterMetadata,
  listPromptGroups,
  updatePromptGroup,
  savePromptSettings
} from "./db.js";
import { getTask, publicTask, cancelTask, subscribeTask } from "./tasks.js";
import { sanitizeError } from "./sanitize.js";
import {
  publicAnalysisRunWithResult,
  startAnalysisTask,
  startImportTask
} from "./workflows.js";
import { testOpenAIConnection } from "./openai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: "2mb" }));

app.get("/api/config", (_request, response) => {
  response.json({ ok: true, runtime: publicRuntimeConfig() });
});

app.get("/api/openai/test", async (_request, response, next) => {
  try {
    response.json({ ok: true, openai: await testOpenAIConnection() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/books", (_request, response) => {
  response.json({ ok: true, books: listBooks() });
});

app.post("/api/books/imports", (request, response, next) => {
  try {
    const task = startImportTask(request.body || {});
    response.status(202).json({ ok: true, task: publicTask(task) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/imports/:id", (request, response, next) => {
  try {
    response.json({ ok: true, task: publicTask(getTask(request.params.id)) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/imports/:id/events", (request, response, next) => {
  try {
    subscribeTask(request.params.id, response);
  } catch (error) {
    next(error);
  }
});

app.post("/api/imports/:id/cancel", (request, response, next) => {
  try {
    response.json({ ok: true, task: cancelTask(request.params.id) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/books/:bookId/chapters", (request, response) => {
  response.json({
    ok: true,
    bookId: request.params.bookId,
    chapters: listChapterMetadata(request.params.bookId)
  });
});

app.post("/api/books/:bookId/delete", (request, response) => {
  response.json({ ok: true, ...deleteBook(request.params.bookId) });
});

app.post("/api/analyses", (request, response, next) => {
  try {
    const task = startAnalysisTask(request.body || {});
    response.status(202).json({ ok: true, task: publicTask(task) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/analyses", (request, response) => {
  response.json({ ok: true, analyses: listAnalysisRuns(request.query.book_id || request.query.bookId) });
});

app.get("/api/analyses/:id", async (request, response, next) => {
  try {
    response.json({ ok: true, analysis: await publicAnalysisRunWithResult(request.params.id) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/analyses/:id", (request, response, next) => {
  try {
    response.json({ ok: true, ...deleteAnalysisRun(request.params.id) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/analyses/:id/events", (request, response, next) => {
  try {
    subscribeTask(request.params.id, response);
  } catch (error) {
    next(error);
  }
});

app.post("/api/analyses/:id/cancel", (request, response, next) => {
  try {
    response.json({ ok: true, task: cancelTask(request.params.id) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/prompts", (_request, response) => {
  response.json({ ok: true, prompts: getPromptSettings() });
});

app.put("/api/prompts", (request, response, next) => {
  try {
    response.json({ ok: true, prompts: savePromptSettings(request.body || {}) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/prompt-groups", (request, response) => {
  response.json({ ok: true, promptGroups: listPromptGroups(request.query.category) });
});

app.post("/api/prompt-groups", (request, response, next) => {
  try {
    response.status(201).json({ ok: true, promptGroup: createPromptGroup(request.body || {}) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/prompt-groups/:id", (request, response, next) => {
  try {
    const promptGroup = getPromptGroup(request.params.id);
    if (!promptGroup) {
      const error = new Error("Prompt 组不存在。");
      error.status = 404;
      throw error;
    }
    response.json({ ok: true, promptGroup });
  } catch (error) {
    next(error);
  }
});

app.put("/api/prompt-groups/:id", (request, response, next) => {
  try {
    response.json({ ok: true, promptGroup: updatePromptGroup(request.params.id, request.body || {}) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/prompt-groups/:id", (request, response, next) => {
  try {
    response.json({ ok: true, ...deletePromptGroup(request.params.id) });
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.resolve(__dirname, "..", "dist")));
app.get(/.*/, (_request, response) => {
  response.sendFile(path.resolve(__dirname, "..", "dist", "index.html"));
});

app.use((error, _request, response, _next) => {
  const safe = sanitizeError(error);
  response.status(safe.status || 500).json({
    ok: false,
    error: safe.message,
    details: safe.details
  });
});

app.listen(config.port, config.host, () => {
  console.log(`Novel Chapter GPT Service: http://${config.host}:${config.port}`);
});
