import { ReviewRecordRow } from "./reviewTypes";

interface MarkdownCodeBlock {
  fence: string;
  language: string;
  lines: string[];
}

export function buildReviewRecordMarkdown(
  record: ReviewRecordRow,
  options: { generatedAt?: Date | string } = {},
) {
  const generatedAt = formatTimestamp(options.generatedAt || new Date());
  const fullTitle =
    toInlineText(record.title) ||
    `Zotero 条目 ${record.zoteroItemID || "未命名"}`;
  const headingTitle = truncateText(fullTitle, 72);
  const lines: string[] = [
    `# Exitem 提炼笔记：${headingTitle}`,
    "",
    "## 文献信息",
    `- 标题: ${fullTitle}`,
    `- 作者: ${toInlineText(record.authors) || "（无）"}`,
    `- 期刊: ${toInlineText(record.journal) || "（无）"}`,
    `- 发布时间: ${toInlineText(record.publicationDate) || "（无）"}`,
    `- Zotero 条目 ID: ${formatOptionalID(record.zoteroItemID)}`,
    `- Exitem 记录 ID: ${formatOptionalID(record.id)}`,
    `- 文件夹: ${formatFolderNames(record)}`,
    `- AI 提供方: ${toInlineText(record.aiProvider) || "（无）"}`,
    `- AI 模型: ${toInlineText(record.aiModel) || "（无）"}`,
    `- 创建时间: ${formatTimestamp(record.createdAt)}`,
    `- 更新时间: ${formatTimestamp(record.updatedAt)}`,
    `- 生成笔记时间: ${generatedAt}`,
  ];

  appendSection(lines, "摘要", formatMarkdownParagraph(record.abstractText));
  appendSection(
    lines,
    "研究背景",
    formatMarkdownParagraph(record.researchBackground),
  );
  appendSection(
    lines,
    "文献综述",
    formatMarkdownParagraph(record.literatureReview),
  );
  appendSection(
    lines,
    "研究方法",
    formatMarkdownParagraph(record.researchMethods),
  );
  appendSection(
    lines,
    "研究结论",
    formatMarkdownParagraph(record.researchConclusions),
  );
  appendSection(lines, "关键发现", formatMarkdownNumbered(record.keyFindings));
  appendSection(
    lines,
    "PDF 批注与笔记",
    formatMarkdownParagraph(record.pdfAnnotationNotesText),
  );
  appendSection(
    lines,
    "标签",
    formatMarkdownBullets(record.classificationTags),
  );
  appendSection(lines, "来源追踪", [
    `- 来源记录 ID: ${formatIDList(record.sourceRecordIDs)}`,
    `- 来源 Zotero 条目 ID: ${formatIDList(record.sourceZoteroItemIDs)}`,
  ]);

  return `${lines.join("\n").trim()}\n`;
}

