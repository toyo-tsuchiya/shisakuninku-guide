// ================================================================
// 試作課 集計レポート（週次・月次）
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
  type:      7,  // H: 種別
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
  status:       12, // M: ステータス
};

// ================================================================
// 週次メイン（毎週木曜 朝7時に自動実行）
// ================================================================
function generateWeeklyReport() {
  const { startDate, endDate } = getWeekRange();
  const logRows      = getSheetData(REPORT_CONFIG.logSSId,      REPORT_CONFIG.logSheetName,       17);
  const scheduleRows = getSheetData(REPORT_CONFIG.scheduleSSId, REPORT_CONFIG.scheduleSheetName,  13, 6);
  const reportSS     = getOrCreateReportSS();

  appendToWeeklyTrend(reportSS, logRows, startDate, endDate);
  appendToWorkerWeekly(reportSS, logRows, startDate, endDate);
  overwriteProjectProgress(reportSS, logRows, scheduleRows);

  Logger.log('週次レポート更新完了: ' + reportSS.getUrl());
}

// 集計期間：実行日の7日前〜前日
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
// ① 週次推移（追記型）
// ================================================================
function appendToWeeklyTrend(reportSS, logRows, startDate, endDate) {
  const HEADERS = ['集計開始', '集計終了', '実稼働人工', '稼働日数', 'フルニンク(人工)', '稼働人数(参考)', '実働(h)', '製造(h)', '間接(h)', '製造比率(%)', '製品数', '労務費(円)'];
  const sheet = getOrInitSheet(reportSS, '①週次推移', HEADERS, '#4285F4');

  // ヘッダーが変わった場合は自動更新（列名変更・列追加どちらにも対応）
  if (sheet.getRange(1, 3).getValue() !== HEADERS[2]) {
    sheet.getRange(1, 1, 1, HEADERS.length)
      .setValues([HEADERS])
      .setBackground('#37474F').setFontColor('#FFFFFF').setFontWeight('bold').setHorizontalAlignment('center');
  }

  if (dateRangeExists(sheet, startDate, endDate)) {
    Logger.log('①週次推移: ' + dFmt(startDate) + ' 既存 → スキップ');
    return;
  }

  const weekLogs   = logRows.filter(r => { const d = toDate(r[L.date]); return d && d >= startDate && d <= endDate; });
  const sampleLogs = weekLogs.filter(r => r[L.type] === 'サンプル製造');
  const otherLogs  = weekLogs.filter(r => r[L.type] !== 'サンプル製造');

  const actualByKey = new Map();
  for (const r of weekLogs) {
    const k = r[L.worker] + '_' + dFmt(toDate(r[L.date]));
    if (!actualByKey.has(k)) actualByKey.set(k, Number(r[L.actualMin]) || 0);
  }
  const totalActualMin = [...actualByKey.values()].reduce((a, b) => a + b, 0);
  const totalMfgMin    = colSum(sampleLogs, L.workMin);
  const totalOtherMin  = colSum(otherLogs,  L.workMin);
  const totalCost      = colSum(weekLogs,   L.laborCost);
  const workDays       = new Set(weekLogs.map(r => dFmt(toDate(r[L.date])))).size;
  const workerCount    = new Set(weekLogs.map(r => r[L.worker]).filter(Boolean)).size;
  const productCount   = new Set(sampleLogs.map(r => r[L.product]).filter(Boolean)).size;
  const mfgRatio       = totalActualMin > 0 ? Math.round(totalMfgMin / totalActualMin * 100) : 0;

  const businessDays = countBusinessDays(startDate, endDate);
  const fullNinku    = businessDays * workerCount;
  const actualNinku  = actualByKey.size;

  sheet.appendRow([
    dFmt(startDate), dFmt(endDate),
    actualNinku, workDays,
    fullNinku, workerCount,
    +(totalActualMin / 60).toFixed(1),
    +(totalMfgMin    / 60).toFixed(1),
    +(totalOtherMin  / 60).toFixed(1),
    mfgRatio, productCount, totalCost,
  ]);

  sheet.getRange(sheet.getLastRow(), 12).setNumberFormat('#,##0');
}

// ================================================================
// ② 職人別週次（追記型）
// ================================================================
function appendToWorkerWeekly(reportSS, logRows, startDate, endDate) {
  const HEADERS = ['集計開始', '集計終了', '職人名', '稼働日数', '実働(h)', '製造(h)', '間接(h)', '製造比率(%)', '労務費(円)'];
  const sheet = getOrInitSheet(reportSS, '②職人別週次', HEADERS, '#A8C7FA');

  if (dateRangeExists(sheet, startDate, endDate)) {
    Logger.log('②職人別週次: ' + dFmt(startDate) + ' 既存 → スキップ');
    return;
  }

  const weekLogs = logRows.filter(r => { const d = toDate(r[L.date]); return d && d >= startDate && d <= endDate; });

  const workerMap = new Map();
  for (const r of weekLogs) {
    const w = r[L.worker];
    if (!w) continue;
    if (!workerMap.has(w)) workerMap.set(w, []);
    workerMap.get(w).push(r);
  }

  const newRows = [...workerMap.keys()]
    .sort((a, b) => a.localeCompare(b, 'ja'))
    .map(worker => {
      const logs = workerMap.get(worker);
      const workDays = new Set(logs.map(r => dFmt(toDate(r[L.date])))).size;
      const actualByDate = new Map();
      for (const r of logs) {
        const k = dFmt(toDate(r[L.date]));
        if (!actualByDate.has(k)) actualByDate.set(k, Number(r[L.actualMin]) || 0);
      }
      const actualMin = [...actualByDate.values()].reduce((a, b) => a + b, 0);
      const mfgMin    = colSum(logs.filter(r => r[L.type] === 'サンプル製造'), L.workMin);
      const indMin    = colSum(logs.filter(r => r[L.type] !== 'サンプル製造'), L.workMin);
      const laborCost = colSum(logs, L.laborCost);
      const mfgRatio  = actualMin > 0 ? Math.round(mfgMin / actualMin * 100) : 0;
      return [
        dFmt(startDate), dFmt(endDate), worker, workDays,
        +(actualMin / 60).toFixed(1), +(mfgMin / 60).toFixed(1), +(indMin / 60).toFixed(1),
        mfgRatio, laborCost,
      ];
    });

  if (newRows.length > 0) {
    const insertRow = sheet.getLastRow() + 1;
    sheet.getRange(insertRow, 1, newRows.length, HEADERS.length).setValues(newRows);
    sheet.getRange(insertRow, 9, newRows.length, 1).setNumberFormat('#,##0');
  }
}

