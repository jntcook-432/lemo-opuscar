"""Dead-air removal — tighten a talking video by cutting silences:
    .venv/bin/python core/clips/tighten.py <input.mp4> [--noise -35dB] [--min 0.6] [--pad 0.15]
                                               [--out tightened.mp4] [--ranges out.json]
Idea from kleZ799/clipmint autoedit.py (MIT): a pause longer than the threshold is dead
air; everything else (breaths, short beats) is left alone so the cut never feels chopped.

Writes the tightened video (one-pass trim/concat re-encode) and, with --ranges, the kept
ranges as JSON (assembled.mjs-style: [{"start":…, "end":…}]) so an edit list can be reused.
"""
import sys, os, json, subprocess, argparse

def die(m): print(f'tighten.py: {m}', file=sys.stderr); sys.exit(1)

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument('input')
ap.add_argument('--noise', default='-35dB')
ap.add_argument('--min', dest='mind', type=float, default=0.6)
ap.add_argument('--pad', type=float, default=0.15, help='seconds of silence kept at each side of a cut')
ap.add_argument('--out', default='tightened.mp4')
ap.add_argument('--ranges')
a = ap.parse_args()
if not os.path.exists(a.input): die(f'input not found: {a.input}')

# ── ตรวจจับความเงียบ (silencedetect) → ช่วงเงียบทั้งหมด ──
r = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', a.input,
                    '-af', f'silencedetect=noise={a.noise}:d={a.mind}', '-f', 'null', '-'],
                   capture_output=True, text=True)
sil, last_start = [], None
for line in r.stderr.splitlines():
    if 'silence_start:' in line:
        last_start = float(line.split('silence_start:')[1].split()[0])
    elif 'silence_end:' in line and last_start is not None:
        sil.append((last_start, float(line.split('silence_end:')[1].split()[0]))); last_start = None
if last_start is not None: sil.append((last_start, 10 ** 9))   # เงียบจบหางไฟล์

# ── ช่วงที่เก็บ = ทั้งหมดลบความเงียบ (เผื่อ pad ท้ายหัว) แล้วรวมช่วงชิดกัน ──
dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                            '-of', 'csv=p=0', a.input], capture_output=True, text=True).stdout)
keeps, cur = [], 0.0
for s, e in sil:
    s2, e2 = max(0.0, s + a.pad), min(dur, e - a.pad)
    if e2 <= s2: continue
    if s2 > cur: keeps.append([cur, s2])
    cur = max(cur, e2)
if cur < dur: keeps.append([cur, dur])
kept = sum(e - s for s, e in keeps)
if len(keeps) == 0: die('the whole input is silent under the current threshold')
print(f'silences {len(sil)} · kept {len(keeps)} ranges · {kept:.2f} s of {dur:.2f} s (cut {dur - kept:.2f} s)')
if a.ranges: json.dump([{'start': round(s, 3), 'end': round(e, 3)} for s, e in keeps], open(a.ranges, 'w'), indent=1)

# ── ตัดจริง: trim/concat รอบเดียว (เฟรมแม่นเพราะ re-encode ทั้งสาย) ──
f, inputs = [], ''
for k, (s, e) in enumerate(keeps):
    f.append(f'[0:v]trim=start={s:.3f}:end={e:.3f},setpts=PTS-STARTPTS[v{k}];'
             f'[0:a]atrim=start={s:.3f}:end={e:.3f},asetpts=PTS-STARTPTS[a{k}]')
    inputs += f'[v{k}][a{k}]'
f.append(f'{inputs}concat=n={len(keeps)}:v=1:a=1[v][a]')
p = subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', a.input,
                    '-filter_complex', ';'.join(f), '-map', '[v]', '-map', '[a]',
                    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
                    '-c:a', 'aac', '-b:a', '192k', a.out])
if p.returncode != 0: die('ffmpeg failed while writing the tightened video')
d = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', a.out],
                   capture_output=True, text=True).stdout.strip()
print(f'tightened: {a.out} ({d} s)')
