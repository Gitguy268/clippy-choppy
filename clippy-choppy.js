/* ClippyChoppy — Win98-choppy Clippy for the web.
 *
 * Sprite data: pithings/clippy agent data (Microsoft Office assistant assets
 * extracted with Double Agent), vendored locally + CDN fallback:
 *  - local:  ./assets/clippy/map.png + ./assets/clippy/agent.json (+ sounds.json)
 *  - CDN:    https://cdn.jsdelivr.net/npm/clippyjs/dist/agents/clippy/
 * Legacy reference: https://github.com/clippyjs/clippy.js
 *
 * CHOPPY RULES (Win98 feel — follow strictly):
 *  1. No CSS transitions on Clippy nodes (`transition: none` everywhere).
 *  2. Frame stepping only: setTimeout at 8-12fps + `steps(1, end)` in CSS.
 *  3. `image-rendering: pixelated` on sprite. Integer scale only (1-4).
 *  4. moveTo = 5 discrete teleport jumps + 80ms freeze. Never a slide.
 *  5. blinkLoop = 2 frames, shut ~120ms, every 3-6s. No fade.
 *  6. Balloon toggles instantly via display none/block. No opacity fade.
 */

const LOCAL_MAP = "./assets/clippy/map.png";
const LOCAL_AGENT = "./assets/clippy/agent.json";
const LOCAL_SOUNDS = "./assets/clippy/sounds.json";
const CDN_BASE = "https://cdn.jsdelivr.net/npm/clippyjs/dist/agents/clippy";
const CDN_AGENT_MJS = `${CDN_BASE}/agent.mjs`;
const CDN_MAP_MJS = `${CDN_BASE}/map.mjs`;
const CDN_SOUNDS_MJS = `${CDN_BASE}/sounds-mp3.mjs`;

// Agent data ships no Blink anim, so the blink loop snaps through these two
// IdleEyeBrowRaise cells (eyes narrowed) then snaps back to the rest cell.
const BLINK_CELLS = [[1116, 186], [1240, 186]];
const REST_CELL = [0, 0];

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

export class ClippyChoppy {
  constructor(opts = {}) {
    this.opts = {
      mapUrl: opts.mapUrl || LOCAL_MAP,
      agentUrl: opts.agentUrl || LOCAL_AGENT,
      soundsUrl: opts.soundsUrl || LOCAL_SOUNDS,
      agentData: opts.agentData || null, // pass parsed agent.json to skip fetch
      fps: opts.fps ?? 10,
      scale: opts.scale ?? 1,
      startX: opts.startX ?? null,
      startY: opts.startY ?? 120,
      idle: opts.idle !== false,
      blink: opts.blink !== false,
    };
    this.fps = clampInt(this.opts.fps, 8, 12);
    this.scale = clampInt(this.opts.scale, 1, 4);

    this.data = null;      // parsed agent.json
    this.mapUrl = null;    // resolved sprite sheet URL
    this.sheetW = 0;
    this.sheetH = 0;
    this.sounds = {};      // id -> Audio element (lazy)

    this.el = null;        // root .clippy-choppy
    this.sprite = null;    // .clippy-sprite (background-position stepping)
    this.balloon = null;
    this.balloonText = null;

    this._queue = Promise.resolve();
    this._playing = false; // true while a queued anim task steps frames
    this._exiting = false; // set by exitAnimation() / play timeout
    this._stepTimer = 0;
    this._blinkTimer = 0;
    this._idleTimer = 0;
    this._balloonTimer = 0;
    this._hidden = false;
    this._dragging = false;
    this._disposed = false;
    this._x = 0;
    this._y = 0;
  }

  get frameMs() {
    return Math.round(1000 / this.fps);
  }

  /* ---------- load ---------- */

  async init() {
    await this.load();
    this._buildShell();
    this.show(true);
    this._startBlinkLoop();
    this._scheduleIdle();
    return this;
  }

  async load() {
    this.data = this.opts.agentData || (await this._loadAgent());
    this.mapUrl = await this._resolveMapUrl();
    await this._preloadMap();
    this._preloadSounds();
    return this;
  }

