"""Small local HTTP bridge for LightOnOCR-2 and Google Cloud Vision.

The local model is loaded lazily on the first LightOn OCR request and then kept
in memory. Only localhost browser clients are accepted. Google OCR requests are
sent to Cloud Vision with local Application Default Credentials.
"""

from __future__ import annotations

import base64
import io
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps

HOST = os.environ.get("LIGHTON_OCR_HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", os.environ.get("LIGHTON_OCR_PORT", "8765")))
MODEL_ID = os.environ.get("LIGHTON_OCR_MODEL", "lightonai/LightOnOCR-2-1B")
CLOUD_BENCHMARK_MODE = os.environ.get("LIGHTON_CLOUD_BENCHMARK", "").lower() in {"1", "true", "yes"}
PROJECT_ROOT = Path(__file__).resolve().parent.parent
MV82_TEMPLATE = PROJECT_ROOT / "mv82-4.pdf"
AUTOMATION_CONFIG = PROJECT_ROOT / "mv82-4-automation-fields.json"
OCR_OUTPUT_DIR = PROJECT_ROOT / "ocr-output"
GOOGLE_VISION_ENDPOINT = "https://vision.googleapis.com/v1/images:annotate"
GOOGLE_CLOUD_PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT", "")
GEMINI_LOCATION = os.environ.get("GEMINI_LOCATION", "global")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

with AUTOMATION_CONFIG.open(encoding="utf-8") as config_stream:
    _automation_config = json.load(config_stream)
ALLOWED_PDF_HANDLERS = {
    handler
    for field in _automation_config["fields"]
    for handler in field["pdfHandlers"]
}
ORGANIZER_FIELDS = [str(field["key"]) for field in _automation_config["fields"]]
ORGANIZER_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        key: {
            "type": "STRING",
            "description": next(
                str(field.get("label", key))
                for field in _automation_config["fields"]
                if field["key"] == key
            ),
        }
        for key in ORGANIZER_FIELDS
    },
    "required": ORGANIZER_FIELDS,
}

_model: Any = None
_processor: Any = None
_torch: Any = None
_device = "not-loaded"
_inference_lock = threading.Lock()
_google_auth_lock = threading.Lock()
_google_credentials: Any = None
_google_quota_project = ""


