// SPDX-License-Identifier: AGPL-3.0-only
// 頭上的點位（十五點：九個中線點＋六個側面點）、外輪廓（髮際線那一圈）與結構參考線。
// 外輪廓的節點存在每顆頭的資料檔（assets/heads/*.json）的 outline（左半邊，公尺）：
//   outline.front  C.P → 額角 → 太陽穴 → 鬢角尖（最後一點＝鬢角尖 S.C.P）
//   outline.tip    鬢角尖
//   outline.rear   鬢角尖之後 → 繞耳朵外緣（側面看在耳殼外面）→ 耳後 → 頸側 → N.P（最後一點＝N.P，在中線上）
//   outline.index  { fsp, sp }＝front 的序號；{ ep, ebp, nsp }＝rear 的序號（E.P＝耳上那段離耳根最高點最近的點）
//   outline.right  左右不對稱的頭才有：右半邊自己的一份（格式同上，x 已經翻成正的）。沒有的頭，右半邊是左半邊的鏡像。
// 這裡負責把節點連成線、算出點位與結構線。
// 方位角 0＝正面、90＝模型左側、180＝後面；仰角 0＝水平、90＝頭頂（和 geometry.js 的 azElToDir 相同）。
// 點位是吸附候選，也是外輪廓與結構線的骨架。
import { Vector3, CatmullRomCurve3 } from '../vendor/three/build/three.module.js';
import { azElToDir, dirToAzEl, mirrorX } from './geometry.js';
import { OFFSET } from './scalp.js';

const V = a => new Vector3(a[0], a[1], a[2]);
const sidePoint = (a, side) => new Vector3(side === 'L' ? a[0] : -a[0], a[1], a[2]);
const specFor = (s, side) => (side === 'R' && s.right ? s.right : s); // 這一側用哪一份節點
function outlineSpec(scalp) {
  if (!scalp.outlineSpec) throw new Error('外周ラインのデータが未読み込みです：先に computeLandmarks(scalp, meta) を呼んでください。頭のデータには outline が必要です');
  return scalp.outlineSpec;
}

// 側面六點（左右各一）。knot＝取 outline 的節點（哪一段、哪個序號），ear＝耳側三點（earPoints）。
const SIDE_RULES = [
  { id: 'F.S.P', name: 'フロントサイドポイント（額の角）', knot: ['front', 'fsp'] },
  { id: 'S.P', name: 'サイドポイント（こめかみ）', knot: ['front', 'sp'] },
  { id: 'S.C.P', name: 'サイドコーナーポイント（もみあげの先）', ear: 'scp' },
  { id: 'E.P', name: 'イヤーポイント（耳の付け根の一番上）', ear: 'ep' },
  { id: 'E.B.P', name: 'イヤーバックポイント', ear: 'ebp' },
  { id: 'N.S.P', name: 'ネープサイドポイント', knot: ['rear', 'nsp'] },
];

const toSkull = (scalp, p) => scalp._skullNearest(p);
// 耳側三點：鬢角尖（tip）、耳點與耳後點（rear 的節點），各自投到頭殼。
function earPoints(scalp, s0, side) {
  const s = specFor(s0, side), on = a => toSkull(scalp, sidePoint(a, side)).point.clone();
  return { scp: on(s.tip), ep: on(s.rear[s.index.ep]), ebp: on(s.rear[s.index.ebp]) };
}

