# TradeBot - Crypto Trading Bot System

자동화된 크립토 트레이딩 봇 시스템. $1,000 초기 자본으로 수익 극대화를 목표.

---

## 프로젝트 방향

### 핵심 철학
**봇의 존재 이유: 프로토콜이 못하는 걸 해야 한다.**

- 안정적 수익만 원하면 HLP/Theo에 예치하면 됨 → 봇을 만들 이유 없음
- 펀딩레이트 수익도 Liminal, Theo 등 기존 프로토콜이 더 잘함
- **봇이 잘하는 것**: 시장 상황 판단, 타이밍, 레버리지 조절, 공격적 진입/퇴출
- **핵심 가치**: LLM이 24/7 시장을 감시하고, 높은 확률의 기회에만 집중적으로 진입

### 전략 구성 (v2 - 재편)

| 전략 | 역할 | 자본 | 모드 |
|------|------|------|------|
| **Discretionary (Core)** | LLM 기반 공격적 트레이딩 | 60% ($600) | 반자동 → 조건부 자동 |
| **Momentum (Support)** | 트렌드 확인 + 자동 진입 | 30% ($300) | Auto |
| **Grid (Idle mode)** | 횡보장에서만 가동 | 10% ($100) | Auto (조건부) |
| ~~Funding Arb~~ | ~~제거 — HLP/Theo가 더 잘함~~ | - | - |
| ~~Token Sniping~~ | ~~보류 — MEV 경쟁 + 자본 부족~~ | - | - |

### 목표
- 월 15-30% 수익률 (레버리지 활용, 고확률 트레이드 선별)
- 최대 드로다운 20% 제한
- 월 10~20회 트레이드 (질 > 양)

---

## Strategy Overview (현재 코드 상태)

| Strategy | Status | 비고 |
|----------|--------|------|
| Grid Trading | ✅ Implemented | v2에서 횡보장 전용으로 전환 예정 |
| Funding Rate Arb | ✅ Implemented | v2에서 제거 예정 (프로토콜 대체) |
| Momentum Trading | ✅ Implemented | 유지, 파라미터 최적화 예정 |
| Discretionary Trading | ✅ Implemented | v2에서 Core로 대폭 고도화 예정 |
| Token Sniping (Solana) | ❌ Not Started | 보류 (자본 $10k+ 시 재고) |

---

## 완료된 작업 (Done)

### Phase 1: Grid Bot ✅
- Hyperliquid perp 기반 그리드 트레이딩
- 설정 가능한 그리드 레벨, 스프레드, 주문 크기
- 자동 그리드 재배치 및 PnL 추적

### Phase 2: Funding Rate Arb ✅
- 5분 주기 펀딩 레이트 스캔 (전 종목)
- OI $500k+, Volume $100k+ 필터
- 양(+) 펀딩 → 숏 / 음(-) 펀딩 → 롱 자동 진입
- 펀딩 정상화/72h 만기/방향 전환 시 자동 청산

### Phase 2.5: Discretionary Trading ✅
- 15분 주기 기술적 분석 (RSI, EMA, ATR, S/R, 트렌드)
- Claude API (LLM) 기반 기회 탐지 및 제안 생성
- Telegram으로 트레이드 제안 → 사용자 승인/수정/거절
- 8개 대화형 명령어 지원

### Phase 3: Momentum Trading ✅
- EMA(9/21) 크로스오버 시그널
- RSI 필터 (과매수/과매도 회피)
- ATR(14) 기반 SL (2x ATR) / TP (3x ATR)
- 심볼별 4시간 시그널 쿨다운

### Infrastructure ✅
- Hyperliquid 거래소 어댑터 (REST + WebSocket + 캔들 + 펀딩)
- 트레이딩 엔진 + 전략 라이프사이클 관리 (start/stop/pause/resume)
- 리스크 매니저 (드로다운 보호, 포지션 제한)
- SQLite 트레이드 로깅 (WAL mode)
- Telegram 봇 (13개 명령어)
- Zod v4 환경변수 검증