  async _loadAgent() {
    // Local agent.json first, CDN agent.mjs as backup.
    try {
      const r = await fetch(this.opts.agentUrl, { cache: "force-cache" });
      if (!r.ok) throw new Error(`agent fetch ${r.status}`);
      return await r.json();
    } catch (err) {
      const mod = await import(/* @vite-ignore */ CDN_AGENT_MJS);
      const data = mod.default || mod.agent_default;
      if (!data || !data.animations) throw err || new Error("agent CDN empty");
      return data;
    }
  }

  async _resolveMapUrl() {
    // A custom mapUrl (or data: URL) wins; else probe local file, else CDN.
    if (this.opts.mapUrl && this.opts.mapUrl !== LOCAL_MAP) return this.opts.mapUrl;
    try {
      const r = await fetch(LOCAL_MAP, { method: "HEAD", cache: "force-cache" });
      if (r.ok) return LOCAL_MAP;
    } catch { /* fall through to CDN */ }
    try {
      const mod = await import(/* @vite-ignore */ CDN_MAP_MJS);
      const url = mod.default || mod.map_default;
      if (typeof url === "string" && url.length > 0) return url;
    } catch { /* fall through */ }
    return LOCAL_MAP;
  }

  _preloadMap() {
    return new Promise((resolve) => {
      const img = new Image();
      img.decoding = "sync";
      img.onload = () => {
        this.sheetW = img.naturalWidth;
        this.sheetH = img.naturalHeight;
        resolve();
      };
      img.onerror = () => resolve(); // draw anyway; background just stays blank
      img.src = this.mapUrl;
    });
  }

  async _preloadSounds() {
    let table = null;
    try {
      const r = await fetch(this.opts.soundsUrl, { cache: "force-cache" });
      if (r.ok) table = await r.json();
    } catch { /* silent: no audio */ }
    if (!table) {
      try {
        const mod = await import(/* @vite-ignore */ CDN_SOUNDS_MJS);
        table = mod.default || mod.sounds_mp3_default || null;
      } catch { table = null; }
    }
    this._soundTable = table || {};
  }

