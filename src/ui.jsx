import {
  Clipboard,
  Database,
  Download,
  KeyRound,
  ShieldCheck
} from "lucide-react";
import { downloadJson, formatTime } from "./api.js";

export function RuntimeGrid({ config }) {
  return (
    <div className="runtime-grid">
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

export function TaskBox({ task }) {
  if (!task) return <div className="task-empty">暂无任务</div>;
  const total = task.progress?.total || 1;
  const completed = task.progress?.completed || 0;
  const percent = Math.min(100, Math.round((completed / total) * 100));
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
    queued: "排队",
    running: "运行",
    completed: "完成",
    completed_with_errors: "完成有错",
    failed: "失败",
    cancelled: "取消"
  }[status] || status;
  return <strong className={`pill ${status}`}>{label}</strong>;
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

export function ChapterTable({ chapters, selectable = false, selectedIndexes = [], onToggle }) {
  if (!chapters.length) return <div className="empty-state tall">没有章节元数据</div>;
  const selected = new Set(selectedIndexes);
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {selectable ? <th className="check-cell">选择</th> : null}
            <th>章节</th>
            <th>标题</th>
            <th>字数</th>
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

export function ResultActions({ analysis }) {
  const canUse = Boolean(analysis?.finalResult);
  return (
    <div className="action-row">
      <IconButton
        icon={Clipboard}
        label="复制"
        disabled={!canUse}
        onClick={() => navigator.clipboard?.writeText(JSON.stringify(analysis.finalResult, null, 2))}
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
