# Dashboard UX review — 2026-11-26

This review changed no code and commits nothing. Screenshots are in
`.agent-workflow/reports/dashboard-ux-2026-11-26/` (gitignored), named
`<page>-<desktop|phone>-<light|dark>.png`. Per-page measurements are in `audit.json` in the same folder.

## Setup

- **Isolation:** I ran a separate dashboard instance on port 17999 from a clean
  worktree of HEAD (9a231c8). It used a throwaway PostgreSQL database and
  `DEFAULT_MODEL_PROVIDER=mock`. The live dashboard and daemon were not touched.
  Afterwards I stopped the instance and removed both the database and the worktree.
- **Seed data:** three throwaway projects (billing-api, web-portal, mobile-app) with
  seven runs:
  - two completed (answer-question, review-pr)
  - one blocked (build-feature, no environment profiles)
  - one failed (review-pr, made failed by a direct update in the throwaway database)
  - two queued (no worker running)
  - one ship-release run holding a pending staging deployment approval
- **Capture:** Playwright with deviceScaleFactor 1, at 1440×900 and 390×844.
  - **Desktop light:** 34 routes, including a bad run id and an unknown path.
  - **Phone light:** the same 34 routes.
  - **Dark (both widths):** 8 key pages: home, queue, runs, a blocked run,
    approvals, learning, settings and Studio.
- **Theme:** dark mode is a manual toggle stored in localStorage
  (`agentflow.dashboard.theme`). It does not follow the system setting.
- **Automated checks per page:**
  - time to first byte (TTFB)
  - page height
  - horizontal overflow on phone
  - text contrast (WCAG AA)
  - form fields without labels, and buttons or links without a name
  - landmarks and skip link
  - where the first Tab key press lands

## Ranked fixes

