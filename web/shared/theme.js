// Colour themes, adapted from the code editor's built-in themes. The
// colours live in tokens.css; this list names them and gives the pickers
// their swatches (editor, sidebar, activity bar, status bar, border, text,
// accent). Loaded in <head> so the saved theme applies before first paint.
'use strict';
(() => {
  const LIST = [
    { id: "dark-modern", name: "Dark Modern", type: 'dark', base: true, sw: ['#1F1F1F', '#181818', '#181818', '#181818', '#2B2B2B', '#CCCCCC', '#0078D4'] },
    { id: "light-modern", name: "Light Modern", type: 'light', base: true, sw: ['#FFFFFF', '#F8F8F8', '#F8F8F8', '#F8F8F8', '#E5E5E5', '#3B3B3B', '#005FB8'] },
    { id: "dark-plus", name: "Dark+", type: 'dark', sw: ['#1E1E1E', '#252526', '#333333', '#007ACC', '#3C3C3C', '#CCCCCC', '#007ACC'] },
    { id: "light-plus", name: "Light+", type: 'light', sw: ['#FFFFFF', '#F3F3F3', '#2C2C2C', '#007ACC', '#E7E7E7', '#333333', '#007ACC'] },
    { id: "monokai", name: "Monokai", type: 'dark', sw: ['#272822', '#1E1F1C', '#272822', '#414339', '#414339', '#F8F8F2', '#66D9EF'] },
    { id: "solarized-dark", name: "Solarized Dark", type: 'dark', sw: ['#002B36', '#00212B', '#003847', '#00212B', '#0B4554', '#EEE8D5', '#2AA198'] },
    { id: "solarized-light", name: "Solarized Light", type: 'light', sw: ['#FDF6E3', '#EEE8D5', '#DDD6C1', '#EEE8D5', '#DDD6C1', '#073642', '#2AA198'] },
    { id: "quiet-light", name: "Quiet Light", type: 'light', sw: ['#F5F5F5', '#F2F2F2', '#EDEDF5', '#705697', '#E0E0E0', '#333333', '#705697'] },
    { id: "tomorrow-night-blue", name: "Tomorrow Night Blue", type: 'dark', sw: ['#002451', '#001C40', '#001733', '#001126', '#0D3466', '#FFFFFF', '#BBDAFF'] },
    { id: "kimbie-dark", name: "Kimbie Dark", type: 'dark', sw: ['#221A0F', '#362712', '#221A0F', '#423523', '#51412C', '#D3AF86', '#F79A32'] },
    { id: "abyss", name: "Abyss", type: 'dark', sw: ['#000C18', '#060621', '#051336', '#10192C', '#2B2B4A', '#CCCCCC', '#6688CC'] },
    { id: "red", name: "Red", type: 'dark', sw: ['#390000', '#330000', '#580000', '#700000', '#5E1010', '#F8F8F8', '#FF6666'] },
    { id: "hc-dark", name: "Dark High Contrast", type: 'dark', sw: ['#000000', '#000000', '#000000', '#000000', '#6FC3DF', '#FFFFFF', '#F38518'] },
    { id: "hc-light", name: "Light High Contrast", type: 'light', sw: ['#FFFFFF', '#FFFFFF', '#FFFFFF', '#FFFFFF', '#0F4A85', '#292929', '#0F4A85'] }
  ];
  const KEY = 'rd.theme';
  const DEFAULT = 'dark-modern';
  const root = document.documentElement;
  const valid = (id) => id === 'system' || LIST.some((t) => t.id === id);

  function saved() {
    try {
      const id = localStorage.getItem(KEY);
      return valid(id) ? id : DEFAULT;
    } catch {
      return DEFAULT;
    }
  }

  // resolve turns "system" into the theme it shows right now.
  function resolve(id) {
    if (id === 'system') id = matchMedia('(prefers-color-scheme: light)').matches ? 'light-modern' : DEFAULT;
    return LIST.find((t) => t.id === id) || LIST[0];
  }

  // apply shows a theme without saving it (live preview); set also saves it.
  function apply(id) {
    root.dataset.theme = valid(id) ? id : DEFAULT;
    syncMeta();
  }

  function set(id) {
    try { localStorage.setItem(KEY, id); } catch { /* private mode */ }
    apply(id);
  }

  // The browser and iOS status bar take their colour from theme-color.
  function syncMeta() {
    const m = document.querySelector('meta[name="theme-color"]');
    if (!m || !document.body) return;
    const c = getComputedStyle(root).getPropertyValue('--surface').trim();
    if (c) m.setAttribute('content', c);
  }

  apply(saved());
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', syncMeta);
  addEventListener('DOMContentLoaded', syncMeta);
  window.RD = Object.assign(window.RD || {}, { themes: { list: LIST, saved, resolve, apply, set } });
})();
