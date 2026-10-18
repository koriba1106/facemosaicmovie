#!/usr/bin/env python3
"""Python 実装(engine.py)を正解として、JS 移植の検証用テストベクトルを生成する。
   使い方: python tests/gen_vectors.py <engine.py のあるフォルダ>   → tests/vectors.json
   生成済みの vectors.json を同梱しているため、通常は再生成不要（Python 不要でテスト可能）。"""
import sys, os, json, base64, random
import numpy as np
sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else "../facemosaic_web")
import engine
from scipy.optimize import linear_sum_assignment

rng = random.Random(20261017)
nrng = np.random.default_rng(20261017)
V = {}

# ---------- 1) dynamic-input の検出ロジック（推論は偽装し、後処理だけを比較） ----------
def rand_row(vw, vh, *, big=False, pad_zone=False, edge=False):
    if big: w = rng.uniform(210, 330)
    else: w = rng.uniform(12, 0.45 * vw)
    h = w * rng.uniform(0.62, 1.5)
    x = rng.uniform(-6, vw - w + 6); y = rng.uniform(-6, vh - h + 6)
    if edge: x = rng.choice([-3.0, 0.5, vw - w - 0.5, vw - w + 2.0]); y = rng.uniform(0, max(1, vh - h))
    if pad_zone: x = vw + rng.uniform(1, 25); y = rng.uniform(0, vh * 0.8)     # パディング領域（有効範囲の外）
    good = rng.random() < 0.7
    j = (lambda a: rng.uniform(-a, a)) if not good else (lambda a: rng.uniform(-a * .12, a * .12))
    lm = [x + w * .3 + j(w), y + h * .38 + j(h), x + w * .7 + j(w), y + h * .38 + j(h), x + w * .5 + j(w), y + h * .58 + j(h),
          x + w * .35 + j(w), y + h * .78 + j(h), x + w * .65 + j(w), y + h * .78 + j(h)]
    return [x, y, w, h, *lm, rng.choice([rng.uniform(0.3, 0.6), rng.uniform(0.5, 1.0), rng.uniform(0.55, 0.99)])]

class P: pass
primary, coarse = P(), P()
eng = type("E", (), {})(); eng.primary = primary; eng.coarse = coarse
cases = []
for (W, H, md) in [(1280, 720, 960), (1920, 1080, 960), (1920, 1080, 640), (640, 360, 640), (1080, 1920, 960), (640, 480, 480), (320, 180, 640), (1280, 720, 480), (3840, 2160, 960), (800, 600, 640)]:
    for k in range(9):
        frame = np.zeros((H, W, 3), np.uint8)
        _, dw, dh = engine._resize_for_detection(frame, md)
        n = rng.randint(0, 6)
        prim = []
        for i in range(n):
            prim.append(rand_row(dw, dh, big=(rng.random() < 0.25), pad_zone=(rng.random() < 0.12), edge=(rng.random() < 0.2)))
        ls = max(dw, dh); cscale = engine.DYN_COARSE_DETECT_DIM / float(ls)
        cw = max(1, int(round(dw * cscale))); ch = max(1, int(round(dh * cscale)))
        co = [rand_row(cw, ch, big=(rng.random() < 0.3), edge=(rng.random() < 0.2)) for _ in range(rng.randint(0, 3))]
        # 主検出と同じ顔を粗スケールでも検出した場合（重複マージの確認）
        if prim and co and rng.random() < 0.6:
            r = prim[0]; co[0] = [r[0] * cw / dw, r[1] * ch / dh, r[2] * cw / dw, r[3] * ch / dh, *[r[4 + i] * (cw / dw if i % 2 == 0 else ch / dh) for i in range(10)], min(0.99, r[14] + 0.02)]
        calls = {"coarse": 0}
        def fake(det, img):
            arr = prim if det is primary else co
            if det is coarse: calls["coarse"] += 1
            a = np.array(arr, dtype=np.float32).reshape(-1, 15)
            return a if len(arr) else None
        saved = engine._dynamic_infer; engine._dynamic_infer = fake
        res = engine.detect_faces_dynamic(eng, frame, md)
        engine._dynamic_infer = saved
        cases.append({"W": W, "H": H, "maxDim": md, "dw": dw, "dh": dh, "cw": cw, "ch": ch,
                      "primary": np.array(prim, dtype=np.float32).reshape(-1, 15).flatten().tolist(), "nPrimary": len(prim),
                      "coarse": np.array(co, dtype=np.float32).reshape(-1, 15).flatten().tolist(), "nCoarse": len(co),
                      "coarseCalled": calls["coarse"] > 0, "expected": [{"box": d["box"], "confidence": d["confidence"]} for d in res]})
