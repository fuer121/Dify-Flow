# 小说章节安全分析台：项目基线

最后更新：2026-05-20 17:40，Asia/Shanghai

本文档是当前项目的唯一真实信息源。后续线程、后续迭代，只要涉及项目目标、架构、安全边界、运行配置、关键决策、路线图或运维方式变化，都必须同步更新本文档。

## 1. 项目身份

- 产品名称：Novel Chapter GPT Service / 小说章节安全分析台
- 本地路径：`/Users/staff/Desktop/Vibe coding/novel-chapter-gpt-service`
- Git 远程仓库：`git@github.com:fuer121/Dify-Flow.git`
- 默认分支：`main`
- 当前项目基线提交：以 `git log -1 --oneline -- docs/PROJECT_CONTROL_BASELINE.md` 为准
- GitHub CLI：已安装在 `~/.local/bin/gh`，当前登录用户为 `fuer121`

## 2. 项目目标

建设一个本地运行、可在局域网访问的小说长文本分析服务：

- 通过自托管 Dify 的最小工作流，一次性导入小说章节。
- 章节正文导入后本地加密保存。
- 后续不同 Prompt、不同分析任务复用本地章节库，不重复调用 Dify。
- 前端不展示、不保存整章正文。
- 日志、Git、普通文件、浏览器存储中不出现章节正文。
- 逐步通过可复用索引和更安全的重试机制，提高长篇小说分析效率。

当前产品定位是本地/内网自用工具，不是公网 SaaS 服务。

## 3. 当前运行快照

截至 2026-05-20 17:40：

- 服务进程：Node.js，监听 `*:5184`
- 当前监听进程：`PID 41886`
- 本机地址：`http://127.0.0.1:5184/`
- 当前局域网地址：`http://172.16.75.46:5184/`
- 当前 VPN/内网地址：`http://10.8.11.29:5184/`
- 局域网 IP 可能随 DHCP 变化，重新确认命令：

```bash
ifconfig | rg -n "inet (10|172\\.(1[6-9]|2[0-9]|3[0-1])|192\\.168)\\."
```

当前非敏感运行配置：

- `HOST=0.0.0.0`
- `PORT=5184`
- `DIFY_API_BASE=https://dify.qmniu.com/v1`
- `OPENAI_API_BASE=https://apitokenzz.xyz/v1`
- `OPENAI_MODEL=gpt-5.5`
- `OPENAI_RETENTION_MODE=zdr`
- `OPENAI_REQUEST_TIMEOUT_MS=600000`
- `IMPORT_BATCH_SIZE=10`
- `OPENAI_CHAPTER_CONCURRENCY=1`
- `OPENAI_PROXY_URL=` 当前为空，因为 `http://127.0.0.1:7897` 曾导致 TLS/代理链路不稳定。

本机预览环境：

- 用途：在不提交、不重启线上 `5184` 服务的情况下，查看和验证新版效果。
- 地址：`http://127.0.0.1:5194/`
- 绑定：`HOST=127.0.0.1`，只允许本机访问，不开放局域网。
- 端口：`PORT=5194`
- 环境标识：`APP_ENV=preview`，`APP_LABEL=本机预览`
- 数据目录：`DATA_DIR=./data-preview`
- 静态资源目录：`STATIC_DIR=./dist-preview`
- 数据来源：通过 `scripts/prepare-preview-data.js` 使用 SQLite 安全备份方式从 `data/novel-chapters.sqlite` 生成一次性快照。
- 数据边界：预览环境里的导入、L1、分析任务只写入 `data-preview/`，不会写入正式 `data/`。
- 密钥边界：预览环境复用同一个 macOS Keychain 主密钥，因此可以解密从正式数据复制出来的章节和分析结果。
- 同步规则：`data-preview/` 是快照，不会自动同步线上新增数据；需要刷新时手动重新运行 `npm run preview:prepare-data`。
- 覆盖提醒：刷新 `data-preview/` 会丢弃预览环境里临时产生的任务和结果。

当前内存任务快照：

- `GET /api/tasks` 当前返回空列表，没有导入、L1 或分析任务在当前进程内运行。

当前部署验证：

- 当前正式服务运行版本：`0cb303c Refocus prompt library on analysis prompts`
- `http://127.0.0.1:5184/api/config` 正常。
- `http://172.16.75.46:5184/api/config` 正常。
- `http://10.8.11.29:5184/api/config` 正常。
- `http://127.0.0.1:5184/api/openai/test` 正常，返回 `200`。
- `http://127.0.0.1:5184/api/dify/test` 返回 `Access token is invalid`，说明服务已连到 Dify Base，但当前 `DIFY_CHAPTER_WORKFLOW_API_KEY` 或 Dify 工作流访问凭证需要重新校验。

重要安全说明：

- `https://apitokenzz.xyz/v1` 是 OpenAI 兼容网关，不是已确认的官方 OpenAI ZDR/MAM 项目地址。大规模发送真实版权章节前，必须确认该网关的数据保留、转发链路、合规和安全承诺。

