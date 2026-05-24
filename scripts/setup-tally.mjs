import "dotenv/config";

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const TALLY_API_URL = "https://api.tally.so";
const APP_BASE_URL = (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const ENV_PATH = path.join(process.cwd(), ".env");

function uuid() {
  return crypto.randomUUID();
}

async function getApiKey() {
  if (process.env.TALLY_API_KEY) return process.env.TALLY_API_KEY.trim();

  const raw = await fs.readFile(ENV_PATH, "utf8").catch(() => "");
  const legacy = raw.match(/^\s*tally\s+api\s*:\s*(.+)\s*$/im);
  return legacy ? legacy[1].trim() : "";
}

function block(type, payload = {}, options = {}) {
  const id = uuid();
  return {
    uuid: id,
    type,
    groupUuid: options.groupUuid || id,
    groupType: options.groupType || type,
    payload
  };
}

function formTitle(html, buttonLabel) {
  return block("FORM_TITLE", {
    html,
    button: {
      label: buttonLabel
    }
  });
}

function text(html) {
  return block("TEXT", { html });
}

function question(label, type, payload = {}) {
  const groupUuid = uuid();
  return [
    text(`<strong>${label}</strong>`),
    {
      uuid: groupUuid,
      type,
      groupUuid,
      groupType: type,
      payload: {
        name: label,
        placeholder: label,
        isRequired: Boolean(payload.isRequired),
        ...payload
      }
    }
  ];
}

function hiddenFields(names) {
  return block("HIDDEN_FIELDS", {
    hiddenFields: names.map((name) => ({ uuid: uuid(), name }))
  });
}

function rolloutFormBlocks() {
  return [
    formTitle("Claim your 48-hour WhatsApp Sales Command Center setup", "Claim 48-hour setup"),
    text("Stop losing commissions to agents' personal phones. We will set up your unified WhatsApp Sales Command Center in 48 hours. If it does not capture or salvage at least 3 property leads in your first 14 days, you pay absolutely nothing."),
    ...question("Your name", "INPUT_TEXT", { isRequired: true }),
    ...question("Agency name", "INPUT_TEXT", { isRequired: true }),
    ...question("Work email", "INPUT_EMAIL", { isRequired: true }),
    ...question("WhatsApp number", "INPUT_PHONE_NUMBER", {
      isRequired: true,
      internationalFormat: true,
      defaultCountryCode: "QA"
    }),
    ...question("How many agents handle WhatsApp property leads?", "INPUT_TEXT", { isRequired: true }),
    ...question("Monthly WhatsApp lead volume", "INPUT_TEXT"),
    ...question("Main lead sources (Instagram, portals, referrals, signs, ads)", "TEXTAREA"),
    ...question("Biggest leak today (missed replies, personal phones, follow-up, pipeline visibility)", "TEXTAREA", { isRequired: true }),
    ...question("How should we qualify leads? (budget, property type, QID/residency, urgency)", "TEXTAREA"),
    ...question("What should the AI agent do for your team?", "TEXTAREA"),
    ...question("Tools to connect with webhooks", "TEXTAREA"),
    ...question("Can we start the 48-hour rollout this week?", "INPUT_TEXT"),
    hiddenFields(["sessionId", "source", "pageUrl", "utm_source", "utm_medium", "utm_campaign"])
  ];
}

function demoLeadFormBlocks() {
  return [
    formTitle("Save this command-center demo lead", "Save lead"),
    text("Send the demo context to Ansury so we can prepare your 48-hour setup without another AI call. The conversation/session context is passed through hidden fields where available."),
    ...question("Your name", "INPUT_TEXT", { isRequired: true }),
    ...question("Agency name", "INPUT_TEXT"),
    ...question("Work email", "INPUT_EMAIL", { isRequired: true }),
    ...question("WhatsApp number", "INPUT_PHONE_NUMBER", {
      isRequired: true,
      internationalFormat: true,
      defaultCountryCode: "QA"
    }),
    ...question("What should we prepare for the rollout call?", "TEXTAREA"),
    hiddenFields(["sessionId", "source", "pageUrl", "conversationSummary", "lastUserMessage", "utm_source", "utm_medium", "utm_campaign"])
  ];
}

async function tallyFetch(apiKey, pathname, options = {}) {
  const response = await fetch(`${TALLY_API_URL}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${pathname} failed with ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function createForm(apiKey, blocks) {
  return tallyFetch(apiKey, "/forms", {
    method: "POST",
    body: JSON.stringify({
      status: "PUBLISHED",
      blocks,
      settings: {
        language: "en",
        hasProgressBar: true,
        hasPartialSubmissions: true
      }
    })
  });
}

async function createWebhook(apiKey, formId, signingSecret) {
  return tallyFetch(apiKey, "/webhooks", {
    method: "POST",
    body: JSON.stringify({
      formId,
      url: `${APP_BASE_URL}/api/tally/webhook`,
      eventTypes: ["FORM_RESPONSE"],
      signingSecret,
      externalSubscriber: "ansury-systems-site"
    })
  });
}

async function upsertEnv(values) {
  const raw = await fs.readFile(ENV_PATH, "utf8").catch(() => "");
  const lines = raw.split(/\r?\n/).filter((line) => !/^\s*tally\s+api\s*:/i.test(line));
  const withoutManaged = lines.filter((line) => {
    const key = line.split("=", 1)[0];
    return !Object.prototype.hasOwnProperty.call(values, key);
  });
  const next = [...withoutManaged];
  for (const [key, value] of Object.entries(values)) {
    next.push(`${key}=${value}`);
  }
  await fs.writeFile(ENV_PATH, `${next.join("\n").replace(/\n+$/, "")}\n`, "utf8");
}

async function main() {
  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new Error("TALLY_API_KEY is missing. Add it to .env and rerun this script.");
  }

  const signingSecret = process.env.TALLY_WEBHOOK_SIGNING_SECRET || crypto.randomBytes(24).toString("hex");

  const rollout = process.env.TALLY_ROLLOUT_FORM_ID
    ? { id: process.env.TALLY_ROLLOUT_FORM_ID }
    : await createForm(apiKey, rolloutFormBlocks());

  const demo = process.env.TALLY_DEMO_FORM_ID
    ? { id: process.env.TALLY_DEMO_FORM_ID }
    : await createForm(apiKey, demoLeadFormBlocks());

  const values = {
    TALLY_API_KEY: apiKey,
    TALLY_ROLLOUT_FORM_ID: rollout.id,
    TALLY_ROLLOUT_FORM_URL: `https://tally.so/r/${rollout.id}`,
    TALLY_DEMO_FORM_ID: demo.id,
    TALLY_DEMO_FORM_URL: `https://tally.so/r/${demo.id}`,
    TALLY_WEBHOOK_SIGNING_SECRET: signingSecret
  };

  if (!process.env.TALLY_ROLLOUT_WEBHOOK_ID && APP_BASE_URL.startsWith("https://")) {
    const webhook = await createWebhook(apiKey, rollout.id, signingSecret);
    values.TALLY_ROLLOUT_WEBHOOK_ID = webhook.id;
  }

  if (!process.env.TALLY_DEMO_WEBHOOK_ID && APP_BASE_URL.startsWith("https://")) {
    const webhook = await createWebhook(apiKey, demo.id, signingSecret);
    values.TALLY_DEMO_WEBHOOK_ID = webhook.id;
  }

  await upsertEnv(values);

  console.log("Tally forms ready:");
  console.log(`- Rollout: ${values.TALLY_ROLLOUT_FORM_URL}`);
  console.log(`- Demo lead: ${values.TALLY_DEMO_FORM_URL}`);
  if (!APP_BASE_URL.startsWith("https://")) {
    console.log("- Webhooks skipped because APP_BASE_URL is not HTTPS. Set production APP_BASE_URL and rerun to create webhooks.");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
