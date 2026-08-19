"use client";

/* eslint-disable react-hooks/refs -- pointer handlers intentionally read and write drag refs only after user events */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AUTOMATION_FIELDS, EMPTY_CASE_DATA, PURPOSES, inferCaseData, mergeOrganizedDocuments, pdfDownloadFilename, reconcileOrganizedData, toPdfFields, type CaseData } from "./automation";
import { clearWorkspaceStorage, estimateWorkspaceStorage, loadWorkspace, requestPersistentWorkspaceStorage, saveWorkspace } from "./workspace-storage";
import { createCustomer, mergeCustomerDocuments, uniqueCustomerName, type Box, type CustomerItem, type DocumentItem, type OcrEngine, type Region } from "./workspace-types";

type ResizeCorner = "nw" | "ne" | "sw" | "se";
type RegionDrag = Region & {
  clientX: number;
  clientY: number;
  mode: "move" | "resize";
  corner?: ResizeCorner;
};
// Google Vision remains implemented for future benchmarks, but is intentionally
// hidden from operators while LightOn is the active UI engine.
const SHOW_GOOGLE_OCR_TEST = false;
const backendEndpoint = (path: string) => {
  const localBrowser = typeof window !== "undefined"
    && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  return localBrowser ? `http://127.0.0.1:8765/${path}` : `/api/${path}`;
};
type SelectOption = { value: string; label: string };

const loadHtmlImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = reject;
  image.src = src;
});

const renderDocument = async (document: DocumentItem) => {
  const image = await loadHtmlImage(document.src);
  const radians = document.rotation * Math.PI / 180;
  const width = Math.abs(image.naturalWidth * Math.cos(radians)) + Math.abs(image.naturalHeight * Math.sin(radians));
  const height = Math.abs(image.naturalWidth * Math.sin(radians)) + Math.abs(image.naturalHeight * Math.cos(radians));
  const fit = Math.min(1, 4000 / width, 4000 / height);
  const canvas = window.document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * fit));
  canvas.height = Math.max(1, Math.round(height * fit));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate(radians);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, -image.naturalWidth * fit / 2, -image.naturalHeight * fit / 2, image.naturalWidth * fit, image.naturalHeight * fit);
  return canvas;
};

const cropCanvas = (source: HTMLCanvasElement, box: Box) => {
  const canvas = window.document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(box.w));
  canvas.height = Math.max(1, Math.round(box.h));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  context.drawImage(source, box.x, box.y, box.w, box.h, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
};

const canvasBlob = (canvas: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) => {
  canvas.toBlob((blob) => {
    if (!blob) {
      reject(new Error("Unable to render PDF page"));
      return;
    }
    resolve(blob);
  }, "image/png");
});

const renderPdfPage = async (blob: Blob, pageNumber: number) => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
  const pdf = await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise;
  try {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 3 });
    const canvas = window.document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    await page.render({ canvasContext: context, viewport, canvas }).promise;
    return canvasBlob(canvas);
  } finally {
    await (pdf as unknown as { destroy(): Promise<void> }).destroy();
  }
};

const createCenteredRegion = (width: number, height: number): Region => {
  const w = Math.max(1, width * .6);
  const h = Math.max(1, height * .4);
  return { id: Date.now(), x: (width - w) / 2, y: (height - h) / 2, w, h };
};

function DocumentThumbnail({ document }: { document: DocumentItem }) {
  const thumbnailRef = useRef<HTMLCanvasElement>(null);
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number } | null>(null);
  const region = document.regions[0] || null;

  useEffect(() => {
    let cancelled = false;
    void renderDocument(document).then((rendered) => {
      if (cancelled || !thumbnailRef.current) return;
      const canvas = thumbnailRef.current;
      canvas.width = rendered.width;
      canvas.height = rendered.height;
      canvas.getContext("2d")?.drawImage(rendered, 0, 0);
      setCanvasSize({ width: rendered.width, height: rendered.height });
    });
    return () => { cancelled = true; };
  }, [document.id, document.rotation, document.src]);

  return (
    <span className="document-preview">
      <canvas ref={thumbnailRef} aria-hidden="true" />
      {region && canvasSize && (
        <span
          className="thumbnail-region"
          aria-hidden="true"
          style={{
            left: `${region.x / canvasSize.width * 100}%`,
            top: `${region.y / canvasSize.height * 100}%`,
            width: `${region.w / canvasSize.width * 100}%`,
            height: `${region.h / canvasSize.height * 100}%`,
          }}
        />
      )}
    </span>
  );
}

function PdfPreview({ data }: { data: Uint8Array }) {
  const [pages, setPages] = useState<string[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
        const pdf = await pdfjs.getDocument({ data: data.slice() }).promise;
        const renderedPages: string[] = [];
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
          const page = await pdf.getPage(pageNumber);
          const viewport = page.getViewport({ scale: 1.6 });
          const canvas = window.document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const context = canvas.getContext("2d");
          if (!context) throw new Error("Canvas unavailable");
          await page.render({ canvasContext: context, viewport, canvas }).promise;
          renderedPages.push(canvas.toDataURL("image/png"));
        }
        if (!cancelled) setPages(renderedPages);
      } catch {
        if (!cancelled) setError("The PDF preview could not be rendered. Please use Download instead.");
      }
    })();
    return () => { cancelled = true; };
  }, [data]);

  if (error) return <div className="pdf-preview-error">{error}</div>;
  if (!pages.length) return <div className="pdf-preview-loading">Rendering PDF…</div>;
  return (
    <div className="pdf-preview-pages" aria-label="Filled MV-82 preview">
      {pages.map((page, index) => <img key={index} src={page} alt={`Filled MV-82 page ${index + 1}`} />)}
    </div>
  );
}

