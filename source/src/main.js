// ============================================================================
// renderer, camera and input
// ============================================================================
const $ = (id) => document.getElementById(id);
const canvas = $('c'), info = $('i'), body = document.body;
// a phone held upright gets the page turned on its side (see template.html)
const rot = matchMedia('(orientation:portrait) and (pointer:coarse)');
// loading bar: each stage glides it to `to` (the share done) over ~`ms` on the compositor, so it moves while this
// thread is busy
let loaded = 0, dead; // dead: the graphics device was lost
const reportLoadingProgress = (m, to, ms) => {
  if (!dead) $('s').textContent = m;
  const a = $('b').animate({ transform: [`scaleX(${loaded})`, `scaleX(${to})`] }, { duration: ms, fill: 'forwards', easing: 'cubic-bezier(.3,.5,.5,1)' });
  loaded = to;
  // go on once the animation runs: one not started before the thread gets busy stays stuck (timer: hidden tabs)
  return new Promise((r) => { a.ready.then(() => setTimeout(r)); setTimeout(r, document.hidden ? 0 : 1e3); });
};
const failStartup = (m) => { throw new Error(m, { cause: 1 }); }; // cause marks a message that is shown as it is
if (!navigator.gpu) failStartup('This scene needs WebGPU. Try a current Chrome or Edge.');
const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter) failStartup('No WebGPU adapter found.');
$('w').hidden = !!navigator.userAgentData; // only Chromium-based browsers have it
const supportsGpuTimestamps = adapter.features.has('timestamp-query');
const device = await adapter.requestDevice({ requiredFeatures: supportsGpuTimestamps ? ['timestamp-query'] : [] });
device.addEventListener('uncapturederror', (e) => console.error('GPU: ' + e.error.message));
// out of memory or a GPU timeout: reload a level lower, or on Low reportLoadingProgress what happened
device.lost.then((l) => {
  if (l.reason === 'destroyed') return; // the page is closing
  if (LV < 2) { keep('abyssal', LV + 1); location.reload(); }
  dead = body.className = 'l e'; $('s').textContent = 'The graphics device was lost. Reload the page to try again.';
});
const gpuCanvasContext = canvas.getContext('webgpu'), CANVAS_FORMAT = navigator.gpu.getPreferredCanvasFormat();
// Rendering targets use linear half-float HDR_COLOR_FORMAT color and a 32-bit depth buffer.
const gpuQueue = device.queue, HDR_COLOR_FORMAT = 'rgba16float', DEPTH_FORMAT = 'depth32float';
const TEXTURE_USAGE = GPUTextureUsage, BUFFER_USAGE = GPUBufferUsage, SHADER_STAGE = GPUShaderStage;

// Allocate an uploadable GPU buffer. WebGPU requires 4-byte-aligned buffer sizes.
// Copying the data here means callers can release their CPU-side arrays after setup.
function uploadGpuBuffer(data, usage) {
  const alignedByteLength = (data.byteLength + 3) & ~3;
  const gpuBuffer = device.createBuffer({
    size: alignedByteLength,
    usage: usage | BUFFER_USAGE.COPY_DST,
  });
  gpuQueue.writeBuffer(gpuBuffer, 0, data.buffer || data, data.byteOffset || 0, data.byteLength);
  return gpuBuffer;
}

function createGpuTexture(width, height, format, usage, options = {}) {
  return device.createTexture({
    size: [width, height, options.d || 1],
    format,
    usage,
    mipLevelCount: options.mips || 1,
    sampleCount: options.samples || 1,
    dimension: options.d ? '3d' : '2d',
  });
}

function createShaderModule(code) {
  return device.createShaderModule({ code });
}

// ---------------------------------------------------------------- static resources
const repeatSampler = device.createSampler({ addressModeU: 'repeat', addressModeV: 'repeat', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy: LV > 1 ? 1 : 8 });
const clampSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
const shadowComparisonSampler = device.createSampler({ compare: 'less-equal', magFilter: 'linear', minFilter: 'linear' });
const shadowTexture = createGpuTexture(SHADOW, SHADOW, DEPTH_FORMAT, TEXTURE_USAGE.RENDER_ATTACHMENT | TEXTURE_USAGE.TEXTURE_BINDING);
const tDummy = createGpuTexture(1, 1, DEPTH_FORMAT, TEXTURE_USAGE.RENDER_ATTACHMENT | TEXTURE_USAGE.TEXTURE_BINDING);
const waterTexture = createGpuTexture(WATER, WATER, HDR_COLOR_FORMAT, TEXTURE_USAGE.RENDER_ATTACHMENT | TEXTURE_USAGE.TEXTURE_BINDING, { mips: 5 });
const detailTexture = createGpuTexture(1024, 1024, 'rgba8unorm', TEXTURE_USAGE.RENDER_ATTACHMENT | TEXTURE_USAGE.TEXTURE_BINDING, { mips: 11 });
const occlusionVolumeTexture = createGpuTexture(NX / 2, NY / 2, 'rg8unorm', TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.COPY_DST, { d: NZ / 2 });
const mapTexture = createGpuTexture(512, 512, 'rgba8unorm', TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.COPY_DST);

const sceneUniformValues = new Float32Array(60), shadowUniformValues = new Float32Array(60);
const sceneUniformBuffer = device.createBuffer({ size: 240, usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST }), shadowUniformBuffer = device.createBuffer({ size: 240, usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST });
const waterUniformValues = new Float32Array(4), waterUniformBuffer = device.createBuffer({ size: 16, usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST });

const VF = SHADER_STAGE.VERTEX | SHADER_STAGE.FRAGMENT;
const sceneBindGroupLayout = device.createBindGroupLayout({ entries: [
  { binding: 0, visibility: VF, buffer: {} },
  { binding: 1, visibility: VF, sampler: {} }, { binding: 2, visibility: VF, sampler: {} }, { binding: 3, visibility: VF, sampler: { type: 'comparison' } },
  { binding: 4, visibility: VF, texture: { sampleType: 'depth' } },
  { binding: 5, visibility: VF, texture: {} }, { binding: 6, visibility: VF, texture: {} },
  { binding: 7, visibility: VF, texture: { viewDimension: '3d' } }, { binding: 8, visibility: VF, texture: {} }] });
const createSceneBindGroup = (u, sh) => device.createBindGroup({ layout: sceneBindGroupLayout, entries: [
  { binding: 0, resource: { buffer: u } }, { binding: 1, resource: repeatSampler }, { binding: 2, resource: clampSampler }, { binding: 3, resource: shadowComparisonSampler },
  { binding: 4, resource: sh.createView() }, { binding: 5, resource: waterTexture.createView() }, { binding: 6, resource: detailTexture.createView() },
  { binding: 7, resource: occlusionVolumeTexture.createView() }, { binding: 8, resource: mapTexture.createView() }] });
const sceneBindGroup = createSceneBindGroup(sceneUniformBuffer, shadowTexture), shadowBindGroup = createSceneBindGroup(shadowUniformBuffer, tDummy);
const scenePipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [sceneBindGroupLayout] });

const bglBlit = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: SHADER_STAGE.FRAGMENT, texture: {} }, { binding: 1, visibility: SHADER_STAGE.FRAGMENT, sampler: {} }] });
const plBlit = device.createPipelineLayout({ bindGroupLayouts: [bglBlit] });
const blitShader = createShaderModule(W_BLIT);
const createBlitPipeline = (entry, format, add) => device.createRenderPipeline({ layout: plBlit, vertex: { module: blitShader, entryPoint: 'vs' },
  fragment: { module: blitShader, entryPoint: entry, targets: [{ format, blend: add ? { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } } : undefined }] } });
const detailMipmapPipeline = createBlitPipeline('fsMip', 'rgba8unorm'), waterMipmapPipeline = createBlitPipeline('fsMip', HDR_COLOR_FORMAT), firstBloomDownsamplePipeline = createBlitPipeline('fsDown0', HDR_COLOR_FORMAT), bloomDownsamplePipeline = createBlitPipeline('fsDown', HDR_COLOR_FORMAT), bloomUpsamplePipeline = createBlitPipeline('fsUp', HDR_COLOR_FORMAT, true);
const createBlitBindGroup = (view) => device.createBindGroup({ layout: bglBlit, entries: [{ binding: 0, resource: view }, { binding: 1, resource: clampSampler }] });
const createColorAttachment = (view, clear) => ({ view, loadOp: clear ? 'clear' : 'load', storeOp: 'store', clearValue: [0, 0, 0, 0] });

