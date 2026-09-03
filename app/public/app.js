const state = {
  view: "overview",
  health: null,
  summary: null,
  quality: null,
  workflow: [],
  projectProgress: { overall: 0, acquisition: 0, sendingReadiness: 0 },
  managedPlan: { hsCodes: [], dailyBudgets: {}, mandatoryHumanGates: [] },
  options: { countries: [], confidences: [], priorities: [], enrichedBuyers: [], variables: [], emailScenarios: [], emailClaims: [], emailAssets: [] },
  buyers: null,
  contacts: null,
  contactQuality: { counts: {}, records: [], storedRecords: 0, suppressions: 0 },
  suppressions: { count: 0, items: [] },
  operationTasks: [],
  contactQueues: [],
  selectedQueueId: null,
  activeCollectionBatch: null,
  pipeline: { stages: [], counts: {}, claimable: 0, jobs: [] },
  countryBusiness: { items: [], totalCompanies: 0 },
  dailyBatch: { selected: [], blockedCount: 0, sendsRequireApproval: false, requiresCentralReview: false },
  inventory: { totalCompanies: 0, previousRemainingCompanies: 0, todayQualifiedCompanies: 0, target: 100, draftPool: { total: 0, sent: 0, remaining: 0 }, dailyStatus: { code: "ended", label: "已结束", detail: "" } },
  outbox: { counts: {}, items: [] },
  mailbox: { accounts: [], counts: {}, messages: [], replies: [], replyUsage: {} },
  mailboxFilters: { account: "", q: "" },
  mailboxSelectedIds: [],
  mailboxExportCount: 20,
  mailboxMessage: null,
  selectedTaskId: null,
  campaigns: [],
  drafts: { items: [], counts: {} },
  draftFilters: { q: "" },
  selectedDraftId: null,
  editingCampaignId: null,
  senderProfile: null,
  deliveryMode: { mode: "manual", automaticApprovalStillRequiresAllGates: true },
  capacity: { simultaneousOnlineUsers: 100, pc: 100, mobile: 100, note: "" },
  controlLoadErrors: [],
  companyQualification: { enabled: false, targetCountries: [], businessKeywords: [], excludeKeywords: [], targetHsCodes: [], allowedCompanyTypes: [], minimumScore: 0, statistics: {} },
  buyerFilters: { q: "", country: "", confidence: "", status: "", page: 1, pageSize: 20 },
  contactFilters: { q: "", buyer: "", priority: "", confidence: "", validation: "", dedupe: "first", emailOnly: false, page: 1, pageSize: 25 },
  campaignPreview: null,
  draftCandidates: [],
};

const viewMeta = {
  overview: ["采集运营", "数据总览"],
  foundation: ["历史数据与质量", "业务底盘"],
  workflow: ["端到端状态", "采集流程"],
  buyers: ["139家原始买家", "买家工作台"],
  contacts: ["前20大买家", "联系人"],
  operations: ["预算与安全状态", "运行控制"],
  campaigns: ["未来发送流程", "邮件实验室"],
  drafts: ["批量内容审阅", "批量草稿"],
  mailbox: ["十账号统一收发", "邮件中心"],
  "sender-profile": ["邮件身份与合规", "发件配置"],
  settings: ["安全与合规", "系统边界"],
};

const main = document.getElementById("mainContent");
const title = document.getElementById("viewTitle");
const sidebar = document.getElementById("sidebar");
const scrim = document.getElementById("mobileScrim");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function currency(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(Number(value || 0));
}

function number(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value || 0));
}

function percent(value) {
  return `${Number(value || 0).toFixed(2)}%`;
}

function shortDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

function shortDateTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function queryString(values) {
  const query = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== "" && value !== false && value != null) query.set(key, value);
  });
  return query.toString();
}

function deliveryEnabled() {
  return Boolean(
    state.health?.delivery?.enabled
    && state.health?.delivery?.smtpConfigured
    && !state.health?.delivery?.circuit?.open
  );
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.details?.join("；") || payload.errors?.join("；") || payload.error || `请求失败 ${response.status}`);
  return payload;
}

function badge(value) {
  const map = {
    "高": "high", "中高": "medium", "中": "medium", "低": "low", "未匹配": "neutral",
    complete: "complete", partial: "partial", blocked: "blocked", prototype: "prototype",
    draft: "draft", review: "review", approved: "approved", simulated_scheduled: "scheduled",
    partially_sent: "partial", sent: "complete",
    "已补全": "complete", "待补全": "neutral",
    READY: "complete", RUNNING: "complete", THROTTLED: "partial", CIRCUIT_OPEN: "blocked", HUMAN_RECOVERY: "prototype",
    ready: "complete", queued: "neutral", running: "complete", waiting_input: "partial", collecting: "partial", drafting: "partial", sending: "partial", aborted: "blocked", circuit_open: "blocked", ended: "complete", paused: "prototype", completed: "complete",
    pending: "neutral", leased: "partial", skipped: "prototype", sending: "partial", accepted: "complete", failed: "blocked", uncertain: "blocked",
    unverified: "neutral", syntax_valid: "partial", domain_valid: "complete", deliverable: "complete",
    accept_all: "partial", invalid: "blocked", opted_out: "blocked",
    synced: "complete", waiting_sync: "neutral", error: "blocked",
    batch_review: "review",
  };
  const labels = {
    complete: "已完成", partial: "进行中", blocked: "待解锁", prototype: "原型",
    draft: "草稿", review: "审核中", approved: "已批准", simulated_scheduled: "模拟排期",
    partially_sent: "部分已发送", sent: "发送完成",
    READY: "就绪", RUNNING: "运行中", THROTTLED: "已降速", CIRCUIT_OPEN: "已熔断", HUMAN_RECOVERY: "人工恢复",
    ready: "就绪", queued: "排队中", running: "执行中", waiting_input: "待输入", collecting: "联系人采集中", drafting: "写草稿中", sending: "发件中", aborted: "意外终止", batch_review: "集中审核", circuit_open: "熔断中", ended: "已结束", paused: "已暂停", completed: "已完成",
    pending: "待处理", leased: "已领取", skipped: "已跳过", sending: "发送中", accepted: "已接受", failed: "失败", uncertain: "状态不确定",
    unverified: "未验证", syntax_valid: "格式有效", domain_valid: "基础有效", deliverable: "可投递",
    accept_all: "全收域名", invalid: "无效", opted_out: "已抑制",
    synced: "已同步", waiting_sync: "等待同步", error: "同步失败",
  };
  return `<span class="badge ${map[value] || "neutral"}">${escapeHtml(labels[value] || value || "-")}</span>`;
}

function toast(message, type = "success") {
  const item = document.createElement("div");
  item.className = `toast ${type === "error" ? "error" : ""}`;
  item.textContent = message;
  document.getElementById("toastRegion").appendChild(item);
  window.setTimeout(() => item.remove(), 3200);
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}

function renderDeliveryStatus() {
  const container = document.getElementById("deliveryStatus");
  if (!container) return;
  const enabled = deliveryEnabled();
  container.innerHTML = `
    <i data-lucide="${enabled ? "shield-check" : "lock-keyhole"}"></i>
    <div><strong>${enabled ? "受控发送已开启" : "真实发送已锁定"}</strong><span>${enabled ? "采集后自动起草；集中批次核验、证据与熔断门仍生效" : "仅本地草稿与模拟排期"}</span></div>
  `;
  refreshIcons();
}

