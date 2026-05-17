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
  if (Array.isArray(prompt?.schema_fields) && prompt.schema_fields.length) {
    return prompt.schema_fields.map((field) => ({
      key: field.name,
      label: field.label || field.name
    }));
  }

  const schema = parseSchema(prompt?.output_schema);
  const properties = schema?.properties?.items?.items?.properties;
  if (properties && typeof properties === "object") {
    return Object.keys(properties).map((key) => ({ key, label: key }));
  }

  if (Array.isArray(result?.items) && result.items[0] && typeof result.items[0] === "object") {
    return Object.keys(result.items[0]).map((key) => ({ key, label: key }));
  }

  return [];
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
