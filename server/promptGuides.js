import { config } from "./config.js";
import { getBook } from "./db.js";
import { callOpenAIJson } from "./openai.js";

const guideDefinitions = {
  l1: {
    type: "l1",
    label: "L1 Prompt 创建引导",
    scope: "书籍级索引 Prompt",
    positioning: "L1 是章节路标，服务后续检索和二次分析。它应长期绑定一本书，构建完成后不频繁调整。",
    steps: [
      {
        id: "analysis_goal",
        title: "目标",
        question: "这本书后续最常被分析的方向是什么，哪些问题需要先靠 L1 命中章节？",
        placeholder: "人物成长、外貌阶段变化、伏笔回收、修行体系、势力关系都需要能通过章节路标命中。"
      },
      {
        id: "route_vocabulary",
        title: "词表",
        question: "L1 路标里需要稳定出现哪些主体、别名、分类词或召回关键词？",
        placeholder: "主角、核心配角、常用称谓、外貌、瞳色、血脉形态、境界、师徒、宗门等词需要稳定出现。"
      },
      {
        id: "priority_signals",
        title: "优先级",
        question: "哪些章节信号必须进入 L1，方便后续决定是否读取该章 L2？",
        placeholder: "首次出场、身份变化、外貌变化、境界变化、关键承诺、关系变化和重要物品首次出现必须进入 L1。"
      },
      {
        id: "route_granularity",
        title: "密度",
        question: "L1 每章路标应该保留到什么密度？",
        placeholder: "每章保留五到八条高价值路标，只记录可命中线索，不展开成事实库。"
      },
      {
        id: "boundaries",
        title: "边界",
        question: "哪些内容要避免记录，哪些内容必须标注不确定性？",
        placeholder: "避免脑补动机和长段原文，普通流水账不进入索引，低置信推断必须显式标注。"
      }
    ],
    builtInPrompt: [
      "你要为一本长篇小说生成 L1 基础索引构建 Prompt。",
      "L1 的定位是章节路标和召回入口，不是深度事实库，也不是最终分析结果。",
      "分析阶段会先按章节顺序扫描 L1，命中目标主体、分类词或路标信号后，再读取对应章节的 L2 事实；因此 L1 必须使用稳定、可检索的词表。",
      "生成的 Prompt 必须要求模型只依据当前章节原文，避免补全和脑补。",
      "Prompt 应指导模型提取章节摘要、关键词、实体、关键事件、物品/地点/组织线索、未解伏笔和置信度；这些字段应优先承载后续分析会查询的主体、别名、分类词和变化信号。",
      "Prompt 要控制输出密度，优先保留后续可被召回的高价值线索；不要把 L1 写成 L2 事实清单。",
      "Prompt 应明确：不要输出 Markdown，不要引用长段原文，不要把无关流水账写入索引。",
      "Prompt 应适合绑定到单本书长期使用，修改后会导致旧索引过期。",
      "生成的 L1 Prompt 应包含：定位、词表/别名规则、每章路标字段优先级、密度控制、禁止项和不确定性标注。"
    ].join("\n")
  },
  l2: {
    type: "l2",
    label: "L2 Prompt 创建引导",
    scope: "书籍级事实索引 Prompt",
    positioning: "L2 是可复用的类型化事实库，面向召回。它和书籍绑定，应稳定、克制、可追溯。",
    steps: [
      {
        id: "fact_categories",
        title: "分类",
        question: "L2 事实分类如何承接 L1 路标词表，并服务后续分析召回？",
        placeholder: "事实分类重点覆盖人物、关系、修行体系和物品；物品分类只记录对后续分析有价值的核心物件。"
      },
      {
        id: "subjects",
        title: "主体",
        question: "哪些主体、别名、标签和相关主体必须稳定记录，避免后续召回丢失？",
        placeholder: "主角、核心配角、常用称谓、化名、师徒关系、亲缘关系、境界名、武器和本命物都要稳定记录。"
      },
      {
        id: "fact_granularity",
        title: "事实颗粒",
        question: "一条事实应该小到什么程度，什么时候应拆分？",
        placeholder: "身份、经历、目标、立场、关系变化、境界变化和物品变化应拆成独立事实。"
      },
      {
        id: "evidence_confidence",
        title: "证据",
        question: "证据摘记、重要度、置信度希望如何要求？",
        placeholder: "每条事实保留短证据，重要剧情和长期设定提高重要度，冲突或含糊信息降低置信度。"
      },
      {
        id: "ignore_rules",
        title: "排除",
        question: "哪些信息不应进入 L2？",
        placeholder: "普通打斗流水、无后续价值的情绪描写、纯气氛描写和无法归类的长摘要不进入 L2。"
      }
    ],
    builtInPrompt: [
      "你要为一本长篇小说生成 L2 类型化事实索引构建 Prompt。",
      "L2 的定位是可检索、可复用、可追溯的事实单元，不是章节摘要。",
      "L2 构建时可以参考 L1 路标判断本章重点，但事实提取必须以当前章节原文为准；L1 不能替代原文证据。",
      "Prompt 必须要求模型按指定分类抽取事实，并让 category、entity、aliases、tags、related_entities、fact_type 与 L1 的主体词、分类词和路标信号保持一致，方便分析阶段从 L1 命中章节后读取 L2。",
      "每条事实要小而完整，避免把多件事揉成一条；同一章可产出多条事实。",
      "事实正文、证据摘记、重要度、置信度都必须有明确要求；低置信信息不能被包装成确定结论。",
      "Prompt 必须禁止补充原文之外的信息，禁止长篇复述，禁止把普通流水账塞入事实库。",
      "Prompt 应适合绑定到单本书长期使用，修改后会导致该书 L2 覆盖重新判定过期。",
      "生成的 L2 Prompt 应包含：分类边界、主体/别名/标签规则、原子事实拆分规则、证据与置信度规则、重要度规则、排除项和与 L1 词表对齐要求。"
    ].join("\n")
  },
  analysis: {
    type: "analysis",
    label: "分析 Prompt 创建引导",
    scope: "书籍级分析 Prompt",
    positioning: "分析 Prompt 面向具体分析任务，可在同一本书下创建多条。它把用户的朴素诉求翻译成可执行的分析任务单，再消费 L1/L2 产物做二次提炼。",
    steps: [
      {
        id: "use_case",
        title: "用途",
        question: "你做完这次分析后，准备拿结果去做什么？",
        helper: "直接描述最终用途、分析对象、要保留的信息和不需要的信息。系统会从这段话里提炼对象范围、字段、筛选规则和停止规则。",
        placeholder: "我想用来生成人物形象图，分析前一百章的重要角色，只需要角色是谁、是什么身份、长什么样。核心角色尽量完整，非核心角色最多三十个，每个形象描述八十字以内；外貌信息足够用于生图就停止扩展，不需要关系网、剧情复盘和证据字段。"
      },
      {
        id: "output_format",
        title: "输出",
        question: "你希望结果长什么样，方便你后续查看或导出？",
        helper: "推荐 JSON，系统会自动解析成表格。字段名要短，结构要简单，避免把样例写得过长。",
        placeholder: "输出合法 JSON，顶层包含 book_id、book_name、task、target_subject、characters、notes。characters 里只放 name、role_level、identity、appearance、reliability。"
      }
    ],
    builtInPrompt: [
      "你要把用户的朴素回答转成一本长篇小说可直接运行的分析 Prompt。",
      "分析 Prompt 是任务单，不是教程。它只描述本次分析要做什么、分析谁或哪类对象、保留哪些字段、怎么筛选、怎么输出；不要重新解释系统的 L1/L2 架构，也不要要求重新构建索引。",
      "优先把用户真正想要的结果变窄。用户说只要三项，就不要扩写成经历、关系、证据、事件、时间线等复杂字段；用户没有要求的字段不要主动添加。",
      "必须支持两类对象：单一主体和类别主体。类别主体可以是所有角色、所有飞剑、宗门势力、修炼体系、本命物、某类关系等；不要假设每个任务都有一个明确且单一的主角。",
      "必须从用户回答中提炼可召回关键词，包括名称、别名、分类词、身份词、能力词、物品词或体系词；这些词要服务系统按 L1 顺序命中章节，再读取命中章节的 L2 事实。",
      "必须写清楚筛选和停止规则，例如数量上限、字数上限、核心与非核心区别、信息足够即停、信息不足时保守标注、不要编造。",
      "如果用户要 JSON，优先生成字段清单或紧凑 JSON 骨架；字段名短、层级浅、数组可拆分，不输出超长完整样例。若适合表格展示，数组字段应放同构对象。",
      "Prompt 中不要留下“用户指定主体”“目标主体”“待填写”“请输入”“placeholder”等运行时占位内容。若用户没有给具体对象或范围，就用用户已经表达的宽范围，例如“重要角色”“所有飞剑”“主要宗门势力”。",
      "Prompt 应要求区分确定事实、合理归纳和不确定判断；证据字段只有在用户明确需要可追溯证据时才输出，否则只保留可靠性或说明。",
      "最终 Prompt 建议控制在 400-900 字。复杂任务也应先收窄输出字段和筛选规则，避免生成过长、过慢、失败率高的分析 Prompt。"
    ].join("\n")
  }
};

