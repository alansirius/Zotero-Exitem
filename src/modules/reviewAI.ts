import { detectAwesomeGPTAsync, getReviewSettings } from "./reviewConfig";
import {
  LiteratureReviewDraft,
  ReviewRecordRow,
  ReviewSettings,
} from "./reviewTypes";

const MAX_SOURCE_CONTENT_CHARS = 100_000;
const MAX_FOLDER_SUMMARY_SOURCE_CHARS = 140_000;
const MAX_NOTE_TEXT_CHARS = 4_000;
const MAX_PDF_TEXT_CHARS = 20_000;
const MAX_PDF_ANNOTATION_TEXT_CHARS = 12_000;
const MAX_PDF_ANNOTATION_COUNT = 80;
const GPT_PLUGIN_TIMEOUT_FLOOR_SECONDS = 600;
const EMBEDDING_MAX_CHUNKS = 12;
const EMBEDDING_CHUNK_CHARS = 1200;
const EMBEDDING_TOP_K = 4;
const DIRECT_PDF_PROMPT_MAX_CHARS = 30_000;

export type ReviewPromptFieldKey =
  | "title"
  | "authors"
  | "journal"
  | "publicationDate"
  | "abstract"
  | "researchBackground"
  | "literatureReview"
  | "researchMethods"
  | "researchConclusions"
  | "keyFindings"
  | "classificationTags"
  | "pdfAnnotationNotesText";

const DEFAULT_REVIEW_PROMPT_FIELD_KEYS: ReviewPromptFieldKey[] = [
  "title",
  "authors",
  "journal",
  "publicationDate",
  "abstract",
  "researchBackground",
  "literatureReview",
  "researchMethods",
  "researchConclusions",
  "keyFindings",
  "classificationTags",
];

export interface ReviewExtractionProgress {
  progress: number;
  stage: string;
}

export const DEFAULT_REVIEW_PROMPT_TEMPLATE = [
  "你是一名严谨的学术研究助理。请基于下方单篇文献信息输出结构化提炼结果。",
  "硬性要求：",
  "1. 仅返回 JSON 对象本体，不要 Markdown、不要代码块、不要额外说明文本。",
  "2. 提炼结果默认使用中文输出；除 title/authors/journal/publicationDate 外，其余字段必须使用中文，不得返回英文段落。",
  "3. 必须包含字段：title, authors, journal, publicationDate, abstract, researchBackground, literatureReview, researchMethods, researchConclusions, keyFindings, classificationTags。",
  "4. keyFindings 与 classificationTags 必须是字符串数组，不得返回对象数组。",
  "5. 严格依据提供材料，不得编造；信息不足时写“信息不足：<缺失点>”。",
  "内容深度要求：",
  "6. abstract：150-300字，交代研究对象、核心问题、数据/语料与主要结果。",
  "7. researchBackground：300-600字，说明研究动机、学术背景、关键争议与切入点。",
  "8. literatureReview：500-900字，系统梳理相关研究脉络、代表观点与本文定位。",
  "9. researchMethods：300-700字，描述数据来源、样本、变量/指标、方法流程与评估方式。",
  "10. researchConclusions：250-500字，总结主要结论、证据强度、局限与适用范围。",
  "11. keyFindings：输出 6-12 条，每条尽量具体（20-80字），避免空泛与重复。",
  "12. classificationTags：输出 8-15 个标签，覆盖主题、任务、方法、数据、领域与结论特征。",
  "",
  "文献信息如下：",
  "{{sourceContent}}",
].join("\n");

export const DEFAULT_FOLDER_SUMMARY_PROMPT_TEMPLATE = [
  "你是一名学术综述写作助手。请基于同一文件夹下的多篇提炼记录，生成一篇中文综合综述。",
  "输出格式要求（硬性）：",
  "1. 仅输出纯文本正文，不要任何 Markdown 标记符，不要项目符号，不要编号列表。",
  "2. 返回前必须执行一次 Markdown 清理：移除 #、##、###、*、**、-、+、>、`、```、[]() 链接格式、| 表格符号、以及 1. 2. 3. 等列表前缀。",
  "3. 使用连续论述段落，可自然分段，但每段都应是完整叙述句。",
  "4. 不要输出“小标题：”式分节标题，不要附加无关说明。",
  "内容要求：",
  "5. 先给出整体研究图景，再展开研究脉络、方法路线、关键结论的一致与分歧、证据强弱与局限、未来方向。",
  "6. 体现不同文献之间的联系、演化关系与互相印证/冲突点，避免逐条罗列。",
  "7. 严格基于给定记录，不得编造未提供的实验、数据或结论。",
  "8. 信息不足处请直接写“现有记录信息不足：<具体方面>”。",
  "9. 文本尽量充分，建议 1800-3200 字；优先保证准确性、覆盖度与可读性。",
  "",
  "文件夹名称：{{folderName}}",
  "",
  "记录内容如下：",
  "{{recordsContent}}",
].join("\n");

interface ReviewItemSource {
  title: string;
  authors: string;
  journal: string;
  date: string;
  abstractText: string;
  zoteroTags: string[];
  content: string;
  pdfText: string;
  pdfPromptMode: "none" | "fulltext" | "embedding";
  pdfAttachmentLabel: string;
  pdfAnnotationText: string;
  importPDFAnnotationsAsField: boolean;
}

interface ReviewExtractionOptions {
  onProgress?: (update: ReviewExtractionProgress) => void;
}

interface FolderReviewSummaryOptions {
  onProgress?: (update: ReviewExtractionProgress) => void;
}

export interface FolderReviewSummaryResult {
  text: string;
  provider: string;
  model: string;
  folderName: string;
  recordCount: number;
}

type ReviewProgressReporter = (progress: number, stage: string) => void;

type GPTBridgeCall = {
  key: string;
  call: () => Promise<any>;
};

let preferredGPTBridgeKey: string | null = null;

class ReviewUserError extends Error {
  userMessage: string;

  constructor(message: string, userMessage?: string) {
    super(message);
    this.name = "ReviewUserError";
    this.userMessage = userMessage || message;
  }
}

