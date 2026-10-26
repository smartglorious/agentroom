// The browser side of tap-frenzy, as an existing example to follow. It talks to the API through `api(method, path, body)` -> { status, body }
// (in the browser this wraps fetch) and keeps its small state in `store` (a localStorage-like object with getItem/setItem/removeItem).
function createTapClient({ api, store }) {
  return {
    start({ instance_key, qr_code }) {
      let requestId = store.getItem("tap.request_id");
      if (!requestId) { requestId = `tap_${Math.random().toString(36).slice(2)}`; store.setItem("tap.request_id", requestId); }
      const r = api("POST", "/public/tap-frenzy/start", { instance_key, qr_code, request_id: requestId });
      if (r.status === 429) return { status: "limit" };
      if (r.status !== 200) return { status: "error", reason: r.status };
      store.setItem("tap.session", r.body.session_id);
      return { status: "playing", sessionId: r.body.session_id, taps: 0 };
    },
    finish(taps) {
      const r = api("POST", "/public/tap-frenzy/finish", { session_id: store.getItem("tap.session"), taps });
      store.removeItem("tap.request_id");
      return r.status === 200 ? { status: "done", score: r.body.score } : { status: "error", reason: r.status };
    },
  };
}
module.exports = { createTapClient };
