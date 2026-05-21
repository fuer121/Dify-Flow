import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  Database,
  Layers,
  Loader2,
  Play,
  RefreshCcw,
  Trash2
} from "lucide-react";
import { apiGet, apiPost, formatTime } from "../api.js";
import { IconButton, Panel, StatusPill, TaskBox } from "../ui.jsx";

const initialImportForm = {
  book_id: "",
  book_name: "",
  start_chapter: "1",
  end_chapter: "100",
  force: false
};

const L2_CATEGORIES = [
  { value: "character", label: "人物" },
  { value: "relationship", label: "关系" },
  { value: "cultivation", label: "境界" },
  { value: "force", label: "势力" },
  { value: "item", label: "物品" },
  { value: "location", label: "地点" },
  { value: "event", label: "事件" },
  { value: "foreshadowing", label: "伏笔" },
  { value: "other", label: "其他" }
];

export function LibraryPage({
  books,
  config,
  importTask,
  importBusy,
  l1Task,
  l1Busy,
  l2Task,
  l2Busy,
  onStartImport,
  onStartL1Index,
  onStartL2Index,
  onImportCancel,
  onImportPause,
  onImportResume,
  onL1Cancel,
  onL1Pause,
  onL1Resume,
  onL2Cancel,
  onL2Pause,
  onL2Resume,
  onBooksChanged,
  setError
}) {
  const initialBookId = importTask?.payload?.bookId || books[0]?.book_id || "";
  const [selectedBookId, setSelectedBookId] = useState(initialBookId);
  const [l1Coverage, setL1Coverage] = useState(null);
  const [l1Chapters, setL1Chapters] = useState([]);
  const [l2Coverage, setL2Coverage] = useState(null);
  const [l2Facts, setL2Facts] = useState([]);
  const [importForm, setImportForm] = useState({
    ...initialImportForm,
    book_id: initialBookId,
    auto_l1_index: false
  });
  const [l1Form, setL1Form] = useState({ start_chapter: "1", end_chapter: "100", force: false });
  const [l2Form, setL2Form] = useState({ start_chapter: "1", end_chapter: "100", force: false, mode: "all", category: "" });

  const loadL1Data = useCallback(async (bookId, startChapter, endChapter) => {
    if (!validChapterNumber(startChapter) || !validChapterNumber(endChapter)) return;
    try {
      const query = `start_chapter=${encodeURIComponent(startChapter)}&end_chapter=${encodeURIComponent(endChapter)}`;
      const [coverageData, chaptersData] = await Promise.all([
        apiGet(`/api/books/${encodeURIComponent(bookId)}/l1-indexes/coverage?${query}`),
        apiGet(`/api/books/${encodeURIComponent(bookId)}/l1-indexes/chapters?${query}`)
      ]);
      setL1Coverage(coverageData.coverage);
      setL1Chapters(chaptersData.chapters || []);
    } catch (error) {
      setError(error.message);
    }
  }, [setError]);

  const loadL2Data = useCallback(async (bookId, startChapter, endChapter, category = "") => {
    if (!validChapterNumber(startChapter) || !validChapterNumber(endChapter)) return;
    try {
      const query = `start_chapter=${encodeURIComponent(startChapter)}&end_chapter=${encodeURIComponent(endChapter)}&category=${encodeURIComponent(category)}&limit=80`;
      const [coverageData, factsData] = await Promise.all([
        apiGet(`/api/books/${encodeURIComponent(bookId)}/l2-indexes/coverage?${query}`),
        apiGet(`/api/books/${encodeURIComponent(bookId)}/l2-facts?${query}`)
      ]);
      setL2Coverage(coverageData.coverage);
      setL2Facts(factsData.facts || []);
    } catch (error) {
      setError(error.message);
    }
  }, [setError]);

  async function loadChapters(bookId) {
    if (!bookId) {
      return;
    }
    setError("");
    try {
      const data = await apiGet(`/api/books/${encodeURIComponent(bookId)}/chapters`);
      const first = data.chapters?.[0]?.chapter_index || 1;
      const last = data.chapters?.[data.chapters.length - 1]?.chapter_index || 100;
      setL1Form((form) => ({ ...form, start_chapter: String(first), end_chapter: String(last) }));
      setL2Form((form) => ({ ...form, start_chapter: String(first), end_chapter: String(last) }));
    } catch (error) {
      setError(error.message);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadChapters(selectedBookId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBookId]);

  useEffect(() => {
    const taskBookId = importTask?.payload?.bookId;
    if (!taskBookId || taskBookId !== selectedBookId || importTask?.status !== "completed") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadChapters(taskBookId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importTask?.id, importTask?.status, selectedBookId]);

  useEffect(() => {
    if (!selectedBookId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadL1Data(selectedBookId, l1Form.start_chapter, l1Form.end_chapter);
  }, [selectedBookId, l1Form.start_chapter, l1Form.end_chapter, l1Task?.id, l1Task?.status, loadL1Data]);

  useEffect(() => {
    if (!selectedBookId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadL2Data(selectedBookId, l2Form.start_chapter, l2Form.end_chapter, l2Form.category);
  }, [selectedBookId, l2Form.start_chapter, l2Form.end_chapter, l2Form.category, l2Task?.id, l2Task?.status, loadL2Data]);

  const selectedBook = useMemo(
    () => books.find((book) => book.book_id === selectedBookId) || null,
    [books, selectedBookId]
  );
  const boundBook = useMemo(
    () => books.find((book) => book.book_id === importForm.book_id.trim()) || null,
    [books, importForm.book_id]
  );

  async function startImport() {
    if (!validChapterNumber(importForm.start_chapter) || !validChapterNumber(importForm.end_chapter)) {
      setError("起始章节和结束章节必须填写为大于 0 的整数。");
      return;
    }
    const task = await onStartImport({
      ...importForm,
      start_chapter: Number(importForm.start_chapter),
      end_chapter: Number(importForm.end_chapter),
      auto_l1_index: Boolean(importForm.auto_l1_index)
    });
    const taskBookId = task?.payload?.bookId || importForm.book_id;
    if (taskBookId) setSelectedBookId(taskBookId);
  }

  async function startL1Index() {
    if (!selectedBookId) {
      setError("请先选择一本书。");
      return;
    }
    if (!validChapterNumber(l1Form.start_chapter) || !validChapterNumber(l1Form.end_chapter)) {
      setError("L1 起始章节和结束章节必须填写为大于 0 的整数。");
      return;
    }
    await onStartL1Index({
      bookId: selectedBookId,
      startChapter: Number(l1Form.start_chapter),
      endChapter: Number(l1Form.end_chapter),
      force: l1Form.force
    });
  }

  async function startL2Index(modeOverride) {
    if (!selectedBookId) {
      setError("请先选择一本书。");
      return;
    }
    if (!validChapterNumber(l2Form.start_chapter) || !validChapterNumber(l2Form.end_chapter)) {
      setError("L2 起始章节和结束章节必须填写为大于 0 的整数。");
      return;
    }
    await onStartL2Index({
      bookId: selectedBookId,
      startChapter: Number(l2Form.start_chapter),
      endChapter: Number(l2Form.end_chapter),
      force: l2Form.force,
      mode: modeOverride || l2Form.mode
    });
  }

  async function deleteSelectedBook() {
    if (!selectedBookId) return;
    const label = selectedBook?.book_name || selectedBookId;
    const confirmed = window.confirm(`删除本地加密章节库中的《${label}》？`);
    if (!confirmed) return;
    setError("");
    try {
      await apiPost(`/api/books/${encodeURIComponent(selectedBookId)}/delete`, {});
      setSelectedBookId("");
      await onBooksChanged();
    } catch (error) {
      setError(error.message);
    }
  }

  function selectBook(bookId) {
    const book = books.find((entry) => entry.book_id === bookId);
    setSelectedBookId(bookId);
    setImportForm((form) => ({ ...form, book_id: bookId, book_name: book?.book_name || "" }));
  }

  function updateBookId(bookId) {
    const book = books.find((entry) => entry.book_id === bookId.trim());
    setImportForm({
      ...importForm,
      book_id: bookId,
      book_name: book?.book_name || ""
    });
  }

  function openPromptManager(section = "index") {
    if (!selectedBookId) return;
    window.history.pushState({}, "", `/prompts?book_id=${encodeURIComponent(selectedBookId)}&section=${encodeURIComponent(section)}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  return (
    <section className="library-layout library-layout-single">
      <div className="library-management-grid">
        <Panel
          className="library-directory-panel"
          icon={Database}
          title="本地书库"
          action={<IconButton icon={RefreshCcw} label="刷新" onClick={onBooksChanged} />}
        >
          <LibraryDirectory
            books={books}
            selectedBookId={selectedBookId}
            onSelect={selectBook}
            onDeleteSelected={deleteSelectedBook}
          />
        </Panel>
        <Panel
          className="library-import-panel"
          icon={BookOpen}
          title="全书导入"
        >
          <div className="form-grid import-form-grid">
            <label>
              <span>书籍名称</span>
              <input
                value={boundBook?.book_name || importForm.book_name}
                disabled={Boolean(boundBook?.book_name)}
                placeholder="例如：凡人修仙传"
                onChange={(event) => setImportForm({ ...importForm, book_name: event.target.value })}
              />
            </label>
            <label>
              <span>小说 ID</span>
              <input
                value={importForm.book_id}
                onChange={(event) => updateBookId(event.target.value)}
              />
            </label>
            <label>
              <span>起始章节</span>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={importForm.start_chapter}
                onChange={(event) => setImportForm({ ...importForm, start_chapter: sanitizeChapterInput(event.target.value) })}
              />
            </label>
            <label>
              <span>结束章节</span>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={importForm.end_chapter}
                onChange={(event) => setImportForm({ ...importForm, end_chapter: sanitizeChapterInput(event.target.value) })}
              />
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={importForm.force}
                onChange={(event) => setImportForm({ ...importForm, force: event.target.checked })}
              />
              <span>覆盖已保存章节</span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={importForm.auto_l1_index}
                onChange={(event) => setImportForm({ ...importForm, auto_l1_index: event.target.checked })}
              />
              <span>导入完成后构建 L1 索引</span>
            </label>
          </div>
          <button className="primary" type="button" onClick={startImport} disabled={importBusy || !config.difyConfigured}>
            {importBusy ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
            {importBusy ? "导入中" : "导入章节"}
          </button>
          <TaskBox
            task={importTask}
            onCancel={onImportCancel}
            onPause={onImportPause}
            onResume={onImportResume}
          />
        </Panel>
      </div>

      <aside className="side">
        <Panel icon={Layers} title="基础索引">
          <div className="form-grid compact">
            <label>
              <span>起始章节</span>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={l1Form.start_chapter}
                onChange={(event) => setL1Form({ ...l1Form, start_chapter: sanitizeChapterInput(event.target.value) })}
              />
            </label>
            <label>
              <span>结束章节</span>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={l1Form.end_chapter}
                onChange={(event) => setL1Form({ ...l1Form, end_chapter: sanitizeChapterInput(event.target.value) })}
              />
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={l1Form.force}
                onChange={(event) => setL1Form({ ...l1Form, force: event.target.checked })}
              />
              <span>强制重建已有索引</span>
            </label>
          </div>
          <CoverageSummary
            coverage={l1Coverage}
            chapters={l1Chapters}
          />
          <IndexPromptStatus
            title="L1 Prompt 状态"
            purpose="逐章建立摘要、关键词、实体、关键事件和伏笔线索。"
            coverage={l1Coverage}
            onManage={() => openPromptManager("index")}
          />
          <button className="primary" type="button" onClick={startL1Index} disabled={l1Busy || !selectedBookId || !config.openaiConfigured}>
            {l1Busy ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
            {l1Busy ? "索引中" : "构建 L1 索引"}
          </button>
          <TaskBox
            task={l1Task}
            onCancel={onL1Cancel}
            onPause={onL1Pause}
            onResume={onL1Resume}
          />
          <L1Preview chapters={l1Chapters} />
        </Panel>

        <Panel icon={Database} title="L2 类型化事实">
          <div className="form-grid compact">
            <label>
              <span>起始章节</span>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={l2Form.start_chapter}
                onChange={(event) => setL2Form({ ...l2Form, start_chapter: sanitizeChapterInput(event.target.value) })}
              />
            </label>
            <label>
              <span>结束章节</span>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={l2Form.end_chapter}
                onChange={(event) => setL2Form({ ...l2Form, end_chapter: sanitizeChapterInput(event.target.value) })}
              />
            </label>
            <label>
              <span>分类筛选</span>
              <select value={l2Form.category} onChange={(event) => setL2Form({ ...l2Form, category: event.target.value })}>
                <option value="">全部分类</option>
                {L2_CATEGORIES.map((category) => (
                  <option key={category.value} value={category.value}>{category.label}</option>
                ))}
              </select>
            </label>
            <label>
              <span>构建模式</span>
              <select value={l2Form.mode} onChange={(event) => setL2Form({ ...l2Form, mode: event.target.value })}>
                <option value="all">构建全部缺失/过期</option>
                <option value="missing">只补缺失</option>
                <option value="retry_failed">只重试失败</option>
              </select>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={l2Form.force}
                onChange={(event) => setL2Form({ ...l2Form, force: event.target.checked })}
              />
              <span>强制重建</span>
            </label>
          </div>
          <L2CoverageSummary coverage={l2Coverage} />
          <IndexPromptStatus
            title="L2 Prompt 状态"
            purpose="建立可检索、可复用的类型化事实层，供分析任务二次提炼。"
            coverage={l2Coverage}
            onManage={() => openPromptManager("index")}
          />
          <div className="action-row wrap">
            <button className="primary" type="button" onClick={() => startL2Index()} disabled={l2Busy || !selectedBookId || !config.openaiConfigured}>
              {l2Busy ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
              {l2Busy ? "索引中" : "构建 L2"}
            </button>
            <button className="secondary" type="button" onClick={() => startL2Index("missing")} disabled={l2Busy || !selectedBookId || !config.openaiConfigured}>
              补缺失
            </button>
            <button className="secondary" type="button" onClick={() => startL2Index("retry_failed")} disabled={l2Busy || !selectedBookId || !config.openaiConfigured}>
              重试失败
            </button>
          </div>
          <TaskBox
            task={l2Task}
            onCancel={onL2Cancel}
            onPause={onL2Pause}
            onResume={onL2Resume}
          />
          <L2FactPreview facts={l2Facts} />
        </Panel>
      </aside>
    </section>
  );
}

function LibraryDirectory({ books, selectedBookId, onSelect, onDeleteSelected }) {
  if (!books.length) return <div className="empty-state">暂无书籍</div>;
  const totalBooks = books.length;
  return (
    <div className="library-directory">
      <div className="library-directory-summary">
        <span>{totalBooks} 本书</span>
      </div>
      <div className="library-book-list" role="list">
        {books.map((entry) => {
          const active = entry.book_id === selectedBookId;
          return (
            <div
              key={entry.book_id}
              className={active ? "library-book-row active" : "library-book-row"}
              role="listitem"
            >
              <button
                type="button"
                className="library-book-select"
                onClick={() => onSelect(entry.book_id)}
              >
                <div className="library-book-title">
                  <strong>{entry.book_name || entry.book_id}</strong>
                  <small>{entry.book_id}</small>
                </div>
                <div className="library-book-meta compact">
                  <span>{entry.chapter_count || 0} 章</span>
                  <span>{chapterRange(entry)}</span>
                  <span>{formatTime(entry.updated_at)}</span>
                </div>
              </button>
              <StatusPill status={entry.last_import_status || "idle"} />
              {active ? (
                <button className="danger inline" type="button" onClick={onDeleteSelected}>
                  <Trash2 size={15} />
                  删除
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function validChapterNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0;
}

function sanitizeChapterInput(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.replace(/^0+(?=\d)/, "").replace(/^0$/, "");
}

function chapterRange(book) {
  const first = book?.first_chapter || "-";
  const last = book?.last_chapter || "-";
  return `${first}-${last}`;
}

function CoverageSummary({ coverage, chapters }) {
  if (!coverage) return <div className="index-summary">暂无 L1 覆盖信息</div>;
  const total = Math.max(coverage.chapters.total || 0, 1);
  const completed = coverage.chapters.completed || 0;
  const failedChapters = chapters.filter((chapter) => chapter.status === "failed").map((chapter) => chapter.chapter_index);
  const unfinished = (coverage.chapters.missing || 0) + (coverage.chapters.failed || 0) + (coverage.chapters.outdated || 0);
  const finishedRatio = Math.round((completed / total) * 100);
  return (
    <div className="coverage-card">
      <div className="coverage-head">
        <strong>L1 覆盖 {finishedRatio}%</strong>
        <span>{coverage.chapters.completed}/{coverage.chapters.total} 章完成</span>
      </div>
      <div className="coverage-bar" aria-label={`L1 覆盖 ${finishedRatio}%`}>
        <span style={{ width: `${finishedRatio}%` }} />
      </div>
      <div className="index-summary">
        <span>缺失 {coverage.chapters.missing}</span>
        <span>失败 {coverage.chapters.failed}</span>
        <span>未完成 {unfinished}</span>
      </div>
      <p className="coverage-note">
        {failedChapters.length
          ? `最近失败章节：${compactChapterList(failedChapters.slice(0, 16))}`
          : coverage.chapters.missing
            ? "缺失通常表示还没有构建，不代表章节导入失败。"
            : "当前范围 L1 索引已覆盖。"}
      </p>
    </div>
  );
}

function L2CoverageSummary({ coverage }) {
  if (!coverage) return <div className="index-summary">暂无 L2 覆盖信息</div>;
  const total = Math.max(coverage.chapters.total || 0, 1);
  const completed = coverage.chapters.completed || 0;
  const finishedRatio = Math.round((completed / total) * 100);
  return (
    <div className="coverage-card">
      <div className="coverage-head">
        <strong>L2 覆盖 {finishedRatio}%</strong>
        <span>{completed}/{coverage.chapters.total} 章 · {coverage.chapters.facts || 0} 条事实</span>
      </div>
      <div className="coverage-bar" aria-label={`L2 覆盖 ${finishedRatio}%`}>
        <span style={{ width: `${finishedRatio}%` }} />
      </div>
      <div className="index-summary">
        <span>缺失 {coverage.chapters.missing}</span>
        <span>失败 {coverage.chapters.failed}</span>
        <span>过期 {coverage.chapters.outdated}</span>
      </div>
      <p className="coverage-note">
        {coverage.failed_chapters?.length
          ? `失败章节：${compactChapterList(coverage.failed_chapters.slice(0, 16))}`
          : "L2 是可复用事实层，汇总任务会优先从这里召回。"}
      </p>
    </div>
  );
}

function L1Preview({ chapters }) {
  if (!chapters.length) return null;
  const chapter = chapters[0];
  return (
    <div className="index-preview">
      <h3>L1 索引预览</h3>
      <article>
        <strong>章节 {chapter.chapter_index}</strong>
        <p>{chapter.summary || chapter.error_summary || "暂无摘要"}</p>
      </article>
    </div>
  );
}

function L2FactPreview({ facts }) {
  const fact = facts[0];
  return (
    <div className="index-preview">
      <h3>L2 结果预览</h3>
      {fact ? (
        <article>
          <strong>第 {fact.chapter_index} 章 · {categoryLabel(fact.category)} · {fact.entity || "未命名主体"}</strong>
          <p>{fact.fact || "暂无事实正文"}</p>
          <small>重要度 {formatScore(fact.importance)} · 置信度 {formatScore(fact.confidence)}</small>
        </article>
      ) : (
        <article className="index-preview-empty">
          <strong>暂无可预览事实</strong>
          <p>构建 L2 后，这里会展示当前范围和分类下的首条类型化事实。</p>
        </article>
      )}
    </div>
  );
}

function IndexPromptStatus({ title, purpose, coverage, onManage }) {
  const chapters = coverage?.chapters;
  const ratio = chapters?.total ? Math.round((Number(chapters.completed || 0) / Number(chapters.total || 1)) * 100) : 0;
  const stale = Number(chapters?.outdated || 0);
  return (
    <div className="index-prompt-card index-prompt-status-card">
      <div className="index-prompt-head">
        <div>
          <h3>{title}</h3>
          <small>{stale ? `可能过期 ${stale} 章` : "当前范围未检测到过期索引"}</small>
        </div>
        <button className="secondary inline" type="button" onClick={onManage}>
          管理索引 Prompt
        </button>
      </div>
      <p className="index-prompt-description">{purpose}</p>
      <div className={stale ? "inline-warning" : "muted-line"}>
        {chapters ? `覆盖已导入章节 ${chapters.completed}/${chapters.total} · ${ratio}%` : "覆盖率读取中"}
      </div>
    </div>
  );
}

function categoryLabel(value) {
  return L2_CATEGORIES.find((category) => category.value === value)?.label || value || "其他";
}

function formatScore(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toFixed(2) : "0.00";
}

function compactChapterList(indexes) {
  return indexes.length ? indexes.join(", ") : "-";
}
