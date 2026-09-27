/* ============================================================
   寝室运营一本通 · app.js
   零依赖原生 JS：状态管理 / 值日轮换 / 账单结算 / 公约 / 共享 / 导出导入
   顶部为纯函数（可在 Node 中单测），底部 DOM 部分在浏览器环境才执行
   ============================================================ */

/* ---------------- 常量 ---------------- */

var STORAGE_KEY = "dormhub_state_v1";
var CORRUPT_KEY = "dormhub_corrupt_backup";

var MEMBER_COLORS = ["#F59E0B", "#A8C686", "#7EC8E3", "#F9B4C2", "#C9A7EB", "#F0896B", "#9AC791", "#E8B04B"];
var MEMBER_EMOJIS = ["🐱", "🐶", "🐰", "🐻", "🐸", "🐼", "🦊", "🐯", "🐺", "🦁", "🐨", "🐷"];
var DEFAULT_TASKS = ["扫地", "拖地", "倒垃圾", "卫生间"];
var DEFAULT_FOODS = ["麻辣烫", "食堂", "外卖", "泡面", "沙县小吃", "黄焖鸡", "螺蛳粉", "烤肉饭", "盖浇饭", "火锅", "兰州拉面", "饭团"];
var SUPPLY_STATES = ["常备", "需补", "已买"];

/* ---------------- 纯函数（可单测） ---------------- */

