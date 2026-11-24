/**
 * Inline SVG icons (24 × 24, stroked with the text colour). Decorative:
 * the button or link around each one carries the label.
 */

const PATHS = {
  logo: '<path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4"/>',
  library: '<path d="M4 4h4v16H4zM10 4h4v16h-4zM16 5l4 1-3 14-4-1z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  settings:
    '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  importFile:
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11v6M9 14l3 3 3-3"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>',
  device: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M2 20h20"/>',
  cloud: '<path d="M17.5 19a4.5 4.5 0 1 0-1.3-8.8A6 6 0 0 0 4.4 12.6 3.5 3.5 0 0 0 6.5 19z"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5M5 20h14"/>',
  volume: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
  play: '<path d="M7 4v16l13-8z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 4h4v16H7zM13 4h4v16h-4z" fill="currentColor" stroke="none"/>',
  prev: '<path d="M6 5v14"/><path d="M18 6 9 12l9 6z" fill="currentColor"/>',
  next: '<path d="M18 5v14"/><path d="M6 6l9 6-9 6z" fill="currentColor"/>',
  loop: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>',
  metronome: '<path d="M8 3h8l3 18H5z"/><path d="M12 15 17 6M8 15h8"/>',
  chords: '<path d="M3 5h18M3 12h18M3 19h18"/><path d="M8 5v14M16 5v14"/>',
  mixer: '<path d="M6 3v18M12 3v18M18 3v18"/><rect x="4" y="13" width="4" height="3" rx="1"/><rect x="10" y="6" width="4" height="3" rx="1"/><rect x="16" y="15" width="4" height="3" rx="1"/>',
  export: '<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName, size = 20): string {
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${
    PATHS[name]
  }</svg>`;
}
