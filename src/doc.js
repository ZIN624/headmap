// SPDX-License-Identifier: AGPL-3.0-only
// 一筆圖的資料：點、線、面、髮片、提拉線、角度扇形。
// 純資料，不依賴 three，瀏覽器與 Node 共用。座標是 { x, y, z }，單位公尺；+Y 向上、臉朝 +Z。
//
// 程式裡的一筆（layer）：
//   { id, shape, points, style: { stroke, width, dash, fill, opacity }, dashed, arrow, closed }
//   line     兩點的線。control＝拉彎時的二次貝茲控制點；section＝分線形狀（見 section.js）
//   curve／freehand／region／panel  多點的形狀。bends＝每一段的彎度點（頭皮上的點）或 null
//   region   面。poly＝true 時邊照點直接連，轉角是尖的（點一下填滿做出來的面）
//   panel／strand／fan  帶 lift（提拉設定，見 lift.js）
//   label    寫在這一筆旁邊的一小段字
//   mirrorPairId  鏡像配對的另一筆
//   origin   換過頭模的筆：原本畫在哪顆頭、原本的位置、搬過來之後的位置指紋（transfer.js）。位置再動過就不留
// 存檔只留必要的欄位（saveLayers），讀回來時逐筆檢查（parseLayers）。
import { DEFAULT_LIFT, normalizeLift } from './lift.js';
import { normalizeSection } from './section.js';

export const SHAPES = ['line', 'curve', 'freehand', 'point', 'region', 'panel', 'strand', 'fan'];
export const SHAPE_LABELS = { line: '直線', curve: '曲線', freehand: '手描き', point: '点', region: '面', panel: 'パネル', strand: 'リフトライン', fan: '角度の扇形' };
export const LIFT_SHAPES = ['panel', 'strand', 'fan'];
export const NO_ARROW_SHAPES = ['point', 'region', 'panel', 'fan'];
const SEGMENT_SHAPES = ['curve', 'freehand', 'region', 'panel']; // 多段，每段可以有彎度點
const ONE_POINT_SHAPES = ['point', 'strand', 'fan'];
export const hasSegments = shape => SEGMENT_SHAPES.includes(shape);
export const minPoints = shape => (ONE_POINT_SHAPES.includes(shape) ? 1 : shape === 'region' ? 3 : 2);
const maxPoints = shape => (ONE_POINT_SHAPES.includes(shape) ? 1 : shape === 'line' ? 2 : Infinity);

export const WIDTHS = [2, 3.5, 5.5];     // 線寬三段（畫面上的 CSS 像素）
export const DASH = [6, 4];              // 虛線的線段與間隔（相對線寬）
export const FILL_OPACITY = 0.38;        // 面的填色透明度
export const PANEL_FILL_OPACITY = 0.22;  // 髮片的色面
export const OUTLINE_COLOR = '#334155';
export const STRUCTURE_COLOR = '#7A8089';
export const STRUCTURE_DOT_COLOR = '#334155';
export const CUT_COLOR = '#D86735';      // 剪過的髮尾線
export const LABEL_INK = '#2B2B2B';      // 標字與色塊髮片的邊線
const defaultStyle = () => ({ stroke: '#1B1B1B', width: WIDTHS[1], dash: [], fill: 'none', opacity: 1 });
// 每種工具一開始的樣式（線與手畫線共用 line）
export const defaultToolStyles = () => ({
  point: { stroke: '#236B91', width: 3.5, dashed: false, arrow: false },
  line: { stroke: '#236B91', width: 3.5, dashed: false, arrow: false },
  region: { stroke: '#0C8F91', width: 2, dashed: false, arrow: false },
  panel: { stroke: '#0C8F91', width: 2, dashed: false, arrow: false },
});

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const isColor = s => typeof s === 'string' && COLOR_RE.test(s);
const widthOk = w => Number.isFinite(w) && w >= 0.5 && w <= 24;

export const LABEL_MAX = 24;
export function cleanLabel(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX);
}

export function newId() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
}

const toPoint = p => (Array.isArray(p) ? { x: +p[0], y: +p[1], z: +p[2] } : { x: +p.x, y: +p.y, z: +p.z });
export const pointArrays = layer => layer.points.map(p => [p.x, p.y, p.z]);
export const segmentCount = layer => (layer.shape === 'region' ? layer.points.length : layer.points.length - 1);

