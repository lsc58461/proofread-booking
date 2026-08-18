/**
 * 첨삭 신청 — Apps Script JSON API
 *
 * 구글시트를 원본으로 두고, 신청은 이 API 를 통해서만 받는다.
 * 동시 신청은 LockService 전역 락으로 직렬화하므로 덮어쓰기가 발생하지 않는다.
 *
 * 락 구간에서는 ScriptProperties 의 점유 현황만 갱신하고(≈100ms),
 * 시트에 이름을 쓰는 작업은 락을 푼 뒤에 한다. 승패는 락 안에서 이미
 * 결정되므로 시트 반영이 수백 ms 늦어도 결과는 달라지지 않는다.
 *
 * 호출자는 Next.js 서버뿐이며 API_TOKEN 으로 인증한다. 관리자 비밀번호
 * 검사는 Next.js 쪽에서 끝내므로 여기서는 토큰만 확인한다.
 */

var PROPS = PropertiesService.getScriptProperties();

var K_CONFIG = 'CONFIG';
var K_TOKEN  = 'API_TOKEN';
// 자리 하나당 속성 하나(CLAIM_c4r12). 여러 자리를 한 속성에 모으면
// 읽고-고쳐-쓰는 사이에 다른 실행이 끼어들어 기록이 사라진다. 락으로 순서를
// 맞춰도 PropertiesService 가 방금 쓴 값을 곧바로 보여준다는 보장이 없어서다.
var CLAIM_PFX  = 'CLAIM_';
var GRID_CACHE = 'GRID_V1';
var GRID_TTL   = 300;        // 초. 시트 색상/구조 캐시
var LOCK_WAIT  = 25000;      // ms

var DEFAULT_CONFIG = {
  title: '첨삭 신청',
  notice: '',
  sheetUrl: '',
  sheetName: '',
  openCols: [],      // 신청을 받을 날짜 열 번호(1-based)
  openAt: 0,         // epoch ms. 0이면 제한 없음
  closeAt: 0,
  blocked: false     // true 면 신청·관리자 화면을 없는 페이지처럼 막는다
};

/* ─────────────────────────── 진입점 ─────────────────────────── */

function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_(fail_('요청 형식이 올바르지 않습니다.'));
  }

  var expected = PROPS.getProperty(K_TOKEN);
  if (!expected) return json_(fail_('API_TOKEN 이 설정되지 않았습니다.'));
  if (String(body.token || '') !== expected) return json_(fail_('unauthorized'));

  var handler = ROUTES[body.action];
  if (!handler) return json_(fail_('알 수 없는 요청입니다: ' + body.action));

  // 차단 중에는 관리자 동작도 막는다. 해제는 gate.* 로만 가능하다.
  if (String(body.action).indexOf('admin.') === 0 && getConfig_().blocked) {
    return json_({ ok: false, blocked: true, message: '차단된 상태입니다.' });
  }

  try {
    return json_(handler(body));
  } catch (err) {
    console.error(body.action + ' 실패: ' + (err && err.stack ? err.stack : err));
    var msg = String((err && err.message) || err);
    // 동시 요청이 몰릴 때 나오는 구글 원문 오류는 그대로 노출하지 않는다.
    if (msg.indexOf('LockService') >= 0 || msg.indexOf('too many') >= 0) {
      return json_(retryable_('접속이 몰리고 있어요. 잠시 후 다시 시도해 주세요.'));
    }
    return json_(fail_(msg));
  }
}

/** 배포 확인용. 실제 동작은 전부 doPost 로 처리한다. */
function doGet() {
  return json_({ ok: true, service: 'proofread-booking', ts: Date.now() });
}

