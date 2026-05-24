// ============================================================
// 試作課 日報アプリ（分入力・出退勤連携版）
// ============================================================

const SHEETS = {
  CRAFTSMEN:  '職人',
  SCHEDULES:  'スケジュール',
  STAGES:     'ステージ',
  LOGS:       '日報ログ'
};

const MINUTES_PER_NINKU = 480;
const RATE_PER_MINUTE   = 42;

// ----------------------------------------------------------
// Web アプリエントリーポイント
// ----------------------------------------------------------
function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('試作課 日報')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ----------------------------------------------------------
// 初回セットアップ
// ----------------------------------------------------------
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 職人
  let s = getOrCreate(ss, SHEETS.CRAFTSMEN);
  if (s.getLastRow() === 0) {
    s.appendRow(['ID', '名前', '備考']);
    header(s, 3);
  }

  // スケジュール（製品マスタ）
  // 列: ID / 製品名 / シーズン・型振・VMD / ブランド / 企画名 / ステータス / 備考
  s = getOrCreate(ss, SHEETS.SCHEDULES);
  if (s.getLastRow() === 0) {
    s.appendRow(['ID', '製品名', 'シーズン・型振・VMD', 'ブランド', '企画名']);
    header(s, 5);
    s.setColumnWidth(2, 240);
    s.setColumnWidth(3, 160);
    s.setColumnWidth(4, 150);
    s.setColumnWidth(5, 200);
  }

  // ステージマスター
  s = getOrCreate(ss, SHEETS.STAGES);
  if (s.getLastRow() === 0) {
    s.appendRow(['ID', 'ステージ名', '順番']);
    header(s, 3);
    const defaults = [
      ['ST1', 'モック',        1],
      ['ST2', '1st',           2],
      ['ST3', '2nd',           3],
      ['ST4', '最終（展示会）', 4],
      ['ST5', '色増し前修正',  5],
      ['ST6', '試験体',        6],
      ['ST7', 'ショー用',      7],
      ['ST8', '--- その他 ---', 8],
      ['ST9', '社内MTG',       9],
      ['ST10','面談',          10],
      ['ST11','研修',          11],
      ['ST12','事務作業',      12],
    ];
    defaults.forEach(r => s.appendRow(r));
  }

  // 日報ログ
  s = getOrCreate(ss, SHEETS.LOGS);
  if (s.getLastRow() === 0) {
    s.appendRow([
      'ID', '日付', '職人名',
      '出勤時刻', '退勤時刻', '休憩(分)', '実働(分)',
      '種別', '製品名', 'フェーズ', '作業種別',
      '作業時間(分)', '人工数', '労務費(円)',
      'メモ', '提出日時', '企画名'
    ]);
    header(s, 17);
    [2,3,8,9,13].forEach(c => s.setColumnWidth(c, 120));
    s.setColumnWidth(8, 220);
  }

  return { success: true, message: 'セットアップ完了しました。' };
}

// ヘッダー修正用（一度だけ実行してください）
function fixLogHeaders() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const s  = ss.getSheetByName(SHEETS.LOGS);
  const headers = [
    'ID', '日付', '職人名',
    '出勤時刻', '退勤時刻', '休憩(分)', '実働(分)',
    '種別', '製品名', 'フェーズ', '作業種別',
    '作業時間(分)', '人工数', '労務費(円)',
    'メモ', '提出日時', '企画名'
  ];
  s.getRange(1, 1, 1, headers.length).setValues([headers]);
  header(s, headers.length);
  Logger.log('ヘッダーを修正しました');
}

// ----------------------------------------------------------
// 初期データ取得
// ----------------------------------------------------------
function getInitialData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return {
    craftsmen: getCraftsmen(ss),
    schedules: getSchedules(ss),
    stages:    getStages(ss)
  };
}

function getCraftsmen(ss) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  const s = ss.getSheetByName(SHEETS.CRAFTSMEN);
  if (!s || s.getLastRow() <= 1) return [];
  return s.getRange(2, 1, s.getLastRow()-1, 3).getValues()
    .filter(r => r[1]).map(r => ({ id:r[0], name:r[1], note:r[2] }));
}

function getSchedules(ss) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  const s = ss.getSheetByName(SHEETS.SCHEDULES);
  if (!s || s.getLastRow() <= 1) return [];
  return s.getRange(2, 1, s.getLastRow()-1, 5).getValues()
    .filter(r => r[1]).map(r => ({
      id:r[0], name:r[1], season:r[2]||'', brand:r[3]||'', plan:r[4]||''
    }));
}

function getStages(ss) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  const s = ss.getSheetByName(SHEETS.STAGES);
  if (!s || s.getLastRow() <= 1) return [];
  return s.getRange(2, 1, s.getLastRow()-1, 3).getValues()
    .filter(r => r[1])
    .sort((a,b) => a[2]-b[2])
    .map(r => ({ id:r[0], name:r[1], order:r[2] }));
}

