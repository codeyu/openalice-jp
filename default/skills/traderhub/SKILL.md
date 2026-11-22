---
name: traderhub
description: >
  How to pull LOW-FREQUENCY market data from the `traderhub` CLI: finished
  market boards (macro, movers, calendars, global macro, Fed, shipping,
  term structure, sector rotation), equity fundamentals (profile, financials,
  ratios, estimates, insiders, short interest), ETF drilldowns, FRED/BLS/EIA
  macro series, OECD cross-country indicators, IMF PortWatch shipping, and
  Deribit crypto curves. Use whenever you need a macro number, a fundamental,
  a calendar, or a ready-made board: "what's CPI", "AAPL ratios", "earnings
  this week", "which sectors are rotating in", "Suez canal traffic", "Fed
  balance sheet". Data is served hub-first (hosted TraderHub) with local
  fallback — no API keys needed. Discover flags live with
  `traderhub <group> <verb> --help`; do NOT guess flags.
---

# `traderhub` — low-frequency market data

One binary for everything that updates on hours-to-quarters cadence. Output is
JSON on stdout (pipe to `jq`); a non-zero exit = failure with the reason on
stderr.

```
traderhub <group> <verb> [--flag value]
traderhub --help                  # all groups
traderhub <group> <verb> --help   # a verb's flags
```

**Not here:** K-lines/quotes (realtime — see `alice analysis` + the
`alice-analysis` skill), collected-RSS articles (`alice rss`), trading (use
`alice-uta` — see the `alice-uta` skill).

## Reach for a BOARD before assembling primitives

Boards are the finished product — pre-aggregated, cached, one call:

```bash
traderhub board get --board macro          # 14 US macro cards (rates, CPI YoY, labor, oil, M2…)
traderhub board get --board movers         # gainers/losers/active + 4 screener lists
traderhub board get --board calendar       # earnings + IPOs + ex-dividends, 14d window
traderhub board get --board calendar --days 30
traderhub board get --board valuation      # S&P 500 PE / CAPE / yields
traderhub board get --board term-structure # BTC/ETH futures curve + annualized basis
traderhub board get --board global-macro   # 7 countries × CPI/rates/CLI/house/equity
traderhub board get --board shipping       # 6 maritime chokepoints, daily transit
traderhub board get --board fed            # balance sheet + dealer positioning + FOMC docs
traderhub board rotation                   # GICS sector rotation table (capital flow lens)
```

