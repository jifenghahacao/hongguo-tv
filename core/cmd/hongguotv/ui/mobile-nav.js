/* Phone navigation: collapse the bottom bar to three tabs (首页/剧场/我的),
   restyle the account page like the official Hongguo app, and add a
   prominent 全屏观看 pill to the portrait player. */
(function () {
  "use strict";
  var mq = window.matchMedia("(max-width: 760px), (max-height: 480px)");
  var SECONDARY = ["rank", "new", "history", "favorites", "follows", "support", "settings"];
  var TILES = [
    { page: "favorites", icon: "icon-favorite", label: "收藏" },
    { page: "history", icon: "icon-history", label: "历史" },
    { page: "follows", icon: "icon-reservation", label: "追更" },
    { page: "rank", icon: "icon-rank", label: "榜单" },
    { page: "support", icon: "icon-heart", label: "打赏" },
    { page: "settings", icon: "icon-settings", label: "设置" }
  ];

  function svgIcon(id) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("aria-hidden", "true");
    var use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#" + id);
    svg.appendChild(use);
    return svg;
  }

  function renameTab(item, name) {
    if (!item) return;
    var span = item.querySelector("span:not(.side-notification-dot)");
    if (span) {
      span.removeAttribute("data-i18n");
      span.textContent = name;
    }
  }

  function addChips(container, items, heading) {
    if (!container || container.querySelector(".mobile-quick-entries")) return;
    var row = document.createElement("div");
    row.className = "mobile-quick-entries";
    var title = document.createElement("strong");
    title.textContent = heading;
    row.appendChild(title);
    items.forEach(function (item) {
      if (!item) return;
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "mobile-quick-entry";
      chip.textContent = item.getAttribute("aria-label") || item.textContent.trim();
      chip.addEventListener("click", function () { item.click(); });
      row.appendChild(chip);
    });
    var headingRow = container.querySelector(".search-heading-row") || container.querySelector(".account-heading");
    if (headingRow && headingRow.parentNode) headingRow.parentNode.insertBefore(row, headingRow.nextSibling);
    else container.appendChild(row);
  }

  function buildAccountPage(byPage) {
    var page = document.getElementById("account-page");
    if (!page || page.querySelector(".mobile-account-header")) return;

    var header = document.createElement("div");
    header.className = "mobile-account-header";
    var avatar = document.createElement("span");
    avatar.className = "mobile-account-avatar";
    avatar.appendChild(svgIcon("icon-user"));
    var name = document.createElement("strong");
    name.textContent = "登录/注册";
    header.appendChild(avatar);
    header.appendChild(name);

    var banner = document.createElement("div");
    banner.className = "mobile-login-banner";
    var copy = document.createElement("div");
    var bTitle = document.createElement("strong");
    bTitle.textContent = "登录领取福利";
    var bDesc = document.createElement("span");
    bDesc.textContent = "登录可同步收藏、历史与账号权益";
    copy.appendChild(bTitle);
    copy.appendChild(bDesc);
    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "登录";
    btn.addEventListener("click", function () {
      var input = page.querySelector("input");
      if (input) { input.focus(); input.scrollIntoView({ block: "center" }); return; }
      var form = page.querySelector("button");
      if (form) form.scrollIntoView({ block: "start" });
    });
    banner.appendChild(copy);
    banner.appendChild(btn);

    var grid = document.createElement("div");
    grid.className = "mobile-tile-grid";
    var gTitle = document.createElement("strong");
    gTitle.textContent = "常用功能";
    grid.appendChild(gTitle);
    TILES.forEach(function (tile) {
      var item = byPage[tile.page];
      if (!item) return;
      var button = document.createElement("button");
      button.type = "button";
      button.className = "mobile-tile";
      button.appendChild(svgIcon(tile.icon));
      var label = document.createElement("span");
      label.textContent = tile.label;
      button.appendChild(label);
      button.addEventListener("click", function () { item.click(); });
      grid.appendChild(button);
    });

    var heading = page.querySelector(".account-heading");
    if (heading) {
      heading.parentNode.insertBefore(header, heading);
      heading.parentNode.insertBefore(banner, heading.nextSibling);
      heading.parentNode.insertBefore(grid, banner.nextSibling);
    } else {
      page.insertBefore(grid, page.firstChild);
      page.insertBefore(banner, page.firstChild);
      page.insertBefore(header, page.firstChild);
    }
  }

  function ensureAccountPage(byPage) {
    var page = document.getElementById("account-page");
    if (!page) return;
    buildAccountPage(byPage);
    // The app auto-focuses the login field when opening the page, which scrolls
    // past the injected header; pin the view back to the top on each open.
    var wasHidden = page.classList.contains("is-hidden");
    new MutationObserver(function () {
      var hidden = page.classList.contains("is-hidden");
      if (!hidden && wasHidden) setTimeout(function () { page.scrollTop = 0; }, 0);
      wasHidden = hidden;
    }).observe(page, { attributes: true, attributeFilter: ["class"] });
  }

  function buildFullscreenPill(shell) {
    var hero = document.getElementById("hero") || shell.querySelector(".hero");
    if (!hero || hero.querySelector(".mobile-fullscreen-pill")) return;
    var pill = document.createElement("button");
    pill.type = "button";
    pill.className = "mobile-fullscreen-pill";
    pill.appendChild(svgIcon("icon-fullscreen"));
    var label = document.createElement("span");
    label.textContent = "全屏观看";
    pill.appendChild(label);
    pill.addEventListener("click", function () {
      var btn = shell.querySelector('.playback-buttons [data-action="fullscreen"]');
      if (btn) btn.click();
    });
    hero.appendChild(pill);
    function sync() {
      var cinema = shell.classList.contains("is-cinema");
      // The detail-page player (mode=player) has no icon row in portrait,
      // so the pill is its only entry into cinema mode as well.
      var playing = shell.dataset.mode === "recommend" || shell.dataset.mode === "player";
      pill.classList.toggle("is-hidden", cinema || !playing);
    }
    new MutationObserver(sync).observe(shell, { attributes: true, attributeFilter: ["class", "data-mode"] });
    sync();
  }

  /* Continuous drag on the progress bar: preview while moving, seek once on
     release. A plain tap still falls through to the app's own click handler. */
  function attachProgressDrag() {
    var track = document.getElementById("control-progress");
    if (!track || track.dataset.mobileDrag === "1") return;
    track.dataset.mobileDrag = "1";
    var fill = track.querySelector("span");
    var label = document.querySelector(".playback-timeline .time-label");
    var dragging = false;
    function fmt(value) {
      value = Math.max(0, Math.floor(value || 0));
      var m = Math.floor(value / 60), s = value % 60;
      return m + ":" + (s < 10 ? "0" : "") + s;
    }
    function preview(clientX) {
      var video = document.getElementById("hero-video");
      var rect = track.getBoundingClientRect();
      if (!rect.width) return rect;
      var ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      if (fill) fill.style.width = (ratio * 100) + "%";
      if (label && video && Number.isFinite(video.duration) && video.duration > 0) {
        label.textContent = fmt(ratio * video.duration) + " / " + fmt(video.duration);
      }
      return rect;
    }
    track.addEventListener("pointerdown", function (event) {
      if (track.disabled) return;
      dragging = true;
      try { track.setPointerCapture(event.pointerId); } catch (ignored) {}
      // No preventDefault here: it suppresses the click that performs the
      // actual seek. touch-action:none already blocks page scrolling.
      preview(event.clientX);
    });
    track.addEventListener("pointermove", function (event) {
      if (dragging) preview(event.clientX);
    });
    function finish(event) {
      if (!dragging) return;
      dragging = false;
      if (fill) fill.style.width = "";
      var rect = track.getBoundingClientRect();
      if (!rect.width) return;
      // A real drag past the click slop never fires a click, so the app's
      // click-to-seek never runs. Dispatch one ourselves with the release
      // coordinates, clamped to the track. Plain taps duplicate the seek at
      // the same position, which is idempotent.
      track.dispatchEvent(new MouseEvent("click", {
        bubbles: true, detail: 1,
        clientX: Math.max(rect.left, Math.min(rect.right, event.clientX)),
        clientY: rect.top + rect.height / 2
      }));
    }
    track.addEventListener("pointerup", finish);
    track.addEventListener("pointercancel", function () {
      dragging = false;
      if (fill) fill.style.width = "";
    });
  }

  /* Portrait feed: horizontal swipes switch episodes. Cinema (landscape):
     vertical swipes switch episodes instead of switching to the next drama,
     which the app's own gesture would otherwise do. */
  function attachEpisodeSwipe(shell) {
    var surface = document.querySelector(".hero-media");
    if (!surface || surface.dataset.mobileSwipe === "1") return;
    surface.dataset.mobileSwipe = "1";
    var touch = null;
    function allowed(target) {
      if (!window.HongguoTV || typeof window.HongguoTV.switchEpisode !== "function") return false;
      if (target.closest("button, input, textarea, a, label, .bottom-controls, .detail-modal, .player-options, .mobile-player-menu")) return false;
      var mode = shell.dataset.mode;
      return mode === "recommend" || mode === "player";
    }
    surface.addEventListener("touchstart", function (event) {
      touch = null;
      if (event.touches.length !== 1 || !allowed(event.target)) return;
      var point = event.touches[0];
      touch = { x: point.clientX, y: point.clientY, cinema: shell.classList.contains("is-cinema") };
    }, false);
    surface.addEventListener("touchmove", function (event) {
      if (!touch || touch.cinema || event.touches.length !== 1) return;
      var point = event.touches[0];
      var dx = Math.abs(point.clientX - touch.x), dy = Math.abs(point.clientY - touch.y);
      if (dx > 10 && dx > dy * 1.2) event.preventDefault();
    }, false);
    document.addEventListener("touchend", function (event) {
      var start = touch;
      touch = null;
      if (!start || !event.changedTouches || !event.changedTouches.length) return;
      var point = event.changedTouches[0];
      var dx = point.clientX - start.x, dy = point.clientY - start.y;
      var horizontal = !start.cinema && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.2;
      var vertical = start.cinema && Math.abs(dy) > 60 && Math.abs(dy) > Math.abs(dx) * 1.2;
      if (!horizontal && !vertical) return;
      // Capture phase + stopPropagation claims the gesture before the app's
      // own feed swipe can switch to a different drama.
      event.stopPropagation();
      if (event.cancelable) event.preventDefault();
      shell.dataset.swipeUntil = String(Date.now() + 500);
      window.HongguoTV.switchEpisode(vertical ? (dy < 0 ? 1 : -1) : (dx < 0 ? 1 : -1));
    }, true);
    surface.addEventListener("touchcancel", function () { touch = null; });
  }

  /* Tap cycles the controls: one tap shows them, the next hides them again.
     A tap in the centre additionally toggles play/pause. */
  function attachCenterTapToggle(shell, hero) {
    hero.addEventListener("click", function (event) {
      if (event.target.closest("button, a, input, textarea, select, label, .bottom-controls, .right-actions, .catalog-ribbon, .player-options, .detail-modal, .playback-command-menu, .end-recommendations")) return;
      // A tap that just dismissed the cinema option sheet does nothing else.
      if (event.hongguoSheetClosed) return;
      // Swipes end in a synthetic click; they must not toggle playback.
      if (Date.now() < Number(shell.dataset.swipeUntil || 0)) return;
      var rect = hero.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      var wasHidden = shell.classList.contains("is-controls-hidden");
      var x = (event.clientX - rect.left) / rect.width;
      var y = (event.clientY - rect.top) / rect.height;
      if (x > 0.15 && x < 0.85 && y > 0.18 && y < 0.82) {
        var btn = document.querySelector('.playback-buttons [data-action="pause"]');
        if (btn) btn.click();
      }
      // The app reveals controls on every action; enforce the show/hide loop
      // against the state that existed before this tap.
      if (wasHidden) shell.classList.remove("is-controls-hidden");
      else shell.classList.add("is-controls-hidden");
    });
  }

  /* Wide videos rotate the phone into landscape when cinema starts and back
     to the sensor default when it ends. The native bridge is a no-op on TVs. */
  function attachCinemaOrientation(shell) {
    var wasCinema = shell.classList.contains("is-cinema");
    function isLandscapeVideo() {
      var video = document.getElementById("hero-video");
      return !!(video && video.videoWidth > video.videoHeight * 1.05);
    }
    function sync() {
      var cinema = shell.classList.contains("is-cinema");
      if (cinema === wasCinema) return;
      wasCinema = cinema;
      try {
        if (window.HongguoScreen) { window.HongguoScreen.setLandscape(cinema && isLandscapeVideo()); return; }
      } catch (ignored) {}
      if (cinema && isLandscapeVideo() && screen.orientation && screen.orientation.lock) {
        screen.orientation.lock("landscape").catch(function () {});
      }
    }
    new MutationObserver(sync).observe(shell, { attributes: true, attributeFilter: ["class"] });
  }

  /* Rotating to landscape enters cinema automatically; rotating back exits. */
  function attachLandscapeCinema(shell) {
    var autoEntered = false;
    function detailOpen() {
      var modal = document.getElementById("detail-modal");
      return modal && !modal.classList.contains("is-hidden");
    }
    function handle() {
      var btn = shell.querySelector('.playback-buttons [data-action="fullscreen"]');
      if (!btn) return;
      var landscape = window.innerWidth > window.innerHeight;
      var cinema = shell.classList.contains("is-cinema");
      var playing = shell.dataset.mode === "recommend";
      if (landscape && playing && !cinema && !detailOpen()) {
        btn.click();
        autoEntered = true;
      } else if (!landscape && cinema && autoEntered) {
        btn.click();
        autoEntered = false;
      }
    }
    window.addEventListener("orientationchange", function () { setTimeout(handle, 250); });
    window.addEventListener("resize", handle);
  }

  /* Replace the portrait button row with the official-style bar:
     观看完整剧情 · 全N集  +  a ⋮ icon opening 倍速/清晰度/弹幕/全集. */
  function buildControlRow(shell) {
    var controls = shell.querySelector(".bottom-controls");
    var hero = document.getElementById("hero") || shell.querySelector(".hero");
    if (!controls || !hero || hero.querySelector(".mobile-control-row")) return;

    var row = document.createElement("div");
    row.className = "mobile-control-row";

    var watch = document.createElement("button");
    watch.type = "button";
    watch.className = "mobile-watch-pill";
    var watchText = document.createElement("span");
    watchText.textContent = "观看完整剧情";
    var watchCount = document.createElement("span");
    watchCount.className = "mobile-watch-count";
    var chevron = document.createElement("i");
    chevron.className = "mobile-watch-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = "▴";
    watch.appendChild(watchText);
    watch.appendChild(watchCount);
    watch.appendChild(chevron);
    watch.addEventListener("click", function () {
      var btn = shell.querySelector('.playback-buttons [data-action="episodes"]');
      if (btn) btn.click();
    });

    var more = document.createElement("button");
    more.type = "button";
    more.className = "mobile-more-btn";
    more.setAttribute("aria-label", "更多设置");
    more.textContent = "⋮";

    var menu = document.createElement("div");
    menu.className = "mobile-player-menu is-hidden";
    [
      { label: "倍速", sel: '[data-action="speed"]' },
      { label: "清晰度", sel: '[data-action="quality"]' },
      { label: "弹幕开关", sel: '[data-action="danmaku"]' },
      { label: "全集", sel: '[data-action="episodes"]' }
    ].forEach(function (item) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "mobile-player-menu-item";
      button.textContent = item.label;
      button.addEventListener("click", function () {
        menu.classList.add("is-hidden");
        var target = shell.querySelector(item.sel);
        if (target) target.click();
      });
      menu.appendChild(button);
    });
    more.addEventListener("click", function (event) {
      event.stopPropagation();
      menu.classList.toggle("is-hidden");
    });
    document.addEventListener("click", function () { menu.classList.add("is-hidden"); });

    /* Cinema mode: the TV icon row is hidden, so expose the current speed,
       quality and danmaku state inline plus a compact exit-fullscreen icon. */
    var cinemaGroup = document.createElement("div");
    cinemaGroup.className = "mobile-cinema-controls";
    function cinemaButton(sel, iconId) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "mobile-cinema-btn";
      if (iconId) button.appendChild(svgIcon(iconId));
      var label = document.createElement("span");
      button.appendChild(label);
      button.addEventListener("click", function () {
        var target = shell.querySelector(sel);
        if (target) target.click();
      });
      cinemaGroup.appendChild(button);
      return label;
    }
    var cinemaSpeed = cinemaButton('[data-action="speed"]');
    var cinemaQuality = cinemaButton('[data-action="quality"]');
    var cinemaDanmaku = cinemaButton('[data-action="danmaku"]');
    cinemaButton('[data-action="fullscreen"]', "icon-fullscreen-exit");

    function syncCinemaLabels() {
      var speed = shell.querySelector('[data-action="speed"]');
      var quality = shell.querySelector('[data-action="quality"]');
      var danmaku = shell.querySelector('[data-action="danmaku"]');
      if (speed) {
        var rate = speed.getAttribute("aria-label") || "倍速";
        cinemaSpeed.textContent = rate.replace(/^(\d)x$/, "$1.0x");
      }
      if (quality) {
        var q = (quality.getAttribute("aria-label") || "").replace(/^自动 · /, "");
        cinemaQuality.textContent = q && q !== "清晰度" ? q : "自动";
      }
      if (danmaku) cinemaDanmaku.textContent = danmaku.getAttribute("aria-pressed") === "true" ? "弹幕开" : "弹幕关";
    }
    [
      '[data-action="speed"]', '[data-action="quality"]', '[data-action="danmaku"]'
    ].forEach(function (sel) {
      var button = shell.querySelector(sel);
      if (button) new MutationObserver(syncCinemaLabels).observe(button, { attributes: true, attributeFilter: ["aria-label", "aria-pressed"] });
    });
    syncCinemaLabels();

    // Tapping the picture while the cinema option panel is open closes it.
    // Capture phase: the app stops propagation of clicks on the video.
    document.addEventListener("click", function (event) {
      var panel = document.getElementById("player-options");
      if (!panel || !shell.classList.contains("is-cinema") || panel.classList.contains("is-hidden")) return;
      if (event.target.closest(".player-options, .mobile-cinema-controls, .mobile-player-menu, .playback-buttons")) return;
      // Same tap only dismisses the sheet; skip the play/controls toggle.
      event.hongguoSheetClosed = true;
      var close = document.getElementById("player-options-close");
      if (close) close.click();
    }, true);

    row.appendChild(watch);
    row.appendChild(cinemaGroup);
    row.appendChild(more);
    controls.appendChild(menu);
    controls.appendChild(row);

    var episode = hero.querySelector(".hero-episode");
    function syncCount() {
      if (!episode) return;
      var match = episode.textContent.match(/全(\d+)集/);
      watchCount.textContent = match ? " · 全" + match[1] + "集" : "";
    }
    if (episode) {
      syncCount();
      new MutationObserver(syncCount).observe(episode, { childList: true, characterData: true, subtree: true });
    }
  }

  function apply() {
    if (!mq.matches) return;
    var shell = document.querySelector(".app-shell");
    if (!shell || shell.dataset.mobileNav === "1") return;
    shell.dataset.mobileNav = "1";
    var byPage = {};
    shell.querySelectorAll(".side-item[data-page]").forEach(function (item) {
      byPage[item.getAttribute("data-page")] = item;
    });
    renameTab(byPage.recommend, "首页");
    renameTab(byPage.search, "剧场");
    renameTab(byPage.account, "我的");
    SECONDARY.forEach(function (page) {
      if (byPage[page]) byPage[page].classList.add("is-hidden");
    });
    addChips(document.getElementById("search-page"), [byPage.rank, byPage.new, byPage.history, byPage.favorites], "更多入口");
    ensureAccountPage(byPage);
    buildFullscreenPill(shell);
    buildControlRow(shell);
    attachProgressDrag();
    var hero = document.getElementById("hero") || shell.querySelector(".hero");
    if (hero) attachCenterTapToggle(shell, hero);
    attachEpisodeSwipe(shell);
    attachCinemaOrientation(shell);
    attachLandscapeCinema(shell);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { setTimeout(apply, 0); });
  } else {
    setTimeout(apply, 0);
  }
})();
