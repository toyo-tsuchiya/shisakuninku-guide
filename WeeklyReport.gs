// ================================================================
// 試作課 週次集計レポート生成スクリプト
// ================================================================

const REPORT_CONFIG = {
  logSSId:          '15FXg3_YFyA-JGVXhtINm7H5jtlO6l07l0wPDezGgqGs',
  scheduleSSId:     '1vdejHfw6fbgVNJc0BuV3xYEWpNNc6lE5iaQYIIJ-QFs',
  logSheetName:     '日報ログ',
  scheduleSheetName:'【スケジュール】2024.01～',
  reportSSName:     '試作課週次レポート',
};

// 日報ログの列インデックス（0始まり）
const L = {
  date:      1,  // B: 日付
  worker:    2,  // C: 職人名
  actualMin: 6,  // G: 実働(分)
  type:      7,  // H: 種別（サンプル製造 / その他）
  product:   8,  // I: 製品名
  phase:     9,  // J: フェーズ
  workType:  10, // K: 作業種別
  workMin:   11, // L: 作業時間(分)
  laborCost: 13, // N: 労務費(円)
};

// スケジュールSSの列インデックス（0始まり）
const S = {
  brand:        1,  // B: ブランド
  planName:     2,  // C: 企画名
  product:      3,  // D: サンプル製品名称
  phase:        6,  // G: サンプルフェーズ
  deliveryDate: 8,  // I: 納品希望日
  startDate:    9,  // J: 試作開始日
  endDate:      10, // K: 試作完了日
  status:       11, // L: ステータス
};

// ================================================================
// メイン（毎週木曜朝7時に自動実行）
// ================================================================
function generateWeeklyReport() {
  const { startDate, endDate } = getWeekRange();

  const logRows      = getSheetData(REPORT_CONFIG.logSSId,      REPORT_CONFIG.logSheetName,       16);
  const scheduleRows = getSheetData(REPORT_CONFIG.scheduleSSId, REPORT_CONFIG.scheduleSheetName,  12);
  const reportSS     = getOrCreateReportSS();

  // 逆順で挿入すると最終的に左から ①②③ の順になる
  generateWorkTypeReport(reportSS, logRows, startDate, endDate);
  generateProjectReport(reportSS, logRows, scheduleRows, startDate, endDate);
  generateSummaryReport(reportSS, logRows, startDate, endDate);

  Logger.log('週次レポート生成完了: ' + reportSS.getUrl());
}

// 集計期間：前週木曜〜昨日（水曜）
function getWeekRange() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const startDate = new Date(today);
  startDate.setDate(today.getDate() - 7);

  const endDate = new Date(today);
  endDate.setDate(today.getDate() - 1);
  endDate.setHours(23, 59, 59, 999);

  return { startDate, endDate };
}

// ================================================================
// スプレッドシートからデータ取得
// ================================================================
function getSheetData(ssId, sheetName, cols) {
  const sheet = SpreadsheetApp.openById(ssId).getSheetByName(sheetName);
  if (!sheet) throw new Error('シートが見つかりません: ' + sheetName);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, cols).getValues();
}

// ================================================================
// 集計SS取得（なければ新規作成）
// ================================================================
function getOrCreateReportSS() {
  const files = DriveApp.getFilesByName(REPORT_CONFIG.reportSSName);
  if (files.hasNext()) return SpreadsheetApp.open(files.next());
  const ss = SpreadsheetApp.create(REPORT_CONFIG.reportSSName);
  Logger.log('集計SS新規作成: ' + ss.getUrl());
  return ss;
}