function setLoading() {
  main.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>正在读取数据</span></div>`;
}

function emptyState(icon, titleText, body) {
  return `<div class="empty-state"><div><i data-lucide="${icon}"></i><strong>${escapeHtml(titleText)}</strong><p>${escapeHtml(body)}</p></div></div>`;
}

async function loadBase() {
  const [health, summary, quality, workflowData, managedPlan, options, buyers, contacts, contactQuality, suppressions, operations, contactQueues, pipeline, countryBusiness, dailyBatch, inventory, outbox, mailbox, campaigns, senderProfile, deliveryMode, capacity, deliveryCapacity] = await Promise.all([
    api("/api/health"),
    api("/api/summary"),
    api("/api/quality"),
    api("/api/workflow"),
    api("/api/managed-plan"),
    api("/api/options"),
    api("/api/buyers?page=1&pageSize=10"),
    api("/api/contacts?page=1&pageSize=25&dedupe=first"),
    api("/api/contact-quality"),
    api("/api/suppressions"),
    api("/api/ops/tasks"),
    api("/api/contact-queues"),
    api("/api/pipeline"),
    api("/api/country-business-collection/status"),
    api("/api/pipeline/daily-batch?limit=1000&central=1"),
    api("/api/pipeline/inventory?limit=1000"),
    api("/api/outbox"),
    api("/api/mailbox"),
    api("/api/campaigns"),
    api("/api/sender-profile"),
    api("/api/delivery-mode"),
    api("/api/capacity"),
    api("/api/delivery-capacity"),
  ]);
  state.health = health;
  state.summary = summary;
  state.quality = quality;
  state.workflow = workflowData.items;
  state.projectProgress = {
    overall: Number(workflowData.overallProgress || 0),
    acquisition: Number(workflowData.acquisitionProgress || 0),
    sendingReadiness: Number(workflowData.sendingReadiness || 0),
  };
  state.managedPlan = managedPlan;
  state.options = options;
  state.buyers = buyers;
  state.contacts = contacts;
  state.contactQuality = contactQuality;
  state.suppressions = suppressions;
  state.operationTasks = operations.items;
  state.contactQueues = contactQueues.items;
  state.selectedQueueId ||= contactQueues.items[0]?.id || null;
  state.pipeline = pipeline;
  state.countryBusiness = countryBusiness;
  state.dailyBatch = dailyBatch;
  state.inventory = inventory;
  state.outbox = outbox;
  state.mailbox = mailbox;
  state.selectedTaskId ||= operations.items[0]?.id || null;
  state.campaigns = campaigns;
  state.senderProfile = senderProfile;
  state.deliveryMode = deliveryMode;
  state.capacity = capacity;
  state.deliveryCapacity = deliveryCapacity;
  renderDeliveryStatus();
}

function renderOverview() {
  const planMode = state.managedPlan.collectionMode || "hscode";
  const planEntry = state.managedPlan.hsCodes?.[0] || {};
  const profile = state.managedPlan.marketTargetProfile || {};
  const task = state.operationTasks.find((item) => (
    item.collectionMode === planMode
      && (planMode === "country_business"
        ? item.country === profile.country && JSON.stringify(item.businessKeywords || []) === JSON.stringify(profile.industryKeywords || [])
        : planMode === "keyword" ? item.keyword === planEntry.keyword : item.hsCode === planEntry.hsCode)
  )) || state.operationTasks.find((item) => item.collectionMode === planMode) || state.operationTasks[0] || null;
  const budgets = { ...(state.managedPlan.dailyBudgets || {}), ...(task?.budgets || {}) };
  const counters = task?.counters || {};
  const collectionLimit = Number(budgets.validEmailCompaniesDaily || budgets.validEmailCompanies || 100);
  const processingStrategy = state.managedPlan.companyProcessingStrategy || { label: "固定模式", dailyCompanyTarget: collectionLimit };
  const inventoryCompanyCount = Number(state.inventory?.inventory?.totalCompanies ?? state.inventory?.selectedCompanyCount ?? state.dailyBatch?.selectedCompanyCount ?? 0);
  const previousRemainingCompanies = Number(state.inventory?.inventory?.previousRemainingCompanies || 0);
  const todayQualifiedCompanies = Number(state.inventory?.inventory?.todayQualifiedCompanies || 0);
  const scanUsed = Number(counters.companyDetails || 0);
  const scanLimit = Number(budgets.companyDetailsDaily || budgets.companyDetails || 100);
  const sendUsed = Number(state.health?.delivery?.daily?.used || 0);
  const sendLimit = Number(state.deliveryCapacity?.globalLimit || 0);
  const draftPoolRemaining = Number(state.inventory?.draftPool?.remaining || 0);
  const dailyStatus = state.inventory?.dailyStatus || { code: "ended", label: "已结束", detail: "" };
  const currentPage = Number(task?.checkpoint?.page || planEntry.startPage || 1);
  const queuePrefix = `${state.managedPlan.planId || ""}_${planEntry.hsCode || ""}_page_`;
  const activeQueue = [...(state.contactQueues || [])]
    .filter((queue) => String(queue.key || "").startsWith(queuePrefix) && Number(queue.counts?.remaining || 0) > 0)
    .sort((left, right) => Number(String(right.key).match(/_page_(\d+)$/)?.[1] || 0) - Number(String(left.key).match(/_page_(\d+)$/)?.[1] || 0))[0];
  const activeQueuePage = Number(String(activeQueue?.key || "").match(/_page_(\d+)$/)?.[1] || currentPage);
  const statusDetail = dailyStatus.code === "collecting" && activeQueue
    ? `${dailyStatus.detail} 当前第 ${activeQueuePage} 页已处理 ${number(activeQueue.counts?.processed)} / ${number(activeQueue.counts?.total)} 家，剩余 ${number(activeQueue.counts?.remaining)}。`
    : dailyStatus.detail;
  const collectionSource = planMode === "country_business"
    ? `国家+业务 ${profile.country || task?.country || "未设置"}`
    : planMode === "keyword"
      ? `关键词 ${planEntry.keyword || task?.keyword || "未设置"}`
      : planEntry.hsCode ? `HSCode ${planEntry.hsCode}` : "当前计划";
  const collectionModeLabel = planMode === "country_business" ? "国家+业务范围第三采集"
    : planMode === "keyword" ? "Keyword副采集" : "HSCode主采集";
  const collectionTarget = planMode === "country_business"
    ? (profile.industryKeywords || task?.businessKeywords || []).join(", ")
    : planMode === "keyword" ? (planEntry.keyword || task?.keyword || "") : (planEntry.hsCode || task?.hsCode || "");
  const countryItems = state.countryBusiness?.items || [];
  const countryRows = countryItems.flatMap((item) => item.businessKeywords.map((keyword) => `
    <div class="country-collection-row"><span class="country-collection-name"><strong>${escapeHtml(item.country)}</strong><small>${escapeHtml(keyword)}</small></span><span class="country-collection-count">${number(item.companies)} 家</span><span class="country-collection-meta">${number(item.pages)} 页 · ${shortDateTime(item.latestAt)}</span></div>`)).slice(0, 3);
  return `
    <div class="view-stack overview-stack">
      <section class="mission-console" aria-labelledby="missionTitle">
        <div class="mission-identity">
          <div class="mission-label"><span class="signal-dot"></span>当前托管批次</div>
          <form class="mission-plan-form" id="overviewManagedPlanForm">
            <label for="overviewHsCode" id="missionTitle">${escapeHtml(collectionModeLabel)}</label>
            <div class="mission-plan-input">
              <input class="input" id="overviewHsCode" name="hsCode" inputmode="numeric" pattern="[0-9]{4,10}" value="${escapeHtml(collectionTarget)}" placeholder="${planMode === "hscode" ? "输入4至10位HSCode" : "当前模式由运行控制管理"}" ${planMode === "hscode" ? "required" : "readonly"} />
              <button class="button primary" type="submit" ${planMode === "hscode" ? "" : "disabled"}><i data-lucide="play"></i>${planMode === "hscode" ? "切换并启动托管采集" : "请在运行控制中切换采集模式"}</button>
            </div>
            <small>当前模式：${escapeHtml(collectionModeLabel)} · 目标：${escapeHtml(collectionTarget || "未设置")}；每日公司目标保持100家，邮件容量由统一服务计算。</small>
          </form>
          <p>${planEntry.direction === "supplier" ? "供应商" : "采购商"}方向 · ${escapeHtml(planEntry.countries?.join("、") || "全部地区")} · 从第 ${number(planEntry.startPage || 1)} 页开始</p>
          <p>每日公司处理策略：${escapeHtml(processingStrategy.label)} · ${number(processingStrategy.dailyCompanyTarget)} 家公司/日</p>
          <div class="mission-tags">${badge(dailyStatus.code)}<span class="readout">PAGE ${number(currentPage)}</span><span class="readout">${escapeHtml(state.managedPlan.mode || "managed").toUpperCase()}</span></div>
          <button class="button mission-link" data-jump="operations" type="button"><i data-lucide="arrow-up-right"></i>打开运行控制</button>
        </div>

        <div class="mission-progress" aria-label="今日执行进度">
          <div class="daily-status-bar ${escapeHtml(dailyStatus.code)}" data-testid="daily-task-status">
            <span class="daily-status-icon"><i data-lucide="${dailyStatus.code === "circuit_open" ? "shield-alert" : dailyStatus.code === "aborted" ? "circle-x" : dailyStatus.code === "sending" ? "send" : dailyStatus.code === "drafting" ? "square-pen" : dailyStatus.code === "collecting" ? "contact-round" : "circle-check"}"></i></span>
            <span class="daily-status-copy"><strong>今日任务：${escapeHtml(collectionSource)}｜${escapeHtml(dailyStatus.label)}</strong><small>${escapeHtml(statusDetail || "状态已同步")}</small></span>
          </div>
          ${dailyMeter("building-2", "发件公司库存", inventoryCompanyCount, Number(state.inventory?.inventory?.target || collectionLimit), `昨日剩余 ${number(previousRemainingCompanies)} 家 + 今日新增 ${number(todayQualifiedCompanies)} 家；已扫描 ${number(scanUsed)} / ${number(scanLimit)} 家详情`)}
          ${quantityMetric("square-pen", "邮件草稿池", draftPoolRemaining)}
          ${dailyMeter("send", "今日邮件发送", sendUsed, sendLimit, deliveryEnabled() ? "受控通道已启用" : "发送保持锁定")}
          <section class="country-collection-summary" aria-label="国家关键词采集">
            <div class="country-collection-head"><strong>国家关键词采集</strong><span>${number(state.countryBusiness?.totalCompanies || 0)} 家去重公司</span></div>
            ${countryRows.length ? countryRows.join("") : `<div class="country-collection-empty">暂无国家关键词采集检查点</div>`}
          </section>
        </div>
      </section>
    </div>`;
}

function renderFoundation() {
  const s = state.summary;
  const q = state.quality || { metrics: {}, issues: [] };
  const topBuyers = state.buyers.items.slice(0, 8);
  return `
    <div class="view-stack">
      <section class="overview-section-head">
        <div><h2>业务底盘</h2><p>集中查看历史贸易样本、联系人质量与高价值买家。</p></div>
      </section>
      <section class="kpi-grid" aria-label="关键指标">
        ${kpi("circle-dollar-sign", "英文主体成交额", currency(s.supplierAmountUsd), `${number(s.supplierTradeCount)} 笔 · 最近 ${s.lastTradeDate}`)}
        ${kpi("building-2", "已验证买家", number(s.buyerCount), `前20覆盖金额 ${percent(s.top20CoveragePct)}`)}
        ${kpi("contact-round", "去重可联系对象", number(s.uniqueContacts), `${number(s.uniqueEmails)} 邮箱 · ${number(s.uniquePhones)} 电话`)}
        ${kpi("scan-search", "历史合格公司", `${number(s.managedHistoryQualifiedCompanies || 0)}`, `${number(s.managedHistoryQualifiedContacts || 0)} 个来源可追溯邮箱已进入托管池`)}
      </section>

      <section class="split-layout">
        <div class="panel">
          <div class="panel-head"><h3>高价值买家</h3><button class="button small" data-jump="buyers" type="button"><i data-lucide="arrow-right"></i>全部买家</button></div>
          <div class="mini-metrics">
            <div class="mini-metric"><span>前20成交额</span><strong>${currency(s.top20AmountUsd)}</strong></div>
            <div class="mini-metric"><span>原始联系人行</span><strong>${number(s.extractedContactRows)}</strong></div>
            <div class="mini-metric"><span>重复关联</span><strong>${number(s.duplicateLinks)}</strong></div>
            <div class="mini-metric"><span>低置信匹配</span><strong>${number(s.lowConfidence)}</strong></div>
            <div class="mini-metric"><span>质量问题</span><strong>${number(q.issues.length)}</strong></div>
          </div>
          <div class="table-shell">
            <table>
              <thead><tr><th>买家</th><th>国家</th><th class="number">成交额</th><th class="number">交易</th><th>补全</th><th class="number">联系人</th></tr></thead>
              <tbody>${topBuyers.map((item) => `
                <tr>
                  <td class="company-cell"><strong>${escapeHtml(item.buyer)}</strong><span>${escapeHtml(item.matchedCompany || "待匹配")}</span></td>
                  <td>${escapeHtml(item.country)}</td>
                  <td class="number">${currency(item.amountUsd)}</td>
                  <td class="number">${number(item.tradeCount)}</td>
                  <td>${badge(item.matchConfidence)}</td>
                  <td class="number">${number(item.accessibleContacts)}</td>
                </tr>`).join("")}</tbody>
            </table>
          </div>
        </div>

      </section>
    </div>`;
}

function kpi(icon, label, value, foot) {
  return `<article class="kpi-card"><div class="kpi-head"><span>${escapeHtml(label)}</span><span class="kpi-icon"><i data-lucide="${icon}"></i></span></div><div class="kpi-value">${value}</div><div class="kpi-foot">${escapeHtml(foot)}</div></article>`;
}

function risk(icon, heading, body) {
  return `<li class="risk-item"><span class="risk-icon"><i data-lucide="${icon}"></i></span><div><strong>${escapeHtml(heading)}</strong><p>${escapeHtml(body)}</p></div></li>`;
}

function renderWorkflow() {
  const progress = state.projectProgress;
  return `
    <div class="view-stack">
      <div class="section-header"><div><h2>端到端九阶段</h2><p>采集、正式域名前端、一键部署、两个域名及10个SMTP账号验收已收口；下一阶段是合规出站通道、自然反馈和更大规模联系人证据。</p></div><div class="section-actions"><span class="badge neutral">项目 ${number(progress.overall)}%</span>${badge("prototype")}</div></div>
      <section class="kpi-grid" aria-label="项目进度">
        ${kpi("chart-no-axes-column-increasing", "项目总进度", `${number(progress.overall)}%`, "按九阶段工程进度平均；不代表允许外发")}
        ${kpi("database-zap", "当前采集批次", `${number(progress.acquisition)}%`, "1,328/1,328家公司，pending 0，failed 0")}
        ${kpi("mail-check", "发件准备度", `${number(progress.sendingReadiness)}%`, "两个域名共10/10个SMTP账号已通过本机与服务器AUTH验收；真实发送仍锁定")}
        ${kpi("users-round", "去重人物联系人", "6,219", "来源于6,617条平台联系人记录")}
      </section>
      <section class="panel">
        <div class="workflow-list">
          ${state.workflow.map((item) => `
            <article class="workflow-row ${item.status}">
              <div class="stage-number">${item.order}</div>
              <div class="stage-title"><strong>${escapeHtml(item.name)}</strong><span>${badge(item.status)}</span></div>
              <div class="stage-output">${escapeHtml(item.output)}</div>
              <div><progress class="progress-track ${item.status === "blocked" ? "red" : item.progress < 100 ? "amber" : ""}" max="100" value="${item.progress}" aria-label="${escapeHtml(item.name)}进度"></progress><div class="kpi-foot">${item.progress}%</div></div>
            </article>`).join("")}
        </div>
      </section>
      <div class="callout"><i data-lucide="circle-stop"></i><div><strong>当前阻塞点：允许开发信的出站通道、自然反馈与联系人许可证据</strong><span>两个域名均已完成MX/SPF/DKIM/DMARC和10/10双端AUTH；阿里企业邮箱及阿里邮件推送均不能承载未经许可的开发信，真实发送仍保持关闭。</span></div></div>
    </div>`;
}

function selectOptions(items, selected, allLabel) {
  return `<option value="">${escapeHtml(allLabel)}</option>${items.map((item) => `<option value="${escapeHtml(item)}" ${item === selected ? "selected" : ""}>${escapeHtml(item)}</option>`).join("")}`;
}

function renderBuyers() {
  const result = state.buyers;
  return `
    <div class="view-stack">
      <div class="section-header"><div><h2>买家原始记录与补全状态</h2><p>保留139家原始报关买家，补全结果不会改写原名称。</p></div><div class="section-actions"><span class="badge neutral">${number(result.total)} 条</span></div></div>
      <section class="panel">
        <form class="toolbar" id="buyerFilterForm">
          <div class="field"><label for="buyerSearch">公司搜索</label><input class="input" id="buyerSearch" name="q" value="${escapeHtml(state.buyerFilters.q)}" placeholder="买家、匹配公司或官网" /></div>
          <div class="field"><label for="buyerCountry">国家/地区</label><select class="select" id="buyerCountry" name="country">${selectOptions(state.options.countries, state.buyerFilters.country, "全部国家")}</select></div>
          <div class="field"><label for="buyerConfidence">匹配置信度</label><select class="select" id="buyerConfidence" name="confidence">${selectOptions(state.options.confidences, state.buyerFilters.confidence, "全部置信度")}</select></div>
          <div class="field"><label for="buyerStatus">补全状态</label><select class="select" id="buyerStatus" name="status">${selectOptions(["已补全", "待补全"], state.buyerFilters.status, "全部状态")}</select></div>
          <button class="button primary" type="submit"><i data-lucide="search"></i>筛选</button>
        </form>
        <div class="table-shell">
          <table>
            <thead><tr><th>买家</th><th>国家</th><th class="number">成交额</th><th class="number">份额</th><th>最近交易</th><th class="number">次数</th><th>补全</th><th>匹配公司</th><th class="number">可联系</th></tr></thead>
            <tbody>${result.items.map((item) => `
              <tr>
                <td class="company-cell"><strong>${escapeHtml(item.buyer)}</strong><span>${item.buyerRank ? `金额排名 #${item.buyerRank}` : `原始序号 #${item.sourceIndex}`}</span></td>
                <td>${escapeHtml(item.country)}</td><td class="number">${currency(item.amountUsd)}</td><td class="number">${percent(item.sharePct)}</td>
                <td>${escapeHtml(item.lastTradeDate || "-")}</td><td class="number">${number(item.tradeCount)}</td><td>${badge(item.enrichmentStatus)}</td>
                <td class="company-cell"><strong>${escapeHtml(item.matchedCompany || "待补全")}</strong><span>${badge(item.matchConfidence)} ${item.website && item.website !== "-" ? `<a href="${escapeHtml(item.website)}" target="_blank" rel="noreferrer">官网</a>` : ""}</span></td>
                <td class="number">${number(item.accessibleContacts)}</td>
              </tr>`).join("")}</tbody>
          </table>
        </div>
        ${pagination("buyers", result)}
      </section>
    </div>`;
}

function renderContacts() {
  const result = state.contacts;
  const buyerNames = state.options.enrichedBuyers || [];
  const checkableCount = result.items.filter((item) => item.email && !item.suppressed).length;
  return `
    <div class="view-stack">
      <div class="section-header"><div><h2>去重联系人工作台</h2><p>网易可见联系人以邮箱格式、域名/MX、公司归属和去重结果作为基础有效标准；不再要求职位验证才能进入候选池。</p></div><div class="section-actions"><span class="badge neutral">${number(result.total)} 条匹配</span><button class="button" id="validatePageButton" type="button" ${checkableCount ? "" : "disabled"}><i data-lucide="scan-search"></i>检查本页 ${number(checkableCount)} 个邮箱</button></div></div>
      <section class="panel">
        <form class="toolbar contact-toolbar" id="contactFilterForm">
          <div class="field"><label for="contactSearch">联系人搜索</label><input class="input" id="contactSearch" name="q" value="${escapeHtml(state.contactFilters.q)}" placeholder="姓名、职位、公司或邮箱" /></div>
          <div class="field"><label for="contactBuyer">买家</label><select class="select" id="contactBuyer" name="buyer">${selectOptions(buyerNames, state.contactFilters.buyer, "当前页全部买家")}</select></div>
          <div class="field"><label for="contactPriority">角色优先级</label><select class="select" id="contactPriority" name="priority">${selectOptions(state.options.priorities, state.contactFilters.priority, "全部角色")}</select></div>
          <div class="field"><label for="contactConfidence">匹配置信度</label><select class="select" id="contactConfidence" name="confidence">${selectOptions(state.options.confidences, state.contactFilters.confidence, "全部置信度")}</select></div>
          <div class="field"><label for="contactValidation">邮箱状态</label><select class="select" id="contactValidation" name="validation">${selectOptions(["unverified", "syntax_valid", "domain_valid", "deliverable", "accept_all", "invalid", "opted_out"], state.contactFilters.validation, "全部状态")}</select></div>
          <button class="button primary" type="submit"><i data-lucide="list-filter"></i>筛选</button>
        </form>
        <div class="panel-head">
          <label class="check-row"><input id="emailOnlyToggle" type="checkbox" ${state.contactFilters.emailOnly ? "checked" : ""} />仅唯一邮箱</label>
          <div class="callout"><i data-lucide="badge-alert"></i><div><strong>${number(state.contactQuality.storedRecords)} 条本地验证 · ${number(state.suppressions.count)} 条永久抑制</strong><span>网易采集邮箱达到基础有效即可进入托管候选；系统仍自动执行格式、域名/MX、去重、抑制名单和反馈熔断。</span></div></div>
        </div>
        <div class="table-shell">
          <table>
            <thead><tr><th>联系人</th><th>角色</th><th>买家与国家</th><th>邮箱</th><th>验证</th><th>电话</th><th>LinkedIn</th><th>来源</th><th>匹配</th><th>操作</th></tr></thead>
            <tbody>${result.items.map((item) => `
              <tr>
                <td class="contact-cell"><strong>${escapeHtml(item.name || "公共联系方式")}</strong><span>${escapeHtml(item.title || "未标注职位")}</span></td>
                <td>${badge(item.priority.startsWith("A-") ? "高" : item.priority.startsWith("B-") ? "中高" : "未匹配")}<div class="kpi-foot">${escapeHtml(item.priority)}</div></td>
                <td class="company-cell"><strong>${escapeHtml(item.rawBuyerName)}</strong><span>${escapeHtml(item.country)} · ${currency(item.amountUsd)}</span></td>
                <td class="contact-cell"><strong>${escapeHtml(item.email || "-")}</strong><span>${item.validationCheckedAt ? `检查 ${shortDate(item.validationCheckedAt)}` : "未执行本地检查"}</span></td>
                <td title="${escapeHtml(item.validationEvidence || "")}">${item.email ? badge(item.validationStatus) : "-"}</td>
                <td>${escapeHtml(item.phone || "-")}</td>
                <td>${item.linkedin ? `<a class="button small" href="${escapeHtml(item.linkedin)}" target="_blank" rel="noreferrer"><i data-lucide="linkedin"></i>档案</a>` : "-"}</td>
                <td>${escapeHtml(item.source || "-")}</td><td>${badge(item.matchConfidence)}</td>
                <td><div class="row-actions">${item.email ? `<button class="icon-button" data-validate-email="${escapeHtml(item.email)}" title="执行本地格式与域名检查" aria-label="验证邮箱"><i data-lucide="shield-check"></i></button>${item.validationStatus !== "deliverable" && !item.suppressed ? `<button class="icon-button" data-manual-deliverable="${escapeHtml(item.email)}" title="录入人工可投递证据" aria-label="录入人工可投递证据"><i data-lucide="file-check-2"></i></button>` : ""}<button class="icon-button danger" data-suppress-email="${escapeHtml(item.email)}" title="加入永久抑制名单" aria-label="抑制邮箱"><i data-lucide="ban"></i></button>` : "-"}</div></td>
              </tr>`).join("")}</tbody>
          </table>
        </div>
        ${pagination("contacts", result)}
      </section>
    </div>`;
}

function pagination(kind, result) {
  return `<div class="pagination"><span>第 ${result.page}/${result.pages} 页 · 共 ${number(result.total)} 条</span><div class="pagination-actions"><button class="button small" data-page-kind="${kind}" data-page="${result.page - 1}" ${result.page <= 1 ? "disabled" : ""}><i data-lucide="chevron-left"></i>上一页</button><button class="button small" data-page-kind="${kind}" data-page="${result.page + 1}" ${result.page >= result.pages ? "disabled" : ""}>下一页<i data-lucide="chevron-right"></i></button></div></div>`;
}

function auditActionLabel(item) {
  const labels = {
    task_created: "任务创建",
    buyer_entry: "买家条目",
    company_search: "公司搜索",
    company_detail: "公司详情",
    contact_page: "联系人分页",
    raw_contact_row: "联系人行",
    checkpoint: "保存检查点",
    budget_rejected: "预算拒绝",
    human_recovery_confirmed: "人工恢复",
  };
  return labels[item.type] || item.type || "未知动作";
}

function auditCountLabel(item) {
  if (item.type === "budget_rejected") return `${number(item.requestedCount)}（当前 ${number(item.currentCount)} / 上限 ${number(item.budget)}）`;
  return item.count == null ? "-" : number(item.count);
}

function pipelineStageLabel(stage) {
  return {
    discovery: "HSCode检索",
    trade_normalization: "贸易记录标准化",
    buyer_matching: "采购商识别",
    contact_enrichment: "联系人补全",
    validation: "邮箱验证",
    drafting: "客制化起草",
    approval: "集中批次审核",
    sending: "受控发送",
    feedback: "反馈回写",
  }[stage] || stage || "-";
}

function aiRuntimeState() {
  const ai = state.health?.ai || {};
  if (!ai.configured) return { ready: false, status: "blocked", label: "未配置API密钥" };
  if (ai.reachable === false) return { ready: true, status: "blocked", label: `已配置但网络不可达${ai.lastError ? `：${ai.lastError}` : ""}` };
  if (ai.reachable === true) return { ready: true, status: "complete", label: `生产请求成功 · ${shortDateTime(ai.lastSuccessAt)}` };
  return { ready: true, status: "partial", label: "已配置，尚未完成生产连通验证" };
}

function renderOperations() {
  const tasks = state.operationTasks || [];
  const queues = state.contactQueues || [];
  const selectedQueue = queues.find((item) => item.id === state.selectedQueueId) || queues[0] || null;
  const queueCounts = selectedQueue?.counts || {};
  const activeBatch = state.activeCollectionBatch?.queueId === selectedQueue?.id ? state.activeCollectionBatch : null;
  const selected = tasks.find((item) => item.id === state.selectedTaskId) || tasks[0] || null;
  const selectedPipeline = state.pipeline.jobs.find((item) => item.operationTaskId === selected?.id) || null;
  const counters = selected?.counters || {};
  const budgets = selected?.budgets || {};
  const collectionUsed = Number(state.inventory?.inventory?.totalCompanies ?? state.dailyBatch?.selectedCompanyCount ?? counters.qualifiedCompanies ?? 0);
  const remaining = (used, limit) => Math.max(Number(limit || 0) - Number(used || 0), 0);
  return `
    <div class="view-stack">
      <div class="section-header"><div><h2>托管采集流水线、动作预算与熔断</h2><p>HSCode、Keyword、国家+业务范围三种 discovery 共用同一队列、阶段和检查点；草稿统一进入集中批次核验。</p></div><div class="section-actions">${state.dailyBatch?.selected?.length ? `<button class="button primary" id="centralBatchSendHeaderButton" type="button"><i data-lucide="send"></i>审核并发送今日批次（${number(state.dailyBatch.selected.length)}）</button>` : ""}<button class="button" id="validateBackupButton" type="button"><i data-lucide="file-check-2"></i>校验备份</button><button class="button" id="mergeBackupButton" type="button"><i data-lucide="history"></i>安全合并备份</button><button class="button" id="exportBackupButton" type="button"><i data-lucide="archive"></i>导出控制备份</button>${selected ? `<button class="button" id="exportTaskButton" type="button"><i data-lucide="file-down"></i>导出任务</button>${badge(selected.safetyState)}` : badge("READY")}</div></div>
      ${state.controlLoadErrors?.length ? `<div class="callout"><i data-lucide="triangle-alert"></i><div><strong>部分控制数据暂时未更新</strong><span>${escapeHtml(state.controlLoadErrors.join("；"))}；页面保留最近一次可用数据。</span></div></div>` : ""}
      <section class="panel"><div class="panel-head"><div><h3>公司资格筛选（当前关闭）</h3><p>当前保持 CompanyQualification disabled；国家+业务范围由 discovery 阶段完成定向，后续 pipeline 不增加额外淘汰。</p></div>${badge(state.companyQualification.enabled ? "complete" : "paused")}</div><form class="panel-body editor" id="companyQualificationForm"><label class="checkbox-line"><input type="checkbox" name="enabled" disabled ${state.companyQualification.enabled ? "checked" : ""}/>启用筛选</label><div class="form-grid"><div class="field"><label>目标国家（逗号分隔）</label><input class="input" name="targetCountries" value="${escapeHtml((state.companyQualification.targetCountries || []).join(", "))}" /></div><div class="field"><label>业务关键词（逗号分隔）</label><input class="input" name="businessKeywords" value="${escapeHtml((state.companyQualification.businessKeywords || []).join(", "))}" /></div><div class="field"><label>目标 HSCode（4-10 位，逗号分隔）</label><input class="input" name="targetHsCodes" value="${escapeHtml((state.companyQualification.targetHsCodes || []).join(", "))}" /></div><div class="field"><label>允许公司类型（逗号分隔）</label><input class="input" name="allowedCompanyTypes" value="${escapeHtml((state.companyQualification.allowedCompanyTypes || []).join(", "))}" /></div><div class="field"><label>最低评分（0-100）</label><input class="input" type="number" min="0" max="100" name="minimumScore" value="${number(state.companyQualification.minimumScore || 0)}" /></div></div><div class="field"><label>排除关键词（逗号分隔）</label><input class="input" name="excludeKeywords" value="${escapeHtml((state.companyQualification.excludeKeywords || []).join(", "))}" /></div><div class="budget-grid">${budgetMeter("已评分公司", state.companyQualification.statistics?.totalCompanies || 0, null, null)}${budgetMeter("通过", state.companyQualification.statistics?.passed || 0, null, null)}${budgetMeter("淘汰", state.companyQualification.statistics?.rejected || 0, null, null)}</div><div class="qualification-reasons"><strong>淘汰/通过原因统计</strong><div class="reason-list">${Object.entries(state.companyQualification.statistics?.reasons || {}).sort((a, b) => b[1] - a[1]).map(([reason, count]) => `<span class="badge neutral">${escapeHtml(reason)} · ${number(count)}</span>`).join("") || `<span class="muted">暂无新任务筛选结果</span>`}</div></div><div class="table-shell"><table><thead><tr><th>公司</th><th>国家</th><th>分数</th><th>结果</th><th>原因</th></tr></thead><tbody>${(state.companyQualification.statistics?.companies || []).map((item) => `<tr><td>${escapeHtml(item.company)}</td><td>${escapeHtml(item.country || "-")}</td><td>${number(item.score)}</td><td>${badge(item.passed ? "complete" : "blocked")}</td><td>${escapeHtml((item.reasons || []).join(", ") || "-")}</td></tr>`).join("") || `<tr><td colspan="5">暂无新任务筛选结果</td></tr>`}</tbody></table></div><button class="button primary" type="submit"><i data-lucide="save"></i>保存筛选规则</button></form></section>
      <section class="kpi-grid" aria-label="运行控制指标">
        ${kpi("list-tree", "本地任务", number(tasks.length), `${number(tasks.filter((item) => item.status === "active").length)} 个运行中`)}
        ${kpi("rows-3", "公司采集队列", number(queueCounts.total || 0), selectedQueue ? `${number(queueCounts.remaining || 0)} 待处理 · ${number(queueCounts.failed || 0)} 失败` : "尚未初始化")}
        ${kpi("workflow", "流水线队列", number(state.pipeline.jobs.length), `${number(state.pipeline.claimable)} 个可领取 · ${number(state.pipeline.counts?.batch_review || 0)} 个集中审核 · ${number(state.pipeline.counts?.waiting_input || 0)} 个待输入`)}
        ${kpi("mail-check", "本地验证", number(state.contactQuality.storedRecords), `${number(state.contactQuality.counts?.domain_valid || 0)} 个域名有效`)}
        ${kpi("ban", "永久抑制", number(state.suppressions.count), "退订、投诉、硬退信和手工禁联")}
        ${kpi("mailbox", "持久发件箱", number(state.outbox.items.length), `${number(state.outbox.counts?.accepted || 0)} 已接受 · ${number(state.outbox.counts?.uncertain || 0)} 待裁决`)}
      </section>

      <section class="panel capacity-panel"><div class="panel-head"><div><h3>容量与在线承载</h3><p>容量读取自服务器统一接口；调度仅支持 dry-run 计划。</p></div><span class="badge ${state.deliveryCapacity?.health === "healthy" ? "complete" : "blocked"}">${number(state.deliveryCapacity?.availableCapacity || 0)} 可用</span></div><div class="panel-body capacity-grid"><div><span>全局容量</span><strong>${number(state.deliveryCapacity?.globalLimit || 0)}</strong></div><div><span>账号池</span><strong>${number(state.deliveryCapacity?.accounts?.length || 0)} 个</strong></div><div><span>阻断账号</span><strong>${number((state.deliveryCapacity?.accounts || []).filter((item) => item.blockedReasons?.length).length)}</strong></div><div><span>今日计划容量</span><strong>${number(state.deliveryCapacity?.availableCapacity || 0)}</strong></div><small>${escapeHtml((state.deliveryCapacity?.blockedReasons || []).join("、") || "无阻断")}</small><hr/><div><span>PC 同时在线</span><strong>${number(state.capacity?.pc || 100)} 人</strong></div><div><span>移动端同时在线</span><strong>${number(state.capacity?.mobile || 100)} 人</strong></div></div></section>

      <section class="panel collection-queue-panel">
        <div class="panel-head"><div><h3>买家公司联系人队列</h3><p>${selectedQueue ? `${escapeHtml(selectedQueue.label)} · ${number(selectedQueue.progressPct)}%` : "Hung Hing 与 Amity 当前剩余公司"}</p></div><div class="section-actions">
          <button class="button primary" id="initializeCollectionButton" type="button"><i data-lucide="list-start"></i>${selectedQueue ? "同步清单" : "初始化队列"}</button>
          ${selectedQueue && ["ready", "running"].includes(selectedQueue.status) ? `<button class="button" id="claimCollectionButton" type="button" ${selectedQueue.activeBatchId ? "disabled" : ""}><i data-lucide="play"></i>领取下一批</button>` : ""}
          ${selectedQueue && ["ready"].includes(selectedQueue.status) ? `<button class="icon-button" id="pauseCollectionButton" type="button" title="暂停队列" aria-label="暂停队列"><i data-lucide="pause"></i></button>` : ""}
          ${selectedQueue && ["paused", "circuit_open"].includes(selectedQueue.status) ? `<button class="button ${selectedQueue.status === "circuit_open" ? "danger" : ""}" id="resumeCollectionButton" type="button"><i data-lucide="shield-check"></i>${selectedQueue.status === "circuit_open" ? "人工恢复" : "恢复队列"}</button>` : ""}
          ${selectedQueue ? `<button class="icon-button" id="exportCollectionBoundaryButton" type="button" title="导出错误边界" aria-label="导出错误边界"><i data-lucide="file-warning"></i></button>${badge(selectedQueue.status)}` : ""}
        </div></div>
        ${selectedQueue ? `<div class="panel-body queue-body">
          <div class="queue-progress"><div><strong>${number(queueCounts.processed)} / ${number(queueCounts.total)}</strong><span>已处理</span></div><progress class="progress-track ${selectedQueue.status === "circuit_open" ? "red" : ""}" max="100" value="${Math.min(Number(selectedQueue.progressPct || 0), 100)}" aria-label="联系人队列处理进度"></progress></div>
          <div class="budget-grid">
            ${budgetMeter("待处理", queueCounts.pending, null, null)}
            ${budgetMeter("已领取", queueCounts.leased, null, null)}
            ${budgetMeter("已完成", queueCounts.completed, null, null)}
            ${budgetMeter("失败", queueCounts.failed, null, null)}
            ${budgetMeter("联系人行", queueCounts.contactRows, null, null)}
          </div>
          <div class="queue-config-line"><span>单批 ${number(selectedQueue.config.batchSize)} 家</span><span>间隔 ${number(selectedQueue.config.minDelayMs / 1000)}-${number(selectedQueue.config.maxDelayMs / 1000)} 秒</span><span>单并发</span><span>最多重试 ${number(selectedQueue.config.maxAttempts)} 次</span><span>需已登录桌面网易会话</span></div>
          ${selectedQueue.lastBoundary ? `<div class="callout"><i data-lucide="triangle-alert"></i><div><strong>${escapeHtml(selectedQueue.lastBoundary.category)}</strong><span>${escapeHtml(selectedQueue.lastBoundary.signal)} · ${shortDateTime(selectedQueue.lastBoundary.at)}</span></div></div>` : ""}
          ${activeBatch ? `<div class="table-shell"><table><thead><tr><th>本批次公司</th><th>来源</th><th>尝试</th></tr></thead><tbody>${activeBatch.items.map((item) => `<tr><td>${escapeHtml(item.companyName)}</td><td>${escapeHtml(item.sourceIds.join(", "))}</td><td>${number(item.attempt)}</td></tr>`).join("")}</tbody></table></div>` : ""}
        </div>` : `<div class="panel-body">${emptyState("list-plus", "尚未建立公司队列", "初始化后会自动排除已经完成的20家公司，并保留全部剩余买家公司。")}</div>`}
      </section>

      <section class="split-layout ops-layout">
        <div class="panel">
          <div class="panel-head"><h3>创建冻结任务</h3><span class="badge neutral">HSCode主采集 · Keyword副采集 · 国家+业务范围第三采集</span></div>
          <form class="panel-body editor" id="opsTaskForm">
            <div class="form-grid"><div class="field"><label for="opsCollectionMode">采集方式</label><select class="select" id="opsCollectionMode" name="collectionMode"><option value="hscode" selected>HSCode主采集</option><option value="keyword">Keyword副采集</option><option value="country_business">国家+业务范围第三采集</option></select></div><div class="field"><label for="opsHsCode">HSCode</label><input class="input" id="opsHsCode" name="hsCode" inputmode="numeric" pattern="[0-9]{4,10}" value="4903000" required /></div></div>
            <div class="field" id="keywordField" hidden><label for="opsKeyword">Keyword关键词</label><input class="input" id="opsKeyword" name="keyword" maxlength="120" placeholder="例如 children activity books" /><small>副采集沿用同一队列、检查点、租约和熔断；HSCode仍是默认主入口。</small></div>
            <div class="field" id="countryBusinessField" hidden><label for="opsCountry">目标国家</label><input class="input" id="opsCountry" name="country" maxlength="80" placeholder="例如 Poland" /><label for="opsBusinessScope">业务范围关键词</label><input class="input" id="opsBusinessScope" name="businessScope" maxlength="500" placeholder="例如 board games, books, paper packaging" /><small>第三采集先按业务关键词检索，再只保留可见国家字段匹配 Poland 的公司；多个关键词用逗号分隔。</small></div>
            <div class="field"><label for="opsDirection">方向</label><select class="select" id="opsDirection" name="direction"><option value="buyer">采购商</option><option value="supplier">供应商</option></select></div>
            <div class="field" id="generalCountriesField"><label for="opsCountries">目标国家/地区（逗号分隔，可留空）</label><input class="input" id="opsCountries" name="countries" placeholder="United States, Mexico" /></div>
            <div class="form-grid"><div class="field"><label for="buyerBudget">买家条目/日</label><input class="input" id="buyerBudget" name="buyerBudget" type="number" min="1" max="2000" value="400" /></div><div class="field"><label for="detailBudget">公司详情扫描/日</label><input class="input" id="detailBudget" name="detailBudget" type="number" min="1" max="400" value="300" /></div></div>
            <div class="form-grid"><div class="field"><label for="validCompanyBudget">有效邮箱公司/日</label><input class="input" id="validCompanyBudget" name="validCompanyBudget" type="number" min="1" max="200" value="100" /></div><div class="field"><label for="contactsPerCompany">每家公司联系人</label><input class="input" id="contactsPerCompany" type="number" value="2" readonly /></div></div>
            <div class="form-grid"><div class="field"><label for="contactPageBudget">联系人分页动作/日</label><input class="input" id="contactPageBudget" name="contactPageBudget" type="number" min="1" max="300" value="200" /></div><div class="field"><label for="emailSendBudget">邮件发送/日</label><input class="input" id="emailSendBudget" name="emailSendBudget" type="number" min="1" max="1000" value="500" /></div></div>
            <div class="field"><label for="opsAutomation">执行方式</label><select class="select" id="opsAutomation" name="automation"><option value="managed" selected>计划级托管</option><option value="supervised">逐批人工批准</option></select><small>托管目标为每日100家基础有效邮箱公司，每家公司最多2位联系人；容量由统一服务计算，格式、域名、去重、抑制名单、反馈熔断仍保持强制。</small></div>
            <button class="button primary" type="submit"><i data-lucide="plus"></i>创建任务</button>
          </form>
        </div>

        <div class="panel">
          <div class="panel-head"><h3>本地任务</h3><span class="badge neutral">${number(tasks.length)} 个</span></div>
          <div class="task-list">${tasks.length ? tasks.map((task) => `
            <button class="task-row ${task.id === selected?.id ? "active" : ""}" data-select-task="${escapeHtml(task.id)}" type="button">
              <span><strong>${escapeHtml(task.collectionMode === "keyword" ? task.keyword : task.collectionMode === "country_business" ? `${task.country}: ${(task.businessKeywords || []).join(", ")}` : task.hsCode)}</strong><small>${task.collectionMode === "keyword" ? "Keyword副采集" : task.collectionMode === "country_business" ? "国家+业务范围第三采集" : "HSCode主采集"} · ${task.direction === "buyer" ? "采购商" : "供应商"} · ${task.automation?.mode === "managed" ? "计划托管" : "人工逐批"} · ${escapeHtml(task.countries.join(", ") || "全部地区")}</small></span>
              <span>${badge(task.safetyState)}<small>${escapeHtml(task.counters.businessDate)}</small></span>
            </button>`).join("") : emptyState("list-plus", "暂无任务", "先创建一个只使用HSCode的冻结任务。")}</div>
        </div>
      </section>

      ${selectedPipeline ? `<section class="panel pipeline-panel">
        <div class="panel-head"><div><h3>端到端流水线</h3><p>${escapeHtml(selectedPipeline.id)} · 当前：${escapeHtml(pipelineStageLabel(selectedPipeline.currentStage))}</p></div>${badge(selectedPipeline.status)}</div>
        <div class="panel-body pipeline-body">
          <div class="pipeline-stages">${state.pipeline.stages.map((stage, index) => {
            const stageState = selectedPipeline.stages?.[stage]?.status || "pending";
            return `<div class="pipeline-stage ${escapeHtml(stageState)}"><span>${index + 1}</span><div><strong>${escapeHtml(pipelineStageLabel(stage))}</strong><small>${escapeHtml(stageState)}</small></div></div>`;
          }).join("")}</div>
          ${selectedPipeline.requiredInput ? `<div class="callout"><i data-lucide="${selectedPipeline.status === "batch_review" ? "clipboard-check" : "log-in"}"></i><div><strong>${selectedPipeline.status === "batch_review" ? "集中批次核验" : "需要人工输入"}</strong><span>${escapeHtml(selectedPipeline.requiredInput)}</span></div></div>` : ""}
          <div class="action-strip">
            ${selectedPipeline.status === "batch_review" ? `<button class="button primary" id="centralBatchSendButton" type="button"><i data-lucide="send"></i>审核并发送今日批次${state.dailyBatch?.selected?.length ? `（${number(state.dailyBatch.selected.length)}）` : ""}</button>` : ""}
            ${["waiting_input", "paused"].includes(selectedPipeline.status) ? `<button class="button primary" id="resumePipelineButton" type="button"><i data-lucide="file-input"></i>登记输入并排队</button>` : ""}
            ${selectedPipeline.status === "circuit_open" ? `<button class="button danger" id="recoverPipelineButton" type="button"><i data-lucide="shield-check"></i>人工确认恢复</button>` : ""}
          </div>
          <p class="pipeline-note">服务器可以长期保存阶段、租约、产物引用和熔断状态；没有网易会话或结果文件时不会继续执行，也不会绕过验证码、权限或付费限制。</p>
        </div>
      </section>` : ""}

      ${selected ? `<section class="panel">
        <div class="panel-head"><div><h3>${escapeHtml(selected.collectionMode === "country_business" ? `${selected.country}: ${(selected.businessKeywords || []).join(", ")}` : selected.collectionMode === "keyword" ? selected.keyword : selected.hsCode)} 运行面板</h3><p>${escapeHtml(selected.id)}</p></div><div>${badge(selected.safetyState)}</div></div>
        <div class="panel-body">
          <div class="budget-grid">
            ${budgetMeter("买家条目", counters.buyerEntries, budgets.buyerEntriesDaily, remaining(counters.buyerEntries, budgets.buyerEntriesDaily))}
            ${budgetMeter("公司搜索", counters.companySearches, null, null)}
            ${budgetMeter("公司详情扫描", counters.companyDetails, budgets.companyDetailsDaily, remaining(counters.companyDetails, budgets.companyDetailsDaily))}
            ${budgetMeter("可发送公司库存", collectionUsed, budgets.validEmailCompaniesDaily, remaining(collectionUsed, budgets.validEmailCompaniesDaily))}
            ${budgetMeter("联系人分页", counters.contactPages, budgets.contactPagesDaily, remaining(counters.contactPages, budgets.contactPagesDaily))}
          ${budgetMeter("邮件发送", state.health?.delivery?.daily?.used || 0, Number(state.deliveryCapacity?.globalLimit || 0), Number(state.deliveryCapacity?.globalRemaining || 0))}
            ${budgetMeter("原始联系人行", counters.rawContactRows, null, null)}
          </div>
          <form class="ops-action-form" id="opsActionForm">
            <div class="form-grid"><div class="field"><label for="opsSignal">页面/安全信号</label><select class="select" id="opsSignal"><option value="none">正常</option><option value="captcha">验证码</option><option value="frequent_operation">操作频繁</option><option value="permission">权限提示</option><option value="http_403">HTTP 403</option><option value="http_429">HTTP 429</option><option value="structure_error">结构异常</option><option value="duplicate_page">重复页</option><option value="page_stuck">页码不前进</option></select></div><div class="field"><label for="opsCount">本次计数</label><input class="input" id="opsCount" type="number" min="1" max="500" value="1" /></div></div>
            <div class="form-grid"><div class="field"><label for="checkpointCompany">检查点公司</label><input class="input" id="checkpointCompany" value="${escapeHtml(selected.checkpoint?.company || "")}" /></div><div class="field"><label for="checkpointPage">当前页码</label><input class="input" id="checkpointPage" type="number" min="0" value="${Number(selected.checkpoint?.page || 0)}" /></div></div>
            <div class="field"><label for="checkpointNote">检查点备注</label><input class="input" id="checkpointNote" value="${escapeHtml(selected.checkpoint?.note || "")}" placeholder="结果数已稳定、字段正常、无保护提示" /></div>
            <div class="action-strip">
              <button class="button" data-op-action="buyer_entry" type="button"><i data-lucide="building-2"></i>买家条目</button>
              <button class="button" data-op-action="company_search" type="button"><i data-lucide="search"></i>公司搜索</button>
              <button class="button" data-op-action="company_detail" type="button"><i data-lucide="panel-top-open"></i>公司详情</button>
              <button class="button" data-op-action="contact_page" type="button"><i data-lucide="book-open"></i>联系人分页</button>
              <button class="button" data-op-action="raw_contact_row" type="button"><i data-lucide="contact-round"></i>联系人行</button>
              <button class="button" data-op-action="checkpoint" type="button"><i data-lucide="save"></i>仅保存检查点</button>
              ${selected.safetyState === "CIRCUIT_OPEN" ? `<button class="button danger" id="recoverTaskButton" type="button"><i data-lucide="shield-check"></i>人工恢复</button>` : ""}
            </div>
          </form>
          <div class="callout"><i data-lucide="circle-stop"></i><div><strong>自动停止规则</strong><span>验证码、操作频繁、权限提示、403/429立即熔断；连续3次结构/分页异常熔断；任何动作超预算拒绝写入。</span></div></div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head"><h3>最近任务审计</h3><span class="badge neutral">显示 ${number(Math.min(selected.audit?.length || 0, 20))} / ${number(selected.audit?.length || 0)} 条</span></div>
        <div class="table-shell"><table><thead><tr><th>时间</th><th>动作</th><th>数量</th><th>安全信号</th><th>结果状态</th></tr></thead><tbody>${(selected.audit || []).slice(0, 20).map((item) => `<tr><td>${escapeHtml(shortDateTime(item.at))}</td><td>${escapeHtml(auditActionLabel(item))}</td><td>${escapeHtml(auditCountLabel(item))}</td><td>${escapeHtml(item.signal || "-")}</td><td>${badge(item.safetyState || "-")}</td></tr>`).join("") || `<tr><td colspan="5">暂无审计记录</td></tr>`}</tbody></table></div>
      </section>` : ""}

      <section class="split-layout ops-layout">
        <div class="panel"><div class="panel-head"><h3>永久抑制名单</h3><span class="badge blocked">不可自动删除</span></div><form class="panel-body editor" id="suppressionForm"><div class="field"><label for="suppressionEmail">邮箱</label><input class="input" id="suppressionEmail" type="email" required /></div><div class="form-grid"><div class="field"><label for="suppressionReason">原因</label><select class="select" id="suppressionReason"><option value="opted_out">退订</option><option value="complaint">投诉</option><option value="hard_bounce">硬退信</option><option value="do_not_contact">明确拒绝联系</option><option value="manual">人工抑制</option></select></div><div class="field"><label for="suppressionSource">证据来源</label><input class="input" id="suppressionSource" value="local-admin" required /></div></div><button class="button danger" type="submit"><i data-lucide="ban"></i>加入永久抑制</button></form></div>
        <div class="panel"><div class="panel-head"><h3>最近抑制记录</h3><span class="badge neutral">只显示哈希前缀</span></div><div class="table-shell"><table><thead><tr><th>指纹</th><th>域名</th><th>原因</th><th>日期</th></tr></thead><tbody>${state.suppressions.items.slice(0, 10).map((item) => `<tr><td><code>${escapeHtml(item.fingerprint)}</code></td><td>${escapeHtml(item.domain)}</td><td>${escapeHtml(item.reason)}</td><td>${shortDate(item.createdAt)}</td></tr>`).join("") || `<tr><td colspan="4">暂无抑制记录</td></tr>`}</tbody></table></div></div>
      </section>
    </div>`;
}

function budgetMeter(label, used, limit, remaining) {
  const ratio = limit ? Math.min((Number(used || 0) / Number(limit)) * 100, 100) : 0;
  return `<article class="budget-card"><span>${escapeHtml(label)}</span><strong>${number(used)}${limit ? ` / ${number(limit)}` : ""}</strong>${limit ? `<progress class="progress-track ${ratio >= 100 ? "red" : ratio >= 75 ? "amber" : ""}" max="100" value="${ratio}" aria-label="${escapeHtml(label)}使用进度"></progress><small>剩余 ${number(remaining)}</small>` : `<small>仅计数，不设独立上限</small>`}</article>`;
}

function renderEmailClaims() {
  return (state.options.emailClaims || []).map((claim) => `
    <label class="claim-option">
      <input type="checkbox" name="approvedClaim" value="${escapeHtml(claim.id)}" />
      <span><strong>${escapeHtml(claim.label)}</strong><small>只有已核实且允许对外使用时才勾选</small></span>
    </label>`).join("");
}

function renderEmailAssets() {
  return (state.options.emailAssets || []).map((asset) => `
    <label class="asset-option">
      <input type="checkbox" name="emailAsset" value="${escapeHtml(asset.id)}" />
      <img src="${escapeHtml(asset.url)}" alt="${escapeHtml(asset.label)}" loading="lazy" />
      <span>${escapeHtml(asset.label)}</span>
    </label>`).join("");
}

function selectedValues(name) {
  return [...document.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => input.value);
}

function syncScenarioControls() {
  const select = document.getElementById("draftScenario");
  if (!select) return;
  const scenario = (state.options.emailScenarios || []).find((item) => item.id === select.value);
  if (!scenario) return;
  const note = document.getElementById("scenarioNote");
  if (note) note.textContent = `${scenario.name}建议 ${scenario.wordRange[0]}-${scenario.wordRange[1]} 词，最多 ${scenario.maxAssets} 张配图。`;
  const selected = [...document.querySelectorAll('input[name="emailAsset"]:checked')];
  selected.slice(scenario.maxAssets).forEach((input) => { input.checked = false; });
  document.querySelectorAll('input[name="emailAsset"]').forEach((input) => {
    input.disabled = !input.checked && selectedValues("emailAsset").length >= scenario.maxAssets;
  });
}

function syncCandidateScenarioControls() {
  const selected = selectedValues("draftCandidateScenario");
  document.querySelectorAll('input[name="draftCandidateScenario"]').forEach((input) => {
    input.disabled = !input.checked && selected.length >= 3;
  });
}

function renderDraftCandidates() {
  if (!state.draftCandidates.length) return "";
  const scenarioNames = new Map((state.options.emailScenarios || []).map((item) => [item.id, item.name]));
  return `<div class="preview-list">${state.draftCandidates.map((draft, index) => `<article class="preview-item"><div class="preview-meta"><span>${escapeHtml(scenarioNames.get(draft.scenario) || draft.scenario)}</span><span>${number(draft.wordCount)} words</span></div><div class="preview-subject">${escapeHtml(draft.subject)}</div><div class="preview-body">${escapeHtml(draft.body)}</div><button class="button small" type="button" data-use-draft="${index}"><i data-lucide="check"></i>采用此草稿</button></article>`).join("")}</div>`;
}

function renderCampaigns() {
  const campaigns = state.campaigns;
  const senderProfile = state.senderProfile || {};
  const aiRuntime = aiRuntimeState();
  const aiReady = aiRuntime.ready;
  const deliveryReady = deliveryEnabled();
  const deliveryCircuit = state.health?.delivery?.circuit || {};
  const deliveryStatus = deliveryCircuit.open
    ? `发送熔断已开启：${deliveryCircuit.reason || "未知原因"}`
    : `SMTP发送${deliveryReady ? "已启用" : "保持锁定"}`;
  return `
    <div class="view-stack">
      <div class="callout"><i data-lucide="${deliveryReady ? "shield-check" : "lock-keyhole"}"></i><div><strong>AI：${escapeHtml(aiRuntime.label)}；${escapeHtml(deliveryStatus)}</strong><span>模型只生成草稿；保存、预览、审核和发送分开执行。发送批次上限 ${number(state.health?.delivery?.batchLimit || 5)} 封，间隔 ${number(state.health?.delivery?.delayMs || 2000)} 毫秒。</span></div></div>
      <section class="campaign-layout">
        <div class="panel">
          <div class="panel-head"><h3>活动草稿与审核队列</h3><span class="badge neutral">${campaigns.length} 个活动</span></div>
          <div class="campaign-list">
            ${campaigns.length ? campaigns.map((item) => `
              <article class="campaign-row">
                <div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.subject || "未填写主题")} · 更新 ${shortDate(item.updatedAt)}</small></div>
                <div><strong>${number(item.estimatedRecipients)}</strong><small>${number(item.sendableRecipients)} 个可发送</small></div>
                <div>${badge(item.status)}</div>
                <div class="campaign-actions">
                  <button class="icon-button" data-preview-campaign="${item.id}" title="生成预览" aria-label="生成预览"><i data-lucide="eye"></i></button>
                  ${!["partially_sent", "sent"].includes(item.status) ? `<button class="icon-button" data-edit-campaign="${item.id}" title="编辑并退回草稿" aria-label="编辑并退回草稿"><i data-lucide="pencil"></i></button>` : ""}
                  ${item.status === "draft" ? `<button class="icon-button" data-review-campaign="${item.id}" title="提交审核" aria-label="提交审核"><i data-lucide="clipboard-check"></i></button>` : ""}
                  ${item.status === "review" ? `<button class="icon-button" data-approve-campaign="${item.id}" title="批准活动" aria-label="批准活动"><i data-lucide="shield-check"></i></button>` : ""}
                  ${item.status === "review" ? `<button class="icon-button" data-schedule-campaign="${item.id}" title="模拟排期" aria-label="模拟排期"><i data-lucide="calendar-clock"></i></button>` : ""}
                  ${deliveryReady && ["approved", "partially_sent"].includes(item.status) ? `<button class="icon-button" data-send-campaign="${item.id}" title="发送下一安全批次" aria-label="发送下一安全批次"><i data-lucide="send"></i></button>` : ""}
                </div>
              </article>`).join("") : emptyState("mail-open", "暂无活动", "右侧保存第一个本地邮件草稿。")}
          </div>
        </div>

        <div class="panel">
          <div class="panel-head"><h3 id="campaignEditorTitle">新建邮件草稿</h3>${badge("draft")}</div>
          <form class="panel-body editor" id="campaignForm">
            <section class="ai-builder" aria-labelledby="aiBuilderTitle">
              <div class="ai-builder-head"><div><h4 id="aiBuilderTitle">场景化 GPT-5.6 邮件起草</h4><p>HSCode只用于内部产品匹配；正文不暴露海关数据来源。所有高风险卖点和配图均需人工批准。</p></div>${badge(aiRuntime.status)}</div>
              <div class="form-grid">
                <div class="field"><label for="draftScenario">邮件场景</label><select class="select" id="draftScenario">${(state.options.emailScenarios || []).map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("")}</select></div>
                <div class="field"><label for="hsCode">HSCode（仅内部匹配）</label><input class="input" id="hsCode" value="4903000" required /></div>
              </div>
              <div class="scenario-note" id="scenarioNote">首次开发信建议 80-130 词，默认不带图，最多 1 张。</div>
              <div class="field"><label>候选输出类型（可选1-3种）</label><div class="check-grid">${(state.options.emailScenarios || []).map((item, index) => `<label class="check-row"><input type="checkbox" name="draftCandidateScenario" value="${escapeHtml(item.id)}" ${index < 2 ? "checked" : ""} />${escapeHtml(item.name)}</label>`).join("")}</div></div>
              <div class="form-grid">
                <div class="field"><label for="buyerCompany">买家公司</label><input class="input" id="buyerCompany" value="{{company}}" /></div>
                <div class="field"><label for="contactName">联系人</label><input class="input" id="contactName" value="{{first_name}}" /></div>
              </div>
              <div class="field"><label for="contactRole">联系人岗位</label><input class="input" id="contactRole" placeholder="e.g. Logistics Manager / Procurement Director" /></div>
              <div class="field"><label for="productFocus">HSCode对应产品方向</label><textarea class="textarea compact" id="productFocus" required>Children's picture, drawing, coloring and activity books; hardcover or paperback formats and related finishing.</textarea></div>
              <div class="field"><label for="tradeContent">已核实的采购商业务证据</label><textarea class="textarea compact" id="tradeContent" required>The buyer publishes or sources children's activity and coloring books.</textarea></div>
              <div class="field"><label for="companyBusiness">我方业务与可提供能力</label><textarea class="textarea compact" id="companyBusiness" required>DaKings Cultural and Creative Co., Ltd provides book printing, binding, packaging, and post-press finishing services in China.</textarea></div>

              <details class="brief-details">
                <summary>展会/拜访资料（仅展会场景必填）</summary>
                <div class="event-fields">
                  <div class="form-grid">
                    <div class="field"><label for="eventName">展会名称</label><input class="input" id="eventName" /></div>
                    <div class="field"><label for="eventDates">日期</label><input class="input" id="eventDates" placeholder="June 23-25, 2026" /></div>
                  </div>
                  <div class="form-grid">
                    <div class="field"><label for="eventBooth">展位号</label><input class="input" id="eventBooth" /></div>
                    <div class="field"><label for="meetingLocation">备选约见地点</label><input class="input" id="meetingLocation" /></div>
                  </div>
                  <div class="field"><label for="eventAddress">展馆详细地址</label><input class="input" id="eventAddress" /></div>
                </div>
              </details>

              <details class="brief-details">
                <summary>受控卖点批准（默认全不勾选）</summary>
                <div class="claim-grid">${renderEmailClaims()}</div>
              </details>

              <div class="field">
                <label>可选配图（首次触达最多1张，展会场景最多2张）</label>
                <div class="asset-grid">${renderEmailAssets()}</div>
                <div class="form-grid image-upload-row"><div class="field"><label for="emailAssetUpload">添加本地图片</label><input class="input" id="emailAssetUpload" type="file" accept="image/jpeg,image/png,image/webp" multiple /></div><div class="field"><label for="emailAssetLabel">图片标签</label><input class="input" id="emailAssetLabel" placeholder="例如：本地作品图" /></div></div>
              </div>
              <label class="check-row"><input id="assetRightsConfirmed" type="checkbox" />已确认所选图片属于我方且允许对该收件人使用</label>
              <div class="form-grid">
                <div class="field"><label for="senderCompany">第一轮发件公司</label><input class="input" id="senderCompany" value="${escapeHtml(senderProfile.companyDisplayName || "")}" readonly /></div>
                <div class="field"><label>身份策略</label><div class="static-field">公司名义 · 公司邮箱收件 · 不使用员工个人信息</div></div>
              </div>
              <div class="form-grid">
                <div class="field"><label for="draftTone">语气</label><select class="select" id="draftTone"><option value="concise and professional">简洁专业</option><option value="warm and consultative">温和顾问式</option><option value="direct and practical">直接务实</option></select></div>
                <div class="field"><label>生成约束</label><div class="static-field">单一CTA · 不写虚假熟络 · 不暴露数据来源</div></div>
              </div>
              <div class="ai-builder-actions"><button class="button primary" id="aiDraftButton" type="button" ${aiReady ? "" : "disabled"}><i data-lucide="wand-sparkles"></i>生成候选草稿</button><button class="button" id="aiBatchDraftButton" type="button" ${aiReady ? "" : "disabled"}><i data-lucide="layers-3"></i>批量生成草稿</button><span id="aiDraftStatus">${escapeHtml(aiRuntime.label)}</span></div>
              <div id="draftCandidates">${renderDraftCandidates()}</div>
            </section>
            <div class="field"><label for="campaignName">活动名称</label><input class="input" id="campaignName" name="name" value="Mexico publishing buyers - pilot" required /></div>
            <div class="field"><label for="campaignSubject">邮件主题</label><input class="input" id="campaignSubject" name="subject" value="Printing support for {{company}}" required /></div>
            <div class="variable-bar">${state.options.variables.map((item) => `<button class="token" type="button" data-token="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join("")}</div>
            <div class="field"><label for="campaignBody">正文</label><textarea class="textarea" id="campaignBody" name="body" required>Hi {{first_name}},

DaKings Cultural and Creative Co., Ltd supports children's picture, activity, and coloring book projects from Guangzhou. {{company}}'s publishing work appears relevant to our printing, binding, packaging, and post-press finishing capabilities.

For an upcoming title, we can quote against the exact trim size, page count, paper, binding, finishing, pack-out and delivery requirements. This gives your team a clear specification-based comparison without a long back-and-forth.

Would you be open to sharing one current specification or RFQ for review? If another colleague manages print sourcing, I would appreciate an introduction.

Best regards,
DaKings Printing Company</textarea></div>
            <div class="form-grid">
              <div class="field"><label for="campaignCountry">目标国家</label><select class="select" id="campaignCountry"><option value="">全部国家</option><option value="Mexico" selected>Mexico</option><option value="United States">United States</option><option value="Bolivia">Bolivia</option><option value="Brazil">Brazil</option><option value="Colombia">Colombia</option></select></div>
              <div class="field"><label for="campaignPriority">联系人角色</label><select class="select" id="campaignPriority"><option value="">全部角色</option>${state.options.priorities.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join("")}</select></div>
            </div>
            <div class="check-grid">
              <label class="check-row"><input id="highConfidenceOnly" type="checkbox" checked />排除低置信匹配</label>
              <label class="check-row"><input id="suppressionChecked" type="checkbox" />已检查抑制名单</label>
              <label class="check-row"><input id="unsubscribeConfigured" type="checkbox" />已配置退订</label>
              <label class="check-row"><input id="senderDomainVerified" type="checkbox" />发件域名已验证</label>
              <label class="check-row"><input id="physicalAddressConfigured" type="checkbox" />已配置实体地址</label>
              <label class="check-row"><input id="sendWithImages" type="checkbox" />允许此批次发送配图邮件</label>
            </div>
            <div class="form-grid"><div class="field"><label for="batchTargetCount">批量起草数量</label><input class="input" id="batchTargetCount" type="number" min="1" max="200" value="20" /></div><div class="field"><label for="batchImageMode">批量配图策略</label><select class="select" id="batchImageMode"><option value="selected">使用所选图片</option><option value="none">不添加图片</option></select></div></div>
            <div class="form-actions"><button class="button primary" id="saveCampaignButton" type="submit"><i data-lucide="save"></i>保存草稿</button><button class="button" id="cancelCampaignEdit" type="button" hidden>取消编辑</button></div>
          </form>
        </div>
      </section>
      ${renderCampaignPreview()}
    </div>`;
}

function renderCampaignPreview() {
  const preview = state.campaignPreview;
  if (!preview) return "";
  const errors = preview.contentErrors || [];
  const assets = preview.assets || [];
  return `<section class="panel"><div class="panel-head"><h3>个性化预览</h3><span class="badge neutral">预计 ${number(preview.estimatedRecipients)} 个候选邮箱</span></div><div class="panel-body preview-stack"><div class="callout"><i data-lucide="triangle-alert"></i><div><strong>预览不代表可发送</strong><span>${escapeHtml(preview.warning)}</span></div></div>${errors.length ? `<div class="content-errors"><strong>内容门槛未通过</strong><ul>${errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul></div>` : `<div class="content-pass"><i data-lucide="circle-check"></i><span>内容、字数、声明和配图门槛已通过</span></div>`}${assets.length ? `<div class="preview-assets">${assets.map((asset) => `<figure><img src="${escapeHtml(asset.url)}" alt="${escapeHtml(asset.label)}" /><figcaption>${escapeHtml(asset.label)}</figcaption></figure>`).join("")}</div>` : ""}<div class="preview-list">${preview.items.map((item) => `<article class="preview-item"><div class="preview-meta"><span>${escapeHtml(item.recipient.name || "公共邮箱")} · ${escapeHtml(item.recipient.company)}</span><span>${escapeHtml(item.recipient.email)} · ${number(item.wordCount)} words</span></div><div class="preview-subject">${escapeHtml(item.subject)}</div><div class="preview-body">${escapeHtml(item.body)}</div></article>`).join("")}</div></div></section>`;
}

function renderSenderProfile() {
  const profile = state.senderProfile || {};
  const readiness = profile.readiness || { readyForCanary: false, missingFields: [], placeholderFields: [], hasPlaceholders: true };
  const ready = Boolean(readiness.readyForCanary);
  const effective = profile.effective || {};
  const issues = [...(readiness.missingFields || []), ...(readiness.placeholderFields || []).map((item) => `${item}仍为占位符`)];
  const value = (key) => escapeHtml(profile[key] || "");
  return `
    <div class="view-stack sender-profile-view">
      <section class="profile-status ${ready ? "ready" : "locked"}">
        <div class="profile-status-icon"><i data-lucide="${ready ? "shield-check" : "lock-keyhole"}"></i></div>
        <div><strong>${ready ? "发件身份可用于金丝雀测试" : "占位配置已启用，真实发送保持锁定"}</strong><p>${ready ? "必填身份、Reply-To 和退订地址均已通过格式检查。" : "可以继续生成和保存草稿，但任何占位符都不能通过真实发送门槛。"}</p></div>
        ${badge(ready ? "complete" : "blocked")}
      </section>

      <section class="sender-profile-layout">
        <div class="panel">
          <div class="panel-head"><h3>对外发件身份</h3><span class="profile-save-state">${profile.updatedAt ? `更新于 ${escapeHtml(shortDateTime(profile.updatedAt))}` : "尚未填写真实资料"}</span></div>
          <form class="panel-body sender-profile-form" id="senderProfileForm">
            <div class="form-grid">
              <div class="field"><label for="profileCompanyDisplayName">对外公司名 *</label><input class="input" id="profileCompanyDisplayName" name="companyDisplayName" value="${value("companyDisplayName")}" required /></div>
              <div class="field"><label for="profileCompanyLegalName">英文对外公司名 *</label><input class="input" id="profileCompanyLegalName" name="companyLegalName" value="${value("companyLegalName")}" required /></div>
              <div class="field"><label for="profileSenderEmail">公司发件邮箱 *</label><input class="input" id="profileSenderEmail" name="senderEmail" type="email" value="${value("senderEmail")}" required /></div>
              <div class="field"><label for="profileReplyTo">公司 Reply-To *</label><input class="input" id="profileReplyTo" name="replyTo" type="email" value="${value("replyTo")}" required /></div>
              <div class="field"><label for="profilePhone">公司电话</label><input class="input" id="profilePhone" name="phone" value="${value("phone")}" /></div>
              <div class="field"><label for="profileWebsite">公司网站</label><input class="input" id="profileWebsite" name="website" value="${value("website")}" /></div>
            </div>
            <div class="static-field"><i data-lucide="landmark"></i>中文项目主体：${value("companyLegalNameZh")} · 统一社会信用代码：${value("unifiedSocialCreditCode") || "待补充"} · 状态：${value("legalIdentityStatus") || "待确认"}</div>
            <div class="static-field"><i data-lucide="building-2"></i>第一轮统一以公司名义发出，不使用员工姓名、职位或个人签名；回复统一进入公司邮箱。</div>
            <div class="field"><label for="profilePhysicalAddress">完整实体地址 *</label><textarea class="textarea compact" id="profilePhysicalAddress" name="physicalAddress" required>${value("physicalAddress")}</textarea></div>

            <div class="form-divider"><span>退订策略</span></div>
            <div class="form-grid">
              <div class="field"><label for="profileUnsubscribeMode">处理方式</label><select class="select" id="profileUnsubscribeMode" name="unsubscribeMode"><option value="reply_only" ${profile.unsubscribeMode === "reply_only" ? "selected" : ""}>回复公司邮箱退订（当前策略）</option><option value="hosted_link_and_reply" ${profile.unsubscribeMode === "hosted_link_and_reply" ? "selected" : ""}>唯一链接 + 回复公司邮箱（后续）</option><option value="hosted_link" ${profile.unsubscribeMode === "hosted_link" ? "selected" : ""}>仅唯一链接（后续）</option></select></div>
              <div class="field"><label for="profileUnsubscribeMailbox">公司退订邮箱 *</label><input class="input" id="profileUnsubscribeMailbox" name="unsubscribeReplyMailbox" type="email" value="${value("unsubscribeReplyMailbox")}" required /></div>
            </div>
            <div class="field"><label for="profileUnsubscribeUrl">后续 HTTPS 退订地址（可选）</label><input class="input" id="profileUnsubscribeUrl" name="unsubscribeBaseUrl" value="${value("unsubscribeBaseUrl")}" placeholder="启用唯一链接模式时再填写" /></div>
            <input type="hidden" name="updatedBy" value="local-admin" />
            <div class="form-actions"><button class="button primary" id="saveSenderProfileButton" type="submit"><i data-lucide="save"></i>保存发件配置</button><span>敏感的 SMTP 密码不会写入此页面。</span></div>
          </form>
        </div>

        <aside class="sender-profile-aside">
          <section class="panel">
            <div class="panel-head"><h3>发送门槛</h3>${badge(ready ? "complete" : "blocked")}</div>
            <div class="panel-body">
              ${issues.length ? `<ul class="profile-checklist">${issues.map((item) => `<li class="issue"><i data-lucide="circle-alert"></i><span>${escapeHtml(item)}</span></li>`).join("")}</ul>` : `<div class="content-pass"><i data-lucide="circle-check"></i><span>身份必填项与格式检查已通过</span></div>`}
            </div>
          </section>
          <section class="panel">
            <div class="panel-head"><h3>域名身份</h3><span class="badge complete">dakingscc.cc</span></div>
            <div class="panel-body"><ul class="profile-checklist"><li><i data-lucide="check"></i><span>MX / SPF 已验证</span></li><li><i data-lucide="check"></i><span>DKIM 已由服务商验证</span></li><li><i data-lucide="check"></i><span>DMARC 已发布，当前 p=none</span></li></ul></div>
          </section>
          <section class="panel">
            <div class="panel-head"><h3>邮件落款预览</h3><i data-lucide="signature"></i></div>
            <div class="panel-body"><div class="signature-preview" id="signaturePreview"><strong data-preview="companyDisplayName">${value("companyDisplayName")}</strong><span data-preview="companyLegalName">${value("companyLegalName")}</span><span data-preview="phone">${value("phone")}</span><span data-preview="website">${value("website")}</span><hr><small>From: <span data-preview="senderEmail">${escapeHtml(effective.from || profile.senderEmail || "")}</span></small><small>Reply-To: <span data-preview="replyTo">${escapeHtml(effective.replyTo || profile.replyTo || "")}</span></small><small>退订：回复至 <span data-preview="unsubscribeReplyMailbox">${escapeHtml(profile.unsubscribeReplyMailbox || effective.replyTo || "")}</span></small><small data-preview="physicalAddress">${value("physicalAddress")}</small></div></div>
          </section>
          <section class="panel">
            <div class="panel-head"><h3>第二轮回复稿</h3><span class="badge neutral">保留空白</span></div>
            <div class="panel-body"><div class="static-field"><i data-lucide="mail-question"></i>收到公司邮箱回信后再创建二轮稿；当前不预填员工姓名、职位或个人联系方式。</div></div>
          </section>
          ${renderSenderAccountFleet(profile.accountFleet || [])}
        </aside>
      </section>
    </div>`;
}

function renderSenderAccountFleet(domains) {
  return `<section class="panel"><div class="panel-head"><h3>发件邮箱池</h3><span class="badge neutral">仅显示状态</span></div><div class="panel-body account-fleet">${domains.length ? domains.map((domain) => `<div class="fleet-domain"><div class="fleet-domain-head"><strong>${escapeHtml(domain.domain || "待购域名")}</strong><span>${number(domain.verifiedCount || 0)}/${number(domain.accountCount || 0)} 个 SMTP 已验收</span></div><ul class="profile-checklist">${(domain.accounts || []).map((account) => `<li><i data-lucide="${account.smtpAuthStatus === "passed_local_and_server_application_password" ? "check" : "clock-3"}"></i><span>${escapeHtml(account.address || "待分配邮箱")} · ${escapeHtml(account.smtpAuthStatus || "not_tested")}</span></li>`).join("")}</ul></div>`).join("") : `<div class="static-field">暂无邮箱池记录</div>`}</div></section>`;
}

function syncCollectionModeControls() {
  const mode = document.getElementById("opsCollectionMode")?.value || "hscode";
  const keyword = document.getElementById("keywordField");
  const countryBusiness = document.getElementById("countryBusinessField");
  const hs = document.getElementById("opsHsCode");
  const hsField = hs?.closest(".field");
  const generalCountries = document.getElementById("generalCountriesField");
  if (keyword) keyword.hidden = mode !== "keyword";
  if (countryBusiness) countryBusiness.hidden = mode !== "country_business";
  if (hsField) hsField.hidden = mode !== "hscode";
  if (generalCountries) generalCountries.hidden = mode === "country_business";
  if (hs) hs.required = mode === "hscode";
  const country = document.getElementById("opsCountry");
  const businessScope = document.getElementById("opsBusinessScope");
  if (country) country.required = mode === "country_business";
  if (businessScope) businessScope.required = mode === "country_business";
}

function loadDrafts() {
  return api("/api/pipeline/drafts?limit=1000").then((drafts) => {
    state.drafts = drafts;
    if (!state.drafts.items.some((item) => item.id === state.selectedDraftId)) state.selectedDraftId = state.drafts.items[0]?.id || null;
  });
}

function renderDrafts() {
  const allDrafts = state.drafts?.items || [];
  const query = String(state.draftFilters.q || "").trim().toLowerCase();
  const drafts = query
    ? allDrafts.filter((item) => [item.company, item.contactName, item.email, item.subject, item.body].some((value) => String(value || "").toLowerCase().includes(query)))
    : allDrafts;
  const selected = drafts.find((item) => item.id === state.selectedDraftId) || drafts[0] || null;
  const selectedIndex = selected ? drafts.findIndex((item) => item.id === selected.id) : -1;
  const counts = state.drafts?.counts || {};
  return `
    <div class="view-stack drafts-view">
      <div class="section-header"><div><h2>批量邮件草稿</h2><p>按流水线批次连续浏览主题、收件人和正文；此处只读，不会触发发送。</p></div><div class="section-actions"><span class="badge neutral">${number(counts.totalDrafts || allDrafts.length)} 封草稿</span><span class="badge neutral">${number(counts.jobs || 0)} 个批次</span></div></div>
      <section class="draft-inbox-layout">
        <div class="panel draft-inbox-list">
          <div class="panel-head"><h3>草稿目录</h3><span class="badge neutral">${number(drafts.length)} 封</span></div>
          <form class="draft-filter" id="draftFilterForm"><label class="sr-only" for="draftSearch">搜索草稿</label><input class="input" id="draftSearch" name="q" value="${escapeHtml(state.draftFilters.q)}" placeholder="搜索公司、联系人、主题或正文" /><button class="icon-button" type="submit" title="搜索草稿" aria-label="搜索草稿"><i data-lucide="search"></i></button></form>
          <div class="draft-list">${drafts.length ? drafts.map((item) => `<button class="draft-row ${item.id === selected?.id ? "active" : ""}" data-select-draft="${escapeHtml(item.id)}" type="button"><span class="draft-row-main"><strong>${escapeHtml(item.company || "未填写公司")}</strong><small>${escapeHtml(item.contactName || "未填写联系人")} · ${escapeHtml(item.email || "无邮箱")}</small><span>${escapeHtml(item.subject || "未填写主题")}</span></span><span class="draft-row-side"><small>${number(item.wordCount)} 词</small><i data-lucide="chevron-right"></i></span></button>`).join("") : emptyState("mail-search", query ? "没有匹配草稿" : "暂无批量草稿", query ? "换一个关键词继续搜索。" : "流水线完成起草后，草稿会自动出现在这里。")}</div>
        </div>
        <article class="panel draft-reader" aria-live="polite">
          ${selected ? `<div class="panel-head"><div><h3>草稿 ${number(selectedIndex + 1)} / ${number(drafts.length)}</h3><p>${escapeHtml(selected.company)} · ${escapeHtml(selected.contactName || "未命名联系人")}</p></div><div class="draft-reader-actions"><button class="icon-button" data-draft-step="prev" type="button" title="上一封" aria-label="上一封" ${selectedIndex <= 0 ? "disabled" : ""}><i data-lucide="chevron-left"></i></button><button class="icon-button" data-draft-step="next" type="button" title="下一封" aria-label="下一封" ${selectedIndex < 0 || selectedIndex >= drafts.length - 1 ? "disabled" : ""}><i data-lucide="chevron-right"></i></button></div></div><div class="draft-recipient"><div><span>收件人</span><strong>${escapeHtml(selected.contactName || "未填写联系人")}</strong><small>${escapeHtml(selected.email || "无邮箱")} · ${escapeHtml(selected.contactRole || "未填写岗位")}</small></div><div><span>批次</span><strong>${escapeHtml(selected.jobId)}</strong><small>${escapeHtml(selected.jobStatus)} · ${escapeHtml(selected.approvalStatus || "待审核")}</small></div></div><div class="draft-subject"><span>主题</span><strong>${escapeHtml(selected.subject || "未填写主题")}</strong></div><pre class="draft-body">${escapeHtml(selected.body || "")}</pre>${selected.warnings?.length ? `<div class="callout"><i data-lucide="triangle-alert"></i><div><strong>草稿提示</strong><span>${escapeHtml(selected.warnings.join("；"))}</span></div></div>` : ""}` : emptyState("mail-open", "选择一封草稿", "从左侧目录选择邮件后查看完整内容。")}
        </article>
      </section>
    </div>`;
}

function renderMailbox() {
  const mailbox = state.mailbox || { accounts: [], counts: {}, messages: [], replies: [], replyUsage: {} };
  const message = state.mailboxMessage;
  const replyCenter = renderMailboxReplyCenter(mailbox);
  if (!mailbox.configured) {
    return `<div class="view-stack"><div class="section-header"><div><h2>十账号统一邮件中心</h2><p>服务器直接通过IMAP/SMTP管理邮箱，不依赖本机畅邮。</p></div>${badge("waiting_sync")}</div>${replyCenter}${emptyState("mail-x", "服务器邮箱凭据尚未配置", "配置受限的十账号客户端授权码后，后台轮询器会自动建立统一收件箱。")}</div>`;
  }
  const accountOptions = mailbox.accounts.map((item) => item.address);
  return `
    <div class="view-stack">
      <div class="section-header"><div><h2>十账号统一邮件中心</h2><p>集中查看Maggie1至Maggie10；回复从原收件账号发出，开发信发送门保持独立锁定。</p></div><div class="section-actions"><span class="badge neutral">${number(mailbox.counts?.synced)}/${number(mailbox.counts?.accounts)} 已同步</span><span class="badge neutral">更新 ${shortDateTime(mailbox.updatedAt)}</span></div></div>
      <section class="kpi-grid" aria-label="邮箱状态">
        ${kpi("inboxes", "集中账号", number(mailbox.counts?.accounts), `${number(mailbox.counts?.synced)}个同步正常`)}
        ${kpi("mail", "缓存邮件", number(mailbox.counts?.messages), `${number(mailbox.counts?.unread)}封未读（只读同步）`)}
        ${kpi("send", "已接受回复", number(mailbox.counts?.repliesAccepted), "只统计邮件中心人工回复")}
        ${kpi("shield-check", "今日回复余量", number(mailbox.replyUsage?.remaining), `安全上限${number(mailbox.replyUsage?.limit)}封`)}
      </section>
      <div class="section-actions mailbox-export-actions"><button class="button" id="exportPotentialRepliesButton" type="button"><i data-lucide="file-down"></i>导出潜在客户回复信息</button><span class="kpi-foot">仅导出非内部发件人的已同步邮件</span></div>
      ${replyCenter}
      <section class="panel mailbox-accounts"><div class="panel-head"><h3>账号同步</h3><span class="kpi-foot">授权码不返回前端</span></div><div class="mailbox-account-grid">${mailbox.accounts.map((account) => `<div class="mailbox-account"><div><strong>${escapeHtml(account.address)}</strong><span>${number(account.cachedCount)}封缓存 · ${shortDateTime(account.lastSyncAt)}</span></div>${badge(account.status)}${account.lastError ? `<p>${escapeHtml(account.lastError)}</p>` : ""}</div>`).join("")}</div></section>
      <details class="panel mailbox-compose"><summary><i data-lucide="square-pen"></i><strong>写一封正常商务邮件</strong><span>单一收件人 · 人工确认 · 不进入开发信活动</span></summary><form class="panel-body" id="mailboxComposeForm"><div class="form-grid"><div class="field"><label for="mailboxComposeAccount">发件账号</label><select class="select" id="mailboxComposeAccount" name="account" required>${accountOptions.map((address) => `<option value="${escapeHtml(address)}">${escapeHtml(address)}</option>`).join("")}</select></div><div class="field"><label for="mailboxComposeTo">收件人</label><input class="input" id="mailboxComposeTo" name="to" type="email" required /></div><div class="field full"><label for="mailboxComposeSubject">主题</label><input class="input" id="mailboxComposeSubject" name="subject" maxlength="240" required /></div><div class="field full"><label for="mailboxComposeBody">正文</label><textarea class="textarea" id="mailboxComposeBody" name="body" rows="8" maxlength="20000" required></textarea></div></div><label class="check-row"><input type="checkbox" name="normalBusinessConfirmed" required /><span>确认这是单一收件人的正常商务通信，不是营销邮件、开发信或批量触达。</span></label><div class="form-actions"><button class="button primary" type="submit" ${mailbox.replyEnabled ? "" : "disabled"}><i data-lucide="send"></i>确认并发送</button><span>营销活动发送开关仍保持关闭</span></div></form></details>
      <details class="panel mailbox-compose"><summary><i data-lucide="send-horizontal"></i><strong>最近发送审计</strong><span>${number(mailbox.replies?.length)}条 · accepted/failed/uncertain均保留</span></summary><div class="table-shell"><table><thead><tr><th>发件账号</th><th>收件人</th><th>主题</th><th>类型</th><th>状态</th><th>时间</th></tr></thead><tbody>${(mailbox.replies || []).length ? mailbox.replies.map((entry) => `<tr><td>${escapeHtml(entry.account)}</td><td>${escapeHtml(entry.recipient)}</td><td class="truncate">${escapeHtml(entry.subject)}</td><td>${entry.type === "manual_compose" ? "新建" : "回复"}</td><td>${badge(entry.status)}</td><td>${shortDateTime(entry.updatedAt)}</td></tr>`).join("") : `<tr><td colspan="6">尚无邮件中心发送记录；本轮部署未发送测试邮件。</td></tr>`}</tbody></table></div></details>
      <section class="mailbox-layout">
        <div class="panel mailbox-list-panel">
          <form class="toolbar mailbox-toolbar" id="mailboxFilterForm">
            <div class="field"><label for="mailboxAccount">邮箱账号</label><select class="select" id="mailboxAccount" name="account">${selectOptions(accountOptions, state.mailboxFilters.account, "全部账号")}</select></div>
            <div class="field"><label for="mailboxSearch">邮件搜索</label><input class="input" id="mailboxSearch" name="q" value="${escapeHtml(state.mailboxFilters.q)}" placeholder="发件人、主题或正文摘要" /></div>
            <button class="button primary" type="submit"><i data-lucide="search"></i>筛选</button>
          </form>
          <div class="mailbox-message-list">${mailbox.messages.length ? mailbox.messages.map((item) => `
            <button class="mailbox-message ${item.unread ? "unread" : ""} ${message?.id === item.id ? "active" : ""}" data-mailbox-message="${escapeHtml(item.id)}" type="button">
              <span class="mailbox-message-head"><strong>${escapeHtml(item.from?.name || item.from?.address || "未知发件人")}</strong><time>${shortDateTime(item.date)}</time></span>
              <span class="mailbox-message-subject">${escapeHtml(item.subject || "（无主题）")}</span>
              <span class="mailbox-message-snippet">${escapeHtml(item.snippet || "（无纯文本正文）")}</span>
              <span class="mailbox-message-account">${escapeHtml(item.account)}${item.hasAttachments ? " · 有附件" : ""}</span>
            </button>`).join("") : emptyState("mail-open", "没有匹配邮件", "等待下一次五分钟同步，或调整账号和搜索条件。")}</div>
        </div>
        <article class="panel mailbox-detail">${message ? `
          <div class="panel-head"><div><h3>${escapeHtml(message.subject || "（无主题）")}</h3><span class="kpi-foot">${escapeHtml(message.account)} · ${shortDateTime(message.date)}</span></div>${message.unread ? `<span class="badge partial">IMAP未读</span>` : ""}</div>
          <div class="mailbox-envelope"><div><span>发件人</span><strong>${escapeHtml(message.from?.name || "")} &lt;${escapeHtml(message.from?.address || "")}&gt;</strong></div><div><span>收件人</span><strong>${escapeHtml((message.to || []).join(", "))}</strong></div></div>
          <pre class="mailbox-body">${escapeHtml(message.bodyText || "（正文无法解析；附件暂不在网页打开）")}</pre>
          <form class="mailbox-reply" id="mailboxReplyForm">
            <div class="field"><label for="mailboxReplyBody">使用 ${escapeHtml(message.account)} 回复</label><textarea class="textarea" id="mailboxReplyBody" name="body" rows="8" maxlength="20000" required placeholder="输入正常商务回复；不会进入开发信活动发送链路。"></textarea></div>
            <div class="form-actions"><button class="button primary" type="submit" ${mailbox.replyEnabled ? "" : "disabled"}><i data-lucide="reply"></i>人工确认并回复</button><span>${mailbox.replyEnabled ? "回复目标固定为原发件人" : "服务器回复开关尚未启用"}</span></div>
          </form>` : emptyState("mouse-pointer-click", "选择一封邮件", "左侧选择邮件后查看完整纯文本正文并使用原账号回复。")}</article>
      </section>
    </div>`;
}

function renderMailboxReplyCenter(mailbox) {
  const messages = Array.isArray(mailbox.messages) ? mailbox.messages : [];
  const replies = Array.isArray(mailbox.replies) ? mailbox.replies : [];
  const repliedIds = new Set(replies.filter((item) => ["sending", "accepted", "uncertain"].includes(item.status) && item.sourceMessageId).map((item) => item.sourceMessageId));
  const classify = (item) => {
    const text = `${item.subject || ""} ${item.snippet || ""}`.toLowerCase();
    if (/unsubscribe|退订|remove me|stop emailing|opt.?out/.test(text)) return "退订请求";
    if (/complaint|abuse|spam|投诉/.test(text)) return "投诉";
    if (/undeliverable|delivery failed|mailer-daemon|退信|bounce/.test(text)) return "退信通知";
    if (/automatic reply|auto.?reply|out of office|自动回复/.test(text)) return "自动回复";
    return "商务回信";
  };
  const status = (item) => repliedIds.has(item.id) ? "已回复" : item.unread ? "待处理" : "已查看";
  const pending = messages.filter((item) => status(item) === "待处理").length;
  const categories = new Set(messages.map(classify));
  const visible = messages.slice(0, 100);
  const selected = new Set(state.mailboxSelectedIds || []);
  const selectedVisible = visible.filter((item) => selected.has(item.id)).length;
  const allVisibleSelected = visible.length > 0 && selectedVisible === visible.length;
  return `<section class="panel mailbox-reply-center" data-testid="mailbox-reply-center">
    <div class="panel-head"><div><h3>回信处理台</h3><p>集中查看收到的邮件，按类型和处理状态分流；选择一封后可在右侧回复。</p></div><div class="mailbox-export-tools"><span class="badge ${pending ? "partial" : "complete"}">${number(pending)} 封待处理</span><label class="mailbox-export-count-label" for="mailboxExportCount">导出行数</label><input class="input mailbox-export-count" id="mailboxExportCount" type="number" min="1" max="500" value="${number(state.mailboxExportCount || selectedVisible || 20)}" aria-label="导出行数" /><button class="button small" id="exportSelectedRepliesButton" type="button" ${selectedVisible ? "" : "disabled"}><i data-lucide="file-down"></i>导出</button></div></div>
    <div class="mailbox-reply-summary"><div><span>收到回信</span><strong>${number(messages.length)}</strong></div><div><span>未读待处理</span><strong>${number(pending)}</strong></div><div><span>类型覆盖</span><strong>${number(categories.size)}</strong></div><div><span>已回复</span><strong>${number(messages.filter((item) => status(item) === "已回复").length)}</strong></div></div>
    <div class="table-shell"><table><thead><tr><th class="select-cell"><input id="mailboxSelectAll" type="checkbox" ${allVisibleSelected ? "checked" : ""} ${visible.length ? "" : "disabled"} aria-label="选择当前显示的回信" /></th><th>处理状态</th><th>回信类型</th><th>发件人</th><th>主题</th><th>收件账号</th><th>时间</th><th>操作</th></tr></thead><tbody>${messages.length ? visible.map((item) => `<tr><td class="select-cell"><input class="mailbox-row-select" type="checkbox" data-mailbox-select="${escapeHtml(item.id)}" ${selected.has(item.id) ? "checked" : ""} aria-label="选择 ${escapeHtml(item.from?.name || item.from?.address || "此回信")}" /></td><td>${badge(status(item))}</td><td>${escapeHtml(classify(item))}</td><td class="truncate">${escapeHtml(item.from?.name || item.from?.address || "未知发件人")}</td><td class="truncate">${escapeHtml(item.subject || "（无主题）")}</td><td>${escapeHtml(item.account || "-")}</td><td>${shortDateTime(item.date)}</td><td><button class="button small" data-mailbox-message="${escapeHtml(item.id)}" type="button"><i data-lucide="external-link"></i>查看</button></td></tr>`).join("") : `<tr><td colspan="8">暂无回信；IMAP同步后会自动出现在这里。</td></tr>`}</tbody></table></div>
  </section>`;
}

function dailyMeter(icon, label, used, limit, note) {
  const safeLimit = Math.max(Number(limit || 0), 1);
  const ratio = Math.min((Number(used || 0) / safeLimit) * 100, 100);
  return `<article class="daily-meter">
    <div class="daily-meter-head"><span><i data-lucide="${icon}"></i>${escapeHtml(label)}</span><strong>${number(used)} / ${number(limit)}</strong></div>
    <progress class="progress-track ${ratio >= 100 ? "red" : ratio >= 75 ? "amber" : ""}" max="100" value="${ratio}" aria-label="${escapeHtml(label)}进度"></progress>
    <div class="daily-meter-foot"><span>${escapeHtml(note)}</span><span>剩余 ${number(Math.max(Number(limit || 0) - Number(used || 0), 0))}</span></div>
  </article>`;
}

function quantityMetric(icon, label, value) {
  return `<article class="daily-meter quantity-metric">
    <div class="daily-meter-head"><span><i data-lucide="${icon}"></i>${escapeHtml(label)}</span><strong>${number(value)}</strong></div>
  </article>`;
}

function renderSettingsLegacy() {
  const aiRuntime = aiRuntimeState();
  const aiReady = aiRuntime.ready;
  const smtpReady = Boolean(state.health?.delivery?.smtpConfigured);
  const sendingEnabled = deliveryEnabled();
  return `
    <div class="view-stack">
      <div class="section-header"><div><h2>当前系统边界</h2><p>AI只生成草稿；真实发送由独立的SMTP开关、合规检查和批次确认控制。</p></div>${badge(sendingEnabled ? "partial" : "blocked")}</div>
      <section class="guardrail-grid">
        ${guardrail("database", "本地数据源", "读取现有采集JSON，不读取浏览器Cookie、LocalStorage或账号凭据。")}
        ${guardrail("shield-check", "只读采集", "正常页面、分页和公开字段；不绕过登录、付费、验证码或遮罩。")}
        ${guardrail(sendingEnabled ? "send" : "mail-x", sendingEnabled ? "受控发送已开启" : "真实发送关闭", sendingEnabled ? `每批最多${state.health.delivery.batchLimit}封，间隔${state.health.delivery.delayMs}毫秒，仍需逐批确认。` : "SMTP配置或EMAIL_SENDING_ENABLED尚未就绪。")}
        ${guardrail("user-check", "人工审核", "未来发送前必须确认实体、职位、邮箱有效性和退订状态。")}
        ${guardrail("list-x", "抑制名单", "退订、invalid、低置信和重复邮箱必须从收件人快照排除。")}
        ${guardrail("file-clock", "审计与归档", "任务动作、预算拒绝和恢复均可见并可导出；原始采集结果不覆盖。")}
      </section>
      <section class="panel"><div class="panel-head"><h3>功能开关</h3></div><div class="table-shell"><table><thead><tr><th>能力</th><th>状态</th><th>说明</th></tr></thead><tbody>
        <tr><td>海关与买家数据读取</td><td>${badge("complete")}</td><td>139家买家和前20联系人已连接</td></tr>
        <tr><td>联系人筛选与去重</td><td>${badge("complete")}</td><td>公司、邮箱、电话和LinkedIn分列</td></tr>
        <tr><td>邮箱格式与域名/MX检查</td><td>${badge("complete")}</td><td>使用本地规则和DNS，已保存 ${number(state.contactQuality.storedRecords)} 条状态；不声称可投递</td></tr>
        <tr><td>网易联系人基础有效</td><td>${badge("complete")}</td><td>具备邮箱并通过格式、域名/MX、公司归属和去重检查即可进入候选；职位不再作为硬门</td></tr>
        <tr><td>永久抑制名单</td><td>${badge("complete")}</td><td>${number(state.suppressions.count)} 条本地哈希记录会从活动收件人中自动排除</td></tr>
        <tr><td>HSCode预算与检查点</td><td>${badge("complete")}</td><td>${number(state.operationTasks.length)} 个本地任务；支持预算拒绝、保护信号熔断和人工恢复</td></tr>
        <tr><td>本地控制备份</td><td>${badge("complete")}</td><td>导出验证、抑制、任务审计和活动草稿；不含密钥、Cookie或原始联系人数据，并附SHA-256摘要</td></tr>
        <tr><td>GPT-5.6邮件起草</td><td>${badge(aiReady ? "complete" : "blocked")}</td><td>${aiReady ? `Responses API已配置，模型 ${escapeHtml(state.health.ai.model)}` : "OPENAI_API_KEY未配置"}</td></tr>
        <tr><td>邮件草稿与预览</td><td>${badge("complete")}</td><td>AI输出先进入人工可编辑草稿，不会自动发送</td></tr>
        <tr><td>SMTP连接</td><td>${badge(smtpReady ? "complete" : "blocked")}</td><td>${smtpReady ? "SMTP凭据完整，前端不可读取" : "Maggie1已通过SMTP AUTH；当前运行环境尚未加载生产凭据"}</td></tr>
        <tr><td>SMTP真实发送</td><td>${badge(sendingEnabled ? "partial" : "blocked")}</td><td>${sendingEnabled ? "逐批确认、限量、限速并写入本地审计" : "默认关闭；须显式设置EMAIL_SENDING_ENABLED=true"}</td></tr>
      </tbody></table></div></section>
    </div>`;
}

function renderSettings() {
  const aiRuntime = aiRuntimeState();
  const smtpReady = Boolean(state.health?.delivery?.smtpConfigured);
  const sendingEnabled = deliveryEnabled();
  const deliveryCircuit = state.health?.delivery?.circuit || {};
  const deliverySummary = deliveryCircuit.open
    ? `发送熔断已开启：${deliveryCircuit.reason || "未知原因"}；必须人工复核并明确恢复`
    : sendingEnabled
      ? `已配置；每批最多 ${number(state.health.delivery.batchLimit)} 封，间隔 ${number(state.health.delivery.delayMs)} ms，仍需逐批确认`
      : "已锁定；未配置 SMTP 或 EMAIL_SENDING_ENABLED 未显式开启";
  return `
    <div class="view-stack settings-view">
      <div class="section-header"><div><h2>系统边界与外部依赖</h2><p>本页把能在本地完成的工作、需要业务确认的事项，以及必须购买或配置的能力分开显示。</p></div>${badge(sendingEnabled ? "partial" : "blocked")}</div>
       <section class="boundary-callout"><div class="boundary-callout-icon"><i data-lucide="shield-check"></i></div><div><strong>当前安全策略</strong><p>网易页面只使用你提供的网易外贸账号和正常页面流程；不会绕过登录、验证码、付费墙或平台限制。AI 只生成草稿，邮箱格式/域名检查也不等于可投递。</p></div><span class="boundary-lock"><i data-lucide="lock-keyhole"></i>真实发送 ${sendingEnabled ? "受控开启" : "已锁定"}</span></section>
       <section class="panel"><div class="panel-head"><div><h3>发送审批模式</h3><span class="panel-caption">自动模式只自动推进已经通过全部服务器发送门槛的批次。</span></div><span class="badge ${state.deliveryMode.mode === "auto" ? "partial" : "neutral"}">${state.deliveryMode.mode === "auto" ? "自动审批" : "人工审批"}</span></div><div class="panel-body"><div class="form-grid"><div class="field"><label for="deliveryModeSelect">模式</label><select class="select" id="deliveryModeSelect"><option value="manual" ${state.deliveryMode.mode === "manual" ? "selected" : ""}>人工审批后发送</option><option value="auto" ${state.deliveryMode.mode === "auto" ? "selected" : ""}>自动审批并发送</option></select></div></div><p class="panel-caption">缺少完整联系人证据、退订/反馈配置、额度、抑制/防重或熔断通过时，自动模式会保持等待，不会强行发送。</p></div></section>
      <section class="dependency-toolbar"><div><h3>外部依赖清单</h3><p>完成这些项目后，系统才会把对应能力从“待确认/受限”推进到可验收状态。</p></div><div class="section-actions"><button class="button small" id="copyDependencyChecklist" type="button"><i data-lucide="clipboard-copy"></i>复制配置字段</button><button class="button small" id="downloadDependencyChecklist" type="button"><i data-lucide="download"></i>下载清单</button></div></section>
      <section class="account-prereq"><div class="account-prereq-icon"><i data-lucide="log-in"></i></div><div><strong>网易外贸账号运行前置</strong><p>由你提供账号并在网易外贸页面完成现场登录；本项目不把网易使用权计入购买项，也不会代替你处理登录验证码。</p></div><span class="badge neutral">不购买</span></section>
      <section class="dependency-grid">
        ${dependencyCard("local", "本地已完成", "可立即使用", "database", ["买家与联系人本地数据读取", "去重、抑制名单、DNS 域名检查", "HSCode 九阶段队列、租约恢复、熔断和检查点", "AI 草稿、人工审核与幂等发件箱"], "不需要购买；数据只写入服务器运行目录，真实发送仍保持关闭。")}
        ${dependencyCard("confirm", "用户确认即可推进", "待你提供证据", "user-round-check", ["业务事实与卖点白名单", "每批发送的收件人、主题和退订策略", "联系人职位、采购证据与所选图片的人工复核"], "中英文公司身份和图片营销使用权已确认；具体活动仍需逐项审核，其他事实不能用 AI 推测替代。")}
        ${dependencyCard("external", "邮箱池技术验收", "10/10已验收", "key-round", ["dakingscc.cc与dakingscc.cn均已完成MX/SPF/DKIM/DMARC", "Maggie1至Maggie10均已完成独立客户端密码与双端AUTH", "十账号统一收件、同账号人工发件/回复与反馈定时器已运行", "阿里企业邮箱仅保留正常商务通信、收件与回复用途"], "阿里邮件推送同样禁止未经许可的开发信；营销触达必须先验收允许该用途的出站产品，并具备许可、退订、抑制与反馈证据。")}
      </section>
      <section class="panel dependency-table-panel"><div class="panel-head"><div><h3>能力验收矩阵</h3><span class="panel-caption">状态是当前本地检测结果，不代表外部服务已经购买或联系人已经验证。</span></div></div><div class="table-shell"><table><thead><tr><th>能力</th><th>当前状态</th><th>为什么受限</th><th>完成证据</th></tr></thead><tbody>
        <tr><td>网易公开页面搜索</td><td>${badge("partial")}</td><td>计划级桌面执行器和每日任务已启用；验证码、凭据、权限、MFA及连续运行验收仍是边界</td><td>搜索结果文件、任务 HSCode、页面检查点、逐项预算审计与连续运行记录</td></tr>
        <tr><td>HSCode持久流水线</td><td>${badge("complete")}</td><td>${number(state.pipeline.jobs.length)} 个任务；缺少网易输入时自动停在waiting_input</td><td>阶段状态、租约、产物引用、熔断与恢复审计</td></tr>
        <tr><td>联系人本地质量检查</td><td>${badge("complete")}</td><td>syntax_valid / domain_valid 不证明邮箱可投递</td><td>检查记录、DNS 结果、抑制名单命中记录</td></tr>
        <tr><td>网易联系人基础有效</td><td>${badge("complete")}</td><td>邮箱、公司归属、格式与域名/MX通过后进入候选；仍受去重、抑制和反馈熔断约束</td><td>网易可见联系人行、公司官网/LinkedIn（若有）和服务器审计</td></tr>
        <tr><td>GPT-5.6 草稿</td><td>${badge(aiRuntime.status)}</td><td>${escapeHtml(aiRuntime.label)}；输出仍需审核</td><td>最近请求时间、成功时间、错误与人工审核记录</td></tr>
        <tr><td>邮件幂等发件箱</td><td>${badge("complete")}</td><td>发送前落盘；accepted/sending/uncertain 禁止自动重试</td><td>${number(state.outbox.counts?.accepted || 0)} 已接受，${number(state.outbox.counts?.uncertain || 0)} 待人工裁决</td></tr>
        <tr><td>SMTP 连接与真实发送</td><td>${badge(sendingEnabled ? "partial" : "blocked")}</td><td>${escapeHtml(sendingEnabled ? deliverySummary : "两个域名和10个邮箱均已完成技术验收；阿里企业邮箱及邮件推送均不允许未经许可的开发信，真实发送继续锁定")}</td><td>合规产品回执、适用地区法律依据、退信/退订日志与逐批审计</td></tr>
        <tr><td>本地控制备份与恢复</td><td>${badge("complete")}</td><td>仅安全合并，禁止破坏性覆盖</td><td>SHA-256 摘要、回滚快照、合并审计</td></tr>
      </tbody></table></div></section>
      <section class="guardrail-grid">
        ${guardrail("database", "本地数据源", "读取现有采集 JSON，不读取浏览器 Cookie、LocalStorage 或账号凭据。")}
        ${guardrail("shield-check", "网易账号正常操作", "使用你提供的网易外贸账号和正常页面，不绕过登录、付费、验证码或平台限制。")}
        ${guardrail(sendingEnabled ? "send" : "mail-x", sendingEnabled ? "受控发送已开启" : "真实发送已关闭", deliverySummary)}
        ${guardrail("user-check", "人工复核", "发送前确认实体、职位、邮箱状态、业务事实和退订状态。")}
        ${guardrail("list-x", "永久抑制", `退订、invalid、低置信和重复邮箱从活动收件人中自动排除；当前 ${number(state.suppressions.count)} 条。`)}
        ${guardrail("file-clock", "审计与归档", `任务、流水线、发件箱和恢复状态均持久化；当前 ${number(state.operationTasks.length)} 个任务、${number(state.pipeline.jobs.length)} 条流水线。`)}
      </section>
    </div>`;
}

function dependencyCard(kind, title, status, icon, items, note) {
  return `<article class="dependency-card ${kind}"><div class="dependency-card-head"><div class="dependency-icon"><i data-lucide="${icon}"></i></div><div><h3>${escapeHtml(title)}</h3><span>${escapeHtml(status)}</span></div></div><ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul><p class="dependency-note">${escapeHtml(note)}</p></article>`;
}

const dependencyChecklistText = `外贸自动化拓客系统：外部购买 / 配置清单

网易账号（不计入购买项）：使用你提供的网易外贸账号现场登录，保持正常页面会话。
1. 邮箱验证：在职/可投递验证服务订阅，或每个邮箱的人工验证证据。
2. 发件基础设施：dakingscc.cc已有5个邮箱，Maggie1至Maggie5已全部完成SMTP AUTH验收；测试均未进入DATA。
3. 第二邮箱池：dakingscc.cn下Maggie6至Maggie10已完成MFA、独立客户端密码、本机/服务器SMTP AUTH及DKIM/DMARC验收。
4. 公司身份：中文法定主体、英文对外名称、统一社会信用代码、公司电话、官网、注册地址和对外实体地址均已确认。
5. 合规配置：回复公司邮箱退订、抑制名单维护、退信/投诉回调和内部金丝雀。

无需购买、但必须由业务负责人确认：业务事实、卖点白名单、每批具体配图、收件人和退订策略。中英文公司身份及官网/公司产品图片的营销使用权已经确认。

验收标准：企业邮箱只用于正常商务通信、收件与回复；营销触达必须使用允许该用途的出站产品，并保存明确许可、逐批审计与退订证据。统一容量服务和管理员权限不能替代产品规则或收件人许可。`;

async function copyDependencyChecklist() {
  try {
    await navigator.clipboard.writeText(dependencyChecklistText);
    toast("配置字段清单已复制");
  } catch {
    toast("浏览器未允许复制，请使用下载清单", "error");
  }
}

function downloadDependencyChecklist() {
  const blob = new Blob([`${dependencyChecklistText}\n`], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "外贸自动化拓客系统-外部购买授权清单.txt";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("外部购买 / 授权清单已下载");
}

function guardrail(icon, heading, body) {
  return `<article class="guardrail"><div class="guardrail-icon"><i data-lucide="${icon}"></i></div><h3>${escapeHtml(heading)}</h3><p>${escapeHtml(body)}</p></article>`;
}

function render() {
  const meta = viewMeta[state.view];
  title.textContent = meta[1];
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === state.view));
  const renderer = {
    overview: renderOverview,
    foundation: renderFoundation,
    workflow: renderWorkflow,
    buyers: renderBuyers,
    contacts: renderContacts,
    operations: renderOperations,
    campaigns: renderCampaigns,
    drafts: renderDrafts,
    mailbox: renderMailbox,
    "sender-profile": renderSenderProfile,
    settings: renderSettings,
  }[state.view];
  main.innerHTML = renderer();
  bindViewEvents();
  refreshIcons();
}

function updateSenderProfilePreview(form) {
  const values = Object.fromEntries(new FormData(form).entries());
  document.querySelectorAll("[data-preview]").forEach((node) => {
    const key = node.dataset.preview;
    node.textContent = values[key] || "-";
  });
}

async function saveSenderProfile(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = document.getElementById("saveSenderProfileButton");
  button.disabled = true;
  try {
    const payload = Object.fromEntries(new FormData(form).entries());
    state.senderProfile = await api("/api/sender-profile", { method: "PUT", body: JSON.stringify(payload) });
    if (state.health?.delivery) state.health.delivery.senderProfile = state.senderProfile.readiness;
    render();
    toast(state.senderProfile.readiness.readyForCanary ? "发件配置已保存，金丝雀身份门槛已通过" : "发件配置已保存；占位符仍会锁定真实发送");
  } catch (error) {
    toast(error.message, "error");
    button.disabled = false;
  }
}

async function loadBuyers() {
  state.buyers = await api(`/api/buyers?${queryString(state.buyerFilters)}`);
}

async function loadContacts() {
  state.contacts = await api(`/api/contacts?${queryString(state.contactFilters)}`);
}

async function loadCampaigns() {
  state.campaigns = await api("/api/campaigns");
}

async function saveDeliveryMode(event) {
  const mode = event.target.value;
  try {
    state.deliveryMode = await api("/api/delivery-mode", {
      method: "PUT",
      body: JSON.stringify({ mode, updatedBy: "web-operator" }),
    });
    render();
    toast(mode === "auto" ? "已启用自动审批；所有发送硬门仍然生效" : "已切换为人工审批");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function loadMailbox() {
  state.mailbox = await api(`/api/mailbox?${queryString(state.mailboxFilters)}`);
  const available = new Set((state.mailbox.messages || []).map((item) => item.id));
  state.mailboxSelectedIds = (state.mailboxSelectedIds || []).filter((id) => available.has(id));
  if (state.mailboxMessage && !state.mailbox.messages.some((item) => item.id === state.mailboxMessage.id)) {
    state.mailboxMessage = null;
  }
}

async function uploadEmailAssets(event) {
  const files = [...(event.target.files || [])].slice(0, 10);
  const label = document.getElementById("emailAssetLabel")?.value.trim();
  for (const file of files) {
    const dataBase64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    try {
      await api("/api/email-assets", { method: "POST", body: JSON.stringify({ filename: file.name, label: label || file.name, mimeType: file.type, dataBase64 }) });
    } catch (error) { toast(error.message, "error"); return; }
  }
  await loadBase();
  state.view = "campaigns";
  render();
  toast(`已添加 ${files.length} 张本地图片`);
}

function toggleMailboxSelection(id, checked) {
  const selected = new Set(state.mailboxSelectedIds || []);
  if (checked) selected.add(id); else selected.delete(id);
  state.mailboxSelectedIds = [...selected];
  render();
}

function toggleMailboxSelectAll(checked) {
  const visibleIds = (state.mailbox?.messages || []).slice(0, 100).map((item) => item.id);
  const selected = new Set(state.mailboxSelectedIds || []);
  visibleIds.forEach((id) => checked ? selected.add(id) : selected.delete(id));
  state.mailboxSelectedIds = [...selected];
  render();
}

function exportSelectedReplies() {
  const selected = [...new Set(state.mailboxSelectedIds || [])];
  if (!selected.length) return toast("请先勾选要导出的客户邮件", "error");
  const requested = Math.max(Number(state.mailboxExportCount || selected.length), 1);
  const limit = Math.min(requested, selected.length, 500);
  const params = new URLSearchParams({ ...state.mailboxFilters, ids: selected.join(","), limit: String(limit) });
  window.location.href = `/api/mailbox/export-replies?${params.toString()}`;
}

async function loadLocalControls() {
  const requests = [
    api("/api/contact-quality"),
    api("/api/suppressions"),
    api("/api/ops/tasks"),
    api("/api/contact-queues"),
    api("/api/pipeline"),
    api("/api/pipeline/daily-batch?limit=1000&central=1"),
    api("/api/outbox"),
    api("/api/company-qualification"),
  ];
  const results = await Promise.allSettled(requests);
  const fallback = [state.contactQuality, state.suppressions, { items: state.operationTasks }, { items: state.contactQueues }, state.pipeline, state.dailyBatch, state.outbox, state.companyQualification];
  state.controlLoadErrors = [];
  const values = results.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    state.controlLoadErrors.push(result.reason?.message || `控制接口 ${index + 1} 暂时不可用`);
    return fallback[index];
  });
  const [contactQuality, suppressions, operations, contactQueues, pipeline, dailyBatch, outbox, companyQualification] = values;
  state.contactQuality = contactQuality || { counts: {}, storedRecords: 0 };
  state.suppressions = suppressions || { count: 0, items: [] };
  state.operationTasks = Array.isArray(operations?.items) ? operations.items : [];
  state.contactQueues = Array.isArray(contactQueues?.items) ? contactQueues.items : [];
  state.pipeline = pipeline || { stages: [], counts: {}, claimable: 0, jobs: [] };
  state.pipeline.jobs = Array.isArray(state.pipeline.jobs) ? state.pipeline.jobs : [];
  state.dailyBatch = dailyBatch || { selected: [], blockedCount: 0 };
  state.outbox = outbox || { counts: {}, items: [] };
  state.outbox.items = Array.isArray(state.outbox.items) ? state.outbox.items : [];
  state.companyQualification = companyQualification || state.companyQualification;
  if (!state.operationTasks.some((item) => item.id === state.selectedTaskId)) {
    state.selectedTaskId = state.operationTasks[0]?.id || null;
  }
  if (!state.contactQueues.some((item) => item.id === state.selectedQueueId)) {
    state.selectedQueueId = state.contactQueues[0]?.id || null;
  }
}

async function validateContactEmail(email) {
  try {
    const result = await api("/api/contact-quality/validate", {
      method: "POST",
      body: JSON.stringify({ email, mode: "domain" }),
    });
    await Promise.all([loadContacts(), loadLocalControls()]);
    render();
    toast(`本地检查完成：${result.results[0]?.status || "unknown"}`);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function validateCurrentContactPage() {
  const button = document.getElementById("validatePageButton");
  const contactIds = state.contacts.items
    .filter((item) => item.email && !item.suppressed)
    .map((item) => item.id)
    .slice(0, 25);
  if (!contactIds.length) return;
  if (button) {
    button.disabled = true;
    button.textContent = "正在执行本地检查";
  }
  try {
    const result = await api("/api/contact-quality/validate", {
      method: "POST",
      body: JSON.stringify({ contactIds, mode: "domain" }),
    });
    await Promise.all([loadContacts(), loadLocalControls()]);
    render();
    toast(`已检查 ${number(result.processed)} 个邮箱，复用为 ${number(result.uniqueDomains)} 个域名查询`);
  } catch (error) {
    toast(error.message, "error");
    render();
  }
}

async function markContactDeliverable(email) {
  const evidence = window.prompt("粘贴可追溯证据URL，并简述该完整邮箱为何属于当前联系人。没有完整邮箱证据请取消。", "");
  if (!evidence?.trim()) return;
  if (!/^https?:\/\//i.test(evidence.trim())) {
    toast("人工可投递证据必须以完整 http/https URL 开头", "error");
    return;
  }
  try {
    await api("/api/contact-quality/status", {
      method: "POST",
      body: JSON.stringify({ email, status: "deliverable", evidence: evidence.trim() }),
    });
    await Promise.all([loadContacts(), loadLocalControls()]);
    render();
    toast("人工证据已保存；发送前仍需活动审核");
  } catch (error) {
    toast(error.message, "error");
  }
}

function downloadJson(filename, payload) {
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportLocalBackup() {
  try {
    const backup = await api("/api/local-backup");
    const stamp = String(backup.exportedAt || new Date().toISOString()).slice(0, 10);
    downloadJson(`dakings-local-control-backup-${stamp}.json`, backup);
    toast("本地控制备份已导出并附带SHA-256摘要");
  } catch (error) {
    toast(error.message, "error");
  }
}

function validateLocalBackupFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const backup = JSON.parse(await file.text());
      const result = await api("/api/local-backup/validate", {
        method: "POST",
        body: JSON.stringify(backup),
      });
      const counts = result.counts || {};
      toast(`备份有效：验证 ${number(counts.validationRecords)}、任务 ${number(counts.operationTasks)}、流水线 ${number(counts.pipelineJobs)}、发件箱 ${number(counts.outboxEntries)}、草稿 ${number(counts.campaigns)}`);
    } catch (error) {
      const message = error instanceof SyntaxError ? "所选文件不是有效的JSON备份" : error.message;
      toast(message, "error");
    }
  }, { once: true });
  input.click();
}

function mergeLocalBackupFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const backup = JSON.parse(await file.text());
      const preview = await api("/api/local-backup/preview", {
        method: "POST",
        body: JSON.stringify(backup),
      });
      const added = preview.added || {};
      const summary = `将新增：验证 ${number(added.validationRecords)}、抑制 ${number(added.suppressions)}、任务 ${number(added.operationTasks)}、流水线 ${number(added.pipelineJobs)}、发件箱 ${number(added.outboxEntries)}、草稿 ${number(added.campaigns)}。\n现有同标识记录全部保留，不执行覆盖或删除。\n\n请输入确认短语：\n${preview.confirmation}`;
      const confirmation = window.prompt(summary);
      if (confirmation !== preview.confirmation) {
        toast("安全合并已取消", "error");
        return;
      }
      const result = await api("/api/local-backup/merge", {
        method: "POST",
        body: JSON.stringify({ backup, confirm: confirmation }),
      });
      await Promise.all([loadContacts(), loadLocalControls(), loadCampaigns()]);
      render();
      const totalAdded = Object.values(result.added || {}).reduce((sum, value) => sum + Number(value || 0), 0);
      toast(`安全合并完成，新增 ${number(totalAdded)} 条；已生成回滚快照 ${result.rollbackFile}`);
    } catch (error) {
      const message = error instanceof SyntaxError ? "所选文件不是有效的JSON备份" : error.message;
      toast(message, "error");
    }
  }, { once: true });
  input.click();
}

function exportSelectedTask() {
  const task = state.operationTasks.find((item) => item.id === state.selectedTaskId);
  if (!task) return;
  downloadJson(`hscode-${task.hsCode}-${task.id}.json`, {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    task,
  });
  toast(`HSCode ${task.hsCode} 任务已导出`);
}

async function suppressEmail(email, reason = "manual", source = "local-admin", skipConfirm = false) {
  if (!skipConfirm && !window.confirm(`确认把 ${email} 加入永久抑制名单？此界面不提供自动删除。`)) return;
  try {
    await api("/api/suppressions", {
      method: "POST",
      body: JSON.stringify({ email, reason, source }),
    });
    await Promise.all([loadContacts(), loadLocalControls(), loadCampaigns()]);
    render();
    toast("已加入永久抑制名单");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function addSuppression(event) {
  event.preventDefault();
  const email = document.getElementById("suppressionEmail").value.trim();
  const reason = document.getElementById("suppressionReason").value;
  const source = document.getElementById("suppressionSource").value.trim();
  if (!window.confirm(`确认永久抑制 ${email}？`)) return;
  await suppressEmail(email, reason, source, true);
}

async function createOpsTask(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const payload = {
    hsCode: form.get("hsCode"),
    collectionMode: form.get("collectionMode"),
    keyword: form.get("keyword"),
    country: form.get("country"),
    businessScope: form.get("businessScope"),
    businessKeywords: String(form.get("businessScope") || "").split(/[,，;；\n]/).map((item) => item.trim()).filter(Boolean),
    direction: form.get("direction"),
    countries: (form.get("collectionMode") === "country_business"
      ? [String(form.get("country") || "").trim()]
      : String(form.get("countries") || "").split(",").map((item) => item.trim()).filter(Boolean)),
    budgets: {
      buyerEntriesDaily: Number(form.get("buyerBudget")),
      companyDetailsDaily: Number(form.get("detailBudget")),
      validEmailCompaniesDaily: Number(form.get("validCompanyBudget")),
      contactPagesDaily: Number(form.get("contactPageBudget")),
      emailSendsDaily: Number(form.get("emailSendBudget")),
    },
    automation: { mode: form.get("automation") },
  };
  if (payload.automation.mode === "managed") {
    const key = payload.collectionMode === "keyword" ? payload.keyword : payload.collectionMode === "country_business" ? `${payload.country}:${payload.businessKeywords.join(",")}` : payload.hsCode;
    const label = payload.collectionMode === "keyword" ? "关键词" : payload.collectionMode === "country_business" ? "国家+业务范围" : "HSCode";
    if (!window.confirm(`确认授权${label} ${key} 按计划自动采集、生成合规草稿并在全部安全门通过后发送？`)) return;
    payload.automation.confirm = `AUTHORIZE MANAGED ${key}`;
    payload.automation.authorizedBy = "web-plan-owner";
  }
  try {
    const task = await api("/api/ops/tasks", { method: "POST", body: JSON.stringify(payload) });
    state.selectedTaskId = task.id;
    await loadLocalControls();
    render();
    toast(`${payload.collectionMode === "country_business" ? "国家+业务范围" : payload.collectionMode === "keyword" ? "Keyword" : "HSCode"} 任务已冻结`);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function recordOpsAction(type) {
  const task = state.operationTasks.find((item) => item.id === state.selectedTaskId);
  if (!task) return;
  const payload = {
    type,
    count: Number(document.getElementById("opsCount")?.value || 1),
    signal: document.getElementById("opsSignal")?.value || "none",
    checkpoint: {
      company: document.getElementById("checkpointCompany")?.value || "",
      page: Number(document.getElementById("checkpointPage")?.value || 0),
      note: document.getElementById("checkpointNote")?.value || "",
    },
  };
  try {
    await api(`/api/ops/tasks/${task.id}/actions`, { method: "POST", body: JSON.stringify(payload) });
    toast(payload.signal === "none" ? "动作与检查点已记录" : "安全信号已记录，状态已自动调整");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    await loadLocalControls();
    render();
  }
}

async function recoverOpsTask() {
  const task = state.operationTasks.find((item) => item.id === state.selectedTaskId);
  if (!task) return;
  const phrase = `RECOVER ${task.id}`;
  const confirmation = window.prompt(`人工确认页面和账号已经恢复后输入：\n${phrase}`);
  if (confirmation !== phrase) return toast("恢复已取消", "error");
  try {
    await api(`/api/ops/tasks/${task.id}/recover`, { method: "POST", body: JSON.stringify({ confirm: phrase }) });
    await loadLocalControls();
    render();
    toast("任务已进入人工恢复金丝雀档");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function resumePipelineJob() {
  const task = state.operationTasks.find((item) => item.id === state.selectedTaskId);
  const job = state.pipeline.jobs.find((item) => item.operationTaskId === task?.id);
  if (!job) return;
  const reference = window.prompt("请输入网易正常页面结果或已导入文件的可追溯引用：");
  if (!reference?.trim()) return;
  try {
    await api(`/api/pipeline/jobs/${job.id}/resume`, {
      method: "POST",
      body: JSON.stringify({ inputReference: reference.trim() }),
    });
    await loadLocalControls();
    render();
    toast("输入引用已登记，流水线已进入可领取队列");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function switchOverviewManagedPlan(event) {
  event.preventDefault();
  const hsCode = String(new FormData(event.currentTarget).get("hsCode") || "").trim();
  const budgets = state.managedPlan.dailyBudgets || {};
  const current = state.managedPlan.hsCodes?.[0] || {};
  try {
    const task = await api("/api/ops/tasks", {
      method: "POST",
      body: JSON.stringify({
        hsCode,
        direction: current.direction || "buyer",
        countries: current.countries || [],
        budgets: {
          buyerEntriesDaily: Number(budgets.buyerEntries || 1200),
          companyDetailsDaily: Number(budgets.companyDetails || 400),
          validEmailCompaniesDaily: Number(budgets.validEmailCompanies || 100),
          contactPagesDaily: Number(budgets.contactPages || 400),
          emailSendsDaily: Number(budgets.emailSends || 500),
        },
        automation: {
          mode: "managed",
          planId: state.managedPlan.planId,
          authorizedBy: "overview-plan-owner",
          confirm: `AUTHORIZE MANAGED ${hsCode}`,
        },
      }),
    });
    state.selectedTaskId = task.id;
    await loadBase();
    render();
    toast(`HSCode ${task.hsCode} 托管采集计划已生效`);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function sendCentralBatch() {
  const count = Number(state.dailyBatch?.selected?.length || 0);
  if (!count) return toast("当前没有通过简单核验的集中审核草稿", "error");
  const phrase = "SEND DAILY BATCH";
  if (window.prompt(`确认集中审核并发送今日批次（最多${count}封）：\n${phrase}`) !== phrase) {
    return toast("集中批次发送已取消", "error");
  }
  const buttons = [...document.querySelectorAll("#centralBatchSendButton, #centralBatchSendHeaderButton")];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const result = await api("/api/pipeline/central-batch/send", {
      method: "POST",
      body: JSON.stringify({ confirm: phrase, reviewer: "web-central-batch" }),
    });
    await loadBase();
    render();
    toast(`集中批次已处理：接受 ${number(result.batch?.accepted || 0)} 封，失败 ${number(result.batch?.failed || 0)} 封`);
  } catch (error) {
    buttons.forEach((button) => { button.disabled = false; });
    toast(error.message, "error");
  }
}

async function recoverPipelineJob() {
  const task = state.operationTasks.find((item) => item.id === state.selectedTaskId);
  const job = state.pipeline.jobs.find((item) => item.operationTaskId === task?.id);
  if (!job) return;
  const phrase = `RECOVER PIPELINE ${job.id}`;
  const confirmation = window.prompt(`确认保护提示已解除后输入：\n${phrase}`);
  if (confirmation !== phrase) return toast("流水线恢复已取消", "error");
  try {
    await api(`/api/pipeline/jobs/${job.id}/recover`, { method: "POST", body: JSON.stringify({ confirm: phrase }) });
    await loadLocalControls();
    render();
    toast("熔断已人工确认；任务保持暂停，需重新登记输入后再运行");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function initializeCollectionQueue() {
  try {
    const queue = await api("/api/contact-queues/initialize", {
      method: "POST",
      body: JSON.stringify({
        key: "hung_hing_amity_20260811",
        label: "Hung Hing + Amity 全部买家公司联系人采集",
        config: { batchSize: 20, minDelayMs: 15000, maxDelayMs: 25000, leaseSeconds: 1800, maxAttempts: 3 },
      }),
    });
    state.selectedQueueId = queue.id;
    state.activeCollectionBatch = null;
    await loadLocalControls();
    render();
    toast(`队列已同步：${number(queue.counts.total)} 家，剩余 ${number(queue.counts.remaining)} 家`);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function claimCollectionBatch() {
  const queue = state.contactQueues.find((item) => item.id === state.selectedQueueId);
  if (!queue) return;
  try {
    const result = await api(`/api/contact-queues/${queue.id}/claim`, {
      method: "POST",
      body: JSON.stringify({ owner: "desktop-collector", batchSize: queue.config.batchSize }),
    });
    state.activeCollectionBatch = result.batch ? { ...result.batch, queueId: queue.id } : null;
    await loadLocalControls();
    render();
    toast(result.batch ? `已领取 ${number(result.batch.items.length)} 家，租约已保存` : "队列没有待处理公司");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function pauseCollectionQueue() {
  const queue = state.contactQueues.find((item) => item.id === state.selectedQueueId);
  if (!queue) return;
  try {
    await api(`/api/contact-queues/${queue.id}/pause`, { method: "POST", body: "{}" });
    await loadLocalControls();
    render();
    toast("联系人采集队列已暂停");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function resumeCollectionQueue() {
  const queue = state.contactQueues.find((item) => item.id === state.selectedQueueId);
  if (!queue) return;
  const body = {};
  if (queue.status === "circuit_open") {
    const phrase = `RECOVER COLLECTION ${queue.id}`;
    const confirmation = window.prompt(`确认网易页面和账号已恢复后输入：\n${phrase}`);
    if (confirmation !== phrase) return toast("恢复已取消", "error");
    body.confirm = phrase;
  }
  try {
    await api(`/api/contact-queues/${queue.id}/resume`, { method: "POST", body: JSON.stringify(body) });
    await loadLocalControls();
    render();
    toast(queue.status === "circuit_open" ? "已进入人工恢复档" : "联系人采集队列已恢复");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function exportCollectionBoundaryReport() {
  const queue = state.contactQueues.find((item) => item.id === state.selectedQueueId);
  if (!queue) return;
  try {
    const report = await api(`/api/contact-queues/${queue.id}/boundary-report`);
    downloadJson(`contact-collection-boundaries-${queue.id}.json`, report);
    toast("错误边界与实施参数已导出");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function selectMailboxMessage(id) {
  try {
    state.mailboxMessage = await api(`/api/mailbox/messages/${encodeURIComponent(id)}`);
    render();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function replyToMailboxMessage(event) {
  event.preventDefault();
  const message = state.mailboxMessage;
  const body = String(new FormData(event.currentTarget).get("body") || "").trim();
  if (!message || !body) return toast("请输入回复正文", "error");
  const phrase = `REPLY ${message.id}`;
  if (window.prompt(`确认使用 ${message.account} 回复 ${message.from?.address || "原发件人"}：\n${phrase}`) !== phrase) {
    return toast("回复已取消", "error");
  }
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api(`/api/mailbox/messages/${encodeURIComponent(message.id)}/reply`, {
      method: "POST",
      body: JSON.stringify({ body, confirm: phrase }),
    });
    await loadMailbox();
    render();
    toast("回复已由原收件账号接受并进入邮件审计");
  } catch (error) {
    button.disabled = false;
    toast(error.message, "error");
  }
}

async function composeMailboxMessage(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form).entries());
  const account = String(values.account || "");
  const phrase = `SEND MAIL ${account}`;
  if (window.prompt(`确认使用 ${account} 向 ${values.to} 发送一封正常商务邮件：\n${phrase}`) !== phrase) {
    return toast("发件已取消", "error");
  }
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api("/api/mailbox/compose", {
      method: "POST",
      body: JSON.stringify({ ...values, normalBusinessConfirmed: values.normalBusinessConfirmed === "on", confirm: phrase }),
    });
    form.reset();
    await loadMailbox();
    render();
    toast("正常商务邮件已由所选账号接受并进入邮件审计");
  } catch (error) {
    button.disabled = false;
    toast(error.message, "error");
  }
}

function bindViewEvents() {
  document.querySelectorAll("[data-jump]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.jump)));
  document.getElementById("mailboxFilterForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    state.mailboxFilters = { account: String(form.get("account") || ""), q: String(form.get("q") || "") };
    state.mailboxMessage = null;
    await loadMailbox();
    render();
  });
  document.querySelectorAll("[data-mailbox-message]").forEach((button) => button.addEventListener("click", () => selectMailboxMessage(button.dataset.mailboxMessage)));
  document.querySelectorAll("[data-mailbox-select]").forEach((input) => input.addEventListener("change", () => toggleMailboxSelection(input.dataset.mailboxSelect, input.checked)));
  document.getElementById("mailboxSelectAll")?.addEventListener("change", (event) => toggleMailboxSelectAll(event.target.checked));
  document.getElementById("mailboxExportCount")?.addEventListener("input", (event) => { state.mailboxExportCount = Math.min(Math.max(Number(event.target.value || 1), 1), 500); });
  document.getElementById("exportSelectedRepliesButton")?.addEventListener("click", exportSelectedReplies);
  document.getElementById("mailboxReplyForm")?.addEventListener("submit", replyToMailboxMessage);
  document.getElementById("mailboxComposeForm")?.addEventListener("submit", composeMailboxMessage);
  document.getElementById("draftFilterForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    state.draftFilters.q = String(new FormData(event.currentTarget).get("q") || "");
    state.selectedDraftId = null;
    render();
  });
  document.querySelectorAll("[data-select-draft]").forEach((button) => button.addEventListener("click", () => {
    state.selectedDraftId = button.dataset.selectDraft;
    render();
  }));
  document.querySelectorAll("[data-draft-step]").forEach((button) => button.addEventListener("click", () => {
    const query = String(state.draftFilters.q || "").trim().toLowerCase();
    const drafts = (state.drafts?.items || []).filter((item) => !query || [item.company, item.contactName, item.email, item.subject, item.body].some((value) => String(value || "").toLowerCase().includes(query)));
    const index = drafts.findIndex((item) => item.id === state.selectedDraftId);
    const next = button.dataset.draftStep === "prev" ? index - 1 : index + 1;
    if (drafts[next]) { state.selectedDraftId = drafts[next].id; render(); }
  }));

  const senderProfileForm = document.getElementById("senderProfileForm");
  if (senderProfileForm) {
    senderProfileForm.addEventListener("submit", saveSenderProfile);
    senderProfileForm.addEventListener("input", () => updateSenderProfilePreview(senderProfileForm));
  }
  document.getElementById("deliveryModeSelect")?.addEventListener("change", saveDeliveryMode);

  const buyerForm = document.getElementById("buyerFilterForm");
  if (buyerForm) buyerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(buyerForm);
    state.buyerFilters = { ...state.buyerFilters, q: form.get("q"), country: form.get("country"), confidence: form.get("confidence"), status: form.get("status"), page: 1 };
    await loadBuyers(); render();
  });

  const contactForm = document.getElementById("contactFilterForm");
  if (contactForm) contactForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(contactForm);
    state.contactFilters = { ...state.contactFilters, q: form.get("q"), buyer: form.get("buyer"), priority: form.get("priority"), confidence: form.get("confidence"), validation: form.get("validation"), page: 1 };
    await loadContacts(); render();
  });

  document.getElementById("emailOnlyToggle")?.addEventListener("change", async (event) => {
    state.contactFilters.emailOnly = event.target.checked;
    state.contactFilters.page = 1;
    await loadContacts(); render();
  });

  document.querySelectorAll("[data-validate-email]").forEach((button) => button.addEventListener("click", () => validateContactEmail(button.dataset.validateEmail)));
  document.getElementById("validatePageButton")?.addEventListener("click", validateCurrentContactPage);
  document.querySelectorAll("[data-suppress-email]").forEach((button) => button.addEventListener("click", () => suppressEmail(button.dataset.suppressEmail, "manual", "contact-workbench")));
  document.querySelectorAll("[data-manual-deliverable]").forEach((button) => button.addEventListener("click", () => markContactDeliverable(button.dataset.manualDeliverable)));
  document.getElementById("validateBackupButton")?.addEventListener("click", validateLocalBackupFile);
  document.getElementById("mergeBackupButton")?.addEventListener("click", mergeLocalBackupFile);
  document.getElementById("exportBackupButton")?.addEventListener("click", exportLocalBackup);
  document.getElementById("copyDependencyChecklist")?.addEventListener("click", copyDependencyChecklist);
  document.getElementById("downloadDependencyChecklist")?.addEventListener("click", downloadDependencyChecklist);
  document.getElementById("exportTaskButton")?.addEventListener("click", exportSelectedTask);
  document.getElementById("initializeCollectionButton")?.addEventListener("click", initializeCollectionQueue);
  document.getElementById("claimCollectionButton")?.addEventListener("click", claimCollectionBatch);
  document.getElementById("pauseCollectionButton")?.addEventListener("click", pauseCollectionQueue);
  document.getElementById("resumeCollectionButton")?.addEventListener("click", resumeCollectionQueue);
  document.getElementById("exportCollectionBoundaryButton")?.addEventListener("click", exportCollectionBoundaryReport);
  document.getElementById("opsTaskForm")?.addEventListener("submit", createOpsTask);
  document.getElementById("companyQualificationForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const split = (name) => String(form.get(name) || "").split(",").map((item) => item.trim()).filter(Boolean);
    try { await api("/api/company-qualification", { method: "PUT", body: JSON.stringify({ enabled: form.has("enabled"), targetCountries: split("targetCountries"), businessKeywords: split("businessKeywords"), excludeKeywords: split("excludeKeywords"), targetHsCodes: split("targetHsCodes"), allowedCompanyTypes: split("allowedCompanyTypes"), minimumScore: Number(form.get("minimumScore") || 0) }) }); await loadLocalControls(); render(); toast("公司资格筛选规则已保存"); } catch (error) { toast(error.message, "error"); }
  });
  document.getElementById("overviewManagedPlanForm")?.addEventListener("submit", switchOverviewManagedPlan);
  document.querySelectorAll("[data-select-task]").forEach((button) => button.addEventListener("click", () => {
    state.selectedTaskId = button.dataset.selectTask;
    render();
  }));
  document.querySelectorAll("[data-op-action]").forEach((button) => button.addEventListener("click", () => recordOpsAction(button.dataset.opAction)));
  document.getElementById("recoverTaskButton")?.addEventListener("click", recoverOpsTask);
  document.getElementById("resumePipelineButton")?.addEventListener("click", resumePipelineJob);
  document.getElementById("centralBatchSendButton")?.addEventListener("click", sendCentralBatch);
  document.getElementById("centralBatchSendHeaderButton")?.addEventListener("click", sendCentralBatch);
  document.getElementById("recoverPipelineButton")?.addEventListener("click", recoverPipelineJob);
  document.getElementById("suppressionForm")?.addEventListener("submit", addSuppression);
  document.getElementById("opsCollectionMode")?.addEventListener("change", (event) => {
    syncCollectionModeControls();
  });
  syncCollectionModeControls();
  document.getElementById("emailAssetUpload")?.addEventListener("change", uploadEmailAssets);

  document.querySelectorAll("[data-page-kind]").forEach((button) => button.addEventListener("click", async () => {
    const kind = button.dataset.pageKind;
    if (kind === "buyers") { state.buyerFilters.page = Number(button.dataset.page); await loadBuyers(); }
    if (kind === "contacts") { state.contactFilters.page = Number(button.dataset.page); await loadContacts(); }
    render();
  }));

  document.querySelectorAll("[data-token]").forEach((button) => button.addEventListener("click", () => {
    const textarea = document.getElementById("campaignBody");
    const token = button.dataset.token;
    const start = textarea.selectionStart;
    textarea.value = `${textarea.value.slice(0, start)}${token}${textarea.value.slice(textarea.selectionEnd)}`;
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = start + token.length;
  }));

  document.getElementById("campaignForm")?.addEventListener("submit", saveCampaign);
  document.getElementById("aiDraftButton")?.addEventListener("click", generateDraft);
  document.getElementById("aiBatchDraftButton")?.addEventListener("click", generateBatchDrafts);
  document.getElementById("draftScenario")?.addEventListener("change", syncScenarioControls);
  document.querySelectorAll('input[name="draftCandidateScenario"]').forEach((input) => input.addEventListener("change", syncCandidateScenarioControls));
  document.querySelectorAll("[data-use-draft]").forEach((button) => button.addEventListener("click", () => useDraftCandidate(Number(button.dataset.useDraft))));
  document.querySelectorAll('input[name="emailAsset"]').forEach((input) => input.addEventListener("change", syncScenarioControls));
  document.querySelectorAll("[data-preview-campaign]").forEach((button) => button.addEventListener("click", () => previewCampaign(button.dataset.previewCampaign)));
  document.querySelectorAll("[data-edit-campaign]").forEach((button) => button.addEventListener("click", () => editCampaign(button.dataset.editCampaign)));
  document.querySelectorAll("[data-review-campaign]").forEach((button) => button.addEventListener("click", () => reviewCampaign(button.dataset.reviewCampaign)));
  document.querySelectorAll("[data-approve-campaign]").forEach((button) => button.addEventListener("click", () => approveCampaign(button.dataset.approveCampaign)));
  document.querySelectorAll("[data-schedule-campaign]").forEach((button) => button.addEventListener("click", () => scheduleCampaign(button.dataset.scheduleCampaign)));
  document.querySelectorAll("[data-send-campaign]").forEach((button) => button.addEventListener("click", () => sendCampaign(button.dataset.sendCampaign)));
  document.getElementById("cancelCampaignEdit")?.addEventListener("click", () => { state.editingCampaignId = null; render(); });
  syncScenarioControls();
  syncCandidateScenarioControls();
}

function useDraftCandidate(index) {
  const draft = state.draftCandidates[index];
  if (!draft) return;
  document.getElementById("draftScenario").value = draft.scenario;
  document.getElementById("campaignSubject").value = draft.subject;
  document.getElementById("campaignBody").value = draft.body;
  document.getElementById("aiDraftStatus").textContent = `${draft.wordCount}词 · 已选择，仍需人工检查`;
  syncScenarioControls();
  toast("候选草稿已写入主题和正文");
}

async function generateDraft() {
  const button = document.getElementById("aiDraftButton");
  const status = document.getElementById("aiDraftStatus");
  const tradeContent = document.getElementById("tradeContent").value.trim();
  const companyBusiness = document.getElementById("companyBusiness").value.trim();
  const productFocus = document.getElementById("productFocus").value.trim();
  const hsCode = document.getElementById("hsCode").value.trim();
  const scenarios = selectedValues("draftCandidateScenario");
  if (!tradeContent || !companyBusiness || !productFocus || !hsCode) {
    toast("请先填写HSCode、产品方向、采购商证据和我方业务", "error");
    return;
  }
  if (!scenarios.length || scenarios.length > 3) {
    toast("请选择1-3种候选输出类型", "error");
    return;
  }
  const assetIds = selectedValues("emailAsset");
  const assetRightsConfirmed = document.getElementById("assetRightsConfirmed").checked;
  if (assetIds.length && !assetRightsConfirmed) {
    toast("选择配图后必须确认对外使用权", "error");
    return;
  }
  button.disabled = true;
  status.textContent = "正在生成草稿…";
  try {
    const result = await api("/api/ai/drafts", {
      method: "POST",
      body: JSON.stringify({
        scenarios,
        hsCode,
        productFocus,
        buyerCompany: document.getElementById("buyerCompany").value,
        contactName: document.getElementById("contactName").value,
        contactRole: document.getElementById("contactRole").value,
        buyerCountry: document.getElementById("campaignCountry").value,
        buyerEvidence: tradeContent,
        companyBusiness,
        senderCompany: document.getElementById("senderCompany").value,
        senderEmail: state.senderProfile?.senderEmail || "",
        senderWebsite: state.senderProfile?.website || "",
        senderPhone: state.senderProfile?.phone || "",
        tone: document.getElementById("draftTone").value,
        approvedClaims: selectedValues("approvedClaim"),
        assetIds,
        assetRightsConfirmed,
        eventName: document.getElementById("eventName").value,
        eventDates: document.getElementById("eventDates").value,
        eventBooth: document.getElementById("eventBooth").value,
        eventAddress: document.getElementById("eventAddress").value,
        meetingLocation: document.getElementById("meetingLocation").value,
        language: "English",
      }),
    });
    state.draftCandidates = result.drafts || [];
    const candidates = document.getElementById("draftCandidates");
    candidates.innerHTML = renderDraftCandidates();
    candidates.querySelectorAll("[data-use-draft]").forEach((candidate) => candidate.addEventListener("click", () => useDraftCandidate(Number(candidate.dataset.useDraft))));
    refreshIcons();
    status.textContent = `已生成 ${state.draftCandidates.length} 种候选，选择后才写入正文`;
    toast("候选草稿已生成，尚未自动采用");
  } catch (error) {
    status.textContent = "生成失败";
    toast(error.message, "error");
  } finally {
    button.disabled = !state.health?.ai?.configured;
  }
}

async function generateBatchDrafts() {
  const button = document.getElementById("aiBatchDraftButton");
  const status = document.getElementById("aiDraftStatus");
  const count = Math.min(Math.max(Number(document.getElementById("batchTargetCount")?.value || 20), 1), 200);
  button.disabled = true;
  status.textContent = `正在准备 ${count} 个邮箱联系人…`;
  try {
    const items = [];
    for (let page = 1; items.length < count; page += 1) {
      const contacts = await api(`/api/contacts?page=${page}&pageSize=100&emailOnly=true&dedupe=first`);
      items.push(...(contacts.items || []));
      if (!contacts.items?.length || page >= Number(contacts.pages || page)) break;
    }
    const recipients = items.filter((item) => item.email).slice(0, count).map((item) => ({ buyerCompany: item.matchedCompany || item.rawBuyerName, contactName: item.name, contactRole: item.title, buyerCountry: item.country }));
    if (!recipients.length) throw new Error("没有可用于批量起草的邮箱联系人");
    status.textContent = `正在批量生成 ${recipients.length} 封草稿…`;
    const result = await api("/api/ai/batch-drafts", { method: "POST", body: JSON.stringify({ count: recipients.length, recipients, scenario: document.getElementById("draftScenario").value, hsCode: document.getElementById("hsCode").value, productFocus: document.getElementById("productFocus").value, buyerEvidence: document.getElementById("tradeContent").value, companyBusiness: document.getElementById("companyBusiness").value, senderCompany: document.getElementById("senderCompany").value, senderEmail: state.senderProfile?.senderEmail || "", senderWebsite: state.senderProfile?.website || "", senderPhone: state.senderProfile?.phone || "", tone: document.getElementById("draftTone").value, approvedClaims: selectedValues("approvedClaim"), assetIds: document.getElementById("batchImageMode").value === "none" ? [] : selectedValues("emailAsset"), assetRightsConfirmed: document.getElementById("assetRightsConfirmed").checked, sendWithImages: document.getElementById("sendWithImages").checked, language: "English" }) });
    state.draftCandidates = result.drafts || [];
    document.getElementById("draftCandidates").innerHTML = renderDraftCandidates(); refreshIcons();
    status.textContent = `已批量生成 ${state.draftCandidates.length} 封候选草稿`; toast("批量草稿已生成，仍需逐项检查和保存");
  } catch (error) { status.textContent = "批量生成失败"; toast(error.message, "error"); }
  finally { button.disabled = !state.health?.ai?.configured; }
}

async function saveCampaign(event) {
  event.preventDefault();
  const country = document.getElementById("campaignCountry").value;
  const priority = document.getElementById("campaignPriority").value;
  const highOnly = document.getElementById("highConfidenceOnly").checked;
  const payload = {
    name: document.getElementById("campaignName").value,
    subject: document.getElementById("campaignSubject").value,
    body: document.getElementById("campaignBody").value,
    brief: {
      scenario: document.getElementById("draftScenario").value,
      hsCode: document.getElementById("hsCode").value,
      productFocus: document.getElementById("productFocus").value,
      buyerEvidence: document.getElementById("tradeContent").value,
      contactRole: document.getElementById("contactRole").value,
      eventName: document.getElementById("eventName").value,
      eventDates: document.getElementById("eventDates").value,
      eventBooth: document.getElementById("eventBooth").value,
      eventAddress: document.getElementById("eventAddress").value,
      meetingLocation: document.getElementById("meetingLocation").value,
    },
    approvedClaims: selectedValues("approvedClaim"),
    assetIds: selectedValues("emailAsset"),
    assetRightsConfirmed: document.getElementById("assetRightsConfirmed").checked,
    filters: {
      countries: country ? [country] : [],
      priorities: priority ? [priority] : [],
      confidences: [],
      includeLowConfidence: !highOnly,
    },
    compliance: {
      suppressionListChecked: document.getElementById("suppressionChecked").checked,
      unsubscribeConfigured: document.getElementById("unsubscribeConfigured").checked,
      senderDomainVerified: document.getElementById("senderDomainVerified").checked,
      physicalAddressConfigured: document.getElementById("physicalAddressConfigured").checked,
      sendWithImages: document.getElementById("sendWithImages").checked,
    },
    batch: {
      targetCount: Number(document.getElementById("batchTargetCount").value || 20),
      imageMode: document.getElementById("batchImageMode").value,
      sendWithImages: document.getElementById("sendWithImages").checked,
    },
  };
  try {
    const path = state.editingCampaignId ? `/api/campaigns/${state.editingCampaignId}` : "/api/campaigns";
    const campaign = await api(path, { method: state.editingCampaignId ? "PUT" : "POST", body: JSON.stringify(payload) });
    state.editingCampaignId = null;
    await loadCampaigns();
    toast(`草稿已保存，预计 ${campaign.estimatedRecipients} 个候选邮箱`);
    render();
  } catch (error) { toast(error.message, "error"); }
}

function editCampaign(id) {
  const campaign = state.campaigns.find((item) => item.id === id);
  if (!campaign) return;
  state.editingCampaignId = id;
  const set = (field, value) => { const input = document.getElementById(field); if (input) input.value = value || ""; };
  set("campaignName", campaign.name); set("campaignSubject", campaign.subject); set("campaignBody", campaign.body);
  set("draftScenario", campaign.brief?.scenario || "first_touch"); set("hsCode", campaign.brief?.hsCode); set("productFocus", campaign.brief?.productFocus);
  set("tradeContent", campaign.brief?.buyerEvidence); set("contactRole", campaign.brief?.contactRole); set("eventName", campaign.brief?.eventName);
  set("eventDates", campaign.brief?.eventDates); set("eventBooth", campaign.brief?.eventBooth); set("eventAddress", campaign.brief?.eventAddress); set("meetingLocation", campaign.brief?.meetingLocation);
  set("campaignCountry", campaign.filters?.countries?.[0]); set("campaignPriority", campaign.filters?.priorities?.[0]);
  document.querySelectorAll('input[name="approvedClaim"]').forEach((input) => { input.checked = (campaign.approvedClaims || []).includes(input.value); });
  document.querySelectorAll('input[name="emailAsset"]').forEach((input) => { input.checked = (campaign.assetIds || []).includes(input.value); });
  document.getElementById("assetRightsConfirmed").checked = Boolean(campaign.assetRightsConfirmed);
  document.getElementById("sendWithImages").checked = Boolean(campaign.batch?.sendWithImages || campaign.compliance?.sendWithImages);
  document.getElementById("batchTargetCount").value = campaign.batch?.targetCount || 20;
  document.getElementById("batchImageMode").value = campaign.batch?.imageMode || "selected";
  document.getElementById("highConfidenceOnly").checked = !campaign.filters?.includeLowConfidence;
  for (const [id, key] of [["suppressionChecked", "suppressionListChecked"], ["unsubscribeConfigured", "unsubscribeConfigured"], ["senderDomainVerified", "senderDomainVerified"], ["physicalAddressConfigured", "physicalAddressConfigured"]]) {
    document.getElementById(id).checked = Boolean(campaign.compliance?.[key]);
  }
  document.getElementById("campaignEditorTitle").textContent = "编辑邮件草稿";
  document.getElementById("saveCampaignButton").innerHTML = '<i data-lucide="save"></i>保存并退回草稿';
  document.getElementById("cancelCampaignEdit").hidden = false;
  syncScenarioControls();
  lucide.createIcons();
  document.getElementById("campaignForm").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function previewCampaign(id) {
  try {
    state.campaignPreview = await api(`/api/campaigns/${id}/preview`, { method: "POST", body: "{}" });
    render();
    document.querySelector(".preview-list")?.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) { toast(error.message, "error"); }
}

async function reviewCampaign(id) {
  try {
    await api(`/api/campaigns/${id}/submit-review`, { method: "POST", body: "{}" });
    await loadCampaigns(); render(); toast("活动已提交本地审核队列");
  } catch (error) { toast(error.message, "error"); }
}

async function approveCampaign(id) {
  const phrase = `APPROVE ${id}`;
  const confirmation = window.prompt(`批准活动前请确认短语：\n${phrase}`);
  if (confirmation !== phrase) {
    toast("批准已取消", "error");
    return;
  }
  try {
    await api(`/api/campaigns/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({ confirm: phrase, reviewer: "local-admin" }),
    });
    await loadCampaigns();
    render();
    toast("活动已批准；真实发送仍需满足 SMTP 与验证门槛");
  } catch (error) { toast(error.message, "error"); }
}

