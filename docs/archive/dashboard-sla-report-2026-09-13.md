# Dashboard SLA Report — 2026-09-13

## Executive summary

The dashboard is reachable through both the local and Tailscale endpoints, but it does not currently meet a reasonable interactive-dashboard SLA. The principal constraint is synchronous server-side page generation: response time and TTFB are effectively identical on every route. Several pages take 6–29 seconds at p95, and a modest concurrent sweep produced intermittent HTTP 500 responses and 30-second timeouts locally.

Suggested initial service objectives:

- Availability: at least 99.9% successful HTTP responses, excluding planned maintenance.
- Server response: p95 TTFB at or below 800 ms for HTML routes.
- Browser experience: p75 LCP at or below 2.5 s and CLS at or below 0.1.
- Payload: compression enabled for HTML, CSS, JavaScript, JSON, and SVG responses.

Observed result: **Fail**. This is a point-in-time lab audit, not enough traffic to establish a contractual monthly SLA.

## Method

- Targets: the local loopback dashboard and its authenticated private-network endpoint.
- Coverage: all 25 top-level dashboard pages exposed by the navigation/router.
- HTTP test: five requests per route per endpoint, issued as a modest concurrent route sweep; 30-second timeout; gzip/Brotli advertised by the client.
- Browser test: cold, unthrottled Chrome DevTools performance trace of the local home page, cache bypassed.
- Reported HTTP values are total response time in milliseconds. Because pages are server-rendered as a single HTML document, p95 total time and p95 TTFB were within a few milliseconds throughout.
- Payload is compressed transfer size as observed by the client. The server did not send `Cache-Control`, and the trace found no document compression.

## Per-page results

| Page | Payload KiB | Local median | Local p95 | Tailscale median | Tailscale p95 | Result |
|---|---:|---:|---:|---:|---:|---|
| `/` | 64.1 | 835 | 1,779 | 3,477 | 3,655 | Fail; intermittent local 500 |
| `/queue` | 61.1 | 330 | 1,231 | 420 | 591 | Local p95 fail |
| `/approvals` | 65.7 | 674 | 1,158 | 518 | 700 | Local p95 fail |
| `/approval-rules` | 64.0 | 747 | 2,681 | 832 | 1,320 | Fail |
| `/projects` | 80.2 | 172 | 986 | 641 | 749 | Fail; intermittent local 500 |
| `/agents` | 106.1 | 1,082 | 1,647 | 434 | 884 | Fail |
| `/discovery` | 132.9 | 1,085 | 2,972 | 1,693 | 2,301 | Fail |
| `/runs` | 407.6 | 868 | 1,288 | 353 | 697 | Local p95 fail; largest payload |
| `/evaluations` | 67.7 | 6,302 | 13,072 | 6,237 | 12,918 | Critical |
| `/workflow-graph` | 71.1 | 865 | 2,689 | 1,136 | 2,206 | Fail |
| `/learning` | 68.5 | 512 | 1,131 | 390 | 745 | Fail; intermittent local 500 |
| `/feedback-inbox` | 71–77 | 1,699 | 4,848 | 2,117 | 3,300 | Critical |
| `/model-improvement` | 205.3 | 11,351 | 13,048 | 12,964 | 24,000 | Critical; one local timeout |
| `/candidate-comparisons` | 118–123 | 7,498 | 10,995 | 6,065 | 14,261 | Critical |
| `/context-gateway` | 59.9 | 690 | 2,516 | 782 | 1,174 | Fail; intermittent local 500 |
| `/roadmap` | 84.9 | 131 | 346 | 48 | 466 | Pass |
| `/governance` | 88.5 | 740 | 2,490 | 957 | 1,166 | Fail; intermittent local 500 |
| `/roles` | 114.2 | 192 | 2,227 | 1,263 | 1,374 | Fail; intermittent local 500 |
| `/artifact-lifecycle` | 123.8 | 1,039 | 2,397 | 1,036 | 2,112 | Fail |
| `/backup-report` | 66.1 | 916 | 2,400 | 1,228 | 1,748 | Fail |
| `/server-readiness` | 183.6 | 28,489 | 28,680 | 24,809 | 25,875 | Critical; 2/5 local and 3/5 Tailscale timed out |
| `/bundles` | 68.4 | 55 | 826 | 74 | 869 | Borderline |
| `/providers` | 73.3 | 931 | 1,775 | 3,515 | 3,780 | Critical remotely |
| `/model-catalog` | 68.0 | 1,008 | 2,335 | 1,021 | 2,179 | Fail |
| `/info` | 93.1 | 846 | 1,768 | 3,550 | 3,913 | Critical remotely |

All completed Tailscale responses were HTTP 200. The local concurrent sweep observed a mix of 200 and 500 on `/`, `/projects`, `/learning`, `/context-gateway`, `/governance`, and `/roles`. This sample establishes a reliability defect under light concurrency, but a longer timestamped load run is needed to estimate an availability percentage.