### DevOps ✅
- VPS 배포 (Hetzner CX22, Ubuntu 24.04)
- PM2 프로세스 매니저
- GitHub Actions 자동 배포 (push → SSH → build → restart)
- Telegram 배포 알림

---

## 남은 작업 (Todo)

### v2 전략 재편
- [x] Discretionary v2: 스코어링 엔진 + 스마트 LLM 트리거
- [x] Funding Arb 전략 비활성화 (엔진에서 제거)
- [x] 자본 배분 재조정 (Discretionary 60%, Momentum 30%, Grid 10%)
- [x] Telegram /score, /cooldown 명령어 추가
- [ ] Grid 전략을 횡보장 전용으로 전환 (시장 상태 판단 로직)
- [ ] Momentum 파라미터 최적화
- [ ] 메인넷 전환
- [ ] 15m 캔들 기반 트리거 지표 추가 (현재 1h 캔들만 사용)

### 향후 개선
- [ ] 전략별 상세 백테스트
- [ ] 모니터링 대시보드
- [ ] 연속 손실 시 자동 포지션 축소

---

## [설계] Discretionary v2: LLM 스마트 트리거 알고리즘

### 원칙
- **코드가 감시, LLM이 판단** — 정량적 필터는 코드, 정성적 판단은 LLM
- **노이즈 제거** — "평소와 다른" 움직임만 포착
- **비용 제어** — 하루 최대 12회 LLM 호출 (월 ~$2-3 Haiku 기준)

### 아키텍처

```
[5분 주기 데이터 수집] ← 코드, 비용 0
        ↓
[1차: 개별 지표 이상 감지] ← 코드, 비용 0
        ↓
[2차: 복합 스코어 계산] ← 코드, 비용 0
        ↓
  스코어 >= 임계값?
    NO → 대기
    YES ↓
[3차: 쿨다운 체크]
        ↓
  쿨다운 통과?
    NO → 대기
    YES ↓
[LLM 호출] → 트레이드 제안 or "기회 아님"
        ↓
[Telegram 알림 → 사용자 승인/자동 진입]
```

### 1차: 개별 지표 이상 감지 (5분 주기, 코드 기반)

| 카테고리 | 지표 | 트리거 조건 | 점수 |
|----------|------|------------|------|
| **가격 급변** | 1h 변동률 | \|변동\| > 2.5% | +3 |
| | 4h 변동률 | \|변동\| > 5% | +3 |
| | 15m 캔들 크기 | > 2x ATR(14) | +2 |
| **모멘텀** | RSI(14) | < 25 또는 > 75 | +3 |
| | RSI 다이버전스 | 가격 신고/저 vs RSI 역방향 | +4 |
| | EMA(9/21) 크로스 | 1h 내 크로스오버 발생 | +3 |
| **변동성** | ATR 급등 | 현재 ATR > 1.5x 20봉 평균 ATR | +2 |
| | 볼린저 밴드 돌파 | 종가가 2σ 밖으로 돌파 | +2 |
| **볼륨** | 거래량 급증 | 1h 거래량 > 3x 24h 평균 | +3 |
| **시장 구조** | 지지/저항 도달 | 주요 S/R 레벨 ±0.5% 이내 | +2 |
| | OI 급변 | 1h OI 변화 > 5% | +2 |
| | 펀딩레이트 극단 | \|funding\| > 0.05%/h | +1 |
| **크로스 심볼** | BTC 급변 시 알트 | BTC 3%+ 이동 + 알트 미반영 | +3 |

### 2차: 복합 스코어 & 임계값

```
총 점수 = Σ(트리거된 지표 점수)

점수별 액션:
  0~4점  → 무시 (평범한 시장)
  5~7점  → 관심 (로그 기록 + Telegram 경고)
  8~10점 → LLM 호출 (일반 분석)
  11점+  → LLM 긴급 호출 (높은 확신도 요구)
```

