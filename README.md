# OCR Workspace

A local, multi-document OCR workbench for difficult insurance and DMV source
documents. The operator interface currently uses local LightOnOCR. Synchronous
Google Cloud Vision comparison code remains installed behind a disabled UI flag.

## Current workflow

1. Select **Add customer**. New filing sets begin as `Customer 1`,
   `Customer 2`, and so on.
2. Use **Add files** inside a customer section to choose several images or PDFs
   at once. Every PDF page appears in that same customer section. Uploading
   never starts OCR.
3. Review the grouped image-only canvas. Each customer's documents, OCR state,
   and form data remain isolated from every other customer.
4. Click an image to open the adjustment modal. The first open creates one
   centered OCR rectangle. Drag it to move it or use its corner handles to
   resize it. The saved rectangle remains visible on the document tile.
5. Close the modal and repeat for any other file.
6. Use the customer's **OCR actions** menu to extract all pending documents, or
   extract a single document from its tile. The backend serializes model
   inference so overlapping generations do not compete. The browser immediately
   organizes the returned OCR with deterministic local rules—Gemini is not
   called during extraction.
7. A temporary customer name is replaced when OCR finds one unambiguous full
   name. Conflicting names remain flagged for review.
8. Select **Form** and use the header customer selector to review that
   customer's address, vehicle, and transaction data beside its source image.
   Use **Reorganize with Gemini** only when the local result needs another pass;
   manually edited fields are preserved.
9. Choose the MV-82 purpose. This changes the missing-data review only; PDF
   checkboxes, radio buttons, and signatures remain manual.
10. Select **Preview MV-82**. The local service clones the untouched official
   template, fills only the approved text/choice handlers, validates the values,
   and returns an embedded preview with a Download action.
11. Each file identifies whether its fields were organized locally or by Gemini
    and offers an **OCR Text** view. Re-running a customer's OCR requires
    confirmation.

The active workspace is saved automatically in IndexedDB, including original
source files, customer grouping, OCR results, crop/rotation settings, filing
purpose, and manual edits. Reloading the same browser origin restores the work.
Generated MV-82 previews are intentionally regenerated rather than persisted.
Use **Clear workspace** to remove all locally saved customers and documents; the
action requires confirmation.

Each engine writes separate, image-free comparison files under `ocr-output/`:
`latest-lighton-extraction.json`, `latest-lighton-extracted-text.txt`,
`latest-google-extraction.json`, and `latest-google-extracted-text.txt`. These
contain normalized OCR, raw OCR, timing, and the unchanged organizer output.

Zoom affects only the display. Rectangle coordinates are normalized to the
source image, and OCR crops are generated from the original source pixels.
When a document has never been opened, the whole document is sent to OCR. Once
opened, its single source-pixel rectangle is sent. Rotation resets the rectangle
to a centered default because the prior coordinates no longer match.

`mv82-4-fields.json` is the immutable technical inventory of every AcroForm
field. `mv82-4-automation-fields.json` is the smaller production configuration
approved from the office checklist.

## Run locally

Start the LightOnOCR service:

```bash
source .venv-lighton/bin/activate
python backend/lighton_server.py
```

In a second terminal, start the interface:

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

### Windows

Create a Windows virtual environment rather than copying the macOS one:

```powershell
python -m venv .venv-lighton
.venv-lighton\Scripts\Activate.ps1
python -m pip install -r requirements-lighton.txt
python backend\lighton_server.py
```

Then run `npm install` and `npm run dev` in another terminal. An NVIDIA GPU
with the appropriate CUDA PyTorch build is recommended for office throughput.

## Local model

The default model is `lightonai/LightOnOCR-2-1B`, served only on
`127.0.0.1:8765`. It loads lazily on the first request and remains in memory.
Override the model or port with `LIGHTON_OCR_MODEL` and `LIGHTON_OCR_PORT`.

## Hidden Google Vision test setup

Google extraction uses Application Default Credentials on the machine running
the local backend. Its endpoint, saved comparison output, and authentication
code remain available, but `SHOW_GOOGLE_OCR_TEST` in `app/page.tsx` is currently
`false`, so operators cannot start Google OCR from the UI. To run another
approved benchmark, enable Cloud Vision and billing for the selected project,
authenticate once, and temporarily set that flag to `true`:

```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project YOUR_PROJECT_ID
```

The current test machine uses project `workbook-a57d1`. Set
`GOOGLE_CLOUD_PROJECT` before starting the backend only when a different quota
project should override the one stored in Application Default Credentials.
Google credentials stay in the local Google Cloud configuration and are never
sent to the browser.

See `OCR_PROJECT_SUMMARY.md` for installed components, cleanup commands,
testing history, and office deployment notes.