// ================================================================
// ③ 案件進捗（毎週上書き・全案件累計）
// ================================================================
function overwriteProjectProgress(reportSS, logRows, scheduleRows) {
  const HEADERS = ['製品名', '企画名', 'ステータス', 'フェーズ', '累計工数(h)', '累計労務費(円)', '納品希望日', '残日数'];
  const sheet = getOrInitSheet(reportSS, '⑦製品別進捗', HEADERS, '#34A853');

  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, HEADERS.length).clearContent();
    if (lastRow > 2) sheet.deleteRows(3, lastRow - 2);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const EXCLUDE_STATUSES = ['完了', '中断'];
  const activeSchedules = scheduleRows.filter(s => !EXCLUDE_STATUSES.includes(String(s[S.status] || '').trim()));

  const productMap    = new Map();
  const planToProduct = new Map();
  for (const sched of activeSchedules) {
    const product  = sched[S.product];
    const planName = sched[S.planName];
    if (!product) continue;
    if (!productMap.has(product)) productMap.set(product, []);
    productMap.get(product).push(sched);
    if (planName && planName !== product && !planToProduct.has(planName)) {
      planToProduct.set(planName, product);
    }
  }

  const sampleLogs = logRows.filter(r => r[L.type] === 'サンプル製造');
  const rows = [];

  for (const [productName, scheds] of productMap) {

    const planName       = scheds[0][S.planName] || '';
    const statuses       = [...new Set(scheds.map(s => String(s[S.status] || '').trim()).filter(Boolean))].join('・') || '-';
    const phases         = [...new Set(scheds.map(s => s[S.phase]).filter(Boolean))].join('・') || '-';
    const schedPlanNames = new Set(scheds.map(s => s[S.planName]).filter(Boolean));

    const delivDates   = scheds.map(s => toDate(s[S.deliveryDate])).filter(Boolean);
    const deliveryDate = delivDates.length ? new Date(Math.min(...delivDates)) : null;
    const remainDays   = deliveryDate ? Math.ceil((deliveryDate - today) / 86400000) : '-';

    const matched = sampleLogs.filter(r => {
      const lp    = r[L.product];
      const lplan = r[L.planName];
      return lp === productName || planToProduct.get(lp) === productName || (lplan && schedPlanNames.has(lplan));
    });

    const totalMin  = colSum(matched, L.workMin);
    const totalCost = colSum(matched, L.laborCost);

    rows.push([
      productName, planName, statuses, phases,
      totalMin  > 0 ? +(totalMin  / 60).toFixed(1) : '',
      totalCost > 0 ? totalCost : '',
      deliveryDate ? dFmt(deliveryDate) : '-', remainDays,
    ]);
  }

  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);
    sheet.getRange(2, 6, rows.length, 1).setNumberFormat('#,##0');

    for (let i = 0; i < rows.length; i++) {
      const remain = rows[i][7];
      if (remain === '-' || remain === '') continue;
      const cell = sheet.getRange(i + 2, 8);
      if      (remain <= 3) cell.setFontColor('#D32F2F').setFontWeight('bold');
      else if (remain <= 7) cell.setFontColor('#F57C00');
    }
  }

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, HEADERS.length);
  Logger.log('③製品別進捗 更新完了（' + rows.length + '件）');
}

// ================================================================
// 月次メイン（毎月1日 朝7時に自動実行）
// ================================================================
function generateMonthlyReport() {
  const d = new Date();
  generateMonthlyReportForMonth(
    d.getMonth() === 0 ? d.getFullYear() - 1 : d.getFullYear(),
    d.getMonth() === 0 ? 12 : d.getMonth()
  );
}

// 特定月を指定して手動実行：generateMonthlyReportForMonth(2026, 5)
function generateMonthlyReportForMonth(year, month) {
  const startDate = new Date(year, month - 1,  1,  0,  0,  0,   0);
  const endDate   = new Date(year, month,       0, 23, 59, 59, 999);
  const label     = year + '年' + String(month).padStart(2, '0') + '月';

  const logRows      = getSheetData(REPORT_CONFIG.logSSId,      REPORT_CONFIG.logSheetName,       17);
  const scheduleRows = getSheetData(REPORT_CONFIG.scheduleSSId, REPORT_CONFIG.scheduleSheetName,  13, 6);
  const reportSS     = getOrCreateReportSS();

  appendToMonthlyTrend(reportSS, logRows, startDate, endDate, label);
  appendToBrandReport(reportSS, logRows, scheduleRows, startDate, endDate, label);
  appendToProjectReport(reportSS, logRows, scheduleRows, startDate, endDate, label);
  appendToWorkerMonthly(reportSS, logRows, startDate, endDate, label);

  Logger.log(label + ' 月次レポート完了: ' + reportSS.getUrl());
}

// ================================================================
// ④ 月次推移（追記型）
// ================================================================
function appendToMonthlyTrend(reportSS, logRows, startDate, endDate, label) {
  const HEADERS = ['年月', '実稼働人工', '稼働日数', '実働(h)', '製造(h)', '間接(h)', '製造比率(%)', '製品数', '企画数', '平均製品工数(h)', '労務費(円)'];
  const sheet = getOrInitSheet(reportSS, '③月別推移', HEADERS, '#FBBC04');

  // ヘッダーが変わった場合は自動更新
  if (sheet.getRange(1, 2).getValue() !== HEADERS[1]) {
    sheet.getRange(1, 1, 1, HEADERS.length)
      .setValues([HEADERS])
      .setBackground('#37474F').setFontColor('#FFFFFF').setFontWeight('bold').setHorizontalAlignment('center');
  }

  if (labelExists(sheet, label)) {
    Logger.log('④月次推移: ' + label + ' 既存 → スキップ');
    return;
  }

  const monthLogs     = logRows.filter(r => { const d = toDate(r[L.date]); return d && d >= startDate && d <= endDate; });
  const sampleLogs    = monthLogs.filter(r => r[L.type] === 'サンプル製造');
  const nonSampleLogs = monthLogs.filter(r => r[L.type] !== 'サンプル製造');

  const actualByKey = new Map();
  for (const r of monthLogs) {
    const k = r[L.worker] + '_' + dFmt(toDate(r[L.date]));
    if (!actualByKey.has(k)) actualByKey.set(k, Number(r[L.actualMin]) || 0);
  }
  const actualNinku      = actualByKey.size;
  const totalActualMin   = [...actualByKey.values()].reduce((a, b) => a + b, 0);
  const totalMfgMin      = colSum(sampleLogs,    L.workMin);
  const totalOtherMin    = colSum(nonSampleLogs, L.workMin);
  const totalCost        = colSum(monthLogs,     L.laborCost);
  const workDays         = new Set(monthLogs.map(r => dFmt(toDate(r[L.date])))).size;
  const productCount     = new Set(sampleLogs.map(r => r[L.product]).filter(Boolean)).size;
  const planCount        = new Set(sampleLogs.map(r => r[L.planName]).filter(Boolean)).size;
  const mfgRatio         = totalActualMin > 0 ? Math.round(totalMfgMin / totalActualMin * 100) : 0;
  const avgMinPerProduct = productCount > 0 ? totalMfgMin / productCount : 0;

  sheet.appendRow([
    label, actualNinku, workDays,
    +(totalActualMin   / 60).toFixed(1),
    +(totalMfgMin      / 60).toFixed(1),
    +(totalOtherMin    / 60).toFixed(1),
    mfgRatio, productCount, planCount,
    +(avgMinPerProduct / 60).toFixed(1),
    totalCost,
  ]);

  const lastRow   = sheet.getLastRow();
  sheet.getRange(lastRow, 11).setNumberFormat('#,##0');

  const ratioCell = sheet.getRange(lastRow, 7);
  if      (mfgRatio >= 70) ratioCell.setFontColor('#2E7D32').setFontWeight('bold');
  else if (mfgRatio >= 50) ratioCell.setFontColor('#F57C00').setFontWeight('bold');
  else                     ratioCell.setFontColor('#C62828').setFontWeight('bold');
}

