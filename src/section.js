// SPDX-License-Identifier: AGPL-3.0-only
// 分線形狀——水平、垂直、前斜、後斜、放射，以及「平行重複」。
//
// 一條分線＝一般的兩點直線（shape 'line'）多記一個 section：{ kind, deg?, pivot? }。
//   線的走法不是兩點之間的最短線，而是「一片平面切頭皮」得到的那條線；平面照地面算（+Y 朝上、臉朝 +Z），不是照螢幕。
//   H 水平＝和地面平行的平面。
//   V 垂直＝和地面垂直的平面。記了 az（切面法線的方位角）＝畫的時候「從那個角度看是一條直線」的那一片（見 verticalAz）；
//           沒記 az（頂視畫的）＝通過兩個端點的那一片。
//   F 前斜＝水平面繞左右軸傾斜 deg 度，往臉的方向低下去；B 後斜＝往後腦的方向低下去（deg 預設 45）。
//   R 放射＝通過樞軸（points[pivot]）、樞軸那裡的頭皮法線、另一個端點的平面。
// 沒有 section 的兩點直線走的是兩點之間的最短線。
// 線被拉彎（有 control）或加了點之後就不是分線了，section 由 app.js 清掉。
import { Vector3 } from '../vendor/three/build/three.module.js';
import { toV, polylineLength, pointAtFraction } from './geometry.js';

const SECTION_KINDS = ['H', 'V', 'F', 'B', 'R'];
export const SECTION_LABELS = { H: '水平', V: '垂直', F: '前下がり', B: '前上がり', R: '放射' };
export const DIAG_DEFAULT = 45, DIAG_MIN = 15, DIAG_MAX = 75, DIAG_STEP = 5;
export const REPEAT = { countMin: 1, countMax: 10, countDefault: 3, gapMin: 0.5, gapMax: 5, gapStep: 0.5, gapDefault: 1.5 };
const PANEL_SPACING = 0.015; // 分線拉成髮片時，根線每 1.5 cm 留一個點（髮片的根線才會照著切面走）
const UP = new Vector3(0, 1, 0);
const MIN_LINE = 0.004; // 短於 4 mm 不算一條線

export const isDiag = kind => kind === 'F' || kind === 'B';
export const canRepeat = section => !!section && SECTION_KINDS.includes(section.kind) && section.kind !== 'R';

export function normalizeSection(s) {
  if (!s || typeof s !== 'object' || !SECTION_KINDS.includes(s.kind)) return null;
  const out = { kind: s.kind };
  if (isDiag(s.kind)) { const d = Number(s.deg); out.deg = Number.isFinite(d) ? Math.min(DIAG_MAX, Math.max(DIAG_MIN, Math.round(d))) : DIAG_DEFAULT; }
  if (s.kind === 'R') out.pivot = s.pivot === 1 ? 1 : 0;
  if (s.kind === 'V' && s.az !== null && s.az !== undefined && Number.isFinite(Number(s.az))) out.az = ((Math.round(Number(s.az) * 10) / 10) % 180 + 180) % 180;
  return out;
}

// 垂直線的切面朝哪邊。和地面垂直的平面有無限多片，選「從現在這個角度看過去是一條直線」的那一片：
// 切面包含「正上方」和「鏡頭看過去的方向」，所以畫出來的線在這個角度看是筆直的上下線（後視＝前後向的切面、側視＝左右向的切面）。
// 回傳切面法線的方位角 az（度，0～180；法線＝(cos az, 0, sin az)）。鏡頭幾乎從正上方或正下方看（頂視）時每片垂直面都是一條線，回 null＝改由兩個端點決定。
// 不交給兩個端點決定，是因為兩點幾乎上下對齊時（從頭側上面畫到頸背）切面方向取決於很小的水平差，線會繞到後腦去。
export function verticalAz(viewDir) {
  const d = toV(viewDir).clone().normalize(), h = d.clone().addScaledVector(UP, -d.dot(UP));
  if (h.length() < 0.25) return null;
  const n = new Vector3().crossVectors(UP, h).normalize();
  return ((Math.round(Math.atan2(n.z, n.x) * 1800 / Math.PI) / 10) % 180 + 180) % 180;
}