async function scheduleCampaign(id) {
  try {
    await api(`/api/campaigns/${id}/simulate-schedule`, { method: "POST", body: JSON.stringify({}) });
    await loadCampaigns(); render(); toast("模拟排期已创建，不会发送邮件");
  } catch (error) { toast(error.message, "error"); }
}

async function sendCampaign(id) {
  const phrase = `SEND ${id}`;
  const confirmation = window.prompt(`即将发送下一安全批次。请输入确认短语：\n${phrase}`);
  if (confirmation !== phrase) {
    toast("发送已取消", "error");
    return;
  }
  try {
    const result = await api(`/api/campaigns/${id}/send`, {
      method: "POST",
      body: JSON.stringify({ confirm: phrase }),
    });
    await loadCampaigns();
    render();
    toast(`本批发送 ${result.batch.sent} 封，失败 ${result.batch.failed} 封，剩余 ${result.batch.remaining} 封`);
  } catch (error) {
    toast(error.message, "error");
  }
}

const commandDialog = document.getElementById("commandDialog");
const commandInput = document.getElementById("commandInput");
const commandList = document.getElementById("commandList");
let commandIndex = 0;

function commandItems(query = "") {
  const needle = query.trim().toLowerCase();
  return Object.entries(viewMeta)
    .filter(([view]) => view !== "workflow")
    .map(([view, meta]) => ({ view, label: meta[1], context: meta[0] }))
    .filter((item) => !needle || `${item.label} ${item.context} ${item.view}`.toLowerCase().includes(needle));
}