class OCRTextParser(HTMLParser):
    """Convert generated HTML to readable text without losing surrounding text."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.lines: list[str] = []
        self._in_table = False
        self._row: list[str] | None = None
        self._cell: list[str] | None = None

    def _append_plain_text(self, data: str) -> None:
        for line in data.splitlines():
            value = " ".join(line.split())
            if value:
                self.lines.append(value)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "table":
            self._in_table = True
        elif tag == "tr":
            self._row = []
        elif tag in {"td", "th"} and self._row is not None:
            self._cell = []

    def handle_data(self, data: str) -> None:
        if self._cell is not None:
            self._cell.append(data)
        elif not self._in_table:
            self._append_plain_text(data)

    def handle_endtag(self, tag: str) -> None:
        if tag in {"td", "th"} and self._cell is not None and self._row is not None:
            value = " ".join("".join(self._cell).split())
            self._row.append(value)
            self._cell = None
        elif tag == "tr" and self._row is not None:
            while self._row and not self._row[-1]:
                self._row.pop()
            if any(self._row):
                self.lines.append(" | ".join(self._row))
            self._row = None
        elif tag == "table":
            self._in_table = False


def normalize_output(raw_text: str) -> str:
    """Keep plain OCR text and flatten generated HTML tables for the UI."""
    if "<table" not in raw_text.lower():
        return raw_text.strip()
    parser = OCRTextParser()
    parser.feed(raw_text)
    return "\n".join(parser.lines).strip() or raw_text.strip()


def load_model() -> None:
    global _model, _processor, _torch, _device
    if _model is not None:
        return

    import torch
    from transformers import LightOnOcrForConditionalGeneration, LightOnOcrProcessor

    if torch.cuda.is_available():
        _device = "cuda"
        dtype = torch.bfloat16
    elif torch.backends.mps.is_available():
        _device = "mps"
        dtype = torch.float32
    else:
        _device = "cpu"
        dtype = torch.bfloat16

    print(f"Loading {MODEL_ID} on {_device}. The first download can take several minutes.", flush=True)
    _processor = LightOnOcrProcessor.from_pretrained(MODEL_ID)
    _model = LightOnOcrForConditionalGeneration.from_pretrained(
        MODEL_ID,
        torch_dtype=dtype,
        low_cpu_mem_usage=True,
    ).to(_device)
    _model.eval()
    _torch = torch
    print(f"{MODEL_ID} is ready on {_device}.", flush=True)


def prepare_crop(data_url: str) -> Image.Image:
    encoded = data_url.split(",", 1)[1] if "," in data_url else data_url
    image = Image.open(io.BytesIO(base64.b64decode(encoded))).convert("RGB")

    # Keep the natural pixels and aspect ratio. Small user-selected regions are
    # enlarged gently so character strokes occupy enough vision-model patches.
    longest = max(image.size)
    if longest < 1200:
        scale = min(4.0, 1200 / max(1, longest))
        image = image.resize(
            (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
            Image.Resampling.LANCZOS,
        )
    border = max(12, round(min(image.size) * 0.04))
    return ImageOps.expand(image, border=border, fill="white")


def recognize(data_url: str) -> dict[str, Any]:
    # Multiple browser requests may arrive together. This lock prevents several
    # copies of the model from generating concurrently on limited local VRAM.
    with _inference_lock:
        return recognize_locked(data_url)


def recognize_locked(data_url: str) -> dict[str, Any]:
    load_model()
    image = prepare_crop(data_url)
    conversation = [{"role": "user", "content": [{"type": "image", "image": image}]}]
    inputs = _processor.apply_chat_template(
        conversation,
        add_generation_prompt=True,
        tokenize=True,
        return_dict=True,
        return_tensors="pt",
    )
    inputs = {
        key: value.to(device=_device, dtype=_model.dtype) if value.is_floating_point() else value.to(_device)
        for key, value in inputs.items()
    }
    started = time.perf_counter()
    with _torch.inference_mode():
        output_ids = _model.generate(**inputs, max_new_tokens=512, do_sample=False)
    generated = output_ids[0, inputs["input_ids"].shape[1] :]
    raw_text = _processor.decode(generated, skip_special_tokens=True).strip()
    text = normalize_output(raw_text)
    return {
        "text": text,
        "rawText": raw_text,
        "model": MODEL_ID,
        "device": _device,
        "durationMs": round((time.perf_counter() - started) * 1000),
    }


def google_access_token() -> tuple[str, str]:
    """Return a refreshed ADC token and its billing/quota project."""
    global _google_credentials, _google_quota_project

    with _google_auth_lock:
        if _google_credentials is None:
            import google.auth

            _google_credentials, detected_project = google.auth.default(
                scopes=["https://www.googleapis.com/auth/cloud-platform"]
            )
            _google_quota_project = (
                GOOGLE_CLOUD_PROJECT
                or getattr(_google_credentials, "quota_project_id", "")
                or detected_project
                or ""
            )
        if not _google_credentials.valid:
            from google.auth.transport.requests import Request as GoogleAuthRequest

            _google_credentials.refresh(GoogleAuthRequest())
        if not _google_credentials.token:
            raise RuntimeError("Google Application Default Credentials did not provide an access token")
        return str(_google_credentials.token), _google_quota_project


def recognize_google(data_url: str) -> dict[str, Any]:
    """Send the browser's exact PNG crop to synchronous Cloud Vision OCR."""
    encoded = data_url.split(",", 1)[1] if "," in data_url else data_url
    if not encoded:
        raise ValueError("Google OCR image is empty")
    # Cloud Vision limits the complete JSON request to 10 MB. Keep room for the
    # request wrapper and headers instead of letting an oversized crop fail deep
    # inside the API call.
    if len(encoded) > 9_500_000:
        raise ValueError("Google OCR crop is too large; select a smaller region")

    token, quota_project = google_access_token()
    request_body = json.dumps({
        "requests": [{
            "image": {"content": encoded},
            "features": [{"type": "DOCUMENT_TEXT_DETECTION"}],
        }]
    }).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json; charset=utf-8",
    }
    if quota_project:
        headers["x-goog-user-project"] = quota_project

    started = time.perf_counter()
    request = urllib.request.Request(
        GOOGLE_VISION_ENDPOINT,
        data=request_body,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            api_payload = json.loads(response.read())
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Google Vision request failed ({error.code}): {detail[:1_000]}") from error

    if api_payload.get("error"):
        raise RuntimeError(str(api_payload["error"].get("message") or api_payload["error"]))
    responses = api_payload.get("responses") or []
    result = responses[0] if responses else {}
    if result.get("error"):
        raise RuntimeError(str(result["error"].get("message") or result["error"]))
    raw_text = str(result.get("fullTextAnnotation", {}).get("text", "")).strip()
    return {
        "text": raw_text,
        "rawText": raw_text,
        "model": "google-cloud-vision/DOCUMENT_TEXT_DETECTION",
        "device": "cloud",
        "durationMs": round((time.perf_counter() - started) * 1000),
    }


def organize_with_gemini(payload: Any) -> dict[str, Any]:
    """Convert one document's OCR text into the complete MV-82 field schema."""
    if not isinstance(payload, dict):
        raise ValueError("Organizer request must be an object")
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("Organizer request must include OCR text")
    if len(text) > 200_000:
        raise ValueError("OCR text is too large to organize")
    if not GOOGLE_CLOUD_PROJECT:
        raise RuntimeError("GOOGLE_CLOUD_PROJECT is not configured")

    token, quota_project = google_access_token()
    endpoint = (
        "https://aiplatform.googleapis.com/v1/projects/"
        f"{GOOGLE_CLOUD_PROJECT}/locations/{GEMINI_LOCATION}/publishers/google/models/"
        f"{GEMINI_MODEL}:generateContent"
    )
    prompt = (
        "Extract values for a New York DMV MV-82 filing from the OCR text below. "
        "Use only facts explicitly present in the text. Never guess or infer missing facts. "
        "Return an empty string for every field that is absent or uncertain. "
        "Keep VINs and ID numbers exact, without adding characters. Use YYYY-MM-DD for dob. "
        "For fullName, preserve the person's or business's natural name order. "
        "printedName should equal fullName when a name is present.\n\n"
        "NY REGISTRATION LAYOUT RULES:\n"
        "- A compact row like 'SUBN BK 5TDKDRBH0PS527032' means bodyType=SUBN, "
        "color=BK, and vin=5TDKDRBH0PS527032.\n"
        "- The next row can contain weight/seats, fuel/cylinders, and vehicle document codes. "
        "For example, '000007 G 4 JM028525 ...' means seating=7, fuelType=G, and "
        "cylinders=4. JM028525 is a vehicle document/control code, not a driver license.\n"
        "- NY color codes such as BK and fuel codes such as G are valid values; preserve them.\n"
        "- Set nysId only from an explicitly labelled customer driver-license/ID value or a "
        "nine-digit DMV client ID in customer identity context. Never use an alphanumeric "
        "registration document/control code for nysId.\n"
        "- A standalone alphanumeric value immediately before the year/make line is commonly "
        "the plate number.\n\n"
        "OCR TEXT:\n"
        f"{text.strip()}"
    )
    request_body = json.dumps({
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0,
            "responseMimeType": "application/json",
            "responseSchema": ORGANIZER_SCHEMA,
        },
    }).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json; charset=utf-8",
    }
    if quota_project:
        headers["x-goog-user-project"] = quota_project
    request = urllib.request.Request(endpoint, data=request_body, headers=headers, method="POST")
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            api_payload = json.loads(response.read())
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Gemini organizer request failed ({error.code}): {detail[:1_000]}") from error

    candidates = api_payload.get("candidates") or []
    parts = ((candidates[0].get("content") or {}).get("parts") or []) if candidates else []
    response_text = next((part.get("text") for part in parts if isinstance(part.get("text"), str)), "")
    if not response_text:
        raise RuntimeError("Gemini organizer returned no structured result")
    fields = json.loads(response_text)
    if not isinstance(fields, dict):
        raise RuntimeError("Gemini organizer returned an invalid result")
    return {
        "fields": {key: str(fields.get(key, "")).strip()[:2_000] for key in ORGANIZER_FIELDS},
        "model": GEMINI_MODEL,
        "durationMs": round((time.perf_counter() - started) * 1000),
    }


