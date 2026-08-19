# OCR Workspace Design Notes

## Approved direction: multi-customer workspace

The office expects no more than approximately 8–10 customers in one active
workspace. The interface should optimize for that scale rather than introduce a
large-batch dashboard.

Each customer is an isolated filing set containing their documents, OCR state,
organized form data, manually edited fields, filing purpose, and generated-form
state. Information from one customer must never be merged into another
customer's form.

### Contextual top header

- Keep `OCR Workspace` at the left.
- Use one segmented `Files` / `Form` page switcher; highlight only the active
  page in blue.
- On the Files page, show `Add customer`, the page switcher, and
  `Clear workspace`.
- Do not show a global `Add files` action. A file is always added from inside a
  specific customer section, so its destination is unambiguous.
- Do not require an active-customer selection on the Files page. All customers
  are visible together on the canvas.
- On the Form page, replace `Add customer` with a compact customer selector.
  Switching that selector changes the form, purpose, source-document picker,
  OCR text, and generated MV-82 together.
- Keep `Reorganize with Gemini` as a secondary indigo action on the Form page.
  It is a form-organization action rather than an OCR action.
- Local organization runs automatically after OCR. Gemini is called only from
  the explicit `Reorganize with Gemini` action and must preserve manually edited
  fields.

### Files canvas and customer sections

- Render customer sections vertically on the existing canvas.
- Begin each section with a subtle separator containing the customer name,
  document count, processing/readiness status, `OCR actions`, and `Add files`.
- `Add files` adds files only to the customer whose section contains the action.
- Keep documents in the existing visual tile style beneath their customer
  separator.
- Keep customers in creation order for the initial implementation. Do not add
  drag-to-reorder until office use demonstrates a need.
- Completed customers remain visible and are never hidden automatically. A
  manual collapse control may be added to reduce the height of completed
  sections.
- Do not implement customer archiving initially. Revisit it after local
  persistence and normal office usage are understood.

### Customer-scoped OCR actions

- Place an `OCR actions` menu beside each customer name.
- Show only actions that apply to that customer and its current state:
  `Extract all`, `Extract pending`, `Retry failed`, or `Re-run OCR`.
- Keep per-document extraction/retry actions available on document tiles.
- A failure in one customer must not prevent other customers from completing.

### Clear workspace

- `Clear workspace` replaces the former global OCR lifecycle menu on the Files
  page.
- Treat it as a destructive secondary action, not a primary action.
- Require confirmation and state the exact number of customers and documents
  that will be removed, along with OCR results and form edits.
- Once saved-workspace history or archiving exists, reconsider whether this
  should become `Start new workspace` instead of permanently clearing data.

### Customer naming

- New customers receive stable temporary names in creation order:
  `Customer 1`, `Customer 2`, and so on.
- After OCR produces one clear full name, replace the temporary name with the
  extracted name.
- If source documents contain conflicting names, keep the temporary name and
  show `Name needs review` rather than guessing.
- Once an operator manually renames a customer, later OCR must never overwrite
  that name.
- Distinguish duplicate extracted names with a restrained suffix such as
  `Jane Lewis (2)`.
- Never renumber existing customers after deletion. The next customer uses the
  next unused sequence number so visible identities do not unexpectedly change.

### File deletion

- Add a small `×` removal control at the top-left of each document image,
  opposite the existing top-right status mark.
- Give the control an accessible `Remove file` label and tooltip.
- Prefer immediate removal with a short-lived `Undo` message instead of a
  confirmation dialog for every file.
- Disable removal while that file is actively extracting.
- After removal, recompute the customer's merged OCR data while preserving all
  manually edited fields.
- Removing an entire customer is a separate action and requires confirmation
  when the customer contains documents.

### Form behavior

- Opening Form selects the first customer with completed OCR when there is no
  previous valid selection.
- The header customer selector lists all customers with a compact readiness
  status and includes `Add customer` at the bottom.
- Selecting a customer without completed OCR shows an `OCR required` state with
  a direct return to that customer's Files section.
- Missing-field counts, conflicts, purpose, source documents, OCR text, Gemini
  organization, and MV-82 generation are all customer-scoped.

## Approved direction: form workspace toolbar

- Use the labeled split-toolbar direction with `FILING SETUP` and `DOCUMENT VIEW` zones.
- Keep the toolbar on one row with a subtle divider between zones.
- Show `Purpose` without the helper sentence about choosing a DMV transaction.
- Keep the review count visually restrained in amber.
- Keep `Preview MV-82` as the primary action.
- Group `Source`, `OCR Text`, and `MV-82` as one segmented view control.
- Keep the active view highlighted in blue, followed by the document selector and `Download`.

## Approved direction: local persistence

The initial persistence layer will remain browser-local with no backend.

- Use IndexedDB rather than `localStorage`; uploaded images and PDFs can be
  stored directly as `Blob` values.
- Auto-save workspace changes. Do not introduce a manual Save button.
- Persist customers, customer names, original documents, thumbnails, rotation,
  crop rectangles, OCR text, organized fields, manual-edit markers, filing
  purpose, processing outcomes, and other data required to restore the work.
- Do not persist open menus, open modals, zoom level, temporary OCR crops, or
  generated MV-82 previews. Generated PDFs can be recreated.
- Store each original image or PDF once. Do not store base64 copies or
  full-resolution rendered duplicates of every PDF page.
- On reload, change interrupted `extracting` states back to a recoverable
  pending/retry state.
- Request persistent browser storage with `navigator.storage.persist()` after
  the operator first creates meaningful work, rather than at application load.
- Use `navigator.storage.estimate()` to display or diagnose usage and quota.
  Warn before storage becomes constrained and handle `QuotaExceededError`
  without damaging the existing workspace.
- Browser data is scoped to the exact origin, browser profile, and device. The
  office installation must use a stable hostname and port.
- Private/incognito sessions are unsupported for persisted office work because
  their data is normally removed when the session ends.
- Browser persistence is not a substitute for a future backup/export strategy
  for critical customer records.

At the expected office maximum of 8–10 active customers, browser capacity is
not expected to be a practical constraint. The implementation must still
measure quota and fail safely rather than assume unlimited storage.

## Proposed implementation sequence

1. Introduce the customer/workspace state model and isolate each customer's
   documents, OCR data, manual edits, purpose, and PDF state.
2. Build the grouped Files canvas, contextual header, per-customer uploads, and
   per-customer OCR menus.
3. Scope the Form workspace and customer selector to the new customer model.
4. Add document removal with Undo and customer/workspace destructive-action
   confirmations.
5. Add IndexedDB auto-save, restoration, storage persistence requests, quota
   reporting, and safe storage-error handling.
6. Verify customer isolation, interrupted-work recovery, deletion recalculation,
   and reload behavior with realistic multi-customer office batches.
