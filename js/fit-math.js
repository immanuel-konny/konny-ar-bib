// 랜드마크 → 착용 핏 계산 (v15 알고리즘 이식)
// fit = { x, y, width, height, rotation, yaw, pitch, confidence } (픽셀 좌표계)

import { BIB_ASPECT, FACE_OVAL } from './config.js';

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// 일부 기기에서 GPU 그래프가 실패한 프레임에 NaN 랜드마크를 반환한다.
// NaN이 한 번 핏에 들어오면 모든 후속 보간이 NaN으로 오염되므로,
// 핏은 반드시 유한값 검증을 통과해야 한다.
export const isFiniteFit = (f) =>
  !!f &&
  [f.x, f.y, f.width, f.height, f.rotation, f.yaw, f.pitch, f.confidence].every(
    Number.isFinite,
  );

// 유한하지만 비현실적인 값도 차단한다. 실기기에서 GPU가 부분 실패한 프레임이
// x=-1.17e24 같은 값을 반환한 사례가 있다 — 유한하므로 isFiniteFit는 통과한다.
// 프레임 크기를 기준으로 물리적으로 가능한 범위인지 함께 검사한다.
export const isPlausibleFit = (f, videoWidth, videoHeight) =>
  isFiniteFit(f) &&
  f.width > videoWidth * 0.05 &&
  f.width < videoWidth * 3 &&
  f.height > 0 &&
  f.height < videoHeight * 3 &&
  Math.abs(f.x) < videoWidth * 3 &&
  Math.abs(f.y) < videoHeight * 3;

