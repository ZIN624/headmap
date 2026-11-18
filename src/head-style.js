// SPDX-License-Identifier: AGPL-3.0-only
// 頭模的外觀：無貼圖的霧面瓷白塑像。只管呈現（材質與燈光），不影響幾何。
// 顏色是 sRGB；燈光固定於場景，轉頭時仍能讀出額頭、顳部與耳根的曲面。
const HEAD_MATERIALS = Object.freeze({
  HD_HEAD_BASE: Object.freeze({ color: 0xf0ede7, roughness: 0.84, metalness: 0 }),
  HD_EYES: Object.freeze({ color: 0xe6e3dd, roughness: 0.9, metalness: 0 }),
  // 胸像接在脖子底下；和頭相接的地方必須同材質，否則接縫會出現一條水平色帶。
  HD_BUST: Object.freeze({ color: 0xf0ede7, roughness: 0.84, metalness: 0 }),
});

const HEAD_LIGHTS = Object.freeze([
  Object.freeze({ type: 'hemisphere', sky: 0xffffff, ground: 0xc4cbd5, intensity: 1.65 }),
  Object.freeze({ type: 'directional', color: 0xffffff, intensity: 1.65, position: [0.6, 0.9, 0.85] }),
  Object.freeze({ type: 'directional', color: 0xe9efff, intensity: 0.55, position: [-0.7, 0.2, 0.65] }),
  Object.freeze({ type: 'directional', color: 0xffffff, intensity: 0.8, position: [-0.25, 0.7, -0.8] }),
]);

export function headMaterialOptions(name) {
  return { ...(HEAD_MATERIALS[name] || HEAD_MATERIALS.HD_HEAD_BASE) };
}

export function addHeadStudioLights(THREE, scene) {
  return HEAD_LIGHTS.map(spec => {
    const light = spec.type === 'hemisphere'
      ? new THREE.HemisphereLight(spec.sky, spec.ground, spec.intensity)
      : new THREE.DirectionalLight(spec.color, spec.intensity);
    if (spec.position) light.position.fromArray(spec.position);
    light.name = spec.type === 'hemisphere' ? 'head-studio-ambient' : 'head-studio-key-fill-rim';
    scene.add(light);
    return light;
  });
}
