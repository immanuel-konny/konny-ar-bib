// 코니 턱받이 AR 가상착용 — 앱 본체
// v15(ChatGPT 베타) 추적·합성 파이프라인 + Meta 안경 트라이온 스타일 UI

import {
  PRODUCTS,
  BIB_ASPECT,
  FIT_DEFAULTS,
  DETECT,
  MOBILE_QUERY,
  STATUS_MESSAGES,
} from './config.js?v37';
import {
  poseToFit,
  faceToFit,
  faceOcclusionMask,
  smoothMask,
  fuseFits,
  medianFit,
  isFiniteFit,
  isPlausibleFit,
  applyFusionOffset,
  measureFusionOffset,
} from './fit-math.js?v37';
import { applyStopLock, smoothTimed } from './stabilizer.js?v37';
import {
  drawBib,
  eraseMaskArea,
  drawBeautyLight,
} from './renderer.js?v37';
import { createPoseLandmarker, createFaceLandmarker, createImageSegmenter } from './engine.js?v37';
import { SEG_MODEL_LITE_URL } from './config.js?v37';

// 빌드 버전 — index.html의 ?v= 캐시버스팅과 함께 올린다.
// ?debug=1 HUD 첫 줄과 콘솔, __vtoDiag()에 표시되어 "지금 어떤 버전인지" 즉시 확인 가능.
const APP_VERSION = 'v37';

const $ = (id) => document.getElementById(id);

const els = {
  overlay: $('vto-overlay'),
  stage: $('stage'),
  video: $('video'),
  backdrop: $('video-backdrop'),
  photoView: $('photo-view'),
  canvas: $('canvas'),
  loader: $('loader'),
  statusBadge: $('status-badge'),
  statusText: $('status-text'),
  hint: $('mobile-hint'),
  heroMessage: $('hero-message'),
  heroDot: $('hero-dot'),
  openCameraBtns: [...document.querySelectorAll('[data-action="open-camera"]')],
  photoInputs: [...document.querySelectorAll('input[data-action="photo-input"]')],
  captureBtns: [...document.querySelectorAll('[data-action="capture"]')],
  flipBtns: [...document.querySelectorAll('[data-action="flip"]')],
  closeBtns: [...document.querySelectorAll('[data-action="close"]')],
  beautyBtns: [...document.querySelectorAll('[data-action="beauty"]')],
  resetBtns: [...document.querySelectorAll('[data-action="reset"]')],
  autoTrack: $('auto-track'),
  scale: $('range-scale'),
  offsetX: $('range-x'),
  offsetY: $('range-y'),
  opacity: $('range-opacity'),
  scaleOut: $('out-scale'),
  offsetXOut: $('out-x'),
  offsetYOut: $('out-y'),
  opacityOut: $('out-opacity'),
  fxLight: $('fx-light'), fxLightOut: $('out-fx-light'),
  fxAngle: $('fx-angle'), fxAngleOut: $('out-fx-angle'),
  fxFlutter: $('fx-flutter'), fxFlutterOut: $('out-fx-flutter'),
  fxBright: $('fx-bright'), fxBrightOut: $('out-fx-bright'),
  fxSat: $('fx-sat'), fxSatOut: $('out-fx-sat'),
  guideModal: $('guide-modal'),
  guideOpen: $('guide-open'),
  guideClose: $('guide-close'),
};

const state = {
  mode: 'idle', // idle | camera | photo
  status: 'idle',
  facing: 'user',
  mirrored: true,
  beauty: true,
  autoTrack: true,
  adjust: { ...FIT_DEFAULTS },
  fx: { light: 1, angle: -35, flutter: 1, bright: 1, sat: 1 }, // 표현 조정
  product: PRODUCTS[0],
};
// 기본값은 사용자가 슬라이더로 확정한 세팅 (2026-08-20): 조명 160%/정면 위,
// 채도 135%, 찰랑거림 200% — 모바일(패널 없음)에도 동일 적용된다.
const FX_DEFAULTS = { light: 1.6, angle: 0, flutter: 2, bright: 1, sat: 1.35 };

// ── 추적 내부 상태 ─────────────────────────────────────────────
let poseLandmarker = null;
let faceLandmarker = null;
let stream = null;
let rafId = null;
let analyzeCanvas = null;
let bibImage = null;
// 노멀맵 기반 방향별 리라이팅 변형 (좌광/상광/우광) — 캔버스 2D에는 셰이더가
// 없으므로 오프라인에서 높이맵(주름+직조+가장자리 라운딩)→노멀맵→N·L 셰이딩을
// 구운 3장을 조명 방향에 따라 실시간 블렌딩한다. 결과: 조명 각도를 돌리거나
// 몸이 움직이면 원단의 결·주름이 픽셀 단위로 빛에 반응.
let bibLit = null; // { left, top, right } — 3장 모두 로드되면 활성
let litCanvas = null;
let litKey = '';

function getLitBibSource(fit) {
  if (!bibLit) return null;
  const ang = ((fit.fxAngle ?? state.fx.angle) * Math.PI) / 180;
  // 정적 각도 + 동적 광각(몸 회전·스윙·이동)을 합쳐 수평 성분을 만든다
  const h = Math.max(-1, Math.min(1, Math.sin(ang) + (fit.lightYaw ?? 0) * 0.55));
  const w = Math.abs(h) * Math.min(1, fit.fxLight ?? state.fx.light);
  const key = `${Math.round(h * 24)}|${Math.round(w * 24)}`;
  if (litKey !== key) {
    const base = bibLit.top;
    litCanvas ??= document.createElement('canvas');
    if (litCanvas.width !== base.naturalWidth) {
      litCanvas.width = base.naturalWidth;
      litCanvas.height = base.naturalHeight;
    }
    const c = litCanvas.getContext('2d');
    c.clearRect(0, 0, litCanvas.width, litCanvas.height);
    c.globalAlpha = 1;
    c.drawImage(base, 0, 0);
    if (w > 0.02) {
      c.globalAlpha = Math.min(1, w);
      c.drawImage(h < 0 ? bibLit.left : bibLit.right, 0, 0);
      c.globalAlpha = 1;
    }
    litKey = key;
  }
  return litCanvas;
}
let photoUrl = null;
let isMobileSession = false;
let autoStarted = false;

let watchdogId = null; // rAF 정지 감시 타이머
let renderedFit = null; // 화면에 그려지는 보간된 핏
let lockedFit = null; // 정지 잠금을 통과한 목표 핏
let lastPose = null; // { fit, ts }
let lastFace = null; // { fit, ts }
let mask = null; // 얼굴 가림 폴리곤
let maskTs = 0; // 마스크 갱신 시각 (오래되면 잘못된 위치를 지우므로 무효화)
let fusionOffset = null; // 포즈 단독 → 융합 보정량 (소스 전환 연속성)
let appearTs = 0; // 재획득 시각 (페이드인 시작점)
let fitRing = []; // 중앙값 필터 링버퍼
let lastSource = null;
let lastFitTs = 0;
let missCount = 0;
let lastPoseTs = 0;
let lastFaceTs = 0;
let lastFrameTs = 0;
let lastDetector = null; // 저 fps에서 얼굴이 포즈를 굶기지 않도록 교차 실행에 사용

