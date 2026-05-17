export async function apiGet(path) {
  const response = await fetch(path);
  return handleResponse(response);
}

export async function apiPost(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return handleResponse(response);
}

export async function apiPut(path, body) {
  const response = await fetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return handleResponse(response);
}

export async function apiDelete(path) {
  const response = await fetch(path, { method: "DELETE" });
  return handleResponse(response);
}

export function followTask(url, setTask, onTerminal) {
  const source = new EventSource(url);
  const handle = (event) => {
    const data = JSON.parse(event.data);
    if (!data.task) return;
    setTask(data.task);
    if (["completed", "failed", "cancelled"].includes(data.task.status)) {
      source.close();
      void onTerminal?.(data.task);
    }
  };

  source.addEventListener("snapshot", handle);
  source.addEventListener("progress", handle);
  source.addEventListener("warning", handle);
  source.addEventListener("running", handle);
  source.addEventListener("completed", handle);
  source.addEventListener("failed", handle);
  source.addEventListener("cancelled", handle);
  source.onerror = () => source.close();
  return source;
}

export function formatTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export function downloadJson(filename, value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function handleResponse(response) {
  const data = await response.json().catch(() => null);
  if (!data) {
    throw new Error(`请求没有返回 JSON：HTTP ${response.status}`);
  }
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `请求失败：HTTP ${response.status}`);
  }
  return data;
}
