// ============================================================
// 試作課 日報アプリ（分入力・出退勤連携版）
// ============================================================

const SHEETS = {
  CRAFTSMEN:     '職人',
  SCHEDULES:     'スケジュール',
  STAGES:        'ステージ',
  STAGE_SUBCATS: 'フェーズ中分類',
  WORK_TYPES:    'その他種別',
  LOGS:          '日報ログ'
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
    s.appendRow(['ID', '名前', '備考', 'メール']);
    header(s, 4);
  } else if (s.getLastColumn() < 4) {
    s.getRange(1, 4).setValue('メール');
  }

  // スケジュール（製品マスタ）
  // 列: ID / 製品名 / 製品or販促 / シーズン・型振・VMD / ブランド / 企画名
  s = getOrCreate(ss, SHEETS.SCHEDULES);
  if (s.getLastRow() === 0) {
    s.appendRow(['ID', '製品名', '製品or販促', 'シーズン・型振・VMD', 'ブランド', '企画名']);
    header(s, 6);
    s.setColumnWidth(2, 240);
    s.setColumnWidth(3, 120);
    s.setColumnWidth(4, 160);
    s.setColumnWidth(5, 150);
    s.setColumnWidth(6, 200);
  } else if (s.getLastColumn() < 6) {
    // 既存シートに製品or販促列を追加
    s.getRange(1, 3).setValue('製品or販促');
    s.insertColumns(3, 1);
    s.getRange(2, 3, s.getLastRow()-1, 1).setValue('製品');
  }

  // ステージマスター（フェーズ大分類）
  s = getOrCreate(ss, SHEETS.STAGES);
  if (s.getLastRow() === 0) {
    s.appendRow(['ID', 'ステージ名', '順番', '中分類あり']);
    header(s, 4);
    [
      ['ST01', 'モック',             1, true],
      ['ST02', '1st',                2, true],
      ['ST03', '2nd',                3, true],
      ['ST04', '3rd',                4, true],
      ['ST05', '4th',                5, true],
      ['ST06', '5th',                6, true],
      ['ST07', '最終',               7, true],
      ['ST08', '色増しサンプル',     8, true],
      ['ST09', '試験体',             9, false],
      ['ST10', '量産',              10, false],
      ['ST11', 'エイジングサンプル', 11, false],
      ['ST12', '修理',              12, false],
      ['ST13', 'SOP',               13, false],
      ['ST14', '治具',              14, false],
    ].forEach(r => s.appendRow(r));
  } else if (s.getLastColumn() < 4) {
    s.getRange(1, 4).setValue('中分類あり');
  }

  // フェーズ中分類マスター
  s = getOrCreate(ss, SHEETS.STAGE_SUBCATS);
  if (s.getLastRow() === 0) {
    s.appendRow(['ID', '中分類名', '順番']);
    header(s, 3);
    [
      ['SC1',  '型紙作成・修正',                  1],
      ['SC2',  '仮制作（部分サンプル・部分修正）', 2],
      ['SC3',  '本制作（型修正がない場合）',       3],
      ['SC4',  '原価表作成・修正',                4],
      ['SC5',  '工程表作成・修正',                5],
      ['SC6',  '引き継ぎ',                        6],
      ['SC7',  'サンプル依頼ミーティング',         7],
      ['SC8',  '裁断確認ミーティング',             8],
      ['SC9',  '製造開発ミーティング',             9],
      ['SC10', '色増しフィードバックミーティング', 10],
      ['SC11', '量産フィードバックミーティング',   11],
      ['SC12', 'サンプルチェック',                12],
    ].forEach(r => s.appendRow(r));
  } else {
    migrateSubcats_(s);
  }

  // その他種別マスター
  s = getOrCreate(ss, SHEETS.WORK_TYPES);
  if (s.getLastRow() === 0) {
    s.appendRow(['ID', '種別名', '順番']);
    header(s, 3);
    [
      ['WT1', '定例ミーティング',                    1],
      ['WT2', 'その他ミーティング',                  2],
      ['WT3', '事務作業',                            3],
      ['WT4', '社内行事',                            4],
      ['WT5', '問い合わせ対応（部材確認・荷受けなど）', 5],
      ['WT6', '棚卸し',                              6],
      ['WT7', '納品処理',                            7],
      ['WT8', 'その他（メモに入れる）',               8],
    ].forEach(r => s.appendRow(r));
  }

  // 日報ログ
  s = getOrCreate(ss, SHEETS.LOGS);
  if (s.getLastRow() === 0) {
    s.appendRow([
      'ID', '日付', '職人名',
      '出勤時刻', '退勤時刻', '休憩(分)', '実働(分)',
      '種別', '製品名', 'フェーズ大分類', '作業種別',
      '作業時間(分)', '人工数', '労務費(円)',
      'メモ', '提出日時', '企画名', 'フェーズ中分類', '製品or販促'
    ]);
    header(s, 19);
    [2,3,8,9,13].forEach(c => s.setColumnWidth(c, 120));
    s.setColumnWidth(8, 220);
  } else if (s.getLastColumn() < 19) {
    s.getRange(1, 19).setValue('製品or販促');
    if (s.getLastColumn() < 18) {
      s.getRange(1, 18).setValue('フェーズ中分類');
    }
    if (s.getRange(1, 10).getValue() === 'フェーズ') {
      s.getRange(1, 10).setValue('フェーズ大分類');
    }
  }

  return { success: true, message: 'セットアップ完了しました。' };
}