// ── 적응형 폴백 상태 ──────────────────────────────────────────
// 일부 모바일 기기에서 특정 입력(다운스케일 캔버스)·델리게이트(GPU) 조합의
// 감지가 실패하는 사례가 있다. "이번 카메라 세션에서 인식이 한 번도 성공하기
// 전"에만 5초 간격으로 조합을 순환하고, 한 번이라도 성공하면 그 조합으로
// 고정한다. (사용자가 늦게 프레임에 들어와도 엔진을 불필요하게 강등하지 않음)
const FALLBACK_STAGE_MS = 5000;
const FALLBACK_STAGES = [
  { input: 'downscale', delegate: 'GPU' }, // 모바일 기본
  { input: 'direct', delegate: 'GPU' }, // 데스크톱 기본
  { input: 'downscale', delegate: 'CPU' },
  { input: 'direct', delegate: 'CPU' },
];
let stageIndex = 1;
let analyzeMode = 'direct'; // 'downscale' | 'direct'
let delegatePref = 'GPU'; // 'GPU' | 'CPU'
let stageStartTs = 0; // 현재 스테이지 시작 시각
let lastSuccessTs = 0; // 이번 세션 마지막 인식 성공 시각 (0 = 아직 없음)
let hasEverDetected = false; // 이번 카메라 세션에서 인식 성공 여부
let escalating = false; // 델리게이트 재생성 중 (감지 일시 중지)

// ── 인물 세그멘테이션 상태 (배경·머리카락 정밀 가림) ─────────
// 로딩은 카메라 시작 후 백그라운드로 진행 — 준비 전/실패 시엔 v12 동작 유지.
let segmenter = null;
let segLoadStarted = false;
let segDisabled = false;
let segInputCanvas = null; // 전용 320px 입력 (감지 입력과 분리해 부하 절감)
let segKeepCanvas = null; // alpha=유지 영역(사람∧¬머리카락∧¬얼굴피부)
let segKeepTs = 0;
let segCostAvg = 0; // CPU 추론 시간 이동평균(ms) — 저사양 기기 자동 조절용
let segTier = 'multi'; // 'multi'(멀티클래스: 머리카락 채널) | 'lite'(바이너리: 경량)
let segSwapping = false;
let swayYaw = 0; // 이동 관성 스웨이 (속도 반응 원근)
let prevRenderX = null;
let prevRenderTs = 0;
// 찰랑거림(v33): 진자 스윙(목 축, 감쇠 스프링) + 밑단 리플 (모두 속도 반응)
let swingA = 0; // 스윙 각 (rad)
let swingV = 0;
let rippleAmp = 0;
let ripplePhase = 0;
let rawX = null; // 필터 이전 원시 감지 x — 안정화가 지운 움직임을 물리 구동에 사용
let rawVx = 0;
let prevRawX = null;
let prevRawTs = 0;
let clothMoving = false; // 데드밴드 히스테리시스 — 정지 노이즈로 꿈틀거리지 않게
let lastSegRunTs = 0;

// 얼굴 엔진만 GPU에서 실패하는 기기 대응. 예외를 던지는 경우뿐 아니라
// "예외 없이 계속 0개를 반환하는" 무증상 실패도 감지해 CPU로 재생성한다.
// (실기기에서 face:0/31 e0 상태가 10초 넘게 이어진 사례)
let faceForcedCpu = false;
let faceDowngrading = false;
let faceMissStreak = 0;

// ── 진단 (?debug=1 시 HUD 표시, window.__vtoDiag()는 항상 사용 가능) ──
const debugEnabled = new URLSearchParams(location.search).has('debug');
const diag = {
  engine: 'not-loaded',
  poseRuns: 0,
  poseHits: 0,
  poseErrors: 0,
  faceRuns: 0,
  faceHits: 0,
  faceErrors: 0,
  segRuns: 0,
  segErrors: 0,
  lastError: null,
  fps: 0,
};
let hudEl = null;
let hudLastUpdate = 0;
let fpsFrames = 0;
let fpsWindowStart = 0;

function updateHud(now) {
  if (!debugEnabled) return;
  fpsFrames += 1;
  if (now - fpsWindowStart >= 1000) {
    diag.fps = Math.round((fpsFrames * 1000) / (now - fpsWindowStart));
    fpsFrames = 0;
    fpsWindowStart = now;
  }
  if (now - hudLastUpdate < 400) return;
  hudLastUpdate = now;
  if (!hudEl) {
    hudEl = document.createElement('pre');
    hudEl.className = 'debug-hud';
    document.body.appendChild(hudEl);
  }
  const v = els.video;
  hudEl.textContent = [
    `${APP_VERSION} mode:${state.mode} status:${state.status} fps:${diag.fps}`,
    `engine:${diag.engine} delegate:${delegatePref} input:${analyzeMode} stage:${stageIndex}${hasEverDetected ? '*' : ''}`,
    `video:${v?.videoWidth ?? 0}x${v?.videoHeight ?? 0} mobile:${isMobileSession} seg:${segDisabled ? 'off' : segmenter ? `${segTier} ${diag.segRuns}r e${diag.segErrors} ${diag.segCost ?? 0}ms` : '-'}`,
    `pose:${diag.poseHits}/${diag.poseRuns} e${diag.poseErrors} face:${diag.faceHits}/${diag.faceRuns} e${diag.faceErrors}${faceForcedCpu ? ' faceCPU' : ''}`,
    `fit:${renderedFit ? `${Math.round(renderedFit.x)},${Math.round(renderedFit.y)} w${Math.round(renderedFit.width)}` : '-'} mask:${mask ? 'y' : 'n'}`,
    diag.lastError ? `err:${String(diag.lastError).replace(/\s+/g, ' ').slice(0, 72)}` : '',
  ].filter(Boolean).join('\n');
}

window.__vtoDiag = () => ({
  version: APP_VERSION,
  ...diag,
  mode: state.mode,
  status: state.status,
  analyzeMode,
  delegatePref,
  stageIndex,
  hasEverDetected,
  isMobileSession,
  video: { w: els.video?.videoWidth ?? 0, h: els.video?.videoHeight ?? 0 },
  renderedFit: renderedFit && {
    x: Math.round(renderedFit.x),
    y: Math.round(renderedFit.y),
    w: Math.round(renderedFit.width),
    conf: +renderedFit.confidence.toFixed(2),
  },
  hasMask: !!mask,
});

// ── 상태 표시 ─────────────────────────────────────────────────
function setStatus(status, message) {
  if (state.status !== status) {
    state.status = status;
    const badgeLabel =
      status === 'tracking' ? '착용 위치 인식됨' : status === 'loading' ? '준비 중' : '위치 찾는 중';
    els.statusBadge.className = `status-badge status-${status}`;
    els.statusBadge.querySelector('span').textContent = badgeLabel;
    els.loader.hidden = status !== 'loading';
    els.captureBtns.forEach((b) => (b.disabled = status !== 'tracking'));
    els.heroDot.className = `message-dot status-${status}`;
  }
  if (message) {
    els.statusText.textContent = message;
    els.hint.textContent = message;
    els.heroMessage.textContent = message;
  }
}

function setMode(mode) {
  state.mode = mode;
  const open = mode !== 'idle';
  els.overlay.hidden = !open;
  document.body.classList.toggle('vto-open', open);
  els.stage.classList.toggle('mode-camera', mode === 'camera');
  els.stage.classList.toggle('mode-photo', mode === 'photo');
  els.photoView.hidden = mode !== 'photo';
  const cameraVisible = mode === 'camera';
  els.video.style.visibility = cameraVisible ? 'visible' : 'hidden';
  els.backdrop.style.visibility = cameraVisible ? 'visible' : 'hidden';
}

