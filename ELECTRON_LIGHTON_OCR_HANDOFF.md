# Electron → Hosted LightOn OCR Integration Handoff

Last verified against the local source and live Google Cloud configuration: **August 16, 2026**.

## 1. Objective

Integrate an existing Windows Electron desktop application with the LightOnOCR service that is already deployed in Google Cloud. Reproduce the useful document-adjustment behavior from the current OCR web application:

1. Select one or more images or PDFs.
2. Show each image or PDF page as a document tile.
3. Clicking/tapping a tile opens a large adjustment modal.
4. The modal provides quick 90° rotation, display zoom, and one movable/resizable OCR rectangle.
5. The selected source-resolution crop is converted to PNG and sent to the existing hosted OCR endpoint.
6. The API returns normalized OCR text, raw model output, model/device information, and inference time.
7. Authentication uses the already-authorized office Google account, `info@guineeinsurance.com`, with automatic token refresh after the initial login.

This integration should reuse the existing hosted model. Do **not** deploy LightOnOCR inside the Electron application and do **not** call the private GPU service directly.

## 2. Verified Google Cloud Architecture

Google Cloud project:

```text
workbook-a57d1
```

Region:

```text
us-east4
```

Services:

| Role | Cloud Run service | URL | Access |
| --- | --- | --- | --- |
| Browser/API gateway | `ocr-office` | `https://ocr-office-kl4btfdxqq-uk.a.run.app` | Protected by Google IAP |
| GPU OCR backend | `lighton-ocr-benchmark` | `https://lighton-ocr-benchmark-kl4btfdxqq-uk.a.run.app` | Private; only the frontend service account can invoke it |

The gateway exposes `/api/ocr` and obtains a short-lived Google identity token from the Cloud Run metadata server before forwarding the request to the private backend `/ocr` route.

The gateway runs as:

```text
ocr-frontend@workbook-a57d1.iam.gserviceaccount.com
```

That service account has `roles/run.invoker` on the private GPU backend. Preserve this boundary:

```text
Electron app
    │
    │ HTTPS + user IAP ID token
    ▼
ocr-office /api/ocr
    │
    │ Google service-to-service ID token
    ▼
lighton-ocr-benchmark /ocr
    │
    ▼
LightOnOCR-2-1B on a Cloud Run GPU
```

Direct unauthenticated access currently behaves as expected:

- `ocr-office` redirects to IAP sign-in.
- `lighton-ocr-benchmark` returns HTTP `403`.

The current IAP access list includes:

```text
info@guineeinsurance.com
bounsalioudiallo@gmail.com
```

The office Electron integration should authenticate as the first account unless the user deliberately selects another authorized account.

## 3. Recommended Authentication Workflow

### User experience

The office employee should normally sign in only once:

1. On the first OCR request, check for a securely stored refresh token.
2. If none exists, open the system browser for Google OAuth/IAP authentication.
3. Ask the employee to select `info@guineeinsurance.com`.
4. Complete the installed-desktop-app OAuth flow using a loopback redirect on `127.0.0.1` and PKCE where supported.
5. Receive a short-lived IAP-compatible ID token and a refresh token.
6. Store the refresh token encrypted with Windows DPAPI through Electron `safeStorage`.
7. Keep the ID token only in memory, together with its expiration time.
8. Before every request, reuse the in-memory ID token if it has more than five minutes remaining.
9. Otherwise use the refresh token to obtain a replacement ID token automatically.
10. Show Google sign-in again only if refresh fails because access was revoked, consent was invalidated, or the saved credential can no longer be decrypted.

An IAP ID token is intentionally short-lived (approximately one hour). Do not attempt to alter its lifetime. Long-running sign-in is achieved by securely retaining the refresh token and silently refreshing the ID token.

### Google configuration that the office Codex must verify

The live IAP service already uses a configured OAuth client, rather than having no OAuth settings. Programmatic desktop access still needs to be completed according to Google IAP's current desktop-app instructions:

1. Inspect the OAuth clients in `workbook-a57d1`.
2. Create or reuse an OAuth client of type **Desktop app** for the Electron application.
3. Add/share that client for programmatic access to the IAP-protected `ocr-office` resource as required by the current Google IAP documentation.
4. Keep `info@guineeinsurance.com` in `roles/iap.httpsResourceAccessor` on `ocr-office`.
5. Confirm the returned ID token has the audience IAP expects for `ocr-office`.
6. Send the token in `Authorization: Bearer ID_TOKEN`.

