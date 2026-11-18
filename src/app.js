// SPDX-License-Identifier: AGPL-3.0-only
// 頭圖 3D：在 3D 頭模上畫圖的網頁。三個畫面：我的頭圖（首頁）、畫圖、預覽。
// 一張頭圖有好幾個步驟，每個步驟記自己畫的筆、視角，以及頭髮是不是放下的。全部自動存在這個瀏覽器的 localStorage，
// 可以匯出、匯入 JSON，也可以把一個步驟輸出成 2000×2000 的透明 PNG。資料格式在 doc.js（一筆圖）與 library.js（頭圖庫）。
// 操作：頭髮外輪廓線裡面單指畫、線外單指轉頭，雙指轉＋縮放（電腦：左鍵同單指、右鍵拖轉、滾輪縮放）。預覽時單指在哪裡都是轉頭。
// 工具：選取、點、線（兩點、水平、垂直、前斜、後斜、放射、手畫）、面（分區樣板、點一下填滿、自己圈）、髮片（提拉、髮長、轉向、切口、放下／拉起）。
// 樣式：實線／虛線、粗細三段、終點箭頭、顏色。另外有鏡像、吸附十五點與線端、復原重做、九個固定視角、標字、前面步驟變淡。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { loadMeshes } from './glb.js';
import { Scalp, geometryFrom, OFFSET } from './scalp.js';
import { streamline, rdp, tidyStroke, maxDeviation, mirrorX, onMidline, insideSphericalPolygon, insideOutline, toV, handleFromControl, controlFromHandle, pointAtFraction } from './geometry.js';
import { computeLandmarks, outlinePoints, structureLines } from './landmarks.js';
import { panelGeometry, strandGeometry, fanGeometry, normalizeLift, normalizeCut, cutRatio, CUT_MIN, fallenPanelGeometry, fallenStrandGeometry, effectiveLift, previousPanel, FIXED_DIRS } from './lift.js';
import * as D from './doc.js';
import * as L from './library.js';
import * as SEC from './section.js';
import * as TPL from './templates.js';
import * as FILL from './fill.js';
import { headMaterialOptions, addHeadStudioLights } from './head-style.js';
import * as H from './heads.js';
import * as TR from './transfer.js';
import { createFlat } from './flat/editor.js';

const UI_KEY = 'head3d.ui'; // 介面設定（工具、工具樣式、自訂色、輪廓線樣式）存在 localStorage 的哪個鍵
const CAMERA_TARGET = new THREE.Vector3(0, -0.025, 0);
const CAMERA_DISTANCE = 1.2;
const FRAME_HALF = 0.135, FRAME_MIN_HEIGHT = 0.32; // 手機先框頭部；展開設定或橫放仍容得下完整頭殼
// 九個固定視角。方位角 0＝正面（臉朝 +Z）、90＝模型左側（+X）、180＝後面、270＝模型右側。
const VIEWS = [
  { key: 'front', label: '正', az: 0 }, { key: 'front_left_45', label: '左前', az: 45 }, { key: 'left', label: '左', az: 90 },
  { key: 'back_left_45', label: '左後', az: 135 }, { key: 'back', label: '後', az: 180 }, { key: 'back_right_45', label: '右後', az: 225 },
  { key: 'right', label: '右', az: 270 }, { key: 'front_right_45', label: '右前', az: 315 }, { key: 'top', label: '頂' },
];
// 工具列：選取、點、線、面、髮片。「線」的形狀在選項列切換：手畫是另一個工具（freehand），其他形狀都是 line。
// 「髮片」＝畫一條兩點的線，畫完直接拉成髮片。shape＝畫出來的形狀；family＝之後畫的樣式記在哪一家（線與手畫共用 line）
const TOOLS = {
  select: {}, point: { shape: 'point', family: 'point' }, line: { shape: 'line', family: 'line' },
  freehand: { shape: 'freehand', family: 'line' }, region: { shape: 'region', family: 'region' }, panel: { shape: 'line', family: 'panel' },
};
// 「線」的形狀：兩點、手畫，加上五種分線（水平、垂直、前斜、後斜、放射）。分線也是 line 工具，畫出來是兩點的線多記一個 section（見 section.js）
const LINE_SHAPES = ['two', 'h', 'v', 'f', 'b', 'r', 'free'];
const SHAPE_KIND = { h: 'H', v: 'V', f: 'F', b: 'B', r: 'R' };
// 每種分線一句白話（選項列下面那一行）：這是什麼線、怎麼畫
const LINE_TIPS = {
  h: '水平：按住拖，線只沿著和地面平行的方向走。',
  v: '垂直：按住拖，上下直切；從現在這個角度看是直線。',
  f: '前斜：線往臉的方向低下去；斜度畫好後在「平行」裡改。',
  b: '後斜：線往後腦的方向低下去；斜度畫好後在「平行」裡改。',
  r: '放射：點一下頭皮，就從樞軸拉一條線到那裡。',
};
// 「面」工具怎麼做出一塊面：fill＝點在線圍起來的地方就填滿；draw＝自己圈（在頭上點幾下、按閉合）
const REGION_MODES = ['fill', 'draw'];
const REGION_TIPS = {
  fill: '上排樣板：按一下畫好分線。點一下填滿：點線圍起來的那一塊，就填上顏色（邊界＝畫好的線和外輪廓）。',
  draw: '上排樣板：按一下畫好分線。自己圈：在頭上點幾下，再按「閉合」，圈出一塊面。',
};
// 這兩個工具畫完會自動選取那一筆，所以這兩個工具下也能拖選取中那筆的端點與彎度把手
const AUTO_SELECT_TOOLS = ['line', 'panel'];
const TAP_PX = 6, HANDLE_PX = 16, ADD_PX = 12, HIT_PX = 12, SNAP_IN_PX = 7, SNAP_OUT_PX = 10, LONG_MS = 500, MIN_LEN = 0.004, COLLAPSE = 0.002;
const SEL_COLOR = '#CD7158'; // 選取中的那一筆畫成這個顏色
const BLOCK_OPACITY = 0.86, BLOCK_EDGE_WIDTH = 1.3; // 色塊髮片：色塊的不透明度、邊線的寬度

const $ = s => document.querySelector(s);
const stage = $('#stage'), canvas = $('#c'), toastEl = $('#toast'), handlesEl = $('#handles'), colorInput = $('#color-input');
let toastTimer = 0, colorLive = false; // colorLive：選色器拖動中（只推一次歷史）
// 提示泡泡放在底欄上方：底欄高度會變（選到一筆時換成設定），用 --foot 跟著
new ResizeObserver(() => document.documentElement.style.setProperty('--foot', $('#footer').offsetHeight + 'px')).observe($('#footer'));
function toast(msg, ms = 2200) { toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms); }

// ---------------------------------------------------------------- three.js 場景
const dpr = Math.min(window.devicePixelRatio || 1, 2);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(dpr);
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
addHeadStudioLights(THREE, scene);
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 5);
// 畫跟轉不用按鈕：外輪廓線內單指畫、線外單指轉（每一指落下時決定，見「單指轉動」）；雙指轉＋縮放；電腦左鍵同單指、右鍵拖轉、中鍵／滾輪縮放
const controls = new OrbitControls(camera, canvas);
controls.enablePan = false; controls.enableDamping = false; controls.minZoom = 0.3; controls.maxZoom = 8; // 縮小到 0.3：髮片畫長也拉得進畫面 controls.rotateSpeed = 0.8;
controls.touches.ONE = null; controls.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;
controls.mouseButtons.LEFT = null; controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY; controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
controls.addEventListener('change', requestRender);
controls.addEventListener('start', () => markView(null)); // 自己轉過：視角鈕不再標九個固定視角之一
canvas.addEventListener('contextmenu', e => e.preventDefault());

let renderQueued = false;
function requestRender() {
  if (renderQueued) return; renderQueued = true;
  const go = () => { if (!renderQueued) return; renderQueued = false; orientArrowHeads(); syncLabels(); renderer.render(scene, camera); updateHandles(); };
  requestAnimationFrame(go); setTimeout(go, 80);
}
function updateCamera(aspect) {
  camera.top = Math.max(FRAME_MIN_HEIGHT / 2, FRAME_HALF / aspect);
  camera.bottom = -camera.top; camera.right = camera.top * aspect; camera.left = -camera.right;
  camera.updateProjectionMatrix();
}
function resize() { const w = Math.max(1, stage.clientWidth), h = Math.max(1, stage.clientHeight); renderer.setSize(w, h, false); updateCamera(w / h); requestRender(); }
new ResizeObserver(resize).observe(stage);
function worldPerPx() { return (camera.top - camera.bottom) / camera.zoom / Math.max(1, canvas.clientHeight); }
// persist：按視角鈕＝這一步記住這個視角
let viewKey = null;
function setView(v, persist = false) {
  const dir = new THREE.Vector3();
  // 頂視：臉朝上；視角選單的「頂視：臉朝下」開著就反過來（後腦在上、臉在下）
  if (v.key === 'top') dir.set(0, 1, doc.settings.topFaceDown ? 0.0002 : -0.0002).normalize();
  else { const a = THREE.MathUtils.degToRad(v.az); dir.set(Math.sin(a), 0, Math.cos(a)); }
  camera.up.set(0, 1, 0);
  camera.position.copy(CAMERA_TARGET).addScaledVector(dir, CAMERA_DISTANCE);
  camera.zoom = 1; camera.updateProjectionMatrix();
  controls.target.copy(CAMERA_TARGET); controls.update();
  markView(v.key);
  if (persist) { curStep().view = cameraState(); saveLib(); }
  requestRender();
}
function markView(key) {
  viewKey = key;
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === key));
  const v = VIEWS.find(x => x.key === key);
  $('#view-label').textContent = v ? v.label + (v.key === 'top' && doc.settings.topFaceDown ? '↓' : '') : '視角';
}
const r4 = x => Math.round(x * 10000) / 10000;
function cameraState() { return { p: camera.position.toArray().map(r4), u: camera.up.toArray().map(r4), z: r4(camera.zoom), k: viewKey }; }
function applyCamera(s) {
  camera.position.fromArray(s.p); camera.up.fromArray(s.u); camera.zoom = s.z; camera.updateProjectionMatrix();
  controls.target.copy(CAMERA_TARGET); controls.update(); markView(s.k || null); requestRender();
}
// 打開一個步驟：照這一步記住的視角；沒記過就用左前
function applyStepView() { const s = curStep(); if (s.view) applyCamera(s.view); else setView(VIEWS[1]); }
const _ndc = new THREE.Vector2(), _ray = new THREE.Raycaster(), _proj = new THREE.Vector3(), _camDir = new THREE.Vector3();
function rayAt(x, y) { const r = canvas.getBoundingClientRect(); _ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1); _ray.setFromCamera(_ndc, camera); return _ray.ray; }
function pickAt(x, y) { const ray = rayAt(x, y); return scalp.pick(ray.origin, ray.direction); }
function toScreen(v) { _proj.copy(v).project(camera); return { x: (_proj.x + 1) / 2 * canvas.clientWidth, y: (1 - _proj.y) / 2 * canvas.clientHeight }; }
function isOccluded(v) { camera.getWorldDirection(_camDir); return scalp.occluded(v.clone().addScaledVector(_camDir, -2), v); }
const localXY = e => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

// ---------------------------------------------------------------- 頭圖庫、這一步的筆、歷史、存檔
// lib＝頭圖庫（library.js）；drawing＝打開的這張頭圖；stepIndex＝第幾個步驟；doc＝這一步的筆（layers）與設定（settings 就是 lib.settings）
let lib = null, drawing = null, stepIndex = 0, mode = 'home';
let doc = { layers: [], settings: L.defaultSettings() };
const history = [], future = [];
const objects = new Map(); // layer id → { group, dense, hit:[Vector3], segs:[[start,end]] }
let scalp = null, outlineLine = null, structureGroup = null, headGroup = null;
let landmarks = []; // computeLandmarks() 的 21 個點（十五點，側面的分左右）：吸附候選、外輪廓與結構線的骨架
let headList = null, headId = null, transferCtx = null; // 頭模清單、現在載入的是哪顆、換頭模搬圖的對照資料
let fallen = false; // 這一步現在是「放下」（true）還是「拉起」（false）
const FALL_STRANDS = 9; // 放下時一片至少畫 9 根，看得出垂下來的樣子

const curStep = () => (drawing ? drawing.steps[stepIndex] || null : null);
function saveLib() {
  lib.updatedAt = new Date().toISOString();
  try { localStorage.setItem(L.STORAGE_KEY, L.serializeLibrary(lib)); } catch (e) { toast('自動儲存失敗：' + (e && e.message || e), 4000); }
}
// 每畫一筆：這一步的筆寫回頭圖庫
function save() {
  L.storeStepLayers(curStep(), doc.layers);
  L.touch(drawing); saveLib();
  updateButtons(); renderStrip(); syncFallBtn();
}
// 讀回存在這個瀏覽器裡的頭圖庫。讀不回來：原文另存一份（不蓋掉），開一份新的
function loadLibrary() {
  const text = localStorage.getItem(L.STORAGE_KEY);
  if (text) {
    try { lib = L.parseLibrary(text); }
    catch (e) {
      try { localStorage.setItem(L.STORAGE_KEY + '.unreadable-' + Date.now(), text); } catch { /* 存不下就不另存 */ }
      toast('頭圖庫讀不回來（原檔另存了一份），先開一份新的：' + e.message, 5000);
    }
  }
  if (!lib) lib = L.newLibrary();
  doc.settings = lib.settings;
}
function snapshot() { return JSON.stringify(doc.layers); }
function pushHistory() { history.push(snapshot()); if (history.length > 60) history.shift(); future.length = 0; }
// 復原／重做：同一個 id 的筆內容可能變了（拖過點、改過髮片角度、選取色），所以全部拆掉重建，不能只補缺的
function restore(json) { doc.layers = JSON.parse(json); selectedId = null; activeHandle = null; for (const id of [...objects.keys()]) removeObject(id); rebuild(); save(); syncUI(); }
function undo() { if (!history.length) return; cancelDraft(); future.push(snapshot()); restore(history.pop()); }
function redo() { if (!future.length) return; cancelDraft(); history.push(snapshot()); restore(future.pop()); }
function updateButtons() {
  const f = !!drawing && L.is2d(drawing);
  $('#undo').disabled = f ? !flat.canUndo() : !history.length;
  $('#redo').disabled = f ? !flat.canRedo() : !future.length;
}
// 畫了東西＝這一步也記住現在的視角（預覽時「回到這一步的視角」就回到這裡）
function commit() { if (mode === 'draw') curStep().view = cameraState(); save(); }
const layerById = id => doc.layers.find(l => l.id === id) || null;
const P3 = v => ({ x: v.x, y: v.y, z: v.z });

