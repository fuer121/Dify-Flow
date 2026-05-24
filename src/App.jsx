import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, BarChart3, BookOpen, ClipboardList, ShieldCheck, Stethoscope } from "lucide-react";
import { apiGet, apiPost, apiPut, followTask } from "./api.js";
import { AnalysisPage } from "./pages/AnalysisPage.jsx";
import { DiagnosticsPage } from "./pages/DiagnosticsPage.jsx";
import { LibraryPage } from "./pages/LibraryPage.jsx";
import { PromptLibraryPage } from "./pages/PromptLibraryPage.jsx";
import { LoadingScreen, RuntimeGrid, StatusPill } from "./ui.jsx";

function currentRoute() {
  if (window.location.pathname === "/prompts") return "prompts";
  if (window.location.pathname === "/diagnostics") return "diagnostics";
  return window.location.pathname === "/library" ? "library" : "analysis";
}

export default function App() {
  const [route, setRoute] = useState(currentRoute);
  const [config, setConfig] = useState(null);
  const [books, setBooks] = useState([]);
  const [prompts, setPrompts] = useState(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [importTask, setImportTask] = useState(null);
  const [importBusy, setImportBusy] = useState(false);
  const [l1Task, setL1Task] = useState(null);
  const [l1Busy, setL1Busy] = useState(false);
  const [l2Task, setL2Task] = useState(null);
  const [l2Busy, setL2Busy] = useState(false);
  const [analysisTask, setAnalysisTask] = useState(null);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const importSourceRef = useRef(null);
  const l1SourceRef = useRef(null);
  const l2SourceRef = useRef(null);
  const analysisSourceRef = useRef(null);

  const bindImportTask = useCallback((task, options = {}) => {
    if (!task?.id) return;
    setImportTask(task);
    setImportBusy(isLiveTask(task));
    importSourceRef.current?.close();
    importSourceRef.current = null;
    if (!isLiveTask(task)) return;
    importSourceRef.current = followTask(
      `/api/imports/${encodeURIComponent(task.id)}/events`,
      setImportTask,
      async (finishedTask) => {
        importSourceRef.current = null;
        setImportBusy(false);
        try {
          await reloadBooks();
        } catch (reloadError) {
          setError(reloadError.message);
        }
        if (finishedTask.status === "failed") setError(finishedTask.error || "导入失败");
        if (finishedTask.status === "completed" && options.autoL1) {
          await startL1Index({
            bookId: finishedTask.payload?.bookId || options.autoL1.bookId,
            startChapter: finishedTask.payload?.startChapter || options.autoL1.startChapter,
            endChapter: finishedTask.payload?.endChapter || options.autoL1.endChapter
          });
        }
      }
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bindL1Task = useCallback((task) => {
    if (!task?.id) return;
    setL1Task(task);
    setL1Busy(isLiveTask(task));
    l1SourceRef.current?.close();
    l1SourceRef.current = null;
    if (!isLiveTask(task)) return;
    l1SourceRef.current = followTask(
      `/api/l1-indexes/${encodeURIComponent(task.id)}/events`,
      setL1Task,
      (finishedTask) => {
        l1SourceRef.current = null;
        setL1Busy(false);
        if (finishedTask.status === "failed") setError(finishedTask.error || "L1 索引失败");
      }
    );
  }, []);

  const bindL2Task = useCallback((task) => {
    if (!task?.id) return;
    setL2Task(task);
    setL2Busy(isLiveTask(task));
    l2SourceRef.current?.close();
    l2SourceRef.current = null;
    if (!isLiveTask(task)) return;
    l2SourceRef.current = followTask(
      `/api/l2-indexes/${encodeURIComponent(task.id)}/events`,
      setL2Task,
      (finishedTask) => {
        l2SourceRef.current = null;
        setL2Busy(false);
        if (finishedTask.status === "failed") setError(finishedTask.error || "L2 索引失败");
      }
    );
  }, []);

  const bindAnalysisTask = useCallback((task, options = {}) => {
    if (!task?.id) return;
    setAnalysisTask(task);
    setAnalysisBusy(isLiveTask(task));
    analysisSourceRef.current?.close();
    analysisSourceRef.current = null;
    if (!isLiveTask(task)) return;
    analysisSourceRef.current = followTask(
      `/api/analyses/${encodeURIComponent(task.id)}/events`,
      setAnalysisTask,
      async (finishedTask) => {
        analysisSourceRef.current = null;
        setAnalysisBusy(false);
        if (finishedTask.status === "failed") setError(finishedTask.error || "分析失败");
        await options.onTerminal?.(finishedTask);
      }
    );
  }, []);

  useEffect(() => {
    const onPopState = () => setRoute(currentRoute());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const loadAll = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const [configData, booksData, promptsData] = await Promise.all([
        apiGet("/api/config"),
        apiGet("/api/books"),
        apiGet("/api/prompts")
      ]);
      setConfig(configData.runtime);
      setBooks(booksData.books || []);
      setPrompts(promptsData.prompts);
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

  useEffect(() => {
    if (busy) return;
    let cancelled = false;
    async function restoreLiveTasks() {
      try {
        const data = await apiGet("/api/tasks");
        if (cancelled) return;
        const liveTasks = (data.tasks || []).filter(isLiveTask);
        const latestImport = liveTasks.find((task) => task.type === "import");
        const latestL1 = liveTasks.find((task) => task.type === "l1-index");
        const latestL2 = liveTasks.find((task) => task.type === "l2-index");
        const latestAnalysis = liveTasks.find((task) => task.type === "analysis");
        if (latestImport && !importSourceRef.current && !importTask) bindImportTask(latestImport);
        if (latestL1 && !l1SourceRef.current && !l1Task) bindL1Task(latestL1);
        if (latestL2 && !l2SourceRef.current && !l2Task) bindL2Task(latestL2);
        if (latestAnalysis && !analysisSourceRef.current && !analysisTask) bindAnalysisTask(latestAnalysis);
      } catch {
        // Older running servers do not have /api/tasks yet. Keep the UI usable.
      }
    }
    void restoreLiveTasks();
    return () => {
      cancelled = true;
    };
  }, [analysisTask, bindAnalysisTask, bindImportTask, bindL1Task, bindL2Task, busy, importTask, l1Task, l2Task]);

  useEffect(() => () => {
    importSourceRef.current?.close();
    l1SourceRef.current?.close();
    l2SourceRef.current?.close();
    analysisSourceRef.current?.close();
  }, []);

  async function reloadBooks() {
    const data = await apiGet("/api/books");
    setBooks(data.books || []);
    return data.books || [];
  }

  async function reloadPromptGroups() {
    const data = await apiGet("/api/prompt-groups");
    return data.promptGroups || [];
  }

  async function loadPromptGroupsForBook(bookId) {
    const query = bookId ? `?book_id=${encodeURIComponent(bookId)}` : "?book_id=";
    const data = await apiGet(`/api/prompt-groups${query}`);
    return data.promptGroups || [];
  }

  async function createBook(payload) {
    const data = await apiPost("/api/books", payload);
    await reloadBooks();
    return data.book;
  }

  async function loadBookIndexPrompts(bookId) {
    const data = await apiGet(`/api/books/${encodeURIComponent(bookId)}/index-prompts`);
    return data;
  }

  async function saveBookIndexPrompts(bookId, payload) {
    const data = await apiPut(`/api/books/${encodeURIComponent(bookId)}/index-prompts`, payload);
    return data.indexPrompts;
  }

  async function startImport(importForm) {
    if (importBusy) return importTask;
    const shouldAutoL1 = Boolean(importForm.auto_l1_index);
    const autoL1Range = {
      bookId: importForm.book_id,
      startChapter: importForm.start_chapter,
      endChapter: importForm.end_chapter
    };
    setImportBusy(true);
    setError("");
    setImportTask(null);
    importSourceRef.current?.close();
    importSourceRef.current = null;
    try {
      const data = await apiPost("/api/books/imports", importForm);
      bindImportTask(data.task, { autoL1: shouldAutoL1 ? autoL1Range : null });
      return data.task;
    } catch (startError) {
      setImportBusy(false);
      setError(startError.message);
      return null;
    }
  }

  async function startL1Index({ bookId, startChapter, endChapter, force = false }) {
    if (l1Busy) return l1Task;
    setL1Busy(true);
    setError("");
    setL1Task(null);
    l1SourceRef.current?.close();
    l1SourceRef.current = null;
    try {
      const data = await apiPost(`/api/books/${encodeURIComponent(bookId)}/l1-indexes`, {
        start_chapter: startChapter,
        end_chapter: endChapter,
        force
      });
      bindL1Task(data.task);
      return data.task;
    } catch (startError) {
      setL1Busy(false);
      setError(startError.message);
      return null;
    }
  }

  async function startL2Index({ bookId, startChapter, endChapter, force = false, mode = "all" }) {
    if (l2Busy) return l2Task;
    setL2Busy(true);
    setError("");
    setL2Task(null);
    l2SourceRef.current?.close();
    l2SourceRef.current = null;
    try {
      const data = await apiPost(`/api/books/${encodeURIComponent(bookId)}/l2-indexes`, {
        start_chapter: startChapter,
        end_chapter: endChapter,
        force,
        mode
      });
      bindL2Task(data.task);
      return data.task;
    } catch (startError) {
      setL2Busy(false);
      setError(startError.message);
      return null;
    }
  }

  async function controlImport(action) {
    if (!importTask?.id) return;
    setError("");
    try {
      const data = await apiPost(`/api/imports/${encodeURIComponent(importTask.id)}/${action}`, {});
      setImportTask(data.task);
      setImportBusy(isLiveTask(data.task));
      if (action === "cancel") {
        importSourceRef.current?.close();
        importSourceRef.current = null;
        setImportBusy(false);
        await reloadBooks();
      }
    } catch (controlError) {
      setError(controlError.message);
    }
  }

  async function controlL1(action) {
    if (!l1Task?.id) return;
    setError("");
    try {
      const data = await apiPost(`/api/l1-indexes/${encodeURIComponent(l1Task.id)}/${action}`, {});
      setL1Task(data.task);
      setL1Busy(isLiveTask(data.task));
      if (action === "cancel") {
        l1SourceRef.current?.close();
        l1SourceRef.current = null;
        setL1Busy(false);
      }
    } catch (controlError) {
      setError(controlError.message);
    }
  }

  async function controlL2(action) {
    if (!l2Task?.id) return;
    setError("");
    try {
      const data = await apiPost(`/api/l2-indexes/${encodeURIComponent(l2Task.id)}/${action}`, {});
      setL2Task(data.task);
      setL2Busy(isLiveTask(data.task));
      if (action === "cancel") {
        l2SourceRef.current?.close();
        l2SourceRef.current = null;
        setL2Busy(false);
      }
    } catch (controlError) {
      setError(controlError.message);
    }
  }

  async function startAnalysis(payload, options = {}) {
    if (analysisBusy) return analysisTask;
    setAnalysisBusy(true);
    setError("");
    setAnalysisTask(null);
    analysisSourceRef.current?.close();
    analysisSourceRef.current = null;
    try {
      const data = await apiPost("/api/analyses", payload);
      bindAnalysisTask(data.task, options);
      return data.task;
    } catch (startError) {
      setAnalysisBusy(false);
      setError(startError.message);
      return null;
    }
  }

  async function resumeAnalysisRun(id, options = {}) {
    if (!id) return null;
    if (analysisBusy && analysisTask?.id === id) return analysisTask;
    setAnalysisBusy(true);
    setError("");
    analysisSourceRef.current?.close();
    analysisSourceRef.current = null;
    try {
      const data = await apiPost(`/api/analyses/${encodeURIComponent(id)}/resume-run`, {});
      bindAnalysisTask(data.task, options);
      return data.task;
    } catch (resumeError) {
      setAnalysisBusy(false);
      setError(resumeError.message);
      return null;
    }
  }

  async function controlAnalysis(action) {
    if (!analysisTask?.id) return;
    setError("");
    try {
      const data = await apiPost(`/api/analyses/${encodeURIComponent(analysisTask.id)}/${action}`, {});
      setAnalysisTask(data.task);
      setAnalysisBusy(isLiveTask(data.task));
      if (action === "cancel") {
        analysisSourceRef.current?.close();
        analysisSourceRef.current = null;
        setAnalysisBusy(false);
      }
    } catch (controlError) {
      setError(controlError.message);
    }
  }

  function navigate(nextRoute) {
    const path = nextRoute === "library"
      ? "/library"
      : nextRoute === "prompts"
        ? "/prompts"
        : nextRoute === "diagnostics"
          ? "/diagnostics"
          : "/";
    window.history.pushState({}, "", path);
    setRoute(nextRoute);
  }

  const importProgress = importTask?.progress || {};
  const importStatusText = importProgress.total
    ? `${importProgress.completed || 0}/${importProgress.total} · ${importProgress.current || "后台导入中"}`
    : importProgress.current || "后台导入中";
  const analysisProgress = analysisTask?.progress || {};
  const analysisStatusText = analysisProgress.total
    ? `${(analysisProgress.completed || 0) + (analysisProgress.failed || 0) + (analysisProgress.skipped || 0)}/${analysisProgress.total} · ${analysisProgress.current || "后台分析中"}`
    : analysisProgress.current || "后台分析中";

  if (busy || !config || !prompts) {
    return <LoadingScreen />;
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><ShieldCheck size={22} /></div>
          <div>
            <h1>小说分析台</h1>
            <p>本地库 · 索引 · 分析</p>
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
            分析
          </button>
          <button
            type="button"
            className={route === "library" ? "active" : ""}
            onClick={() => navigate("library")}
          >
            <BookOpen size={16} />
            书库
          </button>
          <button
            type="button"
            className={route === "prompts" ? "active" : ""}
            onClick={() => navigate("prompts")}
          >
            <ClipboardList size={16} />
            Prompt 库
          </button>
          <button
            type="button"
            className={route === "diagnostics" ? "active" : ""}
            onClick={() => navigate("diagnostics")}
          >
            <Stethoscope size={16} />
            诊断
          </button>
        </nav>

        <div className="background-task-stack">
          {importBusy && importTask ? (
            <button className="background-task-chip" type="button" title={importStatusText} onClick={() => navigate("library")}>
              <StatusPill status={importTask.status} />
              <span>导入 · {importStatusText}</span>
            </button>
          ) : null}
          {l1Busy && l1Task ? (
            <button className="background-task-chip" type="button" title={l1Task.progress?.current || "L1 索引构建中"} onClick={() => navigate("library")}>
              <StatusPill status={l1Task.status} />
              <span>L1 · {l1Task.progress?.current || "索引构建中"}</span>
            </button>
          ) : null}
          {l2Busy && l2Task ? (
            <button className="background-task-chip" type="button" title={l2Task.progress?.current || "L2 索引构建中"} onClick={() => navigate("library")}>
              <StatusPill status={l2Task.status} />
              <span>L2 · {l2Task.progress?.current || "事实索引中"}</span>
            </button>
          ) : null}
          {analysisBusy && analysisTask ? (
            <button className="background-task-chip" type="button" title={analysisStatusText} onClick={() => navigate("analysis")}>
              <StatusPill status={analysisTask.status} />
              <span>分析 · {analysisStatusText}</span>
            </button>
          ) : null}
        </div>
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
          l1Task={l1Task}
          l1Busy={l1Busy}
          l2Task={l2Task}
          l2Busy={l2Busy}
          onStartImport={startImport}
          onStartL1Index={startL1Index}
          onStartL2Index={startL2Index}
          onImportCancel={() => controlImport("cancel")}
          onImportPause={() => controlImport("pause")}
          onImportResume={() => controlImport("resume")}
          onL1Cancel={() => controlL1("cancel")}
          onL1Pause={() => controlL1("pause")}
          onL1Resume={() => controlL1("resume")}
          onL2Cancel={() => controlL2("cancel")}
          onL2Pause={() => controlL2("pause")}
          onL2Resume={() => controlL2("resume")}
          onBooksChanged={reloadBooks}
          setError={setError}
        />
      ) : route === "prompts" ? (
        <PromptLibraryPage
          books={books}
          config={config}
          onCreateBook={createBook}
          onBooksChanged={reloadBooks}
          onLoadBookIndexPrompts={loadBookIndexPrompts}
          onSaveBookIndexPrompts={saveBookIndexPrompts}
          onStartL1Index={startL1Index}
          onStartL2Index={startL2Index}
          onLoadPromptGroups={loadPromptGroupsForBook}
          onPromptGroupsChanged={reloadPromptGroups}
          setError={setError}
        />
      ) : route === "diagnostics" ? (
        <DiagnosticsPage
          config={config}
          setError={setError}
        />
      ) : (
        <AnalysisPage
          books={books}
          config={config}
          prompts={prompts}
          onLoadPromptGroups={loadPromptGroupsForBook}
          analysisTask={analysisTask}
          analysisBusy={analysisBusy}
          onStartAnalysis={startAnalysis}
          onResumeAnalysisRun={resumeAnalysisRun}
          onAnalysisCancel={() => controlAnalysis("cancel")}
          onAnalysisPause={() => controlAnalysis("pause")}
          onAnalysisResume={() => controlAnalysis("resume")}
          setError={setError}
        />
      )}
    </main>
  );
}

function isLiveTask(task) {
  return Boolean(task && ["queued", "running", "paused"].includes(task.status));
}
