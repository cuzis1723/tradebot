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
- **정보 우위 = 진짜 엣지**: TA만으로는 공개정보 역설 (승률 42-48% 한계), 외부 정보 소스와 결합해야 알파 생성

### 전략 구성 (v3 - Agent 토론 합의)

| 전략 | 역할 | 자본 | 모드 |
|------|------|------|------|
| **Discretionary v3 (Core)** | 정보+TA 종합, 메인 수익원 | 55% ($550) | 반자동 → 조건부 자동 |
| **Momentum (Support)** | 자동 트렌드 팔로잉 | 25% ($250) | Auto |
| **Equity Cross** | 크립토-주식 상관관계 | 10% ($100) | Auto |
| **현금 버퍼** | 급변 시 기동 자본 | 10% ($100) | - |
| ~~Grid~~ | ~~제거 — $1,000에서 의미 없음~~ | - | - |
| ~~Funding Arb~~ | ~~제거 — HLP/Theo가 더 잘함~~ | - | - |
| ~~Token Sniping~~ | ~~보류 — MEV 경쟁 + 자본 부족~~ | - | - |

### 레버리지 정책 (확정)

| 확신도 | 레버리지 | 조건 | 빈도 |
|--------|----------|------|------|
| 최고 (정보+TA 완벽 일치) | 10-15x | Polymarket 급변 + TA 확인 | 연 5-10회 |
| 높음 (정보 우위 + TA 확인) | 5-10x | 외부 소스 시그널 + scorer 8+ | 월 3-5회 |
| 중간 (TA 시그널 위주) | 3-5x | 일반 트리거 | 일반 |
| Momentum (자동) | 3x | 현재 5x에서 하향 | 자동 |

### 목표
- 기대 수익: 연 35-60% (보수적), 월 2.5-4% 기본
- 최대 드로다운 20% 하드 스톱 (생존 최우선)
- 월 10~20회 트레이드 (질 > 양)

---

## Strategy Overview (현재 코드 상태)

| Strategy | Status | 비고 |
|----------|--------|------|
| Discretionary v3 | ✅ Implemented | Skill Pipeline + Multi-agent (Propose-Critique) |
| Brain (Dual-loop) | ✅ Implemented | 30분 종합 (Dual Perspective) + 5분 긴급 |
| Momentum Trading | ✅ Implemented | EMA crossover + RSI + ATR |
| External Intelligence | ✅ Implemented | Polymarket + DefiLlama + CoinGecko |
| Scorer (13 indicators) | ✅ Implemented | 가격/모멘텀/변동성/볼륨/구조/크로스 |
| Telegram (확장) | ✅ Implemented | 20+ 명령어 + Web Dashboard |
| Web Dashboard | ✅ Implemented | PnL 차트, 포지션, 스코어, 의사결정 로그 |
| Grid Trading | ✅ Implemented (비활성) | 코드 유지, 엔진에서 미사용 |
| Funding Rate Arb | ✅ Implemented (비활성) | 엔진에서 제거됨 |

---

## TODO: 감사 결과 수정 사항 (2026-02-13)

> 전체 감사 리포트: `docs/audit-report-2026-02-13.md`

### Phase 0: 메인넷 전 필수 (BLOCKING)

| # | 이슈 | 파일 | 상태 |
|---|------|------|------|
| CRIT-1 | 마진 계산 틀림 (notional을 margin으로 오인) | `src/core/skills/code-skills.ts:232` | ✅ DONE |
| CRIT-2 | Discretionary SL/TP가 거래소 주문 아님 (메모리만) | `src/strategies/discretionary/index.ts:169` | ✅ DONE |
| CRIT-3 | Discretionary 포지션 DB 미저장 (PM2 재시작 시 유실) | `src/strategies/discretionary/index.ts:34` | ✅ DONE |
| CRIT-4 | 크로스 레버리지 캡 없음 (총 노셔널 무제한) | `src/core/risk-manager.ts:138` | ✅ DONE |
| CRIT-8 | /do 명령 무제한 LLM 실행 (위험 도구 접근) | `src/monitoring/telegram.ts` | ✅ DONE |
| CRIT-9 | 대시보드 인증 없음 (CORS *, API 키 없음) | `src/dashboard/server.ts:39` | ✅ DONE |

### Phase 1: 수학/알고리즘 수정

