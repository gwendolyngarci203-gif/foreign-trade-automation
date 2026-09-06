import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { spawn } from "node:child_process";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns/promises";
import { fileURLToPath } from "node:url";
import {
  COLLECTION_SIGNALS,
  SEVERE_PLATFORM_SIGNALS,
  STRUCTURE_SIGNALS,
  claimBatch,
  collectionBoundaryReport,
  collectionQueueView,
  completeBatch,
  createOrSyncQueue,
  normalizeCompanyName,
  requeueFailedItems,
  releaseExpiredLease,
  setQueueState,
} from "./contact-collection.mjs";
import {
  validateKeyword,
  keywordCollectionManifest,
  countryBusinessCollectionManifest,
  validateCountry,
  validateBusinessKeywords,
} from "./keyword-collection.mjs";
import { resolveCompanyProcessingStrategy } from "./company-processing-strategy.mjs";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceDir = path.resolve(appDir, "..");
const publicDir = path.join(appDir, "public");
const campaignPath = process.env.CAMPAIGN_PATH || path.join(appDir, "data", "campaigns.json");
const validationPath = process.env.VALIDATION_PATH || path.join(appDir, "data", "contact-validation.json");
const suppressionPath = process.env.SUPPRESSION_PATH || path.join(appDir, "data", "suppressions.json");
const operationsPath = process.env.OPERATIONS_PATH || path.join(appDir, "data", "operations.json");
const contactCollectionPath = process.env.CONTACT_COLLECTION_PATH || path.join(appDir, "data", "contact-collection.json");
const contactCollectionArtifactDir = process.env.CONTACT_COLLECTION_ARTIFACT_DIR || path.join(workspaceDir, "outputs", "contact-collection-batches");
const pipelinePath = process.env.PIPELINE_PATH || path.join(appDir, "data", "pipeline.json");
const pipelineArtifactDir = process.env.PIPELINE_ARTIFACT_DIR || path.join(path.dirname(pipelinePath), "pipeline-artifacts");
const pipelineInputDir = process.env.PIPELINE_INPUT_ROOT || path.join(workspaceDir, "deploy", "runtime-data", "pipeline-inputs");
const outboxPath = process.env.OUTBOX_PATH || path.join(appDir, "data", "outbox.json");
const runtimeStatePath = process.env.RUNTIME_STATE_PATH || path.join(appDir, "data", "runtime-state.json");
const senderProfilePath = process.env.SENDER_PROFILE_PATH || path.join(appDir, "data", "sender-profile.json");
const senderAccountsPath = process.env.SENDER_ACCOUNTS_PATH || path.join(appDir, "data", "sender-accounts.json");
const mailboxStorePath = process.env.MAILBOX_STORE_PATH || path.join(appDir, "data", "mailboxes.json");
const mailboxReplyPath = process.env.MAILBOX_REPLY_STORE_PATH || path.join(appDir, "data", "mailbox-replies.json");
const mailboxAccountsPath = String(process.env.MAILBOX_ACCOUNTS_PATH || "").trim();
const unsubscribeHmacSecretFile = process.env.UNSUBSCRIBE_HMAC_SECRET_FILE || path.join(workspaceDir, "退订HMAC密钥.txt");
const localBackupDir = process.env.LOCAL_BACKUP_DIR || path.join(appDir, "data", "backups");
const emailTemplateLibraryPath = process.env.EMAIL_TEMPLATE_LIBRARY_PATH || path.join(appDir, "data", "email-template-library.json");
const emailAssetStorePath = process.env.EMAIL_ASSET_STORE_PATH || path.join(appDir, "data", "email-assets.json");
const managedPlanPath = process.env.MANAGED_PLAN_PATH || path.join(workspaceDir, "plans", "managed-hscode-plan.json");
const managedHistoryReportPath = process.env.MANAGED_HISTORY_REPORT_PATH || path.join(appDir, "data", "managed-history-report.json");
const releaseMetadataPath = process.env.RELEASE_METADATA_PATH || path.join(workspaceDir, "deploy", "release.json");
const sourcePath = process.env.SOURCE_PATH || path.join(
  workspaceDir,
  "采集输出",
  "深圳市金豪彩色印刷有限公司_网易前20买家联系方式_2026-07-19.json",
);

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const OPENAI_BASE_URL = (String(process.env.OPENAI_BASE_URL || "").trim() || "https://kuaipao.pro/v1").replace(/\/+$/, "");
const OPENAI_MODEL = String(process.env.OPENAI_MODEL || "").trim() || "gpt-5.6-sol";
const OPENAI_PROXY_URL = String(process.env.OPENAI_PROXY_URL || "").trim();
const FEEDBACK_WEBHOOK_SECRET = String(process.env.FEEDBACK_WEBHOOK_SECRET || "").trim();
const OPS_ALERT_EMAIL = String(process.env.OPS_ALERT_EMAIL || "").trim().toLowerCase();
const MAILBOX_REPLY_ENABLED = envEnabled(process.env.MAILBOX_REPLY_ENABLED);
const MAILBOX_REPLY_DAILY_LIMIT = boundedInteger(process.env.MAILBOX_REPLY_DAILY_LIMIT, 50, 1, 200);
const MAX_AI_CONTEXT_CHARS = 4000;
const AI_MIN_INTERVAL_MS = boundedInteger(process.env.AI_MIN_INTERVAL_MS, 1500, 250, 60000);
const EMAIL_TEMPLATE_LIBRARY = JSON.parse(await fs.readFile(emailTemplateLibraryPath, "utf8"));
let lastAiRequestAt = 0;
let aiRequestInFlight = false;
let backupMergeInFlight = false;
let activeStoreMutations = 0;
let campaignMutationTail = Promise.resolve();
const campaignSendsInFlight = new Set();
const pipelineSendsInFlight = new Set();
let centralBatchSendInFlight = false;
const mailboxRepliesInFlight = new Set();
const jsonWriteTails = new Map();

const PIPELINE_STAGES = [
  "discovery",
  "trade_normalization",
  "buyer_matching",
  "contact_enrichment",
  "validation",
  "drafting",
  "approval",
  "sending",
  "feedback",
];
const PIPELINE_STATUSES = new Set(["queued", "running", "waiting_input", "batch_review", "circuit_open", "paused", "completed"]);
const CONTROL_PLANE_DAILY_POLICY_LIMIT = 1000;
const CONTROL_PLANE_UNITS = Object.freeze({
  managedTimer: "dakings-managed-collection.timer",
  managedService: "dakings-managed-collection.service",
  pipelineTimer: "dakings-pipeline-worker.timer",
  pipelineService: "dakings-pipeline-worker.service",
});
let controlPlaneProbeCache = { expiresAt: 0, value: null };

const EMAIL_SCENARIOS = [
  {
    id: "first_touch",
    name: "首次开发信",
    goal: "Use one buyer-specific relevance sentence, introduce the matching print capability, and ask for one specification or RFQ.",
    wordRange: [80, 130],
    maxAssets: 1,
    requiredFields: ["hsCode", "productFocus", "buyerEvidence"],
  },
  {
    id: "factory_proof",
    name: "工厂能力信",
    goal: "Support a relevant production discussion with approved factory evidence and a practical project-level call to action.",
    wordRange: [85, 140],
    maxAssets: 1,
    requiredFields: ["hsCode", "productFocus", "buyerEvidence"],
  },
  {
    id: "exhibition_booth",
    name: "展会展位邀请",
    goal: "Invite the recipient to a verified booth with concise date, booth and venue details, then ask for a meeting time.",
    wordRange: [70, 125],
    maxAssets: 2,
    requiredFields: ["hsCode", "productFocus", "buyerEvidence", "eventName", "eventDates", "eventBooth", "eventAddress"],
  },
  {
    id: "exhibition_city_visit",
    name: "展会当地拜访",
    goal: "Offer either an exhibition meeting or a short company visit in the same city without creating pressure.",
    wordRange: [75, 130],
    maxAssets: 2,
    requiredFields: ["hsCode", "productFocus", "buyerEvidence", "eventName", "eventDates", "meetingLocation"],
  },
  {
    id: "exhibitor_meeting",
    name: "对参展商约见",
    goal: "Reference the recipient's verified exhibitor status and request a brief booth meeting around the matching product category.",
    wordRange: [70, 120],
    maxAssets: 2,
    requiredFields: ["hsCode", "productFocus", "buyerEvidence", "eventName"],
  },
];

const GUARDED_CLAIMS = [
  { id: "experience_33_years", label: "33年印刷经验", text: "DaKings Cultural and Creative Co., Ltd has more than 33 years of printing experience.", pattern: /33\s+years?/i },
  { id: "named_client_references", label: "Walmart / National Geographic客户背书", text: "DaKings Cultural and Creative Co., Ltd is an approved printing supplier for Walmart books and National Geographic publications.", pattern: /walmart|national geographic/i },
  { id: "open_account_terms", label: "OA账期", text: "Open Account payment terms are approved for this specific prospect.", pattern: /open account|\bOA\b/i },
  { id: "fifteen_day_lead_time", label: "15天交期", text: "A 15-day production lead time is verified for the relevant specification and quantity.", pattern: /15[-\s]?day/i },
  { id: "factory_photos", label: "工厂照片可对外使用", text: "The selected factory photograph is approved for external outreach.", pattern: /factory (?:photo|picture|image)/i },
  { id: "portfolio_images", label: "作品图可对外使用", text: "The selected portfolio images are approved for external outreach.", pattern: /portfolio (?:photo|picture|image)|recent printed project/i },
];

let EMAIL_ASSETS = [
  { id: "children_books", label: "儿童书作品", url: "/assets/email/children-books.jpg", file: "assets/email/children-books.jpg", tags: ["4903000", "first_touch", "exhibition"], requiredClaim: "portfolio_images" },
  { id: "colored_edge_books", label: "彩边书工艺", url: "/assets/email/colored-edge-books.jpg", file: "assets/email/colored-edge-books.jpg", tags: ["books", "finishing", "first_touch"], requiredClaim: "portfolio_images" },
  { id: "factory_floor", label: "工厂与设备", url: "/assets/email/factory-floor.jpg", file: "assets/email/factory-floor.jpg", tags: ["factory_proof"], requiredClaim: "factory_photos" },
  { id: "comic_art_books", label: "漫画与艺术书", url: "/assets/email/comic-art-books.jpg", file: "assets/email/comic-art-books.jpg", tags: ["comic", "art_book", "exhibition"], requiredClaim: "portfolio_images" },
  { id: "tarot_packaging", label: "塔罗书卡套装", url: "/assets/email/tarot-packaging.jpg", file: "assets/email/tarot-packaging.jpg", tags: ["tarot", "packaging", "exhibition"], requiredClaim: "portfolio_images" },
  { id: "cards_board_games", label: "卡牌与桌游", url: "/assets/email/cards-board-games.jpg", file: "assets/email/cards-board-games.jpg", tags: ["cards", "board_games", "exhibition"], requiredClaim: "portfolio_images" },
  { id: "premium_books_set", label: "高端书籍套装", url: "/assets/email/premium-books-set.jpg", file: "assets/email/premium-books-set.jpg", tags: ["premium_books", "slipcase", "exhibition"], requiredClaim: "portfolio_images" },
  { id: "games_packaging", label: "游戏与包装产品", url: "/assets/email/games-packaging.jpg", file: "assets/email/games-packaging.jpg", tags: ["games", "packaging", "exhibition"], requiredClaim: "portfolio_images" },
  { id: "collectible_books", label: "收藏类书籍", url: "/assets/email/collectible-books.jpg", file: "assets/email/collectible-books.jpg", tags: ["collectible", "comic", "exhibition"], requiredClaim: "portfolio_images" },
];

const customEmailAssets = await readJsonStore(emailAssetStorePath, { version: 1, assets: [] });
EMAIL_ASSETS = [...EMAIL_ASSETS, ...(Array.isArray(customEmailAssets.assets) ? customEmailAssets.assets : [])
  .filter((asset) => asset && /^asset_[a-zA-Z0-9_-]{8,80}$/.test(String(asset.id || ""))
    && /^image\/(?:jpeg|png|webp)$/.test(String(asset.mimeType || ""))
    && String(asset.file || "").startsWith("assets/uploads/"))];

const SCENARIO_BY_ID = new Map(EMAIL_SCENARIOS.map((item) => [item.id, item]));
const CLAIM_BY_ID = new Map(GUARDED_CLAIMS.map((item) => [item.id, item]));
const ASSET_BY_ID = new Map(EMAIL_ASSETS.map((item) => [item.id, item]));

for (const scenario of EMAIL_SCENARIOS) {
  if (!EMAIL_TEMPLATE_LIBRARY.scenarios?.[scenario.id]) {
    throw new Error(`邮件模板库缺少场景：${scenario.id}`);
  }
}

function envEnabled(value) {
  return /^(1|true|yes)$/i.test(String(value || ""));
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, minimum), maximum) : fallback;
}

const deliveryConfig = {
  enabled: envEnabled(process.env.EMAIL_SENDING_ENABLED),
  allowUnverified: envEnabled(process.env.EMAIL_ALLOW_UNVERIFIED),
  host: String(process.env.SMTP_HOST || "").trim(),
  port: boundedInteger(process.env.SMTP_PORT, 465, 1, 65535),
  secure: process.env.SMTP_SECURE === undefined ? true : envEnabled(process.env.SMTP_SECURE),
  startTls: envEnabled(process.env.SMTP_STARTTLS),
  rejectUnauthorized: process.env.SMTP_TLS_REJECT_UNAUTHORIZED === undefined
    ? true
    : envEnabled(process.env.SMTP_TLS_REJECT_UNAUTHORIZED),
  allowInsecureAuth: envEnabled(process.env.SMTP_ALLOW_INSECURE_AUTH),
  user: String(process.env.SMTP_USER || "").trim(),
  pass: String(process.env.SMTP_PASS || ""),
  from: String(process.env.SMTP_FROM || "").trim(),
  replyTo: String(process.env.EMAIL_REPLY_TO || "").trim(),
  fromName: "",
  unsubscribeUrl: String(process.env.EMAIL_UNSUBSCRIBE_URL || "").trim(),
  unsubscribeReplyMailbox: String(process.env.EMAIL_UNSUBSCRIBE_REPLY_MAILBOX || "").trim(),
  physicalAddress: String(process.env.EMAIL_PHYSICAL_ADDRESS || "").trim(),
  batchLimit: boundedInteger(process.env.SEND_BATCH_LIMIT, 500, 1, 1000),
  dailyLimit: boundedInteger(process.env.SEND_DAILY_LIMIT, 500, 1, 1000),
  accountDailyLimit: boundedInteger(process.env.SEND_ACCOUNT_DAILY_LIMIT, 50, 1, 100),
  delayMs: boundedInteger(process.env.SEND_DELAY_MS, 2000, 500, 30000),
};
const MAX_PIPELINE_CONTACTS_PER_COMPANY_DAILY = 2;

const DEFAULT_SENDER_PROFILE = {
  version: 1,
  status: "placeholder",
  identityMode: "company_first_round",
  senderName: "",
  senderTitle: "",
  companyLegalName: "DaKings Cultural and Creative Co., Ltd",
  companyLegalNameZh: "广州华锐文化创意有限公司",
  companyAliases: ["Guangzhou DaKings Printing Co., Ltd", "DaKings Printing Company", "Dakings Printing"],
  unifiedSocialCreditCode: "",
  legalRepresentative: "",
  registeredCapital: "",
  establishedDate: "",
  businessTerm: "",
  registrationAddress: "",
  businessScope: "",
  legalIdentityStatus: "unconfirmed",
  legalIdentityConfirmedAt: "",
  legalIdentityConfirmedBy: "",
  companyDisplayName: "DaKings Printing Company",
  senderEmail: "maggie1@dakingscc.cc",
  replyTo: "maggie1@dakingscc.cc",
  phone: "[待填写：电话]",
  website: "[待填写：公司网址]",
  physicalAddress: "[待填写：完整实体地址]",
  unsubscribeMode: "reply_only",
  unsubscribeBaseUrl: "",
  unsubscribeReplyMailbox: "maggie1@dakingscc.cc",
  replyRouting: "company_inbox",
  secondRound: {
    status: "reserved_blank",
    subject: "",
    body: ""
  },
  updatedAt: null,
  updatedBy: null,
};

const senderProfileStore = await readJsonStore(senderProfilePath, DEFAULT_SENDER_PROFILE);
Object.assign(senderProfileStore, { ...DEFAULT_SENDER_PROFILE, ...senderProfileStore });
senderProfileStore.secondRound = { ...DEFAULT_SENDER_PROFILE.secondRound, ...(senderProfileStore.secondRound || {}) };
const senderAccountsStore = await readJsonStore(senderAccountsPath, { version: 2, domains: [] });
const mailboxAccountsStore = mailboxAccountsPath
  ? await readJsonStore(mailboxAccountsPath, { version: 1, accounts: [] })
  : { version: 1, accounts: [] };
const mailboxReplyStore = await readJsonStore(mailboxReplyPath, { version: 1, entries: [] });
let unsubscribeHmacSecret = "";
try {
  const rawSecret = await fs.readFile(unsubscribeHmacSecretFile, "utf8");
  unsubscribeHmacSecret = rawSecret.match(/Base64URL）[:：]\s*([A-Za-z0-9_-]{43,})/)?.[1] || "";
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
function syncDeliveryFromSenderProfile() {
  deliveryConfig.from = String(process.env.SMTP_FROM || senderProfileStore.senderEmail || "").trim();
  deliveryConfig.fromName = String(senderProfileStore.companyDisplayName || senderProfileStore.companyLegalName || "").trim();
  deliveryConfig.replyTo = String(process.env.EMAIL_REPLY_TO || senderProfileStore.replyTo || "").trim();
  deliveryConfig.unsubscribeUrl = ["hosted_link", "hosted_link_and_reply"].includes(senderProfileStore.unsubscribeMode)
    ? String(process.env.EMAIL_UNSUBSCRIBE_URL || senderProfileStore.unsubscribeBaseUrl || "").trim()
    : "";
  deliveryConfig.unsubscribeReplyMailbox = String(process.env.EMAIL_UNSUBSCRIBE_REPLY_MAILBOX || senderProfileStore.unsubscribeReplyMailbox || deliveryConfig.replyTo || "").trim();
  deliveryConfig.physicalAddress = String(process.env.EMAIL_PHYSICAL_ADDRESS || senderProfileStore.physicalAddress || "").trim();
}
syncDeliveryFromSenderProfile();

function isSmtpConfigured() {
  return Boolean(deliveryConfig.host && deliveryConfig.user && deliveryConfig.pass && deliveryConfig.from);
}

function mailboxAccountConfig(address) {
  const normalized = normalize(address);
  const account = (mailboxAccountsStore.accounts || []).find((item) => normalize(item.address || item.user) === normalized && item.enabled !== false);
  if (!account) return null;
  const user = String(account.address || account.user || "").trim().toLowerCase();
  const pass = String(account.password || account.pass || "");
  const smtpHost = String(account.smtpHost || "smtp.qiye.aliyun.com").trim();
  const smtpPort = boundedInteger(account.smtpPort, 465, 1, 65535);
  if (!validEmail(user) || !pass || !smtpHost) return null;
  return {
    host: smtpHost,
    port: smtpPort,
    secure: account.smtpSecure === undefined ? true : Boolean(account.smtpSecure),
    startTls: Boolean(account.smtpStartTls),
    rejectUnauthorized: account.rejectUnauthorized === undefined ? true : Boolean(account.rejectUnauthorized),
    allowInsecureAuth: process.env.ALLOW_INSECURE_SMTP_FOR_TESTS === "1" && Boolean(account.smtpAllowInsecureAuth),
    user,
    pass,
    from: user,
    fromName: String(senderProfileStore.companyDisplayName || senderProfileStore.companyLegalName || "DaKings").trim(),
    replyTo: user,
  };
}

function mailboxReplyUsage() {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const used = (mailboxReplyStore.entries || []).filter((entry) => (
    entry.businessDay === day && ["sending", "accepted", "uncertain"].includes(entry.status)
  )).length;
  return { day, used, limit: MAILBOX_REPLY_DAILY_LIMIT, remaining: Math.max(MAILBOX_REPLY_DAILY_LIMIT - used, 0) };
}

function mailboxSenderPriority(message) {
  const address = normalize(message.from?.address);
  const name = normalize(message.from?.name);
  return /^maggie(?:10|[1-9])@dakingscc\.(?:cc|cn)$/.test(address)
    || /^(?:postmaster|mailer-daemon)@/.test(address)
    || address === "no-reply@mailsupport.aliyun.com"
    || /post\s*master|mailer.?daemon|阿里邮箱/.test(name)
    ? 1
    : 0;
}

async function mailboxView(searchParams = new URLSearchParams()) {
  const store = await readJsonStore(mailboxStorePath, { version: 1, accounts: [], messages: [] });
  const accountFilter = normalize(searchParams.get("account"));
  const query = normalize(searchParams.get("q"));
  const configured = (mailboxAccountsStore.accounts || [])
    .filter((item) => item.enabled !== false)
    .map((item) => normalize(item.address || item.user))
    .filter((address) => mailboxAccountConfig(address));
  const statusByAddress = new Map((store.accounts || []).map((item) => [normalize(item.address), item]));
  const accounts = configured.map((address) => {
    const status = statusByAddress.get(address) || {};
    return {
      address,
      status: status.status || "waiting_sync",
      lastSyncAt: status.lastSyncAt || null,
      lastError: status.lastError || "",
      remoteInboxCount: Number(status.remoteInboxCount || 0),
      cachedCount: (store.messages || []).filter((item) => normalize(item.account) === address).length,
    };
  });
  const messages = (store.messages || []).filter((item) => {
    if (accountFilter && normalize(item.account) !== accountFilter) return false;
    if (!query) return true;
    return normalize([item.subject, item.from?.name, item.from?.address, item.snippet, item.account].join(" ")).includes(query);
  }).sort((left, right) => mailboxSenderPriority(left) - mailboxSenderPriority(right)
    || String(right.date || "").localeCompare(String(left.date || "")));
  const publicMessages = messages.slice(0, 500).map(({ bodyText, ...item }) => item);
  return {
    configured: configured.length > 0,
    replyEnabled: MAILBOX_REPLY_ENABLED,
    updatedAt: store.updatedAt || null,
    accounts,
    counts: {
      accounts: accounts.length,
      synced: accounts.filter((item) => item.status === "synced").length,
      messages: messages.length,
      unread: messages.filter((item) => item.unread).length,
      repliesAccepted: (mailboxReplyStore.entries || []).filter((item) => item.status === "accepted").length,
    },
    replyUsage: mailboxReplyUsage(),
    messages: publicMessages,
    replies: (mailboxReplyStore.entries || []).slice(-100).reverse().map(({ providerResponse, ...entry }) => entry),
  };
}

const workflow = [
  { id: "scope", order: 1, name: "任务与主体冻结", status: "complete", progress: 100, output: "公司名/HSCode双入口、角色归因和权限边界已固化" },
  { id: "customs", order: 2, name: "贸易记录与买家发现", status: "complete", progress: 100, output: "当前Hung Hing + Amity批次已冻结1,328家独立买家公司" },
  { id: "buyers", order: 3, name: "买家队列与金额保留", status: "complete", progress: 100, output: "全量买家保留；金额和置信度只排序、不删行" },
  { id: "matching", order: 4, name: "买家公司精确匹配", status: "complete", progress: 100, output: "1,328/1,328家公司均已形成可审计处理结果" },
  { id: "contacts", order: 5, name: "联系人补全与去重", status: "complete", progress: 100, output: "6,617条平台记录、6,424条解析记录、6,219名去重联系人" },
  { id: "validation", order: 6, name: "邮箱与在职验证", status: "complete", progress: 100, output: "已按托管低门槛策略完成格式、域名/MX、公司归属、去重和抑制检查；网易来源联系人进入可发送候选，明确退订、投诉和硬退信仍强制拦截" },
  { id: "drafting", order: 7, name: "个性化邮件起草", status: "complete", progress: 100, output: "托管任务按公司每日最多两位联系人自动生成并持久化模板草稿，集中批次可直接读取" },
  { id: "sending", order: 8, name: "SMTP受控发送", status: "complete", progress: 100, output: "服务器端10个账号、统一容量服务、防重、限速、熔断和冷却恢复均已验收；真实发送仍受开关与合规门控" },
  { id: "feedback", order: 9, name: "退信退订与回复闭环", status: "partial", progress: 95, output: "十账号统一收件、回信处理台、同账号人工发件/回复、六类反馈、抑制和自动停机已上线；保留自然新回复的持续归因验收" },
];

const confidenceRank = { "高": 3, "中高": 2, "中": 1, "低": 0 };

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function stableId(...parts) {
  return crypto.createHash("sha1").update(parts.map((part) => String(part || "")).join("|")).digest("hex").slice(0, 16);
}

function rolePriority(title, name) {
  const text = `${title || ""} ${name || ""}`.toLowerCase();
  if (/purch|procure|supply|production|operation|sourcing|buyer/.test(text)) return "A-采购/运营";
  if (/director|manager|owner|founder|president|chair|chief|ceo|general manager/.test(text)) return "B-管理层";
  if (/editor|marketing|product|account|sales|finance|customer/.test(text)) return "C-相关角色";
  return "D-其他/公共";
}

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

async function readSource() {
  const raw = await fs.readFile(sourcePath, "utf8");
  return JSON.parse(raw);
}

async function readCampaigns() {
  try {
    return JSON.parse(await fs.readFile(campaignPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeCampaigns(campaigns) {
  await writeJsonStore(campaignPath, campaigns);
}

async function readJsonStore(filePath, fallback) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : structuredClone(fallback);
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(fallback);
    throw error;
  }
}

async function writeJsonStore(filePath, value) {
  const snapshot = JSON.stringify(value, null, 2);
  const previous = jsonWriteTails.get(filePath) || Promise.resolve();
  const write = previous.catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try {
      await fs.writeFile(tmp, snapshot, "utf8");
      await fs.rename(tmp, filePath);
    } catch (error) {
      await fs.unlink(tmp).catch(() => {});
      throw error;
    }
  });
  jsonWriteTails.set(filePath, write);
  try {
    await write;
  } finally {
    if (jsonWriteTails.get(filePath) === write) jsonWriteTails.delete(filePath);
  }
}

async function withCampaignMutation(task) {
  const previous = campaignMutationTail;
  let release;
  campaignMutationTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}

function emailFingerprint(value) {
  return crypto.createHash("sha256").update(normalize(value)).digest("hex");
}

function publicFingerprint(value) {
  return String(value || "").slice(0, 12);
}

function buildModel(source, managedHistory = null) {
  const matchesByBuyer = new Map(
    source.top20_company_and_contacts.map((item, index) => [
      normalize(item.query_name),
      { ...item, buyerRank: index + 1 },
    ]),
  );

  const buyers = source.all_buyers
    .map((buyer, index) => {
      const match = matchesByBuyer.get(normalize(buyer.buyer));
      const contacts = match?.contacts || [];
      return {
        id: stableId("buyer", buyer.buyer, buyer.country),
        sourceIndex: index + 1,
        buyerRank: match?.buyerRank || null,
        buyer: buyer.buyer,
        country: buyer.country,
        amountUsd: asNumber(buyer.amount_usd),
        sharePct: asNumber(buyer.share_pct),
        lastTradeDate: buyer.last_trade_date,
        tradeCount: asNumber(buyer.trade_count),
        enrichmentStatus: match ? "已补全" : "待补全",
        matchedCompany: match?.meta?.matched_company || match?.chosen?.display_name || "",
        matchConfidence: match?.match_confidence || "未匹配",
        matchNote: match?.match_note || "",
        website: match?.meta?.website || match?.chosen?.website || "",
        companyPhone: match?.meta?.company_phone || "",
        address: match?.meta?.address || "",
        claimedContacts: asNumber(match?.meta?.contact_count ?? match?.chosen?.contact_count),
        accessibleContacts: asNumber(match?.accessible_contact_rows),
        emailRows: contacts.filter((contact) => contact.email).length,
        phoneRows: contacts.filter((contact) => contact.phone).length,
        linkedinRows: contacts.filter((contact) => contact.linkedin).length,
      };
    })
    .sort((a, b) => b.amountUsd - a.amountUsd);

  const seenContactKeys = new Set();
  const seenEmails = new Set();
  const contacts = [];

  for (const item of source.top20_company_and_contacts) {
    const company = item.meta?.matched_company || item.chosen?.display_name || item.query_name;
    for (const contact of item.contacts || []) {
      const email = normalize(contact.email);
      const phone = String(contact.phone || "").trim();
      const linkedin = normalize(contact.linkedin);
      const key = `${normalize(company)}|${email}|${phone}|${linkedin}`;
      const duplicate = seenContactKeys.has(key);
      const duplicateEmail = email ? seenEmails.has(email) : false;
      seenContactKeys.add(key);
      if (email) seenEmails.add(email);
      contacts.push({
        id: stableId("contact", item.query_name, key, contact.name),
        rawBuyerName: item.query_name,
        country: item.trade?.country || "",
        amountUsd: asNumber(item.trade?.amount_usd),
        buyerRank: source.top20_company_and_contacts.indexOf(item) + 1,
        matchedCompany: company,
        matchConfidence: item.match_confidence || "",
        website: item.meta?.website || item.chosen?.website || "",
        name: contact.name || "",
        title: contact.title || "",
        email: contact.email || "",
        phone,
        linkedin: contact.linkedin || "",
        source: contact.source || "",
        recentlyAdded: Boolean(contact.recently_added),
        priority: rolePriority(contact.title, contact.name),
        contactable: Boolean(email || phone || linkedin),
        validationStatus: email ? "unverified" : "not_applicable",
        duplicate,
        duplicateEmail,
      });
    }
  }

  const top20Amount = source.top20_company_and_contacts.reduce((sum, item) => sum + asNumber(item.trade?.amount_usd), 0);
  const highConfidence = source.top20_company_and_contacts.filter((item) => item.match_confidence === "高").length;
  const lowConfidence = source.top20_company_and_contacts.filter((item) => item.match_confidence === "低").length;

  return {
    source,
    buyers,
    contacts,
    summary: {
      retrievalDate: source.retrieval_date,
      supplierQuery: source.supplier_query,
      supplierAmountUsd: asNumber(source.supplier_summary?.amount_usd),
      supplierTradeCount: asNumber(source.supplier_summary?.trade_count),
      lastTradeDate: source.supplier_summary?.last_trade_date,
      buyerCount: asNumber(source.raw_buyer_count),
      buyerRowsAmountUsd: asNumber(source.raw_buyer_amount_sum_usd),
      reconciliationDifferenceUsd: asNumber(source.reconciliation_difference_usd),
      enrichedBuyerCount: source.top20_company_and_contacts.length,
      top20AmountUsd: top20Amount,
      top20CoveragePct: source.raw_buyer_amount_sum_usd ? (top20Amount / source.raw_buyer_amount_sum_usd) * 100 : 0,
      claimedContactTotal: source.top20_company_and_contacts.reduce(
        (sum, item) => sum + asNumber(item.meta?.contact_count ?? item.chosen?.contact_count),
        0,
      ),
      extractedContactRows: contacts.length,
      accessibleContactRows: asNumber(source.contact_summary?.raw_linked_rows),
      uniqueContacts: asNumber(source.contact_summary?.unique_contacts),
      uniqueEmails: asNumber(source.contact_summary?.unique_emails),
      uniquePhones: asNumber(source.contact_summary?.unique_phones),
      duplicateLinks: asNumber(source.contact_summary?.duplicate_links),
      highConfidence,
      lowConfidence,
      sendingEnabled: false,
      validationEnabled: false,
      managedHistoryQualifiedCompanies: asNumber(managedHistory?.qualifiedCompanies),
      managedHistoryQualifiedContacts: asNumber(managedHistory?.qualifiedContacts),
      managedHistoryUniqueEmails: asNumber(managedHistory?.totalUniqueContacts),
      managedHistoryReprocessedAt: managedHistory?.generatedAt || null,
    },
  };
}

const VALIDATION_STATUSES = new Set([
  "unverified",
  "syntax_valid",
  "domain_valid",
  "deliverable",
  "accept_all",
  "invalid",
  "opted_out",
]);
const SUPPRESSION_REASONS = new Set(["opted_out", "complaint", "hard_bounce", "do_not_contact", "manual"]);
const FEEDBACK_EVENT_TYPES = new Set(["unsubscribe", "complaint", "hard_bounce", "soft_bounce", "reply", "auto_reply"]);
const SAFETY_SIGNALS = new Set([
  "none",
  "captcha",
  "frequent_operation",
  "permission",
  "http_403",
  "http_429",
  "structure_error",
  "duplicate_page",
  "page_stuck",
]);
const ACTION_TYPES = new Set([
  "buyer_entry",
  "company_search",
  "company_detail",
  "qualified_company",
  "contact_page",
  "raw_contact_row",
  "checkpoint",
]);
const validationStore = await readJsonStore(validationPath, { version: 1, records: [] });
const suppressionStore = await readJsonStore(suppressionPath, { version: 1, records: [] });
const operationsStore = await readJsonStore(operationsPath, { version: 1, tasks: [] });

function migrateOperationCounters(store) {
  let changed = false;
  for (const task of Array.isArray(store.tasks) ? store.tasks : []) {
    if (!task || typeof task !== "object") continue;
    task.counters = task.counters && typeof task.counters === "object" ? task.counters : {};
    const current = Number(task.counters.qualifiedCompanies);
    const businessDate = String(task.counters.businessDate || "").slice(0, 10);
    const auditEntries = Array.isArray(task.audit) ? task.audit : [];
    const actionTotal = auditEntries
      .filter((entry) => entry?.type === "qualified_company" && entry?.counters?.businessDate === businessDate)
      .reduce((sum, entry) => sum + Math.max(0, Number(entry.count) || 0), 0);
    if (Number.isFinite(current) && current >= 0) {
      const normalized = Math.max(current, actionTotal);
      if (task.counters.qualifiedCompanies !== normalized) {
        task.counters.qualifiedCompanies = normalized;
        changed = true;
      }
      continue;
    }
    const recovered = [...auditEntries].reverse().find((entry) => (
      entry?.type === "qualified_company"
      && entry?.counters?.businessDate === businessDate
      && Number.isFinite(Number(entry.counters.qualifiedCompanies))
      && Number(entry.counters.qualifiedCompanies) >= 0
    ));
    task.counters.qualifiedCompanies = recovered ? Number(recovered.counters.qualifiedCompanies) : actionTotal;
    changed = true;
  }
  return changed;
}

async function countryBusinessCollectionStatus() {
  const groups = new Map();
  let folders = [];
  try { folders = await fs.readdir(pipelineInputDir, { withFileTypes: true }); } catch { return { items: [], totalCompanies: 0 }; }
  for (const folder of folders.filter((entry) => entry.isDirectory() && entry.name.includes("_country_business_"))) {
    const files = (await fs.readdir(path.join(pipelineInputDir, folder.name))).filter((name) => /^netease_country_business_page_\d+\.json$/.test(name));
    for (const file of files) {
      try {
        const payload = JSON.parse(await fs.readFile(path.join(pipelineInputDir, folder.name, file), "utf8"));
        const country = String(payload.country || "").trim();
        const keywords = Array.isArray(payload.normalizedBusinessKeywords) ? payload.normalizedBusinessKeywords.map((item) => String(item).trim()).filter(Boolean) : [];
        if (!country || !keywords.length || !Array.isArray(payload.records)) continue;
        const key = `${country.toLowerCase()}|${keywords.join(",").toLowerCase()}`;
        const group = groups.get(key) || { country, businessKeywords: keywords, records: [], pages: 0, latestAt: "" };
        group.records.push(...payload.records);
        group.pages += 1;
        if (String(payload.capturedAt || "") > group.latestAt) group.latestAt = String(payload.capturedAt || "");
        groups.set(key, group);
      } catch { /* ignore incomplete checkpoints */ }
    }
  }
  const items = [...groups.values()].map((group) => {
    const companies = [...new Map(group.records.map((record) => [String(record.company || "").trim().toLowerCase(), String(record.company || "").trim()]).filter(([key, value]) => key && value)).values()];
    return { country: group.country, businessKeywords: group.businessKeywords, pages: group.pages, records: group.records.length, companies: companies.length, latestAt: group.latestAt };
  }).sort((left, right) => String(right.latestAt).localeCompare(String(left.latestAt)));
  return { items, totalCompanies: items.reduce((sum, item) => sum + item.companies, 0) };
}

async function readManagedHistoryReport() {
  try {
    const report = JSON.parse(await fs.readFile(managedHistoryReportPath, "utf8"));
    return report?.kind === "managed-history-reprocess-report" ? report : null;
  } catch {
    return null;
  }
}

const operationCountersMigrated = migrateOperationCounters(operationsStore);
const contactCollectionStore = await readJsonStore(contactCollectionPath, { version: 1, queues: [] });
const pipelineStore = await readJsonStore(pipelinePath, { version: 1, jobs: [] });
const outboxStore = await readJsonStore(outboxPath, { version: 1, entries: [] });
const runtimeStateStore = await readJsonStore(runtimeStatePath, {
  version: 1,
  ai: {
    configured: Boolean(process.env.OPENAI_API_KEY),
    reachable: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: "",
  },
});
runtimeStateStore.ai = {
  configured: Boolean(process.env.OPENAI_API_KEY),
  reachable: runtimeStateStore.ai?.reachable ?? null,
  lastAttemptAt: runtimeStateStore.ai?.lastAttemptAt || null,
  lastSuccessAt: runtimeStateStore.ai?.lastSuccessAt || null,
  lastError: runtimeStateStore.ai?.lastError || "",
};
runtimeStateStore.feedback = {
  events: Array.isArray(runtimeStateStore.feedback?.events) ? runtimeStateStore.feedback.events.slice(-5000) : [],
  lastEventAt: runtimeStateStore.feedback?.lastEventAt || null,
};
const deliveryCapacityConfig = deliveryConfig;
function calculateDeliveryCapacity(now = new Date()) {
  const fleet = senderFleetUsage(now);
  const global = dailyDeliveryUsage(now);
  const uncertain = (outboxStore.entries || []).filter((entry) => entry.status === "uncertain").length;
  const blockedReasons = [];
  if (!deliveryCapacityConfig.enabled || !isSmtpConfigured()) blockedReasons.push("smtp_unavailable");
  if (runtimeStateStore.deliveryCircuit.open) blockedReasons.push("delivery_circuit_open");
  if (uncertain) blockedReasons.push("outbox_uncertain");
  if (!fleet.accounts.length) blockedReasons.push("sender_fleet_unavailable");
  const accountCapacities = fleet.accounts.map((account) => getAccountCapacity(account, now));
  const accountRemaining = accountCapacities.reduce((sum, item) => sum + item.remaining, 0);
  return {
    globalLimit: deliveryCapacityConfig.dailyLimit,
    batchLimit: deliveryCapacityConfig.batchLimit,
    accountLimits: Object.fromEntries(accountCapacities.map((item) => [item.account, item.effectiveLimit])),
    globalRemaining: global.remaining,
    accountRemaining,
    accounts: accountCapacities,
    availableCapacity: blockedReasons.length ? 0 : Math.min(global.remaining, deliveryCapacityConfig.batchLimit, accountRemaining),
    health: blockedReasons.length ? "blocked" : "healthy",
    blockedReasons,
  };
}
runtimeStateStore.companyQualification = {
  enabled: Boolean(runtimeStateStore.companyQualification?.enabled),
  targetCountries: Array.isArray(runtimeStateStore.companyQualification?.targetCountries) ? runtimeStateStore.companyQualification.targetCountries.slice(0, 100) : [],
  businessKeywords: Array.isArray(runtimeStateStore.companyQualification?.businessKeywords) ? runtimeStateStore.companyQualification.businessKeywords.slice(0, 100) : [],
  excludeKeywords: Array.isArray(runtimeStateStore.companyQualification?.excludeKeywords) ? runtimeStateStore.companyQualification.excludeKeywords.slice(0, 100) : [],
  targetHsCodes: Array.isArray(runtimeStateStore.companyQualification?.targetHsCodes) ? runtimeStateStore.companyQualification.targetHsCodes.slice(0, 100) : [],
  allowedCompanyTypes: Array.isArray(runtimeStateStore.companyQualification?.allowedCompanyTypes) ? runtimeStateStore.companyQualification.allowedCompanyTypes.slice(0, 100) : [],
  minimumScore: boundedInteger(runtimeStateStore.companyQualification?.minimumScore, 0, 0, 100),
  updatedAt: runtimeStateStore.companyQualification?.updatedAt || null,
};
runtimeStateStore.deliveryCircuit = {
  open: Boolean(runtimeStateStore.deliveryCircuit?.open),
  reason: runtimeStateStore.deliveryCircuit?.reason || "",
  openedAt: runtimeStateStore.deliveryCircuit?.openedAt || null,
  eventId: runtimeStateStore.deliveryCircuit?.eventId || "",
};
runtimeStateStore.deliveryCircuitHistory = Array.isArray(runtimeStateStore.deliveryCircuitHistory)
  ? runtimeStateStore.deliveryCircuitHistory.slice(-200)
  : [];
const DELIVERY_CIRCUIT_COOLDOWN_MS = boundedInteger(
  process.env.DELIVERY_CIRCUIT_COOLDOWN_MINUTES,
  60,
  5,
  1440,
) * 60_000;
const AUTO_RECOVERABLE_DELIVERY_CIRCUIT_REASONS = new Set([
  "rate_limit",
  "provider_temporary",
  "smtp_temporary",
  "hard_bounce",
  "complaint",
]);

function deliveryCircuitRecoveryAssessment({ manual = false, now = Date.now() } = {}) {
  const circuit = runtimeStateStore.deliveryCircuit;
  const blockers = [];
  const openedAt = Date.parse(circuit.openedAt || "");
  const unsafeOutbox = (outboxStore.entries || []).filter((entry) => ["sending", "uncertain"].includes(entry.status));
  if (!circuit.open) blockers.push("delivery_circuit_closed");
  if (circuit.open && unsafeOutbox.length) blockers.push("outbox_sending_or_uncertain");
  if (circuit.open && !manual && !AUTO_RECOVERABLE_DELIVERY_CIRCUIT_REASONS.has(circuit.reason)) {
    blockers.push("reason_requires_manual_confirmation");
  }
  if (circuit.open && !manual && (!Number.isFinite(openedAt) || now - openedAt < DELIVERY_CIRCUIT_COOLDOWN_MS)) {
    blockers.push("cooldown_not_elapsed");
  }
  if (circuit.open && ["hard_bounce", "complaint"].includes(circuit.reason)) {
    const event = runtimeStateStore.feedback.events.find((item) => item.eventId === circuit.eventId && item.type === circuit.reason);
    const suppression = event ? suppressionByHash().get(event.recipientHash) : null;
    const validation = event ? validationByHash().get(event.recipientHash) : null;
    const expectedStatus = circuit.reason === "hard_bounce" ? "invalid" : "opted_out";
    if (!event) blockers.push("feedback_event_missing");
    if (!suppression) blockers.push("recipient_not_suppressed");
    if (!validation || validation.status !== expectedStatus) blockers.push("recipient_not_invalidated");
    if (!manual && circuit.reason === "complaint") {
      const since = now - 24 * 60 * 60_000;
      const recentComplaints = runtimeStateStore.feedback.events.filter((item) => (
        item.type === "complaint" && Date.parse(item.recordedAt || "") >= since
      )).length;
      if (recentComplaints > 1) blockers.push("repeated_complaints_require_intervention");
    }
  }
  return {
    eligible: circuit.open && blockers.length === 0,
    mode: manual ? "manual" : "automatic",
    reason: circuit.reason,
    cooldownUntil: Number.isFinite(openedAt) ? new Date(openedAt + DELIVERY_CIRCUIT_COOLDOWN_MS).toISOString() : null,
    checks: {
      noSendingOrUncertain: unsafeOutbox.length === 0,
      feedbackTargetQuarantined: !blockers.includes("recipient_not_suppressed") && !blockers.includes("recipient_not_invalidated"),
    },
    blockers,
  };
}

async function recoverDeliveryCircuit(method, assessment) {
  const recoveredAt = new Date().toISOString();
  runtimeStateStore.deliveryCircuitHistory = [...runtimeStateStore.deliveryCircuitHistory, {
    ...runtimeStateStore.deliveryCircuit,
    recoveredAt,
    method,
    checks: assessment.checks,
  }].slice(-200);
  runtimeStateStore.deliveryCircuit = { open: false, reason: "", openedAt: null, eventId: "" };
  await writeJsonStore(runtimeStatePath, runtimeStateStore);
}

async function maybeRecoverDeliveryCircuit() {
  const assessment = deliveryCircuitRecoveryAssessment();
  if (!assessment.eligible) return false;
  await recoverDeliveryCircuit("automatic_safe_check", assessment);
  return true;
}
runtimeStateStore.deliveryAutomation = {
  mode: runtimeStateStore.deliveryAutomation?.mode === "auto" ? "auto" : "manual",
  updatedAt: runtimeStateStore.deliveryAutomation?.updatedAt || null,
  updatedBy: runtimeStateStore.deliveryAutomation?.updatedBy || "",
};

function managedProductionSendCount(now = new Date()) {
  const businessDate = businessDateFor(now);
  return (outboxStore.entries || []).filter((entry) => (
    String(entry.campaignId || "").startsWith("pipe_")
    && entry.kind !== "intervention_alert"
    && ["pending", "sending", "accepted", "uncertain"].includes(entry.status)
    && businessDateFor(new Date(entry.createdAt || entry.updatedAt || 0)) === businessDate
  )).length;
}

function managedDailyCycleState(now = new Date()) {
  const businessDate = businessDateFor(now);
  const stored = runtimeStateStore.managedDailyCycle?.businessDate === businessDate
    ? runtimeStateStore.managedDailyCycle
    : {};
  const productionSends = managedProductionSendCount(now);
  const collectionLocked = Boolean(stored.collectionLocked || productionSends > 0);
  return {
    businessDate,
    collectionLocked,
    collectionCompletedAt: stored.collectionCompletedAt || (productionSends > 0 ? new Date(now).toISOString() : null),
    peakCompanyCount: Number(stored.peakCompanyCount || 0),
    reason: stored.reason || (productionSends > 0 ? "production_sending_started" : ""),
    productionSends,
  };
}

async function lockManagedDailyCollection(reason, companyCount = 0) {
  const current = managedDailyCycleState();
  runtimeStateStore.managedDailyCycle = {
    ...current,
    collectionLocked: true,
    collectionCompletedAt: current.collectionCompletedAt || new Date().toISOString(),
    peakCompanyCount: Math.max(current.peakCompanyCount, Number(companyCount || 0)),
    reason: current.reason || String(reason || "inventory_target_reached").slice(0, 120),
  };
  await writeJsonStore(runtimeStatePath, runtimeStateStore);
  return runtimeStateStore.managedDailyCycle;
}

function readOnlyProcess(command, args, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let size = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`${path.basename(command)} probe timed out`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        child.kill("SIGTERM");
        return finish(new Error(`${path.basename(command)} probe output exceeded limit`));
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => finish(error));
    child.once("close", (code) => finish(
      code === 0 ? null : new Error(Buffer.concat(stderr).toString("utf8").trim() || `${path.basename(command)} exited ${code}`),
      Buffer.concat(stdout).toString("utf8"),
    ));
  });
}

