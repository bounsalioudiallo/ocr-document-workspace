# OCR Workspace Design Notes

## Approved direction: contextual top header

Implementation is intentionally deferred until the remaining interface design is settled.

- Keep `OCR Workspace` at the left.
- Use one segmented `Files` / `Form` page switcher; highlight only the active page in blue.
- On the Files page, show `Add files` and an `OCR actions` menu. Hide form-only actions.
- On the Form page, show `Reorganize with Gemini` as a secondary indigo action. Hide file and OCR lifecycle actions.
- Put infrequent lifecycle operations such as `Re-run LightOn` and `New OCR` inside `OCR actions`.
- Local organization runs automatically after OCR. Gemini is called only from the explicit `Reorganize with Gemini` action and must preserve manually edited fields.

## Approved direction: form workspace toolbar

- Use the labeled split-toolbar direction with `FILING SETUP` and `DOCUMENT VIEW` zones.
- Keep the toolbar on one row with a subtle divider between zones.
- Show `Purpose` without the helper sentence about choosing a DMV transaction.
- Keep the review count visually restrained in amber.
- Keep `Preview MV-82` as the primary action.
- Group `Source`, `OCR Text`, and `MV-82` as one segmented view control.
- Keep the active view highlighted in blue, followed by the document selector and `Download`.
