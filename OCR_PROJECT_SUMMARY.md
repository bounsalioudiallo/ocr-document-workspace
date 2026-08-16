# OCR Crop Project Summary

Updated: August 8, 2026

## 1. Problem We Are Solving

The insurance office receives photographs and scanned PDFs of New York driver
licenses, insurance cards, and vehicle registrations. Image quality is often
poor because files are photographed, sent through WhatsApp, and sometimes
printed and scanned again.

The goal is to reduce manual DMV and insurance-form data entry while keeping a
human in control of uncertain values such as driver-license numbers, VINs,
policy numbers, dates, and plate numbers.

## 2. What We Built

The current project is a local browser-based, multi-document OCR workbench with
the following workflow:

1. Upload several JPG, PNG, WEBP, or PDF files at once. PDFs currently render
   the first page. Uploading does not start OCR.
2. Review a clean, image-only canvas without file names or document labels.
3. Click any image to open a modal with rotation and zoom. The first open creates
   one centered OCR rectangle that can be moved and resized from its corners.
   Its saved outline remains visible on the document tile after the modal closes.
4. Close the modal and continue through the remaining images.
5. Click **Extract LightOn** once. Every document is submitted together to
   LightOnOCR; the backend safely serializes model inference locally.
6. Continue to **Form** after all documents finish. The current review screen
   shows editable organized fields beside the selected source image and includes
   a **Raw OCR** view for checking what the engine actually returned.
7. After completion, **Extract LightOn** is replaced by a visually separate
   **Re-run LightOn** action that requires a confirmation click.

### Completed MV-82 workflow

- Office-approved shared fields are defined in
  `mv82-4-automation-fields.json`; the complete 88-field PDF inventory remains
  unchanged in `mv82-4-fields.json`.
- OCR text is normalized into one editable customer/address/vehicle record.
- Customer names are recognized from labelled fields, comma-formatted names,
  and two unlabelled name lines immediately preceding a detected street address.
- Purpose selection changes missing-data guidance without creating six separate
  entry screens.
- PDF buttons, radio controls, disclosures, and signatures remain manual.
- **Preview MV-82** clones `mv82-4.pdf`, fills approved text and choice fields,
  validates the written values, and displays the exact official PDF for review
  and download.

Rectangle coordinates are stored relative to the internal source canvas, not
the enlarged display. Crops therefore come from the source-resolution image
even when the operator has zoomed in.

Closing and reopening a document preserves its single rectangle. OCR receives
that source-pixel crop; a document that has never been opened still uses the
full image. Rotating a document resets the rectangle to a centered default
because the old coordinates no longer match the rotated canvas.

### OCR engines tested during development

#### Tesseract.js

- Runs inside the browser.
- Loads the English LSTM model once and reuses the worker.
- Tries channel-based grayscale, normal grayscale, and Otsu-thresholded crops.
- Selects the nonempty result with the highest Tesseract confidence.
- Works well when a rectangle contains a clean individual line.
- Remains sensitive to license security patterns, uneven backgrounds, broken
  strokes, and bad scans.

#### LightOnOCR-2-1B

- Runs locally through `backend/lighton_server.py` on `127.0.0.1:8765`.
- Uses the open-weight `lightonai/LightOnOCR-2-1B` model.
- Loads lazily on the first LightOnOCR request and remains in memory afterward.
- Receives the raw crop, applies only gentle resizing and white padding, and
  does not use Tesseract's aggressive thresholding.
- Converts LightOnOCR's generated HTML tables into compact, readable rows for
  the result editor while retaining the raw model output in the local response.
- Does not send document pixels to an external OCR API.
- The localhost service accepts browser requests only from localhost origins.

#### Google Cloud Vision `DOCUMENT_TEXT_DETECTION`

- Uses the same browser-rendered documents and exact operator-selected crops as
  LightOnOCR through the local `/ocr-google` endpoint.
- Authenticates on the backend with Google Application Default Credentials;
  credentials are never embedded in browser JavaScript.
- Uses synchronous online Vision requests. According to Google's Vision data
  usage documentation, synchronous image data is processed in memory and is not
  persisted to disk or used to train Cloud Vision. Request metadata may be
  logged temporarily.
- Writes separate image-free audit files containing timing, normalized OCR, raw
  OCR, and the unchanged organizer output.
