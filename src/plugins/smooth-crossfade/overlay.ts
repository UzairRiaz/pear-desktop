import { getProgressBar } from './ytm-adapter';

import type { OverlaySnapshot } from './engine';

const HEIGHT = 136;
const PAD = 10;
/** Seconds shown either side of the fade in the zoomed view. */
const ZOOM_MARGIN = 8;
/** Loudness shown from this many dB below full scale up to 0 dB. */
const RANGE_DB = 50;

const COLORS = {
  background: 'rgba(16, 16, 16, 0.9)',
  border: 'rgba(255, 255, 255, 0.12)',
  text: '#f1f1f1',
  muted: '#9e9e9e',
  outgoing: '#ffb74d',
  incoming: '#4dd0e1',
  fade: 'rgba(255, 255, 255, 0.06)',
  playhead: '#ffffff',
};

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const level = (db: number) => clamp01((db + RANGE_DB) / RANGE_DB);
const toDb = (gain: number) => 20 * Math.log10(Math.max(gain, 1e-6));
/** Bass shelf (dB) drawn as a 0–1 line: 0 dB at the top, full cut at the bottom. */
const bassLevel = (db: number) => clamp01(1 + (db / 30));

const bpmText = (bpm: number | null | undefined) =>
  bpm ? `${bpm.toFixed(1)} BPM` : '? BPM';

/**
 * Canvas shown above the seekbar while the pointer is over it: the current
 * song's loudness over its whole length, and a zoomed view of the upcoming
 * transition with both songs' loudness, beats and the fade curves, so you can
 * see whether the transition does what it should.
 */
export class SeekbarOverlay {
  private readonly canvas = document.createElement('canvas');
  private readonly context: CanvasRenderingContext2D;
  private visible = false;
  private frame = 0;

  constructor(private readonly getSnapshot: () => OverlaySnapshot) {
    Object.assign(this.canvas.style, {
      position: 'fixed',
      zIndex: '10000',
      pointerEvents: 'none',
      display: 'none',
      borderRadius: '8px',
      boxShadow: '0 4px 16px rgba(0, 0, 0, 0.5)',
    });
    this.context = this.canvas.getContext('2d')!;
  }

  start() {
    document.body.append(this.canvas);
    document.addEventListener('pointermove', this.onPointerMove, {
      passive: true,
    });
    document.addEventListener('pointerleave', this.hide, { passive: true });
  }

  stop() {
    document.removeEventListener('pointermove', this.onPointerMove);
    document.removeEventListener('pointerleave', this.hide);
    this.hide();
    this.canvas.remove();
  }

  // The seekbar element gets re-rendered by YT Music, so hit-test its current
  // position instead of holding listeners on it.
  private readonly onPointerMove = (event: PointerEvent) => {
    const bar = getProgressBar();
    if (!bar) return this.hide();
    const rect = bar.getBoundingClientRect();
    const over =
      rect.width > 0 &&
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top - 4 &&
      event.clientY <= rect.bottom + 4;
    if (over) this.show(rect);
    else this.hide();
  };