// Vertex layouts define the exact CPU/GPU contract.
// Packed normals are SNORM8; mesh instances use 3 vec4s (48 bytes).
// Procedural leaves use three instanced attributes (36 bytes), not mesh
// vertices for every blade. The vertex shader expands the blades at draw time.
// ---------------------------------------------------------------- vertex layouts
const A = (shaderLocation, offset, format) => ({ shaderLocation, offset, format });
const vbSolid = { arrayStride: 16, attributes: [A(0, 0, 'float32x3'), A(1, 12, 'snorm8x4')] };
const ibSolid = { arrayStride: 48, stepMode: 'instance', attributes: [A(2, 0, 'float32x4'), A(3, 16, 'float32x4'), A(4, 32, 'float32x4')] };
const ibLeaf = { arrayStride: 36, stepMode: 'instance', attributes: [A(0, 0, 'float32x4'), A(1, 16, 'float32x4'), A(2, 32, 'unorm8x4')] };
const ibAnim = { arrayStride: 32, stepMode: 'instance', attributes: [A(2, 0, 'float32x4'), A(3, 16, 'float32x4')] };
const ibBub = { arrayStride: 32, stepMode: 'instance', attributes: [A(0, 0, 'float32x4'), A(1, 16, 'float32x4')] };
const ibSnow = { arrayStride: 16, stepMode: 'instance', attributes: [A(0, 0, 'float32x4')] };

const createScenePipeline = (m, vsE, fsE, buffers, o = {}) => device.createRenderPipeline({ layout: scenePipelineLayout,
  vertex: { module: m, entryPoint: vsE, buffers, constants: o.constants },
  fragment: { module: m, entryPoint: fsE, targets: [{ format: HDR_COLOR_FORMAT, blend: o.blend }] },
  primitive: { topology: o.strip ? 'triangle-strip' : 'triangle-list', cullMode: o.cull || 'none' },
  depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: !o.blend, depthCompare: 'greater' }, multisample: { count: AA } });
const createShadowPipeline = (m, vsE, buffers, o = {}) => device.createRenderPipeline({ layout: scenePipelineLayout,
  vertex: { module: m, entryPoint: vsE, buffers, constants: o.constants },
  primitive: { topology: o.strip ? 'triangle-strip' : 'triangle-list', cullMode: o.cull || 'none' },
  depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 1.5 } });

await reportLoadingProgress('Compiling shaders…', 0.05, 300);
const solidShader = createShaderModule(W_SOLID), leafShader = createShaderModule(W_LEAF), animalShader = createShaderModule(W_ANIM), surfaceShader = createShaderModule(W_SURF), particleShader = createShaderModule(W_SPR);
const terrainPipeline = createScenePipeline(solidShader, 'vs', 'fs', [vbSolid, ibSolid], { cull: 'back' });
const solidPipeline = createScenePipeline(solidShader, 'vs', 'fs', [vbSolid, ibSolid]);
const nearKelpPipeline = createScenePipeline(leafShader, 'vs', 'fs', [ibLeaf], { strip: true, constants: { ROWS: 9 } });
const midKelpPipeline = createScenePipeline(leafShader, 'vs', 'fs', [ibLeaf], { strip: true, constants: { ROWS: 5 } });
const smallPlantPipeline = createScenePipeline(leafShader, 'vs', 'fs', [ibLeaf], { strip: true, constants: { ROWS: 3, FAR: 70 } });
const farKelpPipeline = createScenePipeline(leafShader, 'vs', 'fs', [ibLeaf], { strip: true, constants: { ROWS: 3 } });
const fishPipeline = createScenePipeline(animalShader, 'vsFish', 'fsFish', [vbSolid, ibAnim]);
const mantaPipeline = createScenePipeline(animalShader, 'vsManta', 'fsManta', [vbSolid, ibAnim]);
const waterSurfacePipeline = createScenePipeline(surfaceShader, 'vs', 'fs', [], { strip: true }), backgroundPipeline = createScenePipeline(surfaceShader, 'vsB', 'fsB', [], { strip: true });
const bubblePipeline = createScenePipeline(particleShader, 'vsBub', 'fsBub', [ibBub], { strip: true, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } });
const ADD = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } };
const snowPipeline = createScenePipeline(particleShader, 'vsSnow', 'fsSnow', [ibSnow], { strip: true, blend: ADD });
const glintPipeline = createScenePipeline(leafShader, 'vsGl', 'fsGl', [ibBub], { strip: true, blend: ADD, constants: { ROWS: 7 } });
const solidShadowPipeline = createShadowPipeline(solidShader, 'vs', [vbSolid, ibSolid]), terrainShadowPipeline = createShadowPipeline(solidShader, 'vs', [vbSolid, ibSolid], { cull: 'front' });
const leafShadowPipeline = createShadowPipeline(leafShader, 'vs', [ibLeaf], { strip: true, constants: { ROWS: 3 } });

const waterShader = createShaderModule(W_WATER);
const waterAnimationPipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module: waterShader, entryPoint: 'vs' }, fragment: { module: waterShader, entryPoint: 'fs', targets: [{ format: HDR_COLOR_FORMAT }] } });
const bgWater = device.createBindGroup({ layout: waterAnimationPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: waterUniformBuffer } }] });
const waterViews = [0, 1, 2, 3, 4].map((m) => waterTexture.createView({ baseMipLevel: m, mipLevelCount: 1 }));
const waterBG = waterViews.map((v) => createBlitBindGroup(v));
const waterPass = waterViews.map((v) => ({ colorAttachments: [createColorAttachment(v, true)] }));

const rayShader = createShaderModule(W_RAYS), compositeShader = createShaderModule(W_POST), rayBlurShader = createShaderModule(W_RBLUR);
const rayBlurPipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module: rayBlurShader, entryPoint: 'vs' }, fragment: { module: rayBlurShader, entryPoint: 'fs', targets: [{ format: HDR_COLOR_FORMAT }] } });
const volumetricRayPipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module: rayShader, entryPoint: 'vs' }, fragment: { module: rayShader, entryPoint: 'fs', targets: [{ format: HDR_COLOR_FORMAT }] } });
const finalCompositePipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module: compositeShader, entryPoint: 'vs' }, fragment: { module: compositeShader, entryPoint: 'fs', targets: [{ format: CANVAS_FORMAT }] } });

// ---------------------------------------------------------------- sun + shadow matrix
const SUN = (() => { const v = [0.27, 1, -0.24], l = hypot(...v); return v.map((c) => c / l); })();
{
  const L = SUN, lr = [L[1], -L[0], 0], ll = hypot(...lr); lr[0] /= ll; lr[1] /= ll;
  const lu = [L[1] * lr[2] - L[2] * lr[1], L[2] * lr[0] - L[0] * lr[2], L[0] * lr[1] - L[1] * lr[0]];
  const R = 225, d0 = -175, d1 = 125, m = shadowUniformValues;
  m[0] = lr[0] / R; m[4] = lr[1] / R; m[8] = lr[2] / R; m[12] = 0;
  m[1] = lu[0] / R; m[5] = lu[1] / R; m[9] = lu[2] / R; m[13] = 0;
  m[2] = -L[0] / (d1 - d0); m[6] = -L[1] / (d1 - d0); m[10] = -L[2] / (d1 - d0); m[14] = d1 / (d1 - d0);
  m[3] = 0; m[7] = 0; m[11] = 0; m[15] = 1;
  for (let i = 0; i < 16; i++) { shadowUniformValues[16 + i] = m[i]; sceneUniformValues[16 + i] = m[i]; }
  for (let i = 0; i < 3; i++) { sceneUniformValues[48 + i] = shadowUniformValues[48 + i] = SUN[i]; }
  shadowUniformValues[32] = 0; shadowUniformValues[33] = -20; shadowUniformValues[34] = 0; shadowUniformValues[35] = 0; shadowUniformValues[58] = 1;
  gpuQueue.writeBuffer(shadowUniformBuffer, 0, shadowUniformValues);
}