// ================================================================
// ⑤ ブランド別（月次追記型・月内 + 累計）
// ================================================================
function appendToBrandReport(reportSS, logRows, scheduleRows, startDate, endDate, label) {
  const HEADERS = ['年月', 'ブランド', '企画数', '製品数', '月内工数(h)', '月内労務費(円)', '累計工数(h)', '累計労務費(円)', '担当者（全期間）'];
  const sheet = getOrInitSheet(reportSS, '⑤ブランド別', HEADERS, '#FDD663');

  if (labelExists(sheet, label)) {
    Logger.log('⑤ブランド別: ' + label + ' 既存 → スキップ');
    return;
  }

  const productToBrand = new Map();
  const planToBrand    = new Map();
  for (const s of scheduleRows) {
    const brand = s[S.brand];
    if (!brand) continue;
    if (s[S.product])  productToBrand.set(s[S.product],  brand);
    if (s[S.planName]) planToBrand.set(s[S.planName], brand);
  }

  const allSampleLogs   = logRows.filter(r => r[L.type] === 'サンプル製造');
  const monthSampleLogs = allSampleLogs.filter(r => { const d = toDate(r[L.date]); return d && d >= startDate && d <= endDate; });

  // 全期間集計（累計）
  const allBrandMap = new Map();
  for (const r of allSampleLogs) {
    const brand = productToBrand.get(r[L.product]) || planToBrand.get(r[L.planName]) || '未紐付け';
    if (!allBrandMap.has(brand)) allBrandMap.set(brand, { plans: new Set(), products: new Set(), workers: new Set(), workMin: 0, cost: 0 });
    const b = allBrandMap.get(brand);
    if (r[L.planName]) b.plans.add(r[L.planName]);
    if (r[L.product])  b.products.add(r[L.product]);
    if (r[L.worker])   b.workers.add(r[L.worker]);
    b.workMin += Number(r[L.workMin])   || 0;
    b.cost    += Number(r[L.laborCost]) || 0;
  }

  // 月内集計
  const monthBrandMap = new Map();
  for (const r of monthSampleLogs) {
    const brand = productToBrand.get(r[L.product]) || planToBrand.get(r[L.planName]) || '未紐付け';
    if (!monthBrandMap.has(brand)) monthBrandMap.set(brand, { workMin: 0, cost: 0 });
    const b = monthBrandMap.get(brand);
    b.workMin += Number(r[L.workMin])   || 0;
    b.cost    += Number(r[L.laborCost]) || 0;
  }

  // 月内に動きがあったブランドのみ追記
  const newRows = [...allBrandMap.keys()]
    .filter(brand => monthBrandMap.has(brand))
    .sort((a, b) => a.localeCompare(b, 'ja'))
    .map(brand => {
      const all   = allBrandMap.get(brand);
      const month = monthBrandMap.get(brand);
      return [
        label, brand, all.plans.size, all.products.size,
        +(month.workMin / 60).toFixed(1), month.cost,
        +(all.workMin   / 60).toFixed(1), all.cost,
        [...all.workers].join('、'),
      ];
    });

  if (newRows.length > 0) {
    const insertRow = sheet.getLastRow() + 1;
    sheet.getRange(insertRow, 1, newRows.length, HEADERS.length).setValues(newRows);
    sheet.getRange(insertRow, 6, newRows.length, 1).setNumberFormat('#,##0');
    sheet.getRange(insertRow, 8, newRows.length, 1).setNumberFormat('#,##0');
  }

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, HEADERS.length);
  Logger.log('⑤ブランド別 追記完了（' + newRows.length + 'ブランド / ' + label + '）');
}

// ================================================================
// ⑥ 企画別（月次追記型・月内 + 累計）「誰が入って・どれくらいで」
// ================================================================
function appendToProjectReport(reportSS, logRows, scheduleRows, startDate, endDate, label) {
  const HEADERS = [
    'ステータス',
    '年月', '企画名', 'ブランド', '製品名',
    '月内工数(h)', '月内労務費(円)', '累計工数(h)', '累計労務費(円)',
    '担当者（月内）', '担当者（累計）',
    '実作業開始', '実作業最終', '作業日数',
    '計画開始', '計画完了',
    '月内_モック(h)', '月内_1st(h)', '月内_2nd(h)', '月内_3rd(h)', '月内_その他(h)',
    '累計_モック(h)', '累計_1st(h)', '累計_2nd(h)', '累計_3rd(h)', '累計_その他(h)',
  ];
  const PHASE_KEYS = ['モック', '1st', '2nd', '3rd'];
  const sheet = getOrInitSheet(reportSS, '⑥企画別', HEADERS, '#A142F4');

  if (labelExists(sheet, label, 2)) {
    Logger.log('⑥企画別: ' + label + ' 既存 → スキップ');
    return;
  }

  const schedPlanMap   = new Map();
  const productPlanMap = new Map();
  for (const s of scheduleRows) {
    const plan    = s[S.planName] || '';
    const product = s[S.product]  || '';
    if (!plan && !product) continue;
    const key = plan || product;
    if (!schedPlanMap.has(key)) schedPlanMap.set(key, []);
    schedPlanMap.get(key).push(s);
    if (product && plan) productPlanMap.set(product, plan);
  }

  const allSampleLogs   = logRows.filter(r => r[L.type] === 'サンプル製造');
  const monthSampleLogs = allSampleLogs.filter(r => { const d = toDate(r[L.date]); return d && d >= startDate && d <= endDate; });

  // 全期間を企画キーで集計
  const allProjectMap = new Map();
  for (const r of allSampleLogs) {
    const key = r[L.planName] || productPlanMap.get(r[L.product]) || r[L.product] || '';
    if (!key) continue;
    if (!allProjectMap.has(key)) allProjectMap.set(key, []);
    allProjectMap.get(key).push(r);
  }

  // 月内を企画キーで集計
  const monthProjectMap = new Map();
  for (const r of monthSampleLogs) {
    const key = r[L.planName] || productPlanMap.get(r[L.product]) || r[L.product] || '';
    if (!key) continue;
    if (!monthProjectMap.has(key)) monthProjectMap.set(key, []);
    monthProjectMap.get(key).push(r);
  }

  // 月内に動きがあった企画のみ追記
  const newRows = [...monthProjectMap.keys()]
    .sort((a, b) => a.localeCompare(b, 'ja'))
    .map(key => {
      const allLogs   = allProjectMap.get(key)   || [];
      const monthLogs = monthProjectMap.get(key) || [];
      const scheds    = schedPlanMap.get(key)    || [];

      const brand    = scheds.length ? scheds[0][S.brand]    || '' : '';
      const planName = scheds.length ? scheds[0][S.planName] || key : key;
      const products = [...new Set(allLogs.map(r => r[L.product]).filter(Boolean))].join('、');
      const statuses = [...new Set(scheds.map(s => s[S.status]).filter(Boolean))].join('・');

      const startDates = scheds.map(s => toDate(s[S.startDate])).filter(Boolean);
      const endDates   = scheds.map(s => toDate(s[S.endDate])).filter(Boolean);
      const planStart  = startDates.length ? new Date(Math.min(...startDates)) : null;
      const planEnd    = endDates.length   ? new Date(Math.max(...endDates))   : null;

      const monthMin    = colSum(monthLogs, L.workMin);
      const monthCost   = colSum(monthLogs, L.laborCost);
      const allMin      = colSum(allLogs,   L.workMin);
      const allCost     = colSum(allLogs,   L.laborCost);

      const monthWorkers = [...new Set(monthLogs.map(r => r[L.worker]).filter(Boolean))].join('、');
      const allWorkers   = [...new Set(allLogs.map(r => r[L.worker]).filter(Boolean))].join('、');

      const allDates  = allLogs.map(r => toDate(r[L.date])).filter(Boolean);
      const firstDate = allDates.length ? new Date(Math.min(...allDates)) : null;
      const lastDate  = allDates.length ? new Date(Math.max(...allDates)) : null;
      const spanDays  = (firstDate && lastDate) ? Math.ceil((lastDate - firstDate) / 86400000) + 1 : '';

      // フェーズ別（月内）
      const monthPhaseMin = new Map();
      for (const r of monthLogs) {
        const ph  = r[L.phase] || '';
        const key = PHASE_KEYS.includes(ph) ? ph : 'その他';
        monthPhaseMin.set(key, (monthPhaseMin.get(key) || 0) + (Number(r[L.workMin]) || 0));
      }
      const monthPhaseCols = [...PHASE_KEYS, 'その他'].map(ph => {
        const m = monthPhaseMin.get(ph) || 0;
        return m > 0 ? +(m / 60).toFixed(1) : '';
      });

      // フェーズ別累計（全期間）
      const allPhaseMin = new Map();
      for (const r of allLogs) {
        const ph  = r[L.phase] || '';
        const key = PHASE_KEYS.includes(ph) ? ph : 'その他';
        allPhaseMin.set(key, (allPhaseMin.get(key) || 0) + (Number(r[L.workMin]) || 0));
      }
      const phaseCols = [...PHASE_KEYS, 'その他'].map(ph => {
        const m = allPhaseMin.get(ph) || 0;
        return m > 0 ? +(m / 60).toFixed(1) : '';
      });

      return [
        statuses,
        label, planName, brand, products,
        monthMin  > 0 ? +(monthMin  / 60).toFixed(1) : '', monthCost  > 0 ? monthCost  : '',
        allMin    > 0 ? +(allMin    / 60).toFixed(1) : '', allCost    > 0 ? allCost    : '',
        monthWorkers, allWorkers,
        firstDate ? dFmt(firstDate) : '', lastDate ? dFmt(lastDate) : '', spanDays,
        planStart ? dFmt(planStart) : '', planEnd  ? dFmt(planEnd)  : '',
        ...monthPhaseCols,
        ...phaseCols,
      ];
    });

  if (newRows.length > 0) {
    const insertRow = sheet.getLastRow() + 1;
    sheet.getRange(insertRow, 1, newRows.length, HEADERS.length).setValues(newRows);
    sheet.getRange(insertRow, 7, newRows.length, 1).setNumberFormat('#,##0');
    sheet.getRange(insertRow, 9, newRows.length, 1).setNumberFormat('#,##0');
  }

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, HEADERS.length);
  sheet.hideColumns(1, 1);
  Logger.log('⑥企画別 追記完了（' + newRows.length + '件 / ' + label + '）');
}

