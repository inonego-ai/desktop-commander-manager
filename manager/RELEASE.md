# Desktop Commander Manager — 배포 준비

## 제품 구성

- v0.2.1 터널 연결·상태 표시·재시작 및 MCP 프록시 안정화 개선 유지
- MCP 프록시의 응답 스풀, 재연결·초기화 캐시 및 대용량 응답 처리 유지
- Manager의 확장 기능 영역과 MCP 확장 레지스트리 유지 (현재 등록된 확장 0개)
- 기존 Goal/Plan 전용 MCP 도구·창·런타임은 배포하지 않음
- 사용자 연결 설정·자격 증명·기존 Goal/Plan 저장 데이터는 자동 수정·삭제하지 않음

## 소스 및 배포 점검

저장소 최상위 폴더에서 실행:

```powershell
npm.cmd --prefix manager run test:proxy
npm.cmd --prefix manager run check
npm.cmd --prefix manager run build:ui
npm.cmd --prefix manager run check:release
Push-Location manager/src-tauri
cargo test --offline
Pop-Location
```

`manager/scripts/Prepare-Release.ps1`은 고정된 버전의 터널 클라이언트,
Node.js, Desktop Commander를 검증한 뒤 배포 리소스를 구성합니다.
프록시 아래에는 `MCPStdioProxy.mjs`,
`extensions/index.mjs`, `extensions/registry.mjs`만 포함됩니다.

`check:release`는 배포 리소스와 소스의 파일 목록·내용을 대조합니다.
이전 Goal/Plan 모듈이나 백업 파일이 섞여 있으면 실패합니다.
`Verify-Runtime.mjs`는 임시 사용자 환경에서 실제 Desktop Commander MCP
초기화와 읽기 전용 명령, 초기화 캐시 재사용을 검사합니다.
터널 자격 증명은 테스트에 포함하지 않습니다.

설치 파일 생성:

```powershell
npm.cmd --prefix manager run build
```

설치 파일은 `manager/src-tauri/target/release/bundle/nsis/`에 생성됩니다.
빌드 결과물 생성과 실제 사용자 컴퓨터 설치는 별개입니다.

## 운영 및 사용자 데이터

설치·업데이트 시에는 앱 설정과 사용자 데이터를 백업하고 변경 전후를 확인합니다.
`connection.json`, Windows 자격 증명 관리자, 터널 프로필과 로그는 사용자 자산이며
Goal/Plan 기능 제거를 이유로 자동 삭제하지 않습니다.
이전 기능에 속한 `plans`, `goals`, `goal-web-profile` 폴더도
소스 정리·빌드 단계에서는 건드리지 않습니다.

운영 중인 Manager 및 터널은 소스 검증이나 빌드 도중 종료·재시작하지 않습니다.
설치본 검증이 필요한 경우 `Verify-Installation.mjs`로 누락·해시 차이와
미등록 파일을 확인합니다. 운영 환경 전환은 별도 승인 후 수행합니다.