function parseSystemdProperties(output) {
  return Object.fromEntries(String(output || "").split(/\r?\n/).map((line) => {
    const index = line.indexOf("=");
    return index > 0 ? [line.slice(0, index), line.slice(index + 1)] : null;
  }).filter(Boolean));
}

async function controlPlaneRuntimeProbes() {
  if (controlPlaneProbeCache.value && Date.now() < controlPlaneProbeCache.expiresAt) return controlPlaneProbeCache.value;
  const properties = ["Id", "ActiveState", "SubState", "UnitFileState", "LastTriggerUSec", "NextElapseUSecRealtime"];
  const units = await Promise.allSettled(Object.entries(CONTROL_PLANE_UNITS).map(async ([key, unit]) => {
    const output = await readOnlyProcess("/usr/bin/systemctl", ["show", unit, "--no-pager", ...properties.map((item) => `--property=${item}`)]);
    const value = parseSystemdProperties(output);
    return [key, {
      unit,
      activeState: value.ActiveState || "unknown",
      subState: value.SubState || "unknown",
      unitFileState: value.UnitFileState || "unknown",
      lastTriggerAt: value.LastTriggerUSec || null,
      nextTriggerAt: value.NextElapseUSecRealtime || null,
    }];
  }));
  const warnings = [];
  const systemd = {};
  units.forEach((result, index) => {
    const key = Object.keys(CONTROL_PLANE_UNITS)[index];
    if (result.status === "fulfilled") systemd[result.value[0]] = result.value[1];
    else {
      systemd[key] = { unit: CONTROL_PLANE_UNITS[key], activeState: "unknown", subState: "unknown", unitFileState: "unknown", lastTriggerAt: null, nextTriggerAt: null };
      warnings.push(`systemd_probe_failed:${key}`);
    }
  });
  let smtpConnections = null;
  try {
    const sockets = await readOnlyProcess("/usr/sbin/ss", ["-Htan", "state", "established"]);
    smtpConnections = sockets.split(/\r?\n/).filter((line) => /:(?:25|465|587)\s/.test(line)).length;
  } catch {
    warnings.push("smtp_socket_probe_failed");
  }
  const value = { systemd, smtpConnections, warnings };
  controlPlaneProbeCache = { value, expiresAt: Date.now() + 5000 };
  return value;
}

async function controlPlaneRelease() {
  const value = JSON.parse(await fs.readFile(releaseMetadataPath, "utf8"));
  if (value?.schemaVersion !== 1 || !/^[a-f0-9]{40}$/i.test(String(value.commit || ""))) {
    throw new Error("invalid release metadata");
  }
  return {
    commit: String(value.commit).toLowerCase(),
    shortCommit: String(value.commit).slice(0, 12).toLowerCase(),
    branch: String(value.branch || "").slice(0, 120),
    recoveryPhase: String(value.recoveryPhase || "").slice(0, 40),
    recoveryStatus: String(value.recoveryStatus || "").slice(0, 80),
    deployedAt: value.deployedAt || null,
  };
}

function controlPlaneQueueSummary(now) {
  const counts = { pending: 0, leased: 0, completed: 0, failed: 0, skipped: 0 };
  const queueStates = {};
  let expiredLeasesObserved = 0;
  for (const queue of contactCollectionStore.queues || []) {
    queueStates[queue.status || "unknown"] = Number(queueStates[queue.status || "unknown"] || 0) + 1;
    for (const item of queue.items || []) {
      const status = counts[item.status] === undefined ? "unknown" : item.status;
      counts[status] = Number(counts[status] || 0) + 1;
    }
    if (queue.activeBatchId && queue.leaseExpiresAt && Date.parse(queue.leaseExpiresAt) <= now.getTime()) expiredLeasesObserved += 1;
  }
  return {
    total: (contactCollectionStore.queues || []).length,
    queueStates,
    counts,
    activeLeases: counts.leased,
    expiredLeasesObserved,
  };
}

function controlPlaneTaskSummary() {
  const counts = {};
  const safetyStates = {};
  for (const task of operationsStore.tasks || []) {
    counts[task.status || "unknown"] = Number(counts[task.status || "unknown"] || 0) + 1;
    safetyStates[task.safetyState || "unknown"] = Number(safetyStates[task.safetyState || "unknown"] || 0) + 1;
  }
  return { total: (operationsStore.tasks || []).length, counts, safetyStates };
}

function controlPlanePipelineSummary() {
  const jobs = pipelineStore.jobs || [];
  const counts = Object.fromEntries([...PIPELINE_STATUSES].map((status) => [status, 0]));
  const stageCounts = {};
  const flow = Object.fromEntries(["discovery", "contact", "draft", "approval", "delivery"].map((stage) => [stage, 0]));
  const flowStage = (stage) => {
    if (stage === "discovery") return "discovery";
    if (["trade_normalization", "buyer_matching", "contact_enrichment", "validation"].includes(stage)) return "contact";
    if (stage === "drafting") return "draft";
    if (stage === "approval") return "approval";
    return "delivery";
  };
  for (const job of jobs) {
    counts[job.status || "unknown"] = Number(counts[job.status || "unknown"] || 0) + 1;
    stageCounts[job.currentStage || "unknown"] = Number(stageCounts[job.currentStage || "unknown"] || 0) + 1;
    flow[flowStage(job.currentStage)] += 1;
  }
  return {
    total: jobs.length,
    counts,
    stageCounts,
    flow,
    claimable: counts.queued,
    activeLeases: jobs.filter((job) => job.status === "running" && job.leaseExpiresAt).length,
  };
}

function controlPlaneOutboxSummary() {
  const statuses = ["pending", "sending", "accepted", "failed", "uncertain", "cancelled"];
  const entries = outboxStore.entries || [];
  const counts = Object.fromEntries(statuses.map((status) => [status, entries.filter((entry) => entry.status === status).length]));
  return { total: entries.length, counts, active: counts.pending + counts.sending + counts.uncertain };
}

function controlPlaneAuditTimeline(limit) {
  const items = [];
  const cleanActor = (value) => {
    const actor = String(value || "").trim();
    if (!actor) return "system";
    return actor.includes("@") ? `actor:${publicFingerprint(emailFingerprint(actor))}` : actor.slice(0, 80);
  };
  const add = (source, entityId, entries) => {
    for (const entry of entries || []) {
      const at = entry.at || entry.recordedAt || entry.recoveredAt || entry.createdAt;
      if (!at || !Number.isFinite(Date.parse(at))) continue;
      items.push({
        at,
        source,
        entityId: String(entityId || "").slice(0, 120),
        type: String(entry.type || entry.status || "state_changed").slice(0, 120),
        stage: String(entry.stage || "").slice(0, 80),
        actor: cleanActor(entry.actor || entry.owner || entry.reviewer || entry.updatedBy),
      });
    }
  };
  for (const task of operationsStore.tasks || []) add("collection", task.id, task.audit);
  for (const queue of contactCollectionStore.queues || []) add("queue", queue.id, queue.audit);
  for (const job of pipelineStore.jobs || []) add("pipeline", job.id, job.audit);
  for (const entry of outboxStore.entries || []) add("outbox", entry.id, entry.events);
  add("delivery", "delivery-circuit", runtimeStateStore.deliveryCircuitHistory);
  items.sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
  return { items: items.slice(0, limit), returned: Math.min(items.length, limit), truncated: items.length > limit };
}

async function controlPlaneStatus(auditLimit = 50) {
  const now = new Date();
  const warnings = [];
  const [releaseResult, probeResult] = await Promise.allSettled([controlPlaneRelease(), controlPlaneRuntimeProbes()]);
  const baseline = releaseResult.status === "fulfilled" ? releaseResult.value : null;
  if (!baseline) warnings.push("release_metadata_unavailable");
  const probes = probeResult.status === "fulfilled"
    ? probeResult.value
    : { systemd: {}, smtpConnections: null, warnings: ["runtime_probe_failed"] };
  warnings.push(...probes.warnings);
  const queues = controlPlaneQueueSummary(now);
  const pipeline = controlPlanePipelineSummary();
  const outbox = controlPlaneOutboxSummary();
  const cycle = managedDailyCycleState(now);
  const daily = dailyDeliveryUsage(now);
  const capacity = calculateDeliveryCapacity(now);
  const mode = runtimeStateStore.deliveryAutomation.mode;
  if (deliveryConfig.dailyLimit !== CONTROL_PLANE_DAILY_POLICY_LIMIT) warnings.push("delivery_limit_config_mismatch");
  if (cycle.collectionLocked) warnings.push("collection_locked");
  if (queues.activeLeases) warnings.push("active_queue_leases");
  if (pipeline.counts.running) warnings.push("pipeline_running");
  if (outbox.active) warnings.push("active_outbox");
  if (mode === "manual" && Number(probes.smtpConnections || 0) > 0) warnings.push("smtp_connection_while_manual");
  const managedTimer = probes.systemd.managedTimer?.activeState || "unknown";
  const pipelineTimer = probes.systemd.pipelineTimer?.activeState || "unknown";
  const unsafe = warnings.some((item) => ["active_queue_leases", "pipeline_running", "active_outbox", "smtp_connection_while_manual"].includes(item));
  const degraded = !baseline || warnings.some((item) => item.includes("probe_failed"));
  const state = unsafe ? "blocked" : degraded ? "degraded" : mode === "manual" || managedTimer !== "active" || pipelineTimer !== "active" ? "safe_hold" : "healthy";
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    readOnly: true,
    overall: { state, warnings: [...new Set(warnings)] },
    baseline,
    delivery: {
      mode,
      policyDailyLimit: CONTROL_PLANE_DAILY_POLICY_LIMIT,
      configuredDailyLimit: deliveryConfig.dailyLimit,
      effectiveDailyLimit: capacity.globalLimit,
      used: daily.used,
      remaining: Math.max(CONTROL_PLANE_DAILY_POLICY_LIMIT - daily.used, 0),
      effectiveRemaining: capacity.globalRemaining,
      automaticSendingEnabled: mode === "auto" && sendingEnabled() && !runtimeStateStore.deliveryCircuit.open,
      circuitOpen: runtimeStateStore.deliveryCircuit.open,
    },
    schedulers: {
      managed: { timer: probes.systemd.managedTimer || null, service: probes.systemd.managedService || null, persistent: true },
      pipeline: { timer: probes.systemd.pipelineTimer || null, service: probes.systemd.pipelineService || null, persistent: true },
    },
    collection: {
      engine: cycle.collectionLocked ? "locked" : probes.systemd.managedService?.activeState === "active" ? "running" : probes.systemd.managedTimer?.activeState === "active" ? "scheduled" : "stopped",
      cycle: { businessDate: cycle.businessDate, locked: cycle.collectionLocked, reason: cycle.reason, productionSends: cycle.productionSends },
      tasks: controlPlaneTaskSummary(),
    },
    queues,
    pipeline,
    outbox,
    smtp: {
      configured: isSmtpConfigured(),
      sendingEnabled: sendingEnabled(),
      automaticSendingEnabled: mode === "auto" && sendingEnabled() && !runtimeStateStore.deliveryCircuit.open,
      establishedConnections: probes.smtpConnections,
      probe: probes.smtpConnections === null ? "unknown" : "ok",
    },
    audit: controlPlaneAuditTimeline(auditLimit),
    probes: {
      releaseMetadata: baseline ? "ok" : "error",
      systemd: probes.warnings.some((item) => item.startsWith("systemd_probe_failed")) ? "error" : "ok",
      smtpSockets: probes.smtpConnections === null ? "error" : "ok",
    },
  };
}

runtimeStateStore.managedDailyCycle = managedDailyCycleState();
const pipelineTaskIds = new Set((pipelineStore.jobs || []).map((job) => job.operationTaskId).filter(Boolean));
const legacyTasksWithoutPipeline = (operationsStore.tasks || []).filter((task) => !pipelineTaskIds.has(task.id));
if (legacyTasksWithoutPipeline.length) {
  pipelineStore.jobs.unshift(...legacyTasksWithoutPipeline.map((task) => createPipelineJob(task)));
}
for (const job of pipelineStore.jobs || []) {
  if (job.automation?.mode !== "managed" || job.currentStage !== "approval" || job.status !== "waiting_input") continue;
  const now = new Date().toISOString();
  const draftedContacts = Number([...job.artifacts || []].reverse().find((item) => item.stage === "drafting")?.counts?.draftedContacts || 0);
  job.status = "batch_review";
  job.requiredInput = "草稿已完成简单核验，等待集中批次审核发送";
  job.stages.approval = { ...(job.stages?.approval || {}), status: "batch_review", updatedAt: now };
  job.batchReview = { status: "pending", draftedContacts, createdAt: now, migratedFromLegacyApproval: true };
  job.updatedAt = now;
  job.audit = [...(job.audit || []), { at: now, type: "legacy_managed_approval_migrated", draftedContacts }].slice(-1000);
}
await Promise.all([
  ...(operationCountersMigrated ? [writeJsonStore(operationsPath, operationsStore)] : []),
  writeJsonStore(pipelinePath, pipelineStore),
  writeJsonStore(outboxPath, outboxStore),
  writeJsonStore(runtimeStatePath, runtimeStateStore),
]);

async function updateAiRuntime(patch) {
  runtimeStateStore.ai = {
    ...runtimeStateStore.ai,
    configured: Boolean(process.env.OPENAI_API_KEY),
    ...patch,
  };
  await writeJsonStore(runtimeStatePath, runtimeStateStore);
}

function validationByHash() {
  return new Map((validationStore.records || []).map((item) => [item.emailHash, item]));
}

function suppressionByHash() {
  return new Map((suppressionStore.records || []).map((item) => [item.emailHash, item]));
}

function applyLocalContactState(model) {
  const validations = validationByHash();
  const suppressions = suppressionByHash();
  for (const contact of model.contacts) {
    if (!contact.email) continue;
    const hash = emailFingerprint(contact.email);
    const validation = validations.get(hash);
    contact.validationStatus = suppressions.has(hash)
      ? "opted_out"
      : (validation?.status || (validEmail(contact.email) ? "unverified" : "invalid"));
    contact.validationCheckedAt = validation?.checkedAt || "";
    contact.validationEvidence = validation?.evidence || "";
    contact.suppressed = suppressions.has(hash);
  }
}

function isSuppressed(email) {
  return Boolean(email) && suppressionByHash().has(emailFingerprint(email));
}

function upsertValidation(record) {
  const records = validationStore.records || (validationStore.records = []);
  const index = records.findIndex((item) => item.emailHash === record.emailHash);
  if (index >= 0) records[index] = { ...records[index], ...record };
  else records.push(record);
}

