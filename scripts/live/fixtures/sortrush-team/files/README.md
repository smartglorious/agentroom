# Mini play platform (server in the root folder, browser client in `web/`)

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

# Spec: Sort Rush browser client (`web/sortRushClient.js`)

Follow `web/tapFrenzyClient.js` and its test. Export `createSortRushClient({ api, store })`; `api(method, path, body)` returns `{ status, body }` for the Sort Rush endpoints above
(it may THROW when the network is down); `store` is a localStorage-like object (`getItem/setItem/removeItem`). Keys are yours to choose but keep everything under the prefix `sr.`.
Every method returns a plain view model; **no view model ever contains an item's `category_id`**.

- `start({ campaign_slug, instance_key, qr_code })`: creates a `request_id` once and keeps it in the store (a second `start` after a reload reuses it and so gets the same session).
  200 -> `{ status: "playing", sessionId, items, categories, score: 0, answered: [] }`; 429 -> `{ status: "limit" }`; 403 or 404 -> `{ status: "error", reason: <http status> }`.
- `drop(itemId, categoryId)`: sends the action with `event_id = "<sessionId>:<n>"` where n is a counter kept in the store (so it survives a reload), and `client_seq = n`.
  200 -> `{ status: "playing", correct, combo, score, answered: [...] }` (score and answered come from the server's answer, not computed locally);
  409 (item already processed) -> same view model, the item counts as answered and nothing breaks; 410 -> `{ status: "expired" }`.
  If `api` throws: keep the action (with the same `event_id`) in a queue in the store, return `{ status: "offline", queued: <queue length> }`, and show no score for it.
- `flush()`: resend queued actions in order, each with its ORIGINAL `event_id`; remove an action when the server answers 200 or 409; stop at the first throw. Returns how many were removed.
- `finish()`: first `flush()`; if actions are still queued return `{ status: "pending" }` (no reward is shown); otherwise POST finish and return `{ status: "done", score, reward_eligible }` taken from the server (never a local score). If the call throws return `{ status: "pending" }`.
- `resume({ qr_code })`: if the store has a session, GET the state and return `{ status: "playing", sessionId, score, answered, remaining }`; without a stored session return `{ status: "none" }`; a 403 means someone else's session: clear the stored session and return `{ status: "none" }`.
Add tests in `web/sortRushClient.test.js` (they may use the real server through `require("../index")` and `http.handle`).
