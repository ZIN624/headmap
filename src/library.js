// SPDX-License-Identifier: AGPL-3.0-only
// 頭圖庫：好幾張頭圖，每張有好幾個步驟。純資料，不依賴 three，瀏覽器與 Node 共用。
// 整個頭圖庫是一份 JSON，存在瀏覽器的 localStorage（照片與底圖太大，另外存在 IndexedDB，這裡只記 id）。
//   頭圖庫 { format, version, updatedAt, settings, drawings, folders, current }
//   頭圖   { id, title, kind, head, createdAt, updatedAt, folder?, star?, trashedAt?, note?, viewNotes?, photos?, backs?, steps }
//          kind＝'3d'（畫在頭模上）或 '2d'（五個視圖的平面圖）；head＝哪顆頭模（heads.json 的 id）
//          note＝整張的筆記；viewNotes＝2D 每個視圖的筆記；photos＝照片的 id；backs＝2D 某個視圖換成自己的底圖（id）
//   3D 步驟 { id, title, layers, view, fall? }　layers＝doc.js 的存檔格式；view＝鏡頭位置；fall＝頭髮放下
//   2D 步驟 { id, title, shapes }　shapes＝flat/shapes.js 的存檔格式（每一筆記自己在哪個視圖）
//   資料夾 { id, name }
import { newId, saveLayers, parseLayers } from './doc.js';
import { saveShapes, parseShapes } from './flat/shapes.js';
import { VIEW_IDS } from './flat/views.js';

export const LIBRARY_FORMAT = 'head3d-library';
export const DRAWING_FORMAT = 'head3d-drawing';
export const FORMAT_VERSION = 1;
export const STORAGE_KEY = 'head3d.library';
export const UNTITLED = '名前のないカット図';
export const DEFAULT_HEAD = 'ict';     // 沒記頭模的檔案＝畫在這顆頭上
export const KINDS = ['3d', '2d'];
export const TRASH_DAYS = 30;          // 回收桶留幾天
export const PHOTO_MAX = 6;            // 一張頭圖最多幾張照片
export const NOTE_MAX = 4000;

// 設定：開關（true／false）與幾個選項
const SETTINGS = {
  outline: true, structure: false, labels: false, ghost: true, mirror: false, snap: true, topFaceDown: false,
  guides: true, magnifier: true, hairline: true, shade: false, grid: 'none', speed: 'normal', smooth: 2,
};
const SETTING_CHOICES = { grid: ['none', 'grid', 'dots'], speed: ['slow', 'normal', 'fast'], smooth: [0, 1, 2, 3] };
export const defaultSettings = () => ({ ...SETTINGS });
function cleanSettings(given) {
  const s = defaultSettings();
  if (!given || typeof given !== 'object') return s;
  for (const k of Object.keys(s)) {
    if (typeof s[k] === 'boolean' && typeof given[k] === 'boolean') s[k] = given[k];
    else if (SETTING_CHOICES[k] && SETTING_CHOICES[k].includes(given[k])) s[k] = given[k];
  }
  return s;
}

export function newLibrary(now = new Date()) {
  return { format: LIBRARY_FORMAT, version: FORMAT_VERSION, updatedAt: now.toISOString(), settings: defaultSettings(), drawings: [], folders: [], current: null };
}
export function newStep(o = {}, kind = '3d') {
  const s = { id: o.id || newId(), title: typeof o.title === 'string' ? o.title : '' };
  if (kind === '2d') s.shapes = Array.isArray(o.shapes) ? o.shapes : [];
  else { s.layers = Array.isArray(o.layers) ? o.layers : []; s.view = o.view || null; }
  return s;
}
export function newDrawing(title = UNTITLED, { kind = '3d', head = DEFAULT_HEAD, folder = null } = {}, now = new Date()) {
  const d = { id: newId(), title: title || UNTITLED, kind: KINDS.includes(kind) ? kind : '3d', head, createdAt: now.toISOString(), updatedAt: now.toISOString(), steps: [newStep({}, kind)] };
  if (folder) d.folder = folder;
  return d;
}
export const drawingById = (lib, id) => lib.drawings.find(d => d.id === id) || null;
export const is2d = d => d.kind === '2d';
// 一個步驟裡的筆（3D 的 layers 或 2D 的 shapes）
export const stepItems = s => (s ? s.shapes || s.layers || [] : []);

// 步驟的編號（01、02…）與名字（沒取名就叫「步驟 N」）
export const stepLabel = i => String(i + 1).padStart(2, '0');
export const stepName = (drawing, i) => { const s = drawing.steps[i]; return s ? (s.title || 'ステップ ' + (i + 1)) : ''; };
// 「前面步驟變淡」要疊哪幾步：排在前面、而且有畫東西的
export function ghostIndices(drawing, i) {
  const out = [];
  for (let j = 0; j < i && j < drawing.steps.length; j++) if (stepItems(drawing.steps[j]).length) out.push(j);
  return out;
}

