// SPDX-License-Identifier: AGPL-3.0-only
// 提拉髮片（panel）、單根提拉線（strand）、角度扇形（fan）的幾何，以及放下之後的樣子。座標是 glTF 慣例（+Y 上、臉朝 +Z）。
// lift 的欄位：elevation（提拉角度，度）、length_cm（髮長）、reference（CENTER＝照頭皮；WORLD＝垂直向下為 0°）、
//   swivel（轉向，度）、style（畫法，見 PANEL_STYLES）、strands（髮束數；ARROWS 時＝箭頭數）、
//   cut（切口）、fixed（固定方向）、follow（跟前一片）。
// ARROWS（預設）的畫法：根線照畫出來的線、提拉用細箭頭（只畫兩端與幾根代表）、髮尾用虛線連起來、不填色。
//
// 轉向 θ（−80～80°）＝髮尾那條線整條沿「根線方向」橫移 s＝L·tanθ；每根髮束從自己的毛根連到平移後的髮尾點，
//   所以髮束實際長度＝√(L²+s²)、和不轉向的方向夾 θ。設定的「髮長」L 仍是根線到髮尾線的垂直距離。
//   橫向＝根線兩端連線去掉提拉方向分量後的方向（swivelAxis）；正值一律朝臉前（+Z；根線前後對稱時朝上 +Y、再不行朝模型左 +X），
//   所以鏡像配對兩邊用同一個值就左右對稱，不用取負。提拉 0°～180° 都有作用；貼著頭皮時髮束用 hairPath 沿頭皮走（方向＝毛根到平移後髮尾、長度 √(L²+s²)）。
//   扇形沒有轉向；單根提拉線沒有根線，「根線方向」用切平面上朝臉前的方向（basis.f）代替。
// 切口 cut＝[[u, r], …]，u＝沿根線的弧長比例 0～1、r＝該處髮束留下的長度比例（0.05～1，只會剪短）；
//   髮束長度＝√(L²+s²)·r(u)，r 在 cut 的點之間線性內插、兩端外面取最近的值。沒有 cut＝全部等長（髮尾虛線）；有 cut＝髮尾線畫成剪線。
import { Vector3 } from '../vendor/three/build/three.module.js';
import { liftBasis, liftDirection, resample, toV } from './geometry.js';
import { OFFSET } from './scalp.js';

const REFERENCES = ['CENTER', 'WORLD']; // CENTER＝頭皮（髮片用中心那根的基準，平行提拉）；WORLD＝垂直向下為 0°
const PANEL_STYLES = ['ARROWS', 'OUTLINE', 'STRANDS', 'TINT', 'RIBBONS', 'BLOCK']; // 根線＋箭頭＋虛線髮尾／只有外框／外框＋髮束線／半透明色面＋髮束線／間隔色帶＋髮束線／實心色塊＋細邊
const SWIVEL_MAX = 80; // 轉向 ±80°（±90° 會無限長）
export const CUT_MIN = 0.05; // 切口最少留 5%
export const DEFAULT_LIFT = () => ({ elevation: 90, length_cm: 8, reference: 'CENTER', swivel: 0, style: 'ARROWS', strands: 3 });
const FAN_ANGLES = [0, 30, 60, 90, 120, 150, 180];
// 固定方向提拉（方形層次用）。lift.fixed＝UP／BACK／SIDE／FRONT：每根髮束都朝同一個「世界座標」的方向拉，
// 不跟頭皮的弧度走（頭皮 90° 是每個位置垂直自己那塊頭皮；固定方向是整片都朝上／正後／正側／正前）。
// SIDE＝朝自己那一側（髮片在模型左側朝 +X、右側朝 −X；剛好在正中線上算左側），所以鏡像配對兩邊各朝各的外側。
// fixed 開著時提拉角度與基準不起作用（值留著，關掉固定方向就回到設定的角度）；轉向照常有作用。
export const FIXED_DIRS = ['UP', 'BACK', 'SIDE', 'FRONT'];
function fixedDirection(kind, x = 0) {
  if (kind === 'UP') return new Vector3(0, 1, 0);
  if (kind === 'BACK') return new Vector3(0, 0, -1);
  if (kind === 'FRONT') return new Vector3(0, 0, 1);
  if (kind === 'SIDE') return new Vector3(x < -0.003 ? -1 : 1, 0, 0);
  return null;
}