## 4. 当前数据快照

SQLite 数据目录：`data/`

当前已导入书籍：

- `1721648` / `废材那又怎样`：已导入 755 章，范围 `1-755`，导入状态 `completed`
- `143170` / `剑来`：已导入 1279 章，范围 `1-1279`，导入状态 `completed`
- `215243` / `第一瞳术师`：已导入 20 章，范围 `1-20`，导入状态 `completed`

当前 L1 逐章索引状态：

- `143170` / `剑来`：1279 章中 484 个完成，795 个失败，0 个缺失
- `1721648` / `废材那又怎样`：755 章中 63 个完成，0 个失败，692 个缺失
- `215243` / `第一瞳术师`：20 章中 0 个完成，0 个失败，20 个缺失

当前 L2 类型化事实索引状态：

- `143170` / `剑来`：1279 章中 0 个完成，0 个失败，1279 个缺失，0 条事实
- `1721648` / `废材那又怎样`：755 章中 0 个完成，0 个失败，755 个缺失，0 条事实
- `215243` / `第一瞳术师`：20 章中 0 个完成，0 个失败，20 个缺失，0 条事实

当前分析任务历史状态：

- `completed`：4 个
- `cancelled`：1 个

当前分析 Prompt 库：

- 共 3 条分析 Prompt
- 分类：`剑来` 2 条，`通用` 1 条

历史窗口索引数据：

- `l1_window_indexes` 里可能保留了早期 10 章窗口索引实验产生的失败记录。
- 这些窗口数据只作为历史数据保留，不再参与新构建，也不能自动删除。

## 5. 架构概览

前端：

- React + Vite
- `src/App.jsx`：应用壳、轻量路由、全局任务状态
- `src/pages/AnalysisPage.jsx`：分析任务中心
- `src/pages/LibraryPage.jsx`：书籍导入、章节元数据、L1 索引控制
- `src/pages/PromptLibraryPage.jsx`：分析 Prompt 库
- `src/ui.jsx`：通用 UI 组件
- `src/schemaTools.js`：Schema 和结果展示辅助逻辑

后端：

- Express on Node.js
- `server/index.js`：HTTP 接口
- `server/workflows.js`：导入、L1、分析任务编排
- `server/tasks.js`：内存任务生命周期、SSE、暂停/继续/取消、时间估算
- `server/db.js`：SQLite 表结构、加密落库、元数据接口
- `server/openai.js`：OpenAI 兼容 Responses API 调用
- `server/dify.js`：Dify 工作流 API 调用和返回解析
- `server/crypto.js`：AES-GCM、HMAC、macOS Keychain 主密钥

存储：

- SQLite 位于 `data/`
- 章节正文使用 AES-256-GCM 加密
- 分析结果使用 AES-256-GCM 加密
- 章节内容校验使用 HMAC-SHA256
- L1 逐章索引当前按内测决策明文存储，但仍视为敏感内容
- 主密钥默认存储在 macOS Keychain：service 为 `novel-chapter-gpt-service`，account 为 `master-key`

## 6. 已实现页面

- `/`：分析任务中心
  - 创建分析任务
  - 选择书籍和章节范围
  - 章节选择模块默认收起
  - 支持非连续章节选择
  - 支持任务级 Prompt/Schema 快照
  - 支持可选 L1 逐章上下文
  - 章节选择收起态会显示已选章节数、L1 缺失数和 L1 失败数
  - Prompt 编辑区会提示当前草稿是否未保存
  - 最终结果如果 `finalResult.items` 可表格化，则表格展示，否则回退到 JSON/文本展示

- `/library`：书籍章节库
  - 导入书籍章节
  - 绑定 `book_name` 和 `book_id`，同一 `book_id` 不能绑定两个书名
  - 只查看章节元数据，不查看整章正文
  - 删除本地书籍数据
  - 构建逐章 L1 索引
  - 构建 L2 类型化事实索引
  - 支持导入任务和 L1 任务的暂停/继续/取消
  - 支持导入完成后自动启动 L1 构建
  - 支持 L1 覆盖率卡片、章节表搜索、L1 完成/未完成/缺失/失败筛选
  - 章节表显示每章 L1 状态；当章节不在当前 L1 查看范围内时显示为“未读取”，避免误判为缺失
  - 基础索引和 L2 类型化事实模块分别展示自己的构建 Prompt
  - 索引构建 Prompt 默认锁定，只读展示；必须手动解锁后才能编辑和保存

- `/prompts`：分析 Prompt 库
  - 新建、编辑、删除分析 Prompt
  - 修改分析 Prompt 名称
  - 为分析 Prompt 设置分类
  - 主要维护最终分析/汇总使用的分析 Prompt
  - 不再把逐章 Prompt 作为主字段；历史逐章 Prompt 数据只做兼容保留
  - 编辑分析 Prompt 时提示未保存修改，切换或新建前会二次确认