var ROUTES = {
  'state':          function (b) { return apiState(); },
  'taken':          function (b) { return apiTaken(); },
  'claim':          function (b) { return apiClaim(b.payload || {}); },
  'admin.load':     function (b) { return apiAdminLoad(); },
  'admin.inspect':  function (b) { return apiAdminInspect(b.sheetUrl, b.sheetName); },
  'admin.preview':  function (b) { return apiAdminPreview(b.config || {}); },
  'admin.save':     function (b) { return apiAdminSave(b.config || {}); },
  'admin.claims':   function (b) { return apiAdminClaims(); },
  'admin.delete':   function (b) { return apiAdminDelete(b.slot); },
  'admin.sync':     function (b) { return apiAdminSyncToSheet(); },
  'admin.import':   function (b) { return apiAdminImportFromSheet(); },
  'admin.reset':    function (b) { return apiAdminResetAll(); },
  'admin.refresh':  function (b) { return apiAdminRefreshGrid(); },
  'admin.bench':    function (b) { return apiAdminBench(); },
  'gate.status':    function (b) { return { ok: true, blocked: !!getConfig_().blocked }; },
  'gate.set':       function (b) { return apiGateSet(b.blocked); }
};

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function fail_(message) { return { ok: false, message: message }; }

/** 잠시 뒤 다시 보내면 성공할 수 있는 실패. 호출한 쪽이 재시도한다. */
function retryable_(message) { return { ok: false, retryable: true, message: message }; }

/** 최초 1회 편집기에서 직접 실행해 토큰을 심는다. 실행 로그에 값이 찍힌다. */
function setupToken() {
  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  PROPS.setProperty(K_TOKEN, token);
  Logger.log('GAS_TOKEN=' + token);
  return token;
}

/* ─────────────────────────── 설정 ─────────────────────────── */

function getConfig_() {
  var raw = PROPS.getProperty(K_CONFIG);
  var cfg = {};
  Object.keys(DEFAULT_CONFIG).forEach(function (k) { cfg[k] = DEFAULT_CONFIG[k]; });
  if (raw) {
    try {
      var saved = JSON.parse(raw);
      Object.keys(saved).forEach(function (k) { cfg[k] = saved[k]; });
    } catch (err) { /* 손상된 설정은 기본값으로 대체 */ }
  }
  return cfg;
}

function saveConfig_(cfg) {
  PROPS.setProperty(K_CONFIG, JSON.stringify(cfg));
  dropGridCache_();
}

/* ─────────────────────────── 점유 현황 ─────────────────────────── */

function slotKey_(col, row) { return 'c' + col + 'r' + row; }

function parseSlot_(key) {
  var m = /^c(\d+)r(\d+)$/.exec(String(key || ''));
  return m ? { col: Number(m[1]), row: Number(m[2]) } : null;
}

function claimKey_(slot) { return CLAIM_PFX + slot; }

/** 전체 신청 내역. { slotKey: {name, id, ts} } — 속성 읽기 1회 */
function getAllClaims_() {
  var all = PROPS.getProperties();
  var out = {};
  Object.keys(all).forEach(function (k) {
    if (k.indexOf(CLAIM_PFX) !== 0) return;
    var slot = k.substring(CLAIM_PFX.length);
    if (!parseSlot_(slot)) return;      // 예전 형식의 키는 무시한다
    try { out[slot] = JSON.parse(all[k]); }
    catch (err) { /* 손상된 항목은 건너뛴다 */ }
  });
  return out;
}

function normName_(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }

function maskName_(name) {
  var s = normName_(name);
  if (s.length <= 1) return s;
  if (s.length === 2) return s.charAt(0) + '*';
  return s.charAt(0) + new Array(s.length - 1).join('*') + s.charAt(s.length - 1);
}

/* ─────────────────────────── 시트 읽기 ─────────────────────────── */

function openSheet_(cfg) {
  if (!cfg.sheetUrl) throw new Error('시트 주소가 설정되지 않았습니다.');
  var ss = SpreadsheetApp.openByUrl(cfg.sheetUrl);
  var sh = cfg.sheetName ? ss.getSheetByName(cfg.sheetName) : ss.getSheets()[0];
  if (!sh) throw new Error('시트 탭을 찾을 수 없습니다: ' + cfg.sheetName);
  return sh;
}

function colLetter_(n) {
  var s = '';
  while (n > 0) {
    var r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = (n - 1 - r) / 26;
  }
  return s;
}

/** backgroundColor 는 값이 0인 채널을 생략하므로 빠진 값은 0으로 본다. */
function isWhite_(c) {
  if (!c) return false;
  var v = function (x) { return x === undefined || x === null ? 0 : x; };
  return v(c.red) === 1 && v(c.green) === 1 && v(c.blue) === 1;
}

