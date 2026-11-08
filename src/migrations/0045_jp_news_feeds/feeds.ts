/** Frozen copy of the Japanese default feeds as shipped with 0045. Do not edit: later default changes need a new migration. */
export const JP_FEEDS_0045 = [
  {
    "name": "NHK ニュース 経済",
    "url": "https://news.web.nhk/n-data/conf/na/rss/cat5.xml",
    "source": "nhk-economy",
    "categories": [
      "jp",
      "macro"
    ],
    "description": "NHK — 国内経済ニュース（速報性が高い）。",
    "enabled": true
  },
  {
    "name": "Yahoo!ニュース 経済",
    "url": "https://news.yahoo.co.jp/rss/categories/business.xml",
    "source": "yahoo-jp-business",
    "categories": [
      "jp",
      "markets"
    ],
    "description": "Yahoo!ニュース — 経済カテゴリ（各社配信の集約）。",
    "enabled": true
  },
  {
    "name": "東洋経済オンライン",
    "url": "https://toyokeizai.net/list/feed/rss",
    "source": "toyokeizai",
    "categories": [
      "jp",
      "industries"
    ],
    "description": "東洋経済 — 企業・業界分析記事。",
    "enabled": true
  },
  {
    "name": "日本銀行 新着情報",
    "url": "https://www.boj.or.jp/rss/whatsnew.xml",
    "source": "boj",
    "categories": [
      "jp",
      "macro"
    ],
    "description": "日本銀行 — 政策決定、統計、講演。",
    "enabled": true
  },
  {
    "name": "JPX お知らせ",
    "url": "https://www.jpx.co.jp/rss/jpx-news.xml",
    "source": "jpx",
    "categories": [
      "jp",
      "markets"
    ],
    "description": "日本取引所グループ — 市場制度・上場関連のお知らせ。",
    "enabled": true
  },
  {
    "name": "Investing.com 日本 株式ニュース",
    "url": "https://jp.investing.com/rss/news_25.rss",
    "source": "investing-jp-stocks",
    "categories": [
      "jp",
      "markets"
    ],
    "description": "Investing.com 日本語版 — 株式市場ニュース。",
    "enabled": true
  },
  {
    "name": "Investing.com 日本 経済ニュース",
    "url": "https://jp.investing.com/rss/news_14.rss",
    "source": "investing-jp-economy",
    "categories": [
      "jp",
      "macro"
    ],
    "description": "Investing.com 日本語版 — 経済全般ニュース。",
    "enabled": true
  },
  {
    "name": "株探 マーケットニュース",
    "url": "https://kabutan.jp/news/marketnews/",
    "source": "kabutan",
    "categories": [
      "jp",
      "markets"
    ],
    "description": "株探 — 市況・材料・特集の見出し（一覧ページから取得）。",
    "enabled": true,
    "kind": "html",
    "html": {
      "linkPattern": "^/news/marketnews/\\?b=n\\d{12}$",
      "linkDatePattern": "b=n(?<y>\\d{4})(?<m>\\d{2})(?<d>\\d{2})"
    }
  },
  {
    "name": "みんかぶ ニュース",
    "url": "https://minkabu.jp/news",
    "source": "minkabu",
    "categories": [
      "jp",
      "markets"
    ],
    "description": "みんかぶ — 個別株・市況ニュースの見出し（一覧ページから取得）。",
    "enabled": true,
    "kind": "html",
    "html": {
      "linkPattern": "^/news/\\d+$"
    }
  },
  {
    "name": "トレーダーズ・ウェブ ニュース",
    "url": "https://www.traders.co.jp/news/",
    "source": "traders-web",
    "categories": [
      "jp",
      "markets"
    ],
    "description": "トレーダーズ・ウェブ — 個別銘柄の材料・場中ニュース（一覧ページから取得）。",
    "enabled": true,
    "kind": "html",
    "html": {
      "linkPattern": "^/news/article/[\\w-]+$"
    }
  },
  {
    "name": "楽天証券 トウシル",
    "url": "https://media.rakuten-sec.net/",
    "source": "rakuten-toushiru",
    "categories": [
      "jp",
      "markets"
    ],
    "description": "楽天証券の投資情報メディア — 相場見通し・銘柄解説（一覧ページから取得）。",
    "enabled": true,
    "kind": "html",
    "html": {
      "linkPattern": "^/articles/-/\\d+$"
    }
  },
  {
    "name": "マネックス証券 マネクリ",
    "url": "https://media.monex.co.jp/",
    "source": "monex-maneclip",
    "categories": [
      "jp",
      "markets"
    ],
    "description": "マネックス証券の投資情報メディア — ストラテジスト解説（一覧ページから取得）。",
    "enabled": true,
    "kind": "html",
    "html": {
      "linkPattern": "^/articles/-/\\d+$"
    }
  },
  {
    "name": "Investing.com 日本 外為ニュース",
    "url": "https://jp.investing.com/rss/news_1.rss",
    "source": "investing-jp-fx",
    "categories": [
      "jp",
      "fx"
    ],
    "description": "Investing.com 日本語版 — 為替ニュース。",
    "enabled": false
  },
  {
    "name": "Investing.com 日本 マーケット見通し",
    "url": "https://jp.investing.com/rss/market_overview.rss",
    "source": "investing-jp-outlook",
    "categories": [
      "jp",
      "markets"
    ],
    "description": "Investing.com 日本語版 — 相場見通し・コラム。",
    "enabled": false
  },
  {
    "name": "朝日新聞 経済・マネー",
    "url": "https://www.asahi.com/rss/asahi/business.rdf",
    "source": "asahi-business",
    "categories": [
      "jp",
      "macro"
    ],
    "description": "朝日新聞 — 経済ニュース（本文は有料記事を含む）。",
    "enabled": false
  },
  {
    "name": "金融庁 新着情報",
    "url": "https://www.fsa.go.jp/fsaNewsListAll_rss2.xml",
    "source": "fsa",
    "categories": [
      "jp",
      "macro"
    ],
    "description": "金融庁 — 行政処分・制度改正（採用情報なども混在）。",
    "enabled": false
  },
  {
    "name": "ITmedia ビジネスオンライン",
    "url": "https://rss.itmedia.co.jp/rss/2.0/business.xml",
    "source": "itmedia-business",
    "categories": [
      "jp",
      "industries"
    ],
    "description": "ITmedia — 企業・業界ニュース。",
    "enabled": false
  },
  {
    "name": "PRESIDENT Online",
    "url": "https://president.jp/list/rss",
    "source": "president",
    "categories": [
      "jp",
      "industries"
    ],
    "description": "プレジデント — ビジネス・経営記事。",
    "enabled": false
  },
  {
    "name": "ZUU online",
    "url": "https://zuuonline.com/feed",
    "source": "zuuonline",
    "categories": [
      "jp",
      "wealth"
    ],
    "description": "ZUU online — 資産運用・マネー記事。",
    "enabled": false
  },
  {
    "name": "日経 マーケット（wor.jp 非公式ミラー）",
    "url": "https://assets.wor.jp/rss/rdf/nikkei/markets.rdf",
    "source": "nikkei-markets-mirror",
    "categories": [
      "jp",
      "markets"
    ],
    "description": "日経電子版マーケットの見出し。第三者による非公式RSS、本文は日経の有料記事。利用は自己判断で。",
    "enabled": false
  }
]
