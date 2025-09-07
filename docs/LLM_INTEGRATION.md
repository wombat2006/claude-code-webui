# LLM Integration Guide (Merged with Pricing)

This guide documents the production‑ready LLM integration with RAG and **dynamic pricing**. Pricing values are sourced from `MODEL_PRICING.json` and its derived file `MODEL_PRICING_WITH_1K.json` (per‑1k fields).

---

## ✅ Implementation Status

* **RAG + Multi‑LLM** integration complete.
* **Cost tracking** now driven by machine‑readable pricing tables.
* **Fallback** to Mock LLM when providers are unavailable.

---

## Supported Providers / Models (2025)

> Model IDs on each vendor may change; use a central mapping and keep pricing files up to date.

### Anthropic (Claude)

* **Primary models:** `claude-sonnet-4`, `claude-opus-4.1`, `claude-haiku-3.5`
* **Example API IDs:** `claude-sonnet-4-20250514`, `claude-opus-4-1-20250805`

### OpenAI

* **Primary models:** `gpt-5`, `gpt-5-mini`, `gpt-5-nano`, `gpt-4o-mini`, `o3-mini` *(pricing TBD)*
* **Example API IDs:** `gpt-5`, `gpt-5-mini`, `o3-mini`

### Google (Gemini)

* **Primary models:** `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-2.0-flash`, `gemini-2.0-flash-lite`

---

## 🔐 Configuration & Secrets

* API keys via env variables:

  * `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`
* **Production secrets**: managed via **AWS Secrets Manager** (planned/partial). Local dev only may read `.env`.

---

## 🚀 Usage

### Test mode (mock)

```bash
MOCK_LLM=true TZ=Asia/Tokyo node src/testServer.js
```

### Production mode (real APIs)

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-openai-..."
export GOOGLE_API_KEY="AIza..."
export MOCK_LLM=false
TZ=Asia/Tokyo node src/testServer.js
```

### LLM Query (RAG)

```bash
curl -X POST http://localhost:3004/llm/query/your-session-id \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4",
    "query": "Show me AWS Lambda code examples with S3 integration"
  }'
```

---

## 💰 Pricing (from `MODEL_PRICING_WITH_1K.json`)

**Unit:** USD per **1K** tokens (derived), and per **1M** tokens (raw).

> Do **not** hardcode numbers in code. Always read from the JSON files.

### Quick Reference (per‑1k)

| Provider  | Model                 | Input/1k | Output/1k | Notes                                        |
| --------- | --------------------- | -------: | --------: | -------------------------------------------- |
| Anthropic | claude-opus-4.1       |    0.015 |     0.075 | cache & hit rates also in JSON               |
| Anthropic | claude-sonnet-4       |    0.003 |     0.015 |                                              |
| Anthropic | claude-haiku-3.5      |   0.0008 |     0.004 |                                              |
| OpenAI    | gpt-5                 |  0.00125 |   0.01000 | cached input rate available                  |
| OpenAI    | gpt-5-mini            |  0.00025 |   0.00200 |                                              |
| OpenAI    | gpt-5-nano            |  0.00005 |   0.00040 |                                              |
| OpenAI    | gpt-4o-mini           |  0.00060 |   0.00240 | realtime text API noted                      |
| OpenAI    | o3-mini               |        — |         — | pricing TBD (null in JSON)                   |
| Google    | gemini-2.5-pro        |  0.00125 |   0.01000 | long‑prompt input 0.0025/1k, output 0.015/1k |
| Google    | gemini-2.5-flash      |  0.00030 |   0.00250 |                                              |
| Google    | gemini-2.5-flash-lite |  0.00010 |   0.00040 |                                              |
| Google    | gemini-2.0-flash      |  0.00010 |   0.00040 |                                              |
| Google    | gemini-2.0-flash-lite | 0.000075 |   0.00030 |                                              |

*Full details (per‑1M and cache pricing) are in the JSON files.*

---

## 🧮 Cost Calculation (example)

> Reads `MODEL_PRICING_WITH_1K.json`, multiplies by prompt/complete token counts, and records Prometheus metrics.

```ts
// src/cost/costCalculator.ts
import pricing from "../../docs/pricing/MODEL_PRICING_WITH_1K.json";

type Usage = { provider: string; model: string; promptTokens: number; completionTokens: number; tier?: "long"|"standard" };

type Price = { input_per_1k?: number; output_per_1k?: number; input_long_per_mtok?: number; output_long_per_mtok?: number };

export function computeCost(u: Usage): number {
  const p = (pricing.providers as any)?.[u.provider]?.[u.model] as Price | undefined;
  if (!p) throw new Error(`No pricing for ${u.provider}/${u.model}`);
  const in1k = p.input_per_1k ?? 0;
  const out1k = p.output_per_1k ?? 0;
  // Optional long‑prompt tier (e.g., Gemini 2.5 Pro)
  const inputLong1k = p.input_long_per_mtok ? p.input_long_per_mtok/1000 : undefined;
  const outputLong1k = p.output_long_per_mtok ? p.output_long_per_mtok/1000 : undefined;

  const inRate = u.tier === "long" && inputLong1k ? inputLong1k : in1k;
  const outRate = u.tier === "long" && outputLong1k ? outputLong1k : out1k;

  return (u.promptTokens/1000)*inRate + (u.completionTokens/1000)*outRate;
}
```

---

## 📡 API Endpoints

* `POST /llm/query/:sessionId` — executes RAG + LLM call; response includes token counts and computed cost.
* `GET /metrics` — Prometheus exposition (tokens, cost, latency, errors per provider/model).

---

## 🔧 RAG Flow (recap)

1. Receive user query → 2) Retrieve relevant docs → 3) Build enriched prompt → 4) Call selected LLM → 5) Return answer + **usage (tokens, cost, latency)**.

---

## ⚠️ Notes

* Keep `MODEL_PRICING.json` and `MODEL_PRICING_WITH_1K.json` up to date; re‑generate when vendors change pricing.
* `o3-mini` pricing is currently **null** in JSON (pending official table). Add when available.
* Prefer Secrets Manager over `.env` for production API keys.