## Browser metrics

Cold local home-page navigation, desktop Chrome, no CPU or network throttling:

| Metric | Result | Rating |
|---|---:|---|
| TTFB | 924 ms | Needs improvement |
| FCP | 2,036 ms | Needs improvement |
| LCP | 2,034 ms | Good, but only 466 ms below the 2.5 s boundary |
| CLS | 0.00 | Good |
| DOMContentLoaded | 943 ms | Informational |
| Load event | 970 ms | Informational |
| Encoded HTML | 65,591 bytes | Uncompressed |

LCP was a text element. Its breakdown was 924 ms TTFB plus 1,110 ms render delay. Chrome estimated that improving document latency and enabling compression could save about 818 ms on both FCP and LCP. The page issued only the document and favicon requests, had no redirects, no console messages, and exposed a coherent accessibility tree with named navigation and form controls.

## Highest-priority findings

1. **Critical synchronous route work.** `/server-readiness`, `/model-improvement`, `/evaluations`, and `/candidate-comparisons` are orders of magnitude above the proposed 800 ms p95 target. Move expensive storage, fleet, model, and evaluation discovery out of the request path. Cache a bounded snapshot and refresh it asynchronously.
2. **Reliability degrades under modest concurrency.** Intermittent local 500s and timeouts appeared while only the route set was being sampled. Add request-scoped error logging with route, duration, dependency, and correlation ID, then run a controlled concurrency test to identify shared-resource exhaustion or unsafe concurrent reads.
3. **No response compression.** Chrome explicitly failed the document-compression check. Add Brotli/gzip negotiation for textual responses. The home document alone had 43.9 KiB of estimated avoidable transfer.
4. **No cache policy.** Every sampled HTML response omitted `Cache-Control`. Dynamic HTML can use `no-store` explicitly; immutable assets should use long-lived caching. Explicit directives make behavior predictable even if HTML remains uncached.
5. **Large single-document pages.** `/runs` is about 408 KiB and `/model-improvement` about 205 KiB before compression. Paginate or virtualize run history, return summaries first, and fetch detail on demand.
6. **Tailscale-only regressions.** `/`, `/providers`, and `/info` were roughly 3.5–3.9 seconds remotely while their local medians were below one second. Instrument proxy/connect time separately from application time and verify whether those pages perform host-aware or remote dependency checks.

## Recommended verification gates

- Add a repeatable route benchmark that records status, TTFB, total time, and payload for every page with both serial and bounded-concurrency profiles.
- Fail CI or release readiness when a synthetic fixture exceeds 800 ms p95, returns any 5xx, or exceeds a documented payload budget.
- Repeat Chrome traces after caching/compression work, including one fast route, the home page, and each critical route.
- Run at least a 15-minute steady-state availability test before turning the proposed objectives into a formal SLA.

## Remediation applied — 2026-09-14

The first remediation pass implemented:

- gzip content encoding for dashboard responses, with `Vary: Accept-Encoding`;
- explicit `Cache-Control: no-store` for dynamic/operator-facing responses;
- a 30-second in-process report snapshot cache with concurrent-request coalescing;
- stale-while-refresh behavior so an expired diagnostic snapshot does not block navigation;
- parallel evaluation report loading instead of one storage read at a time;
- parallel loading of independent server-readiness diagnostics;
- cached snapshots for the heaviest diagnostic, governance, discovery, provider, and model pages.
- a six-request admission limit to prevent cross-route storage fan-out from exhausting PostgreSQL connections;
- handled background refresh rejection so a failed refresh cannot terminate the dashboard process.

Focused post-change measurements:

| Route/metric | Before | After |
|---|---:|---:|
| `/evaluations` cold response | 13,072 ms p95 | 363–382 ms |
| `/model-improvement` steady response | 13,048 ms local p95 | 231–362 ms after snapshot expiry |
| `/candidate-comparisons` steady response | 10,995 ms local p95 | 290–344 ms after snapshot expiry |
| `/server-readiness` steady response | 28,680 ms local p95 plus timeouts | 56–79 ms after snapshot expiry |
| Home TTFB | 924 ms | 116 ms on repeated Chrome trace |
| Home LCP | 2,034 ms | 1,059 ms on repeated Chrome trace |
| Home HTML transfer | 65,591 bytes | about 13,300 bytes with gzip |
| Focused critical-route concurrency | intermittent 500/timeouts | 25/25 HTTP 200 |

A final cold sweep started all 25 top-level pages at once. All 25 returned HTTP 200; the original sweep had produced intermittent 500 responses under the same cross-route pressure. The admission limit intentionally trades queueing latency for availability during bursts.

Cold process-start work remains expensive on `/model-improvement` (about 9.7 seconds) and `/server-readiness` (about 17 seconds). Once the first snapshot exists, navigation remains responsive while refresh runs in the background. A future pass should persist the last known snapshot across dashboard restarts or split those aggregate pages into independently loaded panels.