## 7. 当前公开接口

基础接口：

- `GET /api/config`
- `GET /api/tasks`
- `GET /api/dify/test`
- `GET /api/openai/test`

书籍与导入：

- `GET /api/books`
- `POST /api/books/imports`
- `GET /api/imports/:id`
- `GET /api/imports/:id/events`
- `POST /api/imports/:id/cancel`
- `POST /api/imports/:id/pause`
- `POST /api/imports/:id/resume`
- `GET /api/books/:bookId/chapters`
- `POST /api/books/:bookId/delete`

L1 索引：

- `POST /api/books/:bookId/l1-indexes`
- `GET /api/l1-indexes/:id`
- `GET /api/l1-indexes/:id/events`
- `POST /api/l1-indexes/:id/cancel`
- `POST /api/l1-indexes/:id/pause`
- `POST /api/l1-indexes/:id/resume`
- `GET /api/books/:bookId/l1-indexes/coverage`
- `GET /api/books/:bookId/l1-indexes/chapters`
- `GET /api/books/:bookId/l1-indexes/windows`：仅用于查看历史窗口索引数据

分析任务：

- `GET /api/analyses`
- `POST /api/analyses`
- `GET /api/analyses/:id`
- `GET /api/analyses/:id/events`
- `POST /api/analyses/:id/resume-run`
- `POST /api/analyses/:id/cancel`
- `POST /api/analyses/:id/pause`
- `POST /api/analyses/:id/resume`
- `DELETE /api/analyses/:id`

Prompt：

- `GET /api/prompts`
- `PUT /api/prompts`
- `GET /api/index-prompts`
- `PUT /api/index-prompts`
- `GET /api/prompt-groups`
- `POST /api/prompt-groups`
- `GET /api/prompt-groups/:id`
- `PUT /api/prompt-groups/:id`
- `DELETE /api/prompt-groups/:id`

说明：`prompt-groups` 路径为历史兼容命名，当前产品语义是“分析 Prompt 库”。

## 8. 关键决策

### Dify

- Dify 只负责章节原文获取。
- Dify 工作流必须保持最小化：输入 `book_id`、`start_chapter`、`end_chapter`，输出章节 JSON。
- Dify 工作流不接 LLM。
- 章节导入后存入本地章节库，后续分析不再重复调用 Dify。

### OpenAI 兼容调用

- 使用 Responses API 形态。
- 每次请求强制 `store: false`。
- 不使用 Files、Vector Stores、Assistants、Threads、Batch、background mode。
- 大型分析任务或 L1 任务前，先通过 `/api/openai/test` 做无正文连通性测试。
- 当前网关是 OpenAI 兼容地址，不是官方 OpenAI 地址；在确认合规前，视为重要风险点。

### L1 索引

- 当前 L1 策略是逐章索引，不再构建 10 章窗口索引。
- 已移除的 10 章窗口方案在大书测试中带来额外成本，窗口成功数为 0，并放大失败面。
- 历史 L1 窗口数据保留，但新任务不能再生成窗口索引。
- 已成功的逐章 L1 索引会继续复用。
- L1 Prompt Hash 继续使用 `l1-v1-chapter-window-10`，避免已完成的逐章索引被误判为过期。
- L1 构建 Prompt 可在章节库页面查看和编辑；默认 Prompt 继续沿用兼容 Hash `l1-v1-chapter-window-10`，只有保存自定义 Prompt 后才使用新的 SHA-256 Hash 判断新索引是否过期。
- L1 的 `missing` 表示尚未构建，不等于模型失败。
- L1 的 `failed` 表示已有失败记录。
- 出现成本保护、quota、billing、rate-limit 等系统性上游错误时，L1 任务应提前停止，不能继续把后续章节批量打成失败。

### 分析任务