// ── 핏 계산 헬퍼 ──────────────────────────────────────────────
function withAdjust(fit) {
  const a = state.adjust;
  return {
    ...fit,
    x: fit.x + fit.width * a.x,
    y: fit.y + fit.height * a.y,
    width: fit.width * a.scale,
    height: fit.height * a.scale,
  };
}

function syncCanvasSize(width, height) {
  const canvas = els.canvas;
  if (canvas && width && height && (canvas.width !== width || canvas.height !== height)) {
    canvas.width = width;
    canvas.height = height;
  }
}

// 모바일에서는 분석 입력을 최대 448px로 축소해 연산량·발열을 줄인다.
// (감지가 실패하는 기기에서는 폴백 체인이 direct로 전환)
function analyzeSource(video) {
  if (analyzeMode !== 'downscale') return video;
  const longest = Math.max(video.videoWidth, video.videoHeight);
  const ratio = Math.min(1, DETECT.analyzeMax / Math.max(longest, 1));
  // 짝수 치수 강제 — 일부 GPU의 image_transformation 노드가 홀수 폭에서 실패
  const w = Math.max(2, Math.round(video.videoWidth * ratio) & ~1);
  const h = Math.max(2, Math.round(video.videoHeight * ratio) & ~1);
  analyzeCanvas ??= document.createElement('canvas');
  if (analyzeCanvas.width !== w || analyzeCanvas.height !== h) {
    analyzeCanvas.width = w;
    analyzeCanvas.height = h;
  }
  analyzeCanvas.getContext('2d', { alpha: false })?.drawImage(video, 0, 0, w, h);
  return analyzeCanvas;
}

function renderFrame() {
  const canvas = els.canvas;
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!renderedFit) return;

  // 처음 나타날 때 툭 튀어나오지 않도록 350ms 페이드인
  const appearRamp = appearTs
    ? Math.min(1, (performance.now() - appearTs) / 350)
    : 1;
  // 이동 관성 스웨이: 좌우로 움직일 때 뒤따르는 쪽 원단이 살짝 눕는다.
  const nowRender = performance.now();
  if (prevRenderX !== null) {
    const dtMs = Math.max(8, nowRender - prevRenderTs);
    const vx = ((renderedFit.x - prevRenderX) / dtMs) * 1000;
    const target = Math.max(-0.2, Math.min(0.2, -vx * 0.0005));
    swayYaw += (target - swayYaw) * Math.min(1, dtMs / 200);
  }
  prevRenderX = renderedFit.x;
  prevRenderTs = nowRender;

  const drawFit = withAdjust(renderedFit);
  drawFit.yaw = Math.max(-1, Math.min(1, drawFit.yaw + swayYaw));

  // 진자 스윙: 좌우 이동을 입력으로 목(상단 중앙)을 축 삼아 흔들리고 감쇠 복원.
  // 회전+미소 평행이동뿐이라 실루엣은 보존된다.
  {
    const dtS = Math.min(0.05, Math.max(0.008, (nowRender - prevRenderTs) / 1000)) || 0.016;
    // 원시 감지 좌표의 속도 — 안정화 필터가 지우기 전의 실제 움직임.
    // (v33은 필터 후 속도를 써서 작은 움직임에 전혀 반응하지 못했다)
    if (rawX !== null) {
      if (prevRawX !== null && nowRender > prevRawTs) {
        const v = ((rawX - prevRawX) / Math.max(8, nowRender - prevRawTs)) * 1000;
        rawVx += (v - rawVx) * Math.min(1, dtS * 12); // 가벼운 저역필터
      }
      prevRawX = rawX;
      prevRawTs = nowRender;
    }
    // 데드밴드 + 히스테리시스: 정지 상태의 감지 노이즈(±수 px 지터)가
    // 속도로 오인돼 원단이 계속 꿈틀거리는 것("살아있는 문어") 방지.
    // 움직임 시작 판정 60px/s, 종료 판정 25px/s.
    if (!clothMoving && Math.abs(rawVx) > 60) clothMoving = true;
    else if (clothMoving && Math.abs(rawVx) < 25) clothMoving = false;
    const driveV = clothMoving ? rawVx : 0;

    const flut = state.fx.flutter;
    const force = Math.max(-5, Math.min(5, -driveV * 0.028 * flut));
    swingV += (-32 * swingA - 5.5 * swingV + force) * dtS;
    swingA += swingV * dtS;
    swingA = Math.max(-0.14, Math.min(0.14, swingA));
    if (!clothMoving) {
      // 정착: 잔진동 빠르게 흡수, 충분히 작아지면 스냅 0 → 원형 그대로
      swingV *= 1 - Math.min(1, dtS * 10);
      if (Math.abs(swingA) < 0.012 && Math.abs(swingV) < 0.08) {
        swingA = 0;
        swingV = 0;
      }
    }
    drawFit.rotation += swingA;
    drawFit.x -= (drawFit.height / 2) * swingA; // 목 축 회전 보정 (소각 근사)

    // 밑단 리플: 따라오는 동안만 출렁, 정착하면 위상까지 정지 → 완전 원형
    const speed = clothMoving ? Math.abs(driveV) + Math.abs(swingV) * 500 : 0;
    const targetAmp = clothMoving ? Math.min(0.05 * Math.min(flut, 1.6), speed * 0.0003 * flut) : 0;
    rippleAmp += (targetAmp - rippleAmp) * Math.min(1, dtS * (clothMoving ? 6 : 10));
    if (rippleAmp > 0.004) {
      ripplePhase += dtS * (8 + speed * 0.03);
    } else {
      rippleAmp = 0;
    }
    drawFit.rippleAmp = rippleAmp;
    drawFit.ripplePhase = ripplePhase;
    drawFit.sheenShift = swingA * 2.0;
    // 조명 각: 몸 회전 + 스윙 + 이동 속도
    drawFit.lightYaw = Math.max(-1, Math.min(1,
      drawFit.yaw + swingA * 2.6 + driveV * 0.0006));
    diag.cloth = clothMoving ? 1 : 0;
    drawFit.fxLight = state.fx.light;
    drawFit.fxAngle = state.fx.angle;
    drawFit.fxBright = state.fx.bright;
    drawFit.fxSat = state.fx.sat;
  }

  // 뒤판 레이어는 v30에서 제거 — 이중 스캘럽 테두리 아티팩트(사용자 확인).
  // Spark 레퍼런스의 목 옆 모습은 평면 이미지 + 높은 배치 + 얼굴 가림만으로
  // 만들어진다. 단순함이 정답.

  const bibSource = getLitBibSource(drawFit) ?? bibImage;
  drawBib(ctx, drawFit, state.product, state.adjust.opacity * appearRamp, bibSource);
  if (mask) eraseMaskArea(ctx, mask);
}

function resetTracking() {
  renderedFit = null;
  lockedFit = null;
  lastPose = null;
  lastFace = null;
  mask = null;
  maskTs = 0;
  fusionOffset = null;
  appearTs = 0;
  fitRing = [];
  lastSource = null;
  lastFitTs = 0;
  missCount = 0;
  lastPoseTs = 0;
  lastFaceTs = 0;
  lastFrameTs = 0;
  lastDetector = null;
  faceMissStreak = 0;
  segKeepTs = 0;
  lastSegRunTs = 0;
  swayYaw = 0;
  prevRenderX = null;
  swingA = 0;
  swingV = 0;
  rippleAmp = 0;
  rawX = null;
  prevRawX = null;
  rawVx = 0;
}

