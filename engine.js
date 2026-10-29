/* engine.js - DX Arranger engine for Android (and any browser). No server, no Python: everything runs in the page.
 * It answers the same /api/* calls the Windows server does, so the panel and bridge.js are used unchanged.
 * Sections: 1 MIDI + styles | 2 effects | 3 sound (Web Audio, SoundFont) | 4 style player | 5 multi pads | 6 engine + API | 7 boot */
(function (root) {
'use strict';
const EPS = 1e-4, LOOK = 0.045;                       // seconds: events this close to a cut belong to the section that starts there / scheduling window
const SETUP = new Set(['SFF1', 'SFF2', 'SInt']);
const STYLE_EXTS = ['.sty', '.prs', '.bcs', '.sst', '.pcs', '.pst', '.fps', '.mid'];
const PAD_EXTS = ['.pad', '.mid', '.midi', '.wav', '.mp3', '.m4a', '.ogg'];
const lower = s => String(s).toLowerCase();
const endsWithAny = (n, exts) => exts.some(e => lower(n).endsWith(e));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const baseName = n => String(n).replace(/\.[^.]+$/, '');

// ======================= 1. MIDI + STYLES =======================
function readVLQ(b, pos) {
  let v = 0;
  for (let i = 0; i < 4; i++) {
    if (pos >= b.length) throw new Error('ran out of bytes');
    const x = b[pos++]; v = (v << 7) | (x & 0x7F);
    if (!(x & 0x80)) return [v, pos];
  }
  throw new Error('bad variable-length number');
}
function parseTrack(trk) {                            // -> [{t, k:'meta'|'sysex'|'chan', ...}]   chan: kind, chan(1-16), d[]
  const ev = []; let pos = 0, tick = 0, running = null;
  try {
    while (pos < trk.length) {
      let delta; [delta, pos] = readVLQ(trk, pos); tick += delta;
      const status = trk[pos];
      if (status === 0xFF) {
        const type = trk[pos + 1]; let len; [len, pos] = readVLQ(trk, pos + 2);
        if (pos + len > trk.length) throw new Error('meta past end');
        ev.push({ t: tick, k: 'meta', type, data: trk.subarray(pos, pos + len) }); pos += len; running = null;
        if (type === 0x2F) break;
      } else if (status === 0xF0 || status === 0xF7) {
        let len; [len, pos] = readVLQ(trk, pos + 1); pos += len; running = null;
      } else {
        if (status & 0x80) { running = status; pos++; } else if (running === null) throw new Error('no running status');
        const kind = running & 0xF0, chan = (running & 0x0F) + 1, n = (kind === 0xC0 || kind === 0xD0) ? 1 : 2;
        if (pos + n > trk.length) throw new Error('chan msg past end');
        ev.push({ t: tick, k: 'chan', kind, chan, d: Array.from(trk.subarray(pos, pos + n)) }); pos += n;
      }
    }
  } catch (e) { /* keep the events read so far, like the Python reader */ }
  return ev;
}
function readSMF(bytes, allTracks) {                  // bytes: Uint8Array -> {ppq, events}
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'MThd') throw new Error('Not a MIDI-based file.');
  const hlen = dv.getUint32(4), ppq = dv.getUint16(12);
  if (ppq & 0x8000 || !ppq) throw new Error('SMPTE time is not supported.');
  let pos = 8 + hlen, ev = [];
  while (pos + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]), size = dv.getUint32(pos + 4);
    if (id === 'MTrk') { ev = ev.concat(parseTrack(bytes.subarray(pos + 8, pos + 8 + size))); if (!allTracks) break; }
    pos += 8 + size;
  }
  ev.sort((a, b) => a.t - b.t);
  return { ppq, events: ev };
}
const text = d => String.fromCharCode.apply(null, Array.from(d));
function timeSig(ev) { for (const e of ev) if (e.k === 'meta' && e.type === 0x58 && e.data.length >= 2) return [e.data[0], 2 ** e.data[1]]; return [4, 4]; }
function findSections(ev, ppq) {
  const marks = ev.filter(e => e.k === 'meta' && e.type === 6).map(e => [e.t, text(e.data)]);
  const endTick = Math.max(0, ...ev.map(e => e.t));
  const secs = {}; let s0 = null, s1 = null;
  marks.forEach(([t, name], n) => {
    const nxt = n + 1 < marks.length ? marks[n + 1][0] : endTick;
    if (SETUP.has(name)) { if (s0 === null) s0 = t; s1 = nxt; } else secs[name] = [t, nxt];
  });
  const [num, den] = timeSig(ev), barTicks = Math.max(1, Math.floor(ppq * 4 * num / den));
  for (const name of Object.keys(secs)) {             // snap every section to whole bars (within one beat)
    const [a, b] = secs[name], bars = Math.max(1, Math.round((b - a) / barTicks)), snapped = a + bars * barTicks;
    if (snapped !== b && Math.abs(snapped - b) <= ppq) secs[name] = [a, snapped];
  }
  return { secs, setup: [s0, s1] };
}
function makeClock(ev, ppq) {
  const pts = [[0, 0, 500000]]; let us = 500000, sec = 0, last = 0;
  for (const e of ev) if (e.k === 'meta' && e.type === 0x51 && e.data.length === 3) {
    sec += (e.t - last) * us / 1e6 / ppq; last = e.t; us = (e.data[0] << 16) | (e.data[1] << 8) | e.data[2]; pts.push([e.t, sec, us]);
  }
  return t => { let b = pts[0]; for (const p of pts) if (p[0] <= t) b = p; return b[1] + (t - b[0]) * b[2] / 1e6 / ppq; };
}
const SHAKERS = new Set([69, 70, 82]);
const HIGH_PERC = new Set([42, 44, 46, 51, 53, 54, 59, 69, 70, 73, 74, 75, 80, 81, 82, 83]);
function polishVelocity(note, vel, tick, ppq, amount) {
  const ph = (tick % ppq) / ppq; let f;
  if (Math.min(ph, 1 - ph) < 0.06) f = 1.0; else if (Math.abs(ph - 0.5) < 0.06) f = 0.88;
  else if (Math.min(Math.abs(ph - 0.25), Math.abs(ph - 0.75)) < 0.06) f = 0.74; else f = 0.80;
  f *= 0.94;
  const h = (Math.imul(tick, 2654435761 | 0) ^ Math.imul(note, 40503)) & 0xFFFF;
  f *= 1 + (h / 65535 - 0.5) * 0.12;
  return clamp(Math.round(vel + (vel * f - vel) * amount), 1, 127);
}
/* Drums only: channel 10 as written; channel 9 (second rhythm part) played on channel 10; everything else dropped. */
function build(ev, start, end, toSec, o) {
  const base = toSec(start), out = [];
  for (const e of ev) {
    if (e.k !== 'chan' || !(e.t >= start && e.t < end)) continue;
    let { kind, chan, d } = e;
    if (chan === 9 && o.with9 && (kind === 0x80 || kind === 0x90)) chan = 10; else if (chan !== 10) continue;
    if (o.kit != null && chan === 10 && kind === 0xC0) continue;
    d = d.slice();
    if (kind === 0x90 && d[1] > 0) {
      if (o.polish > 0 && HIGH_PERC.has(d[0])) d[1] = polishVelocity(d[0], d[1], e.t - start, o.ppq, o.polish);
      if (SHAKERS.has(d[0])) d[1] = clamp(Math.round(d[1] * o.shaker), 1, 127);
    }
    out.push([toSec(e.t) - base, [kind | (chan - 1)].concat(d)]);
  }
  if (o.kit != null) out.unshift([0, [0xC9, o.kit | 0]]);
  return { body: out, length: toSec(end) - base };
}
function groupEvents(body, off, tol) {                // [[at,msg]] -> [[at,[msgs]]], skipping those before `off`
  const out = []; tol = tol == null ? 0.0005 : tol;
  for (const [at, m] of body) {
    if (at < off - EPS) continue;
    const last = out[out.length - 1];
    if (last && at - last[0] <= tol) last[1].push(m); else out.push([at, [m]]);
  }
  return out;
}
function prepareStyle(bytes, name, opt) {              // -> package used by the player
  const { ppq, events } = readSMF(bytes, false);
  const { secs, setup } = findSections(events, ppq);
  if (!Object.keys(secs).length) throw new Error('No sections found in that file.');
  const toSec = makeClock(events, ppq), o = { ppq, with9: true, kit: opt.kit, polish: opt.polish, shaker: opt.shaker };
  const setupMsgs = setup[0] !== null ? build(events, setup[0], setup[1], toSec, o).body : [];
  const cache = {};
  const get = n => cache[n] || (cache[n] = build(events, secs[n][0], secs[n][1], toSec, o));
  const first = events.find(e => e.k === 'meta' && e.type === 0x51 && e.data.length === 3);
  const us = first ? (first.data[0] << 16) | (first.data[1] << 8) | first.data[2] : 500000;
  const [num, den] = timeSig(events), mains = Object.keys(secs).filter(n => n.startsWith('Main'));
  return { secs, get, setup: setupMsgs, base: 60000000 / us, num, den,
           main: secs['Main A'] ? 'Main A' : (mains[0] || Object.keys(secs)[0]), name: baseName(name) };
}

