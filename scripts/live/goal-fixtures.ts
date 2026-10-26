import { readdirSync, readFileSync } from "node:fs";
// Small projects with seeded problems, one per goal. The workers see `files` and `goal`; `hidden` are tests the checker adds after the run.
export interface GoalFixture { id: string; /** four workers (lead, fe, be, qa) with role-bound permissions instead of lead/be/qa */ team?: boolean; /** real workers file (BENCH_WORKERS_FILE) and zone-bound permissions */ zones?: boolean; goal: string; files: Record<string, string>; hidden: Record<string, string>; hiddenTests: number }

const AUTH = `const crypto = require("node:crypto");
const hash = (pw) => crypto.createHash("sha256").update(pw).digest("hex");
function createUser(name, pw) { return { name, hash: hash(pw), failed: 0 }; }
// ttl is in seconds, timestamps are in milliseconds
function createSession(user, now, ttl = 3600) { return { user: user.name, expiresAt: now + ttl }; }
function isSessionValid(session, now) { return now < session.expiresAt; }
function login(users, name, pw, now) {
  const user = users.find((u) => u.name === name);
  if (!user) return { ok: false, error: "no such user" };
  if (user.failed >= 3) return { ok: false, error: "locked" };
  if (user.hash !== hash(pw)) { user.failed += 1; return { ok: false, error: "bad password" }; }
  return { ok: true, session: createSession(user, now) };
}
module.exports = { createUser, createSession, isSessionValid, login };
`;
const AUTH_TEST = `const test = require("node:test");
const assert = require("node:assert/strict");
const { createUser, login } = require("./auth");
test("login succeeds with the right password", () => {
  const users = [createUser("ann", "pw1")];
  assert.equal(login(users, "ann", "pw1", 0).ok, true);
});
test("login fails with a wrong password", () => {
  const users = [createUser("ann", "pw1")];
  assert.equal(login(users, "ann", "nope", 0).ok, false);
});
`;
const AUTH_HIDDEN = `const test = require("node:test");
const assert = require("node:assert/strict");
const { createUser, createSession, isSessionValid, login } = require("./auth");
test("a session lasts its ttl in seconds", () => {
  const s = createSession(createUser("a", "p"), 1_000_000, 3600);
  assert.equal(isSessionValid(s, 1_000_000 + 30 * 60 * 1000), true);
  assert.equal(isSessionValid(s, 1_000_000 + 2 * 3600 * 1000), false);
});
test("unknown user and wrong password give the same error", () => {
  const users = [createUser("ann", "pw1")];
  assert.equal(login(users, "bob", "x", 0).error, login(users, "ann", "x", 0).error);
});
test("a successful login resets the failed-attempt counter", () => {
  const users = [createUser("ann", "pw1")];
  login(users, "ann", "x", 0); login(users, "ann", "x", 0);
  assert.equal(login(users, "ann", "pw1", 0).ok, true);
  login(users, "ann", "x", 0); login(users, "ann", "x", 0);
  assert.equal(login(users, "ann", "pw1", 0).ok, true);
});
`;

const CART = `// prices are in euros
function lineTotal(item) { return item.price * item.qty; }
function subtotal(items) { return items.reduce((n, i) => n + lineTotal(i), 0); }
function total(items) { return subtotal(items); }
module.exports = { lineTotal, subtotal, total };
`;
const CART_TEST = `const test = require("node:test");
const assert = require("node:assert/strict");
const { total } = require("./cart");
test("total of two lines", () => {
  assert.equal(total([{ price: 10, qty: 2 }, { price: 5, qty: 1 }]), 25);
});
`;
const CART_HIDDEN = `const test = require("node:test");
const assert = require("node:assert/strict");
const { total, subtotal } = require("./cart");
test("float sums are rounded to cents", () => {
  assert.equal(subtotal([{ price: 0.1, qty: 3 }]), 0.3);
  assert.equal(total([{ price: 19.99, qty: 3 }]), 59.97);
});
test("PERCENT10 takes 10% off", () => {
  assert.equal(total([{ price: 50, qty: 2 }], "PERCENT10"), 90);
});
test("FIXED5 takes 5 off only from 20 spent", () => {
  assert.equal(total([{ price: 30, qty: 1 }], "FIXED5"), 25);
  assert.equal(total([{ price: 10, qty: 1 }], "FIXED5"), 10);
});
test("an unknown coupon changes nothing and the total is never negative", () => {
  assert.equal(total([{ price: 10, qty: 1 }], "NOPE"), 10);
  assert.equal(total([{ price: 2, qty: 1 }], "FIXED5"), 2);
});
`;

