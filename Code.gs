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
    // 既存シートに製品or販促列を追加（先に列を挿入してからヘッダーと既定値を書く）
    s.insertColumns(3, 1);
    s.getRange(1, 3).setValue('製品or販促');
    if (s.getLastRow() > 1) s.getRange(2, 3, s.getLastRow()-1, 1).setValue('製品');
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
    s.appendRow(['ID', '中分類名', '順番', '分類']);
    header(s, 4);
    [
      ['SC1',  '型紙作成・修正',                  1,  '製作'],
      ['SC2',  '仮制作（部分サンプル・部分修正）', 2,  '製作'],
      ['SC3',  '本制作（型修正がない場合）',       3,  '製作'],
      ['SC4',  '抜き型作成',                      4,  '付帯業務'],
      ['SC5',  '原価表作成・修正',                5,  '付帯業務'],
      ['SC6',  '工程表作成・修正',                6,  '付帯業務'],
      ['SC7',  '引き継ぎ',                        7,  '付帯業務'],
      ['SC8',  'サンプル依頼ミーティング',         8,  '付帯業務'],
      ['SC9',  '裁断確認ミーティング',             9,  '付帯業務'],
      ['SC10', '製造開発ミーティング',            10, '付帯業務'],
      ['SC11', '色増しフィードバックミーティング', 11, '付帯業務'],
      ['SC12', '量産フィードバックミーティング',   12, '付帯業務'],
      ['SC13', 'サンプルチェック',                13, '付帯業務'],
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
      'ID', '製番', '日付', '職人名',
      '出勤時刻', '退勤時刻', '休憩(分)', '実働(分)',
      '種別', '製品名', 'フェーズ大分類', '作業種別',
      '作業時間(分)', '人工数', '労務費(円)',
      'メモ', '提出日時', '企画名', 'フェーズ中分類', '製品or販促'
    ]);
    header(s, 20);
    [3,4,9,10,14].forEach(c => s.setColumnWidth(c, 120));
    s.setColumnWidth(9, 220);
  } else if (s.getLastColumn() < 19) {
    s.getRange(1, 19).setValue('製品or販促');
    if (s.getLastColumn() < 18) {
      s.getRange(1, 18).setValue('フェーズ中分類');
    }
    if (s.getRange(1, 10).getValue() === 'フェーズ') {
      s.getRange(1, 10).setValue('フェーズ大分類');
    }
  }
  // 製番列: 無ければ末尾に追加し、B列（ID列の右）に無ければ移動する
  // （2026-08-05: 末尾追加からB列表示への変更。WeeklyReport.gs側のL定数と対で更新すること）
  {
    const lastCol = s.getLastColumn();
    const headers = s.getRange(1, 1, 1, Math.max(lastCol, 1)).getValues()[0];
    let seibanCol = headers.indexOf('製番') + 1;
    if (seibanCol === 0) {
      s.getRange(1, lastCol + 1).setValue('製番');
      seibanCol = lastCol + 1;
    }
    if (seibanCol !== 2) {
      s.moveColumns(s.getRange(1, seibanCol, s.getMaxRows()), 2);
      Logger.log('日報ログ: 製番列をB列に移動しました（元は' + seibanCol + '列目）');
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
    '抜き型作成',
  ];
  let order = lastRow;
  toAdd.forEach(name => {
    if (!data.includes(name)) {
      s.appendRow(['SC' + order, name, order]);
      order++;
    }
  });

  // D列「分類」（製作/付帯業務）の追加。未設定の行に既定値を入れる
  if (s.getRange(1, 4).getValue() !== '分類') {
    s.getRange(1, 4).setValue('分類');
    header(s, 4);
  }
  const SEISAKU = new Set([
    '型紙作成・修正', '型紙・抜き型作成/修正',
    '仮制作（部分サンプル・部分修正）', '本制作（型修正がない場合）',
  ]);
  const rows = s.getRange(2, 2, s.getLastRow() - 1, 3).getValues();  // B:名前 C:順番 D:分類
  rows.forEach((r, i) => {
    const name = String(r[0] || '').trim();
    const cls  = String(r[2] || '').trim();
    if (!name || cls === '製作' || cls === '付帯業務') return;
    s.getRange(i + 2, 4).setValue(SEISAKU.has(name) ? '製作' : '付帯業務');
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

// ================================================================
// 日報ログの列ズレ調査・修復（2026-08-05）
// 原因：B列に製番列を挿入した後、Webアプリが再デプロイされておらず、
// 旧デプロイ（B列追加前・19列）のsubmitReport()が新しい20列のシートに
// そのまま書き込み続けたため、B〜S列の値が実際より1列左にズレて保存された
// （T列＝製品or販促が空欄のまま残る）。
// 「C列（日付のはず）が日付に見えないのにB列は日付っぽい」行をズレ行とみなす。
// ================================================================

// 診断のみ（書き込みなし）。ズレていそうな行番号を一覧表示する
function debugFindShiftedLogRows() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const s  = ss.getSheetByName(SHEETS.LOGS);
  const lastRow = s.getLastRow();
  if (lastRow < 2) { Logger.log('データがありません'); return; }

  const vals = s.getRange(2, 1, lastRow - 1, 3).getValues();  // A:ID B:製番 C:日付
  const looksDate = v => v instanceof Date || /^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}$/.test(String(v).trim());

  const shifted = [];
  vals.forEach((r, i) => {
    if (looksDate(r[1]) && !looksDate(r[2])) shifted.push(i + 2);
  });

  Logger.log('=== 列ズレ疑いの行: ' + shifted.length + '件 ===');
  Logger.log(shifted.join('、') || 'なし');
  if (shifted.length > 0) {
    const sample = shifted.slice(0, 3);
    sample.forEach(row => {
      const r = s.getRange(row, 1, 1, 19).getValues()[0];
      Logger.log('行' + row + ' の中身（A〜S列）: ' + JSON.stringify(r));
    });
  }
}

// debugFindShiftedLogRows() で確認した行を修復する。
// B〜S列（18セル）の値をそのままC〜T列へ1列右にずらし、B列（製番）は
// 製品名から引き直して補完する（'その他'種別の行はB列を空欄のまま）
function fixShiftedLogRows() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const s  = ss.getSheetByName(SHEETS.LOGS);
  const lastRow = s.getLastRow();
  if (lastRow < 2) { Logger.log('データがありません'); return; }

  const vals = s.getRange(2, 1, lastRow - 1, 3).getValues();
  const looksDate = v => v instanceof Date || /^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}$/.test(String(v).trim());
  const shifted = [];
  vals.forEach((r, i) => { if (looksDate(r[1]) && !looksDate(r[2])) shifted.push(i + 2); });

  if (shifted.length === 0) { Logger.log('修復対象なし'); return; }

  // 製品名 → 製番 のルックアップ（submitReportと同じ要領）
  const schedSheet = ss.getSheetByName(SHEETS.SCHEDULES);
  const productToSeiban = new Map();
  if (schedSheet && schedSheet.getLastRow() > 1) {
    const seibanCol = getSeibanColumn_(schedSheet);
    if (seibanCol) {
      schedSheet.getRange(2, 1, schedSheet.getLastRow() - 1, seibanCol).getValues()
        .forEach(r => { if (r[1]) productToSeiban.set(r[1], r[seibanCol - 1] || ''); });
    }
  }

  shifted.forEach(row => {
    const bToS = s.getRange(row, 2, 1, 18).getValues()[0];  // 現在のB〜S列
    s.getRange(row, 3, 1, 18).setValues([bToS]);            // C〜T列へ1列右にずらす

    // 修復後のI列（種別）・J列（製品名）を見て製番を引き直す
    const type    = s.getRange(row, 9).getValue();
    const product = s.getRange(row, 10).getValue();
    const seiban  = (type === 'サンプル製造') ? (productToSeiban.get(product) || '') : '';
    s.getRange(row, 2).setValue(seiban);
  });

  Logger.log('修復完了: ' + shifted.length + '行（' + shifted.join('、') + '）');
}

