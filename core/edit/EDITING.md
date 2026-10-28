# EDITING — ระบบตัดต่อและขั้นตอนการทำงานแบบละเอียด / the cut stage and the full production pipeline

> ภาษาไทยเป็นหลัก · คำสั่งเป็นอังกฤษตามเครื่องมือจริง · รันทุกคำสั่งจากรากไลบรารี (`$LIB`)
> This file adds a clip-level **editing system** (`core/edit/assemble.mjs`) on top of the library's
> single-timeline philosophy: build scenes freely, then cut them into one film with the same
> loudness/grain master as every other film.

---

## §0 ปรัชญาให้ตรงก่อน — เมื่อไหร่ใช้อะไร

| สถานการณ์ | ใช้ |
|---|---|
| หนังทั้งเรื่องวาดในหน้าเดียว ตัดฉากด้วยเวลาใน `render(t)` | **one timeline** (แบบดั้งเดิมของไลบรารี — TECHNIQUE.md §3) · ไม่ต้องตัดต่อ |
| หลายฉาก/หลายคลิปเรนเดอร์แยก ต้อง**เรียง · ตัด · ซ้อนทรานสิชัน · วางเสียง · ใส่ซับ** | **`core/edit/assemble.mjs`** (ระบบนี้) |
| ตัดจากฟุตเทจจริง (สไตล์ Edit & Documentary) | เรนเดอร์/แปลงฟุตเทจเป็นคลิปก่อน แล้วมาตัดด้วยระบบนี้เช่นกัน |

เหตุผลที่ต้องมีตัวตัดต่อ: ไลบรารีเดิมมีแต่ `mux.sh` (ภาพเดียว+เสียงเดียว) — ไม่มีการ**รวมหลายคลิป**,
ไม่มี trim/transition/reorder ทำให้งานหลายฉากต้องกลับไปแก้โค้ดทุกครั้ง ตัวนี้ทำให้ "ห้องตัดต่อ" เป็นข้อมูล (EDL) แทนโค้ด

---

## §1 edit.json — สิ่งเดียวที่ต้องรู้

```json
{
  "fps": 24, "size": "1920x1080", "grain": 1,
  "clips": [
    { "src": "out/s1.mp4", "in": 0.5, "out": 3.0 },
    { "src": "out/s2.mp4", "in": 1.0, "out": 3.5,
      "transition": { "type": "fade", "dur": 0.5 } }
  ],
  "audio":  [ { "src": "mix.wav", "at": 0.0, "gain": 1.0, "fadeIn": 0.2, "fadeOut": 0.8 } ],
  "captions": [ { "t0": 0.2, "t1": 2.0, "text": "…" } ],
  "srt": "out/subs.srt",
  "burn": true
}
```

กติกา (ตรวจให้ก่อนเรนเดอร์ทุกข้อ — ผิดข้อไหน exit 1 พร้อมบอกบรรทัด):

| กติกา | เหตุผล |
|---|---|
| `in`/`out` เป็นวินาทีในไฟล์ต้นทาง · `out > in` เสมอ | ตัดแบบ exclusive ปลาย |
| `out` เกินความยาวไฟล์ต้นทาง = error | กันคลิปหลองจนภาพค้าง |
| `transition` ใส่ใน**คลิปเข้า** (เกิดตอนซ้อนเข้าวัสดุเดิม) · ห้ามใส่คลิปแรก · `dur < ความยาววัสดุก่อนหน้า` | offset ของ xfade ติดลบไม่ได้ |
| ชื่อ transition ใดก็ได้ที่ ffmpeg xfade รู้: `fade, dissolve, wipeleft, slideup, circleopen…` | ผ่านตรงเข้า filter |
| **ความยาวรวม = Σ ความยาวคลิป − Σ transition** | โปรแกรมพิมพ์ตาราง timeline ให้ดูก่อนเรนเดอร์ทุกครั้ง |
| `audio[].at` เป็นวินาทีบน**ไทม์ไลน์ผลรวม** (ไม่ผูกคลิป) · หลายแถว = amix · `gain` เท่าไหร่ก็ได้ · `fadeIn/fadeOut` วินาที | เสียงตัดต่อแยกจากภาพ |
| ไม่มี `audio` = ยัดแทร็กเงียบ (mux.sh เตือน — คาดหมาย) | ปลายทางต้องมีแทร็กเสียงเสมอ |
| `captions` → `.srt` (ตัด cue ทับซ้อนอัตโนมัติเหมือน srt.py) · ปลายทาง `srt` หรือ `out/<ชื่อ>.srt` | ซับแยกไฟล์ส่งลูกค้า/แพลตฟอร์ม |
| `"burn": true` เผาซับลงภาพด้วย (วาด PNG ต่อ cue ด้วย Pillow ฟอนต์ไทยได้ → overlay) — ไม่ต้องมี libass ใน ffmpeg | ช่องทางที่ไม่อ่าน .srt (IG/TikTok บางเส้น) |

