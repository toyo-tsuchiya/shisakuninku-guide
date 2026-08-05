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
  summarySSId:      '1m0f4PMYSjOGb9SmTQpcRHI2U_ACjGlY-iYrbnJSw5Co',  // サマリー専用SS（ID直指定。名前変更の影響を受けない）
  summarySSName:    '試作課：日報サマリー',
};

// 未入力リマインドの営業日判定で除外する休業日
const JP_HOLIDAY_CALENDAR_ID = 'ja.japanese#holiday@group.v.calendar.google.com';
const HOLIDAY_SHEET_NAME     = '休日';  // 日報集計SS内。年末年始など会社独自の休業日をA列に並べる

// 日報ログの列インデックス（0始まり）
// 2026-08-05: B列に「製番」列を新設（Code.gs側で自動移動）→旧B〜S列が1列分右へ
const L = {
  seiban:    1,  // B: 製番
  date:      2,  // C: 日付
  worker:    3,  // D: 職人名
  actualMin: 7,  // H: 実働(分)
  type:      8,  // I: 種別
  product:   9,  // J: 製品名
  phase:     10, // K: フェーズ大分類
  workType:  11, // L: 作業種別
  workMin:   12, // M: 作業時間(分)
  laborCost: 14, // O: 労務費(円)
  planName:  17, // R: 企画名
  subcat:    18, // S: フェーズ中分類
  category:  19, // T: 製品or販促
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

// フェーズ大分類のうち「中分類あり」の8段階（中分類対象外の判定にも使う）
// ステージマスター（Code.gsのSHEETS.STAGES）で中分類あり=trueのものと一致
const DETAIL_PHASE_KEYS = ['モック', '1st', '2nd', '3rd', '4th', '5th', '最終', '色増しサンプル'];

// ⑦製品別・⑧製品×職人別のフェーズ内訳列（8段階＋SOP等の重要業務。エイジングサンプルは「その他」扱い）
const PRODUCT_PHASE_KEYS = [...DETAIL_PHASE_KEYS, '試験体', '修理', 'SOP', '治具'];

// スケジュールSSの列インデックス（0始まり）
// 2026-07-17: A列に「製番」列を新設 →旧B〜M列が1列分右へ
// 2026-07-21: 実シート確認の結果、D列に「製品or販促」列も新設されていたため、
//             ブランド（C）より後ろの企画名以降はさらに1列分右へずれていた（合計2列分シフト）
const S = {
  season:       1,  // B: シーズン・型振・VMD（採番表からのプル型自動補完で使用。2026-08-03追加）
  brand:        2,  // C: ブランド
  category:     3,  // D: 製品or販促（採番表からのプル型自動補完で使用。2026-08-03追加）
  planName:     4,  // E: 企画名
  product:      5,  // F: サンプル製品名称
  phase:        8,  // I: サンプルフェーズ
  deliveryDate: 10, // K: 納品希望日
  startDate:    11, // L: 試作開始日
  endDate:      12, // M: 試作完了日
  status:       14, // O: ステータス（N列は未使用のため間が空く）
};

// ================================================================
// 週次メイン（毎週木曜 朝8時に自動実行）
// ================================================================
function generateWeeklyReport() {
  const { startDate, endDate } = getWeekRange();
  const logRows      = getSheetData(REPORT_CONFIG.logSSId,      REPORT_CONFIG.logSheetName,       20);
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
  const scheduleRows = getSheetData(REPORT_CONFIG.scheduleSSId, REPORT_CONFIG.scheduleSheetName, 15, 6);

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
  const logRows = getSheetData(REPORT_CONFIG.logSSId, REPORT_CONFIG.logSheetName, 20);
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
  const scheduleRows = getSheetData(REPORT_CONFIG.scheduleSSId, REPORT_CONFIG.scheduleSheetName, 15, 6);

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

// ログ1行の時間分類を返す：製作／付帯業務／中分類未選択／中分類対象外
// ・中分類対象外 … 大分類に中分類の選択肢がないフェーズ（試験体・量産・エイジングサンプル・修理・SOP・治具）
// ・中分類未選択 … 中分類を選べるフェーズで空欄だった時間（2026-06-17の機能追加以前の日報を含む）
function logSubcatClass_(r, clsMap) {
  const sc = String(r[L.subcat] || '').trim();
  if (sc) return clsMap.get(sc) || '中分類未選択';
  const phase = String(r[L.phase] || '').trim();
  return DETAIL_PHASE_KEYS.includes(phase) ? '中分類未選択' : '中分類対象外';
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

  const logRows      = getSheetData(REPORT_CONFIG.logSSId,      REPORT_CONFIG.logSheetName,       20);
  const scheduleRows = getSheetData(REPORT_CONFIG.scheduleSSId, REPORT_CONFIG.scheduleSheetName, 15, 6);
  const reportSS     = getOrCreateReportSS();

  appendToMonthlyTrend(reportSS, logRows, startDate, endDate, label);
  appendToBrandReport(reportSS, logRows, scheduleRows, startDate, endDate, label);
  appendToProjectReport(reportSS, logRows, scheduleRows, startDate, endDate, label);
  appendToProductReport(reportSS, logRows, scheduleRows, startDate, endDate, label);
  appendToProductWorkerReport(reportSS, logRows, scheduleRows, startDate, endDate, label);
  appendToWorkerMonthly(reportSS, logRows, startDate, endDate, label);
  buildAllSummarySheets(logRows, scheduleRows, year, month);

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
  const PHASE_KEYS = PRODUCT_PHASE_KEYS;
  const HEADERS = [
    '年月', '企画名', 'ブランド', '製品名', '区分', '担当人数', '担当者（累計）',
    '月内工数(h)', '月内労務費(円)', '累計工数(h)', '累計労務費(円)',
    ...PHASE_KEYS.map(p => '月内_' + p + '(h)'), '月内_その他(h)',
    ...PHASE_KEYS.map(p => '累計_' + p + '(h)'), '累計_その他(h)',
  ];
  const sheet = getOrInitSheet(reportSS, '⑦製品別', HEADERS, '#26A69A');

  // 列構成が変わった場合：既存データ行があると列がずれるため追記を中止（タブ削除→再生成が必要）
  if (sheet.getLastColumn() < HEADERS.length) {
    if (sheet.getLastRow() > 1) {
      Logger.log('⑦製品別: フェーズ列の構成が変わりました。タブを削除してから run202605() 等で各月を再生成してください（追記を中止）');
      return;
    }
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
  const PHASE_KEYS = PRODUCT_PHASE_KEYS;
  const HEADERS = [
    '年月', '企画名', '製品名', '区分', '職人名',
    '月内工数(h)', '月内労務費(円)', '累計工数(h)', '累計労務費(円)',
    ...PHASE_KEYS.map(p => '月内_' + p + '(h)'), '月内_その他(h)',
    ...PHASE_KEYS.map(p => '累計_' + p + '(h)'), '累計_その他(h)',
  ];
  const sheet = getOrInitSheet(reportSS, '⑧製品×職人別', HEADERS, '#FF7043');

  // 列構成が変わった場合：既存データ行があると列がずれるため追記を中止（タブ削除→再生成が必要）
  if (sheet.getLastColumn() < HEADERS.length) {
    if (sheet.getLastRow() > 1) {
      Logger.log('⑧製品×職人別: フェーズ列の構成が変わりました。タブを削除してから run202605() 等で各月を再生成してください（追記を中止）');
      return;
    }
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
  const logRows      = getSheetData(REPORT_CONFIG.logSSId,      REPORT_CONFIG.logSheetName,       20);
  const scheduleRows = getSheetData(REPORT_CONFIG.scheduleSSId, REPORT_CONFIG.scheduleSheetName, 15, 6);
  buildAllSummarySheets(logRows, scheduleRows, year, month);
}

// 単月を手動で生成/更新するラッパー（上書き型なので何度実行してもOK。月の途中でも安全）
function runSummary202606() { generateSummarySheet(2026, 6); }
function runSummary202607() { generateSummarySheet(2026, 7); }

// 製品サマリーと販促サマリーの2枚を専用SS「試作課：日報サマリー」に生成し、
// 同じSS内に月別タブ（例:「2026年06月 製品」）としてアーカイブする。
// 集計データ（①〜⑧）はWeeklyReport側に残るため、サマリーSSは共有・閲覧専用として使える。
function buildAllSummarySheets(logRows, scheduleRows, year, month) {
  const summarySS = getOrCreateSummarySS();
  const label = year + '年' + String(month).padStart(2, '0') + '月';
  buildSummarySheet(summarySS, logRows, scheduleRows, year, month, {
    sheetName: SUMMARY_SHEET_NAME,
    category:  '製品',
    title:     '試作課 日報サマリー',
    note:      '試作課が製品開発に「何に・どれくらい時間を使い・今どんな状況か」を共有するためのシートです（評価や監視を目的としたものではありません。販促物は「⓪販促サマリー」へ）',
    tabColor:  SUMMARY_BLUE_DARK,
    position:  0,
    showIndirect: true,  // 間接業務の内訳は課全体で共通のため、メインの日報サマリーにのみ表示
  });
  buildSummarySheet(summarySS, logRows, scheduleRows, year, month, {
    sheetName: SUMMARY_PROMO_SHEET_NAME,
    category:  '販促',
    title:     '試作課 販促サマリー',
    note:      '販促物（ショート動画・撮影用制作など）に使った時間のサマリーです（評価や監視を目的としたものではありません）',
    tabColor:  '#E65100',
    position:  1,
  });

  // 新規作成時に残るデフォルトシートを削除
  ['シート1', 'Sheet1'].forEach(n => {
    const s = summarySS.getSheetByName(n);
    if (s && summarySS.getNumSheets() > 1) summarySS.deleteSheet(s);
  });

  // 月別アーカイブ（同じ月の再実行は置き換え。過去月との見比べ用）
  archiveSummarySheet_(summarySS, SUMMARY_SHEET_NAME,       label + ' 製品');
  archiveSummarySheet_(summarySS, SUMMARY_PROMO_SHEET_NAME, label + ' 販促');
}

// ライブのサマリーシートを月別タブとして複製保存する（既存の同名タブは置き換え）
function archiveSummarySheet_(ss, liveName, archiveName) {
  const live = ss.getSheetByName(liveName);
  if (!live) return;
  const old = ss.getSheetByName(archiveName);
  if (old) ss.deleteSheet(old);
  const copy = live.copyTo(ss).setName(archiveName);
  copy.setTabColor('#9E9E9E');
  ss.setActiveSheet(copy);
  ss.moveActiveSheet(ss.getNumSheets());  // 末尾（アーカイブ領域）へ
  ss.setActiveSheet(ss.getSheets()[0]);   // 開いたときはライブのサマリーが見えるように戻す
  Logger.log('アーカイブ保存: ' + archiveName);
}

// ================================================================
// サマリー専用SS取得（なければ新規作成）
// ================================================================
function getOrCreateSummarySS() {
  // ID直指定が最優先（名前変更・同名ファイルの影響を受けない）
  if (REPORT_CONFIG.summarySSId) return SpreadsheetApp.openById(REPORT_CONFIG.summarySSId);

  const files = DriveApp.getFilesByName(REPORT_CONFIG.summarySSName);
  while (files.hasNext()) {
    const f = files.next();
    if (f.getMimeType() === MimeType.GOOGLE_SHEETS) return SpreadsheetApp.open(f);
  }
  const ss = SpreadsheetApp.create(REPORT_CONFIG.summarySSName);
  Logger.log('サマリーSS新規作成: ' + ss.getUrl());
  Logger.log('※ 事故防止のため、このURLのID（/d/と/editの間の文字列）を REPORT_CONFIG.summarySSId に貼ってください');
  return ss;
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
    { name: '試験体',         keys: ['試験体'] },
    { name: '修理',           keys: ['修理'] },
    { name: 'SOP',            keys: ['SOP'] },
    { name: '治具',           keys: ['治具'] },
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
  const CLS_KEYS = ['製作', '付帯業務', '中分類未選択', '中分類対象外'];
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

  // 間接業務（その他種別）の内訳（課全体・参考。KPIカード「うち間接」の中身）
  const sumByWorkType = logs => {
    const m = new Map();
    for (const r of logs) {
      if (r[L.type] === 'サンプル製造') continue;
      const k = String(r[L.workType] || '').trim() || '（種別未入力）';
      m.set(k, (m.get(k) || 0) + (Number(r[L.workMin]) || 0));
    }
    return m;
  };
  const indCur  = sumByWorkType(monthLogs);
  const indPrev = sumByWorkType(prevLogs);

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
  noteRow(row, '※ 製作＝型紙・仮制作・本制作など、付帯業務＝原価表・工程表・引き継ぎ・ミーティングなど（設定タブの中分類管理で変更可）'); row++;
  noteRow(row, '※ 中分類対象外＝中分類の選択肢がないフェーズ（試験体・量産・エイジングサンプル・修理・SOP・治具）。中分類未選択＝中分類を選べるフェーズで選択されなかった時間（中分類機能ができた2026/6/17より前の日報を含むため、当面は多めに出ます）');
  row += 2;

  // ---- 🗂 間接業務の内訳（参考・課全体）----------------------------
  if (opts.showIndirect) {
    sectionHeader(row, '🗂 間接業務（その他）の内訳（参考・課全体）'); row++;
    const indRows  = [...indCur.entries()].sort((a, b) => b[1] - a[1]);
    const indTotal = indRows.reduce((a, e) => a + e[1], 0);
    const indMax   = indRows.length ? indRows[0][1] : 0;
    if (indRows.length === 0) { noteRow(row, '該当月の間接業務の日報がありません'); row++; }
    indRows.forEach(([k, min]) => {
      const share = indTotal > 0 ? Math.round(min / indTotal * 100) : 0;
      sheet.getRange(row, 1).setValue(k).setFontSize(10);
      sheet.getRange(row, 4, 1, 2).merge().setValue(barTx(min, indMax, 16)).setFontColor(SUMMARY_BLUE_LIGHT).setFontSize(10);
      sheet.getRange(row, 6).setValue(fmtH(min) + 'h').setHorizontalAlignment('right');
      sheet.getRange(row, 7).setValue(share + '%').setFontSize(9).setFontColor('#78909C').setHorizontalAlignment('right');
      sheet.getRange(row, 8).setValue(deltaStr(fmtH(min), fmtH(indPrev.get(k) || 0), 'h')).setFontSize(8).setFontColor('#90A4AE');
      row++;
    });
    noteRow(row, '※ 日報の「その他」種別（定例ミーティング・事務作業・棚卸しなど）の内訳。製品/販促を問わない課全体の参考値で、KPIカード「うち間接（参考）」の中身です');
    row += 2;
  }

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

  const logRows      = getSheetData(REPORT_CONFIG.logSSId,      REPORT_CONFIG.logSheetName,       19);
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
  // ⓪サマリー2枚は専用SS「試作課：日報サマリー」に移動（2026-07-16）
  const order = ['①週次推移', '②職人別週次', '③月別推移', '④職人別月次', '⑤ブランド別', '⑥企画別', '⑦製品別', '⑧製品×職人別'];
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
  const logRows      = getSheetData(REPORT_CONFIG.logSSId,      REPORT_CONFIG.logSheetName,       20);
  const scheduleRows = getSheetData(REPORT_CONFIG.scheduleSSId, REPORT_CONFIG.scheduleSheetName, 15, 6);
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

// ================================================================
// 月の途中で「該当行削除→再実行」を安全に行うためのラッパー
// ③④⑤⑥⑦⑧は月ラベルが既にあると追記をスキップする設計のため、先取り集計した後に
// 追加で入力された日報（例：SOP作業など）を反映するには、該当月の行を一度削除してから
// generateMonthlyReportForMonth を呼び直す必要がある。この関数はその手順をまとめて行う
// （⓪サマリー2枚は上書き型のため、runSummary202607() 等の単体実行でも常に最新化される）
// ================================================================
function refreshMonthlyReport(year, month) {
  const label = year + '年' + String(month).padStart(2, '0') + '月';
  const reportSS = getOrCreateReportSS();

  [
    { name: '③月別推移',     col: 1 },
    { name: '④職人別月次',   col: 1 },
    { name: '⑤ブランド別',   col: 1 },
    { name: '⑥企画別',       col: 2 },
    { name: '⑦製品別',       col: 1 },
    { name: '⑧製品×職人別', col: 1 },
  ].forEach(({ name, col }) => {
    const sheet = reportSS.getSheetByName(name);
    if (!sheet || sheet.getLastRow() < 2) return;
    const values = sheet.getRange(2, col, sheet.getLastRow() - 1, 1).getValues();
    const rowsToDelete = values
      .map((r, i) => ({ row: i + 2, val: String(r[0]) }))
      .filter(({ val }) => val === label)
      .map(({ row }) => row);
    rowsToDelete.reverse().forEach(row => sheet.deleteRow(row));
    Logger.log(name + ': ' + label + ' の行を' + rowsToDelete.length + '件削除');
  });

  generateMonthlyReportForMonth(year, month);
  Logger.log(label + ' 再集計完了（本日までのデータを反映）');
}

// 2026年07月を本日時点のデータで再集計するラッパー（③〜⑧の該当行削除→再生成→サマリー更新）
function refresh202607() { refreshMonthlyReport(2026, 7); }

// 月を指定せず「今月」を自動判定して再集計するラッパー（毎月新しいrun2026XX()を作らずに済む）
function refreshCurrentMonth() {
  const now = new Date();
  refreshMonthlyReport(now.getFullYear(), now.getMonth() + 1);
}

// 月を指定せず「今月」を自動判定してサマリーだけ更新するラッパー
function runSummaryCurrentMonth() {
  const now = new Date();
  generateSummarySheet(now.getFullYear(), now.getMonth() + 1);
}

// ================================================================
// 特定週を「該当行削除→再実行」で手動更新するための週次版refresh
// ①②は集計開始日・集計終了日が完全一致する行があると追記をスキップする設計のため、
// 遅れて入力された日報（イワブチさんの遅延まとめ入力など）を反映するには、
// 該当週の行を一度削除してから appendToWeeklyTrend/appendToWorkerWeekly を呼び直す必要がある。
// ================================================================
function refreshWeeklyReport(startDate, endDate) {
  startDate = startDate instanceof Date ? new Date(startDate) : new Date(startDate);
  endDate   = endDate   instanceof Date ? new Date(endDate)   : new Date(endDate);
  startDate.setHours(0, 0, 0, 0);
  endDate.setHours(23, 59, 59, 999);

  const reportSS = getOrCreateReportSS();
  const sk = dFmt(startDate), ek = dFmt(endDate);

  ['①週次推移', '②職人別週次'].forEach(name => {
    const sheet = reportSS.getSheetByName(name);
    if (!sheet || sheet.getLastRow() < 2) return;
    const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
    const rowsToDelete = values
      .map((r, i) => ({
        row: i + 2,
        a: r[0] instanceof Date ? dFmt(r[0]) : String(r[0]),
        b: r[1] instanceof Date ? dFmt(r[1]) : String(r[1]),
      }))
      .filter(({ a, b }) => a === sk && b === ek)
      .map(({ row }) => row);
    rowsToDelete.reverse().forEach(row => sheet.deleteRow(row));
    Logger.log(name + ': ' + sk + '〜' + ek + ' の行を' + rowsToDelete.length + '件削除');
  });

  const logRows = getSheetData(REPORT_CONFIG.logSSId, REPORT_CONFIG.logSheetName, 20);
  appendToWeeklyTrend(reportSS, logRows, startDate, endDate);
  appendToWorkerWeekly(reportSS, logRows, startDate, endDate);
  Logger.log(sk + '〜' + ek + ' 週次再集計完了（本日までのデータを反映）');
}

// 直近の自動集計週（先週分）を本日時点のデータで再集計するラッパー
function refreshLastWeek() {
  const { startDate, endDate } = getWeekRange();
  refreshWeeklyReport(startDate, endDate);
}

// ================================================================
// スプレッドシートのカスタムメニュー（このスクリプトが紐づく「WeeklyReport」を開いたときに表示。
// Code.gs/index.htmlは別プロジェクトで「試作日報：ログ取り」に紐づいており、ここには出ない。2026-07-28確認）
// GASエディタの関数プルダウンを毎回探さなくても、ここから主要な手動操作を実行できる
// ================================================================
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('📋 レポート操作')
    .addItem('先週分の週次レポートを再集計', 'menuRefreshLastWeek')
    .addItem('今月のレポートを再集計（月次③〜⑧＋サマリー）', 'menuRefreshCurrentMonth')
    .addItem('サマリーだけ更新', 'menuRunSummaryCurrentMonth')
    .addSeparator()
    .addItem('採番表を処理（新規登録の番号発行）', 'menuRunSeibanTableProcessing')
    .addItem('製番を手動同期', 'menuRunSeibanSync')
    .addItem('未突合製品を調査（結果は実行ログに出力）', 'menuDebugProductCountMismatch')
    .addItem('未入力リマインドのテスト（送信なし・結果は実行ログに出力）', 'menuDebugMissingReports')
    .addToUi();
}

function menuRefreshLastWeek()          { refreshLastWeek();          SpreadsheetApp.getUi().alert('先週分の週次レポートを再集計しました。'); }
function menuRefreshCurrentMonth()      { refreshCurrentMonth();      SpreadsheetApp.getUi().alert('今月のレポートを再集計しました。'); }
function menuRunSummaryCurrentMonth()   { runSummaryCurrentMonth();   SpreadsheetApp.getUi().alert('サマリーを更新しました。'); }
function menuRunSeibanTableProcessing() { runSeibanTableProcessing(); SpreadsheetApp.getUi().alert('採番表を処理しました。'); }
function menuRunSeibanSync()            { runSeibanSync();            SpreadsheetApp.getUi().alert('製番の同期を実行しました。'); }
function menuDebugProductCountMismatch(){ debugProductCountMismatch();SpreadsheetApp.getUi().alert('調査結果を実行ログに出力しました（Apps Scriptエディタの「実行数」から確認できます）。'); }
function menuDebugMissingReports()      { debugMissingReports();      SpreadsheetApp.getUi().alert('リマインド対象を実行ログに出力しました（メールは送信されません）。'); }

function runProductWorker202606() {
  const logRows      = getSheetData(REPORT_CONFIG.logSSId,      REPORT_CONFIG.logSheetName,       20);
  const scheduleRows = getSheetData(REPORT_CONFIG.scheduleSSId, REPORT_CONFIG.scheduleSheetName, 15, 6);
  const reportSS     = getOrCreateReportSS();
  const startDate    = new Date(2026, 5,  1,  0,  0,  0,   0);
  const endDate      = new Date(2026, 6,  0, 23, 59, 59, 999);
  appendToProductWorkerReport(reportSS, logRows, scheduleRows, startDate, endDate, '2026年06月');
}

// ================================================================
// 製番（製造番号）システム（2026-07-16定例発案・2026-08-03改訂）
//
// 目的：日報アプリの製品選択リスト（内部製品マスタ）と、嶋谷さんが管理する
// 外部スケジュール表は別物のスプレッドシートで、これまで同じ製品名を両方に
// 手入力する二重管理だった。これが表記ゆれ・未突合の原因になっていたため、
// 製品単位で一意の製番（採番表が正本）を発行し、名前ではなく製番で紐付ける。
//
// データの流れ（2026-08-03確定）：
//  ①採番表に案件を登録すると自動で試作番号を発行（自動使い回しはしない）
//  ②外部スケジュール表側で、上長が作った行のA列に試作番号を入力/選択すると、
//    採番表を参照してB〜F列を自動補完する（プル型。行の追加はシステムでは行わない）
//  ③外部スケジュール表の製番を内部製品マスタへ自動反映（10分おき、既存のまま）
//
// 粒度：外部スケジュール表は基本1行=1製品（正本）。担当者やフェーズが変わっても
// 行は増やさず、同じ行の可変列（G担当・H サンプル担当・I サンプルフェーズ・
// L/M スケジュール日程・O以降ステータス）を上長が書き換えて運用する
// （2026-08-03確定。以前の「フェーズが進むたびに新しい行を作る」想定は誤りだった）。
// 同じ番号を複数行に入力すること自体は技術的には可能（handleExternalScheduleEdit_は
// 行数を問わない）だが、通常運用としては行わない想定。
// SOP等いったん「完了」で内部製品マスタの選択肢から消えた製品が後で再開しても、
// 同じ製番で再びリンクされる。
//
// フォーマット：ブランドコード-区分(G/P)+年-連番（例: TK-G26-0001）。
// 連番は区分ごと・年ごとにリセットされる（2026-07-22確定）。
//
// 運用：
//  - syncSeibanToAppProductMaster_ … 10分おきの時間主導トリガー（setupSeibanTrigger、既存）
//  - handleExternalScheduleEdit_ … インストール型トリガー（setupExternalScheduleEditTrigger、新規）
// 初回はrunSeibanSync()を手動実行し、ログと両シートの内容を確認してから
// 各トリガーを設定すること。
// ================================================================
const SEIBAN_HEADER = '製番';

// ヘッダー行に「製番」列があればその列番号を返し、なければ末尾に追加する
// （外部スケジュール表・内部製品マスタどちらでも使う共通ヘルパー）
function getOrCreateSeibanColumn_(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const existing = headers.indexOf(SEIBAN_HEADER);
  if (existing !== -1) return existing + 1;
  const col = lastCol + 1;
  sheet.getRange(1, col).setValue(SEIBAN_HEADER).setFontWeight('bold');
  return col;
}

// 製番セルの値を「文字列の識別子」として扱うための共通ヘルパー。
// 旧形式（単純な整数）・新形式（TK-G26-0001のようなブランド付き文字列）の
// どちらも「空でなければ採番済み」として一貫して扱えるようにする（2026-07-29）。
function seibanKey_(val) {
  return String(val || '').trim();
}

// 製番列を先頭（A列）に移動する（2026-07-17: 一番左に表示したいというユーザー要望で1回限り実行）。
// 既にA列にあれば何もしない。実行後は S 定数の列位置（すべて1列分右にずれた状態）と対応する。
function moveSeibanColumnToFront_(sheet) {
  const col = getOrCreateSeibanColumn_(sheet);
  if (col === 1) return;
  sheet.moveColumns(sheet.getRange(1, col, sheet.getMaxRows()), 1);
  Logger.log((sheet.getName()) + ': 製番列をA列に移動しました（元は' + col + '列目）');
}

// 外部スケジュール表の製番列をA列に移動する手動実行用ラッパー。
// 内部製品マスタ（スケジュールシート）側は Code.gs が列位置を固定で読んでいるため対象外
// （動かす場合は Code.gs の getSchedules/submitReport/addSchedule 等も合わせて改修が必要）
function moveSeibanColumnsToFront() {
  moveSeibanColumnToFront_(SpreadsheetApp.openById(REPORT_CONFIG.scheduleSSId).getSheetByName(REPORT_CONFIG.scheduleSheetName));
  Logger.log('製番列の先頭移動 完了（外部スケジュール表のみ）');
}

// ================================================================
// 採番表（登録フロー）2026-07-29実装・2026-08-03上長MTG差分を受けて改訂
//
// 案件登録の原本。ブランド・シーズン・区分・企画名・製品名を入力すると、
// ブランド付きの新形式試作番号（例: TK-G26-0001）を自動発行する。
// 外部スケジュール表と同じSS（REPORT_CONFIG.scheduleSSId）に新タブとして持つ。
//
// 番号は完全一致（ブランド＋企画名＋製品名）であっても自動では使い回さず、
// 未採番の行には常に新しい番号を発行する（上長がスケジュールの主導権を持つ
// という2026-07-30MTGの結論を受け、無条件統合のリスクを避けるため廃止）。
// 同じ「ブランド＋企画名」の既存行があれば「類似候補」列に参考として提示する
// だけにとどめ、本当に番号を使い回したい場合は上長が外部スケジュール表側で
// 既存番号を直接入力する運用にする（備考欄はシステムが書かず、上長の自由記述
// メモ専用として空けておく）。
//
// 外部スケジュール表への反映（A〜F列の自動補完）は、採番表への登録時ではなく
// 外部スケジュール表側で試作番号が入力/選択されたタイミングで行う（プル型・
// handleExternalScheduleEdit_を参照）。ここでの自動行追加は行わない。
// ================================================================
const SEIBAN_TABLE_SHEET_NAME = '採番表';
const SEIBAN_TABLE_HEADERS = ['試作番号', 'シーズン・型振・VMD', 'ブランド', '区分', '企画名', '製品名', '登録日', '備考', '類似候補'];

// 採番表の列インデックス（0始まり）
// note（備考）は上長の自由記述専用。システムが書くヒントはcandidate（類似候補）へ分離する（2026-08-03）
const T = {
  seiban: 0, season: 1, brand: 2, category: 3,
  planName: 4, product: 5, registeredDate: 6, note: 7, candidate: 8,
};

// ブランド名 → コード（project_seiban_system.md 2026-07-22確定のマッピング）
const BRAND_CODES = {
  'TSUCHIYA': 'TK',
  '土屋鞄のランドセル': 'TR',
  'objcts': 'OB',
  'grirose': 'GR',
  'depsoa': 'DP',
  'ATTITU': 'AT',
  'LASTFRAME': 'LF',
};

// 採番表タブが無ければヘッダー付きで新設して返す。
// 既にタブがある場合も、SEIBAN_TABLE_HEADERSに後から増えた列（類似候補など）が
// 末尾に無ければ追記する（getOrCreateSeibanColumn_と同じ「無ければ追加」パターン）
function getOrCreateSeibanTable_(ss) {
  let sheet = ss.getSheetByName(SEIBAN_TABLE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SEIBAN_TABLE_SHEET_NAME);
    sheet.getRange(1, 1, 1, SEIBAN_TABLE_HEADERS.length)
      .setValues([SEIBAN_TABLE_HEADERS])
      .setBackground('#37474F').setFontColor('#FFFFFF').setFontWeight('bold').setHorizontalAlignment('center');
    sheet.setFrozenRows(1);
    Logger.log('採番表タブを新設しました');
    return sheet;
  }
  const lastCol = sheet.getLastColumn();
  if (lastCol < SEIBAN_TABLE_HEADERS.length) {
    sheet.getRange(1, lastCol + 1, 1, SEIBAN_TABLE_HEADERS.length - lastCol)
      .setValues([SEIBAN_TABLE_HEADERS.slice(lastCol)])
      .setBackground('#37474F').setFontColor('#FFFFFF').setFontWeight('bold').setHorizontalAlignment('center');
    Logger.log('採番表タブに不足していた列を追加しました: ' + SEIBAN_TABLE_HEADERS.slice(lastCol).join('、'));
  }
  return sheet;
}

// ブランド名→コード変換。未登録ブランドはログ警告つきで暫定コードを返す
function brandCode_(brand) {
  const b = String(brand || '').trim();
  if (BRAND_CODES[b]) return BRAND_CODES[b];
  Logger.log('採番表: ブランドコード未登録「' + b + '」。暫定コードを使用（BRAND_CODESへの追加を検討してください）');
  return b.slice(0, 2).toUpperCase() || 'XX';
}

// 区分→コード変換（製品=G / 販促=P）
function categoryCode_(category) {
  return String(category || '').trim() === '販促' ? 'P' : 'G';
}

// シーズン文字列から年の下2桁を抜き出す（例: '26AW'→'26'、'2027SS'→'27'）
function seasonYearSuffix_(season) {
  const m = String(season || '').match(/\d+/);
  if (!m) return '00';
  return m[0].slice(-2).padStart(2, '0');
}

// 採番表の未採番行に試作番号を発行する（本体）。
// dryRun=true のときは何も書き込まず、判定結果だけを返す（debugSeibanTable用）。
function processSeibanTable_(dryRun) {
  const ss = SpreadsheetApp.openById(REPORT_CONFIG.scheduleSSId);
  const sheet = getOrCreateSeibanTable_(ss);
  const lastRow = sheet.getLastRow();
  const result = { assigned: 0, log: [] };
  if (lastRow < 2) return result;

  const rows = sheet.getRange(2, 1, lastRow - 1, SEIBAN_TABLE_HEADERS.length).getValues();

  // 類似候補ヒント用のマップと、区分×年ごとの最大連番を作る
  const planCandidates = new Map();   // ブランド\t企画名 → [{seiban, product}, ...]
  const maxByBucket     = new Map();  // 区分+年（例: 'G26'） → 最大連番
  const seibanPattern = /^([A-Z0-9]+)-([GP])(\d{2})-(\d+)$/;

  rows.forEach(r => {
    const seiban = seibanKey_(r[T.seiban]);
    if (!seiban) return;
    const brand = String(r[T.brand] || '').trim();
    const plan  = String(r[T.planName] || '').trim();
    const prod  = String(r[T.product] || '').trim();
    if (brand && plan) {
      const planKey = brand + '\t' + plan;
      if (!planCandidates.has(planKey)) planCandidates.set(planKey, []);
      planCandidates.get(planKey).push({ seiban, product: prod });
    }
    const m = seiban.match(seibanPattern);
    if (m) {
      const bucketKey = m[2] + m[3];
      const num = parseInt(m[4], 10);
      maxByBucket.set(bucketKey, Math.max(maxByBucket.get(bucketKey) || 0, num));
    }
  });

  // 未採番の行に常に新しい番号を発行（自動使い回しはしない。2026-08-03）
  const todayStr = dFmt(new Date());
  rows.forEach((r, i) => {
    if (seibanKey_(r[T.seiban]) !== '') return;
    const season = String(r[T.season]  || '').trim();
    const brand  = String(r[T.brand]   || '').trim();
    const cat    = String(r[T.category]|| '').trim();
    const plan   = String(r[T.planName]|| '').trim();
    const prod   = String(r[T.product] || '').trim();
    if (!season || !brand || !cat || !plan || !prod) return;  // 必須項目が揃っていない行はスキップ

    const planKey = brand + '\t' + plan;
    const code = brandCode_(brand);
    const cc   = categoryCode_(cat);
    const yy   = seasonYearSuffix_(season);
    const bucketKey = cc + yy;
    const next = (maxByBucket.get(bucketKey) || 0) + 1;
    maxByBucket.set(bucketKey, next);
    const newSeiban = code + '-' + cc + yy + '-' + String(next).padStart(4, '0');
    result.assigned++;

    let hint = '';
    const candidates = planCandidates.get(planKey) || [];
    if (candidates.length > 0) {
      hint = '参考: 同企画内の既存番号 ' + candidates.map(c => c.seiban + '（' + c.product + '）').join('、');
    }
    if (!planCandidates.has(planKey)) planCandidates.set(planKey, []);
    planCandidates.get(planKey).push({ seiban: newSeiban, product: prod });

    const rowNum = i + 2;
    result.log.push(rowNum + '行目: ' + newSeiban + (hint ? '（' + hint + '）' : ''));
    if (!dryRun) {
      sheet.getRange(rowNum, T.seiban + 1).setValue(newSeiban);
      if (!r[T.registeredDate]) sheet.getRange(rowNum, T.registeredDate + 1).setValue(todayStr);
      if (hint) sheet.getRange(rowNum, T.candidate + 1).setValue(hint);
    }
  });

  // dryRun時はdebugSeibanTable()側で詳細ログを出すため、ここでは実書き込み時のみ要約を出す
  if (!dryRun && result.assigned > 0) {
    Logger.log('採番表処理: 新規発行' + result.assigned + '件');
  }
  return result;
}

// プレビュー用：何も書き込まず、採番表の未採番行にどの番号が振られるか・
// どんなヒントが類似候補列に書かれるかをログ出力するだけ（実運用トリガーに任せる前に確認する）
function debugSeibanTable() {
  const result = processSeibanTable_(true);
  Logger.log('=== 採番表 処理プレビュー（書き込みなし） ===');
  if (result.log.length === 0) { Logger.log('対象行なし'); return; }
  result.log.forEach(line => Logger.log('  ' + line));
  Logger.log('新規発行予定' + result.assigned + '件');
}

// 手動実行用ラッパー（runSeibanSyncと同じ位置づけ）
function runSeibanTableProcessing() {
  processSeibanTable_(false);
  Logger.log('採番表処理 手動実行 完了');
}

// ================================================================
// 外部スケジュール表への反映（プル型・ルックアップ）2026-08-03実装
//
// 上長がガントチャート側で新しい行を作り、A列（試作番号）に番号を入力または
// 選択すると、採番表を参照してB〜F列（シーズン・ブランド・区分・企画名・
// 製品名）を自動補完する。行を作る・作らない判断とタイミングは上長に委ねる
// （システム側で新しい行を追加・挿入する処理は行わない＝2026-07-30MTGの結論）。
// ================================================================

// 採番表A〜F列を一括読み込みし、試作番号→案件基本情報のMapを返す
// （syncSeibanToAppProductMaster_のように多数の番号をまとめて引く場合に使う）
function readSeibanTableMap_() {
  const ss = SpreadsheetApp.openById(REPORT_CONFIG.scheduleSSId);
  const sheet = getOrCreateSeibanTable_(ss);
  const lastRow = sheet.getLastRow();
  const map = new Map();
  if (lastRow < 2) return map;
  sheet.getRange(2, 1, lastRow - 1, 6).getValues().forEach(r => {
    const seiban = seibanKey_(r[T.seiban]);
    if (!seiban) return;
    map.set(seiban, {
      season:   String(r[T.season]   || '').trim(),
      brand:    String(r[T.brand]    || '').trim(),
      category: String(r[T.category] || '').trim(),
      planName: String(r[T.planName] || '').trim(),
      product:  String(r[T.product]  || '').trim(),
    });
  });
  return map;
}

// 採番表を試作番号で引く（外部スケジュール表の編集イベントごとに呼ばれるため、
// A列だけ先に読んで該当行を特定 → その行のB〜Fだけピンポイントで読む2段階方式にし、
// 編集のたびに採番表全体を読まないようにする）。見つからなければnull
function lookupSeibanMasterByNumber_(seiban) {
  const key = seibanKey_(seiban);
  if (!key) return null;
  const ss = SpreadsheetApp.openById(REPORT_CONFIG.scheduleSSId);
  const sheet = getOrCreateSeibanTable_(ss);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  const seibanColValues = sheet.getRange(2, T.seiban + 1, lastRow - 1, 1).getValues();
  const idx = seibanColValues.findIndex(r => seibanKey_(r[0]) === key);
  if (idx === -1) return null;

  const rowNum = idx + 2;
  const r = sheet.getRange(rowNum, 1, 1, 6).getValues()[0];
  return {
    season:   String(r[T.season]   || '').trim(),
    brand:    String(r[T.brand]    || '').trim(),
    category: String(r[T.category] || '').trim(),
    planName: String(r[T.planName] || '').trim(),
    product:  String(r[T.product]  || '').trim(),
  };
}

// 外部スケジュール表の該当行のB〜F列（シーズン・ブランド・区分・企画名・製品名）を書き込む
function fillExternalScheduleRow_(sheet, rowNum, info) {
  sheet.getRange(rowNum, S.season    + 1).setValue(info.season);
  sheet.getRange(rowNum, S.brand     + 1).setValue(info.brand);
  sheet.getRange(rowNum, S.category  + 1).setValue(info.category);
  sheet.getRange(rowNum, S.planName  + 1).setValue(info.planName);
  sheet.getRange(rowNum, S.product   + 1).setValue(info.product);
}

// インストール型トリガーの本体：外部スケジュール表のA列（試作番号）が編集されたら、
// 採番表を引いてB〜F列を自動補完する
function handleExternalScheduleEdit_(e) {
  if (!e || !e.range) return;
  const editedSheet = e.range.getSheet();
  if (e.source.getId() !== REPORT_CONFIG.scheduleSSId) return;
  if (editedSheet.getName() !== REPORT_CONFIG.scheduleSheetName) return;
  if (e.range.getNumRows() !== 1 || e.range.getNumColumns() !== 1) return;  // 単一セル編集のみ対象

  const row = e.range.getRow();
  if (row < 6) return;  // 1〜5行目は見出し・注意書き

  const seibanCol = getOrCreateSeibanColumn_(editedSheet);
  if (e.range.getColumn() !== seibanCol) return;

  const seiban = seibanKey_(e.range.getValue());
  if (!seiban) return;

  const info = lookupSeibanMasterByNumber_(seiban);
  if (!info) { Logger.log('採番表に見つからない試作番号: ' + seiban); return; }
  fillExternalScheduleRow_(editedSheet, row, info);
}

// handleExternalScheduleEdit_用のインストール型トリガーを設定する（初回・変更時に1回だけ手動実行）。
// 外部スケジュール表はWeeklyReportとは別スプレッドシートのため、単純トリガーonEditでは検知できない
function setupExternalScheduleEditTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'handleExternalScheduleEdit_')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('handleExternalScheduleEdit_')
    .forSpreadsheet(SpreadsheetApp.openById(REPORT_CONFIG.scheduleSSId))
    .onEdit()
    .create();
  Logger.log('外部スケジュール表 編集トリガー設定完了');
}

// 手動テスト用：採番表のルックアップ結果をログに出力するだけ（トリガーを設定する前に確認する）
function debugLookupSeiban(seiban) {
  const info = lookupSeibanMasterByNumber_(seiban);
  Logger.log(info ? JSON.stringify(info) : '見つかりませんでした: ' + seiban);
}

// ② 外部スケジュール表の製番を、日報アプリの内部製品マスタ（スケジュールシート）に反映する。
// 製番で既存行と突合し、無ければ新規追加・製番未リンクの既存行があればバックフィルする
// （表記ゆれで手入力されていた過去の行も、製品名が一致すれば製番を後付けできる）。
// ブランド・企画名・製品名の取得元は、外部スケジュール表ではなく採番表（正本）にする
// （サンプル製品名称は外部スケジュール表側で改名されることがあるため。2026-08-03変更）
function syncSeibanToAppProductMaster_() {
  processSeibanTable_();

  const extSheet = SpreadsheetApp.openById(REPORT_CONFIG.scheduleSSId).getSheetByName(REPORT_CONFIG.scheduleSheetName);
  const lastRow  = extSheet.getLastRow();
  if (lastRow < 6) return;

  const seibanCol = getOrCreateSeibanColumn_(extSheet);
  const extRows = extSheet.getRange(6, 1, lastRow - 5, Math.max(seibanCol, 15)).getValues();
  const seibanMaster = readSeibanTableMap_();

  // 製番ごとに全行のステータスを集計（全行完了/中断ならarchiveCompletedSchedulesで
  // 削除された（されるべき）製品なので、同期で復活させない）
  // ※製番は「文字列の識別子」として扱う（旧形式の整数・新形式のTK-G26-0001どちらも
  //   同じMapキーとして機能する。2026-07-29修正）
  const ARCHIVE_STATUSES = new Set(['完了', '中断']);
  const statusesBySeiban = new Map();
  extRows.forEach(r => {
    const seiban = seibanKey_(r[seibanCol - 1]);
    if (!seiban) return;
    if (!statusesBySeiban.has(seiban)) statusesBySeiban.set(seiban, []);
    statusesBySeiban.get(seiban).push(String(r[S.status] || '').trim());
  });

  // 製番ごとの案件基本情報（採番表を正本として引く。外部スケジュール表に登場する
  // だけで採番表に見つからない番号＝手入力ミス等は同期対象から除外する）
  const latestBySeiban = new Map();
  statusesBySeiban.forEach((statuses, seiban) => {
    const allDone = statuses.every(s => ARCHIVE_STATUSES.has(s));
    if (allDone) return;  // 完了/中断済みは日報アプリに追加・復活させない
    const info = seibanMaster.get(seiban);
    if (!info) return;
    latestBySeiban.set(seiban, {
      seiban,
      brand:   info.brand,
      plan:    info.planName,
      product: info.product,
    });
  });
  if (latestBySeiban.size === 0) return;

  const appSheet = SpreadsheetApp.openById(REPORT_CONFIG.logSSId).getSheetByName('スケジュール');
  if (!appSheet) { Logger.log('内部製品マスタ（スケジュールシート）が見つかりません'); return; }
  const appSeibanCol = getOrCreateSeibanColumn_(appSheet);
  const appLastRow   = appSheet.getLastRow();

  // 既存行を 製番 → 行番号 のマップに。製番が未リンクの行は製品名で仮突合できるよう記録
  const rowBySeiban = new Map();
  const rowByName   = new Map();
  if (appLastRow > 1) {
    appSheet.getRange(2, 1, appLastRow - 1, appSeibanCol).getValues().forEach((r, i) => {
      const rowNum  = i + 2;
      const seiban  = seibanKey_(r[appSeibanCol - 1]);
      if (seiban) rowBySeiban.set(seiban, rowNum);
      const name = String(r[1] || '').trim();  // B列: 製品名
      if (name && !rowByName.has(name)) rowByName.set(name, rowNum);
    });
  }

  let inserted = 0, backfilled = 0, updated = 0;
  latestBySeiban.forEach(info => {
    if (!info.product) return;
    let rowNum = rowBySeiban.get(info.seiban);
    const alreadyLinked = !!rowNum;

    if (!rowNum) {
      // 製番未リンクの既存行があれば新規追加せずそこに製番を後付けする
      rowNum = rowByName.get(info.product);
      if (rowNum) {
        appSheet.getRange(rowNum, appSeibanCol).setValue(info.seiban);
        backfilled++;
      }
    }

    if (!rowNum) {
      // 新規追加（製品or販促は既定「製品」・シーズンは空欄。誤りは設定タブで手動修正）
      // IDは旧形式（単純な整数）ならSB0001のような表示用ID、新形式（ブランド付き文字列）は
      // それ自体がすでに一意で読みやすいIDなのでそのまま使う
      const displayId = /^\d+$/.test(info.seiban) ? 'SB' + info.seiban.padStart(4, '0') : info.seiban;
      appSheet.appendRow([displayId, info.product, '製品', '', info.brand, info.plan]);
      appSheet.getRange(appSheet.getLastRow(), appSeibanCol).setValue(info.seiban);
      inserted++;
      return;
    }

    if (alreadyLinked) {
      // 製番で既にリンク済みの行：外部スケジュール表側で製品名・ブランド・企画名が
      // 変更されていたら追随させる（サンプル製品名称は途中で改名されることがあるため。
      // 企画名は変わらない前提だが念のため一緒に更新する。2026-07-24発覚）
      const cur = appSheet.getRange(rowNum, 2, 1, 5).getValues()[0];  // B〜F: 製品名/区分/シーズン/ブランド/企画名
      const curName  = String(cur[0] || '').trim();
      const curBrand = String(cur[3] || '').trim();
      const curPlan  = String(cur[4] || '').trim();
      if (curName !== info.product || curBrand !== info.brand || curPlan !== info.plan) {
        appSheet.getRange(rowNum, 2).setValue(info.product);
        appSheet.getRange(rowNum, 5).setValue(info.brand);
        appSheet.getRange(rowNum, 6).setValue(info.plan);
        updated++;
      }
    }
  });

  if (inserted > 0 || backfilled > 0 || updated > 0) {
    Logger.log('内部製品マスタ同期: 新規追加' + inserted + '件 / 製番バックフィル' + backfilled + '件 / 名称更新' + updated + '件');
  }
}

// ================================================================
// 孤立した製品マスタ行のクリーンアップ（2026-07-24）
// 製品名の改名・製番未リンクの手動追加などにより、外部スケジュール表に
// 対応する行が一切見つからなくなった製品を、ユーザーが個別確認した上で削除する
// ================================================================
function cleanupOrphanedProducts() {
  const ORPHANED_NAMES = [
    'ミニボストン',
    '(仮)新型バッグ',
    '(仮)財布',
    'なんばバック(仮)',
    '27SS_コレクションライン_Rubber Bag',
    'ユニークプロダクト / クエンチャー（6月）',
    'トート（3型）胴修正',
    'ライスバッグ',
    'スエードトート・ストラップ',
    'カブセトート',
    'イヤホンアクセサリー',
    'ユニークプロダクト_カセットテープMagWear',
    '横トート',
    '水風船',
    'ホーボー撮影用',
    '量産14本',
    'A LEATHER ランドライダー量産14本',
  ];
  const names = new Set(ORPHANED_NAMES);

  const appSheet = SpreadsheetApp.openById(REPORT_CONFIG.logSSId).getSheetByName('スケジュール');
  if (!appSheet || appSheet.getLastRow() <= 1) { Logger.log('内部製品マスタが見つからないか空です'); return; }

  const rows = appSheet.getRange(2, 1, appSheet.getLastRow() - 1, 2).getValues();
  let deleted = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const name = String(rows[i][1] || '').trim();
    if (names.has(name)) {
      appSheet.deleteRow(i + 2);
      deleted++;
    }
  }
  Logger.log('孤立製品クリーンアップ完了: ' + deleted + '件削除');
}

