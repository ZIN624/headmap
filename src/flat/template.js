// SPDX-License-Identifier: AGPL-3.0-only
// 2D 頭圖的底圖：從 3D 頭模畫出五個視圖的線稿（瀏覽器限定，要 WebGL）。
// 每個視圖用正交鏡頭照一次「法線」和「深度」，再找出深度跳動（外形、耳朵、鼻子的輪廓）和法線轉折（眼皮、嘴唇、鼻翼）
// 的地方畫成灰線，所以四顆頭模各有自己的五張線稿。另外：
//   髮際線   外輪廓（3D 的頭髮外輪廓）投影到這個視圖、只留看得到的那段，畫成虛線
//   結構線   五條結構線投影（看得到的段）
//   點位     十五點投影（看得到的；吸附候選）
//   淡淡的立體底（shade）：同一次照相的明暗，開了才畫
// 座標一律是 views.js 的公釐座標。
import { VIEWS, pageBox, project } from './views.js';
import { traceMask } from './snap.js';

const PX_PER_MM = 3.2;        // 線稿解析度：一張紙 360 mm → 1152 px
const NECK_CUT = -0.195;      // 正、背、側面：脖子照到這個高度（公尺）為止
const TOP_CUT = -0.1;         // 頂視：只照這個高度以上（肩膀不要）
const DEPTH_EDGE = 0.0035;    // 深度差多少算輪廓（公尺）
const NORMAL_EDGE = 0.55;     // 法線差多少算轉折（1−cos）

const cache = new Map(); // 頭模 id → 五個視圖的底圖

// head：app.js 的頭模紀錄（meshes、scalp、landmarks、outlinePts、lines）
export async function templatesFor(THREE, renderer, head) {
  if (cache.has(head.id)) return cache.get(head.id);
  const out = {};
  const ctx = makeRig(THREE, head);
  try { for (const v of VIEWS) out[v.id] = await buildView(THREE, renderer, ctx, head, v); }
  finally { ctx.dispose(); }
  cache.set(head.id, out);
  return out;
}

function makeRig(THREE, head) {
  const scene = new THREE.Scene();
  const normalMat = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
  const depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
  const shadeMat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  const meshes = [];
  for (const [name, data] of Object.entries(head.meshes)) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    if (data.normals) g.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3)); else g.computeVertexNormals();
    g.setIndex(new THREE.BufferAttribute(data.indices, 1));
    const m = new THREE.Mesh(g, normalMat); m.name = name; scene.add(m); meshes.push(m);
  }
  const light = new THREE.DirectionalLight(0xffffff, 1.6), amb = new THREE.AmbientLight(0xffffff, 1.1);
  scene.add(light, amb);
  return {
    scene, meshes, normalMat, depthMat, shadeMat, light,
    dispose() { for (const m of meshes) m.geometry.dispose(); normalMat.dispose(); depthMat.dispose(); shadeMat.dispose(); },
  };
}

