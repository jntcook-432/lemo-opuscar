#!/usr/bin/env node
/* Assemble a finished film from rendered clips — the cut/edit stage.
 *
 *   node core/edit/assemble.mjs <edit.json> [--out out.mp4] [--dry-run]
 *
 * edit.json (all times in seconds, relative to each source file):
 * {
 *   "fps": 24, "size": "1920x1080", "grain": 1,
 *   "clips": [
 *     {"src": "out/scene1.mp4", "in": 0.5, "out": 3.0},
 *     {"src": "out/scene2.mp4", "in": 1.0, "out": 3.5,
 *      "transition": {"type": "fade", "dur": 0.5}}
 *   ],
 *   "audio":  [ {"src": "mix.wav", "at": 0.0, "gain": 1.0, "fadeIn": 0.2, "fadeOut": 0.8} ],
 *   "captions": [ {"t0": 0.2, "t1": 2.0, "text": "…"} ],
 *   "srt": "out/subs.srt"
 * }
 *
 * Semantics:
 *   · clips play in order; "in"/"out" trim within the source ("out" exclusive; dur = out − in > 0)
 *   · "transition" on a clip = how it joins the PREVIOUS material (x fading INTO it);
 *     no transition = a straight cut. Any ffmpeg xfade transition name works (fade, wipeleft, dissolve…)
 *   · total length = Σ clip dur − Σ transition dur (printed as a timeline table before rendering)
 *   · audio entries are placed at "at" on the OUTPUT timeline (independent of clips), gain ×, with
 *     optional fades; several entries mix. Audio shorter than the picture is padded by mux.sh, longer is cut
 *   · captions become an .srt next to the output ("srt" path, default out/<name>.srt), matching srt.py's format
 *   · the master step is core/render/mux.sh: two-pass loudnorm to −14 LUFS / TP −1.2 + film grain —
 *     identical numbers to a single-timeline film, so a cut film and a rendered film match
 *
 * Every failure exits non-zero before writing the output; nothing partial is left behind.
 * LEMO_EDIT_DEBUG=1 keeps the intermediate files in <out-dir>/assemble-work/.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const die = (m) => { console.error(`assemble.mjs: ${m}`); process.exit(1); };
const run = (cmd, args, opts = {}) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', ...opts }); }
  catch (e) { die(`${cmd} failed: ${(e.stderr || e.stdout || e.message).toString().split('\n').filter(Boolean).slice(-4).join('\n')}`); }
};
const probe = (f, entry) => run('ffprobe', ['-v', 'error', '-show_entries', entry, '-of', 'csv=p=0', f]).trim().split('\n')[0];

const argv = process.argv.slice(2);
const outArg = (() => { const i = argv.indexOf('--out'); return i >= 0 ? argv[i + 1] : null; })();
const dry = argv.includes('--dry-run');
const editPath = argv.find((a, i) => a !== '--out' && a !== '--dry-run' && argv[i - 1] !== '--out') || die('usage: node core/edit/assemble.mjs <edit.json> [--out out.mp4] [--dry-run]');
if (!fs.existsSync(editPath)) die(`edit list not found: ${editPath}`);

const E = JSON.parse(fs.readFileSync(editPath, 'utf8'));
const FPS = Number(E.fps) > 0 ? Number(E.fps) : 24;
const GRAIN = E.grain == null ? 1 : Number(E.grain);
const [W, H] = String(E.size || '1920x1080').split('x').map(Number);
if (!W || !H || W % 2 || H % 2) die(`bad "size" (${E.size}): need WxH, both even`);
if (!Array.isArray(E.clips) || !E.clips.length) die('"clips" must be a non-empty array');
if (E.clips[0].transition) die('the FIRST clip cannot carry a transition (nothing to join onto)');

const base = path.basename(outArg || 'final.mp4', '.mp4');
const outDir = path.dirname(path.resolve(outArg || 'out/final.mp4'));
const work = path.join(outDir, 'assemble-work');
if (!dry) fs.mkdirSync(work, { recursive: true });

/* ── plan: validate clips, build the timeline table ── */
let cursor = 0;                       // length of the composite so far
const timeline = [];
E.clips.forEach((c, i) => {
  if (!fs.existsSync(c.src)) die(`clip ${i + 1}: source not found: ${c.src}`);
  const din = Number(c.in) || 0, dout = Number(c.out) || 0;
  const d = dout - din;
  if (!(d > 0)) die(`clip ${i + 1} (${c.src}): "out" must be greater than "in" (got ${din} → ${dout})`);
  const srcDur = Number(probe(c.src, 'format=duration'));
  if (!(srcDur > 0)) die(`clip ${i + 1}: cannot read duration of ${c.src} (is it a video?)`);
  if (dout > srcDur + 0.05) die(`clip ${i + 1}: out=${dout} is beyond the end of ${c.src} (${srcDur.toFixed(2)} s)`);
  const tr = c.transition && { type: String(c.transition.type || 'fade'), dur: Number(c.transition.dur) || 0.5 };
  if (tr && (i === 0 || !(tr.dur > 0))) die(`clip ${i + 1}: a transition needs a positive "dur" and cannot be on the first clip`);
  if (tr && tr.dur >= cursor) die(`clip ${i + 1}: transition ${tr.dur} s is longer than the material before it (${cursor.toFixed(2)} s)`);
  const start = tr ? cursor - tr.dur : cursor;
  cursor = tr ? start + d : cursor + d;
  timeline.push({ n: i + 1, src: c.src, in: din, out: dout, dur: d, tr });
});

const total = cursor;
console.log('  #  in → out      dur   transition      source');
timeline.forEach(t => console.log(
  `${String(t.n).padStart(3)}  ${t.in.toFixed(2)} → ${t.out.toFixed(2)}  ${t.dur.toFixed(2)}s  ` +
  `${t.tr ? `${t.tr.type} ${t.tr.dur}s` : 'cut'}  ${t.src}`));
