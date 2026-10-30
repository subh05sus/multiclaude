// apple-glass kit: the Liquid Glass lens, framework-free. glass.tsx builds on
// it, and `attachLiquidGlass` drops it onto any element without React.

/**
 * What makes glass read as Liquid Glass rather than frosted plastic is what
 * happens at the rim: the pane is a thick slab with a rounded edge, so light
 * passing through the edge bends inward (the content behind is pulled and
 * squeezed toward the rim) and the curved edge catches the light as a bright
 * specular line. The middle stays flat and clear.
 *
 * This module models that as optics, not as a ramp:
 *   - The edge profile is a convex squircle, h(x) = (1 - (1 - x)^4)^(1/4):
 *     vertical at the rim, flat where the bezel meets the face, the shape of
 *     Apple's continuous curves.
 *   - A ray looking straight down meets the surface at the slope of that
 *     profile and refracts by Snell's law (n = 1.5, glass). How far it
 *     travels sideways before reaching the content behind is the push.
 *   - The push becomes an SVG displacement map (red = x, green = y,
 *     128 = none) sized to the element's exact width, height and radius.
 *   - A second map is the specular rim: brightest where the edge faces the
 *     light (top left), a dimmer catch on the opposite side, falling off
 *     within a few pixels of the rim plus a soft sheen across the bevel.
 *
 * Only Chromium applies an SVG filter inside `backdrop-filter`. Safari (and
 * so every iOS browser) and Firefox get the frosted layers from
 * liquid-glass.css, whose rim lighting imitates the edge without the bend.
 */

const IOR = 1.5;
const SAMPLES = 256;
const LIGHT = normalize(-0.45, -0.89); // from the top, a little to the left

function normalize(x, y) {
  const l = Math.hypot(x, y) || 1;
  return [x / l, y / l];
}

/** The convex squircle edge: 0 at the rim, 1 where the face begins. */
function height(x) {
  return (1 - (1 - x) ** 4) ** 0.25;
}

/**
 * The push at each step across the bezel, rim (index 0) to face (last),
 * normalised so the largest is 1. `thickness` is the slab's height as a
 * share of the bezel width: thicker glass bends more and further in.
 */
function refractionProfile(thickness) {
  const out = new Float32Array(SAMPLES);
  let max = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const x = Math.min(Math.max((i + 0.5) / SAMPLES, 1e-4), 1 - 1e-4);
    const dx = 1e-3;
    const slope =
      ((height(Math.min(x + dx, 1)) - height(Math.max(x - dx, 0))) /
        (2 * dx)) *
      thickness;
    const incidence = Math.atan(slope);
    const refracted = Math.asin(Math.sin(incidence) / IOR);
    // The ray leaves the curved top tilted inward by (incidence - refracted)
    // and runs down through the glass under it plus a little air before it
    // meets the content.
    const depth = thickness * (height(x) + 0.35);
    const push = Math.tan(incidence - refracted) * depth;
    out[i] = push;
    if (push > max) max = push;
  }
  for (let i = 0; i < SAMPLES; i++) out[i] /= max || 1;
  return out;
}

// The most the rim may magnify. The optical profile drops steeply right at
// the rim, so a strong push there would fold the content back on itself:
// infinitely stretched streaks, then a mirror image. Capping how fast the
// push may fall keeps the mapping one-to-one, so the rim reads as a band of
// magnified, curved content, the way a thick polished edge looks.
const MAX_MAGNIFY = 3;

const profiles = new Map();
/** The profile for this thickness, flattened at the rim for `push / bezel`. */
function profileFor(thickness, ratio) {
  const key = `${Math.round(thickness * 100)}:${Math.round(ratio * 100)}`;
  let p = profiles.get(key);
  if (p) return p;
  p = refractionProfile(Math.round(thickness * 100) / 100);
  // Sample position s(d) = d + push(d) must keep rising: s'(d) >= 1/MAX_MAGNIFY.
  const step = (1 - 1 / MAX_MAGNIFY) / Math.max(ratio, 1e-3) / SAMPLES;
  for (let i = SAMPLES - 2; i >= 0; i--) p[i] = Math.min(p[i], p[i + 1] + step);
  profiles.set(key, p);
  return p;
}

