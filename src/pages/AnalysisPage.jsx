import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Layers,
  Loader2,
  Plus,
  Play,
  RefreshCcw,
  Table2,
  Trash2
} from "lucide-react";
import { apiDelete, apiGet, formatTime } from "../api.js";
import { ChapterTable, IconButton, Panel, ResultActions, StatusPill, TaskBox } from "../ui.jsx";
import {
  normalizePrompt,
  outputSchemaForPrompt,
  resultColumnsFromPrompt
} from "../schemaTools.js";

const initialAnalysisForm = {
  name: "",
  book_id: "",
  start_chapter: "1",
  end_chapter: "20",
  analysis_mode: "balanced",
  source_review_budget: ""
};

export function AnalysisPage({
  books,
  config,
  prompts,
  promptGroups = [],
  l1Task,
  analysisTask,
  analysisBusy,
  onStartAnalysis,
  onResumeAnalysisRun,
  onAnalysisCancel,
  onAnalysisPause,
  onAnalysisResume,
  setError
}) {
  const [analyses, setAnalyses] = useState([]);
  const [chapters, setChapters] = useState([]);
  const [chaptersBookId, setChaptersBookId] = useState("");
  const [analysisForm, setAnalysisForm] = useState({
    ...initialAnalysisForm,
    book_id: books[0]?.book_id || ""
  });
  const [promptDraft, setPromptDraft] = useState(() => normalizePrompt(prompts));
  const defaultPrompt = useMemo(() => normalizePrompt(prompts), [prompts]);
  const [selectedPromptGroupId, setSelectedPromptGroupId] = useState("");
  const [selectedIndexes, setSelectedIndexes] = useState([]);
  const [useL1Context, setUseL1Context] = useState(false);
  const [l1Coverage, setL1Coverage] = useState(null);
  const [l2Coverage, setL2Coverage] = useState(null);
  const selectionOverrideRef = useRef(null);
  const [selectionOverrideToken, setSelectionOverrideToken] = useState(0);
  const [chaptersExpanded, setChaptersExpanded] = useState(false);
  const [selectedAnalysis, setSelectedAnalysis] = useState(null);
  const [busy, setBusy] = useState({ analysis: false, chapters: false, list: false });

  useEffect(() => {
    if (analysisTask?.result?.analysisId && selectedAnalysis?.id === analysisTask.result.analysisId) {
      void loadAnalysisResult(analysisTask.result.analysisId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisTask?.status, analysisTask?.updatedAt]);

  useEffect(() => {
    void loadAnalyses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadChapters(analysisForm.book_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisForm.book_id]);

  useEffect(() => {
    if (!analysisForm.book_id || chaptersBookId !== analysisForm.book_id) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedIndexes([]);
      return;
    }
    const startChapter = chapterNumber(analysisForm.start_chapter);
    const endChapter = chapterNumber(analysisForm.end_chapter, startChapter);
    const inRange = chapters
      .filter((chapter) => chapter.chapter_index >= startChapter && chapter.chapter_index <= endChapter)
      .map((chapter) => chapter.chapter_index);
    const selectionOverride = selectionOverrideRef.current;
    if (selectionOverride) {
      const available = new Set(inRange);
      setSelectedIndexes(selectionOverride.filter((index) => available.has(index)));
      selectionOverrideRef.current = null;
      return;
    }
    setSelectedIndexes(inRange);
  }, [chapters, chaptersBookId, analysisForm.book_id, analysisForm.start_chapter, analysisForm.end_chapter, selectionOverrideToken]);

  const selectedBook = useMemo(
    () => books.find((book) => book.book_id === analysisForm.book_id) || null,
    [books, analysisForm.book_id]
  );

  const chaptersInRange = useMemo(
    () => {
      const startChapter = chapterNumber(analysisForm.start_chapter);
      const endChapter = chapterNumber(analysisForm.end_chapter, startChapter);
      return chapters.filter((chapter) => chapter.chapter_index >= startChapter && chapter.chapter_index <= endChapter);
    },
    [chapters, analysisForm.start_chapter, analysisForm.end_chapter]
  );
  const selectedRangeSummary = useMemo(
    () => summarizeSelection(selectedIndexes, chaptersInRange.length, l1Coverage),
    [selectedIndexes, chaptersInRange.length, l1Coverage]
  );
  useEffect(() => {
    if (!analysisForm.book_id || !validChapterNumber(analysisForm.start_chapter) || !validChapterNumber(analysisForm.end_chapter)) {
      return;
    }
    void loadL1Coverage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisForm.book_id, analysisForm.start_chapter, analysisForm.end_chapter, l1Task?.id, l1Task?.status]);

  async function loadAnalyses() {
    setBusy((state) => ({ ...state, list: true }));
    setError("");
    try {
      const data = await apiGet("/api/analyses");
      setAnalyses(data.analyses || []);
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy((state) => ({ ...state, list: false }));
    }
  }

  async function loadChapters(bookId) {
    if (!bookId) {
      setChapters([]);
      setChaptersBookId("");
      return;
    }
    setBusy((state) => ({ ...state, chapters: true }));
    setError("");
    try {
      const data = await apiGet(`/api/books/${encodeURIComponent(bookId)}/chapters`);
      setChapters(data.chapters || []);
      setChaptersBookId(bookId);
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy((state) => ({ ...state, chapters: false }));
    }
  }

  async function loadL1Coverage() {
    if (!analysisForm.book_id || !validChapterNumber(analysisForm.start_chapter) || !validChapterNumber(analysisForm.end_chapter)) {
      return;
    }
    try {
      const query = `start_chapter=${encodeURIComponent(analysisForm.start_chapter)}&end_chapter=${encodeURIComponent(analysisForm.end_chapter)}`;
      const [l1Data, l2Data] = await Promise.all([
        apiGet(`/api/books/${encodeURIComponent(analysisForm.book_id)}/l1-indexes/coverage?${query}`),
        apiGet(`/api/books/${encodeURIComponent(analysisForm.book_id)}/l2-indexes/coverage?${query}`)
      ]);
      setL1Coverage(l1Data.coverage);
      setL2Coverage(l2Data.coverage);
    } catch (error) {
      setError(error.message);
    }
  }

  async function startAnalysis() {
    if (!validChapterNumber(analysisForm.start_chapter) || !validChapterNumber(analysisForm.end_chapter)) {
      setError("起始章节和结束章节必须填写为大于 0 的整数。");
      return;
    }
    const chapterIndexes = [...new Set(selectedIndexes)].sort((left, right) => left - right);
    if (!chapterIndexes.length) {
      setError("请至少选择一个已导入章节。");
      return;
    }

    setError("");
    setSelectedAnalysis(null);
    const task = await onStartAnalysis({
      ...analysisForm,
      start_chapter: Number(analysisForm.start_chapter),
      end_chapter: Number(analysisForm.end_chapter),
      chapter_indexes: chapterIndexes,
      use_l1_context: useL1Context,
      analysis_mode: analysisForm.analysis_mode,
      source_review_budget: analysisForm.source_review_budget === "" ? undefined : Number(analysisForm.source_review_budget),
      prompt: {
        ...promptDraft,
        output_schema: outputSchemaForPrompt(promptDraft)
      }
    }, {
      onTerminal: async (task) => {
        await loadAnalyses();
        if (task.result?.analysisId) await loadAnalysisResult(task.result.analysisId);
        if (task.status === "failed") setError(task.error || "分析失败");
      }
    });
    if (task?.result?.analysisId) await loadAnalysisResult(task.result.analysisId);
  }

  async function controlAnalysis(action) {
    if (!analysisTask?.id) return;
    setError("");
    if (action === "cancel") await onAnalysisCancel?.();
    if (action === "pause") await onAnalysisPause?.();
    if (action === "resume") await onAnalysisResume?.();
    if (action === "cancel") await loadAnalyses();
  }

  async function resumeSelectedAnalysis() {
    if (!selectedAnalysis?.id) return;
    setError("");
    const task = await onResumeAnalysisRun(selectedAnalysis.id, {
      onTerminal: async (finishedTask) => {
        await loadAnalyses();
        await loadAnalysisResult(selectedAnalysis.id);
        if (finishedTask.status === "failed") setError(finishedTask.error || "分析失败");
      }
    });
    if (task) await loadAnalysisResult(selectedAnalysis.id);
  }

  async function loadAnalysisResult(id) {
    setError("");
    try {
      const data = await apiGet(`/api/analyses/${encodeURIComponent(id)}`);
      setSelectedAnalysis(data.analysis);
      return data.analysis;
    } catch (error) {
      setError(error.message);
      return null;
    }
  }

  async function deleteAnalysis(id) {
    const confirmed = window.confirm("删除这条分析任务和本地加密结果？");
    if (!confirmed) return;
    setError("");
    try {
      await apiDelete(`/api/analyses/${encodeURIComponent(id)}`);
      if (selectedAnalysis?.id === id) setSelectedAnalysis(null);
      await loadAnalyses();
    } catch (error) {
      setError(error.message);
    }
  }

  async function copyAnalysis(id) {
    const analysis = await loadAnalysisResult(id);
    if (!analysis) return;
    const analysisPrompt = normalizePrompt(analysis.prompt || prompts);
    setAnalysisForm({
      ...initialAnalysisForm,
      name: `${analysis.name || "分析任务"} 复制`,
      book_id: analysis.book_id,
      start_chapter: String(analysis.start_chapter),
      end_chapter: String(analysis.end_chapter),
      analysis_mode: analysisPrompt.analysis_mode || analysis.source_stats?.analysis_mode || initialAnalysisForm.analysis_mode,
      source_review_budget: analysisPrompt.source_review_budget === undefined || analysisPrompt.source_review_budget === null
        ? ""
        : String(analysisPrompt.source_review_budget)
    });
    selectionOverrideRef.current = analysis.chapter_indexes || [];
    setSelectionOverrideToken((value) => value + 1);
    setSelectedPromptGroupId("__snapshot__");
    setPromptDraft(analysisPrompt);
  }

  function applyPromptGroup(groupId) {
    setSelectedPromptGroupId(groupId);
    const group = promptGroups.find((entry) => entry.id === groupId);
    setPromptDraft((current) => (
      group
        ? { ...current, name: group.name, summary_prompt: group.summary_prompt }
        : defaultPrompt
    ));
  }

  function updateAnalysisForm(patch) {
    setAnalysisForm((form) => ({ ...form, ...patch }));
    if (patch.book_id !== undefined || patch.start_chapter !== undefined || patch.end_chapter !== undefined) {
      setL1Coverage(null);
      setL2Coverage(null);
    }
  }

  function toggleChapter(index) {
    setSelectedIndexes((current) => (
      current.includes(index)
        ? current.filter((entry) => entry !== index)
        : [...current, index].sort((left, right) => left - right)
    ));
  }

  function selectAllInRange() {
    setSelectedIndexes(chaptersInRange.map((chapter) => chapter.chapter_index));
  }

  function clearSelection() {
    setSelectedIndexes([]);
  }

  return (
    <section className="analysis-layout">
      <aside className="task-rail">
        <Panel
          icon={Layers}
          title="分析任务"
          action={<IconButton icon={RefreshCcw} label="刷新" onClick={loadAnalyses} disabled={busy.list} />}
        >
          <AnalysisHistory
            analyses={analyses}
            books={books}
            selectedId={selectedAnalysis?.id}
            onSelect={loadAnalysisResult}
            onCopy={copyAnalysis}
            onDelete={deleteAnalysis}
          />
        </Panel>
      </aside>

      <section className="workspace">
        <Panel
          icon={Play}
          title="创建分析任务"
          action={<TaskStats book={selectedBook} selectedCount={selectedIndexes.length} totalInRange={chaptersInRange.length} />}
        >
          <div className="form-grid analysis-form-grid">
            <label>
              <span>任务名</span>
              <input
                value={analysisForm.name}
                placeholder="例如：身份形象合并"
                onChange={(event) => updateAnalysisForm({ name: event.target.value })}
              />
            </label>
            <label>
              <span>书籍</span>
              <select
                value={analysisForm.book_id}
                onChange={(event) => updateAnalysisForm({ book_id: event.target.value })}
              >
                <option value="">选择已导入书籍</option>
                {books.map((book) => (
                  <option key={book.book_id} value={book.book_id}>
                    {book.book_name ? `${book.book_name}（${book.book_id}）` : book.book_id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>起始章节</span>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={analysisForm.start_chapter}
                onChange={(event) => updateAnalysisForm({ start_chapter: sanitizeChapterInput(event.target.value) })}
              />
            </label>
            <label>
              <span>结束章节</span>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={analysisForm.end_chapter}
                onChange={(event) => updateAnalysisForm({ end_chapter: sanitizeChapterInput(event.target.value) })}
              />
            </label>
            <label>
              <span>分析模式</span>
              <select
                value={analysisForm.analysis_mode}
                onChange={(event) => updateAnalysisForm({ analysis_mode: event.target.value })}
              >
                <option value="balanced">平衡推荐</option>
                <option value="fast_index">快速探索</option>
                <option value="precision">精准复核</option>
                <option value="full_text">全文精读</option>
              </select>
            </label>
            <label>
              <span>复核预算</span>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder="默认"
                value={analysisForm.source_review_budget}
                onChange={(event) => updateAnalysisForm({ source_review_budget: sanitizeChapterInput(event.target.value) })}
                disabled={analysisForm.analysis_mode === "fast_index" || analysisForm.analysis_mode === "full_text"}
              />
            </label>
            <label>
              <span>分析 Prompt</span>
              <select value={selectedPromptGroupId} onChange={(event) => applyPromptGroup(event.target.value)}>
                <option value="">默认分析 Prompt</option>
                {selectedPromptGroupId === "__snapshot__" ? (
                  <option value="__snapshot__">历史任务 Prompt 快照</option>
                ) : null}
                {promptGroups.map((group) => (
                  <option key={group.id} value={group.id}>{group.category} · {group.name}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="draft-banner compact-banner">
            {selectedPromptGroupId === "__snapshot__"
              ? `当前任务将使用历史任务快照：${promptDraft.name || "未命名分析 Prompt"}。如需修改，请到 Prompt 库维护后重新选择。`
              : selectedPromptGroupId
              ? `当前任务将使用：${promptDraft.name || "未命名分析 Prompt"}。Prompt 内容请在 Prompt 库维护。`
              : "当前任务将使用默认分析 Prompt。Prompt 内容请在 Prompt 库维护。"}
          </div>

          <div className="selector-card">
            <button
              type="button"
              className="selector-summary"
              onClick={() => setChaptersExpanded((value) => !value)}
            >
              <span className="selector-summary-title">
                {chaptersExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                章节选择
              </span>
              <span>{selectedRangeSummary}</span>
            </button>

            {chaptersExpanded ? (
              <>
                <div className="selector-toolbar">
                  <div>
                    <strong>{selectedIndexes.length}</strong>
                    <span> / {chaptersInRange.length} 章已选择</span>
                  </div>
                  <div className="action-row">
                    <IconButton icon={Plus} label="全选范围" onClick={selectAllInRange} disabled={!chaptersInRange.length} />
                    <IconButton icon={Trash2} label="清空" onClick={clearSelection} disabled={!selectedIndexes.length} />
                  </div>
                </div>

                <ChapterTable
                  chapters={chaptersInRange}
                  selectable
                  selectedIndexes={selectedIndexes}
                  onToggle={toggleChapter}
                />
              </>
            ) : null}
          </div>
          <label className="check-row l1-context-row">
            <input
              type="checkbox"
              checked={useL1Context}
              onChange={(event) => setUseL1Context(event.target.checked)}
            />
            <span>附加 L1 上下文</span>
            <small>{formatCoverage(l1Coverage)}</small>
          </label>
          <div className="index-route-note">
            {analysisRouteNote(analysisForm.analysis_mode, l2Coverage, selectedIndexes.length, analysisForm.source_review_budget)}
          </div>
        </Panel>

        <div className="run-section">
          <Panel icon={Play} title="运行">
            <button
              className="primary"
              type="button"
              onClick={startAnalysis}
              disabled={analysisBusy || !config.openaiConfigured || !config.retentionConfirmed || !analysisForm.book_id || !selectedIndexes.length}
            >
              {analysisBusy ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
              {analysisBusy ? "分析中" : "开始分析"}
            </button>
            <TaskBox
              task={analysisTask}
              onCancel={() => controlAnalysis("cancel")}
              onPause={() => controlAnalysis("pause")}
              onResume={() => controlAnalysis("resume")}
            />
          </Panel>
        </div>

        <Panel
          icon={Table2}
          title="最终结果"
          action={<ResultActions analysis={selectedAnalysis} />}
        >
          <ResultView
            analysis={selectedAnalysis}
            analysisBusy={analysisBusy}
            onResume={resumeSelectedAnalysis}
          />
        </Panel>
      </section>
    </section>
  );
}

function TaskStats({ book, selectedCount, totalInRange }) {
  return (
    <div className="stats">
      <span>{book?.chapter_count || 0} 章已入库</span>
      <span>{selectedCount}/{totalInRange} 已选</span>
    </div>
  );
}

function chapterNumber(value, fallback = 1) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function validChapterNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0;
}

function sanitizeChapterInput(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.replace(/^0+(?=\d)/, "").replace(/^0$/, "");
}

function formatCoverage(coverage) {
  if (!coverage) return "L1 覆盖率读取中";
  return `章节 ${coverage.chapters.completed}/${coverage.chapters.total}`;
}

function analysisRouteNote(mode, coverage, selectedCount, budget) {
  if (mode === "full_text") return "全文精读会逐章读取原文，适合小范围高保真分析。";
  if (mode === "fast_index") return `快速探索只使用 L2 索引；当前覆盖 ${coverageText(coverage)}。`;
  const defaultBudget = mode === "precision"
    ? Math.min(30, Math.max(5, Math.ceil(selectedCount * 0.03)))
    : Math.min(10, Math.max(3, Math.ceil(selectedCount * 0.01)));
  const reviewBudget = budget === "" ? defaultBudget : Number(budget || 0);
  const label = mode === "precision" ? "精准复核" : "平衡推荐";
  return `${label}会先召回 L2 事实，最多复核 ${reviewBudget} 章原文；当前 L2 覆盖 ${coverageText(coverage)}。`;
}

function coverageText(coverage) {
  if (!coverage?.chapters) return "读取中";
  return `${coverage.chapters.completed}/${coverage.chapters.total} 章，${coverage.chapters.facts || 0} 条事实`;
}

function summarizeSelection(selectedIndexes, totalInRange, coverage) {
  const selected = selectedIndexes.length;
  const selectedText = `${selected}/${totalInRange} 章已选`;
  if (!coverage?.chapters) return selectedText;
  const missing = coverage.chapters.missing || 0;
  const failed = coverage.chapters.failed || 0;
  const suffix = missing || failed ? `L1 缺失 ${missing} · 失败 ${failed}` : "L1 已覆盖";
  return `${selectedText} · ${suffix}`;
}

function AnalysisHistory({ analyses, books, selectedId, onSelect, onCopy, onDelete }) {
  if (!analyses.length) return <div className="history-empty">暂无分析任务</div>;
  const bookNames = new Map(books.map((book) => [book.book_id, book.book_name || book.book_id]));
  return (
    <div className="analysis-list expanded">
      {analyses.map((analysis) => (
        <div key={analysis.id} className={analysis.id === selectedId ? "analysis-record active" : "analysis-record"}>
          <button type="button" className="analysis-main" onClick={() => onSelect(analysis.id)}>
            <strong>{analysis.name || "未命名任务"}</strong>
            <span>{bookNames.get(analysis.book_id) || analysis.book_id} · {analysis.start_chapter}-{analysis.end_chapter} · {analysis.chapter_count} 章</span>
            <small>{formatTime(analysis.updated_at)}</small>
          </button>
          <div className="analysis-actions">
            <StatusPill status={analysis.status} />
            <button type="button" className="icon-only" onClick={() => onCopy(analysis.id)} title="复制配置">
              <Copy size={15} />
            </button>
            <button type="button" className="icon-only danger-icon" onClick={() => onDelete(analysis.id)} title="删除任务">
              <Trash2 size={15} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function ResultView({ analysis, analysisBusy, onResume }) {
  if (!analysis) return <div className="empty-state tall">选择一个分析任务查看结果</div>;
  if (!analysis.finalResult) {
    return <PartialResultView analysis={analysis} analysisBusy={analysisBusy} onResume={onResume} />;
  }
  if (typeof analysis.finalResult === "string") {
    return (
      <div className="result-stack">
        <SourceStats stats={analysis.source_stats} />
        <TextPreview value={analysis.finalResult} />
      </div>
    );
  }
  const columns = resultColumnsFromPrompt(null, analysis.finalResult);
  const rows = Array.isArray(analysis.finalResult.items) ? analysis.finalResult.items : [];

  if (rows.length && columns.length) {
    return (
      <div className="result-stack">
        <SourceStats stats={analysis.source_stats} />
        <div className="result-summary">
          <h3>{analysis.finalResult.title || analysis.name}</h3>
          <p>{analysis.finalResult.summary || ""}</p>
        </div>
        <div className="table-wrap result-table">
          <table>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column.key}>{column.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  {columns.map((column) => (
                    <td key={column.key}>{formatCell(row?.[column.key])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {analysis.finalResult.failed_chapters?.length ? (
          <div className="inline-warning">
            <FileText size={15} />
            失败章节：{analysis.finalResult.failed_chapters.join(", ")}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="result-stack">
      <SourceStats stats={analysis.source_stats} />
      <JsonPreview value={analysis.finalResult} />
    </div>
  );
}

function SourceStats({ stats }) {
  if (!stats) return null;
  const modeLabel = {
    fast_index: "快速探索",
    balanced: "平衡推荐",
    precision: "精准复核",
    full_text: "全文精读"
  }[stats.analysis_mode] || stats.analysis_mode || "未知模式";
  return (
    <div className="source-stats">
      <span>{modeLabel}</span>
      <span>召回事实 {Number(stats.recalled_facts || 0)} 条</span>
      <span>涉及章节 {Number(stats.recalled_chapters || 0)} 章</span>
      <span>原文复核 {Number(stats.source_review_chapters || 0)}/{Number(stats.source_review_budget || 0)} 章</span>
      {stats.missing_chapters?.length ? <span>索引缺口 {stats.missing_chapters.length} 章</span> : null}
    </div>
  );
}

function PartialResultView({ analysis, analysisBusy, onResume }) {
  const completed = analysis.chapterResults || [];
  const failed = analysis.failedChapterIndexes || [];
  const pending = analysis.pendingChapterIndexes || [];
  return (
    <div className="partial-result-stack">
      <div className="partial-result-header">
        <div>
          <h3>任务尚未生成最终结果</h3>
          <p>
            已完成 {completed.length} 章
            {failed.length ? ` · 失败 ${failed.length} 章` : ""}
            {pending.length ? ` · 待续跑 ${pending.length} 章` : ""}
          </p>
        </div>
        {analysis.canResume ? (
          <button className="secondary" type="button" onClick={onResume} disabled={analysisBusy}>
            {analysisBusy ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
            继续分析
          </button>
        ) : null}
      </div>

      {failed.length ? (
        <div className="inline-warning">
          <FileText size={15} />
          失败章节：{failed.join(", ")}
        </div>
      ) : null}
      {pending.length ? (
        <div className="muted-line">待续跑章节：{compactIndexes(pending)}</div>
      ) : null}

      {completed.length ? (
        <div className="partial-chapter-list">
          {completed.map((entry) => (
            <details key={entry.chapter_index} className="partial-chapter-item">
              <summary>
                第 {entry.chapter_index} 章
                {entry.result?.chapter_title ? ` · ${entry.result.chapter_title}` : ""}
              </summary>
              {entry.result?.summary ? <p>{entry.result.summary}</p> : null}
              <JsonPreview value={entry.result} />
            </details>
          ))}
        </div>
      ) : (
        <div className="empty-state tall">还没有可展示的逐章分析结果</div>
      )}
    </div>
  );
}

function JsonPreview({ value }) {
  return <pre className="json-preview">{JSON.stringify(value, null, 2)}</pre>;
}

function TextPreview({ value }) {
  return <pre className="text-preview">{value}</pre>;
}

function formatCell(value) {
  if (Array.isArray(value)) return value.join(", ");
  if (value && typeof value === "object") return JSON.stringify(value);
  if (value === undefined || value === null || value === "") return "-";
  return String(value);
}

function compactIndexes(indexes) {
  const values = (indexes || []).slice(0, 40);
  const suffix = indexes.length > values.length ? ` 等 ${indexes.length} 章` : "";
  return `${values.join(", ")}${suffix}`;
}