// ================================================================
// ⑦ 職人別ブランド×企画（月次追記型・月内 + 累計）「誰がどの事業・企画に」
// ================================================================
function appendToWorkerDetailReport(reportSS, logRows, scheduleRows, startDate, endDate, label) {
  const HEADERS = ['年月', '職人名', 'ブランド', '企画名', '月内工数(h)', '月内労務費(円)', '累計工数(h)', '累計労務費(円)'];
  const sheet = getOrInitSheet(reportSS, '⑦職人別', HEADERS, '#FF7043');

  if (labelExists(sheet, label)) {
    Logger.log('⑦職人別: ' + label + ' 既存 → スキップ');
    return;
  }

  const productToBrand = new Map();
  const planToBrand    = new Map();
  const productPlanMap = new Map();
  for (const s of scheduleRows) {
    const brand = s[S.brand]    || '';
    const plan  = s[S.planName] || '';
    const prod  = s[S.product]  || '';
    if (prod)         productToBrand.set(prod, brand);
    if (plan)         planToBrand.set(plan, brand);
    if (prod && plan) productPlanMap.set(prod, plan);
  }

  const allSampleLogs   = logRows.filter(r => r[L.type] === 'サンプル製造');
  const monthSampleLogs = allSampleLogs.filter(r => { const d = toDate(r[L.date]); return d && d >= startDate && d <= endDate; });

  const getPlan  = r => r[L.planName] || productPlanMap.get(r[L.product]) || r[L.product] || '';
  const getBrand = r => productToBrand.get(r[L.product]) || planToBrand.get(r[L.planName]) || '未紐付け';

  const allMap = new Map();
  for (const r of allSampleLogs) {
    const worker = r[L.worker] || '';
    const plan   = getPlan(r);
    if (!worker || !plan) continue;
    const key = worker + '\t' + plan;
    if (!allMap.has(key)) allMap.set(key, { worker, plan, brand: getBrand(r), workMin: 0, cost: 0 });
    const e = allMap.get(key);
    e.workMin += Number(r[L.workMin])   || 0;
    e.cost    += Number(r[L.laborCost]) || 0;
  }

  const monthMap = new Map();
  for (const r of monthSampleLogs) {
    const worker = r[L.worker] || '';
    const plan   = getPlan(r);
    if (!worker || !plan) continue;
    const key = worker + '\t' + plan;
    if (!monthMap.has(key)) monthMap.set(key, { workMin: 0, cost: 0 });
    const e = monthMap.get(key);
    e.workMin += Number(r[L.workMin])   || 0;
    e.cost    += Number(r[L.laborCost]) || 0;
  }

  const newRows = [...monthMap.keys()]
    .sort((a, b) => a.localeCompare(b, 'ja'))
    .map(key => {
      const all   = allMap.get(key) || { workMin: 0, cost: 0 };
      const month = monthMap.get(key);
      const info  = allMap.get(key) || { worker: key.split('\t')[0], plan: key.split('\t')[1], brand: '' };
      return [
        label, info.worker, info.brand, info.plan,
        +(month.workMin / 60).toFixed(1), month.cost,
        +(all.workMin   / 60).toFixed(1), all.cost,
      ];
    });

  if (newRows.length > 0) {
    const insertRow = sheet.getLastRow() + 1;
    sheet.getRange(insertRow, 1, newRows.length, HEADERS.length).setValues(newRows);
    sheet.getRange(insertRow, 6, newRows.length, 1).setNumberFormat('#,##0');
    sheet.getRange(insertRow, 8, newRows.length, 1).setNumberFormat('#,##0');
  }

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, HEADERS.length);
  Logger.log('⑦職人別 追記完了（' + newRows.length + '件 / ' + label + '）');
}