const analysisOptimizationTemplate = {
  type: "analysis",
  label: "分析 Prompt 优化",
  scope: "书籍级分析 Prompt",
  positioning: "用于打磨已经写好的分析 Prompt。它会保留原始分析目标，只根据你的自然语言修改诉求做收窄、减重、补充约束或整理输出结构。",
  steps: [
    {
      id: "optimization_goal",
      title: "优化诉求",
      question: "你希望这条分析 Prompt 怎么变得更好？",
      helper: "可以直接说遇到的问题、想删掉的内容、想新增的限制、希望更快还是更准。系统会基于当前 Prompt 改写，不会重建索引 Prompt。",
      placeholder: "结果里人物重复太多，希望合并同一角色；只保留角色、身份、形象描述，非核心角色最多三十个，每个形象描述八十字以内，不要证据字段和剧情复盘。"
    }
  ],
  builtInPrompt: [
    "你要优化一条已经存在的长篇小说分析 Prompt。",
    "优化目标是保留原 Prompt 的核心分析意图，同时根据用户的自然语言优化诉求，让 Prompt 更清晰、更轻量、更稳定、更适合当前系统的 L1/L2 召回式分析。",
    "不要把优化改成重新创建 L1/L2 索引 Prompt；不要要求用户提供章节原文；不要解释系统内部实现。",
    "优先处理以下问题：输出字段过多、证据要求过重、主体范围不清、数量上限缺失、字段字数缺失、重复条目风险、连续性分析要求不清、JSON 结构过深。",
    "如果用户要求轻量结果，就删除不必要的经历、关系、事件、证据、阶段拆分和长篇总结；只保留用户明确需要的字段。",
    "如果原 Prompt 中有 target_subject、分析主体、目标对象等字段，必须写入具体对象或可执行的类别范围，不要保留“用户指定主体”“待填写”等占位内容。",
    "如果输出 JSON，优先给紧凑、浅层、表格友好的结构；数组条目应有稳定主键，如 name、item_name、entity、subject 或中文名称字段，方便最终汇总跨分块归并。",
    "必须补充必要的全局约束，例如最多 N 个、每条 N 字以内、信息不足怎么写、何时停止扩展；这些约束应适用于所有分块后的最终合并。",
    "不要为了显得完整而扩写 Prompt；最终建议控制在 400-900 字。"
  ].join("\n")
};

