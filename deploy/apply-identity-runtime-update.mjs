import fs from "node:fs";
import path from "node:path";

const root = process.argv[2];
if (root !== "/opt/dakings-prospect-ops") throw new Error("unexpected project root");

const runtimeDir = path.join(root, "deploy", "runtime-data");
const sourceDir = path.join(root, "deploy", "identity-source");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, value) => {
  const temporary = `${file}.identity-update`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o640 });
  fs.renameSync(temporary, file);
};

const sourceProfile = read(path.join(sourceDir, "sender-profile.json"));
if (sourceProfile.companyLegalNameZh !== "广州华锐文化创意有限公司" || sourceProfile.unifiedSocialCreditCode !== "91440112MADC5UTQ82") {
  throw new Error("identity source validation failed");
}
const runtimeProfilePath = path.join(runtimeDir, "sender-profile.json");
write(runtimeProfilePath, { ...read(runtimeProfilePath), ...sourceProfile });

const runtimeAccountsPath = path.join(runtimeDir, "sender-accounts.json");
const accounts = read(runtimeAccountsPath);
for (const domain of accounts.domains || []) {
  for (const account of domain.accounts || []) account.displayName = "DaKings Printing Company";
}
write(runtimeAccountsPath, accounts);

const sourceCampaigns = new Map(read(path.join(sourceDir, "campaigns.json")).map((campaign) => [campaign.id, campaign]));
const sourceCampaignsByName = new Map([...sourceCampaigns.values()].map((campaign) => [campaign.name, campaign]));
const runtimeCampaignsPath = path.join(runtimeDir, "campaigns.json");
const campaigns = read(runtimeCampaignsPath);
const updatedAt = new Date().toISOString();
for (const campaign of campaigns) {
  const source = sourceCampaigns.get(campaign.id) || sourceCampaignsByName.get(campaign.name);
  if (!source) continue;
  campaign.subject = source.subject;
  campaign.body = source.body;
  campaign.status = "draft";
  campaign.updatedAt = updatedAt;
  campaign.scheduleAt = null;
  campaign.approvedAt = null;
  campaign.approvedBy = null;
  campaign.recipientSnapshot = null;
  campaign.audit = [...(campaign.audit || []), { at: updatedAt, action: "verified_company_identity_applied" }];
}
write(runtimeCampaignsPath, campaigns);

console.log(JSON.stringify({
  companyLegalNameZh: sourceProfile.companyLegalNameZh,
  companyLegalName: sourceProfile.companyLegalName,
  companyDisplayName: sourceProfile.companyDisplayName,
  campaignsUpdated: campaigns.filter((campaign) => sourceCampaigns.has(campaign.id) || sourceCampaignsByName.has(campaign.name)).length,
}));