// 鏡到另一側的分線：水平、斜線、放射、兩點決定的垂直線都不用改；記了方位角的垂直線，切面左右對調
export function mirrorSection(section) {
  if (!section) return section;
  const out = { ...section };
  if (section.kind === 'V' && Number.isFinite(section.az)) out.az = (180 - section.az) % 180;
  return out;
}

// 水平、前斜、後斜、記了方位角的垂直線：平面方向是固定的（不看端點在哪）；放射、兩點決定的垂直線沒有固定方向，回 null。
export function fixedNormal(section) {
  if (section.kind === 'H') return UP.clone();
  if (section.kind === 'V' && Number.isFinite(section.az)) { const r = section.az * Math.PI / 180; return new Vector3(Math.cos(r), 0, Math.sin(r)); }
  if (isDiag(section.kind)) {
    const r = (section.deg ?? DIAG_DEFAULT) * Math.PI / 180;
    return new Vector3(0, Math.cos(r), section.kind === 'F' ? Math.sin(r) : -Math.sin(r));
  }
  return null;
}

// 這條分線實際用的切面法線（單位向量）。一律再扣掉沿 a→b 的分量，所以平面一定通過兩個端點
// （端點存檔時四捨五入到 0.1 mm，仍然畫得出來）。兩點重合回 null。
function planeNormal(scalp, section, a, b) {
  const A = toV(a), B = toV(b), c = B.clone().sub(A);
  const len = c.length();
  if (len < 1e-6) return null;
  c.multiplyScalar(1 / len);
  let n = fixedNormal(section);
  if (n) { /* 固定方向：下面只扣掉沿 a→b 的分量 */ }
  else if (section.kind === 'V') {
    const h = c.clone().addScaledVector(UP, -c.dot(UP)); // 兩點連線的水平分量
    if (h.lengthSq() < 1e-8) { const nn = scalp.nearest(A).normal; h.copy(nn).addScaledVector(UP, -nn.dot(UP)); } // 兩點正好上下對齊：用頭皮朝外的方向
    if (h.lengthSq() < 1e-8) h.set(0, 0, 1);
    n = new Vector3().crossVectors(UP, h);
  } else if (section.kind === 'R') {
    const pivot = section.pivot === 1 ? B : A;
    n = new Vector3().crossVectors(scalp.nearest(pivot).normal, c);
    if (n.lengthSq() < 1e-8) n.crossVectors(UP, c);
    if (n.lengthSq() < 1e-8) n.set(1, 0, 0);
  } else return null;
  n.addScaledVector(c, -n.dot(c));
  if (n.lengthSq() < 1e-10) return null;
  return n.normalize();
}

// 用通過 a、b、法線 n 的平面切頭皮。切面正好壓在網格的邊上時（最常見：正中線，頭模左右對稱、x＝0 那一排都是網格的邊）
// 一格一格走會卡住，所以切不出來就把切面往旁邊挪 0.02 mm 再切一次（看不出差別）。都切不出來回 null。
function cutLine(scalp, a, b, n) {
  const first = scalp.planeLine(a, b, n);
  if (first) return first;
  const A = toV(a), B = toV(b);
  for (const eps of [2e-5, -2e-5]) {
    const a2 = scalp.nearest(A.clone().addScaledVector(n, eps)).point, b2 = scalp.nearest(B.clone().addScaledVector(n, eps)).point;
    const c = b2.clone().sub(a2);
    if (c.lengthSq() < 1e-12) continue;
    c.normalize();
    const n2 = n.clone().addScaledVector(c, -n.dot(c));
    if (n2.lengthSq() < 1e-10) continue;
    const cut = scalp.planeLine(a2, b2, n2.normalize());
    if (cut) return cut;
  }
  return null;
}

// 一條分線貼頭皮的密集點（抬高 OFFSET）；畫不出來（中間跑出可畫範圍）回 null，呼叫的人退回一般直線。
export function sectionDense(scalp, section, a, b) {
  const n = planeNormal(scalp, section, a, b);
  return n ? cutLine(scalp, a, b, n) : null;
}

