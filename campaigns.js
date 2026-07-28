const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const config = require("../config");
const store = require("../store");
const { AppError } = require("../errors");
const { parseContactsFromFile } = require("../utils/contacts");
const campaignRunner = require("../services/campaignRunner");

const router = express.Router();

const storage = multer.diskStorage({
  destination: function(req, file, cb) {
    fs.mkdirSync(config.upload.dir, { recursive: true });
    cb(null, config.upload.dir);
  },
  filename: function(req, file, cb) {
    const safeOriginal = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}-${safeOriginal}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: config.upload.maxUploadMb * 1024 * 1024
  },
  fileFilter: function(req, file, cb) {
    const allowed = [".xlsx", ".xls", ".csv"];
    const ext = path.extname(file.originalname).toLowerCase();

    if (!allowed.includes(ext)) {
      return cb(new AppError("Formato inválido. Use XLSX, XLS ou CSV.", 400));
    }

    cb(null, true);
  }
});

router.post("/start", upload.single("file"), async (req, res, next) => {
  try {
    const userId = String(req.body.userId || "").trim();
    const message = String(req.body.message || "").trim();

    if (!userId) {
      throw new AppError("Informe o ID de usuário.", 400);
    }

    if (!message) {
      throw new AppError("Informe a mensagem de envio.", 400);
    }

    if (!req.file) {
      throw new AppError("Envie uma planilha de contatos.", 400);
    }

    const instanceConfig = store.findAuthorizedInstance(userId);

    if (!instanceConfig) {
      throw new AppError("ID de usuário não autorizado.", 403);
    }

    const parsed = parseContactsFromFile(req.file.path);

    const campaign = await campaignRunner.createAndStartCampaign({
      instanceConfig,
      contacts: parsed.contacts,
      rejected: parsed.rejected,
      stats: parsed.stats,
      message,
      fileOriginalName: req.file.originalname
    });

    res.status(201).json({
      ok: true,
      campaign
    });
  } catch (error) {
    next(error);
  }
});

router.get("/:id/status", (req, res, next) => {
  try {
    const campaign = campaignRunner.getCampaignStatus(req.params.id);

    res.json({
      ok: true,
      campaign
    });
  } catch (error) {
    next(error);
  }
});

router.post("/:id/stop", (req, res, next) => {
  try {
    const campaign = campaignRunner.stopCampaign(req.params.id);

    res.json({
      ok: true,
      campaign
    });
  } catch (error) {
    next(error);
  }
});

router.get("/:id/report.csv", (req, res, next) => {
  try {
    const csv = campaignRunner.campaignReportCsv(req.params.id);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="campanha-${req.params.id}.csv"`);
    res.send(`\uFEFF${csv}`);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
