# TradeBot 종합 감사 리포트

> **날짜**: 2026-02-13
> **감사팀**: 퀀트 트레이더 에이전트 / 데이터 사이언티스트 에이전트 / 시스템 아키텍트 에이전트
> **대상**: TradeBot v3 — $1,000 크립토 트레이딩 봇
> **판정**: 메인넷 투입 불가. Phase 0 수정 필수.

---

## I. 종합 등급

| 영역 | 등급 | 요약 |
|------|------|------|
| **스코어링 알고리즘** | D | 충돌 페널티가 신호를 파괴, S/R이 naive |
| **리스크 관리** | F | 마진 계산 오류, 크로스 레버리지 캡 없음 |
| **모멘텀 전략** | D+ | SL이 변동성 비례로 폭발 가능, Kelly 기본값 낙관적 |
| **외부 시그널** | F | 후행 지표를 선행으로 취급, 통계적 검증 전무 |
| **실행 안전성** | F | SL/TP가 실제 주문 없음, 포지션 메모리만 보관 |
| **보안** | D | 대시보드 인증 없음, /do 명령 무제한 |

---

## II. CRITICAL 이슈 (즉시 수정)

### CRIT-1: 마진 계산이 완전히 틀림
- **파일**: `src/core/skills/code-skills.ts:232`
- **현재**: `usedMargin = Σ(entryPrice × size)` — 이건 notional이지 margin이 아님
- **올바른 계산**: `margin = notional / leverage`
- **결과**: 가용자본이 5-15x 과소평가 → 유효한 트레이드가 차단됨
- **수정**: `usedMargin = Σ(entryPrice × size / leverage)`

### CRIT-2: Discretionary SL/TP가 실제 거래소 주문이 아님
- **파일**: `src/strategies/discretionary/index.ts:169`
- **현재**: SL/TP 가격이 로컬 메모리에만 저장됨. 거래소에 trigger order 안 걸림
- **위험**: 봇이 꺼지면 SL 없이 포지션만 남음 → 무한 손실 가능
- **수정**: Momentum 전략처럼 `placeTriggerOrder()` 사용

### CRIT-3: Discretionary 포지션이 DB에 안 저장됨
- **파일**: `src/strategies/discretionary/index.ts:34`
- **현재**: `positions: ActiveDiscretionaryPosition[]`가 메모리에만 존재
- **위험**: PM2 재시작 시 포지션 추적 완전 유실. 고아 포지션 발생
- **수정**: SQLite에 포지션 저장, 시작 시 복원 로직 추가

### CRIT-4: 크로스 레버리지 캡 없음
- **파일**: `src/core/risk-manager.ts:138`
- **현재**: 심볼별 40% 제한만 있고 총 노셔널 레버리지 캡 없음
- **위험**: 4개 심볼에 각각 10x → 총 1,600% 레버리지 이론상 가능
- **수정**: 전체 잔고 대비 총 노셔널 10x 하드캡 추가

### CRIT-5: Scorer 충돌 페널티가 신호를 파괴
- **파일**: `src/strategies/discretionary/scorer.ts:242-244`
- **현재**: `penalty = min(longScore, shortScore)` → 양방향 신호가 있으면 총점 급락
- **예시**: longScore=5 + shortScore=4 → 9점이 5점으로 하락 → LLM 호출 차단
- **실제 의미**: 혼합 신호 = 횡보장 → 확신도를 낮추는 게 맞지, 점수 파괴가 아님
- **수정**: penalty를 `-1` 고정 또는 `확신도 × 0.8` 소프트 적용

### CRIT-6: 모멘텀 SL이 변동성 폭발 시 통제 불능
- **파일**: `src/strategies/momentum/index.ts:235-240`
- **현재**: `SL = 2 × ATR(14)` — 변동성 급등 시 ATR이 가격의 10%+ 가능
- **위험**: SL 한 번에 $100 손실 ($250 자본 대비 40%)
- **수정**: `SL = min(2 × ATR, entryPrice × 0.05)` — 최대 5% 하드캡

### CRIT-7: TP 계산이 현재가 기준 (진입가가 아님)
- **파일**: `src/strategies/momentum/index.ts:238-240`
- **현재**: `takeProfit = currentPrice + 3 * atr` — 주문 체결 전 계산
- **위험**: 슬리피지로 진입가 ≠ currentPrice → TP 위치 오류
- **수정**: 체결 후 `entryPrice` 기준으로 TP 재계산

