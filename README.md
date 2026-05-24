# Ansury Systems (Secure Backend Setup)

This project now runs with a backend API so keys are never exposed in the browser.

## What was added

- Express backend API (`server.js`)
- Server-side Anthropic integration with required headers
- Server-side Cal.com integration
- Tally rollout/demo-lead form integration
- Persistent lead capture in `data/leads.json`
- Airtable CRM sync for lead/booking events
- Retry + error handling + fallback contact responses
- Callback-request fallback API (`/api/callback-request`)
- Demo lead capture API (`/api/demo-lead`)
- Tally config/webhook APIs (`/api/tally/config`, `/api/tally/webhook`)
- Frontend rewired to call local `/api/*` endpoints only
- UTF-8-safe frontend text cleanup
- Conversion upgrades:
  - Offer-led CTA copy ("Book Your WhatsApp CRM Rollout")
  - WhatsApp-first real estate CRM positioning
  - Shared inbox, CRM, pipeline, broadcasts, automations, and AI reply sections
  - 3-step agency workflow pre-qualifier before booking
  - One-click WhatsApp fallback + callback request form when slots fail
  - Tally lead-intake forms for lower-cost CTA capture without starting the AI demo

## 1) Create environment file

Create `.env` in the project root and fill it from `.env.example`.

Required:

- `ANTHROPIC_API_KEY`
- `CAL_API_KEY`
- `TALLY_API_KEY` (only required when running `npm run setup:tally`)

`CAL_API_VERSION` defaults to `2024-06-14` and backend includes fallback attempts for compatibility.

Recommended:

- `FALLBACK_WHATSAPP`
- `FALLBACK_EMAIL`
- `CRM_WEBHOOK_URL` (optional webhook for HubSpot/Zapier/Make/etc)
- `AIRTABLE_PAT` (for Airtable CRM sync)
- `AIRTABLE_BASE_ID` + `AIRTABLE_TABLE_ID` or `AIRTABLE_TABLE_NAME`
- `TALLY_ROLLOUT_FORM_ID` / `TALLY_ROLLOUT_FORM_URL`
- `TALLY_DEMO_FORM_ID` / `TALLY_DEMO_FORM_URL`
- `TALLY_WEBHOOK_SIGNING_SECRET` (recommended for production Tally webhooks)

If Airtable base/table values are blank, the backend attempts auto-discovery with your PAT.

## 2) Install and run

```bash
npm install
npm run dev
```

Open:

`http://localhost:3000/ansury-ai-1.html`

## Build check

```bash
npm run build
```

## Tally setup

```bash
npm run setup:tally
```

This creates the rollout and demo-lead forms in Tally, then writes the public form IDs/URLs to `.env`. If `APP_BASE_URL` is HTTPS, the script also creates Tally webhooks back to `/api/tally/webhook`.

## 3) Lead capture storage

Conversation and booking events are stored in:

`data/leads.json`

## 4) Airtable mapping notes

Backend creates records in your Airtable table and maps data to fields that exist.

Recommended fields:

- `EventType`
- `SessionId`
- `Timestamp`
- `Message`
- `AttendeeName`
- `AttendeeEmail`
- `Slot`
- `BookingUid`
- `PayloadJson`

## 5) Deploy Guide

### Option A (Recommended): Vercel

This repo already includes `vercel.json` and `server.js` export compatibility.

1. Create a Vercel project from this folder/repo.
2. Add Environment Variables in Vercel Project Settings:
   - `ANTHROPIC_API_KEY`
   - `ANTHROPIC_MODEL`
   - `ANTHROPIC_VERSION`
   - `CAL_API_KEY`
   - `CAL_API_VERSION`
   - `FALLBACK_WHATSAPP`
   - `FALLBACK_EMAIL`
   - `AIRTABLE_PAT`
   - `AIRTABLE_BASE_ID`
   - `AIRTABLE_TABLE_NAME`
3. Deploy from CLI:

```bash
npm i -g vercel
vercel
vercel --prod
```

4. Open your production URL and test:
   - `/api/health`
   - CTA click -> booking flow
   - callback fallback form submission

### Option B: Cloudflare (Pages + Functions/Workers)

Because this project is Express-based backend + API routes, Vercel is the fastest path.
For Cloudflare, you should migrate backend endpoints from Express to Pages Functions or Workers first.

Recommended Cloudflare path:
1. Keep this HTML/CSS/JS UI.
2. Recreate `/api/*` handlers in `functions/` (Pages Functions) or Worker routes.
3. Move env vars to Cloudflare project bindings/secrets.
4. Deploy via Cloudflare Pages Git integration or Wrangler.

## 6) Security note

If any API key has been shared publicly or in chat, revoke it and create a new key before production use.