Reference: <https://docs.cloud.google.com/iap/docs/authentication-howto>

Do not guess at the audience or silently use a normal Google access token. IAP expects an appropriate Google-issued **ID token**. Decode the JWT locally during development and verify `aud`, `email`, `email_verified`, `iat`, and `exp` without logging the full token.

### Credential storage rules

- OAuth desktop client IDs are identifiers, not secrets.
- A desktop client secret cannot be treated as confidential because it ships with the application.
- Never bundle a Google service-account JSON key in Electron.
- Never bundle the private backend's service identity or try to reproduce the gateway's metadata-server token call on the office PC. The Google metadata server exists inside Google Cloud, not on the office desktop.
- Store the refresh token with Electron `safeStorage.encryptString()` and persist only the encrypted bytes.
- Keep the current ID token in memory; there is no need to write it to disk.
- Never log `Authorization` headers, ID tokens, refresh tokens, source images, or base64 request bodies.
- Provide a **Sign out / Forget Google account** command that deletes the encrypted refresh token and clears the in-memory token.
- If `safeStorage.isEncryptionAvailable()` is false, do not fall back to plaintext. Require interactive sign-in for that session or show a configuration error.

### Suggested Electron process boundary

Authentication, file reading, image conversion, and API requests should run in the Electron **main process** or a tightly controlled utility process. The renderer should receive only the minimum methods it needs through the preload bridge.

Suggested preload surface:

```ts
type OcrRequest = {
  pngDataUrl: string;
  documentId: string;
};

type OcrResult = {
  text: string;
  rawText: string;
  model: string;
  device: string;
  durationMs: number;
};

contextBridge.exposeInMainWorld("officeOcr", {
  signIn: () => ipcRenderer.invoke("ocr:sign-in"),
  signOut: () => ipcRenderer.invoke("ocr:sign-out"),
  status: () => ipcRenderer.invoke("ocr:auth-status"),
  recognize: (request: OcrRequest) => ipcRenderer.invoke("ocr:recognize", request),
});
```

Enable `contextIsolation`, disable `nodeIntegration` in renderers, validate every IPC argument, and do not expose a generic `fetch`, shell, filesystem, or token-retrieval method to the renderer.

### Token manager behavior

Use one shared in-flight refresh promise so simultaneous OCR requests do not start multiple refreshes:

```ts
async function getValidIapIdToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 5 * 60_000) {
    return cachedToken.value;
  }

  if (!refreshInFlight) {
    refreshInFlight = refreshIapIdTokenFromSecureCredential()
      .then((token) => {
        cachedToken = token;
        return token.value;
      })
      .finally(() => {
        refreshInFlight = null;
      });
  }

  return refreshInFlight;
}
```

If an API request returns `401` or an IAP authentication redirect:

1. Discard the cached ID token.
2. Refresh once.
3. Retry the OCR request once.
4. If it still fails, stop retrying and show **Google sign-in required**.

Do not retry authentication indefinitely.

## 4. OCR API Contract

### Endpoint

```http
POST https://ocr-office-kl4btfdxqq-uk.a.run.app/api/ocr
Authorization: Bearer <IAP_ID_TOKEN>
Content-Type: application/json
Accept: application/json
```

Call the gateway `/api/ocr`, not the backend `/ocr` URL.

### Request body

```json
{
  "image": "data:image/png;base64,iVBORw0KGgoAAA..."
}
```

`image` is required and must be a nonempty string. The current UI always sends a PNG data URL generated by a browser canvas. The backend also tolerates bare base64 because it splits on the first comma when present, but the Electron app should send the complete `data:image/png;base64,` form for consistency.

The gateway and backend each enforce a maximum complete HTTP request size of 25 MiB. Base64 increases binary size by roughly one third, and the JSON wrapper adds a small amount. Keep the PNG comfortably below approximately 18 MiB instead of targeting the absolute limit.

This is **not** currently a multipart upload endpoint. Do not send `FormData`, a filesystem path, or raw PDF bytes.

### Successful response