รัน:

```sh
node core/edit/assemble.mjs films/<โปรเจกต์>/edit.json --out films/<โปรเจกต์>/out/final.mp4
node core/edit/assemble.mjs films/<โปรเจกต์>/edit.json --dry-run     # ดูตาราง timeline อย่างเดียว ไม่เรนเดอร์
LEMO_EDIT_DEBUG=1 node …                                            # เก็บไฟล์ขั้นกลางไว้ดีบัก
```

ภายใน: normalize ทุกคลิป (trim→scale→fps→yuv420p) → ต่อด้วย `xfade` (transition) หรือ `concat` (cut)
→ ผสมเสียง (`aresample 48k mono → volume → adelay → afade → amix normalize=0`)
→ **master ผ่าน `core/render/mux.sh`** = loudnorm 2-pass −14 LUFS / TP −1.2 + film grain เท่ากับหนัง one-timeline ทุกตัว

---

## §2 ขั้นตอนการทำงานเต็มสาย (production pipeline แบบละเอียด)

> ทุกขั้นมี "ของที่ต้องได้ก่อนข้ามขั้น" (gate) — ขั้นไหนยังไม่มีของจบขั้น ห้ามข้าม

### ขั้น 1 · Brief — สัมภาษณ์ให้ครบรอบเดียว (DIRECTOR.md §1)
สิ่งที่ต้องถาม/ได้มา: หัวข้อจริง + ข้อเท็จจริงที่ห้ามมั่ว · โลโก้/ชื่อ/ผลิตภัณฑ์ที่ต้องขึ้นจอ ·
วัสดุของลูกค้า (เสียงพากย์? ดนตรี? ภาพ? ฟอนต์?) · ภาษาของหนัง · storyboard เป็น/ไม่เป็น
**Gate:** เขียนสรุปบรีฟ 3–5 บรรทัด อ่านให้ลูกค้ายืนยัน

### ขั้น 2 · เลือกสไตล์ + Benchmark (DIRECTOR.md §2)
หา 2–3 สไตล์ที่เข้าหัวข้อจาก `styles/README.md` → ดู benchmark ที่คนอื่นทำหัวข้อคล้ายมาแล้ว → ตัดสินใจ
**Gate:** สไตล์ตัวเดียวที่ล็อกแล้ว + เหตุผล 1 บรรทัด

### ขั้น 3 · Treatment (DIRECTOR.md §4) — **ก่อนเปิด DEMO เด็ดขาด**
เขียน `films/<ชื่อ>/TREATMENT.md`: โครงเรื่อง 3 แบบ → เลือก 1 พร้อมเหตุผล · แต่ละฉาก: เห็นอะไร เสียงอะไร กี่วินาที
**Gate:** ตารางฉากครบทุกฉาก มีความยาวรวมตัวเลขจริง

### ขั้น 4 · Look — เฟรมตรวจลุค (DIRECTOR.md §5)
เขียนหน้าตาม page contract (§3 ด้านล่าง) → เรนเดอร์ภาพนิ่งเทียบ STYLE.md:
```sh
node core/render/still.mjs films/<p> 1.0 3.0 5.0        # ออก stills/t_*.jpg
.venv/bin/python core/render/sheet.py films/<p>/sheet.jpg films/<p>/stills/*.jpg   # กระดานเทียบ
```
**Gate:** เฟรมผ่านทุกข้อใน STYLE.md (สี แสง ลายเส้น texture) — ไม่ผ่านอย่าไปต่อ

### ขั้น 5 · Timeline กลาง (TECHNIQUE.md §3)
สร้าง `timeline.js` เดียว: ฉาก/จังหวะเพลง/hit points → ออกเป็น JSON ให้ดนตรี ซับ sfx อ่านเลขชุดเดียวกัน
**Gate:** ทุก hit ของภาพมี cue เสียงรออยู่ (เป้า 0 ms)

### ขั้น 6 · เรนเดอร์เป็นคลิป
```sh
node core/render/video.mjs films/<p> --fps 24 --out films/<p>/out/s1.mp4
```
หลายฉากแยกหน้า → หลายคลิป, หรือคลิปเดียวยาวแล้วใช้ `in/out` ตัด
**Gate:** ffprobe ทุกคลิป: fps/ขนาด/ความยาว ตรง edit.json

### ขั้น 7 · เสียงพากย์ (ถ้ามี) — ตรวจทุกบรรทัด
```sh
.venv/bin/python core/tts/tts.py films/<p>/lines.json films/<p>/voices        # อังกฤษ (Kokoro, offline)
.venv/bin/python core/tts/tts_zh.py films/<p>/lines.json films/<p>/voices     # จีน (edge-tts, ต้องออนไลน์)
.venv/bin/python core/tts/asr_check.py films/<p>/lines.json films/<p>/voices  # ถอดเสียงกลับมาเทียบ — exit 0 เท่านั้น
```
**Gate:** asr_check ผ่าน 100% · compress เสียงก่อนผสม (พูดสูงกว่าดนตรี ~10 dB RMS)