/** Lens strengths. Regular glass bends gently; clear glass, over media, more. */
export const LENS = {
  regular: {
    bezel: 0.42, // share of the short side that curves
    maxBezel: 26, // px: a sidebar's edge is as thick as a button's, not wider
    thickness: 0.9,
    chroma: 0.06,
    frost: 2, // px of blur before the bend; the face stays readable
    specular: 0.85,
    push: 0.75, // largest push in px, as a share of the bezel width
    maxPush: 30,
  },
  clear: {
    bezel: 0.48,
    maxBezel: 40,
    thickness: 1.2,
    chroma: 0.07,
    frost: 0.6,
    specular: 1,
    push: 0.8,
    maxPush: 48,
  },
};

/**
 * Both maps for a rounded rectangle of w x h CSS px with corner radius r
 * and a curved rim `bezel` px wide that pushes the content up to `push` px.
 * Returns data URLs.
 */
export function buildLensMaps(w, h, r, bezel, { push, thickness = 0.9, specular = 0.85 }) {
  const disp = document.createElement("canvas");
  const spec = document.createElement("canvas");
  disp.width = spec.width = w;
  disp.height = spec.height = h;
  const dctx = disp.getContext("2d");
  const sctx = spec.getContext("2d");
  if (!dctx || !sctx) return null;
  const dImg = dctx.createImageData(w, h);
  const sImg = sctx.createImageData(w, h);
  const D = dImg.data;
  const S = sImg.data;
  const rim = Math.max(bezel, 1);
  const profile = profileFor(thickness, push / rim);
  const hw = w / 2;
  const hh = h / 2;

  for (let y = 0; y < h; y++) {
    const py = y + 0.5 - hh;
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - hw;
      const i = (y * w + x) * 4;
      // Signed distance to the rounded rectangle; d = how far in from the rim.
      const qx = Math.abs(px) - (hw - r);
      const qy = Math.abs(py) - (hh - r);
      const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
      const inside = Math.min(Math.max(qx, qy), 0);
      const d = r - outside - inside;

      D[i] = 128;
      D[i + 1] = 128;
      D[i + 2] = 128;
      D[i + 3] = 255;
      if (d <= 0 || d >= rim) continue;

      // The outward edge normal.
      let nx;
      let ny;
      if (qx > 0 && qy > 0) {
        const len = Math.hypot(qx, qy) || 1;
        nx = qx / len;
        ny = qy / len;
      } else if (qx > qy) {
        nx = 1;
        ny = 0;
      } else {
        nx = 0;
        ny = 1;
      }
      if (px < 0) nx = -nx;
      if (py < 0) ny = -ny;

      const t = d / rim; // 0 at the rim, 1 at the face
      const mag = profile[Math.min(SAMPLES - 1, Math.floor(t * SAMPLES))];
      // Sample from further in: the content is pulled toward the rim.
      D[i] = 128 - nx * mag * 127;
      D[i + 1] = 128 - ny * mag * 127;

      // Specular: a thin bright line right at the rim plus a soft sheen over
      // the steep part of the bevel, strongest where the edge faces the light.
      const facing = nx * LIGHT[0] + ny * LIGHT[1];
      const lit = Math.max(facing, 0) ** 1.6 + 0.55 * Math.max(-facing, 0) ** 1.6;
      const line = Math.exp(-d / 0.9);
      const sheen = 0.22 * (1 - t) ** 2.4;
      const a = Math.min(1, (line * 0.95 + sheen) * (0.18 + 0.82 * lit)) * specular;
      S[i] = 255;
      S[i + 1] = 255;
      S[i + 2] = 255;
      S[i + 3] = Math.round(a * 255);
    }
  }

  dctx.putImageData(dImg, 0, 0);
  sctx.putImageData(sImg, 0, 0);
  return { displacement: disp.toDataURL(), specular: spec.toDataURL() };
}

/**
 * The <filter> element as markup. Frost a little, bend each colour channel
 * by a slightly different amount (the fringe at the rim), screen them back
 * together, then lay the specular rim over the result.
 */