// ── 엔진 준비 ─────────────────────────────────────────────────
async function ensureEngines() {
  if (poseLandmarker) return poseLandmarker;
  setStatus('loading', STATUS_MESSAGES.loading);
  diag.engine = 'loading';
  poseLandmarker = await createPoseLandmarker(delegatePref);
  faceLandmarker = await createFaceLandmarker(delegatePref);
  diag.engine = faceLandmarker ? 'pose+face' : 'pose-only';
  loadSegmenterInBackground(); // 시작을 막지 않도록 비동기 (모델 ~16MB)
  return poseLandmarker;
}

// 세그멘터 백그라운드 로딩 — 모델(~16MB)이 커서 시작을 막지 않는다
function loadSegmenterInBackground() {
  if (segmenter || segLoadStarted || segDisabled) return;
  segLoadStarted = true;
  (async () => {
    try {
      // CPU 고정: 이 기기군에서 GPU 경로의 마스크 readback이 깨진 버퍼를
      // 반환한다(카테고리·컨피던스 모두 재현됨). 320px·140ms 주기라
      // CPU(XNNPACK)로도 충분히 가볍고, 버그 계열을 원천 회피한다.
      segmenter = await createImageSegmenter('CPU');
      if (segmenter) console.info('[ar] image segmenter ready (cpu)');
    } catch {
      segmenter = null;
    }
  })();
}

// 세그멘테이션 전용 축소 입력 (긴 변 segInputMax, 짝수 치수)
function segSource(video) {
  const longest = Math.max(video.videoWidth, video.videoHeight);
  const ratio = Math.min(1, DETECT.segInputMax / Math.max(longest, 1));
  const w = Math.max(2, Math.round(video.videoWidth * ratio) & ~1);
  const h = Math.max(2, Math.round(video.videoHeight * ratio) & ~1);
  segInputCanvas ??= document.createElement('canvas');
  if (segInputCanvas.width !== w || segInputCanvas.height !== h) {
    segInputCanvas.width = w;
    segInputCanvas.height = h;
  }
  segInputCanvas.getContext('2d', { alpha: false })?.drawImage(video, 0, 0, w, h);
  return segInputCanvas;
}

// 컨피던스 마스크 → 두 개의 마스크 캔버스.
// keep: 배경·머리카락·얼굴피부 제외(=원단이 있어도 되는 곳), 0.35~0.6 페더링.
// skin: 몸피부(목·손 등) 확률 — 렌더 시 "목 구역"에서만 원단을 걷어낸다.
// 실제 턱받이는 목을 감싸지 목 앞(인후)을 덮지 않으므로, 앵커가 조금 높아도
// 목이 항상 드러나 착용감이 유지된다. (맨살 가슴의 아기 케이스를 위해
// 피부 제거는 목 구역에 한정 — 전신 피부 제거 시 원단이 통째로 사라질 수 있음)
// 목 구역 피부 지우기는 v20에서 제거됨 — 사각 클립 경계가 원단에 직선 노치를
// 만들었다(PC 캡처 확인). 목 노출은 v19 적응형 앵커(턱+어깨 블렌드)가 담당한다.
function updateSegKeep(bgProb, hairProb, invert, w, h, ts) {
  segKeepCanvas ??= document.createElement('canvas');
  if (segKeepCanvas.width !== w || segKeepCanvas.height !== h) {
    segKeepCanvas.width = w;
    segKeepCanvas.height = h;
  }
  const ctx = segKeepCanvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  const px = img.data;
  let kept = 0;
  for (let i = 0; i < bgProb.length; i++) {
    // 배경+머리카락만 제거. 얼굴피부 채널은 맨살 목·가슴을 오분류해
    // 원단을 침식했다(2026-08-20 영상) — 얼굴은 랜드마크 오벌 마스크가 담당.
    // invert: 바이너리 selfie 모델은 마스크 1장이 '사람(전경)' 확률이므로 반전.
    const remove = (invert ? 1 - bgProb[i] : bgProb[i]) + (hairProb ? hairProb[i] : 0);
    let a = 0;
    if (remove <= 0.35) a = 255;
    else if (remove < 0.6) a = Math.round(((0.6 - remove) / 0.25) * 255);
    if (a > 0) {
      px[i * 4 + 3] = a;
      if (a > 128) kept++;
    }
  }
  // 사람이 거의 안 잡힌 프레임(오검출)은 채택하지 않는다 — 턱받이 전체 소실 방지
  if (kept < bgProb.length * 0.03) return false;

  // 손상 감지: 정상 인물 마스크는 행당 경계 전환이 몇 개뿐이다.
  // 깨진 버퍼(GPU readback 버그)는 노이즈라 전환이 수백 개 — 폐기한다.
  let flips = 0;
  const rows = 8;
  for (let r = 0; r < rows; r++) {
    const y = Math.floor(((r + 0.5) / rows) * h);
    let prev = px[(y * w) * 4 + 3] > 128;
    for (let x = 1; x < w; x++) {
      const cur = px[(y * w + x) * 4 + 3] > 128;
      if (cur !== prev) flips++;
      prev = cur;
    }
  }
  diag.segFlips = flips;
  if (flips / rows > 16) return false; // 마스크 손상 — 채택 거부

  ctx.putImageData(img, 0, 0);
  segKeepTs = ts;
  diag.segKeepRatio = +(kept / bgProb.length).toFixed(3);
  return true;
}

// 테스트 프로브: 표시 공간 정규화 좌표(0~1)의 세그 유지 알파를 반환
window.__vtoSegAt = (nx, ny) => {
  if (!segKeepCanvas || !segKeepTs) return null;
  const sx = state.mode === 'camera' && state.mirrored ? 1 - nx : nx;
  const x = Math.min(segKeepCanvas.width - 1, Math.max(0, Math.round(sx * segKeepCanvas.width)));
  const y = Math.min(segKeepCanvas.height - 1, Math.max(0, Math.round(ny * segKeepCanvas.height)));
  return segKeepCanvas.getContext('2d').getImageData(x, y, 1, 1).data[3];
};

// 얼굴 엔진만 GPU에서 반복 실패하면(예: image_transformation INVALID_ARGUMENT)
// 얼굴 엔진만 CPU로 재생성한다. 포즈는 건드리지 않는다.
function maybeDowngradeFace() {
  if (faceForcedCpu || faceDowngrading) return;
  // 예외 2회, 또는 포즈는 잡히는데 얼굴만 6회 연속 놓치는 무증상 실패
  const silentFailure = faceMissStreak >= 6 && diag.poseHits > 0;
  if (diag.faceErrors < 2 && !silentFailure) return;
  faceDowngrading = true;
  console.warn(
    `[ar] face landmarker → CPU 재생성 (errors:${diag.faceErrors} miss:${faceMissStreak})`,
  );
  (async () => {
    try {
      const next = await createFaceLandmarker('CPU');
      faceLandmarker?.close();
      faceLandmarker = next;
      faceForcedCpu = true;
      faceMissStreak = 0;
      diag.engine = `${diag.engine.split('+face')[0]}+face(cpu)`;
    } catch (e) {
      diag.lastError = `face-cpu: ${e?.message ?? e}`.replace(/\s+/g, ' ').slice(0, 72);
    } finally {
      faceDowngrading = false;
    }
  })();
}