// 切面線中間被「不能畫的地方」斷開時的畫法。
// 一片切面可能會經過耳朵：耳朵那一塊不能畫，sectionDense 切不出來；這時退回兩點之間的最短線的話，
// 從左鬢角到右鬢角的水平分線會變成一條繞過頭頂的線，意思整個不對。
// 所以從 a 沿切面走，走到可畫範圍的邊就順著那條邊走（耳朵上緣那一段髮際，最多 maxGap），
// 走到切面再出現的地方接回同一片切面繼續走，直到走到 b。回傳抬高 OFFSET 的密集點；走不到 b 回 null。
const BRIDGE_GAP = 0.08;
export function sectionBridged(scalp, section, a, b, maxGap = BRIDGE_GAP) {
  const n = planeNormal(scalp, section, a, b); if (!n) return null;
  const A = scalp.nearest(a).point, B = scalp.nearest(b).point;
  const lift = c => c.p.clone().addScaledVector(scalp._smoothNormal(c.tri, c.p), SURFACE_LIFT);
  const liftAt = p => { const h = scalp.nearest(p); return h.point.clone().addScaledVector(h.normal, SURFACE_LIFT); };
  const smooth = pts => { let q = pts; for (let pass = 0; pass < 2; pass++) q = q.map((p, i) => (i === 0 || i === q.length - 1 ? p : q[i - 1].clone().add(q[i + 1]).addScaledVector(p, 2).multiplyScalar(0.25))); return q; }; // 邊是一格一格的，磨圓一點
  const dirOf = r => r[Math.min(3, r.length - 1)].p.clone().sub(r[0].p);
  // 從 first 這一段開始走到 b；走不到回 null
  const walk = first => {
    const out = [];
    let run = first, total = 0;
    for (let turn = 0; turn < 6 && run; turn++) {
      const hit = run.findIndex((c, k) => k > 0 && distToSeg(B, run[k - 1].p, c.p) < 5e-4); // b 就在這一段上（差 0.5 mm 內）
      const upto = hit > 0 ? hit : run.length;
      for (let i = 0; i < upto; i++) { const p = lift(run[i]); if (out.length && p.distanceTo(out[out.length - 1]) < 1e-6) continue; out.push(p); }
      if (hit > 0) { out.push(lift({ p: B, tri: run[hit].tri })); return out.length >= 2 ? out : null; }
      if (run.closed) return null; // 繞了一圈都沒碰到 b
      total += run.length_; if (total > 0.6) return null;
      // 走到可畫範圍的邊：順著那條邊走到切面再出現的地方
      const end = run[run.length - 1].p, dir = end.clone().sub(run[Math.max(0, run.length - 4)].p);
      dir.addScaledVector(n, -dir.dot(n)); if (dir.lengthSq() < 1e-12) return null; dir.normalize();
      const hop = scalp.boundaryHop(end, n, A, dir, maxGap); if (!hop) return null;
      total += hop.length;
      for (const p of smooth([end, ...hop.path]).slice(1, -1)) out.push(liftAt(p));
      const cands = runsFrom(scalp, hop.point, n, { maxLen: 0.6 }).filter(r => r.length > 1);
      run = cands.find(r => dirOf(r).dot(dir) > 0) || cands[0] || null; // 朝走過來的方向繼續走
    }
    return null;
  };
  // 兩個方向都試，取走得到 b 而且比較短的那一條
  let best = null, bestLen = Infinity;
  for (const first of runsFrom(scalp, A, n, { maxLen: 0.6 }).filter(r => r.length > 1)) {
    const d = walk(first); if (!d) continue;
    const L = polylineLength(d); if (L < bestLen) { bestLen = L; best = d; }
  }
  return best;
}
function distToSeg(p, a, b) { const ab = b.clone().sub(a), L = ab.lengthSq(), u = L ? Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / L)) : 0; return a.clone().addScaledVector(ab, u).distanceTo(p); }
const SURFACE_LIFT = 0.0009; // 和 scalp.js 的 OFFSET 一樣（線沿法線抬 0.9 mm）

// 從 origin 沿切面往兩邊走（scalp.planeRuns）。切面正好壓在網格的邊上（正中線）時起點那一格走不出去，
// 和 cutLine 一樣把起點往旁邊挪 0.02 mm 再走。
function runsFrom(scalp, origin, n, opts) {
  let runs = scalp.planeRuns(origin, n, opts);
  if (runs.some(r => r.length > 1)) return runs;
  for (const eps of [2e-5, -2e-5]) {
    runs = scalp.planeRuns(scalp.nearest(toV(origin).clone().addScaledVector(n, eps)).point, n, opts);
    if (runs.some(r => r.length > 1)) return runs;
  }
  return runs;
}