/**
 * 칸별 배경 상태를 읽는다. { white: 흰색인가, explicit: 직접 칠했는가 }
 *
 * SpreadsheetApp.getBackgrounds() 는 "흰색으로 칠한 칸"과 "한 번도 칠한 적 없는 칸"을
 * 모두 #ffffff 로 돌려준다. 둘 다 열긴 하지만, 후자가 몇 개인지는 관리자에게
 * 알려줘야 칠하다 빠뜨린 칸을 발견할 수 있으므로 userEnteredFormat 으로 구분한다.
 */
function readPaint_(sh, lastRow, lastCol) {
  var a1 =
    "'" + sh.getName().replace(/'/g, "''") + "'!A1:" + colLetter_(lastCol) + lastRow;
  try {
    var resp = Sheets.Spreadsheets.get(sh.getParent().getId(), {
      ranges: [a1],
      fields:
        'sheets(data(rowData(values(userEnteredFormat(backgroundColor),effectiveFormat(backgroundColor)))))'
    });
    var rows = (((((resp.sheets || [])[0] || {}).data || [])[0] || {}).rowData) || [];
    var out = [];
    for (var r = 0; r < lastRow; r++) {
      var cells = ((rows[r] || {}).values) || [];
      var line = [];
      for (var c = 0; c < lastCol; c++) {
        var cell = cells[c] || {};
        var eff = cell.effectiveFormat && cell.effectiveFormat.backgroundColor;
        var ue = cell.userEnteredFormat && cell.userEnteredFormat.backgroundColor;
        // 서식이 전혀 없는 칸은 응답에서 항목째로 빠진다. 셀 기본 배경은 흰색이므로
        // 값이 없으면 흰색으로 본다(검은색은 채널이 모두 생략된 객체로 들어온다).
        line.push({ white: eff ? isWhite_(eff) : true, explicit: !!ue });
      }
      out.push(line);
    }
    return { cells: out, exact: true };
  } catch (err) {
    // 고급 서비스를 못 쓰는 환경에서는 예전 방식으로 동작한다(구분 불가).
    console.error('Sheets 고급 서비스 사용 실패, getBackgrounds 로 대체: ' + err);
    var bgs = sh.getRange(1, 1, lastRow, lastCol).getBackgrounds();
    return {
      cells: bgs.map(function (row) {
        return row.map(function (b) {
          return { white: String(b || '').toLowerCase() === '#ffffff', explicit: true };
        });
      }),
      exact: false
    };
  }
}

/**
 * 시트에서 날짜/시간 축과 신청 가능 칸을 읽어온다.
 * 화면에서 흰색으로 보이는 칸만 신청 대상으로 본다(회색·주황은 제외).
 * 이미 이름이 적혀 있는 칸은 신청 완료로 취급한다.
 */
function readGrid_(cfg) {
  var sh = openSheet_(cfg);
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 2) throw new Error('시트에 데이터가 없습니다.');

  var values = sh.getRange(1, 1, lastRow, lastCol).getDisplayValues();
  var paint = readPaint_(sh, lastRow, lastCol);

  var dates = [];
  for (var c = 2; c <= lastCol; c++) {
    var label = normName_(values[0][c - 1]);
    if (label) dates.push({ col: c, label: label });
  }

  var times = [];
  for (var r = 2; r <= lastRow; r++) {
    var t = normName_(values[r - 1][0]);
    if (t) times.push({ row: r, label: t });
  }

  var openCols = {};
  (cfg.openCols || []).forEach(function (c) { openCols[Number(c)] = true; });

  var open = [];
  var pre = {};
  var raw = {};
  var unpainted = 0;   // 흰색이지만 배경색을 지정한 적은 없는 칸 — 관리자에게 알려줄 값
  dates.forEach(function (d) {
    if (!openCols[d.col]) return;
    times.forEach(function (t) {
      var p = paint.cells[t.row - 1][d.col - 1];
      if (!p || !p.white) return;                // 회색·주황 등은 제외
      // 배경색을 지정한 적 없는 칸도 화면에서는 흰색으로 보이므로 같이 연다.
      // 정리하지 않은 날짜 열이 통째로 열리는 것은 관리자가 열을 직접 고르는 단계에서 막힌다.
      if (!p.explicit) unpainted++;
      var key = slotKey_(d.col, t.row);
      var cell = normName_(values[t.row - 1][d.col - 1]);
      if (cell) {                                // 시트에 이미 적힌 신청
        pre[key] = maskName_(cell);
        raw[key] = cell;
      }
      open.push(key);
    });
  });

  return {
    dates: dates,
    times: times,
    open: open,
    pre: pre,
    raw: raw,
    unpainted: unpainted,
    exact: paint.exact
  };
}