// ================================================================
// ① 週次サマリー（職人別）
// ================================================================
function generateSummaryReport(reportSS, logRows, startDate, endDate) {
  const sheetName = '①サマリー_' + rFmt(startDate) + '-' + rFmt(endDate);
  const existing = reportSS.getSheetByName(sheetName);
  if (existing) reportSS.deleteSheet(existing);
  const sheet = reportSS.insertSheet(sheetName, 0);

  sheet.getRange('A1').setValue('試作課 週次サマリー').setFontSize(14).setFontWeight('bold');
  sheet.getRange('A2')
    .setValue('集計期間：' + dFmt(startDate) + '（木） 〜 ' + dFmt(endDate) + '（水）')
    .setFontColor('#666666');

  const HEADER_ROW = 4;
  const headers = ['職人名', '稼働日数', '実働時間(h)', '製造時間(h)', '間接時間(h)', '労務費(円)'];
  sheet.getRange(HEADER_ROW, 1, 1, headers.length)
    .setValues([headers])
    .setBackground('#37474F')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setHorizontalAlignment('center');

  const weekLogs = logRows.filter(r => {
    const d = toDate(r[L.date]);
    return d && d >= startDate && d <= endDate;
  });

  // 職人ごとにグループ化
  const workerMap = new Map();
  for (const r of weekLogs) {
    const worker = r[L.worker];
    if (!worker) continue;
    if (!workerMap.has(worker)) workerMap.set(worker, []);
    workerMap.get(worker).push(r);
  }

  const sortedWorkers = [...workerMap.keys()].sort((a, b) => a.localeCompare(b, 'ja'));

  let row = HEADER_ROW + 1;
  let odd = false;
  let sumDays = 0, sumActual = 0, sumMfg = 0, sumIndirect = 0, sumCost = 0;

  for (const worker of sortedWorkers) {
    const logs = workerMap.get(worker);

    // 稼働日数（ユニーク日付数）
    const workDays = new Set(logs.map(r => dFmt(toDate(r[L.date])))).size;

    // 実働時間: 同日は同じ値が入るため日別の先頭値を合計
    const actualByDate = new Map();
    for (const r of logs) {
      const k = dFmt(toDate(r[L.date]));
      if (!actualByDate.has(k)) actualByDate.set(k, Number(r[L.actualMin]) || 0);
    }
    const actualMin = [...actualByDate.values()].reduce((a, b) => a + b, 0);

    const mfgMin      = colSum(logs.filter(r => r[L.type] === 'サンプル製造'), L.workMin);
    const indirectMin = colSum(logs.filter(r => r[L.type] !== 'サンプル製造'), L.workMin);
    const laborCost   = colSum(logs, L.laborCost);

    sumDays     += workDays;
    sumActual   += actualMin;
    sumMfg      += mfgMin;
    sumIndirect += indirectMin;
    sumCost     += laborCost;

    const dataRange = sheet.getRange(row, 1, 1, headers.length);
    dataRange.setValues([[
      worker,
      workDays,
      +(actualMin   / 60).toFixed(1),
      +(mfgMin      / 60).toFixed(1),
      +(indirectMin / 60).toFixed(1),
      laborCost,
    ]]);
    if (odd) dataRange.setBackground('#F5F5F5');
    row++;
    odd = !odd;
  }

  // 合計行
  if (row > HEADER_ROW + 1) {
    sheet.getRange(row, 1, 1, headers.length)
      .setValues([['合計', sumDays, +(sumActual/60).toFixed(1), +(sumMfg/60).toFixed(1), +(sumIndirect/60).toFixed(1), sumCost]])
      .setFontWeight('bold')
      .setBackground('#ECEFF1');

    const dataRows = row - HEADER_ROW;
    sheet.getRange(HEADER_ROW + 1, 6, dataRows, 1).setNumberFormat('#,##0');
  }

  sheet.setFrozenRows(HEADER_ROW);
  sheet.autoResizeColumns(1, headers.length);
}

