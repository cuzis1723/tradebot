# TradeBot System Architecture

## High-Level Overview

```mermaid
graph TB
    subgraph External["External Services"]
        HL_API["Hyperliquid Exchange<br/>(REST + WebSocket)"]
        PM["Polymarket<br/>Gamma API"]
        DL["DefiLlama<br/>API"]
        CG["CoinGecko<br/>API"]
        CLAUDE["Anthropic Claude<br/>Haiku LLM"]
    end

    subgraph Core["Core System"]
        ENGINE["TradingEngine<br/>(Orchestrator)"]
        BRAIN["Brain<br/>(Dual-Loop Intelligence)"]
        RISK["RiskManager<br/>(Drawdown / Position Limits)"]
        SKILLS["SkillPipeline<br/>(Code Skills + LLM)"]
    end

    subgraph Strategies["Trading Strategies"]
        DISC["Discretionary v3<br/>55% Capital / Semi-Auto"]
        MOM["Momentum<br/>25% Capital / Auto"]
        EQ["Equity Cross<br/>10% Capital / Auto"]
    end

    subgraph Infra["Infrastructure"]
        HLC["HyperliquidClient<br/>(Singleton Adapter)"]
        DB["SQLite<br/>(WAL mode)"]
        TG["Telegram Bot<br/>(20+ Commands)"]
        DASH["Web Dashboard<br/>(Port 3847)"]
    end

    USER(("Trader<br/>(Human)"))

    ENGINE -->|"lifecycle mgmt"| DISC
    ENGINE -->|"lifecycle mgmt"| MOM
    ENGINE -->|"lifecycle mgmt"| EQ
    ENGINE -->|"5min periodic check"| RISK
    ENGINE <-->|"state + proposals"| BRAIN

    BRAIN -->|"directives"| DISC
    BRAIN -->|"directives"| MOM
    BRAIN -->|"directives"| EQ
    BRAIN -->|"urgent + comprehensive"| SKILLS

    SKILLS -->|"LLM calls"| CLAUDE
    SKILLS -->|"code skills"| RISK

    HLC -->|"prices / fills"| ENGINE
    HLC <-->|"orders / positions"| DISC
    HLC <-->|"orders / positions"| MOM
    HLC <-->|"orders / positions"| EQ
    HLC <-->|"REST + WS"| HL_API

    BRAIN -->|"fetch signals"| PM
    BRAIN -->|"fetch TVL"| DL
    BRAIN -->|"fetch trending"| CG

    ENGINE -->|"alerts"| TG
    BRAIN -->|"alerts"| TG
    DISC -->|"proposals"| TG
    TG -->|"approve/reject/close"| DISC
    USER <-->|"commands"| TG
    USER -->|"view"| DASH

    ENGINE -->|"log trades"| DB
    BRAIN -->|"log decisions"| DB
    SKILLS -->|"log executions"| DB

    DASH -->|"poll API"| ENGINE
```

---

## Brain Dual-Loop Architecture

Brain은 두 개의 독립 루프로 시장을 분석합니다.

```mermaid
graph LR
    subgraph Comprehensive["30-min Comprehensive Loop"]
        C1["Fetch Candles<br/>(All Symbols)"]
        C2["Fetch External Intel<br/>(Polymarket + DeFi + CoinGecko)"]
        C3["Score All Symbols<br/>(13 Indicators)"]
        C4{"External<br/>Signals?"}
        C5a["assessRegimeTechnical<br/>(TA Only LLM)"]
        C5b["assessRegimeMacro<br/>(External Only LLM)"]
        C5c["assessRegime<br/>(Single LLM)"]
        C6["Merge Assessments"]
        C7["Update MarketState<br/>+ Emit 'stateUpdate'"]

        C1 --> C3
        C2 --> C3
        C3 --> C4
        C4 -->|"Yes"| C5a
        C4 -->|"Yes"| C5b
        C4 -->|"No"| C5c
        C5a --> C6
        C5b --> C6
        C5c --> C7
        C6 --> C7
    end

    subgraph Urgent["5-min Urgent Scan Loop"]
        U1["Fetch Candles<br/>+ Info Sources"]
        U2["Score All Symbols<br/>(Code-based, <50ms)"]
        U3{"Score >= 8?"}
        U4["Check Cooldowns"]
        U5["SkillPipeline<br/>runUrgentDecision()"]
        U6{"Trade<br/>Proposed?"}
        U7["Emit 'tradeProposal'"]
        U8["Log + Skip"]

        U1 --> U2
        U2 --> U3
        U3 -->|"Yes"| U4
        U3 -->|"No (0-7)"| U8
        U4 --> U5
        U5 --> U6
        U6 -->|"Yes"| U7
        U6 -->|"No"| U8
    end

    C7 -->|"Broadcast to<br/>All Strategies"| STRATS["Strategies"]
    U7 -->|"Via Engine"| DISC_S["Discretionary<br/>Strategy"]
```

