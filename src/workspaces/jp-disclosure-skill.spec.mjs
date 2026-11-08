// Unit tests for the bundled jp-disclosure Skill's pure helpers
// (default/skills/jp-disclosure/scripts/lib.mjs). Plain .mjs because the Skill
// ships as zero-dependency JavaScript into Workspaces.
import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

import {
  decodeText, displayCode, filterEdinetDocs, filterTdnetRows, formatFactValue, isKeySummaryItem,
  normalizeCode, parseIxbrlFacts, parseIxbrlHeader, parseTdnetList, readZip, recentDates, redactKey,
  resolveTdnetUrl, safeEntryPath, summarizeEdinetDoc, tdnetListUrl, tdnetPageCount, todayJst,
} from '../../default/skills/jp-disclosure/scripts/lib.mjs'

function zip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content, method = 8] of files) {
    const nameBuf = Buffer.from(name, 'utf8')
    const raw = Buffer.from(content)
    const data = method === 8 ? deflateRawSync(raw) : raw
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, data)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

const LIST_HTML = `
<div class="kaijiSum">1～100件&nbsp;/&nbsp;全767件</div>
<table border="0" id="main-list-table">
<tr>
<td class="oddnew-L kjTime" noWrap>15:30</td>
<td class="oddnew-M kjCode" noWrap>69760</td>
<td class="oddnew-M kjName" noWrap>太陽誘電　　　</td>
<td class="oddnew-M kjTitle" align="left"><a href="140120261023555108.pdf" target="_blank">2027年３月期 第２四半期 決算短信 &amp; 補足</a></td>
<td class="oddnew-M kjXbrl" noWrap align="center"><div class="xbrl-mask"><div class="xbrl-button"><a class="style002" href="081220261023555108.zip">XBRL</a></div></div> </td>
<td class="oddnew-M kjPlace" noWrap align="left">東                           </td>
<td class="oddnew-R kjHistroy" align="left">　　　　　</td>
</tr>
<tr>
<td class="evennew-L kjTime" noWrap>15:00</td>
<td class="evennew-M kjCode" noWrap>45020</td>
<td class="evennew-M kjName" noWrap>武田薬</td>
<td class="evennew-M kjTitle" align="left"><a href="140120261105000001.pdf" target="_blank">新薬の製造販売承認取得に関するお知らせ</a></td>
<td class="evennew-M kjXbrl" noWrap align="center"> </td>
<td class="evennew-M kjPlace" noWrap align="left">東名福札</td>
<td class="evennew-R kjHistroy" align="left">2026/11/05 16:00 更新</td>
</tr>
</table>`

const IXBRL = `<html><body>
<ix:nonNumeric name="tse-ed-t:CompanyName" contextRef="CurrentYearInstant">太陽誘電株式会社</ix:nonNumeric>
<ix:nonNumeric name="tse-ed-t:FilingDate" contextRef="CurrentYearInstant">2026年11月5日</ix:nonNumeric>
<ix:nonFraction contextRef="CurrentAccumulatedQ2Duration_ConsolidatedMember_ResultMember" decimals="-6" format="ixt:numdotdecimal" name="tse-ed-t:NetSales" scale="6" unitRef="JPY">206,034</ix:nonFraction>
<ix:nonFraction contextRef="Prior" decimals="3" format="ixt:numdotdecimal" name="tse-ed-t:ChangeInNetSales" scale="-2" sign="-" unitRef="Pure">12.9</ix:nonFraction>
<ix:nonFraction contextRef="Prior" name="tse-ed-t:ChangeInOperatingIncome" unitRef="Pure" xsi:nil="true"/>
<ix:nonFraction contextRef="Current" name="tse-ed-t:NetIncomePerShare" decimals="2" format="ixt:numdotdecimal" unitRef="JPYPerShares">63.01</ix:nonFraction>
</body></html>`

describe('jp-disclosure codes and dates', () => {
  it('normalizes 4-character TSE codes to the 5-character disclosure form', () => {
    expect(normalizeCode('7203')).toBe('72030')
    expect(normalizeCode('130a')).toBe('130A0')
    expect(normalizeCode('72030')).toBe('72030')
    expect(() => normalizeCode('72')).toThrow(/invalid securities code/)
    expect(displayCode('130A0')).toBe('130A')
  })

  it('computes JST dates and descending windows', () => {
    expect(todayJst(new Date('2026-11-07T16:00:00Z'))).toBe('2026-11-08')
    expect(recentDates('2026-03-01', 3)).toEqual(['2026-03-01', '2026-02-28', '2026-02-27'])
    expect(() => recentDates('2026/03/01', 1)).toThrow(/invalid date/)
  })
})

