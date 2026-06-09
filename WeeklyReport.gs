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
  status:       11, // L: ステータス
};

// ================================================================
// 週次メイン（毎週木曜 朝7時に自動実行）
// ================================================================
function generateWeeklyReport() {
  const { startDate, endDate } = getWeekRange();
  const logRows      = getSheetData(REPORT_CONFIG.logSSId,      REPORT_CONFIG.logSheetName,       17);
  const scheduleRows = getSheetData(REPORT_CONFIG.scheduleSSId, REPORT_CONFIG.scheduleSheetName,  12);
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
  const HEADERS = ['集計開始', '集計終了', '稼働人数', '稼働日数', '実働(h)', '製造(h)', '間接(h)', '製造比率(%)', '製品数', '労務費(円)'];
  const sheet = getOrInitSheet(reportSS, '①週次推移', HEADERS, '#4285F4');

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

  sheet.appendRow([
    dFmt(startDate), dFmt(endDate),
    workerCount, workDays,
    +(totalActualMin / 60).toFixed(1),
    +(totalMfgMin    / 60).toFixed(1),
    +(totalOtherMin  / 60).toFixed(1),
    mfgRatio, productCount, totalCost,
  ]);

  sheet.getRange(sheet.getLastRow(), 10).setNumberFormat('#,##0');
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
  const HEADERS = [
    '製品名', 'フェーズ', '企画名', 'ブランド',
    '納品希望日', '残日数', '計画開始', '計画完了',
    '累計工数(h)', '累計労務費(円)', '担当者（全期間）', 'ステータス',
  ];
  const sheet = getOrInitSheet(reportSS, '③案件進捗', HEADERS, '#34A853');

  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.deleteRows(2, lastRow - 1);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const productMap    = new Map();
  const planToProduct = new Map();
  for (const sched of scheduleRows) {
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
    const phases         = [...new Set(scheds.map(s => s[S.phase]).filter(Boolean))].join('・');
    const brand          = scheds[0][S.brand]    || '';
    const planName       = scheds[0][S.planName] || '';
    const statuses       = [...new Set(scheds.map(s => s[S.status]).filter(Boolean))].join('・');
    const schedPlanNames = new Set(scheds.map(s => s[S.planName]).filter(Boolean));

    const startDates   = scheds.map(s => toDate(s[S.startDate])).filter(Boolean);
    const endDates     = scheds.map(s => toDate(s[S.endDate])).filter(Boolean);
    const delivDates   = scheds.map(s => toDate(s[S.deliveryDate])).filter(Boolean);
    const planStart    = startDates.length ? new Date(Math.min(...startDates)) : null;
    const planEnd      = endDates.length   ? new Date(Math.max(...endDates))   : null;
    const deliveryDate = delivDates.length ? new Date(Math.min(...delivDates)) : null;
    const remainDays   = deliveryDate ? Math.ceil((deliveryDate - today) / 86400000) : '';

    const matched = sampleLogs.filter(r => {
      const lp    = r[L.product];
      const lplan = r[L.planName];
      return lp === productName || planToProduct.get(lp) === productName || (lplan && schedPlanNames.has(lplan));
    });

    const totalMin  = colSum(matched, L.workMin);
    const totalCost = colSum(matched, L.laborCost);
    const workers   = [...new Set(matched.map(r => r[L.worker]).filter(Boolean))].join('、');

    rows.push([
      productName, phases, planName, brand,
      deliveryDate ? dFmt(deliveryDate) : '', remainDays,
      planStart ? dFmt(planStart) : '', planEnd ? dFmt(planEnd) : '',
      totalMin  > 0 ? +(totalMin  / 60).toFixed(1) : '',
      totalCost > 0 ? totalCost : '',
      workers, statuses,
    ]);
  }

  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);
    sheet.getRange(2, 10, rows.length, 1).setNumberFormat('#,##0');

    for (let i = 0; i < rows.length; i++) {
      const remain = rows[i][5];
      if (remain === '') continue;
      const cell = sheet.getRange(i + 2, 6);
      if      (remain <= 3) cell.setFontColor('#D32F2F').setFontWeight('bold');
      else if (remain <= 7) cell.setFontColor('#F57C00');
    }
  }

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, HEADERS.length);
  Logger.log('③案件進捗 更新完了（' + rows.length + '件）');
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
  const scheduleRows = getSheetData(REPORT_CONFIG.scheduleSSId, REPORT_CONFIG.scheduleSheetName,  12);
  const reportSS     = getOrCreateReportSS();

  appendToMonthlyTrend(reportSS, logRows, startDate, endDate, label);
  appendToBrandReport(reportSS, logRows, scheduleRows, startDate, endDate, label);
  appendToProjectReport(reportSS, logRows, scheduleRows, startDate, endDate, label);
  appendToWorkerDetailReport(reportSS, logRows, scheduleRows, startDate, endDate, label);

  Logger.log(label + ' 月次レポート完了: ' + reportSS.getUrl());
}

