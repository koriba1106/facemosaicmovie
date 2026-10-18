// OpenCV.js の Mat について、JS から作られたものの生成と解放を全て記録するテスト用ヘルパー。
// 解放漏れを「1個単位」で検出できる（RSS の増加では見えない小さな漏れも拾う）。
module.exports = function trackMats(cv) {
  const live = new Set();
  const cvT = Object.create(cv);                      // pipeline/core に渡すラッパー（定数・関数は元の cv を継承）
  cvT.Mat = function (...a) { const m = new cv.Mat(...a); live.add(m); return m; };
  cvT.Mat.zeros = (...a) => { const m = cv.Mat.zeros(...a); live.add(m); return m; };
  cvT.matFromArray = (...a) => { const m = cv.matFromArray(...a); live.add(m); return m; };
  const origDelete = cv.Mat.prototype.delete, origRoi = cv.Mat.prototype.roi;
  cv.Mat.prototype.delete = function () { live.delete(this); return origDelete.call(this); };
  cv.Mat.prototype.roi = function (...a) { const r = origRoi.apply(this, a); live.add(r); return r; };
  return { cvT, live, restore() { cv.Mat.prototype.delete = origDelete; cv.Mat.prototype.roi = origRoi; } };
};
