// 智赢K线训练助手 · 网页版专属补丁：图表画布自适应窗口/手机旋转
// 桌面版窗口固定，图表不随窗口缩放没问题；网页版在手机上旋转或改变窗口后画布尺寸不变，
// 导致出现大片空白或价格轴被裁掉。这里启用图表库 v4.2 的 autoSize 能力让画布始终跟随容器。
(function () {
  'use strict';
  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    var app = window.__zyApp;
    if (app && app.charts && app.charts.kline) {
      clearInterval(timer);
      try {
        app.charts.kline.applyOptions({ autoSize: true });
        app.charts.volume.applyOptions({ autoSize: true });
        app.charts.macd.applyOptions({ autoSize: true });
      } catch (e) { /* 极老内核浏览器不支持时保持原样 */ }
    } else if (tries > 100) {
      clearInterval(timer);
    }
  }, 100);
})();
