/**
 * SpriteCache — loads SVG assets, rasterizes them to HTMLImageElements, and
 * serves cached sprites for the game canvas.
 *
 * Per-player color: the u-hero SVG references CSS custom properties
 * (--uvq-u-hero-body/shade/hi) with hex fallbacks. For each distinct player
 * color we inject a <style> block that overrides those vars, re-rasterize,
 * and cache the result keyed by color (and state: normal/frozen/hit).
 *
 * All other sprites (boss, mines, projectiles) are color-fixed — rasterized
 * once at startup.
 *
 * Rendering is async: if a sprite isn't in the cache yet, getSprite() kicks
 * off a load and returns null; the Renderer falls back to the legacy glyph
 * for that frame.
 */

const SVG_NAMES = [
  'u-hero',
  'q-boss',
  'q-mine',
  'projectile-u',
  'projectile-q',
];

const templates = new Map(); // name → svg text
const sprites   = new Map(); // key ("name" or "name:color:state") → HTMLImageElement | null (loading)

/** Shift a #rrggbb hex by a factor in [-1, 1]: negative darkens, positive lightens. */
function shiftHex(hex, factor) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const mix = (c) => (factor >= 0 ? Math.round(c + (255 - c) * factor) : Math.round(c * (1 + factor)));
  const to2 = (n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return `#${to2(mix(r))}${to2(mix(g))}${to2(mix(b))}`;
}

/** Preload all SVG templates. Call once at startup. */
export async function preloadSvgTemplates() {
  await Promise.all(
    SVG_NAMES.map(async (name) => {
      const res = await fetch(`/assets/svg/${name}.svg`);
      const text = await res.text();
      templates.set(name, text);
    })
  );
  // Pre-rasterize color-fixed sprites so the first frame has them.
  for (const name of ['q-boss', 'q-mine', 'projectile-u', 'projectile-q']) {
    void requestSprite(name);
  }
}

function rasterize(svgText) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => resolve(null);
    // Use a data URI so the image is self-contained (no cross-origin issues,
    // works with canvas drawImage without tainting).
    const b64 = btoa(unescape(encodeURIComponent(svgText)));
    img.src = `data:image/svg+xml;base64,${b64}`;
  });
}

/** Map a state + playerColor → the 3 CSS var overrides for the U SVG. */
function uPalette(color, state) {
  if (state === 'frozen') {
    return { body: '#88ccff', shade: '#3a6f9e', hi: '#d4ecff' };
  }
  if (state === 'hit') {
    return { body: '#ff3333', shade: '#8a1414', hi: '#ffbdbd' };
  }
  return {
    body: color,
    shade: shiftHex(color, -0.4),
    hi:    shiftHex(color,  0.4),
  };
}

/** Inject a <style> block after <defs> that overrides the U SVG's CSS vars. */
function tintedUSvg(color, state) {
  const tpl = templates.get('u-hero');
  if (!tpl) return null;
  const p = uPalette(color, state);
  const style = `<style type="text/css">:root{--uvq-u-hero-body:${p.body};--uvq-u-hero-shade:${p.shade};--uvq-u-hero-hi:${p.hi};}</style>`;
  return tpl.replace('<defs>', `<defs>${style}`);
}

function keyFor(name, color, state) {
  if (name !== 'u-hero') return name;
  return `u-hero:${color || '#000'}:${state || 'normal'}`;
}

function requestSprite(name, color, state) {
  const key = keyFor(name, color, state);
  if (sprites.has(key)) return; // already loaded or loading
  sprites.set(key, null); // mark as loading
  const svg = name === 'u-hero' ? tintedUSvg(color, state) : templates.get(name);
  if (!svg) {
    sprites.delete(key);
    return;
  }
  rasterize(svg).then((img) => {
    if (img) sprites.set(key, img);
    else sprites.delete(key); // let it retry later
  });
}

/**
 * Synchronous sprite getter. Returns a loaded HTMLImageElement or null if
 * the sprite is still loading (in which case the caller should fall back).
 *
 * @param {string} name  — 'u-hero' | 'q-boss' | 'q-mine' | 'projectile-u' | 'projectile-q'
 * @param {string} [color] — player hex color (only used for 'u-hero')
 * @param {string} [state] — 'normal' | 'frozen' | 'hit' (only used for 'u-hero')
 */
export function getSprite(name, color, state) {
  const key = keyFor(name, color, state);
  const cached = sprites.get(key);
  if (cached) return cached;
  if (cached === null) return null; // loading in progress
  requestSprite(name, color, state);
  return null;
}
