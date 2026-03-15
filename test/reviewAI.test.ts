import { assert } from "chai";
import {
  mergePDFEmbeddingContext,
  pickPDFPromptMode,
} from "../src/modules/reviewAI";

describe("reviewAI", function () {
  it("uses fulltext mode for short pdf text", function () {
    assert.equal(pickPDFPromptMode("short pdf content"), "fulltext");
    assert.equal(pickPDFPromptMode("x".repeat(30000)), "fulltext");
  });

  it("uses embedding mode for long pdf text", function () {
    assert.equal(pickPDFPromptMode("x".repeat(30001)), "embedding");
  });

  it("uses none mode when pdf text is empty", function () {
    assert.equal(pickPDFPromptMode(""), "none");
    assert.equal(pickPDFPromptMode("   "), "none");
  });

  it("keeps source content unchanged when long-pdf embedding returns no context", function () {
    const sourceContent = "标题: Test\n摘要: Sample";
    assert.equal(mergePDFEmbeddingContext(sourceContent, ""), sourceContent);
    assert.equal(
      mergePDFEmbeddingContext(sourceContent, "   \n  "),
      sourceContent,
    );
  });
});