// 把 az/el 方向從頭心射到頭表面；一律投到「頭殼」（頭網格去掉耳朵）：經過耳朵時落在耳根。
function onHead(scalp, az, el) { return scalp.onSkull(scalp.center.clone().addScaledVector(azElToDir(az, el), 0.2)).point.clone(); }
// 後腦中線（az 180）掃仰角：B.P＝z 最小（最後突）的點；G.P＝表面法線仰角第一次到 45° 的點（後腦從「頂」轉到「後」的中點）。
function scanBackMidline(scalp) {
  let bp = null, gp = null;
  for (let el = -50; el <= 85; el += 0.5) {
    const h = scalp.radial(scalp.center.clone().addScaledVector(azElToDir(180, el), 0.2), scalp.head);
    if (!h) continue;
    const nEl = Math.atan2(h.normal.y, Math.hypot(h.normal.x, h.normal.z)) * 180 / Math.PI;
    if (!bp || h.point.z < bp.point.z) bp = { el, point: h.point.clone() };
    if (!gp && nEl >= 45) gp = { el, point: h.point.clone() };
  }
  const coarse = bp.el; // 最突點附近再細掃 ±1°、每 0.05°
  for (let el = coarse - 1; el <= coarse + 1 + 1e-9; el += 0.05) {
    const h = scalp.radial(scalp.center.clone().addScaledVector(azElToDir(180, el), 0.2), scalp.head);
    if (h && h.point.z < bp.point.z) bp = { el, point: h.point.clone() };
  }
  return { bp, gp };
}

// 回傳 21 個點：九個中線點＋六個側面點×左右。每個 { id, name, side:'L'|'R'|'', az, el, point(Vector3，頭表面上、沒抬高) }
//   C.P、N.P      外輪廓在前、後中線上的節點
//   T.P           頭的最高點（資料檔的 landmarks_m.top）
//   B.P           後腦中線上最往後突（z 最小）的點
//   G.P           後腦中線上表面法線到 45° 的地方（從頭頂轉到後腦的中點）
//   ＊.M.P        相鄰兩個中線點的仰角中點
//   側面六點      見 SIDE_RULES
export function computeLandmarks(scalp, meta) {
  if (!meta.outline) throw new Error('頭のデータに outline（外周ラインの節点）がありません');
  if (!meta.landmarks_m || !meta.landmarks_m.top) throw new Error('頭のデータに landmarks_m.top（頭頂）がありません');
  const s = meta.outline;
  scalp.outlineSpec = s;
  if (!!scalp.asymmetric !== !!s.right) { scalp.asymmetric = !!s.right; scalp._earLoops = null; } // 右耳根要不要自己算（Scalp.earRootLoop）
  const out = [];
  const push = (id, name, side, point) => { const ae = dirToAzEl(point.clone().sub(scalp.center)); out.push({ id, name, side, az: ae.az, el: ae.el, point }); };
  const midline = a => { const p = toSkull(scalp, new Vector3(0, a[1], a[2])).point.clone(); p.x = 0; return p; };
  const cp = midline(s.front[0]), np = midline(s.rear[s.rear.length - 1]);
  const cpEl = dirToAzEl(cp.clone().sub(scalp.center)).el, npEl = dirToAzEl(np.clone().sub(scalp.center)).el;
  const top = scalp.nearest(V(meta.landmarks_m.top)).point;
  const topAe = dirToAzEl(top.clone().sub(scalp.center));
  const { bp, gp } = scanBackMidline(scalp);
  const mid = (a, b) => (a + b) / 2;
  push('C.P', 'センターポイント（前髪の生え際の中心）', '', cp);
  push('C.T.M.P', 'センタートップ・ミドルポイント', '', onHead(scalp, 0, mid(cpEl, topAe.el)));
  push('T.P', 'トップポイント（頭頂）', '', top);
  push('T.G.M.P', 'トップゴールデン・ミドルポイント', '', onHead(scalp, 180, mid(topAe.el, gp.el)));
  push('G.P', 'ゴールデンポイント', '', gp.point);
  push('G.B.M.P', 'ゴールデンバック・ミドルポイント', '', onHead(scalp, 180, mid(gp.el, bp.el)));
  push('B.P', 'バックポイント', '', bp.point);
  push('B.N.M.P', 'バックネープ・ミドルポイント', '', onHead(scalp, 180, mid(bp.el, npEl)));
  push('N.P', 'ネープポイント（襟足の生え際の中心）', '', np);
  const earL = earPoints(scalp, s, 'L'), earR = earPoints(scalp, s, 'R');
  for (const r of SIDE_RULES) {
    if (r.ear) { push(r.id, r.name, 'L', earL[r.ear]); push(r.id, r.name, 'R', earR[r.ear]); continue; }
    const p = toSkull(scalp, V(s[r.knot[0]][s.index[r.knot[1]]])).point.clone();
    push(r.id, r.name, 'L', p);
    const sr = s.right;
    push(r.id, r.name, 'R', sr ? toSkull(scalp, sidePoint(sr[r.knot[0]][sr.index[r.knot[1]]], 'R')).point.clone() : scalp.nearestHead(mirrorX(p)).point);
  }
  return out;
}
export const findLandmark = (lms, id, side = '') => lms.find(l => l.id === id && l.side === side);

