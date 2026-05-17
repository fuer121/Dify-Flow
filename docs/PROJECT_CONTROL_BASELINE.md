# Project Control Baseline

Last checkpoint: 2026-05-17, Asia/Shanghai

This file is the single source of truth for the Novel Chapter GPT Service control thread. Future work should update this file whenever project-level assumptions, ports, security posture, deployment details, or operating rules change.

## Project Identity

- Name: Novel Chapter GPT Service / 小说章节安全分析台
- Local path: `/Users/staff/Desktop/Vibe coding/novel-chapter-gpt-service`
- Git remote: `git@github.com:fuer121/Dify-Flow.git`
- Default branch: `main`
- Current pushed baseline commit: `bdfafe1 Initial novel chapter GPT service`
- GitHub CLI: installed at `~/.local/bin/gh`, authenticated as `fuer121`

## Purpose

The service imports novel chapters once from a minimal Dify workflow, stores chapter text encrypted locally, and lets the user run repeatable GPT analysis tasks against already-imported chapters. The frontend must never display or store full chapter text by default.

Primary workflows:

- Import a book/range from Dify in small batches.
- Store chapter metadata in SQLite and chapter content as AES-256-GCM ciphertext.
- Create analysis tasks using stored chapter ranges or selected chapter indexes.
- Configure prompt groups and task-level prompts.
- Render final JSON results as tables when possible.

## Architecture

- Frontend: React + Vite.
- Backend: Express on Node.js.
- Storage: SQLite metadata and encrypted content under `data/`.
- Dify integration: workflow API only, minimal chapter fetch workflow.
- GPT integration: OpenAI-compatible Responses API with `store: false`.
- Encryption:
  - AES-256-GCM for chapter content and analysis results.
  - HMAC-SHA256 for content verification.
  - Master key stored in macOS Keychain by default.

Key directories:

- `src/`: React app.
- `src/pages/AnalysisPage.jsx`: analysis task center.
- `src/pages/LibraryPage.jsx`: book import and chapter metadata library.
- `src/pages/PromptLibraryPage.jsx`: prompt group library.
- `server/`: API, storage, encryption, Dify, OpenAI-compatible calls.
- `dify-workflows/minimal-chapter-fetch.workflow.yml`: importable minimal Dify workflow.
- `docs/security-notes.md`: security notes.
- `docs/PROJECT_CONTROL_BASELINE.md`: this control baseline.

## Runtime And Ports

Local development:

- Vite frontend: `http://127.0.0.1:5173`
- Backend API in `.env`: `PORT=5184`
- LAN production service: `http://192.168.1.163:5184/` as of 2026-05-16
- The LAN IP can change with DHCP; re-check with `ifconfig | rg -n "inet (172|192|10)\\."`.

Launch service:

```bash
npm run build
HOST=0.0.0.0 PORT=5184 node server/index.js
```

Current launchctl label used locally:

```text
com.novel-chapter-gpt-service
```

## Configuration Contract

Required `.env` keys:

- `DIFY_API_BASE`
- `DIFY_CHAPTER_WORKFLOW_API_KEY`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `OPENAI_RETENTION_MODE`
- `HOST`
- `PORT`
- `DATA_DIR`
- `IMPORT_BATCH_SIZE`
- `OPENAI_CHAPTER_CONCURRENCY`
- `OPENAI_PROXY_URL`
- `OPENAI_API_BASE`

Current non-secret runtime shape:

- Dify base: `https://dify.qmniu.com/v1`
- OpenAI-compatible base: `https://apitokenzz.xyz/v1`
- Model: `gpt-5.5`
- Retention mode flag: `zdr`
- Import batch size: `10`
- Chapter analysis concurrency: `1`
- Proxy: configured via `OPENAI_PROXY_URL`; do not commit its value if it becomes sensitive.

Important: `OPENAI_API_BASE=https://apitokenzz.xyz/v1` is a third-party OpenAI-compatible endpoint, not proven to be official OpenAI ZDR/MAM. Before sending real copyrighted chapter text through it, the user must confirm its data retention and legal/security posture.

## Security Rules

Never commit or paste:

