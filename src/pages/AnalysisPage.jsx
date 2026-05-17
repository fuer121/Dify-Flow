import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FileJson,
  FileText,
  Layers,
  Loader2,
  Plus,
  Play,
  RefreshCcw,
  Save,
  Settings2,
  Table2,
  Trash2
} from "lucide-react";
import { apiDelete, apiGet, apiPost, apiPut, followTask, formatTime } from "../api.js";
import { ChapterTable, IconButton, Panel, ResultActions, StatusPill, TaskBox } from "../ui.jsx";
import {
  normalizePrompt,
  outputSchemaForPrompt,
  parseSchema,
  resultColumnsFromPrompt,
  schemaFieldTypes,
  schemaFromFields
} from "../schemaTools.js";

const initialAnalysisForm = {
  name: "",
  book_id: "",
  start_chapter: 1,
  end_chapter: 20
};

export function AnalysisPage({ books, config, prompts, promptGroups = [], onPromptsChanged, setError }) {
  const [analyses, setAnalyses] = useState([]);
  const [chapters, setChapters] = useState([]);
  const [chaptersBookId, setChaptersBookId] = useState("");
  const [analysisForm, setAnalysisForm] = useState({
    ...initialAnalysisForm,
    book_id: books[0]?.book_id || ""
  });
  const [promptDraft, setPromptDraft] = useState(() => normalizePrompt(prompts));
  const [selectedPromptGroupId, setSelectedPromptGroupId] = useState("");
  const [selectedIndexes, setSelectedIndexes] = useState([]);
  const selectionOverrideRef = useRef(null);
  const [selectionOverrideToken, setSelectionOverrideToken] = useState(0);
  const [chaptersExpanded, setChaptersExpanded] = useState(false);
  const [analysisTask, setAnalysisTask] = useState(null);
  const [selectedAnalysis, setSelectedAnalysis] = useState(null);
  const [busy, setBusy] = useState({ analysis: false, prompts: false, chapters: false, list: false });

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
    const inRange = chapters
      .filter((chapter) => chapter.chapter_index >= analysisForm.start_chapter && chapter.chapter_index <= analysisForm.end_chapter)
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
    () => chapters.filter((chapter) => chapter.chapter_index >= analysisForm.start_chapter && chapter.chapter_index <= analysisForm.end_chapter),
    [chapters, analysisForm.start_chapter, analysisForm.end_chapter]
  );

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

  async function startAnalysis() {
    const chapterIndexes = [...new Set(selectedIndexes)].sort((left, right) => left - right);
    if (!chapterIndexes.length) {
      setError("请至少选择一个已导入章节。");
      return;
    }

    setBusy((state) => ({ ...state, analysis: true }));
    setError("");
    setAnalysisTask(null);
    setSelectedAnalysis(null);
    try {
      const data = await apiPost("/api/analyses", {
        ...analysisForm,
        chapter_indexes: chapterIndexes,
        prompt: {
          ...promptDraft,
          output_schema: outputSchemaForPrompt(promptDraft)
        }
      });
      setAnalysisTask(data.task);
      followTask(`/api/analyses/${encodeURIComponent(data.task.id)}/events`, setAnalysisTask, async (task) => {
        setBusy((state) => ({ ...state, analysis: false }));
        await loadAnalyses();
        if (task.result?.analysisId) await loadAnalysisResult(task.result.analysisId);
        if (task.status === "failed") setError(task.error || "分析失败");
      });
    } catch (error) {
      setError(error.message);
      setBusy((state) => ({ ...state, analysis: false }));
    }
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
    setAnalysisForm({
      name: `${analysis.name || "分析任务"} 复制`,
      book_id: analysis.book_id,
      start_chapter: analysis.start_chapter,
      end_chapter: analysis.end_chapter
    });
    selectionOverrideRef.current = analysis.chapter_indexes || [];
    setSelectionOverrideToken((value) => value + 1);
    if (analysis.prompt) setPromptDraft(normalizePrompt(analysis.prompt));
  }

  async function savePrompts() {
    setBusy((state) => ({ ...state, prompts: true }));
    setError("");
    try {
      const data = await apiPut("/api/prompts", {
        ...promptDraft,
        output_schema: outputSchemaForPrompt(promptDraft)
      });
      onPromptsChanged(data.prompts);
      setPromptDraft(normalizePrompt(data.prompts));
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy((state) => ({ ...state, prompts: false }));
    }
  }

  function applyPromptGroup(groupId) {
    setSelectedPromptGroupId(groupId);
    const group = promptGroups.find((entry) => entry.id === groupId);
    if (!group) return;
    setPromptDraft((current) => ({
      ...current,
      name: group.name,
      chapter_prompt: group.chapter_prompt,
      summary_prompt: group.summary_prompt
    }));
  }

  function updateAnalysisForm(patch) {
    setAnalysisForm((form) => ({ ...form, ...patch }));
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
                type="number"
                min="1"
                value={analysisForm.start_chapter}
                onChange={(event) => updateAnalysisForm({ start_chapter: Number(event.target.value) })}
              />
            </label>
            <label>
              <span>结束章节</span>
              <input
                type="number"
                min="1"
                value={analysisForm.end_chapter}
                onChange={(event) => updateAnalysisForm({ end_chapter: Number(event.target.value) })}
              />
            </label>
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
              <span>{selectedIndexes.length} / {chaptersInRange.length} 章已选择</span>
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
        </Panel>

        <div className="split">
          <Panel icon={Settings2} title="Prompt 与 Schema">
            <PromptEditor
              prompt={promptDraft}
              promptGroups={promptGroups}
              selectedPromptGroupId={selectedPromptGroupId}
              onPromptGroupChange={applyPromptGroup}
              onChange={setPromptDraft}
              onSave={savePrompts}
              busy={busy.prompts}
            />
          </Panel>

          <Panel icon={Play} title="运行">
            <button
              className="primary"
              type="button"
              onClick={startAnalysis}
              disabled={busy.analysis || !config.openaiConfigured || !config.retentionConfirmed || !analysisForm.book_id || !selectedIndexes.length}
            >
              {busy.analysis ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
              {busy.analysis ? "分析中" : "开始分析"}
            </button>
            <TaskBox task={analysisTask} />
          </Panel>
        </div>

        <Panel
          icon={Table2}
          title="最终结果"
          action={<ResultActions analysis={selectedAnalysis} />}
        >
          <ResultView analysis={selectedAnalysis} />
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

function PromptEditor({ prompt, promptGroups, selectedPromptGroupId, onPromptGroupChange, onChange, onSave, busy }) {
  const schemaValid = Boolean(parseSchema(outputSchemaForPrompt(prompt)));

  function updatePrompt(patch) {
    onChange((current) => {
      const next = { ...current, ...patch };
      if (next.schema_mode === "fields") {
        next.output_schema = JSON.stringify(schemaFromFields(next.schema_fields), null, 2);
      }
      return next;
    });
  }

  function updateField(index, patch) {
    const fields = prompt.schema_fields.map((field, fieldIndex) => (
      fieldIndex === index ? { ...field, ...patch } : field
    ));
    updatePrompt({ schema_fields: fields });
  }

  function addField() {
    updatePrompt({
      schema_fields: [
        ...prompt.schema_fields,
        { name: `field_${prompt.schema_fields.length + 1}`, label: "新字段", type: "string", required: true, description: "" }
      ]
    });
  }

  function removeField(index) {
    updatePrompt({ schema_fields: prompt.schema_fields.filter((_, fieldIndex) => fieldIndex !== index) });
  }

  return (
    <div className="prompt-editor">
      <label>
        <span>Prompt 组</span>
        <select value={selectedPromptGroupId} onChange={(event) => onPromptGroupChange(event.target.value)}>
          <option value="">手动编辑当前 Prompt</option>
          {promptGroups.map((group) => (
            <option key={group.id} value={group.id}>{group.category} · {group.name}</option>
          ))}
        </select>
      </label>

      <div className="form-grid compact">
        <label>
          <span>模板名</span>
          <input value={prompt.name} onChange={(event) => updatePrompt({ name: event.target.value })} />
        </label>
        <label>
          <span>模型</span>
          <input value={prompt.model} onChange={(event) => updatePrompt({ model: event.target.value })} />
        </label>
        <label>
          <span>推理强度</span>
          <select value={prompt.reasoning_effort} onChange={(event) => updatePrompt({ reasoning_effort: event.target.value })}>
            {["none", "low", "medium", "high", "xhigh"].map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
      </div>

      <label>
        <span>逐章 Prompt</span>
        <textarea value={prompt.chapter_prompt} onChange={(event) => updatePrompt({ chapter_prompt: event.target.value })} />
      </label>
      <label>
        <span>汇总 Prompt</span>
        <textarea value={prompt.summary_prompt} onChange={(event) => updatePrompt({ summary_prompt: event.target.value })} />
      </label>

      <div className="segmented">
        <button
          type="button"
          className={prompt.schema_mode === "fields" ? "active" : ""}
          onClick={() => updatePrompt({ schema_mode: "fields" })}
        >
          <Table2 size={15} />
          字段表
        </button>
        <button
          type="button"
          className={prompt.schema_mode === "raw" ? "active" : ""}
          onClick={() => updatePrompt({ schema_mode: "raw" })}
        >
          <FileJson size={15} />
          原始 JSON
        </button>
      </div>

      {prompt.schema_mode === "fields" ? (
        <SchemaFieldTable fields={prompt.schema_fields} onUpdate={updateField} onAdd={addField} onRemove={removeField} />
      ) : (
        <label>
          <span>最终 JSON Schema</span>
          <textarea
            className={schemaValid ? "schema-box" : "schema-box invalid"}
            value={prompt.output_schema}
            onChange={(event) => updatePrompt({ output_schema: event.target.value })}
          />
        </label>
      )}

      <button className="secondary" type="button" onClick={onSave} disabled={busy || !schemaValid}>
        {busy ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
        保存为默认 Prompt
      </button>
    </div>
  );
}

function SchemaFieldTable({ fields, onUpdate, onAdd, onRemove }) {
  return (
    <div className="schema-fields">
      <div className="schema-field-head">
        <strong>最终 items 表字段</strong>
        <IconButton icon={Plus} label="添加字段" onClick={onAdd} />
      </div>
      <div className="table-wrap compact-table">
        <table>
          <thead>
            <tr>
              <th>字段名</th>
              <th>显示名</th>
              <th>类型</th>
              <th>必填</th>
              <th>描述</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((field, index) => (
              <tr key={`${field.name}-${index}`}>
                <td>
                  <input value={field.name} onChange={(event) => onUpdate(index, { name: event.target.value })} />
                </td>
                <td>
                  <input value={field.label} onChange={(event) => onUpdate(index, { label: event.target.value })} />
                </td>
                <td>
                  <select value={field.type} onChange={(event) => onUpdate(index, { type: event.target.value })}>
                    {schemaFieldTypes.map((type) => (
                      <option key={type} value={type}>{type}</option>
                    ))}
                  </select>
                </td>
                <td className="check-cell">
                  <input
                    type="checkbox"
                    checked={field.required}
                    onChange={(event) => onUpdate(index, { required: event.target.checked })}
                  />
                </td>
                <td>
                  <input value={field.description} onChange={(event) => onUpdate(index, { description: event.target.value })} />
                </td>
                <td>
                  <button type="button" className="icon-only danger-icon" onClick={() => onRemove(index)} title="删除字段">
                    <Trash2 size={15} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ResultView({ analysis }) {
  if (!analysis?.finalResult) return <div className="empty-state tall">没有已完成的最终结果</div>;
  const columns = resultColumnsFromPrompt(analysis.prompt, analysis.finalResult);
  const rows = Array.isArray(analysis.finalResult.items) ? analysis.finalResult.items : [];

  if (rows.length && columns.length) {
    return (
      <div className="result-stack">
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

  return <JsonPreview value={analysis.finalResult} />;
}

function JsonPreview({ value }) {
  return <pre className="json-preview">{JSON.stringify(value, null, 2)}</pre>;
}

function formatCell(value) {
  if (Array.isArray(value)) return value.join(", ");
  if (value && typeof value === "object") return JSON.stringify(value);
  if (value === undefined || value === null || value === "") return "-";
  return String(value);
}