export async function extractLiteratureReview(
  item: Zotero.Item,
  options: ReviewExtractionOptions = {},
) {
  const report = createProgressReporter(options.onProgress);
  report(2, "准备提炼任务");
  report(8, "加载文献信息");

  const settings = getReviewSettings();
  const source = await buildItemSource(item, settings, report);
  report(35, "整理提炼输入");

  if (source.content.length > MAX_SOURCE_CONTENT_CHARS) {
    throw new ReviewUserError(
      "文献内容过长",
      "单个文献内容超过 100,000 字符，暂不支持提炼",
    );
  }

  try {
    report(42, "检查 GPT 插件状态");
    return await extractByCompatibleGPTPlugin(
      item,
      source,
      getCompatibleGPTTimeoutSeconds(settings.timeoutSeconds),
      settings.customPromptTemplate,
      report,
    );
  } catch (e: any) {
    const message = e?.message ? String(e.message) : "unknown";
    if (e instanceof ReviewUserError) throw e;
    throw new ReviewUserError(message, humanizeAIError(message));
  }
}

export function getDefaultReviewPromptTemplate() {
  return DEFAULT_REVIEW_PROMPT_TEMPLATE;
}

export function getDefaultFolderSummaryPromptTemplate() {
  return DEFAULT_FOLDER_SUMMARY_PROMPT_TEMPLATE;
}

export function parseReviewPromptFieldKeys(customPromptTemplate = "") {
  const template = String(customPromptTemplate || "").trim();
  const effectiveTemplate = template || DEFAULT_REVIEW_PROMPT_TEMPLATE;
  const explicit = parsePromptFieldKeysFromExplicitFieldLine(effectiveTemplate);
  if (explicit.length) return explicit;
  const fallback = parsePromptFieldKeysByPattern(effectiveTemplate);
  if (fallback.length) return fallback;
  return [...DEFAULT_REVIEW_PROMPT_FIELD_KEYS];
}

export async function synthesizeFolderReview(
  folderName: string,
  rows: ReviewRecordRow[],
  options: FolderReviewSummaryOptions = {},
): Promise<FolderReviewSummaryResult> {
  const report = createProgressReporter(options.onProgress);
  const normalizedFolderName =
    String(folderName || "").trim() || "未命名文件夹";
  const validRows = (rows || []).filter(Boolean);
  if (!validRows.length) {
    throw new ReviewUserError(
      "No records in folder",
      "该文件夹下暂无可用于合并综述的记录",
    );
  }

  report(5, "整理文件夹记录");
  const recordsContent = buildFolderSummarySourceContent(
    normalizedFolderName,
    validRows,
    report,
  );
  const settings = getReviewSettings();
  const prompt = buildFolderSummaryPrompt(
    normalizedFolderName,
    recordsContent,
    settings.customFolderSummaryPromptTemplate,
  );

  try {
    report(30, "检查 GPT 插件");
    const result = await summarizeByCompatibleGPTPlugin(
      normalizedFolderName,
      prompt,
      recordsContent,
      getCompatibleGPTTimeoutSeconds(settings.timeoutSeconds),
      report,
    );
    result.recordCount = validRows.length;
    return result;
  } catch (e: any) {
    const message = e?.message ? String(e.message) : "unknown";
    if (e instanceof ReviewUserError) throw e;
    throw new ReviewUserError(message, humanizeAIError(message));
  }
}

function createProgressReporter(
  onProgress?: (update: ReviewExtractionProgress) => void,
): ReviewProgressReporter {
  let lastProgress = -1;
  let lastStage = "";
  return (progress, stage) => {
    if (!onProgress) return;
    const nextProgress = clampProgress(progress);
    const nextStage = String(stage || "").trim() || "处理中";
    if (nextProgress === lastProgress && nextStage === lastStage) return;
    lastProgress = nextProgress;
    lastStage = nextStage;
    onProgress({ progress: nextProgress, stage: nextStage });
  };
}

export function getReviewErrorMessage(error: unknown) {
  if (error instanceof ReviewUserError) return error.userMessage;
  if (error instanceof Error) return error.message;
  return "提炼失败，请重试";
}

function clampProgress(progress: number) {
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(100, Math.floor(progress)));
}

async function buildItemSource(
  item: Zotero.Item,
  settings: ReviewSettings,
  report?: ReviewProgressReporter,
): Promise<ReviewItemSource> {
  report?.(10, "读取标题、作者、期刊等元数据");
  const title = safeField(item, "title") || item.getDisplayTitle() || "";
  const journal = safeField(item, "publicationTitle");
  const date = safeField(item, "date");
  const abstractText = safeField(item, "abstractNote");
  const authors = joinCreators(item);
  const zoteroTags = getItemTags(item);
  report?.(16, "读取 Zotero 笔记与标签");
  const noteText = getNoteText(item);
  const shouldReadPDFAnnotations =
    Boolean(settings.usePDFAnnotationsAsContext) ||
    Boolean(settings.importPDFAnnotationsAsField);
  const attachments =
    shouldReadPDFAnnotations || settings.usePDFAsInputSource
      ? await getCandidateAttachments(item)
      : [];
  const pdfAnnotationSource = shouldReadPDFAnnotations
    ? await getPDFAnnotationSource(attachments, settings, report)
    : { text: "", label: "" };
  const pdfSource = settings.usePDFAsInputSource
    ? await getPDFTextSource(attachments, settings, report)
    : { text: "", label: "" };
  const pdfPromptMode = pickPDFPromptMode(pdfSource.text);
  report?.(30, "整理元数据、笔记与 PDF 内容");

  const content = [
    `标题: ${title}`,
    `作者: ${authors}`,
    `期刊: ${journal}`,
    `时间: ${date}`,
    `标签: ${zoteroTags.join(", ")}`,
    "",
    "摘要:",
    abstractText || "（无摘要）",
    noteText ? "\n补充笔记:\n" + noteText : "",
    settings.usePDFAnnotationsAsContext && pdfAnnotationSource.text
      ? `\nPDF批注与批注下笔记（${pdfAnnotationSource.label || "附件"}）：\n${pdfAnnotationSource.text}`
      : "",
    pdfPromptMode === "fulltext" && pdfSource.text
      ? `\nPDF原文（${pdfSource.label || "附件"}）：\n${pdfSource.text}`
      : "",
  ]
    .filter((v) => v != null && String(v).length > 0)
    .join("\n");

  return {
    title,
    authors,
    journal,
    date,
    abstractText,
    zoteroTags,
    content,
    pdfText: pdfSource.text,
    pdfPromptMode,
    pdfAttachmentLabel: pdfSource.label,
    pdfAnnotationText: pdfAnnotationSource.text,
    importPDFAnnotationsAsField: Boolean(settings.importPDFAnnotationsAsField),
  };
}

