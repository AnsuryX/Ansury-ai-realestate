# Ansury AI (Secure Backend Setup)

This project now runs with a backend API so keys are never exposed in the browser.

## What was added

- Express backend API (`server.js`)
- Server-side Anthropic integration with required headers
- Server-side Cal.com integration
- Persistent lead capture in `data/leads.json`
- Airtable CRM sync for lead/booking events
- Retry + error handling + fallback contact responses
- Frontend rewired to call local `/api/*` endpoints only
- UTF-8-safe frontend text cleanup

## 1) Create environment file

Create `.env` in the project root and fill it from `.env.example`.

Required:

- `ANTHROPIC_API_KEY`
- `CAL_API_KEY`

`CAL_API_VERSION` defaults to `2024-06-14` and backend includes fallback attempts for compatibility.

Recommended:

- `FALLBACK_WHATSAPP`
- `FALLBACK_EMAIL`
- `CRM_WEBHOOK_URL` (optional webhook for HubSpot/Zapier/Make/etc)
- `AIRTABLE_PAT` (for Airtable CRM sync)
- `AIRTABLE_BASE_ID` + `AIRTABLE_TABLE_ID` or `AIRTABLE_TABLE_NAME`

If Airtable base/table values are blank, the backend attempts auto-discovery with your PAT.

## 2) Install and run

```bash
npm install
npm run dev
```

Open:

`http://localhost:3000/ansury-ai-1.html`

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

## 5) Security note

If any API key has been shared publicly or in chat, revoke it and create a new key before production use.