const clone = v => JSON.parse(JSON.stringify(v));
// 複製出來的筆換新的 id，鏡像配對跟著對到新的 id
function renewIds(list) {
  const map = new Map(list.map(l => [l.id, newId()]));
  return list.map(l => {
    const n = clone(l); n.id = map.get(l.id);
    if (n.mirrorPairId && map.has(n.mirrorPairId)) n.mirrorPairId = map.get(n.mirrorPairId); else delete n.mirrorPairId;
    return n;
  });
}
export function addStep(drawing, after = drawing.steps.length - 1) { drawing.steps.splice(after + 1, 0, newStep({}, drawing.kind)); return after + 1; }
export function duplicateStep(drawing, i) {
  const src = drawing.steps[i], copy = clone(src);
  copy.id = newId();
  if (src.shapes) copy.shapes = renewIds(src.shapes); else copy.layers = renewIds(src.layers || []);
  if (src.title) copy.title = src.title + '（コピー）';
  drawing.steps.splice(i + 1, 0, copy);
  return i + 1;
}
export function moveStep(drawing, i, dir) {
  const j = i + dir;
  if (j < 0 || j >= drawing.steps.length) return i;
  const [s] = drawing.steps.splice(i, 1);
  drawing.steps.splice(j, 0, s);
  return j;
}
export function deleteStep(drawing, i) {
  if (drawing.steps.length <= 1) throw new Error('ステップは1つ以上残してください');
  drawing.steps.splice(i, 1);
  return Math.min(i, drawing.steps.length - 1);
}
// 整張頭圖複製一份（新的 id；照片與底圖共用同一份檔案）
export function duplicateDrawing(lib, d, now = new Date()) {
  const copy = clone(d);
  copy.id = newId(); copy.title = (d.title + '（コピー）').slice(0, 40); copy.createdAt = copy.updatedAt = now.toISOString();
  delete copy.trashedAt; delete copy.star;
  copy.steps = d.steps.map(s => { const c = clone(s); c.id = newId(); if (c.shapes) c.shapes = renewIds(c.shapes); else c.layers = renewIds(c.layers || []); return c; });
  lib.drawings.splice(lib.drawings.indexOf(d) + 1, 0, copy);
  return copy;
}

// 一個步驟的筆 ↔ 程式裡用的格式
export const stepLayers = step => parseLayers(step.layers || []);
export function storeStepLayers(step, layers) { step.layers = saveLayers(layers); return step; }
export const stepShapes = step => parseShapes(step.shapes || [], VIEW_IDS);
export function storeStepShapes(step, shapes) { step.shapes = saveShapes(shapes); return step; }
export const touch = (d, now = new Date()) => { d.updatedAt = now.toISOString(); };

// ---- 資料夾、收藏、回收桶
export function addFolder(lib, name) {
  const n = cleanName(name);
  if (!n) throw new Error('フォルダには名前が必要です');
  if (lib.folders.some(f => f.name === n)) throw new Error('「' + n + '」というフォルダはすでにあります');
  const f = { id: newId(), name: n }; lib.folders.push(f); return f;
}
export function renameFolder(lib, id, name) {
  const f = lib.folders.find(x => x.id === id), n = cleanName(name);
  if (!f) throw new Error('このフォルダが見つかりません');
  if (!n) throw new Error('フォルダには名前が必要です');
  if (lib.folders.some(x => x !== f && x.name === n)) throw new Error('「' + n + '」というフォルダはすでにあります');
  f.name = n; return f;
}
// 刪資料夾不刪裡面的頭圖：頭圖回到「全部」
export function deleteFolder(lib, id) {
  lib.folders = lib.folders.filter(f => f.id !== id);
  for (const d of lib.drawings) if (d.folder === id) delete d.folder;
}
export function trashDrawing(d, now = new Date()) { d.trashedAt = now.toISOString(); }
export function restoreDrawing(d) { delete d.trashedAt; }
// 回收桶裡放超過 TRASH_DAYS 天的頭圖：回傳要清掉的（呼叫的人負責連照片一起刪）
export function expiredDrawings(lib, now = new Date()) {
  const limit = now.getTime() - TRASH_DAYS * 86400000;
  return lib.drawings.filter(d => d.trashedAt && Date.parse(d.trashedAt) < limit);
}
const cleanName = s => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 30) : '');

