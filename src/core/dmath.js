// 模擬用的數學函式：只用加減乘除和開根號寫成，所以在任何瀏覽器、任何版本的 Node 算出來的每一個位元都相同。
// 內建的 Math.sin / cos / atan2 / hypot / log 各家引擎實作不同，最後一位數可能差 1，
// 重播紀錄（core/replay.js）拿到另一個環境重跑就會慢慢分岔。物理、AI、道路一律用這裡的版本。
// 精度約 1e-15，對遊戲來說和內建的沒有差別。
const PI = 3.141592653589793;
const HALF_PI_HI = 1.5707963267948966, HALF_PI_LO = 6.123233995736766e-17;

// |r| ≤ π/4 的泰勒展開（以 r² 做 Horner）
function sinK(r) {
  const z = r * r;
  return r * (1 + z * (-1 / 6 + z * (1 / 120 + z * (-1 / 5040 + z * (1 / 362880 + z * (-1 / 39916800 + z * (1 / 6227020800 + z * (-1 / 1307674368000 + z * (1 / 355687428096000)))))))));
}
function cosK(r) {
  const z = r * r;
  return 1 + z * (-1 / 2 + z * (1 / 24 + z * (-1 / 720 + z * (1 / 40320 + z * (-1 / 3628800 + z * (1 / 479001600 + z * (-1 / 87178291200 + z * (1 / 20922789888000 + z * (-1 / 6402373705728000)))))))));
}
function quad(x) {
  const k = Math.round(x * (2 / PI));
  _r = (x - k * HALF_PI_HI) - k * HALF_PI_LO;
  return ((k % 4) + 4) % 4;
}
let _r = 0;

export function dsin(x) {
  if (!(x - x === 0)) return NaN;
  switch (quad(x)) {
    case 0: return sinK(_r);
    case 1: return cosK(_r);
    case 2: return -sinK(_r);
    default: return -cosK(_r);
  }
}
export function dcos(x) {
  if (!(x - x === 0)) return NaN;
  switch (quad(x)) {
    case 0: return cosK(_r);
    case 1: return -sinK(_r);
    case 2: return -cosK(_r);
    default: return sinK(_r);
  }
}

const TAN_PI_8 = 0.41421356237309503;
function datan(x) {
  if (x < 0) return -datan(-x);
  if (x > 1) return PI / 2 - datan(1 / x);
  let base = 0;
  if (x > TAN_PI_8) { base = PI / 4; x = (x - 1) / (x + 1); }
  // |x| ≤ tan(π/8)：x − x³/3 + x⁵/5 − …（到 x⁴⁵）
  const z = x * x;
  let sum = 0;
  for (let n = 45; n >= 1; n -= 2) sum = (n % 4 === 1 ? 1 : -1) / n + z * sum;
  // 上面的 Horner 每一層都乘了 z，符號已含在係數裡
  return base + x * sum;
}
export function datan2(y, x) {
  if (!(x - x === 0) || !(y - y === 0)) return NaN;
  if (x > 0) return datan(y / x);
  if (x < 0) return y >= 0 ? datan(y / x) + PI : datan(y / x) - PI;
  return y > 0 ? PI / 2 : y < 0 ? -PI / 2 : 0;
}

export function dhypot(x, y, z = 0) { return Math.sqrt(x * x + y * y + z * z); }

const LN2 = 0.6931471805599453, SQRT2 = 1.4142135623730951;
export function dlog(x) {
  if (!(x > 0)) return x === 0 ? -Infinity : NaN;
  if (x === Infinity) return Infinity;
  let e = 0;
  while (x >= SQRT2) { x *= 0.5; e++; }
  while (x < SQRT2 / 2) { x *= 2; e--; }
  // ln(x) = 2·atanh((x−1)/(x+1))，|z| ≤ 0.172
  const z = (x - 1) / (x + 1), z2 = z * z;
  let sum = 0;
  for (let n = 27; n >= 1; n -= 2) sum = 1 / n + z2 * sum;
  return 2 * z * sum + e * LN2;
}
