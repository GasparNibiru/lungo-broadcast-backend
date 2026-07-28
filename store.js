const fs = require("fs");
const config = require("./config");

const campaigns = new Map();

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function loadInstances() {
  if (!fs.existsSync(config.paths.instancesFile)) return [];

  try {
    const raw = fs.readFileSync(config.paths.instancesFile, "utf8");
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) return [];

    return parsed.map((item) => ({
      userId: String(item.userId || "").trim(),
      instanceName: String(item.instanceName || "").trim(),
      clientName: String(item.clientName || item.userId || "").trim(),
      enabled: item.enabled === true,
      maxContactsPerCampaign: Number(item.maxContactsPerCampaign || config.campaigns.defaultMaxContactsPerCampaign),
      minDelayMs: Number(item.minDelayMs || config.campaigns.defaultMinDelayMs),
      maxDelayMs: Number(item.maxDelayMs || config.campaigns.defaultMaxDelayMs)
    }));
  } catch (error) {
    console.error("[INSTANCES_FILE_ERROR]", error);
    return [];
  }
}

function findAuthorizedInstance(userId) {
  const clean = normalize(userId);
  const instances = loadInstances();

  return instances.find((item) => normalize(item.userId) === clean && item.enabled);
}

function saveCampaign(campaign) {
  campaigns.set(campaign.id, campaign);
  return campaign;
}

function getCampaign(id) {
  return campaigns.get(id);
}

function listCampaigns() {
  return Array.from(campaigns.values());
}

module.exports = {
  loadInstances,
  findAuthorizedInstance,
  saveCampaign,
  getCampaign,
  listCampaigns
};
