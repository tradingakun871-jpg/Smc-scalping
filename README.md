# SMC Scalping AI

AI analysis service for XAUUSD. Each analysis uses exactly **12 closed M5 candles** (one H1 block). Decision weighting: **70% technical SMC + 30% fundamental**. OpenAI is the final contextual analyst and may return BUY, SELL, or NO_TRADE.

## Endpoints
- GET /health
- POST /api/m5/candle — feed one CLOSED M5 candle; analysis fires after 12 unique candles.
- POST /api/analyze — test with exactly 12 closed M5 candles.

## Railway variables
- OPENAI_API_KEY (required; create a new key and never commit it)
- OPENAI_MODEL (optional, default gpt-5.6-luna)

Fundamental input currently accepts a normalized score 0-100 plus optional DXY/yields/news context. The next production step is connecting live market/fundamental feeds and persistent PostgreSQL storage.