describe('jp-disclosure TDnet', () => {
  it('builds paginated list URLs', () => {
    expect(tdnetListUrl('2026-11-06', 2)).toBe('https://www.release.tdnet.info/inbs/I_list_002_20261106.html')
    expect(tdnetPageCount(767)).toBe(8)
    expect(tdnetPageCount(0)).toBe(1)
  })

  it('parses list rows with absolute document links', () => {
    const { total, rows } = parseTdnetList(LIST_HTML, '2026-11-05')
    expect(total).toBe(767)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({
      date: '2026-11-05',
      time: '15:30',
      code: '6976',
      company: '太陽誘電',
      title: '2027年３月期 第２四半期 決算短信 & 補足',
      pdfUrl: 'https://www.release.tdnet.info/inbs/140120261023555108.pdf',
      xbrlUrl: 'https://www.release.tdnet.info/inbs/081220261023555108.zip',
      exchange: '東',
      history: null,
    })
    expect(rows[1]).toMatchObject({ code: '4502', xbrlUrl: null, history: '2026/11/05 16:00 更新' })
  })

  it('filters by code and regex query', () => {
    const { rows } = parseTdnetList(LIST_HTML, '2026-11-05')
    expect(filterTdnetRows(rows, { codes: ['4502'] }).map((r) => r.code)).toEqual(['4502'])
    expect(filterTdnetRows(rows, { query: '承認|買付' }).map((r) => r.code)).toEqual(['4502'])
    expect(filterTdnetRows(rows, { query: '決算短信 &' }).map((r) => r.code)).toEqual(['6976'])
    expect(filterTdnetRows(rows, { query: '(' })).toEqual([])
  })

  it('only resolves documents on the TDnet host', () => {
    expect(resolveTdnetUrl('140120261023555108.pdf')).toBe('https://www.release.tdnet.info/inbs/140120261023555108.pdf')
    expect(() => resolveTdnetUrl('https://example.com/inbs/x.pdf')).toThrow(/not a TDnet/)
    expect(() => resolveTdnetUrl('../other/x.pdf')).toThrow(/not a TDnet/)
  })
})

describe('jp-disclosure inline XBRL', () => {
  it('extracts scaled, signed numeric facts and nil cells', () => {
    const facts = parseIxbrlFacts(IXBRL)
    expect(facts).toEqual([
      { name: 'NetSales', context: 'CurrentAccumulatedQ2Duration_ConsolidatedMember_ResultMember', unit: 'JPY', value: 206034000000 },
      { name: 'ChangeInNetSales', context: 'Prior', unit: 'Pure', value: -0.129 },
      { name: 'ChangeInOperatingIncome', context: 'Prior', unit: 'Pure', value: null },
      { name: 'NetIncomePerShare', context: 'Current', unit: 'JPYPerShares', value: 63.01 },
    ])
    expect(facts.map(formatFactValue)).toEqual(['206,034 百万円', '-12.9%', '—', '63.01 円/株'])
    expect(parseIxbrlHeader(IXBRL)).toEqual({ CompanyName: '太陽誘電株式会社', FilingDate: '2026年11月5日' })
  })

  it('treats IFRS-suffixed names as key summary items', () => {
    expect(isKeySummaryItem('NetSales')).toBe(true)
    expect(isKeySummaryItem('SalesIFRS')).toBe(true)
    expect(isKeySummaryItem('ProfitAttributableToOwnersOfParentIFRS')).toBe(true)
    expect(isKeySummaryItem('FukuokaStockExchange')).toBe(false)
  })
})

describe('jp-disclosure archives and EDINET', () => {
  it('reads stored and deflated zip entries and rejects unsafe paths', () => {
    const entries = readZip(zip([['XBRLData/Summary/a-ixbrl.htm', '<html>決算</html>'], ['b.txt', 'stored', 0]]))
    expect(entries.map((e) => [e.name, e.data.toString('utf8')])).toEqual([
      ['XBRLData/Summary/a-ixbrl.htm', '<html>決算</html>'],
      ['b.txt', 'stored'],
    ])
    expect(safeEntryPath('XBRL_TO_CSV\\a.csv')).toBe('XBRL_TO_CSV/a.csv')
    expect(() => safeEntryPath('../evil.csv')).toThrow(/unsafe/)
    expect(() => safeEntryPath('C:/evil.csv')).toThrow(/unsafe/)
    expect(() => readZip(Buffer.from('not a zip'))).toThrow(/not a zip/)
  })

  it('decodes UTF-16LE EDINET CSV with BOM', () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('"要素ID"\t"値"\n', 'utf16le')])
    expect(decodeText(utf16)).toBe('"要素ID"\t"値"\n')
    expect(decodeText(Buffer.from('plain', 'utf8'))).toBe('plain')
  })

  it('filters and summarizes EDINET document rows', () => {
    const docs = [
      { docID: 'S100AAAA', secCode: '69760', filerName: '太陽誘電株式会社', docTypeCode: '160', docDescription: '半期報告書－第86期', submitDateTime: '2026-11-10 09:00', pdfFlag: '1', csvFlag: '1', xbrlFlag: '1', englishDocFlag: '0', withdrawalStatus: '0' },
      { docID: 'S100BBBB', secCode: null, filerName: 'Fund', docTypeCode: '350', docDescription: '大量保有報告書', submitDateTime: '2026-11-10 10:00' },
    ]
    const hit = filterEdinetDocs(docs, { codes: ['6976'], docTypes: ['120', '160'] })
    expect(hit.map((d) => d.docID)).toEqual(['S100AAAA'])
    expect(filterEdinetDocs(docs, { query: '大量保有' }).map((d) => d.docID)).toEqual(['S100BBBB'])
    expect(summarizeEdinetDoc(docs[0])).toMatchObject({ code: '6976', docTypeName: '半期報告書', files: ['xbrl', 'pdf', 'csv'], withdrawn: undefined })
  })

  it('redacts the API key from messages', () => {
    expect(redactKey('GET ...&Subscription-Key=abc123 failed', 'abc123')).toBe('GET ...&Subscription-Key=*** failed')
  })
})