console.log(`total: ${total.toFixed(2)} s · ${FPS} fps · ${W}x${H} · grain ${GRAIN}`);
if (dry) { console.log('(dry run — nothing rendered)'); process.exit(0); }

/* ── video: normalize every clip, then join with xfade (transition) or concat (cut) ── */
const args = ['-y', '-loglevel', 'error'];
E.clips.forEach(c => args.push('-i', c.src));
const f = [], n = E.clips.length;
E.clips.forEach((c, i) => {
  const { in: din, out: dout } = E.clips[i];
  f.push(`[${i}:v]trim=start=${din}:end=${dout},setpts=PTS-STARTPTS,` +
    `scale=${W}:${H},setsar=1,fps=${FPS},format=yuv420p[v${i}]`);
});
let vx = 'v0';
for (let i = 1; i < n; i++) {
  const t = timeline[i].tr;
  if (t) {
    const offset = (cursorOf(i) - t.dur).toFixed(3);
    f.push(`[${vx}][v${i}]xfade=transition=${t.type}:duration=${t.dur.toFixed(3)}:offset=${offset}[x${i}]`);
    vx = `x${i}`;
  } else {
    f.push(`[${vx}][v${i}]concat=n=2:v=1:a=0[x${i}]`);
    vx = `x${i}`;
  }
}
function cursorOf(i) {                 // composite length after joining clips 0..i-1
  let s = timeline[0].dur;
  for (let k = 1; k <= i - 1; k++) s += timeline[k].tr ? -timeline[k].tr.dur : 0, s += timeline[k].dur;
  return s;
}
f.push(`[${vx}]trim=end=${total.toFixed(3)},setpts=PTS-STARTPTS[vout]`);

/* ── audio: place each entry on the output timeline, then mix ── */
const A = Array.isArray(E.audio) ? E.audio : [];
if (!A.length) console.log('assemble.mjs: no "audio" — a silent track is mixed (mux.sh will warn; that is expected here)');
A.forEach((a, i) => {
  if (!fs.existsSync(a.src)) die(`audio ${i + 1}: source not found: ${a.src}`);
  const idx = n + i;
  args.push('-i', a.src);
  const adur = Number(probe(a.src, 'format=duration'));
  let chain = `[${idx}:a]aresample=48000,aformat=channel_layouts=mono`;
  const g = a.gain == null ? 1 : Number(a.gain);
  if (g !== 1) chain += `,volume=${g}`;
  const at = Number(a.at) || 0;
  chain += `,adelay=${Math.round(at * 1000)}:all=1`;
  if (Number(a.fadeIn) > 0) chain += `,afade=t=in:st=${at.toFixed(3)}:d=${Number(a.fadeIn)}`;
  if (Number(a.fadeOut) > 0) {
    const st = Math.max(0, at + adur - Number(a.fadeOut));
    chain += `,afade=t=out:st=${st.toFixed(3)}:d=${Number(a.fadeOut)}`;
  }
  chain += `[a${i}]`;
  f.push(chain);
});
if (A.length) f.push(`${A.map((_, i) => `[a${i}]`).join('')}amix=inputs=${A.length}:normalize=0,` +
  /* apad ต้องมี whole_dur เสมอ — apad เปล่า ๆ pad ไม่รู้จบ ฟิล์มไม่มีวันเขียนจบ (เจอจริงตอนทดสอบ 28 ต.ค. 2569) */
  `apad=whole_dur=${total.toFixed(3)}[aout]`);

const silent = !A.length;
const videoOnly = path.join(work, 'video-cut.mp4');
const mixWav = path.join(work, 'mix.wav');
args.push('-filter_complex', f.join(';'), '-map', '[vout]',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-r', String(FPS), videoOnly);
if (A.length) {   // the mix goes to its own WAV (mp4 cannot hold PCM) — mux.sh masters it next
  args.push('-map', '[aout]', '-c:a', 'pcm_f32le', mixWav);
} else {          // no audio entries: mix silence now, mux.sh still gets a real track
  run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi',
    '-i', `anullsrc=r=48000:cl=mono:d=${total.toFixed(3)}`, mixWav]);
}
run('ffmpeg', args);

/* ── captions → .srt (same millisecond rounding as core/render/srt.py) ── */
if (Array.isArray(E.captions) && E.captions.length) {
  const cues = [...E.captions].sort((a, b) => a.t0 - b.t0);
  for (let k = 0; k < cues.length - 1; k++) cues[k].t1 = Math.min(cues[k].t1, cues[k + 1].t0);
  const fmt = (s) => { const ms = Math.round(Math.max(0, s) * 1000);
    return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
  const srtPath = E.srt || path.join(outDir, `${base}.srt`);
  fs.mkdirSync(path.dirname(path.resolve(srtPath)), { recursive: true });
  fs.writeFileSync(srtPath, cues.map((c, k) => `${k + 1}\n${fmt(c.t0)} --> ${fmt(c.t1)}\n${c.text}\n`).join('\n'));
  console.log(`srt: ${srtPath} (${cues.length} cues)`);
}

/* ── master through mux.sh — the same loudnorm/grain as every film in the library ── */
const OUT = outArg || path.join('out', 'final.mp4');
fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
run('sh', ['core/render/mux.sh', videoOnly, mixWav, OUT, String(FPS), String(GRAIN)], { stdio: 'inherit' });
console.log(`assembled: ${OUT} (${total.toFixed(2)} s from ${n} clips)`);
if (process.env.LEMO_EDIT_DEBUG !== '1') fs.rmSync(work, { recursive: true, force: true });
