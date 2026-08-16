"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AUTOMATION_FIELDS, EMPTY_CASE_DATA, PURPOSES, inferCaseData, mergeOrganizedDocuments, reconcileOrganizedData, toPdfFields, type CaseData } from "./automation";

type Box = { x: number; y: number; w: number; h: number };
type Region = Box & { id: number };
type ResizeCorner = "nw" | "ne" | "sw" | "se";
type RegionDrag = Region & {
  clientX: number;
  clientY: number;
  mode: "move" | "resize";
  corner?: ResizeCorner;
};
type OcrEngine = "lighton" | "google";
type DocumentState = "idle" | "extracting" | "done" | "failed";
// Google Vision remains implemented for future benchmarks, but is intentionally
// hidden from operators while LightOn is the active UI engine.
const SHOW_GOOGLE_OCR_TEST = false;
const backendEndpoint = (path: string) => {
  const localBrowser = typeof window !== "undefined"
    && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  return localBrowser ? `http://127.0.0.1:8765/${path}` : `/api/${path}`;
};
type DocumentItem = {
  id: number;
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

const canvasObjectUrl = (canvas: HTMLCanvasElement) => new Promise<string>((resolve, reject) => {
  canvas.toBlob((blob) => {
    if (!blob) {
      reject(new Error("Unable to render PDF page"));
      return;
    }
    resolve(URL.createObjectURL(blob));
  }, "image/png");
});

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
    setPages([]);
    setError("");
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
  const closeGuard = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const objectUrlsRef = useRef<string[]>([]);
  const pdfUrlRef = useRef<string | null>(null);
  const manuallyEditedFieldsRef = useRef(new Set<string>());
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [baseSize, setBaseSize] = useState<{ width: number; height: number } | null>(null);
  const [extractingEngine, setExtractingEngine] = useState<OcrEngine | null>(null);
  const [resultEngine, setResultEngine] = useState<OcrEngine>("lighton");
  const [view, setView] = useState<"files" | "form">("files");
  const [selectedSourceId, setSelectedSourceId] = useState<number | null>(null);
  const [rerunArmed, setRerunArmed] = useState(false);
  const [newOcrArmed, setNewOcrArmed] = useState(false);
  const [reorganizing, setReorganizing] = useState(false);
  const [reorganizeError, setReorganizeError] = useState("");
  const [caseData, setCaseData] = useState<CaseData>({ ...EMPTY_CASE_DATA });
  const [conflictingFields, setConflictingFields] = useState<Set<string>>(new Set());
  const [purposeId, setPurposeId] = useState(PURPOSES[0].id);
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [pdfError, setPdfError] = useState("");
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const [previewMode, setPreviewMode] = useState<"source" | "raw" | "pdf">("source");
  const extracting = extractingEngine !== null;
  const importing = importStatus !== null;
  const activeDocument = documents.find((document) => document.id === activeId) || null;
  const selectedSource = documents.find((document) => document.id === selectedSourceId) || documents[0] || null;
  const selectedPurpose = PURPOSES.find((purpose) => purpose.id === purposeId) || PURPOSES[0];
  const combinedOcrText = documents
    .filter((document) => document.text.trim())
    .map((document, index) => `===== DOCUMENT ${index + 1}: ${document.name} =====\n\n${document.text}`)
    .join("\n\n");

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

  const addFiles = async (files: FileList | File[]) => {
    if (importing) return;
    const additions: DocumentItem[] = [];
    const selectedFiles = Array.from(files);
    setImportStatus(`Preparing ${selectedFiles.length} ${selectedFiles.length === 1 ? "file" : "files"}…`);
    try {
      for (let fileIndex = 0; fileIndex < selectedFiles.length; fileIndex += 1) {
        const file = selectedFiles[fileIndex];
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
              const src = await canvasObjectUrl(canvas);
              objectUrlsRef.current.push(src);
              additions.push({
                id: Date.now() + additions.length,
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
            await pdf.destroy();
          } else if (file.type.startsWith("image/")) {
            setImportStatus(`Loading image ${fileIndex + 1} of ${selectedFiles.length}…`);
            const src = URL.createObjectURL(file);
            objectUrlsRef.current.push(src);
            additions.push({ id: Date.now() + additions.length, name: file.name, pageLabel: null, src, rotation: 0, regions: [], text: "", rawText: "", state: "idle", organizedData: null, organizer: null, durationMs: 0 });
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

  const openDocument = (id: number) => {
    if (extracting || Date.now() < closeGuard.current) return;
    setActiveId(id);
    setZoom(1);
  };

  const closeDocument = () => {
    closeGuard.current = Date.now() + 350;
    setActiveId(null);
    setZoom(1);
  };

  const rotate = (amount: number) => {
    if (!activeDocument) return;
    updateDocument(activeDocument.id, { rotation: activeDocument.rotation + amount, regions: [], text: "", rawText: "", state: "idle", organizedData: null, organizer: null, durationMs: 0 });
    setZoom(1);
  };

  const boxStyle = (box: Box) => {
    const canvas = canvasRef.current;
    if (!canvas) return {};
    return { left: `${box.x / canvas.width * 100}%`, top: `${box.y / canvas.height * 100}%`, width: `${box.w / canvas.width * 100}%`, height: `${box.h / canvas.height * 100}%` };
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

  const extractDocuments = async (documentIds: number[], engine: OcrEngine) => {
    if (!documentIds.length || extracting) return;
    const requestedIds = new Set(documentIds);
    const requestedDocuments = documents.filter((document) => requestedIds.has(document.id));
    if (!requestedDocuments.length) return;
    setExtractingEngine(engine);
    setRerunArmed(false);
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
    const filing = mergeOrganizedDocuments(nextDocuments.map((document) => document.organizedData), caseData, manuallyEditedFieldsRef.current);
    const filingData = filing.merged;
    setCaseData(filingData);
    setConflictingFields(filing.conflicts);
    setResultEngine(engine);
    try {
      await fetch(backendEndpoint("save-extraction"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          engine,
          documents: nextDocuments.map((document) => ({
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
  };

  const extractAll = (engine: OcrEngine) => void extractDocuments(documents.map((document) => document.id), engine);
  const extractPending = (engine: OcrEngine) => void extractDocuments(
    documents.filter((document) => document.state === "idle" || document.state === "failed").map((document) => document.id),
    engine,
  );
  const extractNext = () => {
    const next = documents.find((document) => document.state === "idle" || document.state === "failed");
    if (next) void extractDocuments([next.id], "lighton");
  };

  const allExtracted = documents.length > 0 && documents.every((document) => document.state === "done");
  const hasExtracted = documents.some((document) => document.state === "done");
  const hasPending = documents.some((document) => document.state === "idle" || document.state === "failed");

  const openForm = () => {
    if (!hasExtracted) return;
    setSelectedSourceId((current) => current && documents.some((document) => document.id === current) ? current : documents[0].id);
    setRerunArmed(false);
    setView("form");
  };

  const reorganizeWithGemini = async () => {
    if (reorganizing || extracting || !hasExtracted) return;
    setReorganizing(true);
    setReorganizeError("");
    try {
      const nextDocuments = await Promise.all(documents.map(async (document) => {
        if (!document.text.trim()) return document;
        const organizedData = await organizeWithGemini(document.text);
        return { ...document, organizedData, organizer: "gemini" as const };
      }));
      setDocuments(nextDocuments);
      const filing = mergeOrganizedDocuments(
        nextDocuments.map((document) => document.organizedData),
        caseData,
        manuallyEditedFieldsRef.current,
      );
      setCaseData(filing.merged);
      setConflictingFields(filing.conflicts);
    } catch {
      setReorganizeError("Gemini could not reorganize this OCR. Your local organization was kept.");
    } finally {
      setReorganizing(false);
    }
  };

  const updateCaseField = (key: string, value: string) => {
    manuallyEditedFieldsRef.current.add(key);
    if (key === "fullName") manuallyEditedFieldsRef.current.add("printedName");
    setConflictingFields((current) => {
      const next = new Set(current);
      next.delete(key);
      if (key === "fullName") next.delete("printedName");
      return next;
    });
    setCaseData((current) => ({
      ...current,
      [key]: value,
      ...(key === "fullName" && (!current.printedName || current.printedName === current.fullName) ? { printedName: value } : {}),
    }));
    if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
    pdfUrlRef.current = null;
    setPdfUrl(null);
    setPdfData(null);
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

  const requestRerun = () => {
    if (!rerunArmed) {
      setRerunArmed(true);
      return;
    }
    void extractAll(resultEngine);
  };

  const startNewOcr = () => {
    if (extracting) return;
    if (!newOcrArmed) {
      setNewOcrArmed(true);
      return;
    }
    objectUrlsRef.current.forEach((src) => URL.revokeObjectURL(src));
    objectUrlsRef.current = [];
    if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
    pdfUrlRef.current = null;
    manuallyEditedFieldsRef.current.clear();
    setDocuments([]);
    setActiveId(null);
    setSelectedSourceId(null);
    setZoom(1);
    setBaseSize(null);
    setView("files");
    setCaseData({ ...EMPTY_CASE_DATA });
    setConflictingFields(new Set());
    setPurposeId(PURPOSES[0].id);
    setResultEngine("lighton");
    setRerunArmed(false);
    setNewOcrArmed(false);
    setPdfUrl(null);
    setPdfData(null);
    setPdfError("");
    setReorganizeError("");
    setPreviewMode("source");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  useEffect(() => {
    if (!rerunArmed) return;
    const timeout = window.setTimeout(() => setRerunArmed(false), 4000);
    return () => window.clearTimeout(timeout);
  }, [rerunArmed]);

  useEffect(() => {
    if (!newOcrArmed) return;
    const timeout = window.setTimeout(() => setNewOcrArmed(false), 4000);
    return () => window.clearTimeout(timeout);
  }, [newOcrArmed]);

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
  const downloadName = `MV-82-${purposeId}-${caseData.plate || caseData.vin || "filled"}.pdf`;

  return (
    <main className="workspace-app">
      <header className="workspace-bar">
        <strong>OCR Workspace</strong>
        <div className="workspace-actions">
          {view === "files" && <button className="add-files" onClick={() => fileInputRef.current?.click()} disabled={extracting || importing}><span aria-hidden="true">+</span>{importing ? "Adding files…" : "Add files"}</button>}
          <nav className="page-switcher" aria-label="Workspace view">
            <button className={view === "files" ? "active" : ""} onClick={() => setView("files")} aria-current={view === "files" ? "page" : undefined}>Files</button>
            <button className={view === "form" ? "active" : ""} onClick={openForm} disabled={!hasExtracted || importing} aria-current={view === "form" ? "page" : undefined}>Form</button>
          </nav>
          {view === "files" ? (
            <details className="ocr-actions-menu">
              <summary>OCR actions <span aria-hidden="true">⌄</span></summary>
              <div>
                {hasPending && <button onClick={extractNext} disabled={extracting || importing}>{extractingEngine === "lighton" ? "Extracting…" : "Extract next"}</button>}
                {hasPending && documents.length > 1 && <button onClick={() => extractPending("lighton")} disabled={extracting || importing}>Extract all</button>}
                {SHOW_GOOGLE_OCR_TEST && (!allExtracted || resultEngine !== "google") && <button className="google" onClick={() => void extractAll("google")} disabled={!documents.length || extracting}>{extractingEngine === "google" ? "Google…" : "Extract Google"}</button>}
                {allExtracted && <button className={rerunArmed ? "rerun-confirm" : ""} onClick={requestRerun} disabled={importing}>{rerunArmed ? `Confirm ${resultEngine === "google" ? "Google" : "LightOn"}` : `Re-run ${resultEngine === "google" ? "Google" : "LightOn"}`}</button>}
                {documents.length > 0 && <button className={newOcrArmed ? "new-ocr-confirm" : ""} onClick={startNewOcr} disabled={extracting || importing}>{newOcrArmed ? "Confirm New OCR" : "New OCR"}</button>}
                {!documents.length && <span>No OCR actions available</span>}
              </div>
            </details>
          ) : (
            <button className="gemini-reorganize" onClick={() => void reorganizeWithGemini()} disabled={reorganizing || extracting || !hasExtracted}><span aria-hidden="true">✦</span>{reorganizing ? "Reorganizing…" : "Reorganize with Gemini"}</button>
          )}
          <input ref={fileInputRef} type="file" multiple accept="image/*,.pdf,application/pdf" onChange={(event) => event.target.files && void addFiles(event.target.files)} />
        </div>
      </header>

      {view === "files" ? (
        <section className="document-canvas" aria-label="Uploaded documents">
          {!documents.length && <button className="empty-upload" onClick={() => fileInputRef.current?.click()}>Add files</button>}
          {importStatus && <div className="file-import-overlay" role="status" aria-live="polite"><span className="file-import-spinner" /> <strong>{importStatus}</strong><small>Pages will appear here as soon as processing finishes.</small></div>}
          <div className="document-grid">
            {documents.map((document, index) => (
              <article key={document.id} className={`document-tile ${document.state}`}>
                <button className="document-open" onClick={() => openDocument(document.id)} aria-label={`Open uploaded file ${index + 1}`}>
                  <DocumentThumbnail document={document} />
                </button>
                {document.state !== "idle" && <span className="document-state" aria-label={document.state}>{document.state === "done" ? "✓" : document.state === "failed" ? "!" : ""}</span>}
                {document.pageLabel && <span className="document-page-label">{document.pageLabel}</span>}
                {document.state === "done" && <span className={`organizer-status ${document.organizer || "local"}`}>{document.organizer === "gemini" ? "Organized by Gemini" : "Organized locally"}</span>}
                <button
                  className="document-extract"
                  onClick={() => void extractDocuments([document.id], "lighton")}
                  disabled={extracting}
                >
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
        </section>
      ) : (
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
                  onChange={setPurposeId}
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
                options={documents.map((document, index) => ({ value: String(document.id), label: `${index + 1}. ${document.name}` }))}
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
      )}

      {view === "form" && reorganizeError && <div className="gemini-error-toast" role="alert">{reorganizeError}</div>}

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
                  closeGuard.current = Date.now() + 350;
                  setActiveId(null);
                  setZoom(1);
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
