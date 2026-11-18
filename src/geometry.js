// SPDX-License-Identifier: AGPL-3.0-only
// 純幾何（不碰場景、不碰 DOM）：筆跡平滑與減點、球面多邊形內外判斷、方位角／仰角轉換、鏡像、二次貝茲、提拉方向。
// 瀏覽器與 Node 共用。長度單位公尺；座標是 glTF 慣例（+Y 向上、臉朝 +Z、模型左側 +X）。
import { Vector3 } from '../vendor/three/build/three.module.js';

export const toV = p => p instanceof Vector3 ? p : Array.isArray(p) ? new Vector3(p[0], p[1], p[2]) : new Vector3(p.x, p.y, p.z);

// streamline 平滑（perfect-freehand getStrokePoints 的中心線公式）：每一點往前一點內插，t=0.5 時手抖的高頻抖動減半。
export function streamline(points, t = 0.5) {
  if (points.length < 3) return points.map(p => toV(p).clone());
  const out = [toV(points[0]).clone()];
  for (let i = 1; i < points.length; i++) out.push(out[i - 1].clone().lerp(toV(points[i]), 1 - t));
  out[out.length - 1].copy(toV(points[points.length - 1])); // 最後一點用真實落點，線才不會縮短
  return out;
}

// Ramer–Douglas–Peucker：把密集的控制點減到 tolerance（公尺）以內。
export function rdp(points, tolerance = 0.001) {
  const pts = points.map(toV);
  if (pts.length <= 2) return pts.map(p => p.clone());
  const keep = new Array(pts.length).fill(false); keep[0] = keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  const AB = new Vector3(), AP = new Vector3(), tmp = new Vector3();
  while (stack.length) {
    const [s, e] = stack.pop();
    AB.copy(pts[e]).sub(pts[s]);
    const ab2 = AB.lengthSq();
    let maxD = -1, maxI = -1;
    for (let i = s + 1; i < e; i++) {
      AP.copy(pts[i]).sub(pts[s]);
      let d;
      if (ab2 < 1e-16) d = AP.length();
      else { const t = Math.max(0, Math.min(1, AP.dot(AB) / ab2)); d = tmp.copy(AP).addScaledVector(AB, -t).length(); }
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > tolerance) { keep[maxI] = true; stack.push([s, maxI], [maxI, e]); }
  }
  return pts.filter((_, i) => keep[i]).map(p => p.clone());
}

// 一串點離一條折線最遠多少（公尺）。
export function maxDeviation(points, polyline) {
  const line = polyline.map(toV), AB = new Vector3(), AP = new Vector3();
  let worst = 0;
  for (const raw of points) {
    const p = toV(raw); let best = Infinity;
    for (let i = 0; i + 1 < line.length; i++) {
      AB.copy(line[i + 1]).sub(line[i]); AP.copy(p).sub(line[i]);
      const ab2 = AB.lengthSq(), t = ab2 < 1e-16 ? 0 : Math.max(0, Math.min(1, AP.dot(AB) / ab2));
      best = Math.min(best, AP.addScaledVector(AB, -t).length());
    }
    if (line.length === 1) best = p.distanceTo(line[0]);
    worst = Math.max(worst, best);
  }
  return worst;
}

// 手畫收筆：把手畫的筆跡整理成直線或平順的弧線。
// 筆跡大致是直的（離兩端之間的直線不超過 線長×ratio，至少 minDev）→ 只留兩端＝直線；
// 真的有彎 → 留少數幾個點（tolerance 4 mm；用 1 mm 會把手抖都留下來），畫出來是平順的弧線。
// straight(a, b)：兩端之間「直線」的密集取樣（頭皮上是 scalp.geodesic）；不給就用弦。
export function tidyStroke(points, straight = null, { ratio = 0.1, minDev = 0.006, tolerance = 0.004 } = {}) {
  const pts = streamline(points, 0.5);
  if (pts.length < 3) return pts;
  const a = pts[0], b = pts[pts.length - 1];
  let ref = [a, b];
  if (straight) { try { const r = straight(a, b); if (r && r.length >= 2) ref = r; } catch { /* 算不出來就用弦 */ } }
  if (maxDeviation(pts, ref) <= Math.max(minDev, a.distanceTo(b) * ratio)) return [a.clone(), b.clone()];
  return rdp(pts, tolerance);
}