- The implementation remains in `backend/lighton_server.py`, but operator access
  is currently hidden because `SHOW_GOOGLE_OCR_TEST` in `app/page.tsx` is
  `false`. Set it to `true` only for an approved future benchmark.

Tesseract remains installed for comparison history, but the current streamlined
interface exposes the local LightOnOCR service only. Google code and historical
results have not been deleted.

## 3. Recorded OCR Test Results

### Original LightOnOCR crop test

The difficult 622 × 358 driver-license crop used during development produced:

```text
10 963 366 351

BARRIE

ALPHA, BOUBACAR

158 MAGNOLIA DR # A

MASTIC BEACH, NY 11951
```

The meaningful name and address text was correct. The small `ID` label was read
as `10`. Inference took approximately 61.6 seconds on this 16 GB Apple Silicon
Mac using PyTorch MPS. This proves that the model can read the image, but it is
not fast enough on this particular machine to be the final office deployment
without further optimization or different hardware.

Apple Vision was also tested separately on the same image and returned nearly
perfect text immediately. Apple Vision is not a deployment option for the
office because the office computers use Windows.

### Three-page LightOnOCR versus Google Vision test

On August 8, 2026, the same single target crop from each of the three authorized
sample PDFs was sent through both engines without changing `inferCaseData`.
The saved engine durations were:

| Sample | LightOnOCR | Google Vision | Faster engine |
| --- | ---: | ---: | --- |
| Driver license | 26.639 s | 34.042 s | LightOnOCR |
| Registration | 35.317 s | 55.283 s | LightOnOCR |
| Insurance card | 31.974 s | 15.085 s | Google Vision |
| **Total** | **93.930 s** | **104.410 s** | **LightOnOCR by 10.480 s** |

The connection was mobile data. Google was much faster on the smaller insurance
crop but slower on the larger license and registration crops, indicating that
cloud latency in this workflow is sensitive to crop byte size and upload speed.

For 18 populated organizer fields that could be verified visually against the
three sources, LightOnOCR matched all 18. Google matched 14. Google's four
end-to-end organizer failures were:

- NYS ID missing because raw OCR returned `0963 366 351` instead of
  `ID 963 366 351`.
- Vehicle make organized as `YEAR` instead of the source abbreviation `TOYOT`.
- Body type missing even though raw OCR contained `SUBN`.
- Color missing even though raw OCR contained `GY`.

Both engines correctly organized the plate, customer name, date of birth,
address, apartment, city, state, ZIP code, VIN, model year, fuel code, cylinder
count, and seating. Google returned more complete plain text for parts of the
registration and preserved policy number `C104024`. LightOnOCR preserved the
insurance effective/expiration date relationship correctly; its raw output also
contained the policy number, but the current HTML-table normalizer dropped text
that appeared outside the generated table.

For this small test, LightOnOCR was the better end-to-end choice with the current
organizer. Google remains promising for smaller crops, but the sample is too
small for a production decision. The UI was hidden after evaluation rather than
deleting the Google implementation.

## 4. Project Files Added or Changed

- `app/page.tsx` — crop interface, LightOnOCR workflow, raw OCR review, and the
  disabled `SHOW_GOOGLE_OCR_TEST` comparison flag.
- `app/globals.css` — OCR and review-interface styling.
- `backend/lighton_server.py` — persistent local LightOnOCR service plus the
  retained Google Vision endpoint and engine-specific audit persistence.
- `requirements-lighton.txt` — Python dependencies for LightOnOCR and Google
  Application Default Credentials.
- `README.md` — setup and operation instructions for macOS, Linux, and Windows.
- `.gitignore` — excludes the LightOnOCR virtual environment and Python cache.
- `OCR_PROJECT_SUMMARY.md` — this document.

## 5. What Is Installed on This Mac

### Existing web application

- Node.js project dependencies under `node_modules/`.
- Important packages include React, Next.js/Vinext, PDF.js, and Tesseract.js.
- The development app is normally started with `npm run dev`.

### LightOnOCR runtime installed for this test

- Virtual environment:
  `/Users/saikoudiallo/Documents/OCR/.venv-lighton`
- Current virtual-environment size: approximately **856 MB**.
- Main packages: PyTorch 2.13, Transformers 5.14, Pillow, Safetensors, and their
  dependencies.
- LightOnOCR model cache:
  `/Users/saikoudiallo/.cache/huggingface/hub/models--lightonai--LightOnOCR-2-1B`
