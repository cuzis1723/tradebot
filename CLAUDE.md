# TradeBot - Crypto Trading Bot System

자동화된 크립토 트레이딩 봇 시스템. $1,000 초기 자본으로 수익 극대화를 목표.

## Tech Stack
- **Runtime**: Node.js 22+ / TypeScript 5 (strict, ESM)
- **Exchange**: Hyperliquid (`hyperliquid` SDK v1.7.7 by nomeida)
- **DB**: `better-sqlite3` (SQLite, WAL mode)
- **Telegram**: `grammy`
- **Logging**: `pino`
- **Config**: `zod` v4 + `dotenv`
- **Math**: `decimal.js` (주의: `import { Decimal } from 'decimal.js'` 사용)
- **LLM**: `@anthropic-ai/sdk` (Discretionary Trading 분석용)
- **Technical Analysis**: `technicalindicators` (RSI, EMA, ATR)

## Strategy Overview

| Strategy | Tier | Capital | Status | Mode |
|----------|------|---------|--------|------|
| Grid Trading | Foundation | 20% | ✅ Complete | Auto |
| Funding Rate Arb | Foundation | 40% | ✅ Complete | Auto |
| Discretionary Trading | Growth | 30% | ✅ Complete | Semi-Auto (Telegram) |
| Momentum Trading | Growth | 30% | ✅ Complete | Auto |
| Token Sniping (Solana) | Moonshot | 10% | ❌ Pending | Auto |

## Project Structure

```
src/
├── index.ts                          # Entry point
├── config/
│   ├── index.ts                      # Env config (zod validation)
│   └── strategies.ts                 # Strategy default configs
├── core/
│   ├── engine.ts                     # Main orchestrator
│   ├── risk-manager.ts              # Drawdown/position limits
│   └── types.ts                      # All shared types
├── exchanges/
│   └── hyperliquid/
│       ├── client.ts                 # HL REST + WS adapter (singleton)
│       └── types.ts                  # HL-specific types
├── strategies/
│   ├── base.ts                       # Abstract Strategy class
│   ├── grid/
│   │   └── index.ts                  # Grid trading
│   ├── funding-arb/
│   │   └── index.ts                  # Funding rate arbitrage
│   ├── momentum/
│   │   └── index.ts                  # EMA crossover + RSI momentum
│   └── discretionary/
│       ├── index.ts                  # Discretionary strategy (semi-auto)
│       ├── analyzer.ts               # Market technical analysis
│       └── llm-advisor.ts            # Anthropic API LLM advisor
├── data/
│   └── storage.ts                    # SQLite persistence
└── monitoring/
    ├── telegram.ts                   # Telegram bot + all commands
    └── logger.ts                     # Pino logger
```

## Key Implementation Notes

### Hyperliquid SDK
- Symbols: `BTC-PERP`, `ETH-PERP` format; mids use raw coin name (`BTC`, `ETH`)
- 테스트넷에서는 mids 키가 메인넷과 다를 수 있음
- Unified Account 활성 시 Spot USDC가 자동으로 Perp 마진으로 사용됨 (transfer 불필요)
- Init: `new Hyperliquid({ enableWs: true, privateKey, testnet })`
- Wallet address는 ethers로 private key에서 자동 유도

### decimal.js ESM Import
ESM + TypeScript에서 반드시 `import { Decimal } from 'decimal.js'` 사용.
`import Decimal from 'decimal.js'`는 namespace 타입 오류 발생.

### Discretionary Trading Flow
1. Bot이 15분마다 시장 자동 분석 (RSI, EMA, ATR, S/R, 트렌드)
2. LLM (Claude API)이 기회 발견 시 Telegram으로 제안 전송
3. 사용자가 `/approve`, `/modify`, `/reject`로 응답
4. 사용자 주도 명령도 지원: `/market`, `/idea`, `/ask`, `/positions`, `/close`

### Telegram Commands
- **General**: /status, /pnl, /pause, /resume, /stop, /help
- **Discretionary**: /market, /idea, /approve, /modify, /reject, /positions, /close, /ask

## Environment Variables
- `HL_PRIVATE_KEY` - Hyperliquid private key (필수)
- `HL_USE_TESTNET` - testnet 사용 여부 (default: true)
- `TG_BOT_TOKEN` / `TG_CHAT_ID` - Telegram bot
- `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` - LLM advisor
- Capital/Risk: `INITIAL_CAPITAL_USD`, `GRID_CAPITAL_PCT`, etc.

## Development Commands
```bash
npm run dev        # tsx watch src/index.ts
npm run build      # tsc
npm start          # node dist/index.js
npm test           # vitest
```

## Implementation Roadmap
- [x] Phase 1: Grid Bot on Hyperliquid (core framework + grid strategy)
- [x] Phase 2: Funding Rate Arbitrage
- [x] Phase 2.5: Discretionary Trading (LLM + Telegram semi-auto)
- [x] Phase 3: Momentum/Trend Following (EMA crossover + RSI + ATR)
- [x] Telegram bot 연동 (testnet 검증 완료)
- [ ] Phase 4: Token Sniping on Solana
- [ ] VPS 배포 (Hetzner)