class TempoClock {                                     // style seconds ("song position") <-> audio-clock seconds
  constructor(base, bpm, t, pos) { this.base = base; this.s = [t, pos || 0, base / bpm]; }
  real(p) { const [t, q, k] = this.s; return t + (p - q) * k; }
  posAt(t) { const [t0, q, k] = this.s; return q + (t - t0) / k; }
  setBpm(bpm, now) { this.s = [now, this.posAt(now), this.base / bpm]; }
}

// ======================= 2. EFFECTS (state) =======================
const FX_IDS = ['geq', 'eq3m', 'ezeq', 'studio', 'spring', 'drive'];
const FX_AMOUNTS = { geq: [2, 0, -1, 1, 2], eq3m: [2, 0, 2], ezeq: 3, drive: 0.6 };   // dB: kick,low,mid,high,air | low,mid,high | tilt | 0-1

// ======================= 2b. SOUNDFONT (.sf2) reader =======================
class SF2 {
  constructor(buf) {
    const dv = new DataView(buf), chunks = {};
    const id4 = o => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    if (id4(0) !== 'RIFF' || id4(8) !== 'sfbk') throw new Error('Not a SoundFont (.sf2) file.');
    const walk = (s, e) => { while (s + 8 <= e) { const id = id4(s), size = dv.getUint32(s + 4, true);
      if (id === 'LIST') walk(s + 12, s + 8 + size); else chunks[id] = { off: s + 8, size }; s += 8 + size + (size & 1); } };
    walk(12, buf.byteLength);
    if (!chunks.smpl || !chunks.phdr) throw new Error('This SoundFont has no samples or presets.');
    this.smpl = new Int16Array(buf, chunks.smpl.off, chunks.smpl.size >> 1);
    const str = (o, n) => { let s = ''; for (let i = 0; i < n; i++) { const c = dv.getUint8(o + i); if (!c) break; s += String.fromCharCode(c); } return s; };
    const tab = (c, sz, f) => { const out = []; if (!c) return out; for (let o = c.off; o + sz <= c.off + c.size; o += sz) out.push(f(o)); return out; };
    this.phdr = tab(chunks.phdr, 38, o => ({ name: str(o, 20), preset: dv.getUint16(o + 20, true), bank: dv.getUint16(o + 22, true), bag: dv.getUint16(o + 24, true) }));
    this.pbag = tab(chunks.pbag, 4, o => ({ gen: dv.getUint16(o, true) }));
    this.pgen = tab(chunks.pgen, 4, o => [dv.getUint16(o, true), dv.getUint8(o + 2), dv.getUint8(o + 3), dv.getInt16(o + 2, true)]);
    this.inst = tab(chunks.inst, 22, o => ({ bag: dv.getUint16(o + 20, true) }));
    this.ibag = tab(chunks.ibag, 4, o => ({ gen: dv.getUint16(o, true) }));
    this.igen = tab(chunks.igen, 4, o => [dv.getUint16(o, true), dv.getUint8(o + 2), dv.getUint8(o + 3), dv.getInt16(o + 2, true)]);
    this.shdr = tab(chunks.shdr, 46, o => ({ start: dv.getUint32(o + 20, true), end: dv.getUint32(o + 24, true), ls: dv.getUint32(o + 28, true),
      le: dv.getUint32(o + 32, true), rate: dv.getUint32(o + 36, true), pitch: dv.getUint8(o + 40), corr: dv.getInt8(o + 41) }));
    this.byKey = {}; this.phdr.forEach((p, i) => { if (p.name !== 'EOP') this.byKey[p.bank * 128 + p.preset] = i; });
    this.cache = {}; this.zc = new Map();
    this.drums = Object.keys(this.byKey).some(k => k >= 128 * 128);    // worked out once, not on every drum hit
  }
  hasDrums() { return this.drums; }
  _zones(bags, gens, b0, b1, instrumentOper) {          // -> {global, zones:[{g:{oper:[lo,hi,amt]}}]}
    const zones = []; let global = null;
    for (let b = b0; b < b1; b++) {
      const g = {}; for (let i = bags[b].gen; i < bags[b + 1].gen; i++) g[gens[i][0]] = gens[i];
      if (g[instrumentOper] === undefined) { if (b === b0) global = g; } else zones.push(g);
    }
    return { global: global || {}, zones };
  }
  voices(bank, prog, key, vel) {                        // -> [{sample, root, tune, atten, pan, loop, excl, env, fc}]
    let pi = this.byKey[bank * 128 + prog];
    if (pi === undefined) pi = this.byKey[bank * 128 + 0];
    if (pi === undefined && bank !== 128) pi = this.byKey[0 * 128 + prog];
    if (pi === undefined) return [];
    let pz = this.zc.get('p' + pi);
    if (!pz) { pz = this._zones(this.pbag, this.pgen, this.phdr[pi].bag, this.phdr[pi + 1].bag, 41); this.zc.set('p' + pi, pz); }
    const inRange = (g, op) => { const r = g[op]; return !r || (r[1] <= (op === 43 ? key : vel) && (op === 43 ? key : vel) <= r[2]); };
    const out = [];
    for (const z of pz.zones) {
      const pg = Object.assign({}, pz.global, z);
      if (!inRange(pg, 43) || !inRange(pg, 44)) continue;
      const ii = pg[41][3]; let iz = this.zc.get('i' + ii);
      if (!iz) { iz = this._zones(this.ibag, this.igen, this.inst[ii].bag, this.inst[ii + 1].bag, 53); this.zc.set('i' + ii, iz); }
      for (const z2 of iz.zones) {
        const g = Object.assign({}, iz.global, z2);
        if (!inRange(g, 43) || !inRange(g, 44)) continue;
        const a = op => (g[op] ? g[op][3] : null), p = op => (pg[op] ? pg[op][3] : 0), sh = this.shdr[g[53][3]];
        if (!sh) continue;
        const root = a(58) !== null && a(58) >= 0 ? a(58) : sh.pitch;
        out.push({ id: g[53][3], sh, root, scale: a(56) === null ? 100 : a(56),
          tune: (a(51) || 0) * 100 + (a(52) || 0) + p(51) * 100 + p(52) + sh.corr, atten: Math.max(0, (a(48) || 0) + p(48)),
          pan: clamp(((a(17) || 0) + p(17)) / 500, -1, 1), loop: ((a(54) || 0) & 1) === 1, excl: a(57) || 0,
          env: { a: a(34) == null ? -12000 : a(34), h: a(35) == null ? -12000 : a(35), d: a(36) == null ? -12000 : a(36),
                 s: a(37) || 0, r: a(38) == null ? -12000 : a(38) }, fc: a(8) == null ? 13500 : a(8) });
      }
    }
    return out;
  }
  buffer(ctx, v) {                                       // AudioBuffer for one sample (decoded once, on first use)
    let b = this.cache[v.id];
    if (!b) {
      const sh = v.sh, n = Math.max(1, sh.end - sh.start), f = new Float32Array(n);
      for (let i = 0; i < n; i++) f[i] = this.smpl[sh.start + i] / 32768;
      b = ctx.createBuffer(1, n, clamp(sh.rate || 44100, 8000, 96000)); b.getChannelData(0).set(f); this.cache[v.id] = b;
    }
    return b;
  }
}