// ================================================================
// ⑧ 職人別月次（月次追記型）②職人別週次の月次版
// ================================================================
function appendToWorkerMonthly(reportSS, logRows, startDate, endDate, label) {
  const HEADERS = ['年月', '職人名', '稼働日数', '実働(h)', '製造(h)', '間接(h)', '製造比率(%)', '労務費(円)'];
  const sheet = getOrInitSheet(reportSS, '④職人別月次', HEADERS, '#4DD0E1');

  if (labelExists(sheet, label)) {
    Logger.log('⑧職人別月次: ' + label + ' 既存 → スキップ');
    return;
  }

  const monthLogs = logRows.filter(r => { const d = toDate(r[L.date]); return d && d >= startDate && d <= endDate; });

  const workerMap = new Map();
  for (const r of monthLogs) {
    const w = r[L.worker];
    if (!w) continue;
    if (!workerMap.has(w)) workerMap.set(w, []);
    workerMap.get(w).push(r);
  }

  const newRows = [...workerMap.keys()]
    .sort((a, b) => a.localeCompare(b, 'ja'))
    .map(worker => {
      const logs = workerMap.get(worker);
      const workDays = new Set(logs.map(r => dFmt(toDate(r[L.date])))).size;
      const actualByDate = new Map();
      for (const r of logs) {
        const k = dFmt(toDate(r[L.date]));
        if (!actualByDate.has(k)) actualByDate.set(k, Number(r[L.actualMin]) || 0);
      }
      const actualMin = [...actualByDate.values()].reduce((a, b) => a + b, 0);
      const mfgMin    = colSum(logs.filter(r => r[L.type] === 'サンプル製造'), L.workMin);
      const indMin    = colSum(logs.filter(r => r[L.type] !== 'サンプル製造'), L.workMin);
      const laborCost = colSum(logs, L.laborCost);
      const mfgRatio  = actualMin > 0 ? Math.round(mfgMin / actualMin * 100) : 0;
      return [
        label, worker, workDays,
        +(actualMin / 60).toFixed(1), +(mfgMin / 60).toFixed(1), +(indMin / 60).toFixed(1),
        mfgRatio, laborCost,
      ];
    });

  if (newRows.length > 0) {
    const insertRow = sheet.getLastRow() + 1;
    sheet.getRange(insertRow, 1, newRows.length, HEADERS.length).setValues(newRows);
    sheet.getRange(insertRow, 8, newRows.length, 1).setNumberFormat('#,##0');
  }

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, HEADERS.length);
  Logger.log('⑧職人別月次 追記完了（' + newRows.length + '件 / ' + label + '）');
}

// ================================================================
// バックフィル：指定開始日から7日ごとに週次レポートをまとめて生成
// ================================================================
function generateWeeklyReportBackfill() {
  // ★ 開始日を変更して実行してください
  const START_DATE_STR = '2026/05/01';

  const startDate = new Date(START_DATE_STR);
  startDate.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const logRows      = getSheetData(REPORT_CONFIG.logSSId,      REPORT_CONFIG.logSheetName,       17);
  const scheduleRows = getSheetData(REPORT_CONFIG.scheduleSSId, REPORT_CONFIG.scheduleSheetName,  13, 6);
  const reportSS     = getOrCreateReportSS();

  let current = new Date(startDate);
  let count   = 0;

  while (current < today) {
    const periodStart = new Date(current);
    const periodEnd   = new Date(current);
    periodEnd.setDate(periodEnd.getDate() + 6);
    periodEnd.setHours(23, 59, 59, 999);

    const periodEndDay = new Date(periodEnd);
    periodEndDay.setHours(0, 0, 0, 0);
    if (periodEndDay >= today) break;

    appendToWeeklyTrend(reportSS, logRows, periodStart, periodEnd);
    appendToWorkerWeekly(reportSS, logRows, periodStart, periodEnd);

    current.setDate(current.getDate() + 7);
    count++;
  }

  // 案件進捗は最後に1回だけ更新
  overwriteProjectProgress(reportSS, logRows, scheduleRows);

  Logger.log('バックフィル完了: ' + count + '週分 → ' + reportSS.getUrl());
}

// ================================================================
// シートの順番を並べ替える（1回のみ実行）
// ================================================================
function reorderSheets() {
  const ss = getOrCreateReportSS();
  const order = ['①週次推移', '②職人別週次', '③月別推移', '④職人別月次', '⑤ブランド別', '⑥企画別', '⑦製品別進捗'];
  order.forEach((name, i) => {
    const sheet = ss.getSheetByName(name);
    if (sheet) { ss.setActiveSheet(sheet); ss.moveActiveSheet(i + 1); }
  });
  Logger.log('シート並び替え完了');
}

// ================================================================
// ③案件進捗を単体で更新するラッパー
// ================================================================
function runProjectProgress() {
  const logRows      = getSheetData(REPORT_CONFIG.logSSId,      REPORT_CONFIG.logSheetName,      17);
  const scheduleRows = getSheetData(REPORT_CONFIG.scheduleSSId, REPORT_CONFIG.scheduleSheetName, 13, 6);
  const reportSS     = getOrCreateReportSS();
  overwriteProjectProgress(reportSS, logRows, scheduleRows);
}

// ================================================================
// undefined行クリーンアップ（引数なし誤実行で生じた不正行を削除）
// ================================================================
function cleanupUndefinedRows() {
  const reportSS = getOrCreateReportSS();
  const targets = ['③月別推移', '⑤ブランド別', '⑥企画別', '⑦職人別', '④職人別月次'];
  targets.forEach(name => {
    const sheet = reportSS.getSheetByName(name);
    if (!sheet) return;
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    const vals = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = vals.length - 1; i >= 0; i--) {
      const v = String(vals[i][0]);
      if (v.includes('undefined') || v.trim() === '') {
        sheet.deleteRow(i + 2);
        Logger.log(name + ': ' + (i + 2) + '行目を削除（' + v + '）');
      }
    }
  });
  Logger.log('クリーンアップ完了');
}

// 2026年05月の月次を⑧だけ再生成するラッパー（⑧が空の場合に1回だけ実行）
function run202605() { generateMonthlyReportForMonth(2026, 5); }

// ================================================================
// トリガー設定
// ================================================================
function setupWeeklyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'generateWeeklyReport')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('generateWeeklyReport')
    .timeBased().onWeekDay(ScriptApp.WeekDay.THURSDAY).atHour(7).create();
  Logger.log('週次トリガー設定完了: 毎週木曜 7:00');
}

function setupMonthlyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'generateMonthlyReport')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('generateMonthlyReport')
    .timeBased().onMonthDay(1).atHour(7).create();
  Logger.log('月次トリガー設定完了: 毎月1日 7:00');
}

// ================================================================
// スプレッドシートからデータ取得
// ================================================================
function getSheetData(ssId, sheetName, cols, startRow) {
  startRow = startRow || 2;
  const sheet = SpreadsheetApp.openById(ssId).getSheetByName(sheetName);
  if (!sheet) throw new Error('シートが見つかりません: ' + sheetName);
  const lastRow = sheet.getLastRow();
  if (lastRow < startRow) return [];
  return sheet.getRange(startRow, 1, lastRow - startRow + 1, cols).getValues();
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
// シート取得または初期化（ヘッダー + タブカラー付き）
// ================================================================
function getOrInitSheet(ss, name, headers, tabColor) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length)
      .setValues([headers])
      .setBackground('#37474F').setFontColor('#FFFFFF').setFontWeight('bold').setHorizontalAlignment('center');
    sheet.setFrozenRows(1);
    if (tabColor) sheet.setTabColor(tabColor);
  }
  return sheet;
}

// ================================================================
// 重複チェックユーティリティ
// ================================================================
function dateRangeExists(sheet, startDate, endDate) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  const vals = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  const sk = dFmt(startDate), ek = dFmt(endDate);
  return vals.some(r => {
    const a = r[0] instanceof Date ? dFmt(r[0]) : String(r[0]);
    const b = r[1] instanceof Date ? dFmt(r[1]) : String(r[1]);
    return a === sk && b === ek;
  });
}

function labelExists(sheet, label, col) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  return sheet.getRange(2, col || 1, lastRow - 1, 1).getValues().some(r => String(r[0]) === label);
}