// 첫 인식 성공 전까지만: 5초마다 다음 입력·델리게이트 조합으로 순환
function maybeEscalateFallback(now) {
  if (state.mode !== 'camera' || escalating || hasEverDetected) return;
  if (now - stageStartTs < FALLBACK_STAGE_MS) return;

  stageIndex = (stageIndex + 1) % FALLBACK_STAGES.length;
  const stage = FALLBACK_STAGES[stageIndex];
  stageStartTs = now;
  analyzeMode = stage.input;
  diag.lastError = null;
  console.warn(`[ar] fallback stage ${stageIndex}: ${stage.input}/${stage.delegate}`);

  if (stage.delegate === delegatePref) return;

  // 델리게이트 변경은 엔진 재생성 필요 — 재생성 동안 감지는 일시 중지
  escalating = true;
  const target = stage.delegate;
  (async () => {
    try {
      const nextPose = await createPoseLandmarker(target);
      const nextFace = await createFaceLandmarker(target);
      poseLandmarker?.close();
      faceLandmarker?.close();
      poseLandmarker = nextPose;
      faceLandmarker = nextFace;
      delegatePref = target;
      faceForcedCpu = target === 'CPU';
      diag.engine = `${nextFace ? 'pose+face' : 'pose-only'}/${target.toLowerCase()}`;
    } catch (e) {
      diag.lastError = `recreate(${target}): ${e?.message ?? e}`;
    } finally {
      escalating = false;
      stageStartTs = performance.now();
    }
  })();
}

// ── 메인 추적 루프 ────────────────────────────────────────────
// rAF 기본 + 워치독: rAF가 멈추는 환경(백그라운드 탭, 일부 웹뷰, 분할 화면)에서도
// 타이머로 루프를 이어가 추적이 죽지 않게 한다.
function scheduleLoop() {
  rafId = requestAnimationFrame(loop);
  clearTimeout(watchdogId);
  watchdogId = setTimeout(() => {
    if (state.mode !== 'camera') return;
    if (rafId) cancelAnimationFrame(rafId);
    loop();
  }, 120);
}

