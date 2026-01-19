import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { parse } from "csv-parse/sync";
import { google } from "googleapis";
import dotenv from "dotenv";
import { chromium } from "playwright";

dotenv.config();

const CONFIG = {
  sheetId: process.env.SHEET_ID,
  sheetName: process.env.SHEET_NAME || "Sheet1",
  serviceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
  csvPath: process.env.CSV_PATH,
  startRow: Number.parseInt(process.env.START_ROW || "2", 10),
  headless: process.env.HEADLESS !== "false",
  rateLimitMs: Number.parseInt(process.env.RATE_LIMIT_MS || "2000", 10),
  maxRetries: Number.parseInt(process.env.MAX_RETRIES || "3", 10),
  timeoutMs: Number.parseInt(process.env.TIMEOUT_MS || "45000", 10),
  screenshotDir: process.env.SCREENSHOT_DIR || "screenshots",
};

const log = (message, context = {}) => {
  const time = new Date().toISOString();
  const extras = Object.keys(context).length ? ` ${JSON.stringify(context)}` : "";
  console.log(`[${time}] ${message}${extras}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ensureConfig = () => {
  if (!CONFIG.sheetId) {
    throw new Error("SHEET_ID is required.");
  }
  if (!CONFIG.serviceAccountJson) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON is required. Set it to either:\n" +
      "  1. A path to your service account JSON file, or\n" +
      "  2. The JSON credentials directly as a string",
    );
  }
};

const getSheetsClient = async () => {
  let authConfig;

  // Check if it's a file path or direct JSON
  if (fs.existsSync(CONFIG.serviceAccountJson)) {
    // It's a file path
    authConfig = {
      keyFile: CONFIG.serviceAccountJson,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    };
  } else {
    // Try to parse as JSON string
    try {
      const credentials = JSON.parse(CONFIG.serviceAccountJson);
      authConfig = {
        credentials,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      };
    } catch (error) {
      throw new Error(
        `GOOGLE_SERVICE_ACCOUNT_JSON must be either:\n` +
        `  1. A valid file path (file not found at: ${CONFIG.serviceAccountJson}), or\n` +
        `  2. Valid JSON credentials string (JSON parse failed: ${error.message})\n\n` +
        `Please check your .env file and ensure the path exists or provide the JSON directly.`,
      );
    }
  }

  const auth = new google.auth.GoogleAuth(authConfig);
  const client = await auth.getClient();
  return google.sheets({ version: "v4", auth: client });
};

const loadWalletsFromCsv = () => {
  if (!CONFIG.csvPath) {
    return [];
  }
  const csvContent = fs.readFileSync(CONFIG.csvPath, "utf8");
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
  return records.map((record, index) => ({
    wallet: record.wallet || record.Wallet || record.address || record.Address,
    rowIndex: CONFIG.startRow + index,
  }));
};

const loadWalletsFromSheet = async (sheets) => {
  const range = `${CONFIG.sheetName}!A${CONFIG.startRow}:D`;
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.sheetId,
    range,
  });
  const rows = response.data.values || [];
  return rows.map((row, index) => ({
    wallet: row[0],
    activities: row[2],
    holdingsPnl: row[3],
    rowIndex: CONFIG.startRow + index,
  }));
};

const writeSheetValues = async (sheets, rowIndex, activitiesValue, pnlValue) => {
  const range = `${CONFIG.sheetName}!C${rowIndex}:D${rowIndex}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: CONFIG.sheetId,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[activitiesValue, pnlValue]],
    },
  });
};

const promptToContinue = async (message) => {
  log(message);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  await new Promise((resolve) => rl.question("Press Enter to continue...", resolve));
  rl.close();
};

const detectVerification = async (page) => {
  const text = await page.content();
  return /verify you are human|captcha|cloudflare|security check/i.test(text);
};

const waitIfVerification = async (page, contextLabel) => {
  if (await detectVerification(page)) {
    await promptToContinue(`Verification detected on ${contextLabel}.`);
  }
};