- 默认分析路径已改为 `analysis_mode=balanced`：先从 L2 类型化事实索引召回，再按预算复核少量高风险原文章节。
- 分析页的 Prompt 配置以分析 Prompt 为主；选择 `/prompts` 中的条目时，只覆盖最终分析/汇总用的 `summary_prompt`，不覆盖逐章 Prompt。
- 逐章 Prompt 保留为高级兼容项，默认收起，主要服务 `full_text` 或明确需要逐章精读的场景。
- 分析模式、复核预算、输出格式仍属于创建分析任务模块，不进入分析 Prompt 库。
- 主体关键词、分析维度和筛选目标由用户写进分析 Prompt，不做单独下拉字段。
- `use_l1_context=false` 是默认值。
- 当 `use_l1_context=true` 时，每章 Prompt 会附加对应章节的 L1 JSON。
- L1 覆盖缺失只提示，不阻塞分析。
- 汇总 Prompt 不再附加窗口 L1 上下文。
- `fast_index` 只用 L2 索引，不读取章节原文；`precision` 使用更高复核预算；`full_text` 保留旧的逐章全文精读模式。
- `balanced` 默认最多复核 `min(10, max(3, ceil(章节数 * 1%)))` 章，`precision` 默认最多复核 `min(30, max(5, ceil(章节数 * 3%)))` 章；`source_review_budget` 可覆盖默认值。
- 分析任务逐章结果会写入 `analysis_chapters`，未完成、失败、取消或服务重启后，已完成章节结果仍可在任务详情中查看。
- 未完成任务不生成临时最终结果；`finalResult` 只有最终汇总成功后才返回。
- 断点续跑使用 `POST /api/analyses/:id/resume-run`，只允许复用原任务的 Prompt、模型、推理强度、Schema 和章节选择快照。
- 续跑会跳过 `status=completed`、章节 HMAC 匹配、Prompt Hash 匹配且结果密文存在的章节，只重跑失败、缺失、正文变更或 Prompt Hash 不匹配的章节。
- 服务重启后不会自动续跑分析任务，必须由用户在任务详情中手动点击“继续分析”。
- 当最终汇总输入过大时，系统会先把逐章结果分批压缩为结构化中间摘要，再用中间摘要执行最终汇总，避免一次性提交超大 JSON 导致 OpenAI 请求超时。
- 分批压缩必须带入用户最终汇总 Prompt，让压缩阶段按最终分析目标保留信息，而不是做通用摘要。
- 分批压缩输出必须包含 `covered_chapters`、主题事实、章节引用、证据备注、必须保留项、冲突项和失败章节；后端会校验每一批是否覆盖本批所有章节。
- 如果压缩结果漏掉本批章节，或包含非本批章节，任务会失败并提示覆盖异常，不能继续生成可能缺失信息的最终结果。
- 分批压缩不能保证语义零损失；它的定位是降低超时和网关不稳定风险，同时通过章节覆盖校验和结构化证据字段降低核心信息丢失概率。
- 由于 `apitokenzz.xyz` 网关在较大压缩请求上仍可能 180 秒 abort，压缩批次上限已降为约 1.8 万字符。
- 汇总压缩和最终汇总阶段对 abort、网络失败、5xx、429、返回空 JSON 等瞬时错误最多重试 3 次；章节覆盖异常不重试，直接失败。

### 索引构建 Prompt

- L1 基础索引和 L2 类型化事实索引各自维护独立构建 Prompt。
- 索引构建 Prompt 只在 `/library` 对应模块中管理，不进入 `/prompts` 分析 Prompt 库。
- 前端只展示构建 Prompt 本身，不展示章节正文、OpenAI 请求体或索引构建时的完整 Prompt body。
- Prompt 编辑器默认锁定，解锁后才允许编辑；保存后会立即影响后续新建索引任务和覆盖率过期判断。
- 默认 L1 Prompt 保持历史兼容 Hash `l1-v1-chapter-window-10`，默认 L2 Prompt 保持历史兼容 Hash `l2-v1-typed-facts`，避免已构建索引在功能上线后被批量误判为过期。
- 保存自定义 L1/L2 Prompt 后，Hash 变为基于 Prompt 内容计算的 SHA-256；后续构建任务会按新 Hash 跳过、重建或标记过期。

### UI/UX

- 后台 UI 保持简洁、密集、偏操作台风格。
- 不做营销页和落地页。
- 避免嵌套卡片和纯装饰性视觉元素。
- 长任务切换页面后仍要可见。
- 服务重启前，已存在的内存任务可以通过 `GET /api/tasks` 在当前进程内找回；Node 进程重启后内存任务会丢失，但分析任务可通过已落库的逐章结果手动续跑。
- 分析任务中的章节选择默认收起。
- L1 覆盖信息必须区分“缺失”“失败”和“未读取当前范围”。

## 9. 安全规则

禁止提交或粘贴：

- `.env`
- API Key、Bearer Token
- `data/`
- SQLite 文件、WAL/SHM 文件
- 包含加密或明文书籍数据的日志、导出、备份
- 整章正文
- 包含章节正文的 Dify 原始输出
- OpenAI 请求体
- 包含真实章节内容的 Prompt body
- 真实版权书籍的 L1 索引内容

`.gitignore` 必须持续覆盖：

- `.env`
- `.env.*`，但 `.env.example` 除外
- `data/*`
- `data-preview/`
- `node_modules/`
- `dist/`
- `dist-preview/`
- 日志文件
- 系统和编辑器临时文件

日志规则：

- 只记录任务 ID、章节编号、数量、状态、状态码和脱敏错误信息。
- 不记录章节正文、Prompt body、OpenAI 请求体、Dify 原始输出或 L1 索引内容。

运行边界：

- 服务只允许本机、局域网或 VPN 使用。
- 不允许暴露到公网。
- macOS 防火墙可能需要允许 Node.js，局域网设备才能访问。
- Dify 和 SQLite 数据卷应放在 FileVault 或等效加密磁盘上。