function renderCommandList() {
  const items = commandItems(commandInput.value);
  commandIndex = Math.min(commandIndex, Math.max(items.length - 1, 0));
  commandList.innerHTML = items.length ? items.map((item, index) => `
    <button class="command-item ${index === commandIndex ? "active" : ""}" data-command-view="${escapeHtml(item.view)}" role="option" aria-selected="${index === commandIndex}" type="button">
      <span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.context)}</small></span><i data-lucide="arrow-right"></i>
    </button>`).join("") : `<div class="command-empty">没有匹配页面</div>`;
  commandList.querySelectorAll("[data-command-view]").forEach((button) => button.addEventListener("click", () => runCommand(button.dataset.commandView)));
  refreshIcons();
}

function openCommandDialog() {
  commandIndex = 0;
  commandInput.value = "";
  renderCommandList();
  commandDialog.showModal();
  commandInput.focus({ preventScroll: true });
}

async function runCommand(view) {
  commandDialog.close();
  await switchView(view);
}

document.getElementById("commandButton").addEventListener("click", openCommandDialog);
commandInput.addEventListener("input", () => { commandIndex = 0; renderCommandList(); });
commandInput.addEventListener("keydown", (event) => {
  const items = commandItems(commandInput.value);
  if (event.key === "ArrowDown" && items.length) { event.preventDefault(); commandIndex = Math.min(commandIndex + 1, items.length - 1); renderCommandList(); }
  if (event.key === "ArrowUp" && items.length) { event.preventDefault(); commandIndex = Math.max(commandIndex - 1, 0); renderCommandList(); }
  if (event.key === "Enter" && items[commandIndex]) { event.preventDefault(); runCommand(items[commandIndex].view); }
});
commandDialog.addEventListener("click", (event) => { if (event.target === commandDialog) commandDialog.close(); });