| # | 이슈 | 파일 | 상태 |
|---|------|------|------|
| CRIT-5 | Scorer 충돌 페널티가 신호 파괴 (`min(L,S)` → `-1`로) | `src/strategies/discretionary/scorer.ts:242` | ⬜ TODO |
| CRIT-6 | 모멘텀 SL 무제한 (`2×ATR` → `min(2×ATR, 5%)` 캡) | `src/strategies/momentum/index.ts:235` | ⬜ TODO |
| CRIT-7 | TP가 currentPrice 기준 (entryPrice 기준으로 변경) | `src/strategies/momentum/index.ts:238` | ⬜ TODO |
| CRIT-10 | LLM SL 규칙과 코드 불일치 (validation 추가) | `src/core/skills/llm-decide.ts:44` | ⬜ TODO |
| WARN-3 | S/R 계산 naive (스윙 포인트 클러스터링으로 교체) | `src/strategies/discretionary/analyzer.ts:122` | ⬜ TODO |
| WARN-4 | OI 변화 시계열 오염 (타임스탬프 정규화) | `src/strategies/discretionary/analyzer.ts:206` | ⬜ TODO |
| WARN-5 | Kelly 기본값 낙관적 (b=1.5 → b=1.0) | `src/strategies/base.ts:212` | ⬜ TODO |
| WARN-6 | 모멘텀 쿨다운 과도 (4h → 1-2h) | `src/strategies/momentum/index.ts:45` | ⬜ TODO |
| WARN-7 | ADX 기간 부적절 (14 on 1h → 7-10) | `src/strategies/momentum/index.ts:146` | ⬜ TODO |
| WARN-9 | 연속 손실 쿨다운 비동기 (base vs scorer) | `src/strategies/base.ts:79` | ⬜ TODO |

### Phase 2: 시그널 검증

| # | 이슈 | 파일 | 상태 |
|---|------|------|------|
| SIG-1 | 외부 소스별 예측 정확도 추적 테이블 추가 | `src/data/storage.ts` | ⬜ TODO |
| SIG-2 | 소스별 가중치 도입 (동일 가중치 → 예측력 비례) | `src/data/sources/index.ts` | ⬜ TODO |
| SIG-3 | CoinGecko 트렌딩 → "이미 급등" 경고 재분류 | `src/data/sources/coingecko.ts` | ⬜ TODO |
| SIG-4 | Equity Cross 상관관계 윈도우 2h → 7d | `src/strategies/equity-cross/index.ts` | ⬜ TODO |

### Phase 3: 인프라 강화

| # | 이슈 | 파일 | 상태 |
|---|------|------|------|
| INFRA-1 | PM2 kill_timeout: 10000, max_memory: 1G | `ecosystem.config.cjs` | ⬜ TODO |
| INFRA-2 | 모든 HL API에 10초 타임아웃 | `src/exchanges/hyperliquid/client.ts` | ⬜ TODO |
| INFRA-3 | 전략 시작 전 프리플라이트 체크 | `src/core/engine.ts` | ⬜ TODO |
| INFRA-4 | 텔레그램 하트비트 + 자동 재연결 | `src/monitoring/telegram.ts` | ⬜ TODO |
| INFRA-5 | API 실패 서킷 브레이커 (3회 연속 → 일시정지) | `src/exchanges/hyperliquid/client.ts` | ⬜ TODO |

---

## 완료된 작업 (Done)

### Phase 1: Grid Bot ✅
- Hyperliquid perp 기반 그리드 트레이딩
- 설정 가능한 그리드 레벨, 스프레드, 주문 크기
- 자동 그리드 재배치 및 PnL 추적

### Phase 2: Funding Rate Arb ✅ (비활성)
- 5분 주기 펀딩 레이트 스캔 (전 종목)
- OI $500k+, Volume $100k+ 필터
- v2에서 엔진에서 제거 (프로토콜 대체)

### Phase 2.5: Discretionary v1 → v2 ✅
- 15분 주기 → 스코어 트리거 기반 전환
- 13개 지표 스코어링 엔진 (scorer.ts)
- 볼린저 밴드, OI, 볼륨 지표 추가
- 쿨다운 시스템 (심볼별 2h, 글로벌 30min, 일일 12회)

### Phase 3: Momentum Trading ✅
- EMA(9/21) 크로스오버 시그널
- RSI 필터 (과매수/과매도 회피)
- ATR(14) 기반 SL (2x ATR) / TP (3x ATR)
- 심볼별 4시간 시그널 쿨다운
- Brain directive 연동 (allowLong/allowShort/leverageMultiplier)

### Phase 4: Brain + External Intelligence ✅
- Brain 듀얼 루프 (30분 종합 + 5분 긴급)
- Polymarket Gamma API (예측시장 확률) — API 키 불필요
- DefiLlama (DeFi TVL 변동) — API 키 불필요
- CoinGecko (트렌딩 코인) — API 키 불필요
- 전략별 Brain directive 수신 인터페이스
- LLM 토큰 사용량 추적 + 비용 추정

### Infrastructure ✅
- Hyperliquid 거래소 어댑터 (REST + WebSocket + 캔들 + 펀딩)
- 트레이딩 엔진 + 전략 라이프사이클 관리 (start/stop/pause/resume)
- 리스크 매니저 (드로다운 보호, 포지션 제한)
- SQLite 트레이드 로깅 (WAL mode)
- Telegram 봇 (/balance, /usage, /brain, /info 등 20+ 명령어)
- Zod v4 환경변수 검증