export function lensFilterMarkup(id, w, h, maps, { push, chroma = 0.06, frost = 2 }) {
  // A full-strength map value is 0.5 away from neutral, so the scale is
  // twice the push.
  const bend = (k, ch, matrix) => `
    <feDisplacementMap in="frost" in2="map" scale="${(2 * push * k).toFixed(2)}" xChannelSelector="R" yChannelSelector="G" result="bend${ch}"/>
    <feColorMatrix in="bend${ch}" type="matrix" values="${matrix}" result="${ch}"/>`;
  return `<filter id="${id}" x="0" y="0" width="${w}" height="${h}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
    <feGaussianBlur in="SourceGraphic" stdDeviation="${frost}" edgeMode="duplicate" result="frost"/>
    <feImage href="${maps.displacement}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="map"/>
    ${bend(1, "r", "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0")}
    ${bend(1 + chroma, "g", "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0")}
    ${bend(1 + chroma * 2, "b", "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0")}
    <feBlend in="r" in2="g" mode="screen" result="rg"/>
    <feBlend in="rg" in2="b" mode="screen" result="bent"/>
    <feImage href="${maps.specular}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="spec"/>
    <feComposite in="spec" in2="bent" operator="over"/>
  </filter>`;
}

let support = null;

/** True where the browser applies an SVG filter inside backdrop-filter. */
export function supportsBackdropRefraction() {
  if (support !== null) return support;
  if (typeof navigator === "undefined" || typeof CSS === "undefined") return false;
  const ua = navigator.userAgent;
  // Every iOS browser is WebKit underneath, whatever its name says.
  const iOS =
    /iPhone|iPad|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const chromium = /Chrome\/|Chromium\/|Edg\//.test(ua) && !/Firefox/.test(ua);
  support = chromium && !iOS && CSS.supports("backdrop-filter", "blur(1px)");
  return support;
}

/**
 * Everything needed for one element at its current size: the maps, the
 * filter markup and the backdrop-filter value. `tail` runs before the bend
 * (saturation and the luminosity shift), so the specular rim stays bright.
 */
export function lensFor(el, id, opts = {}) {
  const kind = opts.variant === "clear" ? "clear" : "regular";
  const L = LENS[kind];
  const w = Math.round(el.offsetWidth);
  const h = Math.round(el.offsetHeight);
  if (w < 4 || h < 4) return null;
  const short = Math.min(w, h);
  const r = Math.min(opts.radius ?? short / 2, w / 2, h / 2);
  const bezel = Math.min(opts.bezel ?? Math.min(short * L.bezel, L.maxBezel), short / 2);
  const push = opts.depth ?? Math.min(bezel * L.push, L.maxPush);
  const maps = buildLensMaps(w, h, r, bezel, {
    push,
    thickness: opts.thickness ?? L.thickness,
    specular: opts.specular ?? L.specular,
  });
  if (!maps) return null;
  const markup = lensFilterMarkup(id, w, h, maps, {
    push,
    chroma: opts.chroma ?? L.chroma,
    frost: opts.frost ?? L.frost,
  });
  const tail =
    kind === "clear"
      ? "saturate(150%)"
      : "saturate(var(--glass-saturate, 180%)) brightness(var(--glass-luma, 1))";
  return { w, h, markup, backdrop: `${tail} url(#${id})` };
}

let uid = 0;

/**
 * Vanilla use: `attachLiquidGlass(el, { variant: "regular" })` on an element
 * that already has the `.liquid-glass` class. Rebuilds the maps only once a
 * resize settles. Returns a function that removes the lens again.
 */
export function attachLiquidGlass(el, opts = {}) {
  if (!supportsBackdropRefraction()) return () => {};
  const base = `liquid-lens-${++uid}`;
  let version = 0;
  let size = "";
  let settle = 0;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.style.cssText = "position:absolute;pointer-events:none";
  el.appendChild(svg);

  const build = () => {
    const key = `${el.offsetWidth}x${el.offsetHeight}`;
    if (key === size) return;
    // A fresh id per map: some engines cache a filter's output by id.
    const lens = lensFor(el, `${base}-${++version}`, opts);
    if (!lens) return;
    size = key;
    svg.innerHTML = lens.markup;
    el.style.backdropFilter = lens.backdrop;
    el.style.webkitBackdropFilter = lens.backdrop;
  };
  build();
  const observer = new ResizeObserver(() => {
    clearTimeout(settle);
    settle = setTimeout(build, 160);
  });
  observer.observe(el);
  return () => {
    observer.disconnect();
    clearTimeout(settle);
    svg.remove();
    el.style.backdropFilter = "";
    el.style.webkitBackdropFilter = "";
  };
}
