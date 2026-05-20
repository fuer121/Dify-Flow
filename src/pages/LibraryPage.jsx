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

  return (
    <section className="library-layout library-layout-single">
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
        />
      </Panel>
      <aside className="side">
        <Panel
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
        <Panel icon={Database} title="书籍管理">
          <div className="selected-book-card">
            <span>当前选中</span>
            <strong>{selectedBook?.book_name || selectedBookId || "未选择书籍"}</strong>
            <small>{selectedBook ? `${selectedBook.book_id} · ${selectedBook.chapter_count || 0} 章 · ${chapterRange(selectedBook)}` : "先从顶部书库目录选择一本书"}</small>
          </div>
          <button className="danger" type="button" onClick={deleteSelectedBook} disabled={!selectedBookId}>
            <Trash2 size={16} />
            删除选中书籍
          </button>
        </Panel>
      </aside>
    </section>
  );
}

function LibraryDirectory({ books, selectedBookId, onSelect }) {
  if (!books.length) return <div className="empty-state">暂无书籍</div>;
  const totalBooks = books.length;
  const totalChapters = books.reduce((sum, book) => sum + Number(book.chapter_count || 0), 0);
  return (
    <div className="library-directory">
      <div className="library-directory-summary">
        <span>{totalBooks} 本书</span>
        <span>{totalChapters} 章已入库</span>
        <span>导入来源：本机共享库</span>
      </div>
      <div className="library-directory-grid">
        {books.map((book) => (
          <button
            key={book.book_id}
            type="button"
            className={book.book_id === selectedBookId ? "library-book-card active" : "library-book-card"}
            onClick={() => onSelect(book.book_id)}
          >
            <div>
              <strong>{book.book_name || book.book_id}</strong>
              <small>{book.book_id}</small>
            </div>
            <div className="library-book-meta">
              <span>{book.chapter_count || 0} 章</span>
              <span>{chapterRange(book)}</span>
              <span>导入人：本机共享库</span>
              <span>更新时间：{formatTime(book.updated_at)}</span>
            </div>
            <StatusPill status={book.last_import_status || "idle"} />
          </button>
        ))}
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
  return (
    <div className="index-preview">
      <h3>L1 索引预览</h3>
      <div className="index-preview-grid">
        {chapters.slice(0, 5).map((chapter) => (
          <article key={`chapter-${chapter.chapter_index}`}>
            <strong>章节 {chapter.chapter_index}</strong>
            <p>{chapter.summary || chapter.error_summary || "暂无摘要"}</p>
          </article>
        ))}
      </div>
    </div>
  );
}

function L2FactPreview({ facts }) {
  if (!facts.length) return null;
  return (
    <div className="index-preview">
      <h3>L2 事实预览</h3>
      <div className="index-preview-grid">
        {facts.slice(0, 8).map((fact) => (
          <article key={fact.id}>
            <strong>第 {fact.chapter_index} 章 · {categoryLabel(fact.category)} · {fact.entity || "未命名主体"}</strong>
            <p>{fact.fact || "暂无事实正文"}</p>
            <small>重要度 {formatScore(fact.importance)} · 置信度 {formatScore(fact.confidence)}</small>
          </article>
        ))}
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
