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

// ── 평면 원근 + 가장자리 음영 (v10) ────────────────────────
// 몸/머리 회전(yaw)에 맞춰 이미지 전체를 세로 스트립으로 나눠 선형 스케일만
// 적용한다(평면 호모그래피 근사). 직선이 보존되므로 v14 삼각 메시와 달리
// 실루엣·패턴·로고가 휘지 않는다. 실물 착용컷 근거: 몸을 돌리면 먼 쪽
// 원단이 좁고 짧아 보이고, 좌우 날개 끝은 몸 곡면을 따라 살짝 어두워진다.
const PERSPECTIVE_MAX = 0.24; // |yaw|=1에서 근/원측 세로 스케일 차
const PERSPECTIVE_SLICES = 32;
const EDGE_SHADE_BASE = 0.065; // 가장자리 기본 음영 (정면에서도 은은히)

let bibLayerCanvas = null;

function renderBibLayer(image, width, height, yaw) {
  const p = Math.max(-1, Math.min(1, yaw || 0)) * PERSPECTIVE_MAX;
  const pad = Math.ceil((height * Math.abs(p)) / 2) + 2;
  const layerW = Math.max(2, Math.ceil(width));
  const layerH = Math.max(2, Math.ceil(height + pad * 2));

  bibLayerCanvas ??= document.createElement('canvas');
  const layer = bibLayerCanvas;
  if (layer.width !== layerW || layer.height !== layerH) {
    layer.width = layerW;
    layer.height = layerH;
  }
  const lctx = layer.getContext('2d');
  lctx.clearRect(0, 0, layerW, layerH);
  lctx.imageSmoothingEnabled = true;
  lctx.imageSmoothingQuality = 'high';

  const n = PERSPECTIVE_SLICES;
  const srcSliceW = image.naturalWidth / n;
  let x = 0;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n - 0.5;
    const k = 1 - p * t; // 선형 스케일 — 대칭이라 총폭은 width 그대로 유지
    const dw = (width / n) * k;
    const dh = height * k;
    lctx.drawImage(
      image,
      i * srcSliceW, 0, srcSliceW, image.naturalHeight,
      x, (layerH - dh) / 2, dw + 0.6, dh, // +0.6px: 슬라이스 사이 심 갭 방지
    );
    x += dw;
  }

  // 좌우 가장자리 음영 — 원측(far)은 몸 뒤로 돌아가므로 근측보다 살짝 진하게
  const nearAlpha = EDGE_SHADE_BASE * 0.8;
  const farAlpha = EDGE_SHADE_BASE + Math.abs(p) * 0.45;
  const leftAlpha = p >= 0 ? nearAlpha : farAlpha;
  const rightAlpha = p >= 0 ? farAlpha : nearAlpha;
  const grad = lctx.createLinearGradient(0, 0, layerW, 0);
  grad.addColorStop(0, `rgba(40, 28, 22, ${leftAlpha.toFixed(3)})`);
  grad.addColorStop(0.2, 'rgba(40, 28, 22, 0)');
  grad.addColorStop(0.8, 'rgba(40, 28, 22, 0)');
  grad.addColorStop(1, `rgba(40, 28, 22, ${rightAlpha.toFixed(3)})`);
  lctx.save();
  lctx.globalCompositeOperation = 'source-atop'; // 레이어의 턱받이 픽셀에만 적용
  lctx.fillStyle = grad;
  lctx.fillRect(0, 0, layerW, layerH);

  // 턱 그림자: 목 구멍 바로 아래 은은한 그늘 — 실물 착용컷에서 턱이 원단에
  // 드리우는 그림자를 재현한다 (Spark AR 레퍼런스의 핵심 입체 단서).
  const top = (layerH - height) / 2;
  const chinShadow = lctx.createRadialGradient(
    layerW / 2, top + height * 0.10, width * 0.03,
    layerW / 2, top + height * 0.10, width * 0.26,
  );
  chinShadow.addColorStop(0, 'rgba(45, 32, 26, 0.16)');
  chinShadow.addColorStop(0.55, 'rgba(45, 32, 26, 0.06)');
  chinShadow.addColorStop(1, 'rgba(45, 32, 26, 0)');
  lctx.fillStyle = chinShadow;
  lctx.fillRect(0, 0, layerW, layerH);
  lctx.restore();

  return { layer, layerH };
}

// 턱받이 본체 그리기 — 원본 실루엣·비율 유지 + 접촉 그림자
export function drawBib(ctx, fit, product, opacity, image) {
  ctx.save();
  ctx.translate(fit.x, fit.y);
  ctx.rotate(fit.rotation);
  ctx.globalAlpha = opacity * fit.confidence;

  if (image?.complete && image.naturalWidth > 0) {
    const { layer, layerH } = renderBibLayer(image, fit.width, fit.height, fit.yaw);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(layer, -fit.width / 2, -layerH / 2, fit.width, layerH);
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