  _playSound(id) {
    if (!id) return;
    try {
      let a = this.sounds[id];
      if (!a) {
        const uri = this._soundTable && this._soundTable[id];
        if (!uri) return;
        a = new Audio(uri);
        this.sounds[id] = a;
      }
      const p = a.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch { /* audio must never break the frame loop */ }
  }

  /* ---------- DOM shell ---------- */

  _buildShell() {
    const [fw, fh] = this.data.framesize;
    this.el = document.createElement("div");
    this.el.className = "clippy-choppy";
    this.el.style.transition = "none";
    const x = this.opts.startX ?? Math.max(12, window.innerWidth - fw * this.scale - 24);
    this._x = Math.round(x);
    this._y = Math.round(this.opts.startY);
    this.el.style.left = `${this._x}px`;
    this.el.style.top = `${this._y}px`;

    this.sprite = document.createElement("div");
    this.sprite.className = "clippy-sprite";
    this.sprite.style.transition = "none";
    this.sprite.style.width = `${fw * this.scale}px`;
    this.sprite.style.height = `${fh * this.scale}px`;
    this.sprite.style.backgroundImage = `url("${this.mapUrl}")`;
    if (this.sheetW > 0) {
      this.sprite.style.backgroundSize = `${this.sheetW * this.scale}px ${this.sheetH * this.scale}px`;
    }
    this.sprite.style.animationTimingFunction = "steps(1, end)";
    this.el.appendChild(this.sprite);
    document.body.appendChild(this.el);
    this._draw(REST_CELL[0], REST_CELL[1]);
    this._makeDraggable();

    this.balloon = document.createElement("div");
    this.balloon.className = "clippy-balloon";
    this.balloon.style.transition = "none";
    this.balloon.setAttribute("role", "status");
    this.balloonText = document.createElement("div");
    this.balloonText.className = "clippy-balloon-text";
    this.balloon.appendChild(this.balloonText);
    document.body.appendChild(this.balloon);
  }

  _draw(sx, sy) {
    if (!this.sprite) return;
    // Snap to whole pixels; scale stays integer so pixels stay crisp.
    this.sprite.style.backgroundPosition = `${-Math.round(sx * this.scale)}px ${-Math.round(sy * this.scale)}px`;
  }

  /* ---------- frame stepper ---------- */

  _nextFrameIndex(anim, idx, frame) {
    if (this._exiting && frame && frame.exitBranch !== undefined) return frame.exitBranch;
    if (frame && frame.branching && frame.branching.branches) {
      let rnd = Math.random() * 100;
      for (const b of frame.branching.branches) {
        if (rnd <= b.weight) return b.frameIndex;
        rnd -= b.weight;
      }
    }
    return idx + 1;
  }

  _playRaw(name, { timeout = 5000 } = {}) {
    const anim = this.data.animations[name];
    if (!anim) return Promise.resolve(false);
    this._playing = true;
    this._exiting = false;
    let killer = 0;
    if (timeout > 0) {
      killer = window.setTimeout(() => { this._exiting = true; }, timeout);
    }
    return new Promise((resolve) => {
      const frames = anim.frames;
      let idx = 0;
      const step = () => {
        if (this._disposed) { window.clearTimeout(killer); this._playing = false; resolve(false); return; }
        idx = Math.min(idx, frames.length - 1);
        const frame = frames[idx];
        if (frame.images && frame.images[0]) this._draw(frame.images[0][0], frame.images[0][1]);
        else if (this.sprite) this.sprite.style.display = "none";
        if (this.sprite && frame.images && frame.images[0]) this.sprite.style.display = "block";
        if (frame.sound) this._playSound(frame.sound);
        if (idx >= frames.length - 1) {
          window.clearTimeout(killer);
          this._playing = false;
          resolve(true);
          return;
        }
        const wait = Math.max(frame.duration || 100, this.frameMs);
        this._stepTimer = window.setTimeout(() => {
          idx = Math.min(this._nextFrameIndex(anim, idx, frame), frames.length - 1);
          step();
        }, wait);
      };
      step();
    });
  }

  _enqueue(fn) {
    this._queue = this._queue.then(() => {
      if (this._disposed) return false;
      return new Promise(fn);
    });
    // A queued user action cancels a pending idle nap.
    window.clearTimeout(this._idleTimer);
    this._queue.then(() => this._scheduleIdle());
    return this._queue;
  }

  exitAnimation() {
    this._exiting = true;
  }

  /* ---------- public API (mirrors pithings/clippy) ---------- */

  hasAnimation(name) {
    return !!(this.data && this.data.animations[name]);
  }

  animations() {
    return this.data ? Object.keys(this.data.animations) : [];
  }

  play(name, timeout = 5000) {
    if (!this.hasAnimation(name)) return Promise.resolve(false);
    return this._enqueue((resolve) => {
      this._playRaw(name, { timeout }).then((ok) => resolve(ok));
    });
  }

  animate() {
    const pool = this.animations().filter(
      (a) => !a.startsWith("Idle") && a !== "Show" && a !== "Hide"
    );
    if (pool.length === 0) return Promise.resolve(false);
    const pick = pool[Math.floor(Math.random() * pool.length)];
    return this.play(pick);
  }

  speak(text, { hold = false, tts = false } = {}) {
    return this._enqueue((resolve) => {
      // Instant show (display swap, never opacity).
      window.clearTimeout(this._balloonTimer);
      this.balloonText.textContent = "";
      this.balloon.classList.add("show");
      this._placeBalloon();
      // Choppy word-by-word reveal on a setTimeout chain.
      const words = String(text).split(/(\s+)/);
      let i = 0;
      const tick = () => {
        if (this._disposed) { resolve(true); return; }
        i += 1;
        this.balloonText.textContent = words.slice(0, i).join("");
        this._placeBalloon();
        if (i < words.length) {
          this._stepTimer = window.setTimeout(tick, this.frameMs);
        } else {
          if (tts && "speechSynthesis" in window) {
            try {
              speechSynthesis.cancel();
              speechSynthesis.speak(new SpeechSynthesisUtterance(String(text)));
            } catch { /* TTS is best-effort */ }
          }
          if (!hold) {
            this._balloonTimer = window.setTimeout(() => {
              this.balloon.classList.remove("show");
            }, 3000 + String(text).length * 40);
          }
          resolve(true);
        }
      };
      tick();
    });
  }

  closeBalloon() {
    window.clearTimeout(this._balloonTimer);
    if (this.balloon) this.balloon.classList.remove("show");
  }

  moveTo(x, y) {
    const STEPS = 5;
    const GAP = 140;   // ms between teleport jumps
    const FREEZE = 80; // end-freeze so the arrival reads as a snap
    return this._enqueue((resolve) => {
      const target = this._clamp(Math.round(x), Math.round(y));
      const sx = this._x;
      const sy = this._y;
      const hand = Math.abs(target.x - sx) >= Math.abs(target.y - sy)
        ? (target.x >= sx ? "GestureRight" : "GestureLeft")
        : (target.y >= sy ? "GestureDown" : "GestureUp");
      const hop = (named) => {
        let i = 0;
        const jump = () => {
          if (this._disposed) { resolve(false); return; }
          i += 1;
          const t = i / STEPS;
          this._x = Math.round(sx + (target.x - sx) * t);
          this._y = Math.round(sy + (target.y - sy) * t);
          this.el.style.transition = "none"; // enforce per jump
          this.el.style.left = `${this._x}px`;
          this.el.style.top = `${this._y}px`;
          this._placeBalloon();
          if (i < STEPS) this._stepTimer = window.setTimeout(jump, GAP);
          else this._stepTimer = window.setTimeout(() => resolve(true), FREEZE);
        };
        jump();
      };
      // Signal intent with a directional gesture when the agent ships one,
      // then snap across in 5 jumps. Pure teleport when it does not.
      if (this.hasAnimation(hand)) this._playRaw(hand, { timeout: 1500 }).then(hop);
      else hop();
    });
  }

  gestureAt(x, y) {
    const dx = x - (this._x + 62 * this.scale);
    const dy = y - (this._y + 46 * this.scale);
    const dir = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? "Right" : "Left") : (dy >= 0 ? "Down" : "Up");
    const g = `Gesture${dir}`;
    if (this.hasAnimation(g)) return this.play(g);
    const look = `Look${dir}`;
    if (this.hasAnimation(look)) return this.play(look);
    return this.animate();
  }