async function extractByCompatibleGPTPlugin(
  item: Zotero.Item,
  source: ReviewItemSource,
  timeoutSeconds: number,
  customPromptTemplate: string,
  report?: ReviewProgressReporter,
) {
  report?.(48, "检查 GPT 插件状态");
  const detection = await detectAwesomeGPTAsync();
  if (!detection.installed) {
    throw new ReviewUserError(
      "Awesome GPT not found",
      "未检测到可兼容的 GPT 插件（如 Zotero GPT / Awesome GPT），请先安装并完成 Zotero GPT 配置",
    );
  }
  if (detection.installed && !detection.callable) {
    throw new ReviewUserError(
      "Awesome GPT not callable",
      detection.obstacle ||
        "检测到 GPT 插件已安装，但未找到可调用接口，请先初始化 Zotero GPT 界面后重试",
    );
  }
  report?.(56, "生成提炼请求");
  const bridgeSourceContent = await enrichSourceContentWithPDFEmbeddings(
    source,
    timeoutSeconds,
    report,
  );
  report?.(74, "等待 GPT 模型响应");
  const awesomeResult = await tryCallAwesomeGPT(
    item,
    bridgeSourceContent,
    timeoutSeconds,
    buildPrompt(bridgeSourceContent, customPromptTemplate),
  );
  if (!awesomeResult) {
    throw new ReviewUserError(
      "Awesome GPT bridge unavailable",
      "已检测到 GPT 插件，但当前未找到可调用接口，请先初始化 Zotero GPT 界面后重试",
    );
  }
  report?.(88, "解析模型返回结果");
  const draft = normalizeDraft(item, awesomeResult.text, {
    provider: "awesomegpt",
    model: awesomeResult.model || "awesomegpt",
    source,
  });
  report?.(96, "整理并校验提炼结果");
  return draft;
}

async function summarizeByCompatibleGPTPlugin(
  folderName: string,
  prompt: string,
  recordsContent: string,
  timeoutSeconds: number,
  report?: ReviewProgressReporter,
): Promise<FolderReviewSummaryResult> {
  report?.(44, "检查 GPT 插件状态");
  const detection = await detectAwesomeGPTAsync();
  if (!detection.installed) {
    throw new ReviewUserError(
      "Awesome GPT not found",
      "未检测到可兼容的 GPT 插件（如 Zotero GPT / Awesome GPT），请先安装并完成 Zotero GPT 配置",
    );
  }
  if (!detection.callable) {
    throw new ReviewUserError(
      "Awesome GPT not callable",
      detection.obstacle ||
        "检测到 GPT 插件已安装，但未找到可调用接口，请先初始化 Zotero GPT 界面后重试",
    );
  }
  report?.(58, "发送合并综述请求");
  const awesomeResult = await tryCallAwesomeGPT(
    null,
    recordsContent,
    timeoutSeconds,
    prompt,
  );
  if (!awesomeResult) {
    throw new ReviewUserError(
      "Awesome GPT bridge unavailable",
      "已检测到 GPT 插件，但当前未找到可调用接口，请先初始化 Zotero GPT 界面后重试",
    );
  }
  report?.(92, "整理综述结果");
  return {
    text: String(awesomeResult.text || "").trim(),
    provider: "awesomegpt",
    model: awesomeResult.model || "awesomegpt",
    folderName,
    recordCount: 0, // caller will overwrite if needed; kept for shape consistency
  };
}

async function tryCallAwesomeGPT(
  item: Zotero.Item | null,
  sourceContent: string,
  timeoutSeconds: number,
  prompt: string,
) {
  const requestPayload = {
    item,
    prompt,
    sourceContent,
  };
  const mainWin = getPrimaryMainWindowCompat() as any;
  const bridgeCalls = getGPTBridgeCalls(requestPayload, mainWin);
  const orderedBridgeCalls =
    preferredGPTBridgeKey == null
      ? bridgeCalls
      : [
          ...bridgeCalls.filter((candidate) => {
            return candidate.key === preferredGPTBridgeKey;
          }),
          ...bridgeCalls.filter((candidate) => {
            return candidate.key !== preferredGPTBridgeKey;
          }),
        ];

  let lastError: unknown = null;
  for (const candidate of orderedBridgeCalls) {
    try {
      const result = await withPromiseTimeout(
        candidate.call(),
        timeoutSeconds * 1000,
        new ReviewUserError(
          "GPT plugin bridge timeout",
          `GPT 插件响应超时（>${timeoutSeconds}秒），请重试`,
        ),
      );
      if (!result) {
        if (candidate.key === preferredGPTBridgeKey) {
          preferredGPTBridgeKey = null;
        }
        continue;
      }
      preferredGPTBridgeKey = candidate.key;
      if (typeof result === "string") return { text: result };
      if (typeof result?.text === "string")
        return { text: result.text, model: result.model };
      if (typeof result?.content === "string")
        return { text: result.content, model: result.model };
    } catch (e) {
      if (candidate.key === preferredGPTBridgeKey) {
        preferredGPTBridgeKey = null;
      }
      lastError = e;
      // Try next candidate
    }
  }
  if (lastError) {
    throw lastError;
  }
  return null;
}

function getGPTBridgeCalls(
  requestPayload: {
    item: Zotero.Item | null;
    prompt: string;
    sourceContent: string;
  },
  mainWin: any,
): GPTBridgeCall[] {
  return [
    {
      key: "zotero.awesomegpt.extractLiteratureReview",
      call: async () => {
        const fn = (Zotero as any)?.AwesomeGPT?.extractLiteratureReview;
        if (typeof fn !== "function") return null;
        return fn(requestPayload);
      },
    },
    {
      key: "zotero.awesomegpt.extract",
      call: async () => {
        const fn = (Zotero as any)?.AwesomeGPT?.extract;
        if (typeof fn !== "function") return null;
        return fn(requestPayload);
      },
    },
    {
      key: "zotero.gpt.extract",
      call: async () => {
        const fn = (Zotero as any)?.GPT?.extract;
        if (typeof fn !== "function") return null;
        return fn(requestPayload);
      },
    },
    {
      key: "window.awesomegpt.extract",
      call: async () => {
        const fn = (globalThis as any)?.AwesomeGPT?.extract;
        if (typeof fn !== "function") return null;
        return fn(requestPayload);
      },
    },
    {
      key: "meet.openapi.getGPTResponse",
      call: async () => {
        const meet = (mainWin as any)?.Meet;
        const fn = meet?.OpenAI?.getGPTResponse;
        if (typeof fn !== "function") return null;
        const text = await fn.call(meet.OpenAI, requestPayload.prompt);
        return {
          text,
          model:
            ((Zotero as any)?.Prefs?.get?.(
              "extensions.zotero.zoterogpt.model",
            ) as string | undefined) || "zotero-gpt",
        };
      },
    },
  ];
}