// ======================= 3. SOUND (Web Audio) =======================
class Sound {
  constructor(ctx) {
    this.ctx = ctx; const c = ctx;
    this.sf = null; this.sfName = ''; this.chans = []; this.active = {}; this.excl = {}; this.openHat = null; this.revKind = ''; this.irs = {};
    this.amounts = JSON.parse(JSON.stringify(FX_AMOUNTS)); this.master_pct = 100; this.muted = false; this.efx = true;
    const bq = (type, f, q) => { const n = c.createBiquadFilter(); n.type = type; n.frequency.value = f; if (q) n.Q.value = q; n.gain.value = 0; return n; };
    this.geq = [bq('lowshelf', 90), bq('peaking', 220, 0.9), bq('peaking', 1200, 0.9), bq('peaking', 4500, 0.9), bq('highshelf', 9000)];
    this.m3 = [bq('lowshelf', 200), bq('peaking', 1500, 0.8), bq('highshelf', 5000)];
    this.ez = [bq('lowshelf', 250), bq('highshelf', 4000)];
    this.mix = c.createGain();
    let node = this.mix; for (const f of this.geq.concat(this.m3, this.ez)) { node.connect(f); node = f; }
    this.pre = c.createGain(); this.shaper = c.createWaveShaper(); this.post = c.createGain(); this.shaper.oversample = 'none';
    this.sum = c.createGain(); node.connect(this.pre); this.pre.connect(this.shaper); this.shaper.connect(this.post); this.post.connect(this.sum);   // one path: nothing to cancel
    this.revSend = c.createGain(); this.conv = c.createConvolver(); this.revRet = c.createGain();
    this.master = c.createGain(); this.comp = c.createDynamicsCompressor();
    this.comp.threshold.value = -8; this.comp.knee.value = 14; this.comp.ratio.value = 5; this.comp.attack.value = 0.003; this.comp.release.value = 0.18;
    this.sum.connect(this.master); this.sum.connect(this.revSend); this.revSend.connect(this.conv); this.conv.connect(this.revRet); this.revRet.connect(this.master);
    this.master.connect(this.comp); this.comp.connect(c.destination);
    const nb = c.createBuffer(1, c.sampleRate * 2, c.sampleRate), d = nb.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = nb;
    this.setFx({});
  }
  // ---- mixer / effects ----
  setMaster(pct) { this.master_pct = pct; this._master(); }
  setMuted(m) { this.muted = m; this._master(); }
  _master() { this.master.gain.setTargetAtTime(this.muted ? 0 : (this.master_pct / 100) * 0.9, this.ctx.currentTime, 0.01); }
  setEfx(on) { this.efx = on; this.revRet.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.02); }
  setFx(on) {
    const t = this.ctx.currentTime, A = this.amounts, set = (n, v) => n.gain.setTargetAtTime(v, t, 0.02);
    this.geq.forEach((f, i) => set(f, on.geq ? A.geq[i] : 0));
    this.m3.forEach((f, i) => set(f, on.eq3m ? A.eq3m[i] : 0));
    set(this.ez[0], on.ezeq ? -A.ezeq : 0); set(this.ez[1], on.ezeq ? A.ezeq : 0);
    const dr = on.drive ? A.drive : 0;
    if (dr) {                                            // warm saturation: soft hits get fuller, loud hits are rounded, level stays close
      const k = 1 + 3 * dr, m = Math.min(1, 1.2 * dr), curve = new Float32Array(1025);
      for (let i = 0; i < 1025; i++) { const x = i / 512 - 1; curve[i] = (1 - m) * x + m * Math.tanh(k * x) / Math.tanh(k); }
      this.shaper.curve = curve;
    } else this.shaper.curve = null;                     // off: straight through
    this.pre.gain.setTargetAtTime(dr ? 1 + dr : 1, t, 0.02); this.post.gain.setTargetAtTime(dr ? 0.42 : 1, t, 0.02);
    const kind = on.studio ? 'studio' : on.spring ? 'spring' : 'default';
    if (kind !== this.revKind) {
      this.revKind = kind; this.conv.buffer = this.irs[kind] || (this.irs[kind] = this._ir(kind));
      this.revSend.gain.value = { default: 0.14, studio: 0.32, spring: 0.38 }[kind];
    }
  }
  _ir(kind) {                                           // generated reverb tail (stereo)
    const c = this.ctx, sr = c.sampleRate, dur = { default: 0.9, studio: 2.0, spring: 1.0 }[kind], n = Math.floor(sr * dur);
    const b = c.createBuffer(2, n, sr), decay = { default: 6, studio: 3.1, spring: 5 }[kind], k = { default: 0.5, studio: 0.32, spring: 0.8 }[kind];
    const pre = kind === 'studio' ? Math.floor(sr * 0.018) : 0;
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch); let lp = 0;
      for (let i = pre; i < n; i++) { const t = (i - pre) / sr; lp += ((Math.random() * 2 - 1) * Math.exp(-t * decay) - lp) * k; d[i] = lp; }
      if (kind === 'spring') for (let r = 0; r < 14; r++) {   // the spring "boing": repeating falling chirps
        const t0 = Math.floor((r * 0.041 + ch * 0.003) * sr), len = Math.floor(sr * 0.03), amp = 0.55 * Math.pow(0.82, r);
        for (let j = 0; j < len && t0 + j < n; j++) { const s = j / sr; d[t0 + j] += amp * Math.sin(2 * Math.PI * (3200 - 90000 * s) * s) * Math.sin(Math.PI * j / len); }
      }
    }
    return b;
  }
  // ---- soundfont ----
  loadSF2(buf, name) { this.sf = new SF2(buf); this.sfName = name || 'SOUNDFONT'; this.excl = {}; }
  clearSF2() { this.sf = null; this.sfName = ''; }
  // ---- channels ----
  chan(ch) {
    let s = this.chans[ch];
    if (!s) {
      const c = this.ctx; s = this.chans[ch] = { prog: 0, cc7: 100 / 127, part: 1, part_g: c.createGain(), vol: c.createGain(), pan: c.createStereoPanner() };
      s.part_g.connect(s.vol); s.vol.connect(s.pan); s.pan.connect(this.mix); s.vol.gain.value = s.cc7; s.in = s.part_g;
    }
    return s;
  }
  setPart(ch, pct) { const s = this.chan(ch); s.part = pct / 100; s.part_g.gain.setTargetAtTime(s.part, this.ctx.currentTime, 0.02); }
  send(m, when) {                                       // m = [status, d1, d2]; returns a handle for note-ons
    const st = m[0] & 0xF0, ch = m[0] & 0x0F;
    if (st === 0x90 && m[2] > 0) return this.noteOn(ch, m[1], m[2], when);
    if (st === 0x80 || st === 0x90) { this.noteOff(ch, m[1], when); return null; }
    if (st === 0xC0) this.chan(ch).prog = m[1];
    else if (st === 0xB0) {
      const s = this.chan(ch);
      if (m[1] === 7) s.vol.gain.setValueAtTime(m[2] / 127, Math.max(when, this.ctx.currentTime));
      else if (m[1] === 10) s.pan.pan.setValueAtTime(clamp((m[2] - 64) / 64, -1, 1), Math.max(when, this.ctx.currentTime));
      else if (m[1] === 123 || m[1] === 120) this.allOff(ch);
    }
    return null;
  }
  allOff(ch) { for (const k of Object.keys(this.active)) if (ch == null || k.startsWith(ch + ':')) { this.active[k].kill(); delete this.active[k]; } }
  handle(t) {
    const h = { t, nodes: [], gains: [], rel: [], dead: false };
    h.kill = () => { h.dead = true; for (const n of h.nodes) { try { if (n.stop) n.stop(0); } catch (e) { /* not started */ } try { n.disconnect(); } catch (e) { /* ok */ } } };
    h.fade = at => { for (const g of h.gains) { g.gain.cancelScheduledValues(at); g.gain.setTargetAtTime(0, at, 0.008); } for (const n of h.nodes) { try { if (n.stop) n.stop(at + 0.08); } catch (e) { /* ok */ } } };
    return h;
  }
  noteOn(ch, note, vel, when) {
    const t = Math.max(when, this.ctx.currentTime), s = this.chan(ch), h = this.handle(t);
    if (ch === 9) {
      if (this.sf && this.sf.hasDrums()) this._sf(h, 128, s.prog, note, vel, t, s.in, true); else this._drum(h, note, vel, t, s.in);
    } else {
      if (this.sf) this._sf(h, 0, s.prog, note, vel, t, s.in, false); else this._tone(h, s.prog, note, vel, t, s.in);
      this.active[ch + ':' + note] = h;
    }
    return h;
  }
  noteOff(ch, note, when) {
    if (ch === 9) return;                               // drum hits ring out
    const h = this.active[ch + ':' + note]; if (!h) return; delete this.active[ch + ':' + note];
    const at = Math.max(when, this.ctx.currentTime);
    for (const r of h.rel) { const g = r.g.gain; g.cancelScheduledValues(at); g.setTargetAtTime(0, at, Math.max(0.02, r.rel / 3)); try { r.src.stop(at + r.rel + 0.3); } catch (e) { /* ok */ } }
  }
  // ---- SoundFont voices ----
  _sf(h, bank, prog, note, vel, t, dest, oneShot) {
    const c = this.ctx, vs = this.sf.voices(bank, prog, note, vel), tc = x => Math.pow(2, x / 1200);
    for (const v of vs) {
      const buf = this.sf.buffer(c, v), src = c.createBufferSource(), g = c.createGain(), pan = c.createStereoPanner();
      src.buffer = buf; src.playbackRate.value = Math.pow(2, ((note - v.root) * v.scale + v.tune) / 1200);
      if (v.loop && !oneShot && v.sh.le > v.sh.ls) { src.loop = true; src.loopStart = (v.sh.ls - v.sh.start) / buf.sampleRate; src.loopEnd = (v.sh.le - v.sh.start) / buf.sampleRate; }
      const amp = Math.pow(vel / 127, 2) * Math.pow(10, -v.atten / 200) * 0.9; pan.pan.value = v.pan;
      let node = g; src.connect(g);
      if (!oneShot && v.fc < 13000) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = clamp(8.176 * tc(v.fc), 200, 20000); g.connect(f); node = f; h.nodes.push(f); }
      node.connect(pan); pan.connect(dest);
      if (oneShot) g.gain.value = amp;
      else {
        const a = Math.max(0.003, tc(v.env.a)), hd = tc(v.env.h), d = tc(v.env.d), sus = Math.pow(10, -v.env.s / 200);
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(amp, t + a); g.gain.setValueAtTime(amp, t + a + hd);
        g.gain.setTargetAtTime(amp * sus, t + a + hd, Math.max(0.01, d / 3));
        h.rel.push({ g, src, rel: Math.min(4, tc(v.env.r)) });
      }
      src.start(t); h.nodes.push(src, g, pan); h.gains.push(g);
      if (v.excl) { const prev = this.excl[v.excl]; if (prev && prev !== h && !prev.dead) prev.fade(t); this.excl[v.excl] = h; }
    }
  }
  // ---- built-in sounds (used until you load a SoundFont) ----
  _tone(h, prog, note, vel, t, dest) {
    const c = this.ctx, f = 440 * Math.pow(2, (note - 69) / 12), g = c.createGain(), amp = Math.pow(vel / 127, 1.5) * 0.28;
    const wave = prog < 8 ? 'triangle' : prog < 16 ? 'sine' : prog < 24 ? 'square' : prog < 40 ? 'sawtooth' : prog < 56 ? 'sawtooth' : prog < 72 ? 'sawtooth' : prog < 80 ? 'sine' : 'sawtooth';
    const o = c.createOscillator(), o2 = c.createOscillator(), lp = c.createBiquadFilter(), atk = (prog >= 40 && prog < 56) ? 0.12 : 0.008, rel = prog < 16 ? 0.35 : 0.2;
    o.type = wave; o2.type = 'sine'; o.frequency.value = f; o2.frequency.value = f * 2; lp.type = 'lowpass'; lp.frequency.value = clamp(f * 6, 800, 9000);
    const g2 = c.createGain(); g2.gain.value = 0.25; o.connect(lp); o2.connect(g2); g2.connect(lp); lp.connect(g); g.connect(dest);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(amp, t + atk); g.gain.setTargetAtTime(amp * (prog < 16 ? 0.35 : 0.8), t + atk, prog < 16 ? 0.5 : 2);
    o.start(t); o2.start(t); h.nodes.push(o, o2, lp, g, g2); h.gains.push(g); h.rel.push({ g, src: { stop: x => { o.stop(x); o2.stop(x); } }, rel });
  }
  _drum(h, note, vel, t, dest) {
    const c = this.ctx, lvl = Math.pow(vel / 127, 1.6) * 0.9, out = c.createGain(); out.connect(dest); h.nodes.push(out); h.gains.push(out);
    const nz = (type, f, q, dur, lv, atk, at) => {
      const s = c.createBufferSource(), fl = c.createBiquadFilter(), g = c.createGain(), t0 = t + (at || 0); s.buffer = this.noiseBuf; s.loop = true;
      fl.type = type; fl.frequency.value = f; fl.Q.value = q; atk = atk || 0.002;
      g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(lv * lvl, t0 + atk); g.gain.exponentialRampToValueAtTime(0.0008, t0 + atk + dur);
      s.connect(fl); fl.connect(g); g.connect(out); s.start(t0, Math.random() * 1.5); s.stop(t0 + atk + dur + 0.05); h.nodes.push(s, fl, g);
    };
    const tn = (f0, f1, dur, type, lv, at) => {
      const o = c.createOscillator(), g = c.createGain(), t0 = t + (at || 0); o.type = type || 'sine';
      o.frequency.setValueAtTime(f0, t0); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
      g.gain.setValueAtTime(lv * lvl, t0); g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur); o.connect(g); g.connect(out); o.start(t0); o.stop(t0 + dur + 0.05); h.nodes.push(o, g);
    };
    if (note === 35 || note === 36) { tn(165, 46, 0.34, 'sine', 1.0); nz('highpass', 3000, 0.7, 0.012, 0.35); }
    else if (note === 37) { nz('bandpass', 3500, 2, 0.04, 0.6); tn(420, 300, 0.04, 'sine', 0.3); }
    else if (note === 38 || note === 40) { nz('bandpass', note === 38 ? 2400 : 3000, 0.8, 0.2, 0.85); tn(230, 150, 0.12, 'triangle', 0.6); }
    else if (note === 39) { for (let i = 0; i < 3; i++) nz('bandpass', 1300, 1.2, i === 2 ? 0.16 : 0.012, 0.8, 0.001, i * 0.012); }
    else if ([41, 43, 45, 47, 48, 50].includes(note)) { const f = { 41: 85, 43: 105, 45: 128, 47: 152, 48: 178, 50: 205 }[note]; tn(f * 1.6, f, 0.4, 'sine', 0.9); nz('bandpass', 1800, 1, 0.02, 0.25); }
    else if (note === 42) nz('highpass', 7500, 0.7, 0.045, 0.55);
    else if (note === 44) nz('highpass', 7000, 0.7, 0.06, 0.5);
    else if (note === 46) { if (this.openHat && !this.openHat.dead) this.openHat.fade(t); nz('highpass', 6500, 0.7, 0.45, 0.5); this.openHat = h; }
    else if (note === 49 || note === 57) nz('highpass', 4500, 0.6, 1.4, 0.55, 0.003);
    else if (note === 52) nz('highpass', 3500, 0.6, 1.0, 0.55, 0.003);
    else if (note === 55) nz('highpass', 5500, 0.6, 0.55, 0.5, 0.002);
    else if (note === 51 || note === 59) { nz('highpass', 6000, 0.6, 0.9, 0.3); tn(3300, 3200, 0.25, 'square', 0.06); }
    else if (note === 53) { tn(1800, 1790, 0.6, 'sine', 0.35); tn(2700, 2690, 0.5, 'sine', 0.2); nz('highpass', 6500, 0.6, 0.4, 0.2); }
    else if (note === 54) { nz('bandpass', 9000, 1, 0.13, 0.5, 0.004); nz('highpass', 7000, 0.6, 0.07, 0.25); }
    else if (note === 56) { tn(560, 556, 0.3, 'square', 0.28); tn(845, 840, 0.3, 'square', 0.28); }
    else if (note >= 60 && note <= 66) { const f = { 60: 430, 61: 320, 62: 360, 63: 300, 64: 235, 65: 310, 66: 245 }[note]; tn(f, f * 0.8, 0.2, 'sine', 0.8); nz('bandpass', 2500, 1, 0.012, 0.3); }
    else if (note === 67 || note === 68) tn(note === 67 ? 920 : 700, note === 67 ? 915 : 695, 0.25, 'triangle', 0.5);
    else if (note === 69) nz('highpass', 6000, 0.7, 0.05, 0.5, 0.005);
    else if (note === 70) nz('bandpass', 5000, 0.9, 0.045, 0.55, 0.003);
    else if (note === 82) nz('bandpass', 6500, 0.7, 0.07, 0.5, 0.012);
    else if (note === 73 || note === 74) nz('bandpass', 3000, 1.2, note === 73 ? 0.12 : 0.25, 0.45, 0.004);
    else if (note === 75) tn(2500, 2480, 0.06, 'sine', 0.6);
    else if (note === 76 || note === 77) tn(note === 76 ? 1100 : 800, note === 76 ? 1090 : 790, 0.06, 'sine', 0.6);
    else if (note === 80 || note === 81) tn(4200, 4190, note === 80 ? 0.5 : 0.9, 'sine', 0.35);
    else if (note === 83) nz('highpass', 8000, 0.6, 0.3, 0.4);
    else nz('bandpass', 2000, 1, 0.08, 0.5);
  }
  playBuffer(buf, t, loop) {                            // audio pads
    const c = this.ctx, s = c.createBufferSource(), g = c.createGain(); s.buffer = buf; s.loop = !!loop; g.gain.value = 0.9;
    s.connect(g); g.connect(this.mix); s.start(Math.max(t, c.currentTime));
    const h = this.handle(t); h.nodes.push(s, g); h.src = s; return h;
  }
}

