require("dotenv").config();

const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.VERCEL ? path.join("/tmp", "ansury-ai-data") : path.join(__dirname, "data");
const LEADS_FILE = path.join(DATA_DIR, "leads.json");

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
const ANTHROPIC_VERSION = process.env.ANTHROPIC_VERSION || "2023-06-01";

const CAL_API_URL = "https://api.cal.com/v2";
const CAL_API_VERSION = process.env.CAL_API_VERSION || "2026-02-25";
const CAL_VERSION_CANDIDATES = [CAL_API_VERSION, "2026-02-25", "2024-09-04", "2024-06-14"];
const AIRTABLE_API_URL = "https://api.airtable.com/v0";

const FALLBACK_WHATSAPP = process.env.FALLBACK_WHATSAPP || "+97400000000";
const FALLBACK_EMAIL = process.env.FALLBACK_EMAIL || "hello@ansury.ai";
const CRM_WEBHOOK_URL = process.env.CRM_WEBHOOK_URL || "";
const AIRTABLE_PAT = process.env.AIRTABLE_PAT || process.env.AIRTABLE_TOKEN || "";
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || "";
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || "";
const AIRTABLE_TABLE_ID = process.env.AIRTABLE_TABLE_ID || "";
const TALLY_ROLLOUT_FORM_ID = process.env.TALLY_ROLLOUT_FORM_ID || "";
const TALLY_ROLLOUT_FORM_URL = process.env.TALLY_ROLLOUT_FORM_URL || (TALLY_ROLLOUT_FORM_ID ? `https://tally.so/r/${TALLY_ROLLOUT_FORM_ID}` : "");
const TALLY_DEMO_FORM_ID = process.env.TALLY_DEMO_FORM_ID || "";
const TALLY_DEMO_FORM_URL = process.env.TALLY_DEMO_FORM_URL || (TALLY_DEMO_FORM_ID ? `https://tally.so/r/${TALLY_DEMO_FORM_ID}` : "");
const TALLY_WEBHOOK_SIGNING_SECRET = process.env.TALLY_WEBHOOK_SIGNING_SECRET || "";
const AIRTABLE_SYNC_EVENTS = new Set([
  "demo_started",
  "demo_lead_submitted",
  "cta_book_clicked",
  "tally_form_opened",
  "tally_form_submitted",
  "user_message",
  "agent_message",
  "agent_error",
  "booking_intent",
  "booking_intent_detected",
  "prequal_completed",
  "booking_name_captured",
  "booking_email_captured",
  "booking_success",
  "booking_confirmed",
  "booking_failed",
  "booking_error",
  "booking_slots_unavailable",
  "callback_request_submitted",
  "callback_form_sent_client",
  "chat_backend_error",
  "chat_network_error"
]);

const airtableTargetCache = {
  resolved: false,
  baseId: "",
  tableRef: "",
  primaryFieldName: "",
  fieldNames: [],
  tables: []
};

app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "ansury-ai-1.html"));
});

function safeNowIso() {
  return new Date().toISOString();
}

function sanitizeText(value) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 6000);
}

function isValidEmail(value) {
  if (typeof value !== "string") return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function getFallbackContact() {
  return {
    whatsapp: FALLBACK_WHATSAPP,
    email: FALLBACK_EMAIL
  };
}

function sanitizePhone(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[^\d+]/g, "").slice(0, 24);
}

function sanitizeObject(value, depth = 0) {
  if (depth > 4) return null;
  if (value == null) return value;
  if (typeof value === "string") return sanitizeText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeObject(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 80)
        .map(([key, item]) => [sanitizeText(key).slice(0, 120), sanitizeObject(item, depth + 1)])
    );
  }
  return null;
}

function normalizeTallyFields(fields) {
  if (!Array.isArray(fields)) return {};
  return fields.reduce((acc, field) => {
    const label = sanitizeText(field?.label || field?.key || "field").slice(0, 120);
    if (!label) return acc;
    acc[label] = sanitizeObject(field?.value);
    return acc;
  }, {});
}

function verifyTallySignature(req) {
  if (!TALLY_WEBHOOK_SIGNING_SECRET) return true;
  const receivedSignature = String(req.headers["tally-signature"] || "");
  if (!receivedSignature) return false;
  const calculatedSignature = crypto
    .createHmac("sha256", TALLY_WEBHOOK_SIGNING_SECRET)
    .update(JSON.stringify(req.body))
    .digest("base64");
  if (receivedSignature.length !== calculatedSignature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(receivedSignature), Buffer.from(calculatedSignature));
}