export function renderMarkdownToHTML(markdown: string) {
  const lines = normalizeMultilineText(markdown).split("\n");
  const html: string[] = [];
  let paragraphLines: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let listItems: string[] = [];
  let codeBlock: MarkdownCodeBlock | null = null;

  const flushParagraph = () => {
    if (!paragraphLines.length) return;
    html.push(
      `<p>${paragraphLines
        .map((line) => renderInlineMarkdown(line.trimStart()))
        .join("<br/>")}</p>`,
    );
    paragraphLines = [];
  };

  const flushList = () => {
    if (!listType || !listItems.length) {
      listType = null;
      listItems = [];
      return;
    }
    html.push(`<${listType}>${listItems.join("")}</${listType}>`);
    listType = null;
    listItems = [];
  };

  const flushCodeBlock = () => {
    if (!codeBlock) return;
    const langAttr = codeBlock.language
      ? ` data-language="${escapeHTML(codeBlock.language)}"`
      : "";
    html.push(
      `<pre><code${langAttr}>${escapeHTML(codeBlock.lines.join("\n"))}</code></pre>`,
    );
    codeBlock = null;
  };

  for (const rawLine of lines) {
    const line = String(rawLine || "");

    if (codeBlock) {
      if (new RegExp(`^${escapeRegExp(codeBlock.fence)}\\s*$`).test(line)) {
        flushCodeBlock();
      } else {
        codeBlock.lines.push(line);
      }
      continue;
    }

    const fenceMatch = /^(`{3,})([A-Za-z0-9_-]+)?\s*$/.exec(line);
    if (fenceMatch) {
      flushParagraph();
      flushList();
      codeBlock = {
        fence: fenceMatch[1],
        language: fenceMatch[2] || "",
        lines: [],
      };
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      flushParagraph();
      flushList();
      const level = Math.max(1, Math.min(6, headingMatch[1].length));
      html.push(
        `<h${level}>${renderInlineMarkdown(headingMatch[2].trim())}</h${level}>`,
      );
      continue;
    }

    const orderedMatch = /^(\d+)\.\s+(.*)$/.exec(line);
    const bulletMatch = /^[-*+]\s+(.*)$/.exec(line);
    if (orderedMatch || bulletMatch) {
      flushParagraph();
      const nextListType = orderedMatch ? "ol" : "ul";
      if (listType && listType !== nextListType) {
        flushList();
      }
      listType = nextListType;
      listItems.push(
        `<li>${renderInlineMarkdown(
          (orderedMatch?.[2] || bulletMatch?.[1] || "").trim(),
        )}</li>`,
      );
      continue;
    }

    if (listType) {
      flushList();
    }
    paragraphLines.push(line);
  }

  flushParagraph();
  flushList();
  flushCodeBlock();

  return html.join("");
}

export function buildReviewRecordNoteHTML(
  record: ReviewRecordRow,
  options: { generatedAt?: Date | string } = {},
) {
  const markdown = buildReviewRecordMarkdown(record, options);
  const innerHTML = renderMarkdownToHTML(markdown);
  return `${getZoteroNotePrefix()}<div data-exitem-note="review-record">${innerHTML}</div>${getZoteroNoteSuffix()}`;
}

export async function createNativeNoteForReviewRecord(
  record: ReviewRecordRow,
  options: { generatedAt?: Date | string } = {},
) {
  const itemID = Number(record.zoteroItemID);
  if (!itemID) {
    throw new Error("记录缺少有效的 Zotero 条目 ID");
  }

  const parentItem = await Zotero.Items.getAsync(itemID);
  if (!parentItem) {
    throw new Error(`未找到 Zotero 条目：${itemID}`);
  }
  if (
    typeof parentItem.isRegularItem === "function" &&
    !parentItem.isRegularItem()
  ) {
    throw new Error("目标 Zotero 条目不是可挂载笔记的普通文献条目");
  }

  const noteItem = new Zotero.Item("note");
  noteItem.libraryID = parentItem.libraryID;
  noteItem.parentItemID = parentItem.id;
  const noteHTML = buildReviewRecordNoteHTML(record, options);
  const applied = noteItem.setNote(noteHTML);
  if (!applied) {
    throw new Error("写入 Zotero 笔记内容失败");
  }
  await noteItem.saveTx();
  return noteItem;
}

function appendSection(lines: string[], heading: string, bodyLines: string[]) {
  lines.push("", `## ${heading}`, ...bodyLines);
}

function formatMarkdownParagraph(value: unknown) {
  const text = normalizeParagraphText(value);
  if (!text) {
    return ["  （无）"];
  }
  return text.split("\n").map((line) => (line ? `  ${line}` : "  "));
}

function formatMarkdownBullets(values: unknown) {
  const items = normalizeStringArray(values);
  if (!items.length) {
    return ["  （无）"];
  }
  return items.map((item) => `- ${item}`);
}

function formatMarkdownNumbered(values: unknown) {
  const items = normalizeStringArray(values);
  if (!items.length) {
    return ["  （无）"];
  }
  return items.map((item, index) => `${index + 1}. ${item}`);
}

function formatFolderNames(record: ReviewRecordRow) {
  const names = normalizeStringArray(record.folderNames);
  if (names.length) return names.join("、");
  const single = toInlineText(record.folderName);
  return single || "未分类";
}

function formatOptionalID(value: unknown) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? String(Math.floor(num)) : "（无）";
}

function formatIDList(values: unknown) {
  const ids = normalizeIDArray(values);
  return ids.length ? ids.join(", ") : "（无）";
}

function normalizeStringArray(values: unknown) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => toInlineText(value)).filter(Boolean) as string[];
}

function normalizeIDArray(values: unknown) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => String(Math.floor(value)));
}

function normalizeParagraphText(value: unknown) {
  const normalized = normalizeMultilineText(value);
  return normalized.trim();
}

function normalizeMultilineText(value: unknown) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00A0/g, " ");
}

function toInlineText(value: unknown) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" / ")
    .trim();
}

function renderInlineMarkdown(text: string) {
  let html = escapeHTML(String(text || ""));
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/\\([\\`*_{}[\]()#+\-.!>])/g, "$1");
  return html;
}

function escapeHTML(value: string) {
  const zoteroUtils = (globalThis as any)?.Zotero?.Utilities;
  if (zoteroUtils?.htmlSpecialChars) {
    return zoteroUtils.htmlSpecialChars(String(value || ""));
  }
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatTimestamp(value: unknown) {
  if (value instanceof Date) {
    return formatDateObject(value);
  }
  const input = String(value || "").trim();
  if (!input) return "（无）";
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    return input;
  }
  return formatDateObject(date);
}

function formatDateObject(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    "0",
  )}-${String(date.getDate()).padStart(2, "0")} ${String(
    date.getHours(),
  ).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function truncateText(value: string, maxLength: number) {
  const text = String(value || "");
  const limit = Math.max(8, Math.floor(Number(maxLength) || 8));
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 3)}...`;
}

function escapeRegExp(value: string) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getZoteroNotePrefix() {
  return (
    (globalThis as any)?.Zotero?.Notes?.notePrefix ||
    '<div class="zotero-note znv1">'
  );
}

function getZoteroNoteSuffix() {
  return (globalThis as any)?.Zotero?.Notes?.noteSuffix || "</div>";
}