- `.env`
- API keys or bearer tokens
- `data/`
- SQLite files, WAL/SHM files, logs, exports, or backups containing encrypted book data
- Full chapter text
- Raw Dify workflow outputs containing chapter text
- OpenAI request bodies or prompt bodies containing real chapter text

`.gitignore` must keep excluding:

- `.env`
- `.env.*` except `.env.example`
- `data/*`
- `node_modules/`
- `dist/`
- logs
- OS/editor files

When adding diagnostics:

- Log only task IDs, chapter indexes, status codes, sanitized messages, and counts.
- Do not log prompts, chapter text, Dify raw output, or OpenAI request bodies.
- Use `/api/openai/test` for no-chapter connectivity checks before analysis.

## Current Public Interfaces

Backend:

- `GET /api/config`
- `GET /api/dify/test`
- `GET /api/openai/test`
- `GET /api/books`
- `POST /api/books/imports`
- `GET /api/imports/:id`
- `GET /api/imports/:id/events`
- `POST /api/imports/:id/cancel`
- `GET /api/books/:bookId/chapters`
- `POST /api/books/:bookId/delete`
- `GET /api/analyses`
- `POST /api/analyses`
- `GET /api/analyses/:id`
- `GET /api/analyses/:id/events`
- `POST /api/analyses/:id/cancel`
- `DELETE /api/analyses/:id`
- `GET /api/prompts`
- `PUT /api/prompts`
- `GET /api/prompt-groups`
- `POST /api/prompt-groups`
- `GET /api/prompt-groups/:id`
- `PUT /api/prompt-groups/:id`
- `DELETE /api/prompt-groups/:id`

Frontend routes:

- `/`: analysis task center.
- `/library`: book and chapter metadata library.
- `/prompts`: prompt group library.

## Known Implemented Behaviors

- Book import supports `book_name` bound to `book_id`; one `book_id` cannot have two names.
- Import tasks are owned by `App.jsx`, so switching pages does not lose import state.
- Analysis tasks can select non-contiguous chapters.
- Prompt groups can be created, edited, deleted, named, and categorized.
- Prompt/schema snapshots are stored per analysis task.
- OpenAI-compatible calls use Responses API shape with `store: false` and no `background`.
- The service runs an OpenAI-compatible connectivity check before analysis starts, preventing per-chapter network/key failures.
- Dify diagnostics are available at `/api/dify/test`; this checks Dify App API access without pulling chapter text.
- Final results render as a table when `finalResult.items` can be tabular; otherwise JSON preview is shown.

## Verification Commands

Use these before committing substantial changes:

```bash
npm run lint
npm test
npm run build
curl -s http://127.0.0.1:5184/api/config | jq .
curl -s http://127.0.0.1:5184/api/dify/test | jq .
curl -s http://127.0.0.1:5184/api/openai/test | jq .
```

Git checks before push:

```bash
git status --short --branch
git check-ignore -v .env data/novel-chapters.sqlite dist/index.html node_modules/.package-lock.json .DS_Store
git grep --cached -n -I -E '(cg_[A-Za-z0-9_-]+|sk-(proj-)?[A-Za-z0-9_-]{12,}|app-[A-Za-z0-9]{12,}|OPENAI_API_KEY=.+|DIFY_CHAPTER_WORKFLOW_API_KEY=.+)' -- . || true
```

## Git And Release Rules

- Commit only source, docs, tests, and safe examples.
- Do not commit generated `dist/` unless explicitly required.
- Do not commit `.env` or `data/`.
- Prefer small commits with clear messages.
- Before push, run lint/tests/build and staged secret scan.

## Current Operational Notes

- GitHub CLI is installed and authenticated as `fuer121`.
- `gh` is on `~/.local/bin`; `.zshrc` adds this directory to `PATH`.
- Git remote is currently SSH. If SSH fails due to port 22/network issues, switch remote to HTTPS:

```bash
git remote set-url origin https://github.com/fuer121/Dify-Flow.git
```

## Future Work Queue

- Add UI surface for `/api/openai/test` so users can test model connectivity before creating an analysis task.
- Consider virtualizing long chapter metadata tables for very large books.
- Add explicit retry controls for failed import batches and failed analysis chapters.
- Add encrypted export/import for backups if needed.
- Add a small admin page for runtime diagnostics that never displays secrets or chapter text.
