// A minimal router standing in for the real HTTP layer: handle(method, path, body, ctx) -> { status, body }.
const routes = [];
function register(method, pattern, handler) {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
  routes.push({ method, re, keys, handler });
}
function handle(method, path, body = {}, ctx = { now: Date.now() }) {
  const [p, query = ""] = path.split("?");
  const params = Object.fromEntries(new URLSearchParams(query));
  for (const r of routes) {
    const m = r.re.exec(p);
    if (r.method === method && m) { r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); return r.handler({ body, params, ctx }); }
  }
  return { status: 404, body: { error: "not found" } };
}
module.exports = { register, handle };
