# KONNY BIB — AR 가상착용 (AR Try-On)

코니 턱받이를 브라우저에서 실시간 가상 착용해보는 WebAR 서비스입니다.
ChatGPT로 개발한 베타 **v15**(`konny-bib-ar-beta.se0-immanuel.chatgpt.site`)의
추적·합성 파이프라인을 그대로 이식하고, UI/UX는 **Meta AI 안경 가상 착용**
(meta.com의 "가상으로 착용해보기") 수준을 목표로 재구성했습니다.

- 빌드 도구 없음 — 순수 ES Modules 정적 웹앱
- 카메라 영상·사진은 서버로 전송하지 않음 (모델 파일만 CDN 로드)

## 실행

정적 서버로 서빙하면 됩니다. 카메라는 `localhost` 또는 HTTPS에서만 동작합니다.

```bash
npx http-server -p 4173 .
```

또는:

```bash
python -m http.server 4173
```

→ http://localhost:4173

## 구조

| 파일 | 역할 |
|---|---|
| `index.html` | 랜딩 + Meta 스타일 풀스크린 트라이온 오버레이(좌: 카메라, 우: 제품/핏 패널) |
| `css/app.css` | v15 디자인 토큰 + 오버레이/모바일 전체화면 스타일 |
| `js/config.js` | v15에서 추출한 전체 튜닝 상수 (모델 URL, 감지 주기, 임계값, 기본 크기 130% 등) |
| `js/engine.js` | MediaPipe Tasks Vision 로딩 — Pose/Face Landmarker, GPU→CPU 폴백 |
| `js/fit-math.js` | 랜드마크 → 착용 핏 계산: 포즈 핏, 얼굴 핏, 융합, 중앙값 필터, 가림 마스크 |
| `js/stabilizer.js` | 정지 잠금(deadzone lock) + 시간 기반 지수 보간 |
| `js/renderer.js` | 캔버스 합성: 턱받이 + 접촉 그림자 + 얼굴 가림 + 뷰티 라이트 |
| `js/main.js` | 앱 상태, 카메라 제어, 추적 루프, 사진 모드, 캡처 |

## 추적 파이프라인 (v15)

```
카메라 → (모바일: 448px 다운스케일) → Pose Landmarker(52/46ms) + Face Landmarker(118/92ms, 교차 실행)
      → 포즈 핏(어깨 11/12 + 입 9/10) ⊕ 얼굴 핏(코1·턱152·눈33/263·귀234/454) 융합
      → 5프레임 중앙값 → 정지 잠금(위치1.4%/크기2.2%/각도1.2° 임계) → dt 기반 지수 보간
      → Canvas 합성(원본 비율 130%) → 얼굴 윤곽 destination-out 가림
```

핵심 설계 결정(대화에서 검증된 것):

- **MediaPipe 유지** — 턱받이는 목·어깨 기준 제품이라 얼굴 중심 상용 SDK(Banuba 등)보다 어깨 좌표를 직접 주는 MediaPipe가 구조적으로 적합.
- **카메라 제약은 가로 기준 4:3** — 세로 요청 시 기기별 가로/세로 뒤집힘 발생(웹 표준 동작, Banuba 문서에도 명시). 실제 스트림 방향은 재생 후 판별.
- **원본 이미지 합성** — v14의 2.5D 메시 변형은 제품 실루엣·로고를 왜곡해 롤백. 커머스는 제품 재현 정확도가 우선.
- **마스크 방식** — 카메라 영상은 건드리지 않고 턱받이 픽셀만 선택적으로 지움(v15 버그 수정 방식).

## 로드맵

- [ ] 공식 고해상도 누끼·정면/측면 제품 사진으로 에셋 교체
- [ ] 제품(디자인) 추가 — `js/config.js`의 `PRODUCTS` 배열 확장
- [ ] 추적 연산 Web Worker 분리 (UI 프레임 저하 방지)
- [ ] MediaPipe Image Segmenter 기반 목·어깨 정밀 가림
- [ ] 실기기 검증: Galaxy/iPhone FPS·발열·배터리