export const FIXTURES: Record<string, GoalFixture> = {
  auth: {
    id: "auth",
    goal: "Hãy kiểm tra auth.js: tìm các lỗi logic và lỗi bảo mật, sửa những lỗi bạn xác nhận được bằng test, thêm test cho chúng, chạy `node --test` cho tới khi xanh rồi báo cáo ngắn gọn các lỗi đã sửa.",
    files: { "auth.js": AUTH, "auth.test.js": AUTH_TEST }, hidden: { "hidden.test.js": AUTH_HIDDEN }, hiddenTests: 3,
  },
  cart: {
    id: "cart",
    goal: "Hãy làm cho cart.js tính tổng tiền đúng đến từng cent (làm tròn 2 chữ số), thêm mã giảm giá: PERCENT10 giảm 10%, FIXED5 giảm 5 nhưng chỉ khi tạm tính từ 20 trở lên, mã lạ không đổi gì, tổng không bao giờ âm. Thêm test, chạy `node --test` cho tới khi xanh rồi báo cáo ngắn gọn.",
    files: { "cart.js": CART, "cart.test.js": CART_TEST }, hidden: { "hidden.test.js": CART_HIDDEN }, hiddenTests: 4,
  },
};

const ORD_README = `# Order system spec
- Catalog lookups are case-insensitive: "Apple" and "apple" are the same product.
- Stock can never go below 0. Reserving more than is available fails (returns false) and changes nothing.
- Placing an order reserves stock for every line; if any line cannot be reserved, nothing is reserved and the order is rejected.
- Cancelling an order gives its stock back, once (cancelling twice changes nothing).
- Price: apply the discount first, then 20% tax on the discounted amount. All money is rounded to cents at the end of each order.
- The report lists revenue as the sum of the rounded order totals of orders that are not cancelled.
`;
const ORD_CATALOG = `const products = new Map();
function add(name, price) { products.set(name, { name, price }); }
function find(name) { return products.get(name); }
module.exports = { add, find, products };
`;
const ORD_STOCK = `const levels = new Map();
function set(name, qty) { levels.set(name, qty); }
function get(name) { return levels.get(name) ?? 0; }
function reserve(name, qty) { levels.set(name, get(name) - qty); return true; }
function release(name, qty) { levels.set(name, get(name) + qty); }
module.exports = { set, get, reserve, release };
`;
const ORD_PRICING = `function price(lines, discountPct = 0) {
  const gross = lines.reduce((n, l) => n + l.price * l.qty, 0);
  const taxed = gross * 1.2;
  return taxed - taxed * (discountPct / 100);
}
module.exports = { price };
`;
const ORD_ORDERS = `const catalog = require("./catalog");
const stock = require("./stock");
const { price } = require("./pricing");
const orders = [];
function place(items, discountPct = 0) {
  const lines = items.map(({ name, qty }) => ({ name, qty, price: catalog.find(name)?.price }));
  if (lines.some((l) => l.price === undefined)) return null;
  const order = { id: orders.length + 1, lines, total: price(lines, discountPct), cancelled: false };
  orders.push(order);
  return order;
}
function cancel(id) { const o = orders.find((x) => x.id === id); if (o) o.cancelled = true; return o; }
module.exports = { place, cancel, orders };
`;
const ORD_REPORT = `const { orders } = require("./orders");
function revenue() { return orders.filter((o) => !o.cancelled).reduce((n, o) => n + o.total, 0); }
module.exports = { revenue };
`;
const ORD_TEST = `const test = require("node:test");
const assert = require("node:assert/strict");
const catalog = require("./catalog");
test("catalog finds a product by its exact name", () => {
  catalog.add("apple", 2);
  assert.equal(catalog.find("apple").price, 2);
});
`;
const ORD_HIDDEN = `const test = require("node:test");
const assert = require("node:assert/strict");
const fresh = () => { for (const k of Object.keys(require.cache)) if (/\\/(catalog|stock|pricing|orders|report)\\.js$/.test(k)) delete require.cache[k];
  return { catalog: require("./catalog"), stock: require("./stock"), orders: require("./orders"), report: require("./report") }; };
test("catalog is case-insensitive", () => { const { catalog } = fresh(); catalog.add("Apple", 2); assert.equal(catalog.find("apple")?.price, 2); });
test("reserve cannot take stock below zero and changes nothing when it fails", () => {
  const { stock } = fresh(); stock.set("a", 2); assert.equal(stock.reserve("a", 5), false); assert.equal(stock.get("a"), 2);
});
test("placing an order reserves stock", () => {
  const { catalog, stock, orders } = fresh(); catalog.add("a", 10); stock.set("a", 5); orders.place([{ name: "a", qty: 2 }]); assert.equal(stock.get("a"), 3);
});
test("an order that cannot be fully reserved is rejected and reserves nothing", () => {
  const { catalog, stock, orders } = fresh(); catalog.add("a", 10); catalog.add("b", 10); stock.set("a", 5); stock.set("b", 1);
  assert.equal(orders.place([{ name: "a", qty: 2 }, { name: "b", qty: 3 }]), null); assert.equal(stock.get("a"), 5); assert.equal(stock.get("b"), 1);
});
test("discount first, then tax, rounded to cents", () => {
  const { catalog, stock, orders } = fresh(); catalog.add("a", 33.33); stock.set("a", 10);
  assert.equal(orders.place([{ name: "a", qty: 3 }], 10).total, 107.99);
});
test("cancelling gives stock back once and revenue skips cancelled orders", () => {
  const { catalog, stock, orders, report } = fresh(); catalog.add("a", 10); stock.set("a", 5);
  const o1 = orders.place([{ name: "a", qty: 2 }]); orders.place([{ name: "a", qty: 1 }]);
  orders.cancel(o1.id); orders.cancel(o1.id);
  assert.equal(stock.get("a"), 4); assert.equal(report.revenue(), 12);
});
`;
FIXTURES.orders = {
  id: "orders",
  goal: "Đọc README.md (đặc tả hệ thống đặt hàng), đối chiếu toàn bộ mã nguồn với đặc tả, sửa mọi chỗ sai lệch (có thể nằm ở nhiều module), thêm test cho từng chỗ đã sửa, chạy `node --test` cho tới khi xanh rồi báo cáo ngắn gọn.",
  files: { "README.md": ORD_README, "catalog.js": ORD_CATALOG, "stock.js": ORD_STOCK, "pricing.js": ORD_PRICING, "orders.js": ORD_ORDERS, "report.js": ORD_REPORT, "catalog.test.js": ORD_TEST },
  hidden: { "hidden.test.js": ORD_HIDDEN }, hiddenTests: 6,
};