async function switchView(view) {
  state.view = view;
  setMobileNavOpen(false);
  if (view === "buyers") await loadBuyers();
  if (view === "contacts") await loadContacts();
  if (view === "operations") await loadLocalControls();
  if (view === "campaigns") await loadCampaigns();
  if (view === "drafts") await loadDrafts();
  if (view === "mailbox") await loadMailbox();
  render();
}

document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
const menuButton = document.getElementById("menuButton");
function setMobileNavOpen(open) {
  sidebar.classList.toggle("open", open);
  scrim.classList.toggle("open", open);
  menuButton.setAttribute("aria-expanded", String(open));
  menuButton.setAttribute("aria-label", open ? "关闭导航" : "打开导航");
  sidebar.setAttribute("aria-hidden", String(innerWidth <= 820 && !open));
}
menuButton.addEventListener("click", () => setMobileNavOpen(!sidebar.classList.contains("open")));
scrim.addEventListener("click", () => setMobileNavOpen(false));
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); openCommandDialog(); }
  if (event.key === "Escape") setMobileNavOpen(false);
});
addEventListener("resize", () => setMobileNavOpen(false));
setMobileNavOpen(false);
document.getElementById("refreshButton").addEventListener("click", async () => {
  setLoading();
  try { await loadBase(); render(); toast("数据已刷新"); } catch (error) { main.innerHTML = emptyState("server-off", "无法连接本地服务", error.message); refreshIcons(); }
});

setLoading();
loadBase().then(render).catch((error) => {
  main.innerHTML = emptyState("server-off", "无法读取采集结果", error.message);
  refreshIcons();
});

let overviewRefreshInFlight = false;
setInterval(async () => {
  if (document.hidden || state.view !== "overview" || overviewRefreshInFlight || document.activeElement?.matches("input, textarea, select")) return;
  overviewRefreshInFlight = true;
  try {
    const [health, operations, contactQueues, inventory] = await Promise.all([
      api("/api/health"), api("/api/ops/tasks"), api("/api/contact-queues"), api("/api/pipeline/inventory"),
    ]);
    state.health = health;
    state.operationTasks = operations.items || [];
    state.contactQueues = contactQueues.items || [];
    state.inventory = inventory;
    render();
  } catch {} finally {
    overviewRefreshInFlight = false;
  }
}, 30_000);
