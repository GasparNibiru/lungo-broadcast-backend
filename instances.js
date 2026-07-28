const express = require("express");
const store = require("../store");
const evolution = require("../services/evolution");
const { AppError } = require("../errors");

const router = express.Router();

router.post("/validate", async (req, res, next) => {
  try {
    const userId = String(req.body.userId || "").trim();

    if (!userId) {
      throw new AppError("Informe o ID de usuário.", 400);
    }

    const instanceConfig = store.findAuthorizedInstance(userId);

    if (!instanceConfig) {
      throw new AppError("ID de usuário não autorizado.", 403);
    }

    const connection = await evolution.getConnectionState(instanceConfig.instanceName);

    res.json({
      ok: true,
      userId: instanceConfig.userId,
      clientName: instanceConfig.clientName,
      state: connection.state,
      connected: ["open", "connected", "online"].includes(String(connection.state).toLowerCase())
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
