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
var CLAIM_PFX  = 'CLAIM_';   // CLAIM_<열번호> 로 샤딩 (속성 1개당 9KB 제한 회피)
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
  allowCancel: true
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

  try {
    return json_(handler(body));
  } catch (err) {
    console.error(body.action + ' 실패: ' + (err && err.stack ? err.stack : err));
    return json_(fail_(String((err && err.message) || err)));
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
  'cancel':         function (b) { return apiCancel(b.payload || {}); },
  'admin.load':     function (b) { return apiAdminLoad(); },
  'admin.inspect':  function (b) { return apiAdminInspect(b.sheetUrl, b.sheetName); },
  'admin.preview':  function (b) { return apiAdminPreview(b.config || {}); },
  'admin.save':     function (b) { return apiAdminSave(b.config || {}); },
  'admin.claims':   function (b) { return apiAdminClaims(); },
  'admin.delete':   function (b) { return apiAdminDelete(b.slot); },
  'admin.sync':     function (b) { return apiAdminSyncToSheet(); },
  'admin.import':   function (b) { return apiAdminImportFromSheet(); },
  'admin.reset':    function (b) { return apiAdminResetAll(); },
  'admin.refresh':  function (b) { return apiAdminRefreshGrid(); }
};

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function fail_(message) { return { ok: false, message: message }; }

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

function shardKey_(col) { return CLAIM_PFX + col; }

function readShard_(col) {
  try { return JSON.parse(PROPS.getProperty(shardKey_(col)) || '{}'); }
  catch (err) { return {}; }
}