// fixShiftedLogRows() で列をずらした際、休憩(分)の値が「時刻」表示形式のセルに
// 起因してDate型のまま読み書きされ、数値ではなく日付っぽい表示になってしまう
// ことがある（中身は壊れていないが表示がおかしい）。出勤時刻・退勤時刻・実働(分)
// から休憩(分)を計算し直し、プレーンな数値として書き込み直す（2026-08-05）
function fixBreakColumnFormat() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const s  = ss.getSheetByName(SHEETS.LOGS);
  const lastRow = s.getLastRow();
  if (lastRow < 2) { Logger.log('データがありません'); return; }

  const vals = s.getRange(2, 5, lastRow - 1, 4).getValues();  // E:出勤時刻 F:退勤時刻 G:休憩(分) H:実働(分)
  let fixed = 0;
  vals.forEach((r, i) => {
    const breakVal = r[2];
    if (!(breakVal instanceof Date)) return;  // 休憩(分)が日時型になっている行だけが対象
    const clockIn  = r[0];
    const clockOut = r[1];
    if (!(clockIn instanceof Date) || !(clockOut instanceof Date)) return;
    const row = i + 2;
    const spanMin   = Math.round((clockOut.getTime() - clockIn.getTime()) / 60000);
    const actualMin = Number(r[3]) || 0;
    const breakMin  = Math.max(0, spanMin - actualMin);
    s.getRange(row, 7).setNumberFormat('0').setValue(breakMin);
    fixed++;
    Logger.log('行' + row + ': 休憩(分)を' + breakMin + 'に修正');
  });
  Logger.log('休憩(分)フォーマット修復完了: ' + fixed + '行');
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

