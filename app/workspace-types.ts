import { EMPTY_CASE_DATA, PURPOSES, mergeOrganizedDocuments, type CaseData } from "./automation.ts";

export type Box = { x: number; y: number; w: number; h: number };
export type Region = Box & { id: number };
export type OcrEngine = "lighton" | "google";
export type DocumentState = "idle" | "extracting" | "done" | "failed";
export type DocumentSourceKind = "image" | "pdf";

export type DocumentItem = {
  id: number;
  customerId: string;
  sourceId: string;
  sourceBlob: Blob;
  sourceKind: DocumentSourceKind;
  pdfPageNumber: number | null;
  name: string;
  pageLabel: string | null;
  src: string;
  rotation: number;
  regions: Region[];
  text: string;
  rawText: string;
  state: DocumentState;
  organizedData: CaseData | null;
  organizer: "local" | "gemini" | null;
  durationMs: number;
};

export type CustomerItem = {
  id: string;
  sequence: number;
  name: string;
  nameSource: "placeholder" | "ocr" | "manual";
  caseData: CaseData;
  conflictingFields: string[];
  manuallyEditedFields: string[];
  purposeId: string;
  resultEngine: OcrEngine;
};

export type PersistedDocument = Omit<DocumentItem, "src" | "sourceBlob">;

export type WorkspaceSnapshot = {
  version: 1;
  nextCustomerSequence: number;
  customers: CustomerItem[];
  documents: PersistedDocument[];
};

export function createCustomer(sequence: number, id: string): CustomerItem {
  return {
    id,
    sequence,
    name: `Customer ${sequence}`,
    nameSource: "placeholder",
    caseData: { ...EMPTY_CASE_DATA },
    conflictingFields: [],
    manuallyEditedFields: [],
    purposeId: PURPOSES[0].id,
    resultEngine: "lighton",
  };
}

export function uniqueCustomerName(name: string, customers: CustomerItem[], customerId: string) {
  const normalized = name.trim();
  if (!normalized) return "";
  const duplicateCount = customers.filter((customer) => (
    customer.id !== customerId
    && customer.name.replace(/\s+\(\d+\)$/, "").toLocaleUpperCase() === normalized.toLocaleUpperCase()
  )).length;
  return duplicateCount ? `${normalized} (${duplicateCount + 1})` : normalized;
}

export function mergeCustomerDocuments(customer: CustomerItem, documents: DocumentItem[]) {
  return mergeOrganizedDocuments(
    documents.filter((document) => document.customerId === customer.id).map((document) => document.organizedData),
    customer.caseData,
    new Set(customer.manuallyEditedFields),
  );
}