// 新的一筆。o = { shape, points, style?, dashed?, arrow?, control?, bends?, section?, poly?, lift?, label?, mirrorPairId?, id? }
export function newLayer(o) {
  if (!SHAPES.includes(o.shape)) throw new Error('不明な形：' + o.shape);
  const layer = { id: o.id || newId(), shape: o.shape, points: (o.points || []).map(toPoint), style: { ...defaultStyle(), ...(o.style || {}) },
    dashed: !!o.dashed, arrow: !!o.arrow && !NO_ARROW_SHAPES.includes(o.shape), closed: o.shape === 'region' };
  if (o.shape === 'line') {
    layer.control = o.control ? toPoint(o.control) : null;
    const section = layer.control ? null : normalizeSection(o.section); // 拉彎的線不是分線
    if (section) layer.section = section;
  }
  if (o.shape === 'region' && o.poly === true) layer.poly = true;
  if (hasSegments(o.shape)) layer.bends = normalizeBends(layer.poly ? null : o.bends, segmentCount(layer));
  if (LIFT_SHAPES.includes(o.shape)) layer.lift = normalizeLift(o.lift || DEFAULT_LIFT());
  normalizeStyle(layer);
  if (o.mirrorPairId) layer.mirrorPairId = o.mirrorPairId;
  if (o.origin) layer.origin = o.origin;
  const label = cleanLabel(o.label);
  if (label) layer.label = label;
  return layer;
}

export function normalizeBends(bends, count) {
  const out = new Array(Math.max(0, count)).fill(null);
  if (Array.isArray(bends)) bends.forEach((b, i) => { if (i < out.length && pointOk(b)) out[i] = toPoint(b); });
  return out;
}
export const hasBends = layer => Array.isArray(layer.bends) && layer.bends.some(Boolean);

// 虛線、填色、透明度由形狀決定：面與有色面的髮片才有填色
export function normalizeStyle(layer) {
  const s = layer.style, keepOpacity = fallback => (s.opacity > 0 && s.opacity < 1 ? s.opacity : fallback);
  s.dash = layer.dashed && layer.shape !== 'point' ? DASH.slice() : [];
  if (layer.shape === 'region') { s.fill = s.stroke; s.opacity = keepOpacity(FILL_OPACITY); }
  else if (layer.shape === 'point') { s.fill = s.stroke; s.opacity = 1; }
  else if (layer.shape === 'panel') {
    const tinted = ['TINT', 'RIBBONS', 'BLOCK'].includes(layer.lift.style);
    s.fill = tinted ? s.stroke : 'none'; s.opacity = tinted ? keepOpacity(PANEL_FILL_OPACITY) : 1;
  } else { s.fill = 'none'; s.opacity = 1; }
  return layer;
}

// 把一筆就地變成髮片類：線 → 髮片（線本身變成根線；拉彎的直線把彎度點 bend 當第一段的彎度點）；點 → 提拉線或角度扇形。
export function convertToLift(layer, shape, bend = null) {
  if (!LIFT_SHAPES.includes(shape)) throw new Error('パネルの種類ではありません：' + shape);
  if (shape === 'panel') {
    if (!['line', 'curve', 'freehand'].includes(layer.shape)) throw new Error('パネルにできるのは線だけです');
    const bends = layer.shape === 'line' ? [bend ? toPoint(bend) : null] : (layer.bends || []);
    layer.shape = 'panel'; delete layer.control; delete layer.section;
    layer.bends = normalizeBends(bends, layer.points.length - 1);
  } else {
    if (layer.shape !== 'point') throw new Error('リフトラインや角度の扇形にできるのは点だけです');
    layer.shape = shape; layer.points = [layer.points[0]]; delete layer.control; delete layer.bends;
  }
  layer.arrow = shape === 'strand'; layer.closed = false;
  layer.lift = normalizeLift(layer.lift || DEFAULT_LIFT());
  normalizeStyle(layer);
  return layer;
}

// ---- 存檔
const round = x => Math.round(x * 10000) / 10000; // 0.1 mm
const savedPoint = p => ({ x: round(p.x), y: round(p.y), z: round(p.z) });
export function saveLayers(layers) {
  return layers.map(l => {
    const out = { id: l.id, shape: l.shape, points: l.points.map(savedPoint), style: { stroke: l.style.stroke, width: l.style.width, opacity: l.style.opacity } };
    if (l.dashed) out.dashed = true;
    if (l.arrow) out.arrow = true;
    if (l.shape === 'line' && l.control) out.control = savedPoint(l.control);
    if (l.shape === 'line' && l.section && !l.control) out.section = { ...l.section };
    if (hasBends(l)) out.bends = l.bends.map(b => (b ? savedPoint(b) : null));
    if (l.poly) out.poly = true;
    if (LIFT_SHAPES.includes(l.shape)) out.lift = { ...l.lift };
    if (l.mirrorPairId) out.mirrorPairId = l.mirrorPairId;
    if (l.label) out.label = l.label;
    if (l.origin && l.origin.sig === geomSig(out)) out.origin = l.origin; // 搬過來之後動過位置：改算是在現在這顆頭上畫的
    return out;
  });
}