function getGrid_(force) {
  var cache = CacheService.getScriptCache();
  if (!force) {
    var hit = cache.get(GRID_CACHE);
    if (hit) {
      try { return JSON.parse(hit); } catch (err) { /* 캐시 손상 시 재조회 */ }
    }
  }
  var grid = readGrid_(getConfig_());
  try { cache.put(GRID_CACHE, JSON.stringify(grid), GRID_TTL); }
  catch (err) { /* 100KB 초과 시 캐시 생략 */ }
  return grid;
}

function dropGridCache_() { CacheService.getScriptCache().remove(GRID_CACHE); }

/* ─────────────────────────── 신청자용 ─────────────────────────── */

function mergeTaken_(pre, claims) {
  var out = {};
  Object.keys(pre).forEach(function (k) { out[k] = pre[k]; });
  Object.keys(claims).forEach(function (k) { out[k] = maskName_(claims[k].name); });
  return out;
}

function apiState() {
  var cfg = getConfig_();
  if (cfg.blocked) return { ok: true, blocked: true, now: Date.now() };
  if (!cfg.sheetUrl || !(cfg.openCols || []).length) {
    return { ok: true, ready: false, now: Date.now(), title: cfg.title, message: '아직 신청이 열리지 않았습니다.' };
  }
  var grid;
  try {
    grid = getGrid_(false);
  } catch (err) {
    return { ok: true, ready: false, now: Date.now(), title: cfg.title, message: '시트를 불러올 수 없습니다. 관리자에게 문의해 주세요.' };
  }
  // 신청 가능한 칸이 하나도 없는 날짜·시간은 내려보내지 않는다.
  // 그대로 두면 열지 않은 날짜 열과 빈 시간대가 표에 빈 칸으로 잔뜩 남는다.
  var colsUsed = {}, rowsUsed = {};
  grid.open.forEach(function (k) {
    var p = parseSlot_(k);
    colsUsed[p.col] = true;
    rowsUsed[p.row] = true;
  });

  return {
    ok: true,
    ready: true,
    title: cfg.title,
    notice: cfg.notice,
    openAt: cfg.openAt,
    closeAt: cfg.closeAt,
    now: Date.now(),
    dates: grid.dates.filter(function (d) { return colsUsed[d.col]; }),
    times: grid.times.filter(function (t) { return rowsUsed[t.row]; }),
    open: grid.open,
    taken: mergeTaken_(grid.pre, getAllClaims_())
  };
}

/** 폴링용 경량 응답 */
function apiTaken() {
  if (getConfig_().blocked) return { ok: true, blocked: true, now: Date.now(), taken: {} };
  var grid;
  try { grid = getGrid_(false); }
  catch (err) { return { ok: true, now: Date.now(), taken: {} }; }
  return { ok: true, now: Date.now(), taken: mergeTaken_(grid.pre, getAllClaims_()) };
}

