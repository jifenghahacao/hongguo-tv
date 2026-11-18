/* Hongguo mobile UI: immersive feed + player + theater + mine + search,
   backed by the local core API. Gestures kept: vertical snap = switch drama,
   horizontal swipe = switch episode, vertical swipe in cinema = episode,
   drag seek bar = seek. */
(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var fmt = function (s) { s = Math.max(0, Math.floor(s || 0)); var m = Math.floor(s / 60), r = s % 60; return (m < 10 ? "0" : "") + m + ":" + (r < 10 ? "0" : "") + r; };
  var ic = function (n) { return '<svg class="ic"><use href="#i-' + n + '"/></svg>'; };
  var PALETTE = [["#2a2a45", "#5a3a7a"], ["#3b2f2f", "#7a4a2a"], ["#1f3a34", "#2a6a5a"], ["#3a2438", "#7a3a5a"], ["#243a4a", "#3a6a8a"], ["#403020", "#8a6a30"]];
  function hashColor(id) { var h = 0, s = String(id || "x"); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return PALETTE[h % PALETTE.length]; }
  // Signed HEIC covers cannot be decoded by WebView; the core exposes a
  // verified JPEG mirror as cover_fallback for exactly those objects.
  function coverOf(d) { return (d && (d.cover_fallback || d.cover)) || ""; }
  // Any cover that still fails to load (e.g. HEIC without a mirror) drops the
  // broken image and falls back to the gradient + title art.
  document.addEventListener("error", function (e) {
    var img = e.target;
    if (img && img.tagName === "IMG") {
      var cv = img.closest(".cover");
      if (cv) { cv.classList.remove("has-img"); img.remove(); }
    }
  }, true);
  function num(n) { n = Number(n) || 0; if (n >= 1e8) return (n / 1e8).toFixed(1) + "亿"; if (n >= 1e4) return Math.round(n / 1e4) + "万"; return n ? String(n) : ""; }

  async function getJSON(path, params) {
    var q = params ? "?" + new URLSearchParams(params).toString() : "";
    var r = await fetch(path + q);
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok || !j.ok) throw new Error(j.error || "HTTP " + r.status);
    return j.data;
  }
  async function postJSON(path, body) {
    var r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok || !j.ok) throw new Error(j.error || "HTTP " + r.status);
    return j.data;
  }

  var toastTimer = null;
  // fade-in helpers: cover imgs + skeletons + pull-to-refresh
  function fadeImgs(root) {
    (root || document).querySelectorAll(".cover img:not(.ready)").forEach(function (im) {
      if (im.complete && im.naturalWidth) im.classList.add("ready");
      else { im.onload = function () { im.classList.add("ready"); }; im.onerror = function () { im.classList.add("ready"); }; }
    });
  }
  function skGrid(n) {
    var s = "";
    for (var i = 0; i < n; i++) s += '<div><div class="sk sk-card"></div><div class="sk" style="height:13px;margin-top:8px;width:82%"></div><div class="sk" style="height:11px;margin-top:6px;width:55%"></div></div>';
    return '<div class="grid2" style="padding:2px">' + s + "</div>";
  }
  function skRank(n) {
    var s = "";
    for (var i = 0; i < n; i++) s += '<div class="rank-card"><div class="sk" style="width:112px;height:149px"></div><div class="info"><div class="sk" style="height:17px;width:70%"></div><div class="sk" style="height:12px;width:48%;margin-top:10px"></div><div class="sk" style="height:12px;width:60%;margin-top:8px"></div></div></div>';
    return '<div class="rp-list">' + s + "</div>";
  }
  function bindPullRefresh(el, fn) {
    if (!el || el._ptr) return;
    el._ptr = true;
    var sy = 0, active = false;
    el.addEventListener("touchstart", function (e) { active = el.scrollTop <= 0; sy = e.touches[0].clientY; }, { passive: true });
    el.addEventListener("touchmove", function (e) {
      if (active && e.touches[0].clientY - sy > 90) { active = false; fn(); }
    }, { passive: true });
  }
  function toast(msg) {
    var t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove("show"); }, 1800);
  }
  // top-center pill: long-press boost indicator + double-swipe exit hint
  var topTipTimer = null;
  function showTopTip(msg, ms, cls) {
    var t = $("#top-tip"); t.textContent = msg;
    t.className = "top-tip show" + (cls ? " " + cls : "");
    clearTimeout(topTipTimer);
    if (ms) topTipTimer = setTimeout(function () { t.classList.remove("show"); }, ms);
  }
  function hideTopTip() { clearTimeout(topTipTimer); $("#top-tip").classList.remove("show"); }
  // Long-press-to-boost engine: hold for BOOST_MS to play at 2x. While
  // boosting, swipe UP locks 2x as the global speed (persisted); dragging to
  // the bottom wave zone and releasing cancels; a plain release also restores
  // the user's chosen speed.
  var BOOST_MS = 1500;
  function showBoostTip() { var b = document.getElementById("boost-hint"); if (b) b.classList.add("show"); }
  function hideBoostTip() { var b = document.getElementById("boost-hint"); if (b) b.classList.remove("show"); }
  // Bottom "membrane": while boosting, the screen's lower edge bows upward
  // toward the finger (under-damped spring, arc centre follows finger X).
  // Dragging into the bulge and releasing cancels the boost.
  var membrane = (function () {
    var p = 0, v = 0, target = 0, cx = 0.5, cxS = 0.5, raf = 0, shown = false;
    function frame() {
      var f = (target - p) * 0.14;
      v = (v + f) * 0.7;
      p += v;
      if (Math.abs(target - p) < 0.001 && Math.abs(v) < 0.001) { p = target; v = 0; }
      cxS += (cx - cxS) * 0.12;
      // Magnetic bump: only a segment of the bottom edge bows toward the
      // finger (not a full-width half-circle). cx is in viewBox units (100).
      var h = p * 16, cxs = Math.max(30, Math.min(70, cxS * 100));
      var path = document.querySelector("#boost-cancel path");
      if (path) path.setAttribute("d", "M 0 30 L " + (cxs - 27).toFixed(1) + " 30 C " + (cxs - 13).toFixed(1) + " " + (30 - h).toFixed(1) + " " + (cxs + 13).toFixed(1) + " " + (30 - h).toFixed(1) + " " + (cxs + 27).toFixed(1) + " 30 L 100 30 Z");
      var txt = document.getElementById("boost-cancel-txt");
      if (txt) { txt.style.left = cxs.toFixed(1) + "%"; txt.style.bottom = Math.round(h * 3.6 * 0.3 + 8) + "px"; }
      raf = (shown || p > 0.005) ? requestAnimationFrame(frame) : 0;
    }
    return {
      show: function () {
        shown = true; target = 1;
        var z = document.getElementById("boost-cancel"), t = document.getElementById("boost-cancel-txt");
        if (z) z.classList.add("show");
        if (t) t.classList.add("show");
        if (!raf) raf = requestAnimationFrame(frame);
      },
      finger: function (x, hot) {
        cx = Math.max(0.1, Math.min(0.9, x / window.innerWidth));
        var z = document.getElementById("boost-cancel"), t = document.getElementById("boost-cancel-txt");
        if (z) z.classList.toggle("hot", !!hot);
        if (t) t.textContent = hot ? "松开取消" : "取消倍速";
      },
      hide: function () {
        shown = false; target = 0;
        var z = document.getElementById("boost-cancel"), t = document.getElementById("boost-cancel-txt");
        if (z) z.classList.remove("show", "hot");
        if (t) { t.classList.remove("show"); t.textContent = "取消倍速"; }
        if (!raf) raf = requestAnimationFrame(frame);
      }
    };
  })();

  function makeBoost(getVideo, sceneEl, guard, tipFn, onStart) {
    var timer = null, armed = false, mode = "boost", s = null, endedAt = 0, inZone = false;
    function setTip() {
      var b = document.getElementById("boost-hint");
      if (!b) return;
      var t = b.querySelector("b"), sp = b.querySelector("span");
      if (t) t.textContent = mode === "unlock" ? "2倍速锁定中" : "2倍速快进中";
      if (sp) sp.textContent = mode === "unlock" ? "拖到底部凸起 · 松开取消倍速" : "上滑锁定倍速 · 松手恢复";
      b.classList.add("show");
    }
    function stop() {
      clearTimeout(timer); timer = null; s = null;
      if (armed) {
        armed = false; endedAt = Date.now();
        if (mode === "boost") getVideo().playbackRate = settings.speed || 1;
        hideBoostTip(); membrane.hide();
      }
    }
    function lock() {
      armed = false; endedAt = Date.now(); timer = null; s = null; hideBoostTip(); membrane.hide();
      settings.speed = 2; saveSettings();
      getVideo().playbackRate = 2;
      toast("已锁定 2 倍速（全局生效）");
    }
    sceneEl.addEventListener("touchstart", function (e) {
      stop();
      inZone = false;
      var video = getVideo();
      if (e.touches.length !== 1 || video.paused || video.readyState < 2) return;
      if (guard && guard(e.target)) return;
      // 2x already locked globally: the hold becomes an "unlock" gesture that
      // only reveals the cancel membrane (the rate is already 2).
      mode = (settings.speed || 1) >= 2 ? "unlock" : "boost";
      s = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      timer = setTimeout(function () {
        armed = true;
        if (mode === "boost") getVideo().playbackRate = 2;
        setTip();
        // The cancel membrane only exists for the locked-2x unlock gesture;
        // a plain boost just ends when the finger lifts.
        if (mode === "unlock") membrane.show();
        // Freeze the snap container for the whole hold: dragging to the
        // cancel membrane must never scroll to the next/previous drama.
        sceneEl.style.overflowY = "hidden";
        if (onStart) onStart();
      }, BOOST_MS);
    }, { passive: true });
    sceneEl.addEventListener("touchmove", function (e) {
      if (!timer && !armed) return;
      if (e.touches.length !== 1 || !s) { stop(); return; }
      if (!armed && Math.abs(e.touches[0].clientX - s.x) + Math.abs(e.touches[0].clientY - s.y) > 16) { clearTimeout(timer); timer = null; }
    }, { passive: true });
    // Non-passive: consumes the drag while armed (no scroll/episode switch
    // underneath). Up-swipe locks; the bottom membrane handles cancelling.
    sceneEl.addEventListener("touchmove", function (e) {
      if (!armed || !s || e.touches.length !== 1) return;
      e.preventDefault();
      var p = e.touches[0];
      var dy = p.clientY - s.y;
      s.y = p.clientY;
      s.acc = (s.acc || 0) + dy;
      if (s.acc < -55) { if (mode === "boost") lock(); return; }
      inZone = mode === "unlock" && p.clientY > window.innerHeight - 120;
      if (mode === "unlock") membrane.finger(p.clientX, inZone);
    }, { passive: false });
    function endTouch() {
      var wasArmed = armed, wasZone = inZone, m = mode;
      stop();
      if (wasArmed && wasZone && m === "unlock") {
        settings.speed = 1; saveSettings();
        getVideo().playbackRate = 1;
        toast("已取消 2 倍速");
      }
      if (sceneEl.style.overflowY === "hidden") {
        setTimeout(function () { sceneEl.style.overflowY = ""; }, 150);
      }
    }
    sceneEl.addEventListener("touchend", endTouch, { passive: true });
    sceneEl.addEventListener("touchcancel", endTouch, { passive: true });
    return { stop: stop, isBoosting: function () { return armed; }, wasBoosting: function () { return armed; }, recent: function () { return Date.now() - endedAt < 350; } };
  }

  var settings = { quality: "", danmaku: true, auto: true, speed: 1, dmArea: 25, volume: 1, brightness: 1 };
  try { Object.assign(settings, JSON.parse(localStorage.getItem("hg-mobile") || "{}")); } catch (e) { }
  document.documentElement.style.setProperty("--dm-area", (settings.dmArea || 25) + "%");
  // Volume/brightness are app-wide: every video element (feed pair + player
  // pair) mirrors the chosen values, persisted like the rest of settings.
  function applyAV() {
    var b = settings.brightness || 1, v = settings.volume == null ? 1 : settings.volume;
    [feedVideo, feedVideoB, pVideo, pVideoB].forEach(function (el) {
      if (!el) return;
      el.volume = v;
      el.style.filter = b < 0.99 ? "brightness(" + b + ")" : "";
    });
  }
  function saveSettings() {
    localStorage.setItem("hg-mobile", JSON.stringify(settings));
    // Mirror to the core: the WebView origin (and localStorage with it) dies
    // on every cold start because the core port is random. Without this the
    // globally chosen playback speed would silently reset to 1x.
    postJSON("/api/v1/ui-settings", { settings: settings }).catch(function () { });
  }

  // ---------- sheet ----------
  var sheetWrap = $("#sheet-wrap"), sheetBody = $("#sheet-body");
  function openSheet(title, html) { $("#sheet-title").textContent = title; sheetBody.innerHTML = html; sheetWrap.classList.add("open"); fadeImgs(sheetBody); }
  function closeSheet() { sheetWrap.classList.remove("open"); castLock(false); loginSheetCleanup(); }
  $("#sheet-close").addEventListener("click", closeSheet);
  $("#sheet-mask").addEventListener("click", closeSheet);

  // ---------- tabs ----------
  var pages = { home: "#page-home", theater: "#page-theater", search: "#page-search", mine: "#page-mine" };
  var built = { theater: false, mine: false, search: false };
  function switchTab(name) {
    Object.keys(pages).forEach(function (k) { $(pages[k]).classList.toggle("active", k === name); });
    document.querySelectorAll(".tabbar .tab").forEach(function (t) { t.classList.toggle("active", t.dataset.tab === name); });
    if (name === "home") { feedVideo.muted = feedVideo.muted; if (activeFeed >= 0) tryPlayFeed(); }
    else { feedVideo.pause(); feedWantPlay = false; }
    if (!built[name] && pages[name]) {
      built[name] = true;
      if (name === "theater") renderTheater();
      if (name === "mine") renderMine();
      if (name === "search") renderSearch();
    }
  }
  document.querySelectorAll(".tabbar .tab").forEach(function (t) { t.addEventListener("click", function () { switchTab(t.dataset.tab); }); });

  // ---------- drawer ----------
  var drawer = $("#drawer"), drawerMask = $("#drawer-mask");
  function openDrawer() { drawer.classList.add("open"); drawerMask.classList.add("open"); }
  function closeDrawer() { drawer.classList.remove("open"); drawerMask.classList.remove("open"); }
  $("#drawer-close").addEventListener("click", closeDrawer);
  drawerMask.addEventListener("click", closeDrawer);
  document.querySelectorAll(".d-item").forEach(function (b) {
    b.addEventListener("click", function () {
      var k = b.dataset.drawer; closeDrawer();
      if (k === "history" || k === "favorites" || k === "follows") openMyList(k);
      if (k === "quality") sheetQuality(function (v) { settings.quality = v; saveSettings(); toast("默认画质：" + v); });
      if (k === "auto") { settings.auto = !settings.auto; saveSettings(); toast("自动连播：" + (settings.auto ? "开" : "关")); }
      if (k === "danmaku") { settings.danmaku = !settings.danmaku; saveSettings(); toast("弹幕：" + (settings.danmaku ? "开" : "关")); }
      if (k === "dmarea") sheetDmArea(function (v) { settings.dmArea = v; saveSettings(); document.documentElement.style.setProperty("--dm-area", v + "%"); toast("弹幕区域：" + v + "%"); });
      if (k === "about") toast("红果漫剧 · 本地核心版");
    });
  });

  // ---------- danmaku engine ----------
  // Hongguo danmaku carry [name] emote codes; render the common ones as emoji.
  var EMOTE = { "开心": "😄", "大笑": "😂", "笑哭": "😅", "捂脸": "🤦", "亲亲": "😘", "调皮": "😜", "吐舌": "😛", "偷笑": "🤭", "狗头": "🐶", "酷": "😎", "惊讶": "😲", "惊喜": "🤩", "流泪": "😢", "哭": "😭", "生气": "😠", "发怒": "😡", "发抖": "🥶", "汗": "😓", "爱心": "❤️", "比心": "🫶", "点赞": "👍", "赞": "👍", "打call": "📣", "鼓掌": "👏", "抱拳": "🙏", "握手": "🤝", "OK": "👌", "玫瑰": "🌹", "礼物": "🎁", "干杯": "🍻", "咖啡": "☕", "西瓜": "🍉", "蛋糕": "🎂", "月亮": "🌙", "太阳": "☀️", "彩虹": "🌈", "火箭": "🚀", "麦克风": "🎤", "再见": "👋", "猪头": "🐷", "熊": "🐻", "烟花": "🎆", "灯泡": "💡", "飞机": "✈️", "钱": "💰", "彩带": "🎊", "困": "😪", "睡": "😴", "思考": "🤔", "嘘": "🤫", "吐": "🤮", "恶心": "🤢", "恐惧": "😱", "冷汗": "😰", "无奈": "🥲", "委屈": "🥺", "生气吗": "😤", "加油": "💪", "强": "💪", "弱": "👎", "别急": "🐢", "火": "🔥", "爆": "💥", "星星": "⭐", "流星": "🌠", "心动": "💓", "心碎": "💔", "尬笑": "😅", "嘿": "😁", "呲牙": "😁", "白眼": "🙄", "抠鼻": "🤨", "摸头": "🫳", "捏": "🤏", "耶": "✌️", "胜利": "✌️", "爱你": "🥰", "喜欢": "😍", "色": "😍", "呆": "😶", "无语": "😑", "口罩": "😷", "疫苗": "💉", "药": "💊" };
  function emoteText(t) {
    return String(t == null ? "" : t).replace(/\[([^\[\]\n]{1,8})\]/g, function (m, k) { return EMOTE[k] || EMOTE[k.toLowerCase()] || m; });
  }
  function makeDanmaku(layer, getVideo) {
    var items = [], ptr = 0, loadSeq = 0;
    var LANES = [8, 16, 24, 32, 40, 48, 56, 64], laneTail = [null, null, null, null, null, null, null, null];
    var DM_SPEED = 110; // px per second — constant, so spacing is preserved
    function spawn(text) {
      if (!text) return;
      var vw = layer.clientWidth || window.innerWidth || 360;
      // A lane is free only once its previous item's right edge is fully on
      // screen with a gap; same-speed flight means that gap never closes.
      var bi = -1;
      for (var k = 0; k < LANES.length; k++) {
        var prev = laneTail[k];
        if (!prev || !prev.isConnected) { bi = k; break; }
        if (prev.getBoundingClientRect().right < vw - 30) { bi = k; break; }
      }
      if (bi < 0) return; // all lanes busy: drop instead of stacking on top
      var s = document.createElement("span");
      s.textContent = emoteText(text);
      s.style.visibility = "hidden";
      layer.appendChild(s);
      var w = s.offsetWidth || 120;
      var dur = Math.min(16, Math.max(6, (vw + w) / DM_SPEED));
      s.style.visibility = "";
      s.style.top = LANES[bi] + "%";
      s.style.animationDuration = dur + "s";
      s.classList.add("dm-fly");
      laneTail[bi] = s;
      setTimeout(function () { if (laneTail[bi] === s) laneTail[bi] = null; s.remove(); }, dur * 1000 + 400);
    }
    return {
      load: async function (seriesId, vid, durationMs) {
        items = []; ptr = 0; loadSeq++; layer.innerHTML = "";
        if (!settings.danmaku || !vid) return;
        var seq = loadSeq;
        var dur = Math.min(86400000, Math.max(300000, durationMs || 180000));
        // The upstream serves danmaku in ~30s windows: one request only covers
        // the start of the episode, which left the rest of the timeline empty.
        // Page through the cursor until the window covers the whole episode.
        var cursor = "", pages = 0, seen = {};
        try {
          while (pages < 24) {
            var params = { series_id: seriesId, vid: vid, start: "0", duration: String(dur) };
            if (cursor) params.cursor = cursor;
            var d = await getJSON("/api/v1/danmaku", params);
            if (seq !== loadSeq) return; // superseded by a newer load/clear
            (d.items || []).forEach(function (it) {
              var k = (it.offset_ms || 0) + ":" + (it.text || it.content || "");
              if (!seen[k]) { seen[k] = 1; items.push(it); }
            });
            pages++;
            if (!d.has_more || !d.next_cursor) break;
            if (d.window_end && d.window_end >= dur) break;
            cursor = d.next_cursor;
          }
        } catch (e) { }
        if (seq !== loadSeq) return;
        items.sort(function (a, b) { return (a.offset_ms || 0) - (b.offset_ms || 0); });
        if (items.length > 800) items = items.slice(0, 800);
      },
      tick: function () {
        if (!settings.danmaku || !items.length) return;
        var t = ((getVideo() || {}).currentTime || 0) * 1000, budget = 3;
        // After a backward seek, walk the pointer back so the new region's
        // danmaku still get their turn instead of staying silent.
        while (ptr > 0 && (items[ptr - 1].offset_ms || 0) > t + 300) ptr--;
        while (ptr < items.length && (items[ptr].offset_ms || 0) <= t + 300) {
          var dt = t - (items[ptr].offset_ms || 0);
          if (dt >= 4000) { ptr++; continue; }
          if (budget <= 0) break; // stagger bursts instead of stacking a wall of text
          spawn(items[ptr].text || items[ptr].content || "");
          ptr++; budget--;
        }
      },
      send: function (text) { spawn(text); },
      clear: function () { items = []; ptr = 0; loadSeq++; layer.innerHTML = ""; }
    };
  }

  // ---------- feed ----------
  var feed = $("#feed");
  var feedItems = [];
  var pager = { session: "", offset: 0, kind: "recommend", loading: false, done: false, shown: {} };
  // Cross-session dedupe for the recommend cold start (cleared on tab switch).
  var coldSet = {}, coldTopups = 0;
  function createFeedVideo() {
    var v = document.createElement("video");
    v.className = "fi-video";
    v.playsInline = true;
    v.setAttribute("playsinline", "");
    v.setAttribute("preload", "auto");
    v.muted = false;
    v.loop = false;
    return v;
  }
  var feedVideo = createFeedVideo();
  // Hidden twin: preloads the NEXT drama's first frame in its own card so a
  // swipe swaps elements instead of re-loading the src (50-150ms gap).
  var feedVideoB = createFeedVideo();
  feedVideoB.muted = true;
  var fiSeekEl = document.getElementById("fi-seek");
  var activeFeed = -1, playToken = 0, feedWantPlay = false;
  var feedDanmakuLayer = null, feedDanmaku = null;

  // top overlay for home
  (function () {
    var top = document.createElement("div");
    top.className = "fi-top";
    top.style.position = "absolute"; top.style.zIndex = "20";
    top.innerHTML = '<div class="fi-tabs"><span class="on" data-kind="recommend">推荐</span><span data-kind="new">新剧</span><span data-kind="manga">漫剧</span><span data-kind="theater">剧场</span></div>' +
      '<button class="icon-btn" id="home-search">' + ic("search") + '</button>';
    $("#page-home").appendChild(top);
    top.querySelector("#home-search").addEventListener("click", function () { switchTab("search"); });
    top.querySelectorAll(".fi-tabs span").forEach(function (s) {
      s.addEventListener("click", function () {
        if (s.dataset.kind === "theater") { switchTab("theater"); return; }
        if (s.classList.contains("on") && feedItems.length) return;
        top.querySelectorAll(".fi-tabs span").forEach(function (x) { x.classList.toggle("on", x === s); });
        // Keep the currently playing drama out of the new list so the switch
        // is always visibly a different video.
        var keep = activeFeed >= 0 && feedItems[activeFeed] ? feedItems[activeFeed].d.series_id : "";
        pager.kind = s.dataset.kind; pager.session = ""; pager.offset = 0; pager.done = false; pager.shown = {};
        coldSet = {}; coldTopups = 0;
        if (keep) pager.shown[keep] = 1;
        feedVideo.pause(); feedWantPlay = false;
        feedVideo.remove(); fiSeekEl.remove(); // keep them out of the wiped cards
        feedVideoB.remove(); feedVideoB.removeAttribute("src"); feedVideoB.load(); feedVideoB.dataset.previd = "";
        feed.innerHTML = ""; feedItems = []; activeFeed = -1;
        loadFeed().then(function () { if (feedItems.length) activate(0); else toast("该分类暂无可播内容"); });
      });
    });
  })();

  function feedParams() {
    var p = { offset: String(pager.offset) };
    if (pager.session) p.session_id = pager.session;
    var shown = Object.keys(pager.shown);
    if (shown.length) p.shown = shown.join(",");
    return p;
  }
  // Shown history lives in the core (device data dir), not localStorage: the
  // WebView origin changes with the random core port on every cold start.
  function pushShown(ids) {
    ids = (ids || []).filter(Boolean);
    if (!ids.length) return;
    postJSON("/api/v1/feed-history", { ids: ids.slice(0, 60) }).catch(function () { });
  }
  async function loadFeed() {
    if (pager.loading || pager.done) return;
    pager.loading = true;
    try {
      var p = feedParams();
      if (!pager.session) {
        pager.session = String(Math.floor(Math.random() * 9e14) + 1e14);
        p.session_id = pager.session;
        if (pager.kind === "recommend") {
          // Cold start: jump into a random page of the hot pool and filter out
          // dramas already surfaced in previous sessions, like the official app.
          p.offset = String(8 * Math.floor(Math.random() * 36));
          var hist = [];
          try { hist = (await getJSON("/api/v1/feed-history")).items || []; } catch (e) { }
          hist = hist.filter(function (id) { return !pager.shown[id]; });
          hist.forEach(function (id) { coldSet[id] = 1; });
          if (hist.length) p.shown = hist.slice(0, 150).join(",");
        }
        pager.offset = Number(p.offset);
      }
      var d;
      if (pager.kind === "manga") {
        // 漫剧 channel: pull from the comic_series category pool.
        d = await getJSON("/api/v1/category", { genre: "comic_series", offset: String(pager.offset) });
      } else {
        d = await getJSON("/api/v1/lists/" + pager.kind, p);
      }
      var items = d.items || [];
      items.forEach(addFeedItem);
      // A freshly appended neighbor may be the next swipe target: resolve its
      // stream URL and warm the hidden twin right away, not only on activate.
      if (activeFeed >= 0 && feedItems[activeFeed + 1]) {
        prefetchFeed(feedItems[activeFeed + 1].d);
        preloadFeedNext(feedItems[activeFeed + 1]);
      }
      if (pager.kind === "recommend") { pushShown(items.map(function (x) { return x.series_id; })); saveFeedCache(); }
      pager.session = d.session_id || pager.session;
      pager.offset = d.next_offset ? d.next_offset : pager.offset + items.length;
      if (!d.has_more || !items.length) pager.done = true;
      // Upstream filter_ids is approximate; if client-side dedupe left the
      // first cold page nearly empty, pull more pages so the feed has content.
      if (pager.kind === "recommend" && !pager.done && feedItems.length < 6 && coldTopups < 3) {
        coldTopups++;
        pager.loading = false;
        loadFeed();
        return;
      }
    } catch (e) { pager.done = true; }
    pager.loading = false;
  }

  // Cold-start fast path: the previous recommendation batch lives on disk in
  // the core (WebView localStorage dies with the ephemeral origin), so the
  // next launch can paint covers and start the first video while the fresh
  // page is still in flight. Fresh items dedupe against pager.shown.
  async function bootFeedCache() {
    try {
      var c = await getJSON("/api/v1/feed-cache");
      if (!c || !c.items || !c.items.length || !c.ts || Date.now() - c.ts > 12 * 3600 * 1000) return;
      if (pager.kind !== "recommend") return;
      // Rotate the cached batch so every launch opens on a different drama
      // instead of replaying the same first screen.
      var n = c.items.length, k = Math.floor(Math.random() * n);
      for (var j = 0; j < n; j++) addFeedItem(c.items[(k + j) % n]);
      // Start resolving play URLs immediately — don't wait for activate()'s
      // serial path; the srcCache hit then makes the first frame instant.
      for (var q = 0; q < Math.min(3, feedItems.length); q++) {
        var cd = feedItems[q].d;
        prefetchFeed(cd, (cd.vid_list && cd.vid_list[0]) || cd.vid);
      }
      if (feedItems.length) activate(0);
    } catch (e) { }
  }
  var feedCacheTimer = null;
  function saveFeedCache() {
    if (pager.kind !== "recommend" || !feedItems.length) return;
    clearTimeout(feedCacheTimer);
    feedCacheTimer = setTimeout(function () {
      postJSON("/api/v1/feed-cache", { items: feedItems.slice(0, 24).map(function (x) { return x.d; }) }).catch(function () { });
    }, 1500);
  }

  function addFeedItem(d) {
    if (!d || !d.series_id || pager.shown[d.series_id] || coldSet[d.series_id]) return;
    pager.shown[d.series_id] = 1;
    var idx = feedItems.length;
    var c = hashColor(d.series_id);
    var el = document.createElement("article");
    el.className = "feed-item";
    el.dataset.idx = String(idx);
    var tags = (d.tags || []).slice(0, 3).map(function (t) { return "<span>" + esc(t) + "</span>"; }).join("");
    var heat = num(d.play_count) ? '<small>' + num(d.play_count) + '人在看</small>' : "";
    // Favourite button shows the real collect count when the API provides it.
    var favLabel = d.favorite_text ? '<small class="fav-n">' + esc(String(d.favorite_text)) + '</small>' : heat;
    el.innerHTML =
      '<div class="fi-scene"><div class="bg" style="background-image:' + (coverOf(d) ? 'url(' + esc(coverOf(d)) + '),linear-gradient(160deg,' + c[0] + ',' + c[1] + ')' : 'linear-gradient(160deg,' + c[0] + ',' + c[1] + ')') + '"></div>' +
      '<div class="fi-danmaku-layer" style="position:absolute;top:0;left:0;right:0;height:var(--dm-area,25%);z-index:3;pointer-events:none;overflow:hidden"></div></div>' +
      '<button class="fi-watch">' + ic("play") + '观看完整剧情 · 全' + (d.episode_count || "?") + '集</button>' +
      '<button class="fi-danmaku' + (settings.danmaku ? " on" : "") + '">弹' + (settings.danmaku ? "✓" : "×") + '</button>' +
      '<button class="fi-full-btn">' + ic("full") + '全屏观看</button>' +
      '<div class="fi-info"><div class="fi-title">' + esc(d.title) + '</div>' +
      '<div class="fi-tags">' + tags + '</div><div class="fi-desc">' + esc(d.intro || "") + '</div></div>' +
      '<div class="fi-side">' +
      '<button class="fi-act" data-act="cast">' + ic("cast") + '</button>' +
      '<button class="fi-act" data-act="cmt">' + ic("msg") + '</button>' +
      '<button class="fi-act" data-act="rank">' + ic("trophy") + '</button>' +
      '<button class="fi-act" data-act="fav">' + ic("star") + favLabel + '</button>' +
      '</div>' +
      '<div class="fi-play"><button class="icon-btn">' + ic("play") + '</button></div>';
    el.querySelector(".fi-danmaku").addEventListener("click", function () {
      settings.danmaku = !settings.danmaku; saveSettings();
      feedItems.forEach(function (x) {
        var b = x.el.querySelector(".fi-danmaku");
        if (b) { b.classList.toggle("on", settings.danmaku); b.textContent = "弹" + (settings.danmaku ? "✓" : "×"); }
      });
      toast("弹幕：" + (settings.danmaku ? "开" : "关"));
    });
    feed.appendChild(el);
    var bgEl = el.querySelector(".bg");
    if (coverOf(d)) {
      var im0 = new Image();
      im0.onload = im0.onerror = function () { bgEl.classList.add("on"); };
      im0.src = coverOf(d);
    } else bgEl.classList.add("on");
    var it = { d: d, el: el, idx: idx };
    feedItems.push(it);
    el.querySelector(".fi-watch").addEventListener("click", function (e) { e.stopPropagation(); openPlayer(d, 0, 0, false); });
    el.querySelector(".fi-full-btn").addEventListener("click", function (e) { e.stopPropagation(); openPlayer(d, 0, 0, true); });
    el.querySelector(".fi-play").addEventListener("click", function (e) {
      e.stopPropagation(); feedVideo.muted = false;
      var vid = d.vid || (d.vid_list && d.vid_list[0]) || "";
      if (!feedVideo.getAttribute("src")) resolveFeedPlay(d, vid); else tryPlayFeed();
      this.classList.remove("show");
    });
    // tap the picture to pause/resume, like the official app
    el.querySelector(".fi-scene").addEventListener("click", function () {
      if (idx !== activeFeed) return;
      if (feedVideo.paused) {
        el.querySelector(".fi-play").classList.remove("show");
        if (feedVideo.getAttribute("src")) tryPlayFeed();
        else resolveFeedPlay(d, d.vid || (d.vid_list && d.vid_list[0]) || "");
      } else {
        feedVideo.pause(); feedWantPlay = false;
        el.querySelector(".fi-play").classList.add("show");
      }
    });
    el.querySelectorAll(".fi-act").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        var vid = d.vid || (d.vid_list && d.vid_list[0]) || "";
        if (b.dataset.act === "cast") { openCastSheet(); return; }
        if (b.dataset.act === "fav") toggleFav(b, d);
        if (b.dataset.act === "rank") openRankPage();
        if (b.dataset.act === "cmt") { homeCmtD = d; homeCmt.open(); }
      });
    });
  }

  function showFeedSpin(it) {
    if (!it || it.el.querySelector(".fi-spin")) return;
    var s = document.createElement("div");
    s.className = "fi-spin";
    it.el.querySelector(".fi-scene").appendChild(s);
  }
  function hideFeedSpin() {
    feed.querySelectorAll(".fi-spin").forEach(function (s) { s.remove(); });
  }
  function activate(i) {
    if (i === activeFeed || !feedItems[i]) return;
    if (homeCmt) homeCmt.close(); // switching drama closes the comment panel
    activeFeed = i;
    var it = feedItems[i];
    var d = it.d;
    var vid = d.vid || (d.vid_list && d.vid_list[0]) || "";
    feedWantPlay = false;
    feed.querySelectorAll(".fi-play.show").forEach(function (x) { x.classList.remove("show"); });
    it.el.appendChild(fiSeekEl);
    feedDanmakuLayer = it.el.querySelector(".fi-danmaku-layer");
    // Dual-element fast path: the hidden twin already decoded this drama's
    // first frame → swap elements instead of re-loading the src.
    var swapped = swapFeedPreloaded(it, vid);
    feedDanmaku = makeDanmaku(feedDanmakuLayer, function () { return feedVideo; });
    if (swapped) {
      var fullBtn = it.el.querySelector(".fi-full-btn");
      if (fullBtn) fullBtn.classList.toggle("show", feedVideo.classList.contains("landscape"));
      feedDanmaku.load(d.series_id, vid, 180000);
      tryPlayFeed();
      if (feedVideo.readyState < 2) showFeedSpin(it);
    } else {
      feedVideo.pause();
      feedVideo.classList.remove("playing");
      it.el.querySelector(".fi-scene").appendChild(feedVideo);
      resolveFeedPlay(d, vid);
      showFeedSpin(it);
    }
    if (feedItems[i + 1]) prefetchFeed(feedItems[i + 1].d);
    if (feedItems[i + 2]) prefetchFeed(feedItems[i + 2].d);
    preloadFeedNext(feedItems[i + 1]);
    loadFeed();
  }
  function swapFeedPreloaded(it, vid) {
    if (!feedVideoB.getAttribute("src") || feedVideoB.error) return false;
    if (feedVideoB.dataset.previd !== vid) return false;
    if (!it.el.querySelector(".fi-scene").contains(feedVideoB)) return false;
    playToken++; // invalidate any in-flight resolveFeedPlay
    var old = feedVideo;
    old.pause();
    old.classList.remove("playing");
    old.removeAttribute("src"); old.load(); // release the old decoder/buffer
    feedVideo = feedVideoB;
    feedVideoB = old;
    feedVideoB.dataset.previd = "";
    feedVideo.muted = false;
    feedVideo.playbackRate = settings.speed || 1;
    // Ready → reveal instantly. Still buffering → keep the in-flight fetch
    // (far better than restarting the same src on the other element) and let
    // the playing event fade the picture in.
    if (feedVideo.readyState >= 2) feedVideo.classList.add("playing");
    return true;
  }
  function attachFeedPreload(it, vid, hit) {
    if (feedVideoB.dataset.previd === vid) return;
    feedVideoB.pause();
    feedVideoB.removeAttribute("src");
    feedVideoB.dataset.previd = vid;
    feedVideoB.muted = true;
    feedVideoB.classList.remove("playing");
    feedVideoB.classList.toggle("landscape", hit.w > hit.h);
    it.el.querySelector(".fi-scene").appendChild(feedVideoB);
    feedVideoB.src = hit.path;
    feedVideoB.load();
  }
  function preloadFeedNext(it) {
    if (!it || it !== feedItems[activeFeed + 1]) return;
    var d = it.d;
    var vid = d.vid || (d.vid_list && d.vid_list[0]) || "";
    if (!vid) return;
    var hit = srcCache[vid];
    if (hit && hit.path) { attachFeedPreload(it, vid, hit); return; }
    if (!hit) { prefetchFeed(d); hit = srcCache[vid]; }
    if (hit && hit.p) hit.p.then(function (e) {
      if (e && e.path && feedItems[activeFeed + 1] === it) attachFeedPreload(it, vid, e);
    });
  }

  // ---------- DLNA cast ----------
  // ctx remembers what is on the TV so playback can auto-advance to the next
  // episode: { d: drama, idx: epIndex, n: totalEps, player: bool }
  var castState = { casting: false, usn: "", name: "", poll: null, ctx: null, lastPos: "", lastDur: "", advancing: false };
  var castDevs = [];
  function castLock(on) { try { if (window.HongguoTVCast) window.HongguoTVCast.lock(!!on); } catch (e) { } }
  // Android blocks Go's net.Interfaces(), so the bridge hands the Wi-Fi IPv4
  // to the core for building the renderer-facing media URLs.
  function castLanIP() { try { return (window.HongguoTVCast && window.HongguoTVCast.lanIP()) || ""; } catch (e) { return ""; } }
  function markCastIcon() {
    document.querySelectorAll('.fi-act[data-act="cast"], #p-cast').forEach(function (b) { b.classList.toggle("casting", castState.casting); });
  }
  function castSheetHtml() {
    var h = "";
    if (castState.casting) {
      h += '<div class="cast-now">正在投屏：<b>' + esc(castState.name) + '</b><button class="cast-stop">停止投屏</button></div>';
    }
    if (!castDevs.length) h += '<div class="cast-empty">正在搜索投屏设备…（请确保电视与手机在同一 Wi-Fi，并已允许局域网通信）</div>';
    else h += castDevs.map(function (dv, i) { return '<button class="cast-dev" data-i="' + i + '">' + ic("cast") + '<span>' + esc(dv.name || dv.host || "未知设备") + '</span></button>'; }).join("");
    h += '<button class="cast-refresh">重新搜索</button>';
    return h;
  }
  function bindCastSheet() {
    sheetBody.querySelectorAll(".cast-dev").forEach(function (b) {
      b.addEventListener("click", function () { castCurrent(castDevs[Number(b.dataset.i)]); });
    });
    var st = sheetBody.querySelector(".cast-stop");
    if (st) st.addEventListener("click", stopCast);
    var rf = sheetBody.querySelector(".cast-refresh");
    if (rf) rf.addEventListener("click", function () { castDevs = []; renderCast(); fetchCastDevices(true); });
  }
  function renderCast() { sheetBody.innerHTML = castSheetHtml(); bindCastSheet(); }
  async function fetchCastDevices(refresh) {
    try {
      var p = { lan_ip: castLanIP() };
      if (refresh) p.refresh = "1";
      var d = await getJSON("/api/v1/cast/devices", p);
      castDevs = d.devices || [];
    } catch (e) { /* keep the searching placeholder */ }
    renderCast();
  }
  function openCastSheet() {
    castLock(true);
    openSheet("投屏到电视", '<div class="cast-empty">正在搜索投屏设备…</div>');
    renderCast();
    fetchCastDevices(true);
  }
  function castVidAt(ctx, idx) {
    var v = ctx.vids ? ctx.vids[idx] : (ctx.d.vid_list || [])[idx];
    if (!v && idx === 0) v = ctx.d.vid || "";
    return v || "";
  }
  // Feed drama cards only carry the entry vid, so chaining needs the full
  // episode list fetched from the series detail (mirrors openPlayer).
  async function castFetchVids(d) {
    var eps = d.episodes && d.episodes.length ? d.episodes : null;
    if (!eps) {
      try {
        var det = await getJSON("/api/v1/series/detail", { series_id: d.series_id });
        if (det && det.episodes && det.episodes.length) { eps = det.episodes; d.episodes = eps; }
      } catch (e) { }
    }
    if (!eps) return null;
    return eps.map(function (e) { return e.video_id || e.vid || ""; });
  }
  async function castPath(d, vid) {
    var hit = srcCache[vid];
    if (hit && hit.path) return hit.path;
    try {
      var info = (hit && hit.p) ? await hit.p : null;
      if (info && info.path) return info.path;
      info = await getJSON("/api/v1/play/info", { series_id: d.series_id, vid: vid, quality: settings.quality, mode: "range", fallback: "1" });
      return info.path || "";
    } catch (e) { return ""; }
  }
  async function castStartOn(usn, ctx, idx) {
    var d = ctx.d;
    var vid = castVidAt(ctx, idx);
    if (!vid) return "none";
    var path = await castPath(d, vid);
    if (!path) return "stream";
    var title = (d.title || "") + (idx > 0 ? " 第" + (idx + 1) + "集" : "");
    await postJSON("/api/v1/cast/start?lan_ip=" + encodeURIComponent(castLanIP()), { usn: usn, media: path, title: title });
    return "";
  }
  async function castCurrent(dev) {
    if (!dev) return;
    var ctx;
    if (player.classList.contains("open") && pd.drama) {
      // Casting from the player page: follow the drama/episode actually open.
      var vids = (pd.eps || []).map(function (e) { return e.video_id || e.vid || ""; });
      ctx = { d: pd.drama, idx: pd.idx, n: (pd.eps && pd.eps.length) || (pd.drama.vid_list || []).length || 1, player: true };
      if (vids.length) ctx.vids = vids;
    } else {
      var it = feedItems[activeFeed];
      if (!it) return;
      ctx = { d: it.d, idx: 0, n: (it.d.vid_list || []).length || 1, player: false };
    }
    if (ctx.n > 1 && !ctx.vids) {
      var fv = await castFetchVids(ctx.d);
      if (fv) { ctx.vids = fv; if (fv.length > ctx.n) ctx.n = fv.length; }
    }
    try {
      var err = await castStartOn(dev.usn, ctx, ctx.idx);
      if (err === "none") { toast("该视频暂无可投屏片源"); return; }
      if (err === "stream") { toast("取流失败"); return; }
      castState.casting = true; castState.usn = dev.usn; castState.name = dev.name || "电视";
      castState.ctx = ctx; castState.lastPos = ""; castState.lastDur = ""; castState.advancing = false;
      if (ctx.player) pVideo.pause();
      else { feedVideo.pause(); feedWantPlay = false; }
      markCastIcon(); renderCast(); startCastPoll();
      toast("已投屏到 " + castState.name);
    } catch (e) { toast("投屏失败：" + e.message); }
  }
  async function stopCast() {
    try { await postJSON("/api/v1/cast/stop", { usn: castState.usn }); } catch (e) { }
    castState.casting = false; castState.name = ""; castState.usn = ""; castState.ctx = null;
    markCastIcon(); renderCast(); stopCastPoll();
    toast("已停止投屏");
  }
  function castSec(t) {
    var p = String(t || "").split(":");
    if (p.length < 2) return -1;
    return (Number(p[0]) || 0) * 3600 + (Number(p[1]) || 0) * 60 + (Number(p[2]) || 0);
  }
  // Seamless chaining: poll every 5s normally, but once the TV is inside the
  // last 20s of an episode switch to 700ms and prefetch the next episode's
  // stream. At dur-2s the next episode is pushed to the renderer immediately
  // (SetAVTransportURI interrupts the tail), so the TV buffers episode N+1
  // while episode N is finishing instead of after a STOPPED round-trip.
  function startCastPoll() {
    stopCastPoll();
    var tick = function () {
      getJSON("/api/v1/cast/status").then(function (s) {
        var next = 5000;
        if (s.casting) {
          castState.lastPos = s.pos; castState.lastDur = s.duration;
          var pos = castSec(s.pos), dur = castSec(s.duration);
          var ctx = castState.ctx;
          if (ctx && dur > 0 && pos >= 0 && ctx.idx + 1 < ctx.n && pos >= dur - 20) {
            next = 700;
            castPrefetchNext(ctx);
            if (settings.auto && !castState.advancing && pos >= dur - 2) { next = 5000; castAdvance(ctx); }
          }
        } else if (castState.casting && !castState.advancing) {
          // No position feedback (or the early push missed): the TV stopped
          // by itself. Only chain when the last observed position sat near
          // the end; a mid-episode stop means the user took control.
          var c = castState.ctx;
          var p = castSec(castState.lastPos), d = castSec(castState.lastDur);
          var naturalEnd = d < 0 || p < 0 || p >= d - 25;
          if (settings.auto && c && c.idx + 1 < c.n && naturalEnd) castAdvance(c);
          else castRestorePhone();
        }
        if (castState.casting) castState.poll = setTimeout(tick, next);
      }, function () {
        if (castState.casting) castState.poll = setTimeout(tick, 5000);
      });
    };
    castState.poll = setTimeout(tick, 5000);
  }
  function castPrefetchNext(ctx) {
    var vid = castVidAt(ctx, ctx.idx + 1);
    if (!vid || srcCache[vid]) return;
    var ent = srcCache[vid] = { loading: true };
    ent.p = getJSON("/api/v1/play/info", { series_id: ctx.d.series_id, vid: vid, quality: settings.quality, mode: "range", fallback: "1" })
      .then(function (info) { ent.path = info.path; ent.loading = false; return ent; })
      .catch(function () { if (srcCache[vid] === ent) delete srcCache[vid]; });
  }
  async function castAdvance(ctx) {
    castState.advancing = true;
    var err = "stream";
    try { err = await castStartOn(castState.usn, ctx, ctx.idx + 1); } catch (e) { err = "stream"; }
    castState.advancing = false;
    if (!err) {
      ctx.idx += 1; castState.ctx = ctx;
      castState.lastPos = ""; castState.lastDur = "";
      toast("电视继续播放第" + (ctx.idx + 1) + "集");
      if (sheetWrap.classList.contains("open")) renderCast();
    } else {
      castRestorePhone();
      toast(err === "none" ? "本剧已播完" : "下一集投屏失败，已停止");
    }
  }
  function castRestorePhone() {
    castState.casting = false; castState.name = ""; castState.usn = ""; castState.ctx = null;
    markCastIcon(); stopCastPoll();
    if (sheetWrap.classList.contains("open")) renderCast();
  }
  function stopCastPoll() { if (castState.poll) { clearTimeout(castState.poll); castState.poll = null; } }

  // Cache resolved play URLs so swiping to the next drama starts instantly
  // instead of waiting for /play/info (which caused the black flash).
  var srcCache = {};
  function prefetchFeed(d, vidArg) {
    var vid = vidArg || d.vid || (d.vid_list && d.vid_list[0]) || "";
    if (!vid || srcCache[vid]) return;
    var entry = srcCache[vid] = { loading: true };
    // prefetch=1: background priority inside the core, never competes with
    // the currently visible feed video's range fetches.
    entry.p = getJSON("/api/v1/play/info", { series_id: d.series_id, vid: vid, quality: settings.quality, mode: "range", fallback: "1", prefetch: "1" })
      .then(function (info) { entry.path = info.path; entry.w = info.video_width || 0; entry.h = info.video_height || 0; entry.loading = false; return entry; })
      .catch(function () { if (srcCache[vid] === entry) delete srcCache[vid]; });
  }
  function applyFeedSrc(d, vid, hit) {
    feedVideo.src = hit.path;
    feedVideo.playbackRate = settings.speed || 1;
    feedVideo.classList.toggle("landscape", hit.w > hit.h);
    var fullBtn = feedItems[activeFeed] && feedItems[activeFeed].el.querySelector(".fi-full-btn");
    if (fullBtn) fullBtn.classList.toggle("show", hit.w > hit.h);
    feedVideo.currentTime = 0;
    tryPlayFeed();
    feedDanmaku.clear();
    feedDanmaku.load(d.series_id, vid, 180000);
    // Warm the next episode's URL so the auto-chain at "ended" skips the
    // /play/info round trip (the feed twin is busy with the next drama).
    var li = (d.vid_list || []).indexOf(vid);
    if (li >= 0 && d.vid_list[li + 1]) prefetchFeed(d, d.vid_list[li + 1]);
  }
  async function resolveFeedPlay(d, vid, fresh) {
    var token = ++playToken;
    if (!vid) { feedVideo.removeAttribute("src"); return; }
    var hit = fresh ? null : srcCache[vid];
    if (hit && hit.path) { applyFeedSrc(d, vid, hit); return; }
    try {
      var info = (hit && hit.p) ? await hit.p.catch(function () { return null; }) : null;
      if (token !== playToken) return;
      if (!info || !info.path) info = await getJSON("/api/v1/play/info", fresh
        ? { series_id: d.series_id, vid: vid, quality: settings.quality, mode: "range", fallback: "1", nc: "1" }
        : { series_id: d.series_id, vid: vid, quality: settings.quality, mode: "range", fallback: "1" });
      if (token !== playToken) return;
      srcCache[vid] = { path: info.path, w: info.video_width || 0, h: info.video_height || 0 };
      applyFeedSrc(d, vid, srcCache[vid]);
    } catch (e) {
      if (token === playToken) {
        toast("取流失败，点画面重试");
        var el = feedItems[activeFeed] && feedItems[activeFeed].el;
        if (el) el.querySelector(".fi-play").classList.add("show");
      }
    }
  }
  function tryPlayFeed() {
    if (castState.casting) { feedWantPlay = false; return; } // TV keeps playing, not the phone
    feedWantPlay = true;
    var p = feedVideo.play();
    if (p && p.catch) p.catch(function () {
      var el = feedItems[activeFeed] && feedItems[activeFeed].el;
      if (el) el.querySelector(".fi-play").classList.add("show");
    });
  }
  // Cold start can reject the first play() while the WebView is still hidden;
  // resume as soon as the page becomes visible again.
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && feedWantPlay && feedVideo.paused && activeFeed >= 0) tryPlayFeed();
  });
  var feedDragging = false;
  function bindFeedVideo(el) {
    el.addEventListener("playing", function () {
      if (el !== feedVideo) return;
      el.classList.add("playing");
      el.dataset.failedvid = "";
      hideFeedSpin();
      notifyStartupReady(); // first visible frame → native splash may step aside
      var itm = feedItems[activeFeed] && feedItems[activeFeed].el;
      if (itm) itm.querySelector(".fi-play").classList.remove("show");
    });
    // Decode kick: Chromium throttles off-screen videos, so the preloaded
    // twin would only start fetching once the swipe swaps it in. A muted
    // micro-play warms the pipeline while the CURRENT drama still plays.
    el.addEventListener("loadeddata", function () {
      if (el === feedVideo || !el.dataset.previd) return;
      var p = el.play();
      if (p && p.then) p.then(function () { if (el !== feedVideo) el.pause(); }).catch(function () { });
    });
    el.addEventListener("pause", function () { if (el === feedVideo) hideFeedSpin(); });
    // Signed play URLs expire. A srcCache hit from an early prefetch can be
    // dead by the time the user swipes here → MEDIA_ERR_SRC_NOT_SUPPORTED
    // stuck on the cover. Invalidate the stale entry and refetch once.
    el.addEventListener("error", function () {
      if (el !== feedVideo) return;
      var it = feedItems[activeFeed];
      if (!it) return;
      var d = it.d;
      var vid = d.vid || (d.vid_list && d.vid_list[0]) || "";
      if (!vid || el.dataset.failedvid === vid) return; // one retry per vid
      el.dataset.failedvid = vid;
      delete srcCache[vid];
      resolveFeedPlay(d, vid, true);
      showFeedSpin(it);
    });
    el.addEventListener("timeupdate", function () {
      if (el !== feedVideo) return;
      var it = feedItems[activeFeed];
      if (!it || !el.duration) return;
      if (!feedDragging) $("#fi-seek-fill").style.width = (el.currentTime / el.duration * 100) + "%";
      if (feedDanmaku) feedDanmaku.tick();
    });
    el.addEventListener("ended", function () {
      if (el !== feedVideo) return;
      var it = feedItems[activeFeed];
      if (it) nextFeedEpisode(it);
    });
    // Preloader: force the first frame to render while still hidden, so the
    // swap reveals a decoded picture instead of a black poster.
    el.addEventListener("loadeddata", function () {
      if (el === feedVideo || !el.dataset.previd) return;
      var p = el.play();
      if (p && p.then) p.then(function () { if (el !== feedVideo) el.pause(); }).catch(function () { });
    });
  }
  bindFeedVideo(feedVideo);
  bindFeedVideo(feedVideoB);
  // draggable bottom seek bar with preview overlay (matches the official app)
  (function () {
    var bar = $("#fi-seek"), ov = $("#feed-seek-ov"), fsoFill = $("#fso-fill"),
      fsoTime = $("#fso-time"), fsoImg = $("#fso-img");
    var ratio = 0;
    function pos(e) {
      var r = bar.getBoundingClientRect();
      var x = (e.touches && e.touches[0] ? e.touches[0].clientX : e.changedTouches[0].clientX);
      ratio = Math.min(1, Math.max(0, (x - r.left - 14) / (r.width - 28)));
    }
    function render() {
      var dur = feedVideo.duration || 0;
      $("#fi-seek-fill").style.width = ratio * 100 + "%";
      fsoFill.style.width = ratio * 100 + "%";
      fsoTime.innerHTML = "<b>" + fmt(ratio * dur) + "</b>/" + fmt(dur);
    }
    bar.addEventListener("touchstart", function (e) {
      if (!feedItems.length || !feedVideo.duration) return;
      e.preventDefault(); e.stopPropagation();
      feedDragging = true;
      var it = feedItems[activeFeed];
      if (it && coverOf(it.d)) { fsoImg.src = coverOf(it.d); fsoImg.style.display = "block"; }
      else fsoImg.style.display = "none";
      pos(e); render();
      ov.classList.add("show");
    }, { passive: false });
    bar.addEventListener("touchmove", function (e) {
      if (!feedDragging) return;
      e.preventDefault(); pos(e); render();
    }, { passive: false });
    function end(e) {
      if (!feedDragging) return;
      feedDragging = false;
      ov.classList.remove("show");
      pos(e);
      if (feedVideo.duration) feedVideo.currentTime = ratio * feedVideo.duration;
    }
    bar.addEventListener("touchend", end);
    bar.addEventListener("touchcancel", end);
  })();
  feed.addEventListener("scroll", function () {
    var h = feed.clientHeight || 1;
    var i = Math.round(feed.scrollTop / h);
    if (i !== activeFeed) activate(i);
    if (i >= feedItems.length - 2) loadFeed();
  }, { passive: true });
  // Long-press 2x boost on the home feed (movement/scroll cancels the timer).
  var fBoost = makeBoost(function () { return feedVideo; }, feed, function (t) {
    return t.closest("button, input, a, .fi-seek, .fi-side, .fi-info, .fi-top, .home-cmt");
  });

  function nextFeedEpisode(it) {
    var d = it.d;
    var list = d.vid_list && d.vid_list.length ? d.vid_list : null;
    if (!list) { openPlayer(d, 1, 0, false); return; }
    var cur = list.indexOf(d.vid);
    var next = list[Math.min(list.length - 1, cur + 1)];
    d.vid = next;
    if (list[cur + 2]) prefetchFeed(d, list[cur + 2]);
    resolveFeedPlay(d, next);
  }

  // ---------- library helpers ----------
  // The core library guard requires the current owner id (empty for guests).
  var libOwner = null;
  async function libraryOwner() {
    if (libOwner === null) { try { var d = await getJSON("/api/v1/library"); libOwner = d.owner_id || ""; } catch (e) { libOwner = ""; } }
    return libOwner;
  }
  // The core rejects unknown JSON fields, so only send the Drama shape.
  function slimDrama(d) {
    return { series_id: d.series_id, title: d.title || "", cover: coverOf(d) || "", intro: d.intro || "", score: d.score || "", play_count: d.play_count || 0, episode_count: d.episode_count || 0, vid: d.vid || "", vid_list: d.vid_list || [], tags: d.tags || [] };
  }
  async function toggleFav(btn, d) {
    var on = !btn.classList.contains("faved");
    try {
      await postJSON("/api/v1/library", { owner_id: await libraryOwner(), action: "favorite", series_id: d.series_id, value: on, drama: slimDrama(d) });
      btn.classList.toggle("faved", on);
      toast(on ? "已收藏" : "已取消收藏");
    } catch (e) { toast("收藏失败：" + (e.message || e)); }
  }
  // Resume support: a short-lived map of series_id → last history entry,
  // consulted when a drama is opened "from scratch" (no explicit episode or
  // position), so reopening a series jumps to where the user left off.
  var libCache = { t: 0, map: null };
  async function historyMap() {
    if (libCache.map && Date.now() - libCache.t < 20000) return libCache.map;
    try {
      var d = await getJSON("/api/v1/library", {});
      var m = {};
      (d.entries || []).forEach(function (e) {
        if (e.drama && e.drama.series_id && e.last_played_at) m[e.drama.series_id] = e;
      });
      libCache = { t: Date.now(), map: m };
    } catch (e) { }
    return libCache.map || {};
  }
  // ---------- player ----------
  var player = $("#player"), pScene = $("#p-scene"), pVideo = $("#p-video");
  var pd = { drama: null, eps: [], idx: 0, vid: "", info: null, token: 0 };
  // Hidden twin: preloads the next episode's first frame so a swipe swaps
  // elements instead of re-loading the src (same trick as the home feed).
  var pVideoB = document.createElement("video");
  pVideoB.className = "p-video p-preload";
  pVideoB.playsInline = true;
  pVideoB.setAttribute("playsinline", "");
  pVideoB.setAttribute("preload", "auto");
  pVideoB.muted = true;
  pScene.appendChild(pVideoB);
  var pDanmaku = makeDanmaku($("#p-danmaku-layer"), function () { return pVideo; });
  bindPVideo(pVideo);
  bindPVideo(pVideoB);
  applyAV();
  var cinema = false, swipeUntil = 0;

  function epVid(i) {
    var e = pd.eps[i];
    if (!e) return "";
    return e.video_id || e.vid || (pd.drama.vid_list && pd.drama.vid_list[i]) || "";
  }
  async function openPlayer(d, epIndex, resume, forceCinema) {
    epCache = {};
    resetPPreload();
    // "Fresh" opens (no explicit episode/position) resume from history like
    // the official app: jump to the last watched episode and seek to it.
    if (epIndex === 0 && !resume && d.series_id) {
      var he = (await historyMap())[d.series_id];
      if (he && (he.position || 0) > 15 && (he.episode || 1) >= 1) {
        epIndex = Math.max(0, (he.episode || 1) - 1);
        resume = he.position;
        setTimeout(function () { showTopTip("续播：第" + (he.episode || 1) + "集 · " + fmt(he.position), 2200); }, 700);
      }
    }
    pd.drama = d; pd.idx = Math.max(0, epIndex || 0);
    // The entry episode's vid is usually already known from the feed card, so
    // start its play/info now and overlap it with the series/detail fetch;
    // playEpisode awaits this same request instead of issuing a fresh one.
    var seedVid = (pd.idx === 0 && d.vid) ? d.vid : ((d.vid_list || [])[pd.idx] || "");
    if (seedVid) {
      var seedKey = d.series_id + ":" + pd.idx;
      var seed = epCache[seedKey] = { loading: true };
      seed.p = getJSON("/api/v1/play/info", { series_id: d.series_id, vid: seedVid, quality: settings.quality, mode: "range", fallback: "1" })
        .then(function (info) { seed.path = info.path; seed.quality = info.quality || ""; seed.loading = false; return seed; })
        .catch(function () { if (epCache[seedKey] === seed) delete epCache[seedKey]; });
    }
    feedVideo.pause(); feedWantPlay = false;
    player.classList.add("open"); $("#tabbar").classList.add("hidden");
    var c = hashColor(d.series_id);
    $("#p-bg").style.background = "linear-gradient(160deg," + c[0] + "," + c[1] + ")";
    if (coverOf(d)) { $("#p-bg").style.backgroundImage = "url(" + coverOf(d) + ")"; $("#p-bg").style.backgroundSize = "cover"; }
    $("#p-title").textContent = d.title || "";
    $("#p-title2").textContent = d.title || "";
    if (!d.episodes || !d.episodes.length) {
      try {
        var det = await getJSON("/api/v1/series/detail", { series_id: d.series_id });
        if (det && det.episodes && det.episodes.length) { d.episodes = det.episodes; }
      } catch (e) { }
    }
    pd.eps = (d.episodes && d.episodes.length) ? d.episodes : Array.from({ length: d.episode_count || 1 }, function (_, i) { return { index: i + 1, video_id: (d.vid_list || [])[i] || "" }; });
    if (forceCinema) enterCinema();
    playEpisode(pd.idx, resume);
  }
  function closePlayer() {
    cmtUI.close();
    player.classList.remove("open");
    saveProgress();
    pVideo.pause(); pd.token++; resetPPreload();
    if (cinema) exitCinema();
    openDetail(pd.drama);
  }
  $("#p-back").addEventListener("click", closePlayer);

  // Prefetch neighboring episodes' play URLs so swipe-switching is instant
  // (the old 1-2s wait was the /play/info round trip after the animation).
  var epCache = {};
  function prefetchEpisode(i) {
    if (!pd.drama || !pd.eps || !pd.eps[i]) return;
    var vid = epVid(i);
    var key = pd.drama.series_id + ":" + i;
    if (!vid || epCache[key]) return;
    var entry = epCache[key] = { loading: true };
    // prefetch=1 marks this as background priority inside the core so it
    // never competes with the foreground episode's range fetches.
    entry.p = getJSON("/api/v1/play/info", { series_id: pd.drama.series_id, vid: vid, quality: settings.quality, mode: "range", fallback: "1", prefetch: "1" })
      .then(function (info) { entry.path = info.path; entry.quality = info.quality || ""; entry.loading = false; return entry; })
      .catch(function () { if (epCache[key] === entry) delete epCache[key]; });
  }
  function swapPVideo() {
    var old = pVideo;
    old.pause();
    old.onloadedmetadata = null;
    old.removeAttribute("src"); old.load();
    old.classList.add("p-preload");
    pVideo = pVideoB;
    pVideoB = old;
    pVideoB.dataset.previd = "";
    pVideo.classList.remove("p-preload");
    pVideo.muted = false;
    pVideo.playbackRate = settings.speed || 1;
  }
  function attachPPreload(vid, ent) {
    if (pVideoB.dataset.previd === vid || vid === pd.vid) return;
    pVideoB.dataset.previd = vid;
    pVideoB.muted = true;
    pVideoB.classList.add("p-preload");
    pVideoB.removeAttribute("src");
    pVideoB.src = ent.path;
    pVideoB.load();
  }
  function preloadEpisodeNext(i) {
    if (!pd.drama || !pd.eps || !pd.eps[i] || i !== pd.idx + 1) return;
    var vid = epVid(i);
    if (!vid || vid === pd.vid) return;
    var key = pd.drama.series_id + ":" + i;
    var e = epCache[key];
    if (e && e.path) { attachPPreload(vid, e); return; }
    if (!e) prefetchEpisode(i);
    e = epCache[key];
    if (e && e.p) e.p.then(function (ent) {
      if (ent && ent.path && pd.idx + 1 === i) attachPPreload(vid, ent);
    });
  }
  function resetPPreload() {
    pVideoB.pause();
    pVideoB.removeAttribute("src");
    pVideoB.load();
    pVideoB.dataset.previd = "";
  }
  function bindPVideo(el) {
    el.addEventListener("play", function () { if (el === pVideo) updateToggle(); });
    el.addEventListener("pause", function () { if (el === pVideo) updateToggle(); });
    el.addEventListener("timeupdate", function () {
      if (el !== pVideo || !el.duration) return;
      if (!seekDragging) {
        var r = el.currentTime / el.duration;
        $("#p-seek").value = String(Math.round(r * 1000));
        $("#p-seek").style.setProperty("--p", (r * 100) + "%");
        $("#p-cur").textContent = fmt(el.currentTime);
      }
      pDanmaku.tick();
      var now = Date.now();
      if (now - lastSave > 10000) saveProgress();
    });
    el.addEventListener("ended", function () {
      if (el !== pVideo) return;
      if (settings.auto && pd.eps[pd.idx + 1]) playEpisode(pd.idx + 1, 0, true);
      else if (pd.eps[pd.idx + 1]) toast("播放完毕");
    });
    el.addEventListener("playing", function () { if (el === pVideo) pBridge.classList.remove("on"); });
    // Preloader: force the first frame to render while still hidden.
    el.addEventListener("loadeddata", function () {
      if (el === pVideo || !el.dataset.previd) return;
      var p = el.play();
      if (p && p.then) p.then(function () { if (el !== pVideo) el.pause(); }).catch(function () { });
    });
  }
  async function playEpisode(i, startAt, silent) {
    if (!pd.eps[i]) return;
    pd.idx = i;
    speedLabel();
    var vid = epVid(i);
    pd.vid = vid;
    cmtUI.sync();
    var token = ++pd.token;
    pVideo.muted = false;
    $("#p-ep-title").textContent = "第" + (pd.eps[i].index || (i + 1)) + "集";
    $("#p-sub").textContent = (pd.drama.title || "") + " · 第" + (pd.eps[i].index || (i + 1)) + "集" + (pd.eps.length ? " / 共" + pd.eps.length + "集" : "");
    if (!vid) { toast("该集暂无片源"); return; }
    $("#p-cur").textContent = "00:00";
    // Dual-element fast path: the hidden twin already decoded this episode.
    if (pVideoB.dataset.previd === vid && pVideoB.readyState >= 2 && pVideoB.getAttribute("src")) {
      swapPVideo();
      var ent = epCache[pd.drama.series_id + ":" + i];
      if (ent) pd.info = ent;
      $("#p-quality-n").textContent = (ent && ent.quality) || "自动";
      if (startAt > 0 && startAt < pVideo.duration - 2) pVideo.currentTime = startAt;
      $("#p-dur").textContent = fmt(pVideo.duration);
      var land0 = (pVideo.videoWidth || 0) > (pVideo.videoHeight || 0);
      $("#p-full").style.display = land0 ? "" : "none";
      layoutFullBtn();
      pDanmaku.clear();
      pDanmaku.load(pd.drama.series_id, vid, (pVideo.duration || 180) * 1000);
      playP();
      // Auto-advance to the next episode must not pop the control panel;
      // a user-initiated switch still shows it briefly (armHide).
      if (silent) player.classList.add("hide-ui"); else armHide();
      prefetchEpisode(i + 1); prefetchEpisode(i - 1); prefetchEpisode(i + 2);
      preloadEpisodeNext(i + 1);
      return;
    }
    try {
      var key = pd.drama.series_id + ":" + i;
      var e = epCache[key];
      // Reuse an in-flight prefetch instead of firing a duplicate round trip.
      var info = (e && e.path) ? e : ((e && e.p) ? await e.p.catch(function () { return null; }) : null);
      if (!info || !info.path) info = await getJSON("/api/v1/play/info", { series_id: pd.drama.series_id, vid: vid, quality: settings.quality, mode: "range", fallback: "1" });
      if (token !== pd.token) return;
      prefetchEpisode(i + 1); prefetchEpisode(i - 1); prefetchEpisode(i + 2);
      preloadEpisodeNext(i + 1);
      pd.info = info;
      pDanmaku.load(pd.drama.series_id, vid, 300000); // don't wait for metadata
      pVideo.src = info.path;
      // load() resets playbackRate to defaultPlaybackRate, so the chosen global
      // speed must live on defaultPlaybackRate too, not just playbackRate.
      pVideo.defaultPlaybackRate = settings.speed || 1;
      pVideo.playbackRate = settings.speed || 1;
      $("#p-quality-n").textContent = info.quality || "自动";
      pVideo.onloadedmetadata = function () {
        if (token !== pd.token) return;
        if (startAt > 0 && startAt < pVideo.duration - 2) pVideo.currentTime = startAt;
        $("#p-dur").textContent = fmt(pVideo.duration);
        // No auto-rotate: wide videos stay letterboxed in portrait until the
        // user taps the fullscreen button (shown only for landscape videos).
        var land = (pVideo.videoWidth || info.video_width) > (pVideo.videoHeight || info.video_height);
        $("#p-full").style.display = land ? "" : "none";
        layoutFullBtn();
        pDanmaku.clear();
        pDanmaku.load(pd.drama.series_id, vid, (pVideo.duration || 180) * 1000);
        playP();
        if (silent) player.classList.add("hide-ui"); else armHide();
      };
      pVideo.load();
    } catch (e) {
      if (token === pd.token) { toast("取流失败，点重试"); $("#p-center-play").classList.add("show"); }
    }
  }
  function playP() {
    if (castState.casting) { toast("投屏中，节目正在电视上播放"); return; }
    // Single choke point for starting playback: re-apply the global speed here
    // so a swapPVideo fast-path or a post-load() reset can never leave the
    // video at 1x while the label reads 2x.
    pVideo.defaultPlaybackRate = settings.speed || 1;
    pVideo.playbackRate = settings.speed || 1;
    var p = pVideo.play();
    if (p && p.catch) p.catch(function () { $("#p-center-play").classList.add("show"); });
  }
  $("#p-center-play").addEventListener("click", function () {
    this.classList.remove("show");
    if (!pVideo.getAttribute("src")) playEpisode(pd.idx, 0); else playP();
  });

  // center play/pause + auto-hiding controls (tap screen to show)
  var hideTimer = null;
  function armHide() {
    clearTimeout(hideTimer);
    player.classList.remove("hide-ui");
    updateToggle();
    hideTimer = setTimeout(function () {
      if (!player.classList.contains("open")) return;
      if (pVideo.paused) armHide(); else player.classList.add("hide-ui");
    }, 3200);
  }
  function updateToggle() {
    $("#p-toggle").innerHTML = '<svg class="ic"><use href="#i-' + (pVideo.paused ? "play" : "pause") + '"/></svg>';
  }
  $("#p-toggle").addEventListener("click", function (e) {
    e.stopPropagation();
    if (pVideo.paused) playP(); else pVideo.pause();
  });

  var lastSave = 0;
  function saveProgress() {
    if (!pd.drama || !pd.vid || !pVideo.currentTime) return;
    lastSave = Date.now();
    libraryOwner().then(function (oid) {
      var ep = (pd.eps[pd.idx] && pd.eps[pd.idx].index) || pd.idx + 1;
      postJSON("/api/v1/library", { owner_id: oid, action: "progress", drama: slimDrama(pd.drama), episode: ep, video_id: pd.vid, position: Math.floor(pVideo.currentTime), duration: Math.floor(pVideo.duration || 0) }).catch(function () { });
      // Keep the resume cache honest without refetching the whole library.
      if (libCache.map) libCache.map[pd.drama.series_id] = { drama: pd.drama, episode: ep, position: Math.floor(pVideo.currentTime), last_played_at: Date.now() / 1000 };
    });
  }

  // seek bar (native range drag = touch friendly)
  var seekDragging = false;
  $("#p-seek").addEventListener("input", function () {
    seekDragging = true;
    this.style.setProperty("--p", (this.value / 10) + "%");
    if (pVideo.duration) $("#p-cur").textContent = fmt(this.value / 1000 * pVideo.duration);
  });
  $("#p-seek").addEventListener("change", function () {
    if (pVideo.duration) pVideo.currentTime = this.value / 1000 * pVideo.duration;
    seekDragging = false;
  });

  // Frame bridge: keep the last decoded frame on screen (as a small JPEG
  // snapshot) until the next episode renders its first frame, so episode
  // switches never flash black.
  var pBridge = $("#p-bridge"), pHud = $("#p-hud");
  function snapshotFrame() {
    try {
      if (pVideo.readyState < 2 || !pVideo.videoWidth) return;
      var c = document.createElement("canvas");
      var w = 480, h = Math.max(1, Math.round(w * pVideo.videoHeight / pVideo.videoWidth));
      c.width = w; c.height = h;
      c.getContext("2d").drawImage(pVideo, 0, 0, w, h);
      pBridge.style.backgroundImage = "url(" + c.toDataURL("image/jpeg", 0.6) + ")";
      pBridge.classList.add("on");
    } catch (e) { }
  }

  function stepEpisode(delta) {
    var t = pd.idx + delta;
    if (t < 0) { toast("已经是第一集"); return; }
    if (t >= pd.eps.length) { toast("已经是最新一集"); return; }
    // Slide-out / slide-in so the episode change reads as a transition,
    // mirroring the home feed's snap animation.
    snapshotFrame();
    pVideo.pause();
    var dir = delta > 0 ? "up" : "down";
    pScene.classList.add("p-leave-" + dir);
    setTimeout(function () {
      pScene.classList.remove("p-leave-" + dir);
      playEpisode(t, 0);
      pScene.classList.add("p-enter-" + dir);
      setTimeout(function () { pScene.classList.remove("p-enter-" + dir); }, 420);
    }, 240);
  }

  // tap shows/hides controls (double tap = ±10s seek); center vertical swipe
  // switches episodes; edge vertical drags adjust brightness (left) / volume
  // (right), like mainstream players. Single-tap hide waits 260ms so a second
  // tap can cancel it and seek instead.
  (function () {
    var start = null, wasHidden = false, lastTap = 0, lastTapX = 0, singleTimer = null;
    function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
    function doubleSeek(x) {
      if (!pVideo.getAttribute("src") || !pVideo.duration) return;
      var dir = x < (pScene.clientWidth || 1) / 2 ? -10 : 10;
      var t = clamp(pVideo.currentTime + dir, 0, pVideo.duration - 1);
      if (t === pVideo.currentTime) return;
      pVideo.currentTime = t;
      showTopTip(dir > 0 ? "快进 10 秒" : "回退 10 秒", 900);
    }
    player.addEventListener("touchstart", function () { clearTimeout(hideTimer); }, { passive: true, capture: true });
    pScene.addEventListener("touchstart", function (e) {
      wasHidden = player.classList.contains("hide-ui");
      if (wasHidden && !cinema) armHide();
      if (e.touches.length !== 1) { start = null; return; }
      var W = pScene.clientWidth || 1, zx = e.touches[0].clientX / W;
      start = {
        x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now(),
        zone: zx < 0.12 ? "b" : zx > 0.88 ? "v" : "m", drag: null,
        vol: settings.volume == null ? 1 : settings.volume,
        bri: settings.brightness || 1
      };
    }, { passive: true });
    // Live swipe hint: show the target action while the finger is still down.
    pScene.addEventListener("touchmove", function (e) {
      // While boosting, vertical drags belong to the lock/cancel gesture.
      if (pBoost && pBoost.isBoosting()) { start = null; pHud.classList.remove("on"); return; }
      if (!start || e.touches.length !== 1) { pHud.classList.remove("on"); return; }
      var p = e.touches[0], dx = p.clientX - start.x, dy = p.clientY - start.y;
      var adx = Math.abs(dx), ady = Math.abs(dy), txt = "";
      if (start.zone !== "m" && ady > adx * 1.2 && ady >= 24) {
        // Edge vertical drag: brightness (left) / volume (right).
        start.drag = start.zone;
        var r = (start.y - p.clientY) / ((pScene.clientHeight || 1) * 0.6);
        if (start.drag === "v") {
          settings.volume = clamp(start.vol + r, 0, 1);
          txt = "音量 " + Math.round(settings.volume * 100) + "%";
        } else {
          settings.brightness = clamp(start.bri + r, 0.2, 1);
          txt = "亮度 " + Math.round(settings.brightness * 100) + "%";
        }
        applyAV();
        pHud.textContent = txt;
        pHud.classList.add("on");
        return;
      }
      if (Math.max(adx, ady) >= 24) {
        if (ady > adx * 1.2) {
          var t = pd.idx + (dy < 0 ? 1 : -1);
          if (t < 0) txt = "已是第一集";
          else if (t >= pd.eps.length) txt = "已是最新一集";
          else txt = (dy < 0 ? "↑ 下一集 · 第" : "↓ 上一集 · 第") + ((pd.eps[t] && pd.eps[t].index) || (t + 1)) + "集";
        } else if (adx > ady * 1.2) {
          if (cinema) txt = "← 退出全屏 →";
          else if (dx < 0) txt = "→ 剧集详情";
        }
      }
      pHud.textContent = txt;
      pHud.classList.toggle("on", !!txt);
    }, { passive: true });
    pScene.addEventListener("touchend", function (e) {
      pHud.classList.remove("on");
      // releasing after a long-press boost (or its lock/cancel swipe) must not
      // toggle controls or switch episodes
      if (pBoost && (pBoost.isBoosting() || pBoost.recent())) { start = null; return; }
      if (!start) {
        if (e.target.closest(".p-bottom, .p-top")) armHide();
        return;
      }
      var p = e.changedTouches[0];
      var dx = p.clientX - start.x, dy = p.clientY - start.y;
      var adx = Math.abs(dx), ady = Math.abs(dy);
      if (start.drag) { saveSettings(); start = null; return; }   // volume/brightness gesture consumed
      if (Math.max(adx, ady) > 60 && Date.now() - start.t < 800) {
        e.stopPropagation();
        swipeUntil = Date.now() + 500;
        if (ady > adx * 1.2) stepEpisode(dy < 0 ? 1 : -1);                 // vertical = prev/next episode
        else if (cinema && adx > ady * 1.2) exitCinema();                  // landscape: horizontal = leave fullscreen
        else if (!cinema && adx > ady * 1.2 && dx < 0) openDetail(pd.drama); // portrait: swipe left = detail page
        start = null; return;
      }
      if (Math.max(adx, ady) < 12 && Date.now() > swipeUntil) {
        if (e.target.closest("button, input, .p-bottom, .p-top, .p-center-play, .p-toggle")) { armHide(); start = null; return; }
        var now = Date.now();
        if (now - lastTap < 300 && Math.abs(p.clientX - lastTapX) < 100) {
          lastTap = 0;
          if (singleTimer) { clearTimeout(singleTimer); singleTimer = null; }
          doubleSeek(p.clientX);
        } else {
          lastTap = now; lastTapX = p.clientX;
          var hidden0 = wasHidden;
          if (singleTimer) clearTimeout(singleTimer);
          singleTimer = setTimeout(function () {
            singleTimer = null;
            if (!hidden0) player.classList.add("hide-ui");
            else if (cinema) armHide();
          }, 260);
        }
      } else armHide();
      start = null;
    }, true);
  })();
  // Long-press 2x boost for the player (portrait + cinema share pScene).
  var pBoost = makeBoost(function () { return pVideo; }, pScene, function (t) {
    return t.closest("button, input, .p-bottom, .p-top, .p-center-play, .p-toggle, .cmt-panel");
  }, function () { return cinema ? "bl" : ""; }, function () { if (cinema) player.classList.add("hide-ui"); });

  // cinema (landscape) — native rotation via bridge
  function enterCinema() {
    if (cinema && player.classList.contains("is-cinema")) return;
    cinema = true;
    player.classList.add("is-cinema");
    if (window.HongguoScreen) window.HongguoScreen.setLandscape(true);
    layoutFullBtn();
  }
  function exitCinema() {
    cinema = false;
    player.classList.remove("is-cinema");
    if (window.HongguoScreen) window.HongguoScreen.setLandscape(false);
    layoutFullBtn();
  }
  // Sit the fullscreen button at the video's bottom-right corner (portrait
  // letterbox). In cinema (landscape) mode the button is pointless: the video
  // is already fullscreen, so it is hidden entirely.
  function layoutFullBtn() {
    var b = $("#p-full");
    if (!b) return;
    var land = (pVideo.videoWidth || 0) > (pVideo.videoHeight || 0);
    b.style.display = (land && !cinema) ? "" : "none";
    if (!land || cinema) return;
    var ph = pScene.clientHeight || 1, pw = pScene.clientWidth || 1;
    var vw = pVideo.videoWidth || 16, vh = pVideo.videoHeight || 9;
    var dispH = pw * vh / vw;
    // Portrait: sit in the black bar just BELOW the video so the button never
    // covers subtitles.
    var pad = Math.max(6, Math.round((ph - dispH) / 2) - 48);
    b.style.bottom = pad + "px";
  }
  window.addEventListener("resize", layoutFullBtn);
  $("#p-full").addEventListener("click", function () { cinema ? exitCinema() : enterCinema(); });
  $("#p-cast").addEventListener("click", function () { openCastSheet(); });
  $("#p-danmaku").addEventListener("click", function () {
    settings.danmaku = !settings.danmaku; saveSettings();
    toast("弹幕：" + (settings.danmaku ? "开" : "关"));
    if (settings.danmaku) pDanmaku.load(pd.drama.series_id, pd.vid, (pVideo.duration || 180) * 1000); else pDanmaku.clear();
  });

  // ---------- comments (shared panel factory) ----------
  function cmtTime(ts) {
    var s = Math.max(0, Date.now() / 1000 - (ts || 0));
    if (s < 60) return "刚刚";
    if (s < 3600) return Math.floor(s / 60) + "分钟前";
    if (s < 86400) return Math.floor(s / 3600) + "小时前";
    if (s < 86400 * 30) return Math.floor(s / 86400) + "天前";
    var d = new Date((ts || 0) * 1000);
    return (d.getMonth() + 1) + "月" + d.getDate() + "日";
  }
  function cmtItemHTML(c) {
    var name = c.author || "剧友";
    var col = hashColor(c.comment_id || name);
    var av = '<div class="cmt-av" style="background:linear-gradient(135deg,' + col[0] + "," + col[1] + ')">' +
      esc(String(name).slice(0, 1)) + (c.avatar ? '<img src="' + esc(c.avatar) + '" onerror="this.remove()">' : "") + "</div>";
    return '<div class="cmt-item" data-id="' + esc(c.comment_id || "") + '">' + av +
      '<div class="cmt-body"><div class="cmt-name">' + esc(name) + "</div>" +
      '<div class="cmt-text">' + esc(c.text || "") + "</div>" +
      '<div class="cmt-meta"><span>' + cmtTime(c.created) + "</span>" +
      (c.replies ? "<span>" + num(c.replies) + "条回复</span>" : "") +
      '<span class="cmt-like' + (c.liked ? " on" : "") + '" data-like>' + ic("heart") + (c.likes ? num(c.likes) : "点赞") + "</span>" +
      "</div></div></div>";
  }
  // sel: id prefix of the panel elements; ctx(): {series_id, vid} or null;
  // hooks: onOpen/onClose (scene squeeze etc.), offset (comment timestamp),
  // sent (echo as danmaku).
  function makeCmt(sel, ctx, hooks) {
    var panel = $(sel + "-panel"), list = $(sel + "-list"), input = $(sel + "-text"), count = $(sel + "-count");
    var st = { key: "", cursor: "", hasMore: false, loading: false, open: false, pending: false };
    function keyOf(c) { return c ? c.series_id + ":" + c.vid : ""; }
    async function load(append) {
      var c = ctx();
      if (!c || !c.vid) return;
      var key = keyOf(c);
      if (!append) { st.key = key; st.cursor = ""; st.pending = false; list.innerHTML = '<div class="cmt-more">加载中…</div>'; }
      if (st.loading) { if (!append) st.pending = true; return; }
      st.loading = true;
      try {
        var params = { series_id: c.series_id, vid: c.vid };
        if (append && st.cursor) params.cursor = st.cursor;
        var d = await getJSON("/api/v1/comments", params);
        if (st.key !== key) return;
        var items = d.items || [];
        list.innerHTML = "";
        if (!items.length) list.innerHTML = '<div class="cmt-more">还没有评论，抢个沙发</div>';
        else items.forEach(function (x) { list.insertAdjacentHTML("beforeend", cmtItemHTML(x)); });
        st.cursor = d.next_cursor || "";
        st.hasMore = !!d.has_more;
        count.textContent = (d.total ? num(d.total) : "") + "条评论";
      } catch (e) {
        if (st.key === key && !append) list.innerHTML = '<div class="cmt-more">评论加载失败，下拉重试</div>';
      }
      st.loading = false;
      if (st.pending && st.key === key) { st.pending = false; load(false); }
    }
    async function loadMore() {
      var c = ctx();
      if (st.loading || !st.hasMore || !c || !c.vid) return;
      var key = keyOf(c);
      st.loading = true;
      try {
        var d = await getJSON("/api/v1/comments", { series_id: c.series_id, vid: c.vid, cursor: st.cursor });
        if (st.key !== key) return;
        (d.items || []).forEach(function (x) { list.insertAdjacentHTML("beforeend", cmtItemHTML(x)); });
        st.cursor = d.next_cursor || st.cursor;
        st.hasMore = !!d.has_more;
      } catch (e) { }
      st.loading = false;
    }
    list.addEventListener("scroll", function () {
      if (list.scrollTop + list.clientHeight >= list.scrollHeight - 80) loadMore();
    });
    list.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-like]");
      var c = ctx();
      if (!btn || !c) return;
      var item = btn.closest(".cmt-item");
      var on = !btn.classList.contains("on");
      btn.classList.toggle("on", on);
      postJSON("/api/v1/player/action", { action: "comment-like", series_id: c.series_id, vid: c.vid, comment_id: item ? item.dataset.id : "", value: on })
        .catch(function (err) { btn.classList.toggle("on", !on); toast(err.message || "点赞失败"); });
    });
    function send() {
      var text = (input.value || "").trim();
      if (!text) { toast("说点什么吧"); return; }
      var c = ctx();
      if (!c || !c.vid) { toast("视频加载中，稍后再试"); return; }
      input.value = "";
      postJSON("/api/v1/player/action", { action: "comment", series_id: c.series_id, vid: c.vid, text: text, offset_ms: hooks.offset ? hooks.offset() : 0 })
        .then(function (x) {
          if (x && x.comment_id) list.insertAdjacentHTML("afterbegin", cmtItemHTML(x));
          if (hooks.sent) hooks.sent(text);
        })
        .catch(function (e) { toast(e.message || "发送失败"); input.value = text; });
    }
    $(sel + "-send").addEventListener("click", send);
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") send(); });
    $(sel + "-close").addEventListener("click", close);
    $(sel + "-down").addEventListener("click", close);
    function open() {
      var c = ctx();
      if (!c || !c.vid) { toast("视频加载中，稍后再试"); return; }
      if (st.open) return;
      st.open = true;
      panel.classList.add("open");
      if (hooks.onOpen) hooks.onOpen();
      if (st.key !== keyOf(c)) load(false);
    }
    function close() {
      if (!st.open) return;
      st.open = false;
      panel.classList.remove("open");
      if (hooks.onClose) hooks.onClose();
    }
    return {
      open: open, close: close,
      toggle: function () { st.open ? close() : open(); },
      isOpen: function () { return st.open; },
      sync: function () { var c = ctx(); if (st.open && c && c.vid && st.key !== keyOf(c)) load(false); }
    };
  }
  var cmtUI = makeCmt("#cmt", function () {
    return pd.drama && pd.vid ? { series_id: pd.drama.series_id, vid: pd.vid } : null;
  }, {
    onOpen: function () { player.classList.add("cmt-open"); setTimeout(layoutFullBtn, 320); },
    onClose: function () { player.classList.remove("cmt-open"); setTimeout(layoutFullBtn, 320); },
    offset: function () { return Math.round((pVideo.currentTime || 0) * 1000); },
    sent: function (text) { pDanmaku.send(text); }
  });
  var homeCmtD = null;
  var homeCmt = makeCmt("#h-cmt", function () {
    var d = homeCmtD;
    if (!d) return null;
    var vid = d.vid || (d.vid_list && d.vid_list[0]) || "";
    return vid ? { series_id: d.series_id, vid: vid } : null;
  }, {
    offset: function () { return Math.round((feedVideo.currentTime || 0) * 1000); },
    sent: function (text) { if (feedDanmaku) feedDanmaku.send(text); }
  });
  $("#p-cmt").addEventListener("click", function () { cmtUI.toggle(); });
  $("#p-speed").addEventListener("click", function () {
    var speeds = [0.5, 0.75, 1, 1.25, 1.5, 2];
    openSheet("播放速度", '<div class="opt-grid">' + speeds.map(function (s) {
      return '<button class="opt' + (Number(settings.speed) === s ? " on" : "") + '" data-v="' + s + '">' + (s === 1 ? "1.0x（标准）" : s + "x") + "</button>";
    }).join("") + "</div>");
    sheetBody.querySelectorAll(".opt").forEach(function (o) {
      o.addEventListener("click", function () {
        settings.speed = Number(o.dataset.v); saveSettings();
        pVideo.playbackRate = settings.speed; feedVideo.playbackRate = settings.speed;
        feedVideoB.playbackRate = settings.speed;
        speedLabel();
        closeSheet();
      });
    });
  });
  function sheetDmArea(cb) {
    var opts = [[25, "1/4 屏"], [50, "1/2 屏"], [75, "3/4 屏"], [100, "全屏"]];
    openSheet("弹幕屏幕占比", '<div class="opt-grid">' + opts.map(function (o) {
      return '<button class="opt' + ((settings.dmArea || 25) === o[0] ? " on" : "") + '" data-v="' + o[0] + '">' + o[1] + "</button>";
    }).join("") + "</div>");
    sheetBody.querySelectorAll(".opt").forEach(function (o) {
      o.addEventListener("click", function () { cb(Number(o.dataset.v)); closeSheet(); });
    });
  }
  function sheetQuality(cb) {
    var opts = [["", "自动"]].concat((pd.info && pd.info.qualities || ["720P", "1080P"]).map(function (q) { return [q, q]; }));
    openSheet("播放画质", '<div class="opt-grid">' + opts.map(function (o) {
      return '<button class="opt' + (settings.quality === o[0] ? " on" : "") + '" data-v="' + o[0] + '">' + o[1] + "</button>";
    }).join("") + "</div>");
    sheetBody.querySelectorAll(".opt").forEach(function (o) {
      o.addEventListener("click", function () { cb(o.dataset.v); closeSheet(); });
    });
  }
  $("#p-quality").addEventListener("click", function () {
    sheetQuality(function (v) {
      settings.quality = v; saveSettings();
      var t = pVideo.currentTime;
      playEpisode(pd.idx, t);
    });
  });
  $("#p-eps").addEventListener("click", function () {
    openSheet("选择剧集 · 共" + pd.eps.length + "集", '<div class="ep-grid">' + pd.eps.map(function (e, i) {
      return '<button class="ep' + (i === pd.idx ? " on" : "") + '" data-i="' + i + '">' + (e.index || i + 1) + "</button>";
    }).join("") + "</div>");
    sheetBody.querySelectorAll(".ep").forEach(function (b) {
      b.addEventListener("click", function () { closeSheet(); playEpisode(Number(b.dataset.i), 0); });
    });
  });

  // ---------- drama detail ----------
  var detailEl = $("#detail"), detailDrama = null;
  function openDetail(d) {
    if (!d) { closeDetail(); return; }
    detailDrama = d;
    $("#d-head-title").textContent = d.title || "";
    $("#d-name").textContent = d.title || "";
    var c = hashColor(d.series_id);
    $("#d-poster").style.background = coverOf(d) ? "url(" + esc(coverOf(d)) + ") center/cover" : "linear-gradient(160deg," + c[0] + "," + c[1] + ")";
    var eps = (pd.drama === d && pd.eps.length) ? pd.eps : (d.episodes && d.episodes.length ? d.episodes : Array.from({ length: d.episode_count || 1 }, function (_, i) { return { index: i + 1, video_id: (d.vid_list || [])[i] || "" }; }));
    var sub = [];
    if (d.score) sub.push("评分 " + d.score);
    sub.push("共 " + (d.episode_count || eps.length) + " 集");
    if (d.play_count) sub.push(num(d.play_count) + "人在看");
    $("#d-sub2").textContent = sub.join(" · ");
    $("#d-tags").innerHTML = (d.tags || []).map(function (t) { return "<span>" + esc(t) + "</span>"; }).join("");
    $("#d-intro").textContent = d.intro || "";
    $("#d-eps-title").textContent = "选集 · 共" + eps.length + "集";
    var cur = pd.drama === d ? pd.idx : -1;
    $("#d-epgrid").innerHTML = eps.map(function (e, i) { return '<button data-i="' + i + '"' + (i === cur ? ' class="on"' : "") + ">" + (e.index || i + 1) + "</button>"; }).join("");
    $("#d-play").textContent = cur > 0 ? "继续观看 第" + ((pd.eps[cur] && pd.eps[cur].index) || cur + 1) + "集" : "开始追剧";
    detailEl.classList.add("open");
    $("#tabbar").classList.add("hidden");
    getJSON("/api/v1/follow").then(function (f) {
      var on = (f.items || []).some(function (x) { return (x.drama && x.drama.series_id) === d.series_id || x.series_id === d.series_id; });
      $("#d-follow").classList.toggle("on", on); $("#d-follow").textContent = on ? "已追剧" : "+ 追剧";
    }).catch(function () { });
    loadSeasons(d);
  }
  async function loadSeasons(d) {
    $("#d-seasons").innerHTML = "";
    try {
      var r = await getJSON("/api/v1/series/seasons", { series_id: d.series_id });
      var list = (r.items || []).filter(function (x) { return x && x.series_id; });
      if (list.length < 2 || detailDrama !== d) return;
      $("#d-seasons").innerHTML = '<div class="d-seasons-h">全' + list.length + '季<small id="d-seasons-more">查看全部 ›</small></div>' +
        '<div class="d-seasons" id="d-seasons-row">' + list.map(function (s, i) {
          var c = hashColor(s.series_id);
          return '<div class="season-card' + (s.playable ? "" : " upcoming") + '" data-i="' + i + '"><div class="cover' + (coverOf(s) ? " has-img" : "") + '" style="--c1:' + c[0] + ";--c2:" + c[1] + '">' +
            (coverOf(s) ? '<img src="' + esc(coverOf(s)) + '">' : '<span class="cover-art">' + esc((s.title || "").slice(0, 2)) + "</span>") +
            '<span class="sc-tag">' + esc(s.label || "") + "</span></div>" +
            '<div class="sc-label">' + esc((s.title || "").slice(0, 10)) + "</div>" +
            '<div class="sc-sub">' + esc(s.subtitle || (s.playable ? (s.episode_count || "") + "集" : "即将上线")) + "</div></div>";
        }).join("") + "</div>";
      var row = $("#d-seasons-row");
      $("#d-seasons").querySelectorAll(".season-card").forEach(function (card) {
        card.addEventListener("click", function () {
          var s = list[Number(card.dataset.i)];
          if (!s.playable) { toast("该季暂未上线，可先预约"); return; }
          closeDetail(); openPlayer(s, 0, 0, false);
        });
      });
      $("#d-seasons-more").addEventListener("click", function () {
        row.classList.toggle("all");
        this.textContent = row.classList.contains("all") ? "收起 ›" : "查看全部 ›";
      });
    } catch (e) { }
  }
  function closeDetail() {
    detailEl.classList.remove("open"); detailDrama = null;
    $("#tabbar").classList.remove("hidden");
    if (activeFeed >= 0) {
      var it = feedItems[activeFeed];
      it.el.querySelector(".fi-scene").appendChild(feedVideo);
    it.el.appendChild(fiSeekEl);
      feedVideo.classList.add("playing");
      if (!feedVideo.getAttribute("src")) resolveFeedPlay(it.d, it.vid, it); else tryPlayFeed();
    }
  }
  $("#d-back").addEventListener("click", closeDetail);
  $("#d-play").addEventListener("click", function () { if (detailDrama) openPlayer(detailDrama, pd.drama === detailDrama ? pd.idx : 0, 0, false); });
  $("#d-follow").addEventListener("click", function () {
    if (!detailDrama) return;
    var on = !this.classList.contains("on");
    postJSON("/api/v1/follow", { series_id: detailDrama.series_id, enabled: on }).then(function () {
      $("#d-follow").classList.toggle("on", on); $("#d-follow").textContent = on ? "已追剧" : "+ 追剧";
      toast(on ? "已加入追更" : "已取消追更");
    }).catch(function (e) { toast(e.message || "请先登录账号"); });
  });
  $("#d-epgrid").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-i]");
    if (b && detailDrama) openPlayer(detailDrama, Number(b.dataset.i), 0, false);
  });

  // ---------- theater ----------
  var theaterSel = { rank: "", cat: { kind: "", value: "", label: "" } };
  var gridState = { params: null, offset: 0, done: false, loading: false, items: [] };
  async function renderTheater() {
    var page = $("#page-theater");
    page.innerHTML = '<div class="page-head">剧场<span class="sub">免费短剧 · 全集畅看</span></div>' +
      '<div class="section" id="tr-cats-sec" style="padding-top:2px"><div class="cat-tiles" id="tr-cats"></div></div>' +
      '<div class="section" id="tr-grid-sec"><div class="grid2" id="tr-grid">' + skGrid(6) + '</div><div class="loading" id="tr-more" style="display:none">加载更多…</div></div>';
    try {
      var c0 = await getJSON("/api/v1/category", { selectors: "1", offset: "0" });
      renderCats(c0.filters || []);
    } catch (e) { }
    gridState.params = {};
    fetchGrid(true);
    if (!page._gridScroll) {
      page._gridScroll = true;
      page.addEventListener("scroll", function () {
        if (page.scrollTop + page.clientHeight >= page.scrollHeight - 600) fetchGrid(false);
      });
      bindPullRefresh(page, function () { toast("更新中…"); fetchGrid(true); });
    }
  }
  // ---------- rank page (official layout): big title + chip row ----------
  var rankOpts = [], rankLoaded = false, rankSel = null;
  function rankChipLabel(l) {
    l = String(l || "榜单");
    if (l.indexOf("全部") === 0) return "热播榜";
    return l.replace("热度排行", "").replace("排行", "").replace("榜", "") + "榜";
  }
  async function openRankPage() {
    $("#rank-page").classList.add("open");
    $("#tabbar").classList.add("hidden");
    bindPullRefresh(document.querySelector(".rp-body"), function () { if (rankSel) selectRank(rankSel); });
    if (!rankLoaded) {
      $("#rp-list").innerHTML = skRank(6);
      try {
        var d = await getJSON("/api/v1/lists/rank", { offset: "0" });
        rankOpts = [{ id: "", label: "推荐榜", kind: "feed", feed: "recommend" }];
        var hot = (d.ranks || []).filter(function (r) { return r && r.id; })
          .map(function (r) { return { id: r.id, label: rankChipLabel(r.label), kind: "rank" }; });
        if (hot.length) rankOpts.push(hot[0]);
        rankOpts.push({ id: "", label: "新剧榜", kind: "feed", feed: "new" });
        rankOpts = rankOpts.concat(hot.slice(1));
        rankOpts.push({ id: "reservations", label: "预约榜", kind: "res" });
        if (hot.length === 0) rankOpts.push({ id: "", label: "热播榜", kind: "rank" });
        rankLoaded = true;
        renderRpChips();
        rankSel = rankOpts[1] || rankOpts[0];
        selectRank(rankSel);
      } catch (e) { $("#rp-list").innerHTML = '<div class="loading">榜单加载失败</div>'; }
    } else { renderRpChips(); if (rankSel) selectRank(rankSel); }
  }
  function renderRpChips() {
    var el = $("#rp-chips");
    el.innerHTML = rankOpts.map(function (o, i) { return '<button class="rp-chip" data-i="' + i + '">' + esc(o.label) + "</button>"; }).join("");
    el.querySelectorAll(".rp-chip").forEach(function (b) {
      b.addEventListener("click", function () { rankSel = rankOpts[Number(b.dataset.i)]; renderRpChips(); selectRank(rankSel); });
    });
    el.querySelectorAll(".rp-chip").forEach(function (b) { b.classList.toggle("on", rankOpts[Number(b.dataset.i)] === rankSel); });
    var on = el.querySelector(".rp-chip.on");
    if (on) on.scrollIntoView({ inline: "center", block: "nearest" });
  }
  function closeRankPage() {
    $("#rank-page").classList.remove("open");
    $("#tabbar").classList.remove("hidden");
  }
  $("#rp-back").addEventListener("click", closeRankPage);
  $("#rp-search").addEventListener("click", function () { closeRankPage(); switchTab("search"); });
  async function selectRank(o) {
    $("#rp-list").innerHTML = skRank(6);
    document.querySelector(".rp-body").scrollTop = 0;
    try {
      var d = o.kind === "feed"
        ? await getJSON("/api/v1/lists/" + o.feed, { offset: "0" })
        : o.kind === "res"
          ? await getJSON("/api/v1/lists/reservations", { offset: "0" })
          : await getJSON("/api/v1/lists/rank", { rank: o.id, offset: "0" });
      renderRankItems((d.items || []).slice(0, 20), "#rp-list", o.label, o.kind === "rank");
    } catch (e) { $("#rp-list").innerHTML = '<div class="loading">加载失败</div>'; }
  }
  async function fetchGrid(reset) {
    if (!gridState.params) return;
    if (reset) { gridState.offset = 0; gridState.done = false; gridState.items = []; }
    if (gridState.loading || gridState.done) return;
    gridState.loading = true;
    var more = $("#tr-more"); if (more) more.style.display = "";
    try {
      var p = { offset: String(gridState.offset) };
      Object.keys(gridState.params).forEach(function (k) { p[k] = gridState.params[k]; });
      var d = await getJSON("/api/v1/category", p);
      var items = d.items || [];
      if (reset) $("#tr-grid").innerHTML = "";
      if (!items.length && reset) $("#tr-grid").innerHTML = '<div class="loading">暂无结果</div>';
      appendGrid(items);
      gridState.offset = d.next_offset ? d.next_offset : gridState.offset + items.length;
      if (!d.has_more || !items.length) gridState.done = true;
    } catch (e) { if (reset) $("#tr-grid").innerHTML = '<div class="loading">加载失败</div>'; gridState.done = true; }
    gridState.loading = false;
    if (more) more.style.display = "none";
  }
  function renderRankItems(items, elId, rankLabel, showBadge) {
    var el = $(elId || "#tr-list");
    if (!el) return;
    el.innerHTML = items.map(function (d, i) {
      var c = hashColor(d.series_id);
      return '<div class="rank-card" data-sid="' + esc(d.series_id) + '"><div class="cover' + (coverOf(d) ? " has-img" : "") + '" style="--c1:' + c[0] + ";--c2:" + c[1] + '">' +
        (coverOf(d) ? '<img src="' + esc(coverOf(d)) + '" alt="">' : '<span class="cover-art">' + esc((d.title || "").slice(0, 2)) + "</span>") +
        (showBadge === false ? "" : '<span class="rp-badge">第' + (i + 1) + "名</span>") + "</div>" +
        '<div class="info"><div class="rt">' + esc(d.title) + "</div>" +
        '<div class="rs">' + (d.heat ? num(d.heat) + "人正在看" + esc(rankLabel || "榜") : (d.score ? "★" + esc(d.score) + " · " : "") + (num(d.play_count) ? num(d.play_count) + "人在看" : "")) + "</div>" +
        '<div class="tags">' + (d.tags || []).slice(0, 3).map(function (t) { return "<span>" + esc(t) + "</span>"; }).join("") + "</div>" +
        '<button class="play-btn">立即观看</button></div></div>';
    }).join("") || '<div class="loading">暂无数据</div>';
    items.forEach(function (d, i) {
      var card = el.children[i];
      if (card) card.addEventListener("click", function () { closeRankPage(); openPlayer(d, 0, 0, false); });
    });
    fadeImgs(el);
  }
  function renderCats(filters) {
    var el = $("#tr-cats");
    var tiles = [{ kind: "genre", value: "short_play", label: "短剧", icon: "play" }, { kind: "genre", value: "comic_series", label: "漫剧", icon: "wand" }, { kind: "genre", value: "ai_series", label: "AI剧", icon: "grid" }];
    (filters || []).slice(0, 2).forEach(function (row) {
      (row.options || []).slice(0, 3).forEach(function (o) {
        tiles.push({ kind: row.type || row.kind, value: o.id || o.value, label: o.label || o.name });
      });
    });
    el.innerHTML = tiles.slice(0, 9).map(function (t, i) {
      var c = PALETTE[i % PALETTE.length];
      return '<button class="cat-tile' + (theaterSel.cat.value === t.value ? " on" : "") + '" data-i="' + i + '" style="--c1:' + c[0] + ";--c2:" + c[1] + '">' + ic(t.icon || "drama") + t.label + "</button>";
    }).join("");
    el.querySelectorAll(".cat-tile").forEach(function (b) {
      b.addEventListener("click", async function () {
        var t = tiles[Number(b.dataset.i)];
        theaterSel.cat = t;
        el.querySelectorAll(".cat-tile").forEach(function (x) { x.classList.toggle("on", x === b); });
        gridState.params = t.value ? (function () { var o = {}; o[t.kind] = t.value; return o; })() : {};
        $("#tr-grid").innerHTML = '<div class="loading">加载中…</div>';
        fetchGrid(true);
      });
    });
  }
  function appendGrid(items) {
    if (!items.length) return;
    var start = gridState.items.length;
    gridState.items = gridState.items.concat(items);
    var el = $("#tr-grid");
    el.insertAdjacentHTML("beforeend", items.map(function (d) {
      var c = hashColor(d.series_id);
      return '<div class="card" data-sid="' + esc(d.series_id) + '"><div class="cover' + (coverOf(d) ? " has-img" : "") + '" style="--c1:' + c[0] + ";--c2:" + c[1] + '">' +
        (coverOf(d) ? '<img src="' + esc(coverOf(d)) + '" alt="">' : '<span class="cover-art">' + esc((d.title || "").slice(0, 2)) + "</span>") +
        '<span class="cover-ep">' + (d.episode_count ? d.episode_count + "集" : "") + '</span><div class="cover-foot">' + (d.score ? "★" + esc(d.score) : num(d.play_count)) + "</div></div>" +
        '<div class="card-title">' + esc(d.title) + "</div>" +
        '<div class="card-sub">' + esc((d.tags || [])[0] || "") + (d.play_count ? " · " + num(d.play_count) + "人在看" : "") + "</div></div>";
    }).join(""));
    for (var i = 0; i < items.length; i++) {
      (function (k) {
        var card = el.children[start + k];
        if (card) card.addEventListener("click", function () { openPlayer(gridState.items[start + k], 0, 0, false); });
      })(i);
    }
    fadeImgs(el);
  }

  // ---------- mine ----------
  async function renderMine() {
    var page = $("#page-mine");
    page.innerHTML = '<div class="mine-head"><div class="avatar">漫</div><div class="mh-info"><div class="mh-name" id="mn-name">红果用户</div><div class="mh-sub">好剧免费 · 全集畅看</div></div><button class="login-btn" id="mn-login">登录</button></div>' +
      '<div class="stats"><div class="stat"><b id="st-h">-</b><span>观看历史</span></div><div class="stat"><b id="st-f">-</b><span>收藏</span></div><div class="stat"><b id="st-b">-</b><span>追更</span></div></div>' +
      '<div class="settings">' +
      '<button class="set-row" data-m="history">' + ic("clock") + '<span class="sr-label">观看历史</span><span class="sr-val">全部记录' + ic("chev") + "</span></button>" +
      '<button class="set-row" data-m="favorites">' + ic("star") + '<span class="sr-label">我的收藏</span><span class="sr-val">' + ic("chev") + "</span></button>" +
      '<button class="set-row" data-m="follows">' + ic("bookmark") + '<span class="sr-label">我的追更</span><span class="sr-val">' + ic("chev") + "</span></button>" +
      '<div class="set-row">' + ic("grid") + '<span class="sr-label">默认画质</span><span class="sr-val" data-sw="quality">' + (settings.quality || "自动") + ic("chev") + "</span></div>" +
      '<div class="set-row">' + ic("play") + '<span class="sr-label">自动播下一集</span><span class="switch' + (settings.auto ? " on" : "") + '" data-sw="auto"></span></div>' +
      '<div class="set-row">' + ic("danmaku") + '<span class="sr-label">弹幕</span><span class="switch' + (settings.danmaku ? " on" : "") + '" data-sw="danmaku"></span></div>' +
      '<button class="set-row" data-m="update">' + ic("gear") + '<span class="sr-label">检查更新</span><span class="sr-val" id="mn-ver">v1.0' + ic("chev") + "</span></button>" +
      "</div>";
    page.querySelectorAll(".set-row").forEach(function (r) {
      r.addEventListener("click", function () {
        var m = r.dataset.m, sw = r.querySelector("[data-sw]");
        if (m === "history" || m === "favorites" || m === "follows") openMyList(m);
        if (m === "update") checkUpdateNow();
        if (sw && sw.dataset.sw === "quality") sheetQuality(function (v) { settings.quality = v; saveSettings(); renderMine(); });
        if (sw && sw.dataset.sw === "auto") { settings.auto = !settings.auto; saveSettings(); renderMine(); }
        if (sw && sw.dataset.sw === "danmaku") { settings.danmaku = !settings.danmaku; saveSettings(); renderMine(); }
      });
    });
    try {
      var d = await getJSON("/api/v1/library", {});
      var entries = d.entries || [];
      var hist = entries.filter(function (e) { return e.last_played_at; });
      var favs = entries.filter(function (e) { return e.favorite_at; });
      $("#st-h").textContent = hist.length || "-";
      $("#st-f").textContent = favs.length || "-";
      window.__myHistory = hist; window.__myFavorites = favs;
    } catch (e) { }
    try {
      var f = await getJSON("/api/v1/follow", {});
      window.__myFollows = f.items || [];
      $("#st-b").textContent = (f.items || []).length || "-";
    } catch (e) { }
    try {
      // accountStatus carries logged_in + profile; there is no /profile endpoint.
      var st = await getJSON("/api/v1/account", {});
      if (st && st.logged_in) {
        var p = st.profile || {};
        if (p.name) $("#mn-name").textContent = p.name;
        if (p.phone) $(".mine-head .mh-sub").textContent = p.phone;
        var av = $(".mine-head .avatar");
        if (av && p.avatar) {
          av.innerHTML = '<img src="' + esc(p.avatar) + '" alt="" onerror="this.remove()">';
        }
        var b = $("#mn-login");
        b.textContent = "退出登录"; b.dataset.on = "1";
      }
    } catch (e) { }
    $("#mn-login").addEventListener("click", function () {
      if (this.dataset.on) {
        var self = this; self.disabled = true;
        postJSON("/api/v1/account/logout", {}).then(function () { toast("已退出登录"); renderMine(); })
          .catch(function (e) { self.disabled = false; toast(e.message || "退出失败"); });
        return;
      }
      openLogin();
    });
    renderUpdateRow();
  }
  // ---------- login sheet: phone code + QR ----------
  var qrTimer = null, qrId = "", qrDeadline = 0;
  function stopQr() { if (qrTimer) { clearInterval(qrTimer); qrTimer = null; } }
  function cancelQrAttempt() {
    stopQr();
    var id = qrId; qrId = "";
    if (id) postJSON("/api/v1/account/qr/cancel", { id: id }).catch(function () { });
  }
  function loginSheetCleanup() {
    cancelQrAttempt();
    stopSms();
    if (smsActive) { smsActive = false; smsPhase = ""; postJSON("/api/v1/account/cancel", {}).catch(function () { }); }
  }
  function qrRender(s) {
    var stage = $("#qr-stage"), tip = $("#qr-tip");
    if (!stage || !tip) return;
    var q = (s && s.qr_login) || {};
    if (s && s.logged_in) { stage.innerHTML = '<div class="qr-ok">✓</div>'; tip.textContent = "登录成功"; return; }
    if (q.state === "expired" || q.state === "failed" || q.state === "cancelled") {
      stopQr();
      stage.innerHTML = '<button class="qr-retry" id="qr-retry">重新获取二维码</button>';
      var b = $("#qr-retry"); if (b) b.addEventListener("click", startQr);
      tip.textContent = q.error || (q.state === "expired" ? "二维码已过期，请点击重试" : "登录已中断，请重试");
      return;
    }
    if (q.image) stage.innerHTML = '<img src="' + q.image + '" alt="登录二维码">';
    var msg = { preparing: "正在获取二维码…", pending: "请用红果 App 扫描二维码", scanned: "已扫描，请在手机上确认", processing: "正在登录…" };
    tip.textContent = msg[q.state] || q.error || "正在获取二维码…";
  }
  async function startQr() {
    var pane = $("#lg-qr");
    if (!pane) return;
    pane.innerHTML = '<div class="qr-box"><div class="qr-stage" id="qr-stage"><div class="qr-spin"></div></div>' +
      '<div class="qr-tip" id="qr-tip">正在获取二维码…</div>' +
      '<div class="qr-sub">打开「红果免费短剧」App<br>点「我的」→ 右上角「扫一扫」→ 对准二维码</div></div>';
    stopQr(); qrId = "";
    var st;
    try { st = await postJSON("/api/v1/account/qr/start", {}); }
    catch (e) { var t0 = $("#qr-tip"); if (t0) t0.textContent = "二维码获取失败：" + (e.message || "请重试"); return; }
    var q = st.qr_login || {};
    qrId = q.id || "";
    qrDeadline = Date.now() + 10 * 60 * 1000;
    qrRender(st);
    if (!qrId) return;
    qrTimer = setInterval(function () {
      if (!qrId || Date.now() > qrDeadline) { stopQr(); return; }
      getJSON("/api/v1/account/qr/status", { id: qrId }).then(function (s) {
        qrRender(s);
        if (s.logged_in) {
          stopQr(); qrId = "";
          toast("登录成功");
          setTimeout(function () { closeSheet(); renderMine(); }, 800);
        }
      }).catch(function () { stopQr(); var t = $("#qr-tip"); if (t) t.textContent = "登录已中断，请重新获取二维码"; });
    }, 1800);
  }
  // Phone + SMS code login. The core validates the number itself, so the
  // sheet only pre-checks the mainland 11-digit shape for a friendly hint.
  var smsTimer = null, smsActive = false, smsBusy = false, smsCountdownUntil = 0, smsPhase = "";
  function stopSms() { if (smsTimer) { clearInterval(smsTimer); smsTimer = null; } }
  function smsMsg(text, isErr) {
    var m = $("#sms-msg");
    if (m) { m.textContent = text || ""; m.className = "sms-msg" + (isErr ? " err" : ""); }
  }
  function smsSendLabel() {
    var b = $("#sms-send"); if (!b) return;
    var left = Math.ceil((smsCountdownUntil - Date.now()) / 1000);
    if (left > 0) { b.disabled = true; b.textContent = left + "s 后重发"; }
    else { b.disabled = smsBusy; b.textContent = smsPhase === "code" ? "重新发送" : "获取验证码"; }
  }
  function setSmsButtons() {
    var s = $("#sms-send"), l = $("#sms-submit");
    if (s) smsSendLabel();
    if (l) { l.disabled = smsBusy; l.textContent = smsBusy ? "登录中…" : "登 录"; }
  }
  function startSmsTick() {
    stopSms();
    smsTimer = setInterval(function () { smsSendLabel(); if (Date.now() >= smsCountdownUntil) stopSms(); }, 500);
  }
  function smsFormHtml() {
    return '<div class="sms-box">' +
      '<input class="sms-input" id="sms-phone" type="tel" inputmode="numeric" maxlength="13" placeholder="手机号" autocomplete="off">' +
      '<div class="sms-row"><input class="sms-input" id="sms-code" type="tel" inputmode="numeric" maxlength="8" placeholder="短信验证码" autocomplete="off">' +
      '<button class="sms-send" id="sms-send">获取验证码</button></div>' +
      '<button class="sms-login" id="sms-submit">登 录</button>' +
      '<div class="sms-msg" id="sms-msg"></div>' +
      '<div class="qr-sub">验证码由红果官方通道下发，仅用于登录你的红果账号。</div></div>';
  }
  function bindSmsForm() {
    smsSendLabel();
    $("#sms-send").addEventListener("click", function () {
      if (smsBusy || Date.now() < smsCountdownUntil) return;
      var phone = ($("#sms-phone").value || "").trim();
      if (!/^1\d{10}$/.test(phone)) { smsMsg("请输入正确的 11 位手机号", true); return; }
      smsBusy = true; setSmsButtons(); smsMsg("");
      postJSON("/api/v1/account/send-code", { phone: phone, country_code: "" }).then(function (d) {
        smsBusy = false; smsActive = true; smsPhase = d.phase || "code";
        smsCountdownUntil = Date.now() + (Number(d.retry_after) || 60) * 1000;
        if (d.sms_state === "sent") smsMsg("验证码已发送，请查收短信");
        else if (d.sms_state === "limited") smsMsg("发送过于频繁，请稍后再试", true);
        startSmsTick(); setSmsButtons();
      }).catch(function (e) { smsBusy = false; setSmsButtons(); smsMsg(e.message || "验证码发送失败", true); });
    });
    $("#sms-submit").addEventListener("click", function () {
      if (smsBusy) return;
      var phone = ($("#sms-phone").value || "").trim();
      var code = ($("#sms-code").value || "").trim();
      if (!/^1\d{10}$/.test(phone)) { smsMsg("请输入正确的 11 位手机号", true); return; }
      if (!/^\d{4,8}$/.test(code)) { smsMsg("请输入 4-8 位短信验证码", true); return; }
      smsBusy = true; setSmsButtons(); smsMsg("");
      postJSON("/api/v1/account/login", { phone: phone, country_code: "", code: code }).then(function (d) {
        smsBusy = false;
        if (d.logged_in) {
          smsActive = false; smsPhase = "";
          toast("登录成功");
          setTimeout(function () { closeSheet(); renderMine(); }, 600);
          return;
        }
        setSmsButtons();
        if (d.phase === "mfa") { smsPhase = "mfa"; renderMfa(d); return; }
        smsMsg("验证码不正确，请重新输入", true);
      }).catch(function (e) { smsBusy = false; setSmsButtons(); smsMsg(e.message || "登录失败", true); });
    });
  }
  function renderMfa(d) {
    var pane = $("#lg-phone");
    if (!pane) return;
    pane.innerHTML = '<div class="sms-box">' +
      '<div class="mfa-card">红果要求短信验证<br>请用本机发送短信<br>内容：<b>' + esc(d.sms_content || "") + '</b><br>发送至：<b>' + esc(d.sms_number || "") + "</b></div>" +
      '<button class="sms-login" id="mfa-sent">我已发送</button>' +
      '<div class="sms-msg" id="sms-msg"></div>' +
      '<button class="sms-send" id="mfa-back" style="width:100%;padding:12px 0">返回</button></div>';
    $("#mfa-sent").addEventListener("click", function () {
      if (smsBusy) return;
      smsBusy = true; smsMsg("");
      postJSON("/api/v1/account/verify", {}).then(function (s) {
        smsBusy = false;
        if (s.logged_in) {
          smsActive = false; smsPhase = "";
          toast("登录成功");
          setTimeout(function () { closeSheet(); renderMine(); }, 600);
          return;
        }
        smsMsg("尚未检测到短信，请确认已发送后再点一次");
      }).catch(function (e) { smsBusy = false; smsMsg(e.message || "验证失败，请重试", true); });
    });
    $("#mfa-back").addEventListener("click", function () {
      postJSON("/api/v1/account/cancel", {}).catch(function () { });
      smsActive = false; smsPhase = "";
      $("#lg-phone").innerHTML = smsFormHtml();
      bindSmsForm();
    });
  }
  function openLogin() {
    openSheet("登录红果", '<div class="lg-tabs"><button class="lg-tab on" data-t="phone">手机号登录</button><button class="lg-tab" data-t="qr">扫码登录</button></div>' +
      '<div id="lg-phone">' + smsFormHtml() + '</div><div id="lg-qr" style="display:none"></div>');
    bindSmsForm();
    document.querySelectorAll(".lg-tab").forEach(function (t) {
      t.addEventListener("click", function () {
        var qr = t.dataset.t === "qr";
        document.querySelectorAll(".lg-tab").forEach(function (x) { x.classList.toggle("on", x === t); });
        $("#lg-phone").style.display = qr ? "none" : "";
        $("#lg-qr").style.display = qr ? "" : "none";
        if (qr) startQr();
        else cancelQrAttempt();
      });
    });
  }
  // ---------- app updates (native HongguoTVUpdates bridge) ----------
  function updStatus() {
    try { return JSON.parse(window.HongguoTVUpdates.getStatus()) || {}; } catch (e) { return {}; }
  }
  function renderUpdateRow() {
    var el = $("#mn-ver");
    if (!el) return;
    var d = updStatus();
    if (!d.state) { el.textContent = "v1.0"; return; }
    if (d.state === "available") el.textContent = "发现新版 " + (d.latest_version || "");
    else if (d.state === "ready") el.textContent = "可安装 " + (d.latest_version || "");
    else if (d.state === "downloading") el.textContent = "下载中…";
    else if (d.state === "installing") el.textContent = "安装中…";
    else el.textContent = d.current_version || "v1.0";
  }
  var updWatch = 0;
  function checkUpdateNow() {
    if (!window.HongguoTVUpdates) { toast("检查更新仅在 App 内可用"); return; }
    var d0 = updStatus();
    if (d0.state === "downloading" || d0.state === "installing") { toast(d0.message || "更新进行中"); return; }
    if (d0.state === "available" || d0.state === "ready") { toast("新版本已就绪，请按提示安装"); return; }
    toast("正在检查更新…");
    window.HongguoTVUpdates.check();
    clearInterval(updWatch);
    updWatch = setInterval(function () {
      var d = updStatus();
      if (d.state === "checking") return;
      clearInterval(updWatch); updWatch = 0;
      renderUpdateRow();
      if (d.state === "current") toast("已是最新版本 " + (d.current_version || ""));
      else if (d.state === "error" || d.state === "unsupported" || d.state === "incompatible") toast(d.message || "检查更新失败");
      else if (d.state === "ready") toast("安装包已就绪，请按提示安装");
    }, 800);
    setTimeout(function () { if (updWatch) { clearInterval(updWatch); updWatch = 0; renderUpdateRow(); } }, 30000);
  }
  async function openMyList(kind) {
    openSheet(kind === "history" ? "观看历史" : kind === "favorites" ? "我的收藏" : "我的追更", skGrid(4));
    var items = [];
    try {
      if (kind === "follows") { var f = await getJSON("/api/v1/follow", {}); items = (f.items || []).map(function (d) { return { drama: d }; }); }
      else {
        var d = await getJSON("/api/v1/library", {});
        var entries = d.entries || [];
        items = entries.filter(function (e) { return kind === "history" ? e.last_played_at : e.favorite_at; });
        // Most-recent first: last_played_at / favorite_at are epoch-ms numbers.
        var stampKey = kind === "history" ? "last_played_at" : "favorite_at";
        items.sort(function (a, b) { return (Number(b[stampKey]) || 0) - (Number(a[stampKey]) || 0); });
      }
    } catch (e) { openSheet("提示", '<div class="loading">需要登录账号后查看</div>'); return; }
    if (!items.length) { openSheet(kind === "history" ? "观看历史" : kind === "favorites" ? "我的收藏" : "我的追更", '<div class="loading">还没有内容，去逛逛吧</div>'); return; }
    var title = kind === "history" ? "观看历史" : kind === "favorites" ? "我的收藏" : "我的追更";
    openSheet(title, '<div class="list">' + items.map(function (e, i) {
      var d = e.drama || e;
      var c = hashColor(d.series_id);
      var sub = kind === "history" && e.episode ? "看到第" + e.episode + "集" : (d.intro || "").slice(0, 24);
      return '<div class="list-item" data-i="' + i + '"><div class="cover' + (coverOf(d) ? " has-img" : "") + '" style="--c1:' + c[0] + ";--c2:" + c[1] + '">' + (coverOf(d) ? '<img src="' + esc(coverOf(d)) + '" alt="">' : '<span class="cover-art">' + esc((d.title || "").slice(0, 1)) + "</span>") + "</div>" +
        '<div class="li-info"><div class="li-t">' + esc(d.title) + '</div><div class="li-s">' + esc(sub) + "</div></div>" +
        '<span class="go">继续' + ic("chev") + "</span></div>";
    }).join("") + "</div>");
    sheetBody.querySelectorAll(".list-item").forEach(function (li) {
      li.addEventListener("click", function () {
        var e = items[Number(li.dataset.i)];
        var d = e.drama || e;
        closeSheet();
        openPlayer(d, Math.max(0, (e.episode || 1) - 1), e.position || 0, false);
      });
    });
    fadeImgs(sheetBody);
  }

  // ---------- search ----------
  var searchCache = {};
  // "猜你喜欢" keeps one random hot-pool batch per app session so returning
  // to the search tab does not re-shuffle the cards every time.
  var guessCache = null;
  async function renderSearch() {
    var page = $("#page-search");
    var hots = feedItems.slice(0, 4).map(function (x) { return x.d.title; });
    page.innerHTML = '<div class="sug-wrap"><div class="search-bar"><div class="search-box">' + ic("search") + '<input id="search-input" placeholder="搜索短剧、漫剧…"></div><button class="login-btn" id="search-go" style="background:var(--red);color:#fff;padding:8px 16px;border-radius:16px;font-size:13px;font-weight:600">搜索</button></div><div class="sug-list" id="sug-list"></div></div>' +
      '<div class="section"><div class="section-title">热门搜索</div><div class="hot-words">' + (hots.length ? hots.map(function (h) { return '<span class="hot-word">' + esc(h) + "</span>"; }).join("") : '<span class="hot-word">加载中…</span>') + "</div></div>" +
      '<div class="section"><div class="section-title" id="sg-title">猜你喜欢</div><div class="grid2" id="search-grid">' + skGrid(6) + "</div></div>";
    loadGuess();
    function loadGuess() {
      var render = function () {
        var g = $("#search-grid");
        if (g && guessCache && !($("#search-input") || {}).value) renderGridInto(g, guessCache);
      };
      if (guessCache) { render(); return; }
      var sid = String(Math.floor(Math.random() * 9e14) + 1e14);
      getJSON("/api/v1/lists/recommend", { session_id: sid, offset: String(8 * Math.floor(Math.random() * 36)) }).then(function (d) {
        guessCache = (d.items || []).slice(0, 8);
        render();
      }).catch(function () {
        var g = $("#search-grid");
        if (g && !g.querySelector(".card")) g.innerHTML = '<div class="loading">推荐暂时不可用</div>';
      });
    }
    function doSearch(q) {
      if (!q) return;
      $("#sug-list").style.display = "none";
      var t = $("#sg-title"); if (t) t.textContent = "搜索结果";
      var cached = searchCache[q];
      if (cached) { renderGridInto($("#search-grid"), cached); return; }
      $("#search-grid").innerHTML = skGrid(6);
      getJSON("/api/v1/lists/search", { q: q, offset: "0" }).then(function (d) {
        var keys = Object.keys(searchCache);
        if (keys.length >= 12) delete searchCache[keys[0]];
        searchCache[q] = d.items || [];
        renderGridInto($("#search-grid"), d.items || []);
      }).catch(function (e) { $("#search-grid").innerHTML = '<div class="loading">搜索失败：' + esc(e.message) + "</div>"; });
    }
    // Keyword dropdown, like the official app: debounce the input and use the
    // fast suggestions endpoint while the user is still typing.
    var sugTimer = null, sugSeq = 0;
    function showSugs(items, q) {
      var el = $("#sug-list");
      if (!el) return;
      if (!items.length || !q) { el.style.display = "none"; el.innerHTML = ""; return; }
      el.innerHTML = items.slice(0, 8).map(function (s, i) {
        var label = s.name || s.key || "";
        var pos = label.indexOf(q);
        var html = pos >= 0
          ? esc(label.slice(0, pos)) + "<b>" + esc(label.slice(pos, pos + q.length)) + "</b>" + esc(label.slice(pos + q.length))
          : esc(label);
        return '<div class="sug-item" data-i="' + i + '">' + html + (s.kind === "actor" ? "<small>演员</small>" : "") + "</div>";
      }).join("");
      el.style.display = "block";
      el.querySelectorAll(".sug-item").forEach(function (row) {
        row.addEventListener("click", function () {
          var s = items[Number(row.dataset.i)];
          var t = s.name || s.key || "";
          $("#search-input").value = t;
          doSearch(t);
        });
      });
    }
    $("#search-input").addEventListener("input", function () {
      var q = this.value.trim();
      clearTimeout(sugTimer);
      if (!q) { showSugs([], ""); return; }
      sugTimer = setTimeout(function () {
        var seq = ++sugSeq;
        getJSON("/api/v1/search/suggestions", { q: q }).then(function (d) {
          var input = $("#search-input");
          if (seq === sugSeq && input && input.value.trim() === q) showSugs(d.items || [], q);
        }).catch(function () { });
      }, 200);
    });
    $("#search-input").addEventListener("blur", function () {
      setTimeout(function () { var el = $("#sug-list"); if (el) el.style.display = "none"; }, 150);
    });
    $("#search-go").addEventListener("click", function () { doSearch($("#search-input").value.trim()); });
    $("#search-input").addEventListener("keydown", function (e) { if (e.key === "Enter") doSearch(this.value.trim()); });
    page.querySelectorAll(".hot-word").forEach(function (w, i) {
      w.addEventListener("click", function () { $("#search-input").value = w.textContent; doSearch(w.textContent); });
    });
  }
  function renderGridInto(el, items) {
    el.innerHTML = items.map(function (d) {
      var c = hashColor(d.series_id);
      return '<div class="card"><div class="cover' + (coverOf(d) ? " has-img" : "") + '" style="--c1:' + c[0] + ";--c2:" + c[1] + '">' +
        (coverOf(d) ? '<img src="' + esc(coverOf(d)) + '" alt="">' : '<span class="cover-art">' + esc((d.title || "").slice(0, 2)) + "</span>") +
        '<span class="cover-ep">' + (d.episode_count ? d.episode_count + "集" : "") + '</span><div class="cover-foot">' + (d.score ? "★" + esc(d.score) : num(d.play_count)) + "</div></div>" +
        '<div class="card-title">' + esc(d.title) + "</div>" +
        '<div class="card-sub">' + esc((d.tags || [])[0] || "") + (d.play_count ? " · " + num(d.play_count) + "人在看" : "") + "</div></div>";
    }).join("") || '<div class="loading">没有找到相关剧</div>';
    el.querySelectorAll(".card").forEach(function (card, i) {
      card.addEventListener("click", function () { openPlayer(items[i], 0, 0, false); });
    });
    fadeImgs(el);
  }

  // ---------- boot ----------
  // The native startup panel stays up until the first feed frame is actually
  // visible (playing event) so the home page is never revealed half-loaded
  // with a black background. The timer is the JS-side fallback for streams
  // that never autoplay (blocked gesture, upstream failure).
  var startupNotified = false;
  function notifyStartupReady() {
    if (startupNotified) return;
    startupNotified = true;
    try { if (window.HongguoStartup) window.HongguoStartup.notifyReady(); } catch (e) { }
  }
  function speedLabel() {
    var el = $("#p-speed-n");
    if (el) el.textContent = (settings.speed && settings.speed !== 1) ? settings.speed + "x" : "倍速";
  }
  async function loadSettingsFromCore() {
    try {
      var d = await getJSON("/api/v1/ui-settings");
      if (d && d.settings) {
        Object.assign(settings, d.settings);
        localStorage.setItem("hg-mobile", JSON.stringify(settings));
        document.documentElement.style.setProperty("--dm-area", (settings.dmArea || 25) + "%");
        // The feed may already be playing by the time this async fetch lands
        // (fresh WebView origin wipes localStorage every cold start); push
        // the restored speed into every live video element now.
        [typeof pVideo !== "undefined" && pVideo, typeof pVideoB !== "undefined" && pVideoB,
         typeof feedVideo !== "undefined" && feedVideo, typeof feedVideoB !== "undefined" && feedVideoB]
          .forEach(function (v) { if (v) v.playbackRate = settings.speed || 1; });
        speedLabel();
      }
    } catch (e) { }
  }
  speedLabel();
  loadSettingsFromCore();
  bootFeedCache().then(function () { return loadFeed(); }).then(function () {
    if (activeFeed < 0 && feedItems.length) activate(0);
    setTimeout(notifyStartupReady, 4500);
  });
  // unmute feed audio on first user tap
  document.addEventListener("click", function () { feedVideo.muted = false; }, { once: true });
  // Android back button support
  window.HongguoMobileBack = function () {
    if ($("#rank-page").classList.contains("open")) { closeRankPage(); return true; }
    if (sheetWrap.classList.contains("open")) { closeSheet(); return true; }
    if (player.classList.contains("open")) {
      if (cmtUI.isOpen()) { cmtUI.close(); return true; }
      if (cinema) { exitCinema(); return true; } // fullscreen exits to portrait first
      closePlayer(); return true;
    }
    if (detailEl.classList.contains("open")) { closeDetail(); return true; }
    if (homeCmt.isOpen()) { homeCmt.close(); return true; }
    if (drawer.classList.contains("open")) { closeDrawer(); return true; }
    if (!$("#page-home").classList.contains("active")) { switchTab("home"); return true; }
    return false;
  };
  // MainActivity.onBackPressed consults window.HongguoTV.requestBack before
  // showing the exit dialog; the mobile UI must answer through that bridge.
  window.HongguoTV = window.HongguoTV || {};
  window.HongguoTV.requestBack = function () { return HongguoMobileBack(); };
  // Native AppUpdater consults canShowAppUpdate() before every prompt and
  // only fires the startup check once the page opts in via setPromptAllowed.
  window.HongguoTV.canShowAppUpdate = function () {
    return !sheetWrap.classList.contains("open") && !player.classList.contains("open") && !$("#rank-page").classList.contains("open");
  };
  if (window.HongguoTVUpdates) { try { window.HongguoTVUpdates.setPromptAllowed(true); } catch (e) { } }
  // MainActivity calls this instead of showing the old exit dialog: the first
  // back swipe shows a centered top pill, a second one within 3s exits.
  window.HongguoTV.showExitHint = function () { showTopTip("再左滑一次退出应用", 2600); };
  // Audio focus (native): incoming call / headphone unplug pauses whatever is
  // actually playing; regaining focus resumes only that same surface.
  var focusPaused = null;
  function avPause() {
    if (player.classList.contains("open")) { if (!pVideo.paused) { pVideo.pause(); return "p"; } return null; }
    if (!feedVideo.paused) { feedVideo.pause(); feedWantPlay = false; return "f"; }
    return null;
  }
  function avResume(which) {
    if (which === "p") playP();
    else if (which === "f") tryPlayFeed();
  }
  window.HongguoTV.audioFocus = function (gained) {
    if (gained) { avResume(focusPaused); focusPaused = null; }
    else focusPaused = avPause();
  };
  // MainActivity fires these on every pause/resume; without them the call
  // throws a TypeError and background playback relies on WebView internals.
  var bgPaused = null;
  window.HongguoTV.pauseForBackground = function () { bgPaused = avPause(); };
  window.HongguoTV.resumeFromBackground = function () { avResume(bgPaused); bgPaused = null; };
})();
