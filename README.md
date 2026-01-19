# Codex Whale Search

Automates Solscan activity counts and Jupiter Holdings PnL lookups using Playwright, then writes the results back to Google Sheets.

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

Create a `.env` file (or set environment variables):

```bash
SHEET_ID=your_google_sheet_id
SHEET_NAME=Sheet1

# Option 1: Path to service account JSON file
GOOGLE_SERVICE_ACCOUNT_JSON=/absolute/path/to/service-account.json

# Option 2: Direct JSON credentials (useful for CI/CD or Docker)
# GOOGLE_SERVICE_ACCOUNT_JSON='{"type":"service_account","project_id":"...","private_key":"..."}'

# Optional: CSV file with wallet addresses (if not using, wallets will be read from the sheet)
# CSV_PATH=/absolute/path/to/wallets.csv

START_ROW=2
HEADLESS=false
RATE_LIMIT_MS=2000
MAX_RETRIES=3
TIMEOUT_MS=45000
SCREENSHOT_DIR=screenshots
```

Notes:
- `GOOGLE_SERVICE_ACCOUNT_JSON` accepts either a file path or the JSON credentials directly as a string
  - Use a file path for local development (e.g., `./service-account.json`)
  - Use direct JSON for environments where file paths differ (CI/CD, Docker, etc.)
- If `CSV_PATH` is set, wallets are read from CSV and mapped to consecutive rows starting from `START_ROW`.
- If `CSV_PATH` is not set, wallets are read from the sheet itself starting at `START_ROW`.
- Rows with values already in both columns C and D are skipped (resume support).

## Running

```bash
npm start
```

## CSV format

The CSV should include a wallet column. Example headers:

```csv
wallet
8GQHVGauEG8ccScLpafVh6xTDFU92SqXEpcc4oMAW9Qt
```

## Behavior

- Detects verification/captcha pages and pauses for manual intervention.
- Retries failures with exponential backoff.
- Rate limits requests between wallets.
- Captures a screenshot on failure in the `SCREENSHOT_DIR` folder.
- Uses Playwright with Chromium browser for web automation.
