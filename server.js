const express = require("express");
const cors = require("cors");
const fs = require("fs");
const config = require("./config");
const { notFound, errorHandler } = require("./errors");

const instanceRoutes = require("./routes/instances");
const campaignRoutes = require("./routes/campaigns");

fs.mkdirSync(config.upload.dir, { recursive: true });
fs.mkdirSync(config.paths.reportsDir, { recursive: true });

const app = express();

app.disable("x-powered-by");

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(cors({
  origin: function(origin, callback) {
    const allowed = config.allowedOrigins;

    if (!origin || allowed.includes("*") || allowed.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("Origem não permitida pelo CORS."));
  }
}));

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "Lungo Broadcast API",
    version: "1.0.0"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "online",
    time: new Date().toISOString()
  });
});

app.use("/api/instances", instanceRoutes);
app.use("/api/campaigns", campaignRoutes);

app.use(notFound);
app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`Lungo Broadcast API online na porta ${config.port}`);
  console.log(`Ambiente: ${config.nodeEnv}`);
});