function uid(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function round2(x) { return Math.round(x * 100) / 100; }

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function todayStr() {
  return fmtDate(new Date());
}

/* 本地日期 YYYY-MM-DD（不要用 toISOString，会转 UTC 差一天） */
function fmtDate(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

/* 按本地时区解析 YYYY-MM-DD（new Date("2026-09-21") 是 UTC 零点，会偏移） */
function parseDate(str) {
  var p = String(str).split("-").map(Number);
  if (p.length < 3 || isNaN(p[0]) || isNaN(p[1]) || isNaN(p[2])) return new Date(NaN);
  return new Date(p[0], p[1] - 1, p[2]);
}

function mondayOf(d) {
  var t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  var day = (t.getDay() + 6) % 7; // 周一 = 0
  t.setDate(t.getDate() - day);
  return t;
}

/* 距 startDate（周一）的第几周，0 = 当周 */
function weekIndexFromStart(date, startDate) {
  var MS = 86400000;
  var a = mondayOf(date), b = mondayOf(parseDate(startDate));
  return Math.round((a - b) / MS / 7);
}

/* 该周所属显示键，如 2026-W39 */
function isoWeek(date) {
  var d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  var day = (d.getDay() + 6) % 7;
  var thurs = new Date(d);
  thurs.setDate(d.getDate() - day + 3);
  var year = thurs.getFullYear();
  var jan4 = new Date(year, 0, 4);
  var w = 1 + Math.round(((thurs - jan4) / 86400000 - ((jan4.getDay() + 6) % 7)) / 7);
  return year + "-W" + String(w).padStart(2, "0");
}

function weekMonday(offset) {
  var t = mondayOf(new Date());
  t.setDate(t.getDate() + offset * 7);
  return t;
}

/* 值日分配：返回 { taskIdx: memberId }
   swaps[periodKey] = { "0": [m1, m2], ... } 表示这些成员两两互换本周任务 */
function dutyAssignments(tasks, members, weekIndex, swaps) {
  var M = members.length;
  var base = {};
  var i;
  for (i = 0; i < tasks.length; i++) {
    base[i] = members[(weekIndex + i) % M].id;
  }
  var mTask = {};
  for (i = 0; i < tasks.length; i++) { mTask[base[i]] = i; }
  if (swaps) {
    Object.keys(swaps).forEach(function (k) {
      var pair = swaps[k];
      if (!pair || pair.length < 2) return;
      var tA = mTask[pair[0]], tB = mTask[pair[1]];
      if (tA === undefined || tB === undefined) return;
      mTask[pair[0]] = tB;
      mTask[pair[1]] = tA;
    });
  }
  var out = {};
  Object.keys(mTask).forEach(function (mid) { out[mTask[mid]] = mid; });
  return out;
}

/* 未结清账单的每人净额（分）：正 = 应收，负 = 应付 */
function computeNets(expenses) {
  var net = {};
  expenses.forEach(function (e) {
    if (e.settled) return;
    var amt = Math.round(Number(e.amount) * 100);
    var parts = e.participants || [];
    if (!parts.length) return;
    var n = parts.length;
    var share = Math.floor(amt / n);
    var rem = amt - share * n;
    net[e.payer] = (net[e.payer] || 0) + amt - share - rem;
    parts.forEach(function (p) {
      if (p !== e.payer) net[p] = (net[p] || 0) - share;
    });
  });
  return net;
}

/* 简化结算：贪心配对，返回 [{from, to, cents}]，转账笔数最少 */
function simplifySettlement(nets) {
  var pos = [], neg = [];
  Object.keys(nets).forEach(function (id) {
    var c = nets[id];
    if (c > 0) pos.push({ id: id, c: c });
    else if (c < 0) neg.push({ id: id, c: -c });
  });
  pos.sort(function (a, b) { return b.c - a.c; });
  neg.sort(function (a, b) { return b.c - a.c; });
  var out = [], i = 0, j = 0;
  while (i < pos.length && j < neg.length) {
    var t = Math.min(pos[i].c, neg[j].c);
    out.push({ from: neg[j].id, to: pos[i].id, cents: t });
    pos[i].c -= t;
    neg[j].c -= t;
    if (pos[i].c === 0) i++;
    if (neg[j].c === 0) j++;
  }
  return out;
}

function formatYuan(cents) {
  return "¥" + (cents / 100).toFixed(2);
}

function b64encode(str) {
  var bytes = new TextEncoder().encode(str);
  var s = "";
  for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64decode(b64) {
  var bin = atob(b64);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* 默认状态 */
function defaultState() {
  return {
    dormName: "223 寝室",
    members: [
      { id: "m1", name: "阿伟", emoji: "🐱", color: MEMBER_COLORS[0] },
      { id: "m2", name: "小明", emoji: "🐶", color: MEMBER_COLORS[1] },
      { id: "m3", name: "小美", emoji: "🐰", color: MEMBER_COLORS[2] },
      { id: "m4", name: "阿强", emoji: "🐻", color: MEMBER_COLORS[3] }
    ],
    duty: {
      startDate: fmtDate(mondayOf(new Date())),
      period: "weekly",
      tasks: DEFAULT_TASKS.slice(),
      done: {},
      swaps: {}
    },
    expenses: [],
    rules: [],
    shared: {
      supplies: [],
      loans: []
    },
    foods: DEFAULT_FOODS.map(function (n) { return { name: n, votes: 0 }; })
  };
}

/* 归一化导入/加载的数据，缺字段补默认，绝不白屏 */
function normalizeState(raw) {
  var d = defaultState();
  if (!raw || typeof raw !== "object") return d;
  var s = {
    dormName: typeof raw.dormName === "string" && raw.dormName ? raw.dormName : d.dormName,
    members: Array.isArray(raw.members) ? raw.members.filter(function (m) { return m && m.id && m.name; }) : d.members.slice(),
    duty: {
      startDate: raw.duty && typeof raw.duty.startDate === "string" ? raw.duty.startDate : d.duty.startDate,
      period: (raw.duty && raw.duty.period) || "weekly",
      tasks: raw.duty && Array.isArray(raw.duty.tasks) && raw.duty.tasks.length ? raw.duty.tasks : d.duty.tasks.slice(),
      done: (raw.duty && raw.duty.done) || {},
      swaps: (raw.duty && raw.duty.swaps) || {}
    },
    expenses: Array.isArray(raw.expenses) ? raw.expenses : [],
    rules: Array.isArray(raw.rules) ? raw.rules : [],
    shared: {
      supplies: raw.shared && Array.isArray(raw.shared.supplies) ? raw.shared.supplies : [],
      loans: raw.shared && Array.isArray(raw.shared.loans) ? raw.shared.loans : []
    },
    foods: Array.isArray(raw.foods) && raw.foods.length ? raw.foods : d.foods.slice()
  };
  if (!s.members.length) s.members = d.members.slice();
  return s;
}

/* ---------------- 状态读写（localStorage，浏览器环境） ---------------- */

function loadState() {
  if (typeof localStorage === "undefined") return defaultState();
  var raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (e) { /* 隐私模式等 */ }
  if (!raw) return defaultState();
  try {
    return normalizeState(JSON.parse(raw));
  } catch (e) {
    try { localStorage.setItem(CORRUPT_KEY, raw); } catch (e2) {}
    return defaultState();
  }
}

function saveState(s) {
  if (typeof localStorage === "undefined") return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch (e) {}
}

/* ---------------- 浏览器 DOM 部分 ---------------- */

if (typeof document !== "undefined") {

  var state = loadState();
  var currentTab = "home";
  var weekOffset = 0;
  var pendingImportText = null;
  var editRuleId = null;

  var $ = function (sel) { return document.querySelector(sel); };
  var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  function memberById(id) {
    for (var i = 0; i < state.members.length; i++) if (state.members[i].id === id) return state.members[i];
    return null;
  }

  function memberName(id) {
    var m = memberById(id);
    return m ? m.name : "未知";
  }

  function save() { saveState(state); }

  function toast(msg) {
    var t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.classList.remove("show"); }, 2200);
  }

  /* ---------- 渲染 ---------- */

  function renderAll() {
    $("#dorm-name").value = state.dormName;
    renderTabViews();
  }

  function renderTabViews() {
    renderHome();
    renderDuty();
    renderBill();
    renderRules();
    renderShared();
  }

  function memberChips() {
    return '<div class="member-row">' + state.members.map(function (m) {
      return '<div class="avatar solid" style="border-color:' + m.color + '"><span class="emoji">' + m.emoji + '</span><span class="name">' + esc(m.name) + '</span></div>';
    }).join("") + '</div>';
  }

  /* --- 首页 --- */

  function renderHome() {
    var el = $("#view-home");
    var todayDuty = dutyCardHtml();
    var eatHtml = eatCardHtml();
    var billHtml = billSummaryHtml();
    el.innerHTML =
      '<div class="view home-grid">' +
      '  <div class="card span2">' +
      '    <span class="eyebrow">Dashboard</span>' +
      '    <h2 class="card-title">' + esc(state.dormName) + '</h2>' +
      '    <p class="muted">今天 ' + todayStr() + ' · 和舍友一起，把日子过明白</p>' +
      memberChips() +
      '  </div>' +
      todayDuty + eatHtml + billHtml +
      '</div>';
  }

  function currentAssignments() {
    var weekIdx = weekIndexFromStart(new Date(), state.duty.startDate);
    var pk = isoWeek(new Date());
    return {
      members: state.members,
      tasks: state.duty.tasks,
      weekIdx: weekIdx,
      pk: pk,
      assign: dutyAssignments(state.duty.tasks, state.members, weekIdx, state.duty.swaps[pk]),
      done: state.duty.done
    };
  }

  function dutyCardHtml() {
    var a = currentAssignments();
    var pk = a.pk;
    var rows = a.tasks.map(function (t, i) {
      var mid = a.assign[i];
      var m = memberById(mid);
      var done = !!a.done[pk + "::" + i];
      return '<div class="duty-task' + (done ? ' done' : '') + '">' +
        '<span class="emoji">' + (m ? m.emoji : "·") + '</span>' +
        '<span class="tname">' + esc(t) + '</span>' +
        '<span class="who">' + (m ? '<span class="dot" style="background:' + m.color + '"></span>' + esc(m.name) : "未分配") + '</span>' +
        (done ? '<span class="sticker green">已做</span>' : '<span class="sticker orange">待做</span>') +
        '</div>';
    }).join("");
    return '<div class="card">' +
      '<h2 class="card-title">本周值日 <span class="underline"></span></h2>' +
      rows +
      '<p class="muted">' + pk + ' · 周轮换（换班请到「值日」页）</p>' +
      '</div>';
  }

  function eatCardHtml() {
    var list = state.foods.map(function (f) {
      return '<div class="item">' +
        '<span class="item-title">' + esc(f.name) + '</span>' +
        '<span class="sticker blue">' + f.votes + ' 票</span>' +
        '<span class="actions"><button class="btn btn-sm" data-action="eat-vote" data-name="' + esc(f.name) + '">投一票</button></span>' +
        '</div>';
    }).join("");
    return '<div class="card">' +
      '<h2 class="card-title">今天吃什么 <span class="underline"></span></h2>' +
      '<div class="form-row">' +
      '  <button class="btn btn-primary" data-action="eat-pick">随机抽一个</button>' +
      '  <span id="eat-result" class="sticker orange hidden"></span>' +
      '</div>' +
      '<div class="form-row" style="margin-top:10px">' +
      '  <input class="input grow" id="eat-new" maxlength="12" placeholder="加个候选（如 冒菜）">' +
      '  <button class="btn" data-action="eat-add">添加</button>' +
      '</div>' +
      '<div class="list" style="margin-top:10px;max-height:220px;overflow:auto">' + list + '</div>' +
      '</div>';
  }

  function billSummaryHtml() {
    var un = state.expenses.filter(function (e) { return !e.settled; });
    var top = un.slice(0, 3).map(function (e) {
      return '<div class="item">' +
        '<div class="main"><div class="item-title">' + esc(e.desc || "无标题") + '</div>' +
        '<div class="item-sub">' + esc(memberName(e.payer)) + ' 垫付 · ' + esc(e.date || "") + '</div></div>' +
        '<span class="sticker orange">' + formatYuan(Math.round(Number(e.amount) * 100)) + '</span>' +
        '</div>';
    }).join("") || '<p class="muted">还没有账单，去「账单」记一笔吧～</p>';
    var nets = computeNets(state.expenses);
    var line = Object.keys(nets).filter(function (id) { return nets[id] !== 0; }).map(function (id) {
      var v = nets[id];
      return '<span class="sticker ' + (v > 0 ? "green" : "red") + '">' + esc(memberName(id)) + (v > 0 ? " 应收 " : " 应付 ") + formatYuan(Math.abs(v)) + '</span>';
    }).join("") || '<span class="sticker">无未结算</span>';
    return '<div class="card">' +
      '<h2 class="card-title">账单速览 <span class="underline"></span></h2>' +
      '<div class="bill-net" style="margin-bottom:10px">' + line + '</div>' + top +
      '<p class="muted">去「账单」页完成结算</p>' +
      '</div>';
  }

  /* --- 值日 --- */

  function renderDuty() {
    var el = $("#view-duty");
    var membersHtml = state.members.map(function (m) {
      return '<div class="item" data-id="' + m.id + '">' +
        '<span style="font-size:22px">' + m.emoji + '</span>' +
        '<div class="main"><span class="item-title">' + esc(m.name) + '</span>' +
        '<span class="item-sub"><span class="dot" style="background:' + m.color + '"></span>专属色</span></div>' +
        '<span class="actions">' +
        '  <button class="btn btn-sm" data-action="member-edit" data-id="' + m.id + '">编辑</button>' +
        '  <button class="btn btn-sm btn-danger" data-action="member-del" data-id="' + m.id + '">删</button>' +
        '</span></div>';
    }).join("");

    var tasksHtml = state.duty.tasks.map(function (t, i) {
      return '<span class="sticker">' + esc(t) + ' <button class="linklike x" data-action="task-del" data-idx="' + i + '" title="删除">✕</button></span>';
    }).join("");

    var weekHtml = dutyWeekHtml();

    el.innerHTML =
      '<div class="card">' +
      '  <h2 class="card-title">值日轮班 <span class="underline"></span></h2>' +
      '  <div class="card-title" style="font-size:15px;margin-top:6px">成员</div>' +
      '  <div class="list">' + membersHtml + '</div>' +
      '  <div class="form-row" style="margin-top:10px">' +
      '    <input class="input grow" id="m-name" maxlength="6" placeholder="新成员昵称">' +
      '    <select class="input" id="m-emoji" style="width:auto">' + MEMBER_EMOJIS.map(function (e) { return '<option>' + e + '</option>'; }).join("") + '</select>' +
      '    <button class="btn btn-primary" data-action="member-add">添加</button>' +
      '  </div>' +
      '  <div style="margin-top:14px"><span class="card-title" style="font-size:15px">任务</span>' +
      '    <div style="display:flex;gap:6px;flex-wrap:wrap;margin:8px 0">' + tasksHtml + '</div>' +
      '    <div class="form-row">' +
      '      <input class="input grow" id="t-name" maxlength="8" placeholder="新任务（如 阳台）">' +
      '      <button class="btn" data-action="task-add">添加任务</button>' +
      '    </div></div>' +
      '</div>' +
      '<div class="card">' +
      '  <h2 class="card-title">周值班表 <span class="underline"></span></h2>' +
      weekHtml +
      '</div>';
  }

  function dutyWeekHtml() {
    var weekDate = weekMonday(weekOffset);
    var pk = isoWeek(weekDate);
    var weekIdx = weekIndexFromStart(weekDate, state.duty.startDate);
    var assign = dutyAssignments(state.duty.tasks, state.members, weekIdx, state.duty.swaps[pk]);
    var isCurrent = weekOffset === 0;
    var rows = state.duty.tasks.map(function (t, i) {
      var mid = assign[i];
      var m = memberById(mid);
      var done = !!(state.duty.done[pk + "::" + i]);
      return '<div class="duty-task' + (isCurrent ? " today" : "") + '">' +
        '<span class="emoji">' + (m ? m.emoji : "·") + '</span>' +
        '<span class="tname">' + esc(t) + '</span>' +
        '<span class="who">' + (m ? '<span class="dot" style="background:' + m.color + '"></span>' + esc(m.name) : '未分配') + '</span>' +
        (isCurrent
          ? '<button class="btn btn-sm" data-action="duty-toggle" data-idx="' + i + '" data-pk="' + pk + '">' + (done ? "已完成" : "打勾") + '</button>'
          : (done ? '<span class="sticker green">已完成</span>' : '<span class="sticker">当时未打卡</span>')) +
        '</div>';
    }).join("");

    var swapForm = isCurrent
      ? '<div class="form-row" style="margin-top:10px">' +
        '  <span class="muted">本周换班：</span>' +
        '  <select class="input" id="swap-a" style="width:auto">' + memberSelectOptions() + '</select>' +
        '  <span>↔</span>' +
        '  <select class="input" id="swap-b" style="width:auto">' + memberSelectOptions() + '</select>' +
        '  <button class="btn" data-action="duty-swap" data-pk="' + pk + '">互换</button>' +
        '</div>'
      : "";

    return '<div class="duty-head">' +
      '<h3>' + pk + (isCurrent ? "（本周）" : "") + '</h3>' +
      '<div class="actions">' +
      '  <button class="btn btn-sm" data-action="week-prev">‹ 上周</button>' +
      '  <button class="btn btn-sm" data-action="week-today">回到本周</button>' +
      '  <button class="btn btn-sm" data-action="week-next">下周 ›</button>' +
      '</div></div>' +
      '<div class="duty-week">' + rows + '</div>' +
      swapForm;
  }

  function memberSelectOptions(selected) {
    return state.members.map(function (m) {
      return '<option value="' + m.id + '"' + (m.id === selected ? " selected" : "") + '>' + m.emoji + ' ' + esc(m.name) + '</option>';
    }).join("");
  }

  /* --- 账单 --- */

  function renderBill() {
    var el = $("#view-bill");
    var nets = computeNets(state.expenses);
    var transfers = simplifySettlement(nets);

    var netHtml = Object.keys(nets).filter(function (id) { return nets[id] !== 0; }).map(function (id) {
      var v = nets[id];
      return '<span class="sticker ' + (v > 0 ? "green" : "red") + '">' + esc(memberName(id)) + (v > 0 ? " 应收 " : " 应付 ") + formatYuan(Math.abs(v)) + '</span>';
    }).join("") || '<span class="muted">没有未结清的账</span>';

    var transferHtml = transfers.length
      ? transfers.map(function (t) {
          return '<div class="transfer-line">' + esc(memberName(t.from)) + ' → ' + esc(memberName(t.to)) + '  ' + formatYuan(t.cents) + '</div>';
        }).join("")
      : '<span class="muted">无需转账，干干净净～</span>';

    var hisHtml = state.expenses.slice().reverse().map(function (e) {
      var parts = (e.participants || []).map(memberName).join("、") || "—";
      return '<div class="item' + (e.settled ? ' muted' : '') + '">' +
        '<div class="main">' +
        '  <div class="item-title">' + esc(e.desc || "无标题") + (e.settled ? ' <span class="sticker green">已结清</span>' : "") + '</div>' +
        '  <div class="item-sub">' + esc(memberName(e.payer)) + ' 垫付 · 参与 ' + esc(parts) + ' · ' + esc(e.date || "") + '</div>' +
        '</div>' +
        '<span class="sticker orange">' + formatYuan(Math.round(Number(e.amount) * 100)) + '</span>' +
        '<span class="actions">' +
        '  <button class="btn btn-sm" data-action="exp-toggle" data-id="' + e.id + '">' + (e.settled ? "恢复" : "结清") + '</button>' +
        '  <button class="btn btn-sm btn-danger" data-action="exp-del" data-id="' + e.id + '">删</button>' +
        '</span></div>';
    }).join("") || '<p class="muted">还没有账单，在下面记一笔～</p>';

    var partsAll = state.members.map(function (m) {
      return '<label class="pick on"><input type="checkbox" class="exp-part" value="' + m.id + '" checked>' + m.emoji + ' ' + esc(m.name) + '</label>';
    }).join("");

    el.innerHTML =
      '<div class="card">' +
      '  <h2 class="card-title">记一笔 <span class="underline"></span></h2>' +
      '  <div class="form-grid">' +
      '    <div class="field"><label>描述</label><input class="input" id="exp-desc" maxlength="30" placeholder="海底捞"></div>' +
      '    <div class="field"><label>金额</label><input class="input" id="exp-amount" type="number" min="0" step="0.01" placeholder="300.00"></div>' +
      '    <div class="field"><label>谁垫付</label><select class="input" id="exp-payer">' + memberSelectOptions(state.members.length ? state.members[0].id : "") + '</select></div>' +
      '    <div class="field"><label>日期</label><input class="input" id="exp-date" type="date" value="' + todayStr() + '"></div>' +
      '  </div>' +
      '  <div class="field" style="margin-top:10px"><label>参与人（AA）</label><div class="pick-group">' + partsAll + '</div></div>' +
      '  <div class="form-row" style="margin-top:10px"><button class="btn btn-primary" data-action="exp-add">记下这笔</button></div>' +
      '</div>' +
      '<div class="card">' +
      '  <h2 class="card-title">结算中心 <span class="underline"></span></h2>' +
      '  <p class="muted">每人净额（应收 − 应付）：</p>' +
      '  <div class="bill-net">' + netHtml + '</div>' +
      '  <p class="muted" style="margin-top:12px">最少转账方案：</p>' +
      '  <div style="display:flex;flex-direction:column;gap:6px">' + transferHtml + '</div>' +
      '</div>' +
      '<div class="card">' +
      '  <h2 class="card-title">历史账目 <span class="underline"></span></h2>' +
      '  <div class="list">' + hisHtml + '</div>' +
      '</div>';
  }

  /* --- 公约 --- */

  function renderRules() {
    var el = $("#view-rule");
    var list = state.rules.map(function (r) {
      var agreeHtml = state.members.map(function (m) {
        var on = r.agree && r.agree[m.id];
        return '<span class="sticker ' + (on ? "green" : "") + '" style="cursor:pointer" data-action="rule-tgl" data-id="' + r.id + '" data-mid="' + m.id + '" title="点击同意/取消">' + m.emoji + ' ' + esc(m.name) + (on ? " ✓" : "") + '</span>';
      }).join("") || '<span class="muted">还没有成员</span>';
      var editBox = (editRuleId === r.id)
        ? '<div class="form-row" style="margin-top:8px">' +
          '  <input class="input grow" id="rule-edit-text" maxlength="60" value="' + esc(r.text) + '">' +
          '  <button class="btn btn-primary btn-sm" data-action="rule-save" data-id="' + r.id + '">保存</button>' +
          '  <button class="btn btn-sm" data-action="rule-cancel">取消</button>' +
          '</div>'
        : "";
      var agreeCount = Object.keys(r.agree || {}).filter(function (k) { return r.agree[k]; }).length;
      return '<div class="card rule-card">' +
        '<div class="card-title" style="font-size:16px">' + esc(r.text) + '</div>' +
        '<div class="muted">发布于 ' + esc(r.created || "") + ' · ' + agreeCount + '/' + state.members.length + ' 人同意</div>' +
        '<div class="agree-list">' + agreeHtml + '</div>' +
        editBox +
        '<div class="actions" style="margin-top:8px">' +
        '  <button class="btn btn-sm" data-action="rule-edit" data-id="' + r.id + '">编辑</button>' +
        '  <button class="btn btn-sm btn-danger" data-action="rule-del" data-id="' + r.id + '">删</button>' +
        '</div></div>';
    }).join("") || '<p class="muted">还没有公约，来定一条吧～</p>';

    el.innerHTML =
      '<div class="card">' +
      '  <h2 class="card-title">寝室公约 <span class="underline"></span></h2>' +
      '  <p class="muted">大家一起定的规矩，点成员名字表态</p>' +
      '  <div class="form-row" style="margin-top:8px">' +
      '    <input class="input grow" id="rule-new" maxlength="60" placeholder="如：23:30 后不外放">' +
      '    <button class="btn btn-primary" data-action="rule-add">立一条</button>' +
      '  </div>' +
      '</div>' +
      '<div class="list">' + list + '</div>';
  }

  /* --- 共享 --- */

  function renderShared() {
    var el = $("#view-share");
    var supplies = state.shared.supplies.map(function (s) {
      var stCls = s.state === "「需补」" || s.state === "需补" ? "red" : (s.state === "已买" ? "green" : "blue");
      return '<div class="item">' +
        '<div class="main"><div class="item-title">' + esc(s.item) + '</div>' +
        '<div class="item-sub">建议补货：' + esc(memberName(s.buyer)) + '</div></div>' +
        '<span class="sticker ' + stCls + '">' + esc(s.state || "常备") + '</span>' +
        '<span class="actions">' +
        '  <button class="btn btn-sm" data-action="sup-state" data-id="' + s.id + '" title="切换状态">状态</button>' +
        '  <button class="btn btn-sm btn-danger" data-action="sup-del" data-id="' + s.id + '">删</button>' +
        '</span></div>';
    }).join("") || '<p class="muted">还没有公共物资，先登记一个～</p>';

    var loans = state.shared.loans.map(function (l) {
      return '<div class="item' + (l.returned ? " muted" : "") + '">' +
        '<div class="main"><div class="item-title">' + esc(l.item) + (l.returned ? ' <span class="sticker green">已还</span>' : '') + '</div>' +
        '<div class="item-sub">' + esc(memberName(l.lender)) + ' 借出 → ' + esc(memberName(l.borrower)) + ' · 应还 ' + esc(l.due || "—") + '</div></div>' +
        '<span class="actions">' +
        '  <button class="btn btn-sm" data-action="loan-toggle" data-id="' + l.id + '">' + (l.returned ? "未还" : "还了") + '</button>' +
        '  <button class="btn btn-sm btn-danger" data-action="loan-del" data-id="' + l.id + '">删</button>' +
        '</span></div>';
    }).join("") || '<p class="muted">还没有借用记录（镜头、充电宝、教材…）</p>';

    el.innerHTML =
      '<div class="card">' +
      '  <h2 class="card-title">公共物资 <span class="underline"></span></h2>' +
      '  <div class="form-grid">' +
      '    <div class="field"><label>物品</label><input class="input" id="sup-item" maxlength="12" placeholder="垃圾袋 / 洗衣液…"></div>' +
      '    <div class="field"><label>状态</label><select class="input" id="sup-state">' + SUPPLY_STATES.map(function (s) { return "<option>" + s + "</option>"; }).join("") + '</select></div>' +
      '    <div class="field"><label>建议补货人</label><select class="input" id="sup-buyer">' + memberSelectOptions("") + '</select></div>' +
      '  </div>' +
      '  <div class="form-row" style="margin-top:10px"><button class="btn btn-primary" data-action="sup-add">登记</button></div>' +
      '  <div class="list" style="margin-top:10px">' + supplies + '</div>' +
      '</div>' +
      '<div class="card">' +
      '  <h2 class="card-title">物品借用 <span class="underline"></span></h2>' +
      '  <p class="muted">寝室"共享经济"登记：借了啥、谁借的、还了吗</p>' +
      '  <div class="form-grid">' +
      '    <div class="field"><label>物品</label><input class="input" id="loan-item" maxlength="15" placeholder="相机镜头"></div>' +
      '    <div class="field"><label>借出人</label><select class="input" id="loan-lender">' + memberSelectOptions("") + '</select></div>' +
      '    <div class="field"><label>借用人</label><select class="input" id="loan-borrower">' + memberSelectOptions("") + '</select></div>' +
      '    <div class="field"><label>预计归还</label><input class="input" id="loan-due" type="date" value=""></div>' +
      '  </div>' +
      '  <div class="form-row" style="margin-top:10px"><button class="btn btn-primary" data-action="loan-add">登记借用</button></div>' +
      '  <div class="list" style="margin-top:10px">' + loans + '</div>' +
      '</div>';
  }

  /* ---------- Tab 切换 ---------- */

  function showTab(name) {
    currentTab = name;
    $$(".tab").forEach(function (t) { t.classList.toggle("active", t.getAttribute("data-tab") === name); });
    ["home", "duty", "bill", "rule", "share"].forEach(function (v) {
      $("#view-" + v).classList.toggle("hidden", v !== name);
    });
  }

  /* ---------- 导出 / 导入 / 分享 / 重置 ---------- */

  function exportJson() {
    var json = JSON.stringify(state, null, 2);
    var blob = new Blob([json], { type: "application/json" });
    var a = document.createElement("a");
    var d = todayStr().replace(/-/g, "");
    a.href = URL.createObjectURL(blob);
    a.download = "dormhub-backup-" + d + ".json";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast("已导出备份文件");
  }

  function doImport(rawText) {
    var parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) { toast("不是有效的 JSON 数据"); return; }
    var norm = normalizeState(parsed);
    if (!window.confirm("将覆盖本机当前全部数据，确定导入？")) return;
    state = norm;
    save();
    renderAll();
    $("#import-dialog").close();
    toast("导入成功");
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () { return fallbackCopy(text); });
    }
    return Promise.resolve(fallbackCopy(text));
  }
  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) {}
    ta.remove();
    return ok;
  }

  function shareLink() {
    var json = JSON.stringify(state);
    var b64 = b64encode(json);
    if (b64.length > 1500) {
      toast("数据较大，分享链接放不下，改用「导出」文件吧");
      exportJson();
      return;
    }
    var link = location.origin + location.pathname + "#d=" + encodeURIComponent(b64);
    copyText(link).then(function (ok) {
      toast(ok ? "分享链接已复制，发给舍友点开即导入" : "复制失败，请手动复制");
    });
  }

  function tryImportFromHash() {
    var h = location.hash;
    if (!h || h.indexOf("#d=") !== 0) return;
    var b64 = decodeURIComponent(h.slice(3));
    var text;
    try { text = b64decode(b64); } catch (e) { return; }
    if (!confirm("收到一份分享数据，导入并覆盖当前数据？")) { history.replaceState(null, "", location.pathname); return; }
    doImport(text);
    history.replaceState(null, "", location.pathname);
  }

  /* ---------- 事件委托 ---------- */

  document.addEventListener("click", function (ev) {
    var t = ev.target;
    var btn = t.closest ? t.closest("[data-action]") : null;
    if (!btn) return;
    var act = btn.getAttribute("data-action");
    var id = btn.getAttribute("data-id");
    var mid = btn.getAttribute("data-mid");
    var name = btn.getAttribute("data-name");
    var idx = btn.getAttribute("data-idx");
    var pk = btn.getAttribute("data-pk");

    switch (act) {
      /* tabs */
      case "tab": showTab(id); break;
      /* home */
      case "eat-pick": {
        if (!state.foods.length) { toast("先加几个候选吧"); break; }
        var f = state.foods[Math.floor(Math.random() * state.foods.length)];
        var el = $("#eat-result");
        el.textContent = "今天吃 " + f.name;
        el.classList.remove("hidden");
        break;
      }
      case "eat-vote": {
        var it = state.foods.find(function (x) { return x.name === name; });
        if (it) { it.votes = (it.votes || 0) + 1; save(); renderTabViews(); toast("已投 " + it.name); }
        break;
      }
      case "eat-add": {
        var nm = ($("#eat-new").value || "").trim();
        if (!nm) break;
        if (state.foods.some(function (x) { return x.name === nm; })) { toast("已经在候选里啦"); break; }
        state.foods.push({ name: nm, votes: 0 });
        save(); renderTabViews();
        break;
      }
      /* duty */
      case "member-add": {
        var nm2 = ($("#m-name").value || "").trim();
        if (!nm2) { toast("输入昵称"); break; }
        if (state.members.length >= 8) { toast("最多 8 人"); break; }
        var em2 = $("#m-emoji").value || "🙂";
        state.members.push({ id: uid("m"), name: nm2, emoji: em2, color: MEMBER_COLORS[state.members.length % MEMBER_COLORS.length] });
        save(); renderTabViews();
        break;
      }
      case "member-del": {
        if (state.members.length <= 2) { toast("至少保留 2 人"); break; }
        if (!confirm("删除成员 " + memberName(id) + "？相关账单/公约数据保留但显示为未知")) break;
        state.members = state.members.filter(function (m) { return m.id !== id; });
        save(); renderTabViews();
        break;
      }
      case "member-edit": {
        var m = memberById(id);
        if (!m) break;
        var nn = window.prompt("改昵称（≤6 字）", m.name);
        if (nn === null) break;
        nn = nn.trim();
        if (!nn) break;
        m.name = nn.slice(0, 6);
        save(); renderTabViews();
        break;
      }
      case "task-add": {
        var tn = ($("#t-name").value || "").trim();
        if (!tn) { toast("输入任务名"); break; }
        state.duty.tasks.push(tn.slice(0, 8));
        save(); renderTabViews();
        break;
      }
      case "task-del": {
        if (state.duty.tasks.length <= 1) { toast("至少保留 1 个任务"); break; }
        var ti = parseInt(idx, 10);
        state.duty.tasks.splice(ti, 1);
        save(); renderTabViews();
        break;
      }
      case "duty-toggle": {
        var key = pk + "::" + idx;
        if (state.duty.done[key]) delete state.duty.done[key];
        else state.duty.done[key] = true;
        save(); renderDuty(); renderHome();
        break;
      }
      case "duty-swap": {
        var a = $("#swap-a").value, b = $("#swap-b").value;
        if (!a || !b || a === b) { toast("选两个不同的人"); break; }
        if (!state.duty.swaps[pk]) state.duty.swaps[pk] = {};
        var n = Object.keys(state.duty.swaps[pk]).length;
        state.duty.swaps[pk][String(n)] = [a, b];
        save(); renderDuty(); renderHome();
        toast("已互换，改组下周自动恢复");
        break;
      }
      case "week-prev": weekOffset--; renderDuty(); break;
      case "week-next": weekOffset++; renderDuty(); break;
      case "week-today": weekOffset = 0; renderDuty(); break;
      /* bill */
      case "exp-add": {
        var desc = ($("#exp-desc").value || "").trim() || "未命名支出";
        var amount = parseFloat($("#exp-amount").value);
        if (!(amount > 0)) { toast("填个有效金额"); break; }
        var payer = $("#exp-payer").value;
        var parts = $$(".exp-part:checked").map(function (c) { return c.value; });
        if (!parts.length) { toast("至少选一位参与人"); break; }
        state.expenses.push({
          id: uid("e"), desc: desc, amount: amount, payer: payer,
          participants: parts, date: $("#exp-date").value || todayStr(), settled: false
        });
        save(); renderTabViews(); toast("已记一笔");
        break;
      }
      case "exp-toggle": {
        var ee = state.expenses.find(function (x) { return x.id === id; });
        if (ee) { ee.settled = !ee.settled; save(); renderTabViews(); }
        break;
      }
      case "exp-del": {
        if (!confirm("删除这笔账单？")) break;
        state.expenses = state.expenses.filter(function (x) { return x.id !== id; });
        save(); renderTabViews();
        break;
      }
      /* rules */
      case "rule-add": {
        var rt = ($("#rule-new").value || "").trim();
        if (!rt) { toast("写点内容"); break; }
        state.rules.push({ id: uid("r"), text: rt.slice(0, 60), agree: {}, created: todayStr() });
        save(); renderRules();
        break;
      }
      case "rule-tgl": {
        var rr = state.rules.find(function (x) { return x.id === id; });
        if (rr) {
          if (!rr.agree) rr.agree = {};
          rr.agree[mid] = !rr.agree[mid];
          save(); renderRules();
        }
        break;
      }
      case "rule-edit": editRuleId = id; renderRules(); break;
      case "rule-cancel": editRuleId = null; renderRules(); break;
      case "rule-save": {
        var txt = ($("#rule-edit-text").value || "").trim();
        if (!txt) break;
        var rr2 = state.rules.find(function (x) { return x.id === id; });
        if (rr2) { rr2.text = txt.slice(0, 60); }
        editRuleId = null; save(); renderRules();
        break;
      }
      case "rule-del": {
        if (!confirm("删除这条公约？")) break;
        state.rules = state.rules.filter(function (x) { return x.id !== id; });
        save(); renderRules();
        break;
      }
      /* shared */
      case "sup-add": {
        var si = ($("#sup-item").value || "").trim();
        if (!si) { toast("填物品名"); break; }
        state.shared.supplies.push({
          id: uid("s"), item: si.slice(0, 12),
          state: $("#sup-state").value, buyer: $("#sup-buyer").value || (state.members[0] ? state.members[0].id : "")
        });
        save(); renderShared();
        break;
      }
      case "sup-state": {
        var ss = state.shared.supplies.find(function (x) { return x.id === id; });
        if (ss) {
          var cur = SUPPLY_STATES.indexOf(ss.state);
          ss.state = SUPPLY_STATES[(cur + 1) % SUPPLY_STATES.length];
          save(); renderShared();
        }
        break;
      }
      case "sup-del": {
        state.shared.supplies = state.shared.supplies.filter(function (x) { return x.id !== id; });
        save(); renderShared();
        break;
      }
      case "loan-add": {
        var li = ($("#loan-item").value || "").trim();
        if (!li) { toast("填物品名"); break; }
        var lender = $("#loan-lender").value, borrower = $("#loan-borrower").value;
        if (!lender || !borrower || lender === borrower) { toast("借出/借用人不能相同"); break; }
        state.shared.loans.push({
          id: uid("l"), item: li.slice(0, 15), lender: lender, borrower: borrower,
          due: $("#loan-due").value || "", returned: false
        });
        save(); renderShared();
        break;
      }
      case "loan-toggle": {
        var ll = state.shared.loans.find(function (x) { return x.id === id; });
        if (ll) { ll.returned = !ll.returned; save(); renderShared(); }
        break;
      }
      case "loan-del": {
        state.shared.loans = state.shared.loans.filter(function (x) { return x.id !== id; });
        save(); renderShared();
        break;
      }
      /* top bar */
      case "export": exportJson(); break;
      case "import": $("#import-paste").value = ""; pendingImportText = null; $("#import-dialog").showModal(); break;
      case "pickfile": $("#import-file").click(); break;
      case "doimport": {
        var txt = pendingImportText || $("#import-paste").value.trim();
        if (txt) doImport(txt); else toast("先选文件或粘贴内容");
        break;
      }
      case "share": shareLink(); break;
      case "reset": {
        if (!confirm("将清空本机全部数据（值日/账单/公约/共享），确定？")) break;
        if (!confirm("再次确认？此操作不可撤销，建议先导出备份。")) break;
        try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
        state = defaultState();
        save();
        renderAll();
        toast("已重置为初始数据");
        break;
      }
      case "opensync": $("#sync-dialog").showModal(); break;
    }
  });

  document.addEventListener("change", function (ev) {
    if (ev.target && ev.target.id === "dorm-name") {
      state.dormName = ev.target.value.trim() || "223 寝室";
      save();
      renderHome();
    }
    if (ev.target && ev.target.id === "import-file") {
      var f = ev.target.files && ev.target.files[0];
      if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        pendingImportText = String(rd.result);
        $("#import-paste").value = "(已选文件: " + f.name + ")";
        toast("文件已读取，点「导入」确认");
      };
      rd.readAsText(f, "utf-8");
      ev.target.value = "";
    }
  });

  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape") $("#import-paste").value = "";
  });

  /* ---------- 启动 ---------- */

  document.addEventListener("DOMContentLoaded", function () {
    $$(".tab").forEach(function (t) {
      t.addEventListener("click", function () { showTab(t.getAttribute("data-tab")); });
    });
    renderAll();
    showTab(currentTab);
    tryImportFromHash();
  });

}