function loop() {
  clearTimeout(watchdogId);
  const video = els.video;
  if (!video || !poseLandmarker || video.readyState < 2) {
    scheduleLoop();
    return;
  }
  syncCanvasSize(video.videoWidth, video.videoHeight);

  const now = performance.now();
  const poseInterval = isMobileSession ? DETECT.poseInterval.mobile : DETECT.poseInterval.desktop;
  // 얼굴이 CPU로 내려간 기기에서는 추론이 느리므로 주기를 늘려 포즈를 굶기지 않는다
  const faceInterval =
    (isMobileSession ? DETECT.faceInterval.mobile : DETECT.faceInterval.desktop) *
    (faceForcedCpu ? 1.8 : 1);
  const poseDue = now - lastPoseTs >= poseInterval;
  // 포즈·얼굴 감지를 서로 다른 프레임에 배치해 프레임 스파이크 방지.
  // 얼굴이 크게 밀렸을 때는 포즈 차례를 뺏을 수 있지만, 직전에도 얼굴이
  // 실행됐다면 양보한다 — 저 fps(프레임 간격 > 133ms)에서 포즈 기아 방지.
  const faceDue =
    !!faceLandmarker &&
    now - lastFaceTs >= faceInterval &&
    (!poseDue ||
      (now - lastFaceTs > faceInterval * 1.45 && lastDetector !== 'face'));
  const runPose = poseDue && !faceDue;

  if ((runPose || faceDue) && !escalating) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    let input = null;
    try {
      input = analyzeSource(video);
    } catch (error) {
      diag.lastError = `input: ${error?.message ?? error}`;
    }

    // 포즈·얼굴을 각각 try로 감싼다 — 한쪽 엔진의 GPU 오류가
    // 다른 쪽 결과 처리와 융합 로직까지 죽이지 않도록.
    if (input && runPose) {
      lastPoseTs = now;
      lastDetector = 'pose';
      diag.poseRuns += 1;
      try {
        const landmarks = poseLandmarker.detectForVideo(input, now).landmarks?.[0];
        const fit = landmarks ? poseToFit(landmarks, vw, vh, state.mirrored) : null;
        if (fit) {
          lastPose = { fit, ts: now };
          diag.poseHits += 1;
        }
      } catch (error) {
        diag.poseErrors += 1;
        diag.lastError = `pose: ${error?.message ?? error}`.replace(/\s+/g, ' ').slice(0, 72);
      }
    }
    if (input && faceDue && faceLandmarker && !faceDowngrading) {
      lastFaceTs = now;
      lastDetector = 'face';
      diag.faceRuns += 1;
      try {
        // __vtoFailFace: 실기기의 얼굴 엔진 GPU 실패를 재현하는 테스트 훅
        if (window.__vtoFailFace) throw new Error('forced face failure (test hook)');
        const landmarks = faceLandmarker.detectForVideo(input, now).faceLandmarks?.[0];
        const fit = landmarks ? faceToFit(landmarks, vw, vh, state.mirrored) : null;
        // 목 지움 바닥 한계 = 그려질 턱받이 상단 + 높이 30% (직전 프레임 기준)
        let neckLimit = Infinity;
        if (renderedFit) {
          const rf = withAdjust(renderedFit);
          neckLimit = rf.y - rf.height / 2 + rf.height * 0.3;
        }
        const nextMask = landmarks
          ? faceOcclusionMask(landmarks, vw, vh, state.mirrored, neckLimit)
          : null;
        if (fit) {
          lastFace = { fit, ts: now };
          diag.faceHits += 1;
          faceMissStreak = 0;
        } else {
          faceMissStreak += 1;
          maybeDowngradeFace();
        }
        // 마스크는 핏이 유효할 때만 채택한다. 같은 랜드마크라도 마스크 쪽
        // 검증이 느슨해, 퇴화된 결과가 통과하면 턱받이 일부를 지워버린다.
        if (fit && nextMask) {
          mask = smoothMask(mask, nextMask);
          maskTs = now;
        }
      } catch (error) {
        diag.faceErrors += 1;
        diag.lastError = `face: ${error?.message ?? error}`.replace(/\s+/g, ' ').slice(0, 72);
        maybeDowngradeFace();
      }
    }

    const segInterval = Math.max(DETECT.segIntervalMs, segCostAvg * 3.5);
    if (
      segmenter && !segDisabled && !segSwapping && !faceDue &&
      state.mode === 'camera' &&
      now - lastSegRunTs >= segInterval
    ) {
      lastSegRunTs = now;
      diag.segRuns += 1;
      try {
        const segT0 = performance.now();
        const res = segmenter.segmentForVideo(segSource(video), now);
        const segDt = performance.now() - segT0;
        segCostAvg = segCostAvg ? segCostAvg * 0.7 + segDt * 0.3 : segDt;
        diag.segCost = Math.round(segCostAvg);
        // 저사양 기기 자동 조절: 추론이 느리면 주기가 늘고(아래 segInterval),
        // 매우 느리면 끈다. (저사양 PC에서 1회 300ms+가 fps를 2로 떨어뜨림)
        if (segCostAvg > 250 && diag.segRuns > 2 && segTier === 'multi' && !segSwapping) {
          // 멀티클래스가 느린 기기: 끄지 말고 경량 바이너리로 강등
          // (머리카락 채널은 잃지만 몸 실루엣 클리핑은 유지)
          segSwapping = true;
          const slowMs = Math.round(segCostAvg);
          (async () => {
            try {
              const lite = await createImageSegmenter('CPU', SEG_MODEL_LITE_URL);
              try { segmenter?.close(); } catch { /* 무시 */ }
              segmenter = lite;
              segTier = 'lite';
              segCostAvg = 0;
              console.warn('[ar] segmenter downgraded to lite (multi ' + slowMs + 'ms)');
            } catch {
              segDisabled = true;
              segmenter = null;
              segKeepTs = 0;
            } finally {
              segSwapping = false;
            }
          })();
        } else if (segCostAvg > 300 && diag.segRuns > 3 && segTier === 'lite') {
          segDisabled = true;
          try { segmenter.close(); } catch { /* 무시 */ }
          segmenter = null;
          segKeepTs = 0;
          console.warn('[ar] segmenter disabled: too slow (' + Math.round(segCostAvg) + 'ms)');
        }
        // 멀티클래스: [0]=배경, [1]=머리카락. 바이너리(lite): 마스크 1장 = 사람 확률.
        const masks = res?.confidenceMasks;
        if (masks?.length) {
          const bg = masks[0];
          const invert = masks.length === 1;
          const ok = updateSegKeep(
            bg.getAsFloat32Array(),
            !invert && segTier === 'multi' && masks.length > 1 ? masks[1].getAsFloat32Array() : null,
            invert,
            bg.width,
            bg.height,
            now,
          );
          if (ok === false && (diag.segFlips ?? 0) / 8 > 16) {
            // 손상 마스크 반복 → 기능 자체를 끈다 (원단 갉아먹힘 방지 우선)
            diag.segErrors += 1;
            if (diag.segErrors > 4) {
              segDisabled = true;
              try { segmenter.close(); } catch { /* 무시 */ }
              segmenter = null;
              segKeepTs = 0;
              console.warn('[ar] segmenter disabled: corrupted masks');
            }
          }
        }
        res.close();
      } catch (error) {
        diag.segErrors += 1;
        diag.lastError = `seg: ${error?.message ?? error}`.replace(/\s+/g, ' ').slice(0, 72);
        if (diag.segErrors > 4) {
          // 반복 실패 기기: 기능만 끄고 기본 동작 유지
          segDisabled = true;
          try { segmenter.close(); } catch { /* 무시 */ }
          segmenter = null;
        }
      }
    }

    const freshPose = lastPose && now - lastPose.ts < DETECT.poseFreshMs ? lastPose : null;
    const freshFace = lastFace && now - lastFace.ts < DETECT.faceFreshMs ? lastFace : null;

    // 소스 전환에 의한 위치 점프 제거:
    // 포즈+얼굴이 모두 신선하면 융합하고 그 보정량을 기록한다.
    // 얼굴이 끊기면 포즈 단독 결과에 마지막 보정량을 적용해 연속성을 유지한다.
    let merged = null;
    let source = null;
    if (freshPose && freshFace) {
      const fused = fuseFits(freshPose.fit, freshFace.fit);
      fusionOffset = measureFusionOffset(freshPose.fit, fused) ?? fusionOffset;
      merged = { fit: fused, ts: Math.max(freshPose.ts, freshFace.ts) };
      source = 'fusion';
    } else if (freshPose) {
      merged = { fit: applyFusionOffset(freshPose.fit, fusionOffset), ts: freshPose.ts };
      source = 'pose';
    } else if (freshFace) {
      merged = freshFace;
      source = 'face';
    }

    if (merged && isPlausibleFit(merged.fit, vw, vh)) {
      missCount = 0;
      hasEverDetected = true;
      lastSuccessTs = now;
      diag.lastError = null; // 정상 복구되면 이전 오류 표시를 지운다
      rawX = merged.fit.x; // 물리 구동용 원시 좌표 (필터 이전)
      if (merged.ts !== lastFitTs) {
        if (!lockedFit) appearTs = now; // 새로 잡힌 순간부터 페이드인
        // 포즈↔융합은 보정량으로 정렬되므로 링을 비우지 않는다.
        // 얼굴 단독은 기준이 달라 이때만 초기화한다.
        const familyOf = (s) => (s === 'face' ? 'face' : 'pose');
        if (familyOf(lastSource) !== familyOf(source)) fitRing = [];
        lastSource = source;
        lastFitTs = merged.ts;
        fitRing.push(merged.fit);
        if (fitRing.length > DETECT.medianWindow) fitRing.shift();
        lockedFit = applyStopLock(lockedFit, medianFit(fitRing));
      }
      // 너무 가까워 턱받이가 화면 아래로 벗어나면 안내 (추적은 유지)
      const adjusted = withAdjust(lockedFit ?? merged.fit);
      const bibTop = adjusted.y - adjusted.height / 2;
      const offscreen = bibTop > els.canvas.height * 0.88;
      setStatus(
        'tracking',
        offscreen ? STATUS_MESSAGES.tooClose : STATUS_MESSAGES.tracking,
      );
    } else {
      missCount += 1;
    }
    // 일시적 인식 끊김(2.5초 이내)에는 상태·투명도를 유지해 깜빡임 방지.
    // 그 이상 지속될 때만 '위치 찾는 중'으로 바꾸고 서서히 페이드아웃.
    // (프레임 수가 아닌 시간 기준 — 저 fps 기기에서도 동일하게 동작)
    if (now - lastSuccessTs > 2500) {
      setStatus('searching', STATUS_MESSAGES.searching);
      if (lockedFit) lockedFit.confidence *= DETECT.confidenceDecay;
      // 충분히 사라졌으면 완전히 버린다. 다음 인식은 새 기준으로 즉시 배치되어
      // 예전 위치에서 화면을 가로질러 미끄러져 오는 현상이 없어진다.
      if (!lockedFit || lockedFit.confidence < 0.35) {
        lockedFit = null;
        renderedFit = null;
        fitRing = [];
        lastSource = null;
      }
    }
  }
  if (state.mode === 'camera') maybeEscalateFallback(now);

  // 오염된 핏 자가 복구 — 유한하지 않거나 비현실적인 값이면 버리고 재획득
  if (lockedFit && !isPlausibleFit(lockedFit, els.canvas.width, els.canvas.height)) {
    lockedFit = null;
    renderedFit = null;
    fitRing = [];
  }

  // 오래된 가림 마스크는 실제 얼굴 위치와 어긋나 엉뚱한 곳을 지우므로 무효화
  if (mask && now - maskTs > 900) mask = null;

  const delta = lastFrameTs ? now - lastFrameTs : 16.7;
  lastFrameTs = now;
  if (state.autoTrack && lockedFit) {
    renderedFit = smoothTimed(renderedFit, lockedFit, delta);
  }
  renderFrame();
  updateHud(now);
  scheduleLoop();
}

// ── 카메라 제어 ───────────────────────────────────────────────
function stopStream() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  clearTimeout(watchdogId);
  watchdogId = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  if (els.video) els.video.srcObject = null;
  if (els.backdrop) els.backdrop.srcObject = null;
}