// 外輪廓＝兩條通過節點的 Catmull-Rom（centripetal），只在左右鬢角尖相接，所以只有鬢角尖是尖角：
//   前段：右鬢角尖 → 右太陽穴 → 右額角 → C.P → 左額角 → 左太陽穴 → 左鬢角尖
//   後段：左鬢角尖 → 繞左耳外緣 → 耳後 → 頸側 → N.P → 右側反著走回右鬢角尖
// 每 spacing（1 mm）等弧長取樣、投到去掉耳朵的頭殼；沿法線抬高 OFFSET 後細分到 ≤0.75 mm，在細線上做小幅圓順（鬢角尖固定）。
// 回傳的點列從 C.P 開始往左側走（C.P → 左鬢角 → 左耳 → N.P → 右耳 → 右鬢角 → 回到 C.P 前一點），閉合。
export function outlinePoints(scalp, lms, spacing = 0.001) {
  if (!Array.isArray(lms)) throw new Error('外周ラインには、先に computeLandmarks で求めたポイントが必要です');
  const s0 = outlineSpec(scalp);
  const g = (id, side = '') => findLandmark(lms, id, side).point;
  const halfKnots = side => {
    const s = specFor(s0, side);
    const a = s.front.map(p => sidePoint(p, side)); a[0].x = 0; a[a.length - 1] = earPoints(scalp, s0, side).scp;
    const b = s.rear.map(p => sidePoint(p, side)); b[b.length - 1].x = 0;
    return { a, b };
  };
  const L = halfKnots('L'), R = halfKnots('R');
  const chain = pts => {
    const crv = new CatmullRomCurve3(pts, false, 'centripetal', 0.5);
    return crv.getSpacedPoints(Math.max(12, Math.ceil(crv.getLength() / spacing))).map(p => toSkull(scalp, p).point.clone());
  };
  const frontArc = chain([...R.a.slice(1).reverse(), ...L.a]);                                        // 右鬢角尖 … C.P … 左鬢角尖
  const rear = chain([L.a[L.a.length - 1], ...L.b, ...R.b.slice(0, -1).reverse(), R.a[R.a.length - 1]]); // 左鬢角尖 … N.P … 右鬢角尖
  let ring = frontArc.concat(rear.slice(1, -1));
  const cp = g('C.P'); let start = 0;
  for (let i = 1; i < frontArc.length; i++) if (frontArc[i].distanceToSquared(cp) < frontArc[start].distanceToSquared(cp)) start = i;
  ring = ring.slice(start).concat(ring.slice(0, start));
  const lifted = ring.map(p => { const h = toSkull(scalp, p); return h.point.clone().addScaledVector(h.normal, OFFSET); });
  // 耳根邊界的網格法線會造成細小鋸齒；在已貼頭的細線上做次毫米圓順。只固定左右鬢角尖（唯一要保留的尖角）。
  const dense = [], anchors = new Set();
  const tipIndices = ['L', 'R'].map(side => {
    const p = g('S.C.P', side); let closest = 0;
    for (let i = 1; i < lifted.length; i++) if (lifted[i].distanceToSquared(p) < lifted[closest].distanceToSquared(p)) closest = i;
    return closest;
  });
  for (let i = 0; i < lifted.length; i++) {
    if (tipIndices.includes(i)) anchors.add(dense.length);
    const a = lifted[i], b = lifted[(i + 1) % lifted.length], steps = Math.max(1, Math.ceil(a.distanceTo(b) / .00075));
    for (let k = 0; k < steps; k++) dense.push(a.clone().lerp(b, k / steps));
  }
  let result = dense;
  for (let pass = 0; pass < 24; pass++) {
    result = result.map((p, i) => anchors.has(i) ? p : p.clone().multiplyScalar(.5)
      .addScaledVector(result[(i + result.length - 1) % result.length], .25)
      .addScaledVector(result[(i + 1) % result.length], .25));
  }
  return result;
}

