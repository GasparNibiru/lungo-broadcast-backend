class AppError extends Error {
  constructor(message, statusCode = 400, details = null) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

function notFound(req, res) {
  res.status(404).json({
    ok: false,
    error: "Rota não encontrada."
  });
}

function errorHandler(error, req, res, next) {
  if (error instanceof AppError) {
    return res.status(error.statusCode).json({
      ok: false,
      error: error.message,
      details: error.details
    });
  }

  if (error && error.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      ok: false,
      error: "Arquivo muito grande."
    });
  }

  console.error("[ERROR]", error);

  return res.status(500).json({
    ok: false,
    error: "Erro interno no servidor."
  });
}

module.exports = {
  AppError,
  notFound,
  errorHandler
};
