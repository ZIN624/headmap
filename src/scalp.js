// SPDX-License-Identifier: AGPL-3.0-only
// 貼頭皮畫線的幾何核心：點選、最近點、沿表面的最短線、曲線、切面線、圍起來的面。
// 射線與最近點用 three-mesh-bvh 加速（整顆頭有兩萬多個三角形，逐一掃會卡）。瀏覽器與 Node 共用。
// 長度單位公尺；頭心＝世界原點；+Y 向上、臉朝 +Z、模型左側 +X。
import { Vector3, Raycaster, Mesh, BufferGeometry, BufferAttribute, MeshBasicMaterial, DoubleSide, Triangle, CatmullRomCurve3 } from '../vendor/three/build/three.module.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from '../vendor/three-mesh-bvh/index.module.js';
import { insideSphericalPolygon, insideOutline, rdp, toV, quadPoint, quadLength, controlFromHandle, POLYGON_REF } from './geometry.js';

BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
Mesh.prototype.raycast = acceleratedRaycast;

export const OFFSET = 0.0009; // 線沿法線抬 0.9 mm，才不會和頭模搶深度
const FILL_OFFSET = 0.0005;   // 區塊填色抬 0.5 mm（在線的下面）
const STEP = 0.001;           // 兩控制點之間至少每 1 mm 取一個貼頭皮的點
const MIN_STEPS = 8;