// 首頁清單：哪一格（all／star／trash／資料夾 id）、排序（updated／created／title）、搜尋字
export function listDrawings(lib, { box = 'all', sort = 'updated', query = '' } = {}) {
  const q = query.trim().toLowerCase();
  let list = lib.drawings.filter(d => (box === 'trash' ? !!d.trashedAt : !d.trashedAt));
  if (box === 'star') list = list.filter(d => d.star);
  else if (box !== 'all' && box !== 'trash') list = list.filter(d => d.folder === box);
  if (q) list = list.filter(d => d.title.toLowerCase().includes(q) || (d.note || '').toLowerCase().includes(q));
  const key = sort === 'created' ? d => d.createdAt : d => d.updatedAt || d.createdAt;
  if (sort === 'title') list.sort((a, b) => a.title.localeCompare(b.title, 'ja'));
  else list.sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
  return list;
}

// ---- 存檔、匯出、匯入
const vec3 = a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
const idOk = s => typeof s === 'string' && /^[\w-]{1,64}$/.test(s);
function cleanView(v) {
  if (!v || typeof v !== 'object' || !vec3(v.p) || !vec3(v.u)) return null;
  return { p: v.p.slice(), u: v.u.slice(), z: Number.isFinite(v.z) && v.z > 0 ? v.z : 1, k: typeof v.k === 'string' ? v.k : null };
}
function cleanStep(s, where, kind) {
  if (!s || typeof s !== 'object') throw new Error(where + 'の形式が正しくありません');
  const base = { id: typeof s.id === 'string' && s.id ? s.id : undefined, title: typeof s.title === 'string' ? s.title.slice(0, 40) : '' };
  if (kind === '2d') {
    let shapes;
    try { shapes = saveShapes(parseShapes(Array.isArray(s.shapes) ? s.shapes : [], VIEW_IDS)); } catch (e) { throw new Error(where + 'の図が読み込めません：' + e.message); }
    return newStep({ ...base, shapes }, '2d');
  }
  let layers;
  try { layers = saveLayers(parseLayers(Array.isArray(s.layers) ? s.layers : [])); } catch (e) { throw new Error(where + 'の図が読み込めません：' + e.message); }
  const out = newStep({ ...base, layers, view: cleanView(s.view) }, '3d');
  if (s.fall === true) out.fall = true;
  return out;
}
function cleanDrawing(d, where) {
  if (!d || typeof d !== 'object') throw new Error(where + 'の形式が正しくありません');
  if (!Array.isArray(d.steps) || !d.steps.length) throw new Error(where + 'にステップがありません');
  const kind = KINDS.includes(d.kind) ? d.kind : '3d';
  const now = new Date().toISOString();
  const out = {
    id: typeof d.id === 'string' && d.id ? d.id : newId(),
    title: typeof d.title === 'string' && d.title ? d.title.slice(0, 40) : UNTITLED,
    kind,
    head: typeof d.head === 'string' && /^[a-z0-9_]{1,24}$/.test(d.head) ? d.head : DEFAULT_HEAD,
    createdAt: typeof d.createdAt === 'string' ? d.createdAt : now,
    updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : (typeof d.createdAt === 'string' ? d.createdAt : now),
    steps: d.steps.map((s, i) => cleanStep(s, where + 'の ' + (i + 1) + ' ステップ目', kind)),
  };
  if (idOk(d.folder)) out.folder = d.folder;
  if (d.star === true) out.star = true;
  if (typeof d.trashedAt === 'string' && !Number.isNaN(Date.parse(d.trashedAt))) out.trashedAt = d.trashedAt;
  if (typeof d.note === 'string' && d.note) out.note = d.note.slice(0, NOTE_MAX);
  if (kind === '2d' && d.viewNotes && typeof d.viewNotes === 'object') {
    const vn = {}; for (const v of VIEW_IDS) if (typeof d.viewNotes[v] === 'string' && d.viewNotes[v]) vn[v] = d.viewNotes[v].slice(0, NOTE_MAX);
    if (Object.keys(vn).length) out.viewNotes = vn;
  }
  if (Array.isArray(d.photos)) { const p = d.photos.filter(idOk).slice(0, PHOTO_MAX); if (p.length) out.photos = p; }
  if (kind === '2d' && d.backs && typeof d.backs === 'object') {
    const b = {}; for (const v of VIEW_IDS) if (idOk(d.backs[v])) b[v] = d.backs[v];
    if (Object.keys(b).length) out.backs = b;
  }
  return out;
}
function readJSON(text) {
  let raw;
  try { raw = typeof text === 'string' ? JSON.parse(text) : text; } catch { throw new Error('正しい JSON ではありません'); }
  if (!raw || typeof raw !== 'object') throw new Error('ファイルの中身がオブジェクトではありません');
  if (raw.version > FORMAT_VERSION) throw new Error('このファイルは新しいバージョンで保存されたため、ここでは読めません');
  return raw;
}
// 照片、底圖的 id（匯出時要一起帶的檔案）
export const mediaIds = d => [...(d.photos || []), ...Object.values(d.backs || {})];

