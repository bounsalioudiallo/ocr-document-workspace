import assert from "node:assert/strict";
import test from "node:test";

import { EMPTY_CASE_DATA, inferCaseData, mergeOrganizedDocuments, reconcileOrganizedData } from "../app/automation.ts";

test("extracts an unlabelled two-line name immediately before the street address", () => {
  const result = inferCaseData([`ID 747 930 754

SOW
IDRISSA
3772 LACONIA AVE 1
BRONX, NY 10469

DOB 10/28/1989`]);

  assert.equal(result.fullName, "SOW, IDRISSA");
  assert.equal(result.printedName, "SOW, IDRISSA");
  assert.equal(result.nysId, "747930754");
  assert.equal(result.street, "3772 LACONIA AVE");
});

test("extracts registration values from normalized LightOn table rows", () => {
  const result = inferCaseData([`T122588C
2024 TOYOT | NONTRANSFERABLE
SUBN GY | 5TDEBRCH2RS607792
000007 G 4 | JL072930 AUG 07 2025
Wt/Seats | Fuel/Cyl | SBA HSBC19 | Expires 08/31/26`]);

  assert.equal(result.bodyType, "SUBN");
  assert.equal(result.color, "GY");
  assert.equal(result.fuelType, "G");
  assert.equal(result.cylinders, "4");
  assert.equal(result.seating, "7");
});

test("does not treat the Cyl label as a fuel type", () => {
  const result = inferCaseData([`Wt/Seats | Fuel/Cyl`]);

  assert.equal(result.fuelType, "");
});

test("corrects Gemini registration gaps and rejects a vehicle control code as NYS ID", () => {
  const text = `T112764C
2023 TOYOT NONTRANSFERABLE
SUBN BK 5TDKDRBH0PS527032
000007 G 4 JM028525 JAN 20 2026
Wt/Seats Fuel/Cyl STH BRK65C`;
  const gemini = {
    ...EMPTY_CASE_DATA,
    nysId: "JM028525",
    color: "",
    fuelType: "",
    cylinders: "",
    seating: "",
  };
  const result = reconcileOrganizedData(gemini, text);

  assert.equal(result.nysId, "");
  assert.equal(result.color, "BK");
  assert.equal(result.fuelType, "G");
  assert.equal(result.cylinders, "4");
  assert.equal(result.seating, "7");
});

test("merges separately organized documents into one filing without overwriting earlier values", () => {
  const first = { ...EMPTY_CASE_DATA, fullName: "FIRST CUSTOMER", vin: "FIRSTVIN123456789" };
  const second = { ...EMPTY_CASE_DATA, fullName: "SECOND CUSTOMER", plate: "ABC1234" };
  const result = mergeOrganizedDocuments([first, second], EMPTY_CASE_DATA, new Set());

  assert.equal(result.merged.fullName, "FIRST CUSTOMER");
  assert.equal(result.merged.plate, "ABC1234");
  assert.equal(result.merged.vin, "FIRSTVIN123456789");
  assert.equal(result.conflicts.has("fullName"), true);
});

test("preserves manually edited filing values when later documents are merged", () => {
  const document = { ...EMPTY_CASE_DATA, fullName: "OCR CUSTOMER" };
  const current = { ...EMPTY_CASE_DATA, fullName: "MANUAL CUSTOMER" };
  const result = mergeOrganizedDocuments([document], current, new Set(["fullName"]));

  assert.equal(result.merged.fullName, "MANUAL CUSTOMER");
  assert.equal(result.conflicts.has("fullName"), false);
});