// ======================= 4. STYLE PLAYER (the arranger) =======================
/* One song-position clock (TempoClock) drives everything, scheduled a few ms ahead on the audio clock, so:
 * tempo changes are heard at once without moving the beat; a fill starts on the NEXT BEAT and ends on the bar line;
 * Intro/Ending start at the next bar; a style change takes over at the next bar at the same tempo. */
class Player {
  constructor(eng) { this.eng = eng; this.running = false; this.sched = []; }
  start(pkg, startName, bpm, mainName, now) {
    this.pkg = pkg; this.secs = pkg.secs; this.baseBpm = pkg.base; this.quarter = 60 / pkg.base;
    this.setTimeSig(pkg.num, pkg.den); this.get = pkg.get;
    this.bpm = clamp(bpm, 20, 300); this.cur = mainName in pkg.secs ? mainName : pkg.main; this.queue = []; this.ending = false;
    if (startName.startsWith('Main')) this.cur = startName; else {
      this.queue = [[startName, 0]]; const tail = startName.split(' ').pop();
      if (('Main ' + tail.slice(-1)) in pkg.secs) this.cur = 'Main ' + tail.slice(-1);
      this.ending = startName.startsWith('Ending');
    }
    this.clock = new TempoClock(this.baseBpm, this.bpm, now + 0.12, 0); this.G0 = 0; this.sched = [];
    this.swap = null; this.sec = null; this.running = true;
  }
  setTimeSig(num, den) { this.bar = this.quarter * 4 * num / den; this.bpb = Math.max(1, Math.round(this.bar / this.quarter)); }
  begin(now) {
    let seg, off;
    if (this.queue.length) [seg, off] = this.queue.shift(); else { seg = this.cur; off = 0; }
    if (this.swap) {                                    // change of style: our tempo and grid stay, the new style's seconds are rescaled
      const pkg = this.swap; this.swap = null; const r = pkg.base / this.baseBpm, raw = pkg.get, cache = {};
      this.get = n => cache[n] || (cache[n] = (b => ({ body: b.body.map(([at, m]) => [at * r, m]), length: b.length * r }))(raw(n)));
      this.secs = pkg.secs; this.setTimeSig(pkg.num, pkg.den);
      const mains = Object.keys(pkg.secs).filter(n => n.startsWith('Main'));
      if (!(this.cur in this.secs)) this.cur = mains[0] || Object.keys(this.secs)[0];
      if (!(seg in this.secs)) seg = this.cur;
      for (const [, m] of pkg.setup) this.eng.snd.send(m, this.clock.real(this.G0));
      this.eng.onSwap(pkg);
    }
    const { body, length } = this.get(seg);
    this.seg = seg; this.off = off; this.length = length; this.batches = groupEvents(body, off); this.idx = 0;
    this.isMain = seg.startsWith('Main'); this.canInterrupt = this.isMain || seg.startsWith('Fill In');
    this.cut = null; this.Gend = this.G0 + (length - off); this.sec = true;
    const t0 = this.clock.real(this.G0);
    for (const [at, m] of body) if (at < off - EPS && ((m[0] & 0xF0) === 0xC0 || (m[0] & 0xF0) === 0xB0)) this.eng.snd.send(m, t0);
    this.eng.set({ section: seg, bpm: this.bpm, main: this.cur });
  }
  setCut(G, now) {
    this.cut = G;
    this.sched = this.sched.filter(s => { if (s.G >= G - EPS && s.h.t > now) { s.h.kill(); return false; } return s.h.t > now - 1; });
  }
  command(c, now) {
    if (!this.running) return;
    const op = c[0];
    if (op === 'tempo') { this.bpm = clamp(Number(c[1]), 20, 300); this.clock.setBpm(this.bpm, now); this.eng.set({ bpm: this.bpm }); return; }
    if (!this.sec) this.begin(now);
    if (op === 'swap') {
      this.swap = c[1];
      if (this.isMain && !this.queue.length) {
        const pos = this.off + (this.clock.posAt(now) - this.G0), cutUn = (Math.floor(pos / this.bar + 1e-6) + 1) * this.bar;
        this.queue = [[this.seg, 0]]; if (cutUn < this.length - 1e-6) this.setCut(this.G0 + (cutUn - this.off), now);
      }
      return;
    }
    let target = null, mode = 'beat';
    if (op === 'main' && ('Main ' + c[1]) in this.secs) {
      this.cur = 'Main ' + c[1]; this.eng.set({ main: this.cur });
      if (this.eng.st.auto_fill) target = 'Fill In ' + c[1] + c[1];
    } else if (op === 'fill' && this.isMain) target = 'Fill In ' + this.cur.slice(-1) + this.cur.slice(-1);
    else if (op === 'break' && this.isMain) target = 'Fill In BA';
    else if (op === 'ending' && ('Ending ' + c[1]) in this.secs) { target = 'Ending ' + c[1]; mode = 'bar'; this.ending = true; }
    else if (op === 'intro' && ('Intro ' + c[1]) in this.secs) { target = 'Intro ' + c[1]; mode = 'bar'; }
    else return;
    if (!(target in this.secs) || !this.canInterrupt) { if (mode === 'bar' && target in this.secs) this.queue = [[target, 0]]; return; }
    if (target === this.seg) return;
    const pos = this.off + (this.clock.posAt(now) - this.G0); let cutUn, newOff;
    if (mode === 'bar') { cutUn = (Math.floor(pos / this.bar + 1e-6) + 1) * this.bar; newOff = 0; }
    else { const nb = Math.floor(pos / this.quarter + 1e-6) + 1; cutUn = nb * this.quarter; newOff = (nb % this.bpb) * this.quarter; }
    this.queue = [[target, newOff]]; this.cut = null;
    if (cutUn < this.length - 1e-6) this.setCut(this.G0 + (cutUn - this.off), now);
  }
  tick(now) {
    if (!this.running) return;
    const lim = now + LOOK;
    for (let guard = 0; guard < 64; guard++) {
      if (!this.sec) this.begin(now);
      while (this.idx < this.batches.length) {
        const [at, msgs] = this.batches[this.idx], G = this.G0 + (at - this.off);
        if (this.cut !== null && G >= this.cut - EPS) { this.idx = this.batches.length; break; }
        const t = this.clock.real(G);
        if (t > lim) return;
        for (const m of msgs) { const h = this.eng.snd.send(m, t); if (h) this.sched.push({ G, h }); }
        this.idx++;
      }
      const endG = this.cut !== null ? this.cut : this.Gend;
      if (this.clock.real(endG) > lim) return;
      this.G0 = endG; this.sec = null;
      if (this.sched.length > 200) this.sched = this.sched.filter(s => s.h.t > now - 1);
      if (this.ending && this.seg.startsWith('Ending') && !this.queue.length) { this.eng.stopStyle(); return; }
    }
  }
  stop(now) {
    this.running = false;
    for (const s of this.sched) if (s.h.t > now) s.h.kill();
    this.sched = [];
  }
}