function apiClaim(payload) {
  var name  = normName_(payload.name);
  var last4 = String(payload.last4 || '').trim();
  var slot  = String(payload.slot || '');

  if (name.length < 2 || name.length > 20) return fail_('이름을 2자 이상 정확히 입력해 주세요.');
  if (!/^\d{4}$/.test(last4)) return fail_('연락처 뒤 4자리를 입력해 주세요.');
  var parsed = parseSlot_(slot);
  if (!parsed) return fail_('시간을 다시 선택해 주세요.');

  var cfg = getConfig_();
  if (cfg.blocked) return fail_('신청을 받고 있지 않습니다.');
  var now = Date.now();
  if (cfg.openAt && now < cfg.openAt) return fail_('아직 신청 시작 전입니다.');
  if (cfg.closeAt && now > cfg.closeAt) return fail_('신청이 마감되었습니다.');

  var grid;
  try { grid = getGrid_(false); }
  catch (err) { return fail_('시트를 불러올 수 없습니다. 관리자에게 문의해 주세요.'); }
  if (grid.open.indexOf(slot) < 0) return fail_('신청할 수 없는 시간입니다.');
  if (grid.pre[slot]) return fail_('이미 신청된 시간입니다.');

  var id = name + '|' + last4;
  var lock = LockService.getScriptLock();
  var got = false;
  try {
    got = lock.tryLock(LOCK_WAIT);
  } catch (err) {
    // 동시 요청이 많으면 tryLock 자체가 "too many LockService operations" 로 던진다.
    // 원문 그대로 두면 영문 오류가 신청자에게 노출되므로 재시도 대상으로 표시한다.
    return retryable_('신청이 몰리고 있어요. 잠시 후 다시 시도해 주세요.');
  }
  if (!got) return retryable_('신청이 몰리고 있어요. 잠시 후 다시 시도해 주세요.');

  var result;
  try {
    // 속성 읽기 1회 + 쓰기 1회. 락을 잡고 있는 동안 그 이상은 하지 않는다.
    var claims = getAllClaims_();
    if (claims[slot]) {
      // 같은 사람이 같은 자리를 다시 보냈다면 응답이 유실된 뒤의 재시도로 본다.
      // 성공으로 돌려줘야 클라이언트가 안심하고 재시도할 수 있다.
      result = claims[slot].id === id
        ? { ok: true, slot: slot, repeated: true }
        : fail_('방금 마감되었습니다. 다른 시간을 선택해 주세요.');
    } else if (Object.keys(claims).some(function (k) { return claims[k].id === id; })) {
      result = fail_('이미 신청하신 시간이 있습니다. 변경하려면 담당자에게 문의해 주세요.');
    } else {
      PROPS.setProperty(claimKey_(slot), JSON.stringify({
        name: name, id: id, ts: new Date().toISOString()
      }));
      result = { ok: true, slot: slot };
    }
  } finally {
    lock.releaseLock();
  }

  if (result.ok) writeCell_(cfg, parsed, name);   // 락 밖에서 시트 반영
  return result;
}

/** 시트 반영. 실패해도 신청은 유효하며 관리자 페이지의 '시트 다시 맞추기'로 복구한다. */
function writeCell_(cfg, parsed, value) {
  try {
    openSheet_(cfg).getRange(parsed.row, parsed.col).setValue(value);
  } catch (err) {
    console.error('시트 반영 실패: ' + slotKey_(parsed.col, parsed.row) + ' / ' + err);
  }
}

/* ─────────────────────────── 관리자용 ─────────────────────────── */

function apiAdminLoad() {
  var cfg = getConfig_();
  var out = {
    ok: true, config: cfg, now: Date.now(), sheets: [], dates: [],
    openCount: 0, preCount: 0, unpainted: 0, exact: true, error: ''
  };
  if (!cfg.sheetUrl) return out;
  try {
    out.sheets = SpreadsheetApp.openByUrl(cfg.sheetUrl).getSheets().map(function (s) { return s.getName(); });
    var grid = readGrid_(cfg);
    out.dates = grid.dates;
    out.openCount = grid.open.length;
    out.preCount = Object.keys(grid.pre).length;
    out.unpainted = grid.unpainted;
    out.exact = grid.exact;
  } catch (err) {
    out.error = String((err && err.message) || err);
  }
  return out;
}

/** 시트 주소·탭만 먼저 확인해서 날짜 열 목록을 돌려준다(설정 저장 전 단계). */
function apiAdminInspect(sheetUrl, sheetName) {
  var probe = {
    sheetUrl: String(sheetUrl || '').trim(),
    sheetName: String(sheetName || '').trim(),
    openCols: []
  };
  var sheets = SpreadsheetApp.openByUrl(probe.sheetUrl).getSheets().map(function (s) { return s.getName(); });
  if (!probe.sheetName) probe.sheetName = sheets[0];
  var grid = readGrid_(probe);
  return { ok: true, sheets: sheets, sheetName: probe.sheetName, dates: grid.dates, timeCount: grid.times.length };
}