```json
{
  "text": "Normalized readable OCR text",
  "rawText": "Original decoded model response, possibly containing HTML tables",
  "model": "/opt/models/lighton-ocr",
  "device": "cuda",
  "durationMs": 3214
}
```

Fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `text` | string | Normalized text intended for display and downstream parsing |
| `rawText` | string | Original LightOn model output before HTML-table flattening |
| `model` | string | Configured model identifier/path |
| `device` | string | Inference device; hosted service should normally report `cuda` |
| `durationMs` | number | Backend model generation time, not total network duration |

The Electron app should also measure client-side elapsed time so it can distinguish upload/network delay from model inference time.

### Errors

The current backend returns JSON shaped like:

```json
{
  "error": "Error description"
}
```

Relevant failure classes:

| Condition | Likely result | Electron behavior |
| --- | --- | --- |
| Missing/expired IAP authentication | Redirect, `401`, or `403` depending on request path | Refresh once, retry once, then ask for sign-in |
| Account lacks IAP permission | `403` | Show that the Google account is not authorized; do not keep retrying |
| Request above limit | Gateway failure or backend `500` under current implementation | Tell user to select a smaller crop or reduce image resolution |
| Empty/malformed JSON or image | Backend error response | Mark only that document failed and preserve its crop |
| Gateway cannot reach GPU backend | `502` with a generic temporary-unavailable message | Offer Retry; use bounded backoff |
| Cold start/model loading | Long request | Keep progress UI active; do not assume failure after a normal short web timeout |

The gateway currently allows up to 900 seconds for the upstream OCR call. The Electron client should use a generous timeout such as 15 minutes, but it should provide a Cancel action locally. Cancellation stops waiting; it may not stop an inference already running in Cloud Run.

### Optional hosted routes

The same gateway also maps:

```text
/api/organize        → Gemini structured MV-82 organization
/api/fill-mv82       → filled MV-82 PDF generation
/api/save-extraction → audit persistence request
```

Important distinctions:

- `/api/ocr` returns OCR text; it does not return completed MV-82 fields.
- The current web application initially organizes OCR text with local deterministic TypeScript rules.
- The user must explicitly choose **Reorganize with Gemini** before `/api/organize` is called.
- Hosted extraction persistence is currently disabled by cloud benchmark mode, so `/api/save-extraction` returns that persistence is disabled.

If the office task is only OCR integration, implement `/api/ocr` first and leave the other routes out of scope.

## 5. Exact Current File-Import Behavior

The existing web UI accepts:

```text
image/*, .pdf, application/pdf
```

It supports multiple files in one selection.

### Images

For an image file:

1. Retain the original `Blob`.
2. Create an object URL for previewing it.
3. Initialize rotation to `0`.
4. Initialize `regions` as an empty array.
5. Initialize OCR state to `idle` with empty normalized/raw text.

### PDFs

For a PDF:

1. Read the PDF into PDF.js.
2. Iterate through **every page**, starting at page 1.
3. Render each page at PDF.js viewport scale `3`.
4. Convert each rendered page canvas to a PNG `Blob`.
5. Treat each page as a separate document tile and OCR unit.
6. Keep the original PDF blob and the page number so the preview can be recreated later.
7. Name each tile as `Original filename — Page N` and display `Page N` below it.

One bad file is skipped without preventing the remaining selected files from loading. During import, the current UI displays a centered overlay with messages such as:

```text
Preparing 3 files…
Reading PDF 1 of 3…
Processing PDF page 2 of 5…
Loading image 3 of 3…
```

The Electron implementation should surface skipped-file errors more clearly than the current web app while still continuing the batch.

## 6. Exact Rendering and Rotation Algorithm

Before previewing, cropping, or extracting, the current application renders the source into an intermediate canvas.

Given source dimensions `naturalWidth × naturalHeight` and rotation angle `θ`:

```text
rotatedWidth  = abs(naturalWidth × cos θ) + abs(naturalHeight × sin θ)
rotatedHeight = abs(naturalWidth × sin θ) + abs(naturalHeight × cos θ)
fit = min(1, 4000 / rotatedWidth, 4000 / rotatedHeight)
canvasWidth  = round(rotatedWidth × fit)
canvasHeight = round(rotatedHeight × fit)
```

The renderer then:

1. Creates a white canvas using those dimensions.
2. Translates the drawing origin to the center of the canvas.
3. Rotates the context by `θ`.
4. Enables high-quality image smoothing.
5. Draws the source centered at size `naturalWidth × fit` by `naturalHeight × fit`.

The UI offers only `−90°` and `+90°`, although the stored value is a numeric angle and is not normalized back into `0–359`. This does not change the visual result.

The 4000-pixel cap prevents extremely large images from producing oversized canvases and requests. Match it unless the office app already has a carefully tested image-size policy.

### Rotation invalidates the crop and OCR result

When the user rotates a document, the current app:

- Adds or subtracts 90°.
- Deletes the existing OCR rectangle because its coordinates belong to the previous orientation.
- Clears normalized text and raw text.
- Resets document state to `idle`.
- Clears organized data, organizer identity, and duration.
- Resets display zoom to `100%`/Fit.
- Creates a new centered default rectangle after the rotated canvas is rendered.

The office integration should preserve this behavior. Attempting to transform an old rectangle across rotations is unnecessary and more error-prone.

## 7. Document Tile UI

The current Files view is organized by customer. Each customer section contains:

- Customer name.
- Document count.
- Status badge: `Extracting…`, `Name needs review`, `N failed`, `Ready`, `N pending`, or `No documents`.
- An **OCR actions** menu for Extract pending, Retry, and confirmed Re-run.
- An **Add files** button.
- A grid of document tiles.

Each document tile contains:

- A centered image/page canvas with a white background, thin border, and drop shadow.
- A blue hover outline indicating that the preview is clickable.
- The saved OCR rectangle drawn on top as a translucent blue outline.
- A remove `×` control in the upper-left.
- A state control in the upper-right: spinner while extracting, `✓` when done, or `!` when failed.
- A page label for PDF pages.
- An organizer status after completion.
- A per-document action: **Extract this file/page**, **Extracting…**, **Retry**, or **Re-extract**.

The thumbnail rectangle is not independently positioned using thumbnail pixels. It converts the source-canvas rectangle to percentages:

```text
left%   = region.x / sourceCanvas.width  × 100
top%    = region.y / sourceCanvas.height × 100
width%  = region.w / sourceCanvas.width  × 100
height% = region.h / sourceCanvas.height × 100
```

This keeps it aligned when the thumbnail is responsively scaled.

## 8. Adjustment Modal UI and Interaction

Clicking or tapping the document preview opens a modal named **Adjust document**.

### Modal layout

- Full-screen dimmed backdrop.
- Dialog size: up to `1120px × 780px`, constrained to approximately `96vw × 92vh`.
- Minimum dialog height: `520px` in the current desktop-oriented layout.
- A 54px top toolbar.
- A scrollable gray grid-pattern stage beneath the toolbar.
- The rendered document canvas centered in the stage with a drop shadow.

Clicking the backdrop or pressing Escape closes the modal. The top-right `×` also closes it. The current code uses a 350ms close guard to prevent the click that closes a dialog from immediately reopening the document beneath it.

### Toolbar controls

In order:

1. `↺` rotate counterclockwise 90°.
2. `↻` rotate clockwise 90°.
3. `−` decrease display zoom by 25 percentage points.
4. Current display zoom percentage.
5. `+` increase display zoom by 25 percentage points.
6. **Fit** reset zoom to `1`.
7. `×` close.

Zoom is clamped to `0.5–4.0` (50%–400%). Rotation and rectangle changes are disabled while extraction is active. Zoom controls are display-only and do not modify pixels sent to OCR.

### Initial fit and display zoom

The full rendered canvas is fitted into the modal stage using:

```text
availableWidth  = max(240, stageWidth  - 64)
availableHeight = max(220, stageHeight - 64)
baseFit = min(1, availableWidth / canvasWidth, availableHeight / canvasHeight)
baseDisplayWidth  = round(canvasWidth  × baseFit)
baseDisplayHeight = round(canvasHeight × baseFit)
displayWidth  = baseDisplayWidth  × zoom
displayHeight = baseDisplayHeight × zoom
```

The canvas's internal width and height remain unchanged. Only its CSS display dimensions change. This separation is essential: a crop must always come from the internal source canvas, not from a screenshot of the currently zoomed modal.

