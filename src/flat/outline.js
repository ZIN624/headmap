// SPDX-License-Identifier: AGPL-3.0-only
// アウトラインのガイド（2D）：前の終点を「あごから何 cm」、後ろの始点を「襟足の生え際から何 cm」で選んで、
// 左右の側面と背面にアウトラインの線を描く。位置はヘッドのメッシュ（顔と首の輪郭）と N.P から測る。純データ、ブラウザと Node 共用。
// 座標は views.js と同じ：視図平面上の mm、+x 右、+y 下。右側面（顔が右）は x＝z、左側面は x＝−z、背面は x＝−X。

export const FRONT_RANGE = [-6, 12]; // あご上 6cm 〜 あご下 12cm
export const BACK_RANGE = [-8, 8];   // 生え際上 8cm 〜 生え際下 8cm
export const DEFAULT_OUTLINE = { front: 3, back: 0 };
export const OUTLINE_COLOR = '#C63B32';

const fmt = n => (Number.isInteger(n) ? String(n) : n.toFixed(1));
export const frontLabel = cm => (cm === 0 ? 'あごの高さ' : cm > 0 ? 'あご下' + fmt(cm) + 'cm' : 'あご上' + fmt(-cm) + 'cm');
export const backLabel = cm => (cm === 0 ? '襟足の生え際' : cm > 0 ? '生え際下' + fmt(cm) + 'cm' : '生え際上' + fmt(-cm) + 'cm');
export const clampCm = (v, [lo, hi]) => Math.min(hi, Math.max(lo, Math.round(v * 2) / 2));

// メッシュから横顔の輪郭を測る。meshes＝loadMeshes() の結果（HD_HEAD_BASE、HD_BUST）、npY＝N.P の高さ（m、+Y 上）
export function profileAnchors(meshes, npY) {
  const front = new Map(), back = new Map(), backHalf = new Map();
  const add = (m, k, v, pick) => { const o = m.get(k); m.set(k, o === undefined ? v : pick(o, v)); };
  for (const key of ['HD_HEAD_BASE', 'HD_BUST']) {
    const P = meshes[key] && meshes[key].positions;
    if (!P) throw new Error('ヘッドに ' + key + ' がありません');
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i] * 1000, y = Math.round(-P[i + 1] * 1000), z = P[i + 2] * 1000;
      add(front, y, z, Math.max);
      add(back, y, z, Math.min);
      if (z < -20) add(backHalf, y, Math.abs(x), Math.max); // 首の後ろ半分の幅（背面で見える首）
    }
  }
  const at = (m, y) => { for (let d = 0; d <= 4; d++) { if (m.has(y + d)) return m.get(y + d); if (m.has(y - d)) return m.get(y - d); } return null; };
  // あご先：N.P より下で、顔の前の輪郭が首へ大きく切れ込む所（3mm で 15mm 以上へこむ）
  const np = Math.round(-npY * 1000);
  let chin = null;
  for (let y = np - 40; y < np + 120; y++) {
    const a = at(front, y - 3), b = at(front, y);
    if (a !== null && b !== null && b < a - 15) {
      let x = -Infinity; for (let k = y - 12; k < y; k++) { const v = at(front, k); if (v !== null) x = Math.max(x, v); }
      chin = [x, y - 1];
      break;
    }
  }
  if (!chin) throw new Error('あご先の位置が見つかりません');
  return {
    chin,                                         // 右側面の [x, y]（mm）
    np,                                           // N.P の高さ（mm、下が +）
    backX: y => at(back, Math.round(y)),          // 右側面で、その高さの首・頭の後ろの輪郭（mm）
    neckHalf: y => at(backHalf, Math.round(y)),   // 背面で、その高さの首の半分の幅（mm）
  };
}

// 選んだ値からアウトラインの位置を出す。front、back は cm
export function outlineGeometry(anchors, { front, back }) {
  const yb = anchors.np + back * 10, xb = anchors.backX(yb);
  if (xb === null) throw new Error('この高さには首がありません');
  // 前の終点：あご先の下。あごより上は髪が頬に沿うので、上げるほど少し後ろへ
  const yf = anchors.chin[1] + front * 10, xf = anchors.chin[0] - 5 - Math.max(0, -front) * 4;
  const deg = Math.atan2(yf - yb, xf - xb) * 180 / Math.PI;
  const kind = deg > 3 ? '前下がり' : deg < -3 ? '前上がり' : '水平';
  const r = v => Math.round(v * 10) / 10;
  return { backPt: [r(xb), r(yb)], frontPt: [r(xf), r(yf)], deg: r(deg), kind, label: frontLabel(front) + '・' + kind, neckHalf: anchors.neckHalf(yb) };
}

// 描く線（shapes.js の newShape に渡す形）。右側面と左側面は鏡像のペア、背面は首の後ろを横切る線
export function outlineSpecs(geo, ids, style = {}) {
  const st = { color: OUTLINE_COLOR, width: 1.4, dash: 'solid', ...style };
  const flip = p => [-p[0], p[1]];
  const out = [
    { id: ids[0], type: 'line', view: 'right', pts: [geo.backPt, geo.frontPt], style: st, label: geo.label, mirrorPairId: ids[1] },
    { id: ids[1], type: 'line', view: 'left', pts: [flip(geo.backPt), flip(geo.frontPt)], style: st, label: geo.label, mirrorPairId: ids[0] },
  ];
  if (geo.neckHalf) out.push({ id: ids[2], type: 'line', view: 'back', pts: [[-geo.neckHalf, geo.backPt[1]], [geo.neckHalf, geo.backPt[1]]], style: st });
  return out;
}
