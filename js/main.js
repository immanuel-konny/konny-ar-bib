// 코니 턱받이 AR 가상착용 — 앱 본체
// v15(ChatGPT 베타) 추적·합성 파이프라인 + Meta 안경 트라이온 스타일 UI

import {
  PRODUCTS,
  BIB_ASPECT,
  FIT_DEFAULTS,
  DETECT,
  MOBILE_QUERY,
  STATUS_MESSAGES,
} from './config.js';
import {
  poseToFit,
  faceToFit,
  faceOcclusionMask,
  smoothMask,
  fuseFits,
  medianFit,
} from './fit-math.js';
import { applyStopLock, smoothTimed } from './stabilizer.js';
import {
  drawBib,
  eraseMaskArea,
  compositeSkinOver,
  drawBeautyLight,
} from './renderer.js';
import { createPoseLandmarker, createFaceLandmarker } from './engine.js';

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
  product: PRODUCTS[0],
};

// ── 추적 내부 상태 ─────────────────────────────────────────────
let poseLandmarker = null;
let faceLandmarker = null;
let stream = null;
let rafId = null;
let analyzeCanvas = null;
let bibImage = null;
let photoUrl = null;
let isMobileSession = false;
let autoStarted = false;

let watchdogId = null; // rAF 정지 감시 타이머
let renderedFit = null; // 화면에 그려지는 보간된 핏
let lockedFit = null; // 정지 잠금을 통과한 목표 핏
let lastPose = null; // { fit, ts }
let lastFace = null; // { fit, ts }
let mask = null; // 얼굴 가림 폴리곤
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

// ── 진단 (?debug=1 시 HUD 표시, window.__vtoDiag()는 항상 사용 가능) ──
const debugEnabled = new URLSearchParams(location.search).has('debug');
const diag = {
  engine: 'not-loaded',
  poseRuns: 0,
  poseHits: 0,
  faceRuns: 0,
  faceHits: 0,
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
    `mode:${state.mode} status:${state.status} fps:${diag.fps}`,
    `engine:${diag.engine} delegate:${delegatePref} input:${analyzeMode} stage:${stageIndex}${hasEverDetected ? '*' : ''}`,
    `video:${v?.videoWidth ?? 0}x${v?.videoHeight ?? 0} mobile:${isMobileSession}`,
    `pose:${diag.poseHits}/${diag.poseRuns} face:${diag.faceHits}/${diag.faceRuns}`,
    `fit:${renderedFit ? `${Math.round(renderedFit.x)},${Math.round(renderedFit.y)} w${Math.round(renderedFit.width)}` : '-'}`,
    diag.lastError ? `err:${diag.lastError}` : '',
  ].filter(Boolean).join('\n');
}

window.__vtoDiag = () => ({
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
  const w = Math.max(2, Math.round(video.videoWidth * ratio));
  const h = Math.max(2, Math.round(video.videoHeight * ratio));
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
  drawBib(ctx, withAdjust(renderedFit), state.product, state.adjust.opacity, bibImage);
  if (mask) eraseMaskArea(ctx, mask);
}

function resetTracking() {
  renderedFit = null;
  lockedFit = null;
  lastPose = null;
  lastFace = null;
  mask = null;
  fitRing = [];
  lastSource = null;
  lastFitTs = 0;
  missCount = 0;
  lastPoseTs = 0;
  lastFaceTs = 0;
  lastFrameTs = 0;
  lastDetector = null;
}

// ── 엔진 준비 ─────────────────────────────────────────────────
async function ensureEngines() {
  if (poseLandmarker) return poseLandmarker;
  setStatus('loading', STATUS_MESSAGES.loading);
  diag.engine = 'loading';
  poseLandmarker = await createPoseLandmarker(delegatePref);
  faceLandmarker = await createFaceLandmarker(delegatePref);
  diag.engine = faceLandmarker ? 'pose+face' : 'pose-only';
  return poseLandmarker;
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
  const faceInterval = isMobileSession ? DETECT.faceInterval.mobile : DETECT.faceInterval.desktop;
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
    try {
      const input = analyzeSource(video);
      const vw = video.videoWidth;
      const vh = video.videoHeight;

      if (runPose) {
        lastPoseTs = now;
        lastDetector = 'pose';
        diag.poseRuns += 1;
        const landmarks = poseLandmarker.detectForVideo(input, now).landmarks?.[0];
        const fit = landmarks ? poseToFit(landmarks, vw, vh, state.mirrored) : null;
        if (fit) {
          lastPose = { fit, ts: now };
          diag.poseHits += 1;
        }
      }
      if (faceDue && faceLandmarker) {
        lastFaceTs = now;
        lastDetector = 'face';
        diag.faceRuns += 1;
        const landmarks = faceLandmarker.detectForVideo(input, now).faceLandmarks?.[0];
        const fit = landmarks ? faceToFit(landmarks, vw, vh, state.mirrored) : null;
        const nextMask = landmarks
          ? faceOcclusionMask(landmarks, vw, vh, state.mirrored)
          : null;
        if (fit) {
          lastFace = { fit, ts: now };
          diag.faceHits += 1;
        }
        if (nextMask) mask = smoothMask(mask, nextMask);
      }

      const freshPose = lastPose && now - lastPose.ts < DETECT.poseFreshMs ? lastPose : null;
      const freshFace = lastFace && now - lastFace.ts < DETECT.faceFreshMs ? lastFace : null;
      const merged =
        freshPose && freshFace
          ? {
              fit: fuseFits(freshPose.fit, freshFace.fit),
              ts: Math.max(freshPose.ts, freshFace.ts),
            }
          : freshPose ?? freshFace;
      const source = freshPose && freshFace ? 'fusion' : freshPose ? 'pose' : freshFace ? 'face' : null;

      if (merged) {
        missCount = 0;
        hasEverDetected = true;
        lastSuccessTs = now;
        if (merged.ts !== lastFitTs) {
          if (lastSource !== source) fitRing = [];
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
      }
    } catch (error) {
      diag.lastError = `detect: ${error?.message ?? error}`;
      if (now - lastSuccessTs > 2500) {
        setStatus('searching', STATUS_MESSAGES.searching);
      }
    }
  }
  if (state.mode === 'camera') maybeEscalateFallback(now);

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
    stageIndex = isMobileSession ? 0 : 1;
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
      ? faceOcclusionMask(faceLandmarks, img.naturalWidth, img.naturalHeight, false)
      : null;
    if (photoMask) mask = photoMask;

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

  // 가림 처리용 원본 프레임 사본 (뷰티 보정 적용된 상태)
  const cleanFrame = document.createElement('canvas');
  cleanFrame.width = output.width;
  cleanFrame.height = output.height;
  cleanFrame.getContext('2d')?.drawImage(output, 0, 0);

  drawBib(ctx, withAdjust(fit), state.product, state.adjust.opacity, bibImage);
  if (mask) compositeSkinOver(ctx, cleanFrame, mask);

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

function resetAdjust() {
  state.adjust = { ...FIT_DEFAULTS };
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
  // 제품 이미지 프리로드
  const img = new Image();
  img.src = state.product.image;
  img.onload = () => {
    bibImage = img;
    renderFrame();
  };

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
  });
}

init();