// 切口：合法就回排好序、夾在範圍內、四捨五入到千分位的 [[u, r], …]；不合法、少於兩點、或全部都是 1（沒剪到）就回 undefined
export function normalizeCut(cut) {
  if (!Array.isArray(cut)) return undefined;
  const pts = cut.filter(c => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]))
    .map(c => [Math.min(1, Math.max(0, c[0])), Math.min(1, Math.max(CUT_MIN, c[1]))]).sort((a, b) => a[0] - b[0]);
  if (pts.length < 2 || pts.every(c => c[1] >= 1 - 1e-9)) return undefined;
  return pts.map(c => [Math.round(c[0] * 1000) / 1000, Math.round(c[1] * 1000) / 1000]);
}
// 沿根線比例 u 處留下的長度比例：cut 的點之間線性內插，兩端外面取最近的值；沒有 cut＝1
export function cutRatio(cut, u) {
  if (!cut || !cut.length) return 1;
  if (u <= cut[0][0]) return cut[0][1];
  for (let i = 0; i + 1 < cut.length; i++) { const [a, ra] = cut[i], [b, rb] = cut[i + 1]; if (u <= b) return b > a ? ra + (rb - ra) * (u - a) / (b - a) : rb; }
  return cut[cut.length - 1][1];
}

// 把一份 lift 整理成合法的值：數字夾在範圍內，不認得的基準、畫法用預設；cut、fixed、follow 有才帶。
export function normalizeLift(l = {}) {
  const d = DEFAULT_LIFT();
  const num = (v, lo, hi, def) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);
  const out = {
    elevation: num(l.elevation, 0, 180, d.elevation), length_cm: num(l.length_cm, 0.5, 60, d.length_cm),
    reference: REFERENCES.includes(l.reference) ? l.reference : d.reference, swivel: num(l.swivel, -SWIVEL_MAX, SWIVEL_MAX, d.swivel),
    style: PANEL_STYLES.includes(l.style) ? l.style : d.style, strands: Math.round(num(l.strands, 2, 30, d.strands)),
  };
  const cut = normalizeCut(l.cut); if (cut) out.cut = cut;
  if (FIXED_DIRS.includes(l.fixed)) out.fixed = l.fixed; // 固定方向提拉
  if (l.follow === true) out.follow = true; // 跟前一片（移動導線）：角度、髮長、切口照這一頁的前一片髮片（effectiveLift）
  return out;
}

// 毛根＝頭皮上的點。回傳 { root, normal, basis, dir }（root 已抬高；dir＝不轉向的提拉方向）。
function rootAt(scalp, p, lift, basisOverride = null, dirOverride = null) {
  const h = scalp.nearest(toV(p));
  const basis = basisOverride || liftBasis(h.normal, lift.reference);
  return { root: h.point.clone().addScaledVector(h.normal, OFFSET), normal: h.normal, basis, dir: dirOverride ? dirOverride.clone() : liftDirection(basis, lift.elevation), fixed: !!dirOverride };
}
// 髮束怎麼走：固定方向一律照直線走、碰到頭才沿頭皮滑（fixed）；其他照 pathMode
const modeOf = (lift, r) => (r.fixed ? 'fixed' : pathMode(lift.reference, r.normal, r.dir));

// 轉向的橫移軸：根線方向 rootDir 去掉提拉方向 dir 的分量、正規化；正值朝臉前 +Z（根線前後對稱時朝上 +Y、再不行朝模型左 +X）。根線和提拉方向平行時回 null（沒有橫向）。
function swivelAxis(rootDir, dir) {
  const u = toV(rootDir).clone(); u.addScaledVector(dir, -u.dot(dir));
  if (u.lengthSq() < 1e-10) return null;
  u.normalize();
  const sign = Math.abs(u.z) > 0.2 ? Math.sign(u.z) : Math.abs(u.y) > 0.2 ? Math.sign(u.y) : (Math.sign(u.x) || 1);
  return u.multiplyScalar(sign);
}
// 橫移量 s＝L·tanθ（公尺）
const swivelShift = (lenM, swivelDeg) => lenM * Math.tan(Math.min(SWIVEL_MAX, Math.max(-SWIVEL_MAX, swivelDeg)) * Math.PI / 180);