// ---------------------------------------------------------------- 線的顯示
function lineMaterial(style, dashed, opts = {}) {
  const m = new LineMaterial({ color: new THREE.Color(opts.color ?? style.stroke), linewidth: style.width * dpr, worldUnits: false, dashed: !!dashed,
    transparent: opts.opacity !== undefined && opts.opacity < 1, opacity: opts.opacity ?? 1, depthWrite: !(opts.opacity !== undefined && opts.opacity < 1) });
  if (dashed) { const u = style.width * 0.00045; m.dashSize = D.DASH[0] * u; m.gapSize = D.DASH[1] * u; m.dashScale = 1; }
  return m;
}
function makeLine(dense, mat, closed = false) {
  const pts = closed ? dense.concat([dense[0]]) : dense;
  const geo = new LineGeometry();
  const flat = new Float32Array(pts.length * 3);
  pts.forEach((p, i) => { flat[i * 3] = p.x; flat[i * 3 + 1] = p.y; flat[i * 3 + 2] = p.z; });
  geo.setPositions(flat);
  const line = new Line2(geo, mat); line.computeLineDistances(); line.frustumCulled = false;
  return line;
}
// 箭頭頭：平面的燕尾三角，永遠正對鏡頭（每次重畫前 orientArrowHeads 轉一次），
// 大小跟線寬走（世界單位，縮放時和頭模一起變）；線本身在箭頭底下截短（trimEnd），圓頭線端才不會從尖端兩側冒出來。
const arrowLen = style => 0.0052 + style.width * 0.0017;
function arrowDir(dense, back) { // 從尾端往回量 back 公尺取方向（太近的點方向會抖）
  const end = dense[dense.length - 1];
  for (let i = dense.length - 2; i >= 0; i--) if (dense[i].distanceTo(end) >= back || i === 0) { const d = end.clone().sub(dense[i]); return d.lengthSq() < 1e-14 ? null : d.normalize(); }
  return null;
}
function trimEnd(dense, cut) {
  if (dense.length < 2) return dense;
  let left = cut;
  for (let i = dense.length - 1; i > 0; i--) {
    const seg = dense[i].distanceTo(dense[i - 1]);
    if (seg >= left) { const p = dense[i].clone().lerp(dense[i - 1], left / seg); return dense.slice(0, i).concat([p]); }
    left -= seg;
  }
  return dense.slice(0, 2);
}
const arrowLine = (style, dense) => trimEnd(dense, arrowLen(style) * 0.6);
function makeArrowHead(style, dense, colorHex) {
  if (dense.length < 2) return null;
  const len = arrowLen(style), dir = arrowDir(dense, len); if (!dir) return null;
  const w = len * 0.4, notch = len * 0.74;
  const s = new THREE.Shape(); s.moveTo(0, 0); s.lineTo(-w, -len); s.lineTo(0, -notch); s.lineTo(w, -len); s.closePath();
  const m = new THREE.Mesh(new THREE.ShapeGeometry(s), new THREE.MeshBasicMaterial({ color: new THREE.Color(colorHex ?? style.stroke), side: THREE.DoubleSide }));
  m.userData.arrow = { end: dense[dense.length - 1].clone(), dir }; m.renderOrder = 3;
  orientArrow(m);
  return m;
}
const _ax = new THREE.Vector3(), _ay = new THREE.Vector3(), _az = new THREE.Vector3(), _am = new THREE.Matrix4();
function orientArrow(m) {
  const { end, dir } = m.userData.arrow;
  camera.getWorldDirection(_az);
  _ay.copy(dir).addScaledVector(_az, -dir.dot(_az)); // 箭頭方向投到畫面平面
  if (_ay.lengthSq() < 0.02) { m.visible = false; return; } // 幾乎正對或背對鏡頭：不畫頭
  m.visible = true; _ay.normalize(); _az.negate(); _ax.crossVectors(_ay, _az);
  m.quaternion.setFromRotationMatrix(_am.makeBasis(_ax, _ay, _az));
  m.position.copy(end).addScaledVector(_az, 0.004); // 往鏡頭挪 4 mm，斜看時不會插進頭皮
}
function orientArrowHeads() { scene.traverse(o => { if (o.userData.arrow) orientArrow(o); }); }
function pointRadius(style) { return 0.0009 + style.width * 0.00032; }
// 一筆的貼頭皮密集點（線的主體；髮片是根線）
function denseFor(layer) {
  const pts = D.pointArrays(layer);
  if (['point', 'strand', 'fan'].includes(layer.shape)) { const h = scalp.nearest(pts[0]); return [h.point.clone().addScaledVector(h.normal, OFFSET)]; }
  if (layer.shape === 'line') { const sec = sectionOf(layer), cut = sec ? SEC.sectionDense(scalp, sec, pts[0], pts[1]) || SEC.sectionBridged(scalp, sec, pts[0], pts[1]) : null; return cut || scalp.line(pts[0], pts[1], layer.control); } // 分線＝切面線；切不出來（跑出可畫範圍）退回最短線
  if (layer.shape === 'region') return layer.poly ? scalp.polyLoop(pts) : scalp.curveWithBends(pts, layer.bends, true); // poly＝點一下填色的面：邊照點直接連
  return scalp.curveWithBends(pts, layer.bends || []);
}
// 密集點裡每個控制點落在哪（給段中把手用）：回傳每段的 [起, 迄] 索引
function segmentRanges(dense, layer) {
  const pts = layer.points.map(toV), idx = [];
  let from = 0;
  for (const p of pts) { let best = from, bd = Infinity; for (let i = from; i < dense.length; i++) { const d = dense[i].distanceTo(p); if (d < bd) { bd = d; best = i; } } idx.push(best); from = best; }
  const segs = [];
  for (let i = 0; i + 1 < idx.length; i++) segs.push([idx[i], idx[i + 1]]);
  if (layer.shape === 'region') segs.push([idx[idx.length - 1], dense.length]); // 最後一段繞回第一點（dense 不含重複的首點）
  return segs;
}
function segmentDense(o, i) {
  const [s, e] = o.segs[i];
  if (e >= o.dense.length) return o.dense.slice(s).concat([o.dense[0]]);
  return o.dense.slice(s, e + 1);
}
// 面的填色三角形：算一次要幾十毫秒（大塊的面、邊要切細），選取／取消選取、復原、換步驟都會重畫同一塊，所以照「邊的點」留著。
// 留的是座標（Float32Array），每次重畫包成新的幾何（用完的幾何由 disposeGroup 丟掉）。最多留 80 塊，滿了就丟最早放進去的。
const fillCache = new Map();
function regionTriangles(layer, dense) {
  const key = (layer.poly ? 'p' : 'c') + JSON.stringify(layer.points) + (layer.poly ? '' : JSON.stringify(layer.bends || 0));
  if (fillCache.has(key)) return fillCache.get(key);
  const pos = scalp.regionPositions(dense);
  fillCache.set(key, pos); if (fillCache.size > 80) fillCache.delete(fillCache.keys().next().value);
  return pos;
}
// 標字：每一筆都可以帶一小段字，畫在它旁邊（髮片＝髮尾線外面一點；其他＝中間那一點往頭外推一點）。
// 字是畫在圖裡的（匯出的 PNG 也帶），墨色、白色描邊，壓在什麼顏色上都看得到。
const LABEL_HEIGHT = 0.0105; // 剛建好時的字高（公尺）；畫面上的大小每次重畫前由 syncLabels 重算
function labelSprite(text) {
  const fs = 44, pad = 10, font = '600 ' + fs + 'px "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", system-ui, sans-serif';
  const cv = document.createElement('canvas'); let cx = cv.getContext('2d');
  cx.font = font; const w = Math.ceil(cx.measureText(text).width) + pad * 2, h = fs + pad * 2;
  cv.width = w; cv.height = h; cx = cv.getContext('2d');
  cx.font = font; cx.textBaseline = 'middle'; cx.lineJoin = 'round';
  cx.lineWidth = 9; cx.strokeStyle = '#FFFFFF'; cx.strokeText(text, pad, h / 2 + 2);
  cx.fillStyle = D.LABEL_INK; cx.fillText(text, pad, h / 2 + 2);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true }));
  sp.scale.set(LABEL_HEIGHT * w / h, LABEL_HEIGHT, 1); sp.renderOrder = 6; sp.userData.isLabel = true; sp.userData.aspect = w / h;
  return sp;
}
function labelAnchor(dense, extra) {
  const tips = extra && (extra.fallTips || extra.tipLine), mid = a => a[Math.floor(a.length / 2)];
  if (tips && tips.length) { const t = mid(tips), d = t.clone().sub(mid(dense)); return d.lengthSq() > 1e-8 ? t.clone().addScaledVector(d.normalize(), 0.010) : t.clone(); }
  const m = mid(dense) || dense[0], out = m.clone().sub(scalp.center);
  return out.lengthSq() > 1e-8 ? m.clone().addScaledVector(out.normalize(), 0.012) : m.clone();
}
function addLabel(group, layer, dense, extra) {
  const text = D.cleanLabel(layer.label); if (!text || !dense.length) return;
  const sp = labelSprite(text); sp.position.copy(labelAnchor(dense, extra)); sp.userData.anchor = sp.position.clone(); group.add(sp);
}
// 標字固定成螢幕上的大小（畫面拉遠也讀得到），而且整段字留在畫面裡（貼著畫面邊的字往裡面推）。
// 每次重畫前算一次：字的中心＝它那一筆旁邊的定位點；超出畫面邊就往裡面推。
const LABEL_PX = 17, LABEL_PX_MIN = 11, LABEL_EDGE = 4; // 手機整個畫面寬時 17 px；畫面窄就跟著縮，最小 11 px
const _labelV = new THREE.Vector3();
function syncLabels() {
  const W = canvas.clientWidth, H = canvas.clientHeight; if (!W || !H) return;
  const wpp = worldPerPx(), px = Math.max(LABEL_PX_MIN, Math.min(LABEL_PX, W / 22));
  scene.traverse(o => {
    if (!o.userData.isLabel) return;
    const wpx = px * o.userData.aspect;
    o.scale.set(wpx * wpp, px * wpp, 1);
    _labelV.copy(o.userData.anchor).project(camera);
    const hx = wpx / W + 2 * LABEL_EDGE / W, hy = px / H + 2 * LABEL_EDGE / H;
    const x = hx >= 1 ? 0 : Math.max(-1 + hx, Math.min(1 - hx, _labelV.x)), y = hy >= 1 ? 0 : Math.max(-1 + hy, Math.min(1 - hy, _labelV.y));
    o.position.copy(_labelV.set(x, y, _labelV.z).unproject(camera));
  });
}
// 一筆 → three 物件（不加進場景）。buildLayer 把它加進場景並登記；「前面步驟變淡」用它做淡色的複本
function makeLayerObject(layer, selected = false, layers = null) {
  const dense = denseFor(layer);
  // 髮片實際用的設定（「跟前一片」時角度、髮長、切口照前一片；layers＝這一筆所在那一步的全部筆，淡色的前面步驟用它自己那一步的）
  const LF = layer.shape === 'panel' ? effectiveLift(layer, layers || doc.layers) : layer.lift;
  const group = new THREE.Group(); group.renderOrder = 2;
  const s = layer.style, color = selected ? SEL_COLOR : s.stroke;
  const hit = layer.poly ? [] : dense.slice(), extra = {};
  // 髮尾線：沒切口＝虛線（拉出去後的形狀）；剪過（lift.cut）＝橘色實線；選取中照選取色
  const tipLineOf = (g, style, dashedDefault) => { const cut = !!LF.cut; if (!g.tipLine.some(q => q.distanceTo(g.tipLine[0]) > 0.0015)) return new THREE.Group(); return makeLine(g.tipLine, lineMaterial(style, cut ? false : dashedDefault, { color: cut && !selected ? D.CUT_COLOR : color })); };
  if (layer.shape === 'point') {
    const m = new THREE.Mesh(new THREE.SphereGeometry(pointRadius(s), 20, 14), new THREE.MeshBasicMaterial({ color: new THREE.Color(color) })); m.position.copy(dense[0]); group.add(m);
  } else if (layer.shape === 'region') {
    const g = scalp.positionsGeometry(regionTriangles(layer, dense));
    // 填滿的面不畫邊（邊就是圍住它的那些線；再畫一圈會和線疊在同一個位置，搶成一段一段）。
    // 選到它＝整塊換成選取色（和選到線時線變成選取色一樣），取消選取就看到它自己的顏色。
    const picked = layer.poly && selected;
    if (g) group.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: new THREE.Color(picked ? color : s.fill), transparent: true, opacity: picked ? Math.max(s.opacity, 0.55) : s.opacity, depthWrite: false, side: THREE.DoubleSide })));
    if (!layer.poly) group.add(makeLine(dense, lineMaterial({ ...s, width: Math.max(1.5, s.width * 0.6) }, layer.dashed, { color }), true));
  } else if (layer.shape === 'panel' && fallen) {
    // 放下：根線照原線；每根頭髮照自己的髮長垂下來（細線，往白色調淡；沒有箭頭——箭頭＝提拉）；髮尾連成放下後的外形線（剪過＝橘色實線，沒剪＝虛線）
    const g = fallenPanelGeometry(scalp, dense, LF, { strands: Math.max(LF.strands, FALL_STRANDS) });
    group.add(makeLine(dense, lineMaterial(s, layer.dashed, { color })));
    const hairStyle = { ...s, width: Math.max(1.2, s.width * 0.45) }, hairColor = selected ? color : new THREE.Color(s.stroke).lerp(_white, 0.35);
    for (const p of g.paths) if (p.length >= 2) group.add(makeLine(p, lineMaterial(hairStyle, false, { color: hairColor })));
    if (g.tipLine.length >= 2) group.add(tipLineOf(g, { ...s, width: Math.max(1.3, s.width * 0.6) }, true));
    hit.push(...g.tipLine); for (const p of g.paths) if (p.length >= 2) hit.push(pointAtFraction(p, 0.5));
    extra.fallTips = g.tipLine;
  } else if (layer.shape === 'strand' && fallen) {
    const g = fallenStrandGeometry(scalp, D.pointArrays(layer)[0], LF);
    if (g.path.length >= 2) { group.add(makeLine(g.path, lineMaterial(s, layer.dashed, { color }))); hit.push(...[0.25, 0.5, 0.75, 1].map(t => pointAtFraction(g.path, t))); }
    extra.fallTips = [g.tip];
  } else if (layer.shape === 'panel') {
    const g = panelGeometry(scalp, dense, LF), edge = lineMaterial(s, layer.dashed, { color });
    const blockEdge = { ...s, width: BLOCK_EDGE_WIDTH }, blockInk = selected ? color : D.LABEL_INK;
    group.add(makeLine(dense, LF.style === 'BLOCK' ? lineMaterial(blockEdge, false, { color: blockInk }) : edge));
    if (LF.style === 'BLOCK') {
      // 色塊：實心色塊＋細墨線邊，不畫髮束也不畫箭頭；伸出去的方向＝提拉方向，最外面那一邊＝剪線（剪過＝橘色的粗線）
      const verts = [], n = g.roots.length;
      for (let j = 0; j + 1 < n; j++) { const a = g.roots[j], b = g.roots[j + 1], c = g.tips[j + 1], d = g.tips[j]; verts.push(a, b, c, a, c, d); }
      group.add(new THREE.Mesh(new THREE.BufferGeometry().setFromPoints(verts), new THREE.MeshBasicMaterial({ color: new THREE.Color(color), transparent: true, opacity: BLOCK_OPACITY, depthWrite: false, side: THREE.DoubleSide })));
      for (const j of [0, n - 1]) group.add(makeLine(g.paths[j], lineMaterial(blockEdge, false, { color: blockInk })));
      const cut = !!LF.cut;
      if (g.tipLine.some(q => q.distanceTo(g.tipLine[0]) > 0.0015)) group.add(makeLine(g.tipLine, lineMaterial(cut ? { ...s, width: Math.max(2.6, s.width) } : blockEdge, false, { color: cut && !selected ? D.CUT_COLOR : blockInk })));
    } else if (LF.style === 'ARROWS') {
      // 箭頭：根線照原線；提拉＝細箭頭（這片髮片自己的顏色），髮束數＝箭頭數（含兩端）；髮尾＝虛線（拉出去後的形狀）；不填色
      const aStyle = { ...s, width: Math.max(1.3, s.width * 0.6) };
      for (let j = 0; j < g.roots.length; j++) { group.add(makeLine(arrowLine(aStyle, g.paths[j]), lineMaterial(aStyle, false, { color }))); const head = makeArrowHead(aStyle, g.paths[j], color); if (head) group.add(head); }
      group.add(tipLineOf(g, aStyle, true));
    } else {
      group.add(tipLineOf(g, s, layer.dashed));
      for (const j of [0, g.roots.length - 1]) group.add(makeLine(g.paths[j], lineMaterial(s, layer.dashed, { color })));
      if (LF.style !== 'OUTLINE') for (let j = 0; j < g.roots.length; j++) group.add(makeLine(g.paths[j], lineMaterial({ ...s, width: Math.max(1.2, s.width * 0.55) }, false, { color })));
      if (['TINT', 'RIBBONS'].includes(LF.style)) {
        const verts = [], n = g.roots.length;
        for (let j = 0; j + 1 < n; j++) { if (LF.style === 'RIBBONS' && j % 2) continue; const a = g.roots[j], b = g.roots[j + 1], c = g.tips[j + 1], d = g.tips[j]; verts.push(a, b, c, a, c, d); }
        const geo = new THREE.BufferGeometry().setFromPoints(verts);
        group.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: new THREE.Color(s.fill), transparent: true, opacity: s.opacity, depthWrite: false, side: THREE.DoubleSide })));
      }
    }
    hit.push(...g.tipLine); for (const p of g.paths) if (p.length > 2) hit.push(p[Math.floor(p.length / 2)]);
    extra.tipLine = g.tipLine; // 小剪刀把手要放在髮尾線的一端
  } else if (layer.shape === 'strand') {
    const g = strandGeometry(scalp, D.pointArrays(layer)[0], LF);
    group.add(makeLine(layer.arrow ? arrowLine(s, g.path) : g.path, lineMaterial(s, layer.dashed, { color })));
    if (layer.arrow) { const head = makeArrowHead(s, g.path, color); if (head) group.add(head); }
    hit.push(...[0.25, 0.5, 0.75, 1].map(t => pointAtFraction(g.path, t)));
  } else if (layer.shape === 'fan') {
    const g = fanGeometry(scalp, D.pointArrays(layer)[0], LF);
    for (const r of g.rays) { group.add(makeLine(r.path, lineMaterial({ ...s, width: Math.max(1.2, s.width * 0.6) }, layer.dashed, { color }))); hit.push(r.tip, pointAtFraction(r.path, 0.5)); }
    group.add(makeLine(g.arc, lineMaterial(s, false, { color })));
    hit.push(...g.arc);
  } else {
    group.add(makeLine(layer.arrow ? arrowLine(s, dense) : dense, lineMaterial(s, layer.dashed, { color })));
    if (layer.arrow) { const head = makeArrowHead(s, dense, color); if (head) group.add(head); }
  }
  const segs = layer.poly ? [] : D.hasSegments(layer.shape) ? segmentRanges(dense, layer) : (layer.shape === 'line' ? [[0, dense.length - 1]] : []);
  addLabel(group, layer, dense, extra);
  return { group, dense, hit, segs, ...extra };
}
function buildLayer(layer, selected = false) {
  const o = makeLayerObject(layer, selected);
  scene.add(o.group);
  objects.set(layer.id, o);
}
// 前面步驟變淡：把前面幾步畫的筆用淡色疊上來（不能點、不能改）
let ghostGroup = null, ghostLayers = [], ghostTips = [], ghostDense = []; // ghostDense＝[{ layer, dense }]：點一下填色時，看得到的淡色線也是邊界
// 淡色用「往白色調淡、不透明」：Line2 半透明時每個接點會疊出深色小點，面的填色才用透明度
const _white = new THREE.Color(0xffffff);
function fadeGroup(g, f) {
  g.traverse(o => {
    const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of ms) {
      if (m.isLineMaterial) { m.color.lerp(_white, 1 - f); m.linewidth *= 0.8; m.depthWrite = false; } // 淡色線不寫深度：這一步的線剛好畫在前一步的線上（同一條正中線、同一個高度的分線）時，才不會兩條搶成一顆一顆
      else if (m.transparent) m.opacity *= f;
      else if (m.color) m.color.lerp(_white, 1 - f);
    }
  });
}
function buildGhosts() {
  if (ghostGroup) { disposeGroup(ghostGroup); ghostGroup = null; }
  ghostLayers = []; ghostTips = []; ghostDense = [];
  const idx = lib.settings.ghost ? L.ghostIndices(drawing, stepIndex) : [];
  if (!idx.length) { syncFallBtn(); requestRender(); return; }
  const g = new THREE.Group();
  for (const j of idx) {
    let layers; try { layers = L.stepLayers(drawing.steps[j]); } catch { continue; }
    for (const l of layers) { try { const o = makeLayerObject(l, false, layers); fadeGroup(o.group, 0.38); o.group.renderOrder = 1.5; g.add(o.group); ghostLayers.push(l); ghostDense.push({ layer: l, dense: o.dense }); if (o.fallTips) ghostTips.push(...o.fallTips); } catch (e) { console.warn('淡色複本建不出來', e); } }
  }
  scene.add(g); ghostGroup = g; syncFallBtn(); requestRender();
}
function disposeGroup(group) { group.traverse(o => { if (o.material && o.material.map) o.material.map.dispose(); if (o.geometry && !o.isSprite) o.geometry.dispose(); if (o.material) o.material.dispose(); }); scene.remove(group); }
function removeObject(id) { const o = objects.get(id); if (!o) return; disposeGroup(o.group); objects.delete(id); }
const rebuildOnly = l => { removeObject(l.id); try { buildLayer(l, l.id === selectedId); } catch (e) { console.warn('建不出來', l.id, e); } };
// 一片髮片重建之後，排在它後面「跟前一片」的髮片也要重建
function rebuildFollowers(layer) { const i = doc.layers.findIndex(l => l.id === layer.id); for (const f of doc.layers.slice(i + 1)) if (f.shape === 'panel' && f.lift.follow) rebuildOnly(f); }
// 重建一筆後一定要重畫：把手是 HTML 會即時動，three 的線要等下一次 render
function rebuildLayer(layer) { rebuildOnly(layer); if (layer.shape === 'panel') rebuildFollowers(layer); requestRender(); }
function rebuild() {
  const ids = new Set(doc.layers.map(l => l.id));
  for (const id of [...objects.keys()]) if (!ids.has(id)) removeObject(id);
  if (selectedId && !ids.has(selectedId)) { selectedId = null; activeHandle = null; }
  for (const l of doc.layers) if (!objects.has(l.id)) { try { buildLayer(l, l.id === selectedId); } catch (e) { console.warn('建不出來', l.id, e); } }
  requestRender();
}
// 輪廓線樣式：眼睛選單切換，記在介面設定裡（不進 JSON）。不認得的樣式一律當細實線。
const OUTLINE_STYLES = ['thin', 'bold', 'dash', 'dot'];
let outlinePts = null, outlineStyle = 'thin';
function buildOutline(kind) {
  if (outlineLine) disposeGroup(outlineLine);
  const g = new THREE.Group(), C = D.OUTLINE_COLOR;
  const add = (pts, st, dashed = false) => { const ln = makeLine(pts, lineMaterial(st, dashed), true); ln.renderOrder = 1; g.add(ln); return ln; };
  if (kind === 'bold') add(outlinePts, { stroke: '#1B1B1B', width: 2.8 });
  else if (kind === 'dash') add(outlinePts, { stroke: C, width: 1.8 }, true);
  else if (kind === 'dot') { const m = add(outlinePts, { stroke: C, width: 2.6 }, true).material; m.dashSize = 0.0007; m.gapSize = 0.0026; }
  else add(outlinePts, { stroke: C, width: 1.6 });
  g.renderOrder = 1; g.visible = doc.settings.outline;
  scene.add(g); outlineLine = g; requestRender();
}
function setOutlineStyle(kind) {
  outlineStyle = OUTLINE_STYLES.includes(kind) ? kind : 'thin'; saveUI(); buildOutline(outlineStyle);
  document.querySelectorAll('[data-ostyle]').forEach(b => b.classList.toggle('on', b.dataset.ostyle === outlineStyle));
}
function setOutlineVisible(on) { outlineLine.visible = on; $('#tgl-outline').setAttribute('aria-pressed', String(on)); requestRender(); }
function setStructureVisible(on) { structureGroup.visible = on; $('#tgl-structure').setAttribute('aria-pressed', String(on)); $('#struct-btn').setAttribute('aria-pressed', String(on)); requestRender(); }

