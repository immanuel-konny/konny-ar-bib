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
  return clamp(
    (Math.abs(a) - deadzone) * Math.sign(a) * 0.82,
    -Math.PI / 11.25,
    Math.PI / 11.25,
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

// 포즈 핏 + 얼굴 핏 융합 — 위치는 포즈(어깨) 우선, 세로·yaw는 얼굴 우선
export function fuseFits(pose, face) {
  const width = pose.width * 0.58 + face.width * 0.42;
  return {
    x: pose.x * 0.62 + face.x * 0.38,
    y: pose.y * 0.42 + face.y * 0.58,
    width,
    height: width * BIB_ASPECT,
    rotation: pose.rotation * 0.58 + face.rotation * 0.42,
    yaw: clamp(pose.yaw * 0.3 + face.yaw * 0.7, -1, 1),
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

  const width = clamp(earDist * 1.38, videoWidth * 0.25, videoWidth * 0.74);
  const height = width * BIB_ASPECT;
  const rotation = normalizeRotation(
    Math.atan2(eyeSecond.y - eyeFirst.y, eyeSecond.x - eyeFirst.x),
  );

  const fit = {
    x: earMidX + yaw * earDist * 0.04,
    y: chin.y + height * 0.34,
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
