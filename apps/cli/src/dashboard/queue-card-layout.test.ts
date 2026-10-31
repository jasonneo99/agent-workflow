import assert from 'node:assert/strict';
import test from 'node:test';
import {dashboardCss} from './styles.js';

test('queue cards contain long content and wrap controls without widening the page', () => {
  const css = dashboardCss();
  assert.match(css, /\.queue-card-list \{[^}]*min-width: 0;[^}]*max-width: 100%;/u);
  assert.match(css, /\.queue-card \{[^}]*min-width: 0;[^}]*max-width: 100%;[^}]*overflow: hidden;/u);
  assert.match(css, /\.queue-card-header > \*, \.queue-card-footer > \*, \.queue-stage-summary, \.queue-family-attempts \{ min-width: 0; max-width: 100%; \}/u);
  assert.match(css, /\.queue-card-header > \.actions \{[^}]*flex-wrap: wrap;/u);
  assert.match(css, /\.queue-primary-actions \{[^}]*flex-wrap: wrap;[^}]*min-width: 0;/u);
  assert.match(css, /\.queue-card-title p \{[^}]*overflow-wrap: anywhere;/u);
});