const extractSolscanActivities = async (page) => {
  await page.waitForTimeout(2000);
  const text = await page.locator("text=/Total\\s+\\d+\\s+activities/i").first().textContent();
  if (!text) {
    throw new Error("Unable to locate Solscan activities text.");
  }
  const match = text.match(/Total\s+(\d+)\s+activities/i);
  if (!match) {
    throw new Error("Unable to parse Solscan activities count.");
  }
  return match[1];
};

const extractJupiterHoldingsPnl = async (page) => {
  await page.waitForTimeout(2000);
  const label = page.locator("text=/Holdings\s+PnL/i");
  await label.first().waitFor({ timeout: CONFIG.timeoutMs });
  const container = label.first().locator("..")
    .locator("..")
    .locator("..");
  const valueText = await container.locator("text=/\$?[-+\d,.]+/i").first().textContent();
  if (!valueText) {
    throw new Error("Unable to locate Holdings PnL value.");
  }
  return valueText.trim();
};

const withRetries = async (task, { label, attempts }) => {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      log("Retrying after failure", { label, attempt, error: error.message });
      await sleep(2000 * attempt);
    }
  }
  throw lastError;
};

const ensureScreenshotDir = () => {
  if (!fs.existsSync(CONFIG.screenshotDir)) {
    fs.mkdirSync(CONFIG.screenshotDir, { recursive: true });
  }
};

const captureFailureScreenshot = async (page, wallet, label) => {
  ensureScreenshotDir();
  const filename = `${label}-${wallet}-${Date.now()}.png`.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const filepath = path.join(CONFIG.screenshotDir, filename);
  await page.screenshot({ path: filepath, fullPage: true });
  log("Saved failure screenshot", { filepath });
};

const run = async () => {
  ensureConfig();
  const sheets = await getSheetsClient();

  const csvWallets = loadWalletsFromCsv();
  const sheetWallets = await loadWalletsFromSheet(sheets);
  const wallets = csvWallets.length ? csvWallets : sheetWallets;

  if (!wallets.length) {
    log("No wallets found to process.");
    return;
  }

  const browser = await chromium.launch({ headless: CONFIG.headless });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(CONFIG.timeoutMs);

  for (const [index, walletEntry] of wallets.entries()) {
    const rowIndex = walletEntry.rowIndex;
    const wallet = walletEntry.wallet;
    if (!wallet) {
      log("Skipping empty wallet row", { rowIndex });
      continue;
    }
    if (walletEntry.activities && walletEntry.holdingsPnl) {
      log("Skipping already processed row", { rowIndex, wallet });
      continue;
    }

    log("Processing wallet", { index: index + 1, wallet, rowIndex });

    const activitiesValue = await withRetries(
      async () => {
        await page.goto(`https://solscan.io/account/${wallet}#activities`, {
          waitUntil: "domcontentloaded",
        });
        await waitIfVerification(page, "Solscan");
        return extractSolscanActivities(page);
      },
      { label: `solscan-${wallet}`, attempts: CONFIG.maxRetries },
    ).catch(async (error) => {
      await captureFailureScreenshot(page, wallet, "solscan");
      throw error;
    });

    await sleep(CONFIG.rateLimitMs);

    const pnlValue = await withRetries(
      async () => {
        await page.goto(`https://jup.ag/portfolio/${wallet}`, {
          waitUntil: "domcontentloaded",
        });
        await waitIfVerification(page, "Jupiter");
        return extractJupiterHoldingsPnl(page);
      },
      { label: `jupiter-${wallet}`, attempts: CONFIG.maxRetries },
    ).catch(async (error) => {
      await captureFailureScreenshot(page, wallet, "jupiter");
      throw error;
    });

    await writeSheetValues(sheets, rowIndex, activitiesValue, pnlValue);
    log("Updated sheet row", { rowIndex, activitiesValue, pnlValue });

    await sleep(CONFIG.rateLimitMs);
  }

  await browser.close();
};

run().catch((error) => {
  log("Fatal error", { error: error.message });
  process.exit(1);
});