export function geometryFrom(meshData) {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(meshData.positions, 3));
  if (meshData.normals) g.setAttribute('normal', new BufferAttribute(meshData.normals, 3));
  else g.computeVertexNormals();
  g.setIndex(new BufferAttribute(meshData.indices, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

const _a = new Vector3(), _b = new Vector3(), _c = new Vector3(), _p = new Vector3(), _tri = new Triangle();
const _bary = new Vector3(), _n = new Vector3();

export class Scalp {
  // meshes：loadMeshes() 的結果。要有 HD_HEAD_BASE（整顆頭，帶耳殼遮罩 ear）與 HD_BUST（胸像）；HD_EYES 有的話只當阻擋物。
  constructor(meshes, center = [0, 0, 0]) {
    const headData = meshes.HD_HEAD_BASE, bustData = meshes.HD_BUST;
    if (!headData) throw new Error('GLB に HD_HEAD_BASE がありません');
    if (!headData.ear) throw new Error('HD_HEAD_BASE には耳のマスク（ear_bits）が必要です');
    if (!bustData) throw new Error('GLB に HD_BUST がありません');
    const mat = new MeshBasicMaterial({ side: DoubleSide });
    this._ear = headData.ear; // 每個頭頂點是不是耳殼（0／1）
    // 「頭」＝整顆頭（含臉、耳朵）。建 BVH 會把索引重排，所以用副本：沒重排的順序留給身體網格（_ensureBody）。
    this.headGeometry = geometryFrom({ positions: headData.positions, normals: headData.normals, indices: headData.indices.slice() });
    this.headGeometry.computeBoundsTree();
    this.head = new Mesh(this.headGeometry, mat);
    // 「頭殼」＝頭去掉有耳殼頂點的三角形（和頭共用頂點）。外輪廓與結構線投到這上面：落在耳殼上的點會被拉到最近的耳根，
    // 線就貼著耳根走、被耳朵蓋住的那段藏在耳後。
    const idx = this.headGeometry.index, keep = [];
    for (let t = 0; t < idx.count / 3; t++) if (!this._earFace(t)) keep.push(idx.getX(t * 3), idx.getX(t * 3 + 1), idx.getX(t * 3 + 2));
    this._skullGeometry = new BufferGeometry();
    this._skullGeometry.setAttribute('position', this.headGeometry.attributes.position);
    this._skullGeometry.setAttribute('normal', this.headGeometry.attributes.normal);
    this._skullGeometry.setIndex(new BufferAttribute(new Uint32Array(keep), 1));
    this._skullBvh = this._skullGeometry.computeBoundsTree();
    // 可以畫的面（頭皮面）：外輪廓還沒算出來時先用整個頭殼，extendDrawingSurface 再縮成外輪廓以內。
    this.scalp = new Mesh(this._skullGeometry, mat);
    this._useSurface(this._skullGeometry);
    // 身體＝頭＋整個胸像（脖子、肩膀、上背），第一次用到才建（nearestBody）
    this._bodyData = [headData, bustData];
    // 胸像的下緣是開口：再下面沒有身體，髮束自由垂下（不這樣，垂到下緣的髮束會被開口的邊吸住、卡在那裡）
    this.bodyFloor = bustData.min[1];
    this.blockers = [this.head];
    for (const k of ['HD_BUST', 'HD_EYES']) if (meshes[k]) { const g = geometryFrom(meshes[k]); g.computeBoundsTree(); this.blockers.push(new Mesh(g, mat)); }
    for (const m of [this.scalp, ...this.blockers]) m.updateMatrixWorld(true);
    this.center = new Vector3().fromArray(center);
    this.ray = new Raycaster();
    this.ray.firstHitOnly = true;
    this._hit = {};
  }

  // 換一張可以畫的面：射線、最近點、切面線、填色都跟著用它。
  _useSurface(g) {
    this.scalpGeometry = g; this.scalp.geometry = g;
    this._pos = g.attributes.position; this._idx = g.index; this._nrm = g.attributes.normal;
    this._triCount = g.index.count / 3; this._bvh = g.boundsTree;
    this._centroidDirs = null; // 區塊填色用：每個頭皮三角形重心的單位方向，第一次用到才算
    this._edgeMap = null;
  }

  // 把可以畫的面定成「外輪廓以內」：頭殼上落在外輪廓裡面（含 margin 的邊界緩衝）的三角形，再挖掉耳根圈裡面的。
  // 整張面是同一張連通的網格，pick、最近點、切面最短線、曲線和填色才會一起涵蓋鬢角及頸背；
  // 不疊兩張網格，以免切面線在接縫斷掉。
  extendDrawingSurface(outline, margin = 0.01) {
    if (!outline || outline.length < 3) throw new Error('描ける範囲を決めるには、閉じた外周ラインが必要です');
    const loop = rdp(outline.concat([outline[0]]), 0.0005); loop.pop();
    const dirs = loop.map(p => p.clone().sub(this.center).normalize());
    this._drawingEarLoops = { L: this.earRootLoop('L'), R: this.earRootLoop('R') };
    const source = this._skullGeometry, pos = source.attributes.position, idx = source.index;
    const allowed = new Uint8Array(pos.count), used = new Uint8Array(pos.count), p = new Vector3();
    for (let i = 0; i < idx.count; i++) used[idx.getX(i)] = 1;
    for (let i = 0; i < pos.count; i++) {
      if (!used[i]) continue;
      p.fromBufferAttribute(pos, i);
      if (insideOutline(p, this.center, dirs, loop, margin + 0.0005)) allowed[i] = 1;
    }
    const keep = [];
    for (let t = 0; t < idx.count; t += 3) {
      const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2);
      if (!(allowed[a] || allowed[b] || allowed[c])) continue;
      p.fromBufferAttribute(pos, a).add(_b.fromBufferAttribute(pos, b)).add(_c.fromBufferAttribute(pos, c)).multiplyScalar(1 / 3);
      // 去掉耳殼頂點之後還留著耳甲的內凹；可畫網格要再挖掉耳根圈裡面的三角形。
      if (!this._insideDrawingEar(p)) keep.push(a, b, c);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', pos); g.setAttribute('normal', source.attributes.normal);
    g.setIndex(new BufferAttribute(new Uint32Array(keep), 1));
    g.computeBoundingBox(); g.computeBoundingSphere(); g.computeBoundsTree();
    if (this.scalpGeometry !== this._skullGeometry) this.scalpGeometry.dispose();
    this._useSurface(g);
  }

  // 耳根圈的側視投影（y–z）裡面不是頭皮。x > 0 看左耳的圈、x < 0 看右耳的圈，只看 |x| 是不是在耳朵那一側。
  // 離圈邊 0.5 mm 以內不算裡面：留給貼著耳根的筆畫和投影的浮點誤差。
  _insideDrawingEar(p) {
    const loop = this._drawingEarLoops && this._drawingEarLoops[p.x < 0 ? 'R' : 'L'];
    if (!loop || Math.abs(p.x) < 0.06) return false;
    let inside = false, nearest2 = Infinity;
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const a = loop[j], b = loop[i];
      if ((a.y > p.y) !== (b.y > p.y) && p.z < (b.z - a.z) * (p.y - a.y) / (b.y - a.y) + a.z) inside = !inside;
      const dy = b.y - a.y, dz = b.z - a.z;
      const t = Math.max(0, Math.min(1, ((p.y - a.y) * dy + (p.z - a.z) * dz) / Math.max(1e-16, dy * dy + dz * dz)));
      nearest2 = Math.min(nearest2, (p.y - a.y - dy * t) ** 2 + (p.z - a.z - dz * t) ** 2);
    }
    return inside && nearest2 > 0.0005 ** 2;
  }
  _centroids() {
    if (this._centroidDirs) return this._centroidDirs;
    const out = new Float32Array(this._triCount * 3), pos = this._pos, idx = this._idx, c = new Vector3();
    for (let t = 0; t < this._triCount; t++) {
      _a.fromBufferAttribute(pos, idx.getX(t * 3)); _b.fromBufferAttribute(pos, idx.getX(t * 3 + 1)); _c.fromBufferAttribute(pos, idx.getX(t * 3 + 2));
      c.copy(_a).add(_b).add(_c).multiplyScalar(1 / 3).sub(this.center).normalize();
      out[t * 3] = c.x; out[t * 3 + 1] = c.y; out[t * 3 + 2] = c.z;
    }
    return this._centroidDirs = out;
  }

  // 法線一律朝外（離開頭心）。
  outward(n, p) { if (n.dot(_p.copy(p).sub(this.center)) < 0) n.multiplyScalar(-1); return n.normalize(); }

  // 三角形 t 上一點的平滑法線（重心座標內插頂點法線）。
  _smoothNormal(t, point) {
    const ia = this._idx.getX(t * 3), ib = this._idx.getX(t * 3 + 1), ic = this._idx.getX(t * 3 + 2);
    _a.fromBufferAttribute(this._pos, ia); _b.fromBufferAttribute(this._pos, ib); _c.fromBufferAttribute(this._pos, ic);
    _tri.set(_a, _b, _c).getBarycoord(point, _bary);
    const n = new Vector3();
    n.addScaledVector(_n.fromBufferAttribute(this._nrm, ia), _bary.x);
    n.addScaledVector(_n.fromBufferAttribute(this._nrm, ib), _bary.y);
    n.addScaledVector(_n.fromBufferAttribute(this._nrm, ic), _bary.z);
    if (n.lengthSq() < 1e-12) _tri.getNormal(n);
    return this.outward(n, point);
  }

  // 頭皮面上離 position 最近的點（BVH；網格矩陣是單位矩陣，世界座標＝本地座標）。
  nearest(position) {
    const q = toV(position); // 吃 Vector3、[x,y,z] 或 {x,y,z}（存檔裡的 bends 是物件）
    const r = this._bvh.closestPointToPoint(q, this._hit);
    if (!r) throw new Error('頭皮の面が見つかりません。');
    const point = r.point.clone();
    return { point, normal: this._smoothNormal(r.faceIndex, point), distance: r.distance, faceIndex: r.faceIndex };
  }

  // 「頭」表面（含耳朵、額頭）上離 position 最近的點：髮際線外的點（鬢角、耳後）用這個，不會被頭皮面的邊緣吸走。
  nearestHead(position) {
    const q = toV(position);
    const r = this.headGeometry.boundsTree.closestPointToPoint(q, {});
    if (!r) throw new Error('頭の面が見つかりません。');
    const point = r.point.clone();
    const ia = this.headGeometry.index.getX(r.faceIndex * 3), ib = this.headGeometry.index.getX(r.faceIndex * 3 + 1), ic = this.headGeometry.index.getX(r.faceIndex * 3 + 2);
    const pos = this.headGeometry.attributes.position, nrm = this.headGeometry.attributes.normal;
    _a.fromBufferAttribute(pos, ia); _b.fromBufferAttribute(pos, ib); _c.fromBufferAttribute(pos, ic);
    _tri.set(_a, _b, _c).getBarycoord(point, _bary);
    const n = new Vector3().addScaledVector(_n.fromBufferAttribute(nrm, ia), _bary.x).addScaledVector(_n.fromBufferAttribute(nrm, ib), _bary.y).addScaledVector(_n.fromBufferAttribute(nrm, ic), _bary.z);
    if (n.lengthSq() < 1e-12) _tri.getNormal(n);
    // 頭網格的頂點法線就是朝外的，直接用。不用「背向頭心」來判斷朝外：面朝上的斜面（後頸到肩膀、耳殼背面）會判反，
    // 髮束垂到後頸旁邊時會被當成「在頭裡面」而整段吸到脖子上。
    return { point, normal: n.normalize(), distance: r.distance };
  }

  // 「身體」的網格＝頭（含耳朵）＋整個胸像（脖子、肩膀、上背），共用一張 BVH。
  _ensureBody() {
    if (!this._bodyGeometry) {
      const [h, b] = this._bodyData, off = h.positions.length / 3;
      const positions = new Float32Array(h.positions.length + b.positions.length); positions.set(h.positions); positions.set(b.positions, h.positions.length);
      const normals = new Float32Array(h.normals.length + b.normals.length); normals.set(h.normals); normals.set(b.normals, h.normals.length);
      // 頭的最低那一圈是補平的底面，胸像剛好接在它下面：這片底面藏在身體裡面，不是身體表面。
      // 留著的話，垂到接縫旁邊的髮束會被它往下推、陷進胸像，所以三個頂點都在最低那一圈的三角形不算。
      const lo = h.min[1] + 1e-5, hp = h.positions, hi = [];
      for (let t = 0; t < h.indices.length; t += 3) {
        const a = h.indices[t], c = h.indices[t + 1], d = h.indices[t + 2];
        if (!(hp[a * 3 + 1] <= lo && hp[c * 3 + 1] <= lo && hp[d * 3 + 1] <= lo)) hi.push(a, c, d);
      }
      const indices = new Uint32Array(hi.length + b.indices.length); indices.set(hi); for (let i = 0; i < b.indices.length; i++) indices[hi.length + i] = b.indices[i] + off;
      this._bodyGeometry = geometryFrom({ positions, normals, indices }); this._bodyGeometry.computeBoundsTree();
    }
    return this._bodyGeometry;
  }
  // 「身體」表面上離 position 最近的點。nearestHead 只到頭的最低那一圈，長頭髮垂到肩膀會直接穿過去；
  // 髮束（lift.js 的 hairPath）用這個，脖子、肩膀也擋得住。頂點法線照 GLB（朝外）。
  nearestBody(position) {
    const g = this._ensureBody(), q = toV(position), r = g.boundsTree.closestPointToPoint(q, {});
    if (!r) throw new Error('体の面が見つかりません。');
    const point = r.point.clone(), ia = g.index.getX(r.faceIndex * 3), ib = g.index.getX(r.faceIndex * 3 + 1), ic = g.index.getX(r.faceIndex * 3 + 2);
    _a.fromBufferAttribute(g.attributes.position, ia); _b.fromBufferAttribute(g.attributes.position, ib); _c.fromBufferAttribute(g.attributes.position, ic);
    _tri.set(_a, _b, _c).getBarycoord(point, _bary);
    const n = new Vector3().addScaledVector(_n.fromBufferAttribute(g.attributes.normal, ia), _bary.x).addScaledVector(_n.fromBufferAttribute(g.attributes.normal, ib), _bary.y).addScaledVector(_n.fromBufferAttribute(g.attributes.normal, ic), _bary.z);
    if (n.lengthSq() < 1e-12) _tri.getNormal(n);
    return { point, normal: n.normalize(), distance: r.distance };
  }

  // 從頭心往 position 的方向射出去，打到的最外層表面點（預設打頭皮面）。打不到回 null。
  radial(position, mesh = this.scalp) {
    const d = _p.copy(position).sub(this.center);
    if (d.lengthSq() < 1e-16) return null;
    d.normalize();
    const origin = this.center.clone().addScaledVector(d, 2);
    this.ray.set(origin, d.clone().negate());
    this.ray.near = 0; this.ray.far = 4;
    const hits = this.ray.intersectObject(mesh, false);
    const h = hits[0];
    if (!h || h.point.clone().sub(this.center).dot(d) <= 0) return null;
    const normal = mesh === this.scalp ? this._smoothNormal(h.faceIndex, h.point) : this.outward(h.face.normal.clone(), h.point);
    return { point: h.point.clone(), normal, faceIndex: h.faceIndex };
  }

  // 頭網格第 faceIndex 個三角形有沒有耳殼頂點。
  _earFace(faceIndex) {
    const ear = this._ear, idx = this.headGeometry.index;
    return !!(ear[idx.getX(faceIndex * 3)] || ear[idx.getX(faceIndex * 3 + 1)] || ear[idx.getX(faceIndex * 3 + 2)]);
  }
  // 頭殼上離 q 最近的點（含平滑法線）。
  _skullNearest(q) {
    const r = this._skullBvh.closestPointToPoint(q, {});
    if (!r) return null;
    const g = this._skullGeometry, ia = g.index.getX(r.faceIndex * 3), ib = g.index.getX(r.faceIndex * 3 + 1), ic = g.index.getX(r.faceIndex * 3 + 2);
    _a.fromBufferAttribute(g.attributes.position, ia); _b.fromBufferAttribute(g.attributes.position, ib); _c.fromBufferAttribute(g.attributes.position, ic);
    const point = r.point.clone();
    _tri.set(_a, _b, _c).getBarycoord(point, _bary);
    const n = new Vector3().addScaledVector(_n.fromBufferAttribute(g.attributes.normal, ia), _bary.x).addScaledVector(_n.fromBufferAttribute(g.attributes.normal, ib), _bary.y).addScaledVector(_n.fromBufferAttribute(g.attributes.normal, ic), _bary.z);
    if (n.lengthSq() < 1e-12) _tri.getNormal(n);
    return { point, normal: this.outward(n, point), distance: r.distance };
  }
  // 一個空間點投到頭殼（含額頭、頸背，不含耳朵）：先從頭心射到最外層，打到耳朵就取頭殼上最近的點（耳根）。
  onSkull(position) {
    const hit = this.radial(position, this.head);
    if (hit && !this._earFace(hit.faceIndex)) return hit;
    const q = toV(position);
    return this._skullNearest(q) || hit || this.nearestHead(q);
  }

  // 耳根圈（side＝'L' 左耳、'R' 右耳）。左右對稱的頭（asymmetric 沒開）右耳直接鏡像左耳；不對稱的頭兩耳各算各的。
  // 耳殼不能畫，要知道耳殼和頭殼的交界在哪：
  // 1) 頭殼在耳朵一帶的邊界邊（只屬於一個頭殼三角形的邊，也就是耳／非耳三角形的共用邊）接成閉合迴圈，取最長那圈。
  // 2) 這圈在耳甲（耳朵中間的凹處）會從耳屏前面凹進去一條舌頭到耳甲底，直接用它會橫過耳朵中間；
  //    所以在側視圖（y–z 平面）取這圈的凸包當耳朵外形，凹進去的那段用耳屏前面的皮膚補平：
  //    凸包每 1 mm 取樣、每點取頭殼上最近的點，再每 spacing 重取樣。
  // 回傳閉合點列（在頭殼表面上、沒抬高）：index 0＝最高點，接著往前、往下繞耳垂、再從後面回到最高點。
  earRootLoop(side = 'L', spacing = 0.002) {
    if (!this._earLoops) this._earLoops = {};
    if (this._earLoops[side]) return this._earLoops[side];
    if (side === 'R' && !this.asymmetric) return this._earLoops.R = this.earRootLoop('L', spacing).map(p => new Vector3(-p.x, p.y, p.z));
    const sg = side === 'R' ? -1 : 1;
    const g = this._skullGeometry, pos = g.attributes.position, idx = g.index, V = pos.count;
    const key = (i, j) => Math.min(i, j) * V + Math.max(i, j);
    const count = new Map();
    for (let t = 0; t < idx.count / 3; t++) { const a = idx.getX(t * 3), b = idx.getX(t * 3 + 1), c = idx.getX(t * 3 + 2); for (const [i, j] of [[a, b], [b, c], [c, a]]) { const k = key(i, j); count.set(k, (count.get(k) || 0) + 1); } }
    const adj = new Map(), v = new Vector3();
    for (const [k, n] of count) { if (n !== 1) continue; const i = Math.floor(k / V), j = k % V; v.fromBufferAttribute(pos, i); if (v.x * sg < 0.05) continue; (adj.get(i) || adj.set(i, []).get(i)).push(j); (adj.get(j) || adj.set(j, []).get(j)).push(i); }
    const seen = new Set(); let best = null;
    for (const start of adj.keys()) {
      if (seen.has(start)) continue;
      const loop = [start]; seen.add(start); let prev = -1, cur = start;
      for (;;) { const nxt = adj.get(cur).find(x => x !== prev && !seen.has(x)); if (nxt === undefined) break; loop.push(nxt); seen.add(nxt); prev = cur; cur = nxt; }
      if (loop.length > 2 && adj.get(cur).includes(start) && (!best || loop.length > best.length)) best = loop;
    }
    if (!best) throw new Error('耳の付け根の輪が見つかりません');
    const raw = best.map(i => new Vector3().fromBufferAttribute(pos, i));
    // 側視圖凸包（Andrew 單調鏈，座標 (z, y)）
    const sorted = raw.slice().sort((a, b) => a.z - b.z || a.y - b.y);
    const cross = (o, a, b) => (a.z - o.z) * (b.y - o.y) - (a.y - o.y) * (b.z - o.z);
    const lower = []; for (const p of sorted) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
    const upper = []; for (let i = sorted.length - 1; i >= 0; i--) { const p = sorted[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
    let hull = lower.slice(0, -1).concat(upper.slice(0, -1));
    // 轉成 index 0＝最高點、下一點往前（+z）
    let ti = 0; for (let i = 1; i < hull.length; i++) if (hull[i].y > hull[ti].y) ti = i;
    hull = hull.slice(ti).concat(hull.slice(0, ti));
    if (hull[1].z < hull[hull.length - 1].z) hull = [hull[0]].concat(hull.slice(1).reverse());
    // 凸包每 1 mm 取樣（x 線性內插），每點取頭殼最近點
    const dense = [];
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i], b = hull[(i + 1) % hull.length], n = Math.max(1, Math.ceil(a.distanceTo(b) / 0.001));
      for (let k = 0; k < n; k++) { const h = this._skullNearest(a.clone().lerp(b, k / n)); dense.push(h.point); }
    }
    // 沿弧長每 spacing 重取樣成閉合點列
    let total = 0; for (let i = 0; i < dense.length; i++) total += dense[i].distanceTo(dense[(i + 1) % dense.length]);
    const m = Math.max(24, Math.round(total / spacing)), step = total / m, out = [];
    let acc = 0, seg = 0, segLen = dense[0].distanceTo(dense[1 % dense.length]);
    for (let k = 0; k < m; k++) {
      const target = k * step;
      while (acc + segLen < target && seg < dense.length - 1) { acc += segLen; seg++; segLen = dense[seg].distanceTo(dense[(seg + 1) % dense.length]); }
      const u = segLen > 1e-12 ? (target - acc) / segLen : 0;
      out.push(this._skullNearest(dense[seg].clone().lerp(dense[(seg + 1) % dense.length], Math.min(1, Math.max(0, u)))).point);
    }
    // 耳根頂可能是一段平的，投回頭殼後最高點會落在 index 0 旁邊：轉一下讓 index 0 真的是最高點（方向不變）
    let top = 0; for (let i = 1; i < out.length; i++) if (out[i].y > out[top].y) top = i;
    return this._earLoops[side] = out.slice(top).concat(out.slice(0, top));
  }

  // 從鏡頭射線點選頭皮：先打頭皮；如果臉、耳、胸像比頭皮更近（隔著臉點到後腦），拒絕。
  pick(origin, direction) {
    this.ray.set(origin, direction);
    this.ray.near = 0; this.ray.far = 10;
    const hits = this.ray.intersectObject(this.scalp, false);
    if (!hits.length) return null;
    const hit = hits[0];
    if (this._insideDrawingEar(hit.point)) return null;
    for (const b of this.blockers) {
      const bh = this.ray.intersectObject(b, false);
      if (bh.length && bh[0].distance < hit.distance - 0.002) return null;
    }
    return { point: hit.point.clone(), normal: this._smoothNormal(hit.faceIndex, hit.point), distance: hit.distance };
  }

  // 一個世界點從鏡頭看會不會被頭擋住（控制點把手要不要顯示）。
  occluded(origin, point) {
    const dir = point.clone().sub(origin); const dist = dir.length(); dir.normalize();
    this.ray.set(origin, dir); this.ray.near = 0; this.ray.far = dist + 1;
    for (const m of [this.scalp, ...this.blockers]) {
      const h = this.ray.intersectObject(m, false);
      if (h.length && h[0].distance < dist - 0.0015) return true;
    }
    return false;
  }

  _lift(hit) { return hit.point.clone().addScaledVector(hit.normal, OFFSET); }
  // 凹進去的頸部，從頭心射出去可能先碰到比較低的頸、肩。已經靠近表面的曲線點先取最近點，
  // 深入頭心的弦點才用徑向投射；path 傳進來的 fallback 是兩個控制點之間弦上的位置。
  _onSurface(p, fallback) { const near = this.nearest(fallback || p); return near.distance < 0.025 ? near : this.radial(p) || near; }

  // 折線：控制點先投到頭皮最近點，兩點之間按「從頭心出發的方向」插值，每一小段射回頭皮。
  path(controls, closed = false) {
    let pts = controls.map(c => this.nearest(c).point);
    if (pts.length < 2) throw new Error('違う点が2つ以上必要です。');
    if (closed) pts = pts.concat([pts[0]]);
    const result = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const len = a.distanceTo(b);
      if (len < 0.0001) continue;
      const da = a.clone().sub(this.center).normalize(), db = b.clone().sub(this.center).normalize();
      const steps = Math.max(MIN_STEPS, Math.ceil(len / STEP));
      for (let j = 0; j < steps; j++) {
        const u = j / steps;
        const dir = da.clone().lerp(db, u).normalize();
        result.push(this._lift(this._onSurface(this.center.clone().addScaledVector(dir, 0.2), a.clone().lerp(b, u))));
      }
    }
    result.push(this._lift(this.nearest(pts[pts.length - 1])));
    if (result.length < 2) throw new Error('2点が近すぎます。もう一度選んでください。');
    return result;
  }

  // 曲線：通過每個控制點的 Catmull-Rom（向心式），取樣後每一點射回頭皮。closed＝閉合（區塊邊）。
  curve(controls, closed = false) {
    const pts = controls.map(c => this.nearest(c).point);
    if (pts.length < 2) throw new Error('違う点が2つ以上必要です。');
    if (pts.length === 2 && !closed) return this.path(pts);
    const crv = new CatmullRomCurve3(pts, closed, 'centripetal', 0.5);
    const approx = crv.getLength();
    const n = Math.max(MIN_STEPS * (pts.length - (closed ? 0 : 1)), Math.ceil(approx / STEP));
    const result = [];
    for (let i = 0; i <= n; i++) {
      if (closed && i === n) break;
      const p = crv.getPoint(i / n);
      result.push(this._lift(this._onSurface(p)));
    }
    if (!closed) result[result.length - 1] = this._lift(this.nearest(pts[pts.length - 1]));
    if (result.length < 2) throw new Error('2点が近すぎます。もう一度選んでください。');
    return result;
  }

  // 三角形的座標（Float32Array，每九個數一個三角形）→ BufferGeometry。呼叫的人把算好的座標留著（同一塊面重畫時不用再算），每次用這個包成新的幾何。
  positionsGeometry(positions) {
    if (!positions || !positions.length) return null;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(positions, 3));
    g.computeVertexNormals();
    return g;
  }
  // 區塊填色：閉合邊線（密集點）圍住的頭皮三角形，抬 FILL_OFFSET，回傳三角形的座標（沒有就回 null）。
  // 邊線先用 RDP 減到 0.3 mm 以內（判斷用），每個點拿「從頭心看出去的方向」做球面多邊形內外判斷。
  // 整個在裡面的三角形直接用；被邊線切到的三角形（三個角和重心不全在同一邊）切成四小塊再判斷，最多切 depth 次
  // （三角形邊長 1～10 mm，切三次剩 1/8）。整個三角形只看重心的話，填色的邊會是一個三角形那麼大的鋸齒。
  regionPositions(loopDense, depth = 3) {
    if (loopDense.length < 3) return null;
    const simp = rdp(loopDense.concat([loopDense[0]]), 0.0003); simp.pop();
    const dirs = simp.map(p => p.clone().sub(this.center).normalize());
    if (dirs.length < 3) return null;
    const mean = new Vector3(); for (const d of dirs) mean.add(d); mean.normalize();
    let minDot = 1; for (const d of dirs) minDot = Math.min(minDot, d.dot(mean));
    // 粗篩：邊線全部落在「以 mean 為中心的一個圓」裡，圓外面整片不是都在裡面就是都在外面；「外面」的參考方向（正下方）在圓外面時，
    // 圓外面就一定是外面，可以直接跳過。大塊的面（繞過半顆頭、整顆頭扣掉瀏海）那個圓會包到正下方，這時不能篩（篩了會缺一大片）。
    const limit = POLYGON_REF.dot(mean) < minDot - 0.05 ? minDot - 0.05 : -2;
    const cds = this._centroids(), pos = this._pos, idx = this._idx, nrm = this._nrm, C = this.center;
    const out = [], cd = new Vector3(), q = new Vector3();
    const inside = p => insideSphericalPolygon(q.copy(p).sub(C), dirs);
    const vflag = new Int8Array(pos.count).fill(-1); // 每個頂點在不在裡面（相鄰三角形共用，只算一次）
    const flagOf = (i, v) => (vflag[i] < 0 ? (vflag[i] = inside(v) ? 1 : 0) : vflag[i]);
    const emit = (a, na, b, nb, c, nc) => { for (const [v, n] of [[a, na], [b, nb], [c, nc]]) out.push(v.x + n.x * FILL_OFFSET, v.y + n.y * FILL_OFFSET, v.z + n.z * FILL_OFFSET); };
    const mid = (a, b) => a.clone().add(b).multiplyScalar(0.5), midN = (a, b) => a.clone().add(b).normalize();
    // 一小塊：三個角都在同一邊就照那一邊；不然再切，切到底看重心
    const split = (a, na, fa, b, nb, fb, c, nc, fc, level) => {
      if (fa === fb && fb === fc) { if (fa) emit(a, na, b, nb, c, nc); return; }
      if (level >= depth) { if (inside(q.copy(a).add(b).add(c).multiplyScalar(1 / 3).clone())) emit(a, na, b, nb, c, nc); return; }
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a), nab = midN(na, nb), nbc = midN(nb, nc), nca = midN(nc, na);
      const fab = inside(ab) ? 1 : 0, fbc = inside(bc) ? 1 : 0, fca = inside(ca) ? 1 : 0;
      split(a, na, fa, ab, nab, fab, ca, nca, fca, level + 1); split(ab, nab, fab, b, nb, fb, bc, nbc, fbc, level + 1);
      split(ca, nca, fca, bc, nbc, fbc, c, nc, fc, level + 1); split(ab, nab, fab, bc, nbc, fbc, ca, nca, fca, level + 1);
    };
    for (let t = 0; t < this._triCount; t++) {
      cd.set(cds[t * 3], cds[t * 3 + 1], cds[t * 3 + 2]);
      if (cd.dot(mean) < limit) continue; // 粗篩：離多邊形的方向太遠
      const ia = idx.getX(t * 3), ib = idx.getX(t * 3 + 1), ic = idx.getX(t * 3 + 2);
      const a = new Vector3().fromBufferAttribute(pos, ia), b = new Vector3().fromBufferAttribute(pos, ib), c = new Vector3().fromBufferAttribute(pos, ic);
      const fa = flagOf(ia, a), fb = flagOf(ib, b), fc = flagOf(ic, c), fm = insideSphericalPolygon(cd, dirs) ? 1 : 0;
      if (fa === fb && fb === fc && fc === fm && !fm) continue; // 整個在外面
      const na = this.outward(new Vector3().fromBufferAttribute(nrm, ia), a), nb = this.outward(new Vector3().fromBufferAttribute(nrm, ib), b), nc = this.outward(new Vector3().fromBufferAttribute(nrm, ic), c);
      if (fa === fb && fb === fc && fc === fm) { emit(a, na, b, nb, c, nc); continue; }
      if (depth <= 0) { if (fm) emit(a, na, b, nb, c, nc); continue; }
      // 三個角一樣、只有重心不一樣（細長的面穿過三角形中間）：也要切，所以第一層不看「三個角一樣」
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a), nab = midN(na, nb), nbc = midN(nb, nc), nca = midN(nc, na);
      const fab = inside(ab) ? 1 : 0, fbc = inside(bc) ? 1 : 0, fca = inside(ca) ? 1 : 0;
      split(a, na, fa, ab, nab, fab, ca, nca, fca, 1); split(ab, nab, fab, b, nb, fb, bc, nbc, fbc, 1);
      split(ca, nca, fca, bc, nbc, fbc, c, nc, fc, 1); split(ab, nab, fab, bc, nbc, fbc, ca, nca, fca, 1);
    }
    return out.length ? new Float32Array(out) : null;
  }
  // 折線圍成的一圈（點一下填色做出來的面）：相鄰兩點之間走直線、每 1 mm 貼回頭皮一次；不做平滑，轉角保持尖的。回傳抬高 OFFSET 的密集點（不重複第一點）。
  polyLoop(controls) {
    const pts = controls.map(c => this.nearest(c).point), out = [];
    if (pts.length < 3) throw new Error('点が3つ以上必要です。');
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length], n = Math.max(1, Math.ceil(a.distanceTo(b) / STEP));
      for (let k = 0; k < n; k++) out.push(this._lift(this.nearest(k ? a.clone().lerp(b, k / n) : a)));
    }
    return out;
  }

  // ================================================================ 沿網格的最短路徑
  // 邊 → 相鄰三角形（第一次用到才建）。鍵 = min*V + max，V 是頂點數。
  _edges() {
    if (this._edgeMap) return this._edgeMap;
    const V = this._pos.count, idx = this._idx, map = new Map();
    for (let t = 0; t < this._triCount; t++) {
      const a = idx.getX(t * 3), b = idx.getX(t * 3 + 1), c = idx.getX(t * 3 + 2);
      for (const [i, j] of [[a, b], [b, c], [c, a]]) { const k = Math.min(i, j) * V + Math.max(i, j); const arr = map.get(k); if (arr) arr.push(t); else map.set(k, [t]); }
    }
    return this._edgeMap = map;
  }
  _edgeKey(i, j) { const V = this._pos.count; return Math.min(i, j) * V + Math.max(i, j); }
  _triVerts(t) { return [this._idx.getX(t * 3), this._idx.getX(t * 3 + 1), this._idx.getX(t * 3 + 2)]; }

  // 用一個通過 S、E 的平面切頭皮網格，從 S 所在的三角形一格一格走到 E 所在的三角形，回傳交線上的點（含 S、E）與每點所在三角形。
  // 走出頭皮邊界、繞圈或走太遠就回 null。
  _planeCut(S, sTri, E, eTri, planeN) {
    const edges = this._edges(), pos = this._pos, chord = E.clone().sub(S), chordLen = chord.length();
    const dOf = i => { const d = planeN.dot(_p.fromBufferAttribute(pos, i).sub(S)); return Math.abs(d) < 1e-9 ? 1e-9 : d; };
    const cross = (i, j) => { const di = dOf(i), dj = dOf(j); const u = di / (di - dj); return _a.fromBufferAttribute(pos, i).clone().lerp(_b.fromBufferAttribute(pos, j), u); };
    if (sTri === eTri) return [{ p: S.clone(), tri: sTri }, { p: E.clone(), tri: eTri }];
    const crossings = (tri, fromKey) => { const [a, b, c] = this._triVerts(tri); const out = []; for (const [i, j] of [[a, b], [b, c], [c, a]]) { const k = this._edgeKey(i, j); if (k === fromKey) continue; if ((dOf(i) >= 0) !== (dOf(j) >= 0)) out.push({ k, p: cross(i, j) }); } return out; };
    // 起點三角形有兩條邊被切到＝兩個方向；兩個都走走看（例如耳到耳：往上翻過頭頂才到得了，往下會走出頭皮邊界）
    const walk = first => {
      const out = [{ p: S.clone(), tri: sTri }];
      let tri = sTri, next = first;
      for (let step = 0; step < 20000; step++) {
        if (next.p.clone().sub(S).dot(chord) / chordLen > chordLen + 0.02) return null; // 沿弦方向走過頭了（切到別的地方）
        const neighbours = edges.get(next.k); if (!neighbours) return null;
        const other = neighbours.find(t => t !== tri);
        if (other === undefined) return null; // 頭皮邊界
        out.push({ p: next.p, tri: other }); tri = other;
        if (tri === eTri) { out.push({ p: E.clone(), tri: eTri }); return out; }
        const c = crossings(tri, next.k); if (!c.length) return null;
        next = c[0];
      }
      return null;
    };
    let best = null, bestLen = Infinity;
    for (const first of crossings(sTri, -1)) {
      const r = walk(first); if (!r) continue;
      let L = 0; for (let i = 1; i < r.length; i++) L += r[i].p.distanceTo(r[i - 1].p);
      if (L < bestLen) { bestLen = L; best = r; }
    }
    return best;
  }

  // 兩點之間貼表面的最短路徑：通過兩端點、垂直於兩點平均法線的平面切網格，再比對繞兩點連線轉 ±22°、±45°、±68°、90° 的切平面，取最短的那條（每個切面約 1 ms）。
  // 回傳抬高 OFFSET 的密集點。每個切面都走不通（例如跨過頭皮邊界）就退回 path()。
  geodesic(a, b) {
    const hs = this.nearest(a), he = this.nearest(b);
    const S = hs.point, E = he.point;
    const chord = E.clone().sub(S);
    if (chord.length() < 1e-5) return [this._lift(hs), this._lift(he)];
    const nAvg = hs.normal.clone().add(he.normal); if (nAvg.lengthSq() < 1e-8) nAvg.copy(hs.normal); nAvg.normalize();
    const axis = chord.clone().normalize();
    const base = new Vector3().crossVectors(chord, nAvg); if (base.lengthSq() < 1e-14) base.crossVectors(chord, Math.abs(axis.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0)); base.normalize();
    let best = null, bestLen = Infinity;
    for (const deg of [0, 22, -22, 45, -45, 68, -68, 90]) { // 先試垂直於法線的平面，再逐步轉到「繞過頭頂」的平面（耳到耳這種長線要靠它）
      const n = base.clone().applyAxisAngle(axis, deg * Math.PI / 180);
      const cut = this._planeCut(S, hs.faceIndex, E, he.faceIndex, n);
      if (!cut) continue;
      let L = 0; for (let i = 1; i < cut.length; i++) L += cut[i].p.distanceTo(cut[i - 1].p);
      if (L < bestLen) { bestLen = L; best = cut; }
    }
    if (!best) return this.path([S, E]);
    // 去掉太近的重複點，再沿平滑法線抬高
    const out = [];
    for (const c of best) { if (out.length && c.p.distanceTo(out[out.length - 1].raw) < 1e-6) continue; out.push({ raw: c.p, lifted: c.p.clone().addScaledVector(this._smoothNormal(c.tri, c.p), OFFSET) }); }
    if (out.length < 2) return [this._lift(hs), this._lift(he)];
    return out.map(o => o.lifted);
  }

  // ================================================================ 分線形狀用的切面線
  // 用「通過 a、b、法線 planeN」的平面切頭皮，回傳 a 到 b 那一段交線（抬高 OFFSET 的密集點）。
  // 兩個方向都走得到就取短的那一邊；走不到（中間跑出可畫範圍）回 null。planeN 要和 a→b 垂直（平面真的通過兩點）。
  planeLine(a, b, planeN) {
    const hs = this.nearest(a), he = this.nearest(b);
    if (hs.point.distanceTo(he.point) < 1e-5) return null;
    const cut = this._planeCut(hs.point, hs.faceIndex, he.point, he.faceIndex, planeN);
    if (!cut) return null;
    const out = [];
    let last = null;
    for (const c of cut) {
      if (last && c.p.distanceTo(last) < 1e-6) continue;
      last = c.p;
      out.push(c.p.clone().addScaledVector(this._smoothNormal(c.tri, c.p), OFFSET));
    }
    return out.length >= 2 ? out : null;
  }

  // 從表面上一點 origin 出發，沿「通過 origin、法線 planeN」的平面往兩個方向各走一趟。
  // 回傳最多兩段，每段是 [{ p, tri }]（從 origin 開始、沒抬高），另外帶 length_（走了多長）、closed（繞一圈回到起點）、stopped（被 stop 喊停）。
  // 停下來的時機：走滿 maxLen（最後一點剛好停在 maxLen）、stop(p) 說這一點不要（不含這一點）、走到可畫範圍的邊、繞回起點。
  planeRuns(origin, planeN, { maxLen = 0.6, stop = null } = {}) {
    const hs = this.nearest(origin), S = hs.point, sTri = hs.faceIndex;
    const edges = this._edges(), pos = this._pos;
    const dOf = i => { const d = planeN.dot(_p.fromBufferAttribute(pos, i).sub(S)); return Math.abs(d) < 1e-9 ? 1e-9 : d; };
    const cross = (i, j) => { const di = dOf(i), dj = dOf(j); const u = di / (di - dj); return _a.fromBufferAttribute(pos, i).clone().lerp(_b.fromBufferAttribute(pos, j), u); };
    const crossings = (tri, fromKey) => {
      const [a, b, c] = this._triVerts(tri), out = [];
      for (const [i, j] of [[a, b], [b, c], [c, a]]) {
        const k = this._edgeKey(i, j);
        if (k === fromKey) continue;
        if ((dOf(i) >= 0) !== (dOf(j) >= 0)) out.push({ k, p: cross(i, j) });
      }
      return out;
    };
    const runs = [];
    for (const first of crossings(sTri, -1)) {
      const out = [{ p: S.clone(), tri: sTri }];
      let tri = sTri, next = first, len = 0, closed = false, stopped = false;
      for (let step = 0; step < 20000; step++) {
        const prev = out[out.length - 1].p, seg = next.p.distanceTo(prev);
        if (len + seg >= maxLen) { if (seg > 1e-9) out.push({ p: prev.clone().lerp(next.p, (maxLen - len) / seg), tri }); len = maxLen; break; }
        if (stop && stop(next.p)) { stopped = true; break; }
        len += seg;
        const nb = edges.get(next.k), other = nb ? nb.find(t => t !== tri) : undefined;
        if (other === undefined) { out.push({ p: next.p, tri }); break; } // 可畫範圍的邊：最後一點在邊上
        out.push({ p: next.p, tri: other }); tri = other;
        if (tri === sTri) { closed = true; break; }
        const c = crossings(tri, next.k);
        if (!c.length) break;
        next = c[0];
      }
      out.length_ = len; out.closed = closed; out.stopped = stopped; // stopped＝是 stop() 喊停的（例如走到外輪廓）
      runs.push(out);
    }
    return runs;
  }

  // 可畫範圍的邊＝只屬於一個三角形的邊。回傳 { edges: [[i, j]], next: Map(頂點 → 相鄰的邊界頂點) }
  _boundary() {
    const map = this._edges();
    if (this._boundaryCache && this._boundaryCache.map === map) return this._boundaryCache;
    const V = this._pos.count, edges = [], next = new Map();
    const link = (a, b) => { const l = next.get(a); if (l) l.push(b); else next.set(a, [b]); };
    for (const [k, tris] of map) { if (tris.length !== 1) continue; const i = Math.floor(k / V), j = k % V; edges.push([i, j]); link(i, j); link(j, i); }
    return this._boundaryCache = { map, edges, next };
  }
  // 沿切面走到可畫範圍的邊（end，planeRuns 停下來的那一點）之後：順著那條邊走，走到「邊再碰到同一片切面」的地方。
  // 耳朵那一塊不能畫；水平分線走到耳朵上緣就停了，其實切面在耳朵後面還會回到可以畫的地方——這裡找的就是那一點。
  // planeN、planePoint＝那片切面；dir＝走過來的方向（再碰到切面的點要在前面，不是退回去）。兩個方向都試，取短的。
  // 回傳 { path: [Vector3]（沿邊走過的點，不含 end，最後一點就是再碰到切面的那一點）, point, length }；maxLen 內碰不到回 null。
  boundaryHop(end, planeN, planePoint, dir, maxLen = 0.08) {
    const B = this._boundary(), pos = this._pos, P = i => new Vector3().fromBufferAttribute(pos, i), _q = new Vector3();
    const dOf = p => planeN.dot(_p.copy(p).sub(planePoint));
    let start = null, bd = Infinity;
    for (const [i, j] of B.edges) {
      const a = P(i), ab = P(j).sub(a), L = ab.lengthSq(), u = L ? Math.max(0, Math.min(1, _q.copy(end).sub(a).dot(ab) / L)) : 0, d = a.addScaledVector(ab, u).distanceTo(end);
      if (d < bd) { bd = d; start = [i, j]; }
    }
    if (!start || bd > 1e-4) return null; // end 不在邊上
    let best = null;
    for (const [from, to] of [start, [start[1], start[0]]]) {
      const path = []; let a = from, b = to, len = 0, last = end.clone();
      for (let step = 0; step < 4000; step++) {
        const pa = P(a), pb = P(b);
        if (step > 0) { // 第一條邊就是停下來的那一條（它碰到切面的地方就是 end）
          const da = dOf(pa), db = dOf(pb);
          if ((da >= 0) !== (db >= 0)) {
            const x = pa.lerp(pb, da / (da - db)); len += last.distanceTo(x);
            if (len <= maxLen && _q.copy(x).sub(end).dot(dir) > 1e-4 && (!best || len < best.length)) { path.push(x); best = { path, point: x, length: len }; } // 要在前面（邊上的缺口可以不到 1 mm，所以門檻只有 0.1 mm）
            break;
          }
        }
        len += last.distanceTo(pb); if (len > maxLen) break;
        path.push(pb); last = pb;
        const nb = (B.next.get(b) || []).filter(v => v !== a); if (!nb.length) break;
        a = b; b = nb[0];
      }
    }
    return best;
  }

  // 一個空間點貼回表面：離表面 2.5 cm 內用最近點（後腦、頸側也準），太深（貝茲弦垂進頭裡）才用從頭心射出的方向。
  _settle(p) {
    const near = this.nearest(p);
    if (near.distance < 0.025) return near;
    return this.radial(p) || near;
  }

  // 拉彎的直線：二次貝茲 S、C、E 取樣後逐點貼回表面。control（C）是 3D 控制點（彎度點 M=(S+2C+E)/4）。
  bent(a, b, control) {
    const S = this.nearest(a).point, E = this.nearest(b).point, C = toV(control);
    const n = Math.max(MIN_STEPS * 2, Math.ceil(quadLength(S, C, E) / STEP));
    const out = [];
    for (let i = 0; i <= n; i++) out.push(this._lift(this._settle(quadPoint(S, C, E, i / n))));
    out[0] = this._lift(this.nearest(S)); out[out.length - 1] = this._lift(this.nearest(E));
    return out;
  }

  // 直線：沒拉彎走 geodesic，拉彎走 bent。
  line(a, b, control = null) { return control ? this.bent(a, b, control) : this.geodesic(a, b); }

  // 曲線：通過每個控制點的 Catmull-Rom；每一段可以有一個彎度點 bends[i]（表面上的點），有就當成多一個通過點插在那一段中間。
  // 用 CatmullRom 而不是分段貝茲，是因為多點曲線就是靠通過點定形狀，加一個通過點最簡單也最平滑。
  curveWithBends(controls, bends = [], closed = false) {
    const pts = controls.map(c => this.nearest(c).point);
    if (pts.length < 2) throw new Error('違う点が2つ以上必要です。');
    if (pts.length === 2 && !closed) return bends[0] ? this.bent(pts[0], pts[1], controlFromHandle(pts[0], pts[1], this.nearest(bends[0]).point)) : this.geodesic(pts[0], pts[1]);
    const through = [];
    const segs = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < pts.length; i++) {
      through.push(pts[i]);
      if (i < segs && bends[i]) through.push(this.nearest(bends[i]).point);
    }
    return this.curve(through, closed);
  }
}