Every payload carries `meta`: `origin` ("hub" = hosted TraderHub, "local" =
this instance's own keys), `stale: true` = upstream refresh failed, you're
seeing the last good snapshot — say so if it matters to the conclusion.

## Japan market (the user's kabu gateway)

The boards above are US-centric. For Japanese equities read these first:

```bash
traderhub japan breadth                       # advancers/decliners + TSE 33 industries (equal-weight)
traderhub japan ranking-types                 # every ranking id with its Japanese title
traderhub japan ranking --type gain           # also loss, volume, turnover, volume_surge,
traderhub japan ranking --type sector_loss --limit 33   # stop_high/low, weekly_*, credit_*, sector_*
traderhub japan ranking-dates --type sector_gain        # stored days; add --date YYYY-MM-DD to ranking
```

For analysis requests (a stock, "why is X falling", "what to watch") follow
the `jp-market-analysis` skill: market regime and drivers first, the stock last.

Values are the latest stored trading day (end of day), not intraday. Volume
is in thousand shares, trading value in million yen. Breadth sectors are
equal-weight averages; `sector_gain` / `sector_loss` are the official
cap-weighted TSE 33-industry indices — they can differ a lot when large caps
move. "not configured" means the user has not set the kabu gateway in
Settings → Market Data; say so instead of guessing. Japanese K-lines:
`market-data` skill (`kabu|<code>`).

### Japanese stock fundamentals (EDINET DB + J-Quants)

```bash
traderhub japan fundamentals --code 7203        # the stock step of the jp-market-analysis skill
traderhub japan financials --code 7203 --years 3 # full yearly statements, only when needed
```

`fundamentals` returns the latest 決算短信 with the company's effective
full-year forecast and progress %, current forward PER / PBR / dividend yield /
market cap (kabu close ÷ company forecast), 5 years of split-adjusted ratios,
and a 2-year valuation range. Rules:

- The valuation **range** (`valuationHistory`) is computed daily from kabu
  closes and each 決算短信's forecast EPS / BPS, current to the last session;
  `percentile` says where today sits (0 = cheapest of the 2 years). Forward PER
  follows the company forecast, so a cyclical at peak earnings looks cheap —
  compare with `annual` EPS before calling it cheap. If `source` is `jquants`
  the range is a fallback ending ~12 weeks ago; say so.
- Quarterly profit figures are year-to-date in **million yen**; progress % is
  YTD ÷ full-year forecast (Q2 ≈ 50% is on pace), not a beat/miss.
- Read `warnings`: missing keys or an exhausted quota drop parts of the answer.
- Quota is scarce (EDINET DB Free: 100 calls/day, ~3 per new stock). Do not
  loop over many tickers; shortlist with `traderhub japan ranking` / breadth
  first, then call `fundamentals` for the few that matter. Repeats are cached.
- For non-Japanese stocks use the `equity` commands below instead.

### The user's holdings (broker CSV exports)

```bash
traderhub japan holdings                     # newest export per broker, revalued at the latest kabu close
traderhub japan holdings --as-of 2026-11-15  # the export on or before a date
```

Japanese brokers rarely offer APIs, so the user exports holdings CSVs into
`data/holdings/<broker>/` (or a configured extra folder). Supported: SBI証券
「保有証券一覧」(`SBI保有証券一覧_YYYYMMDD.csv`). The result has per-position
account (taxable / nisa-growth / nisa-legacy …), cost, latest value, P&L,
weight, TSE 33 sector and kabuyoho signal; funds at export-time NAV; totals by
account and sector; and `changes` versus the previous export.

- It is research input, not a UTA account: nothing here can place orders.
- `sources[].date` is when the user exported; quantities may have changed since.
  Say the export date when you discuss positions.
- Personal data: summarise (concentration, biggest risks, what changed) rather
  than repeating the whole table; never write it to shared or tracked files.
- For a portfolio review follow the `jp-market-analysis` skill's portfolio section.

## Equity fundamentals

```bash
traderhub equity profile --symbol AAPL
traderhub equity financials --symbol AAPL --type income --period annual --limit 5
traderhub equity ratios --symbol AAPL --period annual --limit 5   # ttm=include by default
traderhub equity estimates --symbol NVDA                          # analyst consensus + price targets
traderhub equity insiders --symbol NVDA --limit 20                # Form-4 transactions
traderhub equity short-interest --symbol GME                      # short shares/ratio/float %
traderhub equity earnings --start-date 2026-06-15 --end-date 2026-06-30
traderhub equity discover --list gainers                          # or: losers, active,
                                   # undervalued_growth, growth_tech, small_caps, undervalued_large
```

## ETF drilldown (the theme workflow)

Broad sectors come from `board rotation`; for a specific theme go one level
deeper:

```bash
traderhub etf search --query uranium
traderhub etf info --symbol URA
traderhub etf holdings --symbol URA       # top constituents
traderhub etf sectors --symbol XLK        # sector weights (decimal fractions)
```

## US macro series (FRED / BLS / EIA)

Workflow: **search for the series id first**, then pull observations.

```bash
traderhub economy fred-search --query "core pce"
traderhub economy fred-series --symbol PCEPILFE --limit 24    # limit = latest N
traderhub economy fred-series --symbol "GDP,UNRATE" --start-date 2020-01-01
traderhub economy fred-regional --symbol WIPCPI               # state-level cross-section
traderhub economy bls-search --query "average hourly earnings"
traderhub economy bls-series --symbol CES0500000003
traderhub economy petroleum --category crude_oil_stocks       # EIA weekly
traderhub economy energy --category retail_gasoline           # EIA short-term outlook
traderhub economy euro-bop --report-type main                 # ECB euro-area balance of payments
```

## Cross-country (OECD)

Country flag takes slugs, comma-separable:
`united_states, china, japan, germany, united_kingdom, india, brazil, france,
italy, canada, australia, south_korea`.

```bash
traderhub global cpi --country china,japan --transform yoy
traderhub global rates --country united_states --duration short
traderhub global leading --country germany          # CLI: 100 = trend, above & rising = expansion
traderhub global house --country canada             # real house price index, 2015=100
traderhub global share --country japan              # equity index, 2015=100
traderhub global retail --country united_kingdom
```

## Shipping (IMF PortWatch) / Fed / crypto curves

```bash
traderhub shipping port-search --query shanghai
traderhub shipping port-volume --port-id <id-from-search>
traderhub shipping chokepoint --name suez           # daily vessels + tonnage
traderhub fed documents                             # FOMC statements/minutes/projections links
traderhub fed balance-sheet                         # WALCL/TREAST/MBS series
traderhub fed dealers                               # primary dealer net positions (NY Fed)
traderhub crypto options --symbol BTC               # Deribit chains (BTC/ETH/PAXG)
traderhub crypto futures --symbol ETH
traderhub index search --query "S&P"                # CBOE index directory
```

## Units — read before comparing numbers

- `percent_change` on movers/discover rows is a **fraction** (0.052 = +5.2%).
- `dividend_yield`, ETF `weight` are **decimal fractions** (0.012 = 1.2%).
- OECD `cpi --transform yoy` and `rates` are **percent units** (3.72 = 3.72%).
- FRED series come in the unit FRED publishes (check the series title).
- `dollar_volume` is price × volume — the only volume number comparable
  ACROSS tickers; `rvol` (volume vs its own 20d average) is the
  unusual-for-itself signal.