## 10. 已知问题

### 长篇全量分析仍然昂贵

即使已经有 L1，默认分析路径仍然会按所选章节提交完整章节正文。这个路径准确性高，但全书级任务仍然慢且成本高。

### L1 构建仍然偏慢

逐章 L1 已经比窗口 L1 便宜，但本质上仍是一章一次模型调用。对于 755 章或 1279 章的书，这仍然是大任务。

### 上游稳定性不足

已观察到的失败模式：

- 代理在 TLS 握手前断开
- OpenAI 兼容网关返回不完整 JSON
- OpenAI 兼容网关返回非合法 JSON，典型错误为 `Unexpected end of JSON input`
- 成本保护或额度保护
- 请求超时
- 已观察到 100 章逐章结果约 17.5 万字符，最终汇总请求触发 `This operation was aborted` 超时。

当前缓解方案：

- `OPENAI_PROXY_URL` 保持为空，优先直连 `OPENAI_API_BASE`
- 对系统性上游错误提前停止任务
- 对大体量最终汇总自动启用后端本地确定性瘦身，保留每章 `chapter_index`、标题、摘要、关键点和证据摘记，降低最终请求体规模。
- 当前不再调用模型做中间压缩，因为真实任务已证明压缩素材请求本身也会在当前网关上稳定 180 秒 abort。
- 最终汇总阶段对 abort、网络失败、5xx、429、返回空 JSON 等瞬时错误最多重试 3 次。
- 正式环境已把 `OPENAI_REQUEST_TIMEOUT_MS` 提高到 `600000`，用于给本地瘦身后的最终汇总更长等待窗口。
- 最终汇总只在汇总 Prompt 明确要求匹配“给定 JSON Schema”时走默认 `final_analysis` JSON Schema，并设置 `max_output_tokens=4500`。
- 如果汇总 Prompt 自己定义 JSON 模板，后端会尝试从最后一个合法 JSON 对象模板推导 `custom_final_analysis` Schema，用结构化输出稳定生成，同时保留用户自定义字段结构。
- 对长输入的自定义 JSON 模板汇总，后端会按顶层字段分多次生成，例如先生成 `major_characters`，再生成 `world_rules`，最后在本地合并为完整 JSON。这样降低单次输出长度，并避免被默认 `title/summary/items/failed_chapters` 格式污染。
- 如果无法从 Prompt 提取合法 JSON 模板，则按 Prompt 原格式走文本输出；后端会尝试解析 JSON 保存，但不会改写成默认 `title/summary/items/failed_chapters` 结构。
- 本地瘦身目标已从约 2.8 万字符降到约 1.8 万字符，优先保障 100 章级任务能续跑完成；代价是最终汇总素材更摘要化。
- 最终汇总保存前会做基础质量闸门：当 3 章以上任务返回 `N/A`、空摘要、空 `items` 且没有其他有效自定义字段时，任务标记失败并保留断点续跑，不把占位结果写成完成态。

### L1 重试流程太粗

系统可以跳过已完成索引，UI 已经支持按 L1 缺失、失败、未完成筛选章节；但还没有“一键只构建缺失”“一键只重试失败”的独立动作，也没有足够直观的失败原因聚合。

### L1 明文存储只是内测阶段取舍

L1 内容是版权正文的派生信息，仍然敏感。生产化前应迁移为加密存储。

### L2 是当前长篇优化主线

L2 类型化事实索引用于 1000 万字、1000+ 章场景下的重复分析。它把章节内容拆成可检索事实单元，分类、主体、标签、章节号、重要度和置信度明文保存，事实正文、证据摘记和复核结果加密保存。默认分析使用 `balanced` 召回式分析；全文精读仍保留，但应作为小范围或高保真兜底路径。

### 任务状态仍在内存中

当前进程内可以通过 `GET /api/tasks` 找回任务并重新订阅进度。Node 进程重启后，正在运行的任务状态仍会丢失。已写入 SQLite 的章节、索引和结果不会丢失。

## 11. 中期优化计划

优先级 1：让 L1 构建更可靠

- 增加“只构建缺失章节”按钮。
- 增加“只重试失败章节”按钮。
- 增加覆盖范围快捷选项：当前范围、导入范围中缺失部分、全书。
- 在 UI 中聚合展示失败原因。
- 对临时网络错误增加小间隔自动重试。
- 对非法 JSON 增加一次 JSON 修复重试。
- 对章节分析任务也增加一次 JSON 修复重试，避免 `Unexpected end of JSON input` 造成大量章节失败。
- 给单次任务增加硬上限：最大章节数、最大失败数。
- 任务事件文案明确区分 missing、failed、skipped、completed。

优先级 2：减少模型调用次数

- 对较短章节探索批量 L1 抽取，同时仍按章节保存结果。
- 为 L1 单独配置模型和推理强度，不必完全沿用分析模型。
- 增加“低成本 L1”模式，使用更小 Schema 和更低推理强度。
- 压缩分析任务中附加的 L1 上下文。

