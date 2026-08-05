// ================================================================
// 採番表検索（サイドバー）2026-08-05実装
//
// 外部スケジュール表（採番表・【スケジュール】タブと同じスプレッドシート）に
// 紐づく専用のApps Scriptプロジェクト。WeeklyReport.gs / Code.gsとは別プロジェクト。
//
// 目的：上長・職人が試作番号・ブランド・企画名・製品名から過去〜現在の案件を
// 検索できるようにする。採番表自体はステータス（進行中/完了/中断）を持たないため、
// 【スケジュール】タブのステータス列も突き合わせて表示する。
//
// 重要：検索処理は採番表・【スケジュール】タブとも読み取り専用。
// setValue系の書き込みは一切行わない（getValuesのみ）。
// ================================================================

const SEIBAN_TABLE_SHEET_NAME = '採番表';

// 採番表の列インデックス（0始まり）。WeeklyReport.gsのT定数と同じ並び。
// 採番表の列構成が変わった場合はWeeklyReport.gs側と揃えて両方直すこと。
const T = {
  seiban: 0, season: 1, brand: 2, category: 3,
  planName: 4, product: 5, registeredDate: 6, note: 7, candidate: 8,
};

// 【スケジュール】タブ側の定数。WeeklyReport.gsのREPORT_CONFIG.scheduleSheetName /
// S定数と同じ値。こちらも列構成が変わった場合は両方直すこと。
const SCHEDULE_SHEET_NAME      = '【スケジュール】2024.01～';
const SCHEDULE_DATA_START_ROW  = 6;   // 1〜5行目は見出し・注意書き
const SCHEDULE_STATUS_COL      = 15;  // O列（WeeklyReport.gsのS.status=14[0始まり]と同じ実列）
const SEIBAN_HEADER            = '製番';
const ARCHIVE_STATUSES         = new Set(['完了', '中断']);

const SEARCH_RESULT_LIMIT = 50;

// ----------------------------------------------------------
// メニュー・サイドバー起動
// ----------------------------------------------------------
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🔍 採番表検索')
    .addItem('検索を開く', 'openSearchSidebar')
    .addToUi();
}

// 図形ボタン・メニューどちらからも呼ばれる
function openSearchSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('SearchSidebar').setTitle('採番表検索');
  SpreadsheetApp.getUi().showSidebar(html);
}

// ----------------------------------------------------------
// 検索本体（読み取り専用）
// ----------------------------------------------------------

// 前後空白除去＋小文字化（大文字小文字を区別しないマッチに使う）
function normalize_(v) {
  return String(v || '').trim().toLowerCase();
}

// 採番表の全データ行を取得
function getSeibanTableRows_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SEIBAN_TABLE_SHEET_NAME);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, T.candidate + 1).getValues();
}

// 【スケジュール】タブの製番列を見出し行（1行目）から探す。見つからなければA列とみなす
// （WeeklyReport.gsのgetOrCreateSeibanColumn_と同じ探し方。ただしこちらは読み取り専用なので列の新設はしない）
function findScheduleSeibanColumn_(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const idx = headers.indexOf(SEIBAN_HEADER);
  return idx === -1 ? 1 : idx + 1;
}

// 【スケジュール】タブを読み、製番ごとに表示用ステータス文字列を返すMapを作る（読み取り専用）
// 判定ルール：
//  ・1行でも「完了」「中断」以外の値があれば「進行中」
//  ・全行が「完了」のみ → 「完了」／全行が「中断」のみ → 「中断」
//  ・「完了」「中断」が混在（進行中の行はなし） → 「完了/中断」
//  ・製番がこのタブに1件も無ければMapに含めない（呼び出し側で「未登録」扱いにする）
function getSeibanStatusMap_() {
  const map = new Map();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SCHEDULE_SHEET_NAME);
  if (!sheet) return map;
  const lastRow = sheet.getLastRow();
  if (lastRow < SCHEDULE_DATA_START_ROW) return map;

  const seibanCol = findScheduleSeibanColumn_(sheet);
  const lastCol   = Math.max(seibanCol, SCHEDULE_STATUS_COL);
  const rows = sheet.getRange(SCHEDULE_DATA_START_ROW, 1, lastRow - SCHEDULE_DATA_START_ROW + 1, lastCol).getValues();

  const statusesBySeiban = new Map();
  rows.forEach(r => {
    const seiban = String(r[seibanCol - 1] || '').trim();
    if (!seiban) return;
    if (!statusesBySeiban.has(seiban)) statusesBySeiban.set(seiban, []);
    statusesBySeiban.get(seiban).push(String(r[SCHEDULE_STATUS_COL - 1] || '').trim());
  });

  statusesBySeiban.forEach((statuses, seiban) => {
    const hasOngoing = statuses.some(s => s && !ARCHIVE_STATUSES.has(s));
    if (hasOngoing) { map.set(seiban, '進行中'); return; }
    const doneValues = new Set(statuses.filter(s => ARCHIVE_STATUSES.has(s)));
    if (doneValues.size === 1) { map.set(seiban, [...doneValues][0]); return; }
    if (doneValues.size > 1)  { map.set(seiban, '完了/中断'); return; }
    // ステータス空欄の行しかない場合、「完了」と誤認しないよう進行中扱いにしておく
    map.set(seiban, '進行中');
  });

  return map;
}

// 登録日セルを比較可能な時刻（ミリ秒）に変換。Date型・文字列どちらでも扱える
function registeredDateTime_(v) {
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

// サイドバーの「検索」からgoogle.script.run経由で呼ばれるメイン処理。
// criteria = { seiban, brand, plan, product }（未入力の項目は検索条件から除外・AND・部分一致）
// 採番表・【スケジュール】タブとも読み取りのみ（setValue系は一切呼ばない）
function searchSeiban(criteria) {
  criteria = criteria || {};
  const seibanQ  = normalize_(criteria.seiban);
  const brandQ   = normalize_(criteria.brand);
  const planQ    = normalize_(criteria.plan);
  const productQ = normalize_(criteria.product);

  if (!seibanQ && !brandQ && !planQ && !productQ) {
    return { total: 0, shown: 0, results: [] };
  }

  const contains = (cell, q) => !q || String(cell || '').toLowerCase().indexOf(q) !== -1;
  const rows = getSeibanTableRows_();

  const matched = rows.filter(r =>
    contains(r[T.seiban],   seibanQ) &&
    contains(r[T.brand],    brandQ) &&
    contains(r[T.planName], planQ) &&
    contains(r[T.product],  productQ)
  );

  const statusMap = getSeibanStatusMap_();

  const sorted = matched
    .map(r => {
      const seiban = String(r[T.seiban] || '');
      return {
        seiban:         seiban,
        brand:          String(r[T.brand] || ''),
        planName:       String(r[T.planName] || ''),
        product:        String(r[T.product] || ''),
        season:         String(r[T.season] || ''),
        category:       String(r[T.category] || ''),
        registeredDate: r[T.registeredDate] instanceof Date
          ? Utilities.formatDate(r[T.registeredDate], 'Asia/Tokyo', 'yyyy/MM/dd')
          : String(r[T.registeredDate] || ''),
        registeredTime: registeredDateTime_(r[T.registeredDate]),
        status: statusMap.get(seiban.trim()) || '未登録',
      };
    })
    .sort((a, b) => b.registeredTime - a.registeredTime);

  return {
    total: sorted.length,
    shown: Math.min(sorted.length, SEARCH_RESULT_LIMIT),
    results: sorted.slice(0, SEARCH_RESULT_LIMIT),
  };
}