// 一根髮束從毛根沿提拉方向走，遇到頭殼就沿表面走（像真髮貼著頭型落下），任何基準都適用；不這樣，垂直向下的髮束會穿進頭裡。
// 每步 4 mm：下一點若進到身體裡（離表面不到 OFFSET），就投回表面抬 OFFSET 繼續走，直到走完 len（沿線量）。
// 直線一路都在頭外就直接回兩點。
// 兩種走法（頭是凸的，所以「投回表面後走切線」會立刻離開頭、變成一條直切線，不能用）：
//   fixed（垂直向下基準一律用這個）＝方向固定不變，像重力：每步往同一個方向走，進到頭殼內就推回表面；貼著頭滑到頭的最寬處以下就自然垂直垂下。
//   surface（頭皮基準、提拉 0° 貼著頭皮時）＝一路沿表面走：每步走完就投回表面、方向換成新切平面上的投影，箭頭順著頭型畫到底。
const HAIR_STEP = 0.004;
// 碰撞面＝頭＋整個胸像（scalp.nearestBody；脖子、肩膀也擋得住）
const surfaceAt = (scalp, p) => scalp.nearestBody(p);
// depth > 0＝太近或進到身體裡。胸像下緣以下沒有身體，一律算在外面。
const insideBy = (scalp, p) => { const h = surfaceAt(scalp, p); return { h, depth: p.y < scalp.bodyFloor ? -1 : OFFSET - p.clone().sub(h.point).dot(h.normal) }; };
const tangentOf = (d, n) => { let t = d.clone().addScaledVector(n, -d.dot(n)); if (t.lengthSq() < 1e-8) { t = new Vector3(0, -1, 0).addScaledVector(n, n.y); if (t.lengthSq() < 1e-8) t = new Vector3(0, 0, 1).addScaledVector(n, -n.z); } return t.normalize(); }; // 正對著頭殼：沿頭皮向下（頭頂就向前）
function pathMode(reference, normal, dir) { return reference !== 'WORLD' && Math.abs(toV(dir).dot(toV(normal))) < 0.02 ? 'surface' : 'fixed'; }
function hairPath(scalp, root, dir, len, mode = 'fixed') {
  const pts = [root.clone()];
  let p = root.clone(), remaining = len, guard = 0;
  if (mode === 'surface') {
    let d = dir.clone();
    while (remaining > 1e-5 && guard++ < 600) {
      const step = Math.min(HAIR_STEP, remaining);
      const h = surfaceAt(scalp, p.clone().addScaledVector(d, step));
      const q = h.point.clone().addScaledVector(h.normal, OFFSET);
      const moved = p.distanceTo(q); if (moved < 1e-6) break;
      d = tangentOf(d, h.normal);
      remaining -= moved; p = q; pts.push(p);
    }
    return pts;
  }
  const tip = root.clone().addScaledVector(dir, len);
  let straight = true;
  const k = Math.max(1, Math.ceil(len / HAIR_STEP));
  for (let i = 1; i <= k && straight; i++) { if (insideBy(scalp, root.clone().lerp(tip, i / k)).depth > 1e-5) straight = false; }
  if (straight) return [root.clone(), tip]; // 一路都在頭外：只要兩點
  while (remaining > 1e-5 && guard++ < 600) {
    const step = Math.min(HAIR_STEP, remaining);
    let q = p.clone().addScaledVector(dir, step);
    const { h, depth } = insideBy(scalp, q);
    if (depth > 1e-5) {
      q = h.point.clone().addScaledVector(h.normal, OFFSET);
      if (p.distanceTo(q) < step * 0.25) { // 方向幾乎正對著頭殼（例如頭頂往下）：沿表面朝這個方向的切線分量走一步再推回表面
        const h2 = surfaceAt(scalp, p.clone().addScaledVector(tangentOf(dir, h.normal), step));
        q = h2.point.clone().addScaledVector(h2.normal, OFFSET);
      }
    }
    const moved = p.distanceTo(q); if (moved < 1e-6) break;
    remaining -= moved; p = q; pts.push(p);
  }
  return pts;
}
// 一根髮束：毛根 r、不轉向的髮長 len、橫移軸 axis 與橫移量 s、留下的比例 ratio → 折線、末端、實際方向。
// 方向＝毛根到平移後髮尾（dir·len + axis·s）、長度 √(len²+s²)·ratio；走法（mode）照不轉向的方向判斷，0° 貼頭皮時仍沿表面走。
function strandPath(scalp, r, len, axis, s, mode, ratio = 1) {
  const d = axis && Math.abs(s) > 1e-9 ? r.dir.clone().multiplyScalar(len).addScaledVector(axis, s).normalize() : r.dir;
  const path = hairPath(scalp, r.root, d, Math.hypot(len, s) * ratio, mode);
  return { path, tip: path[path.length - 1], dir: d };
}
// 髮片共用的設定：基準＝中間那根（照 lift.strands 取樣的中間那個，和畫出來的一樣）、髮長 len（公尺）、
// 固定方向 fdir（整片同一個方向；沒開是 null）、轉向的橫移軸 axis 與橫移量 s
function panelSetup(scalp, denseRoot, lift) {
  const n = Math.max(2, lift.strands), samples = resample(denseRoot, n);
  const basis = liftBasis(scalp.nearest(samples[Math.floor(n / 2)]).normal, lift.reference);
  const len = lift.length_cm / 100;
  const fdir = lift.fixed ? fixedDirection(lift.fixed, samples.reduce((a, p) => a + toV(p).x, 0) / samples.length) : null;
  const axis = swivelAxis(toV(denseRoot[denseRoot.length - 1]).clone().sub(toV(denseRoot[0])), fdir || liftDirection(basis, lift.elevation));
  const s = axis ? swivelShift(len, lift.swivel) : 0;
  return { basis, len, axis, s, fdir };
}
// 髮片：根線的密集點（denseRoot，已貼頭皮）照弧長取 lift.strands 個毛根，每根沿提拉方向長 length_cm（遇頭殼沿頭皮走，見 hairPath）。
// CENTER 與 WORLD 都用中間那根的基準給全部（平行提拉）。回傳 paths（每根的折線）、tips（每根的末端）、tipLine（髮尾線的點：沒切口＝tips；
// 有切口＝沿根線至少取 17 個樣本，切口形狀才圓滑）、axis／shift（轉向的橫移軸與量）、length（髮束實際長度 √(L²+s²)）。
// opts.ignoreCut＝true 時不套切口（小剪刀要拿「沒剪」的髮束算切到哪裡）。
export function panelGeometry(scalp, denseRoot, lift, opts = {}) {
  const n = Math.max(2, lift.strands);
  const samples = resample(denseRoot, n);
  const midIdx = Math.floor(n / 2);
  const { basis, len, axis, s, fdir } = panelSetup(scalp, denseRoot, lift);
  const cut = opts.ignoreCut ? undefined : lift.cut;
  const one = (p, u) => {
    const r = rootAt(scalp, p, lift, basis, fdir);
    return { r, ...strandPath(scalp, r, len, axis, s, modeOf(lift, r), cutRatio(cut, u)) };
  };
  const roots = [], tips = [], dirs = [], paths = [];
  samples.forEach((p, i) => { const k = one(p, i / (n - 1)); roots.push(k.r.root); dirs.push(k.dir); paths.push(k.path); tips.push(k.tip); });
  let tipLine = tips;
  if (cut) { const K = Math.max(n, 17); tipLine = resample(denseRoot, K).map((p, i) => one(p, i / (K - 1)).tip); }
  return { roots, tips, dirs, paths, tipLine, basis, mid: midIdx, axis, shift: s, length: Math.hypot(len, s) };
}
// 單根提拉線：一個毛根、一條線（遇頭殼沿頭皮走）。轉向的橫移軸＝切平面上朝臉前的方向去掉提拉方向分量。
export function strandGeometry(scalp, point, lift) {
  const r = rootAt(scalp, point, lift, null, lift.fixed ? fixedDirection(lift.fixed, toV(point).x) : null);
  const len = lift.length_cm / 100;
  const axis = swivelAxis(r.basis.f, r.dir), s = axis ? swivelShift(len, lift.swivel) : 0;
  const k = strandPath(scalp, r, len, axis, s, modeOf(lift, r));
  return { root: r.root, tip: k.tip, path: k.path, dir: k.dir, basis: r.basis, axis, shift: s, length: Math.hypot(len, s) };
}
// 角度扇形：0～180°、每 30° 一條，外加一條弧（每條射線遇頭殼沿頭皮走，弧連各角度的末端）。扇形沒有轉向。
export function fanGeometry(scalp, point, lift) {
  const r = rootAt(scalp, point, { ...lift, elevation: 0 });
  const len = lift.length_cm / 100;
  const endAt = a => { const d = liftDirection(r.basis, a); return hairPath(scalp, r.root, d, len, pathMode(lift.reference, r.normal, d)); };
  const rays = FAN_ANGLES.map(a => { const path = endAt(a); return { angle: a, tip: path[path.length - 1], path }; });
  const arc = []; for (let a = 0; a <= 180; a += 3) { const path = endAt(a); arc.push(path[path.length - 1]); }
  return { root: r.root, rays, arc, basis: r.basis };
}

