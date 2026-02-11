# TradeBot - Crypto Trading Bot System

자동화된 크립토 트레이딩 봇 시스템. $1,000 초기 자본으로 수익 극대화를 목표.

---

## 프로젝트 방향

### 핵심 전략
**안정적 복리 수익(Foundation) + 성장 전략(Growth) + 비대칭 배팅(Moonshot)** 3-tier 결합.

- **Foundation (60%)**: Grid Bot + Funding Rate Arb → 안정적 수익 기반
- **Growth (30%)**: Momentum + Discretionary → 트렌드 추종 + LLM 기반 의사결정
- **Moonshot (10%)**: Token Sniping on Solana → 비대칭 수익 (고위험/고수익)

### 운영 방식
- **자동 전략** (Grid, Funding Arb, Momentum): 24/7 무인 운영
- **반자동 전략** (Discretionary): 봇이 기회 제안 → Telegram으로 사용자 승인
- **테스트넷 우선**: 메인넷 전환 전 충분한 검증

---

## Strategy Overview

| Strategy | Tier | Capital | Status | Mode |
|----------|------|---------|--------|------|
| Grid Trading | Foundation | 20% | ✅ Complete | Auto |
| Funding Rate Arb | Foundation | 40% | ✅ Complete | Auto |
| Momentum Trading | Growth | 30% | ✅ Complete | Auto |
| Discretionary Trading | Growth | 30% | ✅ Complete | Semi-Auto (Telegram) |
| Token Sniping (Solana) | Moonshot | 10% | ❌ Pending | Auto |

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

### Phase 4: Token Sniping on Solana
- [ ] Solana 지갑 연동 (@solana/web3.js v1.98.x)
- [ ] PumpFun 신규 토큰 감지 (Yellowstone gRPC)
- [ ] Raydium 신규 풀 감지
- [ ] 안전 검사 (mint/freeze authority, 유동성, 허니팟)
- [ ] Jupiter 스왑 실행 (@jup-ag/api v6)
- [ ] Jito 번들 전송 (MEV 보호)

### 향후 개선
- [ ] 메인넷 전환 (충분한 테스트 후)
- [ ] Sharpe Ratio 계산 구현
- [ ] 전략별 상세 백테스트
- [ ] 모니터링 대시보드

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
│   │       ├── index.ts              # Discretionary strategy (semi-auto)
│   │       ├── analyzer.ts           # Market technical analysis
│   │       └── llm-advisor.ts        # Anthropic API LLM advisor
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
- **Discretionary**: /market, /idea, /approve, /modify, /reject, /positions, /close, /ask

---

## Development Commands

```bash
npm run dev        # tsx watch src/index.ts (로컬 개발)
npm run build      # tsc (TypeScript 컴파일)
npm start          # node dist/index.js (프로덕션)
npm test           # vitest
npm run lint       # eslint
```
