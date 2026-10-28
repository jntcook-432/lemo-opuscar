#!/usr/bin/env node
/* Auto-split a finished film into equal parts, cut on REAL frame boundaries.
 *   node core/edit/split.mjs <input.mp4> <parts|seconds-per-part> [--out dir] [--dry-run]
 *
 * Idea and frame-grid logic adapted from tanmoymondal1312/auto-cut (MIT, CutEngine.kt):
 * probe every frame's pts once, then each cut point snaps to the FIRST REAL FRAME at or
 * after the nominal time — parts join with no duplicated and no dropped frames, so every
 * part plays back clean (this is what raw `-ss` seconds cutting gets wrong).
 *
 * Parts are re-encoded (libx264 crf 18) so any cut point is exact; a parts job may run
 * several segments in parallel. Prints a table of the parts before rendering; --dry-run
 * prints only. Output: <out>/<input-name>.part<k>of<n>.mp4
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const die = (m) => { console.error(`split.mjs: ${m}`); process.exit(1); };
const run = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28 }); }
  catch (e) { die(`${cmd} failed: ${(e.stderr || e.message).toString().split('\n').filter(Boolean).slice(-3).join('\n')}`); }
};

const argv = process.argv.slice(2);
let src = null, spec = null, outDir = null, dry = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out') { outDir = argv[++i]; if (outDir == null) die('--out needs a directory'); }
  else if (a.startsWith('--out=')) outDir = a.slice(5) || die('--out needs a directory');
  else if (a === '--dry-run') dry = true;
  else if (src == null) src = a;
  else if (spec == null) spec = a;
  else die(`unexpected argument: ${a}`);
}
if (!src || !spec) die('usage: node core/edit/split.mjs <input.mp4> <parts|seconds-per-part> [--out dir] [--dry-run]');
if (!fs.existsSync(src)) die(`input not found: ${src}`);

const dur = Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src]));
if (!(dur > 0)) die(`cannot read duration of ${src}`);

/* ── จำนวนส่วน / ความยาวต่อส่วน ── */
let parts;
const specN = Number(spec);
if (Number.isInteger(specN) && specN >= 2) parts = specN;                                   // "4" = 4 ส่วน
else if (specN > 0) parts = Math.max(2, Math.round(dur / specN));                           // "7.5" = 7.5 วินาที/ส่วน
else die('spec must be a parts count (integer ≥2) or seconds-per-part (number ≥1)');

/* ── frame index: pts (วินาที) ของทุกเฟรม — หัวใจยืมจาก auto-cut CutEngine.kt ── */
const pts = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time',
  '-of', 'csv=p=0', src]).split('\n').map(s => parseFloat(s)).filter(n => isFinite(n) && n >= 0).sort((a, b) => a - b);
if (pts.length < parts) die(`only ${pts.length} frames readable — cannot cut ${parts} parts`);
const firstFrameAt = (sec) => {                        // binary search: เฟรมจริงเฟรมแรกที่ ≥ sec (auto-cut: firstFrameUsAt)
  let lo = 0, hi = pts.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (pts[mid] < sec) lo = mid + 1; else hi = mid; }
  return pts[lo];
};

/* ── จุดตัด: แบ่งเท่า ๆ กันแล้ว snap หาเฟรมจริง · กันขอบซ้อน/หายแบบ planRange (ถ้า snap ชนกัน ลดจำนวนส่วน) ── */
let bounds;
while (true) {
  bounds = [0];
  let ok = true;
  for (let k = 1; k < parts; k++) {
    const b = firstFrameAt(dur * k / parts);
    if (b <= bounds[k - 1]) { ok = false; break; }
    bounds.push(b);
  }
  if (ok) { bounds.push(dur); break; }
  parts--;                                              // ส่วนสั้นเกินไปสำหรับความละเอียดเฟรม — ลดลงทีละส่วน
  if (parts < 2) die('the video is too short to split on real frames');
}

const name = path.basename(src, path.extname(src));
outDir = outDir || path.dirname(src);
console.log(`  part  start → end      dur    file`);
const list = [];
for (let k = 0; k < parts; k++) {
  const a = bounds[k], b = bounds[k + 1];
  const f = path.join(outDir, `${name}.part${k + 1}of${parts}.mp4`);
  list.push({ a, b, f });
  console.log(`  ${String(k + 1).padStart(2)}   ${a.toFixed(3)} → ${b.toFixed(3)}  ${(b - a).toFixed(2)}s  ${path.basename(f)}`);
}
console.log(`${parts} parts · ${pts.length} frames indexed · source ${dur.toFixed(2)} s`);
if (dry) { console.log('(dry run — nothing rendered)'); process.exit(0); }
fs.mkdirSync(outDir, { recursive: true });

/* ── ตัดจริง: แบ่งเป็นคิวขนาน 3 งาน (สไตล์ worker ของ auto-cut) — re-encode crf 18 ให้ตัดตรงเฟรมได้ทุกจุด ── */
const WORKERS = Math.min(3, parts);
let next = 0, fail = null;
function worker(id) {
  while (!fail) {
    const job = list[next++]; if (!job) return;
    run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', job.a.toFixed(6), '-i', src,
      '-t', (job.b - job.a).toFixed(6), '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
      '-c:a', 'aac', '-b:a', '192k', job.f]);
    const d = Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', job.f]));
    if (Math.abs(d - (job.b - job.a)) > 0.15) { fail = `part ${path.basename(job.f)} came out ${d.toFixed(2)} s (expected ${(job.b - job.a).toFixed(2)})`; return; }
    console.log(`  w${id} ✓ ${path.basename(job.f)}`);
  }
}
if (!dry) {
  await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i + 1)));
  if (fail) die(`${fail} (other finished parts are left in place)`);
}