// 方位角／仰角（度）↔ 單位方向。方位角 0＝正面（+Z）、90＝模型左側（+X）、180＝後面；仰角 0＝水平、90＝頭頂。
export function azElToDir(az, el) {
  const a = az * Math.PI / 180, e = el * Math.PI / 180;
  return new Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
}
export function dirToAzEl(v) {
  const d = toV(v);
  return { az: ((Math.atan2(d.x, d.z) * 180 / Math.PI) % 360 + 360) % 360, el: Math.atan2(d.y, Math.hypot(d.x, d.z)) * 180 / Math.PI };
}

// 球面多邊形內外判斷（crossing number）：從 dir 到參考點 REF（正下方、微微偏一點，永遠不在頭皮上）的大圓弧，
// 和多邊形每一邊相交幾次，奇數＝在裡面。每一邊先用「兩端在測試大圓的不同側」（半開規則，端點剛好在圓上算正側）判斷，
// 這樣頂點正好落在測試圓上也不會重複計數。不用方位角平面做，是因為後腦 az=180 有接縫。
const REF = new Vector3(0.0123, -1, 0.0071).normalize();
export const POLYGON_REF = REF; // 球面多邊形的「外面」參考方向（正下方）：scalp.regionPositions 的粗篩要知道它在哪
const _n1 = new Vector3(), _n2 = new Vector3(), _L = new Vector3(), _c = new Vector3(), _s = new Vector3();
export function insideSphericalPolygon(dir, polyDirs) {
  const P = toV(dir).clone().normalize();
  _n1.crossVectors(P, REF);
  if (_n1.lengthSq() < 1e-18) return false;
  _s.copy(P).add(REF); // 弧 P→REF 的中點方向（弧小於 180°）
  let crossings = 0;
  const n = polyDirs.length;
  for (let i = 0; i < n; i++) {
    const A = polyDirs[i], B = polyDirs[(i + 1) % n];
    const sA = _n1.dot(A) >= 0, sB = _n1.dot(B) >= 0;
    if (sA === sB) continue;
    _n2.crossVectors(A, B);
    _L.crossVectors(_n1, _n2);
    if (_L.lengthSq() < 1e-24) continue;
    _L.normalize();
    if (_L.dot(_c.copy(A).add(B)) < 0) _L.negate(); // 取落在短弧 AB 上的那個交點
    // 交點要在弧 P→REF 之內
    if (_c.crossVectors(P, _L).dot(_n1) >= 0 && _c.crossVectors(_L, REF).dot(_n1) >= 0) crossings++;
  }
  return (crossings & 1) === 1;
}

// 頭皮上一點在不在外輪廓（髮際線那一圈）裡面。
// loopDirs＝外輪廓每點從頭中心出發的單位方向（閉合）；margin（公尺）內離輪廓線夠近也算裡面，手指按在線上就能從線上開始畫。
// 參考點 REF 在正下方（脖子），所以臉、額頭、脖子都在外面，髮際線以上（含耳上、後腦）在裡面。
export function insideOutline(point, center, loopDirs, loopPts, margin = 0) {
  const p = toV(point);
  if (margin > 0 && loopPts) for (const q of loopPts) if (q.distanceTo(p) <= margin) return true;
  return insideSphericalPolygon(p.clone().sub(toV(center)), loopDirs);
}

export const mirrorX = p => { const v = toV(p).clone(); v.x = -v.x; return v; };
export const onMidline = (points, eps = 0.0015) => points.every(p => Math.abs(toV(p).x) <= eps);

export function polylineLength(pts) { let L = 0; for (let i = 1; i < pts.length; i++) L += pts[i].distanceTo(pts[i - 1]); return L; }

