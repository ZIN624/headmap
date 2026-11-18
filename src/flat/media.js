// SPDX-License-Identifier: AGPL-3.0-only
// 照片、自己的底圖、首頁縮圖存在瀏覽器的 IndexedDB（localStorage 放不下圖片）。另外是輸出用的小工具：PDF（每頁一張 JPEG）與 ZIP（不壓縮）。
import { newId } from './shapes.js';

const DB_NAME = 'head3d.media', STORE = 'files';
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error || new Error('IndexedDB を開けません'));
  });
  return dbp;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, mode), st = t.objectStore(STORE), r = fn(st);
    t.oncomplete = () => res(r && 'result' in r ? r.result : undefined);
    t.onerror = () => rej(t.error || new Error('IndexedDB の読み書きに失敗しました'));
  });
}
export const media = {
  get: id => tx('readonly', st => st.get(id)).then(v => v || null),
  put: (id, blob) => tx('readwrite', st => st.put(blob, id)),
  del: id => tx('readwrite', st => st.delete(id)),
  // 圖片檔縮到長邊 maxSide 以內、存成 JPEG，回傳新的 id
  async addImage(file, maxSide = 1600) {
    const blob = await downscale(file, maxSide);
    const id = 'img-' + newId();
    await media.put(id, blob);
    return id;
  },
  async dataUrl(id) { const b = await media.get(id); return b ? blobToDataUrl(b) : null; },
  async putDataUrl(id, url) { await media.put(id, dataUrlToBlob(url)); },
};
// data:…;base64,… → Blob（自己解碼，不用 fetch：網站的安全設定不讓 fetch 讀 data: 網址）
export function dataUrlToBlob(url) {
  const m = /^data:([^;,]+);base64,(.*)$/.exec(url);
  if (!m) throw new Error('画像データではありません');
  const bin = atob(m[2]), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: m[1] });
}
export function blobToDataUrl(b) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); }); }
export async function downscale(file, maxSide) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height)), w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close && bmp.close();
  return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('画像を変換できません'))), 'image/jpeg', 0.86));
}
export async function loadImage(blob) {
  const url = URL.createObjectURL(blob);
  try { const img = new Image(); img.src = url; await img.decode(); return img; } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

// ---------------------------------------------------------------- PDF：pages＝[{ jpeg: Uint8Array, w, h（像素）, pw, ph（頁面大小，pt）}]
export function buildPdf(pages, title = '') {
  const enc = new TextEncoder(), parts = [], offsets = [];
  let size = 0;
  const push = x => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); size += b.length; };
  const obj = (n, body) => { offsets[n] = size; push(n + ' 0 obj\n'); for (const b of [].concat(body)) push(b); push('\nendobj\n'); };
  push('%PDF-1.4\n%âãÏÓ\n');
  const n = pages.length, kids = pages.map((_, i) => (4 + i * 3) + ' 0 R').join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  const hex = s => '<FEFF' + [...s].map(ch => { const c = ch.codePointAt(0); return c > 0xffff ? '' : c.toString(16).padStart(4, '0').toUpperCase(); }).join('') + '>';
  obj(3, `<< /Title ${hex(title)} /Producer ${hex('カット図')} >>`);
  pages.forEach((p, i) => {
    const page = 4 + i * 3, img = page + 1, content = page + 2;
    obj(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.pw} ${p.ph}] /Resources << /XObject << /Im0 ${img} 0 R >> >> /Contents ${content} 0 R >>`);
    obj(img, [`<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`, p.jpeg, '\nendstream']);
    const draw = `q ${p.pw} 0 0 ${p.ph} 0 0 cm /Im0 Do Q`;
    obj(content, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
  });
  const total = 4 + n * 3, xref = size;
  let x = 'xref\n0 ' + total + '\n0000000000 65535 f \n';
  for (let k = 1; k < total; k++) x += String(offsets[k]).padStart(10, '0') + ' 00000 n \n';
  push(x + `trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

// ---------------------------------------------------------------- ZIP（不壓縮）：files＝[{ name, data: Uint8Array }]
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(d) { let c = 0xffffffff; for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function buildZip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  const now = new Date(), dt = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff, dd = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), len = f.data.length;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, dt, true); h.setUint16(12, dd, true); h.setUint32(14, crc, true); h.setUint32(18, len, true); h.setUint32(22, len, true);
    h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    parts.push(new Uint8Array(h.buffer), name, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, dt, true); c.setUint16(14, dd, true); c.setUint32(16, crc, true); c.setUint32(20, len, true); c.setUint32(24, len, true);
    c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + len;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: 'application/zip' });
}
