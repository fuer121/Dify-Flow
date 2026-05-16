import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  Database,
  FileText,
  Loader2,
  Play,
  RefreshCcw,
  Trash2
} from "lucide-react";
import { apiGet, apiPost } from "../api.js";
import { BookList, ChapterTable, IconButton, Panel, TaskBox } from "../ui.jsx";

const initialImportForm = {
  book_id: "",
  book_name: "",
  start_chapter: 1,
  end_chapter: 100,
  force: false
};

export function LibraryPage({ books, config, importTask, importBusy, onStartImport, onBooksChanged, setError }) {
  const initialBookId = importTask?.payload?.bookId || books[0]?.book_id || "";
  const [selectedBookId, setSelectedBookId] = useState(initialBookId);
  const [chapters, setChapters] = useState([]);
  const [importForm, setImportForm] = useState({
    ...initialImportForm,
    book_id: initialBookId
  });
  const [chaptersBusy, setChaptersBusy] = useState(false);

  async function loadChapters(bookId) {
    if (!bookId) {
      setChapters([]);
      return;
    }
    setChaptersBusy(true);
    setError("");
    try {
      const data = await apiGet(`/api/books/${encodeURIComponent(bookId)}/chapters`);
      setChapters(data.chapters || []);
    } catch (error) {
      setError(error.message);
    } finally {
      setChaptersBusy(false);
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

  const selectedBook = useMemo(
    () => books.find((book) => book.book_id === selectedBookId) || null,
    [books, selectedBookId]
  );
  const boundBook = useMemo(
    () => books.find((book) => book.book_id === importForm.book_id.trim()) || null,
    [books, importForm.book_id]
  );

  async function startImport() {
    const task = await onStartImport(importForm);
    const taskBookId = task?.payload?.bookId || importForm.book_id;
    if (taskBookId) setSelectedBookId(taskBookId);
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
      setChapters([]);
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
    <section className="library-layout">
      <aside className="side">
        <Panel
          icon={BookOpen}
          title="全书导入"
          action={<IconButton icon={RefreshCcw} label="刷新" onClick={onBooksChanged} />}
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
                type="number"
                min="1"
                value={importForm.start_chapter}
                onChange={(event) => setImportForm({ ...importForm, start_chapter: Number(event.target.value) })}
              />
            </label>
            <label>
              <span>结束章节</span>
              <input
                type="number"
                min="1"
                value={importForm.end_chapter}
                onChange={(event) => setImportForm({ ...importForm, end_chapter: Number(event.target.value) })}
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
          </div>
          <button className="primary" type="button" onClick={startImport} disabled={importBusy || !config.difyConfigured}>
            {importBusy ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
            {importBusy ? "导入中" : "导入章节"}
          </button>
          <TaskBox task={importTask} />
        </Panel>

        <Panel icon={Database} title="本地书库">
          <BookList books={books} selectedBookId={selectedBookId} onSelect={selectBook} />
          <button className="danger" type="button" onClick={deleteSelectedBook} disabled={!selectedBookId}>
            <Trash2 size={16} />
            删除选中书籍
          </button>
        </Panel>
      </aside>

      <section className="main">
        <Panel
          icon={FileText}
          title="章节元数据"
          action={<SummaryStats book={selectedBook} chapters={chapters} loading={chaptersBusy} />}
        >
          <ChapterTable chapters={chapters} />
        </Panel>
      </section>
    </section>
  );
}

function SummaryStats({ book, chapters, loading }) {
  return (
    <div className="stats">
      <span>{loading ? "读取中" : `${book?.chapter_count || chapters.length || 0} 章`}</span>
      <span>{book?.last_import_status || "idle"}</span>
    </div>
  );
}
