import { useMemo, useState } from "react";
import {
  ClipboardList,
  Folder,
  Loader2,
  Plus,
  RefreshCcw,
  Save,
  Trash2
} from "lucide-react";
import { apiDelete, apiPost, apiPut, formatTime } from "../api.js";
import { IconButton, Panel } from "../ui.jsx";

const emptyDraft = {
  id: "",
  name: "",
  category: "通用",
  chapter_prompt: "",
  summary_prompt: ""
};

export function PromptLibraryPage({ books, promptGroups, onPromptGroupsChanged, setError }) {
  const [selectedId, setSelectedId] = useState(promptGroups[0]?.id || "");
  const [draft, setDraft] = useState(() => promptGroups[0] || emptyDraft);
  const [categoryFilter, setCategoryFilter] = useState("全部");
  const [busy, setBusy] = useState(false);

  const categories = useMemo(() => {
    const values = new Set(["全部", "通用"]);
    for (const book of books) values.add(book.book_name || book.book_id);
    for (const group of promptGroups) values.add(group.category || "未分类");
    return [...values];
  }, [books, promptGroups]);

  const filteredGroups = useMemo(() => (
    categoryFilter === "全部"
      ? promptGroups
      : promptGroups.filter((group) => group.category === categoryFilter)
  ), [categoryFilter, promptGroups]);

  function selectGroup(group) {
    setSelectedId(group.id);
    setDraft(group);
  }

  function startCreate() {
    setSelectedId("");
    setDraft({
      ...emptyDraft,
      category: categoryFilter === "全部" ? "通用" : categoryFilter
    });
  }

  async function saveGroup() {
    setBusy(true);
    setError("");
    try {
      const payload = {
        name: draft.name,
        category: draft.category,
        chapter_prompt: draft.chapter_prompt,
        summary_prompt: draft.summary_prompt
      };
      const data = draft.id
        ? await apiPut(`/api/prompt-groups/${encodeURIComponent(draft.id)}`, payload)
        : await apiPost("/api/prompt-groups", payload);
      const groups = await onPromptGroupsChanged();
      const saved = groups.find((group) => group.id === data.promptGroup.id) || data.promptGroup;
      setSelectedId(saved.id);
      setDraft(saved);
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteGroup() {
    if (!draft.id) return;
    const confirmed = window.confirm(`删除 Prompt 组《${draft.name}》？`);
    if (!confirmed) return;
    setBusy(true);
    setError("");
    try {
      await apiDelete(`/api/prompt-groups/${encodeURIComponent(draft.id)}`);
      const groups = await onPromptGroupsChanged();
      const next = groups[0] || emptyDraft;
      setSelectedId(next.id || "");
      setDraft(next);
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }

  function updateDraft(patch) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  return (
    <section className="prompt-library-layout">
      <aside className="task-rail">
        <Panel
          icon={Folder}
          title="Prompt 分类"
          action={<IconButton icon={RefreshCcw} label="刷新" onClick={onPromptGroupsChanged} />}
        >
          <div className="category-list">
            {categories.map((category) => (
              <button
                key={category}
                type="button"
                className={category === categoryFilter ? "category-item active" : "category-item"}
                onClick={() => setCategoryFilter(category)}
              >
                <strong>{category}</strong>
                <span>{category === "全部" ? promptGroups.length : promptGroups.filter((group) => group.category === category).length} 组</span>
              </button>
            ))}
          </div>
        </Panel>

        <Panel
          icon={ClipboardList}
          title="Prompt 组"
          action={<IconButton icon={Plus} label="新建" onClick={startCreate} />}
        >
          <PromptGroupList groups={filteredGroups} selectedId={selectedId} onSelect={selectGroup} />
        </Panel>
      </aside>

      <section className="workspace">
        <Panel
          icon={ClipboardList}
          title={draft.id ? "编辑 Prompt 组" : "新建 Prompt 组"}
          action={<PromptMeta draft={draft} />}
        >
          <div className="prompt-editor">
            <div className="form-grid prompt-group-form-grid">
              <label>
                <span>Prompt 组名称</span>
                <input
                  value={draft.name}
                  placeholder="例如：角色身份形象提取"
                  onChange={(event) => updateDraft({ name: event.target.value })}
                />
              </label>
              <label>
                <span>分类</span>
                <input
                  list="prompt-category-options"
                  value={draft.category}
                  placeholder="例如：通用 / 某本书名"
                  onChange={(event) => updateDraft({ category: event.target.value })}
                />
                <datalist id="prompt-category-options">
                  {categories.filter((category) => category !== "全部").map((category) => (
                    <option key={category} value={category} />
                  ))}
                </datalist>
              </label>
            </div>

            <label>
              <span>逐章 Prompt</span>
              <textarea
                className="prompt-library-textarea"
                value={draft.chapter_prompt}
                onChange={(event) => updateDraft({ chapter_prompt: event.target.value })}
              />
            </label>
            <label>
              <span>汇总 Prompt</span>
              <textarea
                className="prompt-library-textarea"
                value={draft.summary_prompt}
                onChange={(event) => updateDraft({ summary_prompt: event.target.value })}
              />
            </label>

            <div className="form-actions">
              <button className="secondary" type="button" onClick={saveGroup} disabled={busy}>
                {busy ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
                保存 Prompt 组
              </button>
              <button className="danger inline" type="button" onClick={deleteGroup} disabled={busy || !draft.id}>
                <Trash2 size={16} />
                删除
              </button>
            </div>
          </div>
        </Panel>
      </section>
    </section>
  );
}

function PromptGroupList({ groups, selectedId, onSelect }) {
  if (!groups.length) return <div className="empty-state">暂无 Prompt 组</div>;
  return (
    <div className="prompt-group-list">
      {groups.map((group) => (
        <button
          key={group.id}
          type="button"
          className={group.id === selectedId ? "prompt-group-item active" : "prompt-group-item"}
          onClick={() => onSelect(group)}
        >
          <strong>{group.name}</strong>
          <span>{group.category} · {formatTime(group.updated_at)}</span>
        </button>
      ))}
    </div>
  );
}

function PromptMeta({ draft }) {
  if (!draft.id) return <div className="stats"><span>新 Prompt 组</span></div>;
  return (
    <div className="stats">
      <span>{draft.category || "未分类"}</span>
      <span>{formatTime(draft.updated_at)}</span>
    </div>
  );
}
