import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const automation = JSON.parse(readFileSync(new URL("../mv82-4-automation-fields.json", import.meta.url), "utf8"));
const pdfConfig = JSON.parse(readFileSync(new URL("../mv82-4-fields.json", import.meta.url), "utf8"));
const frontendDockerfile = readFileSync(new URL("../Dockerfile.frontend", import.meta.url), "utf8");
const frontendCloudIgnore = readFileSync(new URL("../.gcloudignore.frontend", import.meta.url), "utf8");
const frontendPage = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");

test("every MV-82 editor handler resolves to a positioned PDF widget", () => {
  const canonical = new Map(pdfConfig.fields.map((field) => [field.handler, field]));
  const handlers = automation.fields.flatMap((field) => field.pdfHandlers);
  assert.ok(handlers.length > 0);

  for (const handler of handlers) {
    const field = canonical.get(handler);
    assert.ok(field, `Missing canonical PDF field: ${handler}`);
    assert.equal(field.fillable, true, `PDF field is not fillable: ${handler}`);
    assert.ok(field.widgets.length > 0, `PDF field has no widgets: ${handler}`);
    for (const widget of field.widgets) {
      assert.ok(widget.page === 1 || widget.page === 2, `Unexpected page for ${handler}`);
      assert.ok(Number.isFinite(widget.rectTopLeft.x));
      assert.ok(Number.isFinite(widget.rectTopLeft.y));
      assert.ok(Math.abs(widget.rectTopLeft.width) > 0);
      assert.ok(Math.abs(widget.rectTopLeft.height) > 0);
    }
  }
});

test("the custom editor stays lightweight by rendering one mapped page at a time", () => {
  const mappedHandlers = new Set(automation.fields.flatMap((field) => field.pdfHandlers));
  const widgetCounts = [1, 2].map((page) => pdfConfig.fields
    .filter((field) => mappedHandlers.has(field.handler))
    .flatMap((field) => field.widgets)
    .filter((widget) => widget.page === page).length);

  assert.deepEqual(widgetCounts, [38, 2]);
  assert.ok(Math.max(...widgetCounts) < 50);
});

test("the production frontend image includes the PDF editor source document", () => {
  assert.match(frontendDockerfile, /COPY --from=build \/app\/public \.\/public/);
  assert.doesNotMatch(frontendCloudIgnore, /^mv82-4\.pdf$/m);
});

test("the PDF editor bypasses cached template failures and offers an in-place retry", () => {
  assert.match(frontendPage, /mv82-4\.pdf\?editor=/);
  assert.match(frontendPage, /cache: "no-store"/);
  assert.match(frontendPage, />Retry loading<\/button>/);
  assert.match(frontendPage, /typeof pdf\.destroy === "function"/);
});