// ---------------------------------------------------------------- world generation
await reportLoadingProgress('Sculpting the seabed…', 0.25, 1200);
// marks a load in progress (quality.js); leaving the page before it ends is not a crash
keep('abyssalLoad', 1);
addEventListener('pagehide', () => keep('abyssalLoad', ''));
let D;
{
  const prims = packTerrainPrimitives();
  const m = createShaderModule(W_DENS), p = device.createComputePipeline({ layout: 'auto', compute: { module: m, entryPoint: 'main' } });
  const size = NX * NY * NZ * 4;
  const u = new ArrayBuffer(48), uu = new Uint32Array(u), uf = new Float32Array(u);
  uu[0] = NX; uu[1] = NY; uu[2] = NZ; uf[4] = OX; uf[5] = OY; uf[6] = OZ; uf[7] = VS;
  uu[8] = MESAS.length; uu[9] = ARCHES.length; uu[10] = HOLES.length; uu[11] = CLEARS.length;
  const bu = uploadGpuBuffer(new Uint8Array(u), BUFFER_USAGE.UNIFORM), bp = uploadGpuBuffer(prims, BUFFER_USAGE.STORAGE);
  const bd = device.createBuffer({ size, usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_SRC }), br = device.createBuffer({ size, usage: BUFFER_USAGE.MAP_READ | BUFFER_USAGE.COPY_DST });
  const bg = device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: bu } }, { binding: 1, resource: { buffer: bd } }, { binding: 2, resource: { buffer: bp } }] });
  const e = device.createCommandEncoder(), c = e.beginComputePass();
  c.setPipeline(p); c.setBindGroup(0, bg); c.dispatchWorkgroups(NX / 4, NY / 4, NZ / 4); c.end();
  e.copyBufferToBuffer(bd, 0, br, 0, size);
  gpuQueue.submit([e.finish()]);
  await br.mapAsync(GPUMapMode.READ);
  D = new Float32Array(br.getMappedRange().slice(0));
  br.unmap(); br.destroy(); bd.destroy();
  // rock connected to the seabed: each column's unbroken run up from the bottom is, and the rock above a gap
  // (overhangs, specks) is when it touches rock that is. What never connects is a speck of noise floating in
  // the water (surface nets would make it a small box), so it becomes water
  const S = NX * NY, R = new Uint8Array(D.length), O = [1, -1, NX, -NX, S, -S], b = new Uint8Array(NX), L = [];
  for (let i = 0; i < D.length;) { b.fill(1); for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++, i++) if (D[i] <= 0) b[x] = 0; else if (b[x]) R[i] = 1; else L.push(i); }
  for (let k = 1; k; L.reverse()) { k = 0; for (const i of L) if (!R[i] && O.some((o) => R[i + o])) R[i] = k = 1; }
  for (const i of L) if (!R[i]) D[i] = -D[i];
}
// Distance to the rock for resolveCameraCollisions(), in 1/127 m (> 0 in rock, clamped to ±1 m), kept only in the 4x4x4-voxel
// bricks near the surface within the camera's reach (~2 MB). collisionBrickLookup per brick: 0 all water, 1 all rock, n brick n-2 in collisionBrickData.
const collisionGridOffset = 52, collisionBrickCountPerAxis = 102, collisionBrickLookup = new Uint16Array(collisionBrickCountPerAxis * collisionBrickCountPerAxis * NY / 4);
let collisionBrickData = new Int8Array(64 * 65534);
{
  let n = 0;
  for (let bz = 0; bz < collisionBrickCountPerAxis; bz++) for (let by = 1; by < NY / 4 - 1; by++) for (let bx = 0; bx < collisionBrickCountPerAxis; bx++) {
    if (hypot(bx - collisionBrickCountPerAxis / 2 + 0.5, bz - collisionBrickCountPerAxis / 2 + 0.5) > 52) continue; // more than 156 m out: never reached
    let lo = 127, hi = -127;
    for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const i = collisionGridOffset + bx * 4 + x + NX * (by * 4 + y + NY * (collisionGridOffset + bz * 4 + z)), gz = D[i + NX * NY] - D[i - NX * NY];
      const gx = D[i + 1] - D[i - 1], g = D[i + NX] - D[i - NX], l = sqrt(gx * gx + g * g + gz * gz) / 1.5;
      const q = round(clamp(D[i] / max(l, 0.05), -1, 1) * 127);
      collisionBrickData[n * 64 + x + 4 * y + 16 * z] = q; if (q < lo) lo = q; if (q > hi) hi = q;
    }
    collisionBrickLookup[bx + collisionBrickCountPerAxis * (by + NY / 4 * bz)] = lo === hi && lo * lo === 16129 ? +(lo > 0) : (n++, n + 1);
  }
  collisionBrickData = collisionBrickData.slice(0, n * 64);
}
await reportLoadingProgress('Carving canyons…', 0.32, 400);
const T = extractTerrainMesh(D);

// preset viewpoints (position, look-at), keys 1-6; the world generator dresses the scene around them
const POSES = [
  [10, 1.3, 7, -9, -31, -10],
  [50, 1.3, 34, 58, -23, 8],
  [-26, 2.2, -100, 0, -9, -108],
  [-55, 1.5, -18, -60, -30, 8],
  [10, 1.2, -62, 6, -22, -90],
  [3, 1.6, 62, 1, -28, 100],
];
// 60 s camera path (position + look-at, Catmull-Rom): the world generator keeps it clear, dev.js flies along it
const FLY = new Float32Array([
  10, -42.2, 7, -9, -31, -10,
  7.5, -41.8, 5.5, -10, -31, -12,
  9, -40.5, 18, 17, -37, 42,
  22, -39.2, 40, 48, -36, 45,
  38, -39.2, 46, 57, -27, 18,
  50, -40.4, 35, 58, -24, 8,
  55, -39, 20, 60, -18, -10,
  58, -34, -12, 40, -26, -60,
  50, -30, -44, 10, -26, -80,
  30, -30, -70, 4, -28, -90,
  12, -38.5, -62, 6, -27, -90,
  -4, -36.5, -70, 0, -14, -100,
  -16, -37, -84, 0, -22, -108,
  -29, -38, -90, -44, -34, -60,
  -41, -38, -70, -56, -34, -40,
  -53, -38, -50, -60, -34, -20,
  -58, -38, -28, -60, -32, 0,
  -57, -38, -10, -60, -30, 16,
  -60, -38, 10, -50, -36, 40,
  -52, -37, 36, -20, -35, 44,
  -22, -38, 43, 4, -38, 52,
  -6, -39.2, 44.5, 4, -37, 70,
  3, -40.6, 53, 3, -35, 84,
  3, -41.5, 62, 1, -30, 100,
  4, -39, 76, 3, -22, 100,
]);
const FLYN = FLY.length / 6, FLYT = 60, LUTN = 1024, flyLUT = new Float32Array(LUTN + 1);
const flyPts = [];
// Performance: the hot camera path stores mutable state in one typed array.
// The index constants below make the packed layout explicit without allocating
// a new camera object (or several vectors) in every requestAnimationFrame.
// CX/CY/CZ: camera position; FX/FY/FZ: forward; RX/RZ: horizontal right;
// UX/UY/UZ: up; VX/VY/VZ: velocity; MX/MY/MZ: requested movement.
const F = new Float64Array(32), P6 = new Float64Array(6);
const CX = 0, CY = 1, CZ = 2, YAW = 3, PIT = 4, FX = 5, FY = 6, FZ = 7, RX = 8, RZ = 9, UX = 10, UY = 11, UZ = 12, VX = 13, VY = 14, VZ = 15, TIME = 16, FLT = 17, LAST = 18, GPU = 19, HUDT = 20, SPL = 21, MX = 22, MY = 23, MZ = 24;
// aimCameraAtTarget the camera from P6 = position + look-at point
function aimCameraAtTarget() {
  const dx = P6[3] - P6[0], dy = P6[4] - P6[1], dz = P6[5] - P6[2];
  F[CX] = P6[0]; F[CY] = P6[1]; F[CZ] = P6[2];
  F[YAW] = atan2(dx, -dz); F[PIT] = atan2(dy, sqrt(dx * dx + dz * dz));
}
const lookAt = (x, y, z, tx, ty, tz) => { P6[0] = x; P6[1] = y; P6[2] = z; P6[3] = tx; P6[4] = ty; P6[5] = tz; aimCameraAtTarget(); };
// camera spline (Catmull-Rom over position + look-at) at parameter F[SPL]
function evaluateCameraSpline() {
  const s = F[SPL]; let i = floor(s) | 0; if (i > FLYN - 2) i = FLYN - 2;
  const u = s - i, i0 = (i > 0 ? i - 1 : 0) * 6, i1 = i * 6, i2 = (i + 1) * 6, i3 = (i + 2 < FLYN ? i + 2 : FLYN - 1) * 6;
  for (let o = 0; o < 6; o++) {
    const a = FLY[i0 + o], b = FLY[i1 + o], c = FLY[i2 + o], d = FLY[i3 + o];
    P6[o] = 0.5 * (2 * b + (c - a) * u + (2 * a - 5 * b + 4 * c - d) * u * u + (3 * b - a - 3 * c + d) * u * u * u);
  }
  aimCameraAtTarget();
}
{ // arc-length table: flyLUT[k] = spline parameter at fraction k/LUTN of the total path length
  const M = 4096, len = new Float32Array(M + 1); let px = 0, py = 0, pz = 0;
  for (let k = 0; k <= M; k++) { F[SPL] = k / M * (FLYN - 1); evaluateCameraSpline(); if (k) len[k] = len[k - 1] + hypot(F[CX] - px, F[CY] - py, F[CZ] - pz); px = F[CX]; py = F[CY]; pz = F[CZ]; }
  for (let k = 0, j = 0; k <= LUTN; k++) { const d = k / LUTN * len[M]; while (j < M - 1 && len[j + 1] < d) j++; flyLUT[k] = (j + (d - len[j]) / max(len[j + 1] - len[j], 1e-6)) / M * (FLYN - 1); }
}
// camera on the scripted path at time F[FLT]
function evaluateFlythroughAtTime() {
  let s = F[FLT] / FLYT; s = s < 0 ? 0 : s > 1 ? 1 : s; s = s * s * (3 - 2 * s) * 0.25 + s * 0.75;
  s *= LUTN; let k = floor(s) | 0; if (k > LUTN - 1) k = LUTN - 1;
  F[SPL] = flyLUT[k] + (flyLUT[k + 1] - flyLUT[k]) * (s - k); evaluateCameraSpline();
}
for (let t = 0; t <= FLYT; t += 0.1) { F[FLT] = t; evaluateFlythroughAtTime(); flyPts.push([F[CX], F[CY], F[CZ]]); }
for (const p of POSES) flyPts.push([p[0], -40, p[2]]);

