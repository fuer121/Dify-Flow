import { useEffect, useMemo, useState } from "react";
import {
  BookPlus,
  ClipboardList,
  Database,
  Folder,
  Loader2,
  Lock,
  LockOpen,
  Plus,
  RefreshCcw,
  Save,
  Trash2
} from "lucide-react";
import { apiDelete, apiPost, apiPut, formatTime } from "../api.js";
import { IconButton, Panel, TaskBox } from "../ui.jsx";

const emptyDraft = {
  id: "",
  book_id: "",
  name: "",
  category: "书籍分析",
  summary_prompt: ""
};

const emptyBookForm = { book_id: "", book_name: "" };

export function PromptLibraryPage({
  books,
  l1Task,
  l2Task,
  onCreateBook,
  onBooksChanged,
  onLoadBookIndexPrompts,
  onSaveBookIndexPrompts,
  onStartL1Index,
  onStartL2Index,
  onL1Cancel,
  onL1Pause,
  onL1Resume,
  onL2Cancel,
  onL2Pause,
  onL2Resume,
  onLoadPromptGroups,
  onPromptGroupsChanged,
  setError
}) {
  const [selectedBookId, setSelectedBookId] = useState(() => bookIdFromUrl() || books[0]?.book_id || "");
  const [bookForm, setBookForm] = useState(emptyBookForm);
  const [creatingBook, setCreatingBook] = useState(false);
  const [bookPromptGroups, setBookPromptGroups] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [indexData, setIndexData] = useState(null);
  const [indexSaving, setIndexSaving] = useState({ l1: false, l2: false });
  const [rebuildPrompt, setRebuildPrompt] = useState(null);

  const selectedBook = useMemo(
    () => books.find((book) => book.book_id === selectedBookId) || null,
    [books, selectedBookId]
  );

  const dirty = useMemo(
    () => !samePromptGroup(draft, bookPromptGroups.find((group) => group.id === selectedId) || emptyDraft),
    [draft, bookPromptGroups, selectedId]
  );

  useEffect(() => {
    if (!selectedBookId && books[0]?.book_id) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedBookId(books[0].book_id);
    }
  }, [books, selectedBookId]);

  useEffect(() => {
    if (!selectedBookId) return;
    void loadBookPromptState(selectedBookId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBookId]);

  async function loadBookPromptState(bookId) {
    setError("");
    try {
      const [indexResponse, groups] = await Promise.all([
        onLoadBookIndexPrompts(bookId),
        onLoadPromptGroups(bookId)
      ]);
      setIndexData(indexResponse);
      setBookPromptGroups(groups);
      const first = groups[0] || null;
      setSelectedId(first?.id || "");
      setDraft(first ? normalizeGroupDraft(first, bookId) : { ...emptyDraft, book_id: bookId });
    } catch (error) {
      setError(error.message);
    }
  }

  async function refreshAll() {
    await onBooksChanged();
    if (selectedBookId) await loadBookPromptState(selectedBookId);
  }

  async function createBook() {
    if (!bookForm.book_id.trim()) {
      setError("小说 ID 不能为空。");
      return;
    }
    setCreatingBook(true);
    setError("");
    try {
      const book = await onCreateBook(bookForm);
      setBookForm(emptyBookForm);
      setSelectedBookId(book.book_id);
    } catch (error) {
      setError(error.message);
    } finally {
      setCreatingBook(false);
    }
  }

  function selectGroup(group) {
    if (dirty && !window.confirm("当前分析 Prompt 有未保存修改，确定切换吗？")) return;
    setSelectedId(group.id);
    setDraft(normalizeGroupDraft(group, selectedBookId));
  }

  function startCreatePrompt() {
    if (!selectedBookId) {
      setError("请先选择或新建一本书。");
      return;
    }
    if (dirty && !window.confirm("当前分析 Prompt 有未保存修改，确定新建吗？")) return;
    setSelectedId("");
    setDraft({ ...emptyDraft, book_id: selectedBookId });
  }

  async function saveGroup() {
    if (!selectedBookId) {
      setError("请先选择一本书。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const payload = {
        book_id: selectedBookId,
        name: draft.name,
        category: selectedBook?.book_name || selectedBookId,
        summary_prompt: draft.summary_prompt
      };
      const data = draft.id
        ? await apiPut(`/api/prompt-groups/${encodeURIComponent(draft.id)}`, payload)
        : await apiPost("/api/prompt-groups", payload);
      await onPromptGroupsChanged();
      const groups = await onLoadPromptGroups(selectedBookId);
      setBookPromptGroups(groups);
      const saved = groups.find((group) => group.id === data.promptGroup.id) || data.promptGroup;
      setSelectedId(saved.id);
      setDraft(normalizeGroupDraft(saved, selectedBookId));
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteGroup() {
    if (!draft.id) return;
    const confirmed = window.confirm(`删除分析 Prompt《${draft.name}》？`);
    if (!confirmed) return;
    setBusy(true);
    setError("");
    try {
      await apiDelete(`/api/prompt-groups/${encodeURIComponent(draft.id)}`);
      await onPromptGroupsChanged();
      const groups = await onLoadPromptGroups(selectedBookId);
      setBookPromptGroups(groups);
      const next = groups[0] || { ...emptyDraft, book_id: selectedBookId };
      setSelectedId(next.id || "");
      setDraft(normalizeGroupDraft(next, selectedBookId));
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveIndexPrompt(type, prompt) {
    if (!selectedBookId) return;
    setIndexSaving((state) => ({ ...state, [type]: true }));
    setError("");
    try {
      const payload = type === "l1" ? { l1_index_prompt: prompt } : { l2_index_prompt: prompt };
      const saved = await onSaveBookIndexPrompts(selectedBookId, payload);
      const refreshed = await onLoadBookIndexPrompts(selectedBookId);
      setIndexData(refreshed);
      setRebuildPrompt({ type, indexPrompts: saved });
    } catch (error) {
      setError(error.message);
      throw error;
    } finally {
      setIndexSaving((state) => ({ ...state, [type]: false }));
    }
  }

  async function startRebuild({ type, startChapter, endChapter, force }) {
    if (!selectedBookId) return;
    if (type === "l1") {
      await onStartL1Index({ bookId: selectedBookId, startChapter, endChapter, force });
    } else {
      await onStartL2Index({ bookId: selectedBookId, startChapter, endChapter, force, mode: "all" });
    }
    setRebuildPrompt(null);
  }

  function updateDraft(patch) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  const indexPrompts = indexData?.indexPrompts || null;
  const l1Coverage = indexData?.coverage?.l1 || null;
  const l2Coverage = indexData?.coverage?.l2 || null;

  return (
    <section className="prompt-workbench">
      <Panel
        icon={Folder}
        title="书籍 Prompt 工作台"
        action={<IconButton icon={RefreshCcw} label="刷新" onClick={refreshAll} />}
      >
        <div className="book-tabs-row">
          {books.map((book) => (
            <button
              key={book.book_id}
              type="button"
              className={book.book_id === selectedBookId ? "book-tab active" : "book-tab"}
              onClick={() => setSelectedBookId(book.book_id)}
            >
              <strong>{book.book_name || book.book_id}</strong>
              <span>{book.chapter_count || 0} 章</span>
            </button>
          ))}
        </div>
        <div className="form-grid new-book-grid">
          <label>
            <span>小说 ID</span>
            <input value={bookForm.book_id} onChange={(event) => setBookForm({ ...bookForm, book_id: event.target.value })} />
          </label>
          <label>
            <span>书籍名称</span>
            <input value={bookForm.book_name} onChange={(event) => setBookForm({ ...bookForm, book_name: event.target.value })} />
          </label>
          <button className="secondary" type="button" onClick={createBook} disabled={creatingBook}>
            {creatingBook ? <Loader2 className="spin" size={16} /> : <BookPlus size={16} />}
            新建书籍
          </button>
        </div>
      </Panel>

      <div className="prompt-workbench-grid">
        <section className="prompt-index-column">
          <Panel icon={Database} title="书籍索引 Prompt" action={<PromptBookMeta book={selectedBook} />}>
            {!selectedBookId || !indexPrompts ? (
              <div className="empty-state">请选择一本书</div>
            ) : (
              <div className="index-prompt-stack">
                <IndexPromptEditor
                  key={`l1-${selectedBookId}-${indexPrompts.l1_index_prompt_hash}-${indexPrompts.updated_at}`}
                  title="L1 基础索引 Prompt"
                  description="用于生成逐章摘要、关键词、实体、关键事件和伏笔线索。"
                  value={indexPrompts.l1_index_prompt}
                  hash={indexPrompts.l1_index_prompt_hash}
                  updatedAt={indexPrompts.updated_at}
                  coverage={l1Coverage}
                  saving={indexSaving.l1}
                  onSave={(prompt) => saveIndexPrompt("l1", prompt)}
                />
                <IndexPromptEditor
                  key={`l2-${selectedBookId}-${indexPrompts.l2_index_prompt_hash}-${indexPrompts.updated_at}`}
                  title="L2 类型化事实 Prompt"
                  description="用于生成可复用事实层，供分析任务按主体和分类召回。"
                  value={indexPrompts.l2_index_prompt}
                  hash={indexPrompts.l2_index_prompt_hash}
                  updatedAt={indexPrompts.updated_at}
                  coverage={l2Coverage}
                  saving={indexSaving.l2}
                  onSave={(prompt) => saveIndexPrompt("l2", prompt)}
                />
                {rebuildPrompt ? (
                  <RebuildConfirm
                    type={rebuildPrompt.type}
                    book={selectedBook}
                    onCancel={() => setRebuildPrompt(null)}
                    onStart={startRebuild}
                  />
                ) : null}
                <TaskBox task={l1Task} onCancel={onL1Cancel} onPause={onL1Pause} onResume={onL1Resume} />
                <TaskBox task={l2Task} onCancel={onL2Cancel} onPause={onL2Pause} onResume={onL2Resume} />
              </div>
            )}
          </Panel>
        </section>

        <section className="prompt-analysis-column">
          <Panel icon={ClipboardList} title="书籍分析 Prompt" action={<IconButton icon={Plus} label="新建" onClick={startCreatePrompt} />}>
            <div className="prompt-analysis-grid">
              <div className="prompt-group-list scoped">
                {bookPromptGroups.length ? bookPromptGroups.map((group) => (
                  <button
                    key={group.id}
                    type="button"
                    className={group.id === selectedId ? "prompt-group-item active" : "prompt-group-item"}
                    onClick={() => selectGroup(group)}
                  >
                    <strong>{group.name}</strong>
                    <span>{formatTime(group.updated_at)}</span>
                  </button>
                )) : <div className="empty-state">当前书籍暂无分析 Prompt</div>}
              </div>

              <div className="prompt-editor">
                <div className={dirty ? "draft-banner active" : "draft-banner"}>
                  {dirty ? "有未保存修改。保存后才会写入当前书籍的分析 Prompt。" : "当前分析 Prompt 已保存。"}
                </div>
                <label>
                  <span>名称</span>
                  <input
                    value={draft.name}
                    placeholder="例如：人物志 / 飞剑设定 / 势力关系"
                    onChange={(event) => updateDraft({ name: event.target.value })}
                  />
                </label>
                <label>
                  <span>分析 Prompt</span>
                  <textarea
                    className="prompt-library-textarea"
                    value={draft.summary_prompt}
                    placeholder="写清楚这次要总结的主体、维度、筛选目标和输出要求。"
                    onChange={(event) => updateDraft({ summary_prompt: event.target.value })}
                  />
                </label>
                <div className="form-actions">
                  <button className="secondary" type="button" onClick={saveGroup} disabled={busy || !selectedBookId}>
                    {busy ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
                    保存分析 Prompt
                  </button>
                  <button className="danger inline" type="button" onClick={deleteGroup} disabled={busy || !draft.id}>
                    <Trash2 size={16} />
                    删除
                  </button>
                </div>
              </div>
            </div>
          </Panel>
        </section>
      </div>
    </section>
  );
}

function PromptBookMeta({ book }) {
  if (!book) return <div className="stats"><span>未选择书籍</span></div>;
  return (
    <div className="stats">
      <span>{book.book_name || book.book_id}</span>
      <span>{book.chapter_count || 0} 章</span>
    </div>
  );
}

function IndexPromptEditor({ title, description, value, hash, updatedAt, coverage, saving, onSave }) {
  const [locked, setLocked] = useState(true);
  const [draft, setDraft] = useState(value);
  const shortHash = String(hash || "").slice(0, 10);

  async function handleSave() {
    try {
      await onSave(draft);
      setLocked(true);
    } catch {
      // Parent owns the user-facing error.
    }
  }

  return (
    <div className="index-prompt-card">
      <div className="index-prompt-head">
        <div>
          <h3>{title}</h3>
          <small>Hash {shortHash || "-"} · 更新 {formatTime(updatedAt)}</small>
        </div>
        <button
          className="secondary inline"
          type="button"
          onClick={() => {
            if (!locked) setDraft(value);
            setLocked((state) => !state);
          }}
        >
          {locked ? <Lock size={15} /> : <LockOpen size={15} />}
          {locked ? "解锁编辑" : "锁定"}
        </button>
      </div>
      <p className="index-prompt-description">{description}</p>
      <IndexCoverageLine coverage={coverage} />
      <textarea
        value={draft}
        readOnly={locked}
        onChange={(event) => setDraft(event.target.value)}
        aria-label={title}
      />
      {!locked ? (
        <div className="action-row wrap">
          <button className="primary inline" type="button" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="spin" size={15} /> : null}
            保存 Prompt
          </button>
        </div>
      ) : null}
    </div>
  );
}

function IndexCoverageLine({ coverage }) {
  const chapters = coverage?.chapters;
  if (!chapters) return <div className="muted-line">覆盖率读取中</div>;
  const ratio = chapters.total ? Math.round((chapters.completed / chapters.total) * 100) : 0;
  const stale = Number(chapters.outdated || 0);
  return (
    <div className={stale ? "inline-warning" : "muted-line"}>
      覆盖 {chapters.completed}/{chapters.total} 章 · {ratio}%
      {stale ? ` · 过期 ${stale} 章` : ""}
    </div>
  );
}

function RebuildConfirm({ type, book, onCancel, onStart }) {
  const first = book?.first_chapter || 1;
  const last = book?.last_chapter || first;
  const [form, setForm] = useState({ start_chapter: String(first), end_chapter: String(last), force: true });
  const label = type === "l1" ? "L1 基础索引" : "L2 类型化事实";

  function submit() {
    const startChapter = Number(form.start_chapter);
    const endChapter = Number(form.end_chapter);
    if (!Number.isInteger(startChapter) || startChapter <= 0 || !Number.isInteger(endChapter) || endChapter <= 0) return;
    onStart({ type, startChapter, endChapter, force: form.force });
  }

  return (
    <div className="rebuild-confirm">
      <strong>{label} Prompt 已保存</strong>
      <p>如需让已有索引按新 Prompt 生效，请选择章节范围后启动重建。</p>
      <div className="form-grid compact">
        <label>
          <span>起始章节</span>
          <input value={form.start_chapter} onChange={(event) => setForm({ ...form, start_chapter: sanitizeChapterInput(event.target.value) })} />
        </label>
        <label>
          <span>结束章节</span>
          <input value={form.end_chapter} onChange={(event) => setForm({ ...form, end_chapter: sanitizeChapterInput(event.target.value) })} />
        </label>
        <label className="check-row">
          <input type="checkbox" checked={form.force} onChange={(event) => setForm({ ...form, force: event.target.checked })} />
          <span>强制重建</span>
        </label>
      </div>
      <div className="action-row wrap">
        <button className="primary inline" type="button" onClick={submit}>立即重建</button>
        <button className="secondary inline" type="button" onClick={onCancel}>稍后处理</button>
      </div>
    </div>
  );
}

function normalizeGroupDraft(group, bookId) {
  return {
    ...emptyDraft,
    ...group,
    book_id: group?.book_id || bookId || "",
    summary_prompt: group?.summary_prompt || ""
  };
}

function samePromptGroup(left, right) {
  return JSON.stringify({
    book_id: left?.book_id || "",
    name: left?.name || "",
    summary_prompt: left?.summary_prompt || ""
  }) === JSON.stringify({
    book_id: right?.book_id || "",
    name: right?.name || "",
    summary_prompt: right?.summary_prompt || ""
  });
}

function bookIdFromUrl() {
  try {
    return new URLSearchParams(window.location.search).get("book_id") || "";
  } catch {
    return "";
  }
}

function sanitizeChapterInput(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.replace(/^0+(?=\d)/, "").replace(/^0$/, "");
}
