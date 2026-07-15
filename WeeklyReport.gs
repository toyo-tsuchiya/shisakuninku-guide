// ================================================================
// 試作課 集計レポート（週次・月次）
// ================================================================

const REPORT_CONFIG = {
  logSSId:          '15FXg3_YFyA-JGVXhtINm7H5jtlO6l07l0wPDezGgqGs',
  scheduleSSId:     '1vdejHfw6fbgVNJc0BuV3xYEWpNNc6lE5iaQYIIJ-QFs',
  logSheetName:     '日報ログ',
  scheduleSheetName:'【スケジュール】2024.01～',
  reportSSId:       '14tMjnRUk5cguC3iX80DwjxeVmyO9TYuv0JFU4cW_ziE',  // 集計レポートSS（ID直指定。名前変更の影響を受けない）
  reportSSName:     'WeeklyReport',
};

// 未入力リマインドの営業日判定で除外する休業日
const JP_HOLIDAY_CALENDAR_ID = 'ja.japanese#holiday@group.v.calendar.google.com';
const HOLIDAY_SHEET_NAME     = '休日';  // 日報集計SS内。年末年始など会社独自の休業日をA列に並べる

// 日報ログの列インデックス（0始まり）
const L = {
  date:      1,  // B: 日付
  worker:    2,  // C: 職人名
  actualMin: 6,  // G: 実働(分)
  type:      7,  // H: 種別
  product:   8,  // I: 製品名
  phase:     9,  // J: フェーズ大分類
  workType:  10, // K: 作業種別
  workMin:   11, // L: 作業時間(分)
  laborCost: 13, // N: 労務費(円)
  planName:  16, // Q: 企画名
  subcat:    17, // R: フェーズ中分類
  category:  18, // S: 製品or販促
};

// フェーズ中分類マスター（Code.gsのSHEETS.STAGE_SUBCATSと同期）
// keysには旧名称（2026-06-18リネーム前）も含め、過去ログを取りこぼさない
const SUBCAT_GROUPS = [
  { label: '型紙・抜き型', keys: ['型紙作成・修正', '型紙・抜き型作成/修正', '抜き型作成'] },
  { label: '仮制作',       keys: ['仮制作（部分サンプル・部分修正）'] },
  { label: '本制作',       keys: ['本制作（型修正がない場合）'] },
  { label: '原価表',       keys: ['原価表作成・修正'] },
  { label: '工程表',       keys: ['工程表作成・修正'] },
];

// 中分類 → 分類（製作/付帯業務）の既定値。マスタのD列「分類」があればそちらを優先する
const DEFAULT_SUBCAT_CLASS = {
  '型紙作成・修正':                   '製作',
  '型紙・抜き型作成/修正':            '製作',  // 旧名称
  '仮制作（部分サンプル・部分修正）': '製作',
  '本制作（型修正がない場合）':       '製作',
  '抜き型作成':                       '付帯業務',
  '原価表作成・修正':                 '付帯業務',
  '工程表作成・修正':                 '付帯業務',
  '引き継ぎ':                         '付帯業務',
  'サンプル依頼ミーティング':          '付帯業務',
  '裁断確認ミーティング':              '付帯業務',
  '製造開発ミーティング':              '付帯業務',
  '色増しフィードバックミーティング':  '付帯業務',
  '量産フィードバックミーティング':    '付帯業務',
  'サンプルチェック':                 '付帯業務',
};

// フェーズ大分類のうち「中分類あり」の8段階（⑧製品×職人別・⑦製品別のフェーズ内訳列に使う）
// ステージマスター（Code.gsのSHEETS.STAGES）で中分類あり=trueのものと一致
const DETAIL_PHASE_KEYS = ['モック', '1st', '2nd', '3rd', '4th', '5th', '最終', '色増しサンプル'];

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
// 週次メイン（毎週木曜 朝8時に自動実行）
// ================================================================
function generateWeeklyReport() {
  const { startDate, endDate } = getWeekRange();
  const logRows      = getSheetData(REPORT_CONFIG.logSSId,      REPORT_CONFIG.logSheetName,       19);
  const reportSS     = getOrCreateReportSS();

  appendToWeeklyTrend(reportSS, logRows, startDate, endDate);
  appendToWorkerWeekly(reportSS, logRows, startDate, endDate);
  archiveCompletedSchedules();
  checkMissingReportsAndRemind(logRows, startDate, endDate);

  Logger.log('週次レポート更新完了: ' + reportSS.getUrl());
}

// ================================================================
// 完了製品の自動アーカイブ（週次実行）
// スケジュールSSで全行のステータスが「完了」の製品をアプリのリストから削除する
// ================================================================
function archiveCompletedSchedules() {
  const scheduleRows = getSheetData(REPORT_CONFIG.scheduleSSId, REPORT_CONFIG.scheduleSheetName, 13, 6);

  // 外部SSで製品名ごとのステータスを集計
  const productStatuses = new Map();
  for (const r of scheduleRows) {
    const product = String(r[S.product] || '').trim();
    const status  = String(r[S.status]  || '').trim();
    if (!product) continue;
    if (!productStatuses.has(product)) productStatuses.set(product, []);
    productStatuses.get(product).push(status);
  }

  // 全行が「完了」または「中断」の製品のみ削除対象（1行でも進行中のステータスがあれば残す）
  const ARCHIVE_STATUSES = new Set(['完了', '中断']);
  const completed = new Set(
    [...productStatuses.entries()]
      .filter(([, statuses]) => statuses.length > 0 && statuses.every(s => ARCHIVE_STATUSES.has(s)))
      .map(([product]) => product)
  );

  if (completed.size === 0) {
    Logger.log('archiveCompletedSchedules: 削除対象なし');
    return;
  }

  // アプリのスケジュールシートから該当製品を削除
  const appSheet = SpreadsheetApp.openById(REPORT_CONFIG.logSSId).getSheetByName('スケジュール');
  if (!appSheet || appSheet.getLastRow() <= 1) return;

  const data = appSheet.getRange(2, 2, appSheet.getLastRow() - 1, 1).getValues();
  const toDelete = data
    .map((r, i) => ({ row: i + 2, name: String(r[0] || '').trim() }))
    .filter(({ name }) => completed.has(name))
    .map(({ row }) => row);

  if (toDelete.length === 0) {
    Logger.log('archiveCompletedSchedules: 削除対象なし（アプリ側に該当製品なし）');
    return;
  }

  // 後ろから削除（行ずれ防止）
  toDelete.reverse().forEach(row => appSheet.deleteRow(row));
  Logger.log('archiveCompletedSchedules 削除完了: ' + toDelete.length + '件 → ' + [...completed].join('、'));
}

// ================================================================
// 日報未入力リマインド（週次レポートと同時に実行。新規トリガー不要）
// 集計期間内の営業日ごとに日報ログを確認し、1日でも入力がない職人へ
// その週の未入力日をまとめてメールで知らせる。カレンダー連携なし。
// ================================================================
function checkMissingReportsAndRemind(logRows, startDate, endDate) {
  const appSS     = SpreadsheetApp.openById(REPORT_CONFIG.logSSId);
  const craftsmen = getCraftsmenForReminder_(appSS).filter(c => c.email);
  if (craftsmen.length === 0) {
    Logger.log('checkMissingReportsAndRemind: メール登録済みの職人がいません（職人シートにメール列を入力してください）');
    return;
  }

  const businessDays = getBusinessDaysInRange_(startDate, endDate, getHolidaySet_(startDate, endDate));
  const loggedSet     = getLoggedDateSet_(logRows);

  craftsmen.forEach(c => {
    const missingDays = businessDays.filter(d => !loggedSet.has(c.name + '_' + dFmt(d)));
    if (missingDays.length === 0) return;
    sendMissingReportReminder_(c.email, c.name, missingDays);
    Logger.log('リマインド送信: ' + c.name + ' <' + c.email + '> 未入力' + missingDays.length + '日');
  });
}

// デバッグ：実際にはメールを送らず、誰にどの日が未入力として検知されるかだけログ出力する
function debugMissingReports() {
  const { startDate, endDate } = getWeekRange();
  const logRows = getSheetData(REPORT_CONFIG.logSSId, REPORT_CONFIG.logSheetName, 19);
  const appSS     = SpreadsheetApp.openById(REPORT_CONFIG.logSSId);
  const craftsmen = getCraftsmenForReminder_(appSS);

  const holidaySet   = getHolidaySet_(startDate, endDate);
  const businessDays = getBusinessDaysInRange_(startDate, endDate, holidaySet);
  const loggedSet     = getLoggedDateSet_(logRows);

  Logger.log('=== 未入力チェック対象期間: ' + dFmt(startDate) + '〜' + dFmt(endDate) + ' ===');
  Logger.log('除外した休業日: ' + ([...holidaySet].sort().join('、') || 'なし'));
  Logger.log('判定対象の営業日: ' + businessDays.map(d => dFmt(d)).join('、'));
  craftsmen.forEach(c => {
    const missingDays = businessDays.filter(d => !loggedSet.has(c.name + '_' + dFmt(d)));
    if (missingDays.length === 0) { Logger.log('  ○ 全日入力済み: ' + c.name); return; }
    const label = c.email ? '× リマインド対象' : '△ 未入力だがメール未登録のため対象外';
    Logger.log('  ' + label + ': ' + c.name + ' → ' + missingDays.map(d => dFmt(d)).join('、'));
  });
}