// ======================= 5. MULTI PADS =======================
const POOL = { 1: [0, 1, 2], 2: [3, 4, 5], 3: [6, 7, 8], 4: [10, 11, 12] };   // each pad's own melodic channels; 9 = drums
function compilePad(events, ppq, a, b, slot, name, isPadFile, shaker) {
  slot = clamp(slot, 1, 4); const pool = POOL[slot], chmap = {}, banks = {};
  for (const e of events) if (e.k === 'chan' && e.kind === 0xB0 && e.d[0] === 0 && !(e.chan in banks)) banks[e.chan] = e.d[1];
  const drumSrc = new Set([10]); if (isPadFile) drumSrc.add(9); for (const ch of Object.keys(banks)) if (banks[ch] === 126 || banks[ch] === 127) drumSrc.add(Number(ch));
  const mapch = src => {
    if (drumSrc.has(src)) return 9;
    if (!(src in chmap)) { if (Object.keys(chmap).length >= pool.length) return null; chmap[src] = pool[Object.keys(chmap).length]; }
    return chmap[src];
  };
  const notes = [], setup = []; let last = 0;
  for (const e of events) {
    if (e.k !== 'chan') continue;
    const ch = mapch(e.chan); if (ch === null) continue;
    const drum = drumSrc.has(e.chan);
    if (e.kind === 0x80 || e.kind === 0x90) {
      if (e.t >= a && e.t < b) {
        const d = e.d.slice(); if (drum && e.kind === 0x90 && d[1] > 0 && SHAKERS.has(d[0])) d[1] = clamp(Math.round(d[1] * shaker), 1, 127);
        notes.push([(e.t - a) / ppq, [e.kind | ch].concat(d)]); last = Math.max(last, e.t - a);
      }
    } else if (!drum && e.t < b && (e.t <= a || !notes.length)) {
      if (!(e.kind === 0xB0 && (e.d[0] === 0 || e.d[0] === 32))) setup.push([e.kind | ch].concat(e.d));
    }
  }
  if (!notes.some(([, m]) => (m[0] & 0xF0) === 0x90 && m[2] > 0)) return null;
  const [num, den] = timeSig(events), barTicks = Math.max(1, Math.floor(ppq * 4 * num / den));
  let span = Math.max(b - a, last); if (span - last >= barTicks) span = Math.ceil(last / barTicks) * barTicks;   // trim a long silent tail to whole bars
  const beats = Math.max(1, Math.ceil(span / ppq - 1e-6)), drumsN = notes.filter(([, m]) => (m[0] & 0x0F) === 9 && (m[0] & 0xF0) === 0x90 && m[2] > 0).length;
  const inst = Object.keys(chmap);
  return { name: String(name).toUpperCase(), kind: 'midi', beats, events: notes, setup,
    info: `${drumsN} drum hits${inst.length ? ', pitched on ch ' + inst.join(',') : ''} | loops every ${beats} beats` };
}
function readPads(bytes, fileName, slot, shaker) {
  const { ppq, events } = readSMF(bytes, true);
  const marks = events.filter(e => e.k === 'meta' && e.type === 6).map(e => [e.t, text(e.data).trim()]).filter(([, n]) => !SETUP.has(n));
  const endTick = Math.max(0, ...events.map(e => e.t)), isPad = lower(fileName).endsWith('.pad'); let spans;
  if (marks.length >= 2) { const cuts = marks.slice(0, 4); spans = cuts.map(([t, n], j) => [n || 'PAD ' + (j + 1), t, j + 1 < cuts.length ? cuts[j + 1][0] : endTick]); }
  else spans = [[baseName(fileName), 0, endTick]];
  const pads = [];
  for (const [name, a, b] of spans) { const p = compilePad(events, ppq, a, b, spans.length > 1 ? 1 + pads.length : slot, name, isPad, shaker); if (p) pads.push(p); }
  if (!pads.length) throw new Error('No notes found in that file.');
  return pads;
}
class Pads {
  constructor(eng) {
    this.eng = eng; this.pads = [null, null, null, null]; this.live = [false, false, false, false]; this.run = [null, null, null, null]; this.error = '';
  }
  info() { return this.pads.map((p, i) => ({ name: p ? p.name : '', kind: p ? p.kind : '', playing: this.live[i] })); }
  async load(file, slot) {                              // file: {name, bytes}
    slot = clamp(slot | 0 || 1, 1, 4); const nm = file.name, got = [];
    if (endsWithAny(nm, ['.wav', '.mp3', '.m4a', '.ogg'])) {
      let buf; try { buf = await this.eng.snd.ctx.decodeAudioData(file.bytes.slice(0).buffer); } catch (e) { throw new Error('Could not decode that audio file.'); }
      this.stop(slot); this.pads[slot - 1] = { name: baseName(nm).toUpperCase(), kind: 'audio', buffer: buf, file: nm }; got.push(slot);
    } else {
      const bank = readPads(file.bytes, nm, slot, this.eng.settings.shaker), first = bank.length > 1 ? 1 : slot;
      bank.forEach((p, j) => { const n = first + j; if (n > 4) return; this.stop(n); p.file = nm; p.index = j; this.pads[n - 1] = p; got.push(n); });
    }
    this.eng.savePads(); return got.map(n => this.pads[n - 1].name);
  }
  trigger(n, now) {
    const p = this.pads[n - 1];
    if (!p) { this.error = `Pad ${n} is empty: MENU > STYLES > MULTIPAD to load a file.`; return; }
    if (this.live[n - 1]) { this.stop(n); return; }
    this.error = ''; this.live[n - 1] = true;
    const eng = this.eng, sync = eng.sync();
    let clk, q, G;
    if (sync) { clk = sync[0]; q = sync[1]; G = (Math.floor(clk.posAt(now) / q + 1e-6) + 1) * q; }        // start on the style's NEXT beat
    else { const b = clamp(eng.st.bpm, 20, 300); clk = new TempoClock(b, b, now); q = 60 / b; G = clk.posAt(now) + 0.03; }
    this.run[n - 1] = { pad: p, clk, q, G, shared: !!sync, bpmSeen: eng.st.bpm, loop: 0, idx: 0, sched: [], src: null, started: false };
  }
  stop(n) {
    const r = this.run[n - 1];
    if (r) { for (const s of r.sched) s.kill(); if (r.src) { try { r.src.stop(0); } catch (e) { /* ok */ } } this.run[n - 1] = null; }
    this.live[n - 1] = false;
  }
  stopAll() { for (let n = 1; n <= 4; n++) this.stop(n); }
  tick(now) {
    for (let n = 1; n <= 4; n++) {
      const r = this.run[n - 1]; if (!r) continue;
      const eng = this.eng, sync = eng.sync(), lim = now + LOOK;
      if (r.shared && (!sync || sync[0] !== r.clk)) { r.clk = new TempoClock(r.clk.base, clamp(eng.st.bpm, 20, 300), now, r.clk.posAt(now)); r.shared = false; r.bpmSeen = eng.st.bpm; }   // style stopped: carry on
      else if (!r.shared && eng.st.bpm !== r.bpmSeen) { r.bpmSeen = eng.st.bpm; r.clk.setBpm(clamp(eng.st.bpm, 20, 300), now); }
      const p = r.pad;
      if (p.kind === 'audio') {
        if (!r.started) { if (r.clk.real(r.G) > lim) continue; r.src = eng.snd.playBuffer(p.buffer, r.clk.real(r.G), eng.settings.padLoop).src; r.started = true; r.t0 = r.clk.real(r.G);
          if (!eng.settings.padLoop) r.endT = r.t0 + p.buffer.duration; }
        else if (r.endT && now > r.endT + 0.05) this.stop(n);
        continue;
      }
      if (!r.started) { r.started = true; for (const m of p.setup) eng.snd.send(m, r.clk.real(r.G)); }
      const len = p.beats * r.q;
      for (;;) {
        while (r.idx < p.events.length) {
          const [beat, m] = p.events[r.idx], t = r.clk.real(r.G + r.loop * len + beat * r.q);
          if (t > lim) break;
          const h = eng.snd.send(m, t); if (h) r.sched.push(h); r.idx++;
        }
        if (r.idx < p.events.length) break;
        if (r.clk.real(r.G + (r.loop + 1) * len) > lim) break;
        for (let i = 0; i < p.events.length; i++) { const m = p.events[i][1]; if ((m[0] & 0xF0) === 0x90 && m[2] > 0 && (m[0] & 0x0F) !== 9) eng.snd.send([0x80 | (m[0] & 0x0F), m[1], 0], r.clk.real(r.G + (r.loop + 1) * len)); }
        r.idx = 0; r.loop++;
        if (!eng.settings.padLoop) { this.stop(n); break; }
        if (r.sched.length > 100) r.sched = r.sched.filter(h => h.t > now - 1);
      }
    }
  }
}