### DevOps ✅
- VPS 배포 (Hetzner CX22, Ubuntu 24.04)
- PM2 프로세스 매니저
- GitHub Actions 자동 배포 (push → SSH → build → restart)
- Telegram 배포 알림

---

## [설계] v3 아키텍처

### 듀얼 루프 아키텍처 (확정, 구현 완료)

```
[30분 종합 분석]                    [5분 긴급 트리거]
  Polymarket 확률 변동               기존 scorer 13개 지표
  DefiLlama TVL 변화                 가격 급변 (>2.5%/1h)
  CoinGecko 트렌딩                   OI 급변 (>5%/1h)
  Equity Perps 상관관계 (Phase 3)    Polymarket 급변 (>15%p/30m)
  시장 레짐 판단                     거래량 스파이크 (5x+)
       ↓                                  ↓
  LLM 종합 판단                     스코어 8+ → 긴급 LLM 호출
  → 포트폴리오 방향 설정             → 즉시 트레이드 제안
  → 관심 종목/내러티브 업데이트       → Telegram 알림
```

### Scorer 지표 (13개 구현 완료)

| 카테고리 | 지표 | 트리거 조건 | 점수 |
|----------|------|------------|------|
| **가격 급변** | 1h 변동률 | \|변동\| > 2.5% | +3 |
| | 4h 변동률 | \|변동\| > 5% | +3 |
| **모멘텀** | RSI(14) | < 25 또는 > 75 | +3 |
| | EMA(9/21) 크로스 | 1h 내 크로스오버 발생 | +3 |
| **변동성** | ATR 급등 | 현재 ATR > 1.5x 20봉 평균 ATR | +2 |
| | 볼린저 밴드 돌파 | 종가가 2σ 밖으로 돌파 | +2 |
| **볼륨** | 거래량 급증 | 1h 거래량 > 3x 24h 평균 | +3 |
| **시장 구조** | 지지/저항 도달 | 주요 S/R 레벨 ±0.5% 이내 | +2 |
| | OI 급변 | 1h OI 변화 > 5% | +2 |
| | 펀딩레이트 극단 | \|funding\| > 0.05%/h | +1 |
| **크로스 심볼** | BTC 급변 시 알트 | BTC 3%+ 이동 + 알트 미반영 | +3 |

### 복합 스코어 & 임계값

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

### 쿨다운 규칙

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
- 외부 소스: Polymarket BTC ETF 승인 72% (+18%p/2h)
- 심볼: ETH-PERP
- 방향 편향: LONG (3/3 지표 일치)

[기술적 데이터]
- 현재가, 1h/4h/24h 변동, RSI, EMA, ATR
- 볼린저 밴드, 지지/저항선
- OI, 펀딩레이트, 거래량 (vs 24h 평균)

[외부 인텔리전스]
- Polymarket: 주요 이벤트 확률 변동
- DefiLlama: 체인별 TVL 흐름
- CoinGecko: 트렌딩 코인/리테일 심리

[포지션 상태]
- 현재 오픈 포지션, 가용 자본
- 오늘 PnL, 최근 5거래 승률