// ================================================================
// ② 案件別レポート（製品名のみで突合）
// ================================================================
function generateProjectReport(reportSS, logRows, scheduleRows, startDate, endDate) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const sheetName = '②案件別_' + rFmt(startDate) + '-' + rFmt(endDate);
  const existing = reportSS.getSheetByName(sheetName);
  if (existing) reportSS.deleteSheet(existing);
  const sheet = reportSS.insertSheet(sheetName, 0);

  sheet.getRange('A1').setValue('試作課 週次案件レポート').setFontSize(14).setFontWeight('bold');
  sheet.getRange('A2')
    .setValue('集計期間：' + dFmt(startDate) + '（木） 〜 ' + dFmt(endDate) + '（水）')
    .setFontColor('#666666');

  const HEADER_ROW = 4;
  const headers = [
    '製品名', 'フェーズ', '企画名', 'ブランド',
    '納品希望日', '残日数', '試作開始(計画)', '試作完了(計画)',
    '今週工数(h)', '今週労務費(円)', '累計工数(h)', '累計労務費(円)',
    '今週担当者', 'ステータス',
  ];
  sheet.getRange(HEADER_ROW, 1, 1, headers.length)
    .setValues([headers])
    .setBackground('#37474F')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setHorizontalAlignment('center');

  // スケジュールSSを製品名でグループ化（同一製品の複数フェーズをまとめる）
  const productMap = new Map();
  for (const sched of scheduleRows) {
    const productName = sched[S.product];
    if (!productName) continue;
    if (!productMap.has(productName)) productMap.set(productName, []);
    productMap.get(productName).push(sched);
  }

  let row = HEADER_ROW + 1;
  let odd = false;

  for (const [productName, scheds] of productMap) {
    const phases   = [...new Set(scheds.map(s => s[S.phase]).filter(Boolean))].join('・');
    const brand    = scheds[0][S.brand]    || '';
    const planName = scheds[0][S.planName] || '';
    const statuses = [...new Set(scheds.map(s => s[S.status]).filter(Boolean))].join('・');

    // 最早開始・最遅完了・最早納品
    const startDates = scheds.map(s => toDate(s[S.startDate])).filter(Boolean);
    const endDates   = scheds.map(s => toDate(s[S.endDate])).filter(Boolean);
    const delivDates = scheds.map(s => toDate(s[S.deliveryDate])).filter(Boolean);
    const planStart    = startDates.length ? new Date(Math.min(...startDates)) : null;
    const planEnd      = endDates.length   ? new Date(Math.max(...endDates))   : null;
    const deliveryDate = delivDates.length ? new Date(Math.min(...delivDates)) : null;
    const remainDays   = deliveryDate ? Math.ceil((deliveryDate - today) / 86400000) : '';

    // 製品名のみで突合（フェーズ不問）
    const allMatched = logRows.filter(r =>
      r[L.product] === productName &&
      r[L.type]    === 'サンプル製造'
    );
    const weekMatched = allMatched.filter(r => {
      const d = toDate(r[L.date]);
      return d && d >= startDate && d <= endDate;
    });

    const weekMin   = colSum(weekMatched, L.workMin);
    const weekCost  = colSum(weekMatched, L.laborCost);
    const totalMin  = colSum(allMatched,  L.workMin);
    const totalCost = colSum(allMatched,  L.laborCost);
    const workers   = [...new Set(weekMatched.map(r => r[L.worker]))].join('、');

    const dataRange = sheet.getRange(row, 1, 1, headers.length);
    dataRange.setValues([[
      productName,
      phases,
      planName,
      brand,
      deliveryDate ? dFmt(deliveryDate) : '',
      remainDays,
      planStart    ? dFmt(planStart)    : '',
      planEnd      ? dFmt(planEnd)      : '',
      weekMin  > 0 ? +(weekMin  / 60).toFixed(1) : '',
      weekCost > 0 ? weekCost  : '',
      totalMin > 0 ? +(totalMin / 60).toFixed(1) : '',
      totalCost> 0 ? totalCost : '',
      workers,
      statuses,
    ]]);
    if (odd) dataRange.setBackground('#F5F5F5');

    if (remainDays !== '') {
      const cell = sheet.getRange(row, 6);
      if      (remainDays <= 3) cell.setFontColor('#D32F2F').setFontWeight('bold');
      else if (remainDays <= 7) cell.setFontColor('#F57C00');
    }

    row++;
    odd = !odd;
  }

  if (row > HEADER_ROW + 1) {
    const dataRows = row - HEADER_ROW - 1;
    sheet.getRange(HEADER_ROW + 1, 10, dataRows, 1).setNumberFormat('#,##0');
    sheet.getRange(HEADER_ROW + 1, 12, dataRows, 1).setNumberFormat('#,##0');
  }

  sheet.setFrozenRows(HEADER_ROW);
  sheet.autoResizeColumns(1, headers.length);
}

