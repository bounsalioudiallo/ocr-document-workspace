import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("keeps Gemini outside the OCR extraction path", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const extraction = source.slice(
    source.indexOf("const extractDocuments"),
    source.indexOf("const extractAll"),
  );
  const explicitGeminiAction = source.slice(
    source.indexOf("const reorganizeWithGemini"),
    source.indexOf("const updateCaseField"),
  );

  assert.match(extraction, /inferCaseData\(\[text\]\)/);
  assert.doesNotMatch(extraction, /organizeWithGemini|backendEndpoint\("organize"\)/);
  assert.match(explicitGeminiAction, /organizeWithGemini\(document\.text\)/);
});