/** 선택한 열 기준으로 실제 열릴 칸 수를 세어본다. */
function apiAdminPreview(cfgIn) {
  var grid = readGrid_({
    sheetUrl: String(cfgIn.sheetUrl || '').trim(),
    sheetName: String(cfgIn.sheetName || '').trim(),
    openCols: (cfgIn.openCols || []).map(Number)
  });
  return {
    ok: true,
    openCount: grid.open.length,
    preCount: Object.keys(grid.pre).length,
    unpainted: grid.unpainted,
    exact: grid.exact
  };
}

function apiAdminSave(cfgIn) {
  var cfg = getConfig_();
  cfg.title       = normName_(cfgIn.title) || DEFAULT_CONFIG.title;
  cfg.notice      = String(cfgIn.notice || '').trim();
  cfg.sheetUrl    = String(cfgIn.sheetUrl || '').trim();
  cfg.sheetName   = String(cfgIn.sheetName || '').trim();
  cfg.openCols    = (cfgIn.openCols || []).map(Number).filter(function (n) { return n > 1; });
  cfg.openAt      = Number(cfgIn.openAt) || 0;
  cfg.closeAt     = Number(cfgIn.closeAt) || 0;
  if (cfg.closeAt && cfg.openAt && cfg.closeAt <= cfg.openAt) return fail_('마감 시간이 오픈 시간보다 빠릅니다.');
  saveConfig_(cfg);
  return { ok: true, config: cfg };
}

function apiAdminClaims() {
  var claims = getAllClaims_();
  var grid;
  try { grid = getGrid_(false); } catch (err) { grid = { dates: [], times: [] }; }
  var dateBy = {}, timeBy = {};
  grid.dates.forEach(function (d) { dateBy[d.col] = d.label; });
  grid.times.forEach(function (t) { timeBy[t.row] = t.label; });

  var rows = Object.keys(claims).map(function (k) {
    var p = parseSlot_(k);
    return {
      slot: k,
      date: dateBy[p.col] || ('열 ' + p.col),
      time: timeBy[p.row] || ('행 ' + p.row),
      name: claims[k].name,
      phone: String(claims[k].id || '').split('|')[1] || '',
      ts: claims[k].ts
    };
  });
  rows.sort(function (a, b) { return String(a.ts).localeCompare(String(b.ts)); });
  return { ok: true, rows: rows, total: rows.length };
}

function apiAdminDelete(slot) {
  var parsed = parseSlot_(slot);
  if (!parsed) return fail_('잘못된 요청입니다.');
  PROPS.deleteProperty(claimKey_(slot));   // 자리마다 키가 따로라 락이 필요 없다
  writeCell_(getConfig_(), parsed, '');
  dropGridCache_();
  return { ok: true };
}

/**
 * 신청 내역을 기준으로 시트를 다시 맞춘다.
 *
 * 열 단위로 한 번에 쓰면 열린 칸 사이에 낀 회색 칸까지 범위에 들어가는데,
 * 운영자가 그 칸들을 보호해 두는 경우가 있어 한 칸만 막혀도 열 전체가 실패한다.
 * 그래서 값이 달라진 칸만 낱개로 쓰고, 막힌 칸은 세어서 알려준다.
 */
function apiAdminSyncToSheet() {
  var cfg = getConfig_();
  var claims = getAllClaims_();
  var sh = openSheet_(cfg);
  var grid = getGrid_(true);

  var byCol = {};
  grid.open.forEach(function (k) {
    var p = parseSlot_(k);
    (byCol[p.col] = byCol[p.col] || []).push(p.row);
  });

  var written = 0;
  var blocked = 0;
  Object.keys(byCol).forEach(function (colStr) {
    var col = Number(colStr);
    var rows = byCol[colStr];
    var minR = Math.min.apply(null, rows);
    var maxR = Math.max.apply(null, rows);
    // 읽기는 보호와 무관하므로 현재 값은 한 번에 가져온다.
    var vals = sh.getRange(minR, col, maxR - minR + 1, 1).getValues();
    rows.forEach(function (r) {
      var c = claims[slotKey_(col, r)];
      var next = c ? c.name : '';
      if (normName_(vals[r - minR][0]) === next) return;
      try {
        sh.getRange(r, col).setValue(next);
        written++;
      } catch (err) {
        blocked++;
      }
    });
  });
  dropGridCache_();
  return { ok: true, written: written, blocked: blocked };
}

