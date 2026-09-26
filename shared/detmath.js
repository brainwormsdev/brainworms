// Math.tanh and Math.exp may differ in the last bit between JavaScript engines (V8, JavaScriptCore,
// SpiderMonkey). The simulation uses these instead: they're built only from + - * / and exact
// rounding, which every engine computes identically, so any browser can replay the server's
// log bit-for-bit. Accurate to about 1e-16, far below the float32 precision the activity is kept in.

const LN2_HI = 0.6931471803691238, LN2_LO = 1.9082149292705877e-10, INV_LN2 = 1.4426950408889634;

// expm1 for |y| <= 0.5: Taylor series in Horner form (15 terms, error < 1e-17)
function expm1Small(y) {
  let p = 1 / 1307674368000;
  for (let n = 14; n >= 1; n--) p = p * y + 1 / FACT[n];
  return p * y;
}
const FACT = [1];
for (let n = 1; n <= 15; n++) FACT[n] = FACT[n - 1] * n;

/** e^x using only + - * / (deterministic across engines). */
export function exp(x) {
  if (x !== x) return x;
  if (x > 709.78) return Infinity;
  if (x < -745.2) return 0;
  const k = Math.round(x * INV_LN2);
  const r = (x - k * LN2_HI) - k * LN2_LO;          // |r| <= ln2/2
  const p = 1 + expm1Small(r);
  let s = 1, n = k < 0 ? -k : k;
  const b = k < 0 ? 0.5 : 2;
  while (n-- > 0) s *= b;                             // 2^k, exact
  return p * s;
}

/** tanh(x) using only + - * / (deterministic across engines). */
export function tanh(x) {
  if (x !== x) return x;
  if (x < 0) return -tanh(-x);
  if (x > 19.1) return 1;
  const y = 2 * x;
  const em1 = y <= 0.5 ? expm1Small(y) : exp(y) - 1;
  return em1 / (em1 + 2);
}