function getCompatibleGPTTimeoutSeconds(timeoutSeconds: number) {
  const normalized = Math.max(1, Math.floor(Number(timeoutSeconds) || 0));
  return Math.max(GPT_PLUGIN_TIMEOUT_FLOOR_SECONDS, normalized);
}

async function enrichSourceContentWithPDFEmbeddings(
  source: ReviewItemSource,
  timeoutSeconds: number,
  report?: ReviewProgressReporter,
) {
  if (source.pdfPromptMode !== "embedding" || !source.pdfText) {
    return source.content;
  }

  report?.(60, "分析长 PDF 重点片段");
  const embeddingContext = await tryBuildPDFEmbeddingContext(
    source,
    timeoutSeconds,
    report,
  );
  if (!embeddingContext) {
    report?.(68, "未获得相关片段，跳过长 PDF 附加内容");
    return mergePDFEmbeddingContext(source.content, "");
  }

  report?.(70, "合并 PDF 重点片段");
  return mergePDFEmbeddingContext(source.content, embeddingContext);
}

export function pickPDFPromptMode(
  pdfText: string,
): ReviewItemSource["pdfPromptMode"] {
  const length = String(pdfText || "").trim().length;
  if (!length) return "none";
  return length <= DIRECT_PDF_PROMPT_MAX_CHARS ? "fulltext" : "embedding";
}

export function mergePDFEmbeddingContext(
  baseContent: string,
  embeddingContext: string,
) {
  const normalizedContext = String(embeddingContext || "").trim();
  if (!normalizedContext) {
    return baseContent;
  }
  const section = [
    "",
    "PDF语义检索片段（Embedding 相关段落）:",
    normalizedContext,
  ].join("\n");
  return appendCappedSection(baseContent, section, MAX_SOURCE_CONTENT_CHARS);
}

async function tryBuildPDFEmbeddingContext(
  source: ReviewItemSource,
  timeoutSeconds: number,
  report?: ReviewProgressReporter,
) {
  try {
    const mainWin = getPrimaryMainWindowCompat() as any;
    const openAI = (mainWin as any)?.Meet?.OpenAI;
    const embedDocuments = openAI?.embedDocuments;
    const embedQuery = openAI?.embedQuery;
    if (
      typeof embedDocuments !== "function" ||
      typeof embedQuery !== "function"
    ) {
      return "";
    }

    const chunks = chunkTextForEmbedding(source.pdfText);
    if (chunks.length < 2) {
      return "";
    }
    report?.(62, "计算 PDF 分块向量");

    const query = buildPDFEmbeddingQuery(source);

    const embedTimeoutSeconds = Math.max(20, Math.min(45, timeoutSeconds));
    const docVectorsRaw = await withPromiseTimeout(
      Promise.resolve(embedDocuments.call(openAI, chunks)),
      embedTimeoutSeconds * 1000,
      new Error("PDF embedding documents timeout"),
    );
    report?.(65, "计算检索查询向量");
    const queryVectorRaw = await withPromiseTimeout(
      Promise.resolve(embedQuery.call(openAI, query)),
      embedTimeoutSeconds * 1000,
      new Error("PDF embedding query timeout"),
    );

    const queryVector = toNumericVector(queryVectorRaw);
    if (!queryVector.length) {
      return "";
    }

    const ranked = chunks
      .map((text, index) => {
        const vector = toNumericVector((docVectorsRaw as any)?.[index]);
        if (!vector.length) return null;
        return {
          index,
          text,
          score: cosineSimilarity(queryVector, vector),
        };
      })
      .filter(Boolean) as Array<{ index: number; text: string; score: number }>;

    if (!ranked.length) {
      return "";
    }
    report?.(67, "筛选相关 PDF 片段");

    const selected = ranked
      .sort((a, b) => b.score - a.score)
      .slice(0, EMBEDDING_TOP_K)
      .sort((a, b) => a.index - b.index);

    return selected
      .map((chunk, i) => `[片段${i + 1}] ${truncateText(chunk.text, 1200)}`)
      .join("\n\n");
  } catch (e) {
    ztoolkit.log("PDF embedding enhancement skipped", e);
    return "";
  }
}