/** 전체 신청 내역. { slotKey: {name, id, ts} } */
function getAllClaims_() {
  var all = PROPS.getProperties();
  var out = {};
  Object.keys(all).forEach(function (k) {
    if (k.indexOf(CLAIM_PFX) !== 0) return;
    try {
      var shard = JSON.parse(all[k] || '{}');
      Object.keys(shard).forEach(function (s) { out[s] = shard[s]; });
    } catch (err) { /* 손상된 샤드는 건너뛴다 */ }
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

/**
 * 시트에서 날짜/시간 축과 신청 가능 칸을 읽어온다.
 * 배경이 흰색인 칸만 신청 가능으로 본다(회색·주황 등은 제외).
 * 이미 이름이 적혀 있는 칸은 신청 완료로 취급한다.
 */
function readGrid_(cfg) {
  var sh = openSheet_(cfg);
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 2) throw new Error('시트에 데이터가 없습니다.');

  var range = sh.getRange(1, 1, lastRow, lastCol);
  var values = range.getDisplayValues();
  var bgs = range.getBackgrounds();

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
  dates.forEach(function (d) {
    if (!openCols[d.col]) return;
    times.forEach(function (t) {
      var bg = String(bgs[t.row - 1][d.col - 1] || '').toLowerCase();
      if (bg !== '#ffffff') return;              // 흰색 칸만 신청 대상
      var key = slotKey_(d.col, t.row);
      var cell = normName_(values[t.row - 1][d.col - 1]);
      if (cell) {                                // 시트에 이미 적힌 신청
        pre[key] = maskName_(cell);
        raw[key] = cell;
      }
      open.push(key);
    });
  });

  return { dates: dates, times: times, open: open, pre: pre, raw: raw };
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
  if (!cfg.sheetUrl || !(cfg.openCols || []).length) {
    return { ok: true, ready: false, now: Date.now(), title: cfg.title, message: '아직 신청이 열리지 않았습니다.' };
  }
  var grid;
  try {
    grid = getGrid_(false);
  } catch (err) {
    return { ok: true, ready: false, now: Date.now(), title: cfg.title, message: '시트를 불러올 수 없습니다. 관리자에게 문의해 주세요.' };
  }
  return {
    ok: true,
    ready: true,
    title: cfg.title,
    notice: cfg.notice,
    openAt: cfg.openAt,
    closeAt: cfg.closeAt,
    allowCancel: !!cfg.allowCancel,
    now: Date.now(),
    dates: grid.dates,
    times: grid.times,
    open: grid.open,
    taken: mergeTaken_(grid.pre, getAllClaims_())
  };
}

/** 폴링용 경량 응답 */
function apiTaken() {
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
  if (!lock.tryLock(LOCK_WAIT)) return fail_('신청이 몰리고 있어요. 잠시 후 다시 시도해 주세요.');

  var result;
  try {
    var claims = getAllClaims_();
    if (claims[slot]) {
      result = fail_('방금 마감되었습니다. 다른 시간을 선택해 주세요.');
    } else if (Object.keys(claims).some(function (k) { return claims[k].id === id; })) {
      result = fail_('이미 신청하신 시간이 있습니다. 변경하려면 기존 신청을 취소해 주세요.');
    } else {
      var shard = readShard_(parsed.col);
      shard[slot] = { name: name, id: id, ts: new Date().toISOString() };
      PROPS.setProperty(shardKey_(parsed.col), JSON.stringify(shard));
      result = { ok: true, slot: slot };
    }
  } finally {
    lock.releaseLock();
  }

  if (result.ok) writeCell_(cfg, parsed, name);   // 락 밖에서 시트 반영
  return result;
}

function apiCancel(payload) {
  var name  = normName_(payload.name);
  var last4 = String(payload.last4 || '').trim();
  var slot  = String(payload.slot || '');

  var cfg = getConfig_();
  if (!cfg.allowCancel) return fail_('취소는 관리자에게 문의해 주세요.');
  var parsed = parseSlot_(slot);
  if (!parsed) return fail_('취소할 신청을 찾을 수 없습니다.');

  var id = name + '|' + last4;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT)) return fail_('잠시 후 다시 시도해 주세요.');

  var result;
  try {
    var shard = readShard_(parsed.col);
    if (!shard[slot]) result = fail_('취소할 신청을 찾을 수 없습니다.');
    else if (shard[slot].id !== id) result = fail_('본인 신청만 취소할 수 있습니다.');
    else {
      delete shard[slot];
      PROPS.setProperty(shardKey_(parsed.col), JSON.stringify(shard));
      result = { ok: true };
    }
  } finally {
    lock.releaseLock();
  }

  if (result.ok) {
    writeCell_(cfg, parsed, '');
    dropGridCache_();   // 캐시된 pre 가 취소된 칸을 계속 마감으로 보이게 하는 것을 막는다
  }
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
  var out = { ok: true, config: cfg, now: Date.now(), sheets: [], dates: [], openCount: 0, preCount: 0, error: '' };
  if (!cfg.sheetUrl) return out;
  try {
    out.sheets = SpreadsheetApp.openByUrl(cfg.sheetUrl).getSheets().map(function (s) { return s.getName(); });
    var grid = readGrid_(cfg);
    out.dates = grid.dates;
    out.openCount = grid.open.length;
    out.preCount = Object.keys(grid.pre).length;
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
  return { ok: true, openCount: grid.open.length, preCount: Object.keys(grid.pre).length };
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
  cfg.allowCancel = !!cfgIn.allowCancel;
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
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT)) return fail_('잠시 후 다시 시도해 주세요.');
  try {
    var shard = readShard_(parsed.col);
    delete shard[slot];
    PROPS.setProperty(shardKey_(parsed.col), JSON.stringify(shard));
  } finally {
    lock.releaseLock();
  }
  writeCell_(getConfig_(), parsed, '');
  dropGridCache_();
  return { ok: true };
}

/** 신청 내역을 시트에 한 번에 다시 써서 어긋난 상태를 복구한다. */
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
  Object.keys(byCol).forEach(function (col) {
    var rows = byCol[col];
    var minR = Math.min.apply(null, rows);
    var maxR = Math.max.apply(null, rows);
    var range = sh.getRange(minR, Number(col), maxR - minR + 1, 1);
    var vals = range.getValues();
    rows.forEach(function (r) {
      var c = claims[slotKey_(col, r)];
      var next = c ? c.name : '';
      if (normName_(vals[r - minR][0]) !== next) { vals[r - minR][0] = next; written++; }
    });
    range.setValues(vals);
  });
  dropGridCache_();
  return { ok: true, written: written };
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
    var shards = {};
    Object.keys(grid.raw).forEach(function (k) {
      var p = parseSlot_(k);
      var sk = shardKey_(p.col);
      shards[sk] = shards[sk] || {};
      // 시트에서 가져온 신청은 연락처를 알 수 없어 본인 취소가 불가능하다(관리자만 삭제 가능).
      shards[sk][k] = { name: grid.raw[k], id: grid.raw[k] + '|----', ts: stamp };
      imported++;
    });
    Object.keys(shards).forEach(function (sk) { PROPS.setProperty(sk, JSON.stringify(shards[sk])); });
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
