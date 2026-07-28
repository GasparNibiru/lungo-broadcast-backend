const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

const rootDir = path.resolve(__dirname, "..");

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).toLowerCase() === "true";
}

function getAllowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS || "*";
  return raw.split(",").map((origin) => origin.trim()).filter(Boolean);
}

const config = {
  port: toNumber(process.env.PORT, 3333),
  nodeEnv: process.env.NODE_ENV || "development",
  allowedOrigins: getAllowedOrigins(),

  evolution: {
    baseUrl: (process.env.EVOLUTION_BASE_URL || "").replace(/\/+$/, ""),
    apiKey: process.env.EVOLUTION_API_KEY || "",
    connectionPath: process.env.EVOLUTION_CONNECTION_PATH || "/instance/connectionState/:instanceName",
    sendTextPath: process.env.EVOLUTION_SEND_TEXT_PATH || "/message/sendText/:instanceName",
    messageDelayMs: toNumber(process.env.EVOLUTION_MESSAGE_DELAY_MS, 0),
    skipConnectionCheck: toBoolean(process.env.SKIP_CONNECTION_CHECK, false)
  },

  upload: {
    maxUploadMb: toNumber(process.env.MAX_UPLOAD_MB, 10),
    dir: path.join(rootDir, "storage", "uploads")
  },

  campaigns: {
    defaultMinDelayMs: toNumber(process.env.DEFAULT_MIN_DELAY_MS, 8000),
    defaultMaxDelayMs: toNumber(process.env.DEFAULT_MAX_DELAY_MS, 25000),
    defaultMaxContactsPerCampaign: toNumber(process.env.DEFAULT_MAX_CONTACTS_PER_CAMPAIGN, 5000)
  },

  paths: {
    rootDir,
    dataDir: path.join(rootDir, "data"),
    instancesFile: path.join(rootDir, "data", "instances.json"),
    reportsDir: path.join(rootDir, "storage", "reports")
  }
};

module.exports = config;
