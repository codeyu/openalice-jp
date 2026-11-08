---
name: jp-disclosure
description: >
  Read Japanese listed-company disclosures: TDnet 適時開示 (決算短信, 業績予想の修正,
  new-drug approvals, M&A, buybacks — last 31 days, no key) and EDINET 法定開示
  (有価証券報告書, 半期報告書, 臨時報告書, 大量保有報告書 — needs EDINET_API_KEY).
  Use for any Japanese stock (4-character TSE code such as 7203 or 130A) when the
  task needs earnings figures, guidance changes, or material company events.
---

# jp-disclosure (read-only)

Primary sources for Japanese equities. A company must publish material events on
TDnet before or at the same time as any press coverage, so check here before
relying on news articles.

Run the bundled script from the Workspace root (Node 18+, no install):

```bash
node .agents/skills/jp-disclosure/scripts/jp-disclosure.mjs --help
```

(`.claude/skills/jp-disclosure/...` is the same file.)

## Which source

| Need | Command |
|------|---------|
| What did 4502 announce recently? | `tdnet list --code 4502 --days 31` |
| Latest 決算短信 numbers | `tdnet list --code 6976 --days 31 --query 決算短信`, then `tdnet summary <xbrl url>` |
| Guidance revisions, approvals, buybacks across the market today | `tdnet list --query '業績予想の修正\|承認\|自己株式'` |
| Full PDF of a disclosure | `tdnet download <pdf url>` and read the PDF |
| Management commentary (定性的情報) | `tdnet download <xbrl url>` → `XBRLData/Attachment/qualitative.htm` |
| Older than 31 days, annual/semiannual reports, multi-year financials | `edinet list --code 6976 --type 120,160 --date YYYY-MM-DD --days 7` → `edinet download <docID>` |
| Who is building a stake (5% rule) | `edinet list --type 350 --query <company>` |

`--json` gives machine-readable output for every command. `--query` is a
case-insensitive regex over title and company name. `--code` accepts a
comma-separated list.

## Reading results

- `tdnet summary` prints the 決算短信 summary by XBRL context.
  `Current…ResultMember` is this period's actual result, `Prior…` the same period
  last year, and `CurrentYearDuration…ForecastMember` the company's full-year
  guidance. `Change…` items are year-on-year changes. IFRS filers use names ending in
  `IFRS` (`SalesIFRS`, `ProfitAttributableToOwnersOfParentIFRS`).
- Amounts are shown in 百万円 and percentages as %. `--json` keeps exact values
  (JPY in yen, ratios as fractions) and nil cells.
- Titles starting with （訂正） are corrections. Cite the corrected figures and mention the correction.
- `edinet download` defaults to `--type csv`: XBRL converted to UTF-8 tab-separated
  files that `grep` can search (for example `grep -r 売上高 .jp-disclosure/edinet/<docID>`).
  Use `--type pdf` to read the filing as published.

## Rules

- Cite the disclosure (company, title, date, PDF URL) for every figure you report.
- Downloads go to `.jp-disclosure/` by default. That folder ignores itself in Git,
  so raw filings stay out of the Workspace history. Put conclusions in your report,
  not the raw files.
- TDnet is a public viewing site, not an API. Keep queries narrow (`--code`, a few
  `--days`), never loop or crawl it, and do not redistribute its documents. The
  script waits between pages and caches past days.
- A `tdnet list` covering many days takes up to a minute on first run. That is
  expected; do not run several in parallel.
- EDINET needs a key. If the script says it is missing, tell the user to register
  at https://api.edinet-fsa.go.jp/ and set `EDINET_API_KEY` or
  `$OPENALICE_HOME/data/config/jp-disclosure.json` (`{"edinetApiKey": "..."}`).
  Never ask for the key in chat or write it into Workspace files.
- This Skill covers filings only. For news coverage, analyst views or sector
  context, use the RSS archive (`alice rss`) or your own web search, and label the
  source as secondary.