// 手動テスト用ラッパー（GASエディタから実行。トリガー設定前に必ず1回実行して結果を確認する）
function runSeibanSync() {
  syncSeibanToAppProductMaster_();
  Logger.log('製番同期 手動実行 完了');
}

function setupSeibanTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncSeibanToAppProductMaster_')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncSeibanToAppProductMaster_')
    .timeBased().everyMinutes(10).create();
  Logger.log('製番同期トリガー設定完了: 10分おき');
}

// ================================================================
// 製番バグの後始末（2026-07-21）
// 列マッピングのバグ（企画名/製品名の取り違え・見出し行の誤読）により
// 内部製品マスタに誤追加された「SB」始まりの行を確認・削除し、
// 誤ってグルーピングされた製番を全体リセットするための後始末関数群
// ================================================================

// 内部製品マスタ（アプリ本体SSの「スケジュール」シート）で、
// ID列が「SB」始まりの行（バグ入り同期で誤追加された行）を一覧表示する（削除はしない）
function debugSeibanBadRows() {
  const s = SpreadsheetApp.openById(REPORT_CONFIG.logSSId).getSheetByName('スケジュール');
  if (!s || s.getLastRow() <= 1) { Logger.log('内部製品マスタが見つからないか空です'); return; }
  const rows = s.getRange(2, 1, s.getLastRow() - 1, 6).getValues();
  let count = 0;
  rows.forEach((r, i) => {
    const id = String(r[0] || '');
    if (id.indexOf('SB') === 0) {
      count++;
      Logger.log('行' + (i + 2) + ': ' + id + ' | 製品名=' + r[1] + ' | ブランド=' + r[4] + ' | 企画名=' + r[5]);
    }
  });
  Logger.log('=== SB始まりの行: ' + count + '件 ===');
}