// スケジュール（製品マスタ）シートの「製番」列番号を返す（無ければnull）。
// 製番列はWeeklyReport.gs側（別Apps Scriptプロジェクト）が動的に追加するため、
// 列位置を固定せずヘッダー名で毎回探す（2026-08-05: ④日報側での製番記録のために追加）
function getSeibanColumn_(s) {
  const lastCol = s.getLastColumn();
  if (lastCol < 1) return null;
  const headers = s.getRange(1, 1, 1, lastCol).getValues()[0];
  const idx = headers.indexOf('製番');
  return idx === -1 ? null : idx + 1;
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
  const hasCls = s.getLastColumn() >= 4;
  const cols = hasCls ? 4 : 3;
  return s.getRange(2, 1, s.getLastRow()-1, cols).getValues()
    .filter(r => r[1])
    .sort((a,b) => a[2]-b[2])
    .map(r => ({ id:r[0], name:r[1], order:r[2], cls: hasCls ? (r[3]||'') : '' }));
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

  // 製品名 → 企画名・製品or販促・製番 のルックアップ（スケジュールマスターから）
  // 製番列はWeeklyReport.gs側（別Apps Scriptプロジェクト）が動的に追加するため列位置は固定しない
  const schedSheet = ss.getSheetByName(SHEETS.SCHEDULES);
  const productToPlan = new Map();
  const productToCategory = new Map();
  const productToSeiban = new Map();
  if (schedSheet && schedSheet.getLastRow() > 1) {
    const hasCategory = schedSheet.getLastColumn() >= 6;
    const seibanCol = getSeibanColumn_(schedSheet);
    const cols = Math.max(hasCategory ? 6 : 5, seibanCol || 0);
    schedSheet.getRange(2, 1, schedSheet.getLastRow()-1, cols).getValues()
      .forEach(r => {
        if (r[1]) {
          if (hasCategory) {
            productToCategory.set(r[1], r[2]||'');
            productToPlan.set(r[1], r[5]||'');
          } else {
            productToPlan.set(r[1], r[4]||'');
          }
          if (seibanCol) productToSeiban.set(r[1], r[seibanCol-1] || '');
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
    const seiban   = isSample ? (productToSeiban.get(row.productName) || '') : '';
    sheet.appendRow([
      Utilities.getUuid(),
      seiban,
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

// ================================================================
// スケジュールシートの列ずれ修復（GASエディタから1回のみ実行）
// 「製品or販促」列の追加後、旧バージョンのデプロイから登録・修正された行は
// C列にシーズン値が入るなど1列ずれて保存されている。該当行を右に1列ずらして
// C列を「製品」に戻し、ヘッダーも正しい並びに直す。
// ================================================================
function fixScheduleCategoryColumn() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const s  = ss.getSheetByName(SHEETS.SCHEDULES);
  if (!s) { Logger.log('スケジュールシートが見つかりません'); return; }

  // ヘッダーを正しい並びに強制（列追加バグでC1が空・D1が製品or販促になっている場合も直る）
  s.getRange(1, 1, 1, 6).setValues([['ID', '製品名', '製品or販促', 'シーズン・型振・VMD', 'ブランド', '企画名']]);

  if (s.getLastRow() <= 1) { Logger.log('データ行なし'); return; }
  const rows = s.getRange(2, 1, s.getLastRow() - 1, 6).getValues();
  let fixed = 0;
  rows.forEach((r, i) => {
    if (!r[1]) return;
    const c = String(r[2] || '').trim();
    if (c === '' || c === '製品' || c === '販促') return;  // 正常な行
    // C列に区分以外の値が入っている＝1列ずれ行。右に1列ずらして修復
    s.getRange(i + 2, 3, 1, 4).setValues([['製品', r[2], r[3], r[4]]]);
    fixed++;
    Logger.log('修復: ' + r[1] + '（区分列の値「' + c + '」をシーズンへ移動）');
  });
  Logger.log('fixScheduleCategoryColumn 完了: ' + fixed + '行を修復（修復後、販促物は製品管理から「販促」に設定し直してください）');
}

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
function addStageSubcat(name, cls) {
  if (!name) return { success:false, message:'中分類名を入力してください。' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const s  = ss.getSheetByName(SHEETS.STAGE_SUBCATS);
  const order = s.getLastRow();
  s.appendRow(['SC'+order, name, order, cls === '付帯業務' ? '付帯業務' : '製作']);
  return { success:true, message:`中分類「${name}」を追加しました。` };
}
function deleteStageSubcat(name) { return delRow(SHEETS.STAGE_SUBCATS, 2, name); }
function updateStageSubcat(origName, name, cls) {
  if (!name) return { success:false, message:'中分類名を入力してください。' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const s  = ss.getSheetByName(SHEETS.STAGE_SUBCATS);
  if (!s || s.getLastRow() <= 1) return { success:false, message:'データがありません。' };
  const data = s.getRange(2, 2, s.getLastRow()-1, 1).getValues();
  const idx  = data.findIndex(r => r[0] === origName);
  if (idx === -1) return { success:false, message:`「${origName}」が見つかりません。` };
  s.getRange(idx+2, 2).setValue(name);
  if (cls === '製作' || cls === '付帯業務') s.getRange(idx+2, 4).setValue(cls);
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
