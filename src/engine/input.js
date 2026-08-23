// One-button input, unified across mouse / touch / keyboard.
export class Input {
  constructor(target = window) {
    this.held = false;
    this.pressedEdge = false;
    this.releasedEdge = false;
    this.pointerX = 0; this.pointerY = 0;
    this.keys = new Set();
    this.anyKeyEdge = false;
    this._holders = new Set();
    this.enabled = true;

    const down = (id) => {
      if (!this.enabled) return;
      const was = this._holders.size > 0;
      this._holders.add(id);
      if (!was) this.pressedEdge = true;
    };
    const up = (id) => {
      const was = this._holders.size > 0;
      this._holders.delete(id);
      if (was && this._holders.size === 0) this.releasedEdge = true;
    };

    target.addEventListener('mousedown', (e) => { if (e.button === 0) down('m'); }, { passive: true });
    target.addEventListener('mouseup', (e) => { if (e.button === 0) up('m'); }, { passive: true });
    target.addEventListener('mousemove', (e) => { this.pointerX = e.clientX; this.pointerY = e.clientY; }, { passive: true });
    target.addEventListener('blur', () => { this._holders.clear(); });

    target.addEventListener('touchstart', (e) => { e.preventDefault(); down('t'); }, { passive: false });
    target.addEventListener('touchend', (e) => { e.preventDefault(); up('t'); }, { passive: false });
    target.addEventListener('touchcancel', () => up('t'), { passive: true });

    target.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.anyKeyEdge = true;
      if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') { e.preventDefault(); down('k'); }
    });
    target.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') up('k');
    });
  }

  /** Call once per frame, after reading edges. */
  endFrame() {
    this.held = this._holders.size > 0;
    this.pressedEdge = false;
    this.releasedEdge = false;
    this.anyKeyEdge = false;
  }

  /** Drives input from script (headless capture / autopilot). */
  setSynthetic(held) {
    const was = this._holders.size > 0;
    if (held && !was) { this._holders.add('s'); this.pressedEdge = true; }
    else if (!held && was) { this._holders.clear(); this.releasedEdge = true; }
  }
}
