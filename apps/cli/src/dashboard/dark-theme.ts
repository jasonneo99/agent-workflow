/** Dark-theme overrides derived from the base (light) stylesheet.
 *
 * Most dashboard components were written with light backgrounds and dark
 * text. The dark theme only restyled the home and queue "ops" components, so
 * every other panel kept a light background under light dark-theme text, or a
 * dark background under dark text. This walks the base rules and, for each
 * colour that would read wrong in dark mode, emits the same selector scoped to
 * html[data-theme="dark"] (inserted before the dark ops theme) with a colour of the same hue mapped to the dark
 * palette. Colours that already suit a dark page (saturated buttons, the dark
 * run log, white text on solid fills) are left alone.
 */

// :where() adds no specificity, so the dark "ops" theme rules that follow
// still win wherever they already style a component.
const DARK_SCOPE = ':where(html[data-theme="dark"])';

type Role = "text" | "background" | "border";

function parseHex(hex: string): [number, number, number] | null {
  const raw = hex.slice(1);
  const full = raw.length === 3 ? [...raw].map(c => c + c).join("") : raw.length === 6 ? raw : null;
  if (!full) return null;
  return [0, 2, 4].map(i => Number.parseInt(full.slice(i, i + 2), 16) / 255) as [number, number, number];
}

function toHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function toHex([h, s, l]: [number, number, number]): string {
  const hue = (p: number, q: number, t: number) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    return u < 1 / 6 ? p + (q - p) * 6 * u : u < 1 / 2 ? q : u < 2 / 3 ? p + (q - p) * (2 / 3 - u) * 6 : p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const rgb = s === 0 ? [l, l, l] : [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)];
  return `#${rgb.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** Map one colour for its role, or return null when it already suits dark mode. */
export function darkColor(hex: string, role: Role): string | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [h, s, l] = toHsl(rgb);
  if (role === "text") {
    // Dark and mid text becomes light text of the same hue.
    if (l >= 0.6) return null;
    return toHex([h, Math.min(s, 0.75), 0.93 - l * 0.4]);
  }
  if (role === "background") {
    // Light surfaces and tints become dark surfaces with a hint of the hue.
    if (l <= 0.8) return null;
    return toHex([h, s * 0.55, 0.07 + (1 - l) * 0.9]);
  }
  if (l <= 0.7) return null;
  return toHex([h, s * 0.45, 0.2 + (1 - l) * 0.3]);
}

function roleFor(property: string): Role | null {
  if (property === "color") return "text";
  if (property === "background" || property === "background-color" || property === "background-image") return "background";
  if (/^border(-(top|right|bottom|left))?(-color)?$/u.test(property) || property === "outline-color") return "border";
  return null;
}

function mapDeclarations(body: string): string[] {
  const out: string[] = [];
  for (const declaration of body.split(";")) {
    const index = declaration.indexOf(":");
    if (index < 0) continue;
    const property = declaration.slice(0, index).trim().toLowerCase();
    const value = declaration.slice(index + 1).trim();
    const role = roleFor(property);
    if (!role || value.includes("var(")) continue;
    let changed = false;
    const mapped = value
      .replace(/\b(white)\b/giu, "#ffffff")
      .replace(/#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/giu, hex => {
        const next = darkColor(hex, role);
        if (next) changed = true;
        return next ?? hex;
      });
    if (changed) out.push(`${property}: ${mapped}`);
  }
  return out;
}

function scopeSelector(selector: string): string | null {
  const parts = selector.split(",").map(part => part.trim()).filter(Boolean);
  if (parts.some(part => part.includes("data-theme"))) return null;
  // The page background itself is owned by the dark ops theme.
  const scoped = parts.filter(part => !/^(html|body|:root)$/u.test(part)).map(part =>
    part.startsWith("html ") ? `${DARK_SCOPE}${part.slice(4)}` : `${DARK_SCOPE} ${part}`);
  return scoped.length ? scoped.join(", ") : null;
}

/** Split CSS into top-level blocks: [prelude, body] pairs, matching braces. */
function blocks(css: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let depth = 0, start = 0, open = -1;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === "{") { if (depth === 0) open = i; depth++; }
    else if (c === "}") {
      depth--;
      if (depth === 0 && open >= 0) { out.push([css.slice(start, open).trim(), css.slice(open + 1, i)]); start = i + 1; open = -1; }
    }
  }
  return out;
}

/** Dark overrides for every base rule whose colours would read wrong on a dark page. */
export function deriveDarkOverrides(baseCss: string): string {
  const rules: string[] = [];
  for (const [prelude, body] of blocks(baseCss)) {
    if (prelude.startsWith("@keyframes") || prelude.startsWith("@font-face")) continue;
    if (prelude.startsWith("@media")) {
      if (prelude.includes("print")) continue;
      const inner = deriveDarkOverrides(body);
      if (inner) rules.push(`${prelude} { ${inner} }`);
      continue;
    }
    if (prelude.startsWith("@")) continue;
    const selector = scopeSelector(prelude);
    const declarations = selector ? mapDeclarations(body) : [];
    if (selector && declarations.length) rules.push(`${selector} { ${declarations.join("; ")}; }`);
  }
  return rules.join("\n");
}

/** Theme bootstrap: a stored choice wins, otherwise follow the system setting. */
export const themeBootstrapScript = "let theme='light';try{const stored=window.localStorage.getItem(key);theme=stored==='dark'||stored==='light'?stored:(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')}catch{}";
