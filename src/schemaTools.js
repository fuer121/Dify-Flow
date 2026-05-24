export const schemaFieldTypes = [
  "string",
  "number",
  "integer",
  "boolean",
  "string[]",
  "number[]",
  "integer[]",
  "boolean[]"
];

export function defaultSchemaFields() {
  return [
    { name: "name", label: "名称", type: "string", required: true, description: "条目名称" },
    { name: "description", label: "描述", type: "string", required: true, description: "合并后的描述" },
    { name: "chapters", label: "章节", type: "integer[]", required: true, description: "相关章节编号" }
  ];
}

export function normalizePrompt(prompt) {
  const schemaFields = normalizeSchemaFields(prompt?.schema_fields);
  const schemaMode = prompt?.schema_mode === "raw" ? "raw" : "fields";
  const outputSchema = schemaMode === "fields"
    ? JSON.stringify(schemaFromFields(schemaFields), null, 2)
    : String(prompt?.output_schema || JSON.stringify(schemaFromFields(schemaFields), null, 2));

  return {
    name: prompt?.name || "默认小说理解模板",
    model: prompt?.model || "gpt-5.5",
    reasoning_effort: prompt?.reasoning_effort || "medium",
    chapter_prompt: prompt?.chapter_prompt || "",
    summary_prompt: prompt?.summary_prompt || "",
    output_schema: outputSchema,
    schema_mode: schemaMode,
    schema_fields: schemaFields
  };
}

export function normalizeSchemaFields(value) {
  const raw = parseFields(value);
  const fields = raw.map((field, index) => normalizeField(field, index)).filter(Boolean);
  return fields.length ? fields : defaultSchemaFields();
}

export function schemaFromFields(value) {
  const fields = normalizeSchemaFields(value);
  const properties = {};
  const required = [];

  for (const field of fields) {
    properties[field.name] = schemaForField(field);
    if (field.required) required.push(field.name);
  }

  return {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string" },
      summary: { type: "string" },
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties,
          required
        }
      },
      failed_chapters: {
        type: "array",
        items: { type: "integer" }
      }
    },
    required: ["title", "summary", "items", "failed_chapters"]
  };
}

export function outputSchemaForPrompt(prompt) {
  if (prompt.schema_mode === "fields") {
    return JSON.stringify(schemaFromFields(prompt.schema_fields), null, 2);
  }
  return prompt.output_schema;
}

export function resultColumnsFromPrompt(prompt, result) {
  if (Array.isArray(result?.items) && result.items[0] && typeof result.items[0] === "object") {
    const keys = new Set();
    for (const row of result.items) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      Object.keys(row).forEach((key) => keys.add(key));
    }
    return [...keys].map((key) => ({ key, label: key }));
  }

  return [];
}

export function tableViewsFromJson(value) {
  const parsed = parseJsonLike(value);
  if (parsed === null || parsed === undefined) return [];

  if (Array.isArray(parsed)) {
    return tableFromArray("结果", parsed);
  }

  if (typeof parsed !== "object") {
    return [];
  }

  const tables = [];
  const entries = Object.entries(parsed);

  for (const [key, entry] of entries) {
    if (!Array.isArray(entry)) continue;
    tables.push(...tableFromArray(labelForKey(key), entry, key));
  }

  if (tables.length) return prioritizeTables(tables);

  const scalarRows = entries
    .filter(([, entry]) => entry !== null && entry !== undefined && !Array.isArray(entry) && typeof entry !== "object")
    .map(([key, entry]) => ({ field: labelForKey(key), value: entry }));
  if (scalarRows.length) {
    return [{
      key: "summary_fields",
      title: "结果字段",
      rows: scalarRows,
      columns: [
        { key: "field", label: "字段" },
        { key: "value", label: "值" }
      ]
    }];
  }

  return [];
}

export function parseJsonLike(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text) return "";
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

export function parseSchema(value) {
  try {
    const schema = typeof value === "string" ? JSON.parse(value) : value;
    return schema && typeof schema === "object" && !Array.isArray(schema) ? schema : null;
  } catch {
    return null;
  }
}

function parseFields(value) {
  if (!value) return defaultSchemaFields();
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : defaultSchemaFields();
    } catch {
      return defaultSchemaFields();
    }
  }
  return defaultSchemaFields();
}

function tableFromArray(title, rows, key = "root") {
  const normalizedRows = rows
    .filter((row) => row !== null && row !== undefined)
    .map((row) => normalizeTableRow(row));
  if (!normalizedRows.length) return [];
  const keys = [];
  for (const row of normalizedRows) {
    for (const columnKey of Object.keys(row)) {
      if (!keys.includes(columnKey)) keys.push(columnKey);
    }
  }
  if (!keys.length) return [];
  return [{
    key,
    title,
    rows: normalizedRows,
    columns: keys.map((columnKey) => ({ key: columnKey, label: labelForKey(columnKey) }))
  }];
}

function normalizeTableRow(row) {
  if (row && typeof row === "object" && !Array.isArray(row)) return row;
  return { value: row };
}

function prioritizeTables(tables) {
  return [...tables].sort((left, right) => {
    if (left.key === "items") return -1;
    if (right.key === "items") return 1;
    return right.rows.length - left.rows.length;
  });
}

function labelForKey(key) {
  const labels = {
    title: "标题",
    summary: "摘要",
    items: "条目",
    failed_chapters: "失败章节",
    name: "名称",
    description: "描述",
    chapters: "章节",
    chapter: "章节",
    chapter_index: "章节",
    chapter_refs: "章节",
    evidence: "证据",
    evidence_notes: "证据",
    confidence: "置信度",
    importance: "重要度",
    category: "分类",
    entity: "主体",
    related_entities: "相关主体",
    fact: "事实",
    fact_type: "事实类型",
    roles: "角色",
    major_characters: "主要人物",
    major_relationships: "主要关系",
    cultivation_system: "修行体系",
    important_items: "重要物品",
    major_events: "关键事件",
    major_foreshadowing: "重要伏笔"
  };
  return labels[key] || String(key || "").replace(/_/g, " ");
}

function normalizeField(field, index) {
  const fallback = defaultSchemaFields()[index];
  const name = String(field?.name || field?.key || fallback?.name || "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
  const type = schemaFieldTypes.includes(field?.type) ? field.type : fallback?.type || "string";
  return {
    name,
    label: String(field?.label || fallback?.label || name).trim() || name,
    type,
    required: field?.required !== false,
    description: String(field?.description || fallback?.description || "").trim()
  };
}

function schemaForField(field) {
  const baseType = field.type.endsWith("[]") ? field.type.slice(0, -2) : field.type;
  const schema = field.type.endsWith("[]")
    ? { type: "array", items: { type: baseType } }
    : { type: baseType };
  if (field.description) schema.description = field.description;
  return schema;
}