### Default OCR rectangle

Opening a document that has never been opened creates exactly one centered region:

```text
width  = 60% of rendered canvas width
height = 40% of rendered canvas height
x = (canvasWidth  - width)  / 2
y = (canvasHeight - height) / 2
```

The region is labeled **OCR area**, filled with faint translucent blue, outlined in blue, and has one circular drag handle at each corner.

Important behavior: if a document has never been opened, its `regions` array remains empty and extraction sends the **whole document**. Simply opening it creates the default crop. Closing the modal preserves the crop.

### Moving the rectangle

Dragging inside the rectangle moves it. Pointer movement occurs in display pixels, so it is converted back into source-canvas coordinates:

```text
dx = pointerDisplayDeltaX / displayedCanvasWidth  × internalCanvasWidth
dy = pointerDisplayDeltaY / displayedCanvasHeight × internalCanvasHeight
```

The new `x` and `y` are clamped so the entire rectangle remains within the canvas. Width and height do not change during a move.

### Resizing the rectangle

The four handles are northwest, northeast, southwest, and southeast. Dragging a handle adjusts only its corresponding sides and clamps all edges to the canvas.

The exact minimum dimensions are:

```text
minimumWidth  = min(120 pixels, canvasWidth  × 0.08)
minimumHeight = min(80 pixels,  canvasHeight × 0.08)
```

The rectangle coordinates are stored as floating-point source-canvas pixels:

```ts
type Region = {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
};
```

Use Pointer Events and pointer capture so mouse, pen, and touch dragging continue correctly even when the pointer moves outside the handle.

### Any rectangle change invalidates old OCR

Moving or resizing the rectangle immediately clears:

- Normalized OCR text.
- Raw OCR text.
- Done/failed status, returning it to `idle`.
- Previously organized fields associated with that document.
- Organizer source.
- Previous inference duration.

This prevents stale text from appearing to describe a newly selected crop.

## 9. Exact Crop Generation

At extraction time, render the document again using the rotation and 4000-pixel-cap algorithm described above.

If a region exists:

```text
cropCanvas.width  = round(region.w)
cropCanvas.height = round(region.h)
drawImage(
  renderedSourceCanvas,
  region.x, region.y, region.w, region.h,
  0, 0, cropCanvas.width, cropCanvas.height
)
pngDataUrl = cropCanvas.toDataURL("image/png")
```

If no region exists:

```text
pngDataUrl = renderedSourceCanvas.toDataURL("image/png")
```

Do not crop the `<img>` thumbnail, modal screenshot, or CSS-scaled canvas. Always crop the internal rendered canvas.

### Backend image preparation

After receiving the PNG, the backend performs a small additional preparation step:

1. Strip the data-URL prefix and base64-decode the bytes.
2. Open with Pillow and convert to RGB.
3. If the crop's longest side is below 1200 pixels, enlarge it enough to approach 1200 pixels, capped at 4× enlargement.
4. Add a white border equal to the larger of 12 pixels or 4% of the crop's shorter side.
5. Send the image to LightOnOCR.
6. Generate at most 512 new model tokens with deterministic decoding (`do_sample=False`).
7. Preserve the original decoded response as `rawText`.
8. If the result includes an HTML table, flatten table rows into readable `cell | cell` lines for `text`.

The client should not duplicate this enlargement or border step. Send the clean source crop and let the backend apply its established model preparation.

## 10. Batch Extraction Workflow

The existing application supports extracting one document, all pending documents for one customer, or rerunning all documents after confirmation.

Recommended Electron state model:

```ts
type DocumentState = "idle" | "extracting" | "done" | "failed";

type OcrDocument = {
  id: string;
  sourceKind: "image" | "pdf";
  pdfPageNumber: number | null;
  rotation: number;
  region: Region | null;
  state: DocumentState;
  text: string;
  rawText: string;
  model: string | null;
  device: string | null;
  backendDurationMs: number;
  totalDurationMs: number;
  error: string | null;
};
```

Per document:

1. Set state to `extracting`.
2. Render the rotated source canvas.
3. Create the selected crop or whole-page PNG.
4. Obtain/refresh the IAP token.
5. POST the PNG data URL to `/api/ocr`.
6. Store both `text` and `rawText`.
7. Store model/device timing metadata.
8. Set state to `done`.
9. On failure, keep source, rotation, and region; set state to `failed` and retain a user-safe error message.