// ---------------------------------------------------------------- 工具、樣式
let tool = 'line', selectedId = null, lineShape = 'two', regionMode = 'fill';
const familyOf = t => TOOLS[t].family || null;
// 每種工具之後畫的樣式，照家族存（線與手畫共用 line），記在介面設定裡。toolStyle()＝目前這個工具的
const toolStyles = D.defaultToolStyles();
const toolStyle = () => toolStyles[familyOf(tool)];
let customColor = null;
function loadUI() {
  try {
    const u = JSON.parse(localStorage.getItem(UI_KEY) || '{}');
    // 存回來的工具樣式逐欄檢查，不合格的那一欄用預設
    for (const k of Object.keys(toolStyles)) {
      const s = u.toolStyles && u.toolStyles[k], t = toolStyles[k]; if (!s || typeof s !== 'object') continue;
      if (D.isColor(s.stroke)) t.stroke = s.stroke;
      if (Number.isFinite(s.width) && s.width >= 0.5 && s.width <= 24) t.width = s.width;
      if (typeof s.dashed === 'boolean') t.dashed = s.dashed;
      if (typeof s.arrow === 'boolean') t.arrow = s.arrow;
    }
    if (D.isColor(u.customColor)) customColor = u.customColor;
    if (Object.hasOwn(TOOLS, u.tool)) tool = u.tool === 'freehand' ? 'line' : u.tool; // 每次打開，線都先回到「兩點」；要手畫再自己切
    if (REGION_MODES.includes(u.regionMode)) regionMode = u.regionMode;
    if (OUTLINE_STYLES.includes(u.outlineStyle)) outlineStyle = u.outlineStyle;
  } catch { /* 介面設定讀不回來就用預設 */ }
}
function saveUI() { try { localStorage.setItem(UI_KEY, JSON.stringify({ toolStyles, customColor, tool, regionMode, outlineStyle })); } catch { /* 存不下就不記 */ } }
function setTool(t) {
  if (t === 'line' && lineShape === 'free') t = 'freehand'; // 「線」按鈕＝目前選的形狀
  if (tool !== t) cancelDraft();
  tool = t;
  if (t !== 'select') select(null);
  document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === (t === 'freehand' ? 'line' : t)));
  saveUI(); syncUI();
}
function setLineShape(s) {
  lineShape = LINE_SHAPES.includes(s) ? s : 'two';
  cancelDraft(); pickingPivot = false; // 換形狀：畫到一半的那條不算
  if (tool === 'line' || tool === 'freehand') setTool(lineShape === 'free' ? 'freehand' : 'line'); else { saveUI(); syncUI(); }
  updateHandles();
}
// ---------------------------------------------------------------- 分線形狀（水平、垂直、前斜、後斜、放射）與平行重複
let diagDeg = SEC.DIAG_DEFAULT; // 前斜、後斜下一條要用的斜度（改過選取中那一條的斜度就跟著記）
let radPivot = null, pickingPivot = false; // 放射的樞軸（null＝頭頂 T.P）；pickingPivot＝下一下點頭皮是在放樞軸
let clipHinted = false;
const camDir = () => camera.getWorldDirection(new THREE.Vector3());
// 現在「線」工具畫出來的是哪一種分線（null＝一般的兩點線）
function drawSection() {
  if (tool !== 'line') return null;
  const kind = SHAPE_KIND[lineShape]; if (!kind) return null;
  return SEC.normalizeSection({ kind, deg: diagDeg, pivot: 0, az: kind === 'V' ? SEC.verticalAz(camDir()) : null }); // 垂直：照現在看的角度切（頂視＝由兩個端點決定）
}
const sectionOf = l => (l && l.shape === 'line' && !l.control && l.section ? l.section : null);
// 外輪廓裡面（線上也算：外輪廓本身抬高 0.9 mm，所以留 1.5 mm）
const inOutline = p => insideOutline(p, scalp.center, outlineDirs, outlinePts, 0.0015);
// 手指按在外輪廓線上或線外一點點（10 px 內算可以畫）：分線的起點拉回外輪廓上，整條線才都在裡面
function intoOutline(p) {
  if (inOutline(p)) return p;
  let best = null, bd = Infinity;
  for (const q of outlinePts) { const d = q.distanceTo(p); if (d < bd) { bd = d; best = q; } }
  return best ? scalp.nearest(best).point : p;
}
function pivotPoint() {
  if (radPivot) return radPivot.clone();
  const tp = landmarks.find(c => c.id === 'T.P');
  return tp ? scalp.nearest(tp.point).point : scalp.nearest(new THREE.Vector3(0, 1, 0)).point;
}
// 畫到一半的那條線的終點：分線照切面走（水平、斜線只能沿著那片面；走到外輪廓就停），一般的線照手指
function setDraftEnd(p) {
  if (!draft.sect) { draft.points[1] = p; draft.dense = null; return true; }
  const f = SEC.fitSection(scalp, draft.sect, draft.points[0], p, inOutline);
  if (!f) return false;
  draft.points[1] = f.b; draft.dense = f.dense; draft.clipped = f.clipped;
  return true;
}
// 畫好：建立這條線（分線多帶 section），畫完自動選取
function finishLine(d, st) {
  const pts = d.points.slice(0, 2), made = createLayer('line', pts, st, d.sect ? { section: { ...d.sect } } : {});
  if (made && d.sect && d.clipped && !clipHinted) { clipHinted = true; toast('線只畫到外輪廓為止', 2000); }
  autoSelect(made);
}
// 改過一條分線的端點之後（拖把手、整條搬、改斜度）：anchor＝不動的那一端的索引。
// 水平、前斜、後斜把「動的那一端」拉回切面上；每一種都只畫到外輪廓為止。畫不出來回 false（呼叫的人還原）。
function refitSection(l, anchor = 0) {
  const sec = sectionOf(l); if (!sec) return true;
  const s = anchor === 0 || sec.kind !== 'R' ? sec : { ...sec, pivot: sec.pivot === 1 ? 0 : 1 }; // fitSection 把第一個參數當 points[0]：反過來餵時樞軸的索引也要反
  const f = SEC.fitSection(scalp, s, toV(l.points[anchor]), toV(l.points[1 - anchor]), inOutline);
  if (!f) return false;
  l.points[anchor] = P3(f.a); l.points[1 - anchor] = P3(f.b);
  return true;
}
// 平行重複（選到水平、垂直、前斜、後斜的線時，選取列的「平行」）：幾條、間隔幾公分（沿頭皮量）、往哪一邊
let repCount = SEC.REPEAT.countDefault, repGap = SEC.REPEAT.gapDefault, repDir = -1;
function syncRepeatPop() {
  const l = layerById(selectedId), sec = sectionOf(l);
  if (!SEC.canRepeat(sec)) { closePops(); return; }
  $('#rep-count-v').textContent = repCount + ' 條';
  $('#rep-gap-v').textContent = repGap + ' cm';
  const [pos, neg] = SEC.repeatDirLabels(scalp, sec, toV(l.points[0]), toV(l.points[1]));
  $('#rep-dir-pos').textContent = pos; $('#rep-dir-neg').textContent = neg;
  $('#rep-dir-pos').classList.toggle('on', repDir > 0); $('#rep-dir-neg').classList.toggle('on', repDir < 0);
  $('#rep-deg-row').hidden = !SEC.isDiag(sec.kind);
  if (SEC.isDiag(sec.kind)) $('#rep-deg-v').textContent = sec.deg + '°';
}
function repeatClick() {
  const open = $('#repeat-pop').hidden; closePops(); if (!open) return;
  $('#repeat-pop').hidden = false; $('#sel-repeat').setAttribute('aria-expanded', 'true'); syncRepeatPop();
}
function makeRepeats() {
  const l = layerById(selectedId), sec = sectionOf(l);
  if (!SEC.canRepeat(sec)) return;
  const r = SEC.parallelSections(scalp, sec, toV(l.points[0]), toV(l.points[1]), { count: repCount, gapCm: repGap, dir: repDir, inside: inOutline });
  if (!r.lines.length) { toast('這一邊畫不出來：已經到外輪廓外面' + (sec.kind === 'H' ? '，或到頭頂了' : ''), 2600); return; }
  pushHistory();
  let made = 0;
  const countBefore = doc.layers.length;
  for (const ln of r.lines) {
    const n = D.newLayer({ shape: 'line', points: [ln.a, ln.b], style: { stroke: l.style.stroke, width: l.style.width }, dashed: l.dashed, arrow: l.arrow, section: { ...sec } });
    try { addLayer(n); made++; } catch (e) { console.warn('平行重複畫不出來', e); }
  }
  if (!made) { history.pop(); toast('這一邊畫不出來', 1800); return; }
  commit(); closePops(); requestRender();
  const both = doc.layers.length - countBefore > made ? '（鏡像那一側也畫了）' : '';
  toast(r.skipped ? '多畫了 ' + made + ' 條' + both + '；另外 ' + r.skipped + ' 條超出外輪廓' + (sec.kind === 'H' ? '或到頭頂了' : '') + '，沒有畫' : '多畫了 ' + made + ' 條' + both, 2800);
}
// 改選取中那條前斜／後斜的斜度（第一點不動，第二點沿新的切面滑過去）；下一條新畫的也用這個斜度
function stepDiag(delta) {
  const l = layerById(selectedId), sec = sectionOf(l);
  if (!sec || !SEC.isDiag(sec.kind)) return;
  const deg = Math.min(SEC.DIAG_MAX, Math.max(SEC.DIAG_MIN, sec.deg + delta));
  if (deg === sec.deg) return;
  const before = snapshot(), keepPts = l.points.map(P3);
  l.section = { ...sec, deg };
  if (!refitSection(l, 0)) { l.points = keepPts; l.section = sec; toast('這個斜度在這裡畫不出來', 1800); return; }
  history.push(before); if (history.length > 60) history.shift(); future.length = 0;
  diagDeg = deg; rebuildLayer(l); syncPartner(l); commit(); updateHandles(); syncRepeatPop();
}
// ---------------------------------------------------------------- 分區樣板（正中線、耳到耳、四區、U型區、瀏海三角）
// 「面」工具第一列按一下：照頭模的點位畫出分線（位置在 templates.js 算）。畫出來是一般的線，用線工具的預設樣式（不跟線工具現在的樣式走），
// 可以再用「選取」調整；一次復原全部退掉。這一步已經有的那幾條不重畫。鏡像開著時，左右成對的兩條配成一對（之後調一邊，另一邊跟著動）。
function addTemplate(key) {
  const label = TPL.TEMPLATE_LABELS[key];
  let specs;
  try { specs = TPL.templateLines(scalp, landmarks, key, inOutline); } catch (e) { toast(label + '畫不出來：' + (e && e.message || e), 2600); return; }
  const fresh = specs.filter(s => !doc.layers.some(l => TPL.sameLine(l, s)));
  if (!fresh.length) { toast('這一步已經有' + label + '了；要調整用「選取」點那條線', 2400); return; }
  const st = D.defaultToolStyles().line;
  const made = fresh.map(s => ({ spec: s, layer: D.newLayer({ shape: s.shape, points: s.points, section: s.section, style: { stroke: st.stroke, width: st.width }, dashed: st.dashed, arrow: st.arrow }) }));
  pushHistory();
  const built = [];
  for (const m of made) { doc.layers.push(m.layer); try { buildLayer(m.layer); built.push(m); } catch (e) { doc.layers.pop(); console.warn('樣板的線畫不出來', m.spec.id, e); } }
  if (!built.length) { history.pop(); updateButtons(); toast(label + '畫不出來', 2000); return; }
  if (doc.settings.mirror) for (const m of built) { const mate = m.spec.pair && built.find(x => x.spec.id === m.spec.pair); if (mate) m.layer.mirrorPairId = mate.layer.id; }
  commit(); requestRender();
  const had = specs.length - fresh.length;
  toast(label + '畫好了（' + built.length + ' 條分線' + (had ? '；已經有的 ' + had + ' 條沒有重畫' : '') + '）。要調整用「選取」點那條線', 3000);
}
// ---------------------------------------------------------------- 點一下填色
// 「面」工具第二列選「點一下填滿」：點在線圍起來的地方，就把那一塊填滿（幾何在 fill.js）。邊界＝這一步畫的線（分線、曲線、手畫線、髮片的根線、
// 別的面的邊；箭頭線不算）＋看得到的淡色前面步驟的線＋外輪廓。沒有圍起來就提示，不會整顆頭填滿。
// 填出來是一塊面（region，多一個 poly＝邊照點直接連）：顏色照「面」工具現在的樣式；用「選取」點它可以換顏色、刪掉，沒有把手。
// 填的是當下的形狀：之後再搬線，面不會跟著動（刪掉重點一次）。鏡像開著時另一側對應的那一塊也一起填、配成一對。
function setRegionMode(m) {
  regionMode = REGION_MODES.includes(m) ? m : 'fill';
  cancelDraft(); saveUI(); syncUI(); updateHandles();
}
function fillBoundaries() {
  const out = [{ points: outlinePts, closed: true, outline: true }];
  const take = (l, dense) => {
    if (!dense || dense.length < 2) return;
    if (l.shape === 'region') out.push({ points: dense, closed: true });
    else if (['line', 'curve', 'freehand', 'panel'].includes(l.shape) && !l.arrow) out.push({ points: dense, closed: false });
  };
  for (const l of doc.layers) { const o = objects.get(l.id); if (o) take(l, o.dense); }
  if (ghostGroup) for (const g of ghostDense) take(g.layer, g.dense);
  return out;
}
const FILL_WHY = {
  outside: '這裡在外輪廓外面：點外輪廓裡面、線圍起來的那一塊',
  tiny: '這一塊太小，點不到：把畫面放大一點再點',
};
function fillAt(point) {
  const C = scalp.center, P = scalp.nearest(point).point;
  const regionAt = p => { const d = p.clone().sub(C).normalize(); return doc.layers.find(l => { const o = l.shape === 'region' ? objects.get(l.id) : null; return o && insideSphericalPolygon(d, o.dense.map(q => q.clone().sub(C).normalize())); }); };
  if (regionAt(P)) { toast('這一塊已經有顏色了：要換顏色或刪掉，用「選取」點它', 2600); return; }
  const bounds = fillBoundaries(), lineCount = bounds.filter(b => !b.outline).length;
  let r;
  try { r = FILL.fillCell(scalp, P, bounds); } catch (e) { console.warn('填色算不出來', e); toast('這一塊填不出來', 2000); return; }
  if (!r.ok) {
    toast(r.reason === 'open' ? (lineCount ? '這一塊沒有圍起來：線頭要接到別的線或外輪廓（差一點點會自動接上）' : '這一步還沒有線：先按上排的樣板，或用「線」畫分線，再點要填的那一塊') : FILL_WHY[r.reason] || '這一塊填不出來', 3200);
    return;
  }
  const st = toolStyles.region;
  const make = loop => D.newLayer({ shape: 'region', poly: true, points: loop, style: { stroke: st.stroke, width: st.width } });
  const fresh = [make(r.loop)];
  // 鏡像：另一側對應的那一塊（不是同一塊、還沒有顏色、也圍得起來）一起填
  if (doc.settings.mirror) {
    const M = scalp.nearest(mirrorX(P)).point;
    if (!r.contains(M) && !regionAt(M)) { try { const m = FILL.fillCell(scalp, M, bounds); if (m.ok) fresh.push(make(m.loop)); } catch (e) { console.warn('鏡像那一側填不出來', e); } }
  }
  pushHistory();
  const built = [];
  for (const l of fresh) { doc.layers.push(l); try { buildLayer(l); built.push(l); } catch (e) { doc.layers.pop(); console.warn('填色畫不出來', e); } }
  if (!built.length) { history.pop(); updateButtons(); toast('這一塊填不出來', 2000); return; }
  if (built.length === 2) { built[0].mirrorPairId = built[1].id; built[1].mirrorPairId = built[0].id; }
  commit(); requestRender();
  toast(built.length === 2 ? '左右兩塊都填好了。要換顏色或刪掉，用「選取」點它' : '填好了。要換顏色或刪掉，用「選取」點它', 2400);
}
// 樣式列在編輯誰：選取中的那一筆，或目前這個工具之後要畫的樣式（髮片工具畫的是線，但樣式算髮片的）
function activeStyle() {
  const l = selectedId ? layerById(selectedId) : null;
  if (l) return { stroke: l.style.stroke, width: l.style.width, dashed: l.dashed, arrow: l.arrow, shape: l.shape };
  const fam = familyOf(tool);
  return fam ? { ...toolStyles[fam], shape: fam === 'panel' ? 'panel' : TOOLS[tool].shape } : null;
}
// 改樣式：有選取中的一筆就改那一筆（可復原），沒有就改目前這個工具之後畫的
function applyStyle(partial, noHistory = false) { // noHistory：選色器拖動中，第一下之後不再推歷史
  const l = selectedId ? layerById(selectedId) : null;
  if (l) {
    if (!noHistory) pushHistory();
    if ('stroke' in partial) l.style.stroke = partial.stroke;
    if ('width' in partial) l.style.width = partial.width;
    if ('dashed' in partial && l.shape !== 'point') l.dashed = partial.dashed;
    if ('arrow' in partial && !D.NO_ARROW_SHAPES.includes(l.shape)) l.arrow = partial.arrow;
    D.normalizeStyle(l);
    rebuildLayer(l); syncPartner(l, true); commit(); syncUI(); return;
  }
  const fam = familyOf(tool); if (!fam) return;
  Object.assign(toolStyles[fam], partial);
  saveUI(); syncUI();
}
function bendLabel(l) { if (l.shape === 'line') return l.control ? '拉直' : '彎'; return '拉直'; }
function syncUI() {
  const st = activeStyle();
  const l = selectedId ? layerById(selectedId) : null;
  const isLift = !!l && D.LIFT_SHAPES.includes(l.shape);
  // 選到一筆時底欄換成「這一筆」：選取列＋（髮片類）提拉、角度、髮長；「更多」再展開轉向、基準、畫法、髮束數、切口
  $('#selbar').hidden = !l;
  $('#tools').hidden = !!l;
  // 選項列（線的形狀、分區樣板、鏡像）只在畫圖工具、沒選東西時
  $('#optrow').hidden = !!l || tool === 'select';
  const lineOn = ['line', 'freehand'].includes(tool);
  $('#line-shape').hidden = !lineOn;
  const regionOn = tool === 'region'; // 面工具的第一列＝分區樣板（五顆）；下面一行白話
  $('#tpl-kind').hidden = !regionOn;
  $('#tpl-tip').hidden = !regionOn || !!l; if (regionOn) $('#tpl-tip').textContent = REGION_TIPS[regionMode];
  $('#fillrow').hidden = !regionOn || !!l; // 面工具第二列「點一下填滿／自己圈」
  document.querySelectorAll('[data-rmode]').forEach(b => b.classList.toggle('on', b.dataset.rmode === regionMode));
  $('#optrow').classList.toggle('lines', lineOn || regionOn); // 七種形狀（或五顆樣板）排一列：字放圖示下面、鏡像鈕也縮成同樣大小
  // 分線形狀下面一行白話；放射多一顆「換樞軸」
  const tipKey = lineOn && tool === 'line' && !l ? lineShape : null;
  $('#line-tip').hidden = !LINE_TIPS[tipKey];
  if (LINE_TIPS[tipKey]) $('#line-tip-text').textContent = pickingPivot ? '點一下頭皮：放射線都從這一點出發（會吸到十五點）。'
    : tipKey === 'r' ? LINE_TIPS.r.replace('樞軸', radPivot ? '樞軸（你放的那一點）' : '樞軸（頭頂）')
    : tipKey === 'f' || tipKey === 'b' ? LINE_TIPS[tipKey].replace('：', ' ' + diagDeg + '°：') : LINE_TIPS[tipKey];
  $('#pivot-btn').hidden = tipKey !== 'r';
  $('#pivot-btn').setAttribute('aria-pressed', String(pickingPivot));
  $('#pivot-btn-text').textContent = pickingPivot ? '回頭頂' : '換樞軸';
  document.querySelectorAll('[data-lshape]').forEach(b => b.classList.toggle('on', b.dataset.lshape === lineShape));
  // 樣式列：畫圖工具，或選到髮片類以外的一筆時出現
  $('#stylerow').hidden = isLift || !st;
  if ($('#stylerow').hidden && !$('#style-pop').hidden) closePops();
  if (st) {
    // 「實線／虛線」兩顆只在線類出現；線樣的顏色＝這一筆（或這個工具）的顏色
    const chips = $('#style-chips');
    chips.hidden = !['line', 'curve', 'freehand'].includes(st.shape);
    chips.style.setProperty('--c', st.stroke);
    chips.querySelectorAll('[data-dash]').forEach(b => b.classList.toggle('on', (b.dataset.dash === '1') === st.dashed));
    // ⋯ 選單：粗細、終點箭頭、顏色
    document.querySelectorAll('[data-width]').forEach(b => b.classList.toggle('on', Math.abs(+b.dataset.width - st.width) < 0.01));
    $('#tgl-arrow').setAttribute('aria-pressed', String(st.arrow));
    $('#tgl-arrow').disabled = D.NO_ARROW_SHAPES.includes(st.shape);
    let matched = false;
    document.querySelectorAll('.sw[data-color]').forEach(b => { const on = b.dataset.color.toLowerCase() === st.stroke.toLowerCase(); b.classList.toggle('on', on); if (on) matched = true; });
    const custom = $('#sw-custom');
    custom.classList.toggle('has', !!customColor);
    if (customColor) { custom.style.setProperty('--sw', customColor); if (!colorLive) colorInput.value = customColor.toLowerCase(); }
    custom.classList.toggle('on', !matched && !!customColor && customColor.toLowerCase() === st.stroke.toLowerCase());
  }
  if (l) {
    const single = ['point', 'strand', 'fan'].includes(l.shape);
    const sec = sectionOf(l);
    $('#sel-label').textContent = sec ? SEC.SECTION_LABELS[sec.kind] + '線' : l.poly ? '填滿的面' : D.SHAPE_LABELS[l.shape];
    $('#sel-repeat').hidden = !SEC.canRepeat(sec); // 水平、垂直、前斜、後斜 → 平行重複（斜度也在裡面）
    if ($('#sel-repeat').hidden && !$('#repeat-pop').hidden) closePops();
    // 選取列：線→反轉／彎／刪點／拉成髮片；點→提拉線／角度扇形；髮片類→反轉／刪點／更多；用不到的鈕藏起來
    $('#sel-flip').hidden = single || l.shape === 'region';
    $('#sel-bend').hidden = !['line', 'curve', 'freehand'].includes(l.shape);
    $('#sel-bend-text').textContent = bendLabel(l);
    $('#sel-bend').querySelector('use').setAttribute('href', l.shape === 'line' && !l.control ? '#i-bend' : '#i-straight');
    $('#sel-delpoint').hidden = single || !!l.poly; // 填滿的面沒有把手，也就沒有「刪點」
    $('#sel-delpoint').disabled = !(activeHandle && activeHandle.kind === 'pt' && l.points.length > D.minPoints(l.shape));
    $('#sel-panel').hidden = !LIFTABLE_FROM.includes(l.shape);
    $('#sel-strand').hidden = $('#sel-fan').hidden = l.shape !== 'point';
    $('#sel-more').hidden = !isLift;
    $('#sel-more').setAttribute('aria-expanded', String(liftMore));
    $('#sel-label-btn').classList.toggle('has', !!l.label);
    if (isLift) syncLiftCard(l);
  }
  $('#liftcard').hidden = !isLift;
  $('#liftcard').classList.toggle('more-open', liftMore);
  $('#tgl-mirror').setAttribute('aria-pressed', String(doc.settings.mirror));
  canvas.classList.toggle('select', tool === 'select');
}

// ---------------------------------------------------------------- 選取、鏡像
let activeHandle = null; // 選取中的把手 { kind:'pt'|'bend', index }
function select(id, handle = null) {
  const prev = selectedId;
  selectedId = id; activeHandle = handle;
  if (prev && prev !== id) { const pl = layerById(prev); if (pl) rebuildLayer(pl); }
  if (id) { const l = layerById(id); if (l) rebuildLayer(l); }
  syncUI(); requestRender();
}
const partnerOf = l => l && l.mirrorPairId ? layerById(l.mirrorPairId) : null;
const mirrorPt = p => { const h = scalp.nearest(mirrorX(p)); return h.point; };
function mirrored(l, id) {
  return D.newLayer({ id, shape: l.shape, points: l.points.map(mirrorPt), style: { stroke: l.style.stroke, width: l.style.width, opacity: l.style.opacity }, dashed: l.dashed, arrow: l.arrow, poly: l.poly === true,
    control: l.control ? mirrorX(l.control) : null, bends: l.bends ? l.bends.map(b => (b ? mirrorPt(b) : null)) : undefined, section: SEC.mirrorSection(sectionOf(l)) || undefined, // 分線鏡像過去還是同一種（水平、斜線的切面左右對稱；垂直的切面方向左右對調；放射照兩個端點算）
    lift: l.lift ? { ...l.lift } : undefined }); // 轉向正值一律朝臉前，鏡像不取負；切口照沿根線的比例直接複製（鏡像的點順序一樣）
}
// 新增一筆（含鏡像配對）
function addLayer(l) {
  doc.layers.push(l);
  if (doc.settings.mirror && !onMidline(l.points)) {
    const p = mirrored(l); p.mirrorPairId = l.id; l.mirrorPairId = p.id; doc.layers.push(p);
    try { buildLayer(p); } catch (e) { console.warn(e); }
  }
  try { buildLayer(l); } catch (e) { doc.layers = doc.layers.filter(x => x !== l && x.id !== l.mirrorPairId); throw e; }
}
// 改了一筆之後：鏡像開著就同步另一側；關著就解除配對
function syncPartner(l, styleOnly = false) {
  const p = partnerOf(l);
  if (!p) { delete l.mirrorPairId; return; }
  if (doc.settings.mirror) {
    const idx = doc.layers.indexOf(p);
    const n = mirrored(l, p.id); n.mirrorPairId = l.id;
    if (p.label) n.label = p.label; // 標字是每一筆自己的，同步形狀時留著
    if (styleOnly) { n.points = p.points; n.control = p.control ?? null; if (p.bends) n.bends = p.bends; if (p.lift) n.lift = p.lift; if (p.section) n.section = p.section; else delete n.section; }
    doc.layers[idx] = n; rebuildLayer(n);
  } else { delete p.mirrorPairId; delete l.mirrorPairId; toast('鏡像關著：這一筆已和另一側解除配對'); }
}
function deleteLayer(l) {
  pushHistory();
  const ids = new Set([l.id]);
  const p = partnerOf(l);
  if (p) { if (doc.settings.mirror) ids.add(p.id); else delete p.mirrorPairId; }
  doc.layers = doc.layers.filter(x => !ids.has(x.id));
  select(null); rebuild(); commit();
}