await reportLoadingProgress('Growing kelp…', 0.73, 2500);
const worldData = populateProceduralWorld(D, T, flyPts, POSES);
for (const p of POSES) p[1] += worldData.gy(p[0], p[2]);
D = worldData.gy = T.smp = null; // with gy goes the generator's working memory (about 200 MB)

await reportLoadingProgress('Building set pieces…', 0.94, 1200);
// mesh ids: 0-3 boulders, 4-6 sponges, 7-8 coral, 9 tube sponge, 10 whale fluke, 11 ship, 12 manta, 13 fish,
// 14-20 rock chunks + pebbles, 21-22 coral LOD, 23-25 far LOD of the large rock chunks
const meshes = [createRockChunkGeometry(1, 3), createRockChunkGeometry(7, 3), createRockChunkGeometry(13, 3), createRockChunkGeometry(22, 3),
  createLathedGeometry([[0, 0, 0.5], [0.34, 0, 0.6], [0.5, 0.2, 0.85], [0.6, 0.6, 1], [0.55, 0.95, 1], [0.47, 1.08, 1], [0.38, 1.1, 0.9], [0.3, 1.0, 0.45], [0.26, 0.6, 0.15], [0, 0.35, 0.05]], 18, 0.3, 9),
  createLathedGeometry([[0, 0, 0.5], [0.2, 0, 0.6], [0.26, 0.5, 0.85], [0.4, 1.25, 1], [0.4, 1.42, 1], [0.33, 1.48, 0.9], [0.26, 1.38, 0.4], [0.18, 0.8, 0.12], [0, 0.5, 0.05]], 16, 0.35, 8),
  createLathedGeometry([[0, 0, 0.5], [0.5, 0, 0.7], [0.72, 0.18, 1], [0.74, 0.38, 1], [0.62, 0.5, 0.9], [0.48, 0.42, 0.45], [0.4, 0.2, 0.15], [0, 0.14, 0.06]], 18, 0.25, 10),
  createCoralGeometry(0), createCoralGeometry(1), createTubeSpongeGeometry()].map((m) => m.build());
meshes.push(createWhaleFlukeGeometry(), createShipwreckGeometry().build(), createMantaGeometry().build(), createFishGeometry().build(),
  createRockChunkGeometry(3).build(), createRockChunkGeometry(11).build(), createRockChunkGeometry(29).build(), createRockChunkGeometry(5, 3).build(), createRockChunkGeometry(17, 3).build(), createRockChunkGeometry(41, 3).build(), createRockChunkGeometry(9, 1).build(), createCoralGeometry(0, 1).build(), createCoralGeometry(1, 1).build(), createRockChunkGeometry(5, 2, 1).build(), createRockChunkGeometry(17, 2, 1).build(), createRockChunkGeometry(41, 2, 1).build());
let nV = 0, nI = 0;
for (const m of meshes) { m.v0 = nV; m.i0 = nI; nV += m.nv; nI += m.ib.length; }
const allV = new Uint8Array(nV * 16), allI = new Uint32Array(nI);
for (const m of meshes) { allV.set(new Uint8Array(m.vb), m.v0 * 16); allI.set(m.ib, m.i0); }
const vbMesh = uploadGpuBuffer(allV, BUFFER_USAGE.VERTEX), ibMesh = uploadGpuBuffer(allI, BUFFER_USAGE.INDEX);
const vbTerrain = uploadGpuBuffer(new Uint8Array(T.vb), BUFFER_USAGE.VERTEX), ibTerrain = uploadGpuBuffer(T.ib, BUFFER_USAGE.INDEX);
const nSolid = worldData.solids.data.length / 12;
const solidData = new Float32Array((nSolid + 1) * 12); solidData.set(worldData.solids.data); solidData.set([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0], nSolid * 12);
const ibSolids = uploadGpuBuffer(solidData, BUFFER_USAGE.VERTEX);
const ibChunk = worldData.chunks.map((c) => uploadGpuBuffer(c.data, BUFFER_USAGE.VERTEX)), ibProp = worldData.props.map((c) => uploadGpuBuffer(c.data, BUFFER_USAGE.VERTEX));
const ibBig = uploadGpuBuffer(new Uint8Array(worldData.big.uploadGpuBuffer), BUFFER_USAGE.VERTEX), ibBigF = uploadGpuBuffer(new Uint8Array(worldData.bigF.uploadGpuBuffer), BUFFER_USAGE.VERTEX), ibSmall = uploadGpuBuffer(new Uint8Array(worldData.small.uploadGpuBuffer), BUFFER_USAGE.VERTEX);
const ibFish = uploadGpuBuffer(worldData.fish, BUFFER_USAGE.VERTEX), ibManta = uploadGpuBuffer(worldData.mantas, BUFFER_USAGE.VERTEX), ibBubbles = uploadGpuBuffer(worldData.bubbles, BUFFER_USAGE.VERTEX), ibSnowB = uploadGpuBuffer(worldData.snow, BUFFER_USAGE.VERTEX);
const ibGl = uploadGpuBuffer(worldData.glints, BUFFER_USAGE.VERTEX), nGl = worldData.glints.length / 8;
const nFish = worldData.fish.length / 8, nManta = worldData.mantas.length / 8, nBub = worldData.bubbles.length / 8, nSnow = worldData.snow.length / 4;
const mantaMesh = meshes[12], fishMesh = meshes[13];
gpuQueue.writeTexture({ texture: occlusionVolumeTexture }, worldData.volD, { bytesPerRow: NX, rowsPerImage: NY / 2 }, [NX / 2, NY / 2, NZ / 2]);
gpuQueue.writeTexture({ texture: mapTexture }, worldData.gm, { bytesPerRow: 2048 }, [512, 512]);

// ---------------------------------------------------------------- one-time bakes: detail texture, shadow map
{
  const m = createShaderModule(W_DETAIL), p = device.createRenderPipeline({ layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] } });
  const e = device.createCommandEncoder();
  let r = e.beginRenderPass({ colorAttachments: [createColorAttachment(detailTexture.createView({ baseMipLevel: 0, mipLevelCount: 1 }), true)] });
  r.setPipeline(p); r.draw(3); r.end();
  for (let i = 1; i < 11; i++) {
    r = e.beginRenderPass({ colorAttachments: [createColorAttachment(detailTexture.createView({ baseMipLevel: i, mipLevelCount: 1 }), true)] });
    r.setPipeline(detailMipmapPipeline); r.setBindGroup(0, createBlitBindGroup(detailTexture.createView({ baseMipLevel: i - 1, mipLevelCount: 1 }))); r.draw(3); r.end();
  }
  r = e.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: shadowTexture.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } });
  r.setBindGroup(0, shadowBindGroup);
  r.setPipeline(terrainShadowPipeline);
  r.setVertexBuffer(0, vbTerrain); r.setVertexBuffer(1, ibSolids); r.setIndexBuffer(ibTerrain, 'uint32');
  r.drawIndexed(T.ib.length, 1, 0, 0, nSolid);
  r.setPipeline(solidShadowPipeline); r.setVertexBuffer(0, vbMesh); r.setIndexBuffer(ibMesh, 'uint32');
  for (let i = 0; i < 12; i++) { const g = worldData.solids.ranges[i]; if (g[1]) r.drawIndexed(meshes[i].ib.length, g[1], meshes[i].i0, meshes[i].v0, g[0]); }
  // small rocks, sponges and corals (~35M triangles) only on High: too much for a phone's driver
  if (!LV) for (let i = 0; i < NCHUNK; i++) { r.setVertexBuffer(1, ibChunk[i]); r.drawIndexed(meshes[14 + i].ib.length, worldData.chunks[i].n, meshes[14 + i].i0, meshes[14 + i].v0, 0); }
  if (!LV) for (let i = 0; i < 6; i++) if (worldData.props[i].n) { r.setVertexBuffer(1, ibProp[i]); r.drawIndexed(meshes[4 + i].ib.length, worldData.props[i].n, meshes[4 + i].i0, meshes[4 + i].v0, 0); }
  r.setPipeline(leafShadowPipeline); r.setVertexBuffer(0, ibBig); r.draw(6, worldData.big.n);
  r.end();
  gpuQueue.submit([e.finish()]);
}
// the GPU has its own copies now: let go of the generator's (about 300 MB)
for (const o of [worldData.big, worldData.bigF, worldData.small, ...worldData.chunks, ...worldData.props]) o.uploadGpuBuffer = o.data = 0;
worldData.glints = worldData.volD = worldData.gm = T.vb = T.ib = T.wp = T.wn = 0;