| # | Page | Screenshot | What's wrong | Proposed change | Effort | Studio overlap |
|---|---|---|---|---|---|---|
| 1 | Home | `home-desktop-light.png` | The first screen does not answer the three questions a user arrives with: what is running, what failed, and what needs me. It shows a decorative wave, six KPI counters and 7-day charts. The real answer, the "Human intervention" list (failed run, blocked run, pending approval, missing worker and supervisor), sits about 1,900 px down. | Put "Needs you", "Running now" and "Recently failed or blocked" as three compact lists at the top, each row linking to the run or approval. Drop the wave. Move the charts below the fold. | M | Yes: home renders in `commands/daemon.ts` |
| 2 | Home, Queue | `home-desktop-light.png`, `queue-desktop-light.png` | Blocked is not a visible state. The Run health donut and the throughput legend show only Completed, Failed and Active, so the blocked run is counted as Active. The Queue header says "Watching 2 active runs" and lists Failed Runs 1 but no blocked count. The "Human intervention 5" counter does not match any list the user can see. | Make Blocked its own state and colour in every rollup, legend and KPI. Make the intervention counter a link to the list it counts. | S–M | Yes: `daemon.ts`, `dashboard/home-metrics.ts` |
| 3 | Runs, Studio | `runs-desktop-light.png`, `studio-desktop-light.png` | Progress is promised when nothing is running. With no worker and no supervisor, a queued run shows "~1.0s remaining". Studio says "Work is in progress — Studio will continue automatically". | When there is no live worker heartbeat, show "Waiting — no worker is running" with a link to start one, and suppress the ETA. | S | Yes: `dashboard/run-eta.ts` and `dashboard/studio.ts` (Studio) |
| 4 | All pages, dark | `home-desktop-dark.png`, `queue-desktop-dark.png`, `runs-desktop-dark.png`, `approvals-desktop-dark.png`, `learning-desktop-dark.png`, `settings-desktop-dark.png` | Dark theme text fails contrast badly: agent-flow chips 1.3:1, "Original request" summaries 1.8:1, form labels and stat labels 2.6:1, learning sub-navigation 3.0:1. The theme also ignores the system dark-mode setting. | Retune the dark muted and label tokens to at least 4.5:1. Use the system setting as the default until the user toggles. | M | Partly: tokens in `dashboard/styles.ts`; the theme script is in `daemon.ts` |
| 5 | Every page intro; run pages | `runs-desktop-light.png`, `run-99e34c4e-desktop-light.png` | Light theme muted text (`--ops-muted #64748b` on `#f7f8fb`) is 4.48:1, just under AA, and it is used for every page subtitle. Stage-agent names and "cancelled" labels on the run timeline are 3.8–3.9:1. | Darken `--ops-muted` slightly (for example `#5b6577`) and the stage label colour. This is one token change. | S | No: `dashboard/styles.ts` only |
| 6 | Bad URLs | `run-does-not-desktop-light.png`, `nonexistent-page-desktop-light.png` | An unknown path returns HTTP 200 with the home page, so typos look like success. A bad run id returns HTTP 500 with a bare "Dashboard request failed." and no navigation. | Return a 404 page inside the normal layout: "Run not found" or "Page not found", with links to Runs and Home. Keep 500 for real failures, and render it inside the layout too. | S | Yes: router in `daemon.ts` |
| 7 | Navigation | `home-desktop-light.png`, `home-phone-light.png` | About 30 links in four collapsible groups. Approvals has no pending-count badge in the main dashboard (Studio has one). Studio is listed under "Work" but opens a different, dark-only product shell. | Keep five top-level items: Home, Queue, Approvals (with badge), Runs, Projects. Put the rest under "More". Give Studio its own clearly labelled entry. | M | Yes: nav in `daemon.ts`, Studio entry point |
| 8 | Runs | `runs-desktop-light.png` | Each row is 5–7 lines tall: short id plus full UUID, full absolute project path, task text repeated three times (title, "For project: …", "Original request"), title-cased ids ("Review Pr"). There is no status filter. | One line per run: short id (copy button), project name (path on hover), task once, the workflow's display name. Add status chips (Failed, Blocked, Queued, Running, Completed). | M | Yes: `daemon.ts` |
| 9 | Run detail | `run-99e34c4e-desktop-light.png`, `run-99e34c4e-phone-light.png` | The page title is the raw UUID. Five "… JSON" export buttons are the most prominent header controls. Four equally styled primary recovery buttons sit next to a separate orange "Skip blocked stage" form, so the recommended action is not obvious. | Use the task as the title and keep the id as secondary text. Collapse the exports into one "Export" menu. Make the recommended next action the only primary button; make the others secondary. | M | Yes: `daemon.ts` |
| 10 | Settings, Bundles, Run (completed), Graph, Model catalog | `settings-phone-light.png`, `bundles-phone-light.png`, `run-22058403-phone-light.png`, `workflow-graph-phone-light.png`, `model-catalog-phone-light.png` | Horizontal overflow at 390 px: page widths are 566, 592, 428, 415 and 400 px. On phone the floating "Partner" button covers stat cards and buttons (`run-99e34c4e-phone-light.png`). | Wrap long paths and code (`overflow-wrap:anywhere`), make wide tables scroll inside their own container, and reserve bottom padding for the floating button or dock it into the header on phone. | S–M | Partly: `styles.ts`; the Partner overlay is `dashboard/queue-partner-overlay.ts` |
| 11 | Home, Queue, Approvals, Run | `home-desktop-light.png`, `queue-desktop-light.png`, `approvals-desktop-light.png`, `run-99e34c4e-desktop-light.png` | Four different stat-card styles: KPI tiles with sparklines; plain label/value text crammed against the batch-limit inputs on Queue; oversized uppercase headings ("TOTAL", "INSPECTED") on the Approval Backlog Radar; bordered boxes in the run command center. | Use one shared metric-card component and one heading scale. On Queue, separate the summary from the worker-batch form. | M | Yes: `daemon.ts` |
| 12 | Run detail, Approvals, all pages | `run-a29c9b69-desktop-light.png`, `approvals-desktop-light.png` | Three "Optional note" inputs on each run page have only a placeholder, no label. Each approval row has two separate note inputs (one for Approve, one for Reject). There is no skip-to-content link; Tab goes through the whole navigation first. Focus outlines are visible, which is good. | Add `aria-label`s (or visible labels) and a single shared note per approval. Add a skip link to `main`. | S | Yes: `daemon.ts` |
| 13 | Providers, Model catalog, Evaluations, Server readiness, Settings, Discovery, Bundles | `providers-desktop-light.png`, `discovery-desktop-light.png`, `bundles-desktop-light.png` | Slow first visit with a blank screen: time to first byte was 1.6–3.0 s on these seven pages. Bundles stays at about 1.1 s even when warm. Other pages answer in 5–200 ms. | Render the page layout immediately and load the slow provider, bundle and readiness probes into placeholders, or serve a cached snapshot with an "as of" time and refresh it in the background. | M–L | Yes: `daemon.ts` handlers |
| 14 | Discovery, Model improvement, Activity, Agents | `discovery-desktop-light.png`, `model-improvement-desktop-light.png`, `activity-desktop-light.png` | Very long pages: Discovery is 26,300 px with 1,858 controls; Model improvement 13,000 px (29,600 px on phone); Activity 10,000 px; Agents 9,700 px. | Paginate or virtualize lists, collapse detail sections by default, and put a filter or search box at the top. | M | Yes: `daemon.ts` |
| 15 | Approvals, Queue | `approvals-desktop-light.png`, `queue-desktop-light.png` | Risky bulk actions sit in prominent positions. "Approve All Pending…" is a primary blue button inside the row of status filters. "Remove failed cards" is a large red button near the top of Queue. | Move bulk actions away from the filters, style them as secondary, and show what will be affected in the confirmation step. | S | Yes: `daemon.ts` |

## Speed

Time to first byte on the first (cold) desktop visit, from the dashboard:

- **Fast (under 200 ms):** Home 377 ms (first page loaded), Queue 109 ms, Runs 25 ms,
  Approvals 11 ms, Run detail 80–160 ms. Most other pages were under 100 ms.
- **Slow:**
  - Discovery 2,972 ms
  - Evaluations 2,046 ms
  - Model catalog 2,018 ms
  - Server readiness 1,709 ms
  - Providers 1,690 ms
  - Settings 1,566 ms
  - Bundles 1,161 ms
  - Unknown path 422 ms (it renders the full home page)

On repeat visits every page except Bundles came back in under 150 ms, so the
slow pages are cold probes that could be cached or deferred (fix 13).

## What works well

- One H1 per page and a `main` landmark on every page. Navigation has an
  `aria-label`, the theme toggle has `aria-pressed`, and focus outlines are visible.
- Approvals, Runs and Queue respond in well under 200 ms when warm.
- The blocked run page explains the blocker in plain language, including the
  command that fixes it.
- Phone layout collapses the sidebar into a Menu button, and the KPI grid reflows to
  two columns.

## Studio overlap

Most dashboard pages render from `apps/cli/src/commands/daemon.ts`, which is
also where Jason's Studio work is active. These fixes touch that file:

- 1, 2, 6, 7, 8, 9, 11, 12, 13, 14 and 15

Fix 3 also touches `dashboard/studio.ts`, which is the Studio surface itself.

These can be done without waiting for the Studio work:

- **5:** touches only `dashboard/styles.ts`
- **Most of 4:** the colour tokens in `dashboard/styles.ts`
- **Most of 10:** the layout rules in `dashboard/styles.ts`
