import crypto from "node:crypto";
import { sanitizeText } from "./sanitize.js";

const tasks = new Map();
const subscribers = new Map();

export function createTask(type, payload = {}) {
  const task = {
    id: crypto.randomUUID(),
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

export function publicTask(task) {
  return {
    id: task.id,
    type: task.type,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    progress: task.progress,
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
  updateTask(task, {
    status: "failed",
    error: sanitizeText(error?.message || error)
  }, "failed");
}

export function cancelTask(id) {
  const task = getTask(id);
  task.cancelled = true;
  updateTask(task, { status: "cancelled", message: "任务已请求取消。" }, "cancelled");
  return publicTask(task);
}

export function assertNotCancelled(task) {
  if (task.cancelled || task.status === "cancelled") {
    const error = new Error("任务已取消。");
    error.status = 499;
    throw error;
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

function safePayload(payload) {
  const clone = { ...payload };
  delete clone.content;
  delete clone.chapter_prompt;
  delete clone.summary_prompt;
  delete clone.output_schema;
  return clone;
}