// ---------------------------------------------------------------- render targets (rebuilt on resize)
// The scene is drawn at `pix` pixels and scaled up to the window. frame() tunes it and the draw distance scale `det`
// for 60 fps; both start where the last visit left them.
const PIXMAX = 2560 * 1440, PIXMIN = mob ? 25e4 : 5e5, DETMIN = 0.4;
let W = 0, H = 0, DW = 0, DH = 0, pix = +SV[1] || (LV > 1 ? 41e4 : mob ? 1280 * 720 : PIXMAX), det = +SV[2] || 1, dynN = 0, dynT = 0, dynG = 0, dynGN = 0, dynBad = 0, dynOk = 0, dynWait = 3;
let passScene, passRays, passBlur, bgBlur, passPost, bgRays, bgPost, bloomPass = [], bloomBG = [], targets = [];
const NB = 6;
function resize() {
  DW = max(2, round(canvas.clientWidth * devicePixelRatio)); DH = max(2, round(canvas.clientHeight * devicePixelRatio));
  const s = min(1, sqrt(pix / (DW * DH)));
  const w = max(2, round(DW * s) & ~1), h = max(2, round(DH * s) & ~1);
  if (w === W && h === H) return;
  dynN = dynG = dynGN = 0; dynT = -300; // let the new size settle before measuring again
  W = w; H = h; canvas.width = W; canvas.height = H;
  gpuCanvasContext.configure({ device, format: CANVAS_FORMAT, alphaMode: 'opaque' });
  for (const t of targets) t.destroy();
  const tMS = createGpuTexture(AA > 1 ? W : 1, H, HDR_COLOR_FORMAT, TEXTURE_USAGE.RENDER_ATTACHMENT, { samples: AA }), tDp = createGpuTexture(W, H, DEPTH_FORMAT, TEXTURE_USAGE.RENDER_ATTACHMENT | TEXTURE_USAGE.TEXTURE_BINDING, { samples: AA });
  const tRes = createGpuTexture(W, H, HDR_COLOR_FORMAT, TEXTURE_USAGE.RENDER_ATTACHMENT | TEXTURE_USAGE.TEXTURE_BINDING), tRay = createGpuTexture(W / 2, H / 2, HDR_COLOR_FORMAT, TEXTURE_USAGE.RENDER_ATTACHMENT | TEXTURE_USAGE.TEXTURE_BINDING), tRay2 = createGpuTexture(W / 2, H / 2, HDR_COLOR_FORMAT, TEXTURE_USAGE.RENDER_ATTACHMENT | TEXTURE_USAGE.TEXTURE_BINDING);
  targets = [tMS, tDp, tRes, tRay, tRay2];
  const bl = [];
  for (let i = 0; i < NB; i++) { const t = createGpuTexture(max(1, W >> (i + 1)), max(1, H >> (i + 1)), HDR_COLOR_FORMAT, TEXTURE_USAGE.RENDER_ATTACHMENT | TEXTURE_USAGE.TEXTURE_BINDING); bl.push(t); targets.push(t); }
  const vDp = tDp.createView(), vRes = tRes.createView(), vRay = tRay.createView(), vRay2 = tRay2.createView(), vBl = bl.map((t) => t.createView());
  // without anti-aliasing (Low) the scene goes straight into the resolve target, and tMS is one unused column
  passScene = { colorAttachments: [{ view: AA > 1 ? tMS.createView() : vRes, resolveTarget: AA > 1 ? vRes : undefined, loadOp: 'clear', storeOp: AA > 1 ? 'discard' : 'store', clearValue: [0, 0, 0, 1] }],
    depthStencilAttachment: { view: vDp, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' } };
  passRays = { colorAttachments: [createColorAttachment(vRay, true)] };
  passBlur = { colorAttachments: [createColorAttachment(vRay2, true)] };
  bgBlur = device.createBindGroup({ layout: rayBlurPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: vRay }] });
  passPost = { colorAttachments: [{ view: null, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] };
  bgRays = device.createBindGroup({ layout: volumetricRayPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: sceneUniformBuffer } }, { binding: 1, resource: repeatSampler }, { binding: 2, resource: shadowComparisonSampler },
    { binding: 3, resource: shadowTexture.createView() }, { binding: 4, resource: waterTexture.createView() }, { binding: 5, resource: vDp }, { binding: 6, resource: occlusionVolumeTexture.createView() }, { binding: 7, resource: clampSampler }] });
  bgPost = device.createBindGroup({ layout: finalCompositePipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: sceneUniformBuffer } }, { binding: 1, resource: clampSampler }, { binding: 2, resource: vRes },
    { binding: 3, resource: vRay2 }, { binding: 4, resource: vBl[0] }, { binding: 5, resource: vDp }] });
  bloomPass = []; bloomBG = [];
  // down: res -> b0 -> ... -> b5 ; up: b5 -> b4 (additive) ... -> b0
  for (let i = 0; i < NB; i++) { bloomPass.push({ colorAttachments: [createColorAttachment(vBl[i], true)] }); bloomBG.push(createBlitBindGroup(i ? vBl[i - 1] : vRes)); }
  for (let i = NB - 1; i > 0; i--) { bloomPass.push({ colorAttachments: [createColorAttachment(vBl[i - 1], false)] }); bloomBG.push(createBlitBindGroup(vBl[i])); }
  sceneUniformValues[52] = W; sceneUniformValues[53] = H; sceneUniformValues[54] = 1 / W; sceneUniformValues[55] = 1 / H;
}
resize();
addEventListener('resize', resize);

// ---------------------------------------------------------------- timing (GPU timestamp queries)
let qs, qResolve, qRead = [], tsBegin, tsEnd;
if (supportsGpuTimestamps) {
  qs = device.createQuerySet({ type: 'timestamp', count: 2 });
  qResolve = device.createBuffer({ size: 16, usage: BUFFER_USAGE.QUERY_RESOLVE | BUFFER_USAGE.COPY_SRC });
  for (let i = 0; i < 6; i++) {
    const b = device.createBuffer({ size: 16, usage: BUFFER_USAGE.MAP_READ | BUFFER_USAGE.COPY_DST });
    const o = { b, busy: false, done: null };
    o.done = () => {
      const a = new BigInt64Array(b.getMappedRange());
      const ms = Number(a[1] - a[0]) / 1e6; F[GPU] = ms; b.unmap(); o.busy = false;
      if (dynT > 0 && ms > 0 && ms < 1e3) { dynG += ms; dynGN++; }
    };
    qRead.push(o);
  }
  tsBegin = { querySet: qs, beginningOfPassWriteIndex: 0 }; tsEnd = { querySet: qs, endOfPassWriteIndex: 1 };
}

