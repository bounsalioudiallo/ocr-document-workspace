import assert from "node:assert/strict";
import test from "node:test";

import { EMPTY_CASE_DATA } from "../app/automation.ts";
import { createCustomer, mergeCustomerDocuments, uniqueCustomerName } from "../app/workspace-types.ts";

const documentFor = (id, customerId, organizedData) => ({
  id,
  customerId,
  sourceId: `source-${id}`,
  sourceBlob: new Blob(["test"], { type: "image/png" }),
  sourceKind: "image",
  pdfPageNumber: null,
  name: `document-${id}.png`,
  pageLabel: null,
  src: `blob:test-${id}`,
  rotation: 0,
  regions: [],
  text: "",
  rawText: "",
  state: "done",
  organizedData,
  organizer: "local",
  durationMs: 0,
});

test("creates stable numbered customer placeholders", () => {
  const customer = createCustomer(3, "customer-three");

  assert.equal(customer.name, "Customer 3");
  assert.equal(customer.sequence, 3);
  assert.equal(customer.nameSource, "placeholder");
});

test("adds restrained suffixes when OCR produces duplicate customer names", () => {
  const first = { ...createCustomer(1, "first"), name: "JANE LEWIS", nameSource: "ocr" };
  const second = { ...createCustomer(2, "second"), name: "JANE LEWIS (2)", nameSource: "ocr" };

  assert.equal(uniqueCustomerName("JANE LEWIS", [first, second], "third"), "JANE LEWIS (3)");
});

test("merges only documents owned by the selected customer", () => {
  const firstCustomer = createCustomer(1, "first");
  const firstDocument = documentFor(1, "first", { ...EMPTY_CASE_DATA, fullName: "FIRST CUSTOMER", vin: "FIRSTVIN123456789" });
  const otherDocument = documentFor(2, "second", { ...EMPTY_CASE_DATA, fullName: "OTHER CUSTOMER", plate: "WRONG123" });
  const filing = mergeCustomerDocuments(firstCustomer, [firstDocument, otherDocument]);

  assert.equal(filing.merged.fullName, "FIRST CUSTOMER");
  assert.equal(filing.merged.vin, "FIRSTVIN123456789");
  assert.equal(filing.merged.plate, "");
  assert.equal(filing.conflicts.has("fullName"), false);
});
