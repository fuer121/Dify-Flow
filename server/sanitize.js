export function sanitizeError(error) {
  return {
    message: sanitizeText(error?.message || "服务器错误"),
    code: error?.code,
    status: error?.status || 500,
    details: sanitizeDetails(error?.details)
  };
}

export function sanitizeText(value) {
  return String(value || "")
    .replace(/(app-|sk-|cg_)[A-Za-z0-9_*.-]+/g, "$1***")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***")
    .slice(0, 1200);
}

export function sanitizeDetails(value) {
  if (!value) return undefined;
  try {
    return JSON.parse(sanitizeText(JSON.stringify(value)));
  } catch {
    return sanitizeText(value);
  }
}

export function chapterRef(chapter) {
  if (!chapter) return "unknown";
  if (typeof chapter === "number") return `chapter:${chapter}`;
  return `chapter:${chapter.chapter_index ?? chapter.chapterIndex ?? "unknown"}`;
}