// ---------------------------------------------------------------- frame
let hud = false;
let kf = 0, kb = 0, kl = 0, kr = 0, ku = 0, kd = 0, ks = 0, mdx = 0, mdy = 0, lkx = 0, lky = 0, l2x = 0, l2y = 0, hN = 0, hMax = 0, hMin = 1e9, hPer = 1e9, hLate = 0, hTot = 0, tId = -1, tN = 0, tx0 = 0, ty0 = 0, tx = 0, ty = 0;
const verticalFovTangent = 0.6, nearClipDistance = 0.1, exposureStrength = 0.62, rayStrength = 0.54;
const submitList = [null];
const rowsNearToFar = new Uint8Array(CELLS);
// Draws the cells of a cell-sorted buffer that are in view and within [minD, maxD) (scaled by `det`, but not for the
// terrain) as merged runs, nearest rows first.
function drawVisibleCells(
  renderPass, cellOffsets, cellMinY, cellMaxY, padding,
  geometry, verticesPerInstance, nearDistance, farDistance
) {
  // The frustum's basis vectors come from the current camera. Use bounding
  // cells rather than individual instances to avoid expensive per-leaf tests.
  const cx = F[CX], cy = F[CY], cz = F[CZ];
  const fx = F[FX], fy = F[FY], fz = F[FZ];
  const rx = F[RX], rz = F[RZ];
  const ux = F[UX], uy = F[UY], uz = F[UZ];

  // Terrain is never affected by adaptive detail distance scaling.
  const scaleSquared = geometry === 1 ? 1 : det * det;
  const minDistanceSquared = nearDistance * nearDistance * scaleSquared;
  const maxDistanceSquared = farDistance * farDistance * scaleSquared;
  const halfCell = CELLW * 0.5;
  const expandedHalfCell = halfCell + padding;
  const horizontalFov = verticalFovTangent * W / H;

  for (let rowIndex = 0; rowIndex < CELLS; rowIndex++) {
    const gridRow = rowsNearToFar[rowIndex];
    const rowStart = gridRow * CELLS;
    const relativeZ = OZ + (gridRow + 0.5) * CELLW - cz;
    const outsideZ = max(abs(relativeZ) - halfCell, 0);

    // Adjacent visible cells share one instanced draw call.
    let visibleRunStart = -1;
    for (let x = 0; x <= CELLS; x++) {
      const cellIndex = rowStart + x;
      let isVisible = false;
      if (x < CELLS) {
        const minY = cellMinY[cellIndex], maxY = cellMaxY[cellIndex];
        if (minY <= maxY) {
          const relativeX = OX + (x + 0.5) * CELLW - cx;
          const relativeY = (minY + maxY) * 0.5 - cy;
          const halfHeight = (maxY - minY) * 0.5 + padding;
          const outsideX = max(abs(relativeX) - halfCell, 0);
          const distanceSquared = outsideX * outsideX + outsideZ * outsideZ;

          if (distanceSquared < maxDistanceSquared && distanceSquared >= minDistanceSquared) {
            // Conservative frustum test: project the cell's expanded bounding
            // box onto camera-forward, right and up directions.
            const forward =
              relativeX * fx + relativeY * fy + relativeZ * fz
              + expandedHalfCell * abs(fx) + halfHeight * abs(fy)
              + expandedHalfCell * abs(fz);
            const right =
              abs(relativeX * rx + relativeZ * rz)
              - expandedHalfCell * (abs(rx) + abs(rz));
            if (forward >= 0 && right <= forward * horizontalFov) {
              const up =
                abs(relativeX * ux + relativeY * uy + relativeZ * uz)
                - expandedHalfCell * (abs(ux) + abs(uz)) - halfHeight * abs(uy);
              isVisible = up <= forward * verticalFovTangent;
            }
          }
        }
      }

      if (isVisible) {
        if (visibleRunStart < 0) visibleRunStart = cellIndex;
      } else if (visibleRunStart >= 0) {
        const firstInstance = cellOffsets[visibleRunStart];
        const instanceCount = cellOffsets[cellIndex] - firstInstance;
        if (instanceCount > 0) {
          if (geometry === 1) {
            // Terrain quads have six indices each.
            renderPass.drawIndexed(instanceCount * 6, 1, firstInstance * 6, 0, nSolid);
          } else if (geometry) {
            // Indexed, instanced rock/coral geometry.
            renderPass.drawIndexed(geometry.ib.length, instanceCount, geometry.i0, geometry.v0, firstInstance);
          } else {
            // Vertex shader expands plant blades or screen-facing sprites.
            renderPass.draw(verticesPerInstance, instanceCount, 0, firstInstance);
          }
        }
        visibleRunStart = -1;
      }
    }
  }
}

// Encode water, opaque/transparent scene, rays, blur, bloom and final output.
// GPU commands are recorded here, then submitted as a single command buffer.
function render() {
  // camera basis (right vector is horizontal)
  const cx = F[CX], cy = F[CY], cz = F[CZ], pitch = F[PIT], yaw = F[YAW];
  const cp = cos(pitch), fy = sin(pitch), rx = cos(yaw), rz = sin(yaw), fx = cp * rz, fz = -cp * rx;
  const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
  F[FX] = fx; F[FY] = fy; F[FZ] = fz; F[RX] = rx; F[RZ] = rz; F[UX] = ux; F[UY] = uy; F[UZ] = uz;
  const asp = W / H, sx = 1 / (verticalFovTangent * asp), sy = 1 / verticalFovTangent, m = sceneUniformValues;
  m[0] = rx * sx; m[4] = 0; m[8] = rz * sx; m[12] = -(rx * cx + rz * cz) * sx;
  m[1] = ux * sy; m[5] = uy * sy; m[9] = uz * sy; m[13] = -(ux * cx + uy * cy + uz * cz) * sy;
  m[2] = 0; m[6] = 0; m[10] = 0; m[14] = nearClipDistance;
  m[3] = fx; m[7] = fy; m[11] = fz; m[15] = -(fx * cx + fy * cy + fz * cz);
  m[32] = cx; m[33] = cy; m[34] = cz; m[35] = F[TIME];
  m[36] = rx; m[37] = 0; m[38] = rz; m[39] = verticalFovTangent * asp;
  m[40] = ux; m[41] = uy; m[42] = uz; m[43] = verticalFovTangent;
  m[44] = fx; m[45] = fy; m[46] = fz; m[47] = nearClipDistance;
  const zx = cx - PURPLE[0], zz = cz - PURPLE[1]; let zt = (44 - sqrt(zx * zx + zz * zz)) / 18; zt = zt < 0 ? 0 : zt > 1 ? 1 : zt;
  m[51] = zt * zt * (3 - 2 * zt);
  let ek = (-cy - 8) / 26; ek = ek < 0 ? 0 : ek > 1 ? 1 : ek;
  m[56] = exposureStrength * (0.6 + 0.4 * ek); m[57] = rayStrength; m[58] = det;
  gpuQueue.writeBuffer(sceneUniformBuffer, 0, sceneUniformValues);
  waterUniformValues[0] = F[TIME]; gpuQueue.writeBuffer(waterUniformBuffer, 0, waterUniformValues);

  { let cr = floor((cz - OZ) / CELLW) | 0; cr = cr < 0 ? 0 : cr > CELLS - 1 ? CELLS - 1 : cr; let n = 0; rowsNearToFar[n++] = cr; for (let d = 1; d < CELLS; d++) { if (cr - d >= 0) rowsNearToFar[n++] = cr - d; if (cr + d < CELLS) rowsNearToFar[n++] = cr + d; } }
  const e = device.createCommandEncoder();
  let slot = null;
  if (supportsGpuTimestamps) { for (let i = 0; i < qRead.length; i++) if (!qRead[i].busy) { slot = qRead[i]; break; } }
  waterPass[0].timestampWrites = slot ? tsBegin : undefined;
  passPost.timestampWrites = slot ? tsEnd : undefined;
  // animated water texture + mips
  let r = e.beginRenderPass(waterPass[0]); r.setPipeline(waterAnimationPipeline); r.setBindGroup(0, bgWater); r.draw(3); r.end();
  for (let i = 1; i < 5; i++) { r = e.beginRenderPass(waterPass[i]); r.setPipeline(waterMipmapPipeline); r.setBindGroup(0, waterBG[i - 1]); r.draw(3); r.end(); }
  // scene
  r = e.beginRenderPass(passScene);
  r.setBindGroup(0, sceneBindGroup);
  r.setPipeline(terrainPipeline); r.setVertexBuffer(0, vbTerrain); r.setVertexBuffer(1, ibSolids); r.setIndexBuffer(ibTerrain, 'uint32');
  drawVisibleCells(r, T.start, T.lo, T.hi, 1.5, 1, 0, 0, 240);
  r.setPipeline(solidPipeline); r.setVertexBuffer(0, vbMesh); r.setIndexBuffer(ibMesh, 'uint32');
  for (let i = 0; i < 12; i++) { const g = worldData.solids.ranges[i]; if (g[1]) r.drawIndexed(meshes[i].ib.length, g[1], meshes[i].i0, meshes[i].v0, g[0]); }
  for (let i = 0; i < NCHUNK; i++) {
    const c = worldData.chunks[i], big = i > 2 && i < 6; r.setVertexBuffer(1, ibChunk[i]);
    drawVisibleCells(r, c.start, c.lo, c.hi, 3, meshes[14 + i], 0, 0, i > 5 ? 30 : big ? 40 : 96);
    if (big) drawVisibleCells(r, c.start, c.lo, c.hi, 3, meshes[20 + i], 0, 40, 150);
  }
  for (let i = 0; i < 6; i++) {
    const lod = i === 3 || i === 4; r.setVertexBuffer(1, ibProp[i]);
    drawVisibleCells(r, worldData.props[i].start, worldData.props[i].lo, worldData.props[i].hi, 3, meshes[4 + i], 0, 0, lod ? 6 : 110);
    if (lod) drawVisibleCells(r, worldData.props[i].start, worldData.props[i].lo, worldData.props[i].hi, 3, meshes[18 + i], 0, 6, 110);
  }
  r.setPipeline(mantaPipeline); r.setVertexBuffer(1, ibManta); r.drawIndexed(mantaMesh.ib.length, nManta, mantaMesh.i0, mantaMesh.v0, 0);
  r.setPipeline(fishPipeline); r.setVertexBuffer(1, ibFish); r.drawIndexed(fishMesh.ib.length, nFish, fishMesh.i0, fishMesh.v0, 0);
  // kelp and plants: 9-row blades up close, 5 rows mid-range, a decimated set far away
  r.setPipeline(nearKelpPipeline); r.setVertexBuffer(0, ibBig); drawVisibleCells(r, worldData.big.start, worldData.big.lo, worldData.big.hi, 5, false, 18, 0, 24);
  r.setPipeline(midKelpPipeline); drawVisibleCells(r, worldData.big.start, worldData.big.lo, worldData.big.hi, 5, false, 10, 24, 58);
  r.setPipeline(farKelpPipeline); r.setVertexBuffer(0, ibBigF); drawVisibleCells(r, worldData.bigF.start, worldData.bigF.lo, worldData.bigF.hi, 5, false, 6, 58, 150);
  r.setPipeline(smallPlantPipeline); r.setVertexBuffer(0, ibSmall); drawVisibleCells(r, worldData.small.start, worldData.small.lo, worldData.small.hi, 1.5, false, 6, 0, 70);
  r.setPipeline(waterSurfacePipeline); r.draw(4);
  r.setPipeline(backgroundPipeline); r.draw(4);
  r.setPipeline(bubblePipeline); r.setVertexBuffer(0, ibBubbles); r.draw(4, nBub);
  r.setPipeline(glintPipeline); r.setVertexBuffer(0, ibGl); r.draw(4, nGl);
  r.setPipeline(snowPipeline); r.setVertexBuffer(0, ibSnowB); r.draw(4, nSnow);
  r.end();
  // light shafts
  r = e.beginRenderPass(passRays); r.setPipeline(volumetricRayPipeline); r.setBindGroup(0, bgRays); r.draw(3); r.end();
  r = e.beginRenderPass(passBlur); r.setPipeline(rayBlurPipeline); r.setBindGroup(0, bgBlur); r.draw(3); r.end();
  // bloom
  for (let i = 0; i < bloomPass.length; i++) {
    r = e.beginRenderPass(bloomPass[i]); r.setPipeline(i === 0 ? firstBloomDownsamplePipeline : i < NB ? bloomDownsamplePipeline : bloomUpsamplePipeline); r.setBindGroup(0, bloomBG[i]); r.draw(3); r.end();
  }
  // composite
  passPost.colorAttachments[0].view = gpuCanvasContext.getCurrentTexture().createView();
  r = e.beginRenderPass(passPost); r.setPipeline(finalCompositePipeline); r.setBindGroup(0, bgPost); r.draw(3); r.end();
  if (slot) { e.resolveQuerySet(qs, 0, 2, qResolve, 0); e.copyBufferToBuffer(qResolve, 0, slot.b, 0, 16); }
  submitList[0] = e.finish();
  gpuQueue.submit(submitList);
  if (slot) { slot.busy = true; slot.b.mapAsync(GPUMapMode.READ).then(slot.done); }
}

