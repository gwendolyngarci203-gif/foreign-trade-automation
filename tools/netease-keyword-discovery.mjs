import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateKeyword } from "../app/keyword-collection.mjs";

const keyword = validateKeyword(process.argv[2]);
const direction = process.argv[3] === "supplier" ? "supplier" : "buyer";
const pageNumber = Number.parseInt(process.argv[4] || "1", 10);
const outputDir = process.argv[5] || path.join("outputs", `${new Date().toISOString().slice(0, 10).replaceAll("-", "")}_keyword_discovery_checkpoint`);
if (!Number.isInteger(pageNumber) || pageNumber < 1) throw new Error("Page must be a positive integer");

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_MODULE_PATH
  || "C:\\Users\\18395\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\node_modules\\playwright";
const { chromium } = require(playwrightPath);
const browser = await chromium.connectOverCDP(process.env.EDGE_CDP_ENDPOINT || "http://127.0.0.1:9223");

try {
  const page = browser.contexts().flatMap((context) => context.pages())
    .find((candidate) => /waimao\.office\.163\.com/.test(candidate.url()));
  if (!page) throw new Error("NetEase page not found");
  const route = direction === "supplier" ? "supplierSearch" : "globalSearch";
  if (!new RegExp(`page=${route}`).test(page.url())) {
    await page.locator(`a[href=\"/#wmData?page=${route}\"]:visible`).first().click();
    await page.waitForTimeout(1_200);
  }
  const input = page.locator('input[placeholder*="关键词"]:visible, input[placeholder*="关键字"]:visible, input[placeholder*="搜索"]:visible').first();
  await input.waitFor({ timeout: 30_000 });
  await input.fill(keyword);
  await input.press("Enter");
  await page.getByRole("button", { name: "搜索", exact: true }).click().catch(() => {});
  if (pageNumber > 1) {
    const jumper = page.locator(".ant-pagination-options-quick-jumper input:visible");
    await jumper.fill(String(pageNumber));
    await jumper.press("Enter");
  }
  await page.waitForFunction(() => [...document.querySelectorAll("table")]
    .some((table) => (table.offsetWidth || table.offsetHeight) && table.querySelectorAll("tr[data-row-key], tbody tr").length > 0), undefined, { timeout: 30_000 });
  await page.waitForTimeout(500);
  const state = await page.evaluate(({ expectedKeyword, expectedPage, expectedDirection }) => {
    const text = document.body?.innerText || "";
    const visible = (element) => element && (element.offsetWidth || element.offsetHeight);
    const table = [...document.querySelectorAll("table")].find((candidate) => visible(candidate) && candidate.querySelectorAll("tr[data-row-key], tbody tr").length);
    const rows = table ? [...table.querySelectorAll("tr[data-row-key], tbody tr")].filter((row) => row.cells.length > 1) : [];
    return {
      url: location.href,
      resultTotal: Number((text.match(/为您找到\s*([0-9,]+)\s*个结果/) || [])[1]?.replaceAll(",", "") || 0),
      safety: {
        captcha: /(?:需要|请|点击|输入|完成|人机|安全).{0,20}(?:验证码|安全验证)|(?:验证码|安全验证).{0,20}(?:弹窗|输入|失败|过期|重试)/.test(text) || [...document.querySelectorAll('[id*="captcha" i], [class*="captcha" i], input[placeholder*="验证码"]')].some(visible),
        rateLimited: /操作频繁|访问过于频繁|请求过于频繁/.test(text),
        accountError: /权限不足|暂无权限|无权访问|账号异常|登录已失效|重新登录/.test(text),
      },
      records: rows.slice(0, 100).map((row, index) => {
        const cells = [...row.cells].map((cell) => cell.innerText.trim()).filter(Boolean);
        return { page: expectedPage, row: index + 1, rowKey: row.getAttribute("data-row-key") || "", keyword: expectedKeyword, direction: expectedDirection, company: cells[0] || "", country: cells.find((cell) => /[A-Za-z]{2,}/.test(cell)) || "", cells };
      }),
    };
  }, { expectedKeyword: keyword, expectedPage: pageNumber, expectedDirection: direction });
  if (!state.records.length) throw new Error("Keyword search returned no visible rows");
  if (state.safety.captcha || state.safety.rateLimited || state.safety.accountError) throw new Error(`Safety boundary: ${JSON.stringify(state.safety)}`);
  const snapshot = {
    schemaVersion: 1,
    kind: "netease-keyword-discovery",
    query: keyword,
    normalizedKeyword: keyword,
    direction,
    capturedAt: new Date().toISOString(),
    dynamicSnapshot: true,
    pagination: { pageNumber, visibleRows: state.records.length },
    source: { platform: "网易外贸通", page: `关键词检索/${direction === "supplier" ? "供应商" : "采购商"}`, url: state.url, query: keyword, direction, resultTotal: state.resultTotal, pageNumber, visibleRows: state.records.length },
    safety: { ...state.safety, hiddenApiUsed: false, deepMiningUsed: false },
    records: state.records,
  };
  const outputPath = path.join(outputDir, `netease_keyword_page_${String(pageNumber).padStart(3, "0")}.json`);
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outputPath, keyword, direction, resultTotal: state.resultTotal, visibleRows: state.records.length, safety: state.safety }, null, 2));
} finally {
  await browser.close();
}