优先级 3：提升分析效率

- 继续优化 L2 召回式分析：分类和主体召回规则、来源追踪展示、索引覆盖不足提醒、复核结果沉淀复用。
- `fast_index`、`balanced`、`precision`、`full_text` 四档分析模式已可用，后续重点是提高召回质量和降低重复复核。
- 增加结果来源追踪：每个结果条目保留章节引用，并标记来源是 L2、原文复核还是全文精读。

优先级 4：安全加固和数据生命周期

- 加密 L1 逐章索引。
- 增加加密备份、导出和恢复。
- 增加密钥轮换 UI。
- 增加任务持久化表，让进行中的任务在进程重启后可恢复或标记为中断。
- 增加管理诊断页，但不能展示密钥、正文或 L1 内容。
- 增加局域网健康检查页。

优先级 5：大书体验优化

- 章节元数据和 L1 表格虚拟滚动。
- 继续完善 L1 表格过滤器，增加失败原因筛选和最近失败优先排序。
- 增加批量选择章节范围。
- 增加清晰的任务历史和重试入口。
- 当分析范围 L1 覆盖率低时，运行前给出提示。

## 12. 长期方向

长期目标是形成三层架构：

1. 本地章节库
   - 一次性加密导入
   - 完整元数据
   - 内容完整性校验

2. 可复用知识层
   - 加密的 L1 章节事实
   - 只在被证明有价值时引入更高阶索引
   - 覆盖率、重试、过期判断可控

3. 查询和分析层
   - 快速 L1 探索
   - 定向全文精修
   - 任务级 Prompt/Schema 快照
   - 带来源追踪、可复现的分析结果

核心原则：不要因为每一个新问题都重跑整本书。优先构建可复用的宽基础索引，再对新问题需要的章节做定向精修。

## 13. 验证命令

重要改动前后执行：

```bash
npm run lint
npm test
npm run build
curl -s http://127.0.0.1:5184/api/config
curl -s http://127.0.0.1:5184/api/dify/test
curl -s http://127.0.0.1:5184/api/openai/test
curl -s http://127.0.0.1:5184/api/tasks
```

本机预览环境验证：

```bash
npm run preview:prepare-data
npm run build:preview
npm run start:preview
curl -s http://127.0.0.1:5194/api/config
curl -s http://127.0.0.1:5184/api/config
```

如果需要非交互式覆盖预览快照：

```bash
npm run preview:prepare-data -- --force
```

局域网检查：

```bash
curl -s http://172.16.75.46:5184/api/config
curl -s http://10.8.11.29:5184/api/config
```

当前进程任务检查：

```bash
curl -s http://127.0.0.1:5184/api/tasks
```

推送前 Git 和密钥检查：

```bash
git status --short --branch
git check-ignore -v .env data/novel-chapters.sqlite dist/index.html node_modules/.package-lock.json .DS_Store
git grep --cached -n -I -E '(cg_[A-Za-z0-9_-]+|sk-(proj-)?[A-Za-z0-9_-]{12,}|app-[A-Za-z0-9]{12,}|OPENAI_API_KEY=.+|DIFY_CHAPTER_WORKFLOW_API_KEY=.+)' -- . || true
```

## 14. 运维手册

启动或重启局域网服务：

```bash
npm run build
lsof -tiTCP:5184 -sTCP:LISTEN | xargs -r kill
PORT=5184 HOST=0.0.0.0 nohup npm start > /tmp/novel-chapter-gpt-service.log 2>&1 &
curl -s http://127.0.0.1:5184/api/config
```

无章节正文的 OpenAI 兼容接口连通性测试：

```bash
curl -s http://127.0.0.1:5184/api/openai/test
```

如果代理错误再次出现：

- 如果 `OPENAI_API_BASE` 可直连，优先直连。
- 除非网络必须走代理，否则保持 `OPENAI_PROXY_URL=` 为空。
- 如果必须使用代理，长任务前先测试代理：

```bash
curl -I -m 10 -x http://127.0.0.1:7897 https://apitokenzz.xyz/v1/models
```

启动本机预览环境：

```bash
npm run preview:local
```

说明：

- 该命令会先准备 `data-preview/`，再构建 `dist-preview/`，最后启动 `5194` 预览服务。
- 如果 `data-preview/novel-chapters.sqlite` 已存在，脚本会提示覆盖风险；非交互式环境需要使用 `npm run preview:prepare-data -- --force`。
- 预览服务可以随时重启，不影响线上 `5184` 正在运行的任务。

## 15. 变更记录

- 2026-05-20：
  - Checkpoint 当前项目基线：正式服务运行在 `0cb303c Refocus prompt library on analysis prompts`。
  - 当前 `GET /api/tasks` 为空，没有导入、L1、L2 或分析任务在当前进程内运行。
  - 当前可访问地址更新为本机 `127.0.0.1:5184`、局域网 `172.16.75.46:5184`、VPN/内网 `10.8.11.29:5184`。
  - 更新书库、L1 覆盖、L2 覆盖、分析任务和分析 Prompt 库数量快照。

