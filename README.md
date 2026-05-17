# 小说章节安全分析台

独立本地 Web 服务：用自托管 Dify 分批获取章节原文，只获取一次；章节正文和 GPT 分析结果加密落本地 SQLite；后续不同 Prompt 的 GPT 分析直接读取本地加密章节库。

## 安全边界

- 章节正文不写明文文件、不进浏览器 localStorage、不出现在普通日志。
- SQLite 只明文保存元数据：`book_id`、章节号、标题、长度、HMAC、状态、时间。
- 正文和分析结果使用 AES-256-GCM 加密。
- HMAC-SHA256 用主密钥计算，不保存普通明文 hash。
- 主密钥默认存 macOS Keychain：`novel-chapter-gpt-service / master-key`。
- OpenAI Responses API 调用强制 `store: false`。
- 服务不使用 OpenAI Files、Vector Stores、Assistants、Threads、Batch、background mode。

严格使用真实版权原文前，请确认 OpenAI 项目已启用 ZDR 或 MAM，并把 `OPENAI_RETENTION_MODE` 设置为 `zdr` 或 `mam`。未设置时，后端会阻止真实章节分析。

## 准备

```bash
cp .env.example .env
```

编辑 `.env`：

```bash
DIFY_API_BASE=http://127.0.0.1:5001/v1
DIFY_CHAPTER_WORKFLOW_API_KEY=app-你的自托管Dify章节工作流Key
OPENAI_API_KEY=sk-你的OpenAIKey
OPENAI_MODEL=gpt-5.5
OPENAI_RETENTION_MODE=zdr
HOST=0.0.0.0
PORT=5174
DATA_DIR=./data
IMPORT_BATCH_SIZE=10
OPENAI_CHAPTER_CONCURRENCY=1
OPENAI_PROXY_URL=
OPENAI_API_BASE=https://api.openai.com/v1
```

如果服务器所在网络不能直连 `api.openai.com`，可把 `OPENAI_PROXY_URL` 设置为本机或 VPN 的 HTTP 代理，例如 `http://127.0.0.1:7897`。如需使用 OpenAI 兼容网关，`OPENAI_API_BASE` 必须指向你确认合规、可承载版权章节内容的地址。

把 `dify-workflows/minimal-chapter-fetch.workflow.yml` 导入自托管 Dify，并发布为 Workflow API。该工作流只负责返回章节原文 JSON，不接 LLM。

## 启动

```bash
npm install
npm run dev
```

前端默认：

```text
http://127.0.0.1:5173
```

后端 API：

```text
http://127.0.0.1:5174
```

## 局域网访问

构建前端后用后端服务托管整个网站：

```bash
npm run build
npm run start:lan
```

同一局域网设备打开：

```text
http://你的本机局域网IP:5174
```

例如本机 IP 是 `172.16.75.46` 时，访问 `http://172.16.75.46:5174`。只在可信局域网/VPN 内使用，不要暴露到公网。

## API

- `POST /api/books/imports`：创建章节导入任务，支持 `book_name` 与 `book_id` 绑定；同一 `book_id` 不能绑定不同书名。
- `GET /api/imports/:id`：查询导入任务。
- `GET /api/imports/:id/events`：导入任务 SSE。
- `GET /api/books/:bookId/chapters`：只返回章节元数据。
- `POST /api/analyses`：创建 GPT 分析任务，支持 `name`、`chapter_indexes` 和任务级 Prompt/Schema。
- `GET /api/analyses`：读取分析任务列表。
- `GET /api/analyses/:id`：读取分析结果和任务级 Prompt/Schema 快照。
- `GET /api/analyses/:id/events`：分析任务 SSE。
- `DELETE /api/analyses/:id`：删除单个分析任务及其加密结果。
- `GET/PUT /api/prompts`：读取和保存默认 Prompt/Schema，支持字段表和原始 JSON Schema 双模式。
- `GET/POST /api/prompt-groups`：读取和新建 Prompt 组，支持名称和分类。
- `GET/PUT/DELETE /api/prompt-groups/:id`：查看、编辑和删除单个 Prompt 组。
- `POST /api/books/:bookId/delete`：删除一本书的本地数据。

## 页面

- `/`：分析任务中心。创建、运行、查看、复制和删除分析任务，可从已导入章节中按范围勾选具体章节。
- `/library`：书籍章节库。导入书籍章节、查看章节元数据、删除本地书籍数据。
- `/prompts`：Prompt 库。新建、编辑、删除和分类管理多组逐章 Prompt/汇总 Prompt。

## 自托管 Dify 建议

建议至少检查这些配置：

```text
DEBUG=false
ENABLE_REQUEST_LOGGING=false
WORKFLOW_LOG_CLEANUP_ENABLED=true
WORKFLOW_LOG_RETENTION_DAYS=1
```

同时把 Dify Docker/Postgres 数据卷放在 FileVault 或等效磁盘加密分区，只绑定本机、内网或 VPN。

## 测试

```bash
npm test
npm run build
```

测试覆盖：

- Dify 分批和章节输出解析。
- AES-GCM 加密、HMAC、SQLite 明文扫描。
- OpenAI 请求断言 `store:false` 且不含 `background`。
- 导入 3 章、二次导入跳过、GPT 分析不重复调用 Dify。