// 兩段切面線上離 target 最近的點。回傳 { q, atStop }：atStop＝最近的點就是「走到外輪廓停下來」的那個盡頭（手指在更外面）。
function nearestOnRuns(runs, target) {
  let best = null, bd = Infinity;
  for (const run of runs) for (let i = 1; i < run.length; i++) {
    const a = run[i - 1].p, ab = run[i].p.clone().sub(a), L = ab.lengthSq();
    const u = L ? Math.max(0, Math.min(1, target.clone().sub(a).dot(ab) / L)) : 0;
    const q = a.clone().addScaledVector(ab, u), d = q.distanceTo(target);
    if (d < bd) { bd = d; best = { q, atStop: !!run.stopped && i === run.length - 1 && u === 1 }; }
  }
  return best;
}

// 畫的時候用：起點 a（頭皮上）固定，手指在 b。回傳 { a, b, dense, clipped }：
//   水平／前斜／後斜：b 取「通過 a 的那片切面」在頭皮上離手指最近的地方（線只能沿著切面走）。
//   垂直／放射：b 照手指的位置，平面跟著兩點轉。
//   inside(p)＝這一點在不在外輪廓裡面；線走到外輪廓就停（clipped＝true），所以整條線都在外輪廓裡面。
// 畫不出來回 null。
export function fitSection(scalp, section, a, b, inside = null) {
  const A = scalp.nearest(a).point;
  const fixed = fixedNormal(section);
  let B, clipped = false;
  if (fixed) {
    const hit = nearestOnRuns(runsFrom(scalp, A, fixed, { stop: inside ? p => !inside(p) : null }), toV(b));
    B = hit ? hit.q : null;
    clipped = !!hit && hit.atStop && hit.q.distanceTo(toV(b)) > 0.003; // 手指在外輪廓外面 3 mm 以上：線只畫到外輪廓
  } else B = scalp.nearest(b).point;
  if (!B || A.distanceTo(B) < 1e-4) return null;
  const n = planeNormal(scalp, section, A, B);
  if (!n) return null;
  let dense = cutLine(scalp, A, B, n);
  if (!dense) return null;
  // 走到外輪廓就停：終點取最後一個還在裡面的點，再照「只記兩個端點」重畫一次（存檔讀回來就是這樣畫的，所以回傳的就是之後看到的那條）
  for (let pass = 0; inside && pass < 4; pass++) {
    let i = 0;
    while (i < dense.length && inside(dense[i])) i++;
    if (i === dense.length) break;
    if (i < 2) return null;
    clipped = true; B = scalp.nearest(dense[i - 1]).point;
    const n2 = planeNormal(scalp, section, A, B), again = n2 ? cutLine(scalp, A, B, n2) : null;
    if (!again) return null;
    dense = again;
  }
  if (inside && !dense.every(inside)) return null;
  return { a: A, b: B, dense, clipped };
}

// 平行重複時「正的方向」：水平、前斜、後斜＝往上；垂直＝往前（切面朝前後）或往左（切面朝左右）。
function repeatNormal(scalp, section, a, b) {
  const n = fixedNormal(section) || planeNormal(scalp, section, a, b);
  if (!n) return null;
  if (section.kind === 'V' && (Math.abs(n.z) >= Math.abs(n.x) ? n.z < 0 : n.x < 0)) n.negate();
  return n;
}
// 平行重複那兩顆方向鈕上的字：[正的方向, 反的方向]
export function repeatDirLabels(scalp, section, a, b) {
  if (section.kind !== 'V') return ['上へ', '下へ'];
  const n = repeatNormal(scalp, section, a, b);
  return n && Math.abs(n.z) < Math.abs(n.x) ? ['左へ', '右へ'] : ['前へ', '後ろへ'];
}

// 一個點離一條折線多遠（量到線段上，不是只量到折線的點）
function distanceToPolyline(line, p) {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], ab = line[i].clone().sub(a), L = ab.lengthSq();
    const u = L ? Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / L)) : 0;
    best = Math.min(best, a.clone().addScaledVector(ab, u).distanceTo(p));
  }
  return best;
}

