// MediaPipe Tasks Vision 로딩 — GPU 우선, 실패 시 CPU 폴백 (v15 동일)

import { POSE_MODEL_URL, FACE_MODEL_URL, WASM_BASE_URL, VISION_BUNDLE_URL } from './config.js';

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