// 어깨선 각도 정규화: ±90°로 접고, 미세 각도(π/240)는 무시,
// 0.82 게인으로 완화한 뒤 최대 ±16°(π/11.25)로 제한한다.
export function normalizeRotation(angle) {
  let a = angle;
  while (a > Math.PI / 2) a -= Math.PI;
  while (a < -Math.PI / 2) a += Math.PI;
  const deadzone = Math.PI / 240;
  if (Math.abs(a) <= deadzone) return 0;
  // Spark AR은 머리 롤을 거의 그대로 따라간다 — 게인 0.9, 최대 ±22.5°
  return clamp(
    (Math.abs(a) - deadzone) * Math.sign(a) * 0.9,
    -Math.PI / 8,
    Math.PI / 8,
  );
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// 최근 N프레임 핏의 성분별 중앙값 — 순간적인 좌표 튐 제거
export function medianFit(fits) {
  return {
    x: median(fits.map((f) => f.x)),
    y: median(fits.map((f) => f.y)),
    width: median(fits.map((f) => f.width)),
    height: median(fits.map((f) => f.height)),
    rotation: median(fits.map((f) => f.rotation)),
    yaw: median(fits.map((f) => f.yaw)),
    pitch: median(fits.map((f) => f.pitch)),
    confidence: median(fits.map((f) => f.confidence)),
  };
}

// 포즈 핏 + 얼굴 핏 융합 — 얼굴(턱) 기준 우선.
// Spark AR 실구동 참고: 턱받이는 턱 바로 아래·얼굴 중심에 붙어야 착용감이 난다.
// 어깨 중심은 좌우 비대칭·호흡 움직임 때문에 치우침과 흘러내림을 만든다.
// 포즈는 몸 회전(yaw)·기울기 보조와 얼굴 소실 시 폴백으로만 쓴다.
// 해부학 모델(v12): 턱받이는 "몸통에 입는" 제품이다.
// - x·회전·yaw(원근): 몸통(어깨) 우선 — 고개만 돌리거나 기울여도 원단은
//   가슴 위에 남고 어깨선을 따라야 한다. 얼굴 우선이던 v10-11에서는 측면
//   자세에서 턱받이가 몸통을 벗어나 배경까지 침범했다.
// - y: 턱 기준 유지 (몸통 y는 폰을 낮게 든 자세에서 흘러내림 유발 — v8 검증)
// - 얼굴 소실 시 폴백과 치우침 방지는 median+stop-lock 필터가 담당.
export function fuseFits(pose, face) {
  const width = pose.width * 0.15 + face.width * 0.85;
  return {
    x: pose.x * 0.55 + face.x * 0.45,
    // y: 턱 60% + 어깨 40% 블렌드 후 턱 기준 창으로 클램프.
    // 어깨선은 목 길이에 자동 적응하지만, 폰을 낮게 들면 어깨가 깊어져
    // 원단이 가슴까지 처지는 사례(2026-08-20 영상) — 창이 양방향 한계를 보장:
    // 위로는 인후를 덮지 않고, 아래로는 목 밑동에서 크게 떨어지지 않는다.
    y: clamp(
      face.y * 0.6 + pose.y * 0.4,
      face.y - face.height * 0.06,
      face.y + face.height * 0.42,
    ),
    width,
    height: width * BIB_ASPECT,
    rotation: pose.rotation * 0.7 + face.rotation * 0.3,
    yaw: clamp(pose.yaw * 0.7 + face.yaw * 0.3, -1, 1),
    pitch: face.pitch,
    confidence: Math.max(pose.confidence, face.confidence),
  };
}

const toPixel = (landmark, width, height, mirrored) => ({
  x: (mirrored ? 1 - landmark.x : landmark.x) * width,
  y: landmark.y * height,
});

// Pose Landmarker(33점) → 핏. 11/12 어깨, 9/10 입꼬리 기준.
export function poseToFit(landmarks, videoWidth, videoHeight, mirrored) {
  const ls = landmarks[11];
  const rs = landmarks[12];
  const lm = landmarks[9];
  const rm = landmarks[10];
  if (!ls || !rs || !lm || !rm) return null;

  const visibility = Math.min(ls.visibility ?? 1, rs.visibility ?? 1);
  if (visibility < 0.32) return null;

  const mapX = (x) => (mirrored ? 1 - x : x) * videoWidth;
  const left = { x: mapX(ls.x), y: ls.y * videoHeight };
  const right = { x: mapX(rs.x), y: rs.y * videoHeight };
  const mouthMid = {
    x: (mapX(lm.x) + mapX(rm.x)) / 2,
    y: ((lm.y + rm.y) / 2) * videoHeight,
  };

  const shoulderDist = Math.hypot(right.x - left.x, right.y - left.y);
  if (shoulderDist < videoWidth * 0.12) return null;

  const shoulderMid = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
  const first = left.x <= right.x ? left : right;
  const second = left.x <= right.x ? right : left;

  const width = clamp(shoulderDist * 0.8, videoWidth * 0.24, videoWidth * 0.72);
  const height = width * BIB_ASPECT;
  // 목 앵커: 입 중심에서 어깨 중심으로 72% 지점
  const anchorY = mouthMid.y + (shoulderMid.y - mouthMid.y) * 0.72;
  const tilt = Math.atan2(second.y - first.y, second.x - first.x);

  // 좌우 어깨의 z(깊이) 차이로 몸 회전(yaw) 추정
  const normDist = Math.max(0.08, Math.hypot(rs.x - ls.x, rs.y - ls.y));
  const zDiff = ((rs.z ?? 0) - (ls.z ?? 0)) / normDist;
  const yaw = clamp((mirrored ? -zDiff : zDiff) * 0.85, -1, 1);

  const fit = {
    x: shoulderMid.x * 0.76 + mouthMid.x * 0.24,
    y: anchorY + height * 0.28,
    width,
    height,
    rotation: normalizeRotation(tilt),
    yaw,
    pitch: 0,
    confidence: clamp(visibility * 1.35, 0.5, 1),
  };
  return isPlausibleFit(fit, videoWidth, videoHeight) ? fit : null;
}

// Face Landmarker(478점) → 핏. 1 코끝, 152 턱끝, 33/263 눈꼬리, 234/454 귀 옆.
export function faceToFit(landmarks, videoWidth, videoHeight, mirrored) {
  if ([1, 33, 152, 234, 263, 454].some((i) => !landmarks[i])) return null;

  const nose = toPixel(landmarks[1], videoWidth, videoHeight, mirrored);
  const chin = toPixel(landmarks[152], videoWidth, videoHeight, mirrored);
  const eyeL = toPixel(landmarks[33], videoWidth, videoHeight, mirrored);
  const eyeR = toPixel(landmarks[263], videoWidth, videoHeight, mirrored);
  const earL = toPixel(landmarks[234], videoWidth, videoHeight, mirrored);
  const earR = toPixel(landmarks[454], videoWidth, videoHeight, mirrored);

  const eyeFirst = eyeL.x <= eyeR.x ? eyeL : eyeR;
  const eyeSecond = eyeL.x <= eyeR.x ? eyeR : eyeL;
  const earFirst = earL.x <= earR.x ? earL : earR;
  const earSecond = earL.x <= earR.x ? earR : earL;

  const earDist = Math.hypot(earSecond.x - earFirst.x, earSecond.y - earFirst.y);
  if (earDist < videoWidth * 0.07) return null;

  const earMidX = (earFirst.x + earSecond.x) / 2;
  const halfEar = Math.max(earDist / 2, 1);
  const yaw = clamp(((nose.x - earMidX) / halfEar) * 1.25, -1, 1);

  const eyeY = (eyeFirst.y + eyeSecond.y) / 2;
  const faceSpan = Math.max(1, chin.y - eyeY);
  const pitch = clamp(((nose.y - eyeY) / faceSpan - 0.5) * 2.1, -0.65, 0.65);

  // Spark AR 실측: 최종 턱받이 폭 ≈ 귀 간격의 1.7배 (계수 1.26 역산).
  // 고개를 돌리면 귀 간격이 원근으로 수축하므로 yaw² 항으로 보상해
  // 측면에서 턱받이가 갑자기 작아지지 않게 한다.
  // 상한 0.58w: 근접 시 화면을 다 덮는 폭주 방지 (렌더 기준 약 75%).
  const width = clamp(
    earDist * 1.26 * (1 + 0.3 * yaw * yaw),
    videoWidth * 0.25,
    videoWidth * 0.58,
  );
  const height = width * BIB_ASPECT;
  const rotation = normalizeRotation(
    Math.atan2(eyeSecond.y - eyeFirst.y, eyeSecond.x - eyeFirst.x),
  );

  const fit = {
    x: earMidX + yaw * earDist * 0.04,
    // 목이 보이지 않도록 턱에 바짝 밀착 (Spark AR 참고 이미지 기준).
    // 기본배율 1.3 곱하면 상단이 턱선 위로 ~33% 겹치고, 겹친 부분은
    // 얼굴 가림 마스크가 지워 "턱 밑으로 들어간" 착용감이 된다.
    // pitch 보정: 고개를 숙이면 턱만 내려가고 목 밑동은 그대로이므로,
    // 내려간 턱만큼 앵커를 당겨 턱받이가 가슴으로 밀려나지 않게 한다.
    // 기준점 -0.35 = 중립 정면 실측값(코끝이 눈-턱 스팬의 33% 지점) —
    // 정면에서는 보정이 0이라 밀착 캘리브레이션이 변하지 않는다.
    y: chin.y + height * (0.40 - clamp(pitch - -0.35, -0.5, 0.35) * 0.15),
    width,
    height,
    rotation,
    yaw,
    pitch,
    confidence: 0.94,
  };
  return isPlausibleFit(fit, videoWidth, videoHeight) ? fit : null;
}

// 얼굴 윤곽 → 가림 마스크 폴리곤 (턱·목이 턱받이 앞에 보이도록)
export function faceOcclusionMask(landmarks, videoWidth, videoHeight, mirrored) {
  if (!landmarks[10] || !landmarks[152] || !landmarks[234] || !landmarks[454]) {
    return null;
  }
  const oval = FACE_OVAL.map((i) =>
    toPixel(landmarks[i], videoWidth, videoHeight, mirrored),
  );
  if (!oval.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return null;

  // 퇴화된 랜드마크(점들이 한곳에 뭉친 경우 등)로 만들어진 마스크는
  // 얼굴이 아닌 엉뚱한 영역을 지워 턱받이가 잘려 보이게 만든다.
  // 윤곽이 얼굴이라 볼 만한 크기인지 확인한다.
  const xs = oval.map((p) => p.x);
  const ys = oval.map((p) => p.y);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  if (spanX < videoWidth * 0.06 || spanY < videoHeight * 0.05) return null;
  if (spanX > videoWidth * 1.2 || spanY > videoHeight * 1.2) return null;

  return { oval, neck: [] };
}

// 포즈 단독 핏에 "포즈→융합" 보정량을 적용해 소스 전환 시 위치가 튀지 않게 한다.
// 얼굴 추적이 느려져(CPU 폴백 등) 융합↔포즈가 번갈아 선택되면, 두 방식의
// 체계적 위치 차이가 그대로 화면 점프로 나타나기 때문이다.
export function applyFusionOffset(poseFit, offset) {
  if (!offset) return poseFit;
  const width = poseFit.width * offset.widthRatio;
  return {
    ...poseFit,
    x: poseFit.x + poseFit.width * offset.dxRatio,
    y: poseFit.y + poseFit.height * offset.dyRatio,
    width,
    height: width * BIB_ASPECT,
  };
}

// 융합 결과와 포즈 단독 결과의 상대 차이 (프레임 크기에 무관하도록 비율로 저장)
export function measureFusionOffset(poseFit, fusedFit) {
  if (!poseFit || !fusedFit || poseFit.width <= 0 || poseFit.height <= 0) return null;
  return {
    dxRatio: (fusedFit.x - poseFit.x) / poseFit.width,
    dyRatio: (fusedFit.y - poseFit.y) / poseFit.height,
    widthRatio: fusedFit.width / poseFit.width,
  };
}

// 가림 마스크 시간 보간 (0.38 lerp) — 윤곽 떨림 완화
export function smoothMask(prev, next) {
  if (
    !prev ||
    prev.oval.length !== next.oval.length ||
    prev.neck.length !== next.neck.length
  ) {
    return next;
  }
  const t = 0.38;
  const lerpPoints = (a, b) =>
    a.map((p, i) => ({ x: p.x + (b[i].x - p.x) * t, y: p.y + (b[i].y - p.y) * t }));
  return { oval: lerpPoints(prev.oval, next.oval), neck: lerpPoints(prev.neck, next.neck) };
}
