// v15 기준 상수 — ChatGPT 베타(konny-bib-ar-beta)에서 추출한 튜닝값을 그대로 유지한다.

export const PRODUCTS = [
  {
    id: 'rolling-bib',
    family: '코니 롤링빕',
    name: '코니 롤링빕',
    english: 'Konny Bib Rolling',
    shape: 'rolling',
    color: '#efd3d0',
    accent: '#26221f',
    url: 'https://konny.co.kr/product/detail.html?product_no=23',
    image: './assets/konny-bib-hd.webp', // 4x 업스케일·디프린지·재질 강화 (원본: konny-bib-source)
  },
];

// 제품 원본 이미지 비율 (높이 / 너비) — 490×246px 누끼 기준
export const BIB_ASPECT = 246 / 490;

export const POSE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task';
export const FACE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task';
// 셀피 멀티클래스 세그멘테이션 (0 배경 / 1 머리카락 / 2 몸피부 / 3 얼굴피부 / 4 옷 / 5 기타)
export const SEG_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';
export const VISION_VERSION = '0.10.35';
export const WASM_BASE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/wasm`;
export const VISION_BUNDLE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/vision_bundle.mjs`;

// Face Landmarker 얼굴 윤곽(oval) 인덱스 — 턱·목 가림(occlusion) 마스크에 사용
export const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379,
  378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127,
  162, 21, 54, 103, 67, 109,
];

// 핏 미세 조정 기본값 — 기본 크기 130%
export const FIT_DEFAULTS = { scale: 1.3, x: 0, y: 0, opacity: 1 };
export const FIT_RANGES = {
  scale: { min: 0.68, max: 1.38, step: 0.01 },
  x: { min: -0.36, max: 0.36, step: 0.01 },
  y: { min: -0.5, max: 0.5, step: 0.01 },
  opacity: { min: 0.55, max: 1, step: 0.01 },
};

// 인식 루프 파라미터
export const DETECT = {
  // 모바일 분석 입력 최대 변(px) — 연산량·발열 절감
  analyzeMax: 448,
  // 감지 주기(ms): 포즈는 빠르게, 얼굴은 보조로 병행.
  // 실기기 fps가 19~24라 프레임 간격(~45ms)보다 짧게 두어 매 프레임 감지되게 한다.
  poseInterval: { mobile: 38, desktop: 34 },
  faceInterval: { mobile: 100, desktop: 84 },
  // 최근 결과 유효 시간(ms)
  poseFreshMs: 760,
  faceFreshMs: 680,
  // 연속 미검출 허용 횟수 초과 시 '위치 찾는 중' 상태로 전환
  missLimit: 11,
  // 미검출 시 프레임당 신뢰도 감쇠
  confidenceDecay: 0.975,
  // 좌표 튐 제거용 중앙값 필터 창 크기(프레임)
  // 5→4: 지연을 줄이면서도 단일 튐은 계속 걸러낸다
  medianWindow: 4,
  // 인물 세그멘테이션: 전용 320px 입력, 140ms 주기, 800ms 유효
  segInputMax: 320,
  segIntervalMs: 140,
  segFreshMs: 800,
};

// 소프트 뷰티 보정 (라이브 CSS 필터 및 저장 사진 필터 동일 값)
export const BEAUTY_FILTER =
  'brightness(1.055) contrast(0.955) saturate(1.045) sepia(0.018)';

export const MOBILE_QUERY = '(max-width: 640px)';

export const STATUS_MESSAGES = {
  idle: '카메라를 켜면 턱받이가 목과 어깨 움직임을 따라가요.',
  loading: '기기 안에서 동작할 착용 엔진을 준비하고 있어요.',
  permission: '카메라 권한을 확인하고 있어요.',
  searching: '조금 떨어져 얼굴과 양쪽 어깨가 보이도록 맞춰주세요.',
  tracking: '몸 방향에 맞춰 입체 착용 위치를 맞추고 있어요.',
  tooClose: '조금 뒤로 물러나면 턱받이 착용 모습이 보여요.',
  error: '카메라를 열 수 없어요. 권한을 허용하거나 사진으로 시도해 주세요.',
  photoLoading: '사진 속 착용 위치를 찾고 있어요.',
  photoTracked: '사진에서 착용 위치를 찾았어요. 아래에서 미세 조정할 수 있어요.',
  photoFallback: '자동 인식이 어려워 기본 위치에 놓았어요. 아래에서 위치를 조정해 주세요.',
  photoError: '사진을 분석하지 못했어요. 다른 사진으로 다시 시도해 주세요.',
};
