# Security Notes

## 数据流

1. 本地服务按小批次调用自托管 Dify。
2. Dify 返回章节原文后，本地服务立即加密并写入 SQLite。
3. 前端只显示章节元数据，不显示正文。
4. GPT 分析任务按章节临时解密，调用 OpenAI Responses API。
5. 逐章结果和最终结果再次加密写入 SQLite。

## 不做的事

- 不把章节正文写入 `.env`、日志、localStorage、普通 JSON 文件。
- 不上传章节文件到 OpenAI Files。
- 不创建 Vector Stores。
- 不使用 Assistants、Threads、Batch、background mode。
- 不在 API 错误详情中回显 prompt body 或 Dify raw output。

## 密钥

默认主密钥由 macOS Keychain 管理。删除 Keychain 项会导致旧数据无法解密。

测试环境只在 `NODE_ENV=test` 时接受 `NOVEL_SERVICE_TEST_MASTER_KEY`，避免自动化测试写入真实 Keychain。

## 删除

`POST /api/books/:bookId/delete` 会删除该书的章节密文、分析密文和关联索引。删除后不可通过本服务恢复，除非你另有加密备份。
