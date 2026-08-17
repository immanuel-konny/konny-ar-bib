// 랜드마크 → 착용 핏 계산 (v15 알고리즘 이식)
// fit = { x, y, width, height, rotation, yaw, pitch, confidence } (픽셀 좌표계)

import { BIB_ASPECT, FACE_OVAL } from './config.js';

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

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

  return {
    x: shoulderMid.x * 0.76 + mouthMid.x * 0.24,
    y: anchorY + height * 0.28,
    width,
    height,
    rotation: normalizeRotation(tilt),
    yaw,
    pitch: 0,
    confidence: clamp(visibility * 1.35, 0.5, 1),
  };
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

  return {
    x: earMidX + yaw * earDist * 0.04,
    y: chin.y + height * 0.34,
    width,
    height,
    rotation,
    yaw,
    pitch,
    confidence: 0.94,
  };
}

// 얼굴 윤곽 → 가림 마스크 폴리곤 (턱·목이 턱받이 앞에 보이도록)
export function faceOcclusionMask(landmarks, videoWidth, videoHeight, mirrored) {
  if (!landmarks[10] || !landmarks[152] || !landmarks[234] || !landmarks[454]) {
    return null;
  }
  return {
    oval: FACE_OVAL.map((i) => toPixel(landmarks[i], videoWidth, videoHeight, mirrored)),
    neck: [],
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