// 期間内の営業日（土日・祝日・会社休業日を除く）一覧を返す
function getBusinessDaysInRange_(startDate, endDate, holidaySet) {
  const days = [];
  const d = new Date(startDate);
  d.setHours(0, 0, 0, 0);
  const end = new Date(endDate);
  end.setHours(0, 0, 0, 0);
  while (d <= end) {
    const dow = d.getDay();
    const isHoliday = holidaySet ? holidaySet.has(dFmt(d)) : false;
    if (dow !== 0 && dow !== 6 && !isHoliday) days.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

// 期間内の休業日セットを返す（Googleの日本の祝日カレンダー ＋ 日報集計SSの「休日」シート）
// 「休日」シートは任意。なければ祝日カレンダーのみで判定する。
function getHolidaySet_(startDate, endDate) {
  const set = new Set();

  try {
    const cal = CalendarApp.getCalendarById(JP_HOLIDAY_CALENDAR_ID);
    if (cal) {
      cal.getEvents(startDate, endDate).forEach(e => {
        const d = e.isAllDayEvent() ? e.getAllDayStartDate() : e.getStartTime();
        set.add(dFmt(d));
      });
    }
  } catch (err) {
    // カレンダーが読めなくてもリマインド自体は動かす（土日のみ除外に劣化）
    Logger.log('祝日カレンダー取得失敗: ' + err);
  }

  const sheet = SpreadsheetApp.openById(REPORT_CONFIG.logSSId).getSheetByName(HOLIDAY_SHEET_NAME);
  if (sheet && sheet.getLastRow() > 1) {
    const from = new Date(startDate); from.setHours(0, 0, 0, 0);
    const to   = new Date(endDate);   to.setHours(23, 59, 59, 999);
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().forEach(row => {
      const d = toDate(row[0]);
      if (d && d >= from && d <= to) set.add(dFmt(d));
    });
  }

  return set;
}

// 日報集計SSの「職人」シートから職人（名前・メール）を取得
// ※getCraftsmen は日報アプリ(Code.gs)側の関数で、このプロジェクトからは参照できないため自前で持つ
function getCraftsmenForReminder_(ss) {
  const s = ss.getSheetByName('職人');
  if (!s || s.getLastRow() <= 1) return [];
  return s.getRange(2, 1, s.getLastRow() - 1, 4).getValues()
    .filter(r => r[1])
    .map(r => ({ id: r[0], name: r[1], note: r[2], email: r[3] }));
}

// 日報ログから「職人名_日付」の提出済みセットを作る
function getLoggedDateSet_(logRows) {
  return new Set(
    logRows
      .map(r => { const d = toDate(r[L.date]); return d ? String(r[L.worker]||'').trim() + '_' + dFmt(d) : null; })
      .filter(Boolean)
  );
}

function sendMissingReportReminder_(email, name, missingDays) {
  const dateList = missingDays.map(d => dFmt(d)).join('\n・');
  MailApp.sendEmail(
    email,
    '【日報】今週分の未入力日があります',
    name + ' さん\n\n' +
    '今週の集計期間中、以下の日付で日報の入力が確認できませんでした。\n' +
    '・' + dateList + '\n\n' +
    '休みなどで問題ない場合はそのままで大丈夫です。入力漏れの場合はご入力をお願いします。\n\n' +
    '（このメールは試作課日報アプリからの自動送信です）'
  );
}

// ================================================================
// デバッグ：archiveCompletedSchedules の削除対象を確認（削除はしない）
// ================================================================
function debugArchiveSchedules() {
  const scheduleRows = getSheetData(REPORT_CONFIG.scheduleSSId, REPORT_CONFIG.scheduleSheetName, 13, 6);

  Logger.log('=== 外部スケジュールSS 製品×ステータス一覧 ===');
  const productStatuses = new Map();
  for (const r of scheduleRows) {
    const product = String(r[S.product] || '').trim();
    const status  = String(r[S.status]  || '').trim();
    if (!product) continue;
    if (!productStatuses.has(product)) productStatuses.set(product, []);
    productStatuses.get(product).push(status);
  }
  for (const [product, statuses] of productStatuses) {
    Logger.log('  [' + statuses.join('、') + '] ' + product);
  }

  const ARCHIVE_STATUSES = new Set(['完了', '中断']);
  const completed = new Set(
    [...productStatuses.entries()]
      .filter(([, statuses]) => statuses.length > 0 && statuses.every(s => ARCHIVE_STATUSES.has(s)))
      .map(([product]) => product)
  );
  Logger.log('=== 削除対象（外部SSで全行 完了/中断）: ' + completed.size + '件 ===');
  completed.forEach(p => Logger.log('  → ' + p));

  const appSheet = SpreadsheetApp.openById(REPORT_CONFIG.logSSId).getSheetByName('スケジュール');
  if (!appSheet || appSheet.getLastRow() <= 1) {
    Logger.log('=== アプリのスケジュールシートが空 ===');
    return;
  }
  const appProducts = appSheet.getRange(2, 2, appSheet.getLastRow() - 1, 1).getValues()
    .map(r => String(r[0] || '').trim()).filter(Boolean);
  Logger.log('=== アプリの製品リスト: ' + appProducts.length + '件 ===');
  appProducts.forEach(p => {
    const hit = completed.has(p);
    Logger.log('  ' + (hit ? '【削除対象】' : '【残す】') + p);
  });
}

// ================================================================
// 製品/販促区分の解決（⑤⑥⑦⑧の内訳集計で使用）
// ================================================================
// 製品名 → 製品or販促 のマップ（日報アプリの製品マスタから。区分列が空の過去ログの補完用）
function getProductCategoryMap_() {
  const map = new Map();
  const s = SpreadsheetApp.openById(REPORT_CONFIG.logSSId).getSheetByName('スケジュール');
  if (!s || s.getLastRow() <= 1) return map;
  s.getRange(2, 2, s.getLastRow() - 1, 2).getValues().forEach(r => {
    const name = String(r[0] || '').trim();
    const cat  = String(r[1] || '').trim();
    if (name && cat) map.set(name, cat);
  });
  return map;
}

// ログ1行の区分を返す：ログの区分列 → 製品マスタ → 既定「製品」
function logCategory_(r, catMap) {
  const c = String(r[L.category] || '').trim() || catMap.get(r[L.product]) || '';
  return c === '販促' ? '販促' : '製品';
}

// 中分類名 → 分類（製作/付帯業務）のマップ。
// アプリの「フェーズ中分類」シートD列を優先し、未設定はコード内既定値で補完する
function getSubcatClassMap_() {
  const map = new Map(Object.entries(DEFAULT_SUBCAT_CLASS));
  const s = SpreadsheetApp.openById(REPORT_CONFIG.logSSId).getSheetByName('フェーズ中分類');
  if (!s || s.getLastRow() <= 1 || s.getLastColumn() < 4) return map;
  s.getRange(2, 2, s.getLastRow() - 1, 3).getValues().forEach(r => {
    const name = String(r[0] || '').trim();
    const cls  = String(r[2] || '').trim();
    if (name && (cls === '製作' || cls === '付帯業務')) map.set(name, cls);
  });
  return map;
}

// ログ1行の時間分類を返す：製作／付帯業務／中分類未入力
function logSubcatClass_(r, clsMap) {
  const sc = String(r[L.subcat] || '').trim();
  if (!sc) return '中分類未入力';
  return clsMap.get(sc) || '中分類未入力';
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

  const lastRow1 = sheet.getLastRow();
  sheet.getRange(lastRow1, 12).setNumberFormat('#,##0');
  applyMfgRatioColor(sheet.getRange(lastRow1, 10), mfgRatio);
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

    // 既存の週数（ユニークな集計開始日の数）で色インデックスを決める
    const weekIndex = insertRow > 2
      ? new Set(sheet.getRange(2, 1, insertRow - 2, 1).getValues().map(r => String(r[0]))).size
      : 0;
    const bgColor = weekIndex % 2 === 1 ? '#E3F2FD' : '#FFFFFF';

    sheet.getRange(insertRow, 1, newRows.length, HEADERS.length).setValues(newRows);
    sheet.getRange(insertRow, 9, newRows.length, 1).setNumberFormat('#,##0');
    sheet.getRange(insertRow, 1, newRows.length, HEADERS.length).setBackground(bgColor);

    // 製造比率(%)列（8列目）に色付け
    newRows.forEach((r, i) => applyMfgRatioColor(sheet.getRange(insertRow + i, 8), r[7]));
  }
}

// ================================================================
// ② 職人別週次：既存データに週ごとの色分けを一括適用（1回のみ実行）
// ================================================================
function colorWorkerWeeklySheet() {
  const sheet = getOrCreateReportSS().getSheetByName('②職人別週次');
  if (!sheet || sheet.getLastRow() <= 1) return;

  const lastRow = sheet.getLastRow();
  const numCols = sheet.getLastColumn();
  const vals = sheet.getRange(2, 1, lastRow - 1, 1).getValues();

  let currentKey = null;
  let weekIndex  = -1;
  let groupStart = 2;

  for (let i = 0; i < vals.length; i++) {
    const key = String(vals[i][0]);
    const row = i + 2;
    if (key !== currentKey) {
      if (currentKey !== null) {
        const bg = weekIndex % 2 === 1 ? '#E3F2FD' : '#FFFFFF';
        sheet.getRange(groupStart, 1, row - groupStart, numCols).setBackground(bg);
      }
      currentKey = key;
      weekIndex++;
      groupStart = row;
    }
  }
  // 最後のグループ
  const bg = weekIndex % 2 === 1 ? '#E3F2FD' : '#FFFFFF';
  sheet.getRange(groupStart, 1, lastRow - groupStart + 1, numCols).setBackground(bg);

  Logger.log('②職人別週次 色分け完了: ' + (weekIndex + 1) + '週分');
}

// ================================================================
// 製造比率(%)セルに色付け（共通ヘルパー）
// ================================================================
function applyMfgRatioColor(cell, ratio) {
  const r = Number(ratio) || 0;
  if      (r >= 70) cell.setFontColor('#2E7D32').setFontWeight('bold');
  else if (r >= 50) cell.setFontColor('#F57C00').setFontWeight('bold');
  else              cell.setFontColor('#C62828').setFontWeight('bold');
}

// ================================================================
// 製造比率(%)色分けを全シートの既存データに一括適用（1回のみ実行）
// 対象: ①週次推移(10列目)、②職人別週次(8列目)、③月別推移(7列目)、④職人別月次(7列目)
// ================================================================
function colorMfgRatioAllSheets() {
  const ss = getOrCreateReportSS();
  const targets = [
    { name: '①週次推移',   col: 10 },
    { name: '②職人別週次', col: 8  },
    { name: '③月別推移',   col: 7  },
    { name: '④職人別月次', col: 7  },
  ];

  targets.forEach(({ name, col }) => {
    const sheet = ss.getSheetByName(name);
    if (!sheet || sheet.getLastRow() <= 1) return;
    const lastRow = sheet.getLastRow();
    const vals = sheet.getRange(2, col, lastRow - 1, 1).getValues();
    vals.forEach((r, i) => applyMfgRatioColor(sheet.getRange(i + 2, col), r[0]));
    Logger.log(name + ' 製造比率 色分け完了: ' + (lastRow - 1) + '行');
  });
}

// ================================================================
// ④⑤⑥⑦ 月次シート：既存データに月ごとの色分けを一括適用（1回のみ実行）
// ================================================================
function colorMonthlySheet(sheetName, labelCol) {
  const sheet = getOrCreateReportSS().getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() <= 1) return;
  const lastRow = sheet.getLastRow();
  const numCols = sheet.getLastColumn();
  const vals = sheet.getRange(2, labelCol, lastRow - 1, 1).getValues();
  let currentKey = null;
  let monthIndex = -1;
  let groupStart = 2;
  for (let i = 0; i < vals.length; i++) {
    const key = String(vals[i][0]);
    const row = i + 2;
    if (key !== currentKey) {
      if (currentKey !== null) {
        const bg = monthIndex % 2 === 1 ? '#E3F2FD' : '#FFFFFF';
        sheet.getRange(groupStart, 1, row - groupStart, numCols).setBackground(bg);
      }
      currentKey = key;
      monthIndex++;
      groupStart = row;
    }
  }
  const bg = monthIndex % 2 === 1 ? '#E3F2FD' : '#FFFFFF';
  sheet.getRange(groupStart, 1, lastRow - groupStart + 1, numCols).setBackground(bg);
  Logger.log(sheetName + ' 月次色分け完了: ' + (monthIndex + 1) + 'ヶ月分');
}

function colorMonthlyAllSheets() {
  colorMonthlySheet('④職人別月次',   1);
  colorMonthlySheet('⑤ブランド別',   1);
  colorMonthlySheet('⑥企画別',       2);
  colorMonthlySheet('⑦製品別',       1);
  colorMonthlySheet('⑧製品×職人別', 1);
}

