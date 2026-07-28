const { randomUUID } = require("crypto");
const config = require("../config");
const store = require("../store");
const evolution = require("./evolution");
const { renderMessage } = require("../utils/contacts");
const { AppError } = require("../errors");

function now() {
  return new Date().toISOString();
}

function randomDelay(minDelayMs, maxDelayMs) {
  const min = Number(minDelayMs || config.campaigns.defaultMinDelayMs);
  const max = Number(maxDelayMs || config.campaigns.defaultMaxDelayMs);

  if (max <= min) return min;

  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function publicCampaign(campaign) {
  return {
    id: campaign.id,
    userId: campaign.userId,
    clientName: campaign.clientName,
    status: campaign.status,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
    startedAt: campaign.startedAt,
    finishedAt: campaign.finishedAt,
    stoppedAt: campaign.stoppedAt,
    stats: campaign.stats,
    progress: campaign.progress,
    activity: campaign.activity.slice(-40).reverse()
  };
}

function addActivity(campaign, message, level = "info") {
  campaign.activity.push({
    at: now(),
    level,
    message
  });
  campaign.updatedAt = now();
}

async function processNext(campaign) {
  if (campaign.status !== "running") return;

  const nextContact = campaign.contacts.find((contact) => contact.status === "pending");

  if (!nextContact) {
    campaign.status = "completed";
    campaign.finishedAt = now();
    campaign.updatedAt = now();
    campaign.progress.pending = 0;
    addActivity(campaign, "Campanha concluída.");
    return;
  }

  nextContact.status = "sending";
  campaign.updatedAt = now();

  try {
    const text = renderMessage(campaign.message, nextContact.row, nextContact.number);

    if (!text) {
      throw new AppError("Mensagem vazia após aplicar variáveis.", 400);
    }

    await evolution.sendTextMessage(campaign.instanceName, nextContact.number, text);

    nextContact.status = "sent";
    nextContact.sentAt = now();
    campaign.progress.sent += 1;
    addActivity(campaign, `Mensagem enviada para ${nextContact.number}.`);
  } catch (error) {
    nextContact.status = "error";
    nextContact.error = error.message || "Erro desconhecido.";
    campaign.progress.errors += 1;
    addActivity(campaign, `Erro ao enviar para ${nextContact.number}: ${nextContact.error}`, "error");
  }

  campaign.progress.pending = Math.max(campaign.stats.valid - campaign.progress.sent - campaign.progress.errors, 0);
  campaign.updatedAt = now();

  if (campaign.status !== "running") return;

  const remaining = campaign.contacts.some((contact) => contact.status === "pending");

  if (!remaining) {
    campaign.status = "completed";
    campaign.finishedAt = now();
    campaign.updatedAt = now();
    addActivity(campaign, "Campanha concluída.");
    return;
  }

  const delay = randomDelay(campaign.minDelayMs, campaign.maxDelayMs);

  campaign.timer = setTimeout(() => {
    processNext(campaign).catch((error) => {
      console.error("[CAMPAIGN_PROCESS_ERROR]", error);
      campaign.status = "error";
      addActivity(campaign, error.message || "Erro inesperado no processamento.", "error");
    });
  }, delay);
}

async function createAndStartCampaign({ instanceConfig, contacts, rejected, stats, message, fileOriginalName }) {
  const maxContacts = instanceConfig.maxContactsPerCampaign || config.campaigns.defaultMaxContactsPerCampaign;

  if (!contacts.length) {
    throw new AppError("Nenhum contato válido encontrado na planilha.", 400, stats);
  }

  if (contacts.length > maxContacts) {
    throw new AppError(`A campanha possui ${contacts.length} contatos válidos, acima do limite de ${maxContacts}.`, 413, {
      validContacts: contacts.length,
      maxContacts
    });
  }

  await evolution.assertInstanceConnected(instanceConfig.instanceName);

  const campaign = {
    id: randomUUID(),
    userId: instanceConfig.userId,
    instanceName: instanceConfig.instanceName,
    clientName: instanceConfig.clientName,
    status: "running",
    fileOriginalName,
    message,
    contacts,
    rejected,
    stats,
    progress: {
      sent: 0,
      pending: stats.valid,
      errors: 0
    },
    activity: [],
    timer: null,
    minDelayMs: instanceConfig.minDelayMs,
    maxDelayMs: instanceConfig.maxDelayMs,
    createdAt: now(),
    updatedAt: now(),
    startedAt: now(),
    finishedAt: null,
    stoppedAt: null
  };

  addActivity(campaign, "Campanha criada.");
  addActivity(campaign, "Instância autorizada e conectada.");
  addActivity(campaign, "Fila de envio iniciada.");

  store.saveCampaign(campaign);

  processNext(campaign).catch((error) => {
    console.error("[CAMPAIGN_START_ERROR]", error);
    campaign.status = "error";
    addActivity(campaign, error.message || "Erro inesperado ao iniciar campanha.", "error");
  });

  return publicCampaign(campaign);
}

function stopCampaign(id) {
  const campaign = store.getCampaign(id);

  if (!campaign) {
    throw new AppError("Campanha não encontrada.", 404);
  }

  if (!["running", "paused"].includes(campaign.status)) {
    return publicCampaign(campaign);
  }

  if (campaign.timer) {
    clearTimeout(campaign.timer);
    campaign.timer = null;
  }

  const sending = campaign.contacts.find((contact) => contact.status === "sending");
  if (sending) sending.status = "pending";

  campaign.status = "stopped";
  campaign.stoppedAt = now();
  campaign.updatedAt = now();
  campaign.progress.pending = campaign.contacts.filter((contact) => contact.status === "pending").length;

  addActivity(campaign, "Campanha interrompida pelo usuário.");

  return publicCampaign(campaign);
}

function getCampaignStatus(id) {
  const campaign = store.getCampaign(id);

  if (!campaign) {
    throw new AppError("Campanha não encontrada.", 404);
  }

  return publicCampaign(campaign);
}

function campaignReportCsv(id) {
  const campaign = store.getCampaign(id);

  if (!campaign) {
    throw new AppError("Campanha não encontrada.", 404);
  }

  const rows = [
    ["campaign_id", "client_name", "user_id", "instance_name", "number", "status", "sent_at", "error", "line"]
  ];

  campaign.contacts.forEach((contact) => {
    rows.push([
      campaign.id,
      campaign.clientName,
      campaign.userId,
      campaign.instanceName,
      contact.number,
      contact.status,
      contact.sentAt || "",
      contact.error || "",
      contact.line || ""
    ]);
  });

  campaign.rejected.forEach((item) => {
    rows.push([
      campaign.id,
      campaign.clientName,
      campaign.userId,
      campaign.instanceName,
      item.rawPhone || "",
      item.reason,
      "",
      item.reason,
      item.line || ""
    ]);
  });

  return rows.map((row) => row.map((value) => {
    const str = String(value ?? "");
    return `"${str.replace(/"/g, '""')}"`;
  }).join(",")).join("\n");
}

module.exports = {
  createAndStartCampaign,
  stopCampaign,
  getCampaignStatus,
  campaignReportCsv
};