// ================================================================ 放下
// 每根髮束照自己的髮長從毛根垂直往下，碰到頭、耳朵、脖子、肩膀就沿表面滑下去（hairPath 的 fixed 走法）；髮尾連起來就是放下後的外形線。
// 每根的髮長和拉起來時一樣（含轉向與切口）：拉起來多長，放下就多長。
const FALL_DIR = new Vector3(0, -1, 0);
// 放下時每根髮束的毛根與髮長（公尺）：count 根、沿根線弧長等分；髮長＝轉向後的實際長度 × 切口留下的比例。
function fallenStrands(scalp, denseRoot, lift, count) {
  const { len, s } = panelSetup(scalp, denseRoot, lift), full = Math.hypot(len, s);
  return resample(denseRoot, count).map((p, i) => ({ root: rootAt(scalp, p, lift).root, length: full * cutRatio(lift.cut, i / (count - 1)) }));
}
// 放下的髮片。回傳 roots、paths、tips（畫髮束用）、tipLine（至少 17 點：放下後的外形線）、lengths（每根髮長）。
// opts.strands＝畫幾根（預設 lift.strands）。
export function fallenPanelGeometry(scalp, denseRoot, lift, opts = {}) {
  const n = Math.max(2, opts.strands || lift.strands);
  const fall = st => hairPath(scalp, st.root, FALL_DIR, st.length, 'fixed');
  const drawn = fallenStrands(scalp, denseRoot, lift, n), paths = drawn.map(fall);
  const tipLine = fallenStrands(scalp, denseRoot, lift, Math.max(n, 17)).map(st => { const p = fall(st); return p[p.length - 1]; });
  return { roots: drawn.map(st => st.root), paths, tips: paths.map(p => p[p.length - 1]), tipLine, lengths: drawn.map(st => st.length) };
}
// 放下的單根提拉線：髮長＝轉向後的實際長度
export function fallenStrandGeometry(scalp, point, lift) {
  const g = strandGeometry(scalp, point, lift), path = hairPath(scalp, g.root, FALL_DIR, g.length, 'fixed');
  return { root: g.root, path, tip: path[path.length - 1], length: g.length };
}