V["dynamic"] = cases

# ---------- 1b) 境界値（しきい値の直前・直後・ちょうど）。乱数では当たりにくい所を狙う ----------
def good_row(x, y, w, h, conf):
    lm = [x + w * .3, y + h * .38, x + w * .7, y + h * .38, x + w * .5, y + h * .58, x + w * .35, y + h * .78, x + w * .65, y + h * .78]
    return [x, y, w, h, *lm, conf]
def bad_row(x, y, w, h, conf):                       # 鼻が目より上: ランドマーク検証で落ちる
    r = good_row(x, y, w, h, conf); r[9] = y - h * 0.5; return r
def run_case(label, W, H, md, prim, co=()):
    frame = np.zeros((H, W, 3), np.uint8)
    _, dw, dh = engine._resize_for_detection(frame, md)
    ls = max(dw, dh); cscale = engine.DYN_COARSE_DETECT_DIM / float(ls)
    cw = max(1, int(round(dw * cscale))); ch = max(1, int(round(dh * cscale)))
    calls = {"coarse": 0}
    def fake(det, img):
        arr = prim if det is primary else co
        if det is coarse: calls["coarse"] += 1
        a = np.array(arr, dtype=np.float64).reshape(-1, 15).astype(np.float32)
        return a if len(arr) else None
    saved = engine._dynamic_infer; engine._dynamic_infer = fake
    res = engine.detect_faces_dynamic(eng, frame, md); engine._dynamic_infer = saved
    def enc(rows):
        out = []
        for v in np.array(rows, dtype=np.float64).reshape(-1, 15).astype(np.float32).flatten().tolist():
            out.append("nan" if v != v else "inf" if v == float("inf") else "-inf" if v == float("-inf") else v)
        return out
    return {"label": label, "W": W, "H": H, "maxDim": md, "dw": dw, "dh": dh, "cw": cw, "ch": ch,
            "primary": enc(prim), "nPrimary": len(prim), "coarse": enc(co), "nCoarse": len(co), "coarseCalled": calls["coarse"] > 0,
            "expected": [{"box": d["box"], "confidence": d["confidence"]} for d in res]}
B = []
W0, H0, MD = 1280, 720, 960                          # 縮小率 0.75 → 検出用 960x540
def add(label, rows, co=(), W=W0, H=H0, md=MD): B.append(run_case(label, W, H, md, rows, co))
for conf in (0.30, 0.449, 0.45, 0.451, 0.65):
    add(f"通常の顔 信頼度{conf}", [good_row(300, 200, 90, 100, conf)])
for conf in (0.50, 0.549, 0.55, 0.551, 0.60):
    add(f"小さい顔(27px) 信頼度{conf}", [good_row(300, 200, 27, 27, conf)])
for conf in (0.449, 0.46):
    add(f"小さくない顔(28px) 信頼度{conf}", [good_row(300, 200, 28, 28, conf)])
for wd in (11.0, 11.99, 12.0, 12.01, 13.0):          # モデル座標の幅。原画では ×4/3 → 14.67 / 15.99 / 16.0 / 16.01 / 17.3 px（16px 未満は捨てる）
    add(f"最小サイズ(幅) 原画{round(wd*4/3,3)}px", [good_row(300, 200, wd, wd * 1.1, 0.9)])
for ht in (11.0, 11.99, 12.0, 12.01, 13.0):          # 高さ側の境界（幅は縦横比の上限内で広くとる）
    add(f"最小サイズ(高さ) 原画{round(ht*4/3,3)}px", [good_row(300, 200, ht * 1.2, ht, 0.9)])
for ratio in (0.49, 0.499, 0.50, 0.501, 1.34, 1.349, 1.35, 1.351):
    add(f"縦横比 {ratio}", [good_row(300, 200, 80 * ratio, 80, 0.9)])
for conf in (0.58, 0.599, 0.60, 0.62):
    add(f"左端に接する顔(不正ランドマーク) 信頼度{conf}", [bad_row(1.0, 200, 80, 90, conf)])
    add(f"右端に接する顔(不正ランドマーク) 信頼度{conf}", [bad_row(960 - 80 - 1.0, 200, 80, 90, conf)])
add("端に接しない顔(不正ランドマーク) 高信頼", [bad_row(300, 200, 80, 90, 0.95)])
add("上端に接する顔(不正ランドマーク) 0.9", [bad_row(300, 1.5, 80, 90, 0.9)])
add("端から3px(接しない) 不正ランドマーク 0.9", [bad_row(3.0, 200, 80, 90, 0.9)])
for cx in (959.9, 960.0, 960.1):
    add(f"中心X={cx}(有効幅960)", [good_row(cx - 40, 200, 80, 90, 0.9)])