// ======================= 6. ENGINE + the /api/* calls =======================
class MemStore {                                        // used when IndexedDB is not available (tests)
  constructor() { this.m = {}; }
  async get(s, k) { return (this.m[s] || {})[k]; }
  async put(s, k, v) { (this.m[s] = this.m[s] || {})[k] = v; }
  async del(s, k) { if (this.m[s]) delete this.m[s][k]; }
  async keys(s) { return Object.keys(this.m[s] || {}); }
}
class IdbStore {                                        // phone storage: styles, pad files, SoundFont and settings survive restarts
  constructor() { this.db = null; }
  open() {
    return new Promise(res => {
      const r = indexedDB.open('dxarranger', 1);
      r.onupgradeneeded = () => { for (const s of ['styles', 'pads', 'kv', 'sf2']) r.result.createObjectStore(s); };
      r.onsuccess = () => { this.db = r.result; res(true); }; r.onerror = () => res(false);
    });
  }
  _t(s, mode, fn) { return new Promise((res, rej) => { const t = this.db.transaction(s, mode), q = fn(t.objectStore(s)); t.oncomplete = () => res(q.result); t.onerror = () => rej(t.error); }); }
  get(s, k) { return this._t(s, 'readonly', o => o.get(k)); }
  put(s, k, v) { return this._t(s, 'readwrite', o => o.put(v, k)); }
  del(s, k) { return this._t(s, 'readwrite', o => o.delete(k)); }
  keys(s) { return this._t(s, 'readonly', o => o.getAllKeys()); }
}
const ADD_STYLES = '+ ADD STYLES';
class Engine {
  constructor(o) {
    this.snd = o.sound; this.store = o.store; this.pickFiles = o.pickFiles || (async () => []);
    this.player = new Player(this); this.padsEng = new Pads(this);
    this.settings = { shaker: 0.6, polish: 0.7, padLoop: true, kit: null };
    this.fx = { geq: false, eq3m: false, ezeq: false, studio: false, spring: false, drive: false };
    this.st = { synth: 'webaudio', message: '', error: '', loaded: false, name: '', running: false, section: '', main: 'Main A', intro: null, bpm: 120,
      base_bpm: 120, auto_fill: true, available: [], rev: 0, muted: false, efx: true, path: '', pads: [], pad_error: '', fx: Object.assign({}, this.fx), sf2: '' };
    this.pkg = null; this.styleBytes = null; this.styleName = ''; this.stylePath = ''; this.master = 100;
    this.groups = { 'VOL-1': [8, 9], 'VOL-2': [10], 'VOL-3': [11], 'VOL-4': [12], 'VOL-5': [13], 'VOL-6': [14, 15] };
    this.perc = { 'PERC-1': 38, 'PERC-2': 40, 'PERC-3': 36, 'PERC-4': 45, 'PERC-5': 47, 'PERC-6': 50, 'PERC2-1': 49, 'PERC2-2': 57, 'PERC2-3': 51, 'PERC2-4': 42, 'PERC2-5': 46, 'PERC2-6': 39 };
  }
  now() { return this.snd.ctx.currentTime; }
  set(o) { Object.assign(this.st, o); }
  snapshot() { return Object.assign({}, this.st, { pads: this.padsEng.info(), pad_error: this.padsEng.error, fx: Object.assign({}, this.fx), sf2: this.snd.sfName }); }
  sync() { return this.player.running ? [this.player.clock, this.player.quarter] : null; }
  async init() {
    try {
      const kv = await this.store.get('kv', 'settings'); if (kv) Object.assign(this.settings, kv);
      const fx = await this.store.get('kv', 'fx'); if (fx) Object.assign(this.fx, fx);
      this.snd.setFx(this.fx);
      const sf = await this.store.get('sf2', 'current');
      if (sf) { try { this.snd.loadSF2(sf.data, sf.name); } catch (e) { /* damaged: built-in sounds */ } }
      const pads = await this.store.get('kv', 'pads') || {};
      for (const k of Object.keys(pads)) { const f = await this.store.get('pads', pads[k].file); if (f) { try { await this.padsEng.load({ name: pads[k].file, bytes: new Uint8Array(f) }, Number(k) - (pads[k].index || 0)); } catch (e) { /* skip */ } } }
    } catch (e) { /* storage problems must not stop the app */ }
    this.set({ message: 'Ready. Press a P button, add styles with + ADD STYLES, then press START.' });
  }
  async saveSettings() { try { await this.store.put('kv', 'settings', this.settings); } catch (e) { /* ok */ } }
  async savePads() {
    const o = {}; this.padsEng.pads.forEach((p, i) => { if (p) o[i + 1] = { file: p.file, index: p.index || 0 }; });
    try { await this.store.put('kv', 'pads', o); } catch (e) { /* ok */ }
  }
  // ---- styles ----
  opts() { return { kit: this.settings.kit, polish: this.settings.polish, shaker: this.settings.shaker }; }
  async loadStyle(bytes, name, path) {
    let pkg; try { pkg = prepareStyle(bytes, name, this.opts()); } catch (e) { this.set({ error: String(e.message || e), message: '' }); return false; }
    this.styleBytes = bytes; this.styleName = name; this.stylePath = path || name;
    if (this.player.running) { this.player.command(['swap', pkg], this.now()); this.set({ message: 'Changing style at the next bar...', error: '' }); return true; }
    this.applyPkg(pkg, false); return true;
  }
  applyPkg(pkg, keepTempo) {
    this.pkg = pkg;
    if (keepTempo) this.set({ loaded: true, name: pkg.name, path: this.stylePath, base_bpm: pkg.base, main: pkg.secs[this.st.main] ? this.st.main : pkg.main,
      available: Object.keys(pkg.secs), rev: this.st.rev + 1, message: `Now playing ${pkg.name.toUpperCase()} (same tempo).`, error: '' });
    else this.set({ loaded: true, running: false, name: pkg.name, path: this.stylePath, base_bpm: pkg.base, bpm: pkg.base, main: pkg.main, intro: null,
      available: Object.keys(pkg.secs), section: '', rev: this.st.rev + 1, error: '', message: `Loaded ${pkg.name.toUpperCase()} (${Math.round(pkg.base)} BPM, drums only). Press the start button.` });
  }
  onSwap(pkg) { this.applyPkg(pkg, true); }
  async rebuild() {                                      // shaker / hi-hat settings changed: rebuild the current style
    if (!this.styleBytes) return;
    try { const pkg = prepareStyle(this.styleBytes, this.styleName, this.opts()); if (this.player.running) this.player.command(['swap', pkg], this.now()); else this.applyPkg(pkg, true); } catch (e) { /* keep the old one */ }
  }
  startStyle() {
    if (!this.st.loaded || !this.pkg) { this.set({ error: 'Load a style first (press a P button, choose a file, press ENTER).' }); return; }
    if (this.player.running) return;
    const pkg = this.pkg, intro = this.st.intro ? 'Intro ' + this.st.intro : null, start = intro && pkg.secs[intro] ? intro : this.st.main, now = this.now();
    for (const [, m] of pkg.setup) this.snd.send(m, now);
    this.player.start(pkg, start, this.st.bpm, this.st.main, now);
    this.set({ running: true, error: '', message: '' });
  }
  stopStyle() {
    this.player.stop(this.now()); this.snd.allOff(); this.set({ running: false, section: '', intro: null });
  }
  stopAll() { this.stopStyle(); this.padsEng.stopAll(); }
  tick() {
    const now = this.now();
    try { this.player.tick(now); this.padsEng.tick(now); } catch (e) { this.set({ error: 'Engine: ' + (e.message || e) }); this.player.running = false; this.st.running = false; }
  }
  // ---- commands from the panel ----
  command(op, arg, body) {
    const now = this.now(), st = this.st;
    switch (op) {
      case 'main': case 'intro': case 'ending':
        if (!['A', 'B', 'C', 'D'].includes(arg)) break;
        if (this.player.running) this.player.command([op, arg], now);
        else if (st.loaded && this.pkg.secs[`${op === 'main' ? 'Main' : op === 'intro' ? 'Intro' : 'Ending'} ${arg}`]) {
          if (op === 'main') this.set({ main: 'Main ' + arg }); else if (op === 'intro') this.set({ intro: st.intro === arg ? null : arg });
        }
        break;
      case 'fill': case 'break': if (this.player.running) this.player.command([op], now); break;
      case 'start': this.startStyle(); break;
      case 'stop': this.stopAll(); break;
      case 'tempo': { const v = Number(arg); if (!isFinite(v)) break; if (this.player.running) this.player.command(['tempo', v], now); else this.set({ bpm: clamp(v, 20, 300) }); break; }
      case 'autofill': this.set({ auto_fill: !st.auto_fill }); break;
      case 'master': this.master = clamp(parseInt(arg, 10) || 0, 0, 100); this.snd.setMaster(this.master); break;
      case 'mute': this.set({ muted: !st.muted }); this.snd.setMuted(this.st.muted); break;
      case 'efx': this.set({ efx: !st.efx }); this.snd.setEfx(this.st.efx); break;
      case 'partvol': for (const ch of this.groups[String(arg)] || []) this.snd.setPart(ch, clamp(parseInt(body && body.value, 10) || 0, 0, 100)); break;
      case 'perc': { const n = this.perc[String(arg)]; if (n != null) this.snd.send([0x99, n, 110], now); break; }
      case 'pad': if (['1', '2', '3', '4'].includes(String(arg))) this.padsEng.trigger(Number(arg), now); break;
      case 'padstop': this.padsEng.stopAll(); break;
      case 'fx': return this.toggleFx(String(arg));
      case 'reg_save': { const r = { style: this.stylePath, main: st.main, bpm: st.bpm, auto_fill: st.auto_fill, vols: (body && body.vols) || {}, master: (body && body.master) || 100 }; this.store.put('kv', 'reg' + arg, r); return { ok: true }; }
    }
    return { ok: true };
  }
  async recall(n) {
    const r = await this.store.get('kv', 'reg' + n); if (!r) return { ok: false };
    if (r.style && r.style !== this.stylePath) { const rest = r.style.split('/').slice(1); const b = await this.store.get('styles', r.style); if (b) await this.loadStyle(new Uint8Array(b), rest.join('/') || r.style, r.style); }
    this.command('main', (r.main || 'Main A').slice(-1)); this.command('tempo', r.bpm); this.set({ auto_fill: !!r.auto_fill });
    for (const k of Object.keys(r.vols || {})) this.command('partvol', k, { value: r.vols[k] });
    this.command('master', r.master); return { ok: true, vols: r.vols || {}, master: r.master || 100 };
  }
  toggleFx(id) {
    if (id === 'alloff') for (const k of Object.keys(this.fx)) this.fx[k] = false;
    else if (id in this.fx) { this.fx[id] = !this.fx[id]; if (this.fx[id] && id === 'studio') this.fx.spring = false; if (this.fx[id] && id === 'spring') this.fx.studio = false; }
    this.snd.setFx(this.fx); this.store.put('kv', 'fx', this.fx); return { ok: true, fx: Object.assign({}, this.fx) };
  }
  // ---- sound settings (menu SETTINGS) ----
  async loadSoundFont(file) {
    try {
      const buf = await file.arrayBuffer(); this.snd.loadSF2(buf, baseName(file.name).toUpperCase());
      await this.store.put('sf2', 'current', { name: this.snd.sfName, data: buf });
      this.set({ message: this.snd.sf.hasDrums() ? `SoundFont ${this.snd.sfName} loaded.` : `SoundFont ${this.snd.sfName} has no drum kit: built-in drums are used.`, error: '' });
    } catch (e) { this.set({ error: 'SoundFont: ' + (e.message || e) }); }
  }
  async clearSoundFont() { this.snd.clearSF2(); try { await this.store.del('sf2', 'current'); } catch (e) { /* ok */ } this.set({ message: 'Using the built-in sounds.' }); }
  // ---- the /api/* calls ----
  async api(method, path, query, body) {
    const J = (json, status) => ({ json, status: status || 200 });
    if (path === '/api/state') return J(this.snapshot());
    if (path === '/api/folder') {
      const slot = parseInt(query.get('slot') || '0', 10) || 0;
      if (slot < 1 || slot > 16) return J({ error: 'slot must be 1-16' }, 400);
      const keys = (await this.store.keys('styles')).filter(k => k.startsWith(slot + '/')).map(k => k.slice(String(slot).length + 1)).sort((a, b) => lower(a) < lower(b) ? -1 : 1);
      const files = [ADD_STYLES].concat(keys);
      return J({ slot, path: 'P' + slot + ' on this phone', folder_name: 'P' + slot, files, labels: files.map(f => f === ADD_STYLES ? ADD_STYLES : baseName(f).toUpperCase()) });
    }
    if (path === '/api/padfolder') {
      const files = (await this.store.keys('pads')).sort((a, b) => lower(a) < lower(b) ? -1 : 1);
      return J({ path: 'Multipad (stored on this phone)', files, pads: this.padsEng.info(), labels: files.map(f => baseName(f).toUpperCase()) });
    }
    if (path === '/api/load' && method === 'POST') {
      const slot = parseInt(body && body.slot, 10) || 0, name = String((body && body.name) || '');
      if (name === ADD_STYLES) {                          // must run inside the tap that opened it (a file chooser needs that)
        const p = this.pickFiles(); p.then(async files => { let first = null; for (const f of files) { if (!endsWithAny(f.name, STYLE_EXTS)) continue; const key = slot + '/' + f.name; await this.store.put('styles', key, await f.arrayBuffer()); first = first || key; }
          if (first) { const b = await this.store.get('styles', first); await this.loadStyle(new Uint8Array(b), first.slice(String(slot).length + 1), first); } else if (files.length) this.set({ error: 'Choose a style file (.STY).' }); });
        return J({ ok: true });
      }
      const key = slot + '/' + name, b = await this.store.get('styles', key);
      if (!b) return J({ error: 'file not found' }, 404);
      await this.loadStyle(new Uint8Array(b), name, key); return J({ ok: true });
    }
    if (path === '/api/upload' && method === 'POST') {    // INBUILT import from the panel: stored in folder 0 and loaded at once
      const name = query.get('name') || 'style.sty', buf = await body.arrayBuffer();
      if (!endsWithAny(name, STYLE_EXTS) || !buf.byteLength || buf.byteLength > 5e6) return J({ error: 'send a .STY file under 5 MB' }, 400);
      await this.store.put('styles', '0/' + name, buf); await this.loadStyle(new Uint8Array(buf), name, '0/' + name); return J({ ok: true, file: name });
    }
    if (path === '/api/padupload' && method === 'POST') {
      const name = query.get('name') || '', buf = await body.arrayBuffer();
      if (!endsWithAny(name, PAD_EXTS) || !buf.byteLength || buf.byteLength > 60e6) return J({ error: 'send a .wav .mp3 .pad .mid file under 60 MB' }, 400);
      await this.store.put('pads', name, buf); return J({ ok: true, file: name });
    }
    if (path === '/api/padload' && method === 'POST') {
      const name = String((body && body.name) || ''), buf = await this.store.get('pads', name);
      if (!buf) return J({ ok: false, error: 'file not found in the Multipad folder' }, 400);
      try { const names = await this.padsEng.load({ name, bytes: new Uint8Array(buf) }, body.slot || 1); return J({ ok: true, names, pads: this.padsEng.info() }); }
      catch (e) { return J({ ok: false, error: String(e.message || e) }, 400); }
    }
    if (path === '/api/setfolder') return J({ ok: false, error: 'folders are inside the app on the phone' });
    if (path === '/api/cmd' && method === 'POST') {
      if (body && body.op === 'reg_recall') return J(await this.recall(body.arg));
      const r = this.command(body && body.op, body && body.arg, body); return J(r || { ok: true });
    }
    return J({ error: 'not found' }, 404);
  }
}

