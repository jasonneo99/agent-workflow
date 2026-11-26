import assert from "node:assert/strict";
import test from "node:test";
import { dashboardCss } from "./styles.js";
import { darkColor, deriveDarkOverrides, themeBootstrapScript } from "./dark-theme.js";

function luminance(hex: string): number {
  const raw = hex.replace("#", "");
  const full = raw.length === 3 ? [...raw].map(c => c + c).join("") : raw;
  const channels = full.match(/../gu)!.map(value => Number.parseInt(value, 16) / 255)
    .map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}
function contrastRatio(foreground: string, background: string): number {
  const [a, b] = [luminance(foreground), luminance(background)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function token(block: string, name: string): string {
  const match = block.match(new RegExp(`--${name}: (#[0-9a-f]{6}|#[0-9a-f]{3})\\b`, "iu"));
  assert.ok(match, `missing --${name}`);
  return match[1]!;
}
const css = typeof dashboardCss === "function" ? (dashboardCss as () => string)() : String(dashboardCss);
const lightBlock = css.slice(css.indexOf('html:not([data-theme="dark"]) { color-scheme: light;'));

test("light theme muted and amber text meet WCAG AA on page and panel backgrounds", () => {
  for (const name of ["ops-muted", "ops-amber", "ops-text"]) {
    for (const background of ["ops-bg", "ops-panel", "ops-panel-2"]) {
      const ratio = contrastRatio(token(lightBlock, name), token(lightBlock, background));
      assert.ok(ratio >= 4.5, `${name} on ${background} is ${ratio.toFixed(2)}:1`);
    }
  }
});

test("light theme keeps light text inside the dark run log", () => {
  assert.match(css, /html:not\(\[data-theme="dark"\]\) \.run-live-entry strong \{ color: #f8fafc; \}/u);
});

test("dark theme tokens meet WCAG AA on dark page and panel backgrounds", () => {
  const darkBlock = css.slice(css.indexOf(":root { color-scheme: dark;"));
  for (const name of ["ops-muted", "ops-text"]) {
    for (const background of ["ops-bg", "ops-panel", "ops-panel-2"]) {
      const ratio = contrastRatio(token(darkBlock, name), token(darkBlock, background));
      assert.ok(ratio >= 4.5, `${name} on ${background} is ${ratio.toFixed(2)}:1`);
    }
  }
});

test("dark overrides remap light surfaces and dark text from the base rules", () => {
  const overrides = deriveDarkOverrides(".card { background: #f8fafc; color: #334155; border: 1px solid #e2e8f0; } .solid { background: #2563eb; color: #fff; } @media (max-width: 600px) { .tint { background: #fef2f2; } } @keyframes k { to { color: #000; } }");
  assert.match(overrides, /^:where\(html\[data-theme="dark"\]\) \.card \{ background: #[0-9a-f]{6}; color: #[0-9a-f]{6}; border: 1px solid #[0-9a-f]{6}; \}/mu);
  assert.doesNotMatch(overrides, /\.solid/u, "saturated fills and white text already suit dark mode");
  assert.match(overrides, /@media \(max-width: 600px\) \{ :where\(html\[data-theme="dark"\]\) \.tint/u);
  assert.doesNotMatch(overrides, /@keyframes/u);
  const card = overrides.match(/\.card \{ background: (#[0-9a-f]{6}); color: (#[0-9a-f]{6})/u)!;
  assert.ok(contrastRatio(card[2]!, card[1]!) >= 4.5, "remapped text stays readable on the remapped surface");
  assert.ok(css.indexOf(':where(html[data-theme="dark"])') < css.indexOf(":root { color-scheme: dark;"), "ops dark theme rules still win");
});

test("theme follows the system setting until the user chooses", () => {
  assert.match(themeBootstrapScript, /prefers-color-scheme: dark/u);
  assert.match(themeBootstrapScript, /stored==='dark'\|\|stored==='light'\?stored/u);
  assert.equal(darkColor("#2563eb", "background"), null);
});
