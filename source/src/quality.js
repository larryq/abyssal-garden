// ============================================================================
// Quality-tier selection (runs before allocating any WebGPU resources).
// ============================================================================
//
// Public, short names are preserved because earlier/later concatenated files
// share these bindings. See docs/ARCHITECTURE.md for the build-order contract.
//
// LV:   0 = High, 1 = Medium, 2 = Low
// THIN: retain 1 in THIN non-stem blades, sparkle particles and pebbles.
// SHADOW: static shadow-map resolution.
// AA:   MSAA sample count (Low disables multisampling).
// WATER: animated water texture resolution.
// RAYN: volumetric light-ray integration steps.
//
// localStorage.abyssal = "qualityLevel,pixelBudget,detailDistance"
// localStorage.abyssalLoad indicates a previous load may have crashed; retry
// at a lower quality level rather than repeatedly losing the WebGPU device.

const mob = matchMedia('(pointer:coarse)').matches;
const mem = navigator.deviceMemory;
const keep = (key, value) => {
  try {
    localStorage[key] = value;
  } catch {
    // Private browsing or restricted storage must not prevent startup.
  }
};

let SV = [];
let LV;
let bad;
try {
  SV = (localStorage.abyssal || '').split(',');
  bad = localStorage.abyssalLoad;
} catch {
  // Use default device heuristics when storage is unavailable.
}

// Prefer full detail on desktop unless reported RAM is very limited.
// On touch devices, select Medium only when at least 8 GB is reported.
LV = SV[0]
  ? +SV[0]
  : mob
    ? (mem > 7 ? 1 : 2)
    : mem <= 4 ? 2 : 0;

if (bad && LV < 2) {
  SV = [++LV];
  keep('abyssal', LV);
}

const THIN = 1 << LV;
const SHADOW = LV ? 2048 : 4096;
const AA = LV > 1 ? 1 : 4;
const WATER = LV > 1 ? 256 : 512;
const RAYN = LV > 1 ? 12 : 34;