  show(fast = true) {
    this._hidden = false;
    if (!this.el) return Promise.resolve(true);
    if (fast || !this.hasAnimation("Show")) {
      this.el.style.display = "block";
      return Promise.resolve(true);
    }
    this.el.style.display = "block";
    return this._enqueue((resolve) => {
      this._playRaw("Show", { timeout: 2000 }).then((ok) => resolve(ok));
    });
  }

  hide(fast = true) {
    this._hidden = true;
    this.closeBalloon();
    window.clearTimeout(this._idleTimer);
    window.clearTimeout(this._blinkTimer);
    if (!this.el) return Promise.resolve(true);
    if (fast || !this.hasAnimation("Hide")) {
      this.el.style.display = "none";
      return Promise.resolve(true);
    }
    return this._enqueue((resolve) => {
      this._playRaw("Hide", { timeout: 2000 }).then((ok) => {
        this.el.style.display = "none";
        resolve(ok);
      });
    });
  }

  stopCurrent() {
    this.exitAnimation();
    this.closeBalloon();
  }

  stop() {
    this._queue = Promise.resolve();
    window.clearTimeout(this._stepTimer);
    this._playing = false;
    this._exiting = true;
    this.closeBalloon();
    this._scheduleIdle();
  }

  pause() {
    window.clearTimeout(this._stepTimer);
    window.clearTimeout(this._blinkTimer);
    window.clearTimeout(this._idleTimer);
  }

  resume() {
    if (this._disposed || this._hidden) return;
    this._startBlinkLoop();
    this._scheduleIdle();
  }

  setFPS(fps) {
    this.fps = clampInt(fps, 8, 12);
  }

  setScale(s) {
    this.scale = clampInt(s, 1, 4);
    if (!this.data || !this.sprite) return;
    const [fw, fh] = this.data.framesize;
    this.sprite.style.width = `${fw * this.scale}px`;
    this.sprite.style.height = `${fh * this.scale}px`;
    if (this.sheetW > 0) {
      this.sprite.style.backgroundSize = `${this.sheetW * this.scale}px ${this.sheetH * this.scale}px`;
    }
  }