// ================================================================
// 月次メイン（毎月1日 朝8時に自動実行。前月分を自動判定して集計）
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

  const logRows      = getSheetData(REPORT_CONFIG.logSSId,      REPORT_CONFIG.logSheetName,       19);
  const scheduleRows = getSheetData(REPORT_CONFIG.scheduleSSId, REPORT_CONFIG.scheduleSheetName,  13, 6);
  const reportSS     = getOrCreateReportSS();

  appendToMonthlyTrend(reportSS, logRows, startDate, endDate, label);
  appendToBrandReport(reportSS, logRows, scheduleRows, startDate, endDate, label);
  appendToProjectReport(reportSS, logRows, scheduleRows, startDate, endDate, label);
  appendToProductReport(reportSS, logRows, scheduleRows, startDate, endDate, label);
  appendToProductWorkerReport(reportSS, logRows, scheduleRows, startDate, endDate, label);
  appendToWorkerMonthly(reportSS, logRows, startDate, endDate, label);
  buildAllSummarySheets(reportSS, logRows, scheduleRows, year, month);

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

  applyMfgRatioColor(sheet.getRange(lastRow, 7), mfgRatio);
}

// ================================================================
// ⑤ ブランド別（月次追記型・月内 + 累計）
// ================================================================
function appendToBrandReport(reportSS, logRows, scheduleRows, startDate, endDate, label) {
  const HEADERS = [
    '年月', 'ブランド', '企画数', '製品数',
    '月内工数(h)', '月内_製品(h)', '月内_販促(h)', '月内労務費(円)',
    '累計工数(h)', '累計_製品(h)', '累計_販促(h)', '累計労務費(円)',
    '担当者（全期間）',
  ];
  const sheet = getOrInitSheet(reportSS, '⑤ブランド別', HEADERS, '#FDD663');

  // ヘッダー列数が変わった場合（製品/販促内訳列追加など）は自動更新
  if (sheet.getLastColumn() < HEADERS.length) {
    sheet.getRange(1, 1, 1, HEADERS.length)
      .setValues([HEADERS])
      .setBackground('#37474F').setFontColor('#FFFFFF').setFontWeight('bold').setHorizontalAlignment('center');
  }

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

  const catMap = getProductCategoryMap_();
  const allSampleLogs   = logRows.filter(r => r[L.type] === 'サンプル製造');
  const monthSampleLogs = allSampleLogs.filter(r => { const d = toDate(r[L.date]); return d && d >= startDate && d <= endDate; });

  // 全期間集計（累計）
  const allBrandMap = new Map();
  for (const r of allSampleLogs) {
    const brand = productToBrand.get(r[L.product]) || planToBrand.get(r[L.planName]) || '未紐付け';
    if (!allBrandMap.has(brand)) allBrandMap.set(brand, { plans: new Set(), products: new Set(), workers: new Set(), workMin: 0, productMin: 0, promoMin: 0, cost: 0 });
    const b = allBrandMap.get(brand);
    if (r[L.planName]) b.plans.add(r[L.planName]);
    if (r[L.product])  b.products.add(r[L.product]);
    if (r[L.worker])   b.workers.add(r[L.worker]);
    const min = Number(r[L.workMin]) || 0;
    b.workMin += min;
    if (logCategory_(r, catMap) === '販促') b.promoMin += min; else b.productMin += min;
    b.cost    += Number(r[L.laborCost]) || 0;
  }

  // 月内集計
  const monthBrandMap = new Map();
  for (const r of monthSampleLogs) {
    const brand = productToBrand.get(r[L.product]) || planToBrand.get(r[L.planName]) || '未紐付け';
    if (!monthBrandMap.has(brand)) monthBrandMap.set(brand, { workMin: 0, productMin: 0, promoMin: 0, cost: 0 });
    const b = monthBrandMap.get(brand);
    const min = Number(r[L.workMin]) || 0;
    b.workMin += min;
    if (logCategory_(r, catMap) === '販促') b.promoMin += min; else b.productMin += min;
    b.cost    += Number(r[L.laborCost]) || 0;
  }

  const hOrBlank = min => min > 0 ? +(min / 60).toFixed(1) : '';

  // 月内に動きがあったブランドのみ追記
  const newRows = [...allBrandMap.keys()]
    .filter(brand => monthBrandMap.has(brand))
    .sort((a, b) => a.localeCompare(b, 'ja'))
    .map(brand => {
      const all   = allBrandMap.get(brand);
      const month = monthBrandMap.get(brand);
      return [
        label, brand, all.plans.size, all.products.size,
        +(month.workMin / 60).toFixed(1), hOrBlank(month.productMin), hOrBlank(month.promoMin), month.cost,
        +(all.workMin   / 60).toFixed(1), hOrBlank(all.productMin),   hOrBlank(all.promoMin),   all.cost,
        [...all.workers].join('、'),
      ];
    });

  if (newRows.length > 0) {
    const insertRow = sheet.getLastRow() + 1;
    const monthIndex = insertRow > 2
      ? new Set(sheet.getRange(2, 1, insertRow - 2, 1).getValues().map(r => String(r[0]))).size
      : 0;
    const bgColor = monthIndex % 2 === 1 ? '#E3F2FD' : '#FFFFFF';
    sheet.getRange(insertRow, 1, newRows.length, HEADERS.length).setValues(newRows);
    sheet.getRange(insertRow, 1, newRows.length, HEADERS.length).setBackground(bgColor);
    sheet.getRange(insertRow, 8,  newRows.length, 1).setNumberFormat('#,##0');
    sheet.getRange(insertRow, 12, newRows.length, 1).setNumberFormat('#,##0');
  }

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, HEADERS.length);
  Logger.log('⑤ブランド別 追記完了（' + newRows.length + 'ブランド / ' + label + '）');
}

// ================================================================
// ⑥ 企画別（月次追記型・月内 + 累計）「誰が入って・どれくらいで」
// ================================================================
function appendToProjectReport(reportSS, logRows, scheduleRows, startDate, endDate, label) {
  const PHASE_KEYS = ['モック', '1st', '2nd', '3rd'];
  const HEADERS = [
    'ステータス',
    '年月', '企画名', 'ブランド', '製品名',
    '月内工数(h)', '月内_製品(h)', '月内_販促(h)', '月内労務費(円)',
    '累計工数(h)', '累計_製品(h)', '累計_販促(h)', '累計労務費(円)',
    '担当者（月内）', '担当者（累計）',
    '実作業開始', '実作業最終', '作業日数',
    '計画開始', '計画完了',
    '月内_モック(h)', '月内_1st(h)', '月内_2nd(h)', '月内_3rd(h)', '月内_その他(h)',
    ...SUBCAT_GROUPS.map(g => '月内_' + g.label + '(h)'),
    '累計_モック(h)', '累計_1st(h)', '累計_2nd(h)', '累計_3rd(h)', '累計_その他(h)',
    ...SUBCAT_GROUPS.map(g => '累計_' + g.label + '(h)'),
  ];
  const sheet = getOrInitSheet(reportSS, '⑥企画別', HEADERS, '#A142F4');

  // ヘッダー列数が変わった場合（中分類列追加など）は自動更新
  if (sheet.getLastColumn() < HEADERS.length) {
    sheet.getRange(1, 1, 1, HEADERS.length)
      .setValues([HEADERS])
      .setBackground('#37474F').setFontColor('#FFFFFF').setFontWeight('bold').setHorizontalAlignment('center');
  }

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

  const catMap = getProductCategoryMap_();
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

      // 製品/販促内訳
      const monthProductMin = colSum(monthLogs.filter(r => logCategory_(r, catMap) === '製品'), L.workMin);
      const monthPromoMin   = colSum(monthLogs.filter(r => logCategory_(r, catMap) === '販促'), L.workMin);
      const allProductMin   = colSum(allLogs.filter(r => logCategory_(r, catMap) === '製品'),   L.workMin);
      const allPromoMin     = colSum(allLogs.filter(r => logCategory_(r, catMap) === '販促'),   L.workMin);

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

      // 中分類別（月内）
      const monthSubcatMin = new Map();
      for (const r of monthLogs) {
        const sc = r[L.subcat] || '';
        const g  = SUBCAT_GROUPS.find(g => g.keys.includes(sc));
        if (!g) continue;
        monthSubcatMin.set(g.label, (monthSubcatMin.get(g.label) || 0) + (Number(r[L.workMin]) || 0));
      }
      const monthSubcatCols = SUBCAT_GROUPS.map(g => {
        const m = monthSubcatMin.get(g.label) || 0;
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

      // 中分類別累計（全期間）
      const allSubcatMin = new Map();
      for (const r of allLogs) {
        const sc = r[L.subcat] || '';
        const g  = SUBCAT_GROUPS.find(g => g.keys.includes(sc));
        if (!g) continue;
        allSubcatMin.set(g.label, (allSubcatMin.get(g.label) || 0) + (Number(r[L.workMin]) || 0));
      }
      const subcatCols = SUBCAT_GROUPS.map(g => {
        const m = allSubcatMin.get(g.label) || 0;
        return m > 0 ? +(m / 60).toFixed(1) : '';
      });

      return [
        statuses,
        label, planName, brand, products,
        monthMin > 0 ? +(monthMin / 60).toFixed(1) : '',
        monthProductMin > 0 ? +(monthProductMin / 60).toFixed(1) : '',
        monthPromoMin   > 0 ? +(monthPromoMin   / 60).toFixed(1) : '',
        monthCost > 0 ? monthCost : '',
        allMin > 0 ? +(allMin / 60).toFixed(1) : '',
        allProductMin > 0 ? +(allProductMin / 60).toFixed(1) : '',
        allPromoMin   > 0 ? +(allPromoMin   / 60).toFixed(1) : '',
        allCost > 0 ? allCost : '',
        monthWorkers, allWorkers,
        firstDate ? dFmt(firstDate) : '', lastDate ? dFmt(lastDate) : '', spanDays,
        planStart ? dFmt(planStart) : '', planEnd  ? dFmt(planEnd)  : '',
        ...monthPhaseCols,
        ...monthSubcatCols,
        ...phaseCols,
        ...subcatCols,
      ];
    });

  if (newRows.length > 0) {
    const insertRow = sheet.getLastRow() + 1;
    const monthIndex = insertRow > 2
      ? new Set(sheet.getRange(2, 2, insertRow - 2, 1).getValues().map(r => String(r[0]))).size
      : 0;
    const bgColor = monthIndex % 2 === 1 ? '#E3F2FD' : '#FFFFFF';
    sheet.getRange(insertRow, 1, newRows.length, HEADERS.length).setValues(newRows);
    sheet.getRange(insertRow, 1, newRows.length, HEADERS.length).setBackground(bgColor);
    sheet.getRange(insertRow, 9,  newRows.length, 1).setNumberFormat('#,##0');
    sheet.getRange(insertRow, 13, newRows.length, 1).setNumberFormat('#,##0');
  }

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, HEADERS.length);
  sheet.hideColumns(1, 1);
  Logger.log('⑥企画別 追記完了（' + newRows.length + '件 / ' + label + '）');
}

