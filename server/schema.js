const FIELD_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "string[]",
  "number[]",
  "integer[]",
  "boolean[]"
]);

export function defaultSchemaFields() {
  return [
    {
      name: "name",
      label: "名称",
      type: "string",
      required: true,
      description: "条目名称"
    },
    {
      name: "description",
      label: "描述",
      type: "string",
      required: true,
      description: "合并后的描述"
    },
    {
      name: "chapters",
      label: "章节",
      type: "integer[]",
      required: true,
      description: "相关章节编号"
    }
  ];
}

export function normalizeSchemaMode(value) {
  return value === "raw" ? "raw" : "fields";
}

export function normalizeSchemaFields(value) {
  const raw = parseFields(value);
  const fields = raw.map((field, index) => normalizeSchemaField(field, index)).filter(Boolean);
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

export function parseSchemaOrThrow(value) {
  try {
    const schema = typeof value === "string" ? JSON.parse(value) : value;
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      throw new Error("schema must be object");
    }
    return schema;
  } catch (error) {
    const wrapped = new Error(`输出 JSON Schema 无效：${error.message}`);
    wrapped.status = 400;
    throw wrapped;
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

function normalizeSchemaField(field, index) {
  const name = String(field?.name || field?.key || "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    if (index < defaultSchemaFields().length) return defaultSchemaFields()[index];
    return null;
  }

  const type = FIELD_TYPES.has(field?.type) ? field.type : "string";
  return {
    name,
    label: String(field?.label || name).trim() || name,
    type,
    required: field?.required !== false,
    description: String(field?.description || "").trim()
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