function buildPDFEmbeddingQuery(source: ReviewItemSource) {
  return [
    `请提取文献《${source.title || "未命名文献"}》中与研究背景、研究方法、研究结论、关键发现相关的段落。`,
    source.authors ? `作者：${source.authors}` : "",
    source.abstractText
      ? `摘要线索：${truncateText(source.abstractText, 600)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function chunkTextForEmbedding(text: string) {
  const normalized = normalizeAttachmentText(text);
  if (!normalized) return [] as string[];

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    const next = current.trim();
    if (next) chunks.push(next);
    current = "";
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > EMBEDDING_CHUNK_CHARS * 1.5) {
      if (current) flush();
      for (let i = 0; i < paragraph.length; i += EMBEDDING_CHUNK_CHARS) {
        chunks.push(paragraph.slice(i, i + EMBEDDING_CHUNK_CHARS).trim());
        if (chunks.length >= EMBEDDING_MAX_CHUNKS)
          return chunks.filter(Boolean);
      }
      continue;
    }

    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > EMBEDDING_CHUNK_CHARS && current) {
      flush();
      current = paragraph;
    } else {
      current = candidate;
    }

    if (chunks.length >= EMBEDDING_MAX_CHUNKS) break;
  }
  if (current && chunks.length < EMBEDDING_MAX_CHUNKS) {
    flush();
  }

  return chunks.filter(Boolean).slice(0, EMBEDDING_MAX_CHUNKS);
}

function toNumericVector(value: unknown) {
  if (!Array.isArray(value)) return [] as number[];
  return value.map((v) => Number(v)).filter((v) => Number.isFinite(v));
}

function cosineSimilarity(a: number[], b: number[]) {
  const size = Math.min(a.length, b.length);
  if (!size) return -1;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < size; i += 1) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (!normA || !normB) return -1;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function appendCappedSection(base: string, section: string, maxChars: number) {
  if (!section) return base;
  if (base.length + section.length <= maxChars) {
    return `${base}${section}`;
  }
  const allowed = Math.max(0, maxChars - base.length - 32);
  if (!allowed) return base;
  return `${base}${section.slice(0, allowed)}\n[Embedding片段已截断]`;
}

function normalizeDraft(
  item: Zotero.Item,
  rawText: string,
  context: {
    provider: string;
    model: string;
    source: ReviewItemSource;
  },
): LiteratureReviewDraft {
  const cleaned = stripCodeFence(rawText).trim();
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = {};
  }

  const keyFindings = coerceArray(
    parsed.keyFindings || parsed.key_findings || parsed.findings || [],
  );
  const classificationTags = coerceArray(
    parsed.classificationTags ||
      parsed.classification_tags ||
      context.source.zoteroTags,
  );

  const draft: LiteratureReviewDraft = {
    zoteroItemID: Number(item.id),
    title: pickString(parsed.title, context.source.title),
    authors: pickString(parsed.authors, context.source.authors),
    journal: pickString(parsed.journal, context.source.journal),
    publicationDate: pickString(
      parsed.publicationDate || parsed.publication_date,
      context.source.date,
    ),
    abstractText: pickString(
      parsed.abstract || parsed.abstractText,
      context.source.abstractText,
    ),
    pdfAnnotationNotesText: context.source.importPDFAnnotationsAsField
      ? String(context.source.pdfAnnotationText || "")
      : "",
    researchBackground: pickString(
      parsed.researchBackground || parsed.background,
      summarizeAbstract(
        context.source.abstractText,
        "研究背景信息不足，建议人工补充。",
      ),
    ),
    literatureReview: pickString(
      parsed.literatureReview || parsed.review,
      "AI 未返回文献综述内容，请重试或手动补充。",
    ),
    researchMethods: pickString(
      parsed.researchMethods || parsed.methods,
      "AI 未识别研究方法，请结合原文确认。",
    ),
    researchConclusions: pickString(
      parsed.researchConclusions || parsed.conclusions,
      "AI 未识别研究结论，请结合原文确认。",
    ),
    keyFindings: keyFindings.length
      ? keyFindings
      : ["AI 未返回关键发现列表，请结合原文补充。"],
    classificationTags: classificationTags.length
      ? classificationTags
      : context.source.zoteroTags,
    aiProvider: context.provider,
    aiModel: context.model,
    rawAIResponse: cleaned,
  };

  return draft;
}

function buildPrompt(sourceContent: string, customPromptTemplate = "") {
  const template = String(customPromptTemplate || "").trim();
  if (!template) {
    return DEFAULT_REVIEW_PROMPT_TEMPLATE.replace(
      /\{\{sourceContent\}\}/g,
      sourceContent,
    );
  }

  if (/\{\{source(Content|_content)\}\}/.test(template)) {
    return template
      .replace(/\{\{sourceContent\}\}/g, sourceContent)
      .replace(/\{\{source_content\}\}/g, sourceContent);
  }

  return [template, "", "文献信息如下：", sourceContent].join("\n");
}

function parsePromptFieldKeysFromExplicitFieldLine(template: string) {
  const fieldLines = String(template || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /(字段|fields?)/i.test(line));
  if (!fieldLines.length) return [] as ReviewPromptFieldKey[];
  const line = fieldLines[0];
  const matched = line.match(/(?:字段|fields?)\s*[：:]\s*(.+)$/i);
  const source = matched?.[1] || line;
  return parsePromptFieldKeysFromTokenString(source);
}

function parsePromptFieldKeysByPattern(template: string) {
  const text = String(template || "");
  const candidates: Array<{ key: ReviewPromptFieldKey; index: number }> = [];
  for (const [key, patterns] of Object.entries(
    PROMPT_FIELD_DETECTION_PATTERNS,
  ) as Array<[ReviewPromptFieldKey, RegExp[]]>) {
    const indexes = patterns
      .map((pattern) => text.search(pattern))
      .filter((idx) => idx >= 0);
    if (!indexes.length) continue;
    candidates.push({
      key,
      index: Math.min(...indexes),
    });
  }
  candidates.sort((a, b) => a.index - b.index);
  return uniquePromptFieldKeys(candidates.map((it) => it.key));
}

function parsePromptFieldKeysFromTokenString(input: string) {
  const raw = String(input || "");
  const tokens = raw
    .split(/[\s,，;；、|/]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const keys = tokens
    .map((token) => mapPromptTokenToFieldKey(token))
    .filter((field): field is ReviewPromptFieldKey => Boolean(field));
  return uniquePromptFieldKeys(keys);
}

function uniquePromptFieldKeys(keys: ReviewPromptFieldKey[]) {
  const normalized = keys.filter(Boolean);
  if (!normalized.length) return [] as ReviewPromptFieldKey[];
  return Array.from(new Set(normalized));
}

function mapPromptTokenToFieldKey(token: string): ReviewPromptFieldKey | null {
  const normalized = normalizePromptToken(token);
  if (!normalized) return null;
  const mapped = PROMPT_FIELD_ALIAS_MAP[normalized];
  if (mapped) return mapped;
  if (normalized.includes("pdf") && normalized.includes("annotation")) {
    return "pdfAnnotationNotesText";
  }
  if (normalized.includes("pdf") && normalized.includes("批注")) {
    return "pdfAnnotationNotesText";
  }
  return null;
}

function normalizePromptToken(token: string) {
  return String(token || "")
    .trim()
    .replace(/[。．,，;；:：'"`“”‘’]/g, "")
    .replace(/\s+/g, "")
    .replace(/[_-]/g, "")
    .toLowerCase();
}