- Current model-cache size: approximately **1.9 GB**.
- Model weights themselves are approximately 2.01 GB before filesystem/cache
  reporting differences.

### Google Vision test configuration retained on this Mac

- Google Cloud CLI 579.0.0 is installed through Homebrew.
- Application Default Credentials use project `workbook-a57d1` for quota and
  billing.
- Cloud Vision is enabled and billing is linked for that project.
- `google-auth[requests]` is installed in `.venv-lighton`.
- Latest engine-specific comparisons are stored under `ocr-output/` without
  retaining source images or crop pixels.
- The Google button is hidden from the current operator UI; these installed
  components remain only to support an explicitly approved future test.

At the time this summary was written, the web development server and the local
LightOnOCR service were running. They do not start automatically after a reboot.

## 6. How to Run the Current Prototype

Start the web interface from the project directory:

```bash
npm run dev
```

Start the local LightOnOCR service in a second terminal on this Mac:

```bash
source .venv-lighton/bin/activate
python backend/lighton_server.py
```

Then open `http://localhost:3000`, add one or more files, optionally adjust or
target them, and click **Extract LightOn**.

On Windows, create a new Windows virtual environment; do not copy the macOS
`.venv-lighton` folder:

```powershell
python -m venv .venv-lighton
.venv-lighton\Scripts\Activate.ps1
python -m pip install -r requirements-lighton.txt
python backend\lighton_server.py
```

For an NVIDIA Windows PC, install the PyTorch build appropriate for that PC's
CUDA version before installing the remaining requirements. Otherwise PyTorch
may run on the CPU and be unacceptably slow.

## 7. Cleanup and Uninstall Instructions

Nothing in this section has been removed automatically. These are documented
options for later cleanup.

### Stop the running processes

In each terminal that is running a service, press `Ctrl+C`:

- Terminal running `npm run dev`.
- Terminal running `python backend/lighton_server.py`.

### Remove only the local LightOnOCR Python environment

From the confirmed project directory
`/Users/saikoudiallo/Documents/OCR`, remove only this exact folder:

```bash
rm -rf /Users/saikoudiallo/Documents/OCR/.venv-lighton
```

This recovers approximately 856 MB and does not remove the web application.

Windows PowerShell equivalent, after confirming the current directory is the
OCR project:

```powershell
Remove-Item -Recurse -Force .venv-lighton
```

### Remove only the downloaded LightOnOCR model

Remove only the exact LightOn model-cache directory:

```bash
rm -rf /Users/saikoudiallo/.cache/huggingface/hub/models--lightonai--LightOnOCR-2-1B
```

This recovers approximately 1.9 GB. Do not delete the entire Hugging Face cache
because it may contain unrelated models used by other projects.

On Windows, the corresponding directory is normally under:

```text
%USERPROFILE%\.cache\huggingface\hub\models--lightonai--LightOnOCR-2-1B
```

Verify the path before removing it.

### Remove all web dependencies for a completely clean project checkout

Only if the entire JavaScript development installation should be cleaned:

```bash
rm -rf /Users/saikoudiallo/Documents/OCR/node_modules
```

The dependencies can later be restored with `npm install`. This is unrelated
to removing LightOnOCR alone.

### Remove the LightOnOCR feature from the source code

Removing installed files does not remove the LightOnOCR option from the UI. A
complete source-code rollback would also require:

1. Removing `backend/lighton_server.py`.
2. Removing `requirements-lighton.txt`.
3. Removing the LightOnOCR engine option and `fetch` path from `app/page.tsx`.
4. Removing `.venv-lighton` and `backend/__pycache__` entries from `.gitignore`
   if they are no longer useful.
5. Removing the LightOnOCR sections from `README.md`.

Do not delete the whole project directory just to uninstall the OCR model.

## 8. AI for the Office Workspace

### Recommended objective

Build an operator-assisted document-entry workspace that extracts fields from
driver licenses, registrations, and insurance cards, validates them, and makes
them easy to transfer into DMV and brokerage forms. The system should optimize
for **less review time and fewer incorrect identifiers**, not merely for a high
general OCR score.

### Recommended production workflow