// 一筆的位置指紋（點、控制點、彎度點，四捨五入到 0.1 mm 之後的雜湊）。吃存檔格式的筆。
export function geomSig(l) {
  const q = p => (p ? [round(p.x), round(p.y), round(p.z)] : null);
  const bends = Array.isArray(l.bends) ? l.bends.map(q) : [];
  while (bends.length && !bends[bends.length - 1]) bends.pop();
  const text = JSON.stringify([(l.points || []).map(q), q(l.control), bends]);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57; // cyrb53
  for (let i = 0; i < text.length; i++) { const ch = text.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
function originOk(o, count) {
  if (!o || typeof o !== 'object' || typeof o.head !== 'string' || !o.head || typeof o.sig !== 'string') return undefined;
  if (!Array.isArray(o.points) || o.points.length !== count || !o.points.every(pointOk)) return undefined;
  const out = { head: o.head, points: o.points.map(toPoint), sig: o.sig };
  if (pointOk(o.control)) out.control = toPoint(o.control);
  if (Array.isArray(o.bends) && o.bends.some(pointOk)) out.bends = o.bends.map(b => (pointOk(b) ? toPoint(b) : null));
  return out;
}

// ---- 讀檔：每一筆都檢查，不合格就丟出錯誤（訊息說明是第幾筆、哪裡不對）
const pointOk = p => !!p && typeof p === 'object' && [p.x, p.y, p.z].every(Number.isFinite) && Math.hypot(p.x, p.y, p.z) <= 2;
function checkPoints(points, where, min, max) {
  if (!Array.isArray(points) || points.length < min) throw new Error(where + 'の点が ' + min + ' 個未満です');
  if (points.length > max) throw new Error(where + 'の点が ' + max + ' 個を超えています');
  return points.map((p, j) => {
    if (!p || typeof p !== 'object' || ![p.x, p.y, p.z].every(Number.isFinite)) throw new Error(where + 'の ' + (j + 1) + ' 番目の点が {x, y, z} の数値ではありません');
    if (Math.hypot(p.x, p.y, p.z) > 2) throw new Error(where + 'の ' + (j + 1) + ' 番目の点が頭から離れすぎています（単位はメートル）');
    return { x: p.x, y: p.y, z: p.z };
  });
}
export function parseLayers(list) {
  if (!Array.isArray(list)) throw new Error('layers がありません');
  const seen = new Set(), base = defaultStyle();
  const layers = list.map((l, i) => {
    const where = (i + 1) + ' 番目の線';
    if (!l || typeof l !== 'object') throw new Error(where + 'がオブジェクトではありません');
    if (!SHAPES.includes(l.shape)) throw new Error(where + 'の形が不明です：' + l.shape);
    const points = checkPoints(l.points, where, minPoints(l.shape), maxPoints(l.shape));
    const s = l.style && typeof l.style === 'object' ? l.style : {};
    let id = typeof l.id === 'string' && l.id ? l.id : newId();
    if (seen.has(id)) id = newId();
    seen.add(id);
    return newLayer({
      id, shape: l.shape, points, dashed: l.dashed === true, arrow: l.arrow === true,
      control: l.shape === 'line' && pointOk(l.control) ? l.control : null, bends: l.bends,
      section: l.shape === 'line' ? l.section : undefined, poly: l.shape === 'region' && l.poly === true, lift: l.lift,
      mirrorPairId: typeof l.mirrorPairId === 'string' ? l.mirrorPairId : undefined, label: l.label, origin: originOk(l.origin, points.length),
      style: { stroke: isColor(s.stroke) ? s.stroke : base.stroke, width: widthOk(s.width) ? s.width : base.width, opacity: Number.isFinite(s.opacity) && s.opacity > 0 && s.opacity <= 1 ? s.opacity : 1 },
    });
  });
  const ids = new Set(layers.map(l => l.id));
  for (const l of layers) if (l.mirrorPairId && !ids.has(l.mirrorPairId)) delete l.mirrorPairId; // 配對的另一筆不在了
  return layers;
}