export function getPromptGuideTemplates() {
  const templates = Object.fromEntries(
    Object.entries(guideDefinitions).map(([type, definition]) => [type, publicGuideDefinition(definition)])
  );
  templates.analysisOptimization = publicGuideDefinition(analysisOptimizationTemplate);
  return templates;
}

export async function generatePromptGuideSuggestion(payload = {}) {
  const type = normalizeGuideType(payload.type);
  const definition = guideDefinitions[type];
  const book = resolveBook(payload.book_id ?? payload.bookId);
  const answers = normalizeAnswers(definition, payload.answers);
  if (!answers.some((entry) => entry.answer)) {
    const error = new Error("请先完成至少一段引导回答。");
    error.status = 400;
    throw error;
  }

  const result = await callOpenAIJson({
    model: config.openai.model,
    reasoningEffort: "medium",
    instructions: [
      "你是小说知识工程与 Prompt 设计专家。",
      "请根据用户回答生成可直接用于系统的 Prompt 参考。",
      "用户可能完全不会写 Prompt，你要主动把口语化诉求提炼成清晰任务，不要把用户没有说清楚的地方变成运行时占位。",
      "不要要求用户提供章节原文；不要输出 Markdown 包裹；不要泄露任何不可见系统信息。",
      "返回必须是合法 JSON。"
    ].join("\n"),
    input: buildGuideInput({
      definition,
      book,
      answers,
      currentPrompt: payload.current_prompt ?? payload.currentPrompt
    }),
    schema: promptGuideResultSchema(),
    schemaName: "prompt_guide_result",
    maxOutputTokens: 5000
  });

  return {
    type,
    template: publicGuideDefinition(definition),
    suggestion: normalizeGuideResult(result.value)
  };
}