// ---------------------------------------------------------------- 吸附
let snapId = null, snapPos = null;
function snapCandidates(excludeId) {
  const out = landmarks.map(c => ({ id: 'lm:' + c.id + c.side, pos: c.point }));
  const ex = layerById(excludeId), exPair = ex && ex.mirrorPairId;
  for (const l of doc.layers) {
    if (l.id === excludeId || l.id === exPair) continue;
    if (l.shape === 'region') continue;
    if (l.points.length === 1) { out.push({ id: 'end:' + l.id + ':0', pos: toV(l.points[0]) }); continue; }
    out.push({ id: 'end:' + l.id + ':0', pos: toV(l.points[0]) }, { id: 'end:' + l.id + ':1', pos: toV(l.points[l.points.length - 1]) });
  }
  return out;
}
// 回傳吸附後的頭皮點（Vector3）。候選：十五個參考點（含鏡像）、線端點、中線（x=0）。進 7 px／出 10 px 遲滯。
function snap(point, excludeId) {
  if (!doc.settings.snap) { snapId = null; snapPos = null; return point; }
  const wpp = worldPerPx(), inT = SNAP_IN_PX * wpp, outT = SNAP_OUT_PX * wpp;
  const cands = snapCandidates(excludeId);
  const mid = Math.abs(point.x) <= outT ? (() => { const q = point.clone(); q.x = 0; const h = scalp.nearest(q); h.point.x = 0; return { id: 'mid', pos: h.point }; })() : null;
  if (mid) cands.push(mid);
  if (snapId) { const cur = cands.find(c => c.id === snapId); if (cur && cur.pos.distanceTo(point) <= outT) { snapPos = cur.pos.clone(); return snapPos.clone(); } snapId = null; }
  let best = null, bd = Infinity;
  for (const c of cands) { const d = c.pos.distanceTo(point); if (d < bd) { bd = d; best = c; } }
  if (best && bd <= inT) { snapId = best.id; snapPos = best.pos.clone(); return snapPos.clone(); }
  snapId = null; snapPos = null; return point;
}
function clearSnap() { snapId = null; snapPos = null; }

// ---------------------------------------------------------------- 畫圖（指標事件）
const pointers = new Map();
let draft = null;   // 進行中：{ kind:'line'|'region'|'freehand', points:[Vector3], preview:Group }
let gesture = null; // 這一指：{ id, x0, y0, moved, kind, ... }
let longTimer = 0;
function previewStyle() { const st = toolStyle(); return { stroke: st.stroke, width: st.width, dash: [], fill: st.stroke, opacity: 1 }; }
function clearPreview() { if (draft && draft.preview) { disposeGroup(draft.preview); draft.preview = null; } }
function renderPreview() {
  if (!draft) return; clearPreview();
  const st = toolStyle(), style = previewStyle();
  const g = new THREE.Group();
  try {
    if (draft.kind === 'line' && draft.points.length === 2) { const dense = draft.dense || scalp.line(draft.points[0], draft.points[1]); g.add(makeLine(st.arrow ? arrowLine(style, dense) : dense, lineMaterial(style, st.dashed, { opacity: 0.75 }))); if (st.arrow) { const h = makeArrowHead(style, dense); if (h) g.add(h); } }
    else if (draft.kind === 'freehand' && draft.points.length >= 2) { const dense = draft.points.map(p => p.clone()); g.add(makeLine(dense, lineMaterial(style, st.dashed, { opacity: 0.75 }))); }
    else if (draft.kind === 'region' && draft.points.length >= 2) { const dense = scalp.curveWithBends(draft.points, [], draft.points.length >= 3); g.add(makeLine(dense, lineMaterial({ ...style, width: Math.max(1.5, style.width * 0.6) }, st.dashed, { opacity: 0.75 }), draft.points.length >= 3)); }
  } catch (e) { /* 兩點太近等：先不畫 */ }
  if (g.children.length) { scene.add(g); draft.preview = g; }
  requestRender();
}
function updateDraftBar() {
  const bar = $('#draftbar'); if (!draft) { bar.hidden = true; return; }
  const n = draft.points.length, done = $('#draft-done'), txt = $('#draft-text');
  if (draft.kind === 'line') { bar.hidden = n !== 1; txt.textContent = '再點一下終點'; done.hidden = true; }
  else if (draft.kind === 'region') { bar.hidden = false; done.hidden = false; txt.textContent = n < 3 ? '再點下一個點（至少 3 點）' : '已點 ' + n + ' 點'; done.disabled = n < 3; }
  else bar.hidden = true;
}
function cancelDraft() { if (!draft) return; clearPreview(); draft = null; clearSnap(); updateDraftBar(); updateHandles(); requestRender(); }
function finishDraft() {
  if (!draft) return;
  const d = draft, st = toolStyle();
  if (d.kind === 'region' && d.points.length < 3) { cancelDraft(); return; }
  clearPreview(); draft = null; clearSnap(); updateDraftBar();
  createLayer(TOOLS[tool].shape, d.points, st);
}
function createLayer(shape, points, st, extra = {}) {
  const pts = points.map(p => p.clone());
  if (D.minPoints(shape) > 1) {
    let len = 0; for (let i = 1; i < pts.length; i++) len += pts[i].distanceTo(pts[i - 1]);
    if (shape === 'region') len += pts[0].distanceTo(pts[pts.length - 1]);
    if (len < MIN_LEN) { toast('太短了，再拉長一點', 1500); requestRender(); return null; }
  }
  const layer = D.newLayer({ shape, points: pts, style: { stroke: st.stroke, width: st.width }, dashed: st.dashed, arrow: st.arrow, ...extra });
  pushHistory();
  try { addLayer(layer); } catch (e) { history.pop(); toast('這一筆畫不出來：' + e.message); requestRender(); return null; }
  commit(); requestRender(); return layer;
}
// 點到哪一筆：先看離線最近（12 px 內），再看點在哪個區塊裡面
function hitLayer(hit) {
  if (!hit) return null;
  const tol = HIT_PX * worldPerPx();
  let best = null, bd = Infinity;
  for (const l of doc.layers) {
    const o = objects.get(l.id); if (!o) continue;
    const extra = l.shape === 'point' ? pointRadius(l.style) : l.style.width * worldPerPx() * 0.5;
    for (const p of o.hit) { const d = p.distanceTo(hit.point); if (d < bd && d <= tol + extra) { bd = d; best = l; } }
  }
  if (best) return best;
  const dir = hit.point.clone().sub(scalp.center).normalize();
  for (const l of doc.layers) { if (l.shape !== 'region') continue; const o = objects.get(l.id); if (o && insideSphericalPolygon(dir, o.dense.map(p => p.clone().sub(scalp.center).normalize()))) return l; }
  return null;
}
// 選取中那一筆的把手：頂點（pt）、每段的彎度點（bend）、每段 1/4 與 3/4 的加點把手（add）
function bendHandles(l) {
  const o = objects.get(l.id); if (!o) return [];
  if (l.shape === 'line') {
    if (l.control) return [scalp.nearest(handleFromControl(l.points[0], l.control, l.points[1])).point];
    return [scalp.nearest(pointAtFraction(o.dense, 0.5)).point];
  }
  if (!D.hasSegments(l.shape)) return [];
  return o.segs.map((_, i) => (l.bends && l.bends[i] ? toV(l.bends[i]) : scalp.nearest(pointAtFraction(segmentDense(o, i), 0.5)).point));
}
function addHandles(l) {
  const o = objects.get(l.id); if (!o || !(l.shape === 'line' || D.hasSegments(l.shape))) return [];
  const out = [];
  o.segs.forEach((_, i) => { const seg = segmentDense(o, i); for (const f of [0.25, 0.75]) out.push({ index: i, pos: scalp.nearest(pointAtFraction(seg, f)).point }); });
  return out;
}
// withAdd=false：只認端點與彎度把手（線、髮片工具下，加點的小淡點不作用也不顯示）
function handleAt(x, y, withAdd = true) {
  const l = selectedId ? layerById(selectedId) : null; if (!l || l.poly) return null; // 填滿的面沒有把手
  let best = null, bd = HANDLE_PX;
  l.points.forEach((p, i) => { const s = toScreen(toV(p)); const d = Math.hypot(s.x - x, s.y - y); if (d < bd) { bd = d; best = { kind: 'pt', index: i }; } });
  if (best) return best;
  bendHandles(l).forEach((m, i) => { const s = toScreen(m); const d = Math.hypot(s.x - x, s.y - y); if (d < bd) { bd = d; best = { kind: 'bend', index: i, pos: m }; } });
  if (best || !withAdd) return best;
  bd = ADD_PX;
  addHandles(l).forEach(a => { const s = toScreen(a.pos); const d = Math.hypot(s.x - x, s.y - y); if (d < bd) { bd = d; best = { kind: 'add', index: a.index, pos: a.pos }; } });
  return best;
}
// 在第 i 段中間插一個頂點：直線變曲線；被插點的那一段不再有彎度點
function insertVertex(l, i, pos) {
  if (l.shape === 'line') { l.shape = 'curve'; l.control = null; delete l.section; l.points.splice(1, 0, P3(pos)); l.bends = [null, null]; D.normalizeStyle(l); return 1; } // 加了點就不是分線了
  l.points.splice(i + 1, 0, P3(pos));
  const bends = l.bends || []; bends.splice(i, 1, null, null); l.bends = D.normalizeBends(bends, D.segmentCount(l));
  return i + 1;
}
function removeVertex(l, k) {
  l.points.splice(k, 1);
  const bends = l.bends || [], n = l.points.length + 1;
  if (D.hasSegments(l.shape)) {
    if (l.shape === 'region') { const segs = n; const prev = (k - 1 + segs) % segs; bends.splice(Math.min(prev, k), 2 - (prev === k ? 1 : 0), null); if (prev > k) { bends.splice(prev - 1, 1); } }
    else { if (k === 0) bends.splice(0, 1); else if (k === n - 1) bends.splice(k - 1, 1); else bends.splice(k - 1, 2, null); }
    l.bends = D.normalizeBends(bends, D.segmentCount(l));
  }
  if ((l.shape === 'curve' || l.shape === 'freehand') && l.points.length === 2) { l.shape = 'line'; l.control = null; delete l.bends; D.normalizeStyle(l); }
}
function moveLayerBy(l, orig, dx, dy) {
  const r = canvas.getBoundingClientRect(), pts = [];
  for (const p of orig.points) { const s = toScreen(p); const h = pickAt(s.x + dx + r.left, s.y + dy + r.top); if (!h) return false; pts.push(h.point); }
  const bends = [];
  for (const b of orig.bends) { if (!b) { bends.push(null); continue; } const s = toScreen(b); const h = pickAt(s.x + dx + r.left, s.y + dy + r.top); if (!h) return false; bends.push(h.point); }
  l.points = pts.map(P3);
  if (l.shape === 'line' && orig.control) { const m = orig.handle; const s = toScreen(m); const h = pickAt(s.x + dx + r.left, s.y + dy + r.top); if (!h) return false; l.control = P3(controlFromHandle(pts[0], pts[1], h.point)); }
  if (l.bends) l.bends = bends.map(b => (b ? P3(b) : null));
  if (sectionOf(l) && !refitSection(l, 0)) return false; // 整條搬的分線：第一點照手指，第二點拉回切面上
  return true;
}
function captureOrig(l) {
  const o = { points: l.points.map(toV), bends: (l.bends || []).map(b => (b ? toV(b) : null)), control: l.control ? toV(l.control) : null, shape: l.shape, section: l.section ? { ...l.section } : null };
  if (l.shape === 'line' && l.control) o.handle = scalp.nearest(handleFromControl(l.points[0], l.control, l.points[1])).point;
  return o;
}
function restoreOrig(l, o) { l.points = o.points.map(P3); l.shape = o.shape; if (o.section) l.section = { ...o.section }; else delete l.section; if (o.shape === 'line') { l.control = o.control ? P3(o.control) : null; delete l.bends; } else { delete l.control; l.bends = o.bends.map(b => (b ? P3(b) : null)); } D.normalizeStyle(l); }

// 有一部分點跑到畫面外面：鏡頭拉遠到全部看得到（正交相機，縮放就是對畫面中心等比例）
function ensureVisible(points, margin = 0.9) {
  // clone：project 會改掉傳進來的點（放下的髮尾還要拿來點選）
  let worst = 0; for (const p of points) { const q = toV(p).clone().project(camera); worst = Math.max(worst, Math.abs(q.x), Math.abs(q.y)); }
  if (worst <= margin) return;
  camera.zoom = Math.max(controls.minZoom, camera.zoom * margin / worst); camera.updateProjectionMatrix(); controls.update(); markView(null); requestRender();
}

// ---------------------------------------------------------------- 單指轉動
// 每一指（或滑鼠左鍵）落下時先決定這一指是畫還是轉頭：
//   拖選取中那筆的把手／小剪刀、選取工具點到一筆、面工具點回第一點、落在外輪廓裡面（離線 OUTLINE_EDGE_PX 內也算，按在線上就能從線上畫）＝畫、拖、選；
//   其他（輪廓線外的額頭與頸部頭皮、臉、耳、脖子、肩膀、空白）＝轉頭。外輪廓線關掉不顯示時範圍一樣。
// OrbitControls 的 pointerdown 比畫布上的這個先跑，所以在 document 的捕獲階段先把 controls.touches.ONE／mouseButtons.LEFT 設好。
// 第二指落下不改（雙指交給 OrbitControls 轉＋縮放）；右鍵拖轉、滾輪縮放也是 OrbitControls 的。
const OUTLINE_EDGE_PX = 10;
let outlineDirs = null, orbitDown = null, outsideHinted = false; // orbitDown＝{ id, orbit }：這一指的決定
function inHair(hit) { return !!hit && insideOutline(hit.point, scalp.center, outlineDirs, outlinePts, OUTLINE_EDGE_PX * worldPerPx()); }
function wantsOrbit(e) {
  if (mode === 'preview') return true; // 預覽：單指在哪裡都是轉頭，不能畫
  const xy = localXY(e);
  const l = selectedId ? layerById(selectedId) : null;
  if (l && (tool === 'select' || AUTO_SELECT_TOOLS.includes(tool))) {
    if (l.shape === 'panel' && scissorsScreen && Math.hypot(xy.x - scissorsScreen.x, xy.y - scissorsScreen.y) <= SCISSORS_PX) return false;
    if (handleAt(xy.x, xy.y, tool === 'select')) return false;
  }
  if (draft && draft.kind === 'region' && draft.points.length >= 3) { const f = toScreen(draft.points[0]); if (Math.hypot(f.x - xy.x, f.y - xy.y) < HANDLE_PX) return false; }
  const hit = pickAt(e.clientX, e.clientY);
  if (tool === 'select' && hitLayer(hit)) return false;
  return !inHair(hit);
}
document.addEventListener('pointerdown', e => {
  if (e.target !== canvas || pointers.size > 0 || e.button !== 0) return;
  const orbit = wantsOrbit(e);
  orbitDown = { id: e.pointerId, orbit };
  controls.touches.ONE = orbit ? THREE.TOUCH.ROTATE : null;
  controls.mouseButtons.LEFT = orbit ? THREE.MOUSE.ROTATE : null;
}, true);
// 長按一筆＝切到選取並選它（任何畫圖工具；線在輪廓線外也可以）
function armLongPress() {
  longTimer = setTimeout(() => { if (!gesture || gesture.moved) return; const target = hitLayer(gesture.hit); if (target) { gesture.kind = 'longpress'; setTool('select'); select(target.id); toast('已選取，可拖控制點', 1200); } }, LONG_MS);
}