// ================================================================
// デバッグ：ログ突合の状況をログ出力
// ================================================================
function debugWeeklyReport() {
  const { startDate, endDate } = getWeekRange();
  Logger.log('=== 集計期間: ' + dFmt(startDate) + ' 〜 ' + dFmt(endDate) + ' ===');

  const logRows      = getSheetData(REPORT_CONFIG.logSSId,      REPORT_CONFIG.logSheetName,       17);
  const scheduleRows = getSheetData(REPORT_CONFIG.scheduleSSId, REPORT_CONFIG.scheduleSheetName,  13, 6);

  const sampleLogs = logRows.filter(r => r[L.type] === 'サンプル製造');
  const weekLogs   = sampleLogs.filter(r => { const d = toDate(r[L.date]); return d && d >= startDate && d <= endDate; });

  Logger.log('サンプル製造ログ（全期間）: ' + sampleLogs.length + '件');
  Logger.log('サンプル製造ログ（集計期間内）: ' + weekLogs.length + '件');

  if (weekLogs.length === 0) {
    Logger.log('→ 集計期間内にサンプル製造の日報がありません');
  } else {
    weekLogs.forEach(r => Logger.log('  ' + dFmt(toDate(r[L.date])) + ' | ' + r[L.worker] + ' | ' + r[L.product] + ' / ' + r[L.phase] + ' | ' + r[L.workMin] + '分'));
  }

  Logger.log('--- 突合チェック ---');
  const scheduleProducts  = new Set(scheduleRows.map(r => r[S.product]).filter(Boolean));
  const schedulePlanNames = new Set(scheduleRows.map(r => r[S.planName]).filter(Boolean));
  [...new Set(sampleLogs.map(r => r[L.product]).filter(Boolean))].forEach(product => {
    const hit = scheduleProducts.has(product) || schedulePlanNames.has(product);
    Logger.log((hit ? '  ✓ 突合OK: ' : '  ✗ 未突合:  ') + product);
  });
}