function secretMatches(actual, expected) {
  if (!actual || !expected) return false;
  const actualBuffer = Buffer.from(String(actual));
  const expectedBuffer = Buffer.from(String(expected));
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function upsertSuppression({ emailHash, domain, reason, source, createdAt }) {
  const records = suppressionStore.records || (suppressionStore.records = []);
  const existing = records.find((item) => item.emailHash === emailHash);
  if (existing) return { record: existing, existing: true };
  const record = { emailHash, domain, reason, source, createdAt };
  records.push(record);
  return { record, existing: false };
}

async function recordFeedbackEvent(input, source) {
  const eventId = String(input.eventId || "").trim().slice(0, 200);
  const type = String(input.type || "").trim();
  const email = normalize(input.email);
  const suppliedHash = String(input.recipientHash || "").trim().toLowerCase();
  if (!/^[a-zA-Z0-9._:-]{1,200}$/.test(eventId)) {
    throw Object.assign(new Error("反馈事件缺少有效eventId"), { status: 422 });
  }
  if (!FEEDBACK_EVENT_TYPES.has(type)) {
    throw Object.assign(new Error("不支持的反馈事件类型"), { status: 422 });
  }
  if (!validEmail(email) && !/^[a-f0-9]{64}$/.test(suppliedHash)) {
    throw Object.assign(new Error("反馈事件需要有效邮箱或recipientHash"), { status: 422 });
  }
  const existing = runtimeStateStore.feedback.events.find((item) => item.eventId === eventId && item.source === source);
  if (existing) {
    return { duplicate: true, event: existing, suppressed: isSuppressed(email), outboxMatched: Boolean(existing.outboxId) };
  }

  const recipientHash = validEmail(email) ? emailFingerprint(email) : suppliedHash;
  const domain = validEmail(email) ? email.split("@")[1] : "";
  const messageId = sanitizeHeader(input.messageId).replace(/^<|>$/g, "").slice(0, 300);
  const occurredAt = Number.isFinite(Date.parse(input.occurredAt)) ? new Date(input.occurredAt).toISOString() : new Date().toISOString();
  const recordedAt = new Date().toISOString();
  const outboxEntry = (outboxStore.entries || []).find((item) => (
    (messageId && item.messageId === messageId) || item.recipientHash === recipientHash
  ));
  if (outboxEntry) {
    outboxEntry.updatedAt = recordedAt;
    outboxEntry.events = [...(outboxEntry.events || []), {
      at: occurredAt,
      status: outboxEntry.status,
      type: `feedback_${type}`,
    }].slice(-100);
    if (["hard_bounce", "complaint", "unsubscribe"].includes(type)) {
      outboxEntry.lastError = `feedback:${type}`;
    }
  }

  const suppressionReason = {
    unsubscribe: "opted_out",
    complaint: "complaint",
    hard_bounce: "hard_bounce",
  }[type];
  let suppressed = false;
  if (suppressionReason) {
    upsertSuppression({
      emailHash: recipientHash,
      domain,
      reason: suppressionReason,
      source: `feedback:${source}`,
      createdAt: recordedAt,
    });
    upsertValidation({
      emailHash: recipientHash,
      domain,
      status: type === "hard_bounce" ? "invalid" : "opted_out",
      checkedAt: recordedAt,
      evidence: `feedback:${type}`,
      mxHosts: [],
    });
    suppressed = true;
  }

  const event = {
    eventId,
    source,
    type,
    recipientHash,
    domain,
    messageId,
    occurredAt,
    recordedAt,
    outboxId: outboxEntry?.id || "",
    campaignId: outboxEntry?.campaignId || "",
  };
  runtimeStateStore.feedback.events = [...runtimeStateStore.feedback.events, event].slice(-5000);
  runtimeStateStore.feedback.lastEventAt = recordedAt;
  if (["complaint", "hard_bounce"].includes(type)) {
    runtimeStateStore.deliveryCircuit = { open: true, reason: type, openedAt: recordedAt, eventId };
  }
  await Promise.all([
    writeJsonStore(runtimeStatePath, runtimeStateStore),
    writeJsonStore(outboxPath, outboxStore),
    writeJsonStore(suppressionPath, suppressionStore),
    writeJsonStore(validationPath, validationStore),
  ]);
  applyLocalContactState(model);
  return { duplicate: false, event, suppressed, outboxMatched: Boolean(outboxEntry) };
}

async function validateEmailDomain(email, mode = "domain") {
  const normalizedEmail = normalize(email);
  const emailHash = emailFingerprint(normalizedEmail);
  const checkedAt = new Date().toISOString();
  const domain = normalizedEmail.split("@")[1] || "";
  if (!validEmail(normalizedEmail)) {
    return { emailHash, domain, status: "invalid", checkedAt, evidence: "invalid_format", mxHosts: [] };
  }
  if (mode === "syntax") {
    return { emailHash, domain, status: "syntax_valid", checkedAt, evidence: "local_syntax", mxHosts: [] };
  }
  try {
    const mx = await dns.resolveMx(domain);
    const mxHosts = mx.sort((a, b) => a.priority - b.priority).map((item) => item.exchange).filter(Boolean).slice(0, 10);
    if (mxHosts.length) {
      return { emailHash, domain, status: "domain_valid", checkedAt, evidence: "dns_mx", mxHosts };
    }
  } catch (error) {
    if (!["ENODATA", "ENOTFOUND", "ESERVFAIL"].includes(error.code)) {
      return { emailHash, domain, status: "syntax_valid", checkedAt, evidence: `dns_temporary:${error.code || "error"}`, mxHosts: [] };
    }
  }
  try {
    const addresses = await dns.resolve(domain);
    if (addresses.length) {
      return { emailHash, domain, status: "domain_valid", checkedAt, evidence: "dns_address_fallback", mxHosts: [] };
    }
  } catch (error) {
    if (!["ENODATA", "ENOTFOUND", "ESERVFAIL"].includes(error.code)) {
      return { emailHash, domain, status: "syntax_valid", checkedAt, evidence: `dns_temporary:${error.code || "error"}`, mxHosts: [] };
    }
  }
  return { emailHash, domain, status: "invalid", checkedAt, evidence: "domain_not_resolved", mxHosts: [] };
}

function publicValidationSummary(model) {
  const linkCounts = model.contacts.reduce((result, item) => {
    const key = item.validationStatus || "unverified";
    result[key] = (result[key] || 0) + 1;
    return result;
  }, {});
  const counts = model.contacts.filter((item) => !item.email || !item.duplicateEmail).reduce((result, item) => {
    const key = item.validationStatus || "unverified";
    result[key] = (result[key] || 0) + 1;
    return result;
  }, {});
  return {
    counts,
    linkCounts,
    storedRecords: (validationStore.records || []).length,
    suppressions: (suppressionStore.records || []).length,
    records: (validationStore.records || []).slice(-100).reverse().map((item) => ({
      fingerprint: publicFingerprint(item.emailHash),
      domain: item.domain,
      status: item.status,
      checkedAt: item.checkedAt,
      evidence: item.evidence,
      mxCount: item.mxHosts?.length || 0,
    })),
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function backupDigest(payload) {
  return crypto.createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

async function createLocalBackup() {
  const payload = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    sourceFile: path.basename(sourcePath),
    scope: "local_control_state_only",
    stores: {
      contactValidation: structuredClone(validationStore),
      suppressions: structuredClone(suppressionStore),
      operations: structuredClone(operationsStore),
      contactCollection: structuredClone(contactCollectionStore),
      pipeline: structuredClone(pipelineStore),
      outbox: structuredClone(outboxStore),
      runtimeState: structuredClone(runtimeStateStore),
      campaigns: await readCampaigns(),
    },
  };
  return {
    ...payload,
    integrity: {
      algorithm: "sha256",
      digest: backupDigest(payload),
    },
  };
}

function validateLocalBackup(input) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, errors: ["备份必须是JSON对象"], counts: {} };
  }
  const { integrity, ...payload } = input;
  if (payload.schemaVersion !== 1) errors.push("不支持的备份版本");
  if (payload.scope !== "local_control_state_only") errors.push("备份范围不正确");
  if (!payload.stores || typeof payload.stores !== "object") errors.push("缺少stores对象");
  const stores = payload.stores || {};
  const validationRecords = stores.contactValidation?.records;
  const suppressionRecords = stores.suppressions?.records;
  const tasks = stores.operations?.tasks;
  const collectionQueues = stores.contactCollection?.queues || [];
  const pipelineJobs = stores.pipeline?.jobs || [];
  const outboxEntries = stores.outbox?.entries || [];
  const campaigns = stores.campaigns;
  if (!Array.isArray(validationRecords)) errors.push("contactValidation.records必须是数组");
  if (!Array.isArray(suppressionRecords)) errors.push("suppressions.records必须是数组");
  if (!Array.isArray(tasks)) errors.push("operations.tasks必须是数组");
  if (stores.contactCollection && !Array.isArray(stores.contactCollection.queues)) errors.push("contactCollection.queues必须是数组");
  if (stores.pipeline && !Array.isArray(stores.pipeline.jobs)) errors.push("pipeline.jobs必须是数组");
  if (stores.outbox && !Array.isArray(stores.outbox.entries)) errors.push("outbox.entries必须是数组");
  if (!Array.isArray(campaigns)) errors.push("campaigns必须是数组");
  if (stores.contactValidation?.version !== 1) errors.push("contactValidation版本不受支持");
  if (stores.suppressions?.version !== 1) errors.push("suppressions版本不受支持");
  if (stores.operations?.version !== 1) errors.push("operations版本不受支持");
  if (stores.contactCollection && stores.contactCollection.version !== 1) errors.push("contactCollection版本不受支持");
  if (stores.pipeline && stores.pipeline.version !== 1) errors.push("pipeline版本不受支持");
  if (stores.outbox && stores.outbox.version !== 1) errors.push("outbox版本不受支持");
  if (stores.runtimeState && stores.runtimeState.version !== 1) errors.push("runtimeState版本不受支持");
  if ((validationRecords?.length || 0) > 100000) errors.push("邮箱验证记录超过100,000条上限");
  if ((suppressionRecords?.length || 0) > 100000) errors.push("抑制记录超过100,000条上限");
  if ((tasks?.length || 0) > 10000) errors.push("任务记录超过10,000条上限");
  if (collectionQueues.length > 1000) errors.push("联系人采集队列超过1,000条上限");
  if (pipelineJobs.length > 10000) errors.push("流水线记录超过10,000条上限");
  if (outboxEntries.length > 100000) errors.push("发件箱记录超过100,000条上限");
  if ((campaigns?.length || 0) > 10000) errors.push("活动记录超过10,000条上限");
  for (const record of [...(validationRecords || []), ...(suppressionRecords || [])].slice(0, 200000)) {
    if (!/^[a-f0-9]{64}$/.test(String(record?.emailHash || ""))) errors.push("邮箱记录包含无效哈希");
    if (Object.hasOwn(record || {}, "email")) errors.push("控制备份不得包含明文邮箱字段");
  }
  for (const task of (tasks || []).slice(0, 10000)) {
    if (!/^task_[a-f0-9-]+$/i.test(String(task?.id || ""))) errors.push("任务ID格式无效");
    if (!/^\d{4,10}$/.test(String(task?.hsCode || ""))) errors.push("任务HSCode格式无效");
  }
  for (const campaign of (campaigns || []).slice(0, 10000)) {
    if (!/^cmp_[a-f0-9-]+$/i.test(String(campaign?.id || ""))) errors.push("活动ID格式无效");
  }
  for (const job of pipelineJobs.slice(0, 10000)) {
    if (!/^pipe_[a-f0-9-]+$/i.test(String(job?.id || ""))) errors.push("流水线ID格式无效");
    if (!/^\d{4,10}$/.test(String(job?.hsCode || ""))) errors.push("流水线HSCode格式无效");
  }
  for (const entry of outboxEntries.slice(0, 100000)) {
    if (!/^out_[a-f0-9-]+$/i.test(String(entry?.id || ""))) errors.push("发件箱ID格式无效");
    if (!/^[a-f0-9]{64}$/.test(String(entry?.recipientHash || ""))) errors.push("发件箱收件人哈希无效");
    if (Object.hasOwn(entry || {}, "email") || Object.hasOwn(entry || {}, "recipientEmail")) errors.push("控制备份不得包含明文收件邮箱");
  }
  const duplicateKey = (items, key) => {
    const seen = new Set();
    for (const item of items || []) {
      const value = String(item?.[key] || "");
      if (seen.has(value)) return true;
      seen.add(value);
    }
    return false;
  };
  if (duplicateKey(validationRecords, "emailHash")) errors.push("邮箱验证记录包含重复哈希");
  if (duplicateKey(suppressionRecords, "emailHash")) errors.push("抑制记录包含重复哈希");
  if (duplicateKey(tasks, "id")) errors.push("任务记录包含重复ID");
  if (duplicateKey(collectionQueues, "id")) errors.push("联系人采集队列包含重复ID");
  if (duplicateKey(campaigns, "id")) errors.push("活动记录包含重复ID");
  if (duplicateKey(pipelineJobs, "id")) errors.push("流水线记录包含重复ID");
  if (duplicateKey(outboxEntries, "id")) errors.push("发件箱记录包含重复ID");
  if (integrity?.algorithm !== "sha256" || !/^[a-f0-9]{64}$/.test(String(integrity?.digest || ""))) {
    errors.push("缺少有效的SHA-256完整性摘要");
  } else if (backupDigest(payload) !== integrity.digest) {
    errors.push("备份完整性摘要不匹配");
  }
  return {
    valid: errors.length === 0,
    errors: [...new Set(errors)],
    schemaVersion: payload.schemaVersion,
    exportedAt: payload.exportedAt || "",
    counts: {
      validationRecords: validationRecords?.length || 0,
      suppressions: suppressionRecords?.length || 0,
      operationTasks: tasks?.length || 0,
      contactQueues: collectionQueues.length,
      pipelineJobs: pipelineJobs.length,
      outboxEntries: outboxEntries.length,
      campaigns: campaigns?.length || 0,
    },
  };
}

function mergeCurrentFirst(currentItems, incomingItems, key) {
  const currentKeys = new Set(currentItems.map((item) => String(item?.[key] || "")));
  const added = incomingItems.filter((item) => !currentKeys.has(String(item?.[key] || "")));
  return {
    items: [...structuredClone(currentItems), ...structuredClone(added)],
    added: added.length,
    conflicts: incomingItems.length - added.length,
  };
}

function buildBackupMergePlan(backup, currentCampaigns) {
  const validation = validateLocalBackup(backup);
  if (!validation.valid) return { ...validation, confirmation: "", stores: null };
  const incoming = backup.stores;
  const validations = mergeCurrentFirst(validationStore.records || [], incoming.contactValidation.records, "emailHash");
  const suppressions = mergeCurrentFirst(suppressionStore.records || [], incoming.suppressions.records, "emailHash");
  const operations = mergeCurrentFirst(operationsStore.tasks || [], incoming.operations.tasks, "id");
  const contactQueues = mergeCurrentFirst(contactCollectionStore.queues || [], incoming.contactCollection?.queues || [], "id");
  const pipelines = mergeCurrentFirst(pipelineStore.jobs || [], incoming.pipeline?.jobs || [], "id");
  const outbox = mergeCurrentFirst(outboxStore.entries || [], incoming.outbox?.entries || [], "id");
  const campaigns = mergeCurrentFirst(currentCampaigns, incoming.campaigns, "id");
  const current = {
    validationRecords: (validationStore.records || []).length,
    suppressions: (suppressionStore.records || []).length,
    operationTasks: (operationsStore.tasks || []).length,
    contactQueues: (contactCollectionStore.queues || []).length,
    pipelineJobs: (pipelineStore.jobs || []).length,
    outboxEntries: (outboxStore.entries || []).length,
    campaigns: currentCampaigns.length,
  };
  const added = {
    validationRecords: validations.added,
    suppressions: suppressions.added,
    operationTasks: operations.added,
    contactQueues: contactQueues.added,
    pipelineJobs: pipelines.added,
    outboxEntries: outbox.added,
    campaigns: campaigns.added,
  };
  const conflicts = {
    validationRecords: validations.conflicts,
    suppressions: suppressions.conflicts,
    operationTasks: operations.conflicts,
    contactQueues: contactQueues.conflicts,
    pipelineJobs: pipelines.conflicts,
    outboxEntries: outbox.conflicts,
    campaigns: campaigns.conflicts,
  };
  const effective = Object.fromEntries(Object.keys(current).map((key) => [key, current[key] + added[key]]));
  return {
    ...validation,
    current,
    incoming: validation.counts,
    added,
    conflicts,
    effective,
    confirmation: `MERGE ${backup.integrity.digest.slice(0, 12).toUpperCase()}`,
    stores: {
      contactValidation: { version: 1, records: validations.items },
      suppressions: { version: 1, records: suppressions.items },
      operations: { version: 1, tasks: operations.items },
      contactCollection: { version: 1, queues: contactQueues.items },
      pipeline: { version: 1, jobs: pipelines.items },
      outbox: { version: 1, entries: outbox.items },
      runtimeState: structuredClone(runtimeStateStore),
      campaigns: campaigns.items,
    },
  };
}

function replaceObjectContents(target, value) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, structuredClone(value));
}

async function commitMergedStores(stores, rollbackBackup) {
  const transactionId = crypto.randomUUID();
  const rollbackName = `rollback-${new Date().toISOString().replace(/[:.]/g, "-")}-${transactionId}.json`;
  const rollbackPath = path.join(localBackupDir, rollbackName);
  await writeJsonStore(rollbackPath, rollbackBackup);

  const originals = {
    contactValidation: structuredClone(validationStore),
    suppressions: structuredClone(suppressionStore),
    operations: structuredClone(operationsStore),
    contactCollection: structuredClone(contactCollectionStore),
    pipeline: structuredClone(pipelineStore),
    outbox: structuredClone(outboxStore),
    runtimeState: structuredClone(runtimeStateStore),
    campaigns: await readCampaigns(),
  };
  const targets = [
    [validationPath, stores.contactValidation, originals.contactValidation],
    [suppressionPath, stores.suppressions, originals.suppressions],
    [operationsPath, stores.operations, originals.operations],
    [contactCollectionPath, stores.contactCollection, originals.contactCollection],
    [pipelinePath, stores.pipeline, originals.pipeline],
    [outboxPath, stores.outbox, originals.outbox],
    [runtimeStatePath, stores.runtimeState, originals.runtimeState],
    [campaignPath, stores.campaigns, originals.campaigns],
  ];
  const staged = targets.map(([filePath]) => `${filePath}.merge-${transactionId}.tmp`);
  try {
    for (let index = 0; index < targets.length; index += 1) {
      const [filePath, value] = targets[index];
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(staged[index], JSON.stringify(value, null, 2), "utf8");
    }
    for (let index = 0; index < targets.length; index += 1) {
      await fs.rename(staged[index], targets[index][0]);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const [filePath, , original] of targets) {
      try {
        await writeJsonStore(filePath, original);
      } catch (rollbackError) {
        rollbackErrors.push(`${path.basename(filePath)}:${rollbackError.message}`);
      }
    }
    const details = rollbackErrors.length ? `；回滚异常：${rollbackErrors.join("；")}` : "；已回滚到合并前状态";
    throw Object.assign(new Error(`安全合并写入失败${details}`), { status: 500, cause: error });
  } finally {
    await Promise.all(staged.map((filePath) => fs.rm(filePath, { force: true }).catch(() => {})));
  }

  replaceObjectContents(validationStore, stores.contactValidation);
  replaceObjectContents(suppressionStore, stores.suppressions);
  replaceObjectContents(operationsStore, stores.operations);
  replaceObjectContents(contactCollectionStore, stores.contactCollection);
  replaceObjectContents(pipelineStore, stores.pipeline);
  replaceObjectContents(outboxStore, stores.outbox);
  replaceObjectContents(runtimeStateStore, stores.runtimeState);
  return rollbackName;
}

function currentBusinessDate() {
  return businessDateFor(new Date());
}

function businessDateFor(value) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(value);
}

function cleanTaskInput(input) {
  const collectionMode = ["keyword", "country_business"].includes(input.collectionMode) ? input.collectionMode : "hscode";
  const hsCode = String(input.hsCode || "").trim();
  const keyword = collectionMode === "keyword" ? validateKeyword(input.keyword) : "";
  const country = collectionMode === "country_business" ? validateCountry(input.country) : "";
  const businessKeywords = collectionMode === "country_business"
    ? validateBusinessKeywords(input.businessKeywords || input.businessScope)
    : [];
  if (collectionMode === "hscode" && !/^\d{4,10}$/.test(hsCode)) throw Object.assign(new Error("HSCode必须是4至10位数字"), { status: 422 });
  const direction = input.direction === "supplier" ? "supplier" : "buyer";
  const bounded = (value, fallback, min, max) => boundedInteger(value, fallback, min, max);
  const managed = input.automation?.mode === "managed";
  const authorizationKey = collectionMode === "keyword" ? keyword
    : collectionMode === "country_business" ? `${country}:${businessKeywords.join(",")}`
      : hsCode;
  if (managed && input.automation?.confirm !== `AUTHORIZE MANAGED ${authorizationKey}`) {
    throw Object.assign(new Error(`计划托管需要确认短语：AUTHORIZE MANAGED ${authorizationKey}`), { status: 428 });
  }
  const emailSendsDaily = bounded(input.budgets?.emailSendsDaily, managed ? 500 : 20, 1, 1000);
  const companyDetailsDaily = bounded(input.budgets?.companyDetailsDaily, managed ? 100 : 5, 1, 400);
  const validEmailCompaniesDaily = bounded(input.budgets?.validEmailCompaniesDaily, managed ? 100 : 0, managed ? 1 : 0, 200);
  const managedDiscoveryFloor = managed ? Math.min(2000, Math.max(100, validEmailCompaniesDaily * 8)) : 100;
  return {
    hsCode,
    collectionMode,
    keyword,
    country,
    businessKeywords,
    direction,
    countries: [...new Set((Array.isArray(input.countries) ? input.countries : [])
      .map((item) => String(item).trim().slice(0, 80)).filter(Boolean))].slice(0, 20),
    budgets: {
      buyerEntriesDaily: Math.max(bounded(input.budgets?.buyerEntriesDaily, managedDiscoveryFloor, 1, 2000), managedDiscoveryFloor),
      companyDetailsDaily: managed ? Math.max(companyDetailsDaily, Math.ceil(emailSendsDaily / 2)) : companyDetailsDaily,
      validEmailCompaniesDaily,
      contactPagesDaily: bounded(input.budgets?.contactPagesDaily, 25, 1, 400),
      emailSendsDaily,
    },
    automation: {
      mode: managed ? "managed" : "supervised",
      planId: managed ? String(input.automation?.planId || `managed-${authorizationKey}`).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 120) : null,
      authorizedAt: managed ? new Date().toISOString() : null,
      authorizedBy: managed ? String(input.automation?.authorizedBy || "plan-owner").trim().slice(0, 120) : null,
      draftPolicy: "best_safe_variant",
      sendPolicy: managed ? "central_batch_review_with_all_delivery_gates" : "per_batch_human_approval",
      mandatoryHumanGates: ["captcha", "credential_error", "permission", "mfa"],
    },
  };
}

function taskPublicView(task) {
  return {
    ...task,
    audit: (task.audit || []).slice(-100).reverse(),
  };
}

function resetDailyCounters(task, businessDate) {
  if (task.counters?.businessDate === businessDate) return;
  task.counters = {
    businessDate,
    buyerEntries: 0,
    companySearches: 0,
    companyDetails: 0,
    qualifiedCompanies: 0,
    contactPages: 0,
    rawContactRows: 0,
  };
}

function counterForAction(type) {
  return {
    buyer_entry: "buyerEntries",
    company_search: "companySearches",
    company_detail: "companyDetails",
    qualified_company: "qualifiedCompanies",
    contact_page: "contactPages",
    raw_contact_row: "rawContactRows",
  }[type] || "";
}

function actionBudget(task, type) {
  if (task.automation?.mode === "managed") return null;
  return {
    buyer_entry: task.budgets.buyerEntriesDaily,
    company_detail: task.budgets.companyDetailsDaily,
    qualified_company: task.budgets.validEmailCompaniesDaily ?? null,
    contact_page: task.budgets.contactPagesDaily,
  }[type] || null;
}

function recordTaskAction(task, input) {
  const type = String(input.type || "");
  if (!ACTION_TYPES.has(type)) throw Object.assign(new Error("不支持的动作类型"), { status: 422 });
  if (input.type === "background_deep_mining") throw Object.assign(new Error("生产流程禁止后台深挖任务"), { status: 422 });
  const idempotencyKey = String(input.idempotencyKey || "").replace(/[^a-zA-Z0-9:._-]/g, "-").slice(0, 200);
  if (idempotencyKey && (task.audit || []).some((item) => item.idempotencyKey === idempotencyKey)) return task;
  const signal = String(input.signal || "none");
  if (!SAFETY_SIGNALS.has(signal)) throw Object.assign(new Error("不支持的安全信号"), { status: 422 });
  const businessDate = String(input.businessDate || currentBusinessDate()).slice(0, 10);
  resetDailyCounters(task, businessDate);
  if (task.safetyState === "CIRCUIT_OPEN") throw Object.assign(new Error("任务已熔断，必须人工恢复后才能记录新动作"), { status: 423 });
  const count = boundedInteger(input.count, 1, 1, type === "raw_contact_row" ? 10000 : 500);
  const counter = counterForAction(type);
  const budget = actionBudget(task, type);
  if (counter && budget !== null && task.counters[counter] + count > budget) {
    const now = new Date().toISOString();
    task.safetyState = "THROTTLED";
    task.status = "paused";
    task.updatedAt = now;
    task.audit = [...(task.audit || []), {
      at: now,
      type: "budget_rejected",
      requestedAction: type,
      requestedCount: count,
      currentCount: task.counters[counter],
      budget,
      safetyState: task.safetyState,
    }].slice(-1000);
    throw Object.assign(new Error(`动作将超过当日预算：${type} ${task.counters[counter]}/${budget}`), { status: 429 });
  }
  if (counter) task.counters[counter] += count;
  const severe = ["captcha", "frequent_operation", "permission", "http_403", "http_429"].includes(signal);
  const anomaly = ["structure_error", "duplicate_page", "page_stuck"].includes(signal);
  task.consecutiveAnomalies = signal === "none" ? 0 : (task.consecutiveAnomalies || 0) + (anomaly ? 1 : 0);
  if (severe || task.consecutiveAnomalies >= 3) {
    task.safetyState = "CIRCUIT_OPEN";
    task.status = "paused";
  } else if (signal !== "none") {
    task.safetyState = "THROTTLED";
  } else {
    task.safetyState = "RUNNING";
    task.status = "active";
  }
  const now = new Date().toISOString();
  if (input.checkpoint && typeof input.checkpoint === "object") {
    task.checkpoint = {
      company: String(input.checkpoint.company || "").slice(0, 300),
      page: boundedInteger(input.checkpoint.page, 0, 0, 10000),
      extracted: boundedInteger(input.checkpoint.extracted, 0, 0, 1000000),
      note: String(input.checkpoint.note || "").slice(0, 500),
      at: now,
    };
  }
  task.updatedAt = now;
  task.audit = [...(task.audit || []), {
    at: now,
    type,
    count,
    signal,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    safetyState: task.safetyState,
    counters: { ...task.counters },
  }].slice(-1000);
  return task;
}

const DEFAULT_COLLECTION_SOURCES = [
  {
    sourceId: "hung_hing",
    path: "outputs/Hung_Hing_Printing_网易买家原始清单_2026-08-11.json",
  },
  {
    sourceId: "amity",
    path: "outputs/Amity_Printing_网易买家原始清单_2026-08-11.json",
  },
];
const DEFAULT_COLLECTION_RESULTS = [
  "outputs/20260811_hung_hing_amity_buyers_contacts/本轮续采原始结果_2026-08-11.json",
];
const DEFAULT_IMPORTED_COMPLETIONS = [
  "SCHOLASTIC",
  "THE BIBLE SOCIETY OF INDIA",
  "PACIFIC PRESS PUBLISHING ASSOCIATIO",
];

function resolveWorkspaceJson(inputPath) {
  const value = String(inputPath || "").trim();
  if (!value) throw Object.assign(new Error("JSON文件路径不能为空"), { status: 422 });
  const resolved = path.resolve(workspaceDir, value);
  const relative = path.relative(workspaceDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative) || path.extname(resolved).toLowerCase() !== ".json") {
    throw Object.assign(new Error("采集队列只允许读取项目目录内的JSON文件"), { status: 422 });
  }
  return resolved;
}

async function readCollectionSource(spec) {
  const filePath = resolveWorkspaceJson(spec.path);
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw Object.assign(new Error(`无法读取买家清单：${path.basename(filePath)} (${error.message})`), { status: 422 });
  }
  const buyers = Array.isArray(parsed.buyers)
    ? parsed.buyers
    : Array.isArray(parsed.records)
      ? parsed.records
      : [];
  if (!buyers.length) throw Object.assign(new Error(`买家清单没有可用buyers/records：${path.basename(filePath)}`), { status: 422 });
  return {
    sourceId: String(spec.sourceId || path.basename(filePath, ".json")).trim().slice(0, 120),
    buyers,
    reference: path.relative(workspaceDir, filePath).replaceAll("\\", "/"),
  };
}

async function readProcessedCompanyNames(paths) {
  const names = [];
  for (const inputPath of paths) {
    const filePath = resolveWorkspaceJson(inputPath);
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
      for (const result of Array.isArray(parsed.results) ? parsed.results : []) {
        const name = String(result.query || result.companyName || "").trim();
        if (name) names.push(name);
      }
    } catch (error) {
      throw Object.assign(new Error(`无法读取历史采集结果：${path.basename(filePath)} (${error.message})`), { status: 422 });
    }
  }
  return names;
}

function collectionSignalFromResult(result) {
  const explicit = String(result.signal || "");
  if (COLLECTION_SIGNALS.has(explicit)) return explicit;
  const alarmText = (Array.isArray(result.alarm) ? result.alarm : [result.alarm]).filter(Boolean).join(" ");
  if (/验证码|安全验证/i.test(alarmText)) return "captcha";
  if (/操作频繁|访问过于频繁|请求过于频繁/i.test(alarmText)) return "frequent_operation";
  if (/权限不足|暂无权限/i.test(alarmText)) return "permission";
  if (/\b403\b/.test(alarmText)) return "http_403";
  if (/\b429\b/.test(alarmText)) return "http_429";
  if (result.status === "no_table") return "structure_error";
  if (result.status === "browser_disconnected") return "browser_disconnected";
  if (result.status === "auth_required") return "auth_required";
  if (result.status === "error" || result.status === "timeout") return "control_timeout";
  return "none";
}

function collectionOutcomeFromResult(result, signal) {
  if (SEVERE_PLATFORM_SIGNALS.has(signal) || STRUCTURE_SIGNALS.has(signal)) return "error";
  if (["control_timeout", "browser_disconnected", "auth_required"].includes(signal)) return "error";
  if (result.status === "partial" || result.contactComplete === false) return "partial";
  if (["no_result", "not_found"].includes(result.status)) return "no_result";
  // An exact company match can expose only public company-level details while
  // the platform queues its separate contact-enrichment workflow. This is a
  // legitimate terminal collection result, not a retriable collection error.
  if (["collected", "company_visible_no_contacts", "contacts_pending_enrichment"].includes(result.status)) return "ok";
  if (result.status === "skipped") return "skipped";
  return result.status === "ok" ? "ok" : "error";
}

async function writeCollectionArtifact(queue, batch, rawResults) {
  if (!Array.isArray(rawResults) || !rawResults.length) return "";
  const safeQueue = queue.id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeBatch = batch.id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const directory = path.join(contactCollectionArtifactDir, safeQueue);
  const filePath = path.join(directory, `${new Date().toISOString().replace(/[:.]/g, "-")}_${safeBatch}.json`);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: "https://waimao.office.163.com/#wmData?page=globalSearch",
    queueId: queue.id,
    batchId: batch.id,
    results: rawResults,
  }, null, 2), "utf8");
  return path.relative(workspaceDir, filePath).replaceAll("\\", "/");
}

function summarizeCollectionResults(queue, batch, rawResults) {
  const batchItems = new Map(batch.itemIds.map((id) => {
    const item = queue.items.find((candidate) => candidate.id === id);
    return [normalizeCompanyName(item?.companyName), item];
  }));
  return (Array.isArray(rawResults) ? rawResults : []).map((result) => {
    const item = result.itemId
      ? queue.items.find((candidate) => candidate.id === result.itemId)
      : batchItems.get(normalizeCompanyName(result.query || result.companyName));
    const signal = collectionSignalFromResult(result);
    return {
      itemId: item?.id || "",
      outcome: collectionOutcomeFromResult(result, signal),
      signal,
      contactRows: Array.isArray(result.contacts) ? result.contacts.length : Number(result.contactRows || 0),
      contactRowsDelta: Number(result.contactRowsDelta ?? (Array.isArray(result.contacts) ? result.contacts.length : Number(result.contactRows || 0))),
      contactTotal: Number(result.contactTotal || 0),
      contactPage: Number(result.contactPage || 0),
      contactPageSize: Number(result.contactPageSize || 0),
      contactNextPage: Number(result.contactNextPage || 0),
      contactPagesCollected: Number(result.contactPagesCollected || 0),
      contactComplete: result.contactComplete !== false,
      error: String(result.error || (signal !== "none" ? result.status || signal : "")).slice(0, 500),
    };
  }).filter((result) => result.itemId);
}

function pipelineJobPublicView(job) {
  return {
    ...job,
    audit: (job.audit || []).slice(-100).reverse(),
  };
}

function createPipelineJob(task, input = {}) {
  const now = new Date().toISOString();
  const inputReference = String(input.inputReference || "").trim().slice(0, 500);
  return {
    id: `pipe_${crypto.randomUUID()}`,
    operationTaskId: task?.id || null,
    hsCode: String(input.hsCode || task?.hsCode || ""),
    collectionMode: input.collectionMode || task?.collectionMode || "hscode",
    keyword: String(input.keyword || task?.keyword || ""),
    country: String(input.country || task?.country || ""),
    businessKeywords: structuredClone(input.businessKeywords || task?.businessKeywords || []),
    direction: input.direction === "supplier" || task?.direction === "supplier" ? "supplier" : "buyer",
    countries: structuredClone(input.countries || task?.countries || []),
    automation: structuredClone(input.automation || task?.automation || { mode: "supervised" }),
    status: inputReference ? "queued" : "waiting_input",
    currentStage: "discovery",
    requiredInput: inputReference ? "" : `需要在网易正常页面完成${(input.collectionMode || task?.collectionMode || "hscode") === "keyword" ? "关键词" : (input.collectionMode || task?.collectionMode) === "country_business" ? "国家+业务范围" : "HSCode"}检索，并提供可追溯的结果文件或页面检查点`,
    inputReference,
    stages: Object.fromEntries(PIPELINE_STAGES.map((stage) => [stage, {
      status: stage === "discovery" ? (inputReference ? "queued" : "waiting_input") : "pending",
      attempts: 0,
      updatedAt: now,
    }])),
    artifacts: [],
    leaseOwner: "",
    leaseExpiresAt: null,
    createdAt: now,
    updatedAt: now,
    audit: [{ at: now, type: "pipeline_created", status: inputReference ? "queued" : "waiting_input" }],
  };
}

function sanitizePipelineArtifact(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const counts = {};
  for (const [key, value] of Object.entries(input.counts || {}).slice(0, 20)) {
    const safeKey = String(key).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 60);
    if (safeKey) counts[safeKey] = boundedInteger(value, 0, 0, 10000000);
  }
  return {
    reference: String(input.reference || "").trim().slice(0, 500),
    note: String(input.note || "").trim().slice(0, 1000),
    counts,
  };
}