### CRIT-8: /do 명령이 무제한 LLM 실행
- **파일**: `src/monitoring/telegram.ts`
- **현재**: 사용자 텍스트가 그대로 LLM에 전달, close_all_positions 등 전체 도구 접근 가능
- **위험**: 프롬프트 인젝션으로 전 포지션 청산 가능
- **수정**: 위험 도구 차단 목록 적용 (close_all, market_open 등)

### CRIT-9: 대시보드 인증 없음
- **파일**: `src/dashboard/server.ts:39`
- **현재**: `Access-Control-Allow-Origin: *` + API 키 없음
- **위험**: 네트워크의 누구나 포지션 조회, 거래 내역 접근 가능
- **수정**: API 키 기반 인증 추가

### CRIT-10: LLM 프롬프트의 SL 규칙과 코드가 불일치
- **파일**: `src/core/skills/llm-decide.ts:44-52`
- **현재**: 프롬프트에서 "SL within 1-2% for 10-15x leverage" 명시하지만 코드는 검증 안 함
- **위험**: LLM이 10x 레버리지 + 5% SL 제안 가능 → 위험 초과
- **수정**: parseTradeResponse()에서 leverage × SL% 하드 밸리데이션

---

## III. WARNING 이슈 (수익 최적화)

### WARN-1: EMA 크로스가 단일 이전 스냅샷에 의존
- **파일**: `scorer.ts:92, 445-450`
- **현재**: prevSnapshot이 null이면 크로스 감지 불가
- **영향**: 주말 갭, 데이터 동기화 이슈 시 진입 신호 누락

### WARN-2: 15m 캔들 스파이크 스코어링이 이진적
- **파일**: `scorer.ts:60-68`
- **현재**: 2x ATR 초과만 +2점 (있거나 없거나)
- **개선**: 1.5x → +1, 2x → +2, 2.5x → +3 단계적 적용

### WARN-3: S/R 계산이 naive
- **파일**: `analyzer.ts:122-127`
- **현재**: 최근 20캔들의 max(high)/min(low) = 단순 스윙
- **문제**: 상승 추세에서 "저항"은 어제 고점일 뿐, 실제 거부 레벨 아님
- **개선**: 스윙 포인트 클러스터링, 라운드 넘버, 피보나치 적용

### WARN-4: OI 변화가 시계열 오염
- **파일**: `analyzer.ts:206-213`
- **현재**: "1h OI 변화"가 실제로는 "마지막 스캔(5분) 대비 변화"
- **개선**: 타임스탬프 기반 정규화 (delta / elapsed * 3600 * 1000)

### WARN-5: Kelly 기본값이 낙관적
- **파일**: `base.ts:212`
- **현재**: 거래 이력 없을 때 winRate=50%, R:R=1.5:1 가정
- **개선**: b=1.0 (손익분기) 또는 고정 2% 리스크로 시작

### WARN-6: 모멘텀 4시간 쿨다운이 과도
- **파일**: `momentum/index.ts:45`
- **현재**: 1분 스캔인데 심볼별 4시간 쿨다운
- **영향**: 30분 후 반전 기회 놓침
- **개선**: 1-2시간으로 축소

### WARN-7: ADX 기간이 부적절
- **파일**: `momentum/index.ts:146`
- **현재**: ADX(14) on 1h = 14시간 주기. 크립토에 너무 긺
- **개선**: ADX(7-10) 또는 4h 차트에서 ADX(14)

### WARN-8: code-skills 마진이 55% 하드코딩
- **파일**: `code-skills.ts:229`
- **현재**: `discAllocation = balance * 0.55` — config에서 안 읽음
- **개선**: 전략 config에서 capitalPct 읽도록

### WARN-9: 연속 손실 쿨다운이 동기화 안 됨
- **파일**: `base.ts:79-94` vs `scorer.ts:10`
- **현재**: base.ts의 autoStop과 scorer.ts의 4h lossCooldown이 독립적
- **위험**: 한쪽 리셋하면 다른쪽은 모름

### WARN-10: Dual perspective가 외부 데이터 없으면 안 돌아감
- **파일**: `skills/index.ts:186-242`
- **현재**: hasExternalSignals == false → 단일 관점만 실행
- **개선**: 항상 양쪽 실행, Macro는 "데이터 없음" 반환

---

## IV. 수학적 결함 상세

### 스코어링: 가산 모델의 상관관계 무시
- **현재**: `총점 = Σ(개별 점수) + 보너스 - 충돌 페널티`
- **문제**: RSI 극저 + EMA 골든크로스는 독립 이벤트가 아니라 같은 가격 움직임의 다른 표현
- 3+3=6이 아니라 실질 정보량은 ~4
- **개선**: 카테고리별 max 점수 적용 (같은 카테고리 중 최고점만), 또는 가중 평균