/** 시트를 직접 고친 뒤, 시트 내용을 정답으로 삼아 신청 현황을 다시 만든다. */
function apiAdminImportFromSheet() {
  var grid = getGrid_(true);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT)) return fail_('잠시 후 다시 시도해 주세요.');

  var imported = 0;
  try {
    clearClaims_();
    var stamp = new Date().toISOString();
    var batch = {};
    Object.keys(grid.raw).forEach(function (k) {
      // 시트에는 이름만 있어 연락처를 알 수 없다. 같은 이름으로 다시 신청하는 것을
      // 막으려면 식별자가 필요하므로 자리표시자를 넣는다.
      batch[claimKey_(k)] = JSON.stringify({
        name: grid.raw[k], id: grid.raw[k] + '|----', ts: stamp
      });
      imported++;
    });
    if (imported) PROPS.setProperties(batch);
  } finally {
    lock.releaseLock();
  }
  dropGridCache_();
  return { ok: true, imported: imported };
}

function clearClaims_() {
  var all = PROPS.getProperties();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf(CLAIM_PFX) === 0) PROPS.deleteProperty(k);
  });
}

function apiAdminResetAll() {
  clearClaims_();
  dropGridCache_();
  return { ok: true };
}

function apiAdminRefreshGrid() {
  dropGridCache_();
  var grid = getGrid_(true);
  return { ok: true, openCount: grid.open.length };
}

/** 사이트 차단 여부를 바꾼다. 관리자 비밀번호와 분리된 별도 화면에서만 호출한다. */
function apiGateSet(blocked) {
  var cfg = getConfig_();
  cfg.blocked = !!blocked;
  saveConfig_(cfg);
  return { ok: true, blocked: cfg.blocked };
}

/**
 * 저장소 연산별 실제 비용 측정. 어디에 신청 현황을 두어야 하는지 판단하기 위한 것으로,
 * 운영 중에는 호출하지 않는다. 시트에는 쓰지 않는다.
 */
function apiAdminBench() {
  var out = [];
  function mark(label, fn) {
    var t0 = Date.now();
    var v;
    try { v = fn(); }
    catch (err) { out.push({ op: label, ms: Date.now() - t0, error: String(err) }); return null; }
    out.push({ op: label, ms: Date.now() - t0 });
    return v;
  }

  var cache = CacheService.getScriptCache();
  var probe = 'BENCH_' + Date.now();

  mark('PROPS.getProperties (전체)', function () { return PROPS.getProperties(); });
  mark('PROPS.getProperty (1개)',    function () { return PROPS.getProperty(K_CONFIG); });
  mark('PROPS.setProperty (1개)',    function () { PROPS.setProperty(probe, 'x'); });
  mark('PROPS.setProperty (2회차)',  function () { PROPS.setProperty(probe, 'y'); });
  mark('PROPS.deleteProperty',       function () { PROPS.deleteProperty(probe); });

  mark('CACHE.get',  function () { return cache.get(probe); });
  mark('CACHE.put',  function () { cache.put(probe, 'x', 60); });
  mark('CACHE.get (적중)', function () { return cache.get(probe); });
  cache.remove(probe);

  mark('LockService 잡고 풀기', function () {
    var l = LockService.getScriptLock();
    l.tryLock(5000);
    l.releaseLock();
  });

  var cfg = getConfig_();
  if (cfg.sheetUrl) {
    var sh = mark('SpreadsheetApp.openByUrl', function () { return openSheet_(cfg); });
    if (sh) {
      mark('sheet.getRange().getValue()', function () { return sh.getRange(2, 2).getValue(); });
      mark('sheet 한 열 getValues()', function () { return sh.getRange(2, 2, 37, 1).getValues(); });
    }
  }

  return { ok: true, timings: out };
}