// ================================================================
// ⑦ 製品別（月次追記型・月内 + 累計）「製品ごとにチーム合計で何時間・どのフェーズに」
// ⑥企画別より細かく、⑧製品×職人別を職人でまとめた粒度（チームでの製品単位）
// ================================================================
function appendToProductReport(reportSS, logRows, scheduleRows, startDate, endDate, label) {
  const PHASE_KEYS = DETAIL_PHASE_KEYS;
  const HEADERS = [
    '年月', '企画名', 'ブランド', '製品名', '区分', '担当人数', '担当者（累計）',
    '月内工数(h)', '月内労務費(円)', '累計工数(h)', '累計労務費(円)',
    ...PHASE_KEYS.map(p => '月内_' + p + '(h)'), '月内_その他(h)',
    ...PHASE_KEYS.map(p => '累計_' + p + '(h)'), '累計_その他(h)',
  ];
  const sheet = getOrInitSheet(reportSS, '⑦製品別', HEADERS, '#26A69A');

  // ヘッダー列数が変わった場合（フェーズ列追加など）は自動更新
  if (sheet.getLastColumn() < HEADERS.length) {
    sheet.getRange(1, 1, 1, HEADERS.length)
      .setValues([HEADERS])
      .setBackground('#37474F').setFontColor('#FFFFFF').setFontWeight('bold').setHorizontalAlignment('center');
  }

  if (labelExists(sheet, label)) {
    Logger.log('⑦製品別: ' + label + ' 既存 → スキップ');
    return;
  }

  const productPlanMap = new Map();
  const productToBrand = new Map();
  const planToBrand    = new Map();
  for (const s of scheduleRows) {
    const plan  = s[S.planName] || '';
    const prod  = s[S.product]  || '';
    const brand = s[S.brand]    || '';
    if (prod && plan)  productPlanMap.set(prod, plan);
    if (prod && brand) productToBrand.set(prod, brand);
    if (plan && brand) planToBrand.set(plan, brand);
  }

  const catMap = getProductCategoryMap_();
  const allSampleLogs   = logRows.filter(r => r[L.type] === 'サンプル製造');
  const monthSampleLogs = allSampleLogs.filter(r => { const d = toDate(r[L.date]); return d && d >= startDate && d <= endDate; });

  function buildMap(rows) {
    const map = new Map();
    for (const r of rows) {
      const product = r[L.product] || '';
      if (!product) continue;
      if (!map.has(product)) map.set(product, { workMin: 0, cost: 0, workers: new Set(), phaseMin: new Map(), plan: '', category: '' });
      const e = map.get(product);
      e.workMin += Number(r[L.workMin])   || 0;
      e.cost    += Number(r[L.laborCost]) || 0;
      if (r[L.worker]) e.workers.add(r[L.worker]);
      if (!e.plan && r[L.planName]) e.plan = r[L.planName];
      if (r[L.category]) e.category = r[L.category];
      const ph = r[L.phase] || '';
      const pk = PHASE_KEYS.includes(ph) ? ph : 'その他';
      e.phaseMin.set(pk, (e.phaseMin.get(pk) || 0) + (Number(r[L.workMin]) || 0));
    }
    return map;
  }

  const monthMap = buildMap(monthSampleLogs);
  const allMap   = buildMap(allSampleLogs);

  const newRows = [...monthMap.keys()]
    .sort((a, b) => a.localeCompare(b, 'ja'))
    .map(product => {
      const month = monthMap.get(product);
      const all   = allMap.get(product) || { workMin: 0, cost: 0, workers: new Set(), phaseMin: new Map(), plan: '', category: '' };
      const plan  = productPlanMap.get(product) || all.plan || '';
      const brand = productToBrand.get(product) || planToBrand.get(plan) || '';
      const category = all.category === '販促' || (!all.category && catMap.get(product) === '販促') ? '販促' : '製品';
      const monthPhaseCols = [...PHASE_KEYS, 'その他'].map(ph => { const m = month.phaseMin.get(ph) || 0; return m > 0 ? +(m / 60).toFixed(1) : ''; });
      const allPhaseCols   = [...PHASE_KEYS, 'その他'].map(ph => { const m = all.phaseMin.get(ph)   || 0; return m > 0 ? +(m / 60).toFixed(1) : ''; });
      return [
        label, plan, brand, product, category, all.workers.size, [...all.workers].join('、'),
        month.workMin > 0 ? +(month.workMin / 60).toFixed(1) : '', month.cost > 0 ? month.cost : '',
        all.workMin   > 0 ? +(all.workMin   / 60).toFixed(1) : '', all.cost   > 0 ? all.cost   : '',
        ...monthPhaseCols, ...allPhaseCols,
      ];
    });

  if (newRows.length > 0) {
    const insertRow = sheet.getLastRow() + 1;
    const monthIndex = insertRow > 2
      ? new Set(sheet.getRange(2, 1, insertRow - 2, 1).getValues().map(r => String(r[0]))).size
      : 0;
    const bgColor = monthIndex % 2 === 1 ? '#E3F2FD' : '#FFFFFF';
    sheet.getRange(insertRow, 1, newRows.length, HEADERS.length).setValues(newRows);
    sheet.getRange(insertRow, 1, newRows.length, HEADERS.length).setBackground(bgColor);
    sheet.getRange(insertRow, 9,  newRows.length, 1).setNumberFormat('#,##0');
    sheet.getRange(insertRow, 11, newRows.length, 1).setNumberFormat('#,##0');
  }

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, HEADERS.length);
  Logger.log('⑦製品別 追記完了（' + newRows.length + '製品 / ' + label + '）');
}

// ================================================================
// ⑧ 製品×職人別（月次追記型・月内 + 累計）「誰がどの製品のどのフェーズに何時間」
// ================================================================
function appendToProductWorkerReport(reportSS, logRows, scheduleRows, startDate, endDate, label) {
  const PHASE_KEYS = DETAIL_PHASE_KEYS;
  const HEADERS = [
    '年月', '企画名', '製品名', '区分', '職人名',
    '月内工数(h)', '月内労務費(円)', '累計工数(h)', '累計労務費(円)',
    ...PHASE_KEYS.map(p => '月内_' + p + '(h)'), '月内_その他(h)',
    ...PHASE_KEYS.map(p => '累計_' + p + '(h)'), '累計_その他(h)',
  ];
  const sheet = getOrInitSheet(reportSS, '⑧製品×職人別', HEADERS, '#FF7043');

  // ヘッダー列数が変わった場合（フェーズ列追加など）は自動更新
  if (sheet.getLastColumn() < HEADERS.length) {
    sheet.getRange(1, 1, 1, HEADERS.length)
      .setValues([HEADERS])
      .setBackground('#37474F').setFontColor('#FFFFFF').setFontWeight('bold').setHorizontalAlignment('center');
  }

  if (labelExists(sheet, label)) {
    Logger.log('⑧製品×職人別: ' + label + ' 既存 → スキップ');
    return;
  }

  const productPlanMap = new Map();
  for (const s of scheduleRows) {
    const plan = s[S.planName] || '';
    const prod = s[S.product]  || '';
    if (prod && plan) productPlanMap.set(prod, plan);
  }

  const catMap = getProductCategoryMap_();
  const allSampleLogs   = logRows.filter(r => r[L.type] === 'サンプル製造');
  const monthSampleLogs = allSampleLogs.filter(r => { const d = toDate(r[L.date]); return d && d >= startDate && d <= endDate; });

  function buildMap(rows) {
    const map = new Map();
    for (const r of rows) {
      const product = r[L.product] || '';
      const worker  = r[L.worker]  || '';
      if (!product || !worker) continue;
      const key = product + '\t' + worker;
      if (!map.has(key)) map.set(key, { workMin: 0, cost: 0, phaseMin: new Map(), category: '' });
      const e = map.get(key);
      e.workMin += Number(r[L.workMin])   || 0;
      e.cost    += Number(r[L.laborCost]) || 0;
      if (r[L.category]) e.category = r[L.category];
      const ph = r[L.phase] || '';
      const pk = PHASE_KEYS.includes(ph) ? ph : 'その他';
      e.phaseMin.set(pk, (e.phaseMin.get(pk) || 0) + (Number(r[L.workMin]) || 0));
    }
    return map;
  }

  const monthMap = buildMap(monthSampleLogs);
  const allMap   = buildMap(allSampleLogs);

  const newRows = [...monthMap.keys()]
    .sort((a, b) => a.localeCompare(b, 'ja'))
    .map(key => {
      const [product, worker] = key.split('\t');
      const month = monthMap.get(key);
      const all   = allMap.get(key) || { workMin: 0, cost: 0, phaseMin: new Map(), category: '' };
      const category = all.category === '販促' || (!all.category && catMap.get(product) === '販促') ? '販促' : '製品';
      const monthPhaseCols = [...PHASE_KEYS, 'その他'].map(ph => { const m = month.phaseMin.get(ph) || 0; return m > 0 ? +(m / 60).toFixed(1) : ''; });
      const allPhaseCols   = [...PHASE_KEYS, 'その他'].map(ph => { const m = all.phaseMin.get(ph)   || 0; return m > 0 ? +(m / 60).toFixed(1) : ''; });
      return [
        label, productPlanMap.get(product) || '', product, category, worker,
        month.workMin > 0 ? +(month.workMin / 60).toFixed(1) : '', month.cost > 0 ? month.cost : '',
        all.workMin   > 0 ? +(all.workMin   / 60).toFixed(1) : '', all.cost   > 0 ? all.cost   : '',
        ...monthPhaseCols, ...allPhaseCols,
      ];
    });

  if (newRows.length > 0) {
    const insertRow = sheet.getLastRow() + 1;
    const monthIndex = insertRow > 2
      ? new Set(sheet.getRange(2, 1, insertRow - 2, 1).getValues().map(r => String(r[0]))).size
      : 0;
    const bgColor = monthIndex % 2 === 1 ? '#E3F2FD' : '#FFFFFF';
    sheet.getRange(insertRow, 1, newRows.length, HEADERS.length).setValues(newRows);
    sheet.getRange(insertRow, 1, newRows.length, HEADERS.length).setBackground(bgColor);
    sheet.getRange(insertRow, 7, newRows.length, 1).setNumberFormat('#,##0');
    sheet.getRange(insertRow, 9, newRows.length, 1).setNumberFormat('#,##0');
  }

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, HEADERS.length);
  Logger.log('⑧製品×職人別 追記完了（' + newRows.length + '件 / ' + label + '）');
}

// ================================================================
// ⑦（旧） 職人別ブランド×企画（月次追記型・月内 + 累計）「誰がどの事業・企画に」
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
// ④ 職人別月次（月次追記型）②職人別週次の月次版
// ================================================================
function appendToWorkerMonthly(reportSS, logRows, startDate, endDate, label) {
  const HEADERS = ['年月', '職人名', '稼働日数', '実働(h)', '製造(h)', '間接(h)', '製造比率(%)', '労務費(円)'];
  const sheet = getOrInitSheet(reportSS, '④職人別月次', HEADERS, '#4DD0E1');

  if (labelExists(sheet, label)) {
    Logger.log('④職人別月次: ' + label + ' 既存 → スキップ');
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
    const monthIndex = insertRow > 2
      ? new Set(sheet.getRange(2, 1, insertRow - 2, 1).getValues().map(r => String(r[0]))).size
      : 0;
    const bgColor = monthIndex % 2 === 1 ? '#E3F2FD' : '#FFFFFF';
    sheet.getRange(insertRow, 1, newRows.length, HEADERS.length).setValues(newRows);
    sheet.getRange(insertRow, 1, newRows.length, HEADERS.length).setBackground(bgColor);
    sheet.getRange(insertRow, 8, newRows.length, 1).setNumberFormat('#,##0');
    // 製造比率(%)列（7列目）に色付け
    newRows.forEach((r, i) => applyMfgRatioColor(sheet.getRange(insertRow + i, 7), r[6]));
  }

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, HEADERS.length);
  Logger.log('④職人別月次 追記完了（' + newRows.length + '件 / ' + label + '）');
}