---

## Skill Pipeline Detail

SkillPipeline은 Code Skills(결정론적)과 LLM Skills(확률적)을 조합합니다.

### Urgent Decision Pipeline (5-min trigger, score >= 8)

```mermaid
graph TD
    INPUT["TriggerScore + Snapshots<br/>+ Brain State + Info Signals"]

    subgraph Phase1["Phase 1: Code Skills (Parallel, <10ms)"]
        SK1["assessContext<br/>regime / direction / risk"]
        SK2["readSignals<br/>score quality / direction"]
        SK3["checkExternal<br/>confirms / contradicts"]
        SK4["assessRisk<br/>capital / drawdown / limits"]
    end

    INPUT --> SK1
    INPUT --> SK2
    INPUT --> SK3
    INPUT --> SK4

    SK4 -->|"canTrade?"| GATE{"Risk<br/>Gate"}
    GATE -->|"false"| EXIT["Early Exit:<br/>no_trade"]

    SK1 --> CTX["DecisionContext"]
    SK2 --> CTX
    SK3 --> CTX
    GATE -->|"true"| CTX

    CTX --> LLM1["LLM decideTrade()<br/>~600ms"]
    LLM1 -->|"no_trade"| EXIT2["Return no_trade"]
    LLM1 -->|"propose_trade"| LLM2["LLM critiqueTrade()<br/>~500ms"]

    LLM2 --> VERDICT{"Critique<br/>Verdict"}
    VERDICT -->|"approve"| PASS["Return Proposal<br/>(Original)"]
    VERDICT -->|"reduce"| ADJUST["Apply Adjustments<br/>(Lower lev/size)"]
    VERDICT -->|"reject"| EXIT3["Return no_trade"]
    ADJUST --> PASS2["Return Proposal<br/>(Modified)"]
```

### Comprehensive Assessment Pipeline (30-min)

```mermaid
graph TD
    INPUT2["All Snapshots + Scores<br/>+ Brain State + Info Signals"]

    subgraph CodePhase["Code Skills Summary"]
        CS1["assessContext()"]
        CS2["readSignals() x N symbols"]
        CS3["checkExternal() x N symbols"]
        CS4["assessRisk()"]
    end

    INPUT2 --> CS1
    INPUT2 --> CS2
    INPUT2 --> CS3
    INPUT2 --> CS4

    CS1 --> COMPRESSED["Compressed Context<br/>(~80 tokens per skill)"]
    CS2 --> COMPRESSED
    CS3 --> COMPRESSED
    CS4 --> COMPRESSED

    COMPRESSED --> CHECK{"Has External<br/>Signals?"}

    CHECK -->|"Yes"| DUAL["Dual Perspective"]
    CHECK -->|"No"| SINGLE["Single Assessment"]

    subgraph DUAL["Dual Perspective (Parallel LLM)"]
        TA["assessRegimeTechnical<br/>(TA context only)"]
        MACRO["assessRegimeMacro<br/>(External context only)"]
    end

    TA --> MERGE["mergeRegimeAssessments()"]
    MACRO --> MERGE

    SINGLE --> OUT["ComprehensiveResponse<br/>regime / direction / riskLevel<br/>confidence / directives"]
    MERGE --> OUT
```

---

## Scorer: 13 Indicators

