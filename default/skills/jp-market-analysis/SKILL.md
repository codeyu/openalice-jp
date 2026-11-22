---
name: jp-market-analysis
description: >
  Top-down workflow for analysing Japanese stocks and the Japanese market:
  regime → drivers → sector rotation → the stock → a stated view. Use for any
  request such as "analyse フジクラ / 5803", "why are AI stocks falling", "what
  should I watch in Japan now", "is X cheap". Produces a judgement with
  scenarios and invalidation, not a recital of financial statements.
---

# Japanese market analysis — top-down, ending in a view

A useful answer explains **why** the price moved and **what to do about it**.
The user can read a 決算短信 themselves; your value is connecting the stock to
the market, the money flow and the news, then committing to a view. Work
through all five steps before answering. Do not stop midway to ask whether to
continue — finish, then offer follow-ups.

Reply in Simplified Chinese (reports included) unless the user asks otherwise.

## 1. Market regime — is it the stock, the sector, or everything?

```bash
traderhub japan breadth                                   # advancers/decliners, TSE 33 industries (equal-weight)
traderhub japan ranking --type sector_gain --limit 33      # official TSE 33-industry index moves
traderhub japan ranking --type weekly_gain                 # also weekly_loss: what moved over the week
alice market bars --bar-id 'yfinance|^N225' --interval 1d --count 60
alice market bars --bar-id 'yfinance|USDJPY' --interval 1d --count 60
alice market bars --bar-id 'yfinance|^SOX' --interval 1d --count 60     # US semiconductors (AI proxy)
alice market bars --bar-id 'yfinance|^GSPC' --interval 1d --count 60    # also ^IXIC, ^VIX
```

State in one line whether the stock's move is idiosyncratic, sector-wide or
market-wide (compare its % move with the Nikkei, its sector index and the US
peer index over the same window).

## 2. Drivers — what changed in the world?

Search **both English and Japanese**. Macro, policy and global-sector drivers
(US politics and elections, the Fed, US tech and AI news, chip export rules,
key executives, tariffs, the yen) mostly break in English first; company and
domestic news in Japanese.

```bash
alice rss grep --pattern 'AI|semiconductor|Nvidia|election|Fed|tariff' --lookback 7d
alice rss grep --pattern 'AI|半導体|選挙|日銀|円安|円高' --lookback 7d
```

The RSS archive only holds subscribed feeds; use your own web search for
current events it does not cover, and cite each source. Name concrete events
with dates. If you cannot confirm a driver, say so — but still state the
leading hypothesis and how to check it.

## 3. Rotation — where did the money go?

Read the TSE 33-industry indices over the last 5–10 trading days, not one day:

```bash
traderhub japan ranking-dates --type sector_gain --limit 10
traderhub japan ranking --type sector_gain --limit 33 --date 2026-11-04   # repeat per date
```

Name the sectors money is leaving and entering (e.g. AI/electric wires,
semiconductors → food, retail, utilities). **Test every narrative against
the numbers**, including the user's: if "money moved into food" but the 食料品
index fell the most on that day, say so and look at more days or at
equal-weight breadth (small caps) before agreeing. Compare equal-weight breadth
with the cap-weighted index to tell large-cap moves from broad ones.

### Comparison baskets — measure rotation with clean proxies

Industry labels are not proxies: many names carry their own story. Compare
these fixed baskets (equal-weight, adjusted closes) over 5 / 20 / 60 sessions
against the Nikkei, and put the result in a table:

| Basket | Codes | What it represents |
|--------|-------|--------------------|
| Defensive consumer | 2702 日本マクドナルド, 4661 OLC, 2579 コカ・コーラBJH, 2587 サントリーBF, 9983 ファストリ | domestic demand, low beta |
| Defensive pharma | 4502 武田, 4503 アステラス, 4523 エーザイ, 4519 中外製薬 | healthcare, low beta |
| Defensive infrastructure | 9020 JR東日本, 9432 NTT, 9503 関西電力 | regulated / utility-like |
| AI & semiconductors | 8035 東京エレクトロン, 6857 アドバンテスト, 6920 レーザーテック, 5803 フジクラ, 5801 古河電工 | AI capex, high beta |
| Robotics & automation | 6324 ハーモニック, 6268 ナブテスコ, 6506 安川電機, 6954 ファナック, 6273 SMC | physical AI / capex cycle |

```bash
for c in 2702 4661 2579 2587 9983; do
  alice market bars --bar-id "kabu|$c" --interval 1d --count 61 --output "/tmp/bars-$c.json"
done
# then compute each name's 5/20/60-session change and the basket average locally
```

Before using any stock as a proxy for its sector, check it has no dominant
story of its own; if it does, leave it out and say why. Known traps:

- **2914 JT** — moves on Russia exposure, not on consumer defensiveness.
- **2802 味の素** — semiconductor material (ABF film): trades partly as AI/semis.
- **4568 第一三共** — ADC growth story with heavy margin buying: trades like growth.
- Names with a fresh split, merger, TOB or guidance shock — check
  `traderhub japan fundamentals` warnings and recent TDnet filings first.

Also check the gap is real, not a data glitch: a move that looks implausible
(e.g. −80% in five days on a large cap) is usually a split not reflected in
`adjusted_close`; cross-check with `yfinance|<code>.T` before using it.

Read the phase of the rotation, not only its direction: when the receiving
basket has already run hard and starts lagging over the last five sessions
while the losing basket stops making new lows, the rotation is maturing —
say chasing the defensives is late, and that this is the turning point to
watch for the losers.

## 4. The stock — only now

```bash
traderhub japan fundamentals --code 5803      # latest 決算短信, forecast, progress, valuation now and vs 2y range
alice market bars --bar-id 'kabu|5803' --interval 1d --count 120
```

Plus `jp-disclosure` for recent TDnet filings that could explain the move.
Keep this section short: the 3–5 facts that matter for the view, not every
line item. Note data gaps (missing bars, delayed valuation history) in one line.

## 5. Answer format

1. **结论** — one or two sentences: the view (e.g. 短期回避 / 观望 / 逢低分批), the
   time horizon, and the main reason.
2. **为什么** — regime and drivers (step 1–2), with dated evidence and sources.
3. **资金流向** — rotation (step 3): out of what, into what; what the data confirms
   or contradicts.
4. **个股** — the few facts from step 4 that support or challenge the view.
5. **情景** — base / bull / bear, each with a trigger to watch (price level,
   event, data release).
6. **失效条件** — what would prove the view wrong.
7. **关注清单** — 2–5 related names or sectors worth watching (e.g. defensive
   value names if money is rotating out of AI), each with one line why.

Label each claim as data (with source and date) or as your inference. A
hypothesis is allowed and expected; present it as one, never as fact. This is
research, not personalised investment advice — say so once, briefly, at the end.