const PROMPT_FIELD_ALIAS_MAP: Record<string, ReviewPromptFieldKey> = {
  title: "title",
  标题: "title",
  authors: "authors",
  author: "authors",
  作者: "authors",
  journal: "journal",
  期刊: "journal",
  publicationdate: "publicationDate",
  publicationtime: "publicationDate",
  发表时间: "publicationDate",
  发布时间: "publicationDate",
  日期: "publicationDate",
  时间: "publicationDate",
  abstract: "abstract",
  abstracttext: "abstract",
  摘要: "abstract",
  researchbackground: "researchBackground",
  background: "researchBackground",
  研究背景: "researchBackground",
  literaturereview: "literatureReview",
  review: "literatureReview",
  文献综述: "literatureReview",
  researchmethods: "researchMethods",
  methods: "researchMethods",
  研究方法: "researchMethods",
  researchconclusions: "researchConclusions",
  conclusions: "researchConclusions",
  研究结论: "researchConclusions",
  keyfindings: "keyFindings",
  findings: "keyFindings",
  关键发现: "keyFindings",
  classificationtags: "classificationTags",
  tags: "classificationTags",
  分类标签: "classificationTags",
  标签: "classificationTags",
  pdfannotationnotestext: "pdfAnnotationNotesText",
  pdfannotations: "pdfAnnotationNotesText",
  pdf批注与笔记: "pdfAnnotationNotesText",
  pdf批注: "pdfAnnotationNotesText",
  批注与笔记: "pdfAnnotationNotesText",
};

const PROMPT_FIELD_DETECTION_PATTERNS: Record<ReviewPromptFieldKey, RegExp[]> =
  {
    title: [/\btitle\b/i, /标题/],
    authors: [/\bauthors?\b/i, /作者/],
    journal: [/\bjournal\b/i, /期刊/],
    publicationDate: [
      /\bpublication[_\s-]?date\b/i,
      /发表时间|发布时间|日期|时间/,
    ],
    abstract: [/\babstract(?:text)?\b/i, /摘要/],
    researchBackground: [/\bresearch[_\s-]?background\b/i, /研究背景|背景/],
    literatureReview: [/\bliterature[_\s-]?review\b/i, /文献综述/],
    researchMethods: [/\bresearch[_\s-]?methods?\b/i, /研究方法|方法/],
    researchConclusions: [/\bresearch[_\s-]?conclusions?\b/i, /研究结论|结论/],
    keyFindings: [/\bkey[_\s-]?findings?\b/i, /关键发现/],
    classificationTags: [/\bclassification[_\s-]?tags?\b/i, /分类标签|标签/],
    pdfAnnotationNotesText: [
      /\bpdf[_\s-]?annotation[_\s-]?notes?(?:[_\s-]?text)?\b/i,
      /pdf批注与笔记|pdf批注|批注与笔记/,
    ],
  };