### Volume Ratio: 통계적 기준 부재
- **현재**: `volumeRatio > 3x` 트리거
- **문제**: 단순 평균 대비 3배는 outlier sensitivity 높음. 청산 캐스케이드 1건으로도 트리거
- **개선**: rolling std dev 기반 z-score > 2 로 변경

### Equity Cross 상관관계: 통계적 무의미
- **파일**: `equity-cross/index.ts`
- **현재**: 2시간 롤링 상관관계
- **문제**: 상관계수 의미있으려면 최소 30+ 데이터포인트. 2시간 = 2포인트
- **개선**: 최소 7일 (168 1h 캔들) 롤링 윈도우

---

## V. 외부 시그널 품질 평가

| 소스 | 예측력 | 레이턴시 | 활용 가치 |
|------|--------|----------|-----------|
| **Polymarket** | 후행 | 10분 캐시 | 이벤트 감지용 OK, 가격 예측 불가 |
| **DefiLlama TVL** | 무의미 | 15분 캐시 | TVL↑ ≠ 가격↑ (에어드랍/파밍 노이즈) |
| **CoinGecko 트렌딩** | 역지표 | 15분 캐시 | 이미 급등 후 진입 = 고점 매수 |

### 공통 문제
- 3개 소스의 캐시 타이밍이 10/15/15분으로 시간 정렬 안 됨
- 크로스 소스 상관관계 분석 자체가 무효
- 시그널별 예측 정확도 추적 테이블 없음

---

## VI. 인프라 위험

| 이슈 | 위험도 | 파일 | 설명 |
|------|--------|------|------|
| PM2 메모리 500M | HIGH | ecosystem.config.cjs | 시장 급변 시 OOM → 강제 킬 → SQLite 손상 |
| kill_timeout 미설정 | HIGH | ecosystem.config.cjs | SIGKILL 즉시 발생 → DB 쓰기 중단 |
| uncaughtException | MED | src/index.ts | 로그만 남기고 트레이딩 계속 → 좀비 상태 |
| API 타임아웃 없음 | MED | hyperliquid/client.ts | HL 네트워크 행 → 전체 시스템 프리즈 |
| 텔레그램 하트비트 없음 | MED | monitoring/telegram.ts | 봇 연결 끊겨도 엔진은 계속 — 알림 없이 거래 |

---

## VII. 우선순위별 액션 플랜

### Phase 0: 메인넷 전 필수 (1-2일)
1. [CRIT-2] Discretionary SL/TP를 거래소 trigger order로 변환
2. [CRIT-3] Discretionary 포지션 DB 저장 + 시작 시 복원
3. [CRIT-1] 마진 계산 수정: notional / leverage
4. [CRIT-9] 대시보드에 API 키 인증 추가
5. [CRIT-8] /do 명령에 위험 도구 차단 목록 적용
6. [CRIT-4] 총 노셔널 레버리지 캡 추가 (잔고의 10x)

### Phase 1: 수학 수정 (3-5일)
7. [CRIT-5] Scorer 충돌 페널티를 -1 또는 확신도 0.8x로 완화
8. [CRIT-6] 모멘텀 SL에 최대 5% 하드캡 적용
9. [CRIT-7] TP를 체결가 기준으로 재계산
10. [CRIT-10] LLM 응답에서 leverage × SL% 밸리데이션
11. [WARN-5] Kelly 기본값을 b=1.0 (보수적)으로 변경
12. [WARN-3] S/R 계산을 스윙 포인트 클러스터링으로 교체
13. [WARN-4] OI 변화를 타임스탬프 기반으로 정규화

### Phase 2: 시그널 검증 (1-2주)
14. 외부 소스별 정확도 추적 테이블 (DB) 추가
15. 소스별 가중치 도입 (현재 동일 가중치 → 예측력 비례)
16. 트렌딩 시그널 → "이미 급등" 경고로 재분류
17. Equity Cross 상관관계 윈도우 최소 7일로 변경

### Phase 3: 인프라 강화 (3-5일)
18. PM2 kill_timeout: 10000, max_memory_restart: '1G'
19. 모든 HL API 호출에 10초 타임아웃
20. 전략 시작 전 프리플라이트 체크 (잔고, API 키, 네트워크)
21. 텔레그램 봇 하트비트 + 자동 재연결
22. 연속 3회 API 실패 시 서킷 브레이커 (전략 일시정지)
