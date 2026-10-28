"""Word-level captions from faster-whisper, ClipMint-style:
    .venv/bin/python core/clips/wordsrt.py <media> [--lang th|en|auto] [--model small]
        [--words 4] [--pause 0.6] [--out cues.json] [--srt out.srt] [--voice-dir reuse/]
Transcribes with word timestamps (faster-whisper, already in the voice tier), then groups
words into caption cues the way clipmint captions.py does: N words per cue, and a pause
longer than --pause between two words starts a new cue — so a line breaks where the
speaker actually breathed.

Outputs:
  cues.json  = [{"t0":…, "t1":…, "text":"…"}] — feed straight into assemble.mjs
               ("captions" + "burn": true) to burn them in with the PNG overlay burner.
  --srt      = the same cues as a plain .srt for platforms.
--voice-dir DIR: skip transcription, reuse words.json written by asr_check.py earlier.
"""
import sys, os, json, subprocess, argparse

def die(m): print(f'wordsrt.py: {m}', file=sys.stderr); sys.exit(1)

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument('media')
ap.add_argument('--lang', default='auto', help='th|en|auto (auto: Thai block → th, else en; pass --lang for whisper language hint)')
ap.add_argument('--model', default=None, help='whisper model (default: en→base.en, th→small, en-fallback→base)')
ap.add_argument('--words', type=int, default=4, help='words per caption cue')
ap.add_argument('--pause', type=float, default=0.6, help='gap that starts a new cue')
ap.add_argument('--out', default='cues.json')
ap.add_argument('--srt')
ap.add_argument('--voice-dir', help='reuse words.json from asr_check.py instead of transcribing')
ap.add_argument('--only', help='voice-dir mode: process only this line id (words.json เวลาเป็นของแต่ละไฟล์ — เลือกเส้นเดียว, หรือใช้ --offset กับหลายเส้น)')
ap.add_argument('--offset', type=float, default=0.0, help='voice-dir mode: shift every time by this many seconds (บรรทัดที่สองต่อจากบรรทัดแรก ให้ส่งความยาวบรรทัดแรก)')
a = ap.parse_args()
if not os.path.exists(a.media) and not a.voice_dir: die(f'media not found: {a.media}')

def fmt(s):
    ms = int(round(max(0, s) * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"

words = []
if a.voice_dir:
    wj = os.path.join(a.voice_dir, 'words.json')
    if not os.path.exists(wj): die(f'{wj} not found — run asr_check.py first (it writes words.json)')
    data = json.load(open(wj, encoding='utf-8'))
    import unicodedata
    char_mode = False
    if isinstance(data, dict):
        # asr_check ไทย: {line_id: [[อักขระ, t0, t1], …]} — ยกมาเป็นหน่วยระดับอักขระ (ไทยไม่เว้นคำ)
        # สระ/วรรณยุกต์ (Mn) เกาะอักขระก่อนหน้า ไม่กินเวลา · cue จะถูกตัดด้วยความยาวตัวอักษรแทนจำนวนคำ
        char_mode = True
        ids = sorted(data) if not a.only else [a.only] if a.only in data else die(f'line id "{a.only}" not in words.json ({", ".join(sorted(data))})')
        for lid in ids:
            for ch, t0, t1 in data[lid]:
                if ch.strip() == '': continue
                t0, t1 = float(t0) + a.offset, float(t1) + a.offset
                mark = len(ch) == 1 and unicodedata.category(ch).startswith('M')
                if mark and words:                       # สระ/วรรณยุกต์เกาะอักขระก่อนหน้า ไม่กินเวลา
                    words[-1]['w'] += ch
                    words[-1]['t1'] = max(words[-1]['t1'], t1)
                else:
                    words.append({'w': ch, 't0': t0, 't1': max(t1, t0)})
    else:
        for line in data:
            words.append({'w': line.get('word', '').strip(), 't0': float(line['start']), 't1': float(line['end'])})
else:
    wav = a.voice_dir or (a.media + '.16k.wav')
    if not a.voice_dir:
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', a.media,
                        '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], check=True)
    try: from faster_whisper import WhisperModel
    except ImportError: die('faster-whisper is missing: install the voice tier (setup.sh deps voice)')
    lang = None if a.lang == 'auto' else a.lang
    model_name = a.model or {'en': 'base.en', 'th': 'small'}.get(a.lang, 'base')
    print(f'wordsrt.py: transcribing ({model_name}, lang={lang or "auto"})…', file=sys.stderr)
    model = WhisperModel(model_name, device='cpu', compute_type='int8')
    segments, _ = model.transcribe(wav, language=lang, word_timestamps=True, vad_filter=True)
    for seg in segments:
        for w in (seg.words or []):
            t = w.word.strip()
            if t: words.append({'w': t, 't0': float(w.start), 't1': float(w.end)})
    if not a.voice_dir and os.path.exists(wav) and wav.endswith('.16k.wav'): os.remove(wav)
if not words: die('no words transcribed')

# ── จับกลุ่มเป็น cue: N หน่วย/cue · หยุดยาวเกิน --pause = เริ่มคิวใหม่ · char_mode ตัดที่ ~24 ตัวอักษร ──
cues, cur = [], [words[0]]
for w in words[1:]:
    gap = w['t0'] - cur[-1]['t1']
    text_len = len(' '.join(x['w'] for x in cur))
    limit = 10 ** 9 if char_mode else a.words
    maxlen = 24 if char_mode else 10 ** 9
    if len(cur) >= limit or gap >= a.pause or text_len + len(w['w']) > maxlen:
        cues.append(cur); cur = [w]
    else:
        cur.append(w)
if cur: cues.append(cur)
out = [{'t0': max(0, c[0]['t0']), 't1': c[-1]['t1'],
        'text': ('' if char_mode else ' ').join(x['w'] for x in c)} for c in cues]
json.dump(out, open(a.out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(f'wordsrt.py: {len(words)} words → {len(out)} cues → {a.out}')
if a.srt:
    open(a.srt, 'w', encoding='utf-8').write('\n'.join(
        f"{k + 1}\n{fmt(c['t0'])} --> {fmt(c['t1'])}\n{c['text']}\n" for k, c in enumerate(out)))
    print(f'srt: {a.srt}')