for cy in (539.9, 540.0, 540.1):
    add(f"中心Y={cy}(有効高540)", [good_row(300, cy - 45, 80, 90, 0.9)])
add("中心が負(-0.1)", [good_row(-40.1, 200, 80, 90, 0.9)])
for size in (199.9, 200.0, 200.1, 260):
    add(f"大きい顔 model_size={size}(粗スケール再検出の発動)", [good_row(300, 100, size, size, 0.9)], [good_row(100, 40, 85, 85, 0.9)])
add("主検出なし → 粗スケール", [], [good_row(100, 40, 85, 85, 0.9)])
for conf in (0.59, 0.599, 0.60, 0.601, 0.8):
    add(f"粗スケール側の信頼度{conf}", [], [good_row(100, 40, 85, 85, conf)])
add("粗スケール側が小さい顔(27px相当) 0.7", [], [good_row(100, 40, 27, 27, 0.7)])
for iouv in (0.30, 0.34, 0.349, 0.351, 0.40):          # 同じ大きさの2つの顔を横にずらし、IoU を調整
    sh = 80 * (1 - iouv) / (1 + iouv)
    add(f"重複マージ IoU≈{iouv}", [good_row(300, 200, 80, 80, 0.95), good_row(300 + sh, 200, 80, 80, 0.90)])
for cont in (0.60, 0.69, 0.71, 0.80):                  # 小さい顔が大きい顔にどれだけ含まれるか
    small = 40; out = small * (1 - cont)
    add(f"包含マージ 含まれる割合≈{cont}", [good_row(300, 200, 150, 150, 0.95), good_row(300 + 150 - small + out, 230, small, small, 0.9)])
add("信頼度が同じ2つ(安定ソートの順序)", [good_row(100, 100, 90, 90, 0.9), good_row(500, 300, 90, 90, 0.9), good_row(800, 100, 90, 90, 0.9)])
add("画面の隅(クリップ)", [good_row(0.5, 0.5, 60, 66, 0.99), good_row(960 - 61, 540 - 67, 60, 66, 0.99)])
add("NaN の信頼度", [good_row(300, 200, 80, 90, float("nan"))])
add("NaN の座標", [good_row(float("nan"), 200, 80, 90, 0.9)])
add("無限大の幅", [good_row(300, 200, float("inf"), 90, 0.9)])
add("幅ゼロ・負", [good_row(300, 200, 0, 90, 0.9), good_row(300, 200, -50, 90, 0.9)])
add("縦長フレーム(1080x1920,960)", [good_row(200, 300, 90, 100, 0.9)], W=1080, H=1920, md=960)
add("小さいフレーム(320x180)", [good_row(100, 50, 40, 44, 0.9)], W=320, H=180, md=960)
add("縮小しないフレーム(640x360,640)", [good_row(200, 100, 60, 66, 0.9)], W=640, H=360, md=640)
add("粗スケール不要(長辺<400)", [], [good_row(10, 10, 30, 30, 0.9)], W=300, H=200, md=960)
V["dynamic_boundary"] = B

# ---------- 2) 追跡 ----------
def scenario(frames, nfaces, drop):
    objs = [{"x": rng.uniform(50, 500), "y": rng.uniform(50, 300), "vx": rng.uniform(-6, 6), "vy": rng.uniform(-4, 4),
             "s": rng.uniform(40, 140), "born": rng.randint(0, 10), "die": rng.randint(frames - 15, frames + 5)} for _ in range(nfaces)]
    seq = []
    for f in range(frames):
        dets = []
        for o in objs:
            o["x"] += o["vx"]; o["y"] += o["vy"]
            if o["born"] <= f < o["die"] and rng.random() > drop:
                s = o["s"] * rng.uniform(.95, 1.05)
                dets.append({"box": [o["x"], o["y"], o["x"] + s, o["y"] + s * 1.1], "confidence": rng.uniform(0.45, 0.95)})
        if rng.random() < .1:
            x, y = rng.uniform(0, 600), rng.uniform(0, 400)
            dets.append({"box": [x, y, x + 60, y + 66], "confidence": rng.uniform(0.45, 0.6)})
        rng.shuffle(dets); seq.append(dets)
    return seq