// 結構參考線：每條都是「點對點連成的平滑線」。
// 中線：C.P→C.T.M.P→T.P→T.G.M.P→G.P→G.B.M.P→B.P→B.N.M.P→N.P；耳到耳：E.P→T.P→E.P；
// G.P 橫線：F.S.P→側面（G.P 高度）→G.P→另一側→F.S.P；耳點到枕骨點：E.P→B.P 左右各一。
// 每條都是通過這些點的 Catmull-Rom，每 1 mm 取樣後投到去掉耳朵的頭殼。回傳 [{ id, points }]，points 抬高 OFFSET×0.8（在使用者畫的線下面）。
export function structureLines(scalp, lms) {
  const lift = OFFSET * 0.8;
  const g = (id, side = '') => findLandmark(lms, id, side).point;
  const through = (pts, spacing = 0.001, smooth = 0) => {
    const crv = new CatmullRomCurve3(pts, false, 'centripetal', 0.5);
    const n = Math.max(24, Math.ceil(crv.getLength() / spacing));
    const project = p => p.y < -.08 ? toSkull(scalp, p) : scalp.onSkull(p);
    let raw = crv.getSpacedPoints(n).map(p => project(p).point); // 等弧長取樣；凹進去的頸部用最近表面投影，避免跳到肩膀
    for (let k = 0; k < smooth; k++) raw = raw.map((p, i) => (i === 0 || i === raw.length - 1 ? p : project(raw[i - 1].clone().add(p).add(raw[i + 1]).multiplyScalar(1 / 3)).point));
    let result = raw.map(p => { const h = project(p); return h.point.clone().addScaledVector(h.normal, lift); });
    for (let pass = 0; pass < smooth * 4; pass++) {
      result = result.map((p, i) => (i === 0 || i === result.length - 1) ? p : p.clone().multiplyScalar(.5)
        .addScaledVector(result[i - 1], .25).addScaledVector(result[i + 1], .25));
    }
    const dense = []; // 投影後在斜的後頸可能把一格拉長：最後再補點到每 1 mm
    for (let i = 0; i < result.length - 1; i++) {
      const a = result[i], b = result[i + 1], m = Math.max(1, Math.ceil(a.distanceTo(b) / .001));
      for (let k = 0; k < m; k++) dense.push(a.clone().lerp(b, k / m));
    }
    dense.push(result[result.length - 1]);
    return dense;
  };
  const gpEl = findLandmark(lms, 'G.P').el;
  // E.P→B.P：從 E.P 直接沿頭殼連到 B.P。外輪廓繞在耳殼外面、E.P 就在外輪廓上，直接連不會碰到耳殼，整條線都在髮際線裡面。
  const epBp = side => through([g('E.P', side), g('B.P')], 0.001, 2);
  return [
    { id: 'center', points: through(['C.P', 'C.T.M.P', 'T.P', 'T.G.M.P', 'G.P', 'G.B.M.P', 'B.P', 'B.N.M.P', 'N.P'].map(id => g(id))) },
    { id: 'ear_to_ear', points: through([g('E.P', 'L'), g('T.P'), g('E.P', 'R')]) },
    { id: 'gp_line', points: through([g('F.S.P', 'L'), onHead(scalp, 90, gpEl - 2), onHead(scalp, 135, gpEl), g('G.P'), onHead(scalp, 225, gpEl), onHead(scalp, 270, gpEl - 2), g('F.S.P', 'R')]) },
    { id: 'ep_bp_left', points: epBp('L') },
    { id: 'ep_bp_right', points: epBp('R') },
  ];
}