// ================================================================
// ⓪ 試作課 日報サマリー（毎月上書き型ダッシュボード）
//
// 目的：試作課の日報データをもとに、試作課が「何に」「どれくらい時間を使い」
// 「今どのような状況なのか」を誰でも数分で理解できるようにする。
// 評価や監視ではなく、活動状況の共有・可視化が目的。
//
// 表現ルール（2026-07-14 方針決定）：
// ・「超過」「異常」「問題案件」など断定的な表現は使わない（標準工数が未設定のため）
// ・色は評価色（赤黄緑）ではなく青の濃淡（濃い青=工数上位20%、薄い青=20〜40%）
// ・赤は未入力・データ不整合など客観的な異常のみに限定
// ・担当者別は「稼働状況」と表記し、効率・生産性の比較にしない
// ================================================================
const SUMMARY_SHEET_NAME       = '⓪日報サマリー';    // 製品のみ
const SUMMARY_PROMO_SHEET_NAME = '⓪販促サマリー';    // 販促のみ
const SUMMARY_COLS       = 8;
const SUMMARY_BLUE_DARK  = '#1565C0';  // 工数上位20%
const SUMMARY_BLUE_LIGHT = '#64B5F6';  // 上位20〜40%
const SUMMARY_GRAY       = '#B0BEC5';  // その他

function generateSummarySheet(year, month) {
  const logRows      = getSheetData(REPORT_CONFIG.logSSId,      REPORT_CONFIG.logSheetName,       19);
  const scheduleRows = getSheetData(REPORT_CONFIG.scheduleSSId, REPORT_CONFIG.scheduleSheetName,  13, 6);
  buildAllSummarySheets(getOrCreateReportSS(), logRows, scheduleRows, year, month);
}

// 単月を手動で生成/更新するラッパー（上書き型なので何度実行してもOK。月の途中でも安全）
function runSummary202606() { generateSummarySheet(2026, 6); }
function runSummary202607() { generateSummarySheet(2026, 7); }

// 製品サマリーと販促サマリーの2枚を生成する
function buildAllSummarySheets(reportSS, logRows, scheduleRows, year, month) {
  buildSummarySheet(reportSS, logRows, scheduleRows, year, month, {
    sheetName: SUMMARY_SHEET_NAME,
    category:  '製品',
    title:     '試作課 日報サマリー',
    note:      '試作課が製品開発に「何に・どれくらい時間を使い・今どんな状況か」を共有するためのシートです（評価や監視を目的としたものではありません。販促物は「⓪販促サマリー」へ）',
    tabColor:  SUMMARY_BLUE_DARK,
    position:  0,
  });
  buildSummarySheet(reportSS, logRows, scheduleRows, year, month, {
    sheetName: SUMMARY_PROMO_SHEET_NAME,
    category:  '販促',
    title:     '試作課 販促サマリー',
    note:      '販促物（ショート動画・撮影用制作など）に使った時間のサマリーです（評価や監視を目的としたものではありません）',
    tabColor:  '#E65100',
    position:  1,
  });
}