- 2026-05-20：
  - Prompt 库重定位为“分析 Prompt 库”，只把最终分析/汇总 Prompt 作为主字段。
  - 创建分析任务选择分析 Prompt 时，只覆盖汇总 Prompt，不覆盖逐章 Prompt。
  - 逐章 Prompt 降级为分析页高级兼容项，默认收起。
  - 明确 Prompt 三层边界：`/library` 管索引构建 Prompt，`/prompts` 管分析 Prompt，`/` 管分析模式、复核预算、输出格式和高级逐章 Prompt。

- 2026-05-20：
  - 正式环境已重启到 `Add editable index prompts` 版本。
  - 基础索引和 L2 类型化事实模块新增各自独立的构建 Prompt 展示与编辑。
  - 构建 Prompt 默认只读锁定，手动解锁后才能编辑；保存成功后自动恢复锁定。
  - 默认 L1/L2 Prompt 继续使用历史兼容 Hash，避免已构建索引被批量误判过期。

- 2026-05-20：
  - 正式环境已重启到 `16a0fa2 Add resilient staged final summaries`。
  - 当前本机地址 `http://127.0.0.1:5184/` 正常，当前局域网地址 `http://192.168.1.163:5184/` 正常。
  - OpenAI 连通性测试正常，`/api/openai/test` 返回 `200`。
  - Dify 连通性测试返回 `Access token is invalid`，需要重新校验自托管 Dify 工作流 API Key 或对应工作流访问配置。

- 2026-05-20：
  - 针对任务 `aa9010ea-6a25-40a0-84c5-968951bcba3b` 再次在 `压缩汇总素材 1/4` 阶段 180 秒 abort，进一步降低压缩批次大小。
  - 汇总压缩和最终汇总阶段新增瞬时错误有限重试，避免网关短时不稳定导致任务直接失败。
  - 该任务 100 个逐章结果已完成并可复用，后续续跑应跳过逐章分析，只重新执行压缩汇总与最终汇总。

- 2026-05-20：
  - 任务 `aa9010ea-6a25-40a0-84c5-968951bcba3b` 在 `压缩汇总素材 1/11` 阶段仍连续 180 秒 abort，说明模型中间压缩路径在当前网关上不可用。
  - 长输入汇总策略改为后端本地确定性瘦身，再只调用一次最终汇总模型。
  - 本地瘦身保留每章编号，避免中间模型漏章；语义细节会被压缩，后续需要更高精度时应采用分层索引或用户指定维度的二次精修。

- 2026-05-20：
  - 本地瘦身后，任务 `aa9010ea-6a25-40a0-84c5-968951bcba3b` 仍在最终汇总阶段触发默认 180 秒 abort。
  - 正式环境新增 `OPENAI_REQUEST_TIMEOUT_MS=600000`，把 OpenAI 请求等待窗口提高到 10 分钟。

- 2026-05-20：
  - 针对同一任务继续降载：最终汇总优先使用任务级 `output_schema` 作为 `final_analysis` JSON Schema，并限制 `max_output_tokens=4500`。
  - 后端本地瘦身目标降至约 1.8 万字符，减少最终单次请求输入规模。
  - 断点续跑仍复用已完成的 100 个逐章结果，只重新执行最终汇总阶段，不重新提交章节正文。

- 2026-05-20：
  - 续跑验证显示网络中断问题已绕过，任务可跳过 100 个逐章结果并完成最终调用；但兼容网关返回过 `N/A` 占位式 JSON。
  - 新增最终汇总质量闸门：明显占位结果按失败处理并进入重试，最终仍不合格时保留任务可续跑状态。

- 2026-05-20：
  - 修正最终汇总格式策略：`Prompt 要 JSON` 不再自动等于 `使用系统 final_analysis Schema`。
  - 只有明确要求“匹配给定 JSON Schema”的任务才强制 Schema；自定义 JSON、Markdown、表格或纯文本格式按汇总 Prompt 原格式输出。
  - 保留本地瘦身、`max_output_tokens`、重试和占位结果质量闸门。

- 2026-05-20：
  - 为自定义 JSON 汇总 Prompt 新增模板推导：当 Prompt 末尾存在合法 JSON 对象模板时，后端自动生成 `custom_final_analysis` Schema。
  - 该路径既避免默认 `title/summary/items/failed_chapters` 结构污染，也比纯文本 JSON 长生成更稳定。
  - 空数组模板字段使用宽松 JSON 值数组，避免把 `major_characters: []` 锁死成只能输出空数组或字符串数组。

