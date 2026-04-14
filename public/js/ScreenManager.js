/**
 * Manages which top-level screen is visible.
 * Screens: 'lobby' | 'game' | 'round-over'
 */
export class ScreenManager {
  constructor() {
    this._screens = {
      lobby:      document.getElementById('screen-lobby'),
      game:       document.getElementById('screen-game'),
      'round-over': document.getElementById('screen-round-over'),
    };
    this._current = 'lobby';
  }

  show(name) {
    for (const [key, el] of Object.entries(this._screens)) {
      el.classList.toggle('active', key === name);
    }
    this._current = name;
  }

  current() {
    return this._current;
  }
}
