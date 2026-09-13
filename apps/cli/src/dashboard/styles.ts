export function roadmapDashboardCss(): string {
  return `
    .roadmap-bug td:first-child { border-left: 4px solid #ef4444; }
    .roadmap-task td:first-child { border-left: 4px solid #2563eb; }
    .roadmap-gantt { display: grid; gap: 0.75rem; }
    .roadmap-gantt-head { display: grid; grid-template-columns: 220px repeat(4, 1fr); color: #53627a; font-size: 0.82rem; font-weight: 700; text-transform: uppercase; }
    .roadmap-gantt-row { display: grid; grid-template-columns: 220px 1fr; gap: 1rem; align-items: start; border-top: 1px solid #dbe3f0; padding-top: 0.85rem; }
    .roadmap-bars { display: grid; grid-template-columns: repeat(4, minmax(120px, 1fr)); gap: 0.45rem; min-height: 2.4rem; }
    .roadmap-bar { display: flex; align-items: center; min-height: 2.35rem; padding: 0.4rem 0.65rem; border: 1px solid #9db7ff; background: #eef4ff; color: #123ca4; text-decoration: none; box-shadow: 0 6px 18px rgba(37, 99, 235, 0.08); }
    .roadmap-bar { gap: 0.55rem; }
    .roadmap-bar small, .priority { display: inline-flex; width: fit-content; padding: 0.1rem 0.35rem; border: 1px solid currentColor; font-size: 0.72rem; font-weight: 800; text-transform: uppercase; }
    .priority-critical, .roadmap-bar.priority-critical { border-color: #dc2626; color: #991b1b; background: #fef2f2; }
    .priority-high, .roadmap-bar.priority-high { border-color: #f97316; color: #9a3412; background: #fff7ed; }
    .priority-medium, .roadmap-bar.priority-medium { border-color: #2563eb; color: #1e40af; background: #eff6ff; }
    .priority-low, .roadmap-bar.priority-low { border-color: #16a34a; color: #166534; background: #f0fdf4; }
    .roadmap-bar.done { opacity: 0.72; background: #edfdf5; border-color: #86efac; color: #166534; }
    .roadmap-bar.next { background: #fff7ed; border-color: #fdba74; color: #9a3412; }
    .roadmap-bar.bug { background: #fff1f2; border-color: #fda4af; color: #9f1239; }
    .roadmap-bar span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .roadmap-row-actions { display: grid; gap: 0.45rem; min-width: 220px; }
    .roadmap-row-actions .inline-form { justify-content: flex-start; }
    .roadmap-row-actions select { min-height: 34px; }
    @media (max-width: 900px) {
      .roadmap-gantt-head { display: none; }
      .roadmap-gantt-row { grid-template-columns: 1fr; }
      .roadmap-bars { grid-template-columns: 1fr; }
      .roadmap-bar { grid-column: 1 / -1 !important; }
    }
  `;
}