[요청]
진입 가치 판단 → 방향/레버리지/진입가/SL/TP를 JSON 제안
레버리지는 확신도에 비례 (3x~15x)
또는 "기회 아님" + 이유
```

### 예상 비용

| 시장 상태 | 일일 LLM 호출 | 월 비용 (Haiku) |
|----------|--------------|----------------|
| 횡보장 | 2~4회 | ~$1 |
| 보통 | 5~8회 | ~$2 |
| 급등/급락 | 8~12회 | ~$3 |

---

## [설계] Equity Perps Cross 전략 (Phase 5-3)

### 개요
크립토-주식 상관관계를 활용한 크로스 마켓 전략. Hyperliquid의 Equity Perps (AAPL, TSLA, NVDA 등)와 크립토 Perps 간의 상관관계/디커플링을 탐지.

### 핵심 아이디어
- NVDA 급등 → AI 관련 크립토 (RENDER, FET 등) 후행 상승 포착
- S&P500 급락 → 크립토 동반 하락 예측, 숏 또는 헷지
- 크립토-주식 상관관계 이탈 시 수렴 트레이드

### 구현 계획
- 자본: 10% ($100)
- Hyperliquid Equity Perps 가격 모니터링
- 상관관계 테이블 유지 (rolling 30d correlation)
- 디커플링 감지 시 LLM에 컨텍스트 전달

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
| LLM | `@anthropic-ai/sdk` (Discretionary 분석 + Brain 종합) |
| TA | `technicalindicators` (RSI, EMA, ATR, BB) |
| External Data | Polymarket Gamma API, DefiLlama API, CoinGecko API (모두 무료, 키 불필요) |
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
DASHBOARD_PORT=         # 웹 대시보드 포트 (default: 3847)
DASHBOARD_URL=          # 외부 접속 URL (Telegram /dashboard용)
DASHBOARD_API_KEY=      # 대시보드 API 키 (설정 시 /api/* 경로 인증 필수)
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
│   │   ├── brain.ts                  # Brain dual-loop (30min comprehensive + 5min urgent)
│   │   ├── engine.ts                 # Main orchestrator
│   │   ├── risk-manager.ts           # Drawdown/position limits
│   │   ├── trading-tools.ts          # LLM tool-use (get_balance, market_open, etc.)
│   │   ├── types.ts                  # All shared types
│   │   └── skills/
│   │       ├── index.ts              # SkillPipeline orchestrator
│   │       ├── code-skills.ts        # 4 code skills (context/signal/external/risk)
│   │       ├── llm-decide.ts         # LLM skills (decide/critique/regime)
│   │       └── types.ts              # Skill types (CritiqueResult, etc.)
│   ├── exchanges/
│   │   └── hyperliquid/
│   │       ├── client.ts             # HL REST + WS adapter (singleton)
│   │       └── types.ts              # HL-specific types
│   ├── strategies/
│   │   ├── base.ts                   # Abstract Strategy class (Brain directive 수신)
│   │   ├── grid/
│   │   │   └── index.ts              # Grid trading (v3에서 제거 예정)
│   │   ├── funding-arb/
│   │   │   └── index.ts              # Funding rate arbitrage (비활성)
│   │   ├── momentum/
│   │   │   └── index.ts              # EMA crossover + RSI momentum
│   │   └── discretionary/
│   │       ├── index.ts              # Discretionary strategy (score-triggered v2)
│   │       ├── analyzer.ts           # Market technical analysis (BB, OI, VolumeRatio)
│   │       ├── scorer.ts             # Score-based trigger engine (13 indicators)
│   │       └── llm-advisor.ts        # Anthropic API LLM advisor (token tracking)
│   ├── data/
│   │   ├── storage.ts                # SQLite persistence
│   │   └── sources/                  # External intelligence
│   │       ├── index.ts              # InfoSources aggregator
│   │       ├── polymarket.ts         # Polymarket Gamma API
│   │       ├── defillama.ts          # DefiLlama API
│   │       └── coingecko.ts          # CoinGecko API
│   ├── dashboard/
│   │   ├── server.ts                 # HTTP server + API routes
│   │   └── index.html                # Single-page dashboard UI
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

### External APIs (모두 무료, 키 불필요)
- **Polymarket**: `https://gamma-api.polymarket.com/events` — 예측시장 이벤트/확률
- **DefiLlama**: `https://api.llama.fi/v2/chains` — 체인별 TVL
- **CoinGecko**: `https://api.coingecko.com/api/v3/search/trending` — 트렌딩 코인

### Telegram Commands
- **General**: /status, /pnl, /pause, /resume, /stop, /help
- **Account**: /balance, /spotbalance, /usage, /fills, /fundingpaid, /rates, /fees, /ledger
- **Brain**: /brain, /market, /score, /cooldown, /info
- **Discretionary**: /idea, /approve, /modify, /reject, /positions, /close, /ask, /do
- **Dashboard**: /dashboard

---

## Development Commands

```bash
npm run dev        # tsx watch src/index.ts (로컬 개발)
npm run build      # tsc (TypeScript 컴파일)
npm start          # node dist/index.js (프로덕션)
npm test           # vitest
npm run lint       # eslint
```

---

## Agent 토론 배경 (의사결정 기록)

### 토론 요약 (Agent A: 실전 최적화론 vs Agent B: 알파 헌터)

**Agent A** — "Build less, survive more, iterate with data"
- 레버리지 2-5x 보수적, 연 35-60% 기대
- 최소 구현으로 빠른 메인넷 가동, 데이터 수집 우선

**Agent B** — "시장을 이기려면 시장보다 먼저 알아야 한다"
- 레버리지 3-20x 확신도 비례, 연 150-280% 기대
- 정보 우위가 유일한 엣지, 내러티브 시스템 핵심

**합의 결론: Phase 기반 하이브리드**
- Agent A의 "빠른 구현 → 데이터 수집" + Agent B의 "정보 우위 = 진짜 엣지"
- Polymarket 반드시 추가 (양쪽 최고 ROI 합의)
- Grid 축소/제거 ($1,000에서 의미 없음)
- 드로다운 20% 하드 스톱 (생존 최우선)
- Phase 5-1만으로 메인넷 가동 가능, 이후 점진적 확장