// ----------------------------------------------------------
// 日報提出
// ----------------------------------------------------------
function submitReport(craftsmanName, dateStr, clockIn, clockOut, breakMin, rows, memo) {
  if (!craftsmanName) return { success:false, message:'職人名を選択してください。' };
  if (!dateStr)       return { success:false, message:'日付を入力してください。' };
  if (!rows || rows.length === 0) return { success:false, message:'作業行を1件以上入力してください。' };

  const actualMin  = calcActualMinutes(clockIn, clockOut, Number(breakMin)||0);
  const totalInput = rows.reduce((s,r) => s + (Number(r.minutes)||0), 0);

  const warning = (actualMin > 0 && totalInput !== actualMin)
    ? `※ 入力合計 ${totalInput}分 ／ 実働 ${actualMin}分（差: ${totalInput - actualMin}分）`
    : null;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.LOGS);
  const submittedAt = fmt(new Date(), 'yyyy/MM/dd HH:mm:ss');

  // 製品名 → 企画名 のルックアップ（スケジュールマスターから）
  const schedSheet = ss.getSheetByName(SHEETS.SCHEDULES);
  const productToPlan = new Map();
  if (schedSheet && schedSheet.getLastRow() > 1) {
    schedSheet.getRange(2, 1, schedSheet.getLastRow()-1, 5).getValues()
      .forEach(r => { if (r[1]) productToPlan.set(r[1], r[4]||''); });
  }

  rows.forEach(row => {
    const min   = Number(row.minutes) || 0;
    const ninku = parseFloat((min / MINUTES_PER_NINKU).toFixed(4));
    const cost  = Math.round(min * RATE_PER_MINUTE);
    const isSample = (row.type !== 'other');
    const planName = isSample ? (productToPlan.get(row.productName) || '') : '';
    sheet.appendRow([
      Utilities.getUuid(),
      dateStr, craftsmanName,
      clockIn||'', clockOut||'', Number(breakMin)||0, actualMin,
      isSample ? 'サンプル製造' : 'その他',
      isSample ? (row.productName||'') : '',
      isSample ? (row.stageName||'')   : '',
      isSample ? ''                    : (row.workType||''),
      min, ninku, cost,
      row.memo || memo || '',
      submittedAt,
      planName
    ]);
  });

  return {
    success: true,
    warning: warning,
    message: `提出しました（${rows.length}件）。${warning||''}`
  };
}

// ----------------------------------------------------------
// 実働分計算
// ----------------------------------------------------------
function calcActualMinutes(clockIn, clockOut, breakMin) {
  if (!clockIn || !clockOut) return 0;
  try {
    const [ih, im] = clockIn.split(':').map(Number);
    const [oh, om] = clockOut.split(':').map(Number);
    return Math.max(0, (oh*60+om) - (ih*60+im) - (breakMin||0));
  } catch(e) { return 0; }
}

// ----------------------------------------------------------
// マスター管理
// ----------------------------------------------------------
function addCraftsman(name, note) {
  if (!name) return { success:false, message:'名前を入力してください。' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const s  = ss.getSheetByName(SHEETS.CRAFTSMEN);
  s.appendRow(['C'+String(s.getLastRow()).padStart(3,'0'), name, note||'']);
  return { success:true, message:`${name} を追加しました。` };
}
function deleteCraftsman(name) { return delRow(SHEETS.CRAFTSMEN, 2, name); }

function addSchedule(name, season, brand, plan) {
  if (!name) return { success:false, message:'製品名を入力してください。' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const s  = ss.getSheetByName(SHEETS.SCHEDULES);
  s.appendRow(['S'+String(s.getLastRow()).padStart(3,'0'), name, season||'', brand||'', plan||'']);
  return { success:true, message:`「${name}」を追加しました。` };
}
function deleteSchedule(name) { return delRow(SHEETS.SCHEDULES, 2, name); }

function addStage(name) {
  if (!name) return { success:false, message:'ステージ名を入力してください。' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const s  = ss.getSheetByName(SHEETS.STAGES);
  const order = s.getLastRow();
  s.appendRow(['ST'+order, name, order]);
  return { success:true, message:`ステージ「${name}」を追加しました。` };
}
function deleteStage(name) { return delRow(SHEETS.STAGES, 2, name); }

// ----------------------------------------------------------
// ユーティリティ
// ----------------------------------------------------------
function getOrCreate(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}
function header(s, n) {
  s.getRange(1,1,1,n).setFontWeight('bold').setBackground('#374151').setFontColor('#fff');
}
function fmt(d, pattern) {
  return Utilities.formatDate(d, 'Asia/Tokyo', pattern);
}
function delRow(sheetName, col, val) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const s  = ss.getSheetByName(sheetName);
  if (!s || s.getLastRow() <= 1) return { success:false, message:'データがありません。' };
  const data = s.getRange(2, col, s.getLastRow()-1, 1).getValues();
  const idx  = data.findIndex(r => r[0] === val);
  if (idx === -1) return { success:false, message:`「${val}」が見つかりません。` };
  s.deleteRow(idx + 2);
  return { success:true, message:`「${val}」を削除しました。` };
}