The current web frontend starts document promises together, but the Python backend serializes model generation with an inference lock to protect limited GPU/model resources. The office app may use a small client concurrency limit—two or three uploads at a time—to avoid sending a large burst. Do not assume that many simultaneous requests increase GPU throughput.

For a rerun, require a confirmation action because rerunning incurs GPU time/cost and replaces the previous OCR result.

## 11. Request Implementation Sketch

This is illustrative structure, not drop-in OAuth code. The office Codex must connect it to the Electron app's actual architecture and Google's current OAuth library/configuration.

```ts
const OCR_URL = "https://ocr-office-kl4btfdxqq-uk.a.run.app/api/ocr";

async function recognizePng(pngDataUrl: string): Promise<OcrResult> {
  validatePngDataUrlAndSize(pngDataUrl);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const idToken = await getValidIapIdToken({ forceRefresh: attempt === 1 });
    const startedAt = performance.now();

    const response = await fetch(OCR_URL, {
      method: "POST",
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${idToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ image: pngDataUrl }),
      signal: AbortSignal.timeout(15 * 60_000),
    });

    if ((response.status === 401 || response.status === 302) && attempt === 0) {
      clearCachedIdToken();
      continue;
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      throw new Error(
        response.status === 403
          ? "This Google account is not authorized for office OCR."
          : "The OCR gateway returned an unexpected sign-in response."
      );
    }

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(toUserSafeOcrError(response.status, payload));
    }

    return {
      text: String(payload.text || "").trim(),
      rawText: String(payload.rawText || payload.text || "").trim(),
      model: String(payload.model || ""),
      device: String(payload.device || ""),
      durationMs: Number(payload.durationMs || 0),
      totalDurationMs: Math.round(performance.now() - startedAt),
    };
  }

  throw new Error("Google sign-in is required.");
}
```

Important: verify how the selected Electron/Node HTTP implementation handles redirects. An IAP redirect should be detected as authentication failure; the OCR request must not quietly follow it and try to parse the Google sign-in HTML as JSON.

## 12. Data and Privacy Boundary

For each OCR request, the following leaves the office computer:

- The selected crop or complete rendered page, encoded as PNG/base64 inside JSON.
- Standard HTTPS request metadata such as IP address, timestamps, headers, and request size.
- The employee's short-lived Google IAP identity token.

The following does not need to be sent for OCR:

- Original local filesystem path.
- Entire original PDF when only one rendered page/crop is being recognized.
- Customer name or internal customer ID.
- Electron refresh token.
- Windows login credentials.

The OCR response returns extracted document text to the office computer. Treat it as sensitive customer information. Do not place text or images in analytics, crash reports, console logs, or remote telemetry.

The cloud backend's benchmark mode disables extraction-file persistence. The OCR image exists in memory for request processing. Normal Google Cloud infrastructure logs may still contain request metadata; application logging intentionally avoids printing document pixels on normal successful requests.

## 13. UX Recommendations for the Office App

Keep the interaction fast and unsurprising:

- Authentication should be invisible after the first successful login.
- Show the signed-in email in a settings/status area, not in the main OCR workflow.
- If the wrong Google account is selected, show the email and provide **Switch account**.
- Preserve crops and rotations across failed requests.
- Show a per-document spinner instead of blocking the entire app unnecessarily.
- Allow the employee to continue reviewing other documents while OCR runs, but disable rotation/crop edits on a document whose current pixels are already being extracted.
- Display **Warming up OCR…** when the first request takes longer because Cloud Run/model startup is occurring.
- Display separate Retry actions for network/backend failures.
- Require confirmation before replacing a completed OCR result.
- Keep normalized text for normal work and offer raw model output in a secondary diagnostic view.

## 14. Implementation Order for the Office Codex