  dispose() {
    this._disposed = true;
    window.clearTimeout(this._stepTimer);
    window.clearTimeout(this._blinkTimer);
    window.clearTimeout(this._idleTimer);
    window.clearTimeout(this._balloonTimer);
    try { speechSynthesis.cancel(); } catch { /* no TTS */ }
    this.el?.remove();
    this.balloon?.remove();
    this.el = null;
    this.sprite = null;
    this.balloon = null;
  }

  /* ---------- idle + blink loops ---------- */

  _scheduleIdle() {
    window.clearTimeout(this._idleTimer);
    if (this._disposed || this._hidden || !this.opts.idle) return;
    this._idleTimer = window.setTimeout(() => {
      if (this._disposed || this._hidden || this._playing || this._dragging) {
        this._scheduleIdle();
        return;
      }
      const idles = this.animations().filter((a) => a.startsWith("Idle"));
      if (idles.length === 0) { this._scheduleIdle(); return; }
      const pick = idles[Math.floor(Math.random() * idles.length)];
      // Idle anims run outside the user queue so speak/play never stall.
      this._playRaw(pick, { timeout: 8000 }).then(() => this._scheduleIdle());
    }, 4500 + Math.random() * 4500);
  }

  _startBlinkLoop() {
    window.clearTimeout(this._blinkTimer);
    if (this._disposed || !this.opts.blink) return;
    const tick = () => {
      if (this._disposed) return;
      // Only blink when idle: never stomp a queued/running anim or a drag.
      if (!this._hidden && !this._playing && !this._dragging && this.el) {
        this._draw(BLINK_CELLS[0][0], BLINK_CELLS[0][1]);
        this._stepTimer = window.setTimeout(() => {
          this._draw(BLINK_CELLS[1][0], BLINK_CELLS[1][1]);
          this._stepTimer = window.setTimeout(() => this._draw(REST_CELL[0], REST_CELL[1]), 60);
        }, 60);
      }
      this._blinkTimer = window.setTimeout(tick, 3000 + Math.random() * 3000);
    };
    this._blinkTimer = window.setTimeout(tick, 2500);
  }

  /* ---------- helpers ---------- */

  _clamp(x, y) {
    const [fw, fh] = this.data ? this.data.framesize : [124, 93];
    const w = fw * this.scale;
    const h = fh * this.scale;
    const m = 5;
    return {
      x: Math.max(m, Math.min(x, window.innerWidth - w - m)),
      y: Math.max(m, Math.min(y, window.innerHeight - h - m)),
    };
  }

  _placeBalloon() {
    if (!this.balloon || !this.el || !this.balloon.classList.contains("show")) return;
    const r = this.el.getBoundingClientRect();
    const bw = Math.min(240, window.innerWidth - 16);
    this.balloon.style.maxWidth = `${bw}px`;
    const bh = this.balloon.offsetHeight || 80;
    let left = Math.round(r.left + r.width / 2 - bw / 2);
    left = Math.max(8, Math.min(left, window.innerWidth - bw - 8));
    let top = Math.round(r.top - bh - 14);
    if (top < 8) top = Math.round(r.bottom + 14); // flip below when crowded
    this.balloon.style.left = `${left}px`;
    this.balloon.style.top = `${top}px`;
  }

  _makeDraggable() {
    let ox = 0;
    let oy = 0;
    this.el.addEventListener("pointerdown", (e) => {
      this._dragging = true;
      this.closeBalloon();
      const r = this.el.getBoundingClientRect();
      ox = e.clientX - r.left;
      oy = e.clientY - r.top;
      try { this.el.setPointerCapture(e.pointerId); } catch { /* older browser */ }
    });
    this.el.addEventListener("pointermove", (e) => {
      if (!this._dragging) return;
      const c = this._clamp(Math.round(e.clientX - ox), Math.round(e.clientY - oy));
      this._x = c.x;
      this._y = c.y;
      this.el.style.transition = "none";
      this.el.style.left = `${this._x}px`;
      this.el.style.top = `${this._y}px`;
    });
    const up = () => { this._dragging = false; };
    this.el.addEventListener("pointerup", up);
    this.el.addEventListener("pointercancel", up);
    this.el.addEventListener("dblclick", () => this.animate());
  }
}

if (typeof window !== "undefined") {
  window.ClippyChoppy = ClippyChoppy;
}
