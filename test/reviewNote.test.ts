import { assert } from "chai";
import {
  buildReviewRecordMarkdown,
  renderMarkdownToHTML,
} from "../src/modules/reviewNote";
import { ReviewRecordRow } from "../src/modules/reviewTypes";

function makeRow(overrides: Partial<ReviewRecordRow> = {}): ReviewRecordRow {
  return {
    id: 12,
    zoteroItemID: 345,
    recordType: "literature",
    title: "Structured extraction for note persistence",
    authors: "Alice Example; Bob Example",
    journal: "Journal of Plugin Workflows",
    publicationDate: "2026-03-10",
    abstractText: "This is the abstract.",
    pdfAnnotationNotesText: "Annotated section one.\nAnnotated section two.",
    researchBackground: "Background content.",
    literatureReview: "Review content.",
    researchMethods: "Method content.",
    researchConclusions: "Conclusion content.",
    keyFindings: ["Finding A", "Finding B"],
    classificationTags: ["tag-a", "tag-b"],
    sourceRecordIDs: [12, 99],
    sourceZoteroItemIDs: [345, 678],
    aiProvider: "openai",
    aiModel: "gpt-5",
    rawAIResponse: '{"ok":true,"score":1}',
    folderID: 7,
    folderName: "未分类",
    folderIDs: [7],
    folderNames: ["未分类", "实验组"],
    createdAt: "2026-03-12T10:30:00.000Z",
    updatedAt: "2026-03-13T11:45:00.000Z",
    ...overrides,
  };
}

describe("reviewNote", function () {
  it("builds markdown with metadata, sections, and source tracking", function () {
    const markdown = buildReviewRecordMarkdown(makeRow(), {
      generatedAt: "2026-03-15T08:00:00.000Z",
    });

    assert.include(
      markdown,
      "# Exitem 提炼笔记：Structured extraction for note persistence",
    );
    assert.include(markdown, "## 文献信息");
    assert.include(markdown, "- 文件夹: 未分类、实验组");
    assert.include(markdown, "## 关键发现");
    assert.include(markdown, "1. Finding A");
    assert.isBelow(
      markdown.indexOf("## 关键发现"),
      markdown.indexOf("## PDF 批注与笔记"),
    );
    assert.isBelow(
      markdown.indexOf("## PDF 批注与笔记"),
      markdown.indexOf("## 标签"),
    );
    assert.include(markdown, "## 来源追踪");
    assert.include(markdown, "- 来源 Zotero 条目 ID: 345, 678");
    assert.notInclude(markdown, "## 原始响应");
    assert.notInclude(markdown, '"score": 1');
  });

  it("renders markdown into note-friendly html", function () {
    const html = renderMarkdownToHTML(
      [
        "# Heading",
        "",
        "## Section",
        "- item one",
        "- item two",
        "",
        "1. first",
        "2. second",
        "",
        "paragraph line 1",
        "  # not a heading inside content",
        "",
        "```json",
        '{"value":1}',
        "```",
      ].join("\n"),
    );

    assert.include(html, "<h1>Heading</h1>");
    assert.include(html, "<h2>Section</h2>");
    assert.include(html, "<ul><li>item one</li><li>item two</li></ul>");
    assert.include(html, "<ol><li>first</li><li>second</li></ol>");
    assert.include(
      html,
      "<p>paragraph line 1<br/># not a heading inside content</p>",
    );
    assert.include(
      html,
      '<pre><code data-language="json">{&quot;value&quot;:1}</code></pre>',
    );
  });
});
