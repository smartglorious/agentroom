# Mini play platform

Existing pieces (read them before adding a game): `db.js` (tables, unique keys, `transaction`), `tenants.js` (campaigns, instances, participants by QR),
`gameSessions.js` (the session authority every game must use: quota, expiry, finalize, reward eligibility), `rewards.js` (exactly-once issuance),
`configs.js` (validators + publishInstance), `http.js` (router), `tapFrenzy.js` (an existing game: follow its pattern). Run tests with `node --test`.

# Spec: Sort Rush (`type: "sort_rush"`, routes under `/public/sort-rush/`)

The player sorts items into the right category before time runs out. The SERVER is the authority: it grades every action and computes the score.

## Config (`instance.config`)
```json
{ "ui": { "title": "..." },
  "logic": { "duration_seconds": 30, "max_plays_per_participant": 3, "base_points": 100, "wrong_penalty": 25, "combo_every": 3 },
  "categories": [ { "id": "recycle", "label": "Recycle" }, { "id": "compost", "label": "Compost" } ],
  "items": [ { "id": "bottle", "label": "Bottle", "category_id": "recycle" } ] }
```
Validation (register a validator for `sort_rush`; `publishInstance` must reject bad configs with the list of errors): ids unique within categories and within items;
2-6 categories; 6-60 items; every item `category_id` exists; `duration_seconds` 15-90; labels are strings of at most 80 characters and must not contain `<` or `>` (no HTML).

## Endpoints (all return `{ status, body }`)
- `POST /public/sort-rush/start` `{ campaign_slug, instance_key, qr_code, request_id }`
  - unknown instance or instance of another type or another campaign: 404. QR unknown or from another campaign: 403. Quota exceeded: 429.
  - Same `request_id` from the same participant returns the same session (no new play).
  - Uses `gameSessions.createSession` (ttl = duration_seconds + 5). The session keeps a snapshot of the config.
  - Response 200: `{ session_id, expires_at, categories: [{id,label}], items: [{id,label}] }`. **Never send `category_id` of items** (that is the answer key).
- `POST /public/sort-rush/action` `{ session_id, event_id, item_id, category_id, client_seq }`
  - unknown session: 404; session finished: 409; now after `expires_at`: 410; item not in this session or category not in the config: 400.
  - Same `event_id` sent again returns the first result with `duplicate: true` and records nothing new. A different `event_id` for an item that was already processed: 409.
  - The server grades: correct if `category_id` equals the item's real category. Response 200: `{ correct, combo, score }` (score so far).
- `POST /public/sort-rush/finish` `{ session_id, score? }`
  - The score is computed by the server from the recorded actions; a `score` sent by the client is ignored. Finishing uses `gameSessions.finalizeSession` (so the reward is issued once);
    finishing twice returns the same body and issues no second reward. Response 200: `{ score, reward_eligible: true }`.
- `GET /public/sort-rush/state/:sessionId?qr_code=...`: only the participant who owns the session may read it (otherwise 403); returns `{ status, score, answered: [item ids], remaining: [item ids] }` so a client can resume.

## Scoring (server side, replay-able from the recorded actions in order)
Correct: `+base_points`, combo + 1, and when the combo is a multiple of `combo_every` add a bonus of `base_points` once. Wrong: `-wrong_penalty` (the score never goes below 0) and the combo resets to 0.

## Acceptance
Tenant/campaign isolation (QR or instance of another campaign is refused); the same `event_id` ten times records one action; an item cannot be processed twice;
a forged client score is ignored; finish twice issues one reward; bad configs are refused at publish; nothing in any response reveals an item's category before it was answered.
Add tests for what you build (`sortRush.test.js`).