  private show(rect: DOMRect) {
    const width = Math.max(320, Math.round(rect.width));
    const left = Math.max(0, Math.min(rect.left, window.innerWidth - width));
    const top = Math.max(0, rect.top - HEIGHT - 6);
    const ratio = window.devicePixelRatio || 1;
    if (this.canvas.width !== width * ratio) {
      this.canvas.width = width * ratio;
      this.canvas.height = HEIGHT * ratio;
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${HEIGHT}px`;
    }
    this.canvas.style.left = `${left}px`;
    this.canvas.style.top = `${top}px`;
    this.canvas.style.display = 'block';

    if (!this.visible) {
      this.visible = true;
      const loop = () => {
        if (!this.visible) return;
        this.draw();
        this.frame = requestAnimationFrame(loop);
      };
      loop();
    }
  }

  private readonly hide = () => {
    this.visible = false;
    cancelAnimationFrame(this.frame);
    this.canvas.style.display = 'none';
  };

  private draw() {
    const snapshot = this.getSnapshot();
    const ratio = window.devicePixelRatio || 1;
    const width = this.canvas.width / ratio;
    const g = this.context;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, width, HEIGHT);

    g.fillStyle = COLORS.background;
    g.fillRect(0, 0, width, HEIGHT);
    g.strokeStyle = COLORS.border;
    g.strokeRect(0.5, 0.5, width - 1, HEIGHT - 1);

    this.drawHeader(snapshot, width);
    this.drawZoom(snapshot, width, 28, 76);
    this.drawSong(snapshot, width, 112, 16);
  }

  private drawHeader(snapshot: OverlaySnapshot, width: number) {
    const g = this.context;
    g.font = '11px Roboto, Arial, sans-serif';
    g.textBaseline = 'top';

    const out = snapshot.outgoing?.analysis;
    const outBpm = out?.grid ? 60 / out.grid.period : null;
    g.fillStyle = COLORS.outgoing;
    g.textAlign = 'left';
    g.fillText(
      `Now ${bpmText(outBpm)} · ${out?.key?.camelot ?? '?'} · beat ${out ? out.beatConfidence.toFixed(2) : '?'}`,
      PAD,
      8,
    );

    const incoming = snapshot.incoming?.analysis;
    const inBpm = incoming?.grid ? 60 / incoming.grid.period : null;
    g.fillStyle = COLORS.incoming;
    g.textAlign = 'right';
    g.fillText(
      incoming
        ? `Next ${bpmText(inBpm)} · ${incoming.key?.camelot ?? '?'} · beat ${incoming.beatConfidence.toFixed(2)}`
        : 'Next: not loaded yet',
      width - PAD,
      8,
    );

    const plan = snapshot.plan;
    g.fillStyle = COLORS.text;
    g.textAlign = 'center';
    const styleName = {
      beatmatch: 'Beat-match',
      echo: 'Echo-out',
      crossfade: 'Crossfade',
    };
    const middle = plan
      ? `${styleName[plan.style]} · ${plan.reason}`
      : snapshot.status;
    g.fillText(middle, width / 2, 8, width * 0.4);
  }

  private drawZoom(
    snapshot: OverlaySnapshot,
    width: number,
    top: number,
    height: number,
  ) {
    const g = this.context;
    const { window } = snapshot;
    const middle = top + (height / 2);
    const half = (height / 2) - 2;

    if (!window) {
      g.fillStyle = COLORS.muted;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(snapshot.status, width / 2, middle);
      return;
    }

    const from = window.start - ZOOM_MARGIN;
    const to = window.end + ZOOM_MARGIN;
    const left = PAD;
    const right = width - PAD;
    const x = (t: number) => left + (((t - from) / (to - from)) * (right - left));
    const timeAt = (px: number) =>
      from + (((px - left) / (right - left)) * (to - from));

    // Transition region.
    g.fillStyle = COLORS.fade;
    g.fillRect(x(window.start), top, x(window.end) - x(window.start), height);

    // Loudness: outgoing above the centre line, incoming below. Faint = the
    // song as recorded; solid = after the fade gains, i.e. what you hear.
    const { profile, incoming } = snapshot;
    const outDb = (t0: number, t1: number) => {
      if (!profile) return Number.NaN;
      const a = Math.max(0, Math.floor(t0 / profile.bucketSeconds));
      const b = Math.min(
        profile.levels.length - 1,
        Math.floor(t1 / profile.bucketSeconds),
      );
      let peak = Number.NaN;
      for (let i = a; i <= b; i++) {
        const v = profile.levels[i];
        if (!Number.isNaN(v) && !(v <= peak)) peak = v;
      }
      return peak;
    };
    const inDb = (t0: number, t1: number) => {
      if (!incoming) return Number.NaN;
      const u0 = incoming.timeAt(t0) - incoming.envelopeStart;
      const u1 = incoming.timeAt(t1) - incoming.envelopeStart;
      if (Number.isNaN(u0) || Number.isNaN(u1)) return Number.NaN;
      const a = Math.max(0, Math.floor(u0 * incoming.frameRate));
      const b = Math.min(
        incoming.envelope.length - 1,
        Math.floor(u1 * incoming.frameRate),
      );
      let peak = Number.NaN;
      for (let i = a; i <= b; i++) {
        const v = incoming.envelope[i];
        if (!(v <= peak)) peak = v;
      }
      return peak;
    };

    for (let px = left; px < right; px++) {
      const t0 = timeAt(px);
      const t1 = timeAt(px + 1);
      const gains = snapshot.levelsAt(t0);

      const o = outDb(t0, t1);
      if (!Number.isNaN(o) && t0 <= window.end) {
        g.fillStyle = 'rgba(255, 183, 77, 0.25)';
        g.fillRect(px, middle - (level(o) * half), 1, level(o) * half);
        const heard = level(o + toDb(gains.out));
        g.fillStyle = COLORS.outgoing;
        g.fillRect(px, middle - (heard * half), 1, heard * half);
      }

      const i = inDb(t0, t1);
      if (!Number.isNaN(i)) {
        g.fillStyle = 'rgba(77, 208, 225, 0.25)';
        g.fillRect(px, middle, 1, level(i) * half);
        const heard = level(i + toDb(gains.in));
        g.fillStyle = COLORS.incoming;
        g.fillRect(px, middle, 1, heard * half);
      }
    }

    g.fillStyle = COLORS.border;
    g.fillRect(left, middle, right - left, 1);

    // Beats: outgoing ticks hang from the top, incoming ticks rise from the
    // bottom. When the songs are beat-matched they line up.
    const tick = (
      t: number,
      fromTop: boolean,
      length: number,
      color: string,
    ) => {
      if (t < from || t > to) return;
      g.fillStyle = color;
      const px = Math.round(x(t));
      if (fromTop) g.fillRect(px, top, 1, length);
      else g.fillRect(px, top + height - length, 1, length);
    };

    const outgoing = snapshot.outgoing;
    if (outgoing) {
      const { downbeats } = outgoing.analysis;
      outgoing.beats.forEach((t, i) => {
        const down =
          downbeats &&
          i >= downbeats.first &&
          (i - downbeats.first) % downbeats.meter === 0;
        tick(t, true, down ? 12 : 7, COLORS.outgoing);
      });
      for (const t of outgoing.predicted) {
        tick(t, true, 5, 'rgba(255, 183, 77, 0.5)');
      }
    }
    if (incoming) {
      const { beats, downbeats } = incoming.analysis;
      beats.forEach((t, i) => {
        const down =
          downbeats &&
          i >= downbeats.first &&
          (i - downbeats.first) % downbeats.meter === 0;
        tick(incoming.songAt(t), false, down ? 12 : 7, COLORS.incoming);
      });
    }

    // Gain curves (solid) and bass shelves (dashed) across the transition.
    const curve = (
      pick: (l: ReturnType<OverlaySnapshot['levelsAt']>) => number,
      color: string,
      dashed = false,
    ) => {
      g.strokeStyle = color;
      g.lineWidth = dashed ? 1 : 1.5;
      g.setLineDash(dashed ? [3, 3] : []);
      g.beginPath();
      for (let px = left; px <= right; px += 2) {
        const value = pick(snapshot.levelsAt(timeAt(px)));
        const y = top + height - 1 - (value * (height - 2));
        if (px === left) g.moveTo(px, y);
        else g.lineTo(px, y);
      }
      g.stroke();
      g.setLineDash([]);
      g.lineWidth = 1;
    };
    curve((l) => l.out, 'rgba(255, 183, 77, 0.8)');
    curve((l) => l.in, 'rgba(77, 208, 225, 0.8)');
    curve((l) => bassLevel(l.outBass), 'rgba(255, 183, 77, 0.6)', true);
    curve((l) => bassLevel(l.inBass), 'rgba(77, 208, 225, 0.6)', true);

    // Playhead.
    if (snapshot.position >= from && snapshot.position <= to) {
      g.fillStyle = COLORS.playhead;
      g.fillRect(Math.round(x(snapshot.position)), top, 1, height);
    }

    g.fillStyle = COLORS.muted;
    g.textBaseline = 'bottom';
    g.textAlign = 'left';
    g.fillText(`${Math.round(from)}s`, left + 2, top + height);
    g.textAlign = 'right';
    g.fillText(`${Math.round(to)}s`, right - 2, top + height);
  }

  private drawSong(
    snapshot: OverlaySnapshot,
    width: number,
    top: number,
    height: number,
  ) {
    const g = this.context;
    const { duration, profile } = snapshot;
    if (!duration) return;

    const left = PAD;
    const right = width - PAD;
    const x = (t: number) => left + ((t / duration) * (right - left));

    if (snapshot.window) {
      const { start, end } = snapshot.window;
      g.fillStyle = 'rgba(255, 255, 255, 0.15)';
      g.fillRect(x(start), top, Math.max(2, x(end) - x(start)), height);
    }

    if (profile) {
      for (let px = left; px < right; px++) {
        const t0 = ((px - left) / (right - left)) * duration;
        const t1 = ((px + 1 - left) / (right - left)) * duration;
        const a = Math.floor(t0 / profile.bucketSeconds);
        const b = Math.min(
          profile.levels.length - 1,
          Math.floor(t1 / profile.bucketSeconds),
        );
        let peak = Number.NaN;
        for (let i = a; i <= b; i++) {
          const v = profile.levels[i];
          if (!Number.isNaN(v) && !(v <= peak)) peak = v;
        }
        if (Number.isNaN(peak)) continue;
        const h = Math.max(1, level(peak) * height);
        g.fillStyle = t0 <= snapshot.position ? '#e0e0e0' : '#757575';
        g.fillRect(px, top + height - h, 1, h);
      }
    } else {
      g.fillStyle = COLORS.muted;
      g.fillRect(left, top + height - 1, right - left, 1);
    }

    g.fillStyle = COLORS.playhead;
    g.fillRect(Math.round(x(snapshot.position)), top - 2, 1, height + 2);
  }
}