def fill_mv82(requested_values: Any) -> dict[str, Any]:
    from pypdf import PdfReader, PdfWriter

    if not isinstance(requested_values, dict):
        raise ValueError("fields must be an object")
    values: dict[str, str] = {}
    for handler, value in requested_values.items():
        if handler not in ALLOWED_PDF_HANDLERS:
            raise ValueError(f"Field is not approved for automatic filling: {handler}")
        if value is None:
            continue
        text = str(value).strip()
        if text:
            values[handler] = text[:500]

    reader = PdfReader(MV82_TEMPLATE)
    canonical = reader.get_fields() or {}
    missing = sorted(set(values) - set(canonical))
    if missing:
        raise ValueError(f"MV-82 fields not found: {missing}")

    writer = PdfWriter()
    writer.clone_document_from_reader(reader)
    writer.update_page_form_field_values(None, values, auto_regenerate=False)
    output = io.BytesIO()
    writer.write(output)
    pdf_bytes = output.getvalue()

    reopened = PdfReader(io.BytesIO(pdf_bytes))
    written_fields = reopened.get_fields() or {}
    mismatches = {
        handler: {"expected": expected, "actual": str(written_fields.get(handler, {}).get("/V", ""))}
        for handler, expected in values.items()
        if str(written_fields.get(handler, {}).get("/V", "")) != expected
    }
    if mismatches:
        raise ValueError(f"Generated PDF field validation failed: {mismatches}")

    return {
        "pdf": base64.b64encode(pdf_bytes).decode("ascii"),
        "filename": "MV-82-filled.pdf",
        "filledFieldCount": len(values),
    }