// collisionSampleValues[j] = distance to the rock (metres, < 0 in water) at the camera + collisionSampleOffsets[3j..3j+2]: the camera, then ±0.375 m on
// each axis for the gradient
const collisionSampleOffsets = new Float64Array([0, 0, 0, .375, 0, 0, -.375, 0, 0, 0, .375, 0, 0, -.375, 0, 0, 0, .375, 0, 0, -.375]), collisionSampleValues = new Float64Array(7);
// collisionBrickLookup contains either a uniform-brick marker (0 water, 1 rock) or an
// index (>=2) into the packed 4×4×4 signed-distance bricks in collisionBrickData.
function readCollisionVoxel(x, y, z) {
  const brick = collisionBrickLookup[(x >> 2) + collisionBrickCountPerAxis * ((y >> 2) + (NY / 4) * (z >> 2))];
  if (brick <= 1) return brick * 254 - 127;
  const withinBrick = (x & 3) + 4 * (y & 3) + 16 * (z & 3);
  return collisionBrickData[(brick - 2) * 64 + withinBrick];
}
// Trilinearly interpolate the compact 4×4×4 collision bricks.
// Result is positive inside rock and negative in open water.
function sampleRockDistance(j) {
  const x = (F[CX] + collisionSampleOffsets[j * 3] - OX) / VS - collisionGridOffset, y = (F[CY] + collisionSampleOffsets[j * 3 + 1] - OY) / VS, z = (F[CZ] + collisionSampleOffsets[j * 3 + 2] - OZ) / VS - collisionGridOffset;
  const ix = x | 0, iy = y | 0, iz = z | 0, u = x - ix, v = y - iy, a = readCollisionVoxel(ix, iy, iz), b = readCollisionVoxel(ix, iy + 1, iz), c = readCollisionVoxel(ix, iy, iz + 1), d = readCollisionVoxel(ix, iy + 1, iz + 1);
  const p = a + (readCollisionVoxel(ix + 1, iy, iz) - a) * u, q = b + (readCollisionVoxel(ix + 1, iy + 1, iz) - b) * u, r = c + (readCollisionVoxel(ix + 1, iy, iz + 1) - c) * u, s = d + (readCollisionVoxel(ix + 1, iy + 1, iz + 1) - d) * u;
  const e = p + (q - p) * v; collisionSampleValues[j] = (e + (r + (s - r) * v - e) * (z - iz)) / 127;
}
// Moves the camera by F[MX..MZ] in steps shorter than its radius cameraCollisionRadius (so it can't pass through thin rock), pushing it
// back out after each step and dropping velocity into the rock, so it slides along.
const cameraCollisionRadius = 0.5;
// Small substeps prevent tunneling; project velocity onto the tangent plane
// when pushing out of rock, so the camera slides rather than sticking.
function resolveCameraCollisions() {
  const n = floor(sqrt(F[MX] * F[MX] + F[MY] * F[MY] + F[MZ] * F[MZ]) / 0.4) + 1;
  for (let i = 0; i < n; i++) {
    F[CX] += F[MX] / n; F[CY] += F[MY] / n; F[CZ] += F[MZ] / n;
    for (let k = 0; k < 2; k++) {
      sampleRockDistance(0); const s = collisionSampleValues[0] + cameraCollisionRadius; if (s <= 0) break;
      for (let j = 1; j < 7; j++) sampleRockDistance(j);
      let gx = collisionSampleValues[1] - collisionSampleValues[2], gy = collisionSampleValues[3] - collisionSampleValues[4], gz = collisionSampleValues[5] - collisionSampleValues[6]; const l = sqrt(gx * gx + gy * gy + gz * gz);
      if (l < 0.075) break; // flat: deep in rock
      gx /= l; gy /= l; gz /= l; const vn = F[VX] * gx + F[VY] * gy + F[VZ] * gz;
      F[CX] -= gx * s; F[CY] -= gy * s; F[CZ] -= gz * s;
      if (vn > 0) { F[VX] -= gx * vn; F[VY] -= gy * vn; F[VZ] -= gz * vn; }
    }
  }
}

// CPU-side animation and input. Keep simulation dt <= 100 ms after tab pauses.
// Rendering quality changes use separate slower windows to avoid oscillation.
// Adapt render load using GPU timestamps when available, otherwise frame times.
// To avoid oscillation, first adjust pixels, then draw distance, then pixels again.
function updateAdaptiveQuality(frameDurationMs) {
  if (frameDurationMs >= 1000) return;
  dynT += frameDurationMs;
  if (dynT <= 0) return;

  dynN++;
  if (dynT <= (menu ? 400 : 1000)) return;

  const averageFrameMs = dynT / dynN;
  const averageGpuMs = dynGN ? dynG / dynGN : 0;
  let loadFactor = 1;

  if (averageGpuMs) {
    // Keep measured GPU time near the middle of the 9.8–13.6 ms band.
    if (averageGpuMs > 13.6 || averageGpuMs < 9.8) {
      loadFactor = 11.7 / averageGpuMs;
    }
  } else if (averageFrameMs > 17.6) {
    // Without GPU timings, require two slow windows before scaling down.
    dynOk = 0;
    if (++dynBad > 1) {
      loadFactor = 15 / averageFrameMs;
      dynBad = 0;
      dynWait = min(dynWait * 2, 60);
    }
  } else {
    dynBad = 0;
    if (averageFrameMs < 12.5) {
      loadFactor = 15 / averageFrameMs;
    } else if (++dynOk > dynWait) {
      // Test for headroom occasionally when vsync hides real GPU capacity.
      loadFactor = 1.17;
      dynOk = 0;
    }
  }

  loadFactor = clamp(loadFactor, 0.5, 1.7);
  const maximumPixels = min(PIXMAX, DW * DH);
  const middlePixels = max(maximumPixels / 2, PIXMIN);
  const previousSettings = pix + det;

  const shouldAdjustPixels = loadFactor < 1
    ? pix > middlePixels || det <= DETMIN
    : pix < middlePixels || det >= 1;

  if (shouldAdjustPixels) {
    const pixelLimit = loadFactor < 1
      ? (det > DETMIN ? middlePixels : PIXMIN)
      : (det < 1 ? middlePixels : maximumPixels);
    pix *= loadFactor;
    if (loadFactor < 1 ? pix < pixelLimit : pix > pixelLimit) {
      pix = pixelLimit;
    }
  } else {
    det = clamp(det * sqrt(loadFactor), DETMIN, 1);
  }

  if (previousSettings !== pix + det) {
    keep('abyssal', [LV, pix < maximumPixels ? pix | 0 : '', det]);
  }
  dynN = dynT = dynG = dynGN = 0;
  resize();
}