// A fixture kept as real files: `files/` is the project the workers see, `hidden/` the tests the checker adds.
const fromDir = (id: string, goal: string, hiddenTests: number, team = false, zones = false): GoalFixture => {
  // Subfolders (web/) keep their relative path, so a file is addressed as "web/x.js".
  const walk = (base: string, rel = ""): [string, string][] => readdirSync(`${base}/${rel}`, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(base, `${rel}${e.name}/`) : [[`${rel}${e.name}`, readFileSync(`${base}/${rel}${e.name}`, "utf8")] as [string, string]]);
  const dir = (sub: string) => Object.fromEntries(walk(`scripts/live/fixtures/${id}/${sub}`));
  return { id, goal, files: dir("files"), hidden: dir("hidden"), hiddenTests, ...(team ? { team } : {}), ...(zones ? { zones } : {}) };
};
FIXTURES.sortrush = fromDir("sortrush",
  "Đọc README.md rồi implement game Sort Rush theo đặc tả vào hệ thống hiện có: làm theo mẫu tapFrenzy.js, dùng gameSessions, rewards, configs đã có, tạo sortRush.js và nạp nó trong index.js. Thêm test (sortRush.test.js), chạy `node --test` cho tới khi xanh rồi báo cáo ngắn gọn.", 9);
FIXTURES["sortrush-team"] = fromDir("sortrush-team",
  "Hãy làm game Sort Rush theo đặc tả trong README.md vào hệ thống hiện có, gồm cả backend (thư mục gốc) lẫn client web (thư mục web/): be làm backend theo mẫu tapFrenzy.js, fe làm client theo mẫu web/tapFrenzyClient.js, qa viết test tích hợp và chạy `node --test`. Lead điều phối và chốt kết quả. Báo cáo ngắn gọn khi xong.", 16, true);
FIXTURES["sortrush-zones"] = fromDir("sortrush-zones",
  "Hãy triển khai game Sort Rush (MVP) theo đặc tả docs/specs/sort-rush.md vào hệ thống hiện có: server ở rules-service/, client ở play-frontend/. Đọc WORKING.md trước. Khi xong và đã kiểm chứng, nhờ docs ghi lại vào WORKING.md. Báo cáo ngắn gọn cho tôi: file, test, rủi ro.", 16, true, true);
