---
name: model-select
description: >
  Select the best LLM model for a task from 33 available models routed through
  BitRouter. Use this skill when choosing which model to use for a specific task,
  optimizing cost vs quality, switching models mid-workflow, or creating
  task-specific routes. Triggers on: model selection, choose model, pick model,
  which model, cost optimization, task routing, model switching.
license: MIT
metadata:
  author: BitRouterAI
  version: "0.1.0"
---

# Model Selection — Task-Aware Routing via BitRouter

You have access to 33 LLM models through BitRouter's OpenRouter upstream.
Rather than using the `auto` load-balancer for every task, **actively select
the right model** based on the task at hand. This saves cost and improves
quality.

---

## Decision Framework

Before starting a task, assess it along two axes:

1. **Complexity**: How hard is the reasoning / how many steps?
2. **Cost sensitivity**: Is this a one-shot or a high-volume repeated task?

Then pick the lowest tier that can handle the job well.

---

## Model Tiers

### Tier 1 — Frontier (complex reasoning, architecture, research)

Use for: multi-file refactors, system design, novel algorithm design, complex
debugging, long-horizon planning, tasks where correctness is critical.

| Model | In $/M | Out $/M | Context | Max Out | Vision | Notes |
|-------|--------|---------|---------|---------|--------|-------|
| anthropic/claude-opus-4.6 | 5.00 | 25.00 | 1M | 128K | yes | Best for long agentic workflows, coding |
| anthropic/claude-opus-4.5 | 5.00 | 25.00 | 200K | 64K | yes | Strong reasoning, file input |
| openai/gpt-5.4 | 2.50 | 15.00 | 1M | 128K | yes | Unified Codex+GPT, massive context |
| google/gemini-3.1-pro-preview | 2.00 | 12.00 | 1M | 65K | yes | Best SWE-bench, audio/video input |
| google/gemini-3-pro-preview | 2.00 | 12.00 | 1M | 65K | yes | Multimodal frontier |
| google/gemini-2.5-pro | 1.25 | 10.00 | 1M | 65K | yes | Thinking model, math/science |

**Cost guidance**: $2–25/M output. Use only when task demands it.

### Tier 2 — Strong (general coding, analysis, most dev work)

Use for: standard feature implementation, code review, writing tests, data
analysis, technical writing, moderate-complexity debugging.

| Model | In $/M | Out $/M | Context | Max Out | Vision | Notes |
|-------|--------|---------|---------|---------|--------|-------|
| anthropic/claude-sonnet-4.6 | 3.00 | 15.00 | 1M | 128K | yes | Best all-round dev model |
| anthropic/claude-sonnet-4.5 | 3.00 | 15.00 | 1M | 64K | yes | Strong coding, file input |
| qwen/qwen3-max-thinking | 0.78 | 3.90 | 262K | 32K | no | Deep chain-of-thought reasoning |
| z-ai/glm-5 | 0.72 | 2.30 | 80K | 131K | no | Systems design, agent workflows |
| moonshotai/kimi-k2.5 | 0.45 | 2.20 | 262K | 65K | yes | Visual coding, agent swarms |
| mistralai/mistral-large-2512 | 0.50 | 1.50 | 262K | — | yes | MoE 675B, good multilingual |
| qwen/qwen3.5-397b-a17b | 0.39 | 2.34 | 262K | 65K | yes | Largest Qwen MoE, vision+video |

**Cost guidance**: $0.40–15/M output. Default tier for most work.

### Tier 3 — Fast (simple tasks, high throughput, cost-sensitive)

Use for: formatting, translation, summarization, triage, simple Q&A, boilerplate
generation, linting, commit messages, quick lookups.

| Model | In $/M | Out $/M | Context | Max Out | Vision | Notes |
|-------|--------|---------|---------|---------|--------|-------|
| anthropic/claude-haiku-4.5 | 1.00 | 5.00 | 200K | 64K | yes | Fast + capable, great value |
| google/gemini-3-flash-preview | 0.50 | 3.00 | 1M | 65K | yes | Fast thinking model, multimodal |
| mistralai/devstral-2512 | 0.40 | 2.00 | 262K | — | no | 123B dense, code specialist |
| google/gemini-2.5-flash | 0.30 | 2.50 | 1M | 65K | yes | Workhorse, audio/video support |
| openai/gpt-5-mini | 0.25 | 2.00 | 400K | 128K | yes | Compact GPT-5, good reasoning |
| qwen/qwen3.5-plus-02-15 | 0.26 | 1.56 | 1M | 65K | yes | 1M context, vision+video |
| qwen/qwen3.5-122b-a10b | 0.26 | 2.08 | 262K | 65K | yes | MoE, good all-round |
| minimax/minimax-m2.5 | 0.20 | 1.17 | 196K | 65K | no | Real-world productivity |
| x-ai/grok-4.1-fast | 0.20 | 0.50 | 2M | 30K | yes | 2M context, great tool calling |
| qwen/qwen3.5-27b | 0.20 | 1.56 | 262K | 65K | yes | Dense, fast, vision+video |
| qwen/qwen3.5-35b-a3b | 0.16 | 1.30 | 262K | 65K | yes | MoE, linear attention, fast |
| openai/gpt-4o-mini | 0.15 | 0.60 | 128K | 16K | yes | Cheap, reliable baseline |
| deepseek/deepseek-chat | 0.32 | 0.89 | 163K | 163K | no | DeepSeek V3, huge output window |
| minimax/minimax-m2.1 | 0.27 | 0.95 | 196K | — | no | Lightweight, coding-focused |
| z-ai/glm-4.5-air | 0.13 | 0.85 | 131K | 98K | no | Agent-focused, lightweight |