// ---------------------------------------------------------------- 二次貝茲彎度點
// 線＝兩端點 S、E ＋ 一個彎度點 M；M=(S+2C+E)/4 在貝茲 t=0.5 的位置，拖 M 反算控制點 C=2M−(S+E)/2。
export function quadPoint(S, C, E, t) { const u = 1 - t; return new Vector3().addScaledVector(toV(S), u * u).addScaledVector(toV(C), 2 * u * t).addScaledVector(toV(E), t * t); }
export function handleFromControl(S, C, E) { return new Vector3().add(toV(S)).addScaledVector(toV(C), 2).add(toV(E)).multiplyScalar(0.25); }
export function controlFromHandle(S, E, M) { return toV(M).clone().multiplyScalar(2).addScaledVector(toV(S).clone().add(toV(E)), -0.5); }
export function quadLength(S, C, E, n = 32) { let L = 0, prev = toV(S); for (let i = 1; i <= n; i++) { const p = quadPoint(S, C, E, i / n); L += p.distanceTo(prev); prev = p; } return L; }
// 把密集折線照弧長等分成 count 個點。
export function resample(points, count) {
  const pts = points.map(toV); const len = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const total = len[len.length - 1]; if (total < 1e-9) throw new Error('線が短すぎます。');
  const out = []; let seg = 0;
  for (let i = 0; i < count; i++) {
    const target = total * i / (count - 1);
    while (seg < pts.length - 2 && len[seg + 1] < target) seg++;
    const t = (target - len[seg]) / Math.max(1e-12, len[seg + 1] - len[seg]);
    out.push(pts[seg].clone().lerp(pts[seg + 1], Math.min(1, Math.max(0, t))));
  }
  return out;
}
// 折線上弧長比例 u（0～1）處的點。
export function pointAtFraction(points, u) {
  const pts = points.map(toV); let total = 0; for (let i = 1; i < pts.length; i++) total += pts[i].distanceTo(pts[i - 1]);
  let target = total * Math.min(1, Math.max(0, u));
  for (let i = 1; i < pts.length; i++) { const d = pts[i].distanceTo(pts[i - 1]); if (target <= d || i === pts.length - 1) return pts[i - 1].clone().lerp(pts[i], d > 0 ? Math.min(1, target / d) : 0); target -= d; }
  return pts[pts.length - 1].clone();
}

// ---------------------------------------------------------------- 提拉方向
// reference：CENTER＝髮片中心頭皮（平行提拉；用中心毛根的基準）、WORLD＝垂直向下為 0°。
// 回傳 { t, n, f }：t＝0° 方向（頭皮上往下的切線；WORLD 是世界向下）、n＝90° 方向（頭皮法線；WORLD 是從頭心往外的水平方向，頭頂改朝臉前）、
// f＝切平面上朝臉前的方向（單根提拉線的轉向橫移軸用；正前方沒有切線方向時額前＝往下、後腦正中＝往上）。
// 轉向不在這裡算：轉向是「髮尾線沿根線方向橫向平移」，在 lift.js 的 swivelAxis／swivelShift。
const DOWN = new Vector3(0, -1, 0), FRONT = new Vector3(0, 0, 1), UP = new Vector3(0, 1, 0);
const projectOut = (v, n) => v.clone().addScaledVector(n, -v.dot(n));
export function liftBasis(normal, reference = 'CENTER') {
  const n0 = toV(normal).clone().normalize();
  if (reference === 'WORLD') {
    let n = projectOut(n0, UP); if (n.length() < 0.03) n = FRONT.clone(); n.normalize();
    let f = projectOut(FRONT, n); if (f.length() < 0.03) f = UP.clone(); f.normalize();
    return { t: DOWN.clone(), n, f };
  }
  let t = projectOut(DOWN, n0);
  if (t.length() < 0.03) t = projectOut(FRONT, n0); // 頭頂附近沒有唯一的「向下」，改用前方
  t.normalize();
  let f = projectOut(FRONT, n0); if (f.length() < 0.03) f = n0.dot(FRONT) >= 0 ? t.clone() : t.clone().negate(); f.normalize();
  return { t, n: n0, f };
}
export function liftDirection(basis, elevationDeg) {
  const a = elevationDeg * Math.PI / 180;
  return basis.t.clone().multiplyScalar(Math.cos(a)).addScaledVector(basis.n, Math.sin(a)).normalize();
}
