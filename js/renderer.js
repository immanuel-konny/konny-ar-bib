// 캔버스 합성 (v15 이식)
// 렌더 순서: 턱받이(그림자 포함) → 얼굴 윤곽 가림(erase/composite) 순으로
// "목에 걸쳐 상의 위에 놓인" 착용감을 만든다.

export function buildMaskPath(mask) {
  const path = new Path2D();
  const addPolygon = (points) => {
    if (!points.length) return;
    path.moveTo(points[0].x, points[0].y);
    points.slice(1).forEach((p) => path.lineTo(p.x, p.y));
    path.closePath();
  };
  addPolygon(mask.oval);
  addPolygon(mask.neck);
  return path;
}

// 라이브 뷰: 마스크 영역의 턱받이 픽셀만 지워 아래 카메라 영상이 그대로 보이게 한다.
// (카메라 영상 자체는 건드리지 않음 — v15에서 마스크 노출 버그를 수정한 방식)
export function eraseMaskArea(ctx, mask) {
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = '#000';
  ctx.fill(buildMaskPath(mask));
  ctx.restore();
}

// 저장 사진: 합성이 끝난 캔버스 위에, 마스크 영역만 원본 프레임을 다시 덮는다.
export function compositeSkinOver(ctx, cleanFrameCanvas, mask) {
  ctx.save();
  ctx.clip(buildMaskPath(mask));
  ctx.drawImage(cleanFrameCanvas, 0, 0);
  ctx.restore();
}

// 제품 이미지가 아직 로드되지 않았을 때의 단순 실루엣 폴백
function drawFallbackShape(ctx, fit, product) {
  const w = fit.width;
  const h = fit.height;
  const path = new Path2D();
  path.moveTo(-w * 0.44, -h * 0.3);
  path.bezierCurveTo(-w * 0.58, -h * 0.08, -w * 0.48, h * 0.15, -w * 0.31, h * 0.22);
  path.bezierCurveTo(-w * 0.31, h * 0.42, -w * 0.12, h * 0.5, 0, h * 0.36);
  path.bezierCurveTo(w * 0.12, h * 0.5, w * 0.31, h * 0.42, w * 0.31, h * 0.22);
  path.bezierCurveTo(w * 0.48, h * 0.15, w * 0.58, -h * 0.08, w * 0.44, -h * 0.3);
  path.quadraticCurveTo(w * 0.22, -h * 0.46, 0, -h * 0.42);
  path.quadraticCurveTo(-w * 0.22, -h * 0.46, -w * 0.44, -h * 0.3);
  path.closePath();
  // 목 구멍
  path.ellipse(0, -h * 0.34, w * 0.18, h * 0.14, 0, 0, Math.PI * 2, true);
  path.closePath();

  ctx.save();
  ctx.shadowColor = 'rgba(58, 40, 28, 0.28)';
  ctx.shadowBlur = w * 0.055;
  ctx.shadowOffsetY = h * 0.035;
  ctx.fillStyle = product.color;
  ctx.fill(path, 'evenodd');
  ctx.restore();

  ctx.strokeStyle = 'rgba(255,255,255,.7)';
  ctx.lineWidth = Math.max(2, w * 0.012);
  ctx.stroke(path);
}

// 턱받이 본체 그리기 — 원본 실루엣·비율 유지 + 접촉 그림자
export function drawBib(ctx, fit, product, opacity, image) {
  ctx.save();
  ctx.translate(fit.x, fit.y);
  ctx.rotate(fit.rotation);
  ctx.globalAlpha = opacity * fit.confidence;

  if (image?.complete && image.naturalWidth > 0) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.shadowColor = 'rgba(48, 32, 24, 0.2)';
    ctx.shadowBlur = Math.min(12, fit.width * 0.02);
    ctx.shadowOffsetY = Math.min(8, fit.height * 0.025);
    ctx.drawImage(image, -fit.width / 2, -fit.height / 2, fit.width, fit.height);

    // 원단 입체감(Spark AR 참고): 제품 비율은 그대로 두고 음영만 얹는다.
    // source-atop이라 방금 그린 턱받이 픽셀 위에만 칠해진다.
    ctx.shadowColor = 'transparent';
    ctx.globalCompositeOperation = 'source-atop';
    // ① 목선 안쪽 그림자 — 상단 중앙이 목 뒤로 들어간 느낌
    const neckShade = ctx.createRadialGradient(
      0, -fit.height * 0.42, fit.width * 0.04,
      0, -fit.height * 0.42, fit.width * 0.34,
    );
    neckShade.addColorStop(0, 'rgba(58, 40, 28, 0.16)');
    neckShade.addColorStop(1, 'rgba(58, 40, 28, 0)');
    ctx.fillStyle = neckShade;
    ctx.fillRect(-fit.width / 2, -fit.height / 2, fit.width, fit.height);
    // ② 상하 원통 음영 — 가슴 위 곡면을 따라 아래로 갈수록 살짝 어둡게
    const drape = ctx.createLinearGradient(0, -fit.height / 2, 0, fit.height / 2);
    drape.addColorStop(0, 'rgba(255, 255, 255, 0.06)');
    drape.addColorStop(0.55, 'rgba(255, 255, 255, 0)');
    drape.addColorStop(1, 'rgba(58, 40, 28, 0.10)');
    ctx.fillStyle = drape;
    ctx.fillRect(-fit.width / 2, -fit.height / 2, fit.width, fit.height);
    ctx.globalCompositeOperation = 'source-over';
  } else {
    drawFallbackShape(ctx, fit, product);
  }
  ctx.restore();
}

// 뷰티 보정이 켜진 저장 사진에 쓰는 은은한 전면광 (screen 합성)
export function drawBeautyLight(ctx, width, height) {
  const gradient = ctx.createRadialGradient(
    width * 0.5,
    height * 0.23,
    0,
    width * 0.5,
    height * 0.23,
    Math.max(width, height) * 0.62,
  );
  gradient.addColorStop(0, 'rgba(255, 241, 236, 0.14)');
  gradient.addColorStop(0.45, 'rgba(255, 247, 243, 0.045)');
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}
