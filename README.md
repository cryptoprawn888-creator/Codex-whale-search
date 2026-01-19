# Codex Whale Search

Automates Solscan activity counts and Jupiter Holdings PnL lookups using Playwright + Stagehand, then writes the results back to Google Sheets.

## Requirements

- Node.js 18+
- Google Sheets service account JSON key shared with the target sheet
- Google Sheet with columns:
  - Column A: wallet address
  - Column C header: `Activities`
  - Column D header: `Holdings PNL`

## Setup

```bash
npm install
```

If you see an npm error about a missing Stagehand version, run:

```bash
npm install @browserbasehq/stagehand@latest
```

Create a `.env` file (or set environment variables):

```bash
SHEET_ID=your_google_sheet_id
SHEET_NAME=Sheet1
GOOGLE_SERVICE_ACCOUNT_JSON=/absolute/path/to/service-account.json
CSV_PATH=/absolute/path/to/wallets.csv
START_ROW=2
HEADLESS=false
RATE_LIMIT_MS=2000
MAX_RETRIES=3
TIMEOUT_MS=45000
SCREENSHOT_DIR=screenshots
STAGEHAND_API_KEY=your_stagehand_api_key_optional
STAGEHAND_PROJECT_ID=your_stagehand_project_id_optional
```

Notes:
- If `CSV_PATH` is set, wallets are read from CSV and mapped to consecutive rows starting from `START_ROW`.
- If `CSV_PATH` is not set, wallets are read from the sheet itself starting at `START_ROW`.
- Rows with values already in both columns C and D are skipped (resume support).

## Running

```bash
npm start
```

## CSV format

The CSV should include a wallet column.

## Behavior

- Detects verification/captcha pages and pauses for manual intervention.
- Retries failures with exponential backoff.
- Rate limits requests between wallets.
- Captures a screenshot on failure in the `SCREENSHOT_DIR` folder.
- If you provide `STAGEHAND_API_KEY`, Stagehand will run via Browserbase; otherwise it uses a local Playwright browser.
