const DEFAULT_CONFIG = Object.freeze({ enabled: false, targetCountries: [], businessKeywords: [], excludeKeywords: [], targetHsCodes: [], allowedCompanyTypes: [], minimumScore: 0 });
const text = (value) => String(value || "").trim();
const list = (value) => Array.isArray(value) ? value.map(text).filter(Boolean) : [];
function normalizeConfig(input = {}) {
  const minimumScore = Number(input.minimumScore);
  return {
    enabled: Boolean(input.enabled),
    targetCountries: list(input.targetCountries),
    businessKeywords: list(input.businessKeywords),
    excludeKeywords: list(input.excludeKeywords),
    targetHsCodes: list(input.targetHsCodes),
    allowedCompanyTypes: list(input.allowedCompanyTypes),
    minimumScore: Number.isFinite(minimumScore) ? Math.max(0, Math.min(100, minimumScore)) : 0
  };
}
function scoreCompany(company, input = {}) {
  const config = normalizeConfig(input); const haystack = [company.company, company.country, ...(company.productDescriptions || []), company.productDescription, company.entityType].map(text).join(" ").toLowerCase();
  const country = !config.targetCountries.length || config.targetCountries.some((item) => text(company.country).toLowerCase() === item.toLowerCase());
  const business = !config.businessKeywords.length || config.businessKeywords.some((item) => haystack.includes(item.toLowerCase()));
  const excluded = config.excludeKeywords.some((item) => haystack.includes(item.toLowerCase()));
  const companyHs = list([...(Array.isArray(company.hsCodes) ? company.hsCodes : []), company.hsCode]);
  const hs = !config.targetHsCodes.length || companyHs.some((code) => config.targetHsCodes.some((target) => text(code).toLowerCase() === target.toLowerCase()));
  const companyType = !config.allowedCompanyTypes.length || config.allowedCompanyTypes.some((type) => text(company.entityType).toLowerCase() === type.toLowerCase());
  const purchase = Number(company.transactions || 0) > 0 || Number(company.amountUsd || 0) > 0;
  const reasons = [];
  reasons.push(country ? "target_country" : "country_mismatch");
  reasons.push(hs ? "matched_hscode" : "hscode_mismatch");
  reasons.push(business ? "buyer_keyword" : "business_mismatch");
  reasons.push(companyType ? "buyer_type" : "company_type_mismatch");
  if (purchase) reasons.push("purchase_record");
  if (excluded) reasons.push("excluded_logistics");
  const score = config.enabled ? Math.min(100, (country ? 30 : 0) + (hs ? 30 : 0) + (business ? 20 : 0) + (purchase ? 20 : 0) + (companyType ? 10 : 0)) : 100;
  const passed = !config.enabled || (country && hs && business && companyType && !excluded && score >= config.minimumScore);
  return { passed, score, reasons };
}
function qualifyBuyers(buyerData, input = {}) { const config = normalizeConfig(input); return { ...buyerData, buyers: (buyerData.buyers || []).map((buyer) => ({ ...buyer, qualification: scoreCompany(buyer, config) })), qualification: { enabled: config.enabled, config } }; }
export { DEFAULT_CONFIG, normalizeConfig, qualifyBuyers, scoreCompany };