### ขั้น 8 · ดนตรี + SFX ตาม sound palette ของสไตล์
`sampler.py` (เครื่องดนตรีจริง) · `pluck.py` (สายดีด) · `sfx.py` (foley สังเคราะห์ ผูกกับ `window.EV`)
วัดพลังงาน 20–120 Hz ให้ต่ำกว่าย่านอื่น ~−3 dB
**Gate:** mix.wav ยาว ≥ ความยาวภาพ · ไม่คลิป

### ขั้น 9 · ตัดต่อ — ระบบนี้
เขียน `edit.json` (§1) → `--dry-run` ดูตารางก่อน → รันจริง → ดูหนังจบทั้งเรื่อง 1 รอบเต็มก่อนส่ง
**Gate:** ความยาวจริงตรงแผน ±0.1 วิ · ทุก transition เกิดตรง beat · ซับตรงเสียง

### ขั้น 10 · ส่งมอบ (DIRECTOR.md §11)
ของที่ต้องอยู่ในโฟลเดอร์โปรเจกต์: `final.mp4` · `final.srt` (ถ้ามีพากย์/คำบรรยาย) · TREATMENT.md ·
edit.json (แก้ต่อได้) · เครดิตดนตรี/ฟอนต์/วัสดุ (ถ้ามี)
**Gate:** เปิดไฟล์จากโฟลเดอร์เปล่า (ลอยตัว ไม่พึ่ง path ในเครื่อง)

---

## §3 page contract ฉบับย่อ (หน้าที่จะเรนเดอร์ได้)

| Global | ใช้เมื่อ | ความหมาย |
|---|---|---|
| `window.READY = true` | บังคับ | โหลดฟอนต์/รูปครบแล้ว — เครื่องมือรอไม่เกิน 180 วิ |
| `window.render(t)` | บังคับ | วาดเฟรมวินาทีที่ `t` — ต้อง deterministic |
| `window.DUR` | วิดีโอ/readcheck | ความยาวหนัง (วินาที) |
| `window.EV` | ถ้ามี sfx | เหตุการณ์เสียง `{t, type, …}` → `events.mjs` |
| `window.TEXTS(t)` | readcheck | ข้อความบนจอ ณ t + กล่องพิกัด (วัดจาก DOM ด้วย getBoundingClientRect อย่า hardcode) |

⚠ บทเรียนจากการทดสอบจริง 27 ต.ค. 2569: พิกัด TEXTS hardcode ไว้ 1920×1080 แล้วเรนเดอร์ 960×540 = ทุกข้อความ
"outside the frame" · ตัวเลขวิ่งเปลี่ยนทุก 0.5 วิ = BAD ทันที (ต้องอยู่ครบช่วงอ่าน) — readcheck ดุกว่า viewport

---

## §3b แตกหนังเป็นหลายส่วน (multi-part delivery)

```sh
node core/edit/split.mjs films/<p>/out/final.mp4 3          # 3 ส่วนเท่ากัน
node core/edit/split.mjs films/<p>/out/final.mp4 60 --dry-run  # ส่วนละ ~60 วินาที
```
จุดตัดทุกจุด snap ไปยัง "เฟรมจริงเฟรมแรกที่ ≥ เวลานั้น" (index เฟรมทั้งไฟล์) — ส่วนต่อส่วนเล่นต่อเนื่อง
ไม่มีเฟรมซ้ำ/หลุด (ยืมแนวคิดจาก tanmoymondal1312/auto-cut, MIT) · ใช้แปลงหนังเป็นซีรีส์หลายส่วนสำหรับ IG/TikTok

## §4 เทียบสาย one-timeline กับสายตัดต่อ

| | one timeline | ตัดต่อ (assemble) |
|---|---|---|
| การตัด | ใน `render(t)` เอง | edit.json |
| เสียงต่อภาพ | render ตอนเดียวจบ (EV ตรงเฟรม) | วางบนไทม์ไลน์ผลรวม |
| ทรานสิชัน | วาดเองในหน้า | `xfade` ชื่อเดียวกับ ffmpeg |
| master | mux.sh | mux.sh (ตัวเดียวกัน) |
| เหมาะกับ | หนังโค้ดล้วนเรื่องเดียวจบ | หลายฉาก · ฟุตเทจจริง · ประกอบข่าว/ดีลจากคลิปเก่า |

ข้อควรระวัง: transition จริง ๆ คือภาพสองชั้นซ้อนกัน — ฉากที่ปลาย/ต้นมีข้อความสำคัญ อย่าให้ตรงช่วง crossfade
(ตัวอักษรจะจางทับกัน) · ต่อจาก crossfade ให้เผื่อ quiet head ≥ 0.3 วิในแต่ละคลิป ตาและหูจะได้หายใจ
