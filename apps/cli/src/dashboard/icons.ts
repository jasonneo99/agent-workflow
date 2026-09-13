export type DashboardIconName =
  | "activity"
  | "agent"
  | "archive"
  | "brain"
  | "check"
  | "chevrons"
  | "clipboard"
  | "database"
  | "download"
  | "file"
  | "gauge"
  | "git"
  | "grid"
  | "history"
  | "info"
  | "key"
  | "layers"
  | "list"
  | "maximize"
  | "message"
  | "package"
  | "pause"
  | "play"
  | "plus"
  | "refresh"
  | "rocket"
  | "route"
  | "search"
  | "server"
  | "settings"
  | "shield"
  | "sparkles"
  | "trash"
  | "users"
  | "warning"
  | "x";

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function dashboardIcon(name: DashboardIconName, label?: string): string {
  const paths: Record<DashboardIconName, string> = {
    activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    agent: '<path d="M12 8V4"/><rect x="5" y="8" width="14" height="10" rx="2"/><path d="M8 18v2"/><path d="M16 18v2"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/>',
    archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
    brain: '<path d="M9 4a3 3 0 0 0-3 3v1a4 4 0 0 0 0 8v1a3 3 0 0 0 5 2"/><path d="M15 4a3 3 0 0 1 3 3v1a4 4 0 0 1 0 8v1a3 3 0 0 1-5 2"/><path d="M12 5v14"/><path d="M8 9h2"/><path d="M14 9h2"/><path d="M8 15h2"/><path d="M14 15h2"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    chevrons: '<path d="m7 7 5 5-5 5"/><path d="m13 7 5 5-5 5"/>',
    clipboard: '<rect x="5" y="4" width="14" height="16" rx="2"/><path d="M9 4.5A2 2 0 0 1 11 3h2a2 2 0 0 1 2 1.5V6H9z"/><path d="M9 12h6"/><path d="M9 16h4"/>',
    database: '<ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5"/><path d="M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
    download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
    file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/>',
    gauge: '<path d="M4 14a8 8 0 1 1 16 0"/><path d="M12 14l4-4"/><path d="M7 14h.01"/><path d="M17 14h.01"/>',
    git: '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 6h8"/><path d="M8 7.5 16.5 16"/>',
    grid: '<rect x="4" y="4" width="6" height="6"/><rect x="14" y="4" width="6" height="6"/><rect x="4" y="14" width="6" height="6"/><rect x="14" y="14" width="6" height="6"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 7v5l3 2"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    key: '<circle cx="7.5" cy="14.5" r="3.5"/><path d="M10 12 21 1"/><path d="m16 6 2 2"/><path d="m14 8 2 2"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 16 9 5 9-5"/>',
    list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
    maximize: '<path d="M8 3H3v5"/><path d="m3 3 6 6"/><path d="M16 3h5v5"/><path d="m21 3-6 6"/><path d="M8 21H3v-5"/><path d="m3 21 6-6"/><path d="M16 21h5v-5"/><path d="m21 21-6-6"/>',
    message: '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/><path d="M8 9h8"/><path d="M8 13h5"/>',
    package: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12 4.5 7.7"/><path d="M12 12v9"/><path d="m12 12 7.5-4.3"/>',
    pause: '<path d="M8 5v14"/><path d="M16 5v14"/>',
    play: '<path d="M8 5v14l11-7z"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2"/><path d="M3 12A9 9 0 0 1 18.5 5.8"/><path d="M18.5 2.5v3.3h-3.3"/><path d="M5.5 21.5v-3.3h3.3"/>',
    rocket: '<path d="M5 15c-1.5 1-2 3-2 6 3 0 5-0.5 6-2"/><path d="M9 15 4 10l6-2 6-6c2 0 4 0 6 2 0 2 0 4-2 6l-6 6z"/><path d="M15 9h.01"/>',
    route: '<circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h3a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h7"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/>',
    server: '<rect x="4" y="4" width="16" height="6" rx="2"/><rect x="4" y="14" width="16" height="6" rx="2"/><path d="M8 7h.01"/><path d="M8 17h.01"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2 3.4-.2-.1a1.7 1.7 0 0 0-2 .3l-.4.2-3.6-2.1-.1-.5a1.7 1.7 0 0 0-1.6-1.2h-.4l-1.9-3.3.2-.4a1.7 1.7 0 0 0 0-2.1l-.2-.4 1.9-3.3h.4a1.7 1.7 0 0 0 1.6-1.2l.1-.5 3.6-2.1.4.2a1.7 1.7 0 0 0 2 .3l.2-.1 2 3.4-.1.1a1.7 1.7 0 0 0-.3 1.9l.2.4v4.2z"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-5"/>',
    sparkles: '<path d="M12 3 10 9l-6 2 6 2 2 6 2-6 6-2-6-2z"/><path d="M19 3v4"/><path d="M21 5h-4"/><path d="M5 17v3"/><path d="M6.5 18.5h-3"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 15h10l1-15"/><path d="M10 11v6"/><path d="M14 11v6"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
    warning: '<path d="m12 3 10 18H2z"/><path d="M12 9v5"/><path d="M12 17h.01"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'
  };
  const accessible = label ? ` role="img" aria-label="${escapeAttribute(label)}"` : ' aria-hidden="true"';
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${accessible}>${paths[name]}</svg>`;
}