function getTallyPublicConfig() {
  return {
    rollout: {
      id: TALLY_ROLLOUT_FORM_ID,
      url: TALLY_ROLLOUT_FORM_URL
    },
    demo: {
      id: TALLY_DEMO_FORM_ID,
      url: TALLY_DEMO_FORM_URL
    }
  };
}

async function ensureStore() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.access(LEADS_FILE);
  } catch (_) {
    const seed = { leads: [] };
    await fs.writeFile(LEADS_FILE, JSON.stringify(seed, null, 2), "utf8");
  }
}

async function readStore() {
  await ensureStore();
  const raw = await fs.readFile(LEADS_FILE, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.leads)) parsed.leads = [];
  return parsed;
}

async function writeStore(store) {
  await fs.writeFile(LEADS_FILE, JSON.stringify(store, null, 2), "utf8");
}

async function updateLeadSession(sessionId, updater) {
  const store = await readStore();
  let lead = store.leads.find((l) => l.sessionId === sessionId);
  if (!lead) {
    lead = {
      sessionId,
      createdAt: safeNowIso(),
      lastActivityAt: safeNowIso(),
      events: [],
      booking: {
        intentDetected: false,
        status: "none"
      }
    };
    store.leads.push(lead);
  }
  updater(lead);
  lead.lastActivityAt = safeNowIso();
  await writeStore(store);
  return lead;
}

async function logLeadEvent(sessionId, eventType, payload) {
  await updateLeadSession(sessionId, (lead) => {
    lead.events.push({
      timestamp: safeNowIso(),
      type: eventType,
      payload
    });
  });

  if (AIRTABLE_PAT && AIRTABLE_SYNC_EVENTS.has(eventType)) {
    await forwardToCRM({
      type: eventType,
      sessionId,
      payload,
      timestamp: safeNowIso()
    });
  }
}

async function upsertBookingState(sessionId, patch) {
  await updateLeadSession(sessionId, (lead) => {
    lead.booking = {
      ...(lead.booking || {}),
      ...patch
    };
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, config = {}) {
  const retries = Number.isInteger(config.retries) ? config.retries : 2;
  const retryDelayMs = Number.isInteger(config.retryDelayMs) ? config.retryDelayMs : 650;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;

      const isRetriable = [429, 500, 502, 503, 504].includes(response.status);
      if (!isRetriable || attempt === retries) return response;
    } catch (error) {
      if (attempt === retries) throw error;
    }
    await delay(retryDelayMs * (attempt + 1));
  }

  throw new Error("Unexpected retry failure.");
}

async function fetchCalApi(pathnameWithQuery, options = {}, versions = CAL_VERSION_CANDIDATES) {
  const uniqueVersions = [...new Set(versions.filter(Boolean))];
  let lastResponse = null;
  let lastData = {};
  let lastVersion = "";

  for (const version of uniqueVersions) {
    const response = await fetchWithRetry(
      `${CAL_API_URL}${pathnameWithQuery}`,
      {
        ...options,
        headers: {
          ...(options.headers || {}),
          Authorization: `Bearer ${process.env.CAL_API_KEY}`,
          "cal-api-version": version
        }
      },
      { retries: 2, retryDelayMs: 600 }
    );

    const data = await response.json().catch(() => ({}));
    if (response.ok) {
      return { response, data, version };
    }

    lastResponse = response;
    lastData = data;
    lastVersion = version;

    if (![404, 400].includes(response.status)) {
      break;
    }
  }

  return { response: lastResponse, data: lastData, version: lastVersion };
}

async function fetchCalApiVersioned(pathnameWithQuery, getOptionsForVersion, versions = CAL_VERSION_CANDIDATES) {
  const uniqueVersions = [...new Set(versions.filter(Boolean))];
  let lastResponse = null;
  let lastData = {};
  let lastVersion = "";

  for (const version of uniqueVersions) {
    const versionedOptions = getOptionsForVersion(version) || {};
    const response = await fetchWithRetry(
      `${CAL_API_URL}${pathnameWithQuery}`,
      {
        ...versionedOptions,
        headers: {
          ...(versionedOptions.headers || {}),
          Authorization: `Bearer ${process.env.CAL_API_KEY}`,
          "cal-api-version": version
        }
      },
      { retries: 2, retryDelayMs: 650 }
    );

    const data = await response.json().catch(() => ({}));
    if (response.ok) {
      return { response, data, version };
    }

    lastResponse = response;
    lastData = data;
    lastVersion = version;

    if (![404, 400].includes(response.status)) {
      break;
    }
  }

  return { response: lastResponse, data: lastData, version: lastVersion };
}

