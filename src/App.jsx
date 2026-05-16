import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, BarChart3, BookOpen, ClipboardList, ShieldCheck } from "lucide-react";
import { apiGet, apiPost, followTask } from "./api.js";
import { AnalysisPage } from "./pages/AnalysisPage.jsx";
import { LibraryPage } from "./pages/LibraryPage.jsx";
import { PromptLibraryPage } from "./pages/PromptLibraryPage.jsx";
import { LoadingScreen, RuntimeGrid, StatusPill } from "./ui.jsx";

function currentRoute() {
  if (window.location.pathname === "/prompts") return "prompts";
  return window.location.pathname === "/library" ? "library" : "analysis";
}

export default function App() {
  const [route, setRoute] = useState(currentRoute);
  const [config, setConfig] = useState(null);
  const [books, setBooks] = useState([]);
  const [prompts, setPrompts] = useState(null);
  const [promptGroups, setPromptGroups] = useState([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [importTask, setImportTask] = useState(null);
  const [importBusy, setImportBusy] = useState(false);
  const importSourceRef = useRef(null);

  useEffect(() => {
    const onPopState = () => setRoute(currentRoute());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const loadAll = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const [configData, booksData, promptsData, promptGroupsData] = await Promise.all([
        apiGet("/api/config"),
        apiGet("/api/books"),
        apiGet("/api/prompts"),
        apiGet("/api/prompt-groups")
      ]);
      setConfig(configData.runtime);
      setBooks(booksData.books || []);
      setPrompts(promptsData.prompts);
      setPromptGroups(promptGroupsData.promptGroups || []);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadAll();
  }, [loadAll]);

  useEffect(() => () => importSourceRef.current?.close(), []);

  async function reloadBooks() {
    const data = await apiGet("/api/books");
    setBooks(data.books || []);
    return data.books || [];
  }

  async function reloadPromptGroups() {
    const data = await apiGet("/api/prompt-groups");
    setPromptGroups(data.promptGroups || []);
    return data.promptGroups || [];
  }

  async function startImport(importForm) {
    if (importBusy) return importTask;
    setImportBusy(true);
    setError("");
    setImportTask(null);
    importSourceRef.current?.close();
    importSourceRef.current = null;
    try {
      const data = await apiPost("/api/books/imports", importForm);
      setImportTask(data.task);
      importSourceRef.current = followTask(
        `/api/imports/${encodeURIComponent(data.task.id)}/events`,
        setImportTask,
        async (task) => {
          importSourceRef.current = null;
          setImportBusy(false);
          try {
            await reloadBooks();
          } catch (reloadError) {
            setError(reloadError.message);
          }
          if (task.status === "failed") setError(task.error || "导入失败");
        }
      );
      return data.task;
    } catch (startError) {
      setImportBusy(false);
      setError(startError.message);
      return null;
    }
  }

  function navigate(nextRoute) {
    const path = nextRoute === "library" ? "/library" : nextRoute === "prompts" ? "/prompts" : "/";
    window.history.pushState({}, "", path);
    setRoute(nextRoute);
  }

  const importProgress = importTask?.progress || {};
  const importStatusText = importProgress.total
    ? `${importProgress.completed || 0}/${importProgress.total} · ${importProgress.current || "后台导入中"}`
    : importProgress.current || "后台导入中";

  if (busy || !config || !prompts) {
    return <LoadingScreen />;
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><ShieldCheck size={22} /></div>
          <div>
            <h1>小说章节安全分析台</h1>
            <p>本地加密章节库 · 任务级 Prompt · GPT 结构化分析</p>
          </div>
        </div>
        <RuntimeGrid config={config} />
      </header>

      <div className="navigation-row">
        <nav className="page-tabs" aria-label="主要页面">
          <button
            type="button"
            className={route === "analysis" ? "active" : ""}
            onClick={() => navigate("analysis")}
          >
            <BarChart3 size={16} />
            分析任务中心
          </button>
          <button
            type="button"
            className={route === "library" ? "active" : ""}
            onClick={() => navigate("library")}
          >
            <BookOpen size={16} />
            书籍章节库
          </button>
          <button
            type="button"
            className={route === "prompts" ? "active" : ""}
            onClick={() => navigate("prompts")}
          >
            <ClipboardList size={16} />
            Prompt 库
          </button>
        </nav>

        {importBusy && importTask ? (
          <div className="background-task-chip" title={importStatusText}>
            <StatusPill status={importTask.status} />
            <span>{importStatusText}</span>
          </div>
        ) : null}
      </div>

      {error ? (
        <section className="alert">
          <AlertTriangle size={18} />
          <span>{error}</span>
        </section>
      ) : null}

      {route === "library" ? (
        <LibraryPage
          books={books}
          config={config}
          importTask={importTask}
          importBusy={importBusy}
          onStartImport={startImport}
          onBooksChanged={reloadBooks}
          setError={setError}
        />
      ) : route === "prompts" ? (
        <PromptLibraryPage
          books={books}
          promptGroups={promptGroups}
          onPromptGroupsChanged={reloadPromptGroups}
          setError={setError}
        />
      ) : (
        <AnalysisPage
          books={books}
          config={config}
          prompts={prompts}
          promptGroups={promptGroups}
          onPromptsChanged={setPrompts}
          setError={setError}
        />
      )}
    </main>
  );
}