// ================================================================ 跟前一片（移動導線）
// 每一片照前一片的長度剪，導線跟著走，長度一路一樣。
// 前一片＝這一頁裡排在它前面、最近的那一片髮片（鏡像配成對的取和它同一側的那一片；自己的鏡像不算）。沒有回 null。
const meanX = l => (l.points && l.points.length ? l.points.reduce((a, p) => a + p.x, 0) / l.points.length : 0);
export function previousPanel(layers, layer) {
  const i = layers.findIndex(l => l.id === layer.id);
  for (let j = (i < 0 ? layers.length : i) - 1; j >= 0; j--) {
    const c = layers[j]; if (c.shape !== 'panel' || c.id === layer.mirrorPairId) continue;
    const mate = c.mirrorPairId ? layers.find(l => l.id === c.mirrorPairId && l.shape === 'panel' && l.id !== layer.id) : null;
    return mate && Math.abs(meanX(mate) - meanX(layer)) < Math.abs(meanX(c) - meanX(layer)) ? mate : c;
  }
  return null;
}
// 畫圖、放下實際用的 lift：follow 開著＝角度、基準、轉向、髮長、切口、固定方向都照前一片（前一片也 follow 就再往前找）；畫法、髮束數照自己。
// 前面沒有髮片＝照自己的設定。
export function effectiveLift(layer, layers, seen = new Set()) {
  const lift = layer.lift; if (!lift || !lift.follow || seen.has(layer.id)) return lift;
  seen.add(layer.id);
  const prev = previousPanel(layers, layer); if (!prev || !prev.lift) return lift;
  const src = effectiveLift(prev, layers, seen);
  const out = { ...lift, elevation: src.elevation, length_cm: src.length_cm, reference: src.reference, swivel: src.swivel };
  delete out.cut; delete out.fixed;
  if (src.fixed) out.fixed = src.fixed;
  if (src.cut) out.cut = src.cut;
  return out;
}