- 2026-05-20：
  - 继续优化长输入自定义 JSON 汇总：进入本地瘦身路径后，按用户 JSON 模板的顶层字段逐个调用模型生成，再由后端本地合并完整结果。
  - 该策略主要解决兼容网关在单次超长最终输出时容易 `fetch failed` 或超时的问题；不会改变短输入任务、默认 `final_analysis` Schema 任务、Markdown 或纯文本汇总任务。
  - 已完成的逐章分析结果仍可断点复用，续跑时只需要重新执行最终分字段汇总阶段。

- 2026-05-20：
  - 新增 L2 类型化事实索引第一版：按章节构建人物、关系、境界、势力、物品、地点、事件、伏笔等事实单元。
  - 新增 L2 构建、覆盖率和事实查询接口；L2 任务支持暂停、继续、取消、跳过已完成、只补缺失、只重试失败。
  - 分析任务新增 `analysis_mode` 和 `source_review_budget`；默认 `balanced`，`fast_index` 不读取原文，`full_text` 保留旧路径。
  - L2 事实正文、证据摘记和复核结果加密保存；检索元数据明文保存；继续不记录章节正文、Prompt body、OpenAI 请求体或 L2 事实内容。

- 2026-05-19：
  - 修复分析任务最终汇总阶段大输入超时问题。
  - 新增大体量汇总保护：短输入直接汇总，长输入先分批压缩逐章结果，再基于压缩摘要生成最终结果。
  - 分批压缩升级为最终 Prompt 感知的结构化 JSON 输出，压缩结果必须携带章节覆盖、事实、章节引用、证据备注、必须保留项和冲突项。
  - 新增压缩覆盖校验：若中间摘要漏掉本批章节或混入非本批章节，任务直接失败，不继续生成最终汇总。
  - 已定位失败任务 `aa9010ea-6a25-40a0-84c5-968951bcba3b`：100 章逐章结果约 17.5 万字符，最终汇总请求 180 秒超时。

- 2026-05-19：
  - 新增分析任务断点续跑：`POST /api/analyses/:id/resume-run`。
  - 分析任务状态提升到前端全局托管，切换到章节库或 Prompt 库时分析任务继续后台运行并显示顶部进度入口。
  - `GET /api/analyses/:id` 扩展返回逐章部分结果、失败章节、待续跑章节和 `canResume`。
  - 分析任务运行时写入 `analysis_runs.status=running`，已完成逐章结果继续加密保存在 `analysis_chapters`。
  - 断点续跑只复用原任务快照，跳过已完成且章节 HMAC 与 Prompt Hash 匹配的章节。

- 2026-05-19：
  - 新增本机预览环境：`5194` 端口、`data-preview/` 数据副本、`dist-preview/` 静态资源目录。
  - 后端静态资源目录改为可通过 `STATIC_DIR` 配置，正式环境默认仍使用 `dist/`。
  - 新增预览数据准备脚本，使用 SQLite 安全备份方式从正式数据库生成预览快照。
  - 前端在预览环境顶部显示“本机预览 · 数据副本”。
  - 新增 `preview:prepare-data`、`build:preview`、`start:preview`、`preview:local` 命令。

- 2026-05-19：
  - 重启服务后启用新版前端与后端任务找回接口。
  - 新增 `GET /api/tasks`，用于当前 Node 进程内找回导入、L1、分析等内存任务。
  - 章节库新增 L1 覆盖率卡片、章节表搜索、L1 状态列和 L1 状态筛选。
  - 分析页章节选择收起态新增 L1 覆盖提示，Prompt 编辑区新增未保存草稿提示。
  - Prompt 库新增未保存修改提示和切换保护。
  - 当前运行中分析任务出现 `OpenAI 返回不是合法 JSON：Unexpected end of JSON input`，后续应优先实现 JSON 修复重试。
  - 更新当前数据快照：`剑来` L1 索引为 482 完成、797 失败；`废材那又怎样` L1 索引为 63 完成。

- 2026-05-18：
  - 将本文档改为中文项目基线，仅保留必要技术字段英文。

- 2026-05-18：
  - 清空 `OPENAI_PROXY_URL`，OpenAI 兼容调用改为直连。
  - 确认 `/api/openai/test` 返回 `200`。
  - 记录当前数据快照和中长期路线图。
  - 再次确认本文档为项目唯一真实信息源。

- 2026-05-18：
  - 移除新的 10 章窗口 L1 构建路径。
  - 分析任务不再附加窗口 L1 上下文。
  - 保留历史 `l1_window_indexes` 数据。
  - L1 覆盖率聚焦逐章覆盖。

- 2026-05-17：
  - 增加 L1 逐章索引表和任务流程。
  - 增加 Prompt 库页面。
  - 拆分分析任务中心和章节库页面。
  - 增加暂停/继续/取消和任务时间估算。

- 2026-05-15 至 2026-05-16：
  - 创建本地服务。
  - 增加加密章节导入和分析流程。
  - 增加 Dify 最小章节工作流集成。
  - 增加 `5184` 端口局域网访问。