// 中分類マイグレーション（GASエディタからも手動で実行可）
function migrateSubcats() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  migrateSubcats_(ss.getSheetByName(SHEETS.STAGE_SUBCATS));
}
function migrateSubcats_(s) {
  const lastRow = s.getLastRow();
  if (lastRow <= 1) return;
  const data = s.getRange(2, 2, lastRow - 1, 1).getValues().map(r => r[0]);

  // 旧名称のリネーム
  const idx = data.indexOf('型紙・抜き型作成/修正');
  if (idx !== -1) s.getRange(idx + 2, 2).setValue('型紙作成・修正');

  // 不足している中分類を末尾に追加
  const toAdd = [
    '引き継ぎ',
    'サンプル依頼ミーティング',
    '裁断確認ミーティング',
    '製造開発ミーティング',
    '色増しフィードバックミーティング',
    '量産フィードバックミーティング',
    'サンプルチェック',
  ];
  let order = lastRow;
  toAdd.forEach(name => {
    if (!data.includes(name)) {
      s.appendRow(['SC' + order, name, order]);
      order++;
    }
  });
}

// ヘッダー修正用（一度だけ実行してください）
function fixLogHeaders() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const s  = ss.getSheetByName(SHEETS.LOGS);
  const headers = [
    'ID', '日付', '職人名',
    '出勤時刻', '退勤時刻', '休憩(分)', '実働(分)',
    '種別', '製品名', 'フェーズ大分類', '作業種別',
    '作業時間(分)', '人工数', '労務費(円)',
    'メモ', '提出日時', '企画名', 'フェーズ中分類'
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
    craftsmen:  getCraftsmen(ss),
    schedules:  getSchedules(ss),
    stages:     getStages(ss),
    subcats:    getStageSubcats(ss),
    workTypes:  getWorkTypes(ss)
  };
}

function getWorkTypes(ss) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  const s = ss.getSheetByName(SHEETS.WORK_TYPES);
  if (!s || s.getLastRow() <= 1) return [];
  return s.getRange(2, 1, s.getLastRow()-1, 3).getValues()
    .filter(r => r[1])
    .sort((a,b) => a[2]-b[2])
    .map(r => ({ id:r[0], name:r[1], order:r[2] }));
}

function getCraftsmen(ss) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  const s = ss.getSheetByName(SHEETS.CRAFTSMEN);
  if (!s || s.getLastRow() <= 1) return [];
  return s.getRange(2, 1, s.getLastRow()-1, 4).getValues()
    .filter(r => r[1]).map(r => ({ id:r[0], name:r[1], note:r[2], email:r[3] }));
}

function getSchedules(ss) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  const s = ss.getSheetByName(SHEETS.SCHEDULES);
  if (!s || s.getLastRow() <= 1) return [];
  const hasCategory = s.getLastColumn() >= 6;
  const cols = hasCategory ? 6 : 5;
  return s.getRange(2, 1, s.getLastRow()-1, cols).getValues()
    .filter(r => r[1]).map(r => ({
      id:r[0], name:r[1], category:hasCategory ? (r[2]||'') : '', season:hasCategory ? (r[3]||'') : (r[2]||''), brand:hasCategory ? (r[4]||'') : (r[3]||''), plan:hasCategory ? (r[5]||'') : (r[4]||'')
    }));
}