1. Locate the Electron main process, preload bridge, renderer framework, existing document model, and existing credential-storage utilities.
2. Add the IAP desktop OAuth configuration and one-time Google sign-in.
3. Add encrypted refresh-token storage and in-memory ID-token caching/refresh.
4. Prove an authenticated `GET /health` or minimal gateway request without exposing credentials in logs.
5. Implement a single-image `/api/ocr` request from the main process.
6. Implement image import and the 4000-pixel-cap rotated source canvas.
7. Implement PDF.js all-page rendering at scale 3.
8. Implement document tiles and source-coordinate rectangle overlays.
9. Implement the adjustment modal, rotation, display-only zoom, move, and corner resize.
10. Connect selected-crop PNG generation to the OCR request.
11. Add per-document state, bounded retries, timeouts, cancellation, and user-safe errors.
12. Add batch extraction with a small concurrency limit.
13. Add raw/normalized text review and confirmed rerun.
14. Add unit tests for coordinate math and integration tests against a mocked IAP/OCR gateway.
15. Perform one controlled live test using a non-sensitive sample before testing authorized office documents.

## 15. Acceptance Tests

### Authentication

- First use opens Google sign-in and succeeds with `info@guineeinsurance.com`.
- Restarting Electron does not require another sign-in.
- An expired ID token refreshes silently.
- A revoked refresh token causes one clean sign-in prompt, not a retry loop.
- An unauthorized account gets a clear access-denied message.
- No token appears in logs, renderer state, DevTools messages, or crash reports.

### Image and PDF preparation

- A normal JPG appears as one tile.
- A five-page PDF appears as five independently adjustable tiles.
- PDF pages are rendered at scale 3.
- Images larger than 4000 pixels on a rotated axis are proportionally reduced.
- White background appears around rotated corners rather than transparency/black.

### Modal and crop

- Clicking/tapping a tile opens the modal at Fit/100% state.
- First open creates a centered 60% × 40% rectangle.
- A document extracted without ever opening sends the whole rendered page.
- The rectangle remains aligned at 50%, 100%, 200%, and 400% display zoom.
- Moving/resizing at every zoom level produces the same source coordinates for the same visual location.
- The rectangle cannot leave the canvas or collapse below its calculated minimum.
- Rotate left/right clears the old rectangle/result and creates a fresh centered rectangle.
- Closing and reopening preserves a non-rotated rectangle.
- Thumbnail overlay matches the modal rectangle.

### OCR

- The request goes only to `ocr-office/.../api/ocr`.
- The body is JSON containing one PNG data URL.
- A valid request returns and stores normalized and raw text.
- Backend and total elapsed durations are kept separately.
- A request larger than the safe size is rejected before upload with guidance to reduce the crop.
- A temporary `502` leaves the crop intact and provides Retry.
- HTML-table model output remains in `rawText` while normalized `text` is readable.

### Security and privacy

- Direct backend requests remain forbidden.
- No service-account key is present in the application bundle.
- Refresh token storage uses Windows-backed Electron `safeStorage`.
- Source images, base64 bodies, and OCR text are absent from application logs and analytics.
- Sign out deletes the encrypted credential and requires sign-in on the next request.

## 16. Current Source References

These files are the authoritative reference implementation in this project:

| Behavior | File |
| --- | --- |
| File import, PDF rendering, rotated canvas, region math, modal, extraction | `app/page.tsx` |
| Modal/tile visual design | `app/globals.css` |
| Document and region types | `app/workspace-types.ts` |
| Local persisted workspace behavior | `app/workspace-storage.ts` |
| Public gateway routes and private Cloud Run token forwarding | `frontend-server.mjs` |
| OCR request validation, crop preparation, model invocation, response | `backend/lighton_server.py` |
| GPU container/model setup | `Dockerfile.lighton` |
| Frontend container/gateway setup | `Dockerfile.frontend` |
| Cloud image builds | `cloudbuild-lighton.yaml`, `cloudbuild-frontend.yaml` |

## 17. Non-Goals and Guardrails

- Do not deploy a second LightOn model unless the existing service cannot meet measured office demand.
- Do not make the private GPU backend public.
- Do not place a permanent API key or service-account private key inside Electron.
- Do not send original PDFs when the API requires a PNG crop.
- Do not couple display zoom to OCR resolution.
- Do not retain stale OCR after crop or rotation changes.
- Do not automatically call Gemini unless that is a separately approved office-app feature.
- Do not persist customer images or OCR text in logs merely for debugging.

The intended relaxed office posture is convenience through **automatic refresh and remembered Google authorization**, not removal of the existing private-backend boundary.
