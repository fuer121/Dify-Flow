import crypto from "node:crypto";
import { sanitizeText } from "./sanitize.js";

const tasks = new Map();
const subscribers = new Map();

export function createTask(type, payload = {}, options = {}) {
  const id = options.id ? String(options.id) : crypto.randomUUID();
  const task = {
    id,
    type,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    progress: {
      total: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      current: ""
    },
    events: [],
    result: null,
    error: "",
    cancelled: false,
    paused: false,
    metrics: {
      runningStartedAt: null,
      pausedAt: null,
      pausedMs: 0,
      lastProgressAt: null,
      lastProcessed: 0,
      unitDurationsMs: []
    },
    payload: safePayload(payload)
  };
  tasks.set(task.id, task);
  emit(task.id, "created", { task: publicTask(task) });
  return task;
}

export function getTask(id) {
  const task = tasks.get(String(id || ""));
  if (!task) {
    const error = new Error("任务不存在。");
    error.status = 404;
    throw error;
  }
  return task;
}

export function findTask(id) {
  return tasks.get(String(id || "")) || null;
}

export function isLiveTask(task) {
  return Boolean(task && ["queued", "running", "paused"].includes(task.status));
}

export function listTasks(filter = {}) {
  const type = filter.type ? String(filter.type) : "";
  const status = filter.status ? String(filter.status) : "";
  return [...tasks.values()]
    .filter((task) => !type || task.type === type)
    .filter((task) => !status || task.status === status)
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
    .map((task) => publicTask(task));
}

export function taskDiagnostics() {
  const all = [...tasks.values()];
  const byStatus = {};
  const byType = {};
  for (const task of all) {
    byStatus[task.status] = (byStatus[task.status] || 0) + 1;
    byType[task.type] = (byType[task.type] || 0) + 1;
  }
  return {
    total: all.length,
    live: all.filter(isLiveTask).length,
    by_status: byStatus,
    by_type: byType,
    recent: all
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
      .slice(0, 12)
      .map((task) => ({
        id: task.id,
        type: task.type,
        status: task.status,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        progress: task.progress,
        error: task.error
      }))
  };
}

export function publicTask(task) {
  return {
    id: task.id,
    type: task.type,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    progress: task.progress,
    estimate: estimateTask(task),
    events: task.events.slice(-80),
    result: task.result,
    error: task.error,
    payload: task.payload
  };
}

export function markTaskRunning(task, patch = {}) {
  updateTask(task, {
    status: "running",
    ...patch
  }, "running");
}

export function updateTask(task, patch = {}, eventType = "progress") {
  updateMetrics(task, patch);
  Object.assign(task, patch, { updatedAt: new Date().toISOString() });
  const event = {
    time: task.updatedAt,
    type: eventType,
    status: task.status,
    progress: task.progress,
    message: sanitizeText(patch.message || eventType)
  };
  task.events.push(event);
  task.events = task.events.slice(-200);
  emit(task.id, eventType, { task: publicTask(task), event });
  return task;
}

export function completeTask(task, result = {}) {
  updateTask(task, {
    status: "completed",
    result
  }, "completed");
}

export function failTask(task, error) {
  if (task.cancelled || task.status === "cancelled") {
    return task;
  }
  updateTask(task, {
    status: "failed",
    error: sanitizeText(error?.message || error)
  }, "failed");
}

export function cancelTask(id) {
  const task = getTask(id);
  task.cancelled = true;
  task.paused = false;
  updateTask(task, { status: "cancelled", message: "任务已请求取消。" }, "cancelled");
  return publicTask(task);
}

export function pauseTask(id) {
  const task = getTask(id);
  if (["completed", "failed", "cancelled"].includes(task.status)) return publicTask(task);
  task.paused = true;
  task.metrics.pausedAt = Date.now();
  updateTask(task, { status: "paused", message: "任务已暂停，将在当前请求结束后停在下一步。" }, "paused");
  return publicTask(task);
}