function buildFolderSummaryPrompt(
  folderName: string,
  recordsContent: string,
  customPromptTemplate = "",
) {
  const template = String(customPromptTemplate || "").trim();
  if (!template) {
    return DEFAULT_FOLDER_SUMMARY_PROMPT_TEMPLATE.replace(
      /\{\{folderName\}\}/g,
      folderName,
    ).replace(/\{\{recordsContent\}\}/g, recordsContent);
  }

  const hasFolderPlaceholder = /\{\{folderName\}\}/.test(template);
  const hasRecordsPlaceholder = /\{\{recordsContent\}\}/.test(template);
  let prompt = template
    .replace(/\{\{folderName\}\}/g, folderName)
    .replace(/\{\{recordsContent\}\}/g, recordsContent);

  if (!hasFolderPlaceholder || !hasRecordsPlaceholder) {
    prompt = [
      prompt,
      "",
      hasFolderPlaceholder ? "" : `文件夹名称：${folderName}`,
      hasRecordsPlaceholder ? "" : `记录内容如下：\n${recordsContent}`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return prompt;
}

function buildFolderSummarySourceContent(
  folderName: string,
  rows: ReviewRecordRow[],
  report?: ReviewProgressReporter,
) {
  report?.(12, "整理记录内容");
  const parts: string[] = [];
  const sortedRows = [...rows].sort((a, b) => {
    const av = String(a.publicationDate || "");
    const bv = String(b.publicationDate || "");
    if (av < bv) return -1;
    if (av > bv) return 1;
    return (a.id || 0) - (b.id || 0);
  });

  for (let i = 0; i < sortedRows.length; i += 1) {
    const row = sortedRows[i];
    if (parts.join("\n\n").length > MAX_FOLDER_SUMMARY_SOURCE_CHARS) break;
    const pdfAnnotationSummaryText = truncateTextWithNotice(
      String(row.pdfAnnotationNotesText || ""),
      1400,
      "PDF批注与批注下笔记已截断",
    );
    const block = [
      `【记录${i + 1}】`,
      `标题: ${row.title || "(无标题)"}`,
      `作者: ${row.authors || ""}`,
      `期刊: ${row.journal || ""}`,
      `发表时间: ${row.publicationDate || ""}`,
      `分类标签: ${(row.classificationTags || []).join(", ")}`,
      ...(pdfAnnotationSummaryText
        ? ["PDF批注与批注下笔记:", pdfAnnotationSummaryText]
        : []),
      "研究背景:",
      truncateText(String(row.researchBackground || ""), 1200),
      "文献综述:",
      truncateText(String(row.literatureReview || ""), 1600),
      "研究方法:",
      truncateText(String(row.researchMethods || ""), 1000),
      "研究结论:",
      truncateText(String(row.researchConclusions || ""), 1200),
      "关键发现:",
      (row.keyFindings || [])
        .slice(0, 10)
        .map((v, idx) => `${idx + 1}. ${v}`)
        .join("\n"),
    ]
      .map((v) => String(v ?? "").trimEnd())
      .filter((v) => v.length > 0)
      .join("\n");
    parts.push(block);
  }

  let content = [
    `文件夹：${folderName}`,
    `记录数量：${rows.length}`,
    "",
    parts.join("\n\n"),
  ].join("\n");

  if (content.length > MAX_FOLDER_SUMMARY_SOURCE_CHARS) {
    content = `${content.slice(0, MAX_FOLDER_SUMMARY_SOURCE_CHARS)}\n\n[记录内容已截断以控制输入长度]`;
  }
  report?.(24, "完成记录内容整理");
  return content;
}

function stripCodeFence(text: string) {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : trimmed;
}

function pickString(input: unknown, fallback = "") {
  const value = String(input ?? "").trim();
  return value || String(fallback || "");
}

function coerceArray(input: unknown) {
  if (Array.isArray(input)) {
    return input
      .map((v) => String(v).trim())
      .filter(Boolean)
      .slice(0, 20);
  }
  if (typeof input === "string") {
    return input
      .split(/[\n;,，；]/)
      .map((v) => v.trim())
      .filter(Boolean)
      .slice(0, 20);
  }
  return [];
}

function humanizeAIError(message: string) {
  const msg = message.toLowerCase();
  if (
    msg.includes("awesome gpt not found") ||
    msg.includes("zotero gpt") ||
    msg.includes("not found")
  ) {
    return "未检测到可用的 Zotero GPT，请检查插件安装与配置";
  }
  if (msg.includes("not callable") || msg.includes("bridge unavailable")) {
    return "已检测到 Zotero GPT，但桥接接口不可用，请先打开 Zotero GPT 页面后重试";
  }
  if (msg.includes("timeout")) {
    return "请求超时，请检查网络和 Zotero GPT 状态后重试";
  }
  if (msg.includes("network") || msg.includes("fetch")) {
    return "网络异常，请检查网络连接与 Zotero GPT 接口状态";
  }
  return "提炼失败，请重试（可检查 Zotero GPT 插件状态和网络）";
}

function safeField(item: Zotero.Item, field: string) {
  try {
    return String(item.getField(field as any) || "").trim();
  } catch {
    return "";
  }
}

function joinCreators(item: Zotero.Item) {
  try {
    const creators = item.getCreators() || [];
    return creators
      .map((creator: any) => {
        if (creator.name) return String(creator.name);
        return [creator.lastName, creator.firstName].filter(Boolean).join(" ");
      })
      .filter(Boolean)
      .join(", ");
  } catch {
    return String((item as any).firstCreator || "");
  }
}

function getItemTags(item: Zotero.Item) {
  try {
    const tags = (item.getTags() || []) as any[];
    return tags.map((t) => String(t?.tag || "").trim()).filter(Boolean);
  } catch {
    return [] as string[];
  }
}

function getNoteText(item: Zotero.Item) {
  try {
    const noteIDs = (item.getNotes?.() || []).slice(0, 3) as number[];
    const notes = noteIDs
      .map((id) => (Zotero.Items as any).get(id))
      .filter(Boolean)
      .map((note: any) => htmlNoteToPlainText(String(note.getNote?.() || "")))
      .filter(Boolean);
    return notes.join("\n").slice(0, MAX_NOTE_TEXT_CHARS);
  } catch {
    return "";
  }
}

async function getPDFAnnotationSource(
  attachments: Zotero.Item[],
  settings: ReviewSettings,
  report?: ReviewProgressReporter,
): Promise<{ text: string; label: string }> {
  try {
    for (const attachment of attachments) {
      if (!isPDFAttachmentItem(attachment)) continue;

      report?.(24, "读取 PDF 批注与批注笔记");
      const annotations = getAttachmentAnnotations(attachment);
      if (!annotations.length) continue;

      const lines: string[] = [];
      let included = 0;
      for (const annotation of annotations) {
        if (included >= MAX_PDF_ANNOTATION_COUNT) break;
        const block = buildAnnotationBlock(annotation, included + 1);
        if (!block) continue;
        lines.push(block);
        included += 1;
      }
      if (!lines.length) continue;

      const joined = lines.join("\n\n");
      const truncationEnabled = Boolean(settings.enablePDFInputTruncation);
      if (!truncationEnabled) {
        return {
          text: joined,
          label: buildAttachmentLabel(attachment),
        };
      }
      const annotationMaxChars = Math.max(
        1,
        Number(settings.pdfAnnotationTextMaxChars) ||
          MAX_PDF_ANNOTATION_TEXT_CHARS,
      );
      return {
        text: truncateTextWithNotice(
          joined,
          annotationMaxChars,
          `PDF批注内容已截断，超过 ${annotationMaxChars} 字符`,
        ),
        label: buildAttachmentLabel(attachment),
      };
    }
  } catch (e) {
    ztoolkit.log("Failed to read PDF annotations", e);
  }

  return { text: "", label: "" };
}

async function getPDFTextSource(
  attachments: Zotero.Item[],
  settings: ReviewSettings,
  report?: ReviewProgressReporter,
) {
  for (const attachment of attachments) {
    if (!isPDFAttachmentItem(attachment)) continue;

    let text = await readAttachmentText(attachment);
    if (!text) {
      report?.(25, "建立 PDF 全文索引");
      await tryIndexAttachmentText(attachment);
      text = await readAttachmentText(attachment);
    }
    const normalized = normalizeAttachmentText(text);
    if (!normalized) continue;

    report?.(28, "提取 PDF 全文");
    const truncationEnabled = Boolean(settings.enablePDFInputTruncation);
    if (!truncationEnabled) {
      return {
        text: normalized,
        label: buildAttachmentLabel(attachment),
      };
    }
    const pdfTextMaxChars = Math.max(
      1,
      Number(settings.pdfTextMaxChars) || MAX_PDF_TEXT_CHARS,
    );
    return {
      text: truncateText(normalized, pdfTextMaxChars),
      label: buildAttachmentLabel(attachment),
    };
  }

  return { text: "", label: "" };
}

function isPDFAttachmentItem(attachment: Zotero.Item) {
  const mimeType = String(
    (attachment as any)?.attachmentContentType || "",
  ).toLowerCase();
  return (
    (typeof (attachment as any)?.isPDFAttachment === "function" &&
      Boolean((attachment as any).isPDFAttachment())) ||
    mimeType.includes("pdf")
  );
}

function getAttachmentAnnotations(attachment: Zotero.Item): any[] {
  try {
    const raw = (attachment as any)?.getAnnotations?.();
    const normalized = Array.isArray(raw) ? raw : [];
    return normalized
      .map((entry) => {
        if (!entry) return null;
        if (typeof entry === "number") {
          return (Zotero.Items as any)?.get?.(entry) || null;
        }
        return entry;
      })
      .filter(Boolean)
      .sort(compareAnnotations);
  } catch {
    return [];
  }
}

function compareAnnotations(a: any, b: any) {
  const pageA = getAnnotationPageNumber(a);
  const pageB = getAnnotationPageNumber(b);
  if (pageA !== pageB) return pageA - pageB;
  const sortA = String(a?.annotationSortIndex || "");
  const sortB = String(b?.annotationSortIndex || "");
  if (sortA < sortB) return -1;
  if (sortA > sortB) return 1;
  return Number(a?.id || 0) - Number(b?.id || 0);
}

function buildAnnotationBlock(annotation: any, index: number) {
  const text = normalizeAnnotationField(annotation?.annotationText);
  const comment = normalizeAnnotationField(annotation?.annotationComment);
  const childNotes = getAnnotationChildNoteText(annotation);
  if (!text && !comment && !childNotes) {
    return "";
  }

  const pageLabel = getAnnotationPageLabel(annotation);
  const typeLabel = mapAnnotationTypeLabel(annotation?.annotationType);
  const lines = [
    `${index}. [${pageLabel}]${typeLabel ? `[${typeLabel}]` : ""}`,
  ];
  if (text) lines.push(`摘录: ${text}`);
  if (comment) lines.push(`批注: ${comment}`);
  if (childNotes) lines.push(`批注下笔记: ${childNotes}`);
  return lines.join("\n");
}

function normalizeAnnotationField(value: unknown) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .split("\u0000")
    .join(" ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getAnnotationChildNoteText(annotation: any) {
  try {
    const noteIDs = (annotation?.getNotes?.() || []) as number[];
    const texts = noteIDs
      .map((id) => (Zotero.Items as any)?.get?.(id))
      .filter(Boolean)
      .map((note: any) => htmlNoteToPlainText(String(note?.getNote?.() || "")))
      .filter(Boolean)
      .slice(0, 5);
    return texts.join(" | ");
  } catch {
    return "";
  }
}

function htmlNoteToPlainText(html: string) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function getAnnotationPageLabel(annotation: any) {
  const label = String(annotation?.annotationPageLabel || "").trim();
  if (label) return `第${label}页`;
  const pageNum = getAnnotationPageNumber(annotation);
  if (Number.isFinite(pageNum) && pageNum > 0) return `第${pageNum}页`;
  return "页码未知";
}

function getAnnotationPageNumber(annotation: any) {
  try {
    const pageLabel = String(annotation?.annotationPageLabel || "").trim();
    const numFromLabel = Number(pageLabel);
    if (Number.isFinite(numFromLabel) && numFromLabel > 0) return numFromLabel;
  } catch {
    // ignore
  }
  try {
    const pos = JSON.parse(String(annotation?.annotationPosition || "{}"));
    const pageIndex = Number(pos?.pageIndex);
    if (Number.isFinite(pageIndex) && pageIndex >= 0) return pageIndex + 1;
  } catch {
    // ignore
  }
  return Number.MAX_SAFE_INTEGER;
}

function mapAnnotationTypeLabel(type: unknown) {
  const value = String(type || "").toLowerCase();
  switch (value) {
    case "highlight":
      return "高亮";
    case "underline":
      return "下划线";
    case "note":
      return "便签";
    case "image":
      return "图片区域";
    case "ink":
      return "手写";
    case "text":
      return "文本";
    default:
      return value ? value : "";
  }
}

async function getCandidateAttachments(
  item: Zotero.Item,
): Promise<Zotero.Item[]> {
  const result: Zotero.Item[] = [];
  const seen = new Set<number>();
  const push = (attachment: Zotero.Item | false | null | undefined) => {
    if (!attachment) return;
    const id = Number(attachment.id || 0);
    if (!id || seen.has(id)) return;
    seen.add(id);
    result.push(attachment);
  };

  try {
    if ((item as any)?.isAttachment?.()) {
      push(item);
      return result;
    }
  } catch {
    // ignore
  }

  try {
    push(await item.getBestAttachment());
  } catch {
    // ignore
  }

  try {
    const bestAttachments = await item.getBestAttachments();
    for (const attachment of bestAttachments || []) {
      push(attachment);
    }
  } catch {
    // ignore
  }

  try {
    const attachmentIDs = (item.getAttachments?.() || []) as number[];
    for (const attachmentID of attachmentIDs) {
      push(
        (Zotero.Items as any)?.get?.(attachmentID) as Zotero.Item | undefined,
      );
    }
  } catch {
    // ignore
  }

  return result;
}

async function readAttachmentText(attachment: Zotero.Item) {
  try {
    return String((await (attachment as any).attachmentText) || "");
  } catch {
    return "";
  }
}

async function tryIndexAttachmentText(attachment: Zotero.Item) {
  try {
    const fullText = (Zotero as any).FullText || (Zotero as any).Fulltext;
    if (!fullText?.indexItems) return;
    await fullText.indexItems([Number(attachment.id)], {
      complete: false,
      ignoreErrors: true,
    });
  } catch {
    // ignore
  }
}

function normalizeAttachmentText(text: string) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .split("\u0000")
    .join(" ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildAttachmentLabel(attachment: Zotero.Item) {
  const title =
    safeField(attachment, "title") ||
    (typeof (attachment as any)?.getDisplayTitle === "function"
      ? String((attachment as any).getDisplayTitle() || "")
      : "");
  return title || `附件 ${String(attachment.id || "")}`.trim();
}

function truncateText(text: string, max: number) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[PDF原文已截断，超过 ${max} 字符]`;
}

function truncateTextWithNotice(text: string, max: number, notice: string) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[${notice}]`;
}

function summarizeAbstract(abstractText: string, fallback: string) {
  const text = String(abstractText || "").trim();
  if (!text) return fallback;
  return text.slice(0, 300);
}

async function withPromiseTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutError: Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(timeoutError), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function getPrimaryMainWindowCompat() {
  const getMainWindows = (Zotero as any)?.getMainWindows;
  if (typeof getMainWindows === "function") {
    const wins = getMainWindows.call(Zotero);
    if (Array.isArray(wins) && wins.length) return wins[0];
  }
  const getMainWindow = (Zotero as any)?.getMainWindow;
  if (typeof getMainWindow === "function") {
    return getMainWindow.call(Zotero) || null;
  }

  try {
    const wm = (globalThis as any)?.Services?.wm;
    if (wm?.getMostRecentWindow) {
      return wm.getMostRecentWindow("zotero:main") || null;
    }
  } catch {
    // ignore
  }

  return null;
}