async function resolveAirtableTarget() {
  if (!AIRTABLE_PAT) return null;
  if (airtableTargetCache.resolved) {
    if (!airtableTargetCache.baseId || !airtableTargetCache.tableRef) return null;
    return {
      baseId: airtableTargetCache.baseId,
      tableRef: airtableTargetCache.tableRef,
      primaryFieldName: airtableTargetCache.primaryFieldName,
      fieldNames: airtableTargetCache.fieldNames,
      tables: airtableTargetCache.tables
    };
  }

  try {
    let baseId = AIRTABLE_BASE_ID;
    let tableRef = AIRTABLE_TABLE_ID || AIRTABLE_TABLE_NAME;

    if (!baseId) {
      const basesRes = await fetchWithRetry(`${AIRTABLE_API_URL}/meta/bases`, {
        headers: {
          Authorization: `Bearer ${AIRTABLE_PAT}`
        }
      }, { retries: 1, retryDelayMs: 500 });

      const basesData = await basesRes.json().catch(() => ({}));
      if (!basesRes.ok || !Array.isArray(basesData.bases) || basesData.bases.length === 0) {
        console.warn("[Airtable] Could not list bases for auto-discovery.");
        airtableTargetCache.resolved = true;
        return null;
      }

      baseId = basesData.bases[0].id;
    }

    const tablesRes = await fetchWithRetry(`${AIRTABLE_API_URL}/meta/bases/${baseId}/tables`, {
      headers: {
        Authorization: `Bearer ${AIRTABLE_PAT}`
      }
    }, { retries: 1, retryDelayMs: 500 });

    const tablesData = await tablesRes.json().catch(() => ({}));
    if (!tablesRes.ok || !Array.isArray(tablesData.tables) || tablesData.tables.length === 0) {
      console.warn("[Airtable] Could not list tables for auto-discovery.");
      airtableTargetCache.resolved = true;
      return null;
    }

    let table = null;
    if (tableRef) {
      table = tablesData.tables.find((t) => t.id === tableRef || t.name === tableRef);
    } else {
      const preferred = tablesData.tables.find((t) => t.name.toLowerCase() === "leads");
      table = preferred || tablesData.tables[0];
    }

    if (!table) {
      console.warn("[Airtable] Selected table could not be found.");
      airtableTargetCache.resolved = true;
      return null;
    }

    const fieldNames = Array.isArray(table.fields) ? table.fields.map((f) => f.name) : [];
    const primaryField = Array.isArray(table.fields)
      ? table.fields.find((f) => f.id === table.primaryFieldId)
      : null;

    airtableTargetCache.resolved = true;
    airtableTargetCache.baseId = baseId;
    airtableTargetCache.tableRef = table.id || table.name;
    airtableTargetCache.primaryFieldName = primaryField?.name || "";
    airtableTargetCache.fieldNames = fieldNames;
    airtableTargetCache.tables = tablesData.tables;
    return {
      baseId: airtableTargetCache.baseId,
      tableRef: airtableTargetCache.tableRef,
      primaryFieldName: airtableTargetCache.primaryFieldName,
      fieldNames: airtableTargetCache.fieldNames,
      tables: airtableTargetCache.tables
    };
  } catch (error) {
    console.warn("[Airtable] Auto-discovery failed:", error.message);
    airtableTargetCache.resolved = true;
    return null;
  }
}

function trimForAirtable(value, limit = 100000) {
  if (value === null || value === undefined) return "";
  return String(value).trim().slice(0, limit);
}