canvas.addEventListener('pointerdown', e => {
  pointers.set(e.pointerId, e);
  if (pointers.size > 1) { abortGesture(); return; } // 第二指落下＝交給 OrbitControls 雙指縮放轉頭
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  try { canvas.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
  const hit = pickAt(e.clientX, e.clientY);
  const xy = localXY(e);
  gesture = { id: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false, kind: null, hit };
  clearTimeout(longTimer);
  // 單指轉動：這一指交給 OrbitControls 轉頭，這裡只處理「點一下」與長按
  if (orbitDown && orbitDown.id === e.pointerId && orbitDown.orbit) { gesture.kind = 'orbit'; if (mode !== 'preview' && tool !== 'select' && !draft) armLongPress(); return; }
  // 選取工具，或線／髮片工具下有選取中的筆（畫完自動選取）：先看是不是按在把手上
  if (selectedId && (tool === 'select' || AUTO_SELECT_TOOLS.includes(tool))) {
    const l = layerById(selectedId);
    // 按在小剪刀上＝開始剪（拖過髮片的軌跡就是切口）
    if (l && l.shape === 'panel' && scissorsScreen && Math.hypot(xy.x - scissorsScreen.x, xy.y - scissorsScreen.y) <= SCISSORS_PX) {
      gesture.kind = 'cut'; gesture.layerId = l.id; gesture.trail = [xy]; placeScissors(xy, true); return;
    }
    const h = handleAt(xy.x, xy.y, tool === 'select');
    if (h && l) {
      gesture.layerId = l.id; gesture.orig = captureOrig(l); gesture.before = snapshot(); gesture.kind = 'handle'; gesture.handle = h;
      if (h.kind === 'add') { pushHistory(); const k = insertVertex(l, h.index, h.pos); gesture.handle = { kind: 'pt', index: k }; gesture.inserted = true; activeHandle = gesture.handle; rebuildLayer(l); }
      else activeHandle = h;
      syncUI(); updateHandles(); return;
    }
  }
  if (tool === 'select') {
    const target = hitLayer(hit);
    if (target) { if (target.id !== selectedId) select(target.id); gesture.kind = 'move'; gesture.layerId = target.id; gesture.orig = captureOrig(target); gesture.pushed = false; return; }
    gesture.kind = 'empty'; return;
  }
  // 其他工具：長按選取
  if (!draft) armLongPress();
  if (tool === 'freehand') { if (!hit) return; draft = { kind: 'freehand', points: [hit.point.clone()], screen: [[e.clientX, e.clientY, 0]], preview: null }; gesture.kind = 'freehand'; return; }
  if (tool === 'point') { gesture.kind = 'point'; return; }
  if (AUTO_SELECT_TOOLS.includes(tool)) {
    if (!hit) { if (selectedId) gesture.kind = 'empty'; return; } // 點到頭外面＝取消選取（和選取工具一樣）
    const sect = drawSection();
    // 放射：正在換樞軸＝這一下是放樞軸（吸得到十五點），不畫線
    if (sect && sect.kind === 'R' && pickingPivot) { radPivot = snap(hit.point.clone()); clearSnap(); pickingPivot = false; cancelDraft(); gesture.kind = 'pivot'; toast('樞軸放好了：點一下頭皮就從這裡拉一條線', 2200); syncUI(); updateHandles(); return; }
    if (draft && draft.kind === 'line' && draft.points.length === 1) { gesture.kind = 'line-end'; if (!setDraftEnd(lineEndAt(hit))) draft.points.length = 1; renderPreview(); updateHandles(); return; }
    // 第一下落在把手以外的地方＝新線的起點（不是取消選取）；先收掉選取，把手才不會跟新線的終點搶位置
    cancelDraft(); if (selectedId) select(null);
    // 放射：起點一律是樞軸，這一下（或拖著看）就是終點，放開就畫好
    if (sect && sect.kind === 'R') { draft = { kind: 'line', points: [pivotPoint()], preview: null, sect }; gesture.kind = 'line-end'; if (!setDraftEnd(lineEndAt(hit))) draft.points.length = 1; renderPreview(); updateHandles(); return; }
    const p = snap(hit.point.clone());
    draft = { kind: 'line', points: [sect ? intoOutline(p) : p], preview: null, sect }; gesture.kind = 'line-start'; updateHandles(); return;
  }
  if (tool === 'region') {
    if (!hit) return;
    if (regionMode === 'fill') { cancelDraft(); gesture.kind = 'fill'; return; } // 點一下填滿（放開才算；拖了不算）
    if (!draft || draft.kind !== 'region') { cancelDraft(); draft = { kind: 'region', points: [], preview: null }; }
    const n = draft.points.length;
    // 點回第一點＝閉合
    if (n >= 3) { const first = toScreen(draft.points[0]); if (Math.hypot(first.x - xy.x, first.y - xy.y) < HANDLE_PX) { gesture.kind = 'finish'; return; } }
    draft.points.push(snap(hit.point.clone())); gesture.kind = 'region-pt'; renderPreview(); updateDraftBar(); updateHandles();
  }
});
canvas.addEventListener('pointermove', e => {
  if (!gesture || gesture.id !== e.pointerId || pointers.size > 1) return;
  if (!gesture.moved && Math.hypot(e.clientX - gesture.x0, e.clientY - gesture.y0) > TAP_PX) { gesture.moved = true; clearTimeout(longTimer); }
  if (!gesture.moved) return;
  const hit = pickAt(e.clientX, e.clientY);
  const l = gesture.layerId ? layerById(gesture.layerId) : null;
  switch (gesture.kind) {
    case 'freehand': if (hit) { draft.points.push(hit.point.clone()); draft.screen.push([e.clientX, e.clientY, 0]); renderPreview(); } break;
    case 'line-start': case 'line-end': if (hit) { if (!setDraftEnd(lineEndAt(hit))) { draft.points.length = 1; draft.dense = null; } renderPreview(); updateHandles(); } break;
    case 'region-pt': if (hit) { draft.points[draft.points.length - 1] = snap(hit.point.clone()); renderPreview(); updateHandles(); } break;
    case 'handle': {
      if (!hit || !l) break;
      const h = gesture.handle;
      if (h.kind === 'pt') {
        const sec = sectionOf(l);
        if (sec) { // 分線：拖一端，另一端不動；水平、斜線這一端只能沿著切面滑，走到外輪廓就停
          const keep = l.points.map(P3), fixed = !!SEC.fixedNormal(sec);
          if (fixed) clearSnap();
          l.points[h.index] = P3(fixed ? hit.point : snap(hit.point.clone(), l.id));
          if (!refitSection(l, 1 - h.index)) l.points = keep;
        } else { const p = snap(hit.point.clone(), l.id); l.points[h.index] = P3(p); }
      }
      else if (h.kind === 'bend') {
        clearSnap();
        if (l.shape === 'line') { l.control = P3(controlFromHandle(toV(l.points[0]), toV(l.points[1]), hit.point)); delete l.section; } // 拉彎了就不是分線
        else { l.bends = D.normalizeBends(l.bends, D.segmentCount(l)); l.bends[h.index] = P3(hit.point); }
      }
      rebuildLayer(l); updateHandles(); break;
    }
    case 'move': if (l && !l.poly) { if (!gesture.pushed) { pushHistory(); gesture.pushed = true; } if (moveLayerBy(l, gesture.orig, e.clientX - gesture.x0, e.clientY - gesture.y0)) { rebuildLayer(l); updateHandles(); } } break;
    case 'cut': { const xy = localXY(e); gesture.trail.push(xy); cutTrail(gesture.trail); placeScissors({ ...xy, rot: trailRot(gesture.trail) }, true); break; }
    default: break;
  }
});
// 線的終點要放在哪：一般的線、垂直、放射會吸附；水平、前斜、後斜的終點只能在切面上，不吸附（吸過去的點不在那片面上）
function lineEndAt(hit) {
  if (draft && draft.sect && SEC.fixedNormal(draft.sect)) { clearSnap(); return hit.point.clone(); }
  return snap(hit.point.clone());
}
function strokeIsStraight(scr) {
  if (!scr || scr.length < 2) return false;
  const a = scr[0], b = scr[scr.length - 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return maxDeviation(streamline(scr, 0.5), [a, b]) <= Math.max(8, len * 0.08);
}
function endGesture(e) {
  pointers.delete(e.pointerId);
  if (!gesture || gesture.id !== e.pointerId) return;
  const g = gesture; gesture = null; clearTimeout(longTimer);
  const st = toolStyle(), l = g.layerId ? layerById(g.layerId) : null;
  switch (g.kind) {
    case 'freehand': {
      const pts = draft ? draft.points : [], scr = draft ? draft.screen : []; clearPreview(); draft = null;
      // 收筆時大致直的就變直線（和「兩點」畫出來的一樣），有彎的只留幾個點（平順的弧線）。
      // 「直」先看螢幕上的筆跡（離起點到終點的連線不超過線長的 8%，至少 8 px）；頭頂、側邊斜著看的地方，螢幕上畫直的線在頭皮上和最短線差很多，只比頭皮上的距離會判成彎的。
      if (pts.length >= 2) { const flat = strokeIsStraight(scr); const simp = flat ? [pts[0], pts[pts.length - 1]] : tidyStroke(pts, (a, b) => scalp.geodesic(a, b)); if (simp.length >= 2) createLayer(simp.length === 2 ? 'line' : 'freehand', simp, st); }
      break;
    }
    case 'point': if (!g.moved && g.hit) createLayer('point', [snap(g.hit.point.clone())], st); clearSnap(); break;
    case 'line-start':
      if (g.moved && draft && draft.points.length === 2) { const d = draft; cancelDraft(); finishLine(d, st); }
      else if (draft) { draft.points.length = 1; draft.dense = null; renderPreview(); updateDraftBar(); updateHandles(); }
      break;
    case 'line-end': {
      const d = draft; cancelDraft();
      if (d && d.points.length === 2) finishLine(d, st);
      else if (d && d.sect) toast('這裡畫不過去：中間會跑出頭皮，換個位置或分兩段畫', 2400); // 分線的切面走不到手指那裡
      break;
    }
    case 'region-pt': clearSnap(); updateDraftBar(); break;
    case 'fill': if (!g.moved && g.hit) fillAt(g.hit.point); break;
    case 'finish': finishDraft(); break;
    case 'handle': {
      clearSnap();
      if (!l) break;
      if (!g.moved && !g.inserted) { syncUI(); updateHandles(); break; }
      const collapsed = l.points.length > 1 && l.points.some((p, i) => l.points.some((q, j) => j > i && toV(p).distanceTo(toV(q)) < COLLAPSE));
      if (collapsed) { restoreOrig(l, g.orig); if (g.inserted) history.pop(); rebuildLayer(l); toast('兩點太近，已還原', 1500); }
      else { if (!g.inserted) { history.push(g.before); if (history.length > 60) history.shift(); future.length = 0; } syncPartner(layerById(l.id)); commit(); } // 復原點＝開始拖的那一刻
      select(l.id, activeHandle); break;
    }
    case 'move': {
      if (!l) break;
      if (g.moved && g.pushed) { syncPartner(l); commit(); } else { select(l.id, null); }
      break;
    }
    case 'empty': if (!g.moved) select(null); break;
    case 'orbit': // 單指轉動：拖了就是轉（OrbitControls 做完了）；點一下＝取消選取，或第一次提示線外不能畫
      if (g.moved || mode === 'preview') break;
      if (selectedId && !draft) select(null);
      else if (g.hit && TOOLS[tool].shape && !outsideHinted) { outsideHinted = true; toast('輪廓線外面單指是轉頭；要畫請從輪廓線裡面開始', 2600); }
      break;
    case 'cut': {
      cutTrail(null);
      if (!l) break;
      if (!g.moved) { toast('按住小剪刀、橫向拖過髮片就是切口（剪刀只會剪短；復原可退）', 3000); break; }
      pushHistory();
      if (applyCut(l, g.trail)) { rebuildLayer(l); syncPartner(l); commit(); toast(l.lift.cut ? '切口剪好了：橘色實線＝剪線；「更多」裡可以還原' : '剪在髮尾外面，切口還原成沒剪', 2400); }
      else { history.pop(); toast('剪刀沒碰到髮束：從髮尾線外面橫向拖過髮片', 2400); }
      select(l.id, null); break;
    }
    default: break;
  }
  updateHandles();
}
// 第二指落下、視窗失焦：這一指做到一半的事全部收回（避免雙指轉頭時留下半條線或多一個點）
function abortGesture() {
  clearTimeout(longTimer);
  if (gesture) {
    const g = gesture; gesture = null;
    const l = g.layerId ? layerById(g.layerId) : null;
    if ((g.kind === 'handle' || g.kind === 'move') && l && g.orig) { restoreOrig(l, g.orig); if (g.inserted || g.pushed) history.pop(); rebuildLayer(l); }
    if (g.kind === 'freehand') { clearPreview(); draft = null; }
    if (g.kind === 'line-start') cancelDraft();
    if (g.kind === 'cut') cutTrail(null);
    if (g.kind === 'line-end' && draft) { if (draft.sect && draft.sect.kind === 'R') cancelDraft(); else { draft.points.length = 1; draft.dense = null; renderPreview(); updateDraftBar(); } } // 放射的起點是樞軸，不留半條
    if (g.kind === 'region-pt' && draft) { draft.points.pop(); if (!draft.points.length) cancelDraft(); else { renderPreview(); updateDraftBar(); } }
  }
  clearSnap(); updateHandles(); requestRender();
}
// 線、髮片工具畫完立刻選取那一筆，中間的彎度把手直接出現；拖完維持選取，點空白（頭外面）或「完成」才取消
let autoSelectHinted = false;
function autoSelect(layer) {
  if (!layer) return;
  // 「髮片」工具：畫完的線直接拉成髮片（和畫線同一步，復原一次就退掉）
  if (tool === 'panel') {
    if (fallen) setFallen(false); // 新髮片要看得到提拉
    try { D.convertToLift(layer, 'panel', null); rebuildLayer(layer); syncPartner(layer); commit(); }
    catch (e) { toast('變不成髮片：' + e.message); }
    select(layer.id);
    if (!panelHinted) { panelHinted = true; toast('髮片：下面選提拉；藍色剪刀可以剪切口', 2600); }
    return;
  }
  select(layer.id);
  if (!autoSelectHinted) { autoSelectHinted = true; toast('拖中間的小方塊可以調彎度；點頭外面取消選取', 2600); }
}
let panelHinted = false;
canvas.addEventListener('pointerup', endGesture); canvas.addEventListener('pointercancel', endGesture);
window.addEventListener('blur', () => { pointers.clear(); abortGesture(); });

// ---------------------------------------------------------------- 把手（HTML 疊在畫布上）
const handlePool = [];
// 池裡的元素會輪流當圓點和點位名稱：不是名稱時一定把字清掉
function handleEl(i, cls) { let el = handlePool[i]; if (!el) { el = document.createElement('div'); handlesEl.append(el); handlePool[i] = el; } el.className = 'h ' + cls; el.hidden = false; if (cls !== 'lbl' && el.firstChild) el.textContent = ''; return el; }
function place(el, v) { const s = toScreen(v); el.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translate(-50%, -50%)`; }
function placeLabel(el, v) { const s = toScreen(v); el.style.transform = `translate(${(s.x + 5).toFixed(1)}px, ${(s.y - 5).toFixed(1)}px) translate(0, -100%)`; }
function updateHandles() {
  if (!scalp) return;
  let i = 0;
  const l = selectedId ? layerById(selectedId) : null;
  if (l) {
    if (tool === 'select') for (const a of addHandles(l)) { if (isOccluded(a.pos)) continue; place(handleEl(i++, 'add'), a.pos); } // 加點的小淡點只在選取工具下
    bendHandles(l).forEach((m, k) => { if (isOccluded(m)) return; place(handleEl(i++, 'bend' + (activeHandle && activeHandle.kind === 'bend' && activeHandle.index === k ? ' active' : '')), m); });
    if (!l.poly) l.points.forEach((p, k) => { const v = toV(p); if (isOccluded(v)) return; place(handleEl(i++, 'pt' + (activeHandle && activeHandle.kind === 'pt' && activeHandle.index === k ? ' active' : '')), v); });
  }
  // 小剪刀把手：選到髮片時放在髮尾線看得到的那一端外面；剪的時候跟著手指走（placeScissors），這裡不重算
  if (!(gesture && gesture.kind === 'cut')) {
    scissorsScreen = l && l.shape === 'panel' && !fallen && (tool === 'select' || AUTO_SELECT_TOOLS.includes(tool)) ? scissorsAnchor(l) : null; // 放下時不能用小剪刀（切口是照拉起的樣子剪的）
    if (scissorsScreen) placeScissors(scissorsScreen); else scissorsEl.hidden = true;
  }
  // 手畫線畫的時候只看線，不顯示取樣點
  if (draft && draft.kind !== 'freehand') draft.points.forEach((p, k) => { if (isOccluded(p)) return; place(handleEl(i++, (draft.kind === 'line' && k === 0 && draft.points.length === 1) ? 'start' : 'draft'), p); });
  if (snapPos && !isOccluded(snapPos)) place(handleEl(i++, 'snap'), snapPos);
  // 放射：樞軸在哪（只在畫圖的「線 → 放射」、沒選東西的時候顯示）
  if (!l && mode === 'draw' && tool === 'line' && lineShape === 'r') { const pv = pivotPoint(); if (!isOccluded(pv)) place(handleEl(i++, pickingPivot ? 'pivot picking' : 'pivot'), pv); }
  // 點位名稱（眼睛選單）：十五點的英文縮寫，放在點的右上角；只是畫面上的字，不進 PNG。結構線關著時點上補一個小圓點。
  if (doc.settings.labels) for (const lm of landmarks) {
    if (isOccluded(lm.point)) continue;
    if (!doc.settings.structure) place(handleEl(i++, 'lbldot'), lm.point);
    const el = handleEl(i++, 'lbl'); el.textContent = lm.id; placeLabel(el, lm.point);
  }
  for (; i < handlePool.length; i++) handlePool[i].hidden = true;
}

// ---------------------------------------------------------------- 選取列的動作
function flipSelected() { const l = layerById(selectedId); if (!l || ['point', 'region', 'strand', 'fan'].includes(l.shape)) return; pushHistory(); l.points.reverse(); if (l.bends) l.bends.reverse(); if (l.section && l.section.kind === 'R') l.section.pivot = l.section.pivot === 1 ? 0 : 1; rebuildLayer(l); syncPartner(l); commit(); select(l.id); }

// ---------------------------------------------------------------- 髮片／提拉線／角度扇形
const LIFTABLE_FROM = ['line', 'curve', 'freehand'];
let liftMore = false, liftLive = false; // 「更多」展開？滑桿拖到一半（只推一次歷史）？
const fmtLen = cm => (Number.isInteger(cm) ? cm : cm.toFixed(1)) + ' cm';
// 把選取中的線變成髮片（根線＝這條線）、把點變成提拉線或扇形；就地改同一筆，復原可退回
function toLiftShape(shape) {
  const l = layerById(selectedId); if (!l) return;
  if (shape === 'panel' && !LIFTABLE_FROM.includes(l.shape)) return;
  if (shape !== 'panel' && l.shape !== 'point') return;
  if (fallen) setFallen(false); // 新髮片要看得到提拉
  pushHistory();
  const bend = l.shape === 'line' && l.control ? P3(scalp.nearest(handleFromControl(toV(l.points[0]), toV(l.control), toV(l.points[1]))).point) : null;
  // 分線拉成髮片，根線要照著切面走——髮片的根線是「通過每個點的曲線」，所以沿著切面每 1.5 cm 留一個點（只留兩端會變成最短線）
  const secDense = shape === 'panel' && sectionOf(l) && objects.get(l.id) ? objects.get(l.id).dense : null;
  if (secDense && secDense.length >= 2) l.points = SEC.sectionControlPoints(scalp, secDense).map(P3);
  try { D.convertToLift(l, shape, bend); rebuildLayer(l); } catch (e) { history.pop(); toast('變不成' + D.SHAPE_LABELS[shape] + '：' + e.message); return; }
  syncPartner(l); commit(); select(l.id);
  toast(shape === 'panel' ? '線變成髮片了：下面調角度與髮長，藍色剪刀可以剪切口' : '點變成' + D.SHAPE_LABELS[shape] + '了：下面調整', 2600);
}
// 改髮片參數。live＝滑桿拖動中（第一下推歷史、之後不推、不存檔；放開時 commitLift）
function setLift(partial, live = false) {
  const l = layerById(selectedId); if (!l || !l.lift) return;
  if (fallen && ['elevation', 'swivel', 'reference', 'fixed'].some(k => k in partial)) { setFallen(false); toast('先拉起來，才看得到提拉的角度', 1800); } // 放下時角度看不出來
  if (!live || !liftLive) pushHistory();
  if (live) liftLive = true;
  // 自己改了角度、髮長或切口＝不再跟前一片（先把前一片的值接過來）
  let base = l.lift;
  const has = ks => ks.some(k => k in partial);
  if (base.follow && has(['elevation', 'swivel', 'reference', 'fixed', 'length_cm', 'cut'])) base = { ...effLift(l), follow: false };
  // 按了垂落／45°／頭皮 90°、拉角度滑桿或換基準＝不再是固定方向
  if (base.fixed && !('fixed' in partial) && has(['elevation', 'reference'])) base = { ...base, fixed: null };
  l.lift = normalizeLift({ ...base, ...partial });
  D.normalizeStyle(l);
  rebuildLayer(l); syncPartner(l);
  if (!live) commit();
  syncUI(); requestRender();
}
function commitLift() { if (!liftLive) return; liftLive = false; commit(); }
function syncLiftCard(l) {
  const card = $('#liftcard'), lf = l.shape === 'panel' ? effLift(l) : l.lift;
  card.querySelectorAll('[data-for]').forEach(r => { r.hidden = !r.dataset.for.split(' ').includes(l.shape); });
  // 固定方向：選了才出現「方向」那一列；角度滑桿與基準收起來（固定方向時不起作用）
  const fixedOn = !!lf.fixed;
  $('#lift-fixed-row').hidden = !fixedOn || !['panel', 'strand'].includes(l.shape);
  if (fixedOn) card.querySelectorAll('[data-elev]').forEach(r => { r.hidden = true; });
  card.querySelectorAll('[data-fixed]').forEach(b => b.classList.toggle('on', b.dataset.fixed === lf.fixed));
  // 導線：自己設定／跟前一片
  card.querySelectorAll('[data-guide]').forEach(b => b.classList.toggle('on', b.dataset.guide === (l.lift.follow ? 'follow' : 'own')));
  $('#lift-elev').value = lf.elevation; $('#lift-elev-v').textContent = lf.elevation + '°';
  $('#lift-len-v').textContent = fmtLen(lf.length_cm);
  // 基準兩選一：髮片是「髮片中心」，一個毛根的提拉線／扇形同一鈕叫「頭皮」
  card.querySelectorAll('[data-ref]').forEach(b => { b.classList.toggle('on', b.dataset.ref === lf.reference); if (b.dataset.ref === 'CENTER') b.textContent = l.shape === 'panel' ? '髮片中心' : '頭皮'; });
  // 轉向＝髮尾線沿根線方向橫移（正值朝臉前），任何提拉角度都有作用；扇形沒有這一列（data-for）
  $('#lift-swivel').value = lf.swivel; $('#lift-swivel-v').textContent = (lf.swivel > 0 ? '+' : '') + lf.swivel + '°';
  card.querySelectorAll('[data-style]').forEach(b => b.classList.toggle('on', b.dataset.style === lf.style));
  $('#lift-n-v').textContent = lf.strands;
  $('#lift-cut-row').hidden = !(l.shape === 'panel' && lf.cut); // 剪過才有「還原」
  card.querySelectorAll('[data-preset]').forEach(b => { const p = LIFT_PRESETS[b.dataset.preset]; b.classList.toggle('on', b.dataset.preset === 'fixed' ? !!lf.fixed : (!lf.fixed && p.reference === lf.reference && p.elevation === lf.elevation)); });
}
// 提拉的常用值：垂落＝從垂直向下 0°；45°＝從自然垂落往外 45°；頭皮 90°＝垂直局部頭皮；
// 固定方向＝整片朝同一個方向拉（朝上／正後／正側／正前），按了才出現方向那一列，預設朝上
const LIFT_PRESETS = { fall: { reference: 'WORLD', elevation: 0, fixed: null }, low: { reference: 'WORLD', elevation: 45, fixed: null }, scalp: { reference: 'CENTER', elevation: 90, fixed: null }, fixed: {} };
let lastFixed = 'UP', fixedHinted = false;
function setFixedDir(kind) {
  const l = layerById(selectedId); if (!l || !l.lift || !FIXED_DIRS.includes(kind)) return;
  if ((l.shape === 'panel' ? effLift(l) : l.lift).fixed === kind && !l.lift.follow) return;
  lastFixed = kind; setLift({ fixed: kind });
  if (!fixedHinted) { fixedHinted = true; toast('固定方向：整片頭髮都朝同一個方向拉，不跟頭皮的弧度走（方形層次）', 3200); }
}
// 按住 −／＋ 連發：先一下，400 ms 後每 90 ms 一下
function holdRepeat(btn, fn) {
  let t1 = 0, t2 = 0;
  const stop = () => { clearTimeout(t1); clearInterval(t2); t1 = t2 = 0; };
  btn.addEventListener('pointerdown', e => { e.preventDefault(); fn(); stop(); t1 = setTimeout(() => { t2 = setInterval(fn, 90); }, 400); });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) btn.addEventListener(ev, stop);
}
const lenStep = cm => (cm < 3 ? 0.5 : 1);
$('#sel-panel').addEventListener('click', () => toLiftShape('panel'));
$('#sel-strand').addEventListener('click', () => toLiftShape('strand'));
$('#sel-fan').addEventListener('click', () => toLiftShape('fan'));
$('#sel-more').addEventListener('click', () => { liftMore = !liftMore; syncUI(); });
$('#lift-elev').addEventListener('input', e => setLift({ elevation: +e.target.value }, true));
$('#lift-elev').addEventListener('change', commitLift);
$('#lift-swivel').addEventListener('input', e => setLift({ swivel: +e.target.value }, true));
$('#lift-swivel').addEventListener('change', commitLift);
holdRepeat($('#lift-len-dec'), () => { const l = layerById(selectedId); if (l && l.lift) setLift({ length_cm: Math.round((l.lift.length_cm - lenStep(l.lift.length_cm - 0.01)) * 2) / 2 }); });
holdRepeat($('#lift-len-inc'), () => { const l = layerById(selectedId); if (l && l.lift) setLift({ length_cm: Math.round((l.lift.length_cm + lenStep(l.lift.length_cm)) * 2) / 2 }); });
holdRepeat($('#lift-n-dec'), () => { const l = layerById(selectedId); if (l && l.lift) setLift({ strands: l.lift.strands - 1 }); });
holdRepeat($('#lift-n-inc'), () => { const l = layerById(selectedId); if (l && l.lift) setLift({ strands: l.lift.strands + 1 }); });
document.querySelectorAll('#lift-ref [data-ref]').forEach(b => b.addEventListener('click', () => setLift({ reference: b.dataset.ref })));
document.querySelectorAll('#lift-preset [data-preset]').forEach(b => b.addEventListener('click', () => (b.dataset.preset === 'fixed' ? setFixedDir(lastFixed) : setLift({ ...LIFT_PRESETS[b.dataset.preset] }))));
document.querySelectorAll('#lift-fixed [data-fixed]').forEach(b => b.addEventListener('click', () => setFixedDir(b.dataset.fixed)));
document.querySelectorAll('#lift-guide [data-guide]').forEach(b => b.addEventListener('click', () => setGuide(b.dataset.guide)));
document.querySelectorAll('#lift-style [data-style]').forEach(b => b.addEventListener('click', () => setLift({ style: b.dataset.style })));
$('#lift-cut-reset').addEventListener('click', () => { const l = layerById(selectedId); if (l && l.lift && l.lift.cut) { setLift({ cut: null }); toast('切口還原了，髮尾回到虛線', 1600); } });

// ---------------------------------------------------------------- 小剪刀
// 選取髮片時，髮尾線的一端外面有一把藍色小剪刀；按住它橫向拖過髮片，拖過的軌跡就是切口。
// 把「沒剪」的髮束（沿根線 25 個樣本）投到畫面上，軌跡和每根相交的點在那根上的弧長比例＝那根留下的比例；沒被剪到的髮束比例不變。
// 輔助修正（不過頭）：相鄰三根 1-2-1 平均一次；全部差不到 3% 就拉成等長；接近一直線（殘差 < 2%）就拉成直線；最後減點（容差 1.5%）存成 lift.cut=[[u, r], …]。
// 剪刀只會剪短（r ≤ 1）；剪過的髮尾線變橘色實線；復原可退、設定的「更多」裡有「還原」；鏡像配對照 u 比例同步。
const CUT_SAMPLES = 25, SCISSORS_GAP = 28, SCISSORS_PX = 26;
const scissorsEl = document.createElement('div'); scissorsEl.className = 'h scissors'; scissorsEl.innerHTML = '<svg><use href="#i-scissors"/></svg>'; scissorsEl.hidden = true; handlesEl.append(scissorsEl);
const cutPath = $('#cutpath');
let scissorsScreen = null; // 剪刀把手目前在畫布上的位置與刀尖方向（null＝沒顯示）
function scissorsAnchor(l) {
  const o = objects.get(l.id); if (!o || !o.tipLine || o.tipLine.length < 2) return null;
  const line = o.tipLine, ends = [[line[0], line[1]], [line[line.length - 1], line[line.length - 2]]];
  for (const [p, q] of ends) {
    if (isOccluded(p)) continue;
    const a = toScreen(p), b = toScreen(q), d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const x = a.x + (a.x - b.x) / d * SCISSORS_GAP, y = a.y + (a.y - b.y) / d * SCISSORS_GAP;
    if (x < 4 || y < 4 || x > canvas.clientWidth - 4 || y > canvas.clientHeight - 4) continue; // 跑到畫面外就換另一端
    return { x, y, rot: Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI }; // 刀尖朝髮尾線（往髮片裡面剪）
  }
  return null;
}
function placeScissors(xy, live = false) {
  scissorsEl.hidden = false; scissorsEl.classList.toggle('live', live);
  if (xy.rot !== undefined) scissorsEl.style.setProperty('--rot', xy.rot.toFixed(1) + 'deg');
  scissorsEl.style.transform = `translate(${xy.x.toFixed(1)}px, ${xy.y.toFixed(1)}px) translate(-50%, -50%)`;
}
// 剪的時候刀尖跟著拖的方向（取最近 12 px 的位移，太短不轉）
function trailRot(trail) {
  const e = trail[trail.length - 1];
  for (let i = trail.length - 2; i >= 0; i--) { const dx = e.x - trail[i].x, dy = e.y - trail[i].y; if (Math.hypot(dx, dy) >= 12) return Math.atan2(dy, dx) * 180 / Math.PI; }
  return undefined;
}
function cutTrail(pts) { if (!pts || pts.length < 2) { cutPath.removeAttribute('d'); return; } cutPath.setAttribute('d', pts.map((p, i) => (i ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join('')); }
function segHit(a, b, c, d) { // 畫面上兩條線段 ab 與 cd 的交點：回傳在 ab 上的比例 t（0～1），不相交回 null
  const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y, den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const qx = c.x - a.x, qy = c.y - a.y, t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}
function applyCut(l, trail) {
  const o = objects.get(l.id); if (!o || trail.length < 2) return false;
  const base = effLift(l); // 跟前一片的髮片照實際看到的樣子剪，剪完就是它自己的設定
  const K = CUT_SAMPLES, prev = base.cut, ratios = new Array(K).fill(null);
  const g = panelGeometry(scalp, o.dense, { ...base, strands: K }, { ignoreCut: true });
  for (let k = 0; k < K; k++) {
    const path = g.paths[k], scr = path.map(p => toScreen(p)), acc = [0];
    for (let i = 1; i < path.length; i++) acc.push(acc[i - 1] + path[i].distanceTo(path[i - 1]));
    const total = acc[acc.length - 1]; if (total < 1e-9) continue;
    outer: for (let i = 0; i + 1 < scr.length; i++) for (let j = 0; j + 1 < trail.length; j++) { const t = segHit(scr[i], scr[i + 1], trail[j], trail[j + 1]); if (t !== null) { ratios[k] = (acc[i] + t * (acc[i + 1] - acc[i])) / total; break outer; } }
  }
  if (!ratios.some(r => r !== null)) return false;
  for (let k = 0; k < K; k++) if (ratios[k] === null) ratios[k] = cutRatio(prev, k / (K - 1));
  let r = ratios.map((v, k) => (k === 0 || k === K - 1 ? v : (ratios[k - 1] + 2 * v + ratios[k + 1]) / 4));
  const lo = Math.min(...r), hi = Math.max(...r);
  if (hi - lo < 0.03) r = r.map(() => (lo + hi) / 2);
  else {
    const xs = r.map((_, k) => k / (K - 1)), my = r.reduce((a, b) => a + b, 0) / K;
    let sxy = 0, sxx = 0; for (let k = 0; k < K; k++) { sxy += (xs[k] - 0.5) * (r[k] - my); sxx += (xs[k] - 0.5) ** 2; }
    const slope = sxy / sxx, b0 = my - slope * 0.5;
    if (Math.max(...r.map((v, k) => Math.abs(v - (b0 + slope * xs[k])))) < 0.02) r = xs.map(x => b0 + slope * x);
  }
  r = r.map(v => Math.min(1, Math.max(CUT_MIN, v)));
  const cut = normalizeCut(rdp(r.map((v, k) => new THREE.Vector3(k / (K - 1), v, 0)), 0.015).map(p => [p.x, p.y]));
  l.lift = normalizeLift({ ...base, cut: cut || null, follow: false });
  return true;
}
// ---------------------------------------------------------------- 導線、放下／拉起
const effLift = l => effectiveLift(l, doc.layers); // 髮片實際用的設定（跟前一片＝前一片的）
// 導線二選一：自己設定＝照這一片自己的提拉角度與髮長；跟前一片＝角度、髮長、切口都照這一步排在它前面的那一片
function setGuide(kind) {
  const l = layerById(selectedId); if (!l || l.shape !== 'panel') return;
  if (kind === 'follow') {
    if (l.lift.follow) return;
    if (!previousPanel(doc.layers, l)) { toast('這一步前面沒有別的髮片：先畫前一片，後面畫的才能「跟前一片」', 3200); return; }
    pushHistory();
    l.lift = normalizeLift({ ...l.lift, follow: true });
    D.normalizeStyle(l); rebuildLayer(l); syncPartner(l); commit(); syncUI();
    toast('跟前一片：角度、髮長、切口都照前一片；前一片改了它也跟著改', 3200);
    return;
  }
  if (!l.lift.follow) return;
  pushHistory();
  l.lift = normalizeLift({ ...effLift(l), follow: false }); // 現在看到的角度、髮長、切口留著，變成它自己的設定
  D.normalizeStyle(l); rebuildLayer(l); syncPartner(l); commit(); syncUI();
  toast('改回自己設定：角度和髮長照現在的樣子，之後自己調', 2400);
}

// 放下／拉起：全部重建（這一步的筆和淡色的前面步驟一起）。放下後髮尾跑到畫面外面就自動拉遠；拉起時鏡頭沒再動過就拉回放下前的大小。
let fallZoom = null, fallHinted = false;
const hasHair = () => [...doc.layers, ...ghostLayers].some(l => l.shape === 'panel' || l.shape === 'strand');
function fallTips() { const out = ghostTips.slice(); for (const o of objects.values()) if (o.fallTips) out.push(...o.fallTips); return out; }
function setFallen(on) {
  on = !!on; if (on === fallen) { syncFallBtn(); return; }
  cancelDraft(); fallen = on;
  if (mode === 'draw') { if (on) curStep().fall = true; else delete curStep().fall; saveLib(); } // 畫圖時按的才記在這一步；預覽時按的不記
  for (const id of [...objects.keys()]) removeObject(id);
  rebuild(); buildGhosts(); syncUI(); updateHandles();
  if (on) { const z = camera.zoom; ensureVisible(fallTips(), 0.92); fallZoom = camera.zoom !== z ? { from: z, to: camera.zoom } : null; }
  else if (fallZoom) { if (Math.abs(camera.zoom - fallZoom.to) < 1e-6) { camera.zoom = fallZoom.from; camera.updateProjectionMatrix(); controls.update(); requestRender(); } fallZoom = null; }
}
function syncFallBtn() {
  const b = $('#fall-btn');
  b.hidden = !hasHair(); // 這一步（含淡色的前面步驟）有髮片或提拉線才出現
  b.setAttribute('aria-pressed', String(fallen));
  $('#fall-text').textContent = fallen ? '拉起' : '放下';
  b.querySelector('use').setAttribute('href', fallen ? '#i-liftup' : '#i-fall');
}
$('#fall-btn').addEventListener('click', () => {
  setFallen(!fallen);
  if (fallen && !fallHinted) { fallHinted = true; toast('放下：每根頭髮照自己的長度自然垂下來；再按一次拉起', 2800); }
});

// 彎直：直線沒彎→給一個彎度（彎度點往旁邊推 15% 線長）；直線有彎→拉直；曲線／手畫線→變直線（留兩端）
function bendSelected() {
  const l = layerById(selectedId); if (!l || !['line', 'curve', 'freehand'].includes(l.shape)) return;
  pushHistory();
  if (l.shape === 'line') {
    if (l.control) l.control = null;
    else {
      const o = objects.get(l.id), S = toV(l.points[0]), E = toV(l.points[1]);
      const m = scalp.nearest(pointAtFraction(o.dense, 0.5));
      const side = new THREE.Vector3().crossVectors(E.clone().sub(S), m.normal).normalize();
      const M = scalp.nearest(m.point.clone().addScaledVector(side, S.distanceTo(E) * 0.15)).point;
      l.control = P3(controlFromHandle(S, E, M)); delete l.section; // 拉彎了就不是分線
    }
  } else { l.points = [l.points[0], l.points[l.points.length - 1]]; l.shape = 'line'; l.control = null; delete l.bends; }
  D.normalizeStyle(l); rebuildLayer(l); syncPartner(l); commit(); select(l.id);
}
function deletePoint() {
  const l = layerById(selectedId); if (!l || !activeHandle || activeHandle.kind !== 'pt' || l.points.length <= D.minPoints(l.shape)) return;
  pushHistory(); removeVertex(l, activeHandle.index); rebuildLayer(l); syncPartner(l); commit(); select(l.id, null);
}

// ---------------------------------------------------------------- 匯出、匯入
function stamp() { const d = new Date(), p = n => String(n).padStart(2, '0'); return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()); }
// 檔案網址留 60 秒才收回：iPhone、iPad 的 Safari 會先問「要下載嗎」，使用者還沒按就收回的話，下載卡住、網址列的進度條一直停著
function downloadBlob(blob, name) { const a = document.createElement('a'); const url = URL.createObjectURL(blob); a.href = url; a.download = name; a.rel = 'noopener'; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
async function shareBlob(blob, name, title) {
  const file = new File([blob], name, { type: blob.type });
  if (!navigator.share || !(navigator.canShare && navigator.canShare({ files: [file] }))) { toast('這個瀏覽器不支援分享檔案，改用下載'); downloadBlob(blob, name); return; }
  try { await navigator.share({ files: [file], title }); } catch (e) { if (e && e.name !== 'AbortError') toast('分享失敗：' + e.message); }
}
// matchScreen＝照畫面的長寬比（看到什麼存什麼，預覽的「儲存照片」用）；不給＝正方形
async function pngBlob(size = 2000, matchScreen = false) {
  const w = stage.clientWidth, h = stage.clientHeight;
  const W = matchScreen ? Math.round(size * w / Math.max(w, h)) : size, Hh = matchScreen ? Math.round(size * h / Math.max(w, h)) : size;
  const scale = matchScreen ? W / w : size / Math.min(w, h);
  const sel = selectedId ? layerById(selectedId) : null; if (sel) { removeObject(sel.id); buildLayer(sel, false); } // 匯出不帶選取色
  const prev = draft && draft.preview; if (prev) prev.visible = false;
  renderer.setPixelRatio(1); renderer.setSize(W, Hh, false); updateCamera(W / Hh);
  scene.traverse(x => { if (x.isLine2) { x.userData.lw = x.material.linewidth; x.material.linewidth = x.material.linewidth / dpr * scale; } });
  renderer.render(scene, camera);
  const blob = await new Promise(res => renderer.domElement.toBlob(res, 'image/png'));
  scene.traverse(x => { if (x.isLine2 && x.userData.lw !== undefined) { x.material.linewidth = x.userData.lw; delete x.userData.lw; } });
  if (prev) prev.visible = true;
  if (sel) rebuildLayer(sel);
  renderer.setPixelRatio(dpr); renderer.setSize(w, h, false); updateCamera(w / h); renderer.render(scene, camera);
  return blob;
}
// 匯入：一張頭圖或整個頭圖庫，都加進「我的頭圖」，不蓋掉已經有的
async function importFile(file) {
  try {
    const { added, media } = L.importInto(lib, await file.text());
    for (const [id, url] of Object.entries(media)) await flat.media.putDataUrl(id, url).catch(e => console.warn('照片存不下來', id, e));
    saveLib(); renderHome();
    toast('匯入完成：' + added.map(d => d.title).join('、'), 3000);
  } catch (e) { toast('匯入失敗：' + e.message, 4000); }
}
// 眼睛選單、視角選單的開關照設定顯示
function applySettings() {
  const s = lib.settings;
  setOutlineVisible(s.outline); setStructureVisible(s.structure);
  $('#tgl-labels').setAttribute('aria-pressed', String(s.labels));
  $('#tgl-ghost').setAttribute('aria-pressed', String(s.ghost));
  $('#tgl-snap').setAttribute('aria-pressed', String(s.snap));
  $('#tgl-topdown').setAttribute('aria-pressed', String(s.topFaceDown));
  document.querySelectorAll('[data-ostyle]').forEach(b => b.classList.toggle('on', b.dataset.ostyle === outlineStyle));
  syncUI();
}

// ---------------------------------------------------------------- 頭圖、步驟
// 打開一個步驟：這一步的筆讀進來、前面步驟變淡、照這一步記住的視角
function openStep(i, { keepView = false } = {}) {
  cancelDraft(); closePops();
  selectedId = null; activeHandle = null;
  stepIndex = Math.max(0, Math.min(drawing.steps.length - 1, i | 0));
  lib.current = { drawingId: drawing.id, stepId: curStep().id, mode };
  if (L.is2d(drawing)) { flat.openStep(stepIndex); saveLib(); renderChrome(); return; }
  history.length = 0; future.length = 0; // 復原只在同一步裡
  fallen = !!curStep().fall; fallZoom = null; // 這一步記住的「放下」
  for (const id of [...objects.keys()]) removeObject(id);
  try { doc = { layers: L.stepLayers(curStep()), settings: lib.settings }; }
  catch (e) { toast('這一步的圖讀不進來：' + e.message, 4000); doc = { layers: [], settings: lib.settings }; }
  rebuild(); buildGhosts();
  if (!keepView) { applyStepView(); if (fallen) ensureVisible(fallTips(), 0.92); }
  saveLib(); updateButtons(); renderChrome();
}
// 打開一張頭圖：i＝第幾步（null＝上次停的那一步）；nextMode 沒給就照現在的畫面（預覽中還是預覽，其他進畫圖）
// 先換上這張頭圖用的頭模（沒載入過要下載，所以是非同步的）
async function openDrawing(id, i = null, nextMode = null) {
  const d = L.drawingById(lib, id); if (!d) return;
  const want = H.headOf(headList, d);
  if (d.head !== want) { d.head = want; saveLib(); } // 記的那顆不在清單裡：改用預設那顆
  try { await useHead(want); } catch (e) { toast('頭模載入失敗：' + e.message, 4000); return; }
  if (drawing && L.is2d(drawing) && drawing !== d) flat.close();
  drawing = d;
  document.body.dataset.kind = d.kind;
  let at = i;
  if (at === null) { const last = lib.current && lib.current.drawingId === id ? d.steps.findIndex(s => s.id === lib.current.stepId) : -1; at = last >= 0 ? last : 0; }
  if (L.is2d(d)) await flat.open(d, currentHead(), lib.current && lib.current.drawingId === id ? lib.current.view : null);
  else setStructureVisible(!!lib.settings.structure); // 2D 那邊可能改過結構線開關（兩邊共用）
  setMode(nextMode || (mode === 'preview' ? 'preview' : 'draw'), false);
  openStep(at);
  if (!L.is2d(d)) resize();
}
// 這張頭圖換一顆頭模：已經畫的圖跟著搬到新頭上相對的位置（transfer.js；2D 在 flat/editor.js 裡搬）
async function switchHead(id) {
  if (!drawing || id === drawing.head) return;
  if (!transferCtx) { toast('換頭模的對照資料讀不到，不能換'); return; }
  if (!L.is2d(drawing)) save();
  const from = drawing.head;
  let h;
  try { h = await useHead(id); } catch (e) { toast('頭模載入失敗：' + e.message, 4000); return; }
  let n = 0;
  try {
    if (L.is2d(drawing)) n = await flat.switchHead(h, from, transferCtx);
    else n = TR.convertDrawing(drawing, id, transferCtx, projectOnScalp);
  } catch (e) { toast('圖搬不過去：' + e.message, 4000); await useHead(from); return; }
  drawing.head = id; L.touch(drawing); saveLib();
  openStep(stepIndex, { keepView: true });
  toast('換成' + H.headLabel(h.model) + (n ? '，' + n + ' 筆圖跟著搬過去了' : ''), 3000);
}
// 換畫面：home＝我的頭圖、draw＝畫圖、preview＝預覽（工具收起來，只剩頭模和換步驟）
function setMode(m, reopen = true) {
  mode = m;
  document.body.dataset.mode = m;
  closePops(); cancelDraft();
  if (m !== 'draw' && selectedId) select(null);
  const flatOn = m !== 'home' && !!drawing && L.is2d(drawing);
  $('#home').hidden = m !== 'home';
  $('#topbar').hidden = m !== 'draw';
  $('#previewbar').hidden = m !== 'preview';
  $('#stage').hidden = flatOn;
  $('#flat').hidden = !flatOn;
  $('#recenter').hidden = m !== 'preview';
  $('#view-btn').hidden = m !== 'draw';
  if (lib.current) { lib.current.mode = m; saveLib(); }
  if (m === 'home') { if (drawing && L.is2d(drawing)) flat.close(); renderHome(); }
  else { renderChrome(); if (flatOn) flat.setMode(m); else if (reopen) resize(); }
  if (!flatOn && m === 'draw' && curStep() && fallen !== !!curStep().fall) setFallen(!!curStep().fall); // 預覽時按過放下／拉起：回畫圖照這一步記住的
  updateButtons(); updateHandles(); requestRender();
}
// 頂欄、步驟條、預覽的換步列：跟著「這一步」換
function renderChrome() {
  if (!drawing) return; // 這張頭圖剛被刪掉
  $('#step-title-text').textContent = L.stepLabel(stepIndex) + '　' + L.stepName(drawing, stepIndex);
  $('#drawing-title-text').textContent = drawing.title;
  $('#preview-drawing').textContent = drawing.title;
  $('#preview-count').textContent = (stepIndex + 1) + '／' + drawing.steps.length;
  renderStrip(); renderPreviewNav();
}
function renderStrip() {
  const strip = $('#strip');
  strip.innerHTML = drawing.steps.map((s, i) => `<button type="button" role="tab" data-step="${i}" class="${i === stepIndex ? 'on' : ''}${L.stepItems(s).length ? ' has' : ''}" aria-selected="${i === stepIndex}" aria-label="${esc(L.stepLabel(i) + ' ' + L.stepName(drawing, i))}">${L.stepLabel(i)}</button>`).join('')
    + '<button type="button" class="add" aria-label="在這一步後面加一步"><svg><use href="#i-plus"/></svg></button>';
  const on = strip.querySelector('.on'); if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// 預覽下方的換步列：上一步、圓點（步驟多於 14 個就寫「i／n」）、下一步，圓點上面寫這一步的名字。只有一步時整條藏起來
function renderPreviewNav() {
  const n = drawing.steps.length;
  $('#previewnav').hidden = mode !== 'preview' || n <= 1;
  $('#preview-step').textContent = L.stepLabel(stepIndex) + '　' + L.stepName(drawing, stepIndex);
  $('#dots').innerHTML = n <= 14 ? drawing.steps.map((_, i) => `<i class="${i === stepIndex ? 'on' : ''}"></i>`).join('') : `<span>${stepIndex + 1}／${n}</span>`;
  $('#prev').disabled = stepIndex <= 0; $('#next').disabled = stepIndex >= n - 1;
}
function goStep(d) { const j = stepIndex + d; if (j < 0 || j >= drawing.steps.length) return; openStep(j); }
// 在換步列上左右滑＝換步驟
{
  let sx = 0, sy = 0, sid = null;
  const nav = $('#previewnav');
  nav.addEventListener('pointerdown', e => { sid = e.pointerId; sx = e.clientX; sy = e.clientY; });
  nav.addEventListener('pointerup', e => { if (e.pointerId !== sid) return; sid = null; const dx = e.clientX - sx, dy = e.clientY - sy; if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.5) goStep(dx < 0 ? 1 : -1); });
  nav.addEventListener('pointercancel', () => { sid = null; });
}

// ---------------------------------------------------------------- 首頁：我的頭圖（全部、收藏、資料夾、回收桶；排序、搜尋）
const home = { box: 'all', sort: 'updated', query: '' };
const thumbUrls = new Map(); // 頭圖 id → 縮圖的 object URL（縮圖存在 IndexedDB）
const kindLabel = d => (L.is2d(d) ? '2D 五視圖' : '3D');
function renderHome() {
  if (!['all', 'star', 'trash'].includes(home.box) && !lib.folders.some(f => f.id === home.box)) home.box = 'all';
  const cur = lib.current && lib.current.drawingId, trash = home.box === 'trash';
  const boxes = [['all', '全部'], ['star', '★ 收藏'], ...lib.folders.map(f => [f.id, f.name])];
  $('#home-boxes').innerHTML = boxes.map(([id, name]) => `<button type="button" class="chip${home.box === id ? ' on' : ''}" data-box="${esc(id)}">${esc(name)}</button>`).join('')
    + '<button type="button" class="chip add" id="home-add-folder" aria-label="新增資料夾"><svg><use href="#i-folder-plus"/></svg></button>'
    + `<button type="button" class="chip${trash ? ' on' : ''}" data-box="trash"><svg><use href="#i-trash"/></svg><span>回收桶</span></button>`;
  document.querySelectorAll('#home-sort [data-sort]').forEach(b => b.classList.toggle('on', b.dataset.sort === home.sort));
  const list = L.listDrawings(lib, home);
  const folderName = id => (lib.folders.find(f => f.id === id) || {}).name;
  $('#home-list').innerHTML = list.length ? list.map(d => {
    const drawn = d.steps.filter(s => L.stepItems(s).length).length, m = H.modelById(headList, H.headOf(headList, d));
    const sub = [kindLabel(d), m ? m.label : '', d.steps.length + ' 步' + (drawn ? '（已畫 ' + drawn + '）' : ''), d.folder && home.box === 'all' ? '📁 ' + folderName(d.folder) : ''].filter(Boolean).join('・');
    const when = trash ? '刪除於 ' + shortDate(d.trashedAt) : shortDate(d.updatedAt);
    const thumb = thumbUrls.get(d.id);
    return `<div class="drawing-item${d.id === cur ? ' cur' : ''}${trash ? ' trashed' : ''}" data-drawing="${esc(d.id)}">`
      + `<button type="button" class="di-open" data-open="${esc(d.id)}" aria-label="打開${esc(d.title)}"><span class="di-ico${thumb ? ' has' : ''}" data-thumb="${esc(d.id)}">${thumb ? `<img alt="" src="${thumb}">` : esc([...d.title][0] || '?')}</span>`
      + `<span class="di-txt"><span class="di-t">${d.star ? '<b class="star">★</b>' : ''}${esc(d.title)}</span><span class="di-s">${esc(sub)}</span><span class="di-s">${esc(when)}</span></span></button>`
      + `<button type="button" class="ic di-more" data-more="${esc(d.id)}" aria-label="${esc(d.title)}的更多動作"><svg><use href="#i-more"/></svg></button></div>`;
  }).join('') : `<p class="home-empty">${trash ? '回收桶是空的' : home.query ? '找不到「' + esc(home.query) + '」' : home.box === 'all' ? '還沒有頭圖，按右上角的＋開始畫' : '這裡還沒有頭圖'}</p>`;
  loadThumbs(list);
}
const shortDate = iso => { const t = new Date(iso); if (Number.isNaN(+t)) return ''; const p = n => String(n).padStart(2, '0'); return t.getFullYear() + '/' + p(t.getMonth() + 1) + '/' + p(t.getDate()) + ' ' + p(t.getHours()) + ':' + p(t.getMinutes()); };
async function loadThumbs(list) {
  for (const d of list) {
    if (thumbUrls.has(d.id)) continue;
    const blob = await flat.media.get('thumb:' + d.id).catch(() => null);
    if (!blob) continue;
    thumbUrls.set(d.id, URL.createObjectURL(blob));
    const el = document.querySelector(`[data-thumb="${CSS.escape(d.id)}"]`);
    if (el) { el.classList.add('has'); el.innerHTML = `<img alt="" src="${thumbUrls.get(d.id)}">`; }
  }
}
// 離開一張頭圖時存一張縮圖（首頁清單用）
async function saveThumb(d) {
  try {
    const blob = L.is2d(d) ? await flat.thumbnail() : await pngBlob(240);
    if (!blob) return;
    await flat.media.put('thumb:' + d.id, blob);
    if (thumbUrls.has(d.id)) URL.revokeObjectURL(thumbUrls.get(d.id));
    thumbUrls.delete(d.id);
  } catch (e) { console.warn('縮圖存不下來', e); }
}
// 回收桶裡超過 30 天的頭圖：連照片一起清掉
function purgeTrash() {
  const old = L.expiredDrawings(lib); if (!old.length) return;
  for (const d of old) removeDrawingFiles(d);
  lib.drawings = lib.drawings.filter(d => !old.includes(d)); saveLib();
}
function removeDrawingFiles(d) {
  const ids = [...L.mediaIds(d), 'thumb:' + d.id];
  const still = new Set(lib.drawings.filter(x => x !== d).flatMap(L.mediaIds)); // 複製出來的頭圖共用同一份照片
  for (const id of ids) if (!still.has(id)) flat.media.del(id).catch(() => {});
}
$('#home-boxes').addEventListener('click', e => {
  if (e.target.closest('#home-add-folder')) { const n = prompt('新資料夾的名字'); if (n === null) return; try { const f = L.addFolder(lib, n); home.box = f.id; saveLib(); renderHome(); } catch (err) { toast(err.message); } return; }
  const b = e.target.closest('[data-box]'); if (!b) return;
  if (home.box === b.dataset.box && lib.folders.some(f => f.id === b.dataset.box)) { openFolderSheet(b.dataset.box); return; } // 再按一次已選的資料夾＝改名、刪除
  home.box = b.dataset.box; renderHome();
});
document.querySelectorAll('#home-sort [data-sort]').forEach(b => b.addEventListener('click', () => { home.sort = b.dataset.sort; renderHome(); }));
$('#home-search').addEventListener('input', e => { home.query = e.target.value; renderHome(); });
$('#home-list').addEventListener('click', e => {
  const more = e.target.closest('[data-more]'); if (more) { openItemSheet(more.dataset.more); return; }
  const b = e.target.closest('[data-open]'); if (!b) return;
  const d = L.drawingById(lib, b.dataset.open);
  if (d && d.trashedAt) { openItemSheet(d.id); return; }
  openDrawing(b.dataset.open, null, 'draw');
});
// 新增一張頭圖：名字（可以不填），按 3D 或 2D 就直接開始畫。3D 用預設那顆（頭模 4），進去後在眼睛選單換；
// 2D 固定用 heads.json 的 default2d（頭模 2），不能換
const newsheet = $('#newsheet');
function renderHeadChoices(el, chosen) {
  el.innerHTML = headList.models.map(m => `<button type="button" class="head-opt${m.id === chosen ? ' on' : ''}" data-head="${esc(m.id)}" aria-pressed="${m.id === chosen}"><b>${esc(m.label)}</b><span>${esc(m.sub)}</span>${m.id === headList.default ? '<em>預設</em>' : ''}</button>`).join('');
}
$('#home-new').addEventListener('click', () => { $('#ns-title').value = ''; newsheet.showModal(); });
$('#ns-kind').addEventListener('click', e => {
  const b = e.target.closest('[data-kind]'); if (!b) return;
  const folder = lib.folders.some(f => f.id === home.box) ? home.box : null;
  const d = L.newDrawing($('#ns-title').value.trim().slice(0, 40) || L.UNTITLED, { kind: b.dataset.kind, head: b.dataset.kind === '2d' ? H.flatHead(headList) : headList.default, folder });
  if (home.box === 'trash' || home.box === 'star') home.box = 'all';
  lib.drawings.push(d); saveLib(); newsheet.close(); openDrawing(d.id, 0, 'draw');
});
newsheet.addEventListener('click', e => { if (e.target === newsheet) newsheet.close(); });
$('#ns-close').addEventListener('click', () => newsheet.close());
// 一張頭圖的動作（首頁的 ⋯）：改名、收藏、移到資料夾、複製、匯出、刪除；回收桶裡：還原、永久刪除
const itemsheet = $('#itemsheet');
let itemId = null;
function openItemSheet(id) {
  const d = L.drawingById(lib, id); if (!d) return;
  itemId = id;
  $('#is-title').textContent = d.title;
  $('#is-sub').textContent = kindLabel(d) + '・' + H.headLabel(H.modelById(headList, H.headOf(headList, d)));
  const trash = !!d.trashedAt;
  for (const el of itemsheet.querySelectorAll('[data-live]')) el.hidden = trash;
  for (const el of itemsheet.querySelectorAll('[data-trash]')) el.hidden = !trash;
  $('#is-star').textContent = d.star ? '取消收藏' : '★ 加入收藏';
  $('#is-folder').innerHTML = '<option value="">（不放資料夾）</option>' + lib.folders.map(f => `<option value="${esc(f.id)}"${d.folder === f.id ? ' selected' : ''}>${esc(f.name)}</option>`).join('');
  itemsheet.showModal();
}
const itemDrawing = () => L.drawingById(lib, itemId);
itemsheet.addEventListener('click', e => { if (e.target === itemsheet) itemsheet.close(); });
$('#is-close').addEventListener('click', () => itemsheet.close());
$('#is-open').addEventListener('click', () => { itemsheet.close(); openDrawing(itemId, null, 'draw'); });
$('#is-rename').addEventListener('click', () => { const d = itemDrawing(); const n = prompt('頭圖的名字', d.title); if (n === null) return; d.title = n.trim().slice(0, 40) || L.UNTITLED; L.touch(d); saveLib(); itemsheet.close(); renderHome(); });
$('#is-star').addEventListener('click', () => { const d = itemDrawing(); if (d.star) delete d.star; else d.star = true; saveLib(); itemsheet.close(); renderHome(); });
$('#is-folder').addEventListener('change', e => { const d = itemDrawing(); if (e.target.value) d.folder = e.target.value; else delete d.folder; saveLib(); itemsheet.close(); renderHome(); toast(e.target.value ? '移到「' + lib.folders.find(f => f.id === e.target.value).name + '」' : '移出資料夾'); });
$('#is-dup').addEventListener('click', async () => { const d = itemDrawing(); const c = L.duplicateDrawing(lib, d); const t = await flat.media.get('thumb:' + d.id).catch(() => null); if (t) await flat.media.put('thumb:' + c.id, t).catch(() => {}); saveLib(); itemsheet.close(); renderHome(); toast('複製好了：' + c.title); });
$('#is-export').addEventListener('click', async () => { const d = itemDrawing(); itemsheet.close(); await exportDrawingFile(d); });
$('#is-trash').addEventListener('click', () => { const d = itemDrawing(); L.trashDrawing(d); if (lib.current && lib.current.drawingId === d.id) lib.current = null; saveLib(); itemsheet.close(); renderHome(); toast('「' + d.title + '」移到回收桶（' + L.TRASH_DAYS + ' 天後自動清掉）', 3000); });
$('#is-restore').addEventListener('click', () => { const d = itemDrawing(); L.restoreDrawing(d); saveLib(); itemsheet.close(); renderHome(); toast('「' + d.title + '」還原了'); });
$('#is-purge').addEventListener('click', () => {
  const d = itemDrawing(); if (!confirm('永久刪除「' + d.title + '」？刪了就找不回來。')) return;
  removeDrawingFiles(d); lib.drawings = lib.drawings.filter(x => x !== d); saveLib(); itemsheet.close(); renderHome();
});
// 資料夾：改名、刪除（裡面的頭圖回到「全部」，不會被刪）
function openFolderSheet(id) {
  const f = lib.folders.find(x => x.id === id); if (!f) return;
  const n = prompt('資料夾改名（清空＝刪除這個資料夾；裡面的頭圖不會被刪）', f.name); if (n === null) return;
  if (!n.trim()) { if (confirm('刪除資料夾「' + f.name + '」？裡面的頭圖會回到「全部」。')) { L.deleteFolder(lib, id); home.box = 'all'; saveLib(); renderHome(); } return; }
  try { L.renameFolder(lib, id, n); saveLib(); renderHome(); } catch (e) { toast(e.message); }
}
const homesheet = $('#homesheet'), aboutsheet = $('#aboutsheet');
$('#home-more').addEventListener('click', () => {
  const live = lib.drawings.filter(d => !d.trashedAt).length;
  $('#home-status').textContent = live + ' 張頭圖・自動存在這個瀏覽器裡（清除瀏覽器資料會不見，記得匯出備份）';
  homesheet.showModal();
});
homesheet.addEventListener('click', e => { if (e.target === homesheet) homesheet.close(); });
$('#hs-close').addEventListener('click', () => homesheet.close());
$('#hs-import').addEventListener('click', () => { homesheet.close(); $('#file-input').click(); });
$('#hs-export').addEventListener('click', async () => {
  homesheet.close();
  const media = await collectMedia(lib.drawings.filter(d => !d.trashedAt));
  downloadBlob(new Blob([L.exportLibrary(lib, media)], { type: 'application/json' }), '頭圖_全部_' + stamp() + '.json'); toast('已產生全部頭圖的 JSON 下載（含照片）');
});
$('#hs-about').addEventListener('click', () => { homesheet.close(); aboutsheet.showModal(); });
$('#hs-help').addEventListener('click', () => { homesheet.close(); $('#helpsheet').showModal(); });
$('#help-close').addEventListener('click', () => $('#helpsheet').close());
$('#helpsheet').addEventListener('click', e => { if (e.target === $('#helpsheet')) $('#helpsheet').close(); });
aboutsheet.addEventListener('click', e => { if (e.target === aboutsheet) aboutsheet.close(); });
$('#as-close').addEventListener('click', () => aboutsheet.close());
$('#file-input').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); });
// 匯出一張頭圖（照片、底圖一起帶）
async function exportDrawingFile(d) {
  const media = await collectMedia([d]);
  downloadBlob(new Blob([L.exportDrawing(d, media)], { type: 'application/json' }), '頭圖_' + fileSafe(d.title) + '_' + stamp() + '.json');
  toast('已產生「' + d.title + '」的 JSON 下載');
}
async function collectMedia(list) {
  const out = {};
  for (const id of new Set(list.flatMap(L.mediaIds))) { const url = await flat.media.dataUrl(id).catch(() => null); if (url) out[id] = url; }
  return out;
}

// ---------------------------------------------------------------- 步驟條、這一步（對話框）
{
  const strip = $('#strip');
  let lpTimer = 0, lpFired = false;
  strip.addEventListener('pointerdown', e => {
    const b = e.target.closest('[data-step]'); lpFired = false; clearTimeout(lpTimer); if (!b) return;
    lpTimer = setTimeout(() => { lpFired = true; openStep(+b.dataset.step); openStepSheet(); }, LONG_MS);
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) strip.addEventListener(ev, () => clearTimeout(lpTimer));
  strip.addEventListener('scroll', () => clearTimeout(lpTimer), { passive: true });
  strip.addEventListener('contextmenu', e => e.preventDefault());
  strip.addEventListener('click', e => {
    if (lpFired) { lpFired = false; return; }
    if (e.target.closest('.add')) { const j = L.addStep(drawing, stepIndex); saveLib(); openStep(j); toast('加了一步：點上面的標題可以幫它取名字', 2600); return; }
    const b = e.target.closest('[data-step]'); if (b) openStep(+b.dataset.step);
  });
}
const stepsheet = $('#stepsheet');
const curItems = () => (L.is2d(drawing) ? flat.stepCount() : doc.layers.length);
function openStepSheet() {
  closePops(); flat.closePops();
  const is2 = L.is2d(drawing);
  $('#ss-drawing').textContent = drawing.title;
  $('#ss-drawing-title').value = drawing.title;
  $('#ss-tag').textContent = L.stepLabel(stepIndex);
  $('#ss-title').value = curStep().title;
  $('#ss-title').placeholder = '步驟 ' + (stepIndex + 1);
  $('#ss-up').disabled = stepIndex <= 0; $('#ss-down').disabled = stepIndex >= drawing.steps.length - 1;
  $('#ss-del').disabled = drawing.steps.length <= 1;
  $('#ss-clear').disabled = !curItems();
  $('#ss-share-png').hidden = !navigator.share;
  $('#ss-head').querySelector('span').textContent = H.headLabel(H.modelById(headList, drawing.head));
  $('#ss-head').disabled = is2; $('#ss-head').querySelector('em').hidden = is2; // 2D 固定一顆頭模
  $('#ss-kind').textContent = kindLabel(drawing);
  $('#ss-note').value = drawing.note || '';
  for (const el of stepsheet.querySelectorAll('[data-k2]')) el.hidden = !is2;
  for (const el of stepsheet.querySelectorAll('[data-k3]')) el.hidden = is2;
  $('#ss-list').innerHTML = drawing.steps.map((x, j) => { const n = L.stepItems(x).length; return `<li><button type="button" data-goto="${j}" class="${j === stepIndex ? 'on' : ''}"><span class="tg">${L.stepLabel(j)}</span><span class="tt">${esc(L.stepName(drawing, j))}</span>${n ? `<span class="ln">${n} 筆</span>` : ''}</button></li>`; }).join('');
  renderPhotos();
  if (!stepsheet.open) stepsheet.showModal();
}
// 照片：一張頭圖最多 6 張，存在 IndexedDB
const photoUrls = new Map();
async function renderPhotos() {
  const ids = drawing.photos || [];
  $('#ss-photo-add').disabled = ids.length >= L.PHOTO_MAX;
  $('#ss-photo-count').textContent = ids.length + '／' + L.PHOTO_MAX;
  const box = $('#ss-photos');
  box.innerHTML = ids.map(id => `<button type="button" class="ph" data-photo="${esc(id)}" aria-label="看照片"><img alt="" src="${photoUrls.get(id) || ''}"></button>`).join('');
  for (const id of ids) {
    if (photoUrls.has(id)) continue;
    const blob = await flat.media.get(id).catch(() => null); if (!blob) continue;
    photoUrls.set(id, URL.createObjectURL(blob));
    const img = box.querySelector(`[data-photo="${CSS.escape(id)}"] img`); if (img) img.src = photoUrls.get(id);
  }
}
$('#ss-photo-add').addEventListener('click', () => $('#photo-input').click());
$('#photo-input').addEventListener('change', async e => {
  const files = [...e.target.files]; e.target.value = '';
  const room = L.PHOTO_MAX - (drawing.photos || []).length;
  if (files.length > room) toast('一張頭圖最多 ' + L.PHOTO_MAX + ' 張照片，多的沒有加進來');
  for (const f of files.slice(0, Math.max(0, room))) {
    try { const id = await flat.media.addImage(f, 1600); drawing.photos = [...(drawing.photos || []), id]; } catch (err) { toast('照片讀不進來：' + err.message); }
  }
  L.touch(drawing); saveLib(); renderPhotos();
});
$('#ss-photos').addEventListener('click', e => { const b = e.target.closest('[data-photo]'); if (b) openPhoto(b.dataset.photo); });
const photosheet = $('#photosheet');
let photoId = null;
function openPhoto(id) { photoId = id; $('#ph-img').src = photoUrls.get(id) || ''; photosheet.showModal(); }
photosheet.addEventListener('click', e => { if (e.target === photosheet || e.target.id === 'ph-img') photosheet.close(); });
$('#ph-close').addEventListener('click', () => photosheet.close());
$('#ph-del').addEventListener('click', () => {
  if (!confirm('把這張照片從頭圖拿掉？')) return;
  drawing.photos = (drawing.photos || []).filter(x => x !== photoId); if (!drawing.photos.length) delete drawing.photos;
  if (!lib.drawings.some(d => (d.photos || []).includes(photoId))) flat.media.del(photoId).catch(() => {});
  L.touch(drawing); saveLib(); photosheet.close(); renderPhotos();
});
$('#ss-note').addEventListener('input', e => { const t = e.target.value.slice(0, L.NOTE_MAX); if (t) drawing.note = t; else delete drawing.note; textChanged(); });
// 頭模：換一顆（已經畫的圖跟著搬）
const headsheet = $('#headsheet');
$('#ss-head').addEventListener('click', () => { renderHeadChoices($('#hd-list'), drawing.head); headsheet.showModal(); });
$('#hd-list').addEventListener('click', async e => { const b = e.target.closest('[data-head]'); if (!b) return; headsheet.close(); stepsheet.close(); await switchHead(b.dataset.head); });
headsheet.addEventListener('click', e => { if (e.target === headsheet) headsheet.close(); });
$('#hd-close').addEventListener('click', () => headsheet.close());
// 改圖名、步驟名：邊打邊記，停手 0.3 秒才存檔、更新頂欄
let textTimer = 0;
function textChanged() { clearTimeout(textTimer); textTimer = setTimeout(() => { saveLib(); renderChrome(); }, 300); }
$('#ss-title').addEventListener('input', e => { curStep().title = e.target.value.trim(); textChanged(); });
$('#ss-drawing-title').addEventListener('input', e => { drawing.title = e.target.value.trim() || L.UNTITLED; $('#ss-drawing').textContent = drawing.title; textChanged(); });
stepsheet.addEventListener('click', e => { if (e.target === stepsheet) stepsheet.close(); });
stepsheet.addEventListener('close', () => { clearTimeout(textTimer); saveLib(); renderChrome(); });
$('#ss-close').addEventListener('click', () => stepsheet.close());
$('#ss-list').addEventListener('click', e => { const b = e.target.closest('[data-goto]'); if (!b) return; stepsheet.close(); openStep(+b.dataset.goto); });
$('#ss-add').addEventListener('click', () => { const j = L.addStep(drawing, stepIndex); saveLib(); openStep(j); openStepSheet(); });
$('#ss-dup').addEventListener('click', () => { const j = L.duplicateStep(drawing, stepIndex); saveLib(); openStep(j); openStepSheet(); toast('複製好了（含這一步的圖）'); });
$('#ss-up').addEventListener('click', () => { const j = L.moveStep(drawing, stepIndex, -1); saveLib(); openStep(j, { keepView: true }); openStepSheet(); });
$('#ss-down').addEventListener('click', () => { const j = L.moveStep(drawing, stepIndex, 1); saveLib(); openStep(j, { keepView: true }); openStepSheet(); });
$('#ss-del').addEventListener('click', () => {
  if (!confirm('刪除「' + L.stepLabel(stepIndex) + ' ' + L.stepName(drawing, stepIndex) + '」這一步？這一步的圖會一起刪掉（不能復原）')) return;
  const j = L.deleteStep(drawing, stepIndex); saveLib(); stepsheet.close(); openStep(j);
});
$('#ss-clear').addEventListener('click', () => {
  if (!curItems() || !confirm('把這一步的圖清掉？（可以按復原）')) return;
  if (L.is2d(drawing)) { flat.clearStep(); stepsheet.close(); return; }
  pushHistory(); doc.layers = []; select(null); rebuild(); commit(); stepsheet.close();
});
const fileSafe = s => s.replace(/[\\/:*?"<>|\s]+/g, '_');
const pngName = () => '頭圖3D_' + fileSafe(drawing.title) + '_' + L.stepLabel(stepIndex) + '_' + stamp() + '.png';
$('#ss-png').addEventListener('click', async () => { stepsheet.close(); downloadBlob(await pngBlob(), pngName()); toast('已產生 PNG 下載（2000×2000 透明，不含點位名稱）'); });
$('#ss-share-png').addEventListener('click', async () => { stepsheet.close(); shareBlob(await pngBlob(), pngName(), '頭圖 3D'); });
$('#ss-export').addEventListener('click', async () => { stepsheet.close(); await exportDrawingFile(drawing); });
// 2D 的輸出：這個視圖、五視圖總表、PDF、動畫影片、社群輪播圖
stepsheet.querySelectorAll('[data-out]').forEach(b => b.addEventListener('click', () => { stepsheet.close(); flat.output(b.dataset.out); }));
$('#ss-dup-drawing').addEventListener('click', async () => {
  const c = L.duplicateDrawing(lib, drawing); saveLib(); stepsheet.close();
  toast('複製好了，現在打開的是「' + c.title + '」'); await openDrawing(c.id, stepIndex, 'draw');
});
$('#ss-del-drawing').addEventListener('click', () => {
  if (!confirm('把「' + drawing.title + '」移到回收桶？（' + L.TRASH_DAYS + ' 天內可以在首頁的回收桶還原）')) return;
  L.trashDrawing(drawing); lib.current = null; saveLib(); stepsheet.close(); setMode('home'); drawing = null;
});

// ---------------------------------------------------------------- 浮動選單（眼睛、視角、樣式 ⋯、平行、標字）
const POPS = ['eye-pop', 'view-pop', 'style-pop', 'repeat-pop', 'label-pop'], POP_BUTTONS = ['eye-btn', 'view-btn', 'style-more', 'sel-repeat', 'sel-label-btn'];
function closePops() {
  for (const id of POPS) $('#' + id).hidden = true;
  for (const id of POP_BUTTONS) $('#' + id).setAttribute('aria-expanded', 'false');
}
function togglePop(popId, btnId) {
  const pop = $('#' + popId), open = pop.hidden;
  closePops();
  if (open) { pop.hidden = false; $('#' + btnId).setAttribute('aria-expanded', 'true'); if (popId === 'eye-pop') { applySettings(); renderEyeHeads(); } if (popId === 'style-pop') syncUI(); }
}
// 眼睛選單的頭模：點一顆就換（已經畫的圖跟著搬過去）
function renderEyeHeads() {
  const el = $('#eye-heads');
  el.innerHTML = !headList || !drawing ? '' : headList.models.map(m => { const on = m.id === drawing.head; return `<button type="button" data-head="${esc(m.id)}" class="${on ? 'on' : ''}" aria-pressed="${on}" aria-label="${esc(H.headLabel(m))}"><b>${esc(m.label)}</b><span>${esc(m.sub.split('・')[0])}</span></button>`; }).join('');
}
$('#eye-heads').addEventListener('click', async e => {
  const b = e.target.closest('[data-head]'); if (!b || !drawing || b.dataset.head === drawing.head) return;
  closePops(); await switchHead(b.dataset.head);
});
$('#eye-btn').addEventListener('click', () => { if (drawing && L.is2d(drawing)) flat.toggleEye(); else togglePop('eye-pop', 'eye-btn'); });
$('#view-btn').addEventListener('click', () => togglePop('view-pop', 'view-btn'));
$('#style-more').addEventListener('click', () => togglePop('style-pop', 'style-more'));
// 按在選單和開它的那顆鈕以外的地方＝收起選單
document.addEventListener('pointerdown', e => {
  if (e.target.closest('.pop') || POP_BUTTONS.some(id => e.target.closest('#' + id))) return;
  if (POPS.some(id => !$('#' + id).hidden)) closePops();
}, true);
const vgrid = $('#vgrid');
for (const key of ['front_left_45', 'front', 'front_right_45', 'left', 'top', 'right', 'back_left_45', 'back', 'back_right_45']) {
  const v = VIEWS.find(x => x.key === key);
  const b = document.createElement('button'); b.type = 'button'; b.dataset.view = v.key; b.textContent = v.label; b.setAttribute('aria-label', '視角：' + v.label);
  b.addEventListener('click', () => { setView(v, true); closePops(); });
  vgrid.append(b);
}
$('#tgl-topdown').addEventListener('click', () => { lib.settings.topFaceDown = !lib.settings.topFaceDown; saveLib(); applySettings(); if (viewKey === 'top') setView(VIEWS.find(v => v.key === 'top'), true); });
document.querySelectorAll('[data-lshape]').forEach(b => b.addEventListener('click', () => setLineShape(b.dataset.lshape)));
// 分線形狀：換樞軸（再按一次＝回頭頂）、平行重複的小選單
$('#pivot-btn').addEventListener('click', () => {
  cancelDraft();
  if (pickingPivot) { pickingPivot = false; radPivot = null; toast('樞軸回到頭頂', 1500); } else pickingPivot = true;
  syncUI(); updateHandles(); requestRender();
});
$('#sel-repeat').addEventListener('click', repeatClick);
// 標字：選到一筆 → 「標字」→ 打字或點常用詞 → 完成。空白＝不要字。
function setLabel(text) {
  const l = layerById(selectedId); if (!l) return;
  const t = D.cleanLabel(text); if ((l.label || '') === t) return;
  pushHistory(); if (t) l.label = t; else delete l.label;
  rebuildLayer(l); commit(); syncUI();
}
function labelClick() {
  const l = layerById(selectedId); if (!l) return;
  const open = $('#label-pop').hidden; closePops(); if (!open) return;
  $('#label-pop').hidden = false; $('#sel-label-btn').setAttribute('aria-expanded', 'true');
  $('#label-input').value = l.label || '';
}
$('#sel-label-btn').addEventListener('click', labelClick);
$('#label-done').addEventListener('click', () => { setLabel($('#label-input').value); closePops(); });
$('#label-clear').addEventListener('click', () => { $('#label-input').value = ''; setLabel(''); closePops(); });
$('#label-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); setLabel($('#label-input').value); closePops(); } e.stopPropagation(); });
document.querySelectorAll('#label-chips [data-word]').forEach(b => b.addEventListener('click', () => { $('#label-input').value = b.dataset.word; setLabel(b.dataset.word); closePops(); }));
const stepRep = (kind, d) => {
  const lim = SEC.REPEAT;
  if (kind === 'count') repCount = Math.min(lim.countMax, Math.max(lim.countMin, repCount + d));
  else repGap = Math.min(lim.gapMax, Math.max(lim.gapMin, Math.round((repGap + d * lim.gapStep) * 10) / 10));
  syncRepeatPop();
};
$('#rep-count-dec').addEventListener('click', () => stepRep('count', -1)); $('#rep-count-inc').addEventListener('click', () => stepRep('count', 1));
$('#rep-gap-dec').addEventListener('click', () => stepRep('gap', -1)); $('#rep-gap-inc').addEventListener('click', () => stepRep('gap', 1));
$('#rep-dir-pos').addEventListener('click', () => { repDir = 1; syncRepeatPop(); }); $('#rep-dir-neg').addEventListener('click', () => { repDir = -1; syncRepeatPop(); });
$('#rep-deg-dec').addEventListener('click', () => stepDiag(-SEC.DIAG_STEP)); $('#rep-deg-inc').addEventListener('click', () => stepDiag(SEC.DIAG_STEP));
$('#rep-go').addEventListener('click', makeRepeats);
document.querySelectorAll('[data-tpl]').forEach(b => b.addEventListener('click', () => addTemplate(b.dataset.tpl)));
document.querySelectorAll('[data-rmode]').forEach(b => b.addEventListener('click', () => setRegionMode(b.dataset.rmode)));

// ---------------------------------------------------------------- 介面接線
document.querySelectorAll('[data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
$('#undo').addEventListener('click', () => { if (drawing && L.is2d(drawing)) flat.undo(); else undo(); });
$('#redo').addEventListener('click', () => { if (drawing && L.is2d(drawing)) flat.redo(); else redo(); });
const setFlag = (k, v) => { lib.settings[k] = v; saveLib(); applySettings(); };
$('#tgl-outline').addEventListener('click', () => setFlag('outline', !lib.settings.outline));
$('#tgl-structure').addEventListener('click', () => { setFlag('structure', !lib.settings.structure); updateHandles(); });
$('#struct-btn').addEventListener('click', () => { setFlag('structure', !lib.settings.structure); updateHandles(); });
$('#tgl-labels').addEventListener('click', () => { setFlag('labels', !lib.settings.labels); updateHandles(); });
$('#tgl-ghost').addEventListener('click', () => { setFlag('ghost', !lib.settings.ghost); buildGhosts(); });
$('#tgl-mirror').addEventListener('click', () => { lib.settings.mirror = !lib.settings.mirror; saveLib(); syncUI(); toast(lib.settings.mirror ? '鏡像開：畫左邊會自動畫右邊' : '鏡像關', 1500); });
$('#tgl-snap').addEventListener('click', () => { setFlag('snap', !lib.settings.snap); clearSnap(); updateHandles(); });
document.querySelectorAll('[data-dash]').forEach(b => b.addEventListener('click', () => applyStyle({ dashed: b.dataset.dash === '1' })));
document.querySelectorAll('[data-width]').forEach(b => b.addEventListener('click', () => applyStyle({ width: +b.dataset.width })));
$('#tgl-arrow').addEventListener('click', () => { const st = activeStyle(); if (st) applyStyle({ arrow: !st.arrow }); });
document.querySelectorAll('.sw[data-color]').forEach(b => b.addEventListener('click', () => applyStyle({ stroke: b.dataset.color })));
// 自訂顏色：手指直接按到蓋在「＋」上的選色器。已經有自訂色就先套用它（選色器跳出來後不改也算數）；拖動選色只推一次歷史
colorInput.addEventListener('click', () => { colorLive = false; const st = activeStyle(); if (customColor && st && st.stroke.toLowerCase() !== customColor.toLowerCase()) applyStyle({ stroke: customColor }); });
colorInput.addEventListener('input', () => { customColor = colorInput.value.toUpperCase(); saveUI(); applyStyle({ stroke: customColor }, colorLive); colorLive = true; });
colorInput.addEventListener('change', () => { colorLive = false; });
$('#draft-done').addEventListener('click', finishDraft); $('#draft-cancel').addEventListener('click', cancelDraft);
$('#sel-close').addEventListener('click', () => select(null));
$('#sel-delete').addEventListener('click', () => { const l = layerById(selectedId); if (l) deleteLayer(l); });
$('#sel-flip').addEventListener('click', flipSelected); $('#sel-bend').addEventListener('click', bendSelected); $('#sel-delpoint').addEventListener('click', deletePoint);
document.querySelectorAll('[data-ostyle]').forEach(b => b.addEventListener('click', () => setOutlineStyle(b.dataset.ostyle)));
function goHome() {
  if (drawing && !drawing.trashedAt) saveThumb(drawing).then(() => { if (mode === 'home') renderHome(); }); // 縮圖存好了再把清單畫一次
  setMode('home');
}
$('#go-home').addEventListener('click', goHome);
$('#preview-home').addEventListener('click', goHome);
$('#step-title').addEventListener('click', openStepSheet);
$('#preview-btn').addEventListener('click', () => { setMode('preview'); if (!L.is2d(drawing)) applyStepView(); });
$('#preview-edit').addEventListener('click', () => setMode('draw'));
// 預覽：儲存這張照片。先產生圖、給看一眼，再選存到手機（分享選單）或下載；
// 分到第二下才叫分享選單，手機瀏覽器才認得是手指按的（等產生圖的時間太久會被擋）
const savesheet = $('#savesheet'), coarse = matchMedia('(pointer: coarse)').matches;
let saveFile = null, saveUrl = null;
async function photoNow() {
  if (L.is2d(drawing)) return flat.photo();
  const png = await pngBlob(2000, true);
  const img = await createImageBitmap(png), c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d'); ctx.fillStyle = getComputedStyle(stage).backgroundColor || '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0); // 透明底鋪上畫面的底色，存到相簿才不會是黑底
  return { blob: await new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('圖產生不出來'))), 'image/png')), name: pngName() };
}
$('#preview-save').addEventListener('click', async e => {
  if (!drawing) return;
  const btn = e.currentTarget; btn.disabled = true;
  try {
    const { blob, name } = await photoNow();
    saveFile = new File([blob], name, { type: 'image/png' });
    if (saveUrl) URL.revokeObjectURL(saveUrl);
    saveUrl = URL.createObjectURL(blob); $('#sv-img').src = saveUrl;
    const share = coarse && !!navigator.share && !!navigator.canShare && navigator.canShare({ files: [saveFile] });
    $('#sv-share').hidden = !share;
    $('#sv-tip').textContent = coarse ? (share ? 'iPhone：按上面的按鈕，再選「儲存影像」。' : '') + '也可以長按圖片存到相簿。' : name;
    savesheet.showModal();
  } catch (err) { toast('照片產生不出來：' + (err && err.message || err), 4000); }
  finally { btn.disabled = false; }
});
$('#sv-share').addEventListener('click', async () => {
  try { await navigator.share({ files: [saveFile], title: drawing.title }); savesheet.close(); }
  catch (e) { if (e && e.name !== 'AbortError') toast('分享失敗：' + e.message + '（可以改按下載）', 3500); }
});
$('#sv-download').addEventListener('click', () => { downloadBlob(saveFile, saveFile.name); savesheet.close(); toast('已產生 PNG 下載'); });
$('#sv-close').addEventListener('click', () => savesheet.close());
savesheet.addEventListener('click', e => { if (e.target === savesheet) savesheet.close(); });
$('#recenter').addEventListener('click', () => { applyStepView(); if (fallen) ensureVisible(fallTips(), 0.92); });
$('#prev').addEventListener('click', () => goStep(-1)); $('#next').addEventListener('click', () => goStep(1));
document.addEventListener('keydown', e => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
  if (document.querySelector('dialog[open]')) return;
  if (drawing && L.is2d(drawing) && mode !== 'home') { flat.keydown(e); return; }
  if (mode === 'preview') { if (e.key === 'ArrowRight') { e.preventDefault(); goStep(1); } else if (e.key === 'ArrowLeft') { e.preventDefault(); goStep(-1); } else if (e.key === 'Escape') setMode('draw'); return; }
  if (mode !== 'draw') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (e.key === 'Escape') { if (POPS.some(id => !$('#' + id).hidden)) closePops(); else if (draft) cancelDraft(); else select(null); }
  else if (e.key === 'Enter') { if (draft) finishDraft(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { const l = layerById(selectedId); if (l) { e.preventDefault(); if (activeHandle && activeHandle.kind === 'pt' && l.points.length > D.minPoints(l.shape)) deletePoint(); else deleteLayer(l); } }
});

// ---------------------------------------------------------------- 2D 頭圖（五個視圖的平面圖；編輯器在 flat/editor.js）
const flat = createFlat({
  THREE, renderer, toast,
  lib: () => lib, drawing: () => drawing, stepIndex: () => stepIndex, mode: () => mode,
  saved: () => { L.touch(drawing); saveLib(); updateButtons(); renderStrip(); },
  changed: () => updateButtons(),
  goStep, openStepSheet, downloadBlob, shareBlob, stamp, fileSafe, prepareHead,
});

// 給自動化測試用
window.head3d = {
  ready: false,
  get lib() { return lib; }, get drawing() { return drawing; }, get stepIndex() { return stepIndex; }, get mode() { return mode; },
  get doc() { return doc; }, get scalp() { return scalp; }, get objects() { return objects; }, get selectedId() { return selectedId; }, get landmarks() { return landmarks; },
  get headId() { return headId; }, get flat() { return flat; },
  setTool, select, setView: key => setView(VIEWS.find(v => v.key === key)), createLayer,
  addLayer: o => { const l = D.newLayer(o); pushHistory(); addLayer(l); commit(); requestRender(); return l; },
  openDrawing, openStep, setMode, pngBlob, undo, redo, pickAt, toScreen, useHead, switchHead,
};

// ---------------------------------------------------------------- 頭模：四顆，每張頭圖記自己用哪一顆
// 第一次用到才下載；載入過的留在記憶體（換回來不用再算一次外輪廓與點位）。
const heads = new Map(); // id → { id, model, group, scalp, landmarks, outlinePts, outlineDirs, lines, structure }
const loadingBox = $('#loading');
function showLoading(text) { loadingBox.hidden = false; loadingBox.classList.remove('failed'); loadingBox.querySelector('span').textContent = text; }
function loadFailed(msg) { loadingBox.hidden = false; loadingBox.classList.add('failed'); loadingBox.querySelector('span').textContent = msg; }
async function prepareHead(id) {
  if (heads.has(id)) return heads.get(id);
  const model = H.modelById(headList, id);
  if (!model) throw new Error('沒有這顆頭模：' + id);
  const [res, metaRes] = await Promise.all([fetch(H.HEADS_DIR + model.glb), fetch(H.HEADS_DIR + model.meta)]);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const meshes = loadMeshes(await res.arrayBuffer());
  const meta = metaRes.ok ? await metaRes.json() : null;
  if (!(meta && meta.outline && meta.landmarks_m)) throw new Error('點位與外輪廓的資料讀不到'); // 沒有外輪廓就沒有可以畫的範圍
  const group = new THREE.Group();
  for (const [name, data] of Object.entries(meshes)) { const m = new THREE.Mesh(geometryFrom(data), new THREE.MeshStandardMaterial(headMaterialOptions(name))); m.name = name; group.add(m); }
  const sc = new Scalp(meshes);
  const lms = computeLandmarks(sc, meta);
  const pts = outlinePoints(sc, lms);
  sc.extendDrawingSurface(pts); // 射線、畫線與線內外的判斷共用同一條外輪廓
  const lines = structureLines(sc, lms);
  const structure = new THREE.Group(); structure.renderOrder = 1;
  for (const s of lines) if (s.points.length >= 2) structure.add(makeLine(s.points, lineMaterial({ stroke: D.STRUCTURE_COLOR, width: 1.2 }, false)));
  // 結構線開著時十五點（含左右）一起顯示成小圓點（直徑 3.6 mm），沒有文字
  const dotMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(D.STRUCTURE_DOT_COLOR) }), dotGeo = new THREE.SphereGeometry(0.0018, 16, 12);
  for (const lm of lms) { const h = sc.nearestHead(lm.point); const m = new THREE.Mesh(dotGeo, dotMat); m.renderOrder = 2; m.position.copy(lm.point).addScaledVector(h.normal, OFFSET + 0.0008); structure.add(m); }
  const rec = { id, model, meshes, group, scalp: sc, landmarks: lms, outlinePts: pts, outlineDirs: pts.map(p => p.clone().sub(sc.center).normalize()), lines, structure };
  heads.set(id, rec);
  return rec;
}
// 換上另一顆頭：場景裡的頭、外輪廓、結構線，以及畫圖用的頭皮、點位都換掉
function applyHead(h) {
  if (headGroup) scene.remove(headGroup);
  if (structureGroup) scene.remove(structureGroup);
  headGroup = h.group; scene.add(headGroup);
  structureGroup = h.structure; scene.add(structureGroup);
  scalp = h.scalp; landmarks = h.landmarks; outlinePts = h.outlinePts; outlineDirs = h.outlineDirs; headId = h.id;
  buildOutline(outlineStyle);
  if (lib) { setOutlineVisible(lib.settings.outline); setStructureVisible(lib.settings.structure); }
  requestRender();
}
async function useHead(id) {
  if (id === headId) return heads.get(id);
  const cached = heads.has(id);
  if (!cached) showLoading('載入' + H.headLabel(H.modelById(headList, id)) + '…');
  try { const h = await prepareHead(id); applyHead(h); return h; }
  finally { if (!cached) loadingBox.hidden = true; }
}
const currentHead = () => heads.get(headId) || null;
const projectOnScalp = p => { const q = scalp.nearest(p).point; return { x: q.x, y: q.y, z: q.z }; };

// ---------------------------------------------------------------- 啟動
(async function main() {
  loadUI();
  setView(VIEWS[1]); resize();
  try {
    const [lr, tr] = await Promise.all([fetch(H.HEADS_URL), fetch(H.TRANSFER_URL)]);
    if (!lr.ok) throw new Error('頭模清單 HTTP ' + lr.status);
    headList = await lr.json();
    const bad = H.validateHeads(headList); if (bad.length) throw new Error(bad[0]);
    if (tr.ok) { try { transferCtx = TR.makeContext(await tr.json()); } catch (e) { console.warn('換頭模的對照資料讀不進來', e); } }
  } catch (e) { loadFailed('頭模清單讀不到：' + e.message); return; }
  try { loadLibrary(); } catch (e) { loadFailed('頭圖庫讀不進來：' + e.message); return; }
  const last = lib.current, lastDrawing = last && L.drawingById(lib, last.drawingId);
  try { await useHead(lastDrawing && ['draw', 'preview'].includes(last.mode) ? H.headOf(headList, lastDrawing) : headList.default); }
  catch (e) { loadFailed('頭模載入失敗：' + e.message); return; }
  loadingBox.hidden = true;
  setTool(tool); applySettings(); purgeTrash();
  // 上次停在畫圖或預覽，就回到那張頭圖的那一步；否則到首頁
  if (lastDrawing && !lastDrawing.trashedAt && ['draw', 'preview'].includes(last.mode)) await openDrawing(lastDrawing.id, null, last.mode);
  else setMode('home');
  window.head3d.ready = true;
  requestRender();
})();
