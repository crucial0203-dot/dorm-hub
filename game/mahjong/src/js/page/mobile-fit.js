/* 麻将棋盘移动端等比缩放（2026-09-27，dorm-hub 集成层新增）
 * 棋盘 .board 固定 45em(720px)：窄屏时优先用 zoom（Chromium 支持且参与布局，无横向幻影滚动），
 * 不支持时回退 transform: scale + 负下边距补偿；--mj-scale/--mj-inv 供 mobile.css 反向补偿弹窗字号。 */
(function mobileFit() {
  'use strict';
  var BREAKPOINT = 820;
  function fit() {
    var board = document.querySelector('main.board');
    if (!board) return;
    var avail = document.documentElement.clientWidth;
    var root = document.documentElement;
    if (window.innerWidth > BREAKPOINT) {
      board.style.zoom = '';
      board.style.transform = '';
      board.style.marginBottom = '';
      root.style.removeProperty('--mj-scale');
      root.style.removeProperty('--mj-inv');
      return;
    }
    var need = board.offsetWidth;
    if (!need) return;
    var s = Math.min(1, avail / need);
    if ('zoom' in board.style) {
      board.style.zoom = s;
      board.style.transform = '';
      board.style.marginBottom = '';
    } else {
      board.style.transformOrigin = 'top left';
      board.style.transform = 'scale(' + s + ')';
      board.style.marginBottom = (s - 1) * board.offsetHeight + 'px';
    }
    root.style.setProperty('--mj-scale', s);
    root.style.setProperty('--mj-inv', 1 / s);
  }
  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', fit);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fit);
  } else {
    fit();
  }
})();