```text
Office file or WhatsApp download
              ↓
Document-type selection or detection
              ↓
Rotation, perspective correction, and template alignment
              ↓
Automatic proposed field rectangles
              ↓
Operator adjusts only incorrect rectangles
              ↓
OCR engine reads original-resolution crops
              ↓
Field-specific validation and cross-document comparison
              ↓
AI organizes values into the office schema
              ↓
Operator reviews flagged fields and approves
              ↓
Export to DMV/insurance form workflow
```

### OCR engine strategy for Windows

The office should benchmark three realistic choices using its own documents:

1. **Azure Vision Image OCR** — likely the simplest consistent option across
   existing Windows PCs if cloud processing of customer documents is approved.
2. **LightOnOCR-2 or RapidOCR on a local NVIDIA workstation** — keeps document
   pixels inside the office and lets several office PCs use one internal OCR
   service. LightOnOCR quality is promising, but latency must be tested on the
   target NVIDIA hardware.
3. **New Windows AI Text Recognition** — promising on supported Copilot+ PCs,
   but it should not be the only engine until every deployed PC supports the
   required Windows AI hardware and runtime.

A central local OCR workstation is preferable to installing a large model on
every ordinary office PC. Each operator can use the lightweight browser UI,
while the internal workstation performs OCR over the office network. If this is
implemented, use authenticated access, TLS, firewall restrictions, and no
unnecessary image retention.

### Template-based automation

The documents have stable layouts. The current manual rectangles can become
training and configuration data for automatic templates:

- Define normalized field rectangles for each known license, registration, and
  insurance-card layout.
- Detect document corners and apply a perspective transform so photographs are
  aligned to a canonical template size.
- Map template rectangles back to original image pixels.
- Show proposed rectangles immediately.
- Let the operator adjust only the fields that are wrong.
- Save corrections to improve template matching, subject to the office's data
  retention policy.

This preserves the successful “one targeted region at a time” behavior without
requiring the operator to draw every rectangle for every document.

### Field-specific AI and validation

Names and addresses benefit from language context. Identifiers should be
handled more strictly:

- Driver-license numbers: state-specific format checks.
- VIN: exactly 17 characters, permitted-character checks, and check-digit
  validation where applicable.
- Dates: valid calendar dates and logical effective/expiration ordering.
- ZIP codes: five digits or ZIP+4.
- Policy and NAIC numbers: carrier-specific format rules when known.
- Plate numbers: state-aware character rules.
- Cross-document checks: compare names, addresses, VINs, and effective dates
  across the license, registration, and insurance card.

The system should preserve both values:

```json
{
  "rawOcr": "what the OCR engine returned",
  "normalizedValue": "the proposed structured value",
  "validation": ["warnings or passed rules"],
  "operatorApproved": false
}
```

An AI model may organize and normalize text, but it should never silently
replace the raw OCR value. Ambiguous characters must be shown to the operator.

### Privacy and operational requirements

These documents contain personal information. Before production deployment:

- Decide formally whether cloud OCR is allowed.
- Use an approved business account and contract for any cloud provider.
- Do not place API keys in browser JavaScript.
- Restrict document and result access by employee role.
- Encrypt data in transit and at rest.
- Define deletion and retention periods for originals, crops, and logs.
- Avoid logging full document images or customer identifiers.
- Record engine version, validation results, and operator approval for audit.
- Obtain legal/compliance review for applicable brokerage, privacy, and
  cybersecurity obligations.

### Suggested pilot plan

1. Collect 50–100 representative documents that the office is authorized to
   use for evaluation. Include good, average, and very poor images.
2. Create verified ground-truth values for the important fields.
3. Run the same exact crops through Tesseract, LightOnOCR/RapidOCR, Azure, and
   any Windows AI candidate.
4. Measure exact-field accuracy separately for names, addresses, dates,
   license numbers, VINs, plates, and policy numbers.
5. Measure median and worst-case processing time and operator correction time.
6. Select the engine and hardware based on total office time saved and exact
   identifier accuracy.
7. Pilot with one or two employees before wider rollout.

### Success metrics

- Percentage of fields accepted without edits.
- Exact-match rate for license numbers, VINs, plates, dates, and policy numbers.
- Average operator seconds per document.
- Percentage of documents requiring rectangle adjustment.
- Median and 95th-percentile OCR latency.
- Number of incorrect values that passed validation.
- Number of documents completed per employee per hour.

The current prototype is suitable for collecting those measurements and
learning which crops and layouts fail. It is not yet a production system for
automatically filing DMV or insurance forms.