**Cost guidance**: $0.13–5/M output. Use for bulk work and simple tasks.

### Tier 4 — Ultra-cheap (maximum throughput, minimal cost)

Use for: batch processing, classification, extraction, format conversion,
simple parsing, test data generation, any task where speed >> quality.

| Model | In $/M | Out $/M | Context | Max Out | Vision | Notes |
|-------|--------|---------|---------|---------|--------|-------|
| openai/gpt-5-nano | 0.05 | 0.40 | 400K | 128K | yes | Smallest GPT-5, ultra-fast |
| xiaomi/mimo-v2-flash | 0.09 | 0.29 | 262K | 65K | no | MoE 309B/15B active, cheapest |
| stepfun/step-3.5-flash | 0.10 | 0.30 | 256K | 256K | no | Cheap MoE, massive output |
| qwen/qwen3-coder-next | 0.12 | 0.75 | 262K | 65K | no | Code-specialist, open-weight |
| deepseek/deepseek-v3.2 | 0.26 | 0.38 | 163K | — | no | Efficient reasoning, tool use |

**Cost guidance**: $0.05–0.75/M output. 10–100x cheaper than frontier.

### Specialist Models

These excel at specific tasks regardless of their tier placement:

| Task | Best Models | Why |
|------|-------------|-----|
| **Code generation** | qwen3-coder-next, devstral-2512, deepseek-v3.2 | Purpose-built for code |
| **Code review / refactor** | claude-sonnet-4.6, devstral-2512, gpt-5.4 | Strong at understanding intent |
| **Multimodal (image)** | gemini-3-pro-preview, claude-sonnet-4.6, kimi-k2.5 | Native vision |
| **Audio/Video** | gemini-2.5-flash, gemini-3-flash-preview, gemini-3-pro-preview | Only Gemini supports A/V |
| **Huge context (>500K)** | grok-4.1-fast (2M), gpt-5.4 (1M), gemini-* (1M), sonnet-4.6 (1M) | Large context windows |
| **Maximum output** | stepfun/step-3.5-flash (256K), deepseek-chat (163K), gpt-5.4/nano (128K) | For long-form generation |
| **Multilingual** | mistral-large-2512, qwen3.5-*, kimi-k2.5 | Strong non-English |
| **Math/Science** | gemini-2.5-pro, qwen3-max-thinking, claude-opus-4.6 | Thinking/reasoning modes |
| **Agentic tool use** | grok-4.1-fast, claude-sonnet-4.6, glm-5, glm-4.5-air | Optimized for tool calling loops |

---

## How to Switch Models

Use the BitRouter CLI to create task-specific routes:

```bash
# Set a named route for the current task type
bitrouter route add my-task openrouter:anthropic/claude-sonnet-4.6

# Create a route with failover (tries in order)
bitrouter route add code-review \
  openrouter:qwen/qwen3-coder-next \
  openrouter:mistralai/devstral-2512 \
  --strategy priority

# Create a load-balanced pool for a task type
bitrouter route add batch-work \
  openrouter:openai/gpt-5-nano \
  openrouter:xiaomi/mimo-v2-flash \
  openrouter:stepfun/step-3.5-flash \
  --strategy load_balance

# Check current routes
bitrouter route list

# Remove a route when done
bitrouter route rm my-task
```

Then use the route name as the model in your API calls:
```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "code-review", "messages": [...]}'
```

---

## Quick Selection Cheatsheet

| Task | Recommended Model | Cost |
|------|-------------------|------|
| Architecture / system design | claude-opus-4.6 | $$$$$ |
| Complex multi-file refactor | gpt-5.4 or gemini-3.1-pro | $$$$ |
| Standard feature / bug fix | claude-sonnet-4.6 | $$$ |
| Code review | devstral-2512 or qwen3-coder-next | $$ |
| Write tests | claude-haiku-4.5 or gpt-5-mini | $$ |
| Simple edit / formatting | gpt-5-nano or mimo-v2-flash | $ |
| Summarize / translate | gpt-5-nano or step-3.5-flash | $ |
| Batch classify / extract | gpt-5-nano or deepseek-v3.2 | $ |
| Image analysis | gemini-2.5-flash or claude-sonnet-4.6 | $$-$$$ |
| Audio/video processing | gemini-2.5-flash or gemini-3-flash | $$ |
| Long document analysis (>500K) | grok-4.1-fast (2M ctx, $0.50/M) | $ |
| Research / deep reasoning | qwen3-max-thinking or gemini-2.5-pro | $$-$$$$ |

---

## Cost Comparison Examples

For a typical 2K input / 1K output task:

| Tier | Model | Cost per call |
|------|-------|---------------|
| Ultra-cheap | gpt-5-nano | $0.0005 |
| Fast | gemini-2.5-flash | $0.003 |
| Strong | claude-sonnet-4.6 | $0.021 |
| Frontier | claude-opus-4.6 | $0.035 |

**A 70x cost difference between cheapest and most expensive.** Choose wisely.