// ================================================================
// 未突合の原因調査
// ================================================================
function debugUnmatched() {
  const logRows      = getSheetData(REPORT_CONFIG.logSSId,      REPORT_CONFIG.logSheetName,      17);
  const scheduleRows = getSheetData(REPORT_CONFIG.scheduleSSId, REPORT_CONFIG.scheduleSheetName, 13, 6);

  const scheduleProducts  = [...new Set(scheduleRows.map(r => r[S.product]).filter(Boolean))].sort();
  const schedulePlanNames = new Set(scheduleRows.map(r => r[S.planName]).filter(Boolean));
  const allScheduleNames  = [...new Set([...scheduleProducts, ...schedulePlanNames])];
  const logProducts       = [...new Set(logRows.filter(r => r[L.type] === 'サンプル製造').map(r => r[L.product]).filter(Boolean))];
  const unmatched         = logProducts.filter(p => !scheduleProducts.includes(p) && !schedulePlanNames.has(p));

  Logger.log('=== スケジュールSS 登録製品名一覧（' + scheduleProducts.length + '件）===');
  scheduleProducts.forEach(p => Logger.log('  ' + p));
  Logger.log('=== 未突合製品の類似候補 ===');
  unmatched.forEach(u => {
    Logger.log('【日報】' + u);
    const candidates = allScheduleNames.filter(s =>
      s.includes(u) || u.includes(s) ||
      s.replace(/[　 （）()【】「」・\-\/]/g, '').includes(u.replace(/[　 （）()【】「」・\-\/]/g, '')) ||
      u.replace(/[　 （）()【】「」・\-\/]/g, '').includes(s.replace(/[　 （）()【】「」・\-\/]/g, ''))
    );
    candidates.length > 0
      ? candidates.forEach(c => Logger.log('  → 候補: ' + c))
      : Logger.log('  → 候補なし');
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
function countBusinessDays(startDate, endDate) {
  let count = 0;
  const d = new Date(startDate);
  d.setHours(0, 0, 0, 0);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);
  while (d <= end) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

// ================================================================
// 使い方ガイド Google ドキュメント作成（1回のみ実行）
// ================================================================
function createUsageGuideDoc() {
  const doc  = DocumentApp.create('試作課レポート 使い方ガイド');
  const body = doc.getBody();
  body.clear();

  const H1 = DocumentApp.ParagraphHeading.HEADING1;
  const H2 = DocumentApp.ParagraphHeading.HEADING2;
  const H3 = DocumentApp.ParagraphHeading.HEADING3;

  function addHeading(text, level) { body.appendParagraph(text).setHeading(level); }
  function addText(text)           { body.appendParagraph(text); }
  function addItalic(text)         { body.appendParagraph(text).editAsText().setItalic(true); }
  function addTable(data) {
    const table = body.appendTable(data);
    const headerRow = table.getRow(0);
    for (let i = 0; i < headerRow.getNumCells(); i++) {
      const cell = headerRow.getCell(i);
      cell.setBackgroundColor('#37474F');
      cell.editAsText().setForegroundColor('#FFFFFF').setBold(true);
    }
    body.appendParagraph('');
  }

  addHeading('集計レポート 使い方ガイド', H1);
  addText('試作課の工数・労務費データを集計した週次・月次レポートの読み方と活用方法です。');
  body.appendParagraph('');

  // ===== シート別の活用ガイド =====

  addHeading('① 週次推移（青タブ）', H2);
  addText('試作課全体の1週間まとめ。実働時間・製造比率・労務費が1行/週で蓄積される。');
  addTable([
    ['見るポイント', '活用例'],
    ['製造比率(%)', '70%以上：緑、50%以上：橙、50%未満：赤で色分け。低い週は間接業務が多かった週'],
    ['労務費(円)', '月次予算との比較に使える'],
    ['稼働人数', '欠勤・休暇が多かった週の確認'],
    ['フルニンク(人工)', '営業日数×稼働人数。期間中フル稼働した場合の最大人工数'],
    ['実績ニンク(人工)', '実際に日報を提出した職人×日のユニーク数。フルニンクとの差が欠勤・休暇分'],
  ]);

  addHeading('② 職人別週次（水色タブ）', H2);
  addText('①の内訳版。誰が何時間働いて、どれだけ製造に使ったかがわかる。');
  addTable([
    ['見るポイント', '活用例'],
    ['製造比率の差', '職人間で製造比率に大きな差がある週は業務分担を見直す契機'],
    ['稼働日数', '有休・欠勤の把握'],
  ]);

  addHeading('③ 案件進捗（緑タブ）', H2);
  addText('現在進行中の全案件の状態（毎週上書き）。スケジュールの全製品に対して累計工数・残日数・担当者を自動更新。');
  addTable([
    ['見るポイント', '活用例'],
    ['残日数（赤字/橙字）', '3日以内：赤、7日以内：橙。週次ミーティングの優先議題に'],
    ['累計工数', '想定より多い案件は遅延・手戻りのサイン'],
    ['ステータス', '「完了」になっているのに工数が増えていないか確認'],
  ]);

  addHeading('④ 月次推移（黄タブ）', H2);
  addText('試作課全体の月まとめ（1行/月で蓄積）。上長向け月次報告の数字がそのまま読み取れる。');
  addTable([
    ['見るポイント', '活用例'],
    ['平均製品工数(h)', '月ごとに増減していれば案件難易度やスキル変化の指標になる'],
    ['企画数', '処理した企画数の推移で試作課のキャパ感を把握'],
  ]);

  addHeading('⑤ ブランド別（薄黄タブ）', H2);
  addText('ブランドごとに何時間・いくら使ったか（月次追記）。上長への「対事業リソース報告」に直接使えるシート。');
  addTable([
    ['見るポイント', '活用例'],
    ['月内工数 vs 累計工数', '今月特定ブランドに集中していないか確認'],
    ['担当者（全期間）', 'そのブランドを誰が主に担っているかが見える'],
  ]);

  addHeading('⑥ 企画別（紫タブ）', H2);
  addText('企画単位で誰がいつ何時間使ったか（月次追記）。フェーズ別累計（モック/1st/2nd/3rd）も含む。');
  addTable([
    ['見るポイント', '活用例'],
    ['累計_モック〜3rd', 'モックより1stが短ければ学習が起きている証拠'],
    ['フェーズ内訳（月内）', '今月どのフェーズに時間を使ったか'],
    ['作業日数', '試作開始から完了までの実稼働日数'],
  ]);
  addItalic('「この企画、なぜ時間がかかったか」の分析起点になるシート。');
  body.appendParagraph('');

  addHeading('⑦ 職人別（橙タブ）', H2);
  addText('職人×ブランド×企画ごとの工数（月次追記）。1行 = 職人1人 × 企画1件 × 1ヶ月。');
  addTable([
    ['見るポイント', '活用例'],
    ['ブランドでフィルタ', '「このブランドに誰が何時間入ったか」が一覧できる'],
    ['企画名でフィルタ', '「この企画に誰が関わったか」が一覧できる'],
    ['職人名でフィルタ', '「この職人は今月どの仕事をしていたか」がわかる'],
  ]);

  addHeading('⑧ 職人別月次（青緑タブ）', H2);
  addText('職人ごとの月まとめ（1行/職人×月）。②職人別週次の月次集計版。月次報告での職人別実績に使える。');
  addTable([
    ['見るポイント', '活用例'],
    ['稼働日数・実働(h)', '職人ごとの月間稼働量を把握。欠勤・有休が多い月の確認'],
    ['製造比率(%)', '職人ごとに製造vs間接の比率を月単位で比較'],
    ['労務費(円)', '職人ごとの月間人件費'],
  ]);

  // ===== 今後の活用 =====

  addHeading('今後の活用（データが3ヶ月以上蓄積されてから）', H2);
  addTable([
    ['やりたいこと', '使うシート', '方法'],
    ['モック→1st→2ndで時間が減っているか確認', '⑥企画別', '同一企画の累計_モック/1st/2nd列を比較'],
    ['特定ブランドへの年間リソース配分', '⑤ブランド別', 'ブランド名でフィルタして累計工数を縦に追う'],
    ['職人ごとの得意ブランド・企画の傾向', '⑦職人別', '職人名でフィルタして累計工数が多い企画を見る'],
    ['月ごとの繁忙期・閑散期の把握', '③月別推移', '稼働日数・製造(h)の推移をグラフ化'],
    ['職人ごとの月間稼働推移', '④職人別月次', '職人名でフィルタして実働・製造比率を縦に追う'],
  ]);

  // ===== 日報入力ミスの影響と調べ方 =====

  addHeading('日報入力ミスの影響と調べ方', H2);
  addHeading('よくある入力ミスとその影響', H3);
  addTable([
    ['入力ミス', '影響するシート', '具体的な症状'],
    ['製品名の表記ゆれ（スペース・全角半角など）', '③⑤⑥⑦', 'その製品の工数が「未紐付け」に入る。③案件進捗の累計工数が0のまま'],
    ['種別（サンプル製造/その他）の選び間違い', '①②④⑧', '製造比率が実態と合わなくなる'],
    ['フェーズの入力ミス', '⑥', 'フェーズ別累計の数字が実態と合わなくなる'],
    ['作業時間の入力ミス（分単位）', '全シート', '工数・労務費がすべてズレる'],
    ['企画名が空欄', '⑥⑦', 'その企画への工数が集計されない'],
    ['職人名の表記ゆれ', '②⑦⑧', '同一人物が別人として2行で集計される'],
  ]);

  addHeading('調べ方（GASエディタから実行）', H3);
  addTable([
    ['関数名', '何がわかるか'],
    ['debugUnmatched()', 'スケジュールSSと突合できていない製品と類似候補を一覧表示。表記ゆれの調査に使う'],
    ['debugWeeklyReport()', '直近1週間のサンプル製造ログと突合状況を確認'],
    ['testAccess()', '日報ログSS・スケジュールSSに正常にアクセスできているか確認'],
  ]);

  addHeading('入力ミスを見つけたら', H3);
  addText('1. 日報ログSSの該当行を直接修正する');
  addText('2. 集計レポートSSの該当月シート（④⑤⑥⑦⑧）の該当月行を削除する');
  addText('3. GASエディタで generateMonthlyReport を再実行して再集計する');

  // ===== 各シートの列定義と計算式 =====

  addHeading('各シートの列定義と計算式', H2);
  addText('各シートの全列が「何を・どう計算しているか」を記載します。');
  body.appendParagraph('');

  addHeading('共通の前提', H3);
  addTable([
    ['用語', '定義'],
    ['実働(分)', '出勤〜退勤の時間 − 休憩時間。職人・日付でユニークに取得（同じ人が同じ日に複数行提出しても1回分のみ加算）'],
    ['作業時間(分)', '各作業行に入力した分数。1日に複数行入力した場合は合計'],
    ['製造(分)', '種別＝「サンプル製造」の作業時間(分)の合計'],
    ['間接(分)', '種別＝「その他」の作業時間(分)の合計（社内MTG・事務作業など）'],
    ['労務費(円)', '作業時間(分) × 42円。提出時に自動計算してログに保存済み'],
    ['突合', '日報の製品名とスケジュールSSの製品名・企画名を照合すること'],
  ]);

  addHeading('① 週次推移', H3);
  addText('集計期間：毎週木曜の自動実行日から7日前〜前日（例：6/12実行 → 6/5〜6/11）');
  addTable([
    ['列名', '計算内容'],
    ['集計開始', '集計期間の開始日'],
    ['集計終了', '集計期間の終了日'],
    ['稼働人数', '期間内に1件でも日報を提出した職人の人数'],
    ['稼働日数', '期間内に誰かが日報を提出した日数（ユニーク日付の数）'],
    ['フルニンク(人工)', '集計期間内の営業日数（土日除く）× 稼働人数。フル稼働した場合の最大人工数'],
    ['実績ニンク(人工)', '実際に日報を提出した職人×日のユニーク組み合わせ数。フルニンクとの差が欠勤・休暇分'],
    ['実働(h)', '全職人の実働(分)合計 ÷ 60（職人×日付で重複排除済み）'],
    ['製造(h)', '全製造作業の作業時間(分)合計 ÷ 60'],
    ['間接(h)', '全間接作業の作業時間(分)合計 ÷ 60'],
    ['製造比率(%)', '製造(分) ÷ 実働(分) × 100（四捨五入）※70%以上：緑、50%以上：橙、50%未満：赤'],
    ['製品数', '期間内に登場したユニークな製品名の数（サンプル製造のみ）'],
    ['労務費(円)', '期間内の全行の労務費合計'],
  ]);

  addHeading('② 職人別週次', H3);
  addText('①と同じ集計期間で、職人ごとに1行出力。');
  addTable([
    ['列名', '計算内容'],
    ['集計開始・終了', '①と同じ'],
    ['職人名', '日報に記入された職人名'],
    ['稼働日数', 'その職人が期間内に日報を提出した日数'],
    ['実働(h)', 'その職人の実働(分)合計 ÷ 60（日付で重複排除済み）'],
    ['製造(h)', 'その職人の製造作業時間(分)合計 ÷ 60'],
    ['間接(h)', 'その職人の間接作業時間(分)合計 ÷ 60'],
    ['製造比率(%)', 'その職人の製造(分) ÷ 実働(分) × 100'],
    ['労務費(円)', 'その職人の期間内の労務費合計'],
  ]);

  addHeading('③ 案件進捗', H3);
  addText('毎週上書き。スケジュールSSに登録されている全製品が対象。');
  addTable([
    ['列名', '計算内容'],
    ['製品名', 'スケジュールSSから取得'],
    ['フェーズ', 'スケジュールSSの「サンプルフェーズ」列から取得（複数あれば「・」区切り）'],
    ['企画名', 'スケジュールSSから取得'],
    ['ブランド', 'スケジュールSSから取得'],
    ['納品希望日', 'スケジュールSSから取得（複数行ある場合は最も早い日付）'],
    ['残日数', '納品希望日 − 今日（マイナスは納期超過）※3日以内：赤、7日以内：橙'],
    ['計画開始', 'スケジュールSSの試作開始日（複数行の最も早い日付）'],
    ['計画完了', 'スケジュールSSの試作完了日（複数行の最も遅い日付）'],
    ['累計工数(h)', '日報ログで同製品・同企画に紐づいた全期間の作業時間(分)合計 ÷ 60'],
    ['累計労務費(円)', '同上の労務費合計'],
    ['担当者（全期間）', '累計で関わった職人名（「、」区切り）'],
    ['ステータス', 'スケジュールSSのステータス列から取得'],
  ]);

  addHeading('④ 月次推移', H3);
  addText('対象月の1日〜末日を集計（①の月次版）。');
  addTable([
    ['列名', '計算内容'],
    ['年月', '例：「2026年05月」'],
    ['稼働人数', '月内に日報を提出したユニーク職人数'],
    ['稼働日数', '月内に誰かが日報を提出したユニーク日付の数'],
    ['実働(h)', '全職人の実働(分)合計 ÷ 60（職人×日付で重複排除済み）'],
    ['製造(h)', '製造作業時間(分)合計 ÷ 60'],
    ['間接(h)', '間接作業時間(分)合計 ÷ 60'],
    ['製造比率(%)', '製造(分) ÷ 実働(分) × 100 ※色分けあり'],
    ['製品数', '月内に登場したユニーク製品名の数'],
    ['企画数', '月内に登場したユニーク企画名の数'],
    ['平均製品工数(h)', '月内の製造作業時間合計 ÷ 製品数 ÷ 60'],
    ['労務費(円)', '月内の全労務費合計'],
  ]);

  addHeading('⑤ ブランド別', H3);
  addText('月次追記。月内に動きがあったブランドのみ追記（当月に1件も日報がないブランドは出ない）。');
  addTable([
    ['列名', '計算内容'],
    ['年月', '例：「2026年05月」'],
    ['ブランド', 'スケジュールSSのブランド名'],
    ['企画数', 'そのブランドに紐づく企画数（累計・全期間のユニーク企画名数）'],
    ['製品数', 'そのブランドに紐づく製品数（累計・全期間のユニーク製品名数）'],
    ['月内工数(h)', '当月のそのブランドへの作業時間(分)合計 ÷ 60'],
    ['月内労務費(円)', '当月の労務費合計'],
    ['累計工数(h)', '全期間のそのブランドへの作業時間(分)合計 ÷ 60'],
    ['累計労務費(円)', '全期間の労務費合計'],
    ['担当者（全期間）', '累計でそのブランドに関わった職人名（「、」区切り）'],
  ]);

  addHeading('⑥ 企画別', H3);
  addText('月次追記。月内に動きがあった企画のみ追記。A列（ステータス）は非表示。');
  addTable([
    ['列名', '計算内容'],
    ['ステータス', 'スケジュールSSのステータス（A列・非表示）'],
    ['年月', '例：「2026年05月」'],
    ['企画名', '企画名（スケジュールSSから取得、なければ製品名）'],
    ['ブランド', 'スケジュールSSから逆引き'],
    ['製品名', 'その企画に紐づいた全製品名（「、」区切り、全期間）'],
    ['月内工数(h)', '当月の作業時間(分)合計 ÷ 60'],
    ['月内労務費(円)', '当月の労務費合計'],
    ['累計工数(h)', '全期間の作業時間(分)合計 ÷ 60'],
    ['累計労務費(円)', '全期間の労務費合計'],
    ['担当者（月内）', '当月に関わった職人名'],
    ['担当者（累計）', '全期間に関わった職人名'],
    ['実作業開始', '全期間で最も古い日報の日付'],
    ['実作業最終', '全期間で最も新しい日報の日付'],
    ['作業日数', '実作業最終 − 実作業開始 + 1（カレンダー日数）'],
    ['計画開始', 'スケジュールSSの試作開始日'],
    ['計画完了', 'スケジュールSSの試作完了日'],
    ['月内_モック(h)', '当月・フェーズ＝モックの作業時間(分)合計 ÷ 60'],
    ['月内_1st〜その他(h)', '同上（1st / 2nd / 3rd / その他）各フェーズ列'],
    ['累計_モック〜その他(h)', '同上の全期間版（5列）'],
  ]);

  addHeading('⑦ 職人別', H3);
  addText('月次追記。職人×企画の組み合わせで1行。当月に動きがあったもののみ追記。');
  addTable([
    ['列名', '計算内容'],
    ['年月', '例：「2026年05月」'],
    ['職人名', '日報に記入された職人名'],
    ['ブランド', 'スケジュールSSから逆引き（製品名 or 企画名で突合）'],
    ['企画名', '企画名（未突合の場合は製品名）'],
    ['月内工数(h)', '当月のその職人×企画の作業時間(分)合計 ÷ 60'],
    ['月内労務費(円)', '当月の労務費合計'],
    ['累計工数(h)', '全期間のその職人×企画の作業時間(分)合計 ÷ 60'],
    ['累計労務費(円)', '全期間の労務費合計'],
  ]);

  addHeading('⑧ 職人別月次', H3);
  addText('月次追記。職人ごとに1行（月内に日報を提出した職人のみ）。');
  addTable([
    ['列名', '計算内容'],
    ['年月', '例：「2026年05月」'],
    ['職人名', '日報に記入された職人名'],
    ['稼働日数', 'その職人が月内に日報を提出した日数'],
    ['実働(h)', 'その職人の実働(分)合計 ÷ 60（日付で重複排除済み）'],
    ['製造(h)', 'その職人の製造作業時間(分)合計 ÷ 60'],
    ['間接(h)', 'その職人の間接作業時間(分)合計 ÷ 60'],
    ['製造比率(%)', 'その職人の製造(分) ÷ 実働(分) × 100'],
    ['労務費(円)', 'その職人の月内の労務費合計'],
  ]);

  doc.saveAndClose();
  Logger.log('✓ ガイドドキュメント作成完了: ' + doc.getUrl());
}
