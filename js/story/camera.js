// Camera poses and paths for the 3D story. A pose is map-like:
//   { lon, lat, dist (km from camera to target), bearing (compass degrees the
//     camera faces), tilt (degrees from straight down) }
// Scroll progress picks a point on a path of keyframes; nothing here touches
// the DOM or WebGL, so it is unit-tested.

import { project } from './geo.js';

const rad = (d) => (d * Math.PI) / 180;

export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
export const clamp01 = (t) => Math.min(1, Math.max(0, t));

/** Scene coordinates (x east, y up, z south, km) of a pose's target and camera. */
export function poseToCamera(pose) {
  const [tx, ty] = project(pose.lon, pose.lat);
  const tilt = rad(Math.max(0.5, Math.min(85, pose.tilt)));
  const behind = rad(pose.bearing + 180); // the camera sits opposite the way it faces
  const horizontal = pose.dist * Math.sin(tilt);
  return {
    target: [tx, 0, -ty],
    position: [tx + horizontal * Math.sin(behind), pose.dist * Math.cos(tilt), -(ty + horizontal * Math.cos(behind))],
  };
}

/** Shortest signed turn from bearing a to bearing b, in degrees (−180, 180]. */
export function turn(a, b) {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

/**
 * Interpolate between two poses. `arc` > 0 pulls the camera back mid-flight
 * (like a map "fly to"), so long moves never skim through the city.
 */
export function lerpPose(a, b, t, { arc = 0, ease = easeInOutCubic } = {}) {
  const e = ease(clamp01(t));
  const dist = a.dist * (b.dist / a.dist) ** e * (1 + arc * Math.sin(Math.PI * e));
  return {
    lon: a.lon + (b.lon - a.lon) * e,
    lat: a.lat + (b.lat - a.lat) * e,
    dist,
    bearing: (a.bearing + turn(a.bearing, b.bearing) * e + 360) % 360,
    tilt: a.tilt + (b.tilt - a.tilt) * e,
  };
}

/**
 * A path of keyframes [{ at: 0..1, pose, arc? }]. Returns the pose at progress p.
 * Between keyframes the camera eases; `arc` on the destination key adds the pull-back.
 */
export function poseAt(path, p) {
  if (p <= path[0].at) return { ...path[0].pose };
  for (let i = 1; i < path.length; i++) {
    const k = path[i];
    if (p <= k.at) {
      const prev = path[i - 1];
      const t = (p - prev.at) / (k.at - prev.at || 1);
      return lerpPose(prev.pose, k.pose, t, { arc: k.arc || 0 });
    }
  }
  return { ...path[path.length - 1].pose };
}

/**
 * Pinned "step" sections: step i owns the slice [i/n, (i+1)/n] of the scroll.
 * The camera flies from the previous pose during the first `fly` share of the
 * slice, then holds still so the reader can read the annotation.
 */
export function stepPath(poses, { start = null, fly = 0.45, arc = 0.6 } = {}) {
  const n = poses.length;
  const path = [{ at: 0, pose: start || poses[0] }];
  poses.forEach((pose, i) => {
    path.push({ at: (i + fly) / n, pose, arc });
    path.push({ at: (i + 1) / n, pose });
  });
  return path;
}

/** Which step a progress value is in, and how far through it (0..1). */
export function stepAt(p, steps) {
  const i = Math.min(steps - 1, Math.max(0, Math.floor(p * steps)));
  return { index: i, local: clamp01(p * steps - i) };
}