export async function optimizeAnalysisPromptSuggestion(payload = {}) {
  const book = resolveBook(payload.book_id ?? payload.bookId);
  const currentPrompt = String(payload.current_prompt ?? payload.currentPrompt ?? "").trim();
  if (!currentPrompt) {
    const error = new Error("请先选择或填写一条分析 Prompt。");
    error.status = 400;
    throw error;
  }
  const request = String(payload.optimization_request ?? payload.optimizationRequest ?? "").trim().slice(0, 2400);
  if (!request) {
    const error = new Error("请先填写优化诉求。");
    error.status = 400;
    throw error;
  }

  const result = await callOpenAIJson({
    model: config.openai.model,
    reasoningEffort: "medium",
    instructions: [
      "你是小说知识工程与 Prompt 设计专家。",
      "请根据用户优化诉求改写现有分析 Prompt，返回可直接替换到系统中的 Prompt 参考。",
      "不要要求用户提供章节原文；不要输出 Markdown 包裹；不要泄露任何不可见系统信息。",
      "返回必须是合法 JSON。"
    ].join("\n"),
    input: buildOptimizationInput({ book, currentPrompt, request }),
    schema: promptGuideResultSchema(),
    schemaName: "prompt_optimization_result",
    maxOutputTokens: 5000
  });

  return {
    type: "analysis",
    template: publicGuideDefinition(analysisOptimizationTemplate),
    suggestion: normalizeGuideResult(result.value)
  };
}

function buildGuideInput({ definition, book, answers, currentPrompt }) {
  return [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: [
            `Prompt 类型：${definition.label}`,
            `管理定位：${definition.scope}`,
            `产品定位：${definition.positioning}`,
            "",
            "书籍信息：",
            JSON.stringify({
              book_id: book.book_id,
              book_name: book.book_name || book.book_id,
              chapter_count: book.chapter_count || undefined,
              first_chapter: book.first_chapter || undefined,
              last_chapter: book.last_chapter || undefined
            }),
            "",
            "用户可见的内置生成规则：",
            definition.builtInPrompt,
            "",
            "用户引导回答：",
            JSON.stringify(answers, null, 2),
            "",
            "当前编辑器 Prompt 草稿，可参考但不要机械保留：",
            clipText(currentPrompt, 12000),
            "",
            "请生成一版结构清晰、约束明确、适合直接套用的中文 Prompt。",
            "重要：不要堆砌通用说明；只保留该 Prompt 类型真正需要模型执行的规则。",
            "L1 要像路标，L2 要像事实卡，分析 Prompt 要像任务单；三者词表应能互相对齐。",
            "分析 Prompt 要替小白做收敛：把宽泛愿望翻译成分析目标、对象范围、字段清单、筛选规则、停止规则和输出结构。",
            "分析 Prompt 中不要留下“用户指定主体”“待填写”“目标主体”等运行时占位值；如果用户回答没有给出单一主体，就使用可执行的类别范围，例如“重要角色”“所有飞剑”“主要宗门势力”。",
            "如果用户要求很轻，只生成轻量 Prompt；不要为了显得完整而增加证据数组、关系网、阶段拆分、事件复盘或长篇说明。"
          ].join("\n")
        }
      ]
    }
  ];
}