```mermaid
graph LR
    subgraph Price["Price (max 6pts)"]
        P1["1h Change > 2.5% → +3"]
        P2["4h Change > 5% → +3"]
    end

    subgraph Momentum["Momentum (max 6pts)"]
        M1["RSI < 25 or > 75 → +3"]
        M2["EMA 9/21 Cross → +3"]
    end

    subgraph Volatility["Volatility (max 4pts)"]
        V1["ATR > 1.5x avg → +2"]
        V2["Bollinger Break → +2"]
    end

    subgraph Volume["Volume (max 3pts)"]
        VL1["Volume > 3x avg → +3"]
    end

    subgraph Structure["Structure (max 5pts)"]
        S1["S/R Level ±0.5% → +2"]
        S2["OI Change > 5% → +2"]
        S3["|Funding| > 0.05% → +1"]
    end

    subgraph Cross["Cross-Symbol (max 3pts)"]
        X1["BTC 3%+ & Alt lag → +3"]
    end

    subgraph Bonus["Composite Bonus"]
        B1["3+ same-dir signals → +2"]
        B2["Multi-TF alignment → +2"]
        B3["2+ symbols simultaneous → +1"]
    end

    TOTAL["Total Score"]

    Price --> TOTAL
    Momentum --> TOTAL
    Volatility --> TOTAL
    Volume --> TOTAL
    Structure --> TOTAL
    Cross --> TOTAL
    Bonus --> TOTAL

    TOTAL -->|"0-4"| IGNORE["Ignore"]
    TOTAL -->|"5-7"| ALERT["Alert Only"]
    TOTAL -->|"8-10"| LLM_CALL["LLM Analysis"]
    TOTAL -->|"11+"| URGENT["Urgent LLM<br/>(High Conviction)"]
```

---

## Trade Execution Flow (Discretionary)

```mermaid
sequenceDiagram
    participant HL as Hyperliquid
    participant Brain
    participant SP as SkillPipeline
    participant LLM as Claude LLM
    participant Engine as TradingEngine
    participant Disc as Discretionary
    participant TG as Telegram
    participant User as Trader

    Note over Brain: 5-min Urgent Scan
    Brain->>HL: Fetch candles + meta
    HL-->>Brain: Market data
    Brain->>Brain: Score all symbols (code)

    alt Score >= 8
        Brain->>SP: runUrgentDecision(score, snapshots)
        SP->>SP: 4 Code Skills (parallel)
        SP->>LLM: decideTrade(context)
        LLM-->>SP: TradeProposal
        SP->>LLM: critiqueTrade(proposal)
        LLM-->>SP: CritiqueResult (approve/reduce/reject)
        SP-->>Brain: Final proposal

        Brain->>Engine: emit 'tradeProposal'
        Engine->>Disc: receiveProposal()
        Disc->>TG: Send proposal details
        TG->>User: "ETH-PERP LONG 5x<br/>Entry: $3,200 SL: $3,100 TP: $3,500"

        alt User approves
            User->>TG: /approve <id>
            TG->>Disc: handleApprove(id)
            Disc->>HL: placeOrder(market)
            HL-->>Disc: Order filled
            Disc->>Disc: Track position (SL/TP monitoring)
        else User modifies
            User->>TG: /modify <id> sl=3050
            TG->>Disc: handleModify(id, adjustments)
        else User rejects
            User->>TG: /reject <id>
            TG->>Disc: handleReject(id)
        end
    end
```

---

## Strategy Capital Allocation

```
Total Capital: $1,000
┌──────────────────────────────────────────────────────────────┐
│ Discretionary v3 (55%)  │ Momentum (25%) │ Equity │ Buffer │
│        $550              │     $250       │ $100   │ $100   │
│ Semi-auto, Info+TA      │ Auto, EMA/RSI  │ Auto   │ Reserve│
│ Lev: 3-15x by conviction│ Lev: 3x fixed  │ Lev:3x │        │
└──────────────────────────────────────────────────────────────┘
```

### Leverage Policy by Conviction

```mermaid
graph LR
    subgraph Conviction["Conviction Level"]
        MAX["Highest<br/>(Info + TA perfect)"]
        HIGH["High<br/>(Info + TA confirm)"]
        MED["Medium<br/>(TA signals only)"]
        LOW["Low<br/>(Marginal setup)"]
    end

    MAX -->|"10-15x"| A1["Freq: 5-10/year"]
    HIGH -->|"5-10x"| A2["Freq: 3-5/month"]
    MED -->|"3-5x"| A3["Freq: normal"]
    LOW -->|"3x"| A4["Freq: rare"]
```

---

## Risk Management Layers

```mermaid
graph TD
    subgraph Layer1["Layer 1: Per-Trade"]
        R1["SL/TP on every position"]
        R2["Leverage caps by conviction"]
        R3["LLM Critique gate"]
    end

    subgraph Layer2["Layer 2: Per-Strategy"]
        R4["Consecutive loss tracking<br/>2 losses → 50% size<br/>3 losses → auto-pause"]
        R5["Symbol cooldown: 2h"]
        R6["Strategy drawdown limit: 20%"]
    end

    subgraph Layer3["Layer 3: Cross-Strategy"]
        R7["Cross-exposure check<br/>(40% per symbol max)"]
        R8["Global drawdown: 20% hard stop"]
        R9["Daily loss limit: 10%"]
    end

    subgraph Layer4["Layer 4: System"]
        R10["Brain cooldowns<br/>Global: 30min / Daily: 12 urgent"]
        R11["5-min periodic balance check"]
        R12["Graceful shutdown on SIGINT/SIGTERM"]
    end

    Layer1 --> Layer2 --> Layer3 --> Layer4
```