// 在頭皮上從 start 往 n 的方向（投到頭皮的切面上）走 dist 公尺，回傳走到的點；
// 切面和頭皮幾乎平行（例如水平面碰到頭頂）或走到可畫範圍的邊，回 null。
function walkAcross(scalp, start, n, dist, step = 0.0005) {
  let h = scalp.nearest(start), q = h.point, gone = 0;
  for (let k = 0; k < 4000 && gone < dist - 1e-9; k++) {
    const t = n.clone().addScaledVector(h.normal, -n.dot(h.normal));
    if (t.length() < 0.08) return null;
    const s = Math.min(step, dist - gone);
    const nh = scalp.nearest(q.clone().addScaledVector(t.normalize(), s));
    const moved = nh.point.distanceTo(q);
    if (moved < s * 0.3) return null;
    gone += moved; q = nh.point; h = nh;
  }
  return q;
}

// 平行重複：照一條分線（水平、垂直、前斜、後斜）再畫 count 條，每條隔 gapCm 公分、往 dir（+1／−1，見 repeatNormal）那一邊。
//   間隔沿著頭皮量，量的位置是基準那條線的中點（頭皮是彎的，兩片平面隔 1 cm 不等於頭皮上隔 1 cm）。
//   每條新線和基準那條一樣長、對齊同一個中點；碰到外輪廓就停在外輪廓上。
// 回傳 { lines: [{ a, b }], skipped }：skipped＝畫不出來的條數（整條在外輪廓外面、或水平面已經到頭頂上面）。
export function parallelSections(scalp, section, a, b, { count = REPEAT.countDefault, gapCm = REPEAT.gapDefault, dir = 1, inside = null } = {}) {
  const out = { lines: [], skipped: 0 };
  const base = canRepeat(section) ? sectionDense(scalp, section, a, b) : null;
  const n = base ? repeatNormal(scalp, section, a, b) : null;
  if (!n) { out.skipped = count; return out; }
  const A = toV(a), B = toV(b), half = polylineLength(base) / 2, across = n.clone().multiplyScalar(dir >= 0 ? 1 : -1);
  let M = scalp.nearest(pointAtFraction(base, 0.5)).point;
  for (let i = 0; i < count; i++) {
    M = walkAcross(scalp, M, across, gapCm / 100);
    if (!M || (inside && !inside(M))) { out.skipped += count - i; break; } // 再過去也一樣，不用試了
    const stop = inside ? p => !inside(p) : null;
    let runs = runsFrom(scalp, M, n, { maxLen: half, stop });
    const loop = runs.find(r => r.closed);
    if (loop) runs = runsFrom(scalp, M, n, { maxLen: Math.min(half, loop.length_ * 0.45), stop }); // 這個高度會繞頭一圈：最多畫到接近一圈，兩頭不重疊
    if (runs.length < 2) { out.skipped++; continue; }
    const toA = A.clone().sub(B);
    const lead = r => (r.length > 1 ? r[1].p.clone().sub(M).dot(toA) : 0); // 這一段是往基準線的 a 那一頭走，還是往 b 那一頭
    const [ra, rb] = lead(runs[0]) >= lead(runs[1]) ? [runs[0], runs[1]] : [runs[1], runs[0]];
    const pa = ra[ra.length - 1].p, pb = rb[rb.length - 1].p;
    if (ra.length_ + rb.length_ < MIN_LINE) { out.skipped++; continue; }
    const dense = sectionDense(scalp, section, pa, pb);
    // 存檔只記兩個端點：重畫出來要真的經過這個中點才算。量的是「離這條線」多遠，不是離最近的那個點：
    // 切面線每過一條網格邊才有一個點，切面和網格的邊幾乎平行時（正中線旁邊的垂直線）兩點之間可以隔 7～9 mm，只量到點會把正中線旁邊那一條誤判成沒經過中點。
    if (!dense || distanceToPolyline(dense, M) >= 0.003) { out.skipped++; continue; }
    out.lines.push({ a: pa.clone(), b: pb.clone() });
  }
  return out;
}

// 分線拉成髮片：根線取沿著切面每 spacing 一個點（髮片的根線是「通過每個點的曲線」，只留兩端會變成最短線）。
export function sectionControlPoints(scalp, dense, spacing = PANEL_SPACING) {
  const k = Math.max(1, Math.round(polylineLength(dense) / spacing)), out = [];
  for (let i = 0; i <= k; i++) out.push(scalp.nearest(pointAtFraction(dense, i / k)).point);
  return out;
}