// ======================= 7. BOOT (browser / Android only) =======================
root.DX = { Engine, Sound, SF2, Player, Pads, MemStore, IdbStore, TempoClock, prepareStyle, readSMF, parseTrack, findSections, build, groupEvents, polishVelocity, readPads, compilePad, FX_IDS };
if (typeof window !== 'undefined' && typeof document !== 'undefined' && !root.__DX_NO_BOOT) boot();

function boot() {
  root.DX_LOCAL = true;                                   // bridge.js: "this is the phone build"
  const AC = root.AudioContext || root.webkitAudioContext, ctx = new AC({ latencyHint: 'interactive' });
  const unlock = () => { if (ctx.state !== 'running') ctx.resume(); try { if (navigator.wakeLock && !boot.lock) navigator.wakeLock.request('screen').then(l => { boot.lock = l; }).catch(() => {}); } catch (e) { /* ok */ } };
  ['pointerdown', 'touchend', 'click', 'keydown'].forEach(e => document.addEventListener(e, unlock, true));
  const pickFiles = () => new Promise(res => {
    const i = document.createElement('input'); i.type = 'file'; i.multiple = true; i.style.display = 'none'; document.body.appendChild(i);
    i.addEventListener('change', () => { res(Array.from(i.files)); i.remove(); }); i.click();
  });
  const store = typeof indexedDB !== 'undefined' ? new IdbStore() : new MemStore();
  const engine = new Engine({ sound: new Sound(ctx), store, pickFiles });
  root.DX.engine = engine;
  const ready = (async () => { if (store.open && !(await store.open())) engine.store = new MemStore(); await engine.init(); })();
  setInterval(() => engine.tick(), 10);
  const origFetch = root.fetch.bind(root);
  root.fetch = async (input, init) => {                   // the panel talks to this engine instead of a server
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('/api/')) return origFetch(input, init);
    await ready;
    const u = new URL(url, 'http://x'), method = (init && init.method) || 'GET'; let body = init && init.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const r = await engine.api(method, u.pathname, u.searchParams, body);
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  };
  window.addEventListener('load', () => {                 // MENU > SETTINGS: SoundFont and sound feel
    if (typeof menuPages === 'undefined' || Object.getOwnPropertyDescriptor(menuPages, 'settings')) return;
    const esc = s => String(s).replace(/[<&]/g, ' ');
    Object.defineProperty(menuPages, 'settings', { configurable: true, enumerable: true, get() {
      const s = engine.settings;
      return ['SOUNDFONT: ' + esc(engine.snd.sfName || 'BUILT-IN'), 'LOAD SOUNDFONT (.SF2)', 'USE BUILT-IN SOUNDS', 'SHAKER LEVEL: ' + Math.round(s.shaker * 100) + '%',
        'HI-HAT FEEL: ' + (s.polish > 0 ? 'ON' : 'OFF'), 'PAD LOOP: ' + (s.padLoop ? 'ON' : 'OFF')];
    } });
    const prev = window.openSelectedMenu;
    window.openSelectedMenu = function () {
      if (menuPage === 'root' && menuIndex === 1) { menuPage = 'settings'; menuIndex = 0; renderLcdMenu(); return; }
      if (menuPage === 'settings') { settingsAction(menuIndex); return; }
      return prev.apply(this, arguments);
    };
    let from = '';
    document.addEventListener('click', ev => { if (ev.target.closest('[data-id="NAV-LEFT"]')) from = menuPage; }, true);
    document.addEventListener('click', ev => { if (ev.target.closest('[data-id="NAV-LEFT"]') && from === 'settings' && menuPage === 'root') { menuIndex = 1; renderLcdMenu(); } });
    async function settingsAction(i) {
      const s = engine.settings;
      if (i === 1) { const f = await pickFiles(); if (f[0]) await engine.loadSoundFont(f[0]); }
      else if (i === 2) await engine.clearSoundFont();
      else if (i === 3) { const L = [1, 0.8, 0.6, 0.4, 0.2], k = L.findIndex(v => Math.abs(v - s.shaker) < 0.01); s.shaker = L[(k + 1) % L.length]; await engine.saveSettings(); engine.rebuild(); engine.padsEng.pads.forEach(p => { if (p && p.kind === 'midi') engine.set({ message: 'Reload pad files to apply the new shaker level.' }); }); }
      else if (i === 4) { s.polish = s.polish > 0 ? 0 : 0.7; await engine.saveSettings(); engine.rebuild(); }
      else if (i === 5) { s.padLoop = !s.padLoop; await engine.saveSettings(); }
      renderLcdMenu();
    }
  });
}
})(typeof window !== 'undefined' ? window : globalThis);
