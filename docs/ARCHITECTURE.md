# Abyssal Garden — Architecture and code-reading guide

Abyssal Garden is a **raw WebGPU + WGSL** renderer, not a Three.js application.
No external 3D models or textures are loaded. The build deliberately concatenates
source files into one asynchronous scope, then emits a self-contained HTML file.

This guide applies to the `refactor/readable-source` branch. The refactor retains
the visual algorithms while grouping source by responsibility.

## Suggested reading order

1. `source/src/quality.js` — choose the quality tier before GPU allocation.
2. `source/src/math.js` — deterministic PRNG, noise, mesh builders, surface nets.
3. `source/src/world-layout.js` — authored mesas, arches, tunnels and region anchors.
4. `source/src/shaders-terrain.js` — WGSL signed density field and compute stage.
5. `source/src/world.js` — surface extraction, vegetation, props, wildlife, ship.
6. `source/src/shaders-scene.js` — shared atmosphere, geometry and instance shaders.
7. `source/src/shaders-post.js` — volumetric shafts, depth blur and final compositing.
8. `source/src/main.js` — GPU device, buffers, pipelines, camera and frame loop.
9. `source/src/audio.js` — Web Audio synthesis, independent of the graphics loop.

## Startup: data movement

```text
quality + helpers
     |
     v
WebGPU device, shader modules, render pipelines
     |
     v
WGSL density compute shader  ---> 512 x 80 x 512 float density grid
     |                                      |
     +--> GPU buffer readback --------------+
                                            |
                               remove unconnected rock islands
                                            |
                     +----------------------+-----------------+
                     |                      |                 |
               surface nets           collision bricks    scatter instances
                     |                                        |
             terrain triangle mesh                    kelp, rocks, animals
                     |                                        |
                     +----------------------+-----------------+
                                            |
                                upload GPU vertex / instance data
                                            |
                          bake textures and mostly static shadows
                                            |
                                        frame loop
```

**Density convention:** positive values are inside rock; negative values are
water. `shaders-terrain.js` computes the density in parallel, but `main.js`
reads the grid back to the CPU to extract terrain and populate the world.

The density volume has 512 × 80 × 512 samples (20,971,520 floats, about 80 MiB).
Unlike a heightmap, it can describe caves, tunnels and overhangs.

## Terrain modeling

`world-layout.js` holds controls for `MESAS`, `ARCHES`, `HOLES` and
`CLEARS`. These are passed to the compute shader as packed float records.

`dens(p)` in `shaders-terrain.js` combines a base seafloor, multi-octave noise,
smooth unions with rock masses and arches, and subtraction for tunnel cylinders.
`surfaceNets()` in `math.js` extracts a polygonal surface at the zero crossing,
and `buildTerrain()` in `world.js` packs positions and normals and groups
triangles into horizontal culling cells.

## How there can be so much kelp

`makeWorld()` scatters vegetation using a deterministic seeded PRNG.
It writes packed instance attributes grouped by camera-culling cell.
Blades are **generated procedurally in the vertex shader**, not stored as
individual detailed meshes. The renderer selects 9-row, 5-row, or simplified
far-field blade versions according to distance.

The same design appears elsewhere: fish, manta rays, bubbles and particles
share a small number of GPU pipelines and receive per-instance parameters.
Instances of rock or coral meshes are drawn in batches.

## Every rendered frame

In `main.js`, `frame(now)` handles mouse/touch/keyboard input, motion
integration, collision, quality adaptation, then calls `render()`.
The latter encodes roughly the following sequence:

```text
Animated water texture + mipmaps
         |
         v
HDR scene color + depth
(terrain, solids, fish, foliage, water surface, particles)
         |
         +-----------------------+
         |                       |
         v                       v
Half-resolution rays         Bloom downsample
         |                       |
Depth-aware ray blur          Bloom upsample
         |                       |
         +-----------+-----------+
                     |
                Final composite
                     |
                  Canvas
```

Important source functions/strings:

- `render()`: records the render and post-processing passes.
- `drawCells()`: selects only nearby and visible instance cells.
- `W_WATER`: updates the animated water lookup texture.
- `W_RAYS`: integrates volumetric light at half resolution.
- `W_RBLUR`: depth-aware smoothing of those rays.
- `W_POST`: upsampling, bloom addition, exposure and tone mapping.

## Why the volumetric lighting works

For each pixel at half resolution, the ray shader reconstructs a camera-space
view direction from the screen coordinates. It stops at visible geometry,
the water surface, or its maximum trace distance. At each point it samples a
sunlight shadow map, moving water patterns, and a coarse 3D volume representing
local occlusion/scattering. The samples are attenuated and accumulated.

The shader uses jittered ray-march samples; a subsequent depth-aware blur
reduces noise without blurring across foreground geometry as aggressively.
The final compositor upsamples light based on depth, mixes bloom and applies
tone mapping, a vignette and a tiny dither.

## Quality and performance

`quality.js` selects high/medium/low settings: instance thinning,
shadow resolution, multisample count, water texture size and ray-march steps.
`main.js` also adapts rendered pixel count and draw distance toward a target
frame rate. It uses GPU timestamp queries where supported, falling back to
frame timings otherwise. The current resolution/detail can be cached locally.

The build provides:

```bash
cd source
npm ci
npm run build:readable  # readable root index.html
npm run build           # minified root index.html
npm run build:dev       # separate dev.html with fly-through/benchmark
```

All versions work without a web server once generated. A WebGPU-capable
browser is still required to execute the result.

## Why the build order matters

`source/build.mjs` does **not** build JavaScript ES modules. It concatenates
source text into a single async function. Variables intentionally refer to
declarations in earlier files. As a result, keep the following relative order:

```text
quality.js -> math.js
 -> shaders.js -> shaders-terrain.js -> shaders-scene.js -> shaders-post.js
 -> world-layout.js -> world.js -> main.js -> audio.js
```

`shaders.js` now serves as a small navigation note. Converting this project
into true modules would be a larger separate change requiring explicit imports,
exports, and startup sequencing.

## Refactor policy and validation

The first branch change only **relocates complete source sections** and adds
comments and build-list entries. It does not deliberately change numerical
constants, shader expressions, draw calls or visual settings.

Before merging, run all three builds, inspect the browser console for WGSL
compilation/validation errors, try each of the six viewpoints, and compare
high-detail screenshots against `main`. Also verify camera collision, quality
switching, pointer lock, audio mute and the development benchmark.

A next refactor pass can isolate `main.js` functions for resource setup,
pipeline construction, terrain readback and render-pass encoding, followed by
more descriptive local names. Keep those changes separate so visual or
performance regressions are easy to attribute.
