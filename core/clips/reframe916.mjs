#!/usr/bin/env node
/* Reframe a landscape video to 9:16 vertical (Shorts/Reels/TikTok):
 *   node core/clips/reframe916.mjs <input.mp4> [--out out.mp4] [--pos 0.5] [--width 1080]
 * --pos is the crop window as a fraction of its travel — 0 flush left, 1 flush right,
 * 0.5 centred (the same convention as clipmint framing.py: it means the same thing at any
 * resolution and survives later re-renders). Audio and captions (burned ones) are kept.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const die = (m) => { console.error(`reframe916.mjs: ${m}`); process.exit(1); };
const argv = process.argv.slice(2);
let src = null, out = null, pos = 0.5, width = 1080;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out') out = argv[++i];
  else if (a.startsWith('--out=')) out = a.slice(5);
  else if (a === '--pos') pos = Number(argv[++i]);
  else if (a.startsWith('--pos=')) pos = Number(a.slice(5));
  else if (a === '--width') width = Number(argv[++i]);
  else if (src == null) src = a;
  else die(`unexpected argument: ${a}`);
}
if (!src || !fs.existsSync(src)) die('usage: node core/clips/reframe916.mjs <input.mp4> [--out out.mp4] [--pos 0..1] [--width 1080]');
if (!(pos >= 0 && pos <= 1)) die('--pos must be a fraction 0..1 (0 = flush left, 1 = flush right)');
if (!(width >= 2 && width % 2 === 0)) die('--width must be an even number');
const height = Math.round(width * 16 / 9 / 2) * 2;

const probe = (f) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim().split('\n')[0];
const [iw, ih] = probe(src).split(',').map(Number);
if (!iw || !ih) die(`cannot read the video size of ${src}`);

const cropW = Math.min(iw, Math.round(ih * 9 / 16 / 2) * 2);
if (cropW >= iw) die('the source is already vertical (9:16 or narrower) — nothing to crop');
const X = Math.round((iw - cropW) * Math.min(1, Math.max(0, pos)));
const Xe = X - (X % 2);
out = out || path.join(path.dirname(src), path.basename(src, path.extname(src)) + '.916.mp4');
console.log(`${iw}x${ih} → ${width}x${height} · crop ${cropW}px window at x=${Xe} (pos ${pos})`);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src,
  '-vf', `crop=${cropW}:${ih}:${Xe}:0,scale=${width}:${height},setsar=1`,
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-c:a', 'copy', out], { stdio: 'inherit' });
console.log(`reframed: ${out}`);