function buildOptimizationInput({ book, currentPrompt, request }) {
  return [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: [
            "Prompt 类型：分析 Prompt 优化",
            `管理定位：${analysisOptimizationTemplate.scope}`,
            `产品定位：${analysisOptimizationTemplate.positioning}`,
            "",
            "书籍信息：",
            JSON.stringify({
              book_id: book.book_id,
              book_name: book.book_name || book.book_id,
              chapter_count: book.chapter_count || undefined,
              first_chapter: book.first_chapter || undefined,
              last_chapter: book.last_chapter || undefined
            }),
            "",
            "用户可见的内置优化规则：",
            analysisOptimizationTemplate.builtInPrompt,
            "",
            "用户自然语言优化诉求：",
            request,
            "",
            "当前分析 Prompt：",
            clipText(currentPrompt, 16000),
            "",
            "请输出一版优化后的中文分析 Prompt。",
            "重要：保留原 Prompt 的核心目标，只按用户诉求做必要优化；不要把轻量任务扩写成复杂分析任务。",
            "优化后的 Prompt 不得包含运行时占位值，不得要求重建 L1/L2，不得要求逐章精读全书，除非用户明确要求 full_text 精读。"
          ].join("\n")
        }
      ]
    }
  ];
}

function promptGuideResultSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      title_suggestion: { type: "string" },
      prompt_suggestion: { type: "string" },
      rationale: { type: "string" },
      usage_notes: {
        type: "array",
        items: { type: "string" }
      },
      quality_checklist: {
        type: "array",
        items: { type: "string" }
      }
    },
    required: ["title_suggestion", "prompt_suggestion", "rationale", "usage_notes", "quality_checklist"]
  };
}

function normalizeGuideResult(value = {}) {
  return {
    title_suggestion: String(value.title_suggestion || "").trim(),
    prompt_suggestion: String(value.prompt_suggestion || "").trim(),
    rationale: String(value.rationale || "").trim(),
    usage_notes: normalizeStringList(value.usage_notes).slice(0, 6),
    quality_checklist: normalizeStringList(value.quality_checklist).slice(0, 8)
  };
}

function normalizeGuideType(type) {
  const value = String(type || "").trim().toLowerCase();
  if (Object.hasOwn(guideDefinitions, value)) return value;
  const error = new Error("Prompt 引导类型必须是 l1、l2 或 analysis。");
  error.status = 400;
  throw error;
}

function resolveBook(bookId) {
  const book = getBook(bookId);
  if (book) return book;
  const error = new Error("书籍不存在，请先选择或新建书籍。");
  error.status = 404;
  throw error;
}

function normalizeAnswers(definition, answers) {
  const byId = Array.isArray(answers)
    ? new Map(answers.map((entry) => [String(entry.id || ""), entry]))
    : new Map(Object.entries(answers || {}).map(([id, answer]) => [id, { answer }]));

  return definition.steps.map((step, index) => {
    const entry = byId.get(step.id) || {};
    return {
      id: step.id,
      step: index + 1,
      question: step.question,
      answer: String(entry.answer ?? "").trim().slice(0, 2400)
    };
  });
}

function publicGuideDefinition(definition) {
  return {
    type: definition.type,
    label: definition.label,
    scope: definition.scope,
    positioning: definition.positioning,
    steps: definition.steps,
    builtInPrompt: definition.builtInPrompt
  };
}

function normalizeStringList(value) {
  return Array.isArray(value)
    ? value.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
}

function clipText(value, maxLength) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n[已截断]`;
}