async function buildView(THREE, renderer, rig, head, v) {
  const box = pageBox(v.id), W = Math.round(box.w * PX_PER_MM), H = Math.round(box.h * PX_PER_MM);
  // 鏡頭：從 dir 那一邊看向原點，畫面範圍＝這張紙（公尺）
  const cam = new THREE.OrthographicCamera(box.x / 1000, (box.x + box.w) / 1000, -box.y / 1000, -(box.y + box.h) / 1000, 0.01, 2);
  cam.position.set(v.dir[0], v.dir[1], v.dir[2]); cam.up.set(v.up[0], v.up[1], v.up[2]); cam.lookAt(0, 0, 0);
  cam.updateProjectionMatrix(); cam.updateMatrixWorld();
  // 只照要的高度：側／正／背照到脖子，頂視不照肩膀
  const clip = v.id === 'top' ? new THREE.Plane(new THREE.Vector3(0, 1, 0), -TOP_CUT) : new THREE.Plane(new THREE.Vector3(0, 1, 0), -NECK_CUT);
  for (const m of [rig.normalMat, rig.depthMat, rig.shadeMat]) { m.clippingPlanes = [clip]; m.needsUpdate = true; }
  const prevLocal = renderer.localClippingEnabled, prevTarget = renderer.getRenderTarget(), prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
  renderer.localClippingEnabled = true;
  const rt = new THREE.WebGLRenderTarget(W, H, { depthBuffer: true });
  const read = mat => {
    for (const m of rig.meshes) m.material = mat;
    renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(rig.scene, cam);
    const px = new Uint8Array(W * H * 4); renderer.readRenderTargetPixels(rt, 0, 0, W, H, px); return px;
  };
  let normal, depth, shade;
  try {
    normal = read(rig.normalMat);
    depth = read(rig.depthMat);
    rig.light.position.set(v.dir[0] * 0.6 + 0.4, 0.8, v.dir[2] * 0.6 + 0.5);
    shade = read(rig.shadeMat);
  } finally {
    renderer.setRenderTarget(prevTarget); renderer.setClearColor(prevClear, prevAlpha); renderer.localClippingEnabled = prevLocal; rt.dispose();
  }
  // 讀回來的影像是上下顛倒的（WebGL 從左下角開始）
  const at = (x, y) => ((H - 1 - y) * W + x) * 4;
  const mask = new Uint8Array(W * H), dep = new Float32Array(W * H), nx = new Float32Array(W * H), ny = new Float32Array(W * H), nz = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, k = at(x, y);
    if (normal[k + 3] < 128) continue;
    mask[i] = 1;
    nx[i] = normal[k] / 127.5 - 1; ny[i] = normal[k + 1] / 127.5 - 1; nz[i] = normal[k + 2] / 127.5 - 1;
    // RGBADepthPacking：深度 0～1 打包在 RGBA（R 是最高位）
    dep[i] = depth[k] / 256 + depth[k + 1] / 65536 + depth[k + 2] / 16777216 + depth[k + 3] / (255 * 16777216);
  }
  const range = 2 - 0.01; // 鏡頭 near～far（公尺）
  // 邊：外形（有東西／沒東西的交界）、深度跳動、法線轉折。線只畫在頭的那一側
  const edge = new Float32Array(W * H), NB = [1, -1, W, -W], depthJump = DEPTH_EDGE / range, n0 = NORMAL_EDGE * 0.6;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    if (!mask[i]) continue;
    let e = 0;
    for (let k = 0; k < 4; k++) {
      const j = i + NB[k];
      if (!mask[j]) { e = 1; break; }
      if (dep[j] - dep[i] > depthJump) e = Math.max(e, 0.95); // 後面那一片比這裡深很多：這裡是前面那一邊，畫線
      const d = 1 - (nx[i] * nx[j] + ny[i] * ny[j] + nz[i] * nz[j]);
      if (d > n0) e = Math.max(e, Math.min(0.75, (d - n0) / NORMAL_EDGE));
    }
    edge[i] = e;
  }
  // 線加粗一格（1 px 的線縮小來看會太淡）
  const thick = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    thick[i] = Math.max(edge[i], 0.85 * Math.max(edge[i - 1], edge[i + 1], edge[i - W], edge[i + W]));
  }
  edge.set(thick);
  // 切到脖子的那一圈不畫（下緣開口）
  if (v.id !== 'top') {
    const cutRow = Math.round((-NECK_CUT * 1000 - box.y) * PX_PER_MM);
    for (let y = Math.max(0, cutRow - 4); y < Math.min(H, cutRow + 3); y++) for (let x = 0; x < W; x++) edge[y * W + x] = 0;
  }
  // 線稿畫進畫布：灰線、邊緣柔一點
  const ink = [138, 144, 153];
  const line = document.createElement('canvas'); line.width = W; line.height = H;
  const lc = line.getContext('2d'), img = lc.createImageData(W, H), D = img.data;
  for (let i = 0; i < W * H; i++) {
    const e = edge[i]; if (e <= 0.05) continue;
    D[i * 4] = ink[0]; D[i * 4 + 1] = ink[1]; D[i * 4 + 2] = ink[2]; D[i * 4 + 3] = Math.round(255 * Math.min(1, e));
  }
  lc.putImageData(img, 0, 0);
  // 淡淡的立體底：明暗壓成很淡的灰（柔的東西，三分之一解析度就夠）
  const SW = Math.ceil(W / 3), SH = Math.ceil(H / 3);
  const sh = document.createElement('canvas'); sh.width = SW; sh.height = SH;
  const sc = sh.getContext('2d'), simg = sc.createImageData(SW, SH), SD = simg.data;
  for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
    const px = Math.min(W - 1, x * 3 + 1), py = Math.min(H - 1, y * 3 + 1), i = py * W + px; if (!mask[i]) continue;
    const g = shade[at(px, py)], o = (y * SW + x) * 4;
    SD[o] = 120; SD[o + 1] = 128; SD[o + 2] = 138; SD[o + 3] = Math.round((255 - g) * 0.42 + 10);
  }
  sc.putImageData(simg, 0, 0);
  // 輪廓的外框（吸附與「點一下填滿」的邊界、完善線條的參考）：把 mask 的外緣描成折線
  const outline = traceMask(mask, W, H).map(p => [box.x + p[0] / PX_PER_MM, box.y + p[1] / PX_PER_MM]);
  // 看不看得到：留一張每公釐一格的深度圖（每格取最前面的表面），之後畫樣板也用它
  const LW = Math.ceil(box.w), LH = Math.ceil(box.h), low = new Float32Array(LW * LH).fill(Infinity);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (!mask[i]) continue;
    const j = Math.min(LH - 1, Math.floor(y / PX_PER_MM)) * LW + Math.min(LW - 1, Math.floor(x / PX_PER_MM));
    if (dep[i] < low[j]) low[j] = dep[i];
  }
  const near = cam.near, far = cam.far, dir = v.dir;
  const visible = p3 => {
    const q = project(v.id, p3), x = Math.floor(q[0] - box.x), y = Math.floor(q[1] - box.y);
    if (x < 1 || y < 1 || x >= LW - 1 || y >= LH - 1) return false;
    let best = Infinity;
    for (const j of [y * LW + x, y * LW + x + 1, y * LW + x - 1, (y + 1) * LW + x, (y - 1) * LW + x]) best = Math.min(best, low[j]);
    if (best === Infinity) return true;
    const px = Array.isArray(p3) ? p3 : [p3.x, p3.y, p3.z];
    const d01 = (1 - (px[0] * dir[0] + px[1] * dir[1] + px[2] * dir[2]) - near) / (far - near); // 鏡頭在 dir（距原點 1 公尺）
    return d01 - best < 0.0025 / range;
  };
  const runs = pts => { // 3D 點列 → 看得到的 2D 段
    const out = []; let cur = null;
    for (const p of pts) {
      if (visible(p)) { if (!cur) { cur = []; out.push(cur); } cur.push(project(v.id, p)); } else cur = null;
    }
    return out.filter(r => r.length >= 2);
  };
  const hairline = runs(head.outlinePts.concat([head.outlinePts[0]]));
  const structure = head.lines.map(l => ({ id: l.id, runs: runs(l.points) }));
  const points = head.landmarks.filter(l => visible(l.point)).map(l => ({ id: l.id, side: l.side, name: l.name, p: project(v.id, l.point) }));
  return {
    view: v.id, box, W, H, pxPerMm: PX_PER_MM,
    line, lineUrl: await toUrl(line), shade: sh, shadeUrl: await toUrl(sh),
    outline, hairline, structure, points, visible, runs,
  };
}
const toUrl = c => new Promise(res => c.toBlob(b => res(URL.createObjectURL(b)), 'image/png'));
