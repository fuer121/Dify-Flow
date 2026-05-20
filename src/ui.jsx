import {
  Clipboard,
  Database,
  Download,
  KeyRound,
  Monitor,
  Pause,
  Play,
  ShieldCheck
} from "lucide-react";
import { useEffect, useState } from "react";
import { downloadJson, formatTime } from "./api.js";

export function RuntimeGrid({ config }) {
  return (
    <div className="runtime-grid">
      {config.isPreview ? (
        <RuntimeItem
          icon={Monitor}
          label="环境"
          ok
          value={`${config.appLabel || "本机预览"} · 数据副本`}
        />
      ) : null}
      <RuntimeItem icon={Database} label="Dify" ok={config.difyConfigured} value={config.difyBase || "未配置"} />
      <RuntimeItem
        icon={KeyRound}
        label="OpenAI"
        ok={config.openaiConfigured && config.retentionConfirmed}
        value={`${config.openaiModel} · ${config.openaiRetentionMode}`}
      />
      <RuntimeItem
        icon={ShieldCheck}
        label="Retention"
        ok={config.retentionConfirmed}
        value={config.retentionConfirmed ? "ZDR/MAM 已确认" : "未确认"}
      />
    </div>
  );
}

export function RuntimeItem({ icon: Icon, label, value, ok }) {
  return (
    <div className="runtime-item">
      <Icon size={15} />
      <span>{label}</span>
      <strong className={ok ? "ok" : "bad"}>{value}</strong>
    </div>
  );
}