export function dashboardCss(): string {
  return `
    :root { color-scheme: light; --nav-width: 204px; --page-gutter: clamp(16px, 2vw, 32px); --radius: 10px; --surface: #fff; --border: #dfe3eb; --shadow: 0 1px 2px rgba(15, 23, 42, .05), 0 8px 24px rgba(15, 23, 42, .04); }
    *, *::before, *::after { box-sizing: border-box; }
    html { min-width: 320px; background: #f7f8fb; }
    main { width: calc(100% - var(--nav-width)); margin-left: var(--nav-width); padding: 32px var(--page-gutter) 48px; }
    body { margin: 0; min-width: 320px; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172033; background: #f7f8fb; }
    h1 { font-size: 28px; margin: 0 0 8px; }
    h2 { font-size: 16px; margin: 0 0 12px; }
    h3 { font-size: 14px; margin: 16px 0 8px; }
    p { line-height: 1.5; }
    ul { margin: 0; padding-left: 20px; }
    table { width: 100%; border-collapse: collapse; background: white; border: 1px solid #e2e7f0; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #e8edf5; font-size: 14px; vertical-align: top; }
    th { color: #4b5870; background: #f0f3f8; font-size: 12px; text-transform: uppercase; }
    a { color: #1d4ed8; text-decoration: none; }
    pre { overflow: auto; background: #101828; color: #eef4ff; padding: 14px; font-size: 13px; line-height: 1.45; }
    .markdown-view { white-space: pre-wrap; word-break: break-word; }
    .lifecycle-help { margin-top: 14px; border: 1px solid #e2e7f0; background: #f8fafc; padding: 12px; }
    .lifecycle-help summary { cursor: pointer; font-weight: 700; color: #172033; }
    .lifecycle-help pre { margin-bottom: 0; }
    .side-nav { position: fixed; inset: 0 auto 0 0; width: var(--nav-width); background: #111827; color: #dbe4f0; padding: 20px 14px; display: grid; align-content: start; gap: 12px; z-index: 10; overflow-y: auto; }
    .side-nav strong { color: white; font-size: 14px; margin: 0 0 2px; }
    .nav-section { display: grid; gap: 4px; }
    .nav-section span { color: #94a3b8; font-size: 10px; font-weight: 800; letter-spacing: 0; text-transform: uppercase; padding: 0 10px; }
    .nav-section.active-group { border-left: 2px solid #60a5fa; padding-left: 6px; margin-left: -8px; }
    .nav-section.active-group span { color: #bfdbfe; }
    .side-nav a { color: #cbd5e1; padding: 9px 10px; border: 1px solid transparent; display: flex; align-items: center; gap: 9px; min-height: 38px; }
    .side-nav a .icon { color: #94a3b8; }
    .side-nav a:hover, .side-nav a.active { color: white; background: #1f2937; border-color: #334155; }
    .side-nav a:hover .icon, .side-nav a.active .icon { color: #93c5fd; }
    .capture-page main { width: 100%; max-width: none; margin-left: 0; padding: 24px; }
    .capture-page .panel { break-inside: avoid; }
    .capture-page .capture-hide { display: none !important; }
    .topbar { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 18px; }
    .panel { min-width: 0; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: clamp(16px, 1.5vw, 24px); margin-bottom: 18px; }
    .subpanel { min-width: 0; border: 1px solid #dbe4f0; border-radius: 8px; background: #f8fafc; padding: 14px; margin: 12px 0; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .quick-actions { margin-top: 12px; }
    .row-tools { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .button, button { appearance: none; border: 1px solid #1d4ed8; border-radius: 6px; background: #1d4ed8; color: white; padding: 8px 11px; font-size: 14px; font-weight: 600; cursor: pointer; transition: background .15s ease, border-color .15s ease, box-shadow .15s ease, color .15s ease, transform .15s ease; display: inline-flex; align-items: center; justify-content: center; gap: 7px; line-height: 1.2; }
    .button:hover, button:hover { background: #1e40af; border-color: #1e40af; box-shadow: 0 1px 3px rgba(29, 78, 216, .22); }
    .icon { flex: 0 0 auto; width: 16px; height: 16px; color: currentColor; }
    h1 .icon, h2 .icon, h3 .icon { width: 18px; height: 18px; }
    .button:focus-visible, button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid #60a5fa; outline-offset: 2px; }
    .compact-button { padding: 5px 8px; min-height: 28px; font-size: 12px; }
    .flash-panel { display: flex; justify-content: space-between; align-items: center; gap: 14px; border-left: 4px solid #2563eb; }
    .flash-panel.success { border-left-color: #16a34a; background: #f0fdf4; }
    .flash-panel.error { border-left-color: #dc2626; background: #fef2f2; }
    .flash-panel div { display: grid; gap: 4px; }
    .flash-panel strong { color: #172033; display: inline-flex; align-items: center; gap: 7px; }
    .flash-panel span { color: #475569; line-height: 1.4; }
    .callout { border: 1px solid #bfdbfe; background: #eff6ff; padding: 12px; margin: 12px 0; display: grid; gap: 8px; }
    .callout strong { color: #172033; }
    .callout p { margin: 0; color: #475569; }
    .callout.completed { border-color: #bbf7d0; background: #f0fdf4; }
    .callout.queued { border-color: #fde68a; background: #fffbeb; }
    .callout.failed { border-color: #fecaca; background: #fef2f2; }
    .action-history { padding-top: 14px; padding-bottom: 14px; }
    .action-history ul { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; padding-left: 0; list-style: none; }
    .action-history li { border: 1px solid #e2e7f0; background: #f8fafc; padding: 10px; display: grid; gap: 4px; }
    .action-history li.success { border-color: #bbf7d0; background: #f0fdf4; }
    .action-history li.error { border-color: #fecaca; background: #fef2f2; }
    .action-history li strong { font-size: 13px; color: #172033; line-height: 1.3; display: inline-flex; align-items: center; gap: 7px; }
    .action-history li span { color: #64748b; font-size: 12px; line-height: 1.3; }
    .run-info-dialog { width: min(720px, calc(100vw - 32px)); border: 1px solid var(--border); border-radius: 8px; padding: 0; color: #172033; box-shadow: 0 24px 70px rgba(15, 23, 42, .28); }
    .run-info-dialog::backdrop { background: rgba(15, 23, 42, .42); }
    .run-info-dialog > div { padding: 20px; }
    .run-info-dialog p { margin: 0 0 12px; }
    .run-info-dialog ul { display: grid; gap: 6px; margin-bottom: 14px; }
    .dialog-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
	    input, select, textarea { border: 1px solid #cbd5e1; border-radius: 6px; padding: 9px 11px; font-size: 14px; min-width: 0; max-width: 100%; background: white; font: inherit; }
	    .feedback-form { display: flex; gap: 6px; flex-wrap: wrap; }
	    .feedback-row-actions { display: grid; gap: 8px; min-width: 210px; }
	    .compact-feedback-form { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; align-items: center; }
	    .compact-feedback-form input { min-width: 0; width: 100%; box-sizing: border-box; }
	    .compact-feedback-form button { white-space: nowrap; }
	    .recommended-feedback { display: grid; gap: 6px; padding: 8px; margin-bottom: 8px; border: 1px solid #bfdbfe; background: #eff6ff; }
	    .recommended-feedback strong { font-size: 12px; color: #1d4ed8; text-transform: uppercase; }
	    .worker-form { display: inline-flex; }
    .dismiss-form { display: inline-flex; gap: 6px; flex-wrap: wrap; }
    .dismiss-form input { min-width: 140px; max-width: 190px; }
    .approval-form { display: inline-flex; gap: 6px; flex-wrap: wrap; }
    .approval-form input { min-width: 120px; max-width: 180px; }
    .bulk-approval-form { display: grid; gap: 14px; }
    .bulk-approval-form label { display: grid; gap: 5px; color: #4b5870; font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .bulk-approval-form input { width: 100%; min-width: 0; box-sizing: border-box; color: #172033; font-weight: 400; text-transform: none; }
    .bulk-approval-form .checkbox-row { display: flex; gap: 8px; align-items: center; text-transform: none; font-size: 13px; color: #172033; }
    .bulk-approval-form .checkbox-row input { width: auto; min-width: 0; }
    .bulk-approval-list { display: grid; gap: 8px; }
    .bulk-approval-row { display: grid !important; grid-template-columns: 18px minmax(0, 1fr); gap: 10px; align-items: start; padding: 10px; border: 1px solid #e2e7f0; background: #f8fafc; color: #172033 !important; font-size: 13px !important; text-transform: none !important; }
    .bulk-approval-row input { width: auto; min-width: 0; margin-top: 2px; }
    .bulk-approval-row span { display: grid; gap: 3px; min-width: 0; }
    .bulk-approval-row strong { font-size: 13px; line-height: 1.35; }
    .bulk-approval-row small { color: #64748b; line-height: 1.35; overflow-wrap: anywhere; }
    .bulk-dismiss-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; align-items: end; }
    .bulk-dismiss-form label { display: grid; gap: 5px; color: #4b5870; font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .bulk-dismiss-form input { width: 100%; min-width: 0; box-sizing: border-box; color: #172033; font-weight: 400; text-transform: none; }
    .bulk-dismiss-form .check-row { display: flex; align-items: center; gap: 8px; min-height: 36px; text-transform: none; font-weight: 500; }
    .bulk-dismiss-form .check-row input { width: auto; }
    .inline-form { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
    .inline-action-form { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 10px 0 16px; padding: 10px; border: 1px solid #e2e7f0; background: #f8fafc; }
    .checkbox-label { display: inline-flex; align-items: center; gap: 8px; color: #172033; font-size: 13px; font-weight: 700; }
    .checkbox-label input { min-width: 0; width: auto; }
    .routing-form, .workflow-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(210px, 100%), 1fr)); gap: 12px; margin: 12px 0; align-items: end; }
    .routing-form label, .workflow-form label { display: grid; gap: 5px; color: #4b5870; font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .routing-form input, .routing-form select, .workflow-form input, .workflow-form select, .workflow-form textarea { width: 100%; min-width: 0; box-sizing: border-box; color: #172033; font-weight: 400; text-transform: none; }
    .workflow-form .check-row { display: flex; align-items: center; gap: 8px; min-height: 36px; }
    .workflow-form .check-row input { width: auto; min-width: 0; }
    .wide { grid-column: 1 / -1; }
    .form-actions { display: flex; align-items: end; }
    .secondary { background: white; color: #1d4ed8; }
    .secondary:hover { background: #eff6ff; border-color: #93c5fd; color: #1e40af; }
    .danger { border-color: #b91c1c; background: #b91c1c; color: white; }
    .warn-panel { border-color: #fcd34d; background: #fffbeb; }
    .section-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 12px; }
    .section-heading div { display: grid; gap: 4px; }
    .health-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(170px, 100%), 1fr)); gap: 10px; }
    .health-card { border: 1px solid #e2e7f0; padding: 12px; display: grid; gap: 5px; color: #172033; background: #fff; min-height: 104px; }
    .health-card strong { font-size: 12px; color: #4b5870; text-transform: uppercase; }
    .health-card span { font-size: 22px; font-weight: 700; }
    .health-card small { color: #64748b; line-height: 1.35; }
    .health-card.good { border-color: #bbf7d0; background: #f0fdf4; }
    .health-card.warn { border-color: #fde68a; background: #fffbeb; }
    .health-card.bad { border-color: #fecaca; background: #fef2f2; }
    .command-center { border-left: 4px solid #2563eb; }
    .command-center.good { border-left-color: #16a34a; }
    .command-center.warn { border-left-color: #d97706; }
    .command-center.bad { border-left-color: #dc2626; }
    .command-summary { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(260px, .9fr); gap: 14px; align-items: stretch; margin-bottom: 12px; }
    .command-summary > div:first-child { border: 1px solid #dbe4f0; background: #f8fafc; padding: 14px; display: grid; gap: 6px; align-content: center; }
    .command-summary strong { color: #172033; font-size: 20px; line-height: 1.2; }
    .command-summary span { color: #64748b; line-height: 1.4; }
    .command-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .command-facts a { border: 1px solid #e2e7f0; background: white; padding: 12px; display: grid; gap: 4px; color: #172033; }
    .command-facts a:hover { border-color: #93c5fd; background: #eff6ff; }
    .command-facts strong { font-size: 22px; }
    .command-facts span { font-size: 12px; color: #64748b; }
    .command-list { display: grid; gap: 8px; }
    .command-item { display: flex; justify-content: space-between; gap: 12px; align-items: center; border: 1px solid #e2e7f0; background: #fff; padding: 12px; }
    .command-item div { display: grid; gap: 4px; min-width: 0; }
    .command-item strong { color: #172033; line-height: 1.3; }
    .command-item span { color: #64748b; line-height: 1.35; }
    .command-item.good { border-color: #bbf7d0; background: #f0fdf4; }
    .command-item.warn { border-color: #fde68a; background: #fffbeb; }
    .command-item.bad { border-color: #fecaca; background: #fef2f2; }
    .operations-panel { border-color: #cbd5e1; }
    .ops-strip { display: grid; grid-template-columns: minmax(220px, 1.7fr) repeat(5, minmax(104px, 1fr)); gap: 10px; }
    .ops-strip > div, .ops-strip > a { border: 1px solid #e2e7f0; background: #f8fafc; padding: 12px; display: grid; gap: 5px; min-height: 72px; align-content: center; color: #172033; transition: background .15s ease, border-color .15s ease, box-shadow .15s ease, transform .15s ease; }
    .ops-strip > a:hover { border-color: #93c5fd; background: #eff6ff; box-shadow: 0 6px 18px rgba(37, 99, 235, .12); transform: translateY(-1px); }
    .ops-strip strong { color: #172033; font-size: 20px; line-height: 1.15; }
    .ops-strip span { color: #64748b; font-size: 12px; line-height: 1.35; }
    .ops-state.good { border-color: #86efac; background: #f0fdf4; }
    .ops-state.warn { border-color: #fde68a; background: #fffbeb; }
    .ops-state.bad { border-color: #fca5a5; background: #fef2f2; }
    .ops-state strong { font-size: 22px; }
    .ops-action { margin-top: 4px; }
    .ops-action .worker-form { display: flex; flex-wrap: wrap; gap: 6px; }
    .ops-action .worker-form input { min-width: 64px; max-width: 84px; padding: 7px 8px; }
    .ops-action .worker-form button { padding: 7px 9px; }
    .worker-summary { display: grid; grid-template-columns: minmax(260px, 1.6fr) repeat(3, minmax(120px, 1fr)); gap: 10px; }
    .worker-summary > div { border: 1px solid #e2e7f0; background: #f8fafc; padding: 12px; display: grid; gap: 5px; align-content: center; min-height: 72px; }
    .worker-summary strong { color: #172033; font-size: 18px; line-height: 1.2; }
    .worker-summary span { color: #64748b; font-size: 12px; line-height: 1.35; }
    .compact-details { margin-top: 12px; }
    .provider-hero { display: grid; grid-template-columns: minmax(240px, 1.15fr) minmax(0, 2fr); gap: 12px; align-items: stretch; }
    .provider-current { border: 1px solid #bfdbfe; background: #eff6ff; padding: 14px; display: grid; gap: 6px; align-content: center; }
    .provider-current strong { color: #1d4ed8; font-size: 28px; line-height: 1.1; }
    .provider-current span { color: #172033; font-weight: 700; }
    .provider-current small { color: #475569; line-height: 1.35; }
    .provider-readiness { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(140px, 100%), 1fr)); gap: 10px; }
    .provider-readiness div { border: 1px solid #e2e7f0; background: #f8fafc; padding: 12px; display: grid; gap: 5px; align-content: center; }
    .provider-readiness strong { color: #172033; font-size: 20px; line-height: 1.15; }
    .provider-readiness span { color: #64748b; font-size: 12px; line-height: 1.3; }
    .provider-setup-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; }
    .provider-setup-card { border: 1px solid #dbe4f0; background: #f8fafc; padding: 12px; display: grid; gap: 7px; }
    .provider-setup-card strong { color: #172033; font-size: 14px; }
    .provider-setup-card span { color: #64748b; line-height: 1.35; font-size: 13px; }
    .provider-setup-card code { white-space: normal; word-break: break-word; background: #eef2ff; color: #3730a3; padding: 5px 6px; }
    .stage-delta { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin: 12px 0 16px; }
    .stage-delta-card { border: 1px solid #dbe4f0; background: #f8fafc; padding: 12px; display: grid; gap: 5px; }
    .stage-delta-card strong { color: #4b5870; font-size: 12px; text-transform: uppercase; }
    .stage-delta-card span { font-size: 22px; font-weight: 750; color: #172033; }
    .stage-delta-card small { color: #64748b; font-size: 12px; line-height: 1.35; }
    .stage-delta-card.good { border-color: #86efac; background: #f0fdf4; }
    .stage-delta-card.warn { border-color: #fde68a; background: #fffbeb; }
    .stage-delta-card.bad { border-color: #fca5a5; background: #fef2f2; }
    .decision-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(250px, 100%), 1fr)); gap: 12px; }
    .decision-card { border: 1px solid #dbe4f0; background: #f8fafc; padding: 14px; display: grid; gap: 8px; align-content: start; min-height: 160px; }
    .decision-card.good { border-color: #bbf7d0; background: #f0fdf4; }
    .decision-card.warn { border-color: #fde68a; background: #fffbeb; }
    .decision-card.bad { border-color: #fecaca; background: #fef2f2; }
    .decision-card strong { color: #172033; font-size: 14px; }
    .decision-card p { margin: 0; color: #475569; font-size: 13px; line-height: 1.4; }
    .decision-card ul { display: grid; gap: 5px; color: #334155; font-size: 12px; line-height: 1.35; }
    .attention-list { display: grid; gap: 8px; }
    .attention-item { border: 1px solid #e2e7f0; padding: 12px; display: flex; justify-content: space-between; gap: 12px; align-items: center; background: #fff; }
    .attention-item div { display: grid; gap: 4px; }
    .attention-item span { color: #64748b; font-size: 14px; line-height: 1.4; }
    .metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 12px; }
    .metric { border: 1px solid #e2e7f0; padding: 12px; display: grid; gap: 4px; }
    .metric strong { display: inline-flex; align-items: center; gap: 7px; color: #4b5870; font-size: 12px; text-transform: uppercase; }
    .metric strong .icon { width: 15px; height: 15px; color: #2563eb; }
    .metric span { font-size: 22px; font-weight: 700; }
    .metric small, .muted { color: #64748b; }
    .approval-triage-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; margin: 0 0 12px; }
    .approval-triage-grid div { border: 1px solid #dbe4f0; background: #f8fafc; padding: 12px; display: grid; gap: 4px; }
    .approval-triage-grid strong { color: #172033; font-size: 13px; }
    .approval-triage-grid span { color: #172033; font-size: 22px; font-weight: 750; line-height: 1.1; }
    .approval-triage-grid small { color: #64748b; line-height: 1.35; }
    .approval-triage-actions { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; margin: 0 0 12px; }
    .approval-triage-actions form { border: 1px solid #dbe4f0; background: #fff; padding: 12px; display: grid; grid-template-columns: minmax(0, 1fr) max-content; gap: 10px; align-items: center; }
    .approval-triage-actions .check-row { display: flex; align-items: center; gap: 8px; color: #4b5870; font-size: 13px; font-weight: 700; }
    .approval-triage-actions .check-row input { width: auto; }
    .approval-context-panel { border-left: 4px solid #2563eb; }
    .status-context-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
    .status-context-grid div { border: 1px solid #dbe4f0; background: #f8fafc; padding: 12px; display: grid; gap: 5px; }
    .status-context-grid strong { font-size: 24px; line-height: 1.1; color: #172033; }
    .status-context-grid span { color: #64748b; line-height: 1.35; }
    .status-context-grid .good { border-color: #bbf7d0; background: #f0fdf4; }
    .status-context-grid .warn { border-color: #fde68a; background: #fffbeb; }
    .status-context-grid .bad { border-color: #fecaca; background: #fef2f2; }
    .approval-row-history { background: #fbfdff; }
    .approval-row-history td { color: #475569; }
    .approval-row-failed { background: #fffaf5; }
    .split-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
    .split-grid > div { border: 1px solid #e2e7f0; background: #f8fafc; padding: 12px; }
    .split-grid h3 { margin-top: 0; }
    .meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
    .meta-grid div { display: grid; gap: 5px; font-size: 14px; }
    .graph-flow { display: grid; gap: 12px; }
    .graph-stage { position: relative; display: grid; grid-template-columns: 42px minmax(0, 1fr); gap: 12px; border: 1px solid #e2e7f0; padding: 14px; background: #fff; }
    .graph-stage + .graph-stage::before { content: ""; position: absolute; left: 34px; top: -13px; width: 2px; height: 12px; background: #94a3b8; }
    .graph-stage h3 { margin: 0 0 6px; }
    .graph-stage p { margin: 0 0 10px; }
    .graph-stage.good { border-color: #bbf7d0; background: #f0fdf4; }
    .graph-stage.warn { border-color: #fde68a; background: #fffbeb; }
    .graph-stage.bad { border-color: #fecaca; background: #fef2f2; }
    .graph-step { width: 32px; height: 32px; display: grid; place-items: center; background: #111827; color: white; font-weight: 700; }
    .chip-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .chip { display: inline-flex; align-items: center; border: 1px solid #cbd5e1; background: white; color: #334155; padding: 4px 7px; font-size: 12px; }
    .mind-map { display: grid; grid-template-columns: minmax(180px, 240px) minmax(0, 1fr); gap: 18px; align-items: center; }
    .mind-center { display: grid; gap: 6px; border: 2px solid #111827; background: #fff; padding: 18px; min-height: 120px; align-content: center; }
    .mind-center strong { font-size: 18px; line-height: 1.25; }
    .mind-center span, .mind-center small { color: #64748b; line-height: 1.35; }
    .mind-branches { position: relative; display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 12px; }
    .mind-branches::before { content: ""; position: absolute; left: -18px; top: 50%; width: 18px; height: 2px; background: #94a3b8; }
    .mind-node { position: relative; display: grid; gap: 6px; border: 1px solid #e2e7f0; background: #fff; padding: 12px; min-height: 148px; }
    .mind-node::before { content: ""; position: absolute; left: -13px; top: 50%; width: 12px; height: 2px; background: #cbd5e1; }
    .mind-node strong { font-size: 14px; line-height: 1.25; }
    .mind-node span, .mind-node small { line-height: 1.35; }
    .mind-node small { color: #64748b; }
    .mind-node.good { border-color: #bbf7d0; background: #f0fdf4; }
    .mind-node.warn { border-color: #fde68a; background: #fffbeb; }
    .mind-node.bad { border-color: #fecaca; background: #fef2f2; }
    .mind-node-meta { display: flex; flex-wrap: wrap; gap: 6px; }
    .mind-node-meta span { border: 1px solid #cbd5e1; background: rgba(255,255,255,0.72); padding: 3px 6px; font-size: 12px; color: #334155; }
    .segmented-actions { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
    .segment { border: 1px solid #cbd5e1; background: #fff; color: #172033; padding: 10px 12px; display: grid; gap: 4px; min-height: 56px; align-content: center; }
    .segment strong { font-size: 14px; line-height: 1.2; }
    .segment span { color: #64748b; font-size: 12px; line-height: 1.25; }
    .segment.active { border-color: #1d4ed8; background: #eff6ff; box-shadow: inset 0 0 0 1px #1d4ed8; }
    .segment.active strong { color: #1d4ed8; }
    .network-shell { display: grid; gap: 12px; }
    .network-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 12px; padding: 10px; border: 1px solid #dbe4f0; background: #f8fafc; }
    .network-toolbar > div:first-child { display: grid; gap: 3px; }
    .network-toolbar strong { color: #172033; font-size: 13px; }
    .network-toolbar span { color: #64748b; font-size: 12px; line-height: 1.3; }
    .network-toolbar-actions { display: flex; align-items: stretch; gap: 8px; }
    .network-fullscreen-toggle { min-width: 124px; white-space: nowrap; }
    body.network-fullscreen-open { overflow: hidden; }
    .network-panel.is-fullscreen { position: fixed; inset: 0; z-index: 100; margin: 0; padding: 16px; border: 0; border-radius: 0; overflow: hidden; background: #f7f8fb; box-shadow: none; }
    .network-panel.is-fullscreen > h2 { margin-bottom: 10px; }
    .network-panel.is-fullscreen .network-toolbar { margin-bottom: 8px; }
    .network-panel.is-fullscreen .network-shell { height: calc(100vh - 112px); grid-template-rows: minmax(0, 1fr) auto; }
    .network-panel.is-fullscreen .network-canvas-scroll { min-height: 0; overflow: auto; }
    .network-panel.is-fullscreen .network-map { width: 100%; height: 100%; min-height: 0; }
    .network-panel.is-fullscreen .network-legend, .network-panel.is-fullscreen .network-health-summary, .network-panel.is-fullscreen .network-explainer { display: none; }
    .compact-segments { grid-template-columns: repeat(2, minmax(112px, 1fr)); min-width: 250px; }
    .compact-segments .segment { min-height: 44px; padding: 8px 10px; }
    .network-canvas-scroll { max-width: 100%; overflow-x: auto; overscroll-behavior-inline: contain; background: #020617; }
    .network-canvas-scroll:focus-visible { outline: 2px solid #60a5fa; outline-offset: 2px; }
    .network-map { display: block; width: 100%; min-height: 430px; border: 1px solid #1e3a5f; background: #020617; box-shadow: inset 0 0 0 1px rgba(56,189,248,0.14), 0 22px 44px rgba(15,23,42,0.16); }
    .network-map .network-backdrop { fill: url(#neuralCoreGlow); }
    .network-map .network-grid { fill: url(#neuralGrid); }
    .network-rings circle { fill: none; stroke: #38bdf8; stroke-opacity: 0.11; stroke-width: 1.2; }
    .network-links path { fill: none; stroke: url(#neuralSignal); stroke-linecap: round; stroke-opacity: 0.26; }
    .network-links .signal { stroke: url(#neuralSignal); stroke-opacity: 0.48; }
    .network-links .support { stroke: #22d3ee; stroke-opacity: 0.36; }
    .network-links .sequence { stroke: #f59e0b; stroke-opacity: 0.34; }
    .network-links .outcome { stroke: #94a3b8; stroke-opacity: 0.24; }
    .network-links .dashed { stroke-opacity: 0.42; }
    .network-links .support.dashed { stroke: #38bdf8; stroke-opacity: 0.50; }
    .network-links .sequence.dashed { stroke: #fbbf24; stroke-opacity: 0.48; }
    .network-links .outcome.dashed { stroke: #bfdbfe; stroke-opacity: 0.34; }
    .network-signal-trail { fill: none; stroke: #e0f2fe; stroke-width: 2.4; stroke-linecap: round; stroke-dasharray: .05 .95; stroke-dashoffset: 1; opacity: .74; filter: url(#neuralGlow); animation: network-signal-run 3.2s linear infinite; animation-delay: var(--signal-delay); }
    .network-packet { fill: #f8fafc; stroke: #38bdf8; stroke-width: 1.5; filter: url(#neuralGlow); }
    .network-node circle { transform-box: fill-box; transform-origin: center; animation: network-node-breathe 3.6s ease-in-out infinite; }
    .network-stage:nth-child(3n + 1) circle, .network-primary-agent:nth-child(3n + 1) circle { animation-delay: .7s; }
    .network-stage:nth-child(3n + 2) circle, .network-primary-agent:nth-child(3n + 2) circle { animation-delay: 1.4s; }
    .network-shell.live-connected .network-signal-trail, .network-shell.live-connected .network-packet { opacity: .04; }
    .network-shell.live-connected .network-synapse.live-active .network-signal-trail, .network-shell.live-connected .network-synapse.live-active .network-packet { opacity: 1; }
    .network-shell.live-connected .network-synapse.live-active > path:first-child { stroke: #38bdf8; stroke-opacity: .92; filter: url(#neuralGlow); }
    .network-shell.live-connected .network-synapse.live-complete > path:first-child { stroke: #22c55e; stroke-opacity: .5; }
    .network-shell.live-connected .network-node circle { animation: none; }
    .network-shell.live-connected .network-node.live-firing { color: #38bdf8 !important; }
    .network-shell.live-connected .network-node.live-firing circle { fill: rgba(14,165,233,.2); stroke-width: 6; animation: network-live-node .92s ease-in-out infinite; }
    .network-shell.live-connected .network-node.live-complete { color: #22c55e !important; }
    .network-shell.live-connected .network-node.live-failed { color: #ef4444 !important; }
    .network-shell.live-connected .network-node.live-queued { color: #f59e0b !important; }
    .network-health-ring { transform: rotate(-90deg); transform-origin: center; stroke-width: 4; stroke-linecap: round; filter: url(#neuralGlow); }
    .network-health-ring.completed { stroke: #22c55e; }
    .network-health-ring.failed { stroke: #ef4444; }
    .network-health-ring.active { stroke: #f59e0b; }
    .network-health-ring.cancelled { stroke: #94a3b8; }
    .network-node circle { fill: rgba(2,6,23,0.32); stroke: currentColor; stroke-width: 4; filter: url(#neuralGlow); }
    .network-node text { fill: white; font-size: 11px; font-weight: 800; pointer-events: none; }
    .network-stage text { font-size: 9px; }
    .network-node { cursor: default; }
    .network-map a .network-node { cursor: pointer; }
    .network-node:hover circle, a:focus .network-node circle { fill: rgba(15,23,42,0.46); stroke-width: 5; }
    .network-focused circle { stroke-width: 6; }
    .network-map a { outline: none; }
    .network-workflow circle { stroke-width: 5; }
    .network-label { fill: #e2e8f0; font-size: 12px; font-weight: 700; }
    .network-layer-label { fill: #93c5fd; font-size: 11px; font-weight: 800; letter-spacing: 0; text-transform: uppercase; }
    .network-playback { display: grid; grid-template-columns: auto minmax(230px, 1fr) minmax(360px, auto); align-items: center; gap: 14px; border: 1px solid #dbe4f0; border-top: 0; background: #f8fafc; padding: 11px 12px; }
    .network-playback-actions { display: flex; gap: 7px; }
    .network-playback .network-replay, .network-playback .network-pause { min-height: 34px; white-space: nowrap; }
    .network-timeline { display: grid; grid-template-columns: auto max-content minmax(0, 1fr); align-items: center; gap: 8px; min-width: 0; font-size: 12px; }
    .network-live-dot { width: 8px; height: 8px; border-radius: 50%; background: #0ea5e9; box-shadow: 0 0 0 5px rgba(14,165,233,.12); animation: network-live-pulse 1.4s ease-in-out infinite; }
    .network-event-title { color: #172033; }
    .network-event-detail { min-width: 0; overflow: hidden; color: #64748b; text-overflow: ellipsis; white-space: nowrap; }
    .network-phases { display: flex; align-items: center; justify-content: flex-end; gap: 0; }
    .network-phases span { display: inline-flex; align-items: center; color: #94a3b8; font-size: 11px; font-weight: 700; white-space: nowrap; }
    .network-phases span::before { content: ""; width: 7px; height: 7px; margin-right: 5px; border: 1.5px solid currentColor; border-radius: 50%; background: #f8fafc; }
    .network-phases span:not(:last-child)::after { content: ""; width: clamp(8px, 1.5vw, 24px); height: 1px; margin: 0 7px; background: #cbd5e1; }
    .network-phases span.active { color: #2563eb; }
    .network-phases span.active::before { border-color: #2563eb; background: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,.12); }
    .network-shell[data-phase="1"] .network-live-dot { background: #f59e0b; box-shadow: 0 0 0 5px rgba(245,158,11,.14); }
    .network-shell[data-phase="4"] .network-live-dot { background: #22c55e; box-shadow: 0 0 0 5px rgba(34,197,94,.14); }
    @keyframes network-signal-run { to { stroke-dashoffset: 0; } }
    @keyframes network-node-breathe { 0%, 74%, 100% { transform: scale(1); } 82% { transform: scale(1.12); } }
    @keyframes network-live-node { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.16); } }
    @keyframes network-live-pulse { 50% { transform: scale(.72); opacity: .72; } }
    .network-legend { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; color: #dbeafe; background: #0f172a; border: 1px solid #1e3a5f; padding: 8px 10px; font-size: 12px; }
    .network-legend span { display: inline-flex; align-items: center; gap: 6px; }
    .network-legend i { display: inline-block; width: 10px; height: 10px; border-radius: 999px; border: 2px solid #020617; box-shadow: 0 0 0 1px rgba(147,197,253,0.6), 0 0 12px rgba(56,189,248,0.42); }
    .network-legend .legend-note { color: #93c5fd; }
    .network-legend .legend-stage { background: #2563eb; }
    .network-legend .legend-workflow { background: #0f172a; }
    .network-legend .legend-health-completed { background: #22c55e; }
    .network-legend .legend-health-failed { background: #ef4444; }
    .network-legend .legend-health-active { background: #f59e0b; }
    .network-health-summary { margin: 0; color: #58708f; font-size: 12px; }
    .network-explainer { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; background: #f8fafc; border: 1px solid #dbe4f0; padding: 10px; }
    .network-explainer div { display: grid; gap: 3px; }
    .network-explainer strong { color: #334155; font-size: 12px; text-transform: uppercase; }
    .network-explainer span { color: #64748b; font-size: 12px; line-height: 1.35; }
    .governance-details { margin-top: 8px; border: 1px solid #e2e7f0; background: #f8fafc; padding: 8px; }
    .governance-details summary { cursor: pointer; font-weight: 700; color: #334155; font-size: 12px; }
    .governance-details ul { display: grid; gap: 8px; margin-top: 8px; padding-left: 0; list-style: none; }
    .governance-details li { display: grid; gap: 4px; border-top: 1px solid #e2e7f0; padding-top: 8px; }
    .governance-details li:first-child { border-top: 0; padding-top: 0; }
    .governance-details span:not(.flag), .governance-details small { color: #64748b; line-height: 1.35; }
    .governance-details code { white-space: normal; word-break: break-word; background: #eef2ff; color: #3730a3; padding: 5px 6px; }
    .focused-stage-panel { border-color: #93c5fd; box-shadow: inset 3px 0 0 #2563eb; }
    .comparison-layout { display: grid; grid-template-columns: minmax(210px, 260px) minmax(0, 1fr); gap: 16px; align-items: start; }
    .suite-list { background: white; border: 1px solid #e2e7f0; padding: 14px; display: grid; gap: 8px; position: sticky; top: 20px; }
    .suite-link { display: grid; gap: 4px; padding: 10px; color: #172033; border: 1px solid #e2e7f0; }
    .suite-link:hover, .suite-link.active { border-color: #93c5fd; background: #eff6ff; }
    .suite-link span, .suite-link small { color: #64748b; }
    .leader-row { background: #f0fdf4; }
    .table-wrap { width: 100%; max-width: 100%; overflow-x: auto; overscroll-behavior-inline: contain; -webkit-overflow-scrolling: touch; }
    .mobile-approval-list { display: none; }
    .approval-filters { align-items: center; }
    .mobile-approval-card { border: 1px solid #dbe4f0; border-left: 4px solid #f59e0b; border-radius: 10px; background: #fff; padding: 16px; box-shadow: 0 1px 2px rgba(15, 23, 42, .05); }
    .mobile-approval-card.risk-low { border-left-color: #16a34a; }
    .mobile-approval-card.risk-high { border-left-color: #dc2626; }
    .mobile-approval-meta { display: grid; grid-template-columns: auto auto minmax(0, 1fr); align-items: center; gap: 8px; color: #64748b; font-size: 12px; }
    .approval-risk { color: #b45309; }
    .risk-low .approval-risk { color: #15803d; }
    .risk-high .approval-risk { color: #b91c1c; }
    .approval-kind { padding: 4px 7px; border-radius: 999px; background: #eef2f7; color: #475569; font-weight: 700; }
    .approval-age { justify-self: end; white-space: nowrap; }
    .mobile-approval-context { display: grid; gap: 3px; margin: 14px 0 10px; }
    .mobile-approval-context strong { font-size: 16px; }
    .mobile-approval-context span { color: #64748b; font-size: 13px; overflow-wrap: anywhere; }
    .mobile-approval-target { display: block; width: 100%; padding: 12px; border: 1px solid #dbe4f0; border-radius: 7px; background: #f8fafc; color: #172033; font-size: 13px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
    .mobile-approval-details { margin-top: 12px; border-top: 1px solid #e2e7f0; border-bottom: 1px solid #e2e7f0; }
    .mobile-approval-details summary { min-height: 44px; display: flex; align-items: center; color: #1d4ed8; font-weight: 700; cursor: pointer; }
    .mobile-approval-details dl { display: grid; gap: 10px; margin: 0 0 14px; }
    .mobile-approval-details dl div { display: grid; gap: 3px; min-width: 0; }
    .mobile-approval-details dt { color: #64748b; font-size: 11px; font-weight: 800; text-transform: uppercase; }
    .mobile-approval-details dd { margin: 0; font-size: 13px; line-height: 1.4; overflow-wrap: anywhere; }
    .mobile-approval-actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 14px; }
    .mobile-approval-actions.two-up { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .mobile-approval-actions form, .mobile-approval-actions button { width: 100%; min-width: 0; }
    .mobile-approval-actions button { min-height: 46px; line-height: 1.2; }
    .mobile-approval-actions .approval-form input { display: none; }
    .approval-empty { display: grid; place-items: center; gap: 6px; min-height: 180px; border: 1px dashed #cbd5e1; border-radius: 10px; color: #64748b; text-align: center; }
    .approval-empty strong { color: #334155; font-size: 16px; }
    .compact { margin-bottom: 12px; }
    .artifact { border: 1px solid #e2e7f0; margin-bottom: 8px; padding: 10px; }
    .artifact summary { cursor: pointer; }
    .flag { display: inline-block; margin-left: 6px; padding: 2px 5px; font-size: 11px; }
    .good { background: #dcfce7; color: #166534; }
    .warn { background: #fef3c7; color: #92400e; }
    .bad { background: #fee2e2; color: #991b1b; }
    .warn-box { background: #fffbeb; border: 1px solid #fcd34d; color: #92400e; padding: 10px 12px; }
    .status { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-width: 78px; padding: 3px 8px; border-radius: 999px; font-size: 12px; text-align: center; background: #eef2ff; color: #3730a3; }
    .status::before { content: ""; width: 6px; height: 6px; border-radius: 999px; background: currentColor; opacity: .72; }
    .completed { background: #dcfce7; color: #166534; }
    .failed { background: #fee2e2; color: #991b1b; }
    .cancelled { background: #e5e7eb; color: #374151; }
    .running, .queued { background: #fef3c7; color: #92400e; }
    @media print {
      body { background: white; }
      main, .capture-page main { max-width: none; padding: 0; }
      .side-nav, .capture-hide, .print-hide { display: none !important; }
      .panel { border-color: #d0d7e2; box-shadow: none; }
      a { color: inherit; }
    }
    @media (max-width: 1180px) {
      .ops-strip { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .ops-state { grid-column: span 2; }
      .provider-hero { grid-template-columns: 1fr; }
    }
    @media (max-width: 820px) {
      :root { --nav-width: 0px; }
      main { width: 100%; margin-left: 0; padding: 94px 12px 24px; }
      .side-nav { right: 0; bottom: auto; width: auto; grid-auto-flow: column; grid-auto-columns: max-content; overflow-x: auto; overflow-y: hidden; padding: 10px 12px; gap: 8px; }
      .side-nav strong { display: none; }
      .nav-section { grid-auto-flow: column; grid-auto-columns: max-content; align-items: center; }
      .nav-section span { display: none; }
      .nav-section.active-group { border-left: 0; padding-left: 0; margin-left: 0; }
      .topbar, .section-heading { display: grid; }
      .attention-item { display: grid; }
      .ops-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .ops-state { grid-column: 1 / -1; }
      .provider-hero { grid-template-columns: 1fr; }
      .provider-readiness { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .comparison-layout { grid-template-columns: 1fr; }
      .suite-list { position: static; }
      .mind-map { grid-template-columns: 1fr; }
      .mind-branches::before, .mind-node::before { display: none; }
      .network-toolbar { display: grid; }
      .network-toolbar-actions { display: grid; grid-template-columns: minmax(0, 1fr) auto; }
      .compact-segments { min-width: 0; }
      .network-map { min-height: 360px; }
      .network-canvas-scroll .network-map { width: 760px; max-width: none; min-height: 462px; }
      .network-playback { grid-template-columns: 1fr; }
      .network-phases { justify-content: flex-start; overflow-x: auto; padding-bottom: 3px; }
      table { display: block; overflow-x: auto; }
      .approval-inbox-panel { padding: 14px; }
      .mobile-approval-list { display: grid; gap: 12px; }
      .desktop-approval-table { display: none; }
      .approval-filters { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .approval-filters .button { width: 100%; justify-content: center; text-align: center; }
      .approval-filters > :not(.filter-open):not(.filter-pending):not(.filter-approved) { display: none; }
      .approval-intro { max-width: 32rem; }
    }
    @media (max-width: 560px) {
      h1 { font-size: 24px; }
      .topbar > .button { display: none; }
      .panel { padding: 14px; border-radius: 8px; }
      .health-grid, .metric-grid, .meta-grid, .split-grid, .provider-setup-grid, .stage-delta, .segmented-actions, .command-summary, .command-facts, .worker-summary { grid-template-columns: 1fr; }
      .command-item { align-items: stretch; flex-direction: column; }
      .actions, .inline-form, .dismiss-form, .approval-form { display: grid; grid-template-columns: 1fr; }
      .actions > *, .inline-form > *, .dismiss-form > *, .approval-form > * { width: 100%; max-width: none; }
      .button, button { display: inline-flex; justify-content: center; align-items: center; min-height: 38px; }
      .ops-strip { grid-template-columns: 1fr; }
      .ops-state { grid-column: auto; }
      .provider-readiness { grid-template-columns: 1fr; }
      .compact-feedback-form { grid-template-columns: 1fr; }
      .actions.approval-filters { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .approval-filters .button { padding-inline: 6px; }
      .mobile-approval-actions { grid-template-columns: 1fr; }
      .mobile-approval-actions.two-up { grid-template-columns: 1fr 1fr; }
      .mobile-approval-meta { grid-template-columns: auto minmax(0, 1fr); }
      .approval-age { grid-column: 2; grid-row: 1; }
      .approval-kind { grid-column: 1 / -1; justify-self: start; }
      th, td { padding: 9px 10px; }
      .network-playback-actions { display: grid; grid-template-columns: 1fr 1fr; }
      .network-toolbar-actions { grid-template-columns: 1fr; }
      .network-fullscreen-toggle { width: 100%; }
      .network-timeline { grid-template-columns: auto 1fr; }
      .network-event-detail { grid-column: 2; white-space: normal; }
    }
    @media (prefers-reduced-motion: reduce) {
      .network-signal-trail, .network-node circle, .network-live-dot { animation: none; }
      .network-packet { display: none; }
    }
  `;
}