async function startCamera(facing = state.facing) {
  stopStream();
  clearPhoto();
  resetTracking();

  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');

    // __vtoForceMobile: 테스트에서 모바일 경로를 강제하기 위한 훅
    isMobileSession = window.__vtoForceMobile ?? window.matchMedia(MOBILE_QUERY).matches;
    // 데스크톱도 다운스케일 입력으로 시작 — 저사양 PC에서 원본 해상도
    // 추론이 fps를 2까지 떨어뜨린 사례(2026-08-19). 폴백 순환은 유지된다.
    stageIndex = 0;
    analyzeMode = FALLBACK_STAGES[stageIndex].input;
    hasEverDetected = false;
    lastSuccessTs = 0;
    stageStartTs = performance.now();
    diag.lastError = null;
    setMode('camera');
    setStatus('loading', STATUS_MESSAGES.permission);

    // 카메라 해상도 제약은 센서의 가로 방향 기준으로 지정하는 것이 웹 표준 동작.
    // 모바일은 가로 기준 4:3(1280×960)을 요청하고 실제 스트림 방향을 판별한다.
    const supported = navigator.mediaDevices.getSupportedConstraints();
    const mobileConstraints = {
      facingMode: { ideal: facing },
      width: { ideal: 1280 },
      height: { ideal: 960 },
      aspectRatio: { ideal: 4 / 3 },
      frameRate: { ideal: 24, max: 30 },
      ...(supported.resizeMode ? { resizeMode: 'none' } : {}),
    };
    const desktopConstraints = {
      facingMode: { ideal: facing },
      width: { ideal: 960 },
      height: { ideal: 1280 },
      frameRate: { ideal: 24, max: 30 },
    };

    const [, mediaStream] = await Promise.all([
      ensureEngines(),
      navigator.mediaDevices.getUserMedia({
        video: isMobileSession ? mobileConstraints : desktopConstraints,
        audio: false,
      }),
    ]);

    await poseLandmarker.setOptions({ runningMode: 'VIDEO' });
    await faceLandmarker?.setOptions({ runningMode: 'VIDEO' });
    await segmenter?.setOptions({ runningMode: 'VIDEO' });

    stream = mediaStream;
    state.facing = facing;
    state.mirrored = facing === 'user';
    els.video.classList.toggle('mirrored', state.mirrored);
    els.backdrop.classList.toggle('mirrored', state.mirrored);
    els.video.srcObject = mediaStream;
    els.backdrop.srcObject = mediaStream;

    // 지원 기기에서 카메라 줌을 최소값으로 → 기본 카메라와 유사한 넓은 화각
    if (isMobileSession) {
      const track = mediaStream.getVideoTracks()[0];
      try {
        const minZoom = track.getCapabilities?.()?.zoom?.min;
        if (typeof minZoom === 'number' && Number.isFinite(minZoom)) {
          await track.applyConstraints({ advanced: [{ zoom: minZoom }] });
        }
      } catch {
        /* zoom 미지원 무시 */
      }
    }

    await els.video.play();
    els.stage.classList.toggle('stream-portrait', els.video.videoHeight >= els.video.videoWidth);
    els.stage.classList.toggle('stream-landscape', els.video.videoHeight < els.video.videoWidth);
    els.backdrop.play().catch(() => undefined);

    setStatus('searching', STATUS_MESSAGES.searching);
    stageStartTs = performance.now(); // 엔진 로딩 시간이 폴백 대기에 포함되지 않도록 재설정
    scheduleLoop();
  } catch (error) {
    console.error(error);
    stopStream();
    setMode('idle');
    setStatus('error', STATUS_MESSAGES.error);
  }
}

function flipCamera() {
  const next = state.facing === 'user' ? 'environment' : 'user';
  startCamera(next);
}

function closeTryOn() {
  stopStream();
  clearPhoto();
  setMode('idle');
  setStatus('idle', STATUS_MESSAGES.idle);
}

// ── 사진 모드 ─────────────────────────────────────────────────
function clearPhoto() {
  if (photoUrl) {
    URL.revokeObjectURL(photoUrl);
    photoUrl = null;
  }
  els.photoView.removeAttribute('src');
}

async function analyzePhoto(img) {
  try {
    await ensureEngines();
    await poseLandmarker.setOptions({ runningMode: 'IMAGE' });
    await faceLandmarker?.setOptions({ runningMode: 'IMAGE' });
    syncCanvasSize(img.naturalWidth, img.naturalHeight);

    const poseResult = poseLandmarker.detect(img);
    const poseFit = poseResult.landmarks?.[0]
      ? poseToFit(poseResult.landmarks[0], img.naturalWidth, img.naturalHeight, false)
      : null;
    const faceLandmarks = faceLandmarker?.detect(img).faceLandmarks?.[0];
    const faceFit = faceLandmarks
      ? faceToFit(faceLandmarks, img.naturalWidth, img.naturalHeight, false)
      : null;
    const photoMask = faceLandmarks
      ? faceOcclusionMask(faceLandmarks, img.naturalWidth, img.naturalHeight, false, Infinity)
      : null;
    if (photoMask) {
      mask = photoMask;
      maskTs = Number.POSITIVE_INFINITY; // 정지 사진은 만료되지 않음
    }

    if (segmenter && !segDisabled) {
      try {
        await segmenter.setOptions({ runningMode: 'IMAGE' });
        const segRes = segmenter.segment(img);
        const masks = segRes.confidenceMasks;
        if (masks?.length) {
          const bg = masks[0];
          updateSegKeep(
            bg.getAsFloat32Array(),
            masks.length > 1 && segTier === 'multi' ? masks[1].getAsFloat32Array() : null,
            masks.length === 1,
            bg.width,
            bg.height,
            Number.POSITIVE_INFINITY,
          );
        }
        segRes.close();
      } catch {
        /* 사진 세그 실패 시 기능만 생략 */
      }
    }

    const merged = poseFit && faceFit ? fuseFits(poseFit, faceFit) : poseFit ?? faceFit;
    const fallbackWidth = img.naturalWidth * 0.48;
    renderedFit = merged ?? {
      x: img.naturalWidth * 0.5,
      y: img.naturalHeight * 0.57,
      width: fallbackWidth,
      height: fallbackWidth * BIB_ASPECT,
      rotation: 0,
      yaw: 0,
      pitch: 0,
      confidence: 0.88,
    };
    lockedFit = renderedFit;
    setStatus(
      merged ? 'tracking' : 'searching',
      merged ? STATUS_MESSAGES.photoTracked : STATUS_MESSAGES.photoFallback,
    );
    renderFrame();
  } catch {
    setStatus('error', STATUS_MESSAGES.photoError);
  }
}

function onPhotoSelected(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  stopStream();
  clearPhoto();
  resetTracking();
  photoUrl = URL.createObjectURL(file);
  els.photoView.src = photoUrl;
  setMode('photo');
  setStatus('loading', STATUS_MESSAGES.photoLoading);
  event.target.value = '';
}

