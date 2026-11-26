import assert from "node:assert/strict";
import test from "node:test";
import { dashboardCss } from "./styles.js";

const phone = (() => {
  const css = dashboardCss();
  const start = css.indexOf("@media (max-width: 560px) {");
  return css.slice(start, css.indexOf("@media (prefers-reduced-motion", start));
})();

test("single-column phone grids can shrink below their content width", () => {
  assert.match(phone, /\.meta-grid, \.split-grid,[^{]+\{ grid-template-columns: minmax\(0, 1fr\);/u);
  assert.match(phone, /\.section-heading \{ grid-template-columns: minmax\(0, 1fr\); \}/u);
  assert.match(phone, /\.meta-grid > \*, \.split-grid > \*, \.section-heading > \* \{ min-width: 0; overflow-wrap: anywhere; \}/u);
  assert.match(phone, /main :where\(p, li, summary[^)]*\) \{ overflow-wrap: anywhere; \}/u);
});

test("phone layout reserves room for the floating Partner button", () => {
  assert.match(phone, /main \{ padding-bottom: 88px; \}/u);
  assert.match(phone, /body \.queue-partner-toggle \{[^}]*bottom: 12px/u);
});