---

## Data Persistence (SQLite)

```mermaid
erDiagram
    trades {
        int id PK
        string strategy_id
        string symbol
        string side
        float price
        float size
        float fee
        float pnl
        int order_id
        int timestamp
    }

    brain_decisions {
        int id PK
        string type
        string regime
        string direction
        int risk_level
        int confidence
        text reasoning
        string trigger_symbol
        int trigger_score
        string proposal_id
        int timestamp
    }

    trade_proposals {
        int id PK
        string proposal_uuid
        string symbol
        string side
        float entry_price
        float sl
        float tp
        int leverage
        string confidence
        text rationale
        string status
        int timestamp
    }

    skill_executions {
        int id PK
        string pipeline_type
        string symbol
        text context_summary
        text signal_summary
        text external_summary
        text risk_summary
        string decision
        int duration_ms
        int timestamp
    }

    llm_logs {
        int id PK
        string type
        text prompt
        text response
        int input_tokens
        int output_tokens
        float cost_usd
        string model
        int timestamp
    }

    daily_pnl {
        int id PK
        string strategy_id
        string date
        float pnl
        int trades_count
    }

    strategy_state {
        int id PK
        string strategy_id
        text state_json
    }

    brain_decisions ||--o{ trade_proposals : "generates"
    trade_proposals ||--o{ trades : "executes"
    skill_executions ||--o{ brain_decisions : "informs"
    llm_logs ||--o{ skill_executions : "records"
    trades ||--o{ daily_pnl : "aggregates"
```

---

## Component Communication Summary

| From | To | Method | Data |
|------|-----|--------|------|
| Engine | Strategies | `strategy.setMarketState()` | MarketState (directives) |
| Engine | Strategies | `strategy.start(capital)` | Allocated capital |
| Engine | RiskManager | `risk.checkSignal()` | Trade signals |
| Engine | RiskManager | `risk.checkGlobalDrawdown()` | Portfolio value |
| Brain | Engine | EventEmitter `'stateUpdate'` | MarketState |
| Brain | Engine | EventEmitter `'tradeProposal'` | TradeProposal |
| Brain | Engine | EventEmitter `'alert'` | Alert message |
| Brain | SkillPipeline | `pipeline.runUrgentDecision()` | Score + snapshots |
| Brain | SkillPipeline | `pipeline.runComprehensiveAssessment()` | All data |
| SkillPipeline | LLMAdvisor | `decideTrade()` / `critique()` | Compressed context |
| Telegram | Discretionary | `handleApprove()` / `handleReject()` | Proposal ID |
| Discretionary | Telegram | Callback `onProposal` | Formatted proposal |
| All | SQLite | `getDb()` singleton | Trades, decisions, logs |
| All | HyperliquidClient | `getHyperliquidClient()` singleton | Orders, prices, candles |

---

## Deployment Architecture

```mermaid
graph LR
    subgraph Dev["Developer"]
        GIT["git push"]
    end

    subgraph GitHub["GitHub"]
        REPO["cuzis1723/tradebot"]
        GA["GitHub Actions<br/>deploy.yml"]
    end

    subgraph VPS["Hetzner CX22"]
        PM2["PM2 Process Manager"]
        APP["TradeBot (Node.js)"]
        SQLITE["SQLite DB"]
        DASHBOARD["Dashboard :3847"]
    end

    GIT --> REPO --> GA
    GA -->|"SSH → pull → build → restart"| PM2
    PM2 --> APP
    APP --> SQLITE
    APP --> DASHBOARD
```

| Component | Detail |
|-----------|--------|
| VPS | Hetzner CX22 (2 vCPU, 4GB RAM, 40GB SSD) |
| OS | Ubuntu 24.04 |
| Runtime | Node.js 22+ / TypeScript 5 (strict, ESM) |
| Process | PM2 (`ecosystem.config.cjs`) |
| CI/CD | GitHub Actions (push to branch triggers SSH deploy) |
| DB | SQLite WAL mode (`data/tradebot.db`) |
