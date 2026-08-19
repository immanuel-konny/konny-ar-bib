// MediaPipe Tasks Vision 로딩 — GPU 우선, 실패 시 CPU 폴백 (v15 동일)

import { POSE_MODEL_URL, FACE_MODEL_URL, SEG_MODEL_URL, WASM_BASE_URL, VISION_BUNDLE_URL } from './config.js';

let visionModulePromise = null;
let filesetPromise = null;

async function loadVisionModule() {
  visionModulePromise ??= import(/* @vite-ignore */ VISION_BUNDLE_URL);
  return visionModulePromise;
}

async function loadFileset() {
  if (!filesetPromise) {
    filesetPromise = loadVisionModule().then((vision) =>
      vision.FilesetResolver.forVisionTasks(WASM_BASE_URL),
    );
  }
  return filesetPromise;
}

// preferredDelegate: 'GPU'(기본, 실패 시 CPU 폴백) | 'CPU'(강제)
export async function createPoseLandmarker(preferredDelegate = 'GPU') {
  const vision = await loadVisionModule();
  const fileset = await loadFileset();
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.52,
    minPosePresenceConfidence: 0.48,
    minTrackingConfidence: 0.48,
  });
  if (preferredDelegate === 'GPU') {
    try {
      return await vision.PoseLandmarker.createFromOptions(fileset, options('GPU'));
    } catch {
      /* CPU 폴백으로 진행 */
    }
  }
  return vision.PoseLandmarker.createFromOptions(fileset, options('CPU'));
}

export async function createFaceLandmarker(preferredDelegate = 'GPU') {
  const vision = await loadVisionModule();
  const fileset = await loadFileset();
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: FACE_MODEL_URL, delegate },
    runningMode: 'VIDEO',
    numFaces: 1,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.52,
  });
  if (preferredDelegate === 'GPU') {
    try {
      return await vision.FaceLandmarker.createFromOptions(fileset, options('GPU'));
    } catch {
      /* CPU 폴백으로 진행 */
    }
  }
  try {
    return await vision.FaceLandmarker.createFromOptions(fileset, options('CPU'));
  } catch {
    // 얼굴 추적 실패 시 포즈 단독으로도 동작 가능
    return null;
  }
}

// 인물 세그멘터 — 배경·머리카락 정밀 가림용. 실패하면 null (기능만 비활성).
export async function createImageSegmenter(preferredDelegate = 'GPU') {
  const vision = await loadVisionModule();
  const fileset = await loadFileset();
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: SEG_MODEL_URL, delegate },
    runningMode: 'VIDEO',
    // 카테고리 마스크는 일부 기기 GPU에서 깨진 버퍼를 반환한다(실기기에서
    // 블록 노이즈로 확인됨). float 컨피던스 마스크는 델리게이트와 무관하게
    // 형식이 보장되므로 이를 사용한다.
    outputCategoryMask: false,
    outputConfidenceMasks: true,
  });
  if (preferredDelegate === 'GPU') {
    try {
      return await vision.ImageSegmenter.createFromOptions(fileset, options('GPU'));
    } catch {
      /* CPU 폴백으로 진행 */
    }
  }
  try {
    return await vision.ImageSegmenter.createFromOptions(fileset, options('CPU'));
  } catch {
    return null;
  }
}