function buildSummarySheet(reportSS, logRows, scheduleRows, year, month, opts) {
  const category = opts.category;
  const label     = year + '年' + String(month).padStart(2, '0') + '月';
  const startDate = new Date(year, month - 1, 1);
  const endDate   = new Date(year, month,     0, 23, 59, 59, 999);
  const prevStart = new Date(year, month - 2, 1);
  const prevEnd   = new Date(year, month - 1, 0, 23, 59, 59, 999);

  const catMap  = getProductCategoryMap_();
  const inRange = (r, s, e) => { const d = toDate(r[L.date]); return d && d >= s && d <= e; };

  // 対象区分（製品 or 販促）のサンプル製造ログだけを集計対象にする
  const isTarget = r => r[L.type] === 'サンプル製造' && logCategory_(r, catMap) === category;
  const monthLogs   = logRows.filter(r => inRange(r, startDate, endDate));
  const prevLogs    = logRows.filter(r => inRange(r, prevStart, prevEnd));
  const monthSample = monthLogs.filter(isTarget);
  const prevSample  = prevLogs.filter(isTarget);
  const allSample   = logRows.filter(isTarget);

  // ---- 集計 ------------------------------------------------------
  // 対象区分の工数・労務費・案件数・人数 ＋ 参考として課全体の総工数と間接
  function calcKpi(sample, logs) {
    return {
      min:      colSum(sample, L.workMin),
      cost:     colSum(sample, L.laborCost),
      products: new Set(sample.map(r => r[L.product]).filter(Boolean)).size,
      workers:  new Set(sample.map(r => r[L.worker]).filter(Boolean)).size,
      deptMin:  colSum(logs, L.workMin),
      indMin:   colSum(logs.filter(r => r[L.type] !== 'サンプル製造'), L.workMin),
    };
  }
  const cur  = calcKpi(monthSample, monthLogs);
  const prev = calcKpi(prevSample,  prevLogs);

  // 製品別（月内）
  const prodMonth = new Map();
  for (const r of monthSample) {
    const p = r[L.product] || '';
    if (!p) continue;
    if (!prodMonth.has(p)) prodMonth.set(p, { min: 0, workers: new Set() });
    const e = prodMonth.get(p);
    e.min += Number(r[L.workMin]) || 0;
    if (r[L.worker]) e.workers.add(r[L.worker]);
  }

  // 製品別（累計）・現在工程（直近の日報のフェーズ）・企画名
  const prodAllMin  = new Map();
  const prodLastLog = new Map();
  const prodPlan    = new Map();
  for (const r of allSample) {
    const p = r[L.product] || '';
    if (!p) continue;
    prodAllMin.set(p, (prodAllMin.get(p) || 0) + (Number(r[L.workMin]) || 0));
    const d = toDate(r[L.date]);
    if (d && (!prodLastLog.has(p) || d > prodLastLog.get(p).time)) prodLastLog.set(p, { time: d, phase: r[L.phase] || '' });
    if (r[L.planName] && !prodPlan.has(p)) prodPlan.set(p, r[L.planName]);
  }
  for (const s of scheduleRows) {
    if (s[S.product] && s[S.planName]) prodPlan.set(s[S.product], s[S.planName]);
  }
  const nameOf = p => (prodPlan.get(p) ? prodPlan.get(p) + '｜' : '') + p;

  // 工程別（月内）
  const PHASE_GROUPS = [
    { name: 'モック',         keys: ['モック'] },
    { name: '1st',            keys: ['1st'] },
    { name: '2nd',            keys: ['2nd'] },
    { name: '3rd以降',        keys: ['3rd', '4th', '5th'] },
    { name: '最終',           keys: ['最終'] },
    { name: '色増しサンプル', keys: ['色増しサンプル'] },
  ];
  const phaseMin = new Map();
  for (const r of monthSample) {
    const ph  = r[L.phase] || '';
    const g   = PHASE_GROUPS.find(g => g.keys.includes(ph));
    const key = g ? g.name : 'その他';
    phaseMin.set(key, (phaseMin.get(key) || 0) + (Number(r[L.workMin]) || 0));
  }
  const phaseRows = [...PHASE_GROUPS.map(g => g.name), 'その他']
    .map(name => ({ name, min: phaseMin.get(name) || 0 }))
    .filter(e => e.min > 0);

  // 製作/付帯業務の内訳（月内・前月。中分類マスタの「分類」列に基づく）
  const clsMap = getSubcatClassMap_();
  const CLS_KEYS = ['製作', '付帯業務', '中分類未入力'];
  const sumByClass = sample => {
    const m = new Map();
    for (const r of sample) {
      const k = logSubcatClass_(r, clsMap);
      m.set(k, (m.get(k) || 0) + (Number(r[L.workMin]) || 0));
    }
    return m;
  };
  const clsCur  = sumByClass(monthSample);
  const clsPrev = sumByClass(prevSample);

  // 担当者別（月内・製造）
  const workerMap = new Map();
  for (const r of monthSample) {
    const w = r[L.worker] || '';
    if (!w) continue;
    if (!workerMap.has(w)) workerMap.set(w, { min: 0, products: new Set() });
    const e = workerMap.get(w);
    e.min += Number(r[L.workMin]) || 0;
    if (r[L.product]) e.products.add(r[L.product]);
  }

  // ---- 表示ヘルパー ----------------------------------------------
  const fmtH  = min => +(min / 60).toFixed(1);
  const comma = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const barTx = (val, max, width) => (max > 0 && val > 0) ? '█'.repeat(Math.max(1, Math.round(val / max * width))) : '';
  const deltaStr = (c, p, unit, isMoney) => {
    const d = c - p;
    if (Math.abs(d) < 0.05) return '前月比 ±0';
    const v = isMoney ? comma(Math.abs(d)) : String(Math.abs(+d.toFixed(1)));
    return '前月比 ' + (d > 0 ? '＋' : '−') + v + unit;
  };
  const rankColor = (i, n) => i < Math.ceil(n * 0.2) ? SUMMARY_BLUE_DARK : i < Math.ceil(n * 0.4) ? SUMMARY_BLUE_LIGHT : SUMMARY_GRAY;

  // ---- シート初期化（💬トピック欄の手入力は同じ月の再生成なら保持）----
  let sheet = reportSS.getSheetByName(opts.sheetName);
  let savedTopic = '';
  if (sheet) {
    const sameMonth = String(sheet.getRange(1, 1).getValue() || '').includes(label);
    const hit = sheet.createTextFinder('💬 今月のトピック').findNext();
    if (hit && sameMonth) savedTopic = String(sheet.getRange(hit.getRow() + 1, 1).getValue() || '');
    sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).breakApart();
    sheet.clear();
  } else {
    sheet = reportSS.insertSheet(opts.sheetName, opts.position);
  }
  sheet.setTabColor(opts.tabColor);
  sheet.setHiddenGridlines(true);

  const sectionHeader = (r, title) => sheet.getRange(r, 1, 1, SUMMARY_COLS).merge().setValue(title)
    .setFontWeight('bold').setFontSize(11).setBackground('#455A64').setFontColor('#FFFFFF');
  const noteRow = (r, text) => sheet.getRange(r, 1, 1, SUMMARY_COLS).merge().setValue(text)
    .setFontSize(8).setFontColor('#90A4AE');

  // ---- タイトル ---------------------------------------------------
  sheet.getRange(1, 1, 1, SUMMARY_COLS).merge()
    .setValue(opts.title + '（' + label + '）').setFontSize(16).setFontWeight('bold');
  sheet.getRange(2, 1, 1, SUMMARY_COLS).merge()
    .setValue(opts.note)
    .setFontSize(9).setFontColor('#78909C');
  let row = 4;

  // ---- 📦 今月の活動（KPIカード）----------------------------------
  sectionHeader(row, '📦 今月の活動（' + category + '）'); row++;
  const kpis = [
    [category + '工数',        fmtH(cur.min) + 'h',      deltaStr(fmtH(cur.min), fmtH(prev.min), 'h')],
    ['労務費（' + category + '）', '¥' + comma(cur.cost), deltaStr(cur.cost, prev.cost, '円', true)],
    ['稼働案件', cur.products + '件', deltaStr(cur.products, prev.products, '件')],
    ['担当人数', cur.workers + '名',  deltaStr(cur.workers, prev.workers, '名')],
    ['課全体 総工数（参考）', fmtH(cur.deptMin) + 'h', deltaStr(fmtH(cur.deptMin), fmtH(prev.deptMin), 'h')],
    ['うち間接（参考）',      fmtH(cur.indMin) + 'h',  deltaStr(fmtH(cur.indMin),  fmtH(prev.indMin),  'h')],
  ];
  kpis.forEach((k, i) => {
    const c = i + 1;
    sheet.getRange(row,     c).setValue(k[0]).setFontSize(9).setFontColor('#78909C');
    sheet.getRange(row + 1, c).setValue(k[1]).setFontSize(15).setFontWeight('bold');
    sheet.getRange(row + 2, c).setValue(k[2]).setFontSize(8).setFontColor('#90A4AE');
  });
  row += 4;

  // ---- 🔧 製作/付帯業務の内訳 --------------------------------------
  sectionHeader(row, '🔧 ' + category + '工数の内訳（製作／付帯業務）'); row++;
  const clsTotal = CLS_KEYS.reduce((a, k) => a + (clsCur.get(k) || 0), 0);
  const clsMax   = CLS_KEYS.reduce((a, k) => Math.max(a, clsCur.get(k) || 0), 0);
  if (clsTotal === 0) { noteRow(row, '該当月のデータがありません'); row++; }
  CLS_KEYS.forEach(k => {
    const min = clsCur.get(k) || 0;
    if (min === 0) return;
    const share = clsTotal > 0 ? Math.round(min / clsTotal * 100) : 0;
    sheet.getRange(row, 1).setValue(k).setFontSize(10);
    sheet.getRange(row, 4, 1, 2).merge().setValue(barTx(min, clsMax, 16))
      .setFontColor(k === '製作' ? SUMMARY_BLUE_DARK : k === '付帯業務' ? SUMMARY_BLUE_LIGHT : SUMMARY_GRAY).setFontSize(10);
    sheet.getRange(row, 6).setValue(fmtH(min) + 'h').setHorizontalAlignment('right');
    sheet.getRange(row, 7).setValue(share + '%').setFontSize(9).setFontColor('#78909C').setHorizontalAlignment('right');
    sheet.getRange(row, 8).setValue(deltaStr(fmtH(min), fmtH(clsPrev.get(k) || 0), 'h')).setFontSize(8).setFontColor('#90A4AE');
    row++;
  });
  noteRow(row, '※ 製作＝型紙・仮制作・本制作など、付帯業務＝原価表・工程表・引き継ぎ・ミーティングなど（設定タブの中分類管理で変更可）。「中分類未入力」は日報で中分類が選ばれていない時間です');
  row += 2;

  // ---- 📈 案件別工数 TOP10 -----------------------------------------
  sectionHeader(row, '📈 案件別工数 TOP10（月内・' + category + '）'); row++;
  const top = [...prodMonth.entries()].sort((a, b) => b[1].min - a[1].min).slice(0, 10);
  if (top.length === 0) { noteRow(row, '該当月の' + category + 'の日報がありません'); row++; }
  const topMax = top.length ? top[0][1].min : 0;
  top.forEach(([p, e], i) => {
    sheet.getRange(row, 1, 1, 3).merge().setValue(nameOf(p)).setFontSize(10);
    sheet.getRange(row, 4, 1, 3).merge().setValue(barTx(e.min, topMax, 24)).setFontColor(rankColor(i, top.length)).setFontSize(10);
    sheet.getRange(row, 7).setValue(fmtH(e.min) + 'h').setHorizontalAlignment('right')
      .setFontWeight(i < Math.ceil(top.length * 0.2) ? 'bold' : 'normal');
    row++;
  });
  noteRow(row, '※ 濃い青＝工数上位20％、薄い青＝上位20〜40％。工数の大小は事実の共有であり、良し悪しの評価ではありません');
  row += 2;

  // ---- 🛠 工程別の時間配分 -----------------------------------------
  sectionHeader(row, '🛠 工程別の時間配分（月内）'); row++;
  const phaseTotal = phaseRows.reduce((a, e) => a + e.min, 0);
  const phaseMax   = phaseRows.reduce((a, e) => Math.max(a, e.min), 0);
  if (phaseRows.length === 0) { noteRow(row, '該当月のデータがありません'); row++; }
  phaseRows.forEach(e => {
    const share = phaseTotal > 0 ? Math.round(e.min / phaseTotal * 100) : 0;
    sheet.getRange(row, 1).setValue(e.name).setFontSize(10);
    sheet.getRange(row, 4, 1, 3).merge().setValue(barTx(e.min, phaseMax, 24)).setFontColor(SUMMARY_BLUE_DARK).setFontSize(10);
    sheet.getRange(row, 7).setValue(fmtH(e.min) + 'h').setHorizontalAlignment('right');
    sheet.getRange(row, 8).setValue(share + '%').setFontSize(9).setFontColor('#78909C').setHorizontalAlignment('right');
    row++;
  });
  row++;

  // ---- 👥 担当者別稼働状況 -----------------------------------------
  sectionHeader(row, '👥 担当者別稼働状況（' + category + '・体制の共有が目的。効率や生産性の比較ではありません）'); row++;
  sheet.getRange(row, 1, 1, 4).setValues([['担当者', category + '工数(h)', '担当案件数', '1案件平均(h)']])
    .setFontSize(9).setFontColor('#78909C');
  row++;
  const workers = [...workerMap.entries()].sort((a, b) => b[1].min - a[1].min);
  const wMax = workers.length ? workers[0][1].min : 0;
  workers.forEach(([w, e]) => {
    sheet.getRange(row, 1).setValue(w).setFontSize(10);
    sheet.getRange(row, 2).setValue(fmtH(e.min)).setHorizontalAlignment('right');
    sheet.getRange(row, 3).setValue(e.products.size).setHorizontalAlignment('right');
    sheet.getRange(row, 4).setValue(e.products.size > 0 ? +(fmtH(e.min) / e.products.size).toFixed(1) : '').setHorizontalAlignment('right');
    sheet.getRange(row, 5, 1, 4).merge().setValue(barTx(e.min, wMax, 20)).setFontColor(SUMMARY_BLUE_LIGHT).setFontSize(10);
    row++;
  });
  row++;

  // ---- 📋 案件一覧 --------------------------------------------------
  sectionHeader(row, '📋 案件一覧（月内に日報のあった' + category + '案件）'); row++;
  sheet.getRange(row, 1, 1, 2).merge().setValue('企画｜製品').setFontSize(9).setFontColor('#78909C');
  sheet.getRange(row, 3).setValue('今月(h)').setFontSize(9).setFontColor('#78909C');
  sheet.getRange(row, 4).setValue('累計(h)').setFontSize(9).setFontColor('#78909C');
  sheet.getRange(row, 5).setValue('現在工程').setFontSize(9).setFontColor('#78909C');
  sheet.getRange(row, 6, 1, 3).merge().setValue('担当者（月内）').setFontSize(9).setFontColor('#78909C');
  row++;
  const list = [...prodMonth.entries()].sort((a, b) => b[1].min - a[1].min);
  list.forEach(([p, e], i) => {
    if (i < Math.ceil(list.length * 0.2)) sheet.getRange(row, 1, 1, SUMMARY_COLS).setBackground('#E3F2FD');
    sheet.getRange(row, 1, 1, 2).merge().setValue(nameOf(p)).setFontSize(10);
    sheet.getRange(row, 3).setValue(fmtH(e.min)).setHorizontalAlignment('right');
    sheet.getRange(row, 4).setValue(fmtH(prodAllMin.get(p) || 0)).setHorizontalAlignment('right');
    sheet.getRange(row, 5).setValue(prodLastLog.has(p) ? prodLastLog.get(p).phase : '').setFontSize(9);
    sheet.getRange(row, 6, 1, 3).merge().setValue([...e.workers].join('、')).setFontSize(9);
    row++;
  });
  noteRow(row, '※ 濃色の行＝今月工数の上位20％。現在工程は直近の日報のフェーズです');
  row += 2;

  // ---- 💬 今月のトピック（手入力欄）--------------------------------
  sectionHeader(row, '💬 今月のトピック（手入力欄）'); row++;
  const topicCell = sheet.getRange(row, 1, 4, SUMMARY_COLS).merge()
    .setBackground('#FFFDE7').setVerticalAlignment('top').setWrap(true).setFontSize(10);
  if (savedTopic) {
    topicCell.setValue(savedTopic);
  } else {
    topicCell.setValue('（数字だけでは伝わらない背景をここにメモ。例：新メンズラインが本格始動／撮影用オブジェ制作／型修正案件が増加。同じ月の再生成では消えません）')
      .setFontColor('#B0A660').setFontStyle('italic');
  }

  // ---- 仕上げ -------------------------------------------------------
  sheet.setColumnWidth(1, 210);
  sheet.setColumnWidths(2, SUMMARY_COLS - 1, 100);
  reportSS.setActiveSheet(sheet);
  reportSS.moveActiveSheet(opts.position + 1);
  Logger.log(opts.sheetName + ' 更新完了（' + label + '）');
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

  const logRows      = getSheetData(REPORT_CONFIG.logSSId,      REPORT_CONFIG.logSheetName,       18);
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

  Logger.log('バックフィル完了: ' + count + '週分 → ' + reportSS.getUrl());
}

// ================================================================
// シートの順番を並べ替える（1回のみ実行）
// ================================================================
function reorderSheets() {
  const ss = getOrCreateReportSS();
  const order = ['⓪日報サマリー', '⓪販促サマリー', '①週次推移', '②職人別週次', '③月別推移', '④職人別月次', '⑤ブランド別', '⑥企画別', '⑦製品別', '⑧製品×職人別'];
  order.forEach((name, i) => {
    const sheet = ss.getSheetByName(name);
    if (sheet) { ss.setActiveSheet(sheet); ss.moveActiveSheet(i + 1); }
  });
  Logger.log('シート並び替え完了');
}


// ================================================================
// undefined行クリーンアップ（引数なし誤実行で生じた不正行を削除）
// ================================================================
function cleanupUndefinedRows() {
  const reportSS = getOrCreateReportSS();
  const targets = ['③月別推移', '⑤ブランド別', '⑥企画別', '⑦製品別', '⑧製品×職人別', '④職人別月次'];
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

// 2026年05月の月次を④だけ再生成するラッパー（④が空の場合に1回だけ実行）
function run202605() { generateMonthlyReportForMonth(2026, 5); }

// ⑧製品×職人別を単月だけ試し生成するラッパー
function runProductWorker202605() {
  const logRows      = getSheetData(REPORT_CONFIG.logSSId,      REPORT_CONFIG.logSheetName,       19);
  const scheduleRows = getSheetData(REPORT_CONFIG.scheduleSSId, REPORT_CONFIG.scheduleSheetName,  13, 6);
  const reportSS     = getOrCreateReportSS();
  const startDate    = new Date(2026, 4,  1,  0,  0,  0,   0);
  const endDate      = new Date(2026, 5,  0, 23, 59, 59, 999);
  appendToProductWorkerReport(reportSS, logRows, scheduleRows, startDate, endDate, '2026年05月');
}

function run202606() { generateMonthlyReportForMonth(2026, 6); }

// 7月分を月の途中で先取り集計する場合に実行（注意：実行すると8/1の自動実行は
// 「2026年07月は既存」としてスキップされるため、月末に③〜⑧の2026年07月の行を
// 削除してから run202607() を再実行して確定させること）
function run202607() { generateMonthlyReportForMonth(2026, 7); }

function runProductWorker202606() {
  const logRows      = getSheetData(REPORT_CONFIG.logSSId,      REPORT_CONFIG.logSheetName,       19);
  const scheduleRows = getSheetData(REPORT_CONFIG.scheduleSSId, REPORT_CONFIG.scheduleSheetName,  13, 6);
  const reportSS     = getOrCreateReportSS();
  const startDate    = new Date(2026, 5,  1,  0,  0,  0,   0);
  const endDate      = new Date(2026, 6,  0, 23, 59, 59, 999);
  appendToProductWorkerReport(reportSS, logRows, scheduleRows, startDate, endDate, '2026年06月');
}

// ================================================================
// トリガー設定
// ================================================================
function setupWeeklyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'generateWeeklyReport')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('generateWeeklyReport')
    .timeBased().onWeekDay(ScriptApp.WeekDay.THURSDAY).atHour(8).create();
  Logger.log('週次トリガー設定完了: 毎週木曜 8:00');
}

function setupMonthlyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'generateMonthlyReport')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('generateMonthlyReport')
    .timeBased().onMonthDay(1).atHour(8).create();
  Logger.log('月次トリガー設定完了: 毎月1日 8:00');
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
  // ID直指定が最優先（名前変更・同名ファイルの影響を受けない）
  if (REPORT_CONFIG.reportSSId) return SpreadsheetApp.openById(REPORT_CONFIG.reportSSId);

  // 予備：名前検索。スクリプトプロジェクトも同名のことがあるため、スプレッドシートのみを対象にする
  const files = DriveApp.getFilesByName(REPORT_CONFIG.reportSSName);
  while (files.hasNext()) {
    const f = files.next();
    if (f.getMimeType() === MimeType.GOOGLE_SHEETS) return SpreadsheetApp.open(f);
  }
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

  const logRows      = getSheetData(REPORT_CONFIG.logSSId,      REPORT_CONFIG.logSheetName,       18);
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
  const logRows      = getSheetData(REPORT_CONFIG.logSSId,      REPORT_CONFIG.logSheetName,      18);
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
  addText('【労務費とは】作業時間(分) × 42円（間接費込み概算）で算出した人件費の概算額です。日報提出時に自動計算されてログに保存されます。');
  addText('【人工とは】「何人が何日関わったか」を表す単位。1人が1日出勤して日報を提出すれば1人工。工数(h)は時間の量、人工は頭数×日数を表すため、両方をセットで見るとリソース配分をより正確に把握できます。');
  body.appendParagraph('');

  // ⓪ 日報サマリー
  addHeading('⓪ 日報サマリー（濃青タブ）／⓪ 販促サマリー（橙タブ）', H2);
  addText('試作課が「何に・どれくらい時間を使い・今どんな状況か」を誰でも数分で理解できるようにする共有用ダッシュボード。製品開発は「⓪日報サマリー」、販促物（ショート動画・撮影用制作など）は「⓪販促サマリー」に分けて表示する。毎月1日の自動実行で前月分に更新される（runSummary2026XX() で2枚とも手動更新可能。上書き型なので月の途中でも安全）。');
  addTable([
    ['セクション', '内容'],
    ['📦 今月の活動', '対象区分の工数・労務費・稼働案件数・担当人数＋参考として課全体総工数・間接のKPIカード（前月比付き）'],
    ['🔧 工数の内訳（製作／付帯業務）', '中分類の「分類」（設定タブで変更可）に基づき、製作（型紙・仮制作・本制作など）と付帯業務（原価表・工程表・引き継ぎ・ミーティングなど）の時間配分を表示。中分類が選ばれていない時間は「中分類未入力」'],
    ['📈 案件別工数 TOP10', '月内工数の横棒ランキング。濃い青=上位20%、薄い青=20〜40%（評価ではなく事実の共有）'],
    ['🛠 工程別の時間配分', 'モック/1st/2nd/3rd以降/最終/色増し/その他の時間配分と構成比'],
    ['👥 担当者別稼働状況', '体制の共有が目的。効率・生産性の比較には使わない'],
    ['📋 案件一覧', '月内に日報のあった案件の今月/累計工数・現在工程・担当者'],
    ['💬 今月のトピック', '手入力欄。数字だけでは伝わらない背景をメモ（同じ月の再生成では消えない）'],
  ]);
  addItalic('表現ルール：標準工数が未設定のため「超過」「異常」と断定せず、「工数上位」「工数が大きかった案件」など中立的な表現と青の濃淡を使う。赤は未入力・データ不整合など客観的な異常のみ。');

  // ① 週次推移
  addHeading('① 週次推移（青タブ）', H2);
  addText('試作課全体の1週間まとめ。実働時間・製造比率・労務費が1行/週で蓄積される。');
  addTable([
    ['見るポイント', '活用例'],
    ['実稼働人工', '実際に日報を提出した職人×日のユニーク組み合わせ数。フル人工との差が欠勤・休暇分'],
    ['稼働日数', '集計期間内に日報が提出された日数'],
    ['フル人工', '集計期間内の営業日数（土日除く）× 稼働人数。フル稼働した場合の最大人工数'],
    ['稼働人数', '期間内に1件でも日報を提出した職人の人数'],
    ['実働(h)・製造(h)・間接(h)', '試作課全体の実働・製造・間接の時間内訳'],
    ['製造比率(%)', '70%以上：緑、50%以上：橙、50%未満：赤で色分け。低い週は間接業務が多かった週'],
    ['製品数', '期間内に登場したユニークな製品の数（サンプル製造のみ）'],
    ['労務費(円)', '作業時間(分) × 42円の合計。月次予算との比較に使える'],
  ]);

  // ② 職人別週次
  addHeading('② 職人別週次（水色タブ）', H2);
  addText('①の内訳版。誰が何時間働いて、どれだけ製造に使ったかがわかる。週ごとに白・薄青で色分けされている。');
  addTable([
    ['見るポイント', '活用例'],
    ['製造比率の差', '職人間で製造比率に大きな差がある週は業務分担を見直すヒントになる'],
    ['稼働日数', '有休・欠勤の把握'],
  ]);

  // ③ 月別推移
  addHeading('③ 月別推移（黄タブ）', H2);
  addText('試作課全体の月まとめ（1行/月で蓄積）。上長向け月次報告の数字がそのまま読み取れる。');
  addTable([
    ['見るポイント', '活用例'],
    ['平均製品工数(h)', '1製品あたりの平均作業時間。増えていれば案件難易度が上がっているか手戻りが多いサイン。減っていればスキルアップや仕様の安定化が起きている証拠'],
    ['企画数', '処理した企画数の推移で試作課のキャパ感を把握'],
  ]);

  // ④ 職人別月次
  addHeading('④ 職人別月次（青緑タブ）', H2);
  addText('職人ごとの月まとめ（1行/職人×月）。②職人別週次の月次集計版。月次報告での職人別実績に使える。');
  addTable([
    ['見るポイント', '活用例'],
    ['稼働日数・実働(h)', '職人ごとの月間稼働量を把握。欠勤・有休が多い月の確認'],
    ['製造比率(%)', '職人ごとに製造vs間接の比率を月単位で比較'],
    ['労務費(円)', '職人ごとの月間人件費（作業時間(分) × 42円）'],
  ]);

  // ⑤ ブランド別
  addHeading('⑤ ブランド別（薄黄タブ）', H2);
  addText('ブランドごとに何時間・いくら使ったか（月次追記）。上長への「対事業リソース報告」に直接使えるシート。');
  addTable([
    ['見るポイント', '活用例'],
    ['月内工数(h) vs 累計工数(h)', '今月特定ブランドに集中していないか確認。工数(h)は時間量を表す'],
    ['月内_製品(h)・月内_販促(h)', '製品開発と販促物（ショート動画等）の工数内訳。労務費の配賦先を分ける判断に使う'],
    ['担当者（全期間）', '全期間を通してそのブランドに携わった職人が一覧できる'],
  ]);
  addItalic('工数(h)はそのブランドに費やした時間の合計。人工は「何人が何日関わったか」の頭数。両方をセットで見ることでリソース配分をより正確に把握できます。');

  // ⑥ 企画別
  addHeading('⑥ 企画別（紫タブ）', H2);
  addText('企画単位で誰がいつ何時間使ったか（月次追記）。フェーズ大分類・中分類（型紙/仮制作/本制作/原価表/工程表）の両方の内訳列あり。');
  addText('対象フェーズ：モック、ファースト、セカンド、サード、フォース、フィフス、最終、色増し、サンプル、商用、SOP、自由、量産');
  addTable([
    ['見るポイント', '活用例'],
    ['累計_ファースト', 'ファーストが短い企画は仕様が固まっていた証拠。モックとファーストを比べることで設計精度がわかる'],
    ['累計_モック〜最終', 'フェーズが進むごとに工数が減っているか確認。増えていれば手戻りや仕様変更のサイン'],
    ['累計_型紙・抜き型', '型紙作成に費やした累計時間。企画間・フェーズ間で比較可能'],
    ['累計_仮制作', '部分修正・部分サンプルにかかった累計時間'],
    ['月内_中分類各列', '今月どの作業種別に時間を使ったか'],
    ['作業日数', '試作開始から完了までの実稼働日数'],
  ]);
  addItalic('「この企画、なぜ時間がかかったか」の分析起点になるシート。型紙作成 vs 仮制作の比率を企画間で比べることで、工程ごとのボトルネックが見える。');
  addItalic('【記入ルール】裁断は各サンプルフェーズ（モック・ファーストなど）の開始時に行う作業です。裁断の時間は別フェーズとして記録せず、そのサンプルフェーズの作業時間に含めて入力してください。');
  body.appendParagraph('');

  // ⑦ 製品別
  addHeading('⑦ 製品別（青緑タブ）', H2);
  addText('製品ごとにチーム合計で何時間・どのフェーズに使ったか（月次追記）。1行 = 製品1件 × 1ヶ月。⑥企画別より細かく、⑧製品×職人別を職人でまとめた粒度。');
  addTable([
    ['見るポイント', '活用例'],
    ['区分', '「製品」か「販促」か。販促物の工数を除外して製品開発の実力値を見る'],
    ['月内_各フェーズ列', '製品ごとに今月どのフェーズに時間を使ったかが見える'],
    ['担当人数・担当者（累計）', 'その製品に関わった人数と顔ぶれ'],
  ]);

  // ⑧ 製品×職人別
  addHeading('⑧ 製品×職人別（橙タブ）', H2);
  addText('製品×職人の組み合わせで工数を集計（月次追記）。1行 = 製品1件 × 職人1人 × 1ヶ月。フェーズ大分類別の月内・累計内訳あり。');
  addTable([
    ['見るポイント', '活用例'],
    ['製品名でフィルタ', '「この製品に誰が何時間かけたか・どのフェーズが多かったか」が一覧できる'],
    ['職人名でフィルタ', '「この職人は今月どの製品のどのフェーズを担当したか」がわかる'],
    ['企画名でフィルタ', '「この企画の製品群に誰が関わったか」が一覧できる'],
    ['月内_各フェーズ列', '製品×職人ごとに今月どのフェーズに時間を使ったかが見える'],
  ]);

  // 今後の活用
  addHeading('今後の活用（データが3ヶ月以上蓄積されてから）', H2);
  addTable([
    ['やりたいこと', '使うシート', '方法'],
    ['フェーズが進むごとに工数が減っているか確認', '⑥企画別', '同一企画の累計_モック/ファースト/セカンド列を比較'],
    ['特定ブランドへの年間リソース配分', '⑤ブランド別', 'ブランド名でフィルタして累計工数を縦に追う'],
    ['月ごとの繁忙期・閑散期の把握', '③月別推移', '稼働日数・製造(h)の推移をグラフ化'],
    ['職人ごとの月間稼働推移', '④職人別月次', '職人名でフィルタして実働・製造比率を縦に追う'],
  ]);

  // 日報入力ミスの影響と調べ方
  addHeading('日報入力ミスの影響と調べ方', H2);
  addHeading('よくある入力ミスとその影響', H3);
  addTable([
    ['入力ミス', '影響するシート', '具体的な症状'],
    ['製品名の表記ゆれ（スペース・全角半角など）', '⑤⑥', 'その製品の工数が「未紐付け」に入る'],
    ['種別（サンプル製造/その他）の選び間違い', '①②③④', '製造比率が実態と合わなくなる'],
    ['フェーズの入力ミス', '⑥', 'フェーズ別累計の数字が実態と合わなくなる'],
    ['作業時間の入力ミス（分単位）', '全シート', '工数・労務費がすべてズレる'],
    ['企画名が空欄', '⑥', 'その企画への工数が集計されない'],
    ['職人名の表記ゆれ', '②④', '同一人物が別人として2行で集計される'],
    ['製品/販促区分の設定ミス（製品管理）', '⑤⑥⑦⑧', '製品/販促の内訳が実態と合わなくなる'],
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
  addText('2. 集計レポートSSの該当月シート（③④⑤⑥）の該当月行を削除する');
  addText('3. GASエディタで該当月のラッパー関数（例：run202606()）を実行して再集計する');

  // 製品リストの自動クリーンアップ
  addHeading('製品リストの自動クリーンアップ', H2);
  addText('日報アプリの製品リスト（設定 → 製品管理）は、毎週木曜の自動実行時にスケジュールSSと突合し、完了した製品を自動で削除します。');
  addTable([
    ['項目', '内容'],
    ['実行タイミング', '毎週木曜 朝8時（週次レポートと同時）'],
    ['削除条件', 'スケジュールSSのステータス（M列）が全行「完了」または「中断」の製品'],
    ['削除されない場合', 'ステータスが1行でも「試作中」「予定」など進行中のものがある / スケジュールSSに製品名の登録がない'],
    ['手動で今すぐ実行', 'GASエディタで archiveCompletedSchedules() を実行'],
  ]);
  addHeading('製品が削除されない時の確認ポイント', H3);
  addTable([
    ['確認事項', '対処'],
    ['アプリの製品名とスケジュールSSのD列（サンプル製品名称）が一致しているか', 'debugUnmatched() を実行して表記ゆれを確認・修正'],
    ['スケジュールSSのステータス（M列）が正しく「完了」になっているか', 'スケジュールSSを直接開いて確認'],
    ['同じ製品名で「完了」以外の行が残っていないか', 'スケジュールSSでその製品名を検索して全行のステータスを確認'],
  ]);

  // 各シートの列定義と計算式
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
    ['労務費(円)', '作業時間(分) × 42円（間接費込み概算）。提出時に自動計算してログに保存済み'],
    ['人工', '職人×日付のユニーク組み合わせ数。1人が1日日報を提出すれば1人工'],
    ['突合', '日報の製品名とスケジュールSSの製品名・企画名を照合すること'],
    ['製品/販促区分', '製品マスタ（設定→製品管理）で選択した区分。日報提出時にログへ記録。区分が空の過去ログは現在の製品マスタから補完し、不明なものは「製品」扱い'],
  ]);

  addHeading('① 週次推移', H3);
  addText('集計期間：毎週木曜の自動実行日から7日前〜前日（例：6/12実行 → 6/5〜6/11）');
  addTable([
    ['列名', '計算内容'],
    ['集計開始', '集計期間の開始日'],
    ['集計終了', '集計期間の終了日'],
    ['実稼働人工', '実際に日報を提出した職人×日のユニーク組み合わせ数'],
    ['稼働日数', '期間内に誰かが日報を提出した日数（ユニーク日付の数）'],
    ['フル人工', '集計期間内の営業日数（土日除く）× 稼働人数。フル稼働した場合の最大人工数'],
    ['稼働人数', '期間内に1件でも日報を提出した職人の人数'],
    ['実働(h)', '全職人の実働(分)合計 ÷ 60（職人×日付で重複排除済み）'],
    ['製造(h)', '全製造作業の作業時間(分)合計 ÷ 60'],
    ['間接(h)', '全間接作業の作業時間(分)合計 ÷ 60'],
    ['製造比率(%)', '製造(分) ÷ 実働(分) × 100（四捨五入）※70%以上：緑、50%以上：橙、50%未満：赤'],
    ['製品数', '期間内に登場したユニークな製品名の数（サンプル製造のみ）'],
    ['労務費(円)', '期間内の全行の労務費合計（作業時間(分) × 42円）'],
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

  addHeading('③ 月別推移', H3);
  addText('対象月の1日〜末日を集計（①の月次版）。');
  addTable([
    ['列名', '計算内容'],
    ['年月', '例：「2026年05月」'],
    ['実稼働人工', '月内に日報を提出したユニーク職人×日の組み合わせ数'],
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

  addHeading('④ 職人別月次', H3);
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

  addHeading('⑤ ブランド別', H3);
  addText('月次追記。月内に動きがあったブランドのみ追記（当月に1件も日報がないブランドは出ない）。');
  addTable([
    ['列名', '計算内容'],
    ['年月', '例：「2026年05月」'],
    ['ブランド', 'スケジュールSSのブランド名'],
    ['企画数', 'そのブランドに紐づく企画数（累計・全期間のユニーク企画名数）'],
    ['製品数', 'そのブランドに紐づく製品数（累計・全期間のユニーク製品名数）'],
    ['月内工数(h)', '当月のそのブランドへの作業時間(分)合計 ÷ 60'],
    ['月内_製品(h)・月内_販促(h)', '月内工数(h)の製品/販促区分別の内訳（0の場合は空欄）'],
    ['月内労務費(円)', '当月の労務費合計'],
    ['累計工数(h)', '全期間のそのブランドへの作業時間(分)合計 ÷ 60'],
    ['累計_製品(h)・累計_販促(h)', '累計工数(h)の製品/販促区分別の内訳（0の場合は空欄）'],
    ['累計労務費(円)', '全期間の労務費合計'],
    ['担当者（全期間）', '全期間を通してそのブランドに関わった職人名（「、」区切り）'],
  ]);

  addHeading('⑥ 企画別', H3);
  addText('月次追記。月内に動きがあった企画のみ追記。A列（ステータス）は非表示。');
  addText('対象フェーズ：モック、ファースト、セカンド、サード、フォース、フィフス、最終、色増し、サンプル、商用、SOP、自由、量産');
  addTable([
    ['列名', '計算内容'],
    ['ステータス', 'スケジュールSSのステータス（A列・非表示）'],
    ['年月', '例：「2026年05月」'],
    ['企画名', '企画名（スケジュールSSから取得、なければ製品名）'],
    ['ブランド', 'スケジュールSSから逆引き'],
    ['製品名', 'その企画に紐づいた全製品名（「、」区切り、全期間）'],
    ['月内工数(h)', '当月の作業時間(分)合計 ÷ 60'],
    ['月内_製品(h)・月内_販促(h)', '月内工数(h)の製品/販促区分別の内訳（0の場合は空欄）'],
    ['月内労務費(円)', '当月の労務費合計'],
    ['累計工数(h)', '全期間の作業時間(分)合計 ÷ 60'],
    ['累計_製品(h)・累計_販促(h)', '累計工数(h)の製品/販促区分別の内訳（0の場合は空欄）'],
    ['累計労務費(円)', '全期間の労務費合計'],
    ['担当者（月内）', '当月に関わった職人名'],
    ['担当者（累計）', '全期間に関わった職人名'],
    ['実作業開始', '全期間で最も古い日報の日付'],
    ['実作業最終', '全期間で最も新しい日報の日付'],
    ['作業日数', '実作業最終 − 実作業開始 + 1（カレンダー日数）'],
    ['計画開始', 'スケジュールSSの試作開始日'],
    ['計画完了', 'スケジュールSSの試作完了日'],
    ['月内_各フェーズ(h)', '当月・フェーズ大分類別の作業時間(分)合計 ÷ 60（モック〜量産の全フェーズ列）'],
    ['月内_型紙・抜き型(h)', '当月・中分類＝型紙作成・修正／抜き型作成（旧名称含む）の作業時間(分)合計 ÷ 60'],
    ['月内_仮制作〜工程表(h)', '同上（仮制作 / 本制作 / 原価表 / 工程表）各中分類列'],
    ['累計_各フェーズ(h)', '全期間版のフェーズ大分類内訳（全フェーズ列）'],
    ['累計_型紙・抜き型〜工程表(h)', '全期間版のフェーズ中分類内訳（5列）。企画間比較の主役'],
  ]);

  addHeading('⑦ 製品別', H3);
  addText('月次追記。製品ごとに1行（チーム合計）。当月に動きがあった製品のみ追記。');
  addTable([
    ['列名', '計算内容'],
    ['年月', '例：「2026年05月」'],
    ['企画名', 'スケジュールSSから製品名で逆引き（なければ日報の企画名）'],
    ['ブランド', 'スケジュールSSから逆引き'],
    ['製品名', '日報に記入された製品名'],
    ['区分', '「製品」または「販促」。日報ログの区分（空欄は製品マスタから補完、不明は「製品」）'],
    ['担当人数・担当者（累計）', '全期間でその製品に関わった職人の人数と名前'],
    ['月内工数(h)・月内労務費(円)', '当月のその製品への作業時間(分)合計 ÷ 60 と労務費合計'],
    ['累計工数(h)・累計労務費(円)', '全期間版'],
    ['月内_各フェーズ(h)・累計_各フェーズ(h)', 'フェーズ大分類別の作業時間内訳 ÷ 60'],
  ]);

  addHeading('⑧ 製品×職人別', H3);
  addText('月次追記。製品×職人の組み合わせで1行。当月に動きがあったもののみ追記。');
  addTable([
    ['列名', '計算内容'],
    ['年月', '例：「2026年05月」'],
    ['企画名', 'スケジュールSSから製品名で逆引き'],
    ['製品名', '日報に記入された製品名'],
    ['区分', '「製品」または「販促」。⑦と同じルールで判定'],
    ['職人名', '日報に記入された職人名'],
    ['月内工数(h)', '当月のその製品×職人の作業時間(分)合計 ÷ 60'],
    ['月内労務費(円)', '当月の労務費合計'],
    ['累計工数(h)', '全期間のその製品×職人の作業時間(分)合計 ÷ 60'],
    ['累計労務費(円)', '全期間の労務費合計'],
    ['月内_各フェーズ(h)', '当月・フェーズ大分類別の作業時間(分)合計 ÷ 60（全フェーズ列）'],
    ['累計_各フェーズ(h)', '全期間・フェーズ大分類別の作業時間(分)合計 ÷ 60（全フェーズ列）'],
  ]);

  doc.saveAndClose();
  Logger.log('✓ ガイドドキュメント作成完了: ' + doc.getUrl());
}