export function Panel({ icon: Icon, title, action, children, className = "" }) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-head">
        <div className="panel-title">
          <Icon size={18} />
          <h2>{title}</h2>
        </div>
        {action ? <div className="panel-action">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function IconButton({ icon: Icon, label, onClick, disabled, className = "ghost", title }) {
  return (
    <button className={className} type="button" onClick={onClick} disabled={disabled} title={title || label}>
      <Icon size={15} />
      {label}
    </button>
  );
}

export function TaskBox({ task, onCancel, onPause, onResume }) {
  const [now, setNow] = useState(() => Date.now());
  const live = Boolean(task && ["queued", "running", "paused"].includes(task.status));

  useEffect(() => {
    if (!live) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live, task?.id]);

  if (!task) return <div className="task-empty">暂无任务</div>;
  const total = task.progress?.total || 1;
  const completed = task.progress?.completed || 0;
  const processed = completed + (task.progress?.failed || 0) + (task.progress?.skipped || 0);
  const percent = Math.min(100, Math.round((processed / total) * 100));
  const timing = taskTiming(task, now);
  const canControl = ["queued", "running", "paused"].includes(task.status);
  const isPaused = task.status === "paused";
  return (
    <div className="task-box">
      <div className="task-top">
        <StatusPill status={task.status} />
        <span>{task.progress?.current || task.status}</span>
      </div>
      <div className="progress">
        <span style={{ width: `${percent}%` }} />
      </div>
      <div className="task-meta">
        <span>完成 {completed}/{total}</span>
        <span>失败 {task.progress?.failed || 0}</span>
        <span>跳过 {task.progress?.skipped || 0}</span>
      </div>
      <div className="task-time">
        <span>已进行 {timing.elapsed}</span>
        <span>预计剩余 {timing.remaining}</span>
      </div>
      {canControl && (onCancel || onPause || onResume) ? (
        <div className="task-controls">
          {isPaused ? (
            <IconButton icon={Play} label="继续" onClick={onResume} disabled={!onResume} />
          ) : (
            <IconButton icon={Pause} label="暂停" onClick={onPause} disabled={!onPause} />
          )}
          <button className="danger inline" type="button" onClick={onCancel} disabled={!onCancel}>
            取消任务
          </button>
        </div>
      ) : null}
      <div className="event-list">
        {(task.events || []).slice(-5).reverse().map((event, index) => (
          <div className="event-row" key={`${event.time}-${index}`}>
            <span>{formatTime(event.time)}</span>
            <p>{event.message}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function StatusPill({ status }) {
  const label = {
    idle: "空闲",
    queued: "排队",
    running: "运行",
    paused: "暂停",
    completed: "完成",
    completed_with_errors: "完成有错",
    failed: "失败",
    cancelled: "取消"
  }[status] || status;
  return <strong className={`pill ${status}`}>{label}</strong>;
}

function taskTiming(task, now) {
  const estimate = task.estimate;
  const elapsedMs = Number.isFinite(estimate?.elapsedMs)
    ? estimate.elapsedMs
    : fallbackElapsedMs(task, now);
  const remainingMs = Number.isFinite(estimate?.remainingMs)
    ? estimate.remainingMs
    : estimate?.remainingMs === null
      ? null
      : fallbackRemainingMs(task, elapsedMs);
  return {
    elapsed: formatDuration(elapsedMs),
    remaining: remainingMs === null ? "估算中" : formatDuration(remainingMs)
  };
}

function fallbackElapsedMs(task, now) {
  const start = new Date(task.createdAt || task.updatedAt || now).getTime();
  const end = ["completed", "failed", "cancelled"].includes(task.status)
    ? new Date(task.updatedAt || now).getTime()
    : now;
  return Math.max(0, end - start);
}

function fallbackRemainingMs(task, elapsedMs) {
  const total = Math.max(0, task.progress?.total || 0);
  const processed = Math.min(total, (task.progress?.completed || 0) + (task.progress?.failed || 0) + (task.progress?.skipped || 0));
  if (processed > 0 && total > processed) return Math.max(0, (elapsedMs / processed) * (total - processed));
  return total > processed && ["queued", "running", "paused"].includes(task.status) ? null : 0;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}小时${String(minutes).padStart(2, "0")}分`;
  if (minutes) return `${minutes}分${String(seconds).padStart(2, "0")}秒`;
  return `${seconds}秒`;
}

export function BookList({ books, selectedBookId, onSelect }) {
  if (!books.length) return <div className="empty-state">暂无书籍</div>;
  return (
    <div className="book-list">
      {books.map((book) => (
        <button
          key={book.book_id}
          type="button"
          className={book.book_id === selectedBookId ? "book-item active" : "book-item"}
          onClick={() => onSelect(book.book_id)}
        >
          <strong>{book.book_name || book.book_id}</strong>
          <span>{book.book_id} · {book.chapter_count || 0} 章 · {book.first_chapter || "-"}-{book.last_chapter || "-"}</span>
        </button>
      ))}
    </div>
  );
}

export function ChapterTable({ chapters, selectable = false, selectedIndexes = [], onToggle, l1ByChapter, l1Range }) {
  if (!chapters.length) return <div className="empty-state tall">没有章节元数据</div>;
  const selected = new Set(selectedIndexes);
  const showL1 = Boolean(l1ByChapter);
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {selectable ? <th className="check-cell">选择</th> : null}
            <th>章节</th>
            <th>标题</th>
            <th>字数</th>
            {showL1 ? <th>L1</th> : null}
            <th>HMAC</th>
            <th>状态</th>
            <th>保存时间</th>
          </tr>
        </thead>
        <tbody>
          {chapters.map((chapter) => (
            <tr key={chapter.chapter_index} className={selected.has(chapter.chapter_index) ? "selected-row" : ""}>
              {selectable ? (
                <td className="check-cell">
                  <input
                    type="checkbox"
                    checked={selected.has(chapter.chapter_index)}
                    onChange={() => onToggle?.(chapter.chapter_index)}
                  />
                </td>
              ) : null}
              <td>{chapter.chapter_index}</td>
              <td>{chapter.title || "-"}</td>
              <td>{chapter.content_length}</td>
              {showL1 ? <td><L1Cell index={l1ByChapter.get(chapter.chapter_index)} chapterIndex={chapter.chapter_index} range={l1Range} /></td> : null}
              <td><code>{String(chapter.content_hmac || "").slice(0, 16)}...</code></td>
              <td>{chapter.fetch_status}</td>
              <td>{formatTime(chapter.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function L1Cell({ index, chapterIndex, range }) {
  if (range && (chapterIndex < range.start || chapterIndex > range.end)) {
    return <span className="mini-status unread">未读取</span>;
  }
  if (!index) return <span className="mini-status missing">缺失</span>;
  const label = {
    completed: "完成",
    failed: "失败",
    outdated: "过期"
  }[index.status] || index.status;
  return <span className={`mini-status ${index.status}`}>{label}</span>;
}

export function ResultActions({ analysis }) {
  const canUse = analysis?.finalResult !== undefined && analysis?.finalResult !== null && analysis?.finalResult !== "";
  return (
    <div className="action-row">
      <IconButton
        icon={Clipboard}
        label="复制"
        disabled={!canUse}
        onClick={() => navigator.clipboard?.writeText(formatResultForClipboard(analysis.finalResult))}
      />
      <IconButton
        icon={Download}
        label="下载"
        disabled={!canUse}
        onClick={() => downloadJson(`analysis-${analysis.id}.json`, analysis.finalResult)}
      />
    </div>
  );
}

function formatResultForClipboard(value) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function LoadingScreen() {
  return (
    <main className="boot">
      <div className="boot-card" aria-label="正在加载安全章节库">
        <div className="skeleton-line wide" />
        <div className="skeleton-line" />
        <div className="skeleton-grid">
          <span />
          <span />
          <span />
        </div>
      </div>
    </main>
  );
}