export function resumeTask(id) {
  const task = getTask(id);
  if (["completed", "failed", "cancelled"].includes(task.status)) return publicTask(task);
  task.paused = false;
  if (task.metrics.pausedAt) {
    task.metrics.pausedMs += Math.max(0, Date.now() - task.metrics.pausedAt);
    task.metrics.pausedAt = null;
  }
  task.metrics.lastProgressAt = Date.now();
  updateTask(task, { status: "running", message: "任务已继续。" }, "running");
  return publicTask(task);
}

export function assertNotCancelled(task) {
  if (task.cancelled || task.status === "cancelled") {
    const error = new Error("任务已取消。");
    error.status = 499;
    throw error;
  }
}

export async function waitIfPaused(task) {
  assertNotCancelled(task);
  while (task.paused || task.status === "paused") {
    await new Promise((resolve) => setTimeout(resolve, 500));
    assertNotCancelled(task);
  }
}

export function subscribeTask(id, response) {
  const task = getTask(id);
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  response.write(`event: snapshot\ndata: ${JSON.stringify({ task: publicTask(task) })}\n\n`);

  const set = subscribers.get(task.id) || new Set();
  set.add(response);
  subscribers.set(task.id, set);

  response.on("close", () => {
    set.delete(response);
    if (set.size === 0) subscribers.delete(task.id);
  });
}

function emit(id, event, data) {
  const set = subscribers.get(id);
  if (!set) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const response of set) {
    response.write(payload);
  }
}

function updateMetrics(task, patch = {}) {
  const now = Date.now();
  if (patch.status === "running" && !task.metrics.runningStartedAt) {
    task.metrics.runningStartedAt = now;
    task.metrics.lastProgressAt = now;
  }
  if (patch.status === "completed" || patch.status === "failed" || patch.status === "cancelled") {
    if (task.metrics.pausedAt) {
      task.metrics.pausedMs += Math.max(0, now - task.metrics.pausedAt);
      task.metrics.pausedAt = null;
    }
  }

  if (!patch.progress) return;
  const previousProcessed = task.metrics.lastProcessed ?? processedUnits(task.progress);
  const nextProcessed = processedUnits(patch.progress);
  const delta = nextProcessed - previousProcessed;
  if (delta <= 0) return;

  const lastAt = task.metrics.lastProgressAt || task.metrics.runningStartedAt || now;
  const duration = Math.max(0, now - lastAt);
  const perUnit = duration / delta;
  for (let index = 0; index < delta; index += 1) {
    task.metrics.unitDurationsMs.push(perUnit);
  }
  task.metrics.unitDurationsMs = task.metrics.unitDurationsMs.slice(-12);
  task.metrics.lastProcessed = nextProcessed;
  task.metrics.lastProgressAt = now;
}

function estimateTask(task) {
  const now = Date.now();
  const start = task.metrics.runningStartedAt || new Date(task.createdAt || task.updatedAt || now).getTime();
  const pausedMs = task.metrics.pausedMs + (task.metrics.pausedAt ? Math.max(0, now - task.metrics.pausedAt) : 0);
  const end = ["completed", "failed", "cancelled"].includes(task.status)
    ? new Date(task.updatedAt || now).getTime()
    : now;
  const elapsedMs = Math.max(0, end - start - pausedMs);
  const total = Math.max(0, task.progress?.total || 0);
  const processed = Math.min(total, processedUnits(task.progress));
  const remainingUnits = Math.max(0, total - processed);
  const recent = task.metrics.unitDurationsMs.slice(-6).filter((value) => Number.isFinite(value) && value > 0);
  const averageMs = recent.length
    ? recent.reduce((sum, value) => sum + value, 0) / recent.length
    : processed > 0
      ? elapsedMs / processed
      : null;

  return {
    elapsedMs,
    remainingMs: averageMs && remainingUnits > 0 ? Math.max(0, averageMs * remainingUnits) : remainingUnits > 0 ? null : 0,
    processed,
    total,
    sampleSize: recent.length
  };
}

function processedUnits(progress = {}) {
  return (progress.completed || 0) + (progress.failed || 0) + (progress.skipped || 0);
}

function safePayload(payload) {
  const clone = { ...payload };
  delete clone.content;
  delete clone.chapter_prompt;
  delete clone.summary_prompt;
  delete clone.output_schema;
  return clone;
}
