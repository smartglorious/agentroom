// Tiny in-memory store standing in for the real database: tables with unique keys and atomic transactions.
const tables = new Map();
const uniques = new Map();
function table(name) { if (!tables.has(name)) tables.set(name, []); return tables.get(name); }
function defineUnique(name, ...cols) { uniques.set(name, [...(uniques.get(name) ?? []), cols]); }
function insert(name, row) {
  for (const cols of uniques.get(name) ?? []) {
    if (table(name).some((r) => cols.every((c) => r[c] === row[c]))) { const e = new Error(`unique violation on ${name}(${cols})`); e.code = "UNIQUE"; throw e; }
  }
  table(name).push(row);
  return row;
}
function find(name, pred) { return table(name).find(pred); }
function filter(name, pred) { return table(name).filter(pred); }
function transaction(fn) {
  const snapshot = new Map([...tables].map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  try { return fn(); } catch (e) { tables.clear(); for (const [k, v] of snapshot) tables.set(k, v); throw e; }
}
function reset() { tables.clear(); }
module.exports = { table, defineUnique, insert, find, filter, transaction, reset };