// ================================================================
// ④ 月次推移（追記型）
// ================================================================
function appendToMonthlyTrend(reportSS, logRows, startDate, endDate, label) {
  const HEADERS = ['年月', '稼働人数', '稼働日数', '実働(h)', '製造(h)', '間接(h)', '製造比率(%)', '製品数', '企画数', '平均製品工数(h)', '労務費(円)'];
  const sheet = getOrInitSheet(reportSS, '④月次推移', HEADERS, '#FBBC04');

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
  const totalActualMin   = [...actualByKey.values()].reduce((a, b) => a + b, 0);
  const totalMfgMin      = colSum(sampleLogs,    L.workMin);
  const totalOtherMin    = colSum(nonSampleLogs, L.workMin);
  const totalCost        = colSum(monthLogs,     L.laborCost);
  const workDays         = new Set(monthLogs.map(r => dFmt(toDate(r[L.date])))).size;
  const workerCount      = new Set(monthLogs.map(r => r[L.worker]).filter(Boolean)).size;
  const productCount     = new Set(sampleLogs.map(r => r[L.product]).filter(Boolean)).size;
  const planCount        = new Set(sampleLogs.map(r => r[L.planName]).filter(Boolean)).size;
  const mfgRatio         = totalActualMin > 0 ? Math.round(totalMfgMin / totalActualMin * 100) : 0;
  const avgMinPerProduct = productCount > 0 ? totalMfgMin / productCount : 0;

  sheet.appendRow([
    label, workerCount, workDays,
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
    '年月', '企画名', 'ブランド', '製品名',
    '月内工数(h)', '月内労務費(円)', '累計工数(h)', '累計労務費(円)',
    '担当者（月内）', '担当者（累計）',
    '実作業開始', '実作業最終', '作業日数',
    '計画開始', '計画完了', 'ステータス', 'フェーズ内訳（月内）',
    '累計_モック(h)', '累計_1st(h)', '累計_2nd(h)', '累計_3rd(h)', '累計_その他(h)',
  ];
  const PHASE_KEYS = ['モック', '1st', '2nd', '3rd'];
  const sheet = getOrInitSheet(reportSS, '⑥企画別', HEADERS, '#A142F4');

  if (labelExists(sheet, label)) {
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

      // フェーズ内訳（月内のみ）
      const phaseMin = new Map();
      for (const r of monthLogs) {
        const ph = r[L.phase] || 'その他';
        phaseMin.set(ph, (phaseMin.get(ph) || 0) + (Number(r[L.workMin]) || 0));
      }
      const phaseStr = [...phaseMin.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([p, m]) => p + ':' + +(m / 60).toFixed(1) + 'h')
        .join(' / ');

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
        label, planName, brand, products,
        monthMin  > 0 ? +(monthMin  / 60).toFixed(1) : '', monthCost  > 0 ? monthCost  : '',
        allMin    > 0 ? +(allMin    / 60).toFixed(1) : '', allCost    > 0 ? allCost    : '',
        monthWorkers, allWorkers,
        firstDate ? dFmt(firstDate) : '', lastDate ? dFmt(lastDate) : '', spanDays,
        planStart ? dFmt(planStart) : '', planEnd  ? dFmt(planEnd)  : '',
        statuses, phaseStr,
        ...phaseCols,
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
// バックフィル：指定開始日から7日ごとに週次レポートをまとめて生成
// ================================================================
function generateWeeklyReportBackfill() {
  // ★ 開始日を変更して実行してください
  const START_DATE_STR = '2026/05/26';

  const startDate = new Date(START_DATE_STR);
  startDate.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const logRows      = getSheetData(REPORT_CONFIG.logSSId,      REPORT_CONFIG.logSheetName,       17);
  const scheduleRows = getSheetData(REPORT_CONFIG.scheduleSSId, REPORT_CONFIG.scheduleSheetName,  12);
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

function labelExists(sheet, label) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  return sheet.getRange(2, 1, lastRow - 1, 1).getValues().some(r => String(r[0]) === label);
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
  const scheduleRows = getSheetData(REPORT_CONFIG.scheduleSSId, REPORT_CONFIG.scheduleSheetName, 12);

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