// debugSeibanBadRows() で確認した「SB」始まりの行を削除する
function deleteSeibanBadRows() {
  const s = SpreadsheetApp.openById(REPORT_CONFIG.logSSId).getSheetByName('スケジュール');
  if (!s || s.getLastRow() <= 1) { Logger.log('内部製品マスタが見つからないか空です'); return; }
  const rows = s.getRange(2, 1, s.getLastRow() - 1, 1).getValues();
  let deleted = 0;
  // 下の行から削除しないと、削除するたびに行番号がズレて対象を取り違える
  for (let i = rows.length - 1; i >= 0; i--) {
    const id = String(rows[i][0] || '');
    if (id.indexOf('SB') === 0) {
      s.deleteRow(i + 2);
      deleted++;
    }
  }
  Logger.log('削除完了: ' + deleted + '件（内部製品マスタのSB始まり行）');
}

// 外部スケジュール表・内部製品マスタ両方の「製番」列の数字を全部クリアする
// （誤ったグルーピングで振られた番号をリセットし、修正済みコードで振り直すため）
function resetSeibanColumns() {
  const extSheet = SpreadsheetApp.openById(REPORT_CONFIG.scheduleSSId).getSheetByName(REPORT_CONFIG.scheduleSheetName);
  const extCol   = getOrCreateSeibanColumn_(extSheet);
  const extLast  = extSheet.getLastRow();
  if (extLast >= 6) extSheet.getRange(6, extCol, extLast - 5, 1).clearContent();

  const appSheet = SpreadsheetApp.openById(REPORT_CONFIG.logSSId).getSheetByName('スケジュール');
  const appCol   = getOrCreateSeibanColumn_(appSheet);
  const appLast  = appSheet.getLastRow();
  if (appLast >= 2) appSheet.getRange(2, appCol, appLast - 1, 1).clearContent();

  Logger.log('製番列リセット完了（外部スケジュール表・内部製品マスタとも）');
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
// デバッグ：外部スケジュール表と日報アプリ製品マスタの件数差分を調査（2026-07-24）
// 外部スケジュール表の「アクティブ（未完了）な製品名」の集合と、日報アプリの
// 製品マスタ全行を突き合わせ、重複行・孤立行（スケジュール側に無い/完了扱い）を洗い出す
// ================================================================
function debugProductCountMismatch() {
  const scheduleSheet = SpreadsheetApp.openById(REPORT_CONFIG.scheduleSSId).getSheetByName(REPORT_CONFIG.scheduleSheetName);
  const seibanCol = getOrCreateSeibanColumn_(scheduleSheet);
  const lastRow = scheduleSheet.getLastRow();
  const rawRows = lastRow >= 6 ? scheduleSheet.getRange(6, 1, lastRow - 5, Math.max(seibanCol, 15)).getValues() : [];

  const ARCHIVE_STATUSES = new Set(['完了', '中断']);

  // 外部スケジュール表：製品名ごとのステータス集計 → アクティブ（未完了）な製品名一覧
  const statusesByName = new Map();
  rawRows.forEach(r => {
    const name = String(r[S.product] || '').trim();
    if (!name) return;
    if (!statusesByName.has(name)) statusesByName.set(name, []);
    statusesByName.get(name).push(String(r[S.status] || '').trim());
  });
  const activeNames = new Set(
    [...statusesByName.entries()]
      .filter(([, statuses]) => !(statuses.length > 0 && statuses.every(s => ARCHIVE_STATUSES.has(s))))
      .map(([name]) => name)
  );
  Logger.log('外部スケジュール表: 製品名ユニーク数=' + statusesByName.size + ' / うちアクティブ(未完了)=' + activeNames.size);

  // 日報アプリの製品マスタ
  const appSheet = SpreadsheetApp.openById(REPORT_CONFIG.logSSId).getSheetByName('スケジュール');
  const appLastRow = appSheet.getLastRow();
  const appRows = appLastRow > 1 ? appSheet.getRange(2, 1, appLastRow - 1, appSheet.getLastColumn()).getValues() : [];
  Logger.log('日報アプリ 製品マスタ: 行数=' + appRows.length);

  // 同じ製品名が複数行あるかチェック
  const nameCount = new Map();
  appRows.forEach(r => {
    const name = String(r[1] || '').trim();
    if (name) nameCount.set(name, (nameCount.get(name) || 0) + 1);
  });
  const dupNames = [...nameCount.entries()].filter(([, c]) => c > 1);
  if (dupNames.length > 0) {
    Logger.log('--- 日報アプリ側で同じ製品名が複数行ある（' + dupNames.length + '件）---');
    dupNames.forEach(([name, c]) => Logger.log('「' + name + '」: ' + c + '行'));
  } else {
    Logger.log('日報アプリ側の重複製品名: なし');
  }

  // アクティブなスケジュールに存在しない（＝本来消えているはずの）app行
  Logger.log('--- 日報アプリにはあるが、外部スケジュール表でアクティブでない製品 ---');
  let extraCount = 0;
  appRows.forEach(r => {
    const name = String(r[1] || '').trim();
    if (!name) return;
    if (!activeNames.has(name)) {
      extraCount++;
      const inSchedule = statusesByName.has(name);
      Logger.log('「' + name + '」 ID=' + r[0] + ' ' + (inSchedule ? '（スケジュールでは完了/中断のみ）' : '（外部スケジュール表に存在しない＝手動追加または孤立）'));
    }
  });
  Logger.log('=== 差分候補: ' + extraCount + '件 ===');
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

  const logRows      = getSheetData(REPORT_CONFIG.logSSId,      REPORT_CONFIG.logSheetName,       19);
  const scheduleRows = getSheetData(REPORT_CONFIG.scheduleSSId, REPORT_CONFIG.scheduleSheetName, 15, 6);

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
  const logRows      = getSheetData(REPORT_CONFIG.logSSId,      REPORT_CONFIG.logSheetName,      19);
  const scheduleRows = getSheetData(REPORT_CONFIG.scheduleSSId, REPORT_CONFIG.scheduleSheetName, 15, 6);

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
  addText('試作課が「何に・どれくらい時間を使い・今どんな状況か」を誰でも数分で理解できるようにする共有用ダッシュボード。専用スプレッドシート「試作課：日報サマリー」に出力される（集計データ本体はWeeklyReportのまま）。製品開発は「⓪日報サマリー」、販促物（ショート動画・撮影用制作など）は「⓪販促サマリー」に分けて表示する。毎月1日の自動実行で前月分に更新され、同時に月別タブ（例:「2026年06月 製品」・グレータブ）として自動アーカイブされるため、過去の月と見比べられる（runSummary2026XX() で手動更新も可能。同じ月の再実行はアーカイブごと置き換わるので安全）。');
  addTable([
    ['セクション', '内容'],
    ['📦 今月の活動', '対象区分の工数・労務費・稼働案件数・担当人数＋参考として課全体総工数・間接のKPIカード（前月比付き）'],
    ['🔧 工数の内訳（製作／付帯業務）', '中分類の「分類」（設定タブで変更可）に基づき、製作（型紙・仮制作・本制作など）と付帯業務（原価表・工程表・引き継ぎ・ミーティングなど）の時間配分を表示。中分類対象外＝中分類の選択肢がないフェーズ（試験体・量産・エイジングサンプル・修理・SOP・治具）、中分類未選択＝選べたのに選択されなかった時間（2026/6/17の機能追加以前の日報を含む）'],
    ['🗂 間接業務（その他）の内訳', '日報の「その他」種別（定例ミーティング・事務作業・棚卸しなど）の時間内訳。課全体の参考値で、KPIカード「うち間接（参考）」の中身。⓪日報サマリーのみに表示'],
    ['📈 案件別工数 TOP10', '月内工数の横棒ランキング。濃い青=上位20%、薄い青=20〜40%（評価ではなく事実の共有）'],
    ['🛠 工程別の時間配分', 'モック/1st/2nd/3rd以降/最終/色増し/試験体/修理/SOP/治具/その他の時間配分と構成比'],
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
    ['試験体・修理・SOP・治具 列', 'サンプル製作以外の重要業務にかけた時間。「この製品のSOP作成に何時間」が製品単位で追える'],
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
    ['計画完了', 'スケAジュールSSの試作完了日'],
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