**복합 보너스:**
- 같은 방향 시그널 3개+ 동시 발생 → +2점
- 멀티 타임프레임 일치 (1h + 4h 같은 방향) → +2점
- 2개+ 심볼에서 동시 시그널 → +1점

### 3차: 쿨다운 규칙

| 규칙 | 값 | 이유 |
|------|-----|------|
| 심볼별 쿨다운 | 2시간 | 같은 심볼 연속 분석 방지 |
| 글로벌 쿨다운 | 30분 | LLM 호출 간 최소 간격 |
| 일일 최대 호출 | 12회 | 비용 제어 |
| 연속 손실 후 | 4시간 | 2연속 손실 트레이드 후 냉각 |
| 관심(5~7점) 알림 | 1시간 | Telegram 스팸 방지 |

### LLM 호출 시 전달 컨텍스트

```
[트리거 요약]
- 트리거 점수: 9/15
- 트리거된 지표: RSI(14)=22.3 (극저), EMA 크로스 (골든), 거래량 3.2x 급증
- 심볼: ETH-PERP
- 방향 편향: LONG (3/3 지표 일치)

[기술적 데이터]
- 현재가, 1h/4h/24h 변동, RSI, EMA, ATR
- 볼린저 밴드, 지지/저항선
- OI, 펀딩레이트, 거래량 (vs 24h 평균)

[포지션 상태]
- 현재 오픈 포지션, 가용 자본
- 오늘 PnL, 최근 5거래 승률

[요청]
진입 가치 판단 → 방향/레버리지/진입가/SL/TP를 JSON 제안
또는 "기회 아님" + 이유
```

### 예상 비용

| 시장 상태 | 일일 LLM 호출 | 월 비용 (Haiku) |
|----------|--------------|----------------|
| 횡보장 | 2~4회 | ~$1 |
| 보통 | 5~8회 | ~$2 |
| 급등/급락 | 8~12회 | ~$3 |

### 구현 파일 매핑

| 파일 | 변경 내용 |
|------|----------|
| `src/strategies/discretionary/scorer.ts` | **신규** - 스코어링 엔진 |
| `src/strategies/discretionary/analyzer.ts` | 확장 - 볼린저, OI, 볼륨 지표 추가 |
| `src/strategies/discretionary/index.ts` | 리팩토링 - 15분 고정 → 스코어 트리거 |
| `src/strategies/discretionary/llm-advisor.ts` | 유지 - 호출 빈도만 변경 |
| `src/core/types.ts` | 타입 추가 - TriggerScore, CooldownState |

### 전략 제거/비활성화 시 변경 파일

| 파일 | 변경 내용 |
|------|----------|
| `src/index.ts` | Funding Arb 등록 제거 |
| `src/config/strategies.ts` | 자본 배분 비율 변경 |

---

## Tech Stack

| 영역 | 기술 |
|------|------|
| Runtime | Node.js 22+ / TypeScript 5 (strict, ESM) |
| Exchange | Hyperliquid (`hyperliquid` SDK v1.7.7) |
| DB | `better-sqlite3` (SQLite, WAL mode) |
| Telegram | `grammy` |
| Logging | `pino` |
| Config | `zod` v4 + `dotenv` |
| Math | `decimal.js` |
| LLM | `@anthropic-ai/sdk` (Discretionary 분석) |
| TA | `technicalindicators` (RSI, EMA, ATR) |
| Deploy | Hetzner VPS + PM2 + GitHub Actions |

---

## 개발 환경

### Repository
- **GitHub**: https://github.com/cuzis1723/tradebot
- **Branch**: `claude/pedantic-heisenberg` (개발), `main` (안정)
- **PR**: https://github.com/cuzis1723/tradebot/pull/1

### VPS (Production)
- **Provider**: Hetzner CX22 (2 vCPU, 4GB RAM, 40GB SSD)
- **IP**: 89.167.31.117
- **OS**: Ubuntu 24.04
- **User**: tradebot
- **Path**: /home/tradebot/project/tradebot
- **Process**: PM2 (`ecosystem.config.cjs`)

