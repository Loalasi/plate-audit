# Garage Plate Audit

A lightweight web app for auditing parked vehicles against a registered-vehicle Excel list, using a phone or tablet camera.

- Runs entirely on the device: plate reading (Tesseract OCR), Excel import/export, PDF and ZIP creation all happen in the browser.
- No data is uploaded. The vehicle list, scans and photos are stored only in that device's browser storage. The page's security policy blocks it from contacting any other site.
- Works offline after the first visit (service worker cache).
- Works on Android (Chrome) and iPhone/iPad (Safari). Add it to the home screen for an app-like experience.

## Files

| Path | Purpose |
|---|---|
| `index.html`, `css/`, `js/` | The app |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and home-screen install |
| `vendor/` | Third-party libraries, bundled locally (see `vendor/licenses/`) |

## Updating the app

Replace the changed files in this repository (Add file → Upload files → Commit changes). When `VERSION` in `sw.js` changes, devices show an **Update now** banner the next time the app is opened with internet.

## Third-party components

Tesseract.js and tesseract.js-core (Apache-2.0), English LSTM traineddata from tesseract-ocr/tessdata (Apache-2.0), SheetJS Community Edition (Apache-2.0), ExcelJS (MIT), JSZip (MIT), jsPDF (MIT), jsPDF-AutoTable (MIT). License texts are in `vendor/licenses/`.
