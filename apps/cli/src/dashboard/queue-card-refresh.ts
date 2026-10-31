/** Same-origin, read-only reconciliation. Never replaces Partner or submits an action. */
export function queueCardRefreshScript(): string { return `
function createQueueCardRefresher(onApplied) {
 const regions = ['counts', 'controls', 'attention', 'cards'];
 const status = document.getElementById('queue-watch-status');
 const retry = document.getElementById('queue-watch-refresh');
 const url = new URL(window.location.href);
 url.searchParams.set('_queue_snapshot', 'fresh');
 let stopped = false, busy = false, pending = false, controller = null, retryTimer = null, failures = 0, snapshot = null, applying = false;
 const key = node => node.nodeType === 1 ? node.getAttribute('data-queue-card-key') || node.id || null : null;
 const edited = node => {
  if (node.nodeType !== 1) return false;
  if (node.matches('[contenteditable="true"]')) return true;
  if (node.matches('input:not([type="hidden"]),textarea')) return node.value !== node.defaultValue || ('checked' in node && node.checked !== node.defaultChecked);
  return node.matches('select') && Array.from(node.options).some(option => option.selected !== option.defaultSelected);
 };
 const protectedNode = node => node.nodeType === 1 && (node.contains(document.activeElement)
  || node.matches('dialog[open]') || edited(node) || Array.from(node.querySelectorAll('input,textarea,select,[contenteditable="true"],dialog[open]')).some(el => edited(el) || el.matches('dialog[open]')));
 function patch(old, fresh) {
  if (old.nodeType !== fresh.nodeType || old.nodeName !== fresh.nodeName) {
   if (protectedNode(old)) return;
   const replacement = document.importNode(fresh, true); old.replaceWith(replacement); return;
  }
  if (old.nodeType !== 1) { if (old.nodeValue !== fresh.nodeValue) old.nodeValue = fresh.nodeValue; return; }
  if ((old.matches('form') && protectedNode(old)) || old.matches('dialog[open]') || edited(old)
    || (old.matches('input,textarea,select,[contenteditable]') && old === document.activeElement)) return;
  for (const attr of Array.from(old.attributes)) {
   if (attr.name === 'open' && old.matches('details,dialog')) continue;
   if (!fresh.hasAttribute(attr.name)) old.removeAttribute(attr.name);
  }
  for (const attr of Array.from(fresh.attributes)) {
   if (attr.name === 'open' && old.matches('details,dialog')) continue;
   if (old.getAttribute(attr.name) !== attr.value) old.setAttribute(attr.name, attr.value);
  }
  const children = Array.from(old.childNodes), used = new Set();
  const keyed = new Map(children.filter(node => key(node)).map(node => [key(node), node]));
  let cursor = old.firstChild;
  for (const desired of Array.from(fresh.childNodes)) {
   const id = key(desired);
   let match = id ? keyed.get(id) : children.find(node => !used.has(node) && !key(node) && node.nodeType === desired.nodeType && node.nodeName === desired.nodeName);
   if (match && used.has(match)) match = null;
   if (!match) { const added = document.importNode(desired, true); old.insertBefore(added, cursor); continue; }
   used.add(match);
   if (match !== cursor) {
    if (typeof old.moveBefore === 'function' && match.isConnected) old.moveBefore(match, cursor);
    else old.insertBefore(match, cursor);
   }
   patch(match, desired); cursor = match.nextSibling;
  }
  for (const node of children) if (!used.has(node) && node.parentNode === old && !protectedNode(node)) node.remove();
 }
 function apply(next) {
  if (stopped || applying) return;
  const pairs = regions.map(name => {
   const selector = '[data-queue-live-region="' + name + '"]';
   const current = document.querySelectorAll(selector), incoming = next.querySelectorAll(selector);
   if (current.length !== 1 || incoming.length !== 1 || incoming[0].querySelector('script,iframe,object')) throw new Error('Invalid queue fragment');
   return [current[0], incoming[0]];
  });
  const cards = Array.from(pairs[3][1].querySelectorAll('[data-queue-card-key]'));
  if (cards.length > 1000 || cards.some(el => !key(el)) || new Set(cards.map(key)).size !== cards.length) throw new Error('Invalid queue card identity');
  const focus = document.activeElement, scroll = { x: window.scrollX, y: window.scrollY };
  const selection = focus && typeof focus.selectionStart === 'number' ? [focus.selectionStart, focus.selectionEnd, focus.selectionDirection] : null;
  applying = true;
  try {
   for (const [current, incoming] of pairs) patch(current, incoming);
   if (focus?.isConnected && document.activeElement !== focus) focus.focus({ preventScroll: true });
   if (selection && focus?.isConnected) focus.setSelectionRange(...selection);
   if (window.scrollX !== scroll.x || window.scrollY !== scroll.y) window.scrollTo(scroll.x, scroll.y);
   snapshot = next;
  } finally { applying = false; }
 }
 async function request() {
  if (stopped) return;
  pending = true;
  if (busy || document.hidden) return;
  busy = true;
  clearTimeout(retryTimer);
  try {
   do {
    pending = false;
    controller = new AbortController();
    const deadline = setTimeout(() => controller?.abort(), 12000);
    try {
     const response = await fetch(url.href, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
     if (!response.ok) throw new Error('Queue refresh failed: ' + response.status);
     if (response.url) { const actual = new URL(response.url); if (actual.origin !== url.origin || actual.pathname !== url.pathname || actual.search !== url.search) throw new Error('Queue scope changed'); }
     const html = await response.text();
     if (html.length > 8000000) throw new Error('Queue fragment too large');
     if (stopped || document.hidden) { pending = true; return; }
     apply(new DOMParser().parseFromString(html, 'text/html'));
     try { const refresh = onApplied?.(); if (refresh && typeof refresh.catch === 'function') refresh.catch(() => {}); } catch {}
     failures = 0; retry.hidden = true; retry.style.display = 'none';
     const age = Number(response.headers?.get?.('x-agentflow-queue-age-ms') || 0), captured = response.headers?.get?.('x-agentflow-queue-captured-at');
     status.textContent = age > 1000 && captured
       ? 'Queue cards show a ' + Math.ceil(age / 1000) + 's snapshot while the latest state loads · captured ' + new Date(captured).toLocaleTimeString()
       : 'Queue cards updated automatically · ' + new Date().toLocaleTimeString();
     if (response.headers?.get?.('x-agentflow-queue-refreshing') === 'true') retryTimer = setTimeout(request, 500);
    } finally { clearTimeout(deadline); controller = null; }
   } while (pending && !stopped && !document.hidden);
  } catch (error) {
   if (stopped) return;
   pending = true; failures++;
   status.textContent = 'Card updates reconnecting; existing cards and drafts are preserved.';
   retry.textContent = 'Retry card update'; retry.hidden = false; retry.style.display = 'inline-flex';
   retryTimer = setTimeout(request, Math.min(30000, 2000 * Math.pow(2, Math.min(failures - 1, 4))));
  } finally { busy = false; }
 }
 const interactionEnded = () => { if (snapshot && !applying && !stopped) apply(snapshot); };
 const visible = () => { if (document.hidden) { controller?.abort(); clearTimeout(retryTimer); } else if (pending) request(); };
 retry.addEventListener('click', request);
 document.addEventListener('focusout', interactionEnded);
 document.addEventListener('change', interactionEnded);
 document.addEventListener('visibilitychange', visible);
 return { request, applySnapshot: apply, stop() { stopped = true; controller?.abort(); clearTimeout(retryTimer); retry.removeEventListener('click', request); document.removeEventListener('focusout', interactionEnded); document.removeEventListener('change', interactionEnded); document.removeEventListener('visibilitychange', visible); } };
}
`; }
