#!/usr/bin/env python3
"""本物のモデル(2026may)で、Python 実装(engine.py, cv2)の検出結果を「正解」として生成する。
   JS 移植(OpenCV.js)が、実画像・実モデルで同じ検出をすることを tests/test_realmodel.js で検証する。
   使い方: python tests/gen_real_fixtures.py <engine.py のあるフォルダ> <モデル.onnx>
   生成物: tests/fixtures/frames.json（正解）, tests/fixtures/frames.bin.gz（BGR 生画素）"""
import sys, os, json, gzip
import numpy as np, cv2
from skimage import data
sys.path.insert(0, sys.argv[1]); import engine
MODEL = sys.argv[2]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
os.makedirs(OUT, exist_ok=True)

W, H = 640, 360
def bgr(a): return cv2.cvtColor(a, cv2.COLOR_RGB2BGR) if a.ndim == 3 else cv2.cvtColor(a, cv2.COLOR_GRAY2BGR)
def bg(w=W, h=H, base=(70, 100, 80)):
    f = np.zeros((h, w, 3), np.uint8); f[:] = base
    ramp = (np.linspace(0, 40, w)[None, :, None]).astype(np.uint8); return cv2.add(f, np.broadcast_to(ramp, (h, w, 3)).copy())   # ノイズなし（圧縮しやすい）
def paste(f, img, x, y):
    h, w = img.shape[:2]; fh, fw = f.shape[:2]
    x0, y0, x1, y1 = max(0, x), max(0, y), min(fw, x + w), min(fh, y + h)
    if x1 > x0 and y1 > y0: f[y0:y1, x0:x1] = img[y0 - y:y1 - y, x0 - x:x1 - x]
    return f
astro = bgr(data.astronaut()); face = astro[10:230, 120:340]          # 220x220: 顔と上半身（顔は約90px）
def scaled(img, s): return cv2.resize(img, (max(1, int(img.shape[1] * s)), max(1, int(img.shape[0] * s))), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_LINEAR)

frames = {}
frames["astro_normal"] = paste(bg(), face, 210, 70)
big = scaled(face, 1.6); frames["astro_large"] = paste(bg(), big, 140, 5)                 # 顔が大きい → 粗スケール再検出が走る
frames["astro_small"] = paste(bg(), scaled(face, 0.30), 300, 150)                         # 顔が小さい（約27px）
frames["astro_edge"] = paste(bg(), face, -60, 60)                                         # 左端で顔が切れる
frames["astro_two"] = paste(paste(bg(), face, 60, 70), face[:, ::-1].copy(), 360, 70)     # 2人
pf = bg(360, 640); frames["astro_portrait"] = paste(pf, scaled(face, 1.2), 50, 180)       # 縦長
frames["astro_tiny"] = paste(bg(320, 180), scaled(face, 0.7), 80, 20)
lfw = data.lfw_subset(); lf = bg()
for i, k in enumerate([3, 40, 77, 120]):
    t = cv2.resize((lfw[k] * 255).astype(np.uint8), (150, 150), interpolation=cv2.INTER_CUBIC); frames_lfw = cv2.cvtColor(t, cv2.COLOR_GRAY2BGR); paste(lf, frames_lfw, 20 + i * 155, 100)
frames["lfw_four"] = lf
for name, a in [("noface_coffee", data.coffee()), ("noface_cat", data.chelsea()), ("noface_camera", data.camera())]:
    frames[name] = cv2.resize(bgr(a), (384, 216), interpolation=cv2.INTER_AREA)       # 顔なし画像（誤検出の確認用。サイズ軽量化）

eng = engine.create_engine(engine.KIND_DYNAMIC, MODEL)
meta, blob = [], bytearray()
for name, f in frames.items():
    f = np.ascontiguousarray(f); h, w = f.shape[:2]
    entry = {"name": name, "w": w, "h": h, "offset": len(blob), "results": {}}
    for md in (640, 480):
        dets = eng.detect(f, md)
        entry["results"][str(md)] = [{"box": d["box"], "confidence": d["confidence"]} for d in dets]
    blob += f.tobytes(); meta.append(entry)
    print(f"{name:16} {w}x{h}  640:{[round(d['confidence'],2) for d in eng.detect(f,640)]}  480:{[round(d['confidence'],2) for d in eng.detect(f,480)]}")
with gzip.GzipFile(os.path.join(OUT, "frames.bin.gz"), "wb", compresslevel=9, mtime=0) as g: g.write(bytes(blob))
json.dump(meta, open(os.path.join(OUT, "frames.json"), "w"))
print("fixtures:", os.path.getsize(os.path.join(OUT, "frames.bin.gz")) // 1024, "KB gz,", len(meta), "frames")
