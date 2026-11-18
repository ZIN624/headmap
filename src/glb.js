// SPDX-License-Identifier: AGPL-3.0-only
// 迷你 GLB 讀取器：只處理頭模用到的格式（三角形網格、float32 位置、uint16/uint32 索引、沒有材質與動畫）。瀏覽器與 Node 共用。
// 回傳 { name: { positions: Float32Array（世界座標，已套用節點變換）, normals: Float32Array|null, indices: Uint32Array, min, max, ear: Uint8Array|null } }。
import { Matrix4, Vector3, Quaternion } from '../vendor/three/build/three.module.js';

const COMPONENT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function parseGlb(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  if (dv.getUint32(0, true) !== 0x46546C67) throw new Error('GLB ファイルではありません');
  const total = dv.getUint32(8, true);
  let offset = 12, json = null, bin = null;
  while (offset < total) {
    const len = dv.getUint32(offset, true), type = dv.getUint32(offset + 4, true);
    const chunk = arrayBuffer.slice(offset + 8, offset + 8 + len);
    if (type === 0x4E4F534A) json = JSON.parse(new TextDecoder().decode(chunk));
    else if (type === 0x004E4942) bin = chunk;
    offset += 8 + len;
  }
  if (!json || !bin) throw new Error('GLB に JSON または BIN のブロックがありません');
  return { json, bin };
}

function readAccessor(json, bin, index) {
  const acc = json.accessors[index];
  const view = json.bufferViews[acc.bufferView];
  const Type = COMPONENT[acc.componentType], n = SIZE[acc.type];
  const start = (view.byteOffset || 0) + (acc.byteOffset || 0);
  const stride = view.byteStride || 0;
  const out = new Type(acc.count * n);
  if (!stride || stride === n * Type.BYTES_PER_ELEMENT) {
    out.set(new Type(bin, start, acc.count * n));
  } else {
    const dv = new DataView(bin);
    const get = { Float32Array: 'getFloat32', Uint16Array: 'getUint16', Uint32Array: 'getUint32', Int16Array: 'getInt16', Uint8Array: 'getUint8', Int8Array: 'getInt8' }[Type.name];
    for (let i = 0; i < acc.count; i++) for (let k = 0; k < n; k++) out[i * n + k] = dv[get](start + i * stride + k * Type.BYTES_PER_ELEMENT, true);
  }
  return out;
}

function nodeMatrix(node) {
  const m = new Matrix4();
  if (node.matrix) return m.fromArray(node.matrix);
  const t = new Vector3().fromArray(node.translation || [0, 0, 0]);
  const q = new Quaternion().fromArray(node.rotation || [0, 0, 0, 1]);
  const s = new Vector3().fromArray(node.scale || [1, 1, 1]);
  return m.compose(t, q, s);
}

export function loadMeshes(arrayBuffer) {
  const { json, bin } = parseGlb(arrayBuffer);
  const result = {};
  const visit = (index, parent) => {
    const node = json.nodes[index];
    const world = parent.clone().multiply(nodeMatrix(node));
    if (node.mesh !== undefined) {
      const mesh = json.meshes[node.mesh];
      const prim = mesh.primitives[0];
      if ((prim.mode ?? 4) !== 4) throw new Error(`${node.name}：三角形のメッシュにしか対応していません`);
      const positions = readAccessor(json, bin, prim.attributes.POSITION);
      const normals = prim.attributes.NORMAL !== undefined ? readAccessor(json, bin, prim.attributes.NORMAL) : null;
      let indices = prim.indices !== undefined ? readAccessor(json, bin, prim.indices) : null;
      if (!indices) { indices = new Uint32Array(positions.length / 3); for (let i = 0; i < indices.length; i++) indices[i] = i; }
      if (!(indices instanceof Uint32Array)) indices = Uint32Array.from(indices);
      const v = new Vector3();
      const normalMatrix = world.clone().invert().transpose();
      for (let i = 0; i < positions.length; i += 3) {
        v.set(positions[i], positions[i + 1], positions[i + 2]).applyMatrix4(world);
        positions[i] = v.x; positions[i + 1] = v.y; positions[i + 2] = v.z;
        if (normals) { v.set(normals[i], normals[i + 1], normals[i + 2]).applyMatrix4(normalMatrix).normalize(); normals[i] = v.x; normals[i + 1] = v.y; normals[i + 2] = v.z; }
      }
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], positions[i + k]); max[k] = Math.max(max[k], positions[i + k]); }
      // 耳殼頂點遮罩存在 mesh.extras.ear_bits（base64 位元組，每頂點 1 bit、低位在前）；網格沒帶就是 null。
      let ear = null;
      if (mesh.extras && typeof mesh.extras.ear_bits === 'string') {
        const raw = typeof atob === 'function' ? Uint8Array.from(atob(mesh.extras.ear_bits), c => c.charCodeAt(0)) : Uint8Array.from(Buffer.from(mesh.extras.ear_bits, 'base64'));
        ear = new Uint8Array(positions.length / 3);
        for (let i = 0; i < ear.length; i++) ear[i] = (raw[i >> 3] >> (i & 7)) & 1;
      }
      result[node.name || mesh.name] = { positions, normals, indices, min, max, ear };
    }
    for (const c of node.children || []) visit(c, world);
  };
  const scene = json.scenes[json.scene ?? 0];
  for (const n of scene.nodes) visit(n, new Matrix4());
  return result;
}
