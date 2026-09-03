const integer = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : fallback;
};

export function resolveCompanyProcessingStrategy(state = {}, config = {}) {
  const legacyTarget = integer(state.legacyTarget, 100);
  const enabled = config.enabled === true || String(config.enabled || "").toLowerCase() === "true";
  return {
    enabled,
    strategy: "fixed",
    label: "固定模式",
    dailyCompanyTarget: enabled ? integer(config.target, legacyTarget) : legacyTarget,
    fallback: "validEmailCompaniesDaily",
  };
}

// Names reserved for future strategies; they are not selectable yet.
export const STRATEGY_TYPES = Object.freeze([
  "fixed",
  "inventory",
  "qualification",
  "capacity",
]);