function pipelineSummary() {
  const jobs = pipelineStore.jobs || [];
  const counts = Object.fromEntries([...PIPELINE_STATUSES].map((status) => [status, jobs.filter((job) => job.status === status).length]));
  return {
    version: pipelineStore.version,
    stages: PIPELINE_STAGES,
    counts,
    claimable: jobs.filter((job) => job.status === "queued").length,
    jobs: jobs.map(pipelineJobPublicView),
  };
}

function claimNextPipelineJob(owner, leaseSeconds) {
  const nowMs = Date.now();
  const expired = (pipelineStore.jobs || []).filter((job) => (
    job.status === "running" && job.leaseExpiresAt && Date.parse(job.leaseExpiresAt) <= nowMs
  ));
  for (const job of expired) {
    job.status = "queued";
    job.leaseOwner = "";
    job.leaseExpiresAt = null;
    job.audit = [...(job.audit || []), { at: new Date().toISOString(), type: "lease_expired_requeued" }].slice(-1000);
  }
  const job = (pipelineStore.jobs || []).find((item) => item.status === "queued");
  if (!job) return null;
  const now = new Date().toISOString();
  job.status = "running";
  job.leaseOwner = owner;
  job.leaseExpiresAt = new Date(nowMs + leaseSeconds * 1000).toISOString();
  job.stages[job.currentStage] = {
    ...(job.stages[job.currentStage] || {}),
    status: "running",
    attempts: Number(job.stages[job.currentStage]?.attempts || 0) + 1,
    updatedAt: now,
  };
  job.updatedAt = now;
  job.audit = [...(job.audit || []), { at: now, type: "stage_claimed", stage: job.currentStage, owner }].slice(-1000);
  return job;
}

function updatePipelineStage(job, input) {
  const stage = String(input.stage || job.currentStage);
  if (stage !== job.currentStage || !PIPELINE_STAGES.includes(stage)) {
    throw Object.assign(new Error("只能更新当前流水线阶段"), { status: 409 });
  }
  if (job.status !== "running") throw Object.assign(new Error("流水线任务尚未被执行器领取"), { status: 409 });
  const owner = String(input.owner || "").trim().slice(0, 120);
  if (!owner || owner !== job.leaseOwner) throw Object.assign(new Error("执行器租约不匹配"), { status: 409 });
  const outcome = String(input.outcome || "completed");
  if (!["completed", "waiting_input", "circuit_open", "paused"].includes(outcome)) {
    throw Object.assign(new Error("不支持的阶段结果"), { status: 422 });
  }
  const now = new Date().toISOString();
  const artifact = sanitizePipelineArtifact(input.artifact);
  if (artifact && (artifact.reference || artifact.note || Object.keys(artifact.counts).length)) {
    job.artifacts = [...(job.artifacts || []), { stage, at: now, ...artifact }].slice(-500);
  }
  job.stages[stage] = { ...(job.stages[stage] || {}), status: outcome, updatedAt: now };
  job.leaseOwner = "";
  job.leaseExpiresAt = null;
  job.updatedAt = now;
  if (outcome === "completed") {
    const index = PIPELINE_STAGES.indexOf(stage);
    if (index === PIPELINE_STAGES.length - 1) {
      job.status = "completed";
      job.requiredInput = "";
    } else if (stage === "drafting" && job.automation?.mode === "managed") {
      job.stages.approval = { ...(job.stages.approval || {}), status: "batch_review", updatedAt: now };
      job.currentStage = "approval";
      job.status = "batch_review";
      job.requiredInput = "草稿已完成简单核验，等待集中批次审核发送";
      job.batchReview = {
        status: "pending",
        draftedContacts: Number(artifact?.counts?.draftedContacts || 0),
        createdAt: now,
      };
      job.audit = [...(job.audit || []), { at: now, type: "central_batch_review_pending", draftedContacts: Number(artifact?.counts?.draftedContacts || 0) }].slice(-1000);
    } else {
      job.currentStage = PIPELINE_STAGES[index + 1];
      job.status = "queued";
      job.stages[job.currentStage] = { ...(job.stages[job.currentStage] || {}), status: "queued", updatedAt: now };
    }
  } else {
    job.status = outcome;
    job.requiredInput = outcome === "waiting_input"
      ? String(input.requiredInput || "需要人工提供下一步输入").trim().slice(0, 500)
      : "";
  }
  job.audit = [...(job.audit || []), { at: now, type: "stage_recorded", stage, outcome, owner }].slice(-1000);
  return job;
}

function paginate(items, page, pageSize) {
  const safeSize = Math.min(Math.max(asNumber(pageSize, 20), 1), 100);
  const total = items.length;
  const pages = Math.max(Math.ceil(total / safeSize), 1);
  const safePage = Math.min(Math.max(asNumber(page, 1), 1), pages);
  const start = (safePage - 1) * safeSize;
  return { items: items.slice(start, start + safeSize), page: safePage, pageSize: safeSize, pages, total };
}

function filterBuyers(model, query) {
  let items = model.buyers;
  const text = normalize(query.get("q"));
  const country = normalize(query.get("country"));
  const confidence = query.get("confidence") || "";
  const status = query.get("status") || "";
  if (text) items = items.filter((item) => normalize(`${item.buyer} ${item.matchedCompany} ${item.website}`).includes(text));
  if (country) items = items.filter((item) => normalize(item.country) === country);
  if (confidence) items = items.filter((item) => item.matchConfidence === confidence);
  if (status) items = items.filter((item) => item.enrichmentStatus === status);
  return paginate(items, query.get("page"), query.get("pageSize"));
}

function filterContacts(model, query) {
  let items = model.contacts;
  const text = normalize(query.get("q"));
  const buyer = normalize(query.get("buyer"));
  const priority = query.get("priority") || "";
  const confidence = query.get("confidence") || "";
  const validation = query.get("validation") || "";
  const dedupe = query.get("dedupe") || "first";
  const emailOnly = query.get("emailOnly") === "true";
  if (text) items = items.filter((item) => normalize(`${item.name} ${item.title} ${item.email} ${item.rawBuyerName} ${item.matchedCompany}`).includes(text));
  if (buyer) items = items.filter((item) => normalize(item.rawBuyerName) === buyer);
  if (priority) items = items.filter((item) => item.priority === priority);
  if (confidence) items = items.filter((item) => item.matchConfidence === confidence);
  if (validation) items = items.filter((item) => item.validationStatus === validation);
  if (dedupe === "first") items = items.filter((item) => !item.duplicate);
  if (emailOnly) items = items.filter((item) => item.email && !item.duplicateEmail);
  return paginate(items, query.get("page"), query.get("pageSize"));
}