function CustomSelect({
  value,
  options,
  onChange,
  ariaLabel,
  className = "",
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selected = options[selectedIndex];

  useEffect(() => {
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => window.document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, []);

  const selectAt = (index: number) => {
    const option = options[index];
    if (option) onChange(option.value);
  };

  return (
    <div ref={rootRef} className={`custom-select ${open ? "open" : ""} ${className}`.trim()}>
      <button
        type="button"
        className="custom-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const direction = event.key === "ArrowDown" ? 1 : -1;
            selectAt((selectedIndex + direction + options.length) % options.length);
            setOpen(true);
          } else if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            selectAt(event.key === "Home" ? 0 : options.length - 1);
            setOpen(true);
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
      >
        <span title={selected?.label}>{selected?.label || "Select"}</span>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
      </button>
      {open && (
        <div className="custom-select-menu" id={listboxId} role="listbox" aria-label={ariaLabel}>
          {options.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={option.value === value ? "selected" : ""}
              key={option.value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <span>{option.label}</span>
              {option.value === value && <span aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const regionDrag = useRef<RegionDrag | null>(null);
  const closeGuard = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileInputCustomerRef = useRef<string | null>(null);
  const objectUrlsRef = useRef<string[]>([]);
  const pdfUrlRef = useRef<string | null>(null);
  const persistenceTimerRef = useRef<number | null>(null);
  const persistenceRequestedRef = useRef(false);
  const [customers, setCustomers] = useState<CustomerItem[]>([]);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [nextCustomerSequence, setNextCustomerSequence] = useState(1);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [baseSize, setBaseSize] = useState<{ width: number; height: number } | null>(null);
  const [sourceCanvasSize, setSourceCanvasSize] = useState<{ width: number; height: number } | null>(null);
  const [extractingEngine, setExtractingEngine] = useState<OcrEngine | null>(null);
  const [extractingCustomerId, setExtractingCustomerId] = useState<string | null>(null);
  const [view, setView] = useState<"files" | "form">("files");
  const [selectedSourceId, setSelectedSourceId] = useState<number | null>(null);
  const [rerunArmedCustomerId, setRerunArmedCustomerId] = useState<string | null>(null);
  const [clearWorkspaceOpen, setClearWorkspaceOpen] = useState(false);
  const [removedDocument, setRemovedDocument] = useState<{ document: DocumentItem; index: number } | null>(null);
  const [reorganizing, setReorganizing] = useState(false);
  const [reorganizeError, setReorganizeError] = useState("");
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [pdfError, setPdfError] = useState("");
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const [previewMode, setPreviewMode] = useState<"source" | "raw" | "pdf">("source");
  const [workspaceHydrated, setWorkspaceHydrated] = useState(false);
  const [storageStatus, setStorageStatus] = useState<"idle" | "saved" | "error">("idle");
  const extracting = extractingEngine !== null;
  const importing = importStatus !== null;
  const activeDocument = documents.find((document) => document.id === activeId) || null;
  const selectedCustomer = customers.find((customer) => customer.id === selectedCustomerId) || null;
  const formDocuments = selectedCustomer ? documents.filter((document) => document.customerId === selectedCustomer.id) : [];
  const caseData = selectedCustomer?.caseData || EMPTY_CASE_DATA;
  const conflictingFields = new Set(selectedCustomer?.conflictingFields || []);
  const purposeId = selectedCustomer?.purposeId || PURPOSES[0].id;
  const selectedSource = formDocuments.find((document) => document.id === selectedSourceId) || formDocuments[0] || null;
  const selectedPurpose = PURPOSES.find((purpose) => purpose.id === purposeId) || PURPOSES[0];
  const combinedOcrText = formDocuments
    .filter((document) => document.text.trim())
    .map((document, index) => `===== DOCUMENT ${index + 1}: ${document.name} =====\n\n${document.text}`)
    .join("\n\n");

  const updateCustomer = useCallback((id: string, updater: (customer: CustomerItem) => CustomerItem) => {
    setCustomers((current) => current.map((customer) => customer.id === id ? updater(customer) : customer));
  }, []);

  const resetPdfPreview = useCallback(() => {
    if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
    pdfUrlRef.current = null;
    setPdfUrl(null);
    setPdfData(null);
    setPdfError("");
    setPreviewMode("source");
  }, []);

  const selectCustomerForForm = (customerId: string) => {
    resetPdfPreview();
    setSelectedCustomerId(customerId);
    setSelectedSourceId(documents.find((document) => document.customerId === customerId)?.id || null);
  };

  const updateDocument = useCallback((id: number, changes: Partial<DocumentItem>) => {
    setDocuments((current) => current.map((document) => document.id === id ? { ...document, ...changes } : document));
  }, []);

  const updateDisplaySize = useCallback(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage || !canvas.width || !canvas.height) return;
    const availableWidth = Math.max(240, stage.clientWidth - 64);
    const availableHeight = Math.max(220, stage.clientHeight - 64);
    const fit = Math.min(1, availableWidth / canvas.width, availableHeight / canvas.height);
    setBaseSize({ width: Math.round(canvas.width * fit), height: Math.round(canvas.height * fit) });
  }, []);

  useEffect(() => {
    if (!activeDocument || !canvasRef.current) return;
    let cancelled = false;
    void renderDocument(activeDocument).then((rendered) => {
      if (cancelled || !canvasRef.current) return;
      const canvas = canvasRef.current;
      canvas.width = rendered.width;
      canvas.height = rendered.height;
      const context = canvas.getContext("2d");
      context?.drawImage(rendered, 0, 0);
      setSourceCanvasSize({ width: rendered.width, height: rendered.height });
      if (!activeDocument.regions.length) {
        const region = createCenteredRegion(rendered.width, rendered.height);
        updateDocument(activeDocument.id, { regions: [region], text: "", rawText: "", state: "idle", organizedData: null, organizer: null, durationMs: 0 });
      } else if (activeDocument.regions.length > 1) {
        updateDocument(activeDocument.id, { regions: [activeDocument.regions[0]], text: "", rawText: "", state: "idle", organizedData: null, organizer: null, durationMs: 0 });
      }
      requestAnimationFrame(updateDisplaySize);
    });
    return () => { cancelled = true; };
  }, [activeDocument?.id, activeDocument?.rotation, activeDocument?.src, updateDisplaySize]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(updateDisplaySize);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [activeId, updateDisplaySize]);

  const addFiles = async (files: FileList | File[], customerId: string) => {
    if (importing || !customers.some((customer) => customer.id === customerId)) return;
    const additions: DocumentItem[] = [];
    const selectedFiles = Array.from(files);
    setImportStatus(`Preparing ${selectedFiles.length} ${selectedFiles.length === 1 ? "file" : "files"}…`);
    try {
      for (let fileIndex = 0; fileIndex < selectedFiles.length; fileIndex += 1) {
        const file = selectedFiles[fileIndex];
        const sourceId = crypto.randomUUID();
        try {
          if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
            setImportStatus(`Reading PDF ${fileIndex + 1} of ${selectedFiles.length}…`);
            const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
            pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
            const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
            for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
              setImportStatus(`Processing PDF page ${pageNumber} of ${pdf.numPages}…`);
              const page = await pdf.getPage(pageNumber);
              const viewport = page.getViewport({ scale: 3 });
              const canvas = window.document.createElement("canvas");
              canvas.width = viewport.width;
              canvas.height = viewport.height;
              const context = canvas.getContext("2d");
              if (!context) throw new Error("Canvas unavailable");
              await page.render({ canvasContext: context, viewport, canvas }).promise;
              const pageBlob = await canvasBlob(canvas);
              const src = URL.createObjectURL(pageBlob);
              objectUrlsRef.current.push(src);
              additions.push({
                id: Date.now() + additions.length,
                customerId,
                sourceId,
                sourceBlob: file,
                sourceKind: "pdf",
                pdfPageNumber: pageNumber,
                name: `${file.name} — Page ${pageNumber}`,
                pageLabel: `Page ${pageNumber}`,
                src,
                rotation: 0,
                regions: [],
                text: "",
                rawText: "",
                state: "idle",
                organizedData: null,
                organizer: null,
                durationMs: 0,
              });
            }
            await (pdf as unknown as { destroy(): Promise<void> }).destroy();
          } else if (file.type.startsWith("image/")) {
            setImportStatus(`Loading image ${fileIndex + 1} of ${selectedFiles.length}…`);
            const src = URL.createObjectURL(file);
            objectUrlsRef.current.push(src);
            additions.push({ id: Date.now() + additions.length, customerId, sourceId, sourceBlob: file, sourceKind: "image", pdfPageNumber: null, name: file.name, pageLabel: null, src, rotation: 0, regions: [], text: "", rawText: "", state: "idle", organizedData: null, organizer: null, durationMs: 0 });
          } else {
            continue;
          }
        } catch {
          // A failed file is skipped so the remaining multi-file upload continues.
        }
      }
      if (additions.length) {
        setDocuments((current) => [...current, ...additions]);
        setView("files");
      }
    } finally {
      setImportStatus(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const addCustomer = () => {
    const id = crypto.randomUUID();
    const customer = createCustomer(nextCustomerSequence, id);
    setCustomers((current) => [...current, customer]);
    setNextCustomerSequence((current) => current + 1);
    setSelectedCustomerId(id);
    setView("files");
    requestAnimationFrame(() => window.document.getElementById(`customer-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const chooseFilesForCustomer = (customerId: string) => {
    fileInputCustomerRef.current = customerId;
    fileInputRef.current?.click();
  };

  const openDocument = (id: number) => {
    if (extracting || closeGuard.current) return;
    setActiveId(id);
    setZoom(1);
    setSourceCanvasSize(null);
  };

  const closeDocument = () => {
    closeGuard.current = true;
    window.setTimeout(() => { closeGuard.current = false; }, 350);
    setActiveId(null);
    setZoom(1);
    setSourceCanvasSize(null);
  };

  const rotate = (amount: number) => {
    if (!activeDocument) return;
    updateDocument(activeDocument.id, { rotation: activeDocument.rotation + amount, regions: [], text: "", rawText: "", state: "idle", organizedData: null, organizer: null, durationMs: 0 });
    setZoom(1);
  };

  const boxStyle = (box: Box) => {
    if (!sourceCanvasSize) return {};
    return { left: `${box.x / sourceCanvasSize.width * 100}%`, top: `${box.y / sourceCanvasSize.height * 100}%`, width: `${box.w / sourceCanvasSize.width * 100}%`, height: `${box.h / sourceCanvasSize.height * 100}%` };
  };

  const onRegionPointerDown = (event: React.PointerEvent<HTMLDivElement>, region: Region) => {
    if (!activeDocument || extracting) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    regionDrag.current = { ...region, clientX: event.clientX, clientY: event.clientY, mode: "move" };
  };

  const onResizePointerDown = (event: React.PointerEvent<HTMLButtonElement>, region: Region, corner: ResizeCorner) => {
    if (!activeDocument || extracting) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    regionDrag.current = { ...region, clientX: event.clientX, clientY: event.clientY, mode: "resize", corner };
  };

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const drag = regionDrag.current;
      const canvas = canvasRef.current;
      if (!drag || !canvas || activeId === null || extracting) return;
      const bounds = canvas.getBoundingClientRect();
      const dx = (event.clientX - drag.clientX) / bounds.width * canvas.width;
      const dy = (event.clientY - drag.clientY) / bounds.height * canvas.height;
      let next: Box;
      if (drag.mode === "move") {
        next = {
          x: Math.max(0, Math.min(canvas.width - drag.w, drag.x + dx)),
          y: Math.max(0, Math.min(canvas.height - drag.h, drag.y + dy)),
          w: drag.w,
          h: drag.h,
        };
      } else {
        const minWidth = Math.min(120, canvas.width * .08);
        const minHeight = Math.min(80, canvas.height * .08);
        let left = drag.x;
        let top = drag.y;
        let right = drag.x + drag.w;
        let bottom = drag.y + drag.h;
        if (drag.corner?.includes("w")) left = Math.max(0, Math.min(right - minWidth, drag.x + dx));
        if (drag.corner?.includes("e")) right = Math.min(canvas.width, Math.max(left + minWidth, drag.x + drag.w + dx));
        if (drag.corner?.includes("n")) top = Math.max(0, Math.min(bottom - minHeight, drag.y + dy));
        if (drag.corner?.includes("s")) bottom = Math.min(canvas.height, Math.max(top + minHeight, drag.y + drag.h + dy));
        next = { x: left, y: top, w: right - left, h: bottom - top };
      }
      setDocuments((current) => current.map((document) => document.id === activeId ? {
        ...document,
        regions: [{ id: drag.id, ...next }],
        text: "",
        rawText: "",
        state: "idle",
        organizedData: null,
        organizer: null,
        durationMs: 0,
      } : document));
    };
    const onPointerEnd = () => { regionDrag.current = null; };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
    };
  }, [activeId, extracting]);

  const readImage = async (image: string, engine: OcrEngine) => {
    const response = await fetch(backendEndpoint(engine === "google" ? "ocr-google" : "ocr"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image }),
    });
    const result = await response.json() as { text?: string; rawText?: string; durationMs?: number; error?: string };
    if (!response.ok) throw new Error(result.error || `${engine === "google" ? "Google Vision" : "LightOnOCR"} request failed`);
    return {
      text: (result.text || "").trim(),
      rawText: (result.rawText || result.text || "").trim(),
      durationMs: result.durationMs || 0,
    };
  };

  const organizeWithGemini = async (text: string) => {
    const response = await fetch(backendEndpoint("organize"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const result = await response.json() as { fields?: CaseData; error?: string };
    if (!response.ok || !result.fields) throw new Error(result.error || "Gemini organizer request failed");
    return reconcileOrganizedData({ ...EMPTY_CASE_DATA, ...result.fields }, text);
  };

  const extractDocuments = async (customerId: string, documentIds: number[], engine: OcrEngine) => {
    if (!documentIds.length || extracting) return;
    const customer = customers.find((item) => item.id === customerId);
    if (!customer) return;
    const requestedIds = new Set(documentIds);
    const requestedDocuments = documents.filter((document) => document.customerId === customerId && requestedIds.has(document.id));
    if (!requestedDocuments.length) return;
    setExtractingEngine(engine);
    setExtractingCustomerId(customerId);
    setRerunArmedCustomerId(null);
    setView("files");
    setDocuments((current) => current.map((document) => requestedIds.has(document.id) ? { ...document, state: "extracting" } : document));
    const extractionResults = await Promise.all(requestedDocuments.map(async (document) => {
      try {
        const rendered = await renderDocument(document);
        const inputs = document.regions[0]
          ? [cropCanvas(rendered, document.regions[0])]
          : [rendered.toDataURL("image/png")];
        const textParts: string[] = [];
        const rawTextParts: string[] = [];
        let durationMs = 0;
        for (const input of inputs) {
          const result = await readImage(input, engine);
          textParts.push(result.text);
          rawTextParts.push(result.rawText);
          durationMs += result.durationMs;
        }
        const text = textParts.filter(Boolean).join("\n");
        const rawText = rawTextParts.filter(Boolean).join("\n");
        const organizedData = inferCaseData([text]);
        return {
          id: document.id,
          text,
          rawText,
          durationMs,
          organizedData,
          organizer: "local" as const,
          state: "done" as const,
        };
      } catch {
        return { id: document.id, state: "failed" as const };
      }
    }));
    const resultById = new Map(extractionResults.map((result) => [result.id, result]));
    const nextDocuments = documents.map((document) => {
      const result = resultById.get(document.id);
      if (!result) return document;
      if (result.state === "failed") return { ...document, state: "failed" as const };
      return {
        ...document,
        text: result.text,
        rawText: result.rawText,
        durationMs: result.durationMs,
        organizedData: result.organizedData,
        organizer: result.organizer,
        state: "done" as const,
      };
    });
    setDocuments(nextDocuments);
    const customerDocuments = nextDocuments.filter((document) => document.customerId === customerId);
    const filing = mergeCustomerDocuments(customer, nextDocuments);
    const filingData = filing.merged;
    setCustomers((current) => current.map((item) => {
      if (item.id !== customerId) return item;
      const extractedName = filing.conflicts.has("fullName") ? "" : filingData.fullName;
      return {
        ...item,
        name: item.nameSource === "placeholder" && extractedName ? uniqueCustomerName(extractedName, current, item.id) : item.name,
        nameSource: item.nameSource === "placeholder" && extractedName ? "ocr" : item.nameSource,
        caseData: filingData,
        conflictingFields: [...filing.conflicts],
        resultEngine: engine,
      };
    }));
    try {
      await fetch(backendEndpoint("save-extraction"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          engine,
          customerId,
          customerName: customer.name,
          documents: customerDocuments.map((document) => ({
            name: document.name,
            state: document.state,
            regionCount: document.regions.length,
            durationMs: document.durationMs,
            normalizedText: document.text,
            rawModelResponse: document.rawText,
          })),
          organizer: filingData,
        }),
      });
    } catch {
      // Audit saving is helpful for tuning, but must not block the OCR workflow.
    }
    setExtractingEngine(null);
    setExtractingCustomerId(null);
  };

  const extractAll = (customerId: string, engine: OcrEngine) => void extractDocuments(
    customerId,
    documents.filter((document) => document.customerId === customerId).map((document) => document.id),
    engine,
  );
  const extractPending = (customerId: string, engine: OcrEngine) => void extractDocuments(
    customerId,
    documents.filter((document) => document.customerId === customerId && (document.state === "idle" || document.state === "failed")).map((document) => document.id),
    engine,
  );
  const hasExtracted = documents.some((document) => document.state === "done");

  const openForm = () => {
    if (!hasExtracted) return;
    const nextCustomer = selectedCustomer && documents.some((document) => document.customerId === selectedCustomer.id && document.state === "done")
      ? selectedCustomer
      : customers.find((customer) => documents.some((document) => document.customerId === customer.id && document.state === "done"));
    if (!nextCustomer) return;
    const nextDocuments = documents.filter((document) => document.customerId === nextCustomer.id);
    if (selectedCustomerId !== nextCustomer.id) selectCustomerForForm(nextCustomer.id);
    else setSelectedSourceId((current) => current && nextDocuments.some((document) => document.id === current) ? current : nextDocuments[0]?.id || null);
    setRerunArmedCustomerId(null);
    setView("form");
  };

  const reorganizeWithGemini = async () => {
    if (reorganizing || extracting || !selectedCustomer || !formDocuments.some((document) => document.state === "done")) return;
    setReorganizing(true);
    setReorganizeError("");
    try {
      const nextDocuments = await Promise.all(documents.map(async (document) => {
        if (document.customerId !== selectedCustomer.id || !document.text.trim()) return document;
        const organizedData = await organizeWithGemini(document.text);
        return { ...document, organizedData, organizer: "gemini" as const };
      }));
      setDocuments(nextDocuments);
      const filing = mergeOrganizedDocuments(
        nextDocuments.filter((document) => document.customerId === selectedCustomer.id).map((document) => document.organizedData),
        selectedCustomer.caseData,
        new Set(selectedCustomer.manuallyEditedFields),
      );
      updateCustomer(selectedCustomer.id, (customer) => ({ ...customer, caseData: filing.merged, conflictingFields: [...filing.conflicts] }));
    } catch {
      setReorganizeError("Gemini could not reorganize this OCR. Your local organization was kept.");
    } finally {
      setReorganizing(false);
    }
  };

  const updateCaseField = (key: string, value: string) => {
    if (!selectedCustomer) return;
    updateCustomer(selectedCustomer.id, (customer) => {
      const manuallyEditedFields = new Set(customer.manuallyEditedFields);
      manuallyEditedFields.add(key);
      if (key === "fullName") manuallyEditedFields.add("printedName");
      const nextConflicts = new Set(customer.conflictingFields);
      nextConflicts.delete(key);
      if (key === "fullName") nextConflicts.delete("printedName");
      const caseData = {
        ...customer.caseData,
        [key]: value,
        ...(key === "fullName" && (!customer.caseData.printedName || customer.caseData.printedName === customer.caseData.fullName) ? { printedName: value } : {}),
      };
      return {
        ...customer,
        name: key === "fullName" && value.trim() ? uniqueCustomerName(value, customers, customer.id) : customer.name,
        nameSource: key === "fullName" && value.trim() ? "manual" : customer.nameSource,
        caseData,
        conflictingFields: [...nextConflicts],
        manuallyEditedFields: [...manuallyEditedFields],
      };
    });
    if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
    pdfUrlRef.current = null;
    setPdfUrl(null);
    setPdfData(null);
  };

  const updatePurpose = (value: string) => {
    if (selectedCustomer) updateCustomer(selectedCustomer.id, (customer) => ({ ...customer, purposeId: value }));
  };

  const generatePdf = async () => {
    if (generatingPdf) return;
    setGeneratingPdf(true);
    setPdfError("");
    try {
      const response = await fetch(backendEndpoint("fill-mv82"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields: toPdfFields(caseData) }),
      });
      const result = await response.json() as { pdf?: string; error?: string };
      if (!response.ok || !result.pdf) throw new Error(result.error || "Unable to generate MV-82");
      const binary = atob(result.pdf);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      pdfUrlRef.current = url;
      setPdfUrl(url);
      setPdfData(bytes);
      setPreviewMode("pdf");
    } catch (error) {
      setPdfError(error instanceof Error ? error.message : "Unable to generate MV-82");
    } finally {
      setGeneratingPdf(false);
    }
  };

  const requestRerun = (customerId: string) => {
    if (rerunArmedCustomerId !== customerId) {
      setRerunArmedCustomerId(customerId);
      return;
    }
    const customer = customers.find((item) => item.id === customerId);
    if (customer) extractAll(customerId, customer.resultEngine);
  };

  const clearWorkspace = async () => {
    if (extracting) return;
    objectUrlsRef.current.forEach((src) => URL.revokeObjectURL(src));
    objectUrlsRef.current = [];
    if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
    pdfUrlRef.current = null;
    setCustomers([]);
    setDocuments([]);
    setNextCustomerSequence(1);
    setActiveId(null);
    setSelectedCustomerId(null);
    setSelectedSourceId(null);
    setZoom(1);
    setBaseSize(null);
    setView("files");
    setRerunArmedCustomerId(null);
    setClearWorkspaceOpen(false);
    setPdfUrl(null);
    setPdfData(null);
    setPdfError("");
    setReorganizeError("");
    setPreviewMode("source");
    if (fileInputRef.current) fileInputRef.current.value = "";
    await clearWorkspaceStorage();
  };

  useEffect(() => {
    if (!rerunArmedCustomerId) return;
    const timeout = window.setTimeout(() => setRerunArmedCustomerId(null), 4000);
    return () => window.clearTimeout(timeout);
  }, [rerunArmedCustomerId]);

  const removeDocument = (document: DocumentItem) => {
    if (document.state === "extracting") return;
    const index = documents.findIndex((item) => item.id === document.id);
    const nextDocuments = documents.filter((item) => item.id !== document.id);
    setRemovedDocument({ document, index });
    setDocuments(nextDocuments);
    const customer = customers.find((item) => item.id === document.customerId);
    if (customer) {
      const filing = mergeCustomerDocuments(customer, nextDocuments);
      updateCustomer(customer.id, (item) => ({ ...item, caseData: filing.merged, conflictingFields: [...filing.conflicts] }));
    }
    if (selectedSourceId === document.id) setSelectedSourceId(null);
  };

  const undoDocumentRemoval = () => {
    if (!removedDocument) return;
    const nextDocuments = [...documents];
    nextDocuments.splice(Math.min(removedDocument.index, nextDocuments.length), 0, removedDocument.document);
    setDocuments(nextDocuments);
    const customer = customers.find((item) => item.id === removedDocument.document.customerId);
    if (customer) {
      const filing = mergeCustomerDocuments(customer, nextDocuments);
      updateCustomer(customer.id, (item) => ({ ...item, caseData: filing.merged, conflictingFields: [...filing.conflicts] }));
    }
    setRemovedDocument(null);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stored = await loadWorkspace();
        if (!stored || cancelled) return;
        const restoredDocuments: DocumentItem[] = [];
        for (const document of stored.snapshot.documents) {
          const sourceBlob = stored.sources.get(document.sourceId);
          if (!sourceBlob) continue;
          const previewBlob = document.sourceKind === "pdf" && document.pdfPageNumber
            ? await renderPdfPage(sourceBlob, document.pdfPageNumber)
            : sourceBlob;
          const src = URL.createObjectURL(previewBlob);
          objectUrlsRef.current.push(src);
          restoredDocuments.push({
            ...document,
            sourceBlob,
            src,
            state: document.state === "extracting" ? "idle" : document.state,
          });
        }
        if (cancelled) return;
        setCustomers(stored.snapshot.customers);
        setDocuments(restoredDocuments);
        setNextCustomerSequence(stored.snapshot.nextCustomerSequence);
        const firstExtractedCustomer = stored.snapshot.customers.find((customer) => restoredDocuments.some((document) => document.customerId === customer.id && document.state === "done"));
        setSelectedCustomerId(firstExtractedCustomer?.id || stored.snapshot.customers[0]?.id || null);
        setStorageStatus("saved");
      } catch {
        if (!cancelled) setStorageStatus("error");
      } finally {
        if (!cancelled) setWorkspaceHydrated(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!workspaceHydrated) return;
    if (persistenceTimerRef.current) window.clearTimeout(persistenceTimerRef.current);
    persistenceTimerRef.current = window.setTimeout(() => {
      void saveWorkspace(customers, documents, nextCustomerSequence)
        .then(async () => {
          setStorageStatus("saved");
          if (documents.length && !persistenceRequestedRef.current) {
            persistenceRequestedRef.current = true;
            await requestPersistentWorkspaceStorage();
          }
          await estimateWorkspaceStorage();
        })
        .catch(() => setStorageStatus("error"));
    }, 400);
    return () => {
      if (persistenceTimerRef.current) window.clearTimeout(persistenceTimerRef.current);
    };
  }, [customers, documents, nextCustomerSequence, workspaceHydrated]);

  useEffect(() => {
    if (!removedDocument) return;
    const timeout = window.setTimeout(() => setRemovedDocument(null), 6000);
    return () => window.clearTimeout(timeout);
  }, [removedDocument]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && activeId !== null) closeDocument();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => () => {
    objectUrlsRef.current.forEach((src) => URL.revokeObjectURL(src));
    if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
  }, []);

  const purposeKeys = new Set(selectedPurpose.reviewFields);
  const missingFields = AUTOMATION_FIELDS.filter((field) => purposeKeys.has(field.key) && !field.allowBlank && !caseData[field.key]?.trim());
  const visibleFields = AUTOMATION_FIELDS.filter((field) => field.group !== "Change" || purposeId === "change");
  const fieldGroups = [...new Set(visibleFields.map((field) => field.group))];
  const downloadName = pdfDownloadFilename(caseData.fullName);

  return (
    <main className="workspace-app">
      <header className="workspace-bar">
        <strong>OCR Workspace</strong>
        <div className="workspace-actions">
          {view === "files" ? (
            <button className="add-customer" onClick={addCustomer} disabled={extracting || importing}><span aria-hidden="true">+</span>Add customer</button>
          ) : selectedCustomer ? (
            <CustomSelect
              className="customer-picker"
              ariaLabel="Select customer"
              value={selectedCustomer.id}
              options={[
                ...customers.map((customer) => ({ value: customer.id, label: customer.name })),
                { value: "__add_customer__", label: "+ Add customer" },
              ]}
              onChange={(value) => value === "__add_customer__" ? addCustomer() : selectCustomerForForm(value)}
            />
          ) : null}
          <nav className="page-switcher" aria-label="Workspace view">
            <button className={view === "files" ? "active" : ""} onClick={() => setView("files")} aria-current={view === "files" ? "page" : undefined}>Files</button>
            <button className={view === "form" ? "active" : ""} onClick={openForm} disabled={!hasExtracted || importing} aria-current={view === "form" ? "page" : undefined}>Form</button>
          </nav>
          {view === "files" ? (
            <button className="clear-workspace" onClick={() => setClearWorkspaceOpen(true)} disabled={!customers.length || extracting || importing}>Clear workspace</button>
          ) : (
            <button className="gemini-reorganize" onClick={() => void reorganizeWithGemini()} disabled={reorganizing || extracting || !formDocuments.some((document) => document.state === "done")}><span aria-hidden="true">✦</span>{reorganizing ? "Reorganizing…" : "Reorganize with Gemini"}</button>
          )}
          <span className={`storage-status ${storageStatus}`} role="status">{storageStatus === "error" ? "Save failed" : storageStatus === "saved" ? "Saved locally" : "Saving…"}</span>
          <input ref={fileInputRef} type="file" multiple accept="image/*,.pdf,application/pdf" onChange={(event) => {
            const customerId = fileInputCustomerRef.current;
            if (event.target.files && customerId) void addFiles(event.target.files, customerId);
          }} />
        </div>
      </header>

      {view === "files" ? (
        <section className="document-canvas" aria-label="Uploaded documents">
          {!customers.length && <button className="empty-upload" onClick={addCustomer}>Add customer</button>}
          {importStatus && <div className="file-import-overlay" role="status" aria-live="polite"><span className="file-import-spinner" /> <strong>{importStatus}</strong><small>Pages will appear here as soon as processing finishes.</small></div>}
          <div className="customer-sections">
            {customers.map((customer) => {
              const customerDocuments = documents.filter((document) => document.customerId === customer.id);
              const pending = customerDocuments.filter((document) => document.state === "idle" || document.state === "failed");
              const failed = customerDocuments.filter((document) => document.state === "failed");
              const done = customerDocuments.filter((document) => document.state === "done");
              const customerExtracting = extractingCustomerId === customer.id;
              const status = customerExtracting
                ? "Extracting…"
                : customer.conflictingFields.includes("fullName")
                  ? "Name needs review"
                : failed.length
                  ? `${failed.length} failed`
                  : customerDocuments.length && done.length === customerDocuments.length
                    ? "Ready"
                    : pending.length
                      ? `${pending.length} pending`
                      : "No documents";
              return (
                <section className="customer-section" id={`customer-${customer.id}`} key={customer.id} aria-labelledby={`customer-name-${customer.id}`}>
                  <header className="customer-section-header">
                    <div className="customer-heading">
                      <strong id={`customer-name-${customer.id}`}>{customer.name}</strong>
                      <span>{customerDocuments.length} {customerDocuments.length === 1 ? "document" : "documents"}</span>
                      <b className={status === "Ready" ? "ready" : failed.length ? "failed" : ""}>{status}</b>
                    </div>
                    <span className="customer-divider" aria-hidden="true" />
                    <details className="ocr-actions-menu customer-ocr-actions">
                      <summary>OCR actions <span aria-hidden="true">⌄</span></summary>
                      <div>
                        {pending.length > 0 && <button onClick={() => extractPending(customer.id, "lighton")} disabled={extracting || importing}>{customerExtracting ? "Extracting…" : failed.length ? "Retry failed and pending" : `Extract ${pending.length === customerDocuments.length ? "all" : "pending"}`}</button>}
                        {customerDocuments.length > 0 && done.length === customerDocuments.length && <button className={rerunArmedCustomerId === customer.id ? "rerun-confirm" : ""} onClick={() => requestRerun(customer.id)} disabled={extracting || importing}>{rerunArmedCustomerId === customer.id ? "Confirm re-run OCR" : "Re-run OCR"}</button>}
                        {SHOW_GOOGLE_OCR_TEST && customerDocuments.length > 0 && <button className="google" onClick={() => extractAll(customer.id, "google")} disabled={extracting || importing}>Extract Google</button>}
                        {!customerDocuments.length && <span>Add files to enable OCR</span>}
                      </div>
                    </details>
                    <button className="customer-add-files" onClick={() => chooseFilesForCustomer(customer.id)} disabled={extracting || importing}><span aria-hidden="true">+</span>Add files</button>
                  </header>
                  {customerDocuments.length ? (
                    <div className="document-grid">
                      {customerDocuments.map((document, index) => (
                        <article key={document.id} className={`document-tile ${document.state}`}>
                          <span className="document-preview-shell">
                            <button className="document-open" onClick={() => openDocument(document.id)} aria-label={`Open ${customer.name} file ${index + 1}`}>
                              <DocumentThumbnail document={document} />
                            </button>
                            <button className="document-remove" onClick={() => removeDocument(document)} disabled={document.state === "extracting"} aria-label={`Remove ${document.name}`}>×</button>
                            {document.state !== "idle" && <span className="document-state" aria-label={document.state}>{document.state === "done" ? "✓" : document.state === "failed" ? "!" : ""}</span>}
                          </span>
                          {document.pageLabel && <span className="document-page-label">{document.pageLabel}</span>}
                          {document.state === "done" && <span className={`organizer-status ${document.organizer || "local"}`}>{document.organizer === "gemini" ? "Organized by Gemini" : "Organized locally"}</span>}
                          <button className="document-extract" onClick={() => void extractDocuments(customer.id, [document.id], "lighton")} disabled={extracting}>
                            {document.state === "extracting"
                              ? "Extracting…"
                              : document.state === "done"
                                ? `Re-extract ${document.pageLabel ? "page" : "file"}`
                                : document.state === "failed"
                                  ? `Retry ${document.pageLabel ? "page" : "file"}`
                                  : `Extract this ${document.pageLabel ? "page" : "file"}`}
                          </button>
                        </article>
                      ))}
                    </div>
                  ) : <button className="customer-empty-files" onClick={() => chooseFilesForCustomer(customer.id)}><span aria-hidden="true">+</span>Add files for {customer.name}</button>}
                </section>
              );
            })}
          </div>
        </section>
      ) : selectedCustomer && formDocuments.some((document) => document.state === "done") ? (
        <section className="review-workspace">
          <header className="review-toolbar">
            <section className="filing-setup" aria-label="Filing setup">
              <span className="toolbar-eyebrow">Filing setup</span>
              <div className="purpose-selector">
                <strong>Purpose</strong>
                <CustomSelect
                  ariaLabel="Purpose"
                  value={purposeId}
                  options={PURPOSES.map((purpose) => ({ value: purpose.id, label: purpose.label }))}
                  onChange={updatePurpose}
                />
              </div>
              <div className={`review-readiness ${missingFields.length ? "incomplete" : "ready"}`}>
                {missingFields.length ? `${missingFields.length} to review` : "Ready"}
              </div>
              <button className="primary preview-mv82" onClick={() => void generatePdf()} disabled={generatingPdf}>{generatingPdf ? "Generating…" : "Preview MV-82"}</button>
            </section>
            <span className="review-toolbar-divider" aria-hidden="true" />
            <section className="document-view-controls" aria-label="Document view">
              <span className="toolbar-eyebrow">Document view</span>
              <div className="view-tabs">
                <button className={previewMode === "source" ? "active" : ""} onClick={() => setPreviewMode("source")}>Source</button>
                <button className={previewMode === "raw" ? "active" : ""} onClick={() => setPreviewMode("raw")}>OCR Text</button>
                <button className={previewMode === "pdf" ? "active" : ""} onClick={() => setPreviewMode("pdf")} disabled={!pdfData}>MV-82</button>
              </div>
              <CustomSelect
                className="source-picker"
                ariaLabel="Select source document"
                value={String(selectedSource?.id ?? "")}
                options={formDocuments.map((document, index) => ({ value: String(document.id), label: `${index + 1}. ${document.name}` }))}
                onChange={(value) => setSelectedSourceId(Number(value))}
              />
              {pdfUrl
                ? <a className="download-mv82" href={pdfUrl} download={downloadName}>Download</a>
                : <button className="download-mv82" disabled>Download</button>}
            </section>
            {pdfError && <span className="pdf-error">{pdfError}</span>}
          </header>
          <div className="review-sheet">
            <div className="case-fields">
              {fieldGroups.map((group) => (
                <section key={group} className="case-group">
                  <h2>{group}</h2>
                  <div className="case-grid">
                    {visibleFields.filter((field) => field.group === group).map((field) => {
                      const expected = purposeKeys.has(field.key);
                      const missing = expected && !field.allowBlank && !caseData[field.key]?.trim();
                      const conflicting = conflictingFields.has(field.key);
                      return (
                        <label key={field.key} className={`${missing ? "missing" : ""} ${conflicting ? "conflict" : ""}`.trim()}>
                          <span>{field.label}{expected && <i>Required</i>}{conflicting && <i className="conflict-badge">Conflict</i>}</span>
                          <input
                            type={field.inputType || "text"}
                            value={caseData[field.key] || ""}
                            onChange={(event) => updateCaseField(field.key, event.target.value)}
                            autoComplete="off"
                          />
                          {field.fillMode === "manual" && <small>{field.manualReason}</small>}
                        </label>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          </div>
          <aside className="evidence-panel">
            <div className="evidence-content">
              {previewMode === "pdf" && pdfData
                ? <PdfPreview data={pdfData} />
                : previewMode === "raw"
                  ? <pre className="raw-ocr">{combinedOcrText || "No OCR text is available."}</pre>
                  : selectedSource && <img src={selectedSource.src} alt="Selected source document" style={{ transform: `rotate(${selectedSource.rotation}deg)` }} />}
            </div>
          </aside>
        </section>
      ) : (
        <section className="form-empty-state">
          <strong>OCR required for {selectedCustomer?.name || "this customer"}</strong>
          <span>Add and extract at least one document before reviewing the form.</span>
          <button className="primary" onClick={() => {
            setView("files");
            if (selectedCustomer) requestAnimationFrame(() => window.document.getElementById(`customer-${selectedCustomer.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
          }}>Return to files</button>
        </section>
      )}

      {view === "form" && reorganizeError && <div className="gemini-error-toast" role="alert">{reorganizeError}</div>}

      {removedDocument && (
        <div className="undo-toast" role="status">
          <span>{removedDocument.document.name} removed</span>
          <button onClick={undoDocumentRemoval}>Undo</button>
        </div>
      )}

      {clearWorkspaceOpen && (
        <div className="confirm-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setClearWorkspaceOpen(false); }}>
          <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="clear-workspace-title">
            <strong id="clear-workspace-title">Clear this workspace?</strong>
            <p>All {customers.length} {customers.length === 1 ? "customer" : "customers"}, {documents.length} {documents.length === 1 ? "document" : "documents"}, OCR results, and form edits will be removed.</p>
            <div><button onClick={() => setClearWorkspaceOpen(false)}>Cancel</button><button className="destructive" onClick={() => void clearWorkspace()}>Clear workspace</button></div>
          </section>
        </div>
      )}

      {activeDocument && (
        <div className="document-modal" onClick={(event) => { if (event.target === event.currentTarget) window.setTimeout(closeDocument, 0); }}>
          <section className="document-dialog" aria-modal="true" role="dialog" aria-label="Adjust document">
            <header className="document-tools">
              <button onClick={() => rotate(-90)} disabled={extracting}>↺</button>
              <button onClick={() => rotate(90)} disabled={extracting}>↻</button>
              <button onClick={() => setZoom((current) => Math.max(.5, current - .25))}>−</button>
              <span>{Math.round(zoom * 100)}%</span>
              <button onClick={() => setZoom((current) => Math.min(4, current + .25))}>+</button>
              <button onClick={() => setZoom(1)} disabled={zoom === 1}>Fit</button>
              <button
                aria-label="Close"
                onClick={(event) => {
                  event.stopPropagation();
                  closeDocument();
                }}
              >×</button>
            </header>
            <section className="document-stage" ref={stageRef}>
              <div className="document-canvas-wrap">
                <canvas
                  ref={canvasRef}
                  style={baseSize ? { width: baseSize.width * zoom, height: baseSize.height * zoom } : undefined}
                  aria-label="Document editing canvas"
                />
                {activeDocument.regions[0] && (() => {
                  const region = activeDocument.regions[0];
                  return <div
                    className="region-box"
                    style={boxStyle(region)}
                    onPointerDown={(event) => onRegionPointerDown(event, region)}
                    role="group"
                    aria-label="OCR selection area"
                  >
                    <span>OCR area</span>
                    {(["nw", "ne", "sw", "se"] as ResizeCorner[]).map((corner) => (
                      <button
                        key={corner}
                        className={`resize-handle ${corner}`}
                        aria-label={`Resize ${corner}`}
                        onPointerDown={(event) => onResizePointerDown(event, region, corner)}
                      />
                    ))}
                  </div>;
                })()}
              </div>
            </section>
          </section>
        </div>
      )}
    </main>
  );
}