### CI/CD
- **GitHub Actions**: `.github/workflows/deploy.yml`
- **트리거**: `claude/pedantic-heisenberg` 또는 `main` push 시
- **플로우**: SSH → git pull → npm install → build → pm2 restart → Telegram 알림

### 환경 변수 (.env)
```
HL_PRIVATE_KEY=         # Hyperliquid private key (필수)
HL_USE_TESTNET=true     # testnet 사용 여부
TG_BOT_TOKEN=           # Telegram bot token
TG_CHAT_ID=             # Telegram chat ID
ANTHROPIC_API_KEY=      # Claude API key (Discretionary용)
ANTHROPIC_MODEL=        # LLM 모델 (default: claude-haiku-4-5-20251001)
INITIAL_CAPITAL_USD=    # 초기 자본
```

---

## Project Structure

```
tradebot/
├── .github/workflows/
│   └── deploy.yml                    # GitHub Actions 자동 배포
├── src/
│   ├── index.ts                      # Entry point
│   ├── config/
│   │   ├── index.ts                  # Env config (zod validation)
│   │   └── strategies.ts             # Strategy default configs
│   ├── core/
│   │   ├── engine.ts                 # Main orchestrator
│   │   ├── risk-manager.ts           # Drawdown/position limits
│   │   └── types.ts                  # All shared types
│   ├── exchanges/
│   │   └── hyperliquid/
│   │       ├── client.ts             # HL REST + WS adapter (singleton)
│   │       └── types.ts              # HL-specific types
│   ├── strategies/
│   │   ├── base.ts                   # Abstract Strategy class
│   │   ├── grid/
│   │   │   └── index.ts              # Grid trading
│   │   ├── funding-arb/
│   │   │   └── index.ts              # Funding rate arbitrage
│   │   ├── momentum/
│   │   │   └── index.ts              # EMA crossover + RSI momentum
│   │   └── discretionary/
│   │       ├── index.ts              # Discretionary strategy (score-triggered v2)
│   │       ├── analyzer.ts           # Market technical analysis (BB, OI, VolumeRatio)
│   │       ├── scorer.ts             # Score-based trigger engine (13 indicators)
│   │       └── llm-advisor.ts        # Anthropic API LLM advisor (trigger-aware)
│   ├── data/
│   │   └── storage.ts                # SQLite persistence
│   └── monitoring/
│       ├── telegram.ts               # Telegram bot + all commands
│       └── logger.ts                 # Pino logger
├── scripts/                          # 테스트/유틸리티 스크립트
├── ecosystem.config.cjs              # PM2 설정
├── package.json
└── tsconfig.json
```

---

## Key Implementation Notes

### Hyperliquid SDK
- Symbols: `BTC-PERP`, `ETH-PERP` format
- 테스트넷 mids 키: `ETH-PERP` format (메인넷은 `ETH`)
- Unified Account: Spot USDC가 자동으로 Perp 마진으로 사용
- Init: `new Hyperliquid({ enableWs: true, privateKey, testnet })`
- Candle: `sdk.info.getCandleSnapshot(coin, interval, startTime, endTime)`
- Funding: `sdk.info.perpetuals.getMetaAndAssetCtxs()` → `[meta, assetCtxs[]]`

### decimal.js ESM Import
ESM + TypeScript에서 반드시 `import { Decimal } from 'decimal.js'` 사용.
`import Decimal from 'decimal.js'`는 namespace 타입 오류 발생.

### Telegram Commands
- **General**: /status, /pnl, /pause, /resume, /stop, /help
- **Discretionary**: /market, /score, /cooldown, /idea, /approve, /modify, /reject, /positions, /close, /ask

---

## Development Commands

```bash
npm run dev        # tsx watch src/index.ts (로컬 개발)
npm run build      # tsc (TypeScript 컴파일)
npm start          # node dist/index.js (프로덕션)
npm test           # vitest
npm run lint       # eslint
```