function buildQualityReport(model) {
  const buyers = model.buyers;
  const contacts = model.contacts;
  const emailContacts = contacts.filter((item) => item.email);
  const accessible = contacts.filter((item) => item.contactable);
  const invalidEmailFormat = emailContacts.filter((item) => !validEmail(item.email));
  const blankName = contacts.filter((item) => !item.name && item.contactable);
  const missingCompany = contacts.filter((item) => !item.matchedCompany && item.contactable);
  const lowConfidence = contacts.filter((item) => !item.matchConfidence || !item.matchedCompany);
  const pendingBuyers = buyers.filter((item) => !item.matchedCompany);
  const confidenceCounts = buyers.reduce((counts, item) => {
    const key = item.matchConfidence || "未匹配";
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  const validationLinkCounts = contacts.reduce((counts, item) => {
    const key = item.validationStatus || "unknown";
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  const validationCounts = contacts.filter((item) => !item.email || !item.duplicateEmail).reduce((counts, item) => {
    const key = item.validationStatus || "unknown";
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  const suppressed = contacts.filter((item) => item.suppressed);
  const issues = [];
  const addIssue = (severity, code, count, message, action) => {
    if (count > 0) issues.push({ severity, code, count, message, action });
  };
  addIssue("high", "pending_buyer_enrichment", pendingBuyers.length,
    "仍有买家没有完成公司匹配和联系方式补全。", "继续队列 B，但保持买家搜索预算与联系方式预算分开。");
  addIssue("high", "unverified_email", validationCounts.unverified || 0,
    "邮箱只完成采集，尚未证明可投递。", "在进入 approved_recipient 前完成语法、域名/MX或人工验证。");
  addIssue("medium", "invalid_email_format", invalidEmailFormat.length,
    "邮箱字符串不符合基础格式。", "禁止进入发送候选，保留原始值并标记 invalid_format。");
  addIssue("medium", "blank_contact_name", blankName.length,
    "可联系记录缺少人物姓名，可能是公司级联系方式。", "放入公司联系方式表，不要用空白姓名占据人物联系人表。");
  addIssue("medium", "missing_matched_company", missingCompany.length,
    "联系方式缺少已匹配的买家公司。", "回到公司匹配阶段，保留原始买家名称，不强行归属。");
  addIssue("low", "duplicate_contact_link", model.summary.duplicateLinks,
    "存在重复联系方式关联。", "按公司、邮箱、电话和LinkedIn去重；同名不足以合并人物。");
  addIssue("low", "low_confidence_match", lowConfidence.length,
    "低置信公司匹配记录仍在数据池中。", "保留为待复核候选，不进入默认触达名单。");

  return {
    generatedAt: new Date().toISOString(),
    source: {
      retrievalDate: model.summary.retrievalDate,
      supplierQuery: model.summary.supplierQuery,
      buyerCount: model.summary.buyerCount,
    },
    metrics: {
      buyers: buyers.length,
      buyersEnriched: buyers.length - pendingBuyers.length,
      buyersPendingEnrichment: pendingBuyers.length,
      contactsExtracted: contacts.length,
      contactsAccessible: accessible.length,
      uniqueContacts: model.summary.uniqueContacts,
      uniqueEmails: model.summary.uniqueEmails,
      uniquePhones: model.summary.uniquePhones,
      duplicateLinks: model.summary.duplicateLinks,
      invalidEmailFormat: invalidEmailFormat.length,
      blankContactName: blankName.length,
      missingMatchedCompany: missingCompany.length,
      confidenceCounts,
      validationCounts,
      validationLinkCounts,
      suppressedContacts: suppressed.length,
      localValidationRecords: (validationStore.records || []).length,
      suppressionRecords: (suppressionStore.records || []).length,
    },
    issues,
    safeToSend: false,
    safeToSendReason: "当前数据池的邮箱默认是unverified；本地质量报告不会替代投递验证、在职确认、退订检查或人工审核。",
  };
}

function campaignRecipients(model, campaign) {
  const filters = campaign.filters || {};
  let items = model.contacts.filter((item) => item.email && !item.duplicateEmail && !item.suppressed && !isSuppressed(item.email));
  if (filters.countries?.length) items = items.filter((item) => filters.countries.includes(item.country));
  if (filters.confidences?.length) items = items.filter((item) => filters.confidences.includes(item.matchConfidence));
  if (filters.priorities?.length) items = items.filter((item) => filters.priorities.includes(item.priority));
  if (!filters.includeLowConfidence) items = items.filter((item) => confidenceRank[item.matchConfidence] >= 1);
  return items;
}

function renderTemplate(template, recipient) {
  const firstName = recipient.name?.split(/\s+/)[0] || "there";
  const replacements = {
    "{{first_name}}": firstName,
    "{{full_name}}": recipient.name || "there",
    "{{company}}": recipient.matchedCompany || recipient.rawBuyerName,
    "{{buyer_name}}": recipient.rawBuyerName,
    "{{country}}": recipient.country,
    "{{role}}": recipient.title || "your team",
  };
  return Object.entries(replacements).reduce((value, [token, replacement]) => value.split(token).join(replacement), String(template || ""));
}

function clipText(value, maximum = MAX_AI_CONTEXT_CHARS) {
  return String(value || "").trim().slice(0, maximum);
}

function extractResponseText(response) {
  if (typeof response?.output_text === "string") return response.output_text;
  return (response?.output || [])
    .flatMap((item) => item?.content || [])
    .filter((item) => item?.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function parseAiDraft(rawText) {
  const cleaned = String(rawText || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const candidates = [cleaned];
  for (let start = cleaned.indexOf("{"); start >= 0; start = cleaned.indexOf("{", start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < cleaned.length; index += 1) {
      const character = cleaned[index];
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = !quoted;
      else if (!quoted && character === "{") depth += 1;
      else if (!quoted && character === "}" && --depth === 0) {
        candidates.push(cleaned.slice(start, index + 1));
        break;
      }
    }
  }
  let parsed = candidates.map((candidate) => {
    try { return JSON.parse(candidate); } catch { return null; }
  }).find((candidate) => typeof candidate?.subject === "string" && typeof candidate?.body === "string");
  if (!parsed) {
    const labeled = cleaned.match(/(?:^|\n)\s*Subject\s*:\s*([^\n]+)\n+(?:Body\s*:\s*)?([\s\S]+)/i);
    if (labeled) parsed = { subject: labeled[1], body: labeled[2] };
  }
  if (!parsed) throw Object.assign(new Error("模型没有返回可解析的邮件草稿"), { status: 502 });
  const subject = clipText(parsed.subject, 240);
  const body = clipText(parsed.body, 12000);
  if (!subject || !body) throw Object.assign(new Error("模型返回的主题或正文为空"), { status: 502 });
  return { subject, body };
}

function englishWordCount(value) {
  return (String(value || "").match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
}

function contactFirstName(value) {
  const name = clipText(value, 200);
  if (!name || name === "{{first_name}}") return "{{first_name}}";
  const parts = name.split(/\s+/).filter(Boolean);
  while (parts.length > 1 && /^(mr|mrs|ms|miss|dr|prof)\.?$/i.test(parts[0])) parts.shift();
  return parts[0] || name;
}

function enforceGreeting(body, firstName) {
  const greeting = `Hi ${firstName || "{{first_name}}"},`;
  const text = String(body || "").trim();
  if (/^Hi\s+[^\n,]+,/i.test(text)) return text.replace(/^Hi\s+[^\n,]+,/i, greeting);
  return `${greeting}\n\n${text}`;
}

class CurlResponse {
  constructor(status, body) {
    this.status = status;
    this.body = body;
    this.ok = status >= 200 && status < 300;
  }

  async json() {
    return JSON.parse(this.body);
  }
}

function curlConfigValue(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\r", " ")
    .replaceAll("\n", " ");
}

async function requestOpenAi(url, options) {
  if (!OPENAI_PROXY_URL) return fetch(url, options);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dakings-openai-"));
  const bodyPath = path.join(tempDir, "request.json");
  const configPath = path.join(tempDir, "curl.conf");
  const body = String(options.body || "");
  const headers = Object.entries(options.headers || {});
  const config = [
    `url = "${curlConfigValue(url)}"`,
    `proxy = "${curlConfigValue(OPENAI_PROXY_URL)}"`,
    `request = "${curlConfigValue(options.method || "GET")}"`,
    "connect-timeout = 10",
    "max-time = 120",
    "silent",
    "show-error",
    "output = -",
    `data-binary = "@${curlConfigValue(bodyPath)}"`,
    ...headers.map(([name, value]) => `header = "${curlConfigValue(`${name}: ${value}`)}"`),
    'write-out = "\\n%{http_code}"',
    "",
  ].join("\n");

  await fs.writeFile(bodyPath, body, { mode: 0o600 });
  await fs.writeFile(configPath, config, { mode: 0o600 });
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn("curl", ["--config", configPath], { stdio: ["ignore", "pipe", "pipe"] });
      const stdout = [];
      const stderr = [];
      child.stdout.on("data", chunk => stdout.push(chunk));
      child.stderr.on("data", chunk => stderr.push(chunk));
      child.once("error", reject);
      child.once("close", code => resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }));
      options.signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    });
    const match = result.stdout.match(/\n(\d{3})\s*$/);
    if (!match) {
      throw new Error(result.stderr.trim() || `curl exited with code ${result.code}`);
    }
    return new CurlResponse(Number(match[1]), result.stdout.slice(0, match.index));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function requestAiDraftCompletion(instructions, facts, revisionRequest = "") {
  let response;
  try {
    response = await requestOpenAi(`${OPENAI_BASE_URL}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        reasoning: { effort: "none" },
        max_output_tokens: 700,
        text: {
          format: {
            type: "json_schema",
            name: "email_draft",
            strict: true,
            schema: {
              type: "object",
              properties: { subject: { type: "string" }, body: { type: "string" } },
              required: ["subject", "body"],
              additionalProperties: false,
            },
          },
        },
        instructions,
        input: `Create one outreach email from these facts:\n${JSON.stringify({
          ...facts,
          ...(revisionRequest ? { revision_request: revisionRequest } : {}),
        }, null, 2)}`,
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    const message = clipText(error.message || "network_error", 500);
    await updateAiRuntime({ reachable: false, lastError: message });
    throw Object.assign(new Error(`AI网关网络不可达：${message}`), { status: 502 });
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const providerMessage = clipText(payload?.error?.message || `HTTP ${response.status}`, 500);
    await updateAiRuntime({ reachable: true, lastError: providerMessage });
    throw Object.assign(new Error(`AI网关请求失败：${providerMessage}`), { status: 502 });
  }
  const responseText = extractResponseText(payload);
  try {
    return { payload, draft: parseAiDraft(responseText) };
  } catch (error) {
    const contentTypes = (payload.output || []).flatMap((item) => (item.content || []).map((content) => content.type)).filter(Boolean);
    error.message = `${error.message} (status=${payload.status || "unknown"}, content=${contentTypes.join(",") || "none"}, textChars=${responseText.length})`;
    throw error;
  }
}

async function dailyPipelineBatch(limit = deliveryConfig.dailyLimit, reserveMode = false, centralOnly = false) {
  const daily = dailyDeliveryUsage();
  const selected = [];
  const companyDailyCounts = new Map();
  if (!reserveMode) {
    for (const entry of outboxStore.entries || []) {
      if (!entry.companyHash || businessDateFor(new Date(entry.createdAt || entry.updatedAt || 0)) !== daily.businessDate
        || !["pending", "sending", "accepted", "uncertain"].includes(entry.status)) continue;
      companyDailyCounts.set(entry.companyHash, Number(companyDailyCounts.get(entry.companyHash) || 0) + 1);
    }
  }
  const selectionLimit = reserveMode ? limit : Math.min(limit, daily.remaining);
  const seenRecipients = new Set();
  const blocked = [];
  const jobs = (pipelineStore.jobs || []).filter((job) => {
    if (reserveMode) {
      // Reserve mode is the cross-day company inventory: retain unsent drafts
      // after a prior batch has moved the job into feedback.
      return latestPipelineArtifact(job, "drafting")
        && !["completed", "paused", "circuit_open"].includes(job.status);
    }
    if (centralOnly
      && job.automation?.mode === "managed"
      && job.currentStage === "feedback"
      && job.status === "waiting_input"
      && job.batchReview?.status === "sent"
      && latestPipelineArtifact(job, "drafting")) return true;
    return job.currentStage === "approval"
      && (centralOnly ? job.status === "batch_review" : ["waiting_input", "batch_review"].includes(job.status));
  });
  for (const job of jobs) {
    let artifact;
    try { artifact = await readPipelineArtifact(job, "drafting"); } catch { continue; }
    for (const [index, draft] of (artifact.drafts || []).entries()) {
      const company = normalizeCompanyName(draft.company);
      const email = normalize(draft.email);
      const errors = pipelineDraftErrors(draft);
      const companyHash = stableId("company", company);
      const recipientHash = emailFingerprint(email);
      const companyDailyLimitReached = Number(companyDailyCounts.get(companyHash) || 0) >= MAX_PIPELINE_CONTACTS_PER_COMPANY_DAILY;
      const duplicateRecipient = (outboxStore.entries || []).some((entry) => entry.recipientHash === recipientHash
        && ["pending", "sending", "accepted", "uncertain"].includes(entry.status));
      if (errors.length || !company || !email || isSuppressed(email) || companyDailyLimitReached || duplicateRecipient || seenRecipients.has(recipientHash)) {
        blocked.push({ jobId: job.id, draftIndex: index, company: draft.company, reasons: [...errors, ...(isSuppressed(email) ? ["收件人已抑制"] : []), ...(companyDailyLimitReached ? [`公司今日已达到${MAX_PIPELINE_CONTACTS_PER_COMPANY_DAILY}位联系人上限`] : []), ...(duplicateRecipient ? ["收件人已发送"] : [])] });
        continue;
      }
      if (selected.length >= selectionLimit) break;
      selected.push({ jobId: job.id, draftIndex: index, company: draft.company, contactName: draft.contactName, emailFingerprint: publicFingerprint(recipientHash) });
      companyDailyCounts.set(companyHash, Number(companyDailyCounts.get(companyHash) || 0) + 1);
      seenRecipients.add(recipientHash);
    }
    if (selected.length >= selectionLimit) break;
  }
  const fleet = senderFleetUsage();
  const hasLegacyApproval = jobs.some((job) => job.currentStage === "approval" && job.status === "waiting_input");
  const hasCentralReview = jobs.some((job) => job.status === "batch_review");
  const selectedCompanyCount = new Set(selected
    .map((item) => normalizeCompanyName(item.company).toLowerCase())
    .filter(Boolean)).size;
  const managedTask = (operationsStore.tasks || []).find((task) => (
    task.automation?.mode === "managed"
    && task.counters?.businessDate === daily.businessDate
    && !["completed", "cancelled"].includes(task.status)
  ));
  const processingStrategy = resolveCompanyProcessingStrategy(
    { legacyTarget: managedTask?.budgets?.validEmailCompaniesDaily || 100 },
    { enabled: process.env.COMPANY_PROCESSING_STRATEGY_ENABLED, target: process.env.COMPANY_PROCESSING_FIXED_TARGET },
  );
  const companyTarget = processingStrategy.dailyCompanyTarget;
  const todayQualifiedCompanies = Math.min(
    selectedCompanyCount,
    Math.max(0, Number(managedTask?.counters?.qualifiedCompanies || 0)),
  );
  return {
    businessDate: daily.businessDate,
    reserveMode,
    centralOnly,
    limit: Math.min(limit, daily.limit),
    remaining: daily.remaining,
    senderCapacity: { accounts: fleet.accounts.length, perAccount: fleet.limitPerAccount, remaining: fleet.accounts.reduce((sum, item) => sum + item.remaining, 0) },
    selected,
    selectedCompanyCount,
    inventory: {
      previousRemainingCompanies: Math.max(selectedCompanyCount - todayQualifiedCompanies, 0),
      todayQualifiedCompanies,
      totalCompanies: selectedCompanyCount,
      target: companyTarget,
      ready: selectedCompanyCount >= companyTarget,
    },
    blockedCount: blocked.length,
    blocked: blocked.slice(0, 100),
    sendsRequireApproval: hasLegacyApproval,
    requiresCentralReview: hasCentralReview,
  };
}

async function pipelineDraftPoolStats() {
  let totalDrafts = 0;
  let sentDrafts = 0;
  const countedStatuses = new Set(["pending", "sending", "accepted", "uncertain"]);
  const sentKeys = new Set((outboxStore.entries || [])
    .filter((entry) => countedStatuses.has(entry.status) && String(entry.recipientId || "").startsWith("pipeline-draft-"))
    .map((entry) => `${entry.campaignId}:${entry.recipientId}`));
  for (const job of pipelineStore.jobs || []) {
    const reference = latestPipelineArtifact(job, "drafting");
    if (!reference) continue;
    let artifact;
    try { artifact = await readPipelineArtifact(job, "drafting"); } catch { continue; }
    for (const [index] of (artifact.drafts || []).entries()) {
      totalDrafts += 1;
      if (sentKeys.has(`${job.id}:pipeline-draft-${index}`)) sentDrafts += 1;
    }
  }
  return { total: totalDrafts, sent: sentDrafts, remaining: Math.max(totalDrafts - sentDrafts, 0) };
}

async function pipelineInventory(limit = deliveryConfig.dailyLimit) {
  const [batch, currentBatch, draftPool] = await Promise.all([
    dailyPipelineBatch(limit, true, true),
    dailyPipelineBatch(limit, false, true),
    pipelineDraftPoolStats(),
  ]);
  const inventory = { ...batch, currentSendableCount: Number(currentBatch.selected?.length || 0) };
  return { ...inventory, draftPool, managedCycle: managedDailyCycleState(), dailyStatus: dailyTaskStatus(inventory, draftPool) };
}

function dailyTaskStatus(batch, draftPool) {
  const task = (operationsStore.tasks || []).find((item) => (
    item.automation?.mode === "managed" && !["completed", "cancelled"].includes(item.status)
  ));
  const taskId = task?.id;
  const jobs = (pipelineStore.jobs || []).filter((job) => !taskId || job.operationTaskId === taskId);
  const currentDayJob = (job) => businessDateFor(new Date(job.updatedAt || job.createdAt || 0)) === currentBusinessDate();
  const queues = (contactCollectionStore.queues || []).filter((queue) => (
    String(queue.key || "").includes(`_${task?.hsCode || ""}_page_`)
  ));
  const activeOutbox = (outboxStore.entries || []).some((entry) => entry.status === "sending");
  const circuitOpen = Boolean(
    runtimeStateStore.deliveryCircuit?.open
    || task?.safetyState === "CIRCUIT_OPEN"
    || jobs.some((job) => currentDayJob(job) && job.status === "circuit_open")
    || queues.some((queue) => ["circuit_open"].includes(queue.status)),
  );
  const paused = task?.status === "paused"
    || task?.safetyState === "HUMAN_RECOVERY"
    || jobs.some((job) => currentDayJob(job) && job.status === "paused")
    || queues.some((queue) => queue.status === "paused");
  const waitingInput = jobs.some((job) => currentDayJob(job) && job.status === "waiting_input" && job.currentStage !== "feedback");
  const sending = activeOutbox || jobs.some((job) => currentDayJob(job) && (
    job.currentStage === "sending" || job.stages?.sending?.status === "running"
  ));
  const drafting = jobs.some((job) => currentDayJob(job) && (
    ["queued", "running"].includes(job.status) && (job.currentStage === "drafting" || job.stages?.drafting?.status === "running")
  ));
  const inventoryReady = Boolean(batch.inventory?.ready);
  const currentSendableCount = Number(batch.currentSendableCount ?? batch.selected?.length ?? 0);
  const hasSendable = currentSendableCount > 0;
  const cycle = managedDailyCycleState();
  const daily = dailyDeliveryUsage();
  const collecting = !cycle.collectionLocked && !inventoryReady && (
    task?.status === "active"
    || queues.some((queue) => ["ready", "running"].includes(queue.status) && Number(queue.counts?.remaining || 0) > 0)
  );
  const dailyComplete = daily.remaining <= 0 || (
    cycle.collectionLocked && !hasSendable && !sending && !drafting && !collecting && !waitingInput && !paused
  );
  let code = "ended";
  let label = "当日任务已结束";
  let detail = "当日采集、草稿和发件任务均无待执行项。";
  if (dailyComplete) {
    detail = circuitOpen
      ? `今日发送额度已完成；退信熔断仍在后台冷却，当前剩余 ${Number(batch.inventory?.totalCompanies || 0)} 家结转明日。`
      : `今日单向循环已完成；当前剩余 ${Number(batch.inventory?.totalCompanies || 0)} 家将作为明日起始库存。`;
  } else if (circuitOpen) {
    code = "circuit_open";
    label = "熔断中";
    detail = task?.requiredInput || "系统已暂停自动操作，等待熔断恢复。";
  } else if (paused || waitingInput) {
    code = "aborted";
    label = "意外终止";
    detail = task?.requiredInput || jobs.find((job) => job.requiredInput)?.requiredInput || "任务被暂停，等待处理异常。";
  } else if (sending || ((inventoryReady || cycle.collectionLocked) && hasSendable)) {
    code = "sending";
    label = "发件中";
    detail = `${currentSendableCount} 封候选邮件等待或正在通过发件通道处理。`;
  } else if (drafting) {
    code = "drafting";
    label = "写草稿中";
    detail = `${Number(draftPool?.remaining || 0)} 封草稿仍在池中，流水线正在生成或整理邮件。`;
  } else if (collecting) {
    code = "collecting";
    label = "联系人采集中";
    detail = `发件公司库存 ${Number(batch.inventory?.totalCompanies || 0)} / ${Number(batch.inventory?.target || 100)} 家，达到目标后进入发件。`;
  } else if (cycle.collectionLocked) {
    code = "ended";
    label = "当日任务已结束";
    detail = `今日采集已锁定；当前剩余 ${Number(batch.inventory?.totalCompanies || 0)} 家将作为明日起始库存。`;
  }
  return { code, label, detail, updatedAt: new Date().toISOString() };
}

async function pipelineDraftInbox(limit = 500) {
  const items = [];
  let totalDrafts = 0;
  let jobCount = 0;
  for (const job of pipelineStore.jobs || []) {
    const reference = latestPipelineArtifact(job, "drafting");
    if (!reference) continue;
    let artifact;
    try { artifact = await readPipelineArtifact(job, "drafting"); } catch { continue; }
    if (!Array.isArray(artifact.drafts) || !artifact.drafts.length) continue;
    jobCount += 1;
    totalDrafts += artifact.drafts.length;
    for (const [index, draft] of artifact.drafts.entries()) {
      if (items.length >= limit) break;
      items.push({
        id: `${job.id}:${index}`,
        jobId: job.id,
        hsCode: job.hsCode,
        jobStatus: job.status,
        currentStage: job.currentStage,
        updatedAt: job.updatedAt,
        index,
        company: String(draft.company || "").slice(0, 300),
        contactName: String(draft.contactName || "").slice(0, 200),
        contactRole: String(draft.contactRole || "").slice(0, 200),
        email: String(draft.email || "").slice(0, 320),
        country: String(draft.country || "").slice(0, 120),
        subject: String(draft.subject || "").slice(0, 500),
        body: String(draft.body || "").slice(0, 12000),
        wordCount: Number(draft.wordCount) || 0,
        warnings: Array.isArray(draft.warnings) ? draft.warnings.map((item) => String(item).slice(0, 300)).slice(0, 10) : [],
        approvalStatus: String(draft.approvalStatus || "").slice(0, 100),
      });
    }
  }
  return { items, counts: { totalDrafts, returned: items.length, jobs: jobCount, truncated: totalDrafts > items.length } };
}

function latestPipelineArtifact(job, stage) {
  return [...(job.artifacts || [])].reverse().find((item) => item.stage === stage)?.reference || "";
}

async function readPipelineArtifact(job, stage) {
  const reference = latestPipelineArtifact(job, stage);
  if (!reference.startsWith("file://")) throw Object.assign(new Error(`流水线${stage}产物引用无效`), { status: 422 });
  const filePath = path.resolve(fileURLToPath(reference));
  const relative = path.relative(path.resolve(pipelineArtifactDir), filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative) || path.extname(filePath).toLowerCase() !== ".json") {
    throw Object.assign(new Error("流水线产物不在允许目录内"), { status: 422 });
  }
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function pipelineDraftErrors(draft) {
  const errors = [];
  if (!validEmail(draft?.email)) errors.push("收件人邮箱无效");
  if (!String(draft?.contactName || "").trim()) errors.push("缺少具名联系人");
  if (!String(draft?.company || "").trim()) errors.push("缺少联系人公司");
  if (!String(draft?.subject || "").trim() || !String(draft?.body || "").trim()) errors.push("邮件主题或正文为空");
  const words = englishWordCount(draft?.body || "");
  if (words < 80 || words > 130) errors.push(`正文${words}词，需控制在80-130词`);
  if (/\bHS\s*Code\b|\bcustoms\b|import records?/i.test(draft?.body || "")) errors.push("正文不得暴露HSCode或海关数据来源");
  if (/\b(?:I am|I'm|I work|my name is)\b/i.test(draft?.body || "")) errors.push("第一轮必须使用公司口吻");
  if ((draft?.warnings || []).length) errors.push("草稿仍有质量警告");
  return errors;
}

function pipelineSendBlockers(job, drafts, { centralReview = false } = {}) {
  const errors = [];
  const daily = dailyDeliveryUsage();
  if (runtimeStateStore.deliveryCircuit.open) errors.push(`发送熔断已开启：${runtimeStateStore.deliveryCircuit.reason}`);
  if (daily.remaining <= 0) errors.push(`北京时间${daily.businessDate}的每日发送硬上限${daily.limit}封已用完`);
  if (!deliveryConfig.enabled) errors.push("EMAIL_SENDING_ENABLED未开启");
  if (!isSmtpConfigured()) errors.push("SMTP配置不完整");
  if (!senderFleetUsage().accounts.some((item) => item.remaining > 0) && !(isSmtpConfigured() && activeSenderUsagePolicy() !== "business_communication_only_no_marketing")) errors.push("十账号当日额度已用完或没有合规可用账号");
  if (activeSenderUsagePolicy() === "business_communication_only_no_marketing") errors.push("当前发件域名尚未记录小批量商务交流授权");
  if (!FEEDBACK_WEBHOOK_SECRET) errors.push("反馈回调未配置");
  const profileReadiness = senderProfileReadiness();
  if (!profileReadiness.readyForCanary) errors.push(...profileReadiness.missingFields.map((item) => `发件身份缺少：${item}`));
  if (!deliveryConfig.physicalAddress) errors.push("缺少发件方实体地址");
  const companyCounts = new Map();
  for (const draft of drafts) {
    errors.push(...pipelineDraftErrors(draft));
    if (isSuppressed(draft.email)) errors.push(`收件人已进入抑制名单：${draft.contactName}`);
    const companyHash = stableId("company", normalizeCompanyName(draft.company));
    companyCounts.set(companyHash, Number(companyCounts.get(companyHash) || 0) + 1);
    if (companyCounts.get(companyHash) > MAX_PIPELINE_CONTACTS_PER_COMPANY_DAILY) errors.push(`同一公司每日最多触达${MAX_PIPELINE_CONTACTS_PER_COMPANY_DAILY}位联系人：${draft.company}`);
    const duplicateRecipient = (outboxStore.entries || []).some((entry) => (
      entry.recipientHash === emailFingerprint(draft.email)
      && ["pending", "sending", "accepted", "uncertain"].includes(entry.status)
    ));
    if (duplicateRecipient) errors.push(`收件人已在发件箱中：${draft.contactName}`);
    const companyContactedToday = (outboxStore.entries || []).filter((entry) => (
      entry.companyHash === companyHash
      && businessDateFor(new Date(entry.createdAt || entry.updatedAt || 0)) === daily.businessDate
      && ["pending", "sending", "accepted", "uncertain"].includes(entry.status)
    )).length;
    if (companyContactedToday + companyCounts.get(companyHash) > MAX_PIPELINE_CONTACTS_PER_COMPANY_DAILY) errors.push(`该公司今日将超过${MAX_PIPELINE_CONTACTS_PER_COMPANY_DAILY}位联系人上限：${draft.company}`);
  }
  if (!centralReview && !job.approval?.recipientEvidence?.length) errors.push("缺少收件人个人级可投递和在职证据");
  return [...new Set(errors)];
}

async function sendPipelineDraftBatch(job, drafts, draftIndexes) {
  const results = [];
  for (let index = 0; index < Math.min(drafts.length, calculateDeliveryCapacity().availableCapacity); index += 1) {
    await maybeRecoverDeliveryCircuit();
    if (runtimeStateStore.deliveryCircuit.open) {
      results.push({
        draftIndex: draftIndexes[index],
        status: "circuit_open",
        error: `发送熔断已开启：${runtimeStateStore.deliveryCircuit.reason}`,
      });
      break;
    }
    const draft = drafts[index];
    const draftIndex = draftIndexes[index];
    const recipient = { id: `pipeline-draft-${draftIndex}`, email: draft.email };
    let outboxEntry;
    try {
      const sender = selectSenderAccount();
      outboxEntry = await prepareOutboxEntry({ id: job.id }, recipient, sender);
      outboxEntry.companyHash = stableId("company", normalizeCompanyName(draft.company));
      await transitionOutbox(outboxEntry, "sending");
      await maybeRecoverDeliveryCircuit();
      if (runtimeStateStore.deliveryCircuit.open) {
        const reason = `发送熔断已开启：${runtimeStateStore.deliveryCircuit.reason}`;
        await transitionOutbox(outboxEntry, "failed", { lastError: reason });
        results.push({ draftIndex, status: "circuit_open", error: reason, outboxId: outboxEntry.id });
        break;
      }
      const delivery = await sendSmtpMessage({ to: draft.email, subject: draft.subject, body: draft.body, messageId: outboxEntry.messageId }, sender.config);
      await transitionOutbox(outboxEntry, "accepted", { providerResponse: delivery.response });
      results.push({ draftIndex, status: "accepted", outboxId: outboxEntry.id });
    } catch (error) {
      const status = error.deliveryUncertain ? "uncertain" : "failed";
      if (outboxEntry) await transitionOutbox(outboxEntry, status, { lastError: error.message });
      results.push({ draftIndex, status, error: clipText(error.message, 240) });
      break;
    }
    if (index < drafts.length - 1) await delay(deliveryConfig.delayMs);
  }
  return results;
}

function scenarioValidationErrors(scenario, brief) {
  const labels = {
    hsCode: "HSCode",
    productFocus: "产品方向",
    buyerEvidence: "采购商业务证据",
    eventName: "展会名称",
    eventDates: "展会日期",
    eventBooth: "展位号",
    eventAddress: "展会地址",
    meetingLocation: "约见地点",
  };
  return scenario.requiredFields
    .filter((field) => !String(brief[field] || "").trim())
    .map((field) => `缺少${labels[field] || field}`);
}

function normalizedDraftBrief(input) {
  return {
    hsCode: clipText(input.hsCode, 40),
    productFocus: clipText(input.productFocus, 500),
    buyerEvidence: clipText(input.buyerEvidence || input.tradeContent),
    eventName: clipText(input.eventName, 300),
    eventDates: clipText(input.eventDates, 200),
    eventBooth: clipText(input.eventBooth, 120),
    eventAddress: clipText(input.eventAddress, 500),
    meetingLocation: clipText(input.meetingLocation, 500),
  };
}

function claimViolations(text, approvedClaimIds) {
  const approved = new Set(approvedClaimIds || []);
  return GUARDED_CLAIMS
    .filter((claim) => !approved.has(claim.id) && claim.pattern.test(String(text || "")))
    .map((claim) => claim.label);
}

async function generateAiDraft(input) {
  if (!process.env.OPENAI_API_KEY) {
    throw Object.assign(new Error("OPENAI_API_KEY尚未配置"), { status: 503 });
  }

  const brief = normalizedDraftBrief(input);
  const tradeContent = brief.buyerEvidence;
  const companyBusiness = clipText(input.companyBusiness);
  if (!tradeContent || !companyBusiness) {
    throw Object.assign(new Error("贸易内容和我方业务说明不能为空"), { status: 422 });
  }

  const scenario = SCENARIO_BY_ID.get(String(input.scenario || "first_touch")) || SCENARIO_BY_ID.get("first_touch");
  const validationErrors = scenarioValidationErrors(scenario, brief);
  if (validationErrors.length) {
    throw Object.assign(new Error(`场景资料不完整：${validationErrors.join("、")}`), { status: 422 });
  }

  const approvedClaimIds = [...new Set((Array.isArray(input.approvedClaims) ? input.approvedClaims : [])
    .map((item) => String(item))
    .filter((item) => CLAIM_BY_ID.has(item)))];
  const selectedAssetIds = [...new Set((Array.isArray(input.assetIds) ? input.assetIds : [])
    .map((item) => String(item))
    .filter((item) => ASSET_BY_ID.has(item)))].slice(0, scenario.maxAssets);
  if (selectedAssetIds.length && !input.assetRightsConfirmed) {
    throw Object.assign(new Error("选择配图后必须确认对外使用权"), { status: 422 });
  }
  const missingAssetClaims = selectedAssetIds
    .map((id) => ASSET_BY_ID.get(id))
    .filter((asset) => asset.requiredClaim && !approvedClaimIds.includes(asset.requiredClaim))
    .map((asset) => asset.label);
  if (missingAssetClaims.length) {
    throw Object.assign(new Error(`配图尚未完成对外使用批准：${missingAssetClaims.join("、")}`), { status: 422 });
  }

  const approvedClaims = approvedClaimIds.map((id) => CLAIM_BY_ID.get(id).text);
  const selectedAssets = selectedAssetIds.map((id) => {
    const asset = ASSET_BY_ID.get(id);
    return { id: asset.id, label: asset.label };
  });

  const facts = {
    scenario: scenario.id,
    scenario_goal: scenario.goal,
    target_word_range: scenario.wordRange,
    hs_code_for_internal_matching_only: brief.hsCode,
    product_focus: brief.productFocus,
    buyer_company: clipText(input.buyerCompany, 300) || "{{company}}",
    buyer_country: clipText(input.buyerCountry, 120),
    contact_full_name: clipText(input.contactName, 200),
    contact_first_name: contactFirstName(input.contactName),
    contact_role: clipText(input.contactRole, 200),
    verified_buyer_evidence: brief.buyerEvidence,
    sender_company: clipText(input.senderCompany, 200) || "DaKings Printing Company",
    sender_identity_policy: "Company identity only for first-round outreach. No employee name, personal title, or personal contact details.",
    sender_name: "",
    sender_title: "",
    sender_email: clipText(input.senderEmail, 320),
    sender_phone: clipText(input.senderPhone, 120),
    sender_website: clipText(input.senderWebsite, 320),
    sender_business: companyBusiness,
    avoid_subjects: (Array.isArray(input.avoidSubjects) ? input.avoidSubjects : []).map((item) => clipText(item, 240)).filter(Boolean).slice(-10),
    approved_optional_claims: approvedClaims,
    selected_inline_assets: selectedAssets,
    template_version: EMAIL_TEMPLATE_LIBRARY.version,
    template_global_rules: EMAIL_TEMPLATE_LIBRARY.globalRules,
    template_scenario_blueprint: EMAIL_TEMPLATE_LIBRARY.scenarios[scenario.id],
    event: {
      name: brief.eventName,
      dates: brief.eventDates,
      booth: brief.eventBooth,
      address: brief.eventAddress,
      meeting_location: brief.meetingLocation,
    },
    desired_language: clipText(input.language, 40) || "English",
    tone: clipText(input.tone, 80) || "concise and professional",
  };

  const instructions = [
    "You write permission-based B2B trade outreach emails.",
    "Use only facts supplied by the user. Never invent certifications, clients, prices, shipment history, capabilities, or relationship claims.",
    "Treat the supplied template as a structural blueprint, not text to copy. Correct the source style into natural business English.",
    "Follow the supplied scenario goal and target word range. Use one specific buyer-relevance sentence and one low-pressure call to action.",
    "The HS code is internal matching context. Never mention the HS code, customs records, import data, scraping, or how the buyer was discovered.",
    "Adapt the value proposition and call to action to the contact role. Procurement may receive a quotation/RFQ ask; logistics may receive pack-out or delivery questions; editorial may receive format and finishing questions.",
    "Start with Hi plus contact_first_name. Never greet a named contact with their full name. Do not use How are you, dear, long-time admirer language, fake familiarity, or unsupported praise.",
    "Write a 4-8 word subject adapted to the contact role and product relevance. Do not repeat any subject in avoid_subjects.",
    "Only use optional claims listed under approved_optional_claims. If selected_inline_assets is empty, do not mention attached or included images.",
    "For exhibition scenarios, include only the supplied event details and ask for a specific short meeting window or reply.",
    "This is a first-round company email. Write in the company voice using we/our, never I/my. Do not invent or include an employee name, employee title, or personal signature.",
    "Preserve {{first_name}} and {{company}} exactly when they appear.",
    "Do not use hype, false urgency, tracking claims, deceptive subject lines, multiple calls to action, or more than one exclamation mark.",
    "End with the sender company name only, followed only by supplied company contact fields when useful.",
    "Return only valid JSON with exactly two string fields: subject and body.",
  ].join(" ");

  const attemptedAt = new Date().toISOString();
  await updateAiRuntime({ lastAttemptAt: attemptedAt, lastError: "" });
  let { payload, draft } = await requestAiDraftCompletion(instructions, facts);
  draft.body = enforceGreeting(draft.body, facts.contact_first_name);
  let wordCount = englishWordCount(draft.body);
  let rewrittenForLength = false;
  if (wordCount < scenario.wordRange[0] || wordCount > scenario.wordRange[1]) {
    await delay(AI_MIN_INTERVAL_MS);
    ({ payload, draft } = await requestAiDraftCompletion(
      instructions,
      facts,
      `Rewrite the email once so the body is ${scenario.wordRange[0]}-${scenario.wordRange[1]} English words, while preserving the same verified facts and exactly one call to action.`,
    ));
    draft.body = enforceGreeting(draft.body, facts.contact_first_name);
    wordCount = englishWordCount(draft.body);
    rewrittenForLength = true;
  }
  const violations = claimViolations(`${draft.subject}\n${draft.body}`, approvedClaimIds);
  if (violations.length) {
    throw Object.assign(new Error(`模型草稿包含未批准卖点：${violations.join("、")}`), { status: 502 });
  }
  const warnings = [];
  if (wordCount < scenario.wordRange[0] || wordCount > scenario.wordRange[1]) {
    warnings.push(`正文${wordCount}词，建议范围${scenario.wordRange[0]}-${scenario.wordRange[1]}词`);
  }
  if (/\bHS\s*Code\b|customs?|import records?/i.test(draft.body)) warnings.push("正文不应暴露HSCode或海关数据来源");
  await updateAiRuntime({ reachable: true, lastSuccessAt: new Date().toISOString(), lastError: "" });
  return {
    ...draft,
    model: payload.model || OPENAI_MODEL,
    scenario: scenario.id,
    wordCount,
    warnings,
    assetIds: selectedAssetIds,
    templateVersion: EMAIL_TEMPLATE_LIBRARY.version,
    rewrittenForLength,
  };
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ""));
}

const SENDER_PROFILE_FIELDS = [
  ["companyDisplayName", "对外公司名"],
  ["companyLegalName", "公司法定名称"],
  ["senderEmail", "发件邮箱"],
  ["replyTo", "Reply-To邮箱"],
  ["website", "公司网站"],
  ["physicalAddress", "实体地址"],
  ["unsubscribeReplyMailbox", "公司退订邮箱"],
];
const PLACEHOLDER_PATTERN = /\[待填写|\[placeholder\]|\b(?:todo|tbd|placeholder)\b/i;

function hasPlaceholder(value) {
  return PLACEHOLDER_PATTERN.test(String(value || ""));
}

function httpsUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

function senderProfileReadiness(profile = senderProfileStore) {
  const missingFields = [];
  const placeholderFields = [];
  for (const [key, label] of SENDER_PROFILE_FIELDS) {
    const value = String(profile[key] || "").trim();
    if (!value) missingFields.push(label);
    else if (hasPlaceholder(value)) placeholderFields.push(label);
  }
  if (profile.senderEmail && !validEmail(profile.senderEmail)) missingFields.push("发件邮箱格式");
  if (profile.replyTo && !validEmail(profile.replyTo)) missingFields.push("Reply-To邮箱格式");
  if (profile.unsubscribeReplyMailbox && !validEmail(profile.unsubscribeReplyMailbox)) missingFields.push("退订回复邮箱格式");
  if (["hosted_link", "hosted_link_and_reply"].includes(profile.unsubscribeMode)) {
    if (!profile.unsubscribeBaseUrl) missingFields.push("退订HTTPS地址");
    else if (hasPlaceholder(profile.unsubscribeBaseUrl)) placeholderFields.push("退订HTTPS地址");
    else if (!httpsUrl(profile.unsubscribeBaseUrl)) missingFields.push("退订地址必须使用HTTPS");
    if (!unsubscribeHmacSecret) missingFields.push("退订HMAC密钥");
  }
  const hasPlaceholders = placeholderFields.length > 0;
  const complete = missingFields.length === 0 && placeholderFields.length === 0;
  return {
    complete,
    hasPlaceholders,
    readyForCanary: complete && !hasPlaceholders,
    missingFields: [...new Set(missingFields)],
    placeholderFields: [...new Set(placeholderFields)],
  };
}

function cleanSenderProfileInput(input) {
  const source = input && typeof input === "object" ? input : {};
  const next = { ...senderProfileStore };
  const textFields = ["companyLegalName", "companyLegalNameZh", "unifiedSocialCreditCode", "legalRepresentative", "registeredCapital", "establishedDate", "businessTerm", "registrationAddress", "businessScope", "legalIdentityStatus", "legalIdentityConfirmedAt", "legalIdentityConfirmedBy", "companyDisplayName", "senderEmail", "replyTo", "phone", "website", "physicalAddress", "unsubscribeMode", "unsubscribeBaseUrl", "unsubscribeReplyMailbox", "updatedBy"];
  for (const key of textFields) {
    if (source[key] !== undefined) next[key] = String(source[key] || "").replace(/[\r\n]+/g, " ").trim().slice(0, 300);
  }
  if (!["hosted_link_and_reply", "hosted_link", "reply_only"].includes(next.unsubscribeMode)) {
    throw Object.assign(new Error("不支持的退订策略"), { status: 422 });
  }
  next.identityMode = "company_first_round";
  next.senderName = "";
  next.senderTitle = "";
  next.replyRouting = "company_inbox";
  next.secondRound = { status: "reserved_blank", subject: "", body: "" };
  const readiness = senderProfileReadiness(next);
  if (next.senderEmail && !validEmail(next.senderEmail)) throw Object.assign(new Error("发件邮箱格式不正确"), { status: 422 });
  if (next.replyTo && !validEmail(next.replyTo)) throw Object.assign(new Error("Reply-To邮箱格式不正确"), { status: 422 });
  if (next.unsubscribeReplyMailbox && !validEmail(next.unsubscribeReplyMailbox)) throw Object.assign(new Error("退订回复邮箱格式不正确"), { status: 422 });
  if (next.unsubscribeBaseUrl && !hasPlaceholder(next.unsubscribeBaseUrl) && !httpsUrl(next.unsubscribeBaseUrl)) {
    throw Object.assign(new Error("退订地址必须是HTTPS URL"), { status: 422 });
  }
  next.status = readiness.readyForCanary ? "configured" : "placeholder";
  return { ...next, version: 1, updatedAt: new Date().toISOString() };
}

function publicSenderProfile() {
  const readiness = senderProfileReadiness();
  return {
    ...senderProfileStore,
    readiness,
    effective: {
      from: deliveryConfig.from,
      fromName: deliveryConfig.fromName,
      replyTo: deliveryConfig.replyTo,
      unsubscribeUrl: deliveryConfig.unsubscribeUrl,
      unsubscribeReplyMailbox: deliveryConfig.unsubscribeReplyMailbox,
      physicalAddress: deliveryConfig.physicalAddress,
    },
    unsubscribeHmac: {
      configured: Boolean(unsubscribeHmacSecret),
      algorithm: "HMAC-SHA256",
      activeForReplyOnly: false,
    },
    accountFleet: publicSenderAccounts(),
  };
}

function publicSenderAccounts() {
  return (senderAccountsStore.domains || []).map((domain) => ({
    domain: domain.domain,
    status: domain.status || "planned",
    usagePolicy: domain.usagePolicy || "",
    accountCount: Array.isArray(domain.accounts) ? domain.accounts.length : 0,
    verifiedCount: Array.isArray(domain.accounts)
      ? domain.accounts.filter((account) => account.smtpAuthStatus === "passed_local_and_server_application_password").length
      : 0,
    accounts: (domain.accounts || []).map((account) => ({
      address: account.address,
      displayName: account.displayName,
      role: account.role,
      smtpAuthStatus: account.smtpAuthStatus,
      webLoginStatus: account.webLoginStatus,
    })),
  }));
}

function senderUsagePolicy(address = deliveryConfig.from) {
  const senderDomain = String(address || "").split("@").at(-1)?.trim().toLowerCase();
  if (!senderDomain) return "";
  return (senderAccountsStore.domains || []).find((domain) => (
    String(domain.domain || "").trim().toLowerCase() === senderDomain
  ))?.usagePolicy || "";
}

function sendingEnabled() {
  return deliveryConfig.enabled
    && isSmtpConfigured()
    && activeSenderUsagePolicy() !== "business_communication_only_no_marketing";
}

function sendableRecipients(model, campaign) {
  const delivered = new Set(campaign?.delivery?.recipientHashes || []);
  const lockedOutboxRecipients = new Set((outboxStore.entries || [])
    .filter((entry) => ["pending", "sending", "accepted", "uncertain"].includes(entry.status))
    .map((entry) => entry.recipientHash));
  return campaignRecipients(model, campaign).filter((recipient) => (
    validEmail(recipient.email)
    && !isSuppressed(recipient.email)
    && recipient.validationStatus !== "invalid"
    && recipient.validationStatus !== "opted_out"
    && (recipient.validationStatus === "deliverable" || deliveryConfig.allowUnverified)
    && !delivered.has(stableId("delivery", normalize(recipient.email)))
    && !lockedOutboxRecipients.has(emailFingerprint(recipient.email))
  ));
}

function sendReadiness(model, campaign) {
  const errors = [];
  const profileReadiness = senderProfileReadiness();
  const daily = dailyDeliveryUsage();
  if (runtimeStateStore.deliveryCircuit.open) errors.push(`发送熔断已开启：${runtimeStateStore.deliveryCircuit.reason}`);
  if (daily.remaining <= 0) errors.push(`北京时间${daily.businessDate}的每日发送硬上限${daily.limit}封已用完`);
  if (!deliveryConfig.enabled) errors.push("EMAIL_SENDING_ENABLED未开启");
  if (!isSmtpConfigured()) errors.push("SMTP配置不完整");
  if (!senderFleetUsage().accounts.some((item) => item.remaining > 0) && !(isSmtpConfigured() && activeSenderUsagePolicy() !== "business_communication_only_no_marketing")) errors.push("十账号当日额度已用完或没有合规可用账号");
  if (activeSenderUsagePolicy() === "business_communication_only_no_marketing") {
    errors.push("当前发件域名只允许正常商务通信，不允许营销或开发信");
  }
  if (!FEEDBACK_WEBHOOK_SECRET) errors.push("反馈回调未配置");
  if (!profileReadiness.readyForCanary) {
    if (profileReadiness.missingFields.length) errors.push(`发件身份缺少：${profileReadiness.missingFields.join("、")}`);
    if (profileReadiness.placeholderFields.length) errors.push(`发件身份仍含占位符：${profileReadiness.placeholderFields.join("、")}`);
  }
  if (["hosted_link", "hosted_link_and_reply"].includes(senderProfileStore.unsubscribeMode) && !deliveryConfig.unsubscribeUrl) errors.push("缺少退订地址");
  if (["reply_only", "hosted_link_and_reply"].includes(senderProfileStore.unsubscribeMode) && !deliveryConfig.unsubscribeReplyMailbox) errors.push("缺少公司退订邮箱");
  if (!deliveryConfig.physicalAddress) errors.push("缺少发件方实体地址");
  if (!campaign || !["approved", "partially_sent"].includes(campaign.status)) errors.push("活动尚未进入已批准发送状态");
  if (campaign) {
    errors.push(...campaignContentErrors(campaign));
    const checks = campaign.compliance || {};
    if (!checks.senderDomainVerified) errors.push("发件域名未确认");
    if (!checks.unsubscribeConfigured) errors.push("退订机制未确认");
    if (!checks.physicalAddressConfigured) errors.push("实体地址未确认");
    if (!checks.suppressionListChecked) errors.push("抑制名单未检查");
    if (!sendableRecipients(model, campaign).length) errors.push("没有通过发送门槛的收件人");
  }
  return { ready: errors.length === 0, errors };
}

function sanitizeHeader(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function encodeHeader(value) {
  const clean = sanitizeHeader(value);
  return /^[\x20-\x7E]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean).toString("base64")}?=`;
}

function base64Lines(value) {
  return Buffer.from(value).toString("base64").match(/.{1,76}/g)?.join("\r\n") || "";
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function buildEmailMessage({ to, subject, body, assetIds = [], messageId = "" }, smtpConfig = deliveryConfig) {
  const safeFrom = sanitizeHeader(smtpConfig.from);
  const safeFromName = sanitizeHeader(smtpConfig.fromName || deliveryConfig.fromName);
  const safeTo = sanitizeHeader(to);
  const unsubscribeUrl = sanitizeHeader(deliveryConfig.unsubscribeUrl);
  const unsubscribeMailbox = sanitizeHeader(deliveryConfig.unsubscribeReplyMailbox || deliveryConfig.replyTo);
  const unsubscribeMailto = unsubscribeMailbox
    ? `mailto:${unsubscribeMailbox}?subject=${encodeURIComponent("unsubscribe")}`
    : "";
  const unsubscribeHeaderValue = [unsubscribeUrl && `<${unsubscribeUrl}>`, unsubscribeMailto && `<${unsubscribeMailto}>`].filter(Boolean).join(", ");
  const footer = [
    "",
    "---",
    `Unsubscribe: ${unsubscribeUrl || "Reply to this email with unsubscribe"}`,
    deliveryConfig.physicalAddress,
  ].join("\n");
  const plainText = `${body.trim()}${footer}`;
  const selectedAssets = [...new Set(assetIds)]
    .map((id) => ASSET_BY_ID.get(id))
    .filter(Boolean)
    .slice(0, 2);
  const headers = [
    `From: ${safeFromName ? `${encodeHeader(safeFromName)} <${safeFrom}>` : safeFrom}`,
    `To: ${safeTo}`,
    ...(smtpConfig.replyTo ? [`Reply-To: ${sanitizeHeader(smtpConfig.replyTo)}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${sanitizeHeader(messageId || `${crypto.randomUUID()}@${smtpConfig.host}`)}>`,
    "MIME-Version: 1.0",
    ...(unsubscribeHeaderValue ? [`List-Unsubscribe: ${unsubscribeHeaderValue}`] : []),
  ];
  if (!selectedAssets.length) {
    return [
      ...headers,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(Buffer.from(plainText, "utf8")),
    ].join("\r\n");
  }

  const relatedBoundary = `rel_${crypto.randomUUID().replaceAll("-", "")}`;
  const alternativeBoundary = `alt_${crypto.randomUUID().replaceAll("-", "")}`;
  const images = selectedAssets.map((asset, index) => ({ ...asset, cid: `dakings_asset_${index + 1}` }));
  const htmlBody = escapeHtml(body.trim()).replace(/\r?\n/g, "<br>");
  const htmlFooter = [
    `<p style="margin:24px 0 0;color:#66706e;font-size:12px;line-height:1.5;border-top:1px solid #e3e8e6;padding-top:12px">`,
    unsubscribeUrl
      ? `Unsubscribe: <a href="${escapeHtml(unsubscribeUrl)}">${escapeHtml(unsubscribeUrl)}</a> or reply with “unsubscribe”<br>`
      : "Reply to this email with “unsubscribe” to opt out.<br>",
    `${escapeHtml(deliveryConfig.physicalAddress)}</p>`,
  ].join("");
  const htmlImages = images.map((asset) => (
    `<figure style="margin:18px 0 0"><img src="cid:${asset.cid}" alt="${escapeHtml(asset.label)}" style="display:block;max-width:560px;width:100%;height:auto;border:0"><figcaption style="margin-top:6px;color:#66706e;font-size:12px">${escapeHtml(asset.label)}</figcaption></figure>`
  )).join("");
  const html = `<!doctype html><html><body style="margin:0;padding:0;font-family:Arial,sans-serif;color:#1f2928;font-size:15px;line-height:1.6"><div style="max-width:600px;margin:0 auto;padding:24px">${htmlBody}${htmlImages}${htmlFooter}</div></body></html>`;
  const parts = [
    ...headers,
    `Content-Type: multipart/related; boundary="${relatedBoundary}"`,
    "",
    `--${relatedBoundary}`,
    `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
    "",
    `--${alternativeBoundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(Buffer.from(plainText, "utf8")),
    `--${alternativeBoundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(Buffer.from(html, "utf8")),
    `--${alternativeBoundary}--`,
  ];
  for (const asset of images) {
    const assetPath = asset.file?.startsWith("assets/uploads/")
      ? path.join(publicDir, asset.file)
      : path.join(publicDir, asset.file);
    const bytes = await fs.readFile(assetPath);
    parts.push(
      `--${relatedBoundary}`,
      `Content-Type: ${asset.mimeType || "image/jpeg"}; name="${asset.id}.${asset.mimeType === "image/png" ? "png" : asset.mimeType === "image/webp" ? "webp" : "jpg"}"`,
      "Content-Transfer-Encoding: base64",
      `Content-ID: <${asset.cid}>`,
      `Content-Disposition: inline; filename="${asset.id}.jpg"`,
      "",
      base64Lines(bytes),
    );
  }
  parts.push(`--${relatedBoundary}--`);
  return parts.join("\r\n");
}

function waitForSocket(socket, eventName) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off(eventName, onReady);
      socket.off("error", onError);
    };
    const onReady = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(error); };
    socket.once(eventName, onReady);
    socket.once("error", onError);
  });
}

function readSmtpResponse(socket) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => finish(new Error("SMTP响应超时")), 15000);
    const finish = (error, result) => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) reject(error); else resolve(result);
    };
    const onError = (error) => finish(error);
    const onClose = () => finish(new Error("SMTP连接意外关闭"));
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines.at(-1) || "";
      const match = last.match(/^(\d{3})\s/);
      if (match) finish(null, { code: Number(match[1]), text: buffer });
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function smtpCommand(socket, command, expectedCodes) {
  const responsePromise = readSmtpResponse(socket);
  if (command !== null) socket.write(`${command}\r\n`);
  const response = await responsePromise;
  if (!expectedCodes.includes(response.code)) {
    throw new Error(`SMTP命令失败（${response.code}）`);
  }
  return response;
}

function buildMailboxReplyMessage(message, smtpConfig) {
  const references = [...new Set([...(message.references || []), message.inReplyTo].filter(Boolean).map(cleanMessageId))].slice(-20);
  return [
    `From: ${encodeHeader(smtpConfig.fromName)} <${sanitizeHeader(smtpConfig.from)}>`,
    `To: ${sanitizeHeader(message.to)}`,
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${sanitizeHeader(message.messageId)}>`,
    ...(message.inReplyTo ? [`In-Reply-To: <${cleanMessageId(message.inReplyTo)}>`] : []),
    ...(references.length ? [`References: ${references.map((value) => `<${value}>`).join(" ")}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(Buffer.from(String(message.body || "").trim(), "utf8")),
  ].join("\r\n");
}

function activeSenderUsagePolicy() { return senderUsagePolicy(); }

function senderFleetUsage(now = new Date()) {
  const businessDate = businessDateFor(now);
  const counted = new Set(["pending", "sending", "accepted", "uncertain"]);
  const accounts = (mailboxAccountsStore.accounts || [])
    .filter((item) => item.enabled !== false)
    .map((item) => mailboxAccountConfig(item.address || item.user))
    .filter((config) => config && senderUsagePolicy(config.from) === "approved_small_batch_business_exchange")
    .map((config) => {
      const senderHash = emailFingerprint(config.from);
      const used = (outboxStore.entries || []).filter((entry) => entry.senderHash === senderHash
        && counted.has(entry.status)
        && businessDateFor(new Date(entry.createdAt || entry.updatedAt || 0)) === businessDate).length;
      return { config, senderHash, used, remaining: Math.max(deliveryConfig.accountDailyLimit - used, 0) };
    });
  return { businessDate, limitPerAccount: deliveryConfig.accountDailyLimit, accounts };
}

function getAccountHealth(account, now = new Date()) {
  const senderHash = account?.senderHash || emailFingerprint(account?.config?.from || account?.address || account?.from || account);
  const entries = (outboxStore.entries || []).filter((entry) => entry.senderHash === senderHash);
  const accepted = entries.filter((entry) => entry.status === "accepted").length;
  const hardBounces = runtimeStateStore.feedback.events.filter((event) => event.senderHash === senderHash && event.type === "hard_bounce").length;
  const complaints = runtimeStateStore.feedback.events.filter((event) => event.senderHash === senderHash && event.type === "complaint").length;
  const uncertainCount = entries.filter((entry) => entry.status === "uncertain").length;
  const smtpRejectCount = entries.filter((entry) => entry.status === "failed" || entry.lastError && /SMTP|拒绝|reject/i.test(entry.lastError)).length;
  const total = entries.length;
  const acceptedRate = total ? accepted / total : 1;
  const hardBounceRate = total ? hardBounces / total : 0;
  const recentFailures = entries.filter((entry) => entry.status === "failed").length;
  const feedbackTimes = runtimeStateStore.feedback.events.filter((event) => event.senderHash === senderHash && event.createdAt).map((event) => Date.parse(event.createdAt)).filter(Number.isFinite);
  const feedbackDelay = feedbackTimes.length ? Math.max(0, now.getTime() - Math.max(...feedbackTimes)) : 0;
  const circuitBreakerState = runtimeStateStore.deliveryCircuit.open ? "open" : "closed";
  const signals = { acceptedRate, hardBounceRate, complaintRate: total ? complaints / total : 0, uncertainCount, feedbackDelay, recentFailures, smtpRejectCount, circuitBreakerState };
  const riskLevel = complaints || hardBounces || uncertainCount || circuitBreakerState === "open" ? "high" : recentFailures || smtpRejectCount ? "medium" : "low";
  return { healthScore: riskLevel === "high" ? 25 : riskLevel === "medium" ? 60 : 100, riskLevel, signals };
}

function calculateEffectiveAccountLimit(account, health = getAccountHealth(account)) {
  const configuredLimit = deliveryCapacityConfig.accountDailyLimit;
  if (health.riskLevel === "blocked") return 0;
  if (health.riskLevel === "high") return Math.floor(configuredLimit * 0.2);
  if (health.riskLevel === "medium") return Math.floor(configuredLimit * 0.6);
  return configuredLimit;
}

function getAccountCapacity(account, now = new Date()) {
  const address = String(account?.config?.from || account?.address || account?.from || account || "").trim();
  const senderHash = account?.senderHash || emailFingerprint(address);
  const used = account?.used ?? (senderFleetUsage(now).accounts.find((item) => item.senderHash === senderHash)?.used || 0);
  const health = getAccountHealth({ senderHash, config: { from: address } }, now);
  const blockedReasons = [];
  if (runtimeStateStore.deliveryCircuit.open) blockedReasons.push("delivery_circuit_open");
  if (health.signals.uncertainCount) blockedReasons.push("uncertain_pending");
  const configuredLimit = deliveryCapacityConfig.accountDailyLimit;
  const effectiveLimit = blockedReasons.length ? 0 : calculateEffectiveAccountLimit(account, health);
  return { account: publicFingerprint(senderHash), configuredLimit, effectiveLimit, used, remaining: Math.max(effectiveLimit - used, 0), healthStatus: health.riskLevel, healthScore: health.healthScore, riskLevel: health.riskLevel, signals: health.signals, blockedReasons };
}

function selectSenderAccount() {
  const available = senderFleetUsage().accounts.filter((item) => item.remaining > 0)
    .sort((left, right) => left.used - right.used || left.config.from.localeCompare(right.config.from));
  if (!available.length && isSmtpConfigured() && senderUsagePolicy() !== "business_communication_only_no_marketing") {
    const senderHash = emailFingerprint(deliveryConfig.from);
    const used = (outboxStore.entries || []).filter((entry) => entry.senderHash === senderHash && ["pending", "sending", "accepted", "uncertain"].includes(entry.status) && businessDateFor(new Date(entry.createdAt || entry.updatedAt || 0)) === currentBusinessDate()).length;
    if (used < deliveryConfig.accountDailyLimit) return { config: deliveryConfig, senderHash, used, remaining: deliveryConfig.accountDailyLimit - used };
  }
  if (!available.length) throw Object.assign(new Error("十账号当日额度已用完或没有合规可用的SMTP账号"), { status: 423 });
  return available[0];
}

function cleanMessageId(value) {
  return sanitizeHeader(value).replace(/^<|>$/g, "").slice(0, 300);
}

async function sendSmtpMessage(message, smtpConfig = deliveryConfig, buildMessage = buildEmailMessage) {
  let socket;
  let dataSubmitted = false;
  if (smtpConfig.secure) {
    socket = tls.connect({
      host: smtpConfig.host,
      port: smtpConfig.port,
      servername: smtpConfig.host,
      rejectUnauthorized: smtpConfig.rejectUnauthorized,
    });
    await waitForSocket(socket, "secureConnect");
  } else {
    socket = net.connect({ host: smtpConfig.host, port: smtpConfig.port });
    await waitForSocket(socket, "connect");
  }

  try {
    await smtpCommand(socket, null, [220]);
    await smtpCommand(socket, `EHLO ${host}`, [250]);
    if (!smtpConfig.secure && smtpConfig.startTls) {
      await smtpCommand(socket, "STARTTLS", [220]);
      socket = tls.connect({
        socket,
        servername: smtpConfig.host,
        rejectUnauthorized: smtpConfig.rejectUnauthorized,
      });
      await waitForSocket(socket, "secureConnect");
      await smtpCommand(socket, `EHLO ${host}`, [250]);
    }
    if (!socket.encrypted && !smtpConfig.allowInsecureAuth) {
      throw new Error("拒绝在未加密SMTP连接上提交账号密码");
    }
    await smtpCommand(socket, "AUTH LOGIN", [334]);
    await smtpCommand(socket, Buffer.from(smtpConfig.user).toString("base64"), [334]);
    await smtpCommand(socket, Buffer.from(smtpConfig.pass).toString("base64"), [235]);
    await smtpCommand(socket, `MAIL FROM:<${sanitizeHeader(smtpConfig.from).replace(/^.*<|>.*$/g, "")}>`, [250]);
    await smtpCommand(socket, `RCPT TO:<${sanitizeHeader(message.to)}>`, [250, 251]);
    await smtpCommand(socket, "DATA", [354]);
    const emailMessage = await buildMessage(message, smtpConfig);
    const responsePromise = readSmtpResponse(socket);
    dataSubmitted = true;
    socket.write(`${emailMessage.replace(/^\./gm, "..")}\r\n.\r\n`);
    const accepted = await responsePromise;
    if (accepted.code !== 250) {
      const error = new Error(`SMTP邮件未被接受（${accepted.code}）`);
      error.deliveryUncertain = false;
      throw error;
    }
    await smtpCommand(socket, "QUIT", [221]);
    return { accepted: true, response: clipText(accepted.text, 500), messageId: message.messageId };
  } catch (error) {
    if (error.deliveryUncertain === undefined) error.deliveryUncertain = dataSubmitted;
    throw error;
  } finally {
    socket.destroy();
  }
}

function outboxPublicSummary() {
  const entries = outboxStore.entries || [];
  const statuses = ["pending", "sending", "accepted", "failed", "uncertain", "cancelled"];
  return {
    counts: Object.fromEntries(statuses.map((status) => [status, entries.filter((entry) => entry.status === status).length])),
    items: entries.slice(-200).reverse().map((entry) => ({
      id: entry.id,
      campaignId: entry.campaignId,
      recipientFingerprint: publicFingerprint(entry.recipientHash),
      senderFingerprint: publicFingerprint(entry.senderHash),
      status: entry.status,
      attempts: entry.attempts,
      messageId: entry.messageId,
      lastError: entry.lastError,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      events: (entry.events || []).slice(-20),
    })),
  };
}

function dailyDeliveryUsage(now = new Date()) {
  const businessDate = businessDateFor(now);
  const countedStatuses = new Set(["pending", "sending", "accepted", "uncertain"]);
  const used = (outboxStore.entries || []).filter((entry) => {
    const createdAt = new Date(entry.createdAt || entry.updatedAt || 0);
    return Number.isFinite(createdAt.getTime())
      && businessDateFor(createdAt) === businessDate
      && countedStatuses.has(entry.status);
  }).length;
  return {
    businessDate,
    used,
    limit: deliveryConfig.dailyLimit,
    remaining: Math.max(deliveryConfig.dailyLimit - used, 0),
  };
}

async function sendInterventionAlert(input) {
  if (!validEmail(OPS_ALERT_EMAIL)) throw Object.assign(new Error("OPS_ALERT_EMAIL未配置有效邮箱"), { status: 503 });
  if (!deliveryConfig.enabled || !isSmtpConfigured()) throw Object.assign(new Error("生产SMTP发送未就绪，无法发送人工介入告警"), { status: 423 });
  const code = String(input.code || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").slice(0, 80);
  const incidentId = String(input.incidentId || "").trim().replace(/[^a-zA-Z0-9:._-]+/g, "-").slice(0, 120);
  const title = clipText(String(input.title || "").trim(), 160);
  const details = clipText(String(input.details || "").trim(), 1500);
  const instructions = clipText(String(input.instructions || "").trim(), 1500);
  if (!code || !title || !instructions) throw Object.assign(new Error("告警类别、标题和介入说明不能为空"), { status: 422 });
  const daily = dailyDeliveryUsage();
  const campaign = { id: `ops-alert-${daily.businessDate}-${code}${incidentId ? `-${incidentId}` : ""}` };
  const recipient = { id: `ops-alert-${code}`, email: OPS_ALERT_EMAIL };
  const idempotencyKey = stableId("outbox", campaign.id, normalize(recipient.email));
  const existing = (outboxStore.entries || []).find((entry) => entry.idempotencyKey === idempotencyKey
    && ["pending", "sending", "accepted", "uncertain"].includes(entry.status));
  if (existing) return { ok: true, duplicate: true, status: existing.status, daily };
  if (daily.remaining <= 0) throw Object.assign(new Error(`北京时间${daily.businessDate}的每日发送硬上限${daily.limit}封已用完`), { status: 429 });

  const sender = selectSenderAccount();
  let entry;
  try {
    entry = await prepareOutboxEntry(campaign, recipient, sender);
    entry.kind = "intervention_alert";
    entry.alertCode = code;
    await transitionOutbox(entry, "sending", { type: "intervention_alert_sending" });
    const body = [
      "自动托管系统检测到需要人工介入的异常。",
      "",
      `异常类别：${code}`,
      `发生时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}`,
      details ? `异常信息：${details}` : "",
      "",
      "请按以下方式介入：",
      instructions,
      "",
      "处理完成后无需手工重跑；服务器定时器会在下一轮自动继续。",
    ].filter((line) => line !== "").join("\n");
    const delivery = await sendSmtpMessage({
      to: OPS_ALERT_EMAIL,
      subject: `【DaKings托管异常】${title}`,
      body,
      messageId: entry.messageId,
    }, sender.config, buildMailboxReplyMessage);
    await transitionOutbox(entry, "accepted", { type: "intervention_alert_accepted", providerResponse: delivery.response });
    return { ok: true, duplicate: false, status: "accepted", daily: dailyDeliveryUsage() };
  } catch (error) {
    if (entry) await transitionOutbox(entry, error.deliveryUncertain ? "uncertain" : "failed", {
      type: "intervention_alert_failed",
      lastError: error.message,
    });
    throw error;
  }
}

async function prepareOutboxEntry(campaign, recipient, sender = null) {
  const idempotencyKey = stableId("outbox", campaign.id, normalize(recipient.email));
  const recipientHash = emailFingerprint(recipient.email);
  let entry = (outboxStore.entries || []).find((item) => item.idempotencyKey === idempotencyKey);
  if (entry && ["pending", "sending", "accepted", "uncertain"].includes(entry.status)) {
    throw Object.assign(new Error(`发件箱状态为${entry.status}，禁止自动重试`), { status: 409 });
  }
  const activeRecipient = (outboxStore.entries || []).find((item) => item.recipientHash === recipientHash
    && item.idempotencyKey !== idempotencyKey
    && ["pending", "sending", "accepted", "uncertain"].includes(item.status));
  if (activeRecipient) {
    throw Object.assign(new Error("收件人已在发件箱中，禁止重复发送"), { status: 409 });
  }
  const now = new Date().toISOString();
  if (!entry) {
    entry = {
      id: `out_${crypto.randomUUID()}`,
      idempotencyKey,
      campaignId: campaign.id,
      recipientId: recipient.id,
      recipientHash,
      senderHash: sender?.senderHash || emailFingerprint(deliveryConfig.from),
      status: "pending",
      attempts: 0,
      messageId: `${crypto.randomUUID()}@${sanitizeHeader(sender?.config?.host || deliveryConfig.host)}`,
      providerResponse: "",
      lastError: "",
      createdAt: now,
      updatedAt: now,
      events: [{ at: now, status: "pending", type: "outbox_created" }],
    };
    outboxStore.entries.push(entry);
  } else {
    entry.status = "pending";
    entry.senderHash = sender?.senderHash || entry.senderHash || emailFingerprint(deliveryConfig.from);
    entry.updatedAt = now;
    entry.lastError = "";
    entry.messageId = `${crypto.randomUUID()}@${sanitizeHeader(sender?.config?.host || deliveryConfig.host)}`;
    entry.events = [...(entry.events || []), { at: now, status: "pending", type: "retry_prepared" }].slice(-100);
  }
  await writeJsonStore(outboxPath, outboxStore);
  return entry;
}

async function transitionOutbox(entry, status, details = {}) {
  const now = new Date().toISOString();
  entry.status = status;
  entry.updatedAt = now;
  if (status === "sending") entry.attempts = Number(entry.attempts || 0) + 1;
  if (details.providerResponse !== undefined) entry.providerResponse = clipText(details.providerResponse, 500);
  if (details.lastError !== undefined) entry.lastError = clipText(details.lastError, 500);
  const event = { at: now, status, type: details.type || `delivery_${status}` };
  if (details.actor !== undefined) event.actor = clipText(details.actor, 120);
  if (details.reason !== undefined) event.reason = clipText(details.reason, 500);
  entry.events = [...(entry.events || []), event].slice(-100);
  await writeJsonStore(outboxPath, outboxStore);
  return entry;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function campaignWithMetrics(model, campaign) {
  const recipients = campaignRecipients(model, campaign);
  const readiness = sendReadiness(model, campaign);
  return {
    ...campaign,
    estimatedRecipients: recipients.length,
    unverifiedRecipients: recipients.filter((item) => item.validationStatus === "unverified").length,
    sendableRecipients: sendableRecipients(model, campaign).length,
    sendingLocked: !readiness.ready,
    sendBlockers: readiness.errors,
  };
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function text(res, status, payload, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": contentType, "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""').replace(/\r?\n/g, " ")}"`;
}

function sendCsv(res, filename, headers, rows) {
  const body = `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function parseBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("请求体过大"), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("JSON格式无效"), { status: 400 });
  }
}

function cleanCampaignInput(input) {
  const cleanArray = (value) => (Array.isArray(value) ? value.map((item) => String(item).slice(0, 120)).slice(0, 50) : []);
  const scenario = SCENARIO_BY_ID.get(String(input.brief?.scenario || "first_touch")) || SCENARIO_BY_ID.get("first_touch");
  const approvedClaims = [...new Set(cleanArray(input.approvedClaims).filter((id) => CLAIM_BY_ID.has(id)))];
  const assetIds = [...new Set(cleanArray(input.assetIds).filter((id) => ASSET_BY_ID.has(id)))].slice(0, scenario.maxAssets);
  return {
    name: String(input.name || "未命名活动").trim().slice(0, 120),
    subject: String(input.subject || "").trim().slice(0, 240),
    body: String(input.body || "").trim().slice(0, 12000),
    brief: {
      scenario: scenario.id,
      hsCode: String(input.brief?.hsCode || "").trim().slice(0, 40),
      productFocus: String(input.brief?.productFocus || "").trim().slice(0, 500),
      buyerEvidence: String(input.brief?.buyerEvidence || "").trim().slice(0, MAX_AI_CONTEXT_CHARS),
      contactRole: String(input.brief?.contactRole || "").trim().slice(0, 200),
      eventName: String(input.brief?.eventName || "").trim().slice(0, 300),
      eventDates: String(input.brief?.eventDates || "").trim().slice(0, 200),
      eventBooth: String(input.brief?.eventBooth || "").trim().slice(0, 120),
      eventAddress: String(input.brief?.eventAddress || "").trim().slice(0, 500),
      meetingLocation: String(input.brief?.meetingLocation || "").trim().slice(0, 500),
    },
    approvedClaims,
    assetIds,
    assetRightsConfirmed: Boolean(input.assetRightsConfirmed),
    filters: {
      countries: cleanArray(input.filters?.countries),
      confidences: cleanArray(input.filters?.confidences),
      priorities: cleanArray(input.filters?.priorities),
      includeLowConfidence: Boolean(input.filters?.includeLowConfidence),
    },
    compliance: {
      senderDomainVerified: Boolean(input.compliance?.senderDomainVerified),
      unsubscribeConfigured: Boolean(input.compliance?.unsubscribeConfigured),
      physicalAddressConfigured: Boolean(input.compliance?.physicalAddressConfigured),
      suppressionListChecked: Boolean(input.compliance?.suppressionListChecked),
      ...(input.compliance?.sendWithImages === undefined ? {} : { sendWithImages: Boolean(input.compliance.sendWithImages) }),
    },
    batch: {
      targetCount: boundedInteger(input.batch?.targetCount, 200, 1, 200),
      imageMode: ["selected", "none"].includes(String(input.batch?.imageMode)) ? String(input.batch.imageMode) : "selected",
      sendWithImages: input.batch?.sendWithImages === undefined && input.compliance?.sendWithImages === undefined
        ? true
        : Boolean(input.batch?.sendWithImages ?? input.compliance?.sendWithImages),
    },
  };
}

function campaignAssetIds(campaign) {
  return campaign?.batch?.sendWithImages === false || campaign?.batch?.imageMode === "none" || campaign?.compliance?.sendWithImages === false
    ? []
    : (campaign?.assetIds || []);
}

function campaignContentErrors(campaign) {
  const errors = [];
  const scenario = SCENARIO_BY_ID.get(campaign.brief?.scenario || "first_touch") || SCENARIO_BY_ID.get("first_touch");
  const brief = campaign.brief || {};
  if (!campaign.subject) errors.push("缺少邮件主题");
  if (!campaign.body) errors.push("缺少邮件正文");
  errors.push(...scenarioValidationErrors(scenario, brief));
  const approvedClaims = campaign.approvedClaims || [];
  const violations = claimViolations(`${campaign.subject || ""}\n${campaign.body || ""}`, approvedClaims);
  if (violations.length) errors.push(`正文包含未批准卖点：${violations.join("、")}`);
  const assetIds = (campaign.assetIds || []).filter((id) => ASSET_BY_ID.has(id));
  if (assetIds.length > scenario.maxAssets) errors.push(`当前场景最多允许${scenario.maxAssets}张配图`);
  if (assetIds.length && !campaign.assetRightsConfirmed) errors.push("配图对外使用权尚未确认");
  const missingAssetClaims = assetIds
    .map((id) => ASSET_BY_ID.get(id))
    .filter((asset) => asset.requiredClaim && !approvedClaims.includes(asset.requiredClaim))
    .map((asset) => asset.label);
  if (missingAssetClaims.length) errors.push(`配图尚未完成卖点批准：${missingAssetClaims.join("、")}`);
  const wordCount = englishWordCount(campaign.body);
  if (campaign.body && (wordCount < scenario.wordRange[0] || wordCount > scenario.wordRange[1])) {
    errors.push(`正文${wordCount}词，需控制在${scenario.wordRange[0]}-${scenario.wordRange[1]}词`);
  }
  if (/\bHS\s*Code\b|\bcustoms\b|import records?/i.test(campaign.body || "")) errors.push("正文不得暴露HSCode或海关数据来源");
  if (/\b(?:I am|I'm|I work|my name is)\b/i.test(campaign.body || "")) errors.push("第一轮必须使用公司口吻，不得使用员工个人身份");
  const signature = String(campaign.body || "").match(/(?:Best|Kind) regards,?\s*\n\s*([^\n]+)/i)?.[1]?.trim();
  const allowedCompanyNames = [senderProfileStore.companyDisplayName, senderProfileStore.companyLegalName, ...(senderProfileStore.companyAliases || [])].filter(Boolean).map(normalize);
  if (signature && allowedCompanyNames.length && !allowedCompanyNames.some((name) => normalize(signature).includes(name))) {
    errors.push("第一轮落款必须使用公司名，不得使用员工姓名");
  }
  return [...new Set(errors)];
}

function isStoreMutationRequest(method, pathname) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return false;
  return /^\/api\/(contact-quality|suppressions|ops\/(?:tasks|intervention-alert)|contact-queues|pipeline|outbox|mailbox|campaigns|sender-profile|feedback|delivery-circuit|delivery-capacity|delivery-mode|managed-cycle|email-assets|keyword-collection|country-business-collection|company-qualification)(?:\/|$)/.test(pathname);
}

async function apiHandler(req, res, url, model) {
  const pathname = url.pathname;
  const isBackupMerge = req.method === "POST" && pathname === "/api/local-backup/merge";
  if (isBackupMerge) {
    if (backupMergeInFlight || activeStoreMutations > 0) {
      return json(res, 409, { error: "当前存在本地写入任务，请稍后重试安全合并" });
    }
    backupMergeInFlight = true;
    try {
      return await apiHandlerUnlocked(req, res, url, model);
    } finally {
      backupMergeInFlight = false;
    }
  }
  const isMutation = isStoreMutationRequest(req.method, pathname);
  if (isMutation && backupMergeInFlight) {
    return json(res, 503, { error: "控制备份正在安全合并，本次写入已拒绝" });
  }
  const deliveryMutation = isMutation && (
    /^\/api\/campaigns(?:\/|$)/.test(pathname)
    || /^\/api\/pipeline\/jobs\/[^/]+\/send$/.test(pathname)
    || pathname === "/api/pipeline/central-batch/send"
    || /^\/api\/outbox\/[^/]+\/cancel$/.test(pathname)
    || pathname === "/api/ops/intervention-alert"
  );
  const sendMatch = req.method === "POST" ? pathname.match(/^\/api\/campaigns\/([^/]+)\/send$/) : null;
  const sendCampaignId = sendMatch?.[1] || "";
  if (sendCampaignId && campaignSendsInFlight.has(sendCampaignId)) {
    return json(res, 409, { error: "该活动已有发送请求执行中，本次重复请求已拒绝" });
  }
  if (sendCampaignId) campaignSendsInFlight.add(sendCampaignId);
  if (isMutation) activeStoreMutations += 1;
  try {
    if (deliveryMutation) return await withCampaignMutation(() => apiHandlerUnlocked(req, res, url, model));
    return await apiHandlerUnlocked(req, res, url, model);
  } finally {
    if (isMutation) activeStoreMutations -= 1;
    if (sendCampaignId) campaignSendsInFlight.delete(sendCampaignId);
  }
}

async function apiHandlerUnlocked(req, res, url, model) {
  const pathname = url.pathname;
  if (req.method === "GET" && pathname === "/api/control-plane/status") {
    const auditLimit = boundedInteger(url.searchParams.get("auditLimit"), 50, 0, 200);
    return json(res, 200, await controlPlaneStatus(auditLimit));
  }
  if (req.method === "GET" && pathname === "/api/company-qualification") {
    const totals = { totalCompanies: 0, passed: 0, rejected: 0, reasons: {}, companies: [] };
    for (const job of (pipelineStore.jobs || []).slice(0, 200)) {
      const reference = latestPipelineArtifact(job, "buyer_matching");
      if (!reference) continue;
      try {
        const artifact = await readPipelineArtifact(job, "buyer_matching");
        for (const buyer of artifact.buyers || []) {
          if (!buyer.qualification) continue;
          totals.totalCompanies += 1;
          totals[buyer.qualification.passed ? "passed" : "rejected"] += 1;
          for (const reason of buyer.qualification.reasons || []) totals.reasons[reason] = Number(totals.reasons[reason] || 0) + 1;
          if (totals.companies.length < 50) totals.companies.push({ company: buyer.company, country: buyer.country, score: buyer.qualification.score, passed: buyer.qualification.passed, reasons: buyer.qualification.reasons || [] });
        }
      } catch {}
    }
    return json(res, 200, { ...runtimeStateStore.companyQualification, statistics: totals });
  }
  if (req.method === "PUT" && pathname === "/api/company-qualification") {
    const input = await parseBody(req);
    const cleanList = (value) => [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || "").trim().slice(0, 120)).filter(Boolean))].slice(0, 100);
    const cleanHsCodes = (value) => [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || "").trim()).filter((item) => /^\d{4,10}$/.test(item)))].slice(0, 100);
    const score = Number(input.minimumScore);
    runtimeStateStore.companyQualification = { enabled: Boolean(input.enabled), targetCountries: cleanList(input.targetCountries), businessKeywords: cleanList(input.businessKeywords), excludeKeywords: cleanList(input.excludeKeywords), targetHsCodes: cleanHsCodes(input.targetHsCodes), allowedCompanyTypes: cleanList(input.allowedCompanyTypes), minimumScore: Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0, updatedAt: new Date().toISOString() };
    await writeJsonStore(runtimeStatePath, runtimeStateStore);
    return json(res, 200, runtimeStateStore.companyQualification);
  }
  if (req.method === "GET" && pathname === "/api/health") {
    await maybeRecoverDeliveryCircuit();
    return json(res, 200, {
      ok: true,
      sourceLoaded: true,
      ai: { ...runtimeStateStore.ai, configured: Boolean(process.env.OPENAI_API_KEY), model: OPENAI_MODEL },
      feedback: {
        webhookConfigured: Boolean(FEEDBACK_WEBHOOK_SECRET),
        eventCount: runtimeStateStore.feedback.events.length,
        lastEventAt: runtimeStateStore.feedback.lastEventAt,
      },
      mailbox: {
        configuredAccounts: (mailboxAccountsStore.accounts || []).filter((item) => mailboxAccountConfig(item.address || item.user)).length,
        replyEnabled: MAILBOX_REPLY_ENABLED,
        replyUsage: mailboxReplyUsage(),
      },
      delivery: {
        enabled: deliveryConfig.enabled,
        automationMode: runtimeStateStore.deliveryAutomation.mode,
        smtpConfigured: isSmtpConfigured(),
        allowUnverified: deliveryConfig.allowUnverified,
        batchLimit: deliveryConfig.batchLimit,
        capacity: calculateDeliveryCapacity(),
        daily: dailyDeliveryUsage(),
        senderFleet: (() => {
          const fleet = senderFleetUsage();
          return { businessDate: fleet.businessDate, accountLimit: fleet.limitPerAccount, configured: fleet.accounts.length, used: fleet.accounts.reduce((sum, item) => sum + item.used, 0), remaining: fleet.accounts.reduce((sum, item) => sum + item.remaining, 0), accounts: fleet.accounts.map((item) => ({ senderFingerprint: publicFingerprint(item.senderHash), used: item.used, remaining: item.remaining })) };
        })(),
        delayMs: deliveryConfig.delayMs,
        circuit: runtimeStateStore.deliveryCircuit,
        interventionAlert: { configured: validEmail(OPS_ALERT_EMAIL) },
        senderProfile: senderProfileReadiness(),
      },
      managedCycle: managedDailyCycleState(),
      localControls: {
        validationRecords: (validationStore.records || []).length,
        suppressions: (suppressionStore.records || []).length,
        operationTasks: (operationsStore.tasks || []).length,
        contactQueues: (contactCollectionStore.queues || []).length,
        pipelineJobs: (pipelineStore.jobs || []).length,
        outboxEntries: (outboxStore.entries || []).length,
      },
      sendingEnabled: sendingEnabled(),
      timestamp: new Date().toISOString(),
    });
  }
  if (req.method === "GET" && pathname === "/api/summary") return json(res, 200, model.summary);
  if (req.method === "GET" && pathname === "/api/quality") return json(res, 200, buildQualityReport(model));
  if (req.method === "GET" && pathname === "/api/workflow") {
    const overallProgress = Math.round(workflow.reduce((sum, item) => sum + item.progress, 0) / workflow.length);
    return json(res, 200, {
      items: workflow,
      overallProgress,
      acquisitionProgress: 100,
      sendingReadiness: 98,
      sendingEnabled: sendingEnabled(),
      measuredAt: new Date().toISOString().slice(0, 10),
    });
  }
  if (req.method === "GET" && pathname === "/api/buyers") return json(res, 200, filterBuyers(model, url.searchParams));
  if (req.method === "GET" && pathname === "/api/contacts") return json(res, 200, filterContacts(model, url.searchParams));
  if (req.method === "GET" && pathname === "/api/local-backup") {
    return json(res, 200, await createLocalBackup());
  }
  if (req.method === "POST" && pathname === "/api/local-backup/validate") {
    const result = validateLocalBackup(await parseBody(req));
    return json(res, result.valid ? 200 : 422, result);
  }
  if (req.method === "POST" && pathname === "/api/local-backup/preview") {
    const backup = await parseBody(req);
    const result = buildBackupMergePlan(backup, await readCampaigns());
    const { stores, ...publicResult } = result;
    return json(res, result.valid ? 200 : 422, publicResult);
  }
  if (req.method === "POST" && pathname === "/api/local-backup/merge") {
    const input = await parseBody(req);
    const backup = input.backup;
    const plan = buildBackupMergePlan(backup, await readCampaigns());
    if (!plan.valid) {
      const { stores, ...publicResult } = plan;
      return json(res, 422, publicResult);
    }
    if (input.confirm !== plan.confirmation) {
      return json(res, 409, { error: "安全合并确认短语不匹配", expected: plan.confirmation });
    }
    const rollbackBackup = await createLocalBackup();
    const rollbackFile = await commitMergedStores(plan.stores, rollbackBackup);
    applyLocalContactState(model);
    return json(res, 200, {
      merged: true,
      mode: "current_wins_add_only",
      added: plan.added,
      conflicts: plan.conflicts,
      counts: plan.effective,
      rollbackFile,
      safety: "现有记录优先；抑制、任务计数、熔断状态和发送历史不会被备份回滚",
    });
  }
  if (req.method === "GET" && pathname === "/api/contact-quality") {
    return json(res, 200, publicValidationSummary(model));
  }
  if (req.method === "POST" && pathname === "/api/contact-quality/validate") {
    const input = await parseBody(req);
    const requestedEmails = Array.isArray(input.emails) ? input.emails : (input.email ? [input.email] : []);
    const contactIds = new Set(Array.isArray(input.contactIds) ? input.contactIds.map(String) : []);
    const contactEmails = model.contacts.filter((item) => contactIds.has(item.id)).map((item) => item.email);
    const emails = [...new Set([...requestedEmails, ...contactEmails].map(normalize).filter(Boolean))].slice(0, 25);
    if (!emails.length) return json(res, 422, { error: "至少提供一个邮箱或联系人ID" });
    const mode = input.mode === "syntax" ? "syntax" : "domain";
    const results = [];
    const domainCache = new Map();
    for (const email of emails) {
      const domain = email.split("@")[1] || "";
      let result;
      if (mode === "domain" && validEmail(email) && domainCache.has(domain)) {
        const cached = domainCache.get(domain);
        result = {
          ...cached,
          emailHash: emailFingerprint(email),
          checkedAt: new Date().toISOString(),
        };
      } else {
        result = await validateEmailDomain(email, mode);
        if (mode === "domain" && validEmail(email)) {
          domainCache.set(domain, {
            domain: result.domain,
            status: result.status,
            evidence: result.evidence,
            mxHosts: result.mxHosts,
          });
        }
      }
      upsertValidation(result);
      results.push({ ...result, fingerprint: publicFingerprint(result.emailHash), emailHash: undefined });
    }
    await writeJsonStore(validationPath, validationStore);
    applyLocalContactState(model);
    return json(res, 200, {
      mode,
      processed: results.length,
      uniqueDomains: new Set(emails.filter(validEmail).map((email) => email.split("@")[1])).size,
      results,
      summary: publicValidationSummary(model),
    });
  }
  if (req.method === "POST" && pathname === "/api/contact-quality/status") {
    const input = await parseBody(req);
    const email = normalize(input.email);
    const status = String(input.status || "");
    const evidence = String(input.evidence || "").trim().slice(0, 500);
    if (!validEmail(email)) return json(res, 422, { error: "邮箱格式无效" });
    if (!VALIDATION_STATUSES.has(status) || ["unverified", "opted_out"].includes(status)) {
      return json(res, 422, { error: "不支持的人工验证状态" });
    }
    if (!evidence) return json(res, 422, { error: "人工状态必须提供可追溯证据" });
    if (status === "deliverable" && !/^https?:\/\//i.test(evidence)) {
      return json(res, 422, { error: "人工可投递状态必须提供完整http/https证据URL" });
    }
    const record = {
      emailHash: emailFingerprint(email),
      domain: email.split("@")[1],
      status,
      checkedAt: new Date().toISOString(),
      evidence: `manual:${evidence}`,
      mxHosts: [],
    };
    upsertValidation(record);
    await writeJsonStore(validationPath, validationStore);
    applyLocalContactState(model);
    return json(res, 200, { ...record, fingerprint: publicFingerprint(record.emailHash), emailHash: undefined });
  }
  if (req.method === "GET" && pathname === "/api/suppressions") {
    return json(res, 200, {
      count: (suppressionStore.records || []).length,
      items: (suppressionStore.records || []).slice().reverse().map((item) => ({
        fingerprint: publicFingerprint(item.emailHash),
        domain: item.domain,
        reason: item.reason,
        source: item.source,
        createdAt: item.createdAt,
      })),
    });
  }
  if (req.method === "POST" && pathname === "/api/suppressions") {
    const input = await parseBody(req);
    const email = normalize(input.email);
    const reason = String(input.reason || "manual");
    const source = String(input.source || "local-admin").trim().slice(0, 200) || "local-admin";
    if (!validEmail(email)) return json(res, 422, { error: "邮箱格式无效" });
    if (!SUPPRESSION_REASONS.has(reason)) return json(res, 422, { error: "不支持的抑制原因" });
    const emailHash = emailFingerprint(email);
    const { record, existing } = upsertSuppression({
      emailHash,
      domain: email.split("@")[1],
      reason,
      source,
      createdAt: new Date().toISOString(),
    });
    upsertValidation({
      emailHash,
      domain: record.domain,
      status: "opted_out",
      checkedAt: new Date().toISOString(),
      evidence: `suppression:${reason}`,
      mxHosts: [],
    });
    await Promise.all([
      writeJsonStore(suppressionPath, suppressionStore),
      writeJsonStore(validationPath, validationStore),
    ]);
    applyLocalContactState(model);
    return json(res, existing ? 200 : 201, {
      fingerprint: publicFingerprint(record.emailHash),
      domain: record.domain,
      reason: record.reason,
      source: record.source,
      createdAt: record.createdAt,
      existing: Boolean(existing),
    });
  }
  if (req.method === "POST" && pathname === "/api/feedback/events") {
    if (!FEEDBACK_WEBHOOK_SECRET) return json(res, 503, { error: "反馈回调尚未配置" });
    const suppliedSecret = req.headers["x-feedback-secret"];
    if (!secretMatches(suppliedSecret, FEEDBACK_WEBHOOK_SECRET)) return json(res, 401, { error: "反馈回调认证失败" });
    const source = String(req.headers["x-feedback-source"] || "provider").trim().slice(0, 80) || "provider";
    const result = await recordFeedbackEvent(await parseBody(req), source);
    return json(res, result.duplicate ? 200 : 202, {
      accepted: true,
      duplicate: result.duplicate,
      eventId: result.event.eventId,
      type: result.event.type,
      recipientFingerprint: publicFingerprint(result.event.recipientHash),
      suppressed: result.suppressed,
      outboxMatched: result.outboxMatched,
    });
  }
  if (req.method === "GET" && pathname === "/api/feedback") {
    return json(res, 200, {
      configured: Boolean(FEEDBACK_WEBHOOK_SECRET) || MAILBOX_REPLY_ENABLED,
      count: runtimeStateStore.feedback.events.length,
      lastEventAt: runtimeStateStore.feedback.lastEventAt,
      events: runtimeStateStore.feedback.events.slice(-200).reverse(),
    });
  }
  if (req.method === "GET" && pathname === "/api/delivery-circuit") {
    await maybeRecoverDeliveryCircuit();
    return json(res, 200, {
      ...runtimeStateStore.deliveryCircuit,
      recovery: deliveryCircuitRecoveryAssessment(),
      recentRecoveries: runtimeStateStore.deliveryCircuitHistory.slice(-10).reverse(),
    });
  }
  if (req.method === "GET" && pathname === "/api/delivery-capacity") {
    const capacity = calculateDeliveryCapacity();
    return json(res, 200, {
      ...capacity,
    });
  }
  if (req.method === "POST" && pathname === "/api/ops/intervention-alert") {
    try {
      return json(res, 200, await sendInterventionAlert(await parseBody(req)));
    } catch (error) {
      return json(res, error.status || 503, { error: clipText(error.message, 500) });
    }
  }
  if (req.method === "GET" && pathname === "/api/delivery-mode") {
    return json(res, 200, {
      mode: runtimeStateStore.deliveryAutomation.mode,
      updatedAt: runtimeStateStore.deliveryAutomation.updatedAt,
      updatedBy: runtimeStateStore.deliveryAutomation.updatedBy,
      automaticApprovalStillRequiresAllGates: true,
    });
  }
  if (req.method === "PUT" && pathname === "/api/delivery-mode") {
    const input = await parseBody(req);
    const mode = String(input.mode || "").trim();
    if (!["manual", "auto"].includes(mode)) return json(res, 422, { error: "发送模式必须是 manual 或 auto" });
    runtimeStateStore.deliveryAutomation = {
      mode,
      updatedAt: new Date().toISOString(),
      updatedBy: String(input.updatedBy || "web-operator").trim().slice(0, 120) || "web-operator",
    };
    await writeJsonStore(runtimeStatePath, runtimeStateStore);
    return json(res, 200, {
      mode: runtimeStateStore.deliveryAutomation.mode,
      updatedAt: runtimeStateStore.deliveryAutomation.updatedAt,
      updatedBy: runtimeStateStore.deliveryAutomation.updatedBy,
      automaticApprovalStillRequiresAllGates: true,
    });
  }
  if (req.method === "POST" && pathname === "/api/delivery-circuit/recover") {
    const input = await parseBody(req);
    if (input.confirm !== "RECOVER DELIVERY") {
      return json(res, 428, { error: "需要输入确认短语：RECOVER DELIVERY" });
    }
    if (!runtimeStateStore.deliveryCircuit.open) return json(res, 200, runtimeStateStore.deliveryCircuit);
    const assessment = deliveryCircuitRecoveryAssessment({ manual: true });
    if (!assessment.eligible) return json(res, 423, { error: "发送熔断尚未通过恢复核查", details: assessment.blockers });
    await recoverDeliveryCircuit("manual_confirmed_safe_check", assessment);
    return json(res, 200, runtimeStateStore.deliveryCircuit);
  }
  if (req.method === "GET" && pathname === "/api/contact-queues") {
    const expired = (contactCollectionStore.queues || []).some((queue) => releaseExpiredLease(queue));
    if (expired) await writeJsonStore(contactCollectionPath, contactCollectionStore);
    return json(res, 200, {
      version: contactCollectionStore.version,
      items: (contactCollectionStore.queues || []).map((queue) => collectionQueueView(queue)),
    });
  }
  if (req.method === "POST" && pathname === "/api/contact-queues/initialize") {
    const input = await parseBody(req);
    const sourceSpecs = Array.isArray(input.sources) && input.sources.length ? input.sources : DEFAULT_COLLECTION_SOURCES;
    const resultPaths = Array.isArray(input.processedResultPaths)
      ? input.processedResultPaths
      : DEFAULT_COLLECTION_RESULTS;
    const [sources, importedNames] = await Promise.all([
      Promise.all(sourceSpecs.slice(0, 20).map(readCollectionSource)),
      readProcessedCompanyNames(resultPaths.slice(0, 100)),
    ]);
    const key = String(input.key || "hung_hing_amity_20260811").trim().slice(0, 120);
    const existing = (contactCollectionStore.queues || []).find((queue) => queue.key === key);
    const queue = createOrSyncQueue(existing, {
      id: existing?.id || `collection_${crypto.randomUUID()}`,
      key,
      label: input.label || "Hung Hing + Amity 全部买家公司联系人采集",
      sources,
      processedNames: [
        ...(Array.isArray(input.processedNames) ? input.processedNames : []),
        ...importedNames,
        ...(!input.sources ? DEFAULT_IMPORTED_COMPLETIONS : []),
      ],
      config: input.config,
    });
    if (!existing) contactCollectionStore.queues.unshift(queue);
    await writeJsonStore(contactCollectionPath, contactCollectionStore);
    return json(res, existing ? 200 : 201, collectionQueueView(queue));
  }
  const collectionMatch = pathname.match(/^\/api\/contact-queues\/([^/]+)(?:\/(claim|pause|resume|retry-failed|boundary-report|batches\/([^/]+)\/complete))?$/);
  if (collectionMatch) {
    const [, id, action, batchId] = collectionMatch;
    const queue = (contactCollectionStore.queues || []).find((item) => item.id === id);
    if (!queue) return json(res, 404, { error: "联系人采集队列不存在" });
    if (req.method === "GET" && !action) {
      const changed = releaseExpiredLease(queue);
      if (changed) await writeJsonStore(contactCollectionPath, contactCollectionStore);
      const includeItems = url.searchParams.get("items") === "1";
      return json(res, 200, collectionQueueView(queue, { includeItems }));
    }
    if (req.method === "GET" && action === "boundary-report") {
      return json(res, 200, collectionBoundaryReport(queue));
    }
    if (req.method === "POST" && action === "claim") {
      const input = await parseBody(req);
      const batch = claimBatch(queue, {
        ...input,
        batchId: `batch_${crypto.randomUUID()}`,
      });
      await writeJsonStore(contactCollectionPath, contactCollectionStore);
      return json(res, 200, { batch, queue: collectionQueueView(queue) });
    }
    if (req.method === "POST" && action?.startsWith("batches/") && batchId) {
      const input = await parseBody(req);
      const batch = queue.batches.find((item) => item.id === batchId);
      if (!batch) return json(res, 404, { error: "采集批次不存在" });
      const rawResults = Array.isArray(input.rawResults) ? input.rawResults.slice(0, 50) : [];
      const artifactReference = String(input.artifactReference || "").trim()
        || await writeCollectionArtifact(queue, batch, rawResults);
      const results = rawResults.length
        ? summarizeCollectionResults(queue, batch, rawResults)
        : (Array.isArray(input.results) ? input.results.slice(0, 50) : []);
      const view = completeBatch(queue, batchId, {
        owner: input.owner,
        results,
        artifactReference,
      });
      await writeJsonStore(contactCollectionPath, contactCollectionStore);
      return json(res, 200, { queue: view, artifactReference });
    }
    if (req.method === "POST" && ["pause", "resume"].includes(action)) {
      const input = await parseBody(req);
      const view = setQueueState(queue, action, input);
      await writeJsonStore(contactCollectionPath, contactCollectionStore);
      return json(res, 200, view);
    }
    if (req.method === "POST" && action === "retry-failed") {
      const input = await parseBody(req);
      const view = requeueFailedItems(queue, input);
      await writeJsonStore(contactCollectionPath, contactCollectionStore);
      return json(res, 200, view);
    }
  }
  if (req.method === "GET" && pathname === "/api/pipeline") {
    return json(res, 200, pipelineSummary());
  }
  if (req.method === "GET" && pathname === "/api/country-business-collection/status") {
    return json(res, 200, await countryBusinessCollectionStatus());
  }
  if (req.method === "GET" && pathname === "/api/pipeline/drafts") {
    const limit = boundedInteger(url.searchParams.get("limit"), 500, 1, 1000);
    return json(res, 200, await pipelineDraftInbox(limit));
  }
  if (req.method === "GET" && pathname === "/api/pipeline/daily-batch") {
    const requested = boundedInteger(url.searchParams.get("limit"), deliveryConfig.dailyLimit, 1, deliveryConfig.dailyLimit);
    const reserveMode = ["1", "true"].includes(String(url.searchParams.get("reserve") || "").toLowerCase());
    const centralOnly = ["1", "true"].includes(String(url.searchParams.get("central") || url.searchParams.get("centralOnly") || "").toLowerCase());
    return json(res, 200, await dailyPipelineBatch(requested, reserveMode, centralOnly));
  }
  if (req.method === "GET" && pathname === "/api/pipeline/inventory") {
    const requested = boundedInteger(url.searchParams.get("limit"), deliveryConfig.dailyLimit, 1, deliveryConfig.dailyLimit);
    return json(res, 200, await pipelineInventory(requested));
  }
  if (req.method === "GET" && pathname === "/api/managed-cycle") {
    return json(res, 200, managedDailyCycleState());
  }
  if (req.method === "POST" && pathname === "/api/managed-cycle/lock") {
    const input = await parseBody(req);
    if (input.confirm !== "LOCK MANAGED COLLECTION") return json(res, 428, { error: "需要输入确认短语：LOCK MANAGED COLLECTION" });
    const inventory = await pipelineInventory(deliveryConfig.dailyLimit);
    if (!inventory.inventory?.ready && managedProductionSendCount() < 1) {
      return json(res, 409, { error: "发件公司库存尚未达到当日目标，不能提前锁定采集", inventory: inventory.inventory });
    }
    return json(res, 200, await lockManagedDailyCollection("inventory_target_reached", inventory.inventory?.totalCompanies));
  }
  if (req.method === "POST" && pathname === "/api/pipeline/central-batch/send") {
    const input = await parseBody(req);
    if (input.confirm !== "SEND DAILY BATCH") return json(res, 428, { error: "需要输入确认短语：SEND DAILY BATCH" });
    if (centralBatchSendInFlight) return json(res, 409, { error: "今日集中批次已有发送请求执行中" });
    centralBatchSendInFlight = true;
    try {
      await maybeRecoverDeliveryCircuit();
      const batch = await dailyPipelineBatch(deliveryConfig.batchLimit, false, true);
      if (!batch.selected.length) return json(res, 423, { error: "当前没有通过简单核验的集中审核草稿", batch });
      await lockManagedDailyCollection("production_sending_started", batch.inventory?.totalCompanies);
      const groups = new Map();
      for (const item of batch.selected) {
        const group = groups.get(item.jobId) || { jobId: item.jobId, indexes: [] };
        group.indexes.push(item.draftIndex);
        groups.set(item.jobId, group);
      }
      const prepared = [];
      for (const group of groups.values()) {
        const job = (pipelineStore.jobs || []).find((item) => item.id === group.jobId);
        if (!job) return json(res, 409, { error: `集中批次任务已消失：${group.jobId}` });
        const artifact = await readPipelineArtifact(job, "drafting");
        const drafts = group.indexes.map((index) => artifact.drafts?.[index]).filter(Boolean);
        if (drafts.length !== group.indexes.length) return json(res, 409, { error: `集中批次草稿产物不完整：${group.jobId}` });
        const blockers = pipelineSendBlockers(job, drafts, { centralReview: true });
        if (blockers.length) return json(res, 423, { error: "集中批次简单核验未通过", details: blockers, jobId: group.jobId });
        prepared.push({ job, indexes: group.indexes, drafts });
      }
      const deliveries = [];
      for (const group of prepared) {
        const results = await sendPipelineDraftBatch(group.job, group.drafts, group.indexes);
        const finishedAt = new Date().toISOString();
        const accepted = results.filter((item) => item.status === "accepted").length;
        const failed = results.filter((item) => item.status !== "accepted").length;
        const priorDelivery = group.job.delivery || {};
        group.job.delivery = {
          attempted: Number(priorDelivery.attempted || 0) + results.length,
          accepted: Number(priorDelivery.accepted || 0) + accepted,
          failed: Number(priorDelivery.failed || 0) + failed,
          results: [...(priorDelivery.results || []), ...results],
          completedAt: finishedAt,
        };
        group.job.stages.approval = { ...(group.job.stages.approval || {}), status: "completed", updatedAt: finishedAt };
        group.job.stages.sending = { ...(group.job.stages.sending || {}), status: failed ? "paused" : "completed", updatedAt: finishedAt };
        group.job.currentStage = failed ? "sending" : "feedback";
        group.job.status = failed ? "paused" : "waiting_input";
        group.job.requiredInput = failed ? "集中批次发送失败，需查明后人工恢复" : "等待退信、投诉或收件箱回复事件";
        group.job.stages.feedback = { ...(group.job.stages.feedback || {}), status: failed ? "pending" : "waiting_input", updatedAt: finishedAt };
        group.job.batchReview = { ...(group.job.batchReview || {}), status: failed ? "paused" : "sent", reviewedAt: finishedAt, reviewedBy: String(input.reviewer || "central-batch").slice(0, 120) };
        group.job.audit = [...(group.job.audit || []), { at: finishedAt, type: "central_batch_send_completed", accepted, failed, draftIndexes: group.indexes }].slice(-1000);
        deliveries.push({ jobId: group.job.id, accepted, failed, results });
      }
      await writeJsonStore(pipelinePath, pipelineStore);
      return json(res, 200, { ok: true, mode: "central_batch", batch: { selected: batch.selected.length, accepted: deliveries.reduce((sum, item) => sum + item.accepted, 0), failed: deliveries.reduce((sum, item) => sum + item.failed, 0), deliveries }, daily: dailyDeliveryUsage() });
    } finally {
      centralBatchSendInFlight = false;
    }
  }
  if (req.method === "POST" && pathname === "/api/pipeline/jobs") {
    const rawInput = await parseBody(req);
    const operationTaskId = String(rawInput.operationTaskId || "").trim();
    const task = operationTaskId
      ? (operationsStore.tasks || []).find((item) => item.id === operationTaskId)
      : null;
    if (operationTaskId && !task) return json(res, 404, { error: "采集任务不存在" });
    const input = task ? {} : cleanTaskInput(rawInput);
    const job = createPipelineJob(task, { ...input, inputReference: "" });
    pipelineStore.jobs.unshift(job);
    await writeJsonStore(pipelinePath, pipelineStore);
    return json(res, 201, pipelineJobPublicView(job));
  }
  if (req.method === "POST" && pathname === "/api/pipeline/claim-next") {
    const input = await parseBody(req);
    const owner = String(input.owner || "").trim().slice(0, 120);
    if (!owner) return json(res, 422, { error: "执行器owner不能为空" });
    const job = claimNextPipelineJob(owner, boundedInteger(input.leaseSeconds, 300, 30, 3600));
    await writeJsonStore(pipelinePath, pipelineStore);
    return json(res, 200, { job: job ? pipelineJobPublicView(job) : null });
  }
  const pipelineMatch = pathname.match(/^\/api\/pipeline\/jobs\/([^/]+)\/(resume|stage|pause|circuit|recover|approve|simulate-send|send)$/);
  if (pipelineMatch && req.method === "POST") {
    const [, id, action] = pipelineMatch;
    const job = (pipelineStore.jobs || []).find((item) => item.id === id);
    if (!job) return json(res, 404, { error: "流水线任务不存在" });
    const input = await parseBody(req);
    const now = new Date().toISOString();
    if (action === "approve") {
      if (input.confirm !== `APPROVE PIPELINE ${id}`) return json(res, 428, { error: `需要输入确认短语：APPROVE PIPELINE ${id}` });
      if (job.currentStage !== "approval" || job.status !== "waiting_input") return json(res, 409, { error: "流水线尚未停在审批门" });
      const artifact = await readPipelineArtifact(job, "drafting");
      const indexes = [...new Set((Array.isArray(input.draftIndexes) ? input.draftIndexes : []).map(Number))];
      const drafts = indexes.map((index) => artifact.drafts?.[index]).filter(Boolean);
      if (!drafts.length || drafts.length !== indexes.length) return json(res, 422, { error: "审批的草稿序号无效" });
      const companyCounts = drafts.reduce((counts, draft) => counts.set(normalizeCompanyName(draft.company), Number(counts.get(normalizeCompanyName(draft.company)) || 0) + 1), new Map());
      if ([...companyCounts.values()].some((count) => count > MAX_PIPELINE_CONTACTS_PER_COMPANY_DAILY)) {
        return json(res, 422, { error: `同一公司每天最多批准${MAX_PIPELINE_CONTACTS_PER_COMPANY_DAILY}封首次触达` });
      }
      const draftErrors = drafts.flatMap(pipelineDraftErrors);
      if (draftErrors.length) return json(res, 422, { error: "草稿未达到批准门槛", details: [...new Set(draftErrors)] });
      const recipientEvidence = Array.isArray(input.recipientEvidence) ? input.recipientEvidence : [];
      const evidenceValid = recipientEvidence.length === drafts.length && recipientEvidence.every((item) => {
        const sources = [...new Set((Array.isArray(item?.sources) ? item.sources : [])
          .map((source) => String(source || "").trim())
          .filter((source) => /^https?:\/\/[^\s]+$/i.test(source)))];
        return item?.deliverableConfirmed === true
          && item?.currentEmploymentConfirmed === true
          && sources.length >= 2;
      });
      if (!evidenceValid) {
        return json(res, 422, { error: "每个收件人必须有可投递、当前在职和至少两条来源证据" });
      }
      job.approval = {
        approvedAt: now,
        approvedBy: String(input.reviewer || "project-owner").trim().slice(0, 120) || "project-owner",
        draftIndexes: indexes,
        providerAuthorization: String(input.providerAuthorization || "company_reported_alimail_small_batch_business_exchange_approval").slice(0, 300),
        recipientEvidence: recipientEvidence.map((item, index) => ({
          draftIndex: indexes[index],
          deliverableConfirmed: true,
          currentEmploymentConfirmed: true,
          checkedAt: String(item.checkedAt || now).slice(0, 40),
          sources: item.sources.map((source) => String(source).slice(0, 500)).slice(0, 5),
        })),
      };
      job.stages.approval = { ...(job.stages.approval || {}), status: "completed", updatedAt: now };
      job.currentStage = "sending";
      job.status = "waiting_input";
      job.requiredInput = "已批准收件人快照；等待精确发送确认";
      job.stages.sending = { ...(job.stages.sending || {}), status: "waiting_input", updatedAt: now };
      job.updatedAt = now;
      job.audit = [...(job.audit || []), { at: now, type: "pipeline_approved", reviewer: job.approval.approvedBy, draftIndexes: indexes }].slice(-1000);
    } else if (action === "simulate-send") {
      if (input.confirm !== `SIMULATE SEND PIPELINE ${id}`) return json(res, 428, { error: `需要输入确认短语：SIMULATE SEND PIPELINE ${id}` });
      if (input.simulation !== true) return json(res, 422, { error: "发送预演必须显式声明 simulation=true" });
      if (job.currentStage !== "approval" || job.status !== "waiting_input") return json(res, 409, { error: "流水线尚未停在审批门" });
      const artifact = await readPipelineArtifact(job, "drafting");
      const drafts = Array.isArray(artifact.drafts) ? artifact.drafts : [];
      const now = new Date().toISOString();
      const wouldSend = drafts.slice(0, deliveryConfig.batchLimit).map((draft, index) => ({
        draftIndex: index,
        company: normalizeCompanyName(draft.company),
        recipientPresent: Boolean(String(draft.email || "").trim()),
      }));
      job.simulation = { at: now, mode: "no_smtp", wouldSend: wouldSend.length, eligibleDrafts: drafts.length, results: wouldSend };
      job.audit = [...(job.audit || []), { at: now, type: "pipeline_send_simulated", wouldSend: wouldSend.length, smtp: false }].slice(-1000);
      job.updatedAt = now;
      await writeJsonStore(pipelinePath, pipelineStore);
      return json(res, 200, { ok: true, simulation: true, jobId: id, stage: job.currentStage, status: job.status, wouldSend: wouldSend.length, eligibleDrafts: drafts.length, smtp: false, outboxCreated: 0 });
    } else if (action === "send") {
      if (input.confirm !== `SEND PIPELINE ${id}`) return json(res, 428, { error: `需要输入确认短语：SEND PIPELINE ${id}` });
      if (pipelineSendsInFlight.has(id)) return json(res, 409, { error: "该流水线已有发送请求执行中" });
      if (job.currentStage !== "sending" || job.status !== "waiting_input") return json(res, 409, { error: "流水线尚未进入已批准发送门" });
      pipelineSendsInFlight.add(id);
      try {
        await maybeRecoverDeliveryCircuit();
        const artifact = await readPipelineArtifact(job, "drafting");
        const drafts = (job.approval?.draftIndexes || []).map((index) => artifact.drafts?.[index]).filter(Boolean);
        const blockers = pipelineSendBlockers(job, drafts);
        if (blockers.length) return json(res, 423, { error: "流水线发送条件未满足", details: blockers });
        const results = await sendPipelineDraftBatch(job, drafts, job.approval.draftIndexes);
        const finishedAt = new Date().toISOString();
        const accepted = results.filter((item) => item.status === "accepted").length;
        const failed = results.filter((item) => item.status !== "accepted").length;
        job.delivery = { attempted: results.length, accepted, failed, results, completedAt: finishedAt };
        job.stages.sending = { ...(job.stages.sending || {}), status: failed ? "paused" : "completed", updatedAt: finishedAt };
        job.currentStage = failed ? "sending" : "feedback";
        job.status = failed ? "paused" : "waiting_input";
        job.requiredInput = failed ? "发送失败，需查明后人工恢复" : "等待退信、投诉或收件箱回复事件";
        job.stages.feedback = { ...(job.stages.feedback || {}), status: failed ? "pending" : "waiting_input", updatedAt: finishedAt };
        job.updatedAt = finishedAt;
        job.audit = [...(job.audit || []), { at: finishedAt, type: "pipeline_send_completed", accepted, failed }].slice(-1000);
      } finally {
        pipelineSendsInFlight.delete(id);
      }
    } else if (action === "resume") {
      const reference = String(input.inputReference || "").trim().slice(0, 500);
      if (!reference) return json(res, 422, { error: "恢复任务必须提供可追溯输入引用" });
      if (!['waiting_input', 'paused'].includes(job.status)) return json(res, 409, { error: "当前状态不允许恢复排队" });
      job.inputReference = reference;
      job.requiredInput = "";
      job.status = "queued";
      job.stages[job.currentStage] = { ...(job.stages[job.currentStage] || {}), status: "queued", updatedAt: now };
      job.updatedAt = now;
      job.audit = [...(job.audit || []), { at: now, type: "input_supplied", stage: job.currentStage }].slice(-1000);
    } else if (action === "stage") {
      updatePipelineStage(job, input);
    } else if (action === "pause") {
      job.status = "paused";
      job.leaseOwner = "";
      job.leaseExpiresAt = null;
      job.updatedAt = now;
      job.audit = [...(job.audit || []), { at: now, type: "pipeline_paused", reason: String(input.reason || "manual").slice(0, 300) }].slice(-1000);
    } else if (action === "circuit") {
      job.status = "circuit_open";
      job.leaseOwner = "";
      job.leaseExpiresAt = null;
      job.stages[job.currentStage] = { ...(job.stages[job.currentStage] || {}), status: "circuit_open", updatedAt: now };
      job.updatedAt = now;
      job.audit = [...(job.audit || []), { at: now, type: "pipeline_circuit_opened", signal: String(input.signal || "manual").slice(0, 120) }].slice(-1000);
    } else if (action === "recover") {
      if (input.confirm !== `RECOVER PIPELINE ${id}`) return json(res, 428, { error: `需要输入确认短语：RECOVER PIPELINE ${id}` });
      if (job.status !== "circuit_open") return json(res, 409, { error: "只有熔断任务可以人工恢复" });
      job.status = "paused";
      job.requiredInput = "恢复后需人工确认输入引用，再进入小批量金丝雀运行";
      job.updatedAt = now;
      job.audit = [...(job.audit || []), { at: now, type: "pipeline_human_recovery_confirmed" }].slice(-1000);
    }
    await writeJsonStore(pipelinePath, pipelineStore);
    return json(res, 200, pipelineJobPublicView(job));
  }
  if (req.method === "GET" && pathname === "/api/ops/tasks") {
    return json(res, 200, { items: (operationsStore.tasks || []).map(taskPublicView) });
  }
  if (req.method === "GET" && pathname === "/api/managed-plan") {
    try {
      const plan = JSON.parse(await fs.readFile(managedPlanPath, "utf8"));
      const activeTask = (operationsStore.tasks || []).find((task) => task.automation?.mode === "managed" && !["completed", "cancelled"].includes(task.status));
      if (activeTask) {
        return json(res, 200, {
          schemaVersion: 1,
          planId: activeTask.automation.planId,
          mode: "managed",
          authorizedBy: activeTask.automation.authorizedBy,
          hsCodes: activeTask.collectionMode === "keyword" ? [] : [{ hsCode: activeTask.hsCode, direction: activeTask.direction, countries: activeTask.countries, startPage: Math.max(1, Number(activeTask.checkpoint?.page || 0) + 1) }],
          keywords: activeTask.collectionMode === "keyword" ? [{ keyword: activeTask.keyword, direction: activeTask.direction, startPage: Math.max(1, Number(activeTask.checkpoint?.page || 0) + 1) }] : [],
          dailyBudgets: {
            buyerEntries: activeTask.budgets.buyerEntriesDaily,
            companyDetails: activeTask.budgets.companyDetailsDaily,
            validEmailCompanies: activeTask.budgets.validEmailCompaniesDaily,
            contactPages: activeTask.budgets.contactPagesDaily,
            emailSends: activeTask.budgets.emailSendsDaily,
            globalEmailHardCap: 500,
          },
          selection: plan.selection || {},
          delivery: plan.delivery || {},
          compliance: plan.compliance || {},
          mandatoryHumanGates: ["captcha", "credential_error", "permission", "mfa"],
          companyProcessingStrategy: resolveCompanyProcessingStrategy(
            { legacyTarget: activeTask.budgets.validEmailCompaniesDaily },
            { enabled: process.env.COMPANY_PROCESSING_STRATEGY_ENABLED, target: process.env.COMPANY_PROCESSING_FIXED_TARGET },
          ),
          sourceTaskId: activeTask.id,
        });
      }
      return json(res, 200, {
        schemaVersion: 1,
        planId: plan.planId,
        mode: plan.mode,
        hsCodes: plan.hsCodes || [],
        dailyBudgets: plan.dailyBudgets || {},
        selection: plan.selection || {},
        compliance: plan.compliance || {},
        mandatoryHumanGates: plan.mandatoryHumanGates || [],
        companyProcessingStrategy: resolveCompanyProcessingStrategy(
          { legacyTarget: plan.dailyBudgets?.validEmailCompanies || 100 },
          { enabled: process.env.COMPANY_PROCESSING_STRATEGY_ENABLED, target: process.env.COMPANY_PROCESSING_FIXED_TARGET },
        ),
      });
    } catch {
      return json(res, 503, { error: "托管HSCode计划暂不可用" });
    }
  }
  if (req.method === "POST" && pathname === "/api/ops/tasks") {
    const input = cleanTaskInput(await parseBody(req));
    const now = new Date().toISOString();
    if (input.automation.mode === "managed") {
      const existing = (operationsStore.tasks || []).find((item) => (
        item.automation?.mode === "managed"
        && item.collectionMode === input.collectionMode
        && (input.collectionMode === "country_business"
          ? item.country === input.country && JSON.stringify(item.businessKeywords || []) === JSON.stringify(input.businessKeywords || [])
          : input.collectionMode === "keyword" ? item.keyword === input.keyword : item.hsCode === input.hsCode)
        && !["completed", "cancelled"].includes(item.status)
      ));
      if (existing) {
        existing.direction = input.direction;
        existing.countries = input.countries;
        existing.country = input.country;
        existing.businessKeywords = input.businessKeywords;
        existing.budgets = input.budgets;
        existing.updatedAt = now;
        existing.audit = [...(existing.audit || []), { at: now, type: "managed_plan_refreshed", budgets: input.budgets }].slice(-1000);
        await writeJsonStore(operationsPath, operationsStore);
        return json(res, 200, taskPublicView(existing));
      }
      for (const prior of (operationsStore.tasks || []).filter((item) => (
        item.automation?.mode === "managed" && !["completed", "cancelled"].includes(item.status)
      ))) {
        prior.status = "cancelled";
        prior.updatedAt = now;
        prior.audit = [...(prior.audit || []), { at: now, type: "managed_plan_replaced", replacement: input.collectionMode === "country_business" ? `${input.country}:${input.businessKeywords.join(",")}` : input.hsCode }].slice(-1000);
        for (const job of (pipelineStore.jobs || []).filter((item) => (
          item.operationTaskId === prior.id
          && !latestPipelineArtifact(item, "drafting")
          && !["completed", "paused", "circuit_open"].includes(item.status)
        ))) {
          job.status = "paused";
          job.leaseOwner = null;
          job.leaseExpiresAt = null;
          job.requiredInput = `托管采集计划已切换为${input.collectionMode === "country_business" ? `${input.country}:${input.businessKeywords.join(",")}` : input.hsCode}`;
          job.updatedAt = now;
          job.audit = [...(job.audit || []), { at: now, type: "managed_plan_replaced", replacementHsCode: input.hsCode }].slice(-1000);
        }
      }
    }
    const task = {
      id: `task_${crypto.randomUUID()}`,
      ...input,
      status: "ready",
      safetyState: "READY",
      consecutiveAnomalies: 0,
      counters: {
        businessDate: currentBusinessDate(),
        buyerEntries: 0,
        companySearches: 0,
        companyDetails: 0,
        qualifiedCompanies: 0,
        contactPages: 0,
        rawContactRows: 0,
      },
      checkpoint: null,
      createdAt: now,
      updatedAt: now,
      audit: [{
        at: now,
        type: input.automation.mode === "managed" ? "managed_plan_authorized" : "task_created",
        safetyState: "READY",
      }],
    };
    operationsStore.tasks.unshift(task);
    pipelineStore.jobs.unshift(createPipelineJob(task));
    await Promise.all([
      writeJsonStore(operationsPath, operationsStore),
      writeJsonStore(pipelinePath, pipelineStore),
    ]);
    return json(res, 201, taskPublicView(task));
  }
  const taskMatch = pathname.match(/^\/api\/ops\/tasks\/([^/]+)(?:\/(actions|recover))?$/);
  if (taskMatch) {
    const [, id, action] = taskMatch;
    const task = (operationsStore.tasks || []).find((item) => item.id === id);
    if (!task) return json(res, 404, { error: "采集任务不存在" });
    if (req.method === "GET" && !action) return json(res, 200, taskPublicView(task));
    if (req.method === "PUT" && !action) {
      if (task.automation?.mode !== "managed") return json(res, 409, { error: "只有托管任务允许同步预算" });
      const input = await parseBody(req);
      const authKey = task.collectionMode === "keyword" ? task.keyword
        : task.collectionMode === "country_business" ? `${task.country}:${(task.businessKeywords || []).join(",")}`
          : task.hsCode;
      if (input.confirm !== `AUTHORIZE MANAGED ${authKey}`) return json(res, 428, { error: `需要输入确认短语：AUTHORIZE MANAGED ${authKey}` });
      const emailSendsDaily = boundedInteger(input.budgets?.emailSendsDaily, task.budgets.emailSendsDaily, 1, 1000);
      const companyDetailsDaily = boundedInteger(input.budgets?.companyDetailsDaily, task.budgets.companyDetailsDaily, 1, 400);
      const validEmailCompaniesDaily = boundedInteger(input.budgets?.validEmailCompaniesDaily, task.budgets.validEmailCompaniesDaily ?? 100, 1, 200);
      const managedDiscoveryFloor = Math.min(2000, Math.max(100, validEmailCompaniesDaily * 8));
      task.budgets = {
        buyerEntriesDaily: Math.max(boundedInteger(input.budgets?.buyerEntriesDaily, task.budgets.buyerEntriesDaily, 1, 2000), managedDiscoveryFloor),
        companyDetailsDaily: Math.max(companyDetailsDaily, Math.ceil(emailSendsDaily / 2)),
        validEmailCompaniesDaily,
        contactPagesDaily: boundedInteger(input.budgets?.contactPagesDaily, task.budgets.contactPagesDaily, 1, 400),
        emailSendsDaily,
      };
      task.updatedAt = new Date().toISOString();
      task.audit = [...(task.audit || []), { at: task.updatedAt, type: "managed_budgets_synchronized", budgets: task.budgets }].slice(-1000);
      await writeJsonStore(operationsPath, operationsStore);
      return json(res, 200, taskPublicView(task));
    }
    if (req.method === "POST" && action === "actions") {
      const input = await parseBody(req);
      try {
        recordTaskAction(task, input);
      } catch (error) {
        await writeJsonStore(operationsPath, operationsStore);
        throw error;
      }
      await writeJsonStore(operationsPath, operationsStore);
      return json(res, 200, taskPublicView(task));
    }
    if (req.method === "POST" && action === "recover") {
      const input = await parseBody(req);
      const automatic = task.automation?.mode === "managed" && input.verification === "netease_business_page_ready";
      if (!automatic && input.confirm !== `RECOVER ${id}`) return json(res, 428, { error: `需要输入确认短语：RECOVER ${id}` });
      const now = new Date().toISOString();
      task.status = automatic ? "active" : "ready";
      task.safetyState = automatic ? "RUNNING" : "HUMAN_RECOVERY";
      task.consecutiveAnomalies = 0;
      resetDailyCounters(task, currentBusinessDate());
      task.updatedAt = now;
      task.audit = [...(task.audit || []), { at: now, type: automatic ? "managed_runtime_verified_recovery" : "human_recovery_confirmed", safetyState: task.safetyState }].slice(-1000);
      await writeJsonStore(operationsPath, operationsStore);
      return json(res, 200, taskPublicView(task));
    }
  }
  if (req.method === "POST" && ["/api/ai/draft", "/api/ai/drafts"].includes(pathname)) {
    const now = Date.now();
    if (aiRequestInFlight || now - lastAiRequestAt < AI_MIN_INTERVAL_MS) {
      return json(res, 429, { error: "AI生成请求过于频繁，请稍后重试" });
    }
    lastAiRequestAt = now;
    aiRequestInFlight = true;
    try {
      const input = await parseBody(req);
      if (pathname === "/api/ai/draft") return json(res, 200, await generateAiDraft(input));

      const scenarioIds = [...new Set((Array.isArray(input.scenarios) ? input.scenarios : [])
        .map(String)
        .filter((id) => SCENARIO_BY_ID.has(id)))].slice(0, 3);
      if (!scenarioIds.length) return json(res, 422, { error: "请选择1-3种候选输出类型" });
      const brief = normalizedDraftBrief(input);
      const validationErrors = scenarioIds.flatMap((id) => {
        const scenario = SCENARIO_BY_ID.get(id);
        return scenarioValidationErrors(scenario, brief).map((error) => `${scenario.name}：${error}`);
      });
      if (validationErrors.length) return json(res, 422, { error: `候选类型资料不完整：${validationErrors.join("；")}` });

      const drafts = [];
      for (const scenario of scenarioIds) {
        if (drafts.length) await delay(AI_MIN_INTERVAL_MS);
        drafts.push(await generateAiDraft({ ...input, scenario }));
      }
      return json(res, 200, { drafts });
    } finally {
      aiRequestInFlight = false;
    }
  }
  if (req.method === "POST" && pathname === "/api/ai/batch-drafts") {
    const input = await parseBody(req);
    const recipients = Array.isArray(input.recipients) ? input.recipients.slice(0, boundedInteger(input.count, 20, 1, 200)) : [];
    if (!recipients.length) return json(res, 422, { error: "批量起草至少需要一个收件人" });
    const scenario = SCENARIO_BY_ID.get(String(input.scenario || "first_touch")) || SCENARIO_BY_ID.get("first_touch");
    const drafts = [];
    for (const recipient of recipients) {
      if (drafts.length) await delay(AI_MIN_INTERVAL_MS);
      drafts.push(await generateAiDraft({ ...input, ...recipient, scenario }));
    }
    return json(res, 200, { drafts, count: drafts.length, sendWithImages: Boolean(input.sendWithImages) });
  }
  if (req.method === "GET" && pathname === "/api/options") {
    return json(res, 200, {
      countries: [...new Set(model.buyers.map((item) => item.country))].filter(Boolean).sort(),
      confidences: ["高", "中高", "中", "低"],
      priorities: ["A-采购/运营", "B-管理层", "C-相关角色", "D-其他/公共"],
      enrichedBuyers: model.source.top20_company_and_contacts.map((item) => item.query_name),
      variables: ["{{first_name}}", "{{full_name}}", "{{company}}", "{{buyer_name}}", "{{country}}", "{{role}}"],
      emailScenarios: EMAIL_SCENARIOS.map(({ id, name, wordRange, maxAssets, requiredFields }) => ({ id, name, wordRange, maxAssets, requiredFields })),
      emailClaims: GUARDED_CLAIMS.map(({ id, label, text }) => ({ id, label, text })),
      emailAssets: EMAIL_ASSETS.map(({ id, label, url, tags, requiredClaim }) => ({ id, label, url, tags, requiredClaim })),
      collectionModes: [
        { id: "hscode", label: "HSCode主采集", description: "按HSCode检索，默认主流程" },
        { id: "keyword", label: "Keyword副采集", description: "按关键词检索，复用同一队列与安全边界" },
        { id: "country_business", label: "国家+业务范围采集", description: "按目标国家过滤业务关键词结果，作为第三采集方式" },
      ],
      emailTemplate: { version: EMAIL_TEMPLATE_LIBRARY.version, source: EMAIL_TEMPLATE_LIBRARY.source },
    });
  }
  if (req.method === "POST" && pathname === "/api/keyword-collection/prepare") {
    try {
      return json(res, 200, keywordCollectionManifest(await parseBody(req)));
    } catch (error) {
      return json(res, 422, { error: error.message });
    }
  }
  if (req.method === "POST" && pathname === "/api/country-business-collection/prepare") {
    try {
      return json(res, 200, countryBusinessCollectionManifest(await parseBody(req)));
    } catch (error) {
      return json(res, 422, { error: error.message });
    }
  }
  if (req.method === "GET" && pathname === "/api/capacity") {
    const configured = boundedInteger(process.env.UI_CONCURRENCY_LIMIT, 100, 10, 500);
    return json(res, 200, {
      model: "single-node-local-json",
      simultaneousOnlineUsers: configured,
      pc: configured,
      mobile: configured,
      note: "这是单实例并发验收基线，不是多副本容量承诺；生产扩容前需按部署环境压测。",
    });
  }
  if (req.method === "POST" && pathname === "/api/email-assets") {
    const input = await parseBody(req);
    const mimeType = String(input.mimeType || "").toLowerCase();
    const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);
    if (!allowed.has(mimeType)) return json(res, 415, { error: "仅支持 JPG、PNG 或 WebP 图片" });
    const encoded = String(input.dataBase64 || "").replace(/^data:[^;]+;base64,/, "");
    let bytes;
    try { bytes = Buffer.from(encoded, "base64"); } catch { bytes = Buffer.alloc(0); }
    if (!bytes.length || bytes.length > 5 * 1024 * 1024) return json(res, 413, { error: "图片必须为1字节至5MB" });
    const id = `asset_${crypto.randomUUID()}`;
    const extension = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
    const file = `assets/uploads/${id}.${extension}`;
    const filePath = path.join(publicDir, file);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, bytes, { mode: 0o600 });
    const asset = {
      id,
      label: String(input.label || input.filename || "本地上传图片").trim().slice(0, 120) || "本地上传图片",
      url: `/${file}`,
      file,
      mimeType,
      tags: ["local_upload"],
      requiredClaim: "",
      uploadedAt: new Date().toISOString(),
    };
    customEmailAssets.assets = [...(customEmailAssets.assets || []), asset].slice(-200);
    EMAIL_ASSETS.push(asset);
    ASSET_BY_ID.set(asset.id, asset);
    await writeJsonStore(emailAssetStorePath, customEmailAssets);
    return json(res, 201, { asset: { id: asset.id, label: asset.label, url: asset.url, tags: asset.tags, requiredClaim: "" } });
  }
  if (req.method === "GET" && pathname === "/api/sender-profile") {
    return json(res, 200, publicSenderProfile());
  }
  if (req.method === "PUT" && pathname === "/api/sender-profile") {
    let next;
    try {
      next = cleanSenderProfileInput(await parseBody(req));
    } catch (error) {
      return json(res, error.status || 422, { error: error.message });
    }
    Object.keys(senderProfileStore).forEach((key) => delete senderProfileStore[key]);
    Object.assign(senderProfileStore, next);
    await writeJsonStore(senderProfilePath, senderProfileStore);
    syncDeliveryFromSenderProfile();
    return json(res, 200, publicSenderProfile());
  }
  if (req.method === "GET" && pathname === "/api/outbox") {
    return json(res, 200, outboxPublicSummary());
  }
  if (req.method === "GET" && pathname === "/api/mailbox") {
    return json(res, 200, await mailboxView(url.searchParams));
  }
  if (req.method === "GET" && pathname === "/api/mailbox/export-replies") {
    const store = await readJsonStore(mailboxStorePath, { version: 1, accounts: [], messages: [] });
    const accountFilter = normalize(url.searchParams.get("account"));
    const query = normalize(url.searchParams.get("q"));
    const requestedIds = new Set(String(url.searchParams.get("ids") || "").split(",").map((item) => item.trim()).filter(Boolean));
    const requestedLimit = boundedInteger(url.searchParams.get("limit"), requestedIds.size || 100, 1, 500);
    const replies = (store.messages || [])
      .filter((item) => mailboxSenderPriority(item) === 0)
      .filter((item) => !accountFilter || normalize(item.account) === accountFilter)
      .filter((item) => !query || normalize([item.subject, item.from?.name, item.from?.address, item.snippet, item.account].join(" ")).includes(query))
      .sort((left, right) => String(right.date || "").localeCompare(String(left.date || "")));
    const selectedReplies = requestedIds.size
      ? replies.filter((item) => requestedIds.has(item.id)).slice(0, requestedLimit)
      : replies.slice(0, requestedLimit);
    return sendCsv(res, `potential-buyer-replies-${currentBusinessDate()}.csv`,
      ["message_id", "received_at", "mailbox_account", "sender_name", "sender_email", "to", "subject", "body_text", "snippet", "attachments", "status", "message_json"],
      selectedReplies.map((item) => [item.id, item.date, item.account, item.from?.name, item.from?.address, Array.isArray(item.to) ? item.to.join("; ") : String(item.to || ""), item.subject, item.bodyText, item.snippet, Array.isArray(item.attachments) ? item.attachments.map((attachment) => attachment.filename || attachment.name || attachment).join("; ") : String(item.attachments || ""), item.unread ? "unread" : "read", JSON.stringify(item)]));
  }
  if (req.method === "POST" && pathname === "/api/mailbox/compose") {
    if (!MAILBOX_REPLY_ENABLED) return json(res, 423, { error: "邮件中心发件开关尚未启用" });
    const input = await parseBody(req);
    const account = normalize(input.account);
    const recipient = normalize(input.to);
    const subject = String(input.subject || "").trim().slice(0, 240);
    const body = String(input.body || "").trim();
    if (input.confirm !== `SEND MAIL ${account}`) return json(res, 428, { error: `需要输入确认短语：SEND MAIL ${account}` });
    if (input.normalBusinessConfirmed !== true) return json(res, 422, { error: "必须确认这是单一收件人的正常商务通信，不是营销或开发信" });
    if (!validEmail(recipient) || !subject || !body || body.length > 20000) return json(res, 422, { error: "收件人、主题或1至20000字符正文无效" });
    const smtpConfig = mailboxAccountConfig(account);
    if (!smtpConfig) return json(res, 503, { error: "所选发件账号缺少服务器端客户端授权码" });
    const usage = mailboxReplyUsage();
    if (!usage.remaining) return json(res, 429, { error: `正常商务邮件已达到每日${usage.limit}封安全上限` });
    const now = new Date().toISOString();
    const entry = {
      id: `mbc_${crypto.randomUUID()}`,
      type: "manual_compose",
      sourceMessageId: null,
      account,
      recipient,
      subject,
      status: "sending",
      businessDay: usage.day,
      messageId: `${crypto.randomUUID()}@${account.split("@")[1]}`,
      createdAt: now,
      updatedAt: now,
      lastError: "",
    };
    mailboxReplyStore.entries ||= [];
    mailboxReplyStore.entries.push(entry);
    await writeJsonStore(mailboxReplyPath, mailboxReplyStore);
    try {
      const delivery = await sendSmtpMessage({ to: recipient, subject, body, messageId: entry.messageId }, smtpConfig, buildMailboxReplyMessage);
      Object.assign(entry, { status: "accepted", providerResponse: delivery.response, updatedAt: new Date().toISOString() });
      await writeJsonStore(mailboxReplyPath, mailboxReplyStore);
      return json(res, 200, { accepted: true, entry: { ...entry, providerResponse: undefined }, usage: mailboxReplyUsage() });
    } catch (error) {
      Object.assign(entry, { status: error.deliveryUncertain ? "uncertain" : "failed", lastError: clipText(error.message, 240), updatedAt: new Date().toISOString() });
      await writeJsonStore(mailboxReplyPath, mailboxReplyStore);
      return json(res, error.deliveryUncertain ? 502 : 503, { error: entry.lastError, status: entry.status });
    }
  }
  const mailboxMessageMatch = pathname.match(/^\/api\/mailbox\/messages\/([^/]+)$/);
  if (req.method === "GET" && mailboxMessageMatch) {
    const store = await readJsonStore(mailboxStorePath, { version: 1, accounts: [], messages: [] });
    const message = (store.messages || []).find((item) => item.id === mailboxMessageMatch[1]);
    if (!message) return json(res, 404, { error: "邮件不存在或尚未同步" });
    return json(res, 200, message);
  }
  const mailboxReplyMatch = pathname.match(/^\/api\/mailbox\/messages\/([^/]+)\/reply$/);
  if (req.method === "POST" && mailboxReplyMatch) {
    if (!MAILBOX_REPLY_ENABLED) return json(res, 423, { error: "邮件中心回复开关尚未启用" });
    if (mailboxRepliesInFlight.has(mailboxReplyMatch[1])) return json(res, 409, { error: "该邮件正在回复，请勿重复提交" });
    const input = await parseBody(req);
    if (input.confirm !== `REPLY ${mailboxReplyMatch[1]}`) {
      return json(res, 428, { error: `需要输入确认短语：REPLY ${mailboxReplyMatch[1]}` });
    }
    const body = String(input.body || "").trim();
    if (!body || body.length > 20000) return json(res, 422, { error: "回复正文必须为1至20000个字符" });
    const usage = mailboxReplyUsage();
    if (!usage.remaining) return json(res, 429, { error: `正常商务回复已达到每日${usage.limit}封安全上限` });
    const store = await readJsonStore(mailboxStorePath, { version: 1, accounts: [], messages: [] });
    const source = (store.messages || []).find((item) => item.id === mailboxReplyMatch[1]);
    if (!source) return json(res, 404, { error: "原邮件不存在或尚未同步" });
    const recipient = normalize(source.from?.address);
    const smtpConfig = mailboxAccountConfig(source.account);
    if (!smtpConfig) return json(res, 503, { error: "该收件账号缺少服务器端客户端授权码" });
    if (!validEmail(recipient) || recipient.endsWith(`@${smtpConfig.user.split("@")[1]}`)) {
      return json(res, 422, { error: "原邮件没有可回复的外部联系人地址" });
    }
    if ((mailboxReplyStore.entries || []).some((entry) => entry.sourceMessageId === source.id && ["sending", "accepted", "uncertain"].includes(entry.status))) {
      return json(res, 409, { error: "该入站邮件已经回复；请等待对方新邮件后继续会话" });
    }

    const now = new Date().toISOString();
    const entry = {
      id: `mbr_${crypto.randomUUID()}`,
      sourceMessageId: source.id,
      account: smtpConfig.user,
      recipient,
      subject: /^re\s*:/i.test(source.subject || "") ? source.subject : `Re: ${source.subject || "Business inquiry"}`,
      status: "sending",
      businessDay: usage.day,
      messageId: `${crypto.randomUUID()}@${smtpConfig.user.split("@")[1]}`,
      createdAt: now,
      updatedAt: now,
      lastError: "",
    };
    mailboxReplyStore.entries ||= [];
    mailboxReplyStore.entries.push(entry);
    await writeJsonStore(mailboxReplyPath, mailboxReplyStore);
    mailboxRepliesInFlight.add(source.id);
    try {
      const delivery = await sendSmtpMessage({
        to: recipient,
        subject: entry.subject,
        body,
        messageId: entry.messageId,
        inReplyTo: source.messageId,
        references: source.references || [],
      }, smtpConfig, buildMailboxReplyMessage);
      Object.assign(entry, { status: "accepted", providerResponse: delivery.response, updatedAt: new Date().toISOString() });
      await writeJsonStore(mailboxReplyPath, mailboxReplyStore);
      return json(res, 200, { accepted: true, entry: { ...entry, providerResponse: undefined }, usage: mailboxReplyUsage() });
    } catch (error) {
      Object.assign(entry, {
        status: error.deliveryUncertain ? "uncertain" : "failed",
        lastError: clipText(error.message, 240),
        updatedAt: new Date().toISOString(),
      });
      await writeJsonStore(mailboxReplyPath, mailboxReplyStore);
      return json(res, error.deliveryUncertain ? 502 : 503, { error: entry.lastError, status: entry.status });
    } finally {
      mailboxRepliesInFlight.delete(source.id);
    }
  }
  const outboxCancelMatch = pathname.match(/^\/api\/outbox\/([^/]+)\/cancel$/);
  if (outboxCancelMatch && req.method === "POST") {
    const entry = (outboxStore.entries || []).find((item) => item.id === outboxCancelMatch[1]);
    if (!entry) return json(res, 404, { error: "发件箱记录不存在" });
    if (entry.status !== "pending") return json(res, 409, { error: "只有pending记录可以取消" });
    const input = await parseBody(req);
    if (input.confirm !== `CANCEL OUTBOX ${entry.id}`) return json(res, 428, { error: `需要输入确认短语：CANCEL OUTBOX ${entry.id}` });
    const actor = clipText(String(input.operator || "").trim(), 120);
    const reason = clipText(String(input.reason || "").trim(), 500);
    if (!actor || !reason) return json(res, 422, { error: "取消必须记录操作者和原因" });
    await transitionOutbox(entry, "cancelled", { type: "manual_outbox_cancelled", actor, reason });
    const job = (pipelineStore.jobs || []).find((item) => item.id === entry.campaignId);
    if (job?.currentStage === "sending" && ["waiting_input", "paused"].includes(job.status)) {
      job.status = "paused";
      job.leaseOwner = "";
      job.leaseExpiresAt = null;
      job.requiredInput = `发件箱记录已取消：${reason}`.slice(0, 500);
      job.stages.sending = { ...(job.stages.sending || {}), status: "paused", updatedAt: entry.updatedAt };
      job.updatedAt = entry.updatedAt;
      job.audit = [...(job.audit || []), { at: entry.updatedAt, type: "pipeline_outbox_cancelled", outboxId: entry.id, actor, reason }].slice(-1000);
      await writeJsonStore(pipelinePath, pipelineStore);
    }
    return json(res, 200, {
      outbox: {
        id: entry.id,
        campaignId: entry.campaignId,
        status: entry.status,
        attempts: entry.attempts,
        events: (entry.events || []).slice(-20),
      },
      job: job ? { id: job.id, status: job.status, currentStage: job.currentStage } : null,
      smtp: false,
    });
  }
  const outboxMatch = pathname.match(/^\/api\/outbox\/([^/]+)\/resolve$/);
  if (outboxMatch && req.method === "POST") {
    const entry = (outboxStore.entries || []).find((item) => item.id === outboxMatch[1]);
    if (!entry) return json(res, 404, { error: "发件箱记录不存在" });
    if (entry.status !== "uncertain") return json(res, 409, { error: "只有uncertain记录需要人工裁决" });
    const input = await parseBody(req);
    if (input.confirm !== `RESOLVE ${entry.id}`) return json(res, 428, { error: `需要输入确认短语：RESOLVE ${entry.id}` });
    const outcome = input.outcome === "accepted" ? "accepted" : "failed";
    await transitionOutbox(entry, outcome, { type: "manual_delivery_resolution", lastError: String(input.note || "manual resolution") });
    return json(res, 200, outboxPublicSummary());
  }
  if (req.method === "GET" && pathname === "/api/campaigns") {
    const campaigns = await readCampaigns();
    return json(res, 200, campaigns.map((campaign) => campaignWithMetrics(model, campaign)));
  }
  if (req.method === "POST" && pathname === "/api/campaigns") {
    const input = cleanCampaignInput(await parseBody(req));
    const campaigns = await readCampaigns();
    const now = new Date().toISOString();
    const campaign = {
      id: `cmp_${crypto.randomUUID()}`,
      ...input,
      status: "draft",
      createdAt: now,
      updatedAt: now,
      scheduleAt: null,
      audit: [{ at: now, action: "draft_created" }],
    };
    campaigns.unshift(campaign);
    await writeCampaigns(campaigns);
    return json(res, 201, campaignWithMetrics(model, campaign));
  }

  const campaignMatch = pathname.match(/^\/api\/campaigns\/([^/]+)(?:\/(preview|submit-review|approve|simulate-schedule|send))?$/);
  if (campaignMatch) {
    const [, id, action] = campaignMatch;
    const campaigns = await readCampaigns();
    const index = campaigns.findIndex((campaign) => campaign.id === id);
    if (index < 0) return json(res, 404, { error: "活动不存在" });
    const campaign = campaigns[index];

    if (req.method === "GET" && !action) return json(res, 200, campaignWithMetrics(model, campaign));

    if (req.method === "PUT" && !action) {
      if (!["draft", "review", "approved", "simulated_scheduled"].includes(campaign.status)) {
        return json(res, 409, { error: "已开始发送的活动不可编辑；请复制为新草稿" });
      }
      const input = cleanCampaignInput(await parseBody(req));
      const now = new Date().toISOString();
      campaigns[index] = {
        ...campaign,
        ...input,
        status: "draft",
        updatedAt: now,
        scheduleAt: null,
        approvedAt: null,
        approvedBy: null,
        recipientSnapshot: null,
        audit: [...(campaign.audit || []), { at: now, action: "edited_and_returned_to_draft" }],
      };
      await writeCampaigns(campaigns);
      return json(res, 200, campaignWithMetrics(model, campaigns[index]));
    }

    if (req.method === "POST" && action === "preview") {
      const recipients = campaignRecipients(model, campaign).slice(0, 5);
      const assets = (campaign.assetIds || []).map((id) => ASSET_BY_ID.get(id)).filter(Boolean);
      return json(res, 200, {
        campaignId: id,
        estimatedRecipients: campaignRecipients(model, campaign).length,
        scenario: campaign.brief?.scenario || "first_touch",
        assets: assets.map(({ id: assetId, label, url }) => ({ id: assetId, label, url })),
        contentErrors: campaignContentErrors(campaign),
        warning: "所有邮箱仍为unverified；此预览不会发送邮件。配图不含跟踪像素。",
        items: recipients.map((recipient) => ({
          recipient: { name: recipient.name, email: recipient.email, company: recipient.matchedCompany, priority: recipient.priority },
          subject: renderTemplate(campaign.subject, recipient),
          body: renderTemplate(campaign.body, recipient),
          wordCount: englishWordCount(renderTemplate(campaign.body, recipient)),
        })),
      });
    }

    if (req.method === "POST" && action === "submit-review") {
      const recipients = campaignRecipients(model, campaign);
      const errors = campaignContentErrors(campaign);
      if (!recipients.length) errors.push("没有符合条件的邮箱联系人");
      if (errors.length) return json(res, 422, { error: "无法提交审核", details: errors });
      const now = new Date().toISOString();
      campaigns[index] = {
        ...campaign,
        status: "review",
        updatedAt: now,
        recipientSnapshot: { count: recipients.length, createdAt: now, sourceDate: model.summary.retrievalDate },
        audit: [...(campaign.audit || []), { at: now, action: "submitted_for_review" }],
      };
      await writeCampaigns(campaigns);
      return json(res, 200, campaignWithMetrics(model, campaigns[index]));
    }

    if (req.method === "POST" && action === "approve") {
      const input = await parseBody(req);
      if (input.confirm !== `APPROVE ${id}`) {
        return json(res, 428, { error: `需要输入确认短语：APPROVE ${id}` });
      }
      if (campaign.status !== "review") {
        return json(res, 409, { error: "只有 review 状态的活动可以批准" });
      }
      const recipients = campaignRecipients(model, campaign);
      const errors = campaignContentErrors(campaign);
      if (!recipients.length) errors.push("没有符合条件的收件人");
      const checks = campaign.compliance || {};
      if (!checks.senderDomainVerified) errors.push("发件域名未确认");
      if (!checks.unsubscribeConfigured) errors.push("退订机制未确认");
      if (!checks.physicalAddressConfigured) errors.push("实体地址未确认");
      if (!checks.suppressionListChecked) errors.push("抑制名单未检查");
      if (errors.length) return json(res, 422, { error: "活动未达到批准门槛", details: [...new Set(errors)] });
      const now = new Date().toISOString();
      const reviewer = String(input.reviewer || "local-admin").trim().slice(0, 120) || "local-admin";
      campaigns[index] = {
        ...campaign,
        status: "approved",
        updatedAt: now,
        approvedAt: now,
        approvedBy: reviewer,
        recipientSnapshot: campaign.recipientSnapshot || {
          count: recipients.length,
          createdAt: now,
          sourceDate: model.summary.retrievalDate,
        },
        audit: [...(campaign.audit || []), { at: now, action: "campaign_approved", reviewer }],
      };
      await writeCampaigns(campaigns);
      return json(res, 200, campaignWithMetrics(model, campaigns[index]));
    }

    if (req.method === "POST" && action === "simulate-schedule") {
      if (!["review", "approved"].includes(campaign.status)) return json(res, 409, { error: "活动必须先进入审核状态" });
      const input = await parseBody(req);
      const now = new Date().toISOString();
      const scheduleAt = input.scheduleAt ? new Date(input.scheduleAt).toISOString() : new Date(Date.now() + 86400000).toISOString();
      campaigns[index] = {
        ...campaign,
        status: "simulated_scheduled",
        scheduleAt,
        updatedAt: now,
        audit: [...(campaign.audit || []), { at: now, action: "simulated_schedule_created", scheduleAt }],
      };
      await writeCampaigns(campaigns);
      return json(res, 200, campaignWithMetrics(model, campaigns[index]));
    }

    if (req.method === "POST" && action === "send") {
      const input = await parseBody(req);
      if (input.confirm !== `SEND ${id}`) {
        return json(res, 428, { error: `需要输入确认短语：SEND ${id}` });
      }
      const readiness = sendReadiness(model, campaign);
      if (!readiness.ready) return json(res, 423, { error: "发送条件未满足", details: readiness.errors });

      const available = sendableRecipients(model, campaign);
      const daily = dailyDeliveryUsage();
      const batch = available.slice(0, Math.min(deliveryConfig.batchLimit, daily.remaining));
      const sentHashes = [];
      const failures = [];
      for (let indexInBatch = 0; indexInBatch < batch.length; indexInBatch += 1) {
        const recipient = batch[indexInBatch];
        let outboxEntry;
        try {
          const sender = selectSenderAccount();
          outboxEntry = await prepareOutboxEntry(campaign, recipient, sender);
          await transitionOutbox(outboxEntry, "sending");
          const delivery = await sendSmtpMessage({
            to: recipient.email,
            subject: renderTemplate(campaign.subject, recipient),
            body: renderTemplate(campaign.body, recipient),
            assetIds: campaignAssetIds(campaign),
            messageId: outboxEntry.messageId,
          }, sender.config);
          await transitionOutbox(outboxEntry, "accepted", { providerResponse: delivery.response });
          sentHashes.push(stableId("delivery", normalize(recipient.email)));
        } catch (error) {
          const status = error.deliveryUncertain ? "uncertain" : "failed";
          if (outboxEntry) await transitionOutbox(outboxEntry, status, { lastError: error.message });
          failures.push({ recipientId: recipient.id, status, error: clipText(error.message, 240) });
        }
        if (indexInBatch < batch.length - 1) await delay(deliveryConfig.delayMs);
      }

      const nowIso = new Date().toISOString();
      const previousHashes = campaign.delivery?.recipientHashes || [];
      const recipientHashes = [...new Set([...previousHashes, ...sentHashes])];
      const remaining = Math.max(available.length - sentHashes.length, 0);
      campaigns[index] = {
        ...campaign,
        status: remaining === 0 && failures.length === 0 ? "sent" : "partially_sent",
        updatedAt: nowIso,
        delivery: {
          sentCount: recipientHashes.length,
          recipientHashes,
          lastBatchAt: nowIso,
          lastBatchSent: sentHashes.length,
          lastBatchFailed: failures.length,
        },
        audit: [...(campaign.audit || []), {
          at: nowIso,
          action: "smtp_batch_attempted",
          sent: sentHashes.length,
          failed: failures.length,
        }],
      };
      await writeCampaigns(campaigns);
      const result = {
        campaign: campaignWithMetrics(model, campaigns[index]),
        batch: { attempted: batch.length, sent: sentHashes.length, failed: failures.length, remaining },
        failures,
      };
      return json(res, sentHashes.length ? 200 : 502, result);
    }
  }

  if (pathname === "/api/send" || pathname.endsWith("/send")) {
    return json(res, 423, { error: "真实发送功能已锁定", sendingEnabled: false });
  }
  return json(res, 404, { error: "接口不存在" });
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function staticHandler(res, pathname) {
  const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const filePath = path.resolve(publicDir, requested);
  if (!filePath.startsWith(`${publicDir}${path.sep}`) && filePath !== path.join(publicDir, "index.html")) {
    return text(res, 403, "Forbidden");
  }
  try {
    const file = await fs.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mime[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Content-Length": file.length,
      "Cache-Control": "no-cache",
    });
    res.end(file);
  } catch (error) {
    if (error.code === "ENOENT") return text(res, 404, "Not found");
    throw error;
  }
}

const source = await readSource();
const managedHistory = await readManagedHistoryReport();
const model = buildModel(source, managedHistory);
applyLocalContactState(model);

const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' https://unpkg.com; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  );
  try {
    const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204, { "Cache-Control": "public, max-age=86400" });
      return res.end();
    }
    if (url.pathname.startsWith("/api/")) return await apiHandler(req, res, url, model);
    return await staticHandler(res, url.pathname);
  } catch (error) {
    console.error(error);
    return json(res, error.status || 500, { error: error.message || "服务器错误" });
  }
});

server.listen(port, host, () => {
  console.log(`DaKings Prospect Ops running at http://${host}:${port}`);
  console.log(`Source: ${sourcePath}`);
  console.log(`AI draft generation: ${process.env.OPENAI_API_KEY ? `configured (${OPENAI_MODEL})` : "not configured"}`);
  console.log(`SMTP delivery: ${sendingEnabled() ? "enabled" : "locked"}`);
});