// ── 저장 (뷰티 보정 포함) ─────────────────────────────────────
function capture() {
  const canvas = els.canvas;
  const fit = renderedFit;
  if (!canvas || !fit) return;

  const output = document.createElement('canvas');
  output.width = canvas.width;
  output.height = canvas.height;
  const ctx = output.getContext('2d');
  if (!ctx) return;

  if (state.mode === 'camera' && els.video) {
    ctx.filter = state.beauty
      ? 'brightness(1.055) contrast(0.955) saturate(1.045) sepia(0.018)'
      : 'none';
    if (state.mirrored) {
      ctx.translate(output.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(els.video, 0, 0, output.width, output.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = 'none';
    if (state.beauty) drawBeautyLight(ctx, output.width, output.height);
  } else if (state.mode === 'photo' && els.photoView) {
    ctx.drawImage(els.photoView, 0, 0, output.width, output.height);
  }

  // WYSIWYG: 화면에 보이는 라이브 캔버스(턱받이+얼굴가림+세그 클리핑+원근이
  // 모두 반영된 상태)를 그대로 합성한다. 저장본과 화면이 항상 일치한다.
  ctx.drawImage(els.canvas, 0, 0, output.width, output.height);

  output.toBlob(
    (blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `konny-bib-${state.product.id}.jpg`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    'image/jpeg',
    0.92,
  );
}

// ── 미세 조정 UI ──────────────────────────────────────────────
function syncAdjustOutputs() {
  const a = state.adjust;
  els.scaleOut.textContent = `${Math.round(a.scale * 100)}%`;
  els.offsetXOut.textContent = a.x === 0 ? '가운데' : a.x > 0 ? `오른쪽 ${Math.round(a.x * 100)}` : `왼쪽 ${Math.round(-a.x * 100)}`;
  els.offsetYOut.textContent = a.y === 0 ? '기본' : a.y > 0 ? `아래 ${Math.round(a.y * 100)}` : `위 ${Math.round(-a.y * 100)}`;
  els.opacityOut.textContent = `${Math.round(a.opacity * 100)}%`;
}

function bindAdjust(input, key) {
  input.addEventListener('input', () => {
    state.adjust[key] = Number(input.value);
    syncAdjustOutputs();
    renderFrame();
  });
}

function syncFxOutputs() {
  const f = state.fx;
  if (els.fxLightOut) els.fxLightOut.textContent = `${Math.round(f.light * 100)}%`;
  if (els.fxAngleOut) els.fxAngleOut.textContent = f.angle === 0 ? '정면 위' : (f.angle < 0 ? `왼쪽 ${-f.angle}°` : `오른쪽 ${f.angle}°`);
  if (els.fxFlutterOut) els.fxFlutterOut.textContent = f.flutter === 0 ? '끔' : `${Math.round(f.flutter * 100)}%`;
  if (els.fxBrightOut) els.fxBrightOut.textContent = `${Math.round(f.bright * 100)}%`;
  if (els.fxSatOut) els.fxSatOut.textContent = `${Math.round(f.sat * 100)}%`;
}

function resetAdjust() {
  state.adjust = { ...FIT_DEFAULTS };
  state.fx = { ...FX_DEFAULTS };
  if (els.fxLight) els.fxLight.value = String(FX_DEFAULTS.light);
  if (els.fxAngle) els.fxAngle.value = String(FX_DEFAULTS.angle);
  if (els.fxFlutter) els.fxFlutter.value = String(FX_DEFAULTS.flutter);
  if (els.fxBright) els.fxBright.value = String(FX_DEFAULTS.bright);
  if (els.fxSat) els.fxSat.value = String(FX_DEFAULTS.sat);
  syncFxOutputs();
  els.scale.value = String(FIT_DEFAULTS.scale);
  els.offsetX.value = String(FIT_DEFAULTS.x);
  els.offsetY.value = String(FIT_DEFAULTS.y);
  els.opacity.value = String(FIT_DEFAULTS.opacity);
  state.autoTrack = true;
  els.autoTrack.checked = true;
  syncAdjustOutputs();
  renderFrame();
}

function toggleBeauty() {
  state.beauty = !state.beauty;
  els.video.classList.toggle('beauty-enabled', state.beauty);
  document.querySelectorAll('.beauty-light').forEach((el) => {
    el.style.display = state.beauty ? '' : 'none';
  });
  els.beautyBtns.forEach((b) => {
    b.classList.toggle('active', state.beauty);
    b.setAttribute('aria-pressed', String(state.beauty));
  });
}

// ── 초기화 ────────────────────────────────────────────────────
function init() {
  console.info(`[ar] KONNY BIB AR TRY-ON ${APP_VERSION}`);
  // 제품 이미지 프리로드
  const img = new Image();
  img.src = state.product.image;
  img.onload = () => {
    bibImage = img;
    renderFrame();
  };
  const litFiles = {
    left: './assets/konny-bib-lit-left.webp?v37',
    top: './assets/konny-bib-lit-top.webp?v37',
    right: './assets/konny-bib-lit-right.webp?v37',
  };
  const litImgs = {};
  let litLeft = Object.keys(litFiles).length;
  for (const [dir, src] of Object.entries(litFiles)) {
    const li = new Image();
    li.src = src;
    li.onload = () => {
      litImgs[dir] = li;
      if (--litLeft === 0) {
        bibLit = litImgs;
        litKey = '';
        renderFrame();
      }
    };
  }

  els.openCameraBtns.forEach((b) => b.addEventListener('click', () => startCamera()));
  els.photoInputs.forEach((i) => i.addEventListener('change', onPhotoSelected));
  els.captureBtns.forEach((b) => b.addEventListener('click', capture));
  els.flipBtns.forEach((b) => b.addEventListener('click', flipCamera));
  els.closeBtns.forEach((b) => b.addEventListener('click', closeTryOn));
  els.beautyBtns.forEach((b) => b.addEventListener('click', toggleBeauty));
  els.resetBtns.forEach((b) => b.addEventListener('click', resetAdjust));

  els.autoTrack.addEventListener('change', () => {
    state.autoTrack = els.autoTrack.checked;
  });
  bindAdjust(els.scale, 'scale');
  bindAdjust(els.offsetX, 'x');
  bindAdjust(els.offsetY, 'y');
  bindAdjust(els.opacity, 'opacity');
  syncAdjustOutputs();

  // 표현 조정 슬라이더
  const bindFx = (input, key, fmt) => {
    if (!input) return;
    input.addEventListener('input', () => {
      state.fx[key] = Number(input.value);
      syncFxOutputs();
      renderFrame();
    });
  };
  bindFx(els.fxLight, 'light');
  bindFx(els.fxAngle, 'angle');
  bindFx(els.fxFlutter, 'flutter');
  bindFx(els.fxBright, 'bright');
  bindFx(els.fxSat, 'sat');
  syncFxOutputs();

  els.photoView.addEventListener('load', () => {
    if (state.mode === 'photo' && els.photoView.src) analyzePhoto(els.photoView);
  });

  els.guideOpen.addEventListener('click', () => (els.guideModal.hidden = false));
  els.guideClose.addEventListener('click', () => (els.guideModal.hidden = true));
  els.guideModal.addEventListener('click', (e) => {
    if (e.target === els.guideModal) els.guideModal.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!els.guideModal.hidden) els.guideModal.hidden = true;
      else if (state.mode !== 'idle') closeTryOn();
    }
  });

  // 모바일에서는 접속 즉시 전체화면 카메라 실행 (v15 동작 유지)
  if (window.matchMedia(MOBILE_QUERY).matches && !autoStarted) {
    autoStarted = true;
    window.setTimeout(() => startCamera('user'), 120);
  }

  window.addEventListener('pagehide', () => {
    stopStream();
    poseLandmarker?.close();
    faceLandmarker?.close();
    segmenter?.close();
  });
}

init();