def save_extraction(payload: Any) -> dict[str, Any]:
    """Save a local, image-free snapshot for comparing OCR and organization."""
    if not isinstance(payload, dict):
        raise ValueError("Extraction snapshot must be an object")
    documents = payload.get("documents")
    organizer = payload.get("organizer")
    engine = str(payload.get("engine", "")).lower()
    if engine not in {"lighton", "google"}:
        raise ValueError("Extraction snapshot requires engine lighton or google")
    if not isinstance(documents, list) or not isinstance(organizer, dict):
        raise ValueError("Extraction snapshot requires documents and organizer")

    safe_documents: list[dict[str, Any]] = []
    for index, document in enumerate(documents[:20], start=1):
        if not isinstance(document, dict):
            continue
        safe_documents.append({
            "number": index,
            "name": str(document.get("name", ""))[:255],
            "state": str(document.get("state", ""))[:30],
            "regionCount": int(document.get("regionCount", 0)),
            "durationMs": int(document.get("durationMs", 0)),
            "normalizedText": str(document.get("normalizedText", ""))[:200_000],
            "rawModelResponse": str(document.get("rawModelResponse", ""))[:300_000],
        })

    snapshot = {
        "savedAt": datetime.now(timezone.utc).isoformat(),
        "engine": engine,
        "note": "Local audit file. Uploaded images are not stored here.",
        "documents": safe_documents,
        "organizerFields": {str(key)[:100]: str(value)[:2_000] for key, value in organizer.items()},
    }
    OCR_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    json_path = OCR_OUTPUT_DIR / f"latest-{engine}-extraction.json"
    json_temp = OCR_OUTPUT_DIR / f".latest-{engine}-extraction.json.tmp"
    json_temp.write_text(json.dumps(snapshot, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    json_temp.replace(json_path)

    text_sections = [f"OCR extraction saved {snapshot['savedAt']}", f"Engine: {engine}"]
    for document in safe_documents:
        text_sections.extend([
            "",
            f"===== DOCUMENT {document['number']}: {document['name'] or '(name unavailable)'} =====",
            f"Duration: {document['durationMs']} ms",
            "",
            "----- NORMALIZED OCR -----",
            str(document["normalizedText"]),
            "",
            "----- RAW OCR -----",
            str(document["rawModelResponse"]),
        ])
    text_sections.extend(["", "===== ORGANIZER FIELDS ====="])
    text_sections.extend(f"{key}: {value}" for key, value in snapshot["organizerFields"].items())
    text_path = OCR_OUTPUT_DIR / f"latest-{engine}-extracted-text.txt"
    text_temp = OCR_OUTPUT_DIR / f".latest-{engine}-extracted-text.txt.tmp"
    text_temp.write_text("\n".join(text_sections).rstrip() + "\n", encoding="utf-8")
    text_temp.replace(text_path)

    return {
        "saved": True,
        "jsonPath": str(json_path.relative_to(PROJECT_ROOT)),
        "textPath": str(text_path.relative_to(PROJECT_ROOT)),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "LightOnOCRLocal/1.0"

    def _send(self, status: int, payload: dict[str, Any]) -> None:
        # HTTP 204 responses must not contain a message body. Cloud Run's
        # frontend rejects a 204 with body bytes as a protocol error, which
        # prevents browser CORS preflights from seeing these headers.
        body = b"" if status == 204 else json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        origin = self.headers.get("Origin", "")
        if origin.startswith("http://localhost:") or origin.startswith("http://127.0.0.1:"):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._send(204, {})

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._send(200, {"ok": True, "loaded": _model is not None, "model": MODEL_ID, "device": _device})
        else:
            self._send(404, {"error": "Not found"})

    def do_POST(self) -> None:  # noqa: N802
        allowed_paths = {"/ocr", "/organize", "/fill-mv82", "/save-extraction"} if CLOUD_BENCHMARK_MODE else {
            "/ocr", "/ocr-google", "/organize", "/fill-mv82", "/save-extraction"
        }
        if self.path not in allowed_paths:
            self._send(404, {"error": "Not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 25 * 1024 * 1024:
                raise ValueError("Request is empty or too large")
            payload = json.loads(self.rfile.read(length))
            if self.path == "/save-extraction":
                if CLOUD_BENCHMARK_MODE:
                    self._send(200, {"saved": False, "persistenceDisabled": True})
                else:
                    self._send(200, save_extraction(payload))
                return
            if self.path == "/fill-mv82":
                self._send(200, fill_mv82(payload.get("fields")))
                return
            if self.path == "/organize":
                self._send(200, organize_with_gemini(payload))
                return
            image = payload.get("image")
            if not isinstance(image, str) or not image:
                raise ValueError("Request must include an image data URL")
            self._send(200, recognize_google(image) if self.path == "/ocr-google" else recognize(image))
        except Exception as error:
            if CLOUD_BENCHMARK_MODE:
                print(f"OCR request failed: {type(error).__name__}", file=sys.stderr, flush=True)
            else:
                print(f"OCR error: {error}", file=sys.stderr, flush=True)
            self._send(500, {"error": str(error)})

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {format % args}", flush=True)


if __name__ == "__main__":
    print(f"LightOnOCR service listening at http://{HOST}:{PORT}", flush=True)
    if CLOUD_BENCHMARK_MODE:
        print("Cloud benchmark mode: Google Vision and extraction persistence are disabled.", flush=True)
    print("The model loads on the first OCR request. Press Ctrl+C to stop.", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