function getStages(ss) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  const s = ss.getSheetByName(SHEETS.STAGES);
  if (!s || s.getLastRow() <= 1) return [];
  const hasSubCol = s.getLastColumn() >= 4;
  const cols = hasSubCol ? 4 : 3;
  return s.getRange(2, 1, s.getLastRow()-1, cols).getValues()
    .filter(r => r[1])
    .sort((a,b) => a[2]-b[2])
    .map(r => ({ id:r[0], name:r[1], order:r[2], hasSub: hasSubCol ? !!r[3] : false }));
}

function getStageSubcats(ss) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  const s = ss.getSheetByName(SHEETS.STAGE_SUBCATS);
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

  // 製品名 → 企画名・製品or販促 のルックアップ（スケジュールマスターから）
  const schedSheet = ss.getSheetByName(SHEETS.SCHEDULES);
  const productToPlan = new Map();
  const productToCategory = new Map();
  if (schedSheet && schedSheet.getLastRow() > 1) {
    const hasCategory = schedSheet.getLastColumn() >= 6;
    const cols = hasCategory ? 6 : 5;
    schedSheet.getRange(2, 1, schedSheet.getLastRow()-1, cols).getValues()
      .forEach(r => {
        if (r[1]) {
          if (hasCategory) {
            productToCategory.set(r[1], r[2]||'');
            productToPlan.set(r[1], r[5]||'');
          } else {
            productToPlan.set(r[1], r[4]||'');
          }
        }
      });
  }

  rows.forEach(row => {
    const min   = Number(row.minutes) || 0;
    const ninku = parseFloat((min / MINUTES_PER_NINKU).toFixed(4));
    const cost  = Math.round(min * RATE_PER_MINUTE);
    const isSample = (row.type !== 'other');
    const planName = isSample ? (productToPlan.get(row.productName) || '') : '';
    const category = isSample ? (productToCategory.get(row.productName) || '') : '';
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
      planName,
      isSample ? (row.stageSubcat||'') : '',
      category
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
function addCraftsman(name, email, note) {
  if (!name) return { success:false, message:'名前を入力してください。' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const s  = ss.getSheetByName(SHEETS.CRAFTSMEN);
  s.appendRow(['C'+String(s.getLastRow()).padStart(3,'0'), name, note||'', email||'']);
  return { success:true, message:`${name} を追加しました。` };
}
function updateCraftsman(origName, name, email, note) {
  if (!name) return { success:false, message:'名前を入力してください。' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const s  = ss.getSheetByName(SHEETS.CRAFTSMEN);
  if (!s || s.getLastRow() <= 1) return { success:false, message:'データがありません。' };
  const data = s.getRange(2, 2, s.getLastRow()-1, 1).getValues();
  const idx  = data.findIndex(r => r[0] === origName);
  if (idx === -1) return { success:false, message:`「${origName}」が見つかりません。` };
  s.getRange(idx+2, 2, 1, 3).setValues([[name, note||'', email||'']]);
  return { success:true, message:`「${name}」を更新しました。` };
}
function deleteCraftsman(name) { return delRow(SHEETS.CRAFTSMEN, 2, name); }

function addSchedule(name, category, season, brand, plan) {
  if (!name) return { success:false, message:'製品名を入力してください。' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const s  = ss.getSheetByName(SHEETS.SCHEDULES);
  s.appendRow(['S'+String(s.getLastRow()).padStart(3,'0'), name, category||'製品', season||'', brand||'', plan||'']);
  return { success:true, message:`「${name}」を追加しました。` };
}
function deleteSchedule(name) { return delRow(SHEETS.SCHEDULES, 2, name); }

function updateSchedule(origName, name, category, season, brand, plan) {
  if (!name) return { success:false, message:'製品名を入力してください。' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const s  = ss.getSheetByName(SHEETS.SCHEDULES);
  if (!s || s.getLastRow() <= 1) return { success:false, message:'データがありません。' };
  const data = s.getRange(2, 2, s.getLastRow()-1, 1).getValues();
  const idx  = data.findIndex(r => r[0] === origName);
  if (idx === -1) return { success:false, message:`「${origName}」が見つかりません。` };
  s.getRange(idx+2, 2, 1, 5).setValues([[name, category||'製品', season||'', brand||'', plan||'']]);
  return { success:true, message:`「${name}」を更新しました。` };
}

function addStage(name, hasSub) {
  if (!name) return { success:false, message:'ステージ名を入力してください。' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const s  = ss.getSheetByName(SHEETS.STAGES);
  const order = s.getLastRow();
  s.appendRow(['ST'+order, name, order, hasSub ? true : false]);
  return { success:true, message:`ステージ「${name}」を追加しました。` };
}
function deleteStage(name)       { return delRow(SHEETS.STAGES,        2, name); }
function updateStage(origName, name, hasSub) {
  if (!name) return { success:false, message:'大分類名を入力してください。' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const s  = ss.getSheetByName(SHEETS.STAGES);
  if (!s || s.getLastRow() <= 1) return { success:false, message:'データがありません。' };
  const data = s.getRange(2, 2, s.getLastRow()-1, 1).getValues();
  const idx  = data.findIndex(r => r[0] === origName);
  if (idx === -1) return { success:false, message:`「${origName}」が見つかりません。` };
  s.getRange(idx+2, 2, 1, 3).setValues([[name, s.getRange(idx+2, 3).getValue(), hasSub ? true : false]]);
  return { success:true, message:`「${name}」を更新しました。` };
}
function addStageSubcat(name) {
  if (!name) return { success:false, message:'中分類名を入力してください。' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const s  = ss.getSheetByName(SHEETS.STAGE_SUBCATS);
  const order = s.getLastRow();
  s.appendRow(['SC'+order, name, order]);
  return { success:true, message:`中分類「${name}」を追加しました。` };
}
function deleteStageSubcat(name) { return delRow(SHEETS.STAGE_SUBCATS, 2, name); }
function updateStageSubcat(origName, name) {
  if (!name) return { success:false, message:'中分類名を入力してください。' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const s  = ss.getSheetByName(SHEETS.STAGE_SUBCATS);
  if (!s || s.getLastRow() <= 1) return { success:false, message:'データがありません。' };
  const data = s.getRange(2, 2, s.getLastRow()-1, 1).getValues();
  const idx  = data.findIndex(r => r[0] === origName);
  if (idx === -1) return { success:false, message:`「${origName}」が見つかりません。` };
  s.getRange(idx+2, 2).setValue(name);
  return { success:true, message:`「${name}」を更新しました。` };
}

function moveStage(name, dir)    { return moveItem_(SHEETS.STAGES,        2, 3, name, dir); }
function moveSubcat(name, dir)   { return moveItem_(SHEETS.STAGE_SUBCATS, 2, 3, name, dir); }
function moveWorkType(name, dir) { return moveItem_(SHEETS.WORK_TYPES,    2, 3, name, dir); }
function moveItem_(sheetName, nameCol, orderCol, name, dir) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const s  = ss.getSheetByName(sheetName);
  if (!s || s.getLastRow() <= 1) return { success:false, message:'データがありません。' };
  const data  = s.getRange(2, 1, s.getLastRow()-1, orderCol).getValues();
  const items = data.map((r,i) => ({ row:i+2, name:r[nameCol-1], order:Number(r[orderCol-1]) }))
                    .filter(r => r.name)
                    .sort((a,b) => a.order - b.order);
  const idx = items.findIndex(r => r.name === name);
  if (idx === -1) return { success:false, message:`「${name}」が見つかりません。` };
  const swapIdx = idx + dir;
  if (swapIdx < 0 || swapIdx >= items.length) return { success:false, message:'移動できません。' };
  const tmp = items[idx].order;
  s.getRange(items[idx].row,   orderCol).setValue(items[swapIdx].order);
  s.getRange(items[swapIdx].row, orderCol).setValue(tmp);
  return { success:true, message:'順番を変更しました。' };
}

function addWorkType(name) {
  if (!name) return { success:false, message:'種別名を入力してください。' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const s  = ss.getSheetByName(SHEETS.WORK_TYPES);
  if (!s) return { success:false, message:'シートが見つかりません。初期設定を実行してください。' };
  const order = s.getLastRow();
  s.appendRow(['WT'+order, name, order]);
  return { success:true, message:`種別「${name}」を追加しました。` };
}
function deleteWorkType(name) { return delRow(SHEETS.WORK_TYPES, 2, name); }
function updateWorkType(origName, name) {
  if (!name) return { success:false, message:'種別名を入力してください。' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const s  = ss.getSheetByName(SHEETS.WORK_TYPES);
  if (!s || s.getLastRow() <= 1) return { success:false, message:'データがありません。' };
  const data = s.getRange(2, 2, s.getLastRow()-1, 1).getValues();
  const idx  = data.findIndex(r => r[0] === origName);
  if (idx === -1) return { success:false, message:`「${origName}」が見つかりません。` };
  s.getRange(idx+2, 2).setValue(name);
  return { success:true, message:`「${name}」を更新しました。` };
}

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
