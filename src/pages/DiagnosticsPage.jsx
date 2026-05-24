import { Activity, Database, HardDrive, RefreshCcw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet, formatTime } from "../api.js";
import { IconButton, Panel, StatusPill } from "../ui.jsx";

export function DiagnosticsPage({ config, setError }) {
  const [diagnostics, setDiagnostics] = useState(null);
  const [busy, setBusy] = useState(false);

  const loadDiagnostics = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const data = await apiGet("/api/diagnostics");
      setDiagnostics(data);
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }, [setError]);

  useEffect(() => {
    let cancelled = false;
    async function loadInitialDiagnostics() {
      try {
        const data = await apiGet("/api/diagnostics");
        if (!cancelled) setDiagnostics(data);
      } catch (error) {
        if (!cancelled) setError(error.message);
      }
    }
    void loadInitialDiagnostics();
    return () => {
      cancelled = true;
    };
  }, [setError]);

  const runtime = useMemo(() => diagnostics?.runtime || config || {}, [diagnostics?.runtime, config]);
  const database = diagnostics?.database || {};
  const tasks = diagnostics?.tasks || {};
  const books = database.books || [];
  const totals = database.totals || {};
  const l1Status = database.statuses?.l1 || {};
  const l2Status = database.statuses?.l2 || {};
  const analysisStatus = database.statuses?.analyses || {};

  const healthItems = useMemo(() => [
    { label: "Dify", ok: Boolean(runtime.difyConfigured), value: runtime.difyConfigured ? "已配置" : "未配置" },
    { label: "OpenAI", ok: Boolean(runtime.openaiConfigured), value: runtime.openaiModel || "未配置" },
    { label: "留存模式", ok: Boolean(runtime.retentionConfirmed), value: runtime.openaiRetentionMode || "unset" },
    { label: "任务", ok: Number(tasks.live || 0) === 0, value: Number(tasks.live || 0) ? `${tasks.live} 个运行中` : "空闲" }
  ], [runtime, tasks.live]);

  return (
    <section className="diagnostics-layout">
      <Panel
        icon={ShieldCheck}
        title="系统诊断"
        action={<IconButton icon={RefreshCcw} label="刷新" onClick={loadDiagnostics} disabled={busy} />}
      >
        <div className="diagnostic-hero">
          {healthItems.map((item) => (
            <div className="diagnostic-health-card" key={item.label}>
              <span>{item.label}</span>
              <strong className={item.ok ? "ok" : "bad"}>{item.value}</strong>
            </div>
          ))}
        </div>
        <p className="diagnostic-note">
          只展示运行和索引元数据，不展示密钥、章节正文、L1 内容、L2 加密事实正文或 Prompt 密文。
        </p>
      </Panel>

      <div className="diagnostics-grid">
        <Panel icon={Database} title="数据规模">
          <div className="diagnostic-metrics">
            <Metric label="书籍" value={totals.books} />
            <Metric label="章节" value={totals.chapters} />
            <Metric label="L1" value={totals.l1_indexes} />
            <Metric label="L2 章节" value={totals.l2_chapter_statuses} />
            <Metric label="L2 事实" value={totals.l2_facts} />
            <Metric label="分析" value={totals.analyses} />
            <Metric label="Prompt" value={totals.prompt_groups} />
            <Metric label="汇总分块" value={totals.summary_parts} />
          </div>
        </Panel>

        <Panel icon={Activity} title="状态分布">
          <div className="diagnostic-status-grid">
            <StatusGroup title="L1 索引" values={l1Status} />
            <StatusGroup title="L2 索引" values={l2Status} />
            <StatusGroup title="分析任务" values={analysisStatus} />
            <StatusGroup title="内存任务" values={tasks.by_status || {}} />
          </div>
        </Panel>
      </div>

      <Panel icon={HardDrive} title="存储与任务">
        <div className="diagnostic-storage">
          <span>数据库：{formatBytes(database.storage?.db_file_bytes || 0)}</span>
          <span>更新时间：{formatTime(database.storage?.db_updated_at)}</span>
          <span>数据目录：{runtime.dataDir || "-"}</span>
        </div>
        {tasks.recent?.length ? (
          <div className="table-wrap diagnostic-table">
            <table>
              <thead>
                <tr>
                  <th>类型</th>
                  <th>状态</th>
                  <th>进度</th>
                  <th>更新时间</th>
                  <th>错误</th>
                </tr>
              </thead>
              <tbody>
                {tasks.recent.map((task) => (
                  <tr key={task.id}>
                    <td>{taskTypeLabel(task.type)}</td>
                    <td><StatusPill status={task.status} /></td>
                    <td>{taskProgressText(task.progress)}</td>
                    <td>{formatTime(task.updatedAt)}</td>
                    <td>{task.error || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">暂无内存任务</div>
        )}
      </Panel>

      <Panel icon={Database} title="书籍索引概览">
        {books.length ? (
          <div className="table-wrap diagnostic-table">
            <table>
              <thead>
                <tr>
                  <th>书籍</th>
                  <th>章节</th>
                  <th>L1 完成</th>
                  <th>L2 完成</th>
                  <th>L2 事实</th>
                  <th>分析</th>
                  <th>Prompt</th>
                  <th>更新</th>
                </tr>
              </thead>
              <tbody>
                {books.map((book) => (
                  <tr key={book.book_id}>
                    <td>
                      <strong>{book.book_name || book.book_id}</strong>
                      <span className="muted-cell">{book.book_id}</span>
                    </td>
                    <td>{book.chapter_count || 0}</td>
                    <td>{statusCount(book.l1, "completed")}</td>
                    <td>{statusCount(book.l2, "completed")}</td>
                    <td>{book.l2_facts || 0}</td>
                    <td>{statusCount(book.analyses, "completed")}/{sumCounts(book.analyses)}</td>
                    <td>{book.prompt_groups || 0}</td>
                    <td>{formatTime(book.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">暂无书籍</div>
        )}
      </Panel>
    </section>
  );
}

function Metric({ label, value }) {
  return (
    <div className="diagnostic-metric">
      <span>{label}</span>
      <strong>{Number(value || 0).toLocaleString("zh-CN")}</strong>
    </div>
  );
}

function StatusGroup({ title, values }) {
  const entries = Object.entries(values || {}).filter(([, count]) => Number(count || 0) > 0);
  return (
    <div className="diagnostic-status-group">
      <strong>{title}</strong>
      {entries.length ? entries.map(([status, count]) => (
        <span key={status}>{statusLabel(status)} {Number(count || 0)}</span>
      )) : <span>无记录</span>}
    </div>
  );
}

function taskProgressText(progress = {}) {
  const total = Number(progress.total || 0);
  const done = Number(progress.completed || 0) + Number(progress.failed || 0) + Number(progress.skipped || 0);
  return total ? `${done}/${total} · ${progress.current || ""}` : progress.current || "-";
}

function statusCount(values, key) {
  return Number(values?.[key] || 0);
}

function sumCounts(values = {}) {
  return Object.values(values || {}).reduce((sum, value) => sum + Number(value || 0), 0);
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function taskTypeLabel(value) {
  return {
    import: "导入",
    "l1-index": "L1",
    "l2-index": "L2",
    analysis: "分析"
  }[value] || value;
}

function statusLabel(value) {
  return {
    completed: "完成",
    failed: "失败",
    missing: "缺失",
    outdated: "过期",
    queued: "排队",
    running: "运行",
    paused: "暂停",
    cancelled: "取消"
  }[value] || value;
}