export const serializeLibrary = lib => JSON.stringify(lib);
export function parseLibrary(text) {
  const raw = readJSON(text);
  if (raw.format !== LIBRARY_FORMAT || !Array.isArray(raw.drawings)) throw new Error('カット図ライブラリの形式が正しくありません');
  const lib = newLibrary();
  lib.settings = cleanSettings(raw.settings);
  lib.drawings = raw.drawings.map((d, i) => cleanDrawing(d, (i + 1) + ' 枚目'));
  if (Array.isArray(raw.folders)) {
    const names = new Set();
    for (const f of raw.folders) { const n = f && cleanName(f.name); if (f && idOk(f.id) && n && !names.has(n)) { names.add(n); lib.folders.push({ id: f.id, name: n }); } }
  }
  const folderIds = new Set(lib.folders.map(f => f.id));
  for (const d of lib.drawings) if (d.folder && !folderIds.has(d.folder)) delete d.folder;
  if (typeof raw.updatedAt === 'string') lib.updatedAt = raw.updatedAt;
  const cur = raw.current;
  if (cur && typeof cur === 'object' && typeof cur.drawingId === 'string') {
    lib.current = { drawingId: cur.drawingId, stepId: typeof cur.stepId === 'string' ? cur.stepId : null, mode: typeof cur.mode === 'string' ? cur.mode : null };
    if (VIEW_IDS.includes(cur.view)) lib.current.view = cur.view; // 2D：停在哪個視圖
  }
  return lib;
}
// 匯出：media＝{ id: dataURL }（照片與底圖；沒有就不帶）
export function exportDrawing(drawing, media = null) {
  const out = { format: DRAWING_FORMAT, version: FORMAT_VERSION, exportedAt: new Date().toISOString(), drawing };
  if (media && Object.keys(media).length) out.media = media;
  return JSON.stringify(out, null, 1);
}
export function exportLibrary(lib, media = null) {
  const out = { format: LIBRARY_FORMAT, version: FORMAT_VERSION, exportedAt: new Date().toISOString(), folders: lib.folders, drawings: lib.drawings.filter(d => !d.trashedAt) };
  if (media && Object.keys(media).length) out.media = media;
  return JSON.stringify(out, null, 1);
}
// 匯入一張頭圖或整個頭圖庫，都加進現有的頭圖庫，不蓋掉原本的。id 已經有的另外給新 id。
// 回傳 { added（加進來的頭圖）, media（檔案裡帶的照片與底圖：{ id: dataURL }，呼叫的人存進 IndexedDB） }
export function importInto(lib, text) {
  const raw = readJSON(text);
  let list;
  if (raw.format === DRAWING_FORMAT) list = [raw.drawing];
  else if (raw.format === LIBRARY_FORMAT && Array.isArray(raw.drawings)) list = raw.drawings;
  else throw new Error('このファイルは読めません：ここで書き出したカット図かカット図ライブラリの JSON を使ってください');
  // 先全部檢查完再加進去：其中一張讀不進來，頭圖庫就完全不動
  const added = list.map((d, i) => cleanDrawing(d, list.length > 1 ? (i + 1) + ' 枚目' : 'このカット図'));
  // 資料夾：照名字對到現有的；沒有就新增
  const folderMap = new Map();
  if (raw.format === LIBRARY_FORMAT && Array.isArray(raw.folders)) {
    for (const f of raw.folders) {
      const n = f && cleanName(f.name); if (!n || !idOk(f.id)) continue;
      const have = lib.folders.find(x => x.name === n) || (() => { const g = { id: newId(), name: n }; lib.folders.push(g); return g; })();
      folderMap.set(f.id, have.id);
    }
  }
  const have = new Set(lib.drawings.map(d => d.id));
  for (const d of added) {
    if (have.has(d.id)) { d.id = newId(); d.title = (d.title + '（読み込み）').slice(0, 40); }
    if (d.folder) { if (folderMap.has(d.folder)) d.folder = folderMap.get(d.folder); else delete d.folder; }
    delete d.trashedAt;
    have.add(d.id); lib.drawings.push(d);
  }
  const media = {};
  if (raw.media && typeof raw.media === 'object') for (const [id, url] of Object.entries(raw.media)) if (idOk(id) && typeof url === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(url)) media[id] = url;
  return { added, media };
}