// ================================================================
// ③ 作業種別内訳
// ================================================================
function generateWorkTypeReport(reportSS, logRows, startDate, endDate) {
  const sheetName = '③種別内訳_' + rFmt(startDate) + '-' + rFmt(endDate);
  const existing = reportSS.getSheetByName(sheetName);
  if (existing) reportSS.deleteSheet(existing);
  const sheet = reportSS.insertSheet(sheetName, 0);

  sheet.getRange('A1').setValue('試作課 週次作業種別内訳').setFontSize(14).setFontWeight('bold');
  sheet.getRange('A2')
    .setValue('集計期間：' + dFmt(startDate) + '（木） 〜 ' + dFmt(endDate) + '（水）')
    .setFontColor('#666666');

  const HEADER_ROW = 4;
  const headers = ['種別', '件数', '合計時間(h)', '担当者'];
  sheet.getRange(HEADER_ROW, 1, 1, headers.length)
    .setValues([headers])
    .setBackground('#37474F')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setHorizontalAlignment('center');

  const weekLogs = logRows.filter(r => {
    const d = toDate(r[L.date]);
    return d && d >= startDate && d <= endDate;
  });

  // 種別キーでグループ化
  const typeMap = new Map();
  for (const r of weekLogs) {
    const typeKey = r[L.type] === 'サンプル製造'
      ? 'サンプル製造'
      : (String(r[L.workType] || '').trim() || 'その他');
    if (!typeMap.has(typeKey)) typeMap.set(typeKey, []);
    typeMap.get(typeKey).push(r);
  }

  // サンプル製造を先頭に、残りは五十音順
  const sortedTypes = [...typeMap.keys()].sort((a, b) => {
    if (a === 'サンプル製造') return -1;
    if (b === 'サンプル製造') return 1;
    return a.localeCompare(b, 'ja');
  });

  let row = HEADER_ROW + 1;
  let odd = false;

  for (const typeKey of sortedTypes) {
    const logs    = typeMap.get(typeKey);
    const count   = logs.length;
    const totalMin = colSum(logs, L.workMin);
    const workers = [...new Set(logs.map(r => r[L.worker]).filter(Boolean))].join('、');

    const dataRange = sheet.getRange(row, 1, 1, headers.length);
    dataRange.setValues([[typeKey, count, +(totalMin / 60).toFixed(1), workers]]);
    if (odd) dataRange.setBackground('#F5F5F5');
    row++;
    odd = !odd;
  }

  sheet.setFrozenRows(HEADER_ROW);
  sheet.autoResizeColumns(1, headers.length);
}

// ================================================================
// 定時トリガー設定（初回1回だけ実行すれば OK）
// ================================================================
function setupWeeklyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'generateWeeklyReport')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('generateWeeklyReport')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.THURSDAY)
    .atHour(7)
    .create();

  Logger.log('トリガー設定完了: 毎週木曜 7:00');
}

// ================================================================
// デバッグ：ログ突合の状況をログ出力
// ================================================================
function debugWeeklyReport() {
  const { startDate, endDate } = getWeekRange();
  Logger.log('=== 集計期間: ' + dFmt(startDate) + ' 〜 ' + dFmt(endDate) + ' ===');

  const logRows      = getSheetData(REPORT_CONFIG.logSSId,      REPORT_CONFIG.logSheetName,       16);
  const scheduleRows = getSheetData(REPORT_CONFIG.scheduleSSId, REPORT_CONFIG.scheduleSheetName,  12);

  const sampleLogs = logRows.filter(r => r[L.type] === 'サンプル製造');
  const weekLogs   = sampleLogs.filter(r => {
    const d = toDate(r[L.date]);
    return d && d >= startDate && d <= endDate;
  });
  Logger.log('サンプル製造ログ（全期間）: ' + sampleLogs.length + '件');
  Logger.log('サンプル製造ログ（集計期間内）: ' + weekLogs.length + '件');

  if (weekLogs.length === 0) {
    Logger.log('→ 集計期間内にサンプル製造の日報がありません');
  } else {
    Logger.log('--- 集計期間内のログ一覧 ---');
    weekLogs.forEach(r => {
      Logger.log('  ' + dFmt(toDate(r[L.date])) + ' | ' + r[L.worker] + ' | ' + r[L.product] + ' / ' + r[L.phase] + ' | ' + r[L.workMin] + '分');
    });
  }

  // 製品名のみで突合チェック（フェーズ不問）
  Logger.log('--- 日報ログの製品 vs スケジュールSS 突合チェック（製品名のみ）---');
  const scheduleProducts = new Set(scheduleRows.map(r => r[S.product]).filter(Boolean));
  const logProducts = [...new Set(sampleLogs.map(r => r[L.product]).filter(Boolean))];

  logProducts.forEach(product => {
    const hit = scheduleProducts.has(product);
    Logger.log((hit ? '  ✓ 突合OK: ' : '  ✗ 未突合:  ') + product);
  });
}

// ================================================================
// ユーティリティ
// ================================================================
function dFmt(date) {
  return Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy/MM/dd');
}
function rFmt(date) {
  return Utilities.formatDate(date, 'Asia/Tokyo', 'MMdd');
}
function toDate(val) {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}
function colSum(rows, col) {
  return rows.reduce((acc, r) => acc + (Number(r[col]) || 0), 0);
}