function airtableFormulaString(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function findField(table, candidates) {
  const fields = Array.isArray(table?.fields) ? table.fields : [];
  return candidates.find((candidate) => fields.some((field) => field.name === candidate)) || "";
}

function extractLeadIdentity(payload) {
  const nested = payload.payload || {};
  return {
    name: trimForAirtable(payload.attendeeName || nested.name || nested.attendeeName || "", 160),
    email: trimForAirtable(payload.attendeeEmail || nested.email || nested.attendeeEmail || "", 240),
    phone: trimForAirtable(nested.phone || nested.whatsapp || nested.phoneNumber || "", 40),
    message: trimForAirtable(payload.message || nested.text || nested.notes || nested.error || "", 12000),
    slot: trimForAirtable(payload.slot || nested.slot || nested.preferredTime || "", 240)
  };
}

function crmStatusForEvent(eventType) {
  if (eventType === "booking_confirmed" || eventType === "booking_success") return "Booked";
  if (eventType === "callback_request_submitted") return "Callback Requested";
  if (eventType === "prequal_completed") return "Qualified";
  if (eventType === "booking_intent" || eventType === "booking_intent_detected") return "Booking Requested";
  if (eventType.includes("error") || eventType.includes("failed") || eventType.includes("unavailable")) return "Needs Manual Follow-up";
  return "New";
}

function nextActionForEvent(eventType, identity) {
  if (eventType === "booking_confirmed" || eventType === "booking_success") return "Calendar booking confirmed";
  if (eventType === "callback_request_submitted") return `Call back ${identity.slot || "at requested time"}`;
  if (eventType.includes("error") || eventType.includes("failed") || eventType.includes("unavailable")) return "Manual follow-up required";
  if (eventType === "booking_intent" || eventType === "booking_intent_detected") return "Complete booking flow";
  return "Review website chat";
}

async function airtableJson(url, options = {}) {
  const response = await fetchWithRetry(
    url,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${AIRTABLE_PAT}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    },
    { retries: 1, retryDelayMs: 450 }
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${response.status} ${JSON.stringify(data).slice(0, 500)}`);
  }
  return data;
}

async function findAirtableRecord(baseId, tableRef, formula) {
  const params = new URLSearchParams({
    maxRecords: "1",
    filterByFormula: formula
  });
  const data = await airtableJson(`${AIRTABLE_API_URL}/${baseId}/${encodeURIComponent(tableRef)}?${params.toString()}`, {
    method: "GET"
  });
  return Array.isArray(data.records) ? data.records[0] : null;
}

async function createAirtableRecord(baseId, tableRef, fields) {
  const data = await airtableJson(`${AIRTABLE_API_URL}/${baseId}/${encodeURIComponent(tableRef)}`, {
    method: "POST",
    body: JSON.stringify({
      records: [{ fields }],
      typecast: true
    })
  });
  return data.records?.[0] || null;
}

async function updateAirtableRecord(baseId, tableRef, recordId, fields) {
  const data = await airtableJson(`${AIRTABLE_API_URL}/${baseId}/${encodeURIComponent(tableRef)}`, {
    method: "PATCH",
    body: JSON.stringify({
      records: [{ id: recordId, fields }],
      typecast: true
    })
  });
  return data.records?.[0] || null;
}

async function syncAirtableCrm(payload, target) {
  const tables = Array.isArray(target.tables) ? target.tables : [];
  const leadsTable = tables.find((table) => table.name === "Leads");
  const dealsTable = tables.find((table) => table.name === "Deals/Interactions");
  if (!leadsTable || !findField(leadsTable, ["Lead Name"])) return false;

  const sessionId = trimForAirtable(payload.sessionId || crypto.randomUUID(), 120);
  const identity = extractLeadIdentity(payload);
  const leadName = `${identity.name || identity.email || "Website Lead"} - ${sessionId}`;
  const leadNameField = findField(leadsTable, ["Lead Name"]);
  const emailField = findField(leadsTable, ["Email"]);
  const phoneField = findField(leadsTable, ["Phone Number", "Phone"]);
  const sourceField = findField(leadsTable, ["Lead Source"]);
  const languageField = findField(leadsTable, ["Language Preference"]);
  const statusField = findField(leadsTable, ["AI Qualification Status"]);

  let leadRecord = null;
  if (identity.email && emailField) {
    leadRecord = await findAirtableRecord(
      target.baseId,
      leadsTable.id || leadsTable.name,
      `{${emailField}} = '${airtableFormulaString(identity.email)}'`
    );
  }
  if (!leadRecord) {
    leadRecord = await findAirtableRecord(
      target.baseId,
      leadsTable.id || leadsTable.name,
      `FIND('${airtableFormulaString(sessionId)}', {${leadNameField}}) > 0`
    );
  }

  const leadFields = {
    [leadNameField]: leadName
  };
  if (identity.email && emailField) leadFields[emailField] = identity.email;
  if (identity.phone && phoneField) leadFields[phoneField] = identity.phone;
  if (sourceField) leadFields[sourceField] = "Website Chat";
  if (languageField) leadFields[languageField] = "English";
  if (statusField) leadFields[statusField] = crmStatusForEvent(payload.type || "");

  leadRecord = leadRecord
    ? await updateAirtableRecord(target.baseId, leadsTable.id || leadsTable.name, leadRecord.id, leadFields)
    : await createAirtableRecord(target.baseId, leadsTable.id || leadsTable.name, leadFields);

  if (!dealsTable || !leadRecord) return true;

  const dealNameField = findField(dealsTable, ["Deal/Interaction Name"]);
  if (!dealNameField) return true;

  const leadLinkField = findField(dealsTable, ["Lead"]);
  const nextActionField = findField(dealsTable, ["Next Action"]);
  const viewingDateField = findField(dealsTable, ["Viewing Date"]);
  const logField = findField(dealsTable, ["WhatsApp Conversation Log"]);
  const dealName = `Website interaction - ${sessionId}`;
  const dealRef = dealsTable.id || dealsTable.name;
  let dealRecord = await findAirtableRecord(
    target.baseId,
    dealRef,
    `FIND('${airtableFormulaString(sessionId)}', {${dealNameField}}) > 0`
  );

  const logLine = `[${payload.timestamp || safeNowIso()}] ${payload.type || "event"}${identity.message ? `: ${identity.message}` : ""}`;
  const existingLog = trimForAirtable(dealRecord?.fields?.[logField] || "", 90000);
  const dealFields = {
    [dealNameField]: dealName
  };
  if (leadLinkField) dealFields[leadLinkField] = [leadRecord.id];
  if (nextActionField) dealFields[nextActionField] = nextActionForEvent(payload.type || "", identity);
  if (viewingDateField && identity.slot && !Number.isNaN(new Date(identity.slot).getTime())) {
    dealFields[viewingDateField] = new Date(identity.slot).toISOString();
  }
  if (logField) {
    dealFields[logField] = trimForAirtable(existingLog ? `${existingLog}\n${logLine}` : logLine, 90000);
  }

  if (dealRecord) {
    await updateAirtableRecord(target.baseId, dealRef, dealRecord.id, dealFields);
  } else {
    await createAirtableRecord(target.baseId, dealRef, dealFields);
  }

  return true;
}

async function forwardToAirtable(payload) {
  if (!AIRTABLE_PAT) return;

  try {
    const target = await resolveAirtableTarget();
    if (!target) return;

    if (await syncAirtableCrm(payload, target)) return;

    const fieldNames = new Set(Array.isArray(target.fieldNames) ? target.fieldNames : []);
    const eventType = trimForAirtable(payload.type || "event", 120);
    const summary = `${eventType} ${trimForAirtable(payload.sessionId || "", 50)} ${safeNowIso()}`.trim();
    const fields = {};

    if (target.primaryFieldName) {
      fields[target.primaryFieldName] = summary;
    } else if (fieldNames.has("Name")) {
      fields.Name = summary;
    }

    const mapping = [
      { candidates: ["EventType", "Event Type"], value: eventType },
      { candidates: ["SessionId", "Session ID"], value: trimForAirtable(payload.sessionId || "", 120) },
      { candidates: ["Timestamp", "Created At"], value: trimForAirtable(payload.timestamp || safeNowIso(), 64) },
      { candidates: ["Message", "Notes"], value: trimForAirtable(payload.message || payload.payload?.text || "", 5000) },
      { candidates: ["AttendeeName", "Attendee Name", "Name"], value: trimForAirtable(payload.attendeeName || payload.payload?.name || "", 240) },
      { candidates: ["AttendeeEmail", "Attendee Email", "Email"], value: trimForAirtable(payload.attendeeEmail || payload.payload?.email || "", 240) },
      { candidates: ["Slot", "Call Slot"], value: trimForAirtable(payload.slot || payload.payload?.slot || "", 240) },
      { candidates: ["BookingUid", "Booking UID"], value: trimForAirtable(payload.bookingUid || payload.payload?.bookingUid || "", 240) },
      { candidates: ["PayloadJson", "Payload JSON", "Payload"], value: trimForAirtable(JSON.stringify(payload.payload || payload), 90000) }
    ];

    for (const item of mapping) {
      const candidate = item.candidates.find((name) => fieldNames.has(name));
      if (candidate && item.value) {
        fields[candidate] = item.value;
      }
    }

    if (Object.keys(fields).length === 0) {
      console.warn("[Airtable] No writable field mapping found. Set AIRTABLE_TABLE_NAME with compatible fields.");
      return;
    }

    await createAirtableRecord(target.baseId, target.tableRef, fields);
  } catch (error) {
    console.error("[Airtable] write failed:", error.message);
  }
}

async function forwardToCRM(payload) {
  if (CRM_WEBHOOK_URL) {
    try {
      await fetchWithRetry(
        CRM_WEBHOOK_URL,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        },
        { retries: 1, retryDelayMs: 450 }
      );
    } catch (error) {
      console.error("[CRM] webhook failed:", error.message);
    }
  }

  await forwardToAirtable(payload);
}

function assertEnv() {
  const missing = [];
  if (!process.env.ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
  if (!process.env.CAL_API_KEY) missing.push("CAL_API_KEY");
  if (!AIRTABLE_PAT) {
    console.warn("[boot] AIRTABLE_PAT not set. Airtable CRM sync is disabled.");
  } else if (!AIRTABLE_BASE_ID || (!AIRTABLE_TABLE_ID && !AIRTABLE_TABLE_NAME)) {
    console.warn("[boot] AIRTABLE_BASE_ID + AIRTABLE_TABLE_ID/AIRTABLE_TABLE_NAME not fully set. Using Airtable auto-discovery.");
  }
  if (missing.length > 0) {
    console.warn(`[boot] Missing env vars: ${missing.join(", ")}`);
  }
}

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: safeNowIso()
  });
});

app.get("/api/fallback-contact", (_req, res) => {
  res.json({
    fallback: getFallbackContact()
  });
});

app.get("/api/tally/config", (_req, res) => {
  res.json({
    tally: getTallyPublicConfig()
  });
});

app.post("/api/tally/webhook", async (req, res) => {
  if (!verifyTallySignature(req)) {
    return res.status(401).json({ error: "Invalid Tally signature." });
  }

  const data = req.body?.data || {};
  const fields = normalizeTallyFields(data.fields);
  const sessionId = sanitizeText(fields.sessionId || fields["Session ID"] || data.responseId || data.submissionId || crypto.randomUUID());
  const formName = sanitizeText(data.formName || "Tally form");
  const email = sanitizeText(fields["Work email"] || fields.Email || fields.email || "");
  const phone = sanitizePhone(fields["WhatsApp number"] || fields.Phone || fields.phone || "");
  const name = sanitizeText(fields["Your name"] || fields.Name || fields.name || "");

  const payload = {
    provider: "tally",
    formId: sanitizeText(data.formId || ""),
    formName,
    responseId: sanitizeText(data.responseId || data.submissionId || ""),
    submissionPreviewUrl: sanitizeText(data.submissionPreviewUrl || ""),
    fields
  };

  try {
    await logLeadEvent(sessionId, "tally_form_submitted", payload);
    await updateLeadSession(sessionId, (lead) => {
      lead.identity = {
        ...(lead.identity || {}),
        name: name || lead.identity?.name || "",
        email: email || lead.identity?.email || "",
        phone: phone || lead.identity?.phone || ""
      };
      lead.tally = {
        ...(lead.tally || {}),
        lastFormId: payload.formId,
        lastFormName: formName,
        lastResponseId: payload.responseId,
        lastSubmissionAt: safeNowIso()
      };
    });
    await forwardToCRM({
      type: "tally_form_submitted",
      sessionId,
      attendeeName: name,
      attendeeEmail: email,
      payload,
      timestamp: safeNowIso()
    });
    return res.json({ ok: true });
  } catch (error) {
    console.error("[tally/webhook] fatal:", error);
    return res.status(500).json({ error: "Could not process Tally webhook." });
  }
});

app.post("/api/chat", async (req, res) => {
  const sessionId = sanitizeText(req.body.sessionId) || crypto.randomUUID();
  const systemPrompt = sanitizeText(req.body.systemPrompt);
  const userMessage = sanitizeText(req.body.userMessage);
  const conversationHistory = Array.isArray(req.body.conversationHistory) ? req.body.conversationHistory : [];

  if (!userMessage) {
    return res.status(400).json({ error: "userMessage is required." });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: "ANTHROPIC_API_KEY is not configured.",
      fallback: getFallbackContact()
    });
  }

  const cleanedMessages = conversationHistory
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .map((m) => ({
      role: m.role,
      content: sanitizeText(m.content)
    }))
    .filter((m) => m.content.length > 0)
    .slice(-30);

  await logLeadEvent(sessionId, "user_message", { text: userMessage });

  try {
    const response = await fetchWithRetry(
      ANTHROPIC_API_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": ANTHROPIC_VERSION
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 700,
          system: systemPrompt,
          messages: cleanedMessages
        })
      },
      { retries: 2, retryDelayMs: 700 }
    );

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("[Anthropic] request failed:", response.status, data);
      await logLeadEvent(sessionId, "agent_error", { source: "anthropic", status: response.status, data });
      return res.status(502).json({
        error: "AI service unavailable.",
        fallback: getFallbackContact()
      });
    }

    const reply = sanitizeText(data?.content?.[0]?.text || "");
    if (!reply) {
      await logLeadEvent(sessionId, "agent_error", { source: "anthropic", reason: "empty_reply" });
      return res.status(502).json({
        error: "AI generated an empty response.",
        fallback: getFallbackContact()
      });
    }

    const hasBookingIntent = reply.includes("[BOOKING_INTENT]");
    const cleanReply = reply.replace("[BOOKING_INTENT]", "").trim();

    await logLeadEvent(sessionId, "agent_message", { text: cleanReply });
    if (hasBookingIntent) {
      await upsertBookingState(sessionId, {
        intentDetected: true,
        intentDetectedAt: safeNowIso(),
        status: "intent_detected"
      });
      await forwardToCRM({
        type: "booking_intent",
        sessionId,
        message: cleanReply,
        timestamp: safeNowIso()
      });
    }

    return res.json({
      sessionId,
      reply: cleanReply,
      hasBookingIntent
    });
  } catch (error) {
    console.error("[chat] fatal:", error);
    await logLeadEvent(sessionId, "agent_error", { source: "backend", message: error.message });
    return res.status(502).json({
      error: "AI backend request failed.",
      fallback: getFallbackContact()
    });
  }
});

app.get("/api/cal/event-types", async (_req, res) => {
  if (!process.env.CAL_API_KEY) {
    return res.status(500).json({ error: "CAL_API_KEY is not configured." });
  }

  try {
    const { response, data, version } = await fetchCalApi(
      "/event-types",
      {},
      [CAL_API_VERSION, "2024-06-14", "2024-09-04", "2026-02-25"]
    );
    if (!response.ok) {
      console.error("[Cal] event-types failed:", response.status, data, "version:", version);
      return res.status(502).json({ error: "Calendar service unavailable." });
    }

    const items = Array.isArray(data.data) ? data.data : [];
    return res.json({ eventTypes: items });
  } catch (error) {
    console.error("[cal/event-types] fatal:", error);
    return res.status(502).json({ error: "Calendar service request failed." });
  }
});

app.get("/api/cal/slots", async (req, res) => {
  if (!process.env.CAL_API_KEY) {
    return res.status(500).json({ error: "CAL_API_KEY is not configured." });
  }

  const eventTypeId = Number(req.query.eventTypeId);
  if (!Number.isFinite(eventTypeId) || eventTypeId <= 0) {
    return res.status(400).json({ error: "Valid eventTypeId is required." });
  }

  const start = new Date();
  const end = new Date();
  end.setDate(end.getDate() + 21);

  const params = new URLSearchParams({
    eventTypeId: String(eventTypeId),
    start: start.toISOString(),
    end: end.toISOString(),
    timeZone: "Asia/Qatar"
  });

  try {
    const { response, data, version } = await fetchCalApi(
      `/slots?${params.toString()}`,
      {},
      [CAL_API_VERSION, "2024-09-04", "2024-06-14", "2026-02-25"]
    );
    if (!response.ok) {
      console.error("[Cal] slots failed:", response.status, data, "version:", version);
      return res.status(502).json({ error: "Could not fetch slots." });
    }

    const slotMap = data?.data?.slots || data?.data || {};
    const slots = [];
    for (const times of Object.values(slotMap)) {
      if (!Array.isArray(times)) continue;
      for (const slot of times) {
        if (typeof slot === "string") slots.push(slot);
        else if (slot?.start) slots.push(slot.start);
        else if (slot?.time) slots.push(slot.time);
      }
    }
    return res.json({ slots: slots.slice(0, 8) });
  } catch (error) {
    console.error("[cal/slots] fatal:", error);
    return res.status(502).json({ error: "Calendar slots request failed." });
  }
});

app.post("/api/cal/bookings", async (req, res) => {
  if (!process.env.CAL_API_KEY) {
    return res.status(500).json({ error: "CAL_API_KEY is not configured." });
  }

  const sessionId = sanitizeText(req.body.sessionId) || crypto.randomUUID();
  const eventTypeId = Number(req.body.eventTypeId);
  const start = sanitizeText(req.body.startTime);
  const name = sanitizeText(req.body.name);
  const email = sanitizeText(req.body.email);

  if (!Number.isFinite(eventTypeId) || !start || !name || !isValidEmail(email)) {
    return res.status(400).json({ error: "eventTypeId, startTime, name, valid email are required." });
  }

  try {
    const { response, data, version } = await fetchCalApiVersioned(
      "/bookings",
      (apiVersion) => {
        const isModernPayload = apiVersion === "2026-02-25";
        const payload = isModernPayload
          ? {
              eventTypeId,
              start,
              attendee: {
                name,
                email,
                timeZone: "Asia/Qatar",
                language: "en"
              },
              metadata: {
                source: "ansury-website-chat"
              }
            }
          : {
              eventTypeId,
              start,
              timeZone: "Asia/Qatar",
              language: "en",
              metadata: {
                source: "ansury-website-chat"
              },
              responses: {
                name,
                email,
                notes: "Website booking request"
              }
            };

        return {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payload)
        };
      },
      [CAL_API_VERSION, "2024-06-14", "2026-02-25", "2024-09-04"]
    );
    if (!response.ok) {
      console.error("[Cal] booking failed:", response.status, data, "version:", version);
      await logLeadEvent(sessionId, "booking_error", { status: response.status, data });
      return res.status(502).json({
        error: "Booking service unavailable.",
        fallback: getFallbackContact()
      });
    }

    await upsertBookingState(sessionId, {
      status: "booked",
      bookedAt: safeNowIso(),
      attendeeName: name,
      attendeeEmail: email,
      slot: start
    });
    await logLeadEvent(sessionId, "booking_confirmed", {
      attendeeName: name,
      attendeeEmail: email,
      slot: start,
      bookingUid: data?.data?.uid || null
    });
    await forwardToCRM({
      type: "booking_confirmed",
      sessionId,
      attendeeName: name,
      attendeeEmail: email,
      slot: start,
      bookingUid: data?.data?.uid || null,
      timestamp: safeNowIso()
    });

    return res.json({
      sessionId,
      booking: data.data || null
    });
  } catch (error) {
    console.error("[cal/bookings] fatal:", error);
    await logLeadEvent(sessionId, "booking_error", { message: error.message });
    return res.status(502).json({
      error: "Booking request failed.",
      fallback: getFallbackContact()
    });
  }
});

app.post("/api/lead-event", async (req, res) => {
  const sessionId = sanitizeText(req.body.sessionId) || crypto.randomUUID();
  const type = sanitizeText(req.body.type);
  const payload = typeof req.body.payload === "object" && req.body.payload !== null ? req.body.payload : {};

  if (!type) {
    return res.status(400).json({ error: "type is required." });
  }

  try {
    await logLeadEvent(sessionId, type, payload);
    return res.json({ ok: true, sessionId });
  } catch (error) {
    console.error("[lead-event] fatal:", error);
    return res.status(500).json({ error: "Could not persist event." });
  }
});

app.post("/api/demo-lead", async (req, res) => {
  const sessionId = sanitizeText(req.body.sessionId) || crypto.randomUUID();
  const name = sanitizeText(req.body.name);
  const email = sanitizeText(req.body.email);
  const phone = sanitizePhone(req.body.phone);
  const agency = sanitizeText(req.body.agency);
  const notes = sanitizeText(req.body.notes);
  const source = sanitizeText(req.body.source || "demo");
  const conversationHistory = Array.isArray(req.body.conversationHistory)
    ? req.body.conversationHistory
        .filter((message) => message && (message.role === "user" || message.role === "assistant"))
        .slice(-20)
        .map((message) => ({
          role: message.role,
          content: sanitizeText(message.content)
        }))
    : [];

  if (!name || !phone || (email && !isValidEmail(email))) {
    return res.status(400).json({ error: "Name and phone are required; email must be valid when provided." });
  }

  const payload = {
    name,
    email,
    phone,
    agency,
    notes,
    source,
    conversationHistory
  };

  try {
    await updateLeadSession(sessionId, (lead) => {
      lead.identity = {
        ...(lead.identity || {}),
        name,
        email,
        phone,
        agency
      };
      lead.demoLead = {
        source,
        notes,
        submittedAt: safeNowIso(),
        conversationHistory
      };
    });
    await logLeadEvent(sessionId, "demo_lead_submitted", payload);
    await forwardToCRM({
      type: "demo_lead_submitted",
      sessionId,
      attendeeName: name,
      attendeeEmail: email,
      message: notes,
      payload,
      timestamp: safeNowIso()
    });
    return res.json({ ok: true, sessionId });
  } catch (error) {
    console.error("[demo-lead] fatal:", error);
    return res.status(500).json({ error: "Could not save demo lead." });
  }
});

app.post("/api/callback-request", async (req, res) => {
  const sessionId = sanitizeText(req.body.sessionId) || crypto.randomUUID();
  const name = sanitizeText(req.body.name);
  const phone = sanitizePhone(req.body.phone);
  const preferredTime = sanitizeText(req.body.preferredTime);
  const notes = sanitizeText(req.body.notes);

  if (!name || !phone || !preferredTime) {
    return res.status(400).json({ error: "name, phone and preferredTime are required." });
  }

  try {
    await logLeadEvent(sessionId, "callback_request_submitted", {
      name,
      phone,
      preferredTime,
      notes
    });

    await forwardToCRM({
      type: "callback_request_submitted",
      sessionId,
      attendeeName: name,
      message: notes,
      slot: preferredTime,
      payload: {
        name,
        phone,
        preferredTime,
        notes
      },
      timestamp: safeNowIso()
    });

    return res.json({ ok: true });
  } catch (error) {
    console.error("[callback-request] fatal:", error);
    return res.status(500).json({
      error: "Could not save callback request.",
      fallback: getFallbackContact()
    });
  }
});

app.use((err, _req, res, _next) => {
  console.error("[unhandled]", err);
  res.status(500).json({
    error: "Unexpected server error.",
    fallback: getFallbackContact()
  });
});

async function boot() {
  assertEnv();
  await ensureStore();
}

if (process.env.VERCEL) {
  boot().catch((error) => {
    console.error("[boot] failed on Vercel:", error);
  });
  module.exports = app;
} else {
  app.listen(PORT, async () => {
    await boot();
    console.log(`Ansury server running on http://localhost:${PORT}`);
  });
}
