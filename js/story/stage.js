// The 3D city behind the story. Loaded lazily, after first paint.
//
// Two scenes share one canvas and one camera:
//   • neighborhoods: NYC's 195 neighborhoods extruded; height and color follow
//     the story's metric hour by hour (heat index, AQI or wind gusts)
//   • terrain: the city's real elevation (USGS 3DEP), with a sea that rises to
//     the measured storm tide; land under water is colored by flood depth
// Lighting follows the replay's real sun position. Everything here is visual:
// the page states every fact in text as well.

import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  EffectComposer,
  ExtrudeGeometry,
  Fog,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineLoop,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  OutputPass,
  Path,
  PerspectiveCamera,
  PlaneGeometry,
  RenderPass,
  Scene,
  Shape,
  SRGBColorSpace,
  UnrealBloomPass,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { project } from './geo.js';
import { poseToCamera } from './camera.js';
import { daylight, nyLocalToUtc, solarPosition } from './sun.js';
import { cellLonLat, decodeElevation, ELEVATION } from './elevation.js';
import { hexToRgb, mix, NEUTRAL, RAMPS, rampAt, skyAt } from './palette.js';

const TERRAIN_EXAGGERATION = 0.008; // km of height per metre of elevation (×8)
const BASE_HEIGHT = 0.05; // km
const MAX_EXTRA = 1.9; // km

const srgb = (rgb) => new Color().setRGB(rgb[0], rgb[1], rgb[2], SRGBColorSpace);

