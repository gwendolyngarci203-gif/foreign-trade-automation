const KEYWORD_MIN_LENGTH = 2;
const KEYWORD_MAX_LENGTH = 120;
const COUNTRY_MAX_LENGTH = 80;
const BUSINESS_KEYWORD_MAX = 8;

export function normalizeKeyword(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, KEYWORD_MAX_LENGTH);
}

export function validateKeyword(value) {
  const keyword = normalizeKeyword(value);
  if (keyword.length < KEYWORD_MIN_LENGTH) throw new Error("关键词至少需要2个字符");
  return keyword;
}

export function normalizeCountry(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, COUNTRY_MAX_LENGTH);
}

export function validateCountry(value) {
  const country = normalizeCountry(value);
  if (country.length < 2) throw new Error("目标国家至少需要2个字符");
  return country;
}

export function normalizeBusinessKeywords(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[,，;；\n]/);
  return [...new Set(values.map((item) => normalizeKeyword(item)).filter(Boolean))].slice(0, BUSINESS_KEYWORD_MAX);
}

export function validateBusinessKeywords(value) {
  const keywords = normalizeBusinessKeywords(value);
  if (!keywords.length) throw new Error("至少需要一个业务范围关键词");
  if (keywords.some((keyword) => keyword.length < KEYWORD_MIN_LENGTH)) {
    throw new Error("业务范围关键词至少需要2个字符");
  }
  return keywords;
}

export function buildKeywordSearchUrl(keyword, direction = "buyer") {
  const query = validateKeyword(keyword);
  const page = direction === "supplier" ? "supplierSearch" : "globalSearch";
  return `https://waimao.office.163.com/#wmData?page=${page}&keyword=${encodeURIComponent(query)}`;
}

export function keywordCollectionManifest(input = {}) {
  const keyword = validateKeyword(input.keyword);
  const direction = input.direction === "supplier" ? "supplier" : "buyer";
  return {
    mode: "keyword",
    keyword,
    direction,
    searchUrl: buildKeywordSearchUrl(keyword, direction),
    framework: "contact-collection-queue",
    requiredSignals: ["captcha", "frequent_operation", "permission", "http_403", "http_429"],
  };
}

export function countryBusinessCollectionManifest(input = {}) {
  const country = validateCountry(input.country);
  const businessKeywords = validateBusinessKeywords(input.businessKeywords || input.businessScope);
  const direction = input.direction === "supplier" ? "supplier" : "buyer";
  const businessQuery = businessKeywords.join(" ");
  return {
    mode: "country_business",
    country,
    businessKeywords,
    businessQuery,
    direction,
    searchUrl: buildKeywordSearchUrl(businessQuery, direction),
    filter: { country, match: "country_alias_or_visible_country_cell" },
    framework: "contact-collection-queue",
    requiredSignals: ["captcha", "frequent_operation", "permission", "http_403", "http_429"],
  };
}

export function marketTargetProfile(input = {}) {
  return {
    enabled: input.enabled === true,
    country: validateCountry(input.country),
    industryKeywords: validateBusinessKeywords(input.industryKeywords),
    excludeKeywords: normalizeBusinessKeywords(input.excludeKeywords),
    direction: input.direction === "supplier" ? "supplier" : "buyer",
  };
}

export function marketTargetDiscoveryInputs(input = {}) {
  const profile = marketTargetProfile(input);
  if (!profile.enabled) return [];
  return profile.industryKeywords.map((keyword) => ({
    country: profile.country,
    businessKeywords: [keyword],
    excludeKeywords: profile.excludeKeywords,
    direction: profile.direction,
  }));
}

export function countryBusinessDiscoveryArtifact(input = {}) {
  const manifest = countryBusinessCollectionManifest(input);
  const excludeKeywords = normalizeBusinessKeywords(input.excludeKeywords);
  const records = (Array.isArray(input.records) ? input.records : []).filter((record) => {
    const text = [record.company, ...(record.cells || [])].join(" ").toLowerCase();
    return !excludeKeywords.some((keyword) => text.includes(keyword.toLowerCase()));
  });
  const pageNumber = Math.max(Number.parseInt(input.pageNumber || "1", 10) || 1, 1);
  return {
    schemaVersion: 1,
    kind: "netease-country-business-discovery",
    query: manifest.businessQuery,
    normalizedBusinessKeywords: manifest.businessKeywords,
    country: manifest.country,
    direction: manifest.direction,
    capturedAt: input.capturedAt || new Date().toISOString(),
    dynamicSnapshot: true,
    pagination: { pageNumber, visibleRows: records.length, sourceRows: Number(input.sourceRows ?? records.length) },
    source: { platform: "网易外贸通", page: `关键词检索/${manifest.direction === "supplier" ? "供应商" : "采购商"}`, url: input.url || manifest.searchUrl, query: manifest.businessQuery, direction: manifest.direction, country: manifest.country, businessKeywords: manifest.businessKeywords, resultTotal: Number(input.resultTotal || 0), pageNumber, visibleRows: records.length },
    safety: { ...(input.safety || {}), hiddenApiUsed: false, deepMiningUsed: false, countryFilterApplied: true },
    discoveryFilter: { excludeKeywords, excludedRows: Math.max(0, (Array.isArray(input.records) ? input.records.length : 0) - records.length) },
    records: records.map((record) => ({ ...record, hsCode: "", productDescription: manifest.businessKeywords.join(", ") })),
  };
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}`) {
  const [keyword, direction] = process.argv.slice(2);
  console.log(JSON.stringify(keywordCollectionManifest({ keyword, direction }), null, 2));
}
