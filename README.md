# 작은 요약 화면(PiP) — 깃허브에 넣는 방법

## 먼저 알아둘 것

이 저장소에는 `android/` 폴더가 없다. 빌드할 때마다 워크플로가 `npx cap add android` 로
새로 만든다. 그래서 **안드로이드 폴더에 파일을 직접 넣어봐야 다음 빌드에서 지워진다.**

기존 기지국 플러그인이 쓰는 방식이 정답이다.

```
native/CellInfoPlugin.java      ← 저장소에 소스만 둔다
build-apk.yml 의 설치 스텝      ← 빌드 중에 생성된 android/ 안으로 복사 + MainActivity 재작성
```

PiP도 똑같이 간다.

## 넣을 파일 두 개

### 1) `native/PipPlugin.java`  (새 파일)

이 폴더의 `native/PipPlugin.java` 를 저장소 `native/` 폴더에 그대로 올린다.
(패키지는 `com.dullyyj.subway` — capacitor.config.json 의 appId 와 같아서 수정할 필요 없다)

### 2) `.github/workflows/build-apk.yml`  (기존 파일 교체)

이 폴더의 `build-apk.yml` 로 통째로 바꾼다. 기존 파일에서 바뀐 곳은 두 군데뿐이다.

- `Install CellInfo plugin` → `Install native plugins` 로 이름이 바뀌고,
  `PipPlugin.java` 도 같이 복사한 뒤 MainActivity 에 `registerPlugin(PipPlugin.class)` 와
  `onUserLeaveHint()` / `onPictureInPictureModeChanged()` 를 넣어 다시 쓴다.
- `Patch AndroidManifest` 에 PiP 속성(`supportsPictureInPicture`, `resizeableActivity`)을
  넣는 파이썬 블록이 추가됐다. `configChanges` 는 이미 필요한 값이 다 들어 있어서 그대로 통과한다.

### 3) `www/index.html`

같이 받은 index.html 로 교체한다. (화면·토글·네이티브 연동은 여기에 이미 들어 있다)

## 올리는 순서

1. `native/PipPlugin.java` 추가
2. `.github/workflows/build-apk.yml` 교체
3. `www/index.html` 교체
4. main 에 push → Actions 가 APK 를 만든다

셋을 한 번에 커밋해도 되고 따로 해도 된다. 다만 **워크플로만 먼저 올리면 빌드가 실패한다**
(`native/PipPlugin.java 가 없습니다` 로 멈춘다). 플러그인 파일을 같이 올리거나 먼저 올릴 것.

## 확인 방법

- 빌드 로그의 `=== 설치된 파일 ===` 에 `PipPlugin.java` 가 보이면 복사 성공
- `PiP 매니페스트 패치 완료` 가 보이면 매니페스트 성공
- 앱에서 설정 > 작은 요약 화면 카드 → "화면 위 축소 표시를 쓸 수 있어요." 로 바뀌어 있으면 연결 성공
- 경로 안내 중에 홈 버튼 → 작은 창에 현재역 · N분 남음 · 도착 예정 시각

## 안 되는 경우

- 안드로이드 8.0 미만은 PiP 자체가 없다 → 기존 상단 알림으로 안내된다
- 시스템 설정 > 앱 > 길동무 > 다른 앱 위에 표시 가 꺼져 있으면 안 뜬다
- 설정의 작은 요약 화면 토글이 꺼져 있으면 아무 것도 하지 않는다
