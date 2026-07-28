const XLSX = require("xlsx");

function normalizeKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizePhone(value) {
  let digits = String(value ?? "").replace(/\D/g, "");

  if (digits.startsWith("00")) {
    digits = digits.slice(2);
  }

  if ((digits.length === 10 || digits.length === 11) && !digits.startsWith("55")) {
    digits = `55${digits}`;
  }

  return digits;
}

function isValidPhone(phone) {
  return /^55\d{10,11}$/.test(phone) || /^\d{10,13}$/.test(phone);
}

function findPhoneColumn(rows) {
  if (!rows.length) return null;

  const keys = Object.keys(rows[0]);
  const aliases = ["telefone", "whatsapp", "celular", "fone", "numero", "número", "phone", "contato"];

  return keys.find((key) => {
    const normalized = normalizeKey(key);
    return aliases.some((alias) => normalized.includes(normalizeKey(alias)));
  }) || keys[0];
}

function buildVariableMap(row, normalizedPhone) {
  const variables = {};

  Object.entries(row).forEach(([key, value]) => {
    const normalized = normalizeKey(key);
    variables[normalized] = String(value ?? "").trim();
    variables[key] = String(value ?? "").trim();
  });

  variables.telefone = normalizedPhone;
  variables.whatsapp = normalizedPhone;
  variables.numero = normalizedPhone;

  return variables;
}

function renderMessage(template, row, normalizedPhone) {
  const variables = buildVariableMap(row, normalizedPhone);

  return String(template || "").replace(/\{([^}]+)\}/g, (match, key) => {
    const normalized = normalizeKey(key);
    return variables[normalized] ?? variables[key] ?? "";
  }).trim();
}

function parseContactsFromFile(filePath) {
  const workbook = XLSX.readFile(filePath, {
    cellDates: false,
    raw: false
  });

  const firstSheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[firstSheetName];

  if (!sheet) {
    return {
      contacts: [],
      rejected: [],
      stats: {
        total: 0,
        valid: 0,
        duplicate: 0,
        invalid: 0
      }
    };
  }

  const rows = XLSX.utils.sheet_to_json(sheet, {
    defval: "",
    raw: false
  });

  const phoneColumn = findPhoneColumn(rows);
  const seen = new Set();
  const contacts = [];
  const rejected = [];

  rows.forEach((row, index) => {
    const rawPhone = phoneColumn ? row[phoneColumn] : "";
    const number = normalizePhone(rawPhone);
    const line = index + 2;

    if (!isValidPhone(number)) {
      rejected.push({
        line,
        reason: "invalid_phone",
        rawPhone,
        row
      });
      return;
    }

    if (seen.has(number)) {
      rejected.push({
        line,
        reason: "duplicate_phone",
        rawPhone,
        row
      });
      return;
    }

    seen.add(number);

    contacts.push({
      line,
      number,
      row,
      status: "pending",
      error: null,
      sentAt: null
    });
  });

  const invalid = rejected.filter((item) => item.reason === "invalid_phone").length;
  const duplicate = rejected.filter((item) => item.reason === "duplicate_phone").length;

  return {
    contacts,
    rejected,
    stats: {
      total: rows.length,
      valid: contacts.length,
      duplicate,
      invalid
    }
  };
}

module.exports = {
  normalizeKey,
  normalizePhone,
  isValidPhone,
  parseContactsFromFile,
  renderMessage
};