def run_scenario(seq, use_scipy):
    saved = engine.HAS_SCIPY; engine.HAS_SCIPY = use_scipy
    tracks, nid, out = [], 1, []
    for dets in seq:
        tracks, nid = engine.update_tracks_pool(tracks, [dict(d) for d in dets], nid)
        out.append([{"id": t.track_id, "box": list(t.box), "vel": list(t.velocity), "hits": t.hits, "missing": t.missing_count,
                     "confirmed": t.confirmed, "render": list(t.get_render_box())} for t in tracks])
    engine.HAS_SCIPY = saved
    return out

V["tracker"] = []
for (fr, nf, drop) in [(60, 1, 0.0), (80, 2, 0.15), (80, 4, 0.2), (100, 6, 0.25), (60, 3, 0.4), (120, 8, 0.1)]:
    seq = scenario(fr, nf, drop)
    V["tracker"].append({"seq": seq, "hungarian": run_scenario(seq, True), "greedy": run_scenario(seq, False)})

# ---------- 3) ハンガリアン法 ----------
V["assign"] = []
for _ in range(80):
    n, m = rng.randint(1, 9), rng.randint(1, 9)
    M = [[rng.random() for _ in range(m)] for _ in range(n)]
    r, c = linear_sum_assignment(np.array(M))
    V["assign"].append({"cost": M, "pairs": [[int(a), int(b)] for a, b in zip(r, c)], "total": float(sum(M[a][b] for a, b in zip(r, c)))})

# ---------- 4) モザイク（画像は小さくして、ファイルサイズを抑える） ----------
V["mosaic"] = []
for (W, H, specs) in [
    (200, 150, [([20, 20, 100, 110], True, 10, [3, 1]), ([130, 30, 180, 90], True, 2, [0, 0])]),
    (220, 160, [([5, 5, 55, 65], True, 5, [-2, 1]), ([90.4, 40.6, 170.2, 140.9], True, 8, [4, -3]), ([180, 100, 219, 159], False, 1, [0, 0])]),
    (129, 97, [([0, 0, 129, 97], True, 3, [0, 0]), ([20, 20, 21, 21], True, 3, [0, 0])]),
    (256, 192, [([40, 40, 115, 115], True, 6, [0, 0]), ([140, 40, 221, 121], True, 6, [0, 0]), ([140, 140, 165, 165], True, 6, [0, 0])]),
]:
    yy, xx = np.mgrid[0:H, 0:W]
    img = np.stack([(xx * 255 / W), (yy * 255 / H), ((xx + yy) * 255 / (W + H))], -1) + nrng.integers(-30, 30, (H, W, 3))
    img = np.clip(img, 0, 255).astype(np.uint8)
    tracks = []
    for i, (box, conf, hits, vel) in enumerate(specs):
        t = engine.RobustFaceTrack(box, i + 1, 0.9 if conf else 0.5)
        t.confirmed = conf; t.hits = hits; t.velocity = [float(vel[0]), float(vel[1])]
        tracks.append(t)
    out = img.copy(); engine.apply_mosaic_to_frame(out, tracks)
    V["mosaic"].append({"W": W, "H": H, "image": base64.b64encode(img.tobytes()).decode(), "expected": base64.b64encode(out.tobytes()).decode(),
                        "tracks": [{"box": list(t.box), "confirmed": t.confirmed, "hits": t.hits, "velocity": list(t.velocity)} for t in tracks]})

# ---------- 5) ビットレート / 丸め ----------
V["bitrate"] = []
for (size, dur) in [(50_000_000, 100), (300_000_000, 600), (1_000_000, 10), (5_000_000, 0), (0, 10), (20_000_000, 3), (100, 50)]:
    e = engine.VideoExporter("a", "b", "c", "d", compact=True, input_file_size=size, duration_sec=dur)
    V["bitrate"].append({"size": size, "dur": dur, "expected": e.calculate_compact_bitrate(dur)})
V["round"] = [{"x": x, "expected": int(round(x))} for x in [0.5, 1.5, 2.5, 3.5, 4.5, 1.49, 1.51, 4.4999, 75 * 0.06, 25 * 0.06, 8.5, 0.0, 7.0, 639.5, 360.5]]

path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vectors.json")
json.dump(V, open(path, "w"))
print({k: len(v) for k, v in V.items()}, "->", "vectors.json", os.path.getsize(path) // 1024, "KB")
print("境界値ケース:", len(B), "件（採用あり", sum(1 for b in B if b["expected"]), "/ 棄却のみ", sum(1 for b in B if not b["expected"]), "）")
print("coarse が走ったケース:", sum(c["coarseCalled"] for c in cases), "/", len(cases), "  採用された検出の総数:", sum(len(c["expected"]) for c in cases))
