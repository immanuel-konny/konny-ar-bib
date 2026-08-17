// 착용 위치 안정화 (v15 이식)
// 1단계 applyStopLock: 정지 잠금 — 임계값 이하 변화는 무시, 넘을 때만 적응형 게인으로 이동
// 2단계 smoothTimed: 시간 기반 지수 보간 — 렌더 프레임마다 부드럽게 목표를 따라감

import { clamp } from './fit-math.js';
import { BIB_ASPECT } from './config.js';

export function applyStopLock(prev, next) {
  if (!prev) return next;

  const norm = Math.max(next.width, 1);
  const posDelta = Math.hypot(next.x - prev.x, next.y - prev.y) / norm;

  // 큰 점프도 스냅하지 않고 아래의 이동량 제한에 맡긴다. 오인식 한 프레임이
  // 그대로 반영되면 화면이 튀기 때문이다. 추적을 완전히 잃은 뒤의 재획득은
  // 호출부에서 lockedFit을 비워 처리한다(prev === null → next 그대로 채택).
  const sizeDelta = Math.abs(next.width - prev.width) / norm;
  const rotDelta = Math.abs(next.rotation - prev.rotation);
  const yawDelta = Math.abs(next.yaw - prev.yaw);

  // 임계값: 위치 1.1%, 크기 1.8%, 각도 1.2° — 이하면 게인 0으로 고정 유지.
  // (정지 잠금은 유지하되 움직임 인식은 더 민감하게)
  const posMoved = posDelta >= 0.011;
  const sizeMoved = sizeDelta >= 0.018;
  const rotMoved = rotDelta >= Math.PI / 150;

  const posGain = posMoved ? clamp(0.45 + posDelta * 1.6, 0.45, 0.88) : 0;
  const sizeGain = sizeMoved ? clamp(0.32 + sizeDelta, 0.32, 0.6) : 0;
  const rotGain = rotMoved ? clamp(0.3 + rotDelta * 2, 0.3, 0.5) : 0;
  const yawGain = yawDelta > 0.035 ? clamp(0.3 + yawDelta * 0.55, 0.3, 0.55) : 0;

  // 큰 오인식이 튀지 않도록 프레임당 이동량 제한 (위치 12%, 크기 10%)
  const maxMove = norm * 0.12;
  const maxGrow = norm * 0.1;
  const dx = clamp(next.x - prev.x, -maxMove, maxMove);
  const dy = clamp(next.y - prev.y, -maxMove, maxMove);
  const dw = clamp(next.width - prev.width, -maxGrow, maxGrow);

  return {
    x: prev.x + dx * posGain,
    y: prev.y + dy * posGain,
    width: prev.width + dw * sizeGain,
    height: prev.height + (next.height - prev.height) * sizeGain,
    rotation: prev.rotation + (next.rotation - prev.rotation) * rotGain,
    yaw: prev.yaw + (next.yaw - prev.yaw) * yawGain,
    pitch: prev.pitch + (next.pitch - prev.pitch) * yawGain,
    confidence: Math.max(prev.confidence, next.confidence, 0.88),
  };
}

export function smoothTimed(prev, target, deltaMs) {
  if (!prev) return target;

  const dt = clamp(deltaMs, 4, 40) / 1000;
  const speed = Math.hypot(target.x - prev.x, target.y - prev.y) / Math.max(target.width, 1);


  // 움직임이 클수록 위치 응답 속도 상승 (24→최대 42).
  // 정지 시 떨림은 위 정지 잠금이 막으므로, 추종 속도는 높여도 안전하다.
  const posAlpha = 1 - Math.exp(-(24 + Math.min(speed, 0.55) * 32) * dt);
  const sizeAlpha = 1 - Math.exp(-17 * dt);
  const rotAlpha = 1 - Math.exp(-14 * dt);
  const angleAlpha = 1 - Math.exp(-11 * dt);
  const confAlpha = 1 - Math.exp(-14 * dt);

  // 목표에 충분히 가까우면 스냅해 잔떨림(오버슈트) 방지
  const posSnap = Math.max(0.75, target.width * 0.0015);
  const sizeSnap = Math.max(0.6, target.width * 0.0012);
  const rotSnap = Math.PI / 720;

  const x = prev.x + (target.x - prev.x) * posAlpha;
  const y = prev.y + (target.y - prev.y) * posAlpha;
  const width = prev.width + (target.width - prev.width) * sizeAlpha;
  const height = prev.height + (target.height - prev.height) * sizeAlpha;
  const rotation = prev.rotation + (target.rotation - prev.rotation) * rotAlpha;

  return {
    x: Math.abs(target.x - x) < posSnap ? target.x : x,
    y: Math.abs(target.y - y) < posSnap ? target.y : y,
    width: Math.abs(target.width - width) < sizeSnap ? target.width : width,
    height:
      Math.abs(target.height - height) < sizeSnap * BIB_ASPECT ? target.height : height,
    rotation: Math.abs(target.rotation - rotation) < rotSnap ? target.rotation : rotation,
    yaw: prev.yaw + (target.yaw - prev.yaw) * angleAlpha,
    pitch: prev.pitch + (target.pitch - prev.pitch) * angleAlpha,
    confidence: prev.confidence + (target.confidence - prev.confidence) * confAlpha,
  };
}