// Smooth first-person swimming with mouse/touch look and collision.
function updateCameraMovement(dt) {
  // Touch acts like a virtual joystick held off-center.
  if (tId >= 0) {
    const touchScale = 4 / min(innerWidth, innerHeight);
    let stickX = clamp((tx - tx0) * touchScale, -1, 1);
    let stickY = clamp((ty - ty0) * touchScale, -1, 1);
    lkx += stickX * 1.5 * dt;
    lky += stickY * dt;
  }

  // Two cascaded low-pass filters make mouse look fluid and avoid abrupt turns.
  const smoothing = 1 - exp(-dt * 30);
  lkx += mdx * 0.0022;
  lky += mdy * 0.0022;
  mdx = 0;
  mdy = 0;

  const firstYaw = lkx * smoothing;
  const firstPitch = lky * smoothing;
  lkx -= firstYaw;
  lky -= firstPitch;
  l2x += firstYaw;
  l2y += firstPitch;

  const yawDelta = l2x * smoothing;
  const pitchDelta = l2y * smoothing;
  l2x -= yawDelta;
  l2y -= pitchDelta;

  const yaw = F[YAW] + yawDelta;
  const pitch = clamp(F[PIT] - pitchDelta, -1.55, 1.55);
  const swimSpeed = ks || tN > 1 ? 26 : 7;
  const acceleration = 1 - exp(-dt * 4.5);
  const forwardInput = tId >= 0 ? 0.7 : kf - kb;
  const sidewaysInput = kr - kl;
  const verticalInput = ku - kd;
  const pitchCos = cos(pitch);
  const yawSin = sin(yaw);
  const yawCos = cos(yaw);

  // Desired movement in world coordinates; ease velocity toward that target.
  const desiredX = (yawSin * pitchCos * forwardInput + yawCos * sidewaysInput) * swimSpeed;
  const desiredY = (sin(pitch) * forwardInput + verticalInput) * swimSpeed;
  const desiredZ = (-yawCos * pitchCos * forwardInput + yawSin * sidewaysInput) * swimSpeed;
  const velocityX = F[VX] + (desiredX - F[VX]) * acceleration;
  const velocityY = F[VY] + (desiredY - F[VY]) * acceleration;
  const velocityZ = F[VZ] + (desiredZ - F[VZ]) * acceleration;

  let nextX = F[CX] + velocityX * dt;
  let nextY = F[CY] + velocityY * dt;
  let nextZ = F[CZ] + velocityZ * dt;

  // Keep the swimmer inside the authored world and below the surface.
  const radialDistance = sqrt(nextX * nextX + nextZ * nextZ);
  if (radialDistance > 150) {
    nextX *= 150 / radialDistance;
    nextZ *= 150 / radialDistance;
  }
  nextY = clamp(nextY, -52, -1.2);

  F[YAW] = yaw;
  F[PIT] = pitch;
  F[VX] = velocityX;
  F[VY] = velocityY;
  F[VZ] = velocityZ;
  F[MX] = nextX - F[CX];
  F[MY] = nextY - F[CY];
  F[MZ] = nextZ - F[CZ];
  resolveCameraCollisions();
}

// The browser's frame timestamp is milliseconds; the simulation uses seconds.
// Clamp long pauses so returning to the tab cannot leap through the terrain.
function frame(now) {
  requestAnimationFrame(frame);
  const frameDurationMs = now - F[LAST];
  F[LAST] = now;
  const dt = min(frameDurationMs / 1000, 0.1);

  updateAdaptiveQuality(frameDurationMs);
  F[TIME] += dt;
  updateCameraMovement(dt);
  render();

  if (hud) {
    hN++; if (frameDurationMs > hMax) hMax = frameDurationMs; if (frameDurationMs < hMin) hMin = frameDurationMs; if (frameDurationMs > hPer * 1.5) { hLate++; hTot++; }
    F[HUDT] += frameDurationMs / 1000;
    if (F[HUDT] > 0.5) { info.textContent = `${(hN / F[HUDT]).toFixed(0)} fps  ·  worst frame ${hMax.toFixed(1)} ms  ·  late frames ${hLate} (total ${hTot})  ·  GPU ${F[GPU].toFixed(2)} ms  ·  ${W}x${H} (${W * 100 / DW | 0}%)`; F[HUDT] = 0; hPer = hMin; hN = 0; hMax = 0; hMin = 1e9; hLate = 0; }
  }
}

// ---------------------------------------------------------------- input
const key = (e, v) => {
  switch (e.code) {
    case 'KeyW': kf = v; break; case 'KeyS': kb = v; break; case 'KeyA': kl = v; break; case 'KeyD': kr = v; break;
    case 'KeyE': ku = v; break; case 'KeyQ': kd = v; break; case 'ShiftLeft': case 'ShiftRight': ks = v; break;
    default: if (v && !e.repeat) {
      if (e.code === 'KeyH') { hud = !hud; hTot = 0; hPer = 1e9; info.textContent = ''; }
      else if (e.code === 'KeyM') mute();
      else if (e.code === 'Escape') ui(true);
      else if (e.code >= 'Digit1' && e.code <= 'Digit6') lookAt(...POSES[e.code.charCodeAt(5) - 49]);
    }
  }
};
// behind the menu only the stats and mute keys work
addEventListener('keydown', (e) => { if (menu && e.code !== 'KeyH' && e.code !== 'KeyM') return; sound(); key(e, 1); });
addEventListener('keyup', (e) => key(e, 0));
const release = () => { kf = kb = kl = kr = ku = kd = ks = 0; tId = -1; tN = 0; };
const capture = () => { sound(); const p = canvas.requestPointerLock({ unadjustedMovement: true }); if (p && p.catch) p.catch(() => canvas.requestPointerLock()).catch(() => 0); };
canvas.addEventListener('click', capture);
addEventListener('mousemove', (e) => { if (document.pointerLockElement === canvas) { mdx += e.movementX; mdy += e.movementY; } });
addEventListener('blur', release);
const touch = (e) => {
  e.preventDefault(); sound(); tN = e.touches.length;
  let f = null, first = false; for (let i = 0; i < tN; i++) if (e.touches[i].identifier === tId) f = e.touches[i];
  if (!f) { tId = -1; if (tN) { f = e.touches[0]; tId = f.identifier; first = true; } }
  if (f) {
    // the touch axes turn with the page when it lies on its side
    const x = rot.matches ? f.clientY : f.clientX, y = rot.matches ? -f.clientX : f.clientY, s = 1100 / min(innerWidth, innerHeight);
    if (first) { tx0 = x; ty0 = y; } else { mdx += (x - tx) * s; mdy += (y - ty) * s; } // the view follows the finger at once
    tx = x; ty = y;
  }
};
for (const n of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) canvas.addEventListener(n, touch, { passive: false });

// ---------------------------------------------------------------- menu
// The scene keeps rendering (blurred by CSS) behind the menu. Esc, losing the mouse or the corner button open it.
let menu = true;
const bDive = $('d');
const ui = (m) => {
  if (dead) return;
  menu = m; body.className = m ? 'm' : document.pointerLockElement ? 'g p' : 'g';
  // focus the dive button so Enter works (delayed: it can't take focus while still hidden)
  if (m) { release(); setTimeout(() => menu && bDive.focus(), 100); } else document.activeElement.blur();
};
const go = () => {
  sound(); ui(false); bDive.textContent = 'Resume';
  // phones: go fullscreen and ask for landscape; where that is refused the CSS rotation still applies
  if (mob) document.documentElement.requestFullscreen?.()?.then(() => screen.orientation.lock('landscape')).catch(() => 0);
  if (!mob) capture();
};
bDive.onclick = go; $('o').onclick = () => ui(true);
// detail buttons: the current level is lit, the others reload the page with theirs
$('q').querySelectorAll('button').forEach((b, i) => { if (i === 2 - LV) b.className = 'on'; else b.onclick = () => { keep('abyssal', 2 - i); location.reload(); }; });
document.addEventListener('pointerlockchange', () => ui(!document.pointerLockElement));

// draw the first frame and wait for the GPU to finish it (pipelines get compiled on first use) before the reveal
lookAt(...POSES[0]);
await reportLoadingProgress('Letting the light in…', 1, 400);
render(); await gpuQueue.onSubmittedWorkDone();
setTimeout(keep, 15e3, 'abyssalLoad', ''); // the load counts as survived after 15 s of frames
ui(true);
requestAnimationFrame((t) => { F[LAST] = t; requestAnimationFrame(frame); });
