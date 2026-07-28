const axios = require("axios");
const config = require("../config");
const { AppError } = require("../errors");

function assertEvolutionConfig() {
  if (!config.evolution.baseUrl) {
    throw new AppError("EVOLUTION_BASE_URL não configurado no .env.", 500);
  }

  if (!config.evolution.apiKey) {
    throw new AppError("EVOLUTION_API_KEY não configurado no .env.", 500);
  }
}

function buildUrl(pathTemplate, instanceName) {
  const encodedInstance = encodeURIComponent(instanceName);
  const path = pathTemplate
    .replace(":instanceName", encodedInstance)
    .replace("{instanceName}", encodedInstance)
    .replace(":instance", encodedInstance)
    .replace("{instance}", encodedInstance);

  return `${config.evolution.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

function headers() {
  return {
    "Content-Type": "application/json",
    "apikey": config.evolution.apiKey
  };
}

async function getConnectionState(instanceName) {
  assertEvolutionConfig();

  const url = buildUrl(config.evolution.connectionPath, instanceName);

  try {
    const response = await axios.get(url, {
      headers: headers(),
      timeout: 20000
    });

    const data = response.data || {};
    const state = data?.instance?.state || data?.state || data?.connectionState || "unknown";

    return {
      ok: true,
      state,
      raw: data
    };
  } catch (error) {
    const status = error.response?.status || 500;
    const details = error.response?.data || error.message;

    throw new AppError("Não foi possível validar a instância na Evolution API.", status, details);
  }
}

async function assertInstanceConnected(instanceName) {
  if (config.evolution.skipConnectionCheck) {
    return {
      ok: true,
      state: "skipped"
    };
  }

  const result = await getConnectionState(instanceName);
  const state = String(result.state || "").toLowerCase();
  const connectedStates = ["open", "connected", "online"];

  if (!connectedStates.includes(state)) {
    throw new AppError(`A instância "${instanceName}" não está conectada. Estado atual: ${result.state}.`, 409, result.raw);
  }

  return result;
}

async function sendTextMessage(instanceName, number, text) {
  assertEvolutionConfig();

  const url = buildUrl(config.evolution.sendTextPath, instanceName);

  const payload = {
    number,
    textMessage: {
      text
    },
    delay: config.evolution.messageDelayMs,
    linkPreview: false
  };

  try {
    const response = await axios.post(url, payload, {
      headers: headers(),
      timeout: 30000
    });

    return response.data;
  } catch (error) {
    const status = error.response?.status || 500;
    const details = error.response?.data || error.message;

    throw new AppError("Falha ao enviar mensagem pela Evolution API.", status, details);
  }
}

module.exports = {
  getConnectionState,
  assertInstanceConnected,
  sendTextMessage
};