export async function createStage(canvas, { theme = 'light', mobile = false, bloom = !mobile } = {}) {
  const renderer = new WebGLRenderer({ canvas, antialias: !mobile, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 2));
  renderer.outputColorSpace = SRGBColorSpace;

  const scene = new Scene();
  scene.fog = new Fog(0xffffff, 45, 160);
  const camera = new PerspectiveCamera(30, 1, 0.05, 600);

  // sky: a vertical gradient drawn into a small canvas texture
  const skyCanvas = document.createElement('canvas');
  skyCanvas.width = 2;
  skyCanvas.height = 256;
  const skyTexture = new CanvasTexture(skyCanvas);
  skyTexture.colorSpace = SRGBColorSpace;
  scene.background = skyTexture;

  const hemi = new HemisphereLight(0xffffff, 0x888888, 1.2);
  const sun = new DirectionalLight(0xffffff, 2);
  const moon = new DirectionalLight(0x9fb4d8, 0);
  moon.position.set(-40, 60, 30);
  const ambient = new AmbientLight(0xffffff, 0.15);
  scene.add(hemi, sun, sun.target, moon, ambient);

  // The ground plane takes the horizon's color, so the city floats on the haze.
  const sea = new Mesh(new PlaneGeometry(800, 800), new MeshBasicMaterial({ color: 0x999999 }));
  sea.rotation.x = -Math.PI / 2;
  sea.position.y = -0.002;
  scene.add(sea);

  let composer = null;
  let bloomPass = null;
  if (bloom) {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    bloomPass = new UnrealBloomPass(new Vector2(256, 256), 0.5, 0.4, 0.72);
    composer.addPass(bloomPass);
    composer.addPass(new OutputPass());
  }

  const state = {
    theme,
    hazard: null,
    frame: { x: 0, y: 0 },
    width: 1,
    height: 1,
    dirty: true,
    sunElevation: 10,
    smoke: 0,
    glow: 0,
    fogNear: 45,
    fogFar: 170,
    fogScale: 1,
  };

  // ---------------- neighborhoods ----------------

  const city = new Group();
  scene.add(city);
  let ntas = null; // [{ feature, mesh, outline, areaIds, park }]
  let ntaLoad = null;

  function shapesFor(geometry) {
    const polys = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
    return polys.map((rings) => {
      const toPts = (ring) => ring.map(([lon, lat]) => new Vector2(...project(lon, lat)));
      const shape = new Shape(toPts(rings[0]));
      for (const hole of rings.slice(1)) shape.holes.push(new Path(toPts(hole)));
      return shape;
    });
  }

  function loadNtas() {
    ntaLoad ||= fetch('data/nyc-ntas.geojson')
      .then((r) => r.json())
      .then((geo) => {
        const outlineMat = new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 });
        ntas = geo.features.map((feature) => {
          const shapes = shapesFor(feature.geometry);
          const mesh = new Mesh(new ExtrudeGeometry(shapes, { depth: 1, bevelEnabled: false, curveSegments: 1 }), new MeshLambertMaterial({ color: 0xcccccc }));
          mesh.rotation.x = -Math.PI / 2;
          mesh.scale.z = BASE_HEIGHT;
          if (!mobile) {
            for (const shape of shapes) {
              const pts = shape.getPoints();
              const g = new BufferGeometry();
              g.setAttribute('position', new BufferAttribute(new Float32Array(pts.flatMap((p) => [p.x, p.y, 1.002])), 3));
              mesh.add(new LineLoop(g, outlineMat));
            }
          }
          city.add(mesh);
          return { feature, mesh, outlineMat, park: feature.properties.park, areaIds: feature.properties.areas };
        });
        return ntas;
      });
    return ntaLoad;
  }

  /**
   * values: one number per NTA (same order as the GeoJSON), NaN for "no data";
   * domain: [lo, hi]. Heights and colors ease toward these targets frame by frame.
   */
  function setNtaValues(values, domain) {
    if (!ntas) return;
    const ramp = RAMPS[state.hazard][state.theme];
    const glowRamp = RAMPS[state.hazard].dark;
    const neutral = NEUTRAL[state.theme];
    const night = 1 - daylight(state.sunElevation);
    ntas.forEach((n, i) => {
      const v = values[i];
      if (n.park || Number.isNaN(v)) {
        n.targetHeight = BASE_HEIGHT * (n.park ? 0.6 : 1);
        n.targetColor = hexToRgb(n.park ? neutral.park : neutral.land);
        n.targetGlow = [0, 0, 0];
        return;
      }
      const t = Math.min(1, Math.max(0, (v - domain[0]) / (domain[1] - domain[0])));
      n.targetHeight = BASE_HEIGHT + MAX_EXTRA * t;
      n.targetColor = rampAt(ramp, t);
      // hot places keep glowing after dark: the city "stays red"
      const g = state.glow * night * (0.2 + 0.8 * t);
      n.targetGlow = rampAt(glowRamp, t).map((c) => c * g);
    });
    ntas[0].outlineMat.color.copy(srgb(hexToRgb(neutral.paper)));
    ntas[0].outlineMat.opacity = state.theme === 'dark' ? 0.18 : 0.4;
    state.dirty = true;
  }

  function easeNtas(k) {
    if (!ntas || !city.visible) return false;
    let moving = false;
    for (const n of ntas) {
      if (n.targetHeight == null) continue;
      n.height ??= n.targetHeight;
      n.color ??= n.targetColor;
      n.glowNow ??= n.targetGlow;
      const dh = n.targetHeight - n.height;
      if (Math.abs(dh) > 0.002) moving = true;
      n.height += dh * k;
      n.color = mix(n.color, n.targetColor, k);
      n.glowNow = mix(n.glowNow, n.targetGlow, k);
      n.mesh.scale.z = n.height;
      n.mesh.material.color.copy(srgb(n.color));
      n.mesh.material.emissive.copy(srgb(n.glowNow));
    }
    return moving;
  }

  // ---------------- terrain (floods) ----------------

  const terrain = new Group();
  scene.add(terrain);
  let terrainMesh = null;
  let terrainElev = null;
  let floodSea = null;
  let terrainLoad = null;

  function loadTerrain() {
    terrainLoad ||= new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = ELEVATION.url;
    }).then((img) => {
      const size = ELEVATION.size;
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, size, size).data;
      const step = mobile ? 3 : 1;
      const n = Math.floor(size / step);
      const pos = new Float32Array(n * n * 3);
      const elev = new Float32Array(n * n);
      const land = new Uint8Array(n * n);
      for (let row = 0; row < n; row++) {
        for (let col = 0; col < n; col++) {
          const sr = Math.min(size - 1, row * step);
          const sc = Math.min(size - 1, col * step);
          const o = (sr * size + sc) * 4;
          const k = row * n + col;
          const e = Math.max(0.3, decodeElevation(px[o], px[o + 1]));
          land[k] = px[o + 2] > 0 ? 1 : 0;
          elev[k] = e;
          const [x, y] = project(...cellLonLat(sr, sc, size));
          pos.set([x, e * TERRAIN_EXAGGERATION, -y], k * 3);
        }
      }
      const idx = [];
      for (let row = 0; row < n - 1; row++) {
        for (let col = 0; col < n - 1; col++) {
          const a = row * n + col;
          const b = a + 1;
          const c2 = a + n;
          const d = c2 + 1;
          if (land[a] && land[c2] && land[b]) idx.push(a, c2, b);
          if (land[b] && land[c2] && land[d]) idx.push(b, c2, d);
        }
      }
      const geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(pos, 3));
      geo.setAttribute('elev', new BufferAttribute(elev, 1));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      terrainMesh = new Mesh(geo, floodMaterial());
      terrainElev = elev;
      floodSea = new Mesh(new PlaneGeometry(600, 600), new MeshLambertMaterial({ color: 0x5588aa, transparent: true, opacity: 0.55, depthWrite: false }));
      floodSea.rotation.x = -Math.PI / 2;
      terrain.add(terrainMesh, floodSea);
      return terrainMesh;
    });
    return terrainLoad;
  }

  // Flood shading runs per pixel: each fragment compares its interpolated
  // elevation with the water level, so the waterline is smooth between samples.
  const floodUniforms = {
    uWater: { value: -100 },
    uLand: { value: new Color() },
    uShallow: { value: new Color() },
    uDeep: { value: new Color() },
  };
  function floodMaterial() {
    const mat = new MeshLambertMaterial();
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, floodUniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float elev;\nvarying float vElev;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvElev = elev;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uWater;\nuniform vec3 uLand;\nuniform vec3 uShallow;\nuniform vec3 uDeep;\nvarying float vElev;')
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          float depth = uWater - vElev;
          float wet = smoothstep(-0.04, 0.04, depth);
          vec3 flood = mix(uShallow, uDeep, clamp(depth / 2.0, 0.0, 1.0));
          diffuseColor.rgb = mix(uLand, flood, wet);`,
        );
    };
    return mat;
  }

  /** Water level in metres (NAVD88): land below it turns to flood-ramp blue by depth. */
  let lastWater = null;
  function setWater(meters) {
    if (!terrainMesh) return;
    const memo = `${meters.toFixed(3)}|${state.theme}`;
    if (memo === lastWater) return;
    lastWater = memo;
    const ramp = RAMPS.floods[state.theme];
    // flooded land: the flood ramp by depth (1 ft of water reads Low, 6+ ft Severe)
    const u = floodUniforms;
    u.uWater.value = meters;
    u.uLand.value.copy(srgb(hexToRgb(NEUTRAL[state.theme].land)));
    u.uShallow.value.copy(srgb(hexToRgb(ramp[1])));
    u.uDeep.value.copy(srgb(hexToRgb(state.theme === 'dark' ? ramp[4] : ramp[3])));
    floodSea.position.y = Math.max(0, meters) * TERRAIN_EXAGGERATION + 0.0005;
    floodSea.material.color.copy(srgb(hexToRgb(ramp[1])));
    floodSea.material.opacity = 0.16;
    state.dirty = true;
  }

  // ---------------- light & sky ----------------

  function paintSky(top, horizon) {
    const ctx = skyCanvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    const css = (c) => `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`;
    grad.addColorStop(0, css(top));
    grad.addColorStop(0.35, css(top));
    grad.addColorStop(1, css(horizon));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 2, 256);
    skyTexture.needsUpdate = true;
    scene.fog.color.copy(srgb(horizon));
    const ground = state.hazard === 'floods' ? mix(hexToRgb(NEUTRAL[state.theme].water), hexToRgb(RAMPS.floods[state.theme][0]), 0.45) : horizon;
    sea.material.color.copy(srgb(ground));
  }

  /** Light the scene for a New York local hour, e.g. "2019-07-20T16:00" (+ fractional hours). */
  let lastTime = null;
  function setTime(key, extraHours = 0, smoke = 0) {
    const memo = `${key}|${extraHours.toFixed(3)}|${smoke.toFixed(3)}|${state.theme}|${state.hazard}`;
    if (memo === lastTime) return;
    lastTime = memo;
    const sunNow = solarPosition(nyLocalToUtc(key) + extraHours * 3600000);
    const azimuth = sunNow.azimuth;
    // the flood map keeps a stormy dusk light through the night so the water stays readable
    const elevation = state.hazard === 'floods' ? Math.max(sunNow.elevation, 0) : sunNow.elevation;
    state.sunElevation = elevation;
    state.smoke = smoke;
    const day = daylight(elevation);
    const { top, horizon } = skyAt(state.theme, elevation, smoke);
    paintSky(top, horizon);

    const floods = state.hazard === 'floods';
    // the flood map is a map first: soft, even light from the southwest so terrain and water read clearly
    const az = ((floods ? 225 : azimuth) * Math.PI) / 180;
    const el = ((floods ? 40 : Math.max(elevation, 2)) * Math.PI) / 180;
    sun.position.set(Math.sin(az) * Math.cos(el) * 100, Math.sin(el) * 100, -Math.cos(az) * Math.cos(el) * 100);
    const warm = floods ? 1 : Math.min(1, Math.max(0, elevation / 25));
    sun.color.copy(srgb(mix([1, 0.62, 0.38], [1, 0.97, 0.92], warm)));
    // Physically based lights divide by π; these are fractions of "fully lit",
    // tuned so a sunlit roof shows its ramp color without blowing out.
    const PI = Math.PI;
    sun.intensity = PI * (floods ? 0.42 : 0.62 * day * (1 - smoke * 0.5));
    moon.intensity = PI * (floods ? 0 : 0.1 * (1 - day));
    hemi.color.copy(srgb(floods ? [1, 1, 1] : mix(top, [1, 1, 1], 0.5)));
    hemi.groundColor.copy(srgb(hexToRgb(NEUTRAL[state.theme].land)));
    hemi.intensity = PI * (floods ? (state.theme === 'dark' ? 0.5 : 0.66) : 0.22 + 0.32 * day);
    ambient.intensity = PI * (floods ? 0.04 : 0.03 + 0.03 * day);

    // smoke thickens the haze, but the city always stays visible through it
    state.fogNear = 45 - 20 * smoke;
    state.fogFar = 170 - 55 * smoke;
    applyFog();
    // bloom only after dark, on the glowing (hottest) neighborhoods; never on the flood map
    if (bloomPass) bloomPass.strength = floods ? 0 : 0.55 * (1 - day) * (1 - day);
    state.dirty = true;
  }

  function applyTheme() {
    state.dirty = true;
  }

  // ---------------- camera ----------------

  function setPose(pose) {
    const { position, target } = poseToCamera(pose);
    camera.position.set(...position);
    camera.lookAt(...target);
    // haze is set for a camera ~60 km out; pulled further back (phones), it moves back too
    state.fogScale = Math.max(1, pose.dist / 60);
    applyFog();
    // keep depth precision where the city is: a far camera pushes its near plane out, so flat
    // parks and the ground never z-fight
    const near = Math.max(0.05, pose.dist * 0.02);
    if (Math.abs(camera.near - near) > 1e-3) {
      camera.near = near;
      camera.updateProjectionMatrix();
    }
    state.dirty = true;
  }

  function applyFog() {
    scene.fog.near = state.fogNear * state.fogScale;
    scene.fog.far = state.fogFar * state.fogScale;
  }

  function applySize() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    state.width = w;
    state.height = h;
    renderer.setSize(w, h, false);
    if (composer) composer.setSize(w, h);
    camera.aspect = w / h;
    camera.setViewOffset(w, h, -state.frame.x, -state.frame.y, w, h);
    camera.updateProjectionMatrix();
    state.dirty = true;
  }

  /** Shift the picture (in CSS px) so the city sits beside or above the text. */
  function setFrame(x, y) {
    if (state.frame.x === x && state.frame.y === y) return;
    state.frame = { x, y };
    camera.setViewOffset(state.width, state.height, -x, -y, state.width, state.height);
    camera.updateProjectionMatrix();
    state.dirty = true;
  }

  /** Screen position (CSS px) of a lon/lat at a height above the ground (km). */
  function toScreen(lon, lat, heightKm = 0) {
    const [x, y] = project(lon, lat);
    const v = new Vector3(x, heightKm, -y).project(camera);
    return { x: ((v.x + 1) / 2) * state.width, y: ((1 - v.y) / 2) * state.height, visible: v.z < 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2 };
  }

  /** Height (km) of the top of the neighborhood that holds a DrainWatch area. */
  function areaTop(areaId) {
    if (state.hazard === 'floods' && terrainElev) return 0.02;
    const n = ntas && ntas.find((x) => x.areaIds.includes(areaId));
    return n ? n.mesh.scale.z : BASE_HEIGHT;
  }

  async function setHazard(hazard) {
    state.hazard = hazard;
    state.glow = hazard === 'heat' ? 0.9 : hazard === 'air' ? 0.35 : 0.2;
    const floods = hazard === 'floods';
    city.visible = !floods;
    terrain.visible = floods;
    if (floods) await loadTerrain();
    else await loadNtas();
    state.dirty = true;
  }

  function setTheme(theme) {
    state.theme = theme;
    applyTheme();
  }

  function render(force = false) {
    if (easeNtas(state.instant ? 1 : 0.18)) state.dirty = true;
    if (!state.dirty && !force) return;
    state.dirty = false;
    if (composer) composer.render();
    else renderer.render(scene, camera);
  }

  window.addEventListener('resize', applySize);
  applySize();
  applyTheme();

  return {
    set instant(v) {
      state.instant = v;
    },
    setHazard,
    setTheme,
    setTime,
    setPose,
    setFrame,
    setNtaValues,
    setWater,
    toScreen,
    areaTop,
    render,
    resize: applySize,
    get ntaFeatures() {
      return ntas ? ntas.map((n) => n.feature) : null;
    },
    loadNtas,
    renderer,
  };
}
