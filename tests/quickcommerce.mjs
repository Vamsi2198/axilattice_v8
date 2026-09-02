/* Reproduction of the deployed dataset's shape: 79k rows, 13 columns,
   dims category(7) city(6) dark_store(8) items(6) order_type(2) rating(5)
   time_slot(4) tip(4). */
import { rng } from "./generate.mjs";
export function quickcommerce({ rows = 79346, seed = 909 } = {}) {
  const r = rng(seed);
  const N = (m, s) => m + s * Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r());
  const pick = (a) => a[Math.floor(r() * a.length)];
  const category = ["Grocery","Dairy","Snacks","Beverages","Personal Care","Household","Frozen"];
  const city = ["Bengaluru","Hyderabad","Chennai","Mumbai","Pune","Delhi"];
  const store = ["DS-01","DS-02","DS-03","DS-04","DS-05","DS-06","DS-07","DS-08"];
  const slot = ["Morning","Afternoon","Evening","Night"];
  const otype = ["Express","Standard"];
  const out = [["order_id","order_date","city","dark_store","category","time_slot","order_type","items","rating","tip","order_value","delivery_min","courier_id"]];
  for (let i = 0; i < rows; i++) {
    const m = Math.floor(r() * 12);
    const d = 1 + Math.floor(r() * 28);
    const c = pick(city), ds = pick(store), sl = pick(slot), ot = pick(otype);
    // planted: DS-07 slow; Night slow; Express faster
    let base = 22 + (ds === "DS-07" ? 11 : 0) + (sl === "Night" ? 6 : 0) + (ot === "Express" ? -6 : 0);
    const delivery = Math.max(4, Math.round(N(base, 5)));
    const items = 1 + Math.floor(r() * 6);
    const rating = delivery > 34 ? (r() < 0.7 ? 1 + Math.floor(r() * 2) : 3) : 3 + Math.floor(r() * 3);
    const tip = [0, 10, 20, 30][Math.min(3, Math.floor(r() * 4))];
    out.push([`ORD-${i}`, `2024-${String(m + 1).padStart(2,"0")}-${String(d).padStart(2,"0")}`,
      c, ds, pick(category), sl, ot, items, rating, tip,
      Math.max(50, Math.round(N(420, 130))), delivery, `CR-${Math.floor(r()*220)}`]);
  }
  return out.map((x) => x.join(",")).join("\n");
}
