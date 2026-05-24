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
  planName:  16, // Q: 企画名
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

  const logRows      = getSheetData(REPORT_CONFIG.logSSId,      REPORT_CONFIG.logSheetName,       17);
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
// ② 案件別レポート（製品名または企画名で突合）
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

  // スケジュールSSを製品名でグループ化（企画名でも検索できるように）
  const productMap    = new Map(); // 製品名 → schedule rows
  const planToProduct = new Map(); // 企画名 → 製品名

  for (const sched of scheduleRows) {
    const productName = sched[S.product];
    const planName    = sched[S.planName];
    if (!productName) continue;
    if (!productMap.has(productName)) productMap.set(productName, []);
    productMap.get(productName).push(sched);
    if (planName && planName !== productName && !planToProduct.has(planName)) {
      planToProduct.set(planName, productName);
    }
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

    // 製品名・スケジュール企画名・ログ企画名いずれかで突合（フェーズ不問）
    const schedPlanNames = new Set(scheds.map(s => s[S.planName]).filter(Boolean));
    const allMatched = logRows.filter(r => {
      if (r[L.type] !== 'サンプル製造') return false;
      const lp   = r[L.product];
      const lplan = r[L.planName];
      return lp === productName ||
             planToProduct.get(lp) === productName ||
             (lplan && schedPlanNames.has(lplan));
    });
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

  const logRows      = getSheetData(REPORT_CONFIG.logSSId,      REPORT_CONFIG.logSheetName,       17);
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

  // 製品名または企画名で突合チェック
  Logger.log('--- 日報ログの製品 vs スケジュールSS 突合チェック（製品名 or 企画名）---');
  const scheduleProducts  = new Set(scheduleRows.map(r => r[S.product]).filter(Boolean));
  const schedulePlanNames = new Set(scheduleRows.map(r => r[S.planName]).filter(Boolean));
  const logProducts = [...new Set(sampleLogs.map(r => r[L.product]).filter(Boolean))];

  logProducts.forEach(product => {
    const hit = scheduleProducts.has(product) || schedulePlanNames.has(product);
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

// ================================================================
// 未突合の原因調査（スケジュールSS製品名との比較）
// ================================================================
function debugUnmatched() {
  const logRows      = getSheetData(REPORT_CONFIG.logSSId,      REPORT_CONFIG.logSheetName,      16);
  const scheduleRows = getSheetData(REPORT_CONFIG.scheduleSSId, REPORT_CONFIG.scheduleSheetName, 12);

  const scheduleProducts  = [...new Set(scheduleRows.map(r => r[S.product]).filter(Boolean))].sort();
  const schedulePlanNames = new Set(scheduleRows.map(r => r[S.planName]).filter(Boolean));
  const allScheduleNames  = [...new Set([...scheduleProducts, ...schedulePlanNames])];
  const logProducts       = [...new Set(logRows.filter(r => r[L.type] === 'サンプル製造').map(r => r[L.product]).filter(Boolean))];
  const unmatched         = logProducts.filter(p => !scheduleProducts.includes(p) && !schedulePlanNames.has(p));

  Logger.log('=== スケジュールSS 登録製品名一覧（' + scheduleProducts.length + '件）===');
  scheduleProducts.forEach(p => Logger.log('  ' + p));

  Logger.log('');
  Logger.log('=== 未突合製品の類似候補 ===');
  unmatched.forEach(u => {
    Logger.log('【日報】' + u);
    const candidates = allScheduleNames.filter(s =>
      s.includes(u) || u.includes(s) ||
      s.replace(/[　 （）()【】「」・\-\/]/g, '').includes(u.replace(/[　 （）()【】「」・\-\/]/g, '')) ||
      u.replace(/[　 （）()【】「」・\-\/]/g, '').includes(s.replace(/[　 （）()【】「」・\-\/]/g, ''))
    );
    if (candidates.length > 0) {
      candidates.forEach(c => Logger.log('  → 候補: ' + c));
    } else {
      Logger.log('  → 候補なし（スケジュールSSに未登録の可能性）');
    }
  });
}

// ================================================================
// アクセステスト（エラー切り分け用）
// ================================================================
function testAccess() {
  try {
    const ss1 = SpreadsheetApp.openById(REPORT_CONFIG.logSSId);
    Logger.log('✓ 日報ログSS: ' + ss1.getName());
    const sh1 = ss1.getSheetByName(REPORT_CONFIG.logSheetName);
    Logger.log(sh1 ? '✓ シート「' + REPORT_CONFIG.logSheetName + '」あり' : '✗ シート「' + REPORT_CONFIG.logSheetName + '」なし');
  } catch(e) {
    Logger.log('✗ 日報ログSSエラー: ' + e.message);
  }
  try {
    const ss2 = SpreadsheetApp.openById(REPORT_CONFIG.scheduleSSId);
    Logger.log('✓ スケジュールSS: ' + ss2.getName());
    const sh2 = ss2.getSheetByName(REPORT_CONFIG.scheduleSheetName);
    Logger.log(sh2 ? '✓ シート「' + REPORT_CONFIG.scheduleSheetName + '」あり' : '✗ シート「' + REPORT_CONFIG.scheduleSheetName + '」なし');
  } catch(e) {
    Logger.log('✗ スケジュールSSエラー: ' + e.message);
  }
}
