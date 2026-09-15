// 智赢K线训练助手 v5 — 完整优化版
(function() {
  'use strict';

  var LW = window.LightweightCharts;
  if (!LW) { console.error('LightweightCharts未加载'); return; }

  var app = {
    settings: {
      stopProfit: 0, stopLoss: 0,
      excludeST: true, excludeSTStar: true,
      buyRatio: 1, sellRatio: 1
    },
    // stateSnapshot: 用于撤销功能
    _snapshot: null,
    state: {
      rawKlines: [], klines: [],
      period: 'day', rawIndex: 0, currentIndex: 0,
      historyCount: 0, rawHistoryCount: 0, totalTrainingBars: 150,
      position: null, cash: 100000, totalAssets: 100000, startCapital: 100000,
      currentCapital: 100000,  // 持久化的最新余额，新训练从它取，不被任何功能键重置
      trades: [], tradeMarkers: [], isTraining: false, isFinished: false,
      trainingStarted: false,  // 用户是否已进入训练区
      stockInfo: null, stockType: 'normal', stockTypeName: '主板', isMock: true
    },
    charts: {}, series: {},
    maData: { ma5:[], ma10:[], ma20:[] },
    volumeData: [], macdData: [],
    _userZoomed: false, _suppressRangeEvent: false, _toastTimer: null
  };

  // ===== 状态快照（撤销用）=====
  function saveSnapshot() {
    app._snapshot = {
      cash: app.state.cash, totalAssets: app.state.totalAssets,
      position: app.state.position ? { shares: app.state.position.shares, avgPrice: app.state.position.avgPrice } : null,
      trades: app.state.trades.slice(), tradeMarkers: app.state.tradeMarkers.slice(),
      rawIndex: app.state.rawIndex
    };
  }

  function undoLastAction() {
    if (!app._snapshot || !app.state.isTraining || app.state.isFinished) return;
    if (app.state.rawIndex === app._snapshot.rawIndex && app.state.position === null && app._snapshot.position === null) {
      toast('没有可撤销的操作','info'); return;
    }
    var snap = app._snapshot;
    app.state.cash = snap.cash;
    app.state.totalAssets = snap.totalAssets;
    app.state.position = snap.position;
    app.state.trades = snap.trades.slice();
    app.state.tradeMarkers = snap.tradeMarkers.slice();
    // 注意：撤销只回退账户与交易快照，不改变训练进行中状态，
    // 因此不能从快照恢复 isFinished/isTraining/trainingStarted（快照未保存这些，
    // 用 undefined 覆盖会触发 buy/sell/skip 的守卫、把训练永久锁死）。

    // 回退 rawIndex 并重建所有图表状态
    app.state.rawIndex = snap.rawIndex;
    app.state.klines = aggregateKlines(app.state.rawKlines.slice(0, app.state.rawIndex + 1), app.state.period);
    app.state.currentIndex = app.state.klines.length - 1;
    calcIndicators(); renderAllCharts();
    updateAccount(); saveCurrentCapital(); updateProgress();
    setButtons(true);
    // 如无持仓，撤销按钮禁用
    var undoBtn = document.getElementById('btn-undo');
    if (undoBtn && app.state.trades.length === 0) undoBtn.disabled = true;
    app._snapshot = null;
    toast('已撤销上一笔操作', 'info');
  }

  // ===== 日期工具 =====
  function getWeekKey(dateStr) {
    // 统一使用 UTC，避免本地零点与 getUTCDay/setUTCDate 混用导致部分时区周聚合归错周
    var d = new Date(dateStr + 'T00:00:00Z');
    var dayNum = d.getUTCDay() || 7; d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    var weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return d.getUTCFullYear() + '-W' + String(weekNo).padStart(2, '0');
  }
  function getMonthKey(dateStr) { return dateStr.substring(0, 7); }

  // ===== K线聚合 =====
  function aggregateKlines(raw, period) {
    if (period === 'day') return raw.map(function(k) { return { date:k.date, open:k.open, high:k.high, low:k.low, close:k.close, volume:k.volume }; });
    if (period === 'week') return aggregateBy(raw, getWeekKey);
    if (period === 'month') return aggregateBy(raw, getMonthKey);
    return raw;
  }
  function aggregateBy(raw, keyFn) {
    var result = [], group = [];
    raw.forEach(function(bar) {
      if (group.length > 0 && keyFn(group[0].date) !== keyFn(bar.date)) {
        result.push(mergeGroup(group)); group = [];
      }
      group.push(bar);
    });
    if (group.length > 0) result.push(mergeGroup(group));
    return result;
  }
  function mergeGroup(bars) {
    var first = bars[0], last = bars[bars.length - 1];
    var high = -Infinity, low = Infinity, vol = 0;
    bars.forEach(function(b) { if (b.high > high) high = b.high; if (b.low < low) low = b.low; vol += b.volume; });
    return { date: first.date, open: first.open, high: high, low: low, close: last.close, volume: vol };
  }

  // ===== 图表初始化 =====
  function initCharts() {
    var themeOptions = {
      layout: { background: { type: 'solid', color: '#150e10' }, textColor: '#dcd2d4', fontSize: 11 },
      grid: { vertLines: { color: 'rgba(255, 120, 120, 0.07)' }, horzLines: { color: 'rgba(255, 120, 120, 0.07)' } },
      rightPriceScale: { borderColor: '#3a2b30', autoScale: true, minimumWidth: 65, scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: { borderColor: '#3a2b30' },
      crosshair: { mode: 0 }
    };
    app.charts.kline = LW.createChart(document.getElementById('chart-kline'), themeOptions);
    app.series.candlestick = app.charts.kline.addCandlestickSeries({
      upColor: '#ef4444', downColor: '#22c55e',
      borderUpColor: '#ef4444', borderDownColor: '#22c55e',
      wickUpColor: '#ef4444', wickDownColor: '#22c55e'
    });
    app.series.ma5 = app.charts.kline.addLineSeries({ color: '#ffffff', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    app.series.ma10 = app.charts.kline.addLineSeries({ color: '#fbbf24', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    app.series.ma20 = app.charts.kline.addLineSeries({ color: '#a78bfa', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    app.series.startLine = app.charts.kline.addLineSeries({ color: '#ff7b7b', lineWidth: 2, lineStyle: 2, priceScaleId: '', priceLineVisible: false, lastValueVisible: false });
    // 持仓成本线
    app.series.costLine = app.charts.kline.addLineSeries({ color: '#3b82f6', lineWidth: 1, lineStyle: 1, priceLineVisible: false, lastValueVisible: false, title: '成本' });

    app.charts.volume = LW.createChart(document.getElementById('chart-volume'), themeOptions);
    app.series.volume = app.charts.volume.addHistogramSeries({ priceFormat: { type: 'volume' }, priceLineVisible: false });

    // MACD 子图使用独立配置，确保 price scale 能完整显示负值和小数值
    var macdThemeOptions = JSON.parse(JSON.stringify(themeOptions));
    macdThemeOptions.layout = { background: { type: 'solid', color: '#150e10' }, textColor: '#dcd2d4', fontSize: 10 };
    macdThemeOptions.rightPriceScale = {
      borderColor: '#3a2b30',
      autoScale: true,
      scaleMargins: { top: 0.02, bottom: 0.02 },
      alignLabels: false,
      minimumWidth: 65
    };
    app.charts.macd = LW.createChart(document.getElementById('chart-macd'), macdThemeOptions);
    var macdPriceFormat = { type: 'price', precision: 4, minMove: 0.0001 };
    // 顺序关键：直方图先建(置于底层)，DIFF/DEA 线后建(置于顶层)，避免柱体遮盖两根指标线
    app.series.macdBar = app.charts.macd.addHistogramSeries({
      priceFormat: macdPriceFormat,
      priceLineVisible: false
    });
    app.series.diff = app.charts.macd.addLineSeries({
      color: '#22d3ee', lineWidth: 3,
      priceFormat: macdPriceFormat,
      priceLineVisible: false, lastValueVisible: false, title: 'DIFF'
    });
    app.series.dea = app.charts.macd.addLineSeries({
      color: '#fbbf24', lineWidth: 3,
      priceFormat: macdPriceFormat,
      priceLineVisible: false, lastValueVisible: false, title: 'DEA'
    });
    app.series.macdZero = app.charts.macd.addLineSeries({
      color: 'rgba(148,163,184,0.7)', lineWidth: 1, lineStyle: 2,
      priceFormat: macdPriceFormat,
      priceLineVisible: false, lastValueVisible: false, title: '0轴'
    });

    // 联动：setCrosshairPosition(price, time, series)，time 用业务日字符串（与系列数据一致）
    function priceForTime(kind, time) {
      if (kind === 'volume') {
        for (var i = 0; i < app.volumeData.length; i++) if (app.volumeData[i].time === time) return app.volumeData[i].value;
      } else if (kind === 'diff') {
        for (var j = 0; j < app.macdData.diff.length; j++) if (app.macdData.diff[j].time === time) return app.macdData.diff[j].value;
      } else { // kline close
        for (var k = 0; k < app.state.klines.length; k++) if (app.state.klines[k].date === time) return app.state.klines[k].close;
      }
      return 0;
    }
    // 联动：setCrosshairPosition(price, time, series)，time 用业务日字符串（与系列数据一致）
    // 关键：目标序列还没有数据时（首次加载 setData 级联期间 / MACD 预热区），
    // setCrosshairPosition 会在库内部抛 "Value is null"（空价格范围断言），
    // 异常沿 setData 冒泡会中断整个渲染回调 → fitToDefaultView 不执行 →
    // MACD 时间轴停留 null → 首次进入副图空白（点“新训练”因三图已有数据而正常）。
    // 因此每个调用必须单独 try/catch，目标图暂时无法定位该时间时静默跳过。
    function syncCrosshair(targetChart, targetSeries, kind, time) {
      try { targetChart.setCrosshairPosition(priceForTime(kind, time), time, targetSeries); }
      catch (e) { /* 目标图尚无该时间点数据，跳过 */ }
    }
    app.charts.kline.subscribeCrosshairMove(function(p) {
      if (!p.time) { app.charts.volume.clearCrosshairPosition(); app.charts.macd.clearCrosshairPosition(); return; }
      syncCrosshair(app.charts.volume, app.series.volume, 'volume', p.time);
      syncCrosshair(app.charts.macd, app.series.diff, 'diff', p.time);
    });
    app.charts.volume.subscribeCrosshairMove(function(p) {
      if (!p.time) { app.charts.kline.clearCrosshairPosition(); app.charts.macd.clearCrosshairPosition(); return; }
      syncCrosshair(app.charts.kline, app.series.candlestick, 'kline', p.time);
      syncCrosshair(app.charts.macd, app.series.diff, 'diff', p.time);
    });
    // 三图都订阅可见范围变化：任意图被拖动/缩放，都会经 handleRangeChange 换算后
    // 同步给另外两图（此前只订阅 K 线图，在成交量/MACD 面板上拖动/滚轮只会
    // 单独移动自己，与另两图脱节，表现为「MACD 不能和 K线、成交量同步」）。
    ['kline', 'volume', 'macd'].forEach(function(name) {
      var chart = app.charts[name];
      chart.timeScale().subscribeVisibleLogicalRangeChange(function(range) {
        handleRangeChange(chart, range);
      });
    });
  }

  // ===== 指标计算 =====
  function calcMA(d, p) {
    var r = []; for (var i = 0; i < d.length; i++) { var s = d.slice(Math.max(0, i-p+1), i+1); var sum = 0; for (var j = 0; j < s.length; j++) sum += s[j]; r.push(sum / s.length); } return r;
  }
  function calcEMA(d, p) {
    if (d.length < p) return [d.reduce(function(a,b){return a+b;},0)/d.length];
    var r = [], sum = 0; for (var j = 0; j < p; j++) sum += d[j];
    var ema = sum/p, m = 2/(p+1); r.push(ema);
    for (var i = p; i < d.length; i++) { ema = (d[i]-ema)*m + ema; r.push(ema); } return r;
  }
  function calcMACD(closes) {
    if (closes.length < 26) return { diff:[], dea:[], bars:[] };
    // 防御：收盘价必须全是有效数字
    for (var ci = 0; ci < closes.length; ci++) {
      if (!Number.isFinite(closes[ci])) {
        console.warn('[MACD] 收盘价含无效值', ci, closes[ci]);
        return { diff:[], dea:[], bars:[] };
      }
    }
    var ema12=calcEMA(closes,12), ema26=calcEMA(closes,26), len=ema26.length, e12=ema12.slice(ema12.length-len);
    var diff=[]; for(var i=0;i<len;i++) diff.push(e12[i]-ema26[i]);
    var dea=calcEMA(diff,9), dLen=dea.length, d2=diff.slice(diff.length-dLen);
    var bars=[], dates=app.state.klines.map(function(k){return k.date;}), si=dates.length-dLen;
    for(var i=0;i<dLen;i++) {
      var v=2*(d2[i]-dea[i]);
      bars.push({time:dates[si+i],value:v,color:v>=0?'rgba(239,68,68,0.85)':'rgba(34,197,94,0.85)'});
    }
    var result = {diff:d2.map(function(v,i){return{time:dates[si+i],value:v};}),dea:dea.map(function(v,i){return{time:dates[si+i],value:v};}),bars:bars};
    console.log('[MACD] klines='+closes.length+' bars='+bars.length+' lastDiff='+(result.diff.length?result.diff[result.diff.length-1].value:'none')+' lastBar='+(bars.length?bars[bars.length-1].value:'none'));
    return result;
  }

  function calcIndicators() {
    var closes = app.state.klines.map(function(k){return k.close;});
    app.maData.ma5=calcMA(closes,5); app.maData.ma10=calcMA(closes,10); app.maData.ma20=calcMA(closes,20);
    app.volumeData = app.state.klines.map(function(k,i){
      var up=i===0||k.close>=app.state.klines[i-1].close;
      return {time:k.date,value:k.volume,color:up?'rgba(239,68,68,0.65)':'rgba(34,197,94,0.65)'};
    });
    app.macdData = calcMACD(closes);
  }

  // ===== 周期切换 =====
  function rebuildForPeriod(newPeriod) {
    app._userZoomed = false; // 切换周期后重新适配全量（避免不同bar数量保留逻辑范围导致错位）
    app.state.period = newPeriod;
    var rawSlice = app.state.rawKlines.slice(0, app.state.rawIndex + 1);
    app.state.klines = aggregateKlines(rawSlice, newPeriod);
    app.state.currentIndex = app.state.klines.length - 1;
    if (newPeriod === 'day') app.state.historyCount = app.state.rawHistoryCount;
    else if (newPeriod === 'week') app.state.historyCount = Math.round(app.state.rawHistoryCount / 5);
    else app.state.historyCount = Math.round(app.state.rawHistoryCount / 21);
    if (app.state.currentIndex < 0) app.state.currentIndex = 0;
    calcIndicators(); renderAllCharts(); updateAccount(); updateProgress();
  }

  // ===== 数据 =====
  function genMockData() {
    var allTypes = ['normal','normal','normal','normal','normal','normal','st','st_star','gem','star','normal','normal'];
    var type;
    for (var tries = 0; tries < 20; tries++) {
      type = allTypes[Math.floor(Math.random() * allTypes.length)];
      if (app.settings.excludeST && type === 'st') continue;
      if (app.settings.excludeSTStar && type === 'st_star') continue;
      break;
    }
    if (!type) type = 'normal';
    var typeNames = { normal:'主板', st:'ST', st_star:'*ST', gem:'创业板', star:'科创板' };
    var hc = 500, tc = app.state.totalTrainingBars || 150;
    var total = hc + tc;
    var klines = [], price = 10 + Math.random() * 90;
    var baseVol = (type === 'st' || type === 'st_star') ? 0.07 : 0.035;
    for (var i = 0; i < total; i++) {
      var vol = price * (0.01 + Math.random() * baseVol);
      var ch = (Math.random() - 0.48) * vol;
      var o = price, c = price + ch, h = Math.max(o, c) + Math.random() * vol * 0.5, l = Math.min(o, c) - Math.random() * vol * 0.5;
      var d = new Date(2025, 0, 2); d.setDate(d.getDate() + i);
      klines.push({ date: d.toISOString().split('T')[0], open: +o.toFixed(2), high: +h.toFixed(2), low: +l.toFixed(2), close: +c.toFixed(2), volume: (5e6 + Math.random() * 45e6) | 0 });
      price = c;
    }
    return { stock: { id: 0, code: '******', name: '???' }, klines: klines, isMock: true, stockType: type, stockTypeName: typeNames[type] || type, historyCount: hc, trainingCount: tc };
  }

  function getData() {
    return new Promise(function(resolve) {
      if (typeof window.api !== 'undefined' && window.api.getNewTraining) {
        window.api.getNewTraining({ excludeST: app.settings.excludeST }).then(function(r) {
          if (r.success) { r.data.trainingCount = app.state.totalTrainingBars; resolve(r.data); }
          else resolve(genMockData());
        }).catch(function() { resolve(genMockData()); });
      } else resolve(genMockData());
    });
  }

  // ===== 图表渲染 =====
  function renderAllCharts() {
    var cd=[], m5=[], m10=[], m20=[], ml=[];
    for (var i=0; i<=app.state.currentIndex; i++) {
      var k=app.state.klines[i];
      cd.push({time:k.date,open:k.open,high:k.high,low:k.low,close:k.close});
      m5.push({time:k.date,value:app.maData.ma5[i]});
      m10.push({time:k.date,value:app.maData.ma10[i]});
      m20.push({time:k.date,value:app.maData.ma20[i]});
    }
    // 程序化数据变更统一加守卫：防止库内部的范围变化被误判为用户缩放或触发外传
    var prevSuppress = app._suppressRangeEvent;
    app._suppressRangeEvent = true;
    stampProgrammaticRange();
    app.series.candlestick.setData(cd);
    app.series.ma5.setData(m5); app.series.ma10.setData(m10); app.series.ma20.setData(m20);
    app.series.volume.setData(app.volumeData.slice(0, app.state.currentIndex+1));

    // 训练起点标记线
    var hc = app.state.historyCount;
    if (hc > 0 && cd.length > hc && hc < cd.length) {
      var startBar = cd[hc];
      // 关键修复：竖线高度只用「训练区」(hc ~ 当前进度) 的价格范围，
      // 不能用全部已揭示数据——否则历史区的早期高价(如45元)会把 autoScale 价格轴撑开，
      // 导致当前 K 线被压成一条平线、且放大无效。
      var lineSlice = app.state.klines.slice(hc, app.state.currentIndex + 1);
      if (lineSlice.length > 0) {
        var priceMin = Math.min.apply(null, lineSlice.map(function(k){return k.low;}));
        var priceMax = Math.max.apply(null, lineSlice.map(function(k){return k.high;}));
        ml.push({ time: startBar.time, value: priceMin }); ml.push({ time: startBar.time, value: priceMax });
        app.series.startLine.setData(ml);
      } else { app.series.startLine.setData([]); }
    } else { app.series.startLine.setData([]); }

    // 持仓成本线
    updateCostLine();

    // 官方 issue #2044 workaround：同帧多 series setData 时，若时间轴时间点集合
    // 发生变化（跨局换股票必然变化），先设置的 line series 内部缓存不会重算，
    // 下一帧渲染抛 "Value is null" → 主图整帧空白（成交量/MACD 独立画布幸免）。
    // 对每条线 series update 末点，强制其按最终时间轴重新映射缓存（幂等、无视觉副作用）。
    try {
      if (m5.length > 0) {
        var lastIdx = m5.length - 1;
        app.series.ma5.update({ time: m5[lastIdx].time, value: m5[lastIdx].value });
        app.series.ma10.update({ time: m10[lastIdx].time, value: m10[lastIdx].value });
        app.series.ma20.update({ time: m20[lastIdx].time, value: m20[lastIdx].value });
      }
      if (ml.length > 0) app.series.startLine.update({ time: ml[ml.length - 1].time, value: ml[ml.length - 1].value });
    } catch (e) { console.warn('[renderAllCharts] #2044 workaround update 失败(不影响渲染)', e); }

    // 双保险：下一帧把主图所有 series 重放一遍 setData。
    // 实测（issue #2044 复现）：同帧连续 setData 后时间轴已稳定，重放可强制所有
    // series 缓存按最终时间轴重算，根治"开新局后主图整帧空白"。崩帧仅 16ms 无感。
    requestAnimationFrame(function() {
      try {
        // 守卫：若 rAF 期间已推进新K线（cd 快照过期），跳过重放避免数据回退
        if (app.state.currentIndex !== cd.length - 1) return;
        app.series.candlestick.setData(cd);
        app.series.ma5.setData(m5); app.series.ma10.setData(m10); app.series.ma20.setData(m20);
        app.series.startLine.setData(ml);
      } catch (e) { console.warn('[renderAllCharts] 重放 setData 失败', e); }
    });

    // MACD（DIFF 白线 / DEA 黄线 / 红绿柱 / 0轴虚线）
    var mi=app.state.klines.length-app.macdData.bars.length;
    var vb=[],vd=[],ve=[],vz=[];
    for(var i=0;i<app.macdData.bars.length;i++) if(mi+i<=app.state.currentIndex) {
      vb.push(app.macdData.bars[i]); vd.push(app.macdData.diff[i]); ve.push(app.macdData.dea[i]);
      vz.push({time:app.macdData.diff[i].time,value:0});
    }
    console.log('[renderMACD] mi='+mi+' currentIndex='+app.state.currentIndex+' vb='+vb.length+' vd='+vd.length);
    if(vd.length>0){
      app.series.diff.setData(vd);app.series.dea.setData(ve);app.series.macdBar.setData(vb);app.series.macdZero.setData(vz);
      try {
        app.charts.macd.priceScale().applyOptions({ autoScale: true });
        app.charts.macd.priceScale().fitContent();
      } catch(e) {}
    }
    else {app.series.diff.setData([]);app.series.dea.setData([]);app.series.macdBar.setData([]);app.series.macdZero.setData([]);}
    app._suppressRangeEvent = prevSuppress;

    updateMarkers();
    if(!app._userZoomed){fitToDefaultView();}
    else { resyncSubCharts(); }  // 用户缩放状态下重绘，按 K 线当前可见范围重新对齐子图

    // 强制 price scale 按当前可见范围适配，避免全部历史数据把 K 线压成平线
    requestAnimationFrame(function(){
      try { app.charts.kline.priceScale().fitContent(); } catch(e){}
      try { app.charts.volume.priceScale().fitContent(); } catch(e){}
      try { app.charts.macd.priceScale().fitContent(); } catch(e){}
    });
  }

  function updateCostLine() {
    if (app.state.position && app.state.klines.length >= 2) {
      var p = app.state.position.avgPrice;
      var first = app.state.klines[0].date, last = app.state.klines[app.state.klines.length-1].date;
      app.series.costLine.setData([{time:first,value:p},{time:last,value:p}]);
    } else { app.series.costLine.setData([]); }
  }

  function updateMarkers() {
    if (app.state.tradeMarkers.length > 0) {
      var visible = app.state.tradeMarkers.filter(function(m) {
        for (var i = 0; i < app.state.klines.length; i++) { if (app.state.klines[i].date === m.time) return true; }
        return false;
      });
      app.series.candlestick.setMarkers(visible.length > 0 ? visible : []);
    } else { app.series.candlestick.setMarkers([]); }
  }

  // ===== 启动训练 =====
  async function startNewTraining() {
    // 每次开训前先从本地库实时读取最新资金，确保跨会话持久化一定生效（不依赖 loadCapital 的调用时机）
    try {
      var capResp = await window.api.getSetting('currentCapital');
      if (capResp && capResp.success && capResp.value) {
        var savedCap = parseFloat(capResp.value);
        if (savedCap > 0) {
          app.state.currentCapital = savedCap;
          console.log('[startNewTraining] 读取到资金 ¥' + savedCap);
        }
      }
    } catch (e) { console.warn('[startNewTraining] 读取资金失败', e); }
    getData().then(function(data) {
      app.state.rawKlines = data.klines;
      app.state.totalTrainingBars = data.trainingCount || 150;
      app.state.period = 'day';
      app.state.trainingStarted = false;
      var hc = data.historyCount || 0;
      app.state.rawHistoryCount = hc;
      app.state.historyCount = hc;
      app.state.rawIndex = hc;
      app.state.klines = aggregateKlines(app.state.rawKlines.slice(0, app.state.rawIndex + 1), 'day');
      app.state.currentIndex = app.state.klines.length - 1;
      app.state.position = null;
      // 新训练从「持久化的最新余额」开始，不重置（仅「重置资金」键会把它设回10万）
      var cap = (app.state.currentCapital > 0) ? app.state.currentCapital : app.state.startCapital;
      app.state.cash = cap; app.state.totalAssets = cap; app.state.startCapital = cap;
      app.state.trades = []; app.state.tradeMarkers = [];
      app.state.isTraining = true; app.state.isFinished = false;
      app.state.stockInfo = data.stock;
      app.state.realStockInfo = { id: data.stock.id, code: data.stock.code, name: data.stock.name };
      app.state.isMock = data.isMock !== false;
      app.state.stockType = data.stockType || 'normal';
      app.state.stockTypeName = data.stockTypeName || '主板';
      app.state.stockInfo.name = '???'; app.state.stockInfo.code = '******';
      app._userZoomed = false; app._snapshot = null;

      calcIndicators(); renderAllCharts();
      updateAccount(); updateProgress(); setButtons(true);

      // 首次渲染后确保默认视图生效，避免容器未布局完成导致 fit 失败
      setTimeout(function() {
        if (app.charts.kline && app.state.currentIndex > 0 && !app._userZoomed) {
          fitToDefaultView();
        }
      }, 120);

      var tc = app.state.totalTrainingBars;
      toast('前半部分为历史走势（可缩放浏览），最后'+app.state.totalTrainingBars+'根为训练区','info');
    });
  }

  // ===== 推进K线 =====
  function advanceRaw() {
    if (app.state.rawIndex >= app.state.rawKlines.length - 1) {
      finishTraining(); return false;
    }
    app.state.rawIndex++;
    var newBar = app.state.rawKlines[app.state.rawIndex];
    var period = app.state.period;

    if (period === 'day') {
      app.state.klines.push({ date:newBar.date, open:newBar.open, high:newBar.high, low:newBar.low, close:newBar.close, volume:newBar.volume });
      app.state.currentIndex = app.state.klines.length - 1;
      var closes = app.state.klines.map(function(k){return k.close;});
      app.maData.ma5.push(avgLastN(closes, 5)); app.maData.ma10.push(avgLastN(closes, 10)); app.maData.ma20.push(avgLastN(closes, 20));
      var up = app.state.currentIndex === 0 || newBar.close >= app.state.klines[app.state.currentIndex - 1].close;
      app.volumeData.push({ time: newBar.date, value: newBar.volume, color: up ? 'rgba(239,68,68,0.65)' : 'rgba(34,197,94,0.65)' });
      recalcMACDIncremental();
      updateChartIncremental();
    } else {
      var keyFn = period === 'week' ? getWeekKey : getMonthKey;
      var lastKline = app.state.klines[app.state.klines.length - 1];
      var lastKey = lastKline ? keyFn(lastKline.date) : '';
      var newKey = keyFn(newBar.date);
      if (newKey === lastKey && app.state.klines.length > 0) {
        lastKline.high = Math.max(lastKline.high, newBar.high); lastKline.low = Math.min(lastKline.low, newBar.low);
        lastKline.close = newBar.close; lastKline.volume += newBar.volume;
      } else {
        app.state.klines.push({ date: newBar.date, open: newBar.open, high: newBar.high, low: newBar.low, close: newBar.close, volume: newBar.volume });
        app.state.currentIndex = app.state.klines.length - 1;
      }
      calcIndicators(); renderAllCharts();
    }
    updateAccount(); updateProgress();
    return true;
  }

  function avgLastN(arr, n) {
    var s = arr.slice(Math.max(0, arr.length - n));
    var sum = 0; for (var j = 0; j < s.length; j++) sum += s[j]; return sum / s.length;
  }
  function recalcMACDIncremental() {
    var closes = app.state.klines.map(function(k){return k.close;});
    var prevLen = app.macdData.diff ? app.macdData.diff.length : 0;
    app.macdData = calcMACD(closes);
    var mi=app.state.klines.length-app.macdData.bars.length, vb=[],vd=[],ve=[],vz=[];
    for(var i=0;i<app.macdData.bars.length;i++) if(mi+i<=app.state.currentIndex) {
      vb.push(app.macdData.bars[i]); vd.push(app.macdData.diff[i]); ve.push(app.macdData.dea[i]);
      vz.push({time:app.macdData.diff[i].time,value:0});
    }
    console.log('[recalcMACD] vb='+vb.length+' vd='+vd.length);
    var prevSuppress = app._suppressRangeEvent;
    app._suppressRangeEvent = true;
    stampProgrammaticRange();
    var newLen = vd.length;
    if (prevLen > 0 && (newLen === prevLen || newLen === prevLen + 1)) {
      // 增量追加：EMA 递推确定性，已有 bar 的值不变，只需补最后一根。
      // 用 update() 代替 setData，避免重置 MACD 时间轴引发视野漂移。
      var last = app.macdData.diff.length - 1;
      app.series.diff.update(app.macdData.diff[last]);
      app.series.dea.update(app.macdData.dea[last]);
      app.series.macdBar.update(app.macdData.bars[last]);
      app.series.macdZero.update({time:app.macdData.diff[last].time, value:0});
    } else {
      app.series.diff.setData(vd);app.series.dea.setData(ve);app.series.macdBar.setData(vb);app.series.macdZero.setData(vz);
    }
    try { app.charts.macd.priceScale().applyOptions({ autoScale: true }); } catch(e) {}
    app._suppressRangeEvent = prevSuppress;
  }
  function updateChartIncremental() {
    var i = app.state.currentIndex, k = app.state.klines[i];
    // 程序化数据变更统一加守卫（update 可能触发时间轴自动右移，属于程序行为而非用户缩放）
    var prevSuppress = app._suppressRangeEvent;
    app._suppressRangeEvent = true;
    stampProgrammaticRange();
    app.series.candlestick.update({time:k.date,open:k.open,high:k.high,low:k.low,close:k.close});
    app.series.ma5.update({time:k.date,value:app.maData.ma5[i]});
    app.series.ma10.update({time:k.date,value:app.maData.ma10[i]});
    app.series.ma20.update({time:k.date,value:app.maData.ma20[i]});
    app.series.volume.update(app.volumeData[i]);
    app._suppressRangeEvent = prevSuppress;
    var hc = app.state.historyCount;
    if (hc > 0 && hc < app.state.klines.length) {
      var startBar = { time: app.state.klines[hc].date };
      // 与 renderAllCharts 一致：只取训练区价格范围（startLine 已是 overlay 轴，不影响价格刻度）
      var lineSlice = app.state.klines.slice(hc, app.state.currentIndex + 1);
      if (lineSlice.length > 0) {
        var pmin = Math.min.apply(null, lineSlice.map(function(k){return k.low;}));
        var pmax = Math.max.apply(null, lineSlice.map(function(k){return k.high;}));
        app.series.startLine.setData([{time:startBar.time,value:pmin},{time:startBar.time,value:pmax}]);
      }
    }
    updateCostLine(); updateMarkers();
    if(!app._userZoomed){fitToDefaultView();}
    else { resyncSubCharts(); }  // 推进一根后，setData 已重置 MACD 时间轴，需重新对齐

    requestAnimationFrame(function(){
      try { app.charts.kline.priceScale().fitContent(); } catch(e){}
      try { app.charts.volume.priceScale().fitContent(); } catch(e){}
      try { app.charts.macd.priceScale().fitContent(); } catch(e){}
    });
  }

  // ===== 进入训练区 =====
  function enterTrainingZone() {
    if (app.state.trainingStarted) return;
    app.state.trainingStarted = true;
    // 滚动到训练起点
    if (app.state.rawIndex < app.state.rawHistoryCount) {
      app.state.rawIndex = app.state.rawHistoryCount;
      app.state.klines = aggregateKlines(app.state.rawKlines.slice(0, app.state.rawIndex + 1), app.state.period);
      app.state.currentIndex = app.state.klines.length - 1;
      calcIndicators(); renderAllCharts();
    }
    updateProgress();
    // 显示撤销按钮
    var undoBtn = document.getElementById('btn-undo');
    if (undoBtn) { undoBtn.style.display = ''; undoBtn.disabled = true; }
    toast('训练区已开启！开始决策', 'info');
  }

  // ===== 交易操作 =====
  function buy() {
    if (!app.state.isTraining || app.state.isFinished) return;
    if (!app.state.trainingStarted) { enterTrainingZone(); return; }
    var k=app.state.klines[app.state.currentIndex], price=k.close;
    var ratio=app.settings.buyRatio||1;
    var shares=Math.floor(app.state.cash*ratio/price/100)*100;
    if(shares<100){toast('资金不足','info');return;}
    saveSnapshot();
    var cost=shares*price;
    if(app.state.position){
      // 加仓：按加权平均成本合并
      var old=app.state.position;
      var newShares=old.shares+shares;
      var newAvg=(old.shares*old.avgPrice+shares*price)/newShares;
      app.state.position={shares:newShares,avgPrice:+newAvg.toFixed(4)};
    } else {
      app.state.position={shares:shares,avgPrice:price};
    }
    app.state.cash=+(app.state.cash-cost).toFixed(2);
    app.state.totalAssets=+(app.state.cash+app.state.position.shares*app.state.position.avgPrice).toFixed(2);
    app.state.trades.push({klineIndex:app.state.rawIndex,action:'buy',price:price,shares:shares,amount:cost,pnl:0});
    app.state.tradeMarkers.push({time:k.date,position:'belowBar',color:'#f04444',shape:'arrowUp',text:'买',size:2});
    updateMarkers(); updateCostLine();
    toast('买入 '+shares+' 股 (仓位'+Math.round(ratio*100)+'%) ¥'+price.toFixed(2),'buy');
    flash('buy'); updateAccount(); saveCurrentCapital(); advanceNext();
  }

  function sell(forceAll) {
    if (!app.state.isTraining || app.state.isFinished) return;
    if (!app.state.trainingStarted) { enterTrainingZone(); return; }
    if(!app.state.position){toast('无持仓','info');return;}
    var k=app.state.klines[app.state.currentIndex],price=k.close,pos=app.state.position;
    var ratio=forceAll?1:(app.settings.sellRatio||1);
    var sellShares = forceAll ? pos.shares : Math.floor(pos.shares*ratio/100)*100;
    if(sellShares<100) sellShares=pos.shares; // 不足100股则清掉剩余
    if(sellShares<=0){toast('持仓不足','info');return;}
    saveSnapshot();
    var rev=sellShares*price, costPortion=sellShares*pos.avgPrice, pnl=+(rev-costPortion).toFixed(2);
    app.state.cash=+(app.state.cash+rev).toFixed(2);
    var remaining=pos.shares-sellShares;
    if(remaining>0){ app.state.position={shares:remaining,avgPrice:pos.avgPrice}; }
    else { app.state.position=null; }
    app.state.totalAssets=app.state.position?+(app.state.cash+app.state.position.shares*app.state.position.avgPrice).toFixed(2):app.state.cash;
    app.state.trades.push({klineIndex:app.state.rawIndex,action:'sell',price:price,shares:sellShares,amount:rev,pnl:pnl});
    app.state.tradeMarkers.push({time:k.date,position:'aboveBar',color:'#21c75d',shape:'arrowDown',text:'卖',size:2});
    updateMarkers();
    if(!app.state.position) app.series.costLine.setData([]);
    var t=pnl>=0?'盈利 +¥'+pnl.toFixed(2):'亏损 -¥'+Math.abs(pnl).toFixed(2);
    toast('卖出 '+sellShares+' 股！'+t,'sell');
    flash('sell'); updateAccount(); saveCurrentCapital(); advanceNext();
  }

  function skip() {
    if (!app.state.isTraining || app.state.isFinished) return;
    if (!app.state.trainingStarted) { enterTrainingZone(); return; }
    toast('观望 — 不操作','skip');
    advanceNext();
  }

  function advanceNext() {
    if (app.state.rawIndex >= app.state.rawKlines.length - 1) { finishTraining(); return; }
    advanceRaw();
    if (app.state.position && app.state.rawIndex >= app.state.rawHistoryCount) checkStops();
  }

  function checkStops() {
    var pos=app.state.position,price=app.state.klines[app.state.currentIndex].close;
    var pct=((price-pos.avgPrice)/pos.avgPrice)*100;
    if(app.settings.stopProfit>0&&pct>=app.settings.stopProfit){toast('止盈！+'+pct.toFixed(1)+'%','sell');sell(true);}
    else if(app.settings.stopLoss>0&&pct<=-app.settings.stopLoss){toast('止损！'+pct.toFixed(1)+'%','sell');sell(true);}
  }

  // ===== 训练结束 =====
  function finishTraining() {
    app.state.isFinished=true; app.state.isTraining=false;
    app._userZoomed = false; // 训练结束揭晓时展示全量图
    // 展示所有剩余K线
    app.state.rawIndex = app.state.rawKlines.length - 1;
    app.state.klines = aggregateKlines(app.state.rawKlines, app.state.period);
    app.state.currentIndex = app.state.klines.length - 1;
    calcIndicators(); renderAllCharts();

    if(app.state.position){
      var lp=app.state.rawKlines[app.state.rawKlines.length-1].close,pos=app.state.position;
      var rev=pos.shares*lp,cost=pos.shares*pos.avgPrice,pnl=+(rev-cost).toFixed(2);
      app.state.cash=+(app.state.cash+rev).toFixed(2);app.state.totalAssets=app.state.cash;
      app.state.trades.push({klineIndex:app.state.rawKlines.length-1,action:'sell',price:lp,shares:pos.shares,amount:rev,pnl:pnl});
      app.state.position=null;
    }
    updateAccount(); updateProgress(); setButtons(false);
    app.state.startCapital = app.state.totalAssets;
    revealStock(); saveRecord(); showReport();
    toast('训练结束！查看复盘报告','info');
  }

  function revealStock() {
    if(app.state.isMock){
      var st=[{code:'600519',name:'贵州茅台',type:'normal'},{code:'000858',name:'五粮液',type:'normal'},{code:'300750',name:'宁德时代',type:'gem'},{code:'601318',name:'中国平安',type:'normal'},{code:'600036',name:'招商银行',type:'normal'},{code:'000333',name:'美的集团',type:'normal'}];
      var matched=st.filter(function(s){return s.type===app.state.stockType;});
      if(matched.length===0)matched=st;
      app.state.stockInfo=matched[Math.floor(Math.random()*matched.length)];
    } else if (app.state.realStockInfo) {
      // 真实数据：训练结束时还原真实名称/代码（修复之前恒显示 ???/****** 的问题）
      app.state.stockInfo = app.state.realStockInfo;
    }
  }

  // ===== 复盘报告 =====
  function showReport() {
    var raw=app.state.rawKlines, tr=app.state.trades, st=app.state.stockInfo;
    var sells=tr.filter(function(t){return t.action==='sell';});
    var buys=tr.filter(function(t){return t.action==='buy';});
    var total=sells.length, wins=sells.filter(function(t){return t.pnl>0;}).length;
    var wr=total>0?((wins/total)*100).toFixed(1):'0.0';
    var ec=app.state.totalAssets, sc=app.state.startCapital, rr=(((ec-sc)/sc)*100).toFixed(2);
    var peak=sc,mdd=0,cap=sc,loses=sells.filter(function(t){return t.pnl<0;});
    var totalProfit=0,totalLoss=0;
    tr.forEach(function(t){if(t.action==='sell'){cap+=t.pnl;if(cap>peak)peak=cap;var dd=((peak-cap)/peak)*100;if(dd>mdd)mdd=dd;if(t.pnl>0)totalProfit+=t.pnl;else totalLoss+=Math.abs(t.pnl);}});
    var cls=parseFloat(rr)>=0?'profit':'loss', sign=parseFloat(rr)>=0?'+':'';

    // 持仓时长统计
    var holdTimes = [];
    for (var i = 0; i < tr.length; i++) {
      if (tr[i].action === 'buy') {
        for (var j = i + 1; j < tr.length; j++) {
          if (tr[j].action === 'sell') { holdTimes.push(tr[j].klineIndex - tr[i].klineIndex); break; }
        }
      }
    }
    var avgHold = holdTimes.length > 0 ? (holdTimes.reduce(function(a,b){return a+b;},0) / holdTimes.length).toFixed(1) : '-';
    var maxHold = holdTimes.length > 0 ? Math.max.apply(null, holdTimes) : '-';
    var minHold = holdTimes.length > 0 ? Math.min.apply(null, holdTimes) : '-';

    document.getElementById('result-content').innerHTML=
      '<div class="result-stock">'+st.name+'（'+st.code+'）</div>'+
      '<div class="result-date">类型：'+app.state.stockTypeName+' | '+raw[0].date+' ~ '+raw[raw.length-1].date+' | 全量历史+训练'+app.state.totalTrainingBars+'根</div>'+
      '<div class="result-stats">'+
        '<div class="stat-item"><span class="stat-label">最终资产</span><span class="stat-value">¥'+ec.toLocaleString('zh-CN',{minimumFractionDigits:2})+'</span></div>'+
        '<div class="stat-item"><span class="stat-label">收益率</span><span class="stat-value '+cls+'">'+sign+rr+'%</span></div>'+
        '<div class="stat-item"><span class="stat-label">交易次数</span><span class="stat-value">'+total+'</span></div>'+
        '<div class="stat-item"><span class="stat-label">胜率</span><span class="stat-value">'+wr+'%</span></div>'+
        '<div class="stat-item"><span class="stat-label">最大回撤</span><span class="stat-value loss">-'+mdd.toFixed(2)+'%</span></div>'+
        '<div class="stat-item"><span class="stat-label">盈/亏</span><span class="stat-value">'+wins+'/'+(total-wins)+'</span></div>'+
        '<div class="stat-item"><span class="stat-label">总盈利</span><span class="stat-value profit">+¥'+totalProfit.toFixed(0)+'</span></div>'+
        '<div class="stat-item"><span class="stat-label">总亏损</span><span class="stat-value loss">-¥'+totalLoss.toFixed(0)+'</span></div>'+
        '<div class="stat-item"><span class="stat-label">平均持仓</span><span class="stat-value">'+(avgHold==='-'?'-':avgHold+'根')+'</span></div>'+
        '<div class="stat-item"><span class="stat-label">最长/最短</span><span class="stat-value">'+(maxHold==='-'?'-':maxHold+'/'+minHold+'根')+'</span></div>'+
      '</div>'+
      '<div id="equity-chart-container"><h4 style="color:#a39397;font-size:12px;margin-bottom:8px;">资产曲线</h4><canvas id="equity-canvas" width="580" height="180"></canvas></div>';
    document.getElementById('result-modal').classList.remove('hidden');

    // 绘制盈亏曲线
    setTimeout(drawEquityCurve, 200);
  }

  function drawEquityCurve() {
    var canvas = document.getElementById('equity-canvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height, pad = 20, pw = W - pad*2, ph = H - pad*2;
    ctx.clearRect(0, 0, W, H);

    // 收集每根K线后的资产变化
    var sc = app.state.startCapital;
    var equity = [sc];
    var tr = app.state.trades;
    var raw = app.state.rawKlines;
    var tradeIdx = 0;
    var cap = sc;
    var equityDates = [raw[0].date];

    for (var i = 0; i < raw.length; i++) {
      while (tradeIdx < tr.length && tr[tradeIdx].klineIndex === i) {
        if (tr[tradeIdx].action === 'sell') cap += tr[tradeIdx].pnl;
        tradeIdx++;
      }
      equity.push(cap);
      equityDates.push(i < raw.length - 1 ? raw[i+1].date : raw[raw.length-1].date);
    }

    var minE = Math.min.apply(null, equity), maxE = Math.max.apply(null, equity);
    var range = maxE - minE || 1;
    var hc = app.state.rawHistoryCount;
    var trainStart = hc / raw.length;  // 比例位置

    // 网格线
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
    for (var g = 0; g <= 5; g++) {
      var gy = pad + ph * g / 5;
      ctx.beginPath(); ctx.moveTo(pad, gy); ctx.lineTo(W - pad, gy); ctx.stroke();
      // Y轴标签
      ctx.fillStyle = '#a39397'; ctx.font = '10px Consolas'; ctx.textAlign = 'right';
      ctx.fillText('¥' + (maxE - range * g / 5).toFixed(0), pad - 4, gy + 4);
    }

    // 训练区起点线
    var tx = pad + pw * trainStart;
    ctx.strokeStyle = 'rgba(240,68,68,0.55)'; ctx.setLineDash([4,4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(tx, pad); ctx.lineTo(tx, H - pad); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#ff7b7b'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('训练开始', tx, pad - 6);

    // 水平基准线（启动资金）
    var yBase = pad + ph * (maxE - sc) / range;
    if (yBase > pad && yBase < H - pad) {
      ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad, yBase); ctx.lineTo(W - pad, yBase); ctx.stroke();
    }

    // 资产曲线
    ctx.strokeStyle = cap >= sc ? '#f04444' : '#21c75d'; ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.beginPath();
    for (var i = 0; i < equity.length; i++) {
      var x = pad + pw * i / (equity.length - 1);
      var y = pad + ph - ph * (equity[i] - minE) / range;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // 填充区域
    ctx.lineTo(W - pad, H - pad); ctx.lineTo(pad, H - pad); ctx.closePath();
    var grad = ctx.createLinearGradient(0, pad, 0, H - pad);
    grad.addColorStop(0, cap >= sc ? 'rgba(240,68,68,0.18)' : 'rgba(33,199,93,0.18)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad; ctx.fill();

    // 最终值
    var fx = pad + pw, fy = pad + ph - ph * (equity[equity.length-1] - minE) / range;
    ctx.fillStyle = cap >= sc ? '#ef4444' : '#22c55e'; ctx.font = 'bold 12px Consolas'; ctx.textAlign = 'left';
    ctx.fillText('¥'+cap.toFixed(0), fx + 4, fy + 4);
  }

  function saveRecord() {
    try{
      var tr=app.state.trades, ec=app.state.totalAssets, sc=app.state.startCapital;
      var sells=tr.filter(function(t){return t.action==='sell';});
      var total=sells.length, wins=sells.filter(function(t){return t.pnl>0;}).length;
      var winRate=total>0?((wins/total)*100):0;
      // 计算最大回撤（与复盘报告口径一致），修复之前写死 0 的问题
      var peak=sc,mdd=0,cap=sc;
      tr.forEach(function(t){if(t.action==='sell'){cap+=t.pnl;if(cap>peak)peak=cap;var dd=((peak-cap)/peak)*100;if(dd>mdd)mdd=dd;}});
      // 先写入当前资金，使其随训练记录的 _saveToDisk 一并落盘（避免依赖 300ms 防抖丢失）
      saveCurrentCapital();
      if(window.api&&window.api.saveTraining)window.api.saveTraining({
        stockId:app.state.stockInfo.id,stockName:app.state.stockInfo.name,stockCode:app.state.stockInfo.code,
        startDate:app.state.rawKlines[0].date,endDate:app.state.rawKlines[app.state.rawKlines.length-1].date,
        startCapital:sc,endCapital:ec,
        totalTrades:total,
        winTrades:wins,winRate:winRate,maxDrawdown:mdd,
        returnRate:((ec-sc)/sc)*100,trades:tr
      });
    }catch(e){}
  }

  function saveCurrentCapital() {
    try {
      app.state.currentCapital = app.state.totalAssets;  // 同步内存，供新训练读取
      if (window.api && window.api.setSetting) {
        window.api.setSetting('currentCapital', String(app.state.totalAssets));
      }
    } catch(e) {}
  }

  function loadCapital() {
    return new Promise(function(resolve) {
      try {
        if (window.api && window.api.getSetting) {
        window.api.getSetting('currentCapital').then(function(r) {
          if (r.success && r.value) {
            var saved = parseFloat(r.value);
            if (saved > 0) {
              app.state.startCapital = saved;
              app.state.cash = saved;
              app.state.totalAssets = saved;
              app.state.currentCapital = saved;  // 内存同步，避免首次即回弹
              console.log('[loadCapital] 读取到已保存资金: ¥' + saved);
            } else {
              console.log('[loadCapital] 读到值但<=0，使用默认 100000');
            }
          } else {
            console.log('[loadCapital] 未找到保存的资金，使用默认 100000 (r=' + JSON.stringify(r) + ')');
          }
          resolve();
        }).catch(function() { resolve(); });
        } else resolve();
      } catch(e) { resolve(); }
    });
  }

  function resetCapital() {
    app.state.startCapital = 100000;
    app.state.cash = 100000;
    app.state.totalAssets = 100000;
    app.state.currentCapital = 100000;  // 仅此处重置余额
    saveCurrentCapital();
    startNewTraining();
    toast('资金已重置为 ¥100,000', 'info');
  }

  // ===== UI =====
  function updateAccount() {
    var pv=0,fp=0,s=0;
    if(app.state.position){var cp=app.state.klines[app.state.currentIndex].close,pos=app.state.position;pv=pos.shares*cp;fp=pv-pos.shares*pos.avgPrice;s=pos.shares;app.state.totalAssets=+(app.state.cash+pv).toFixed(2);}
    document.getElementById('total-assets').textContent=app.state.totalAssets.toLocaleString('zh-CN',{minimumFractionDigits:2});
    document.getElementById('position-value').textContent=pv.toLocaleString('zh-CN',{minimumFractionDigits:2});
    document.getElementById('available-cash').textContent=app.state.cash.toLocaleString('zh-CN',{minimumFractionDigits:2});
    document.getElementById('position-shares').textContent=s>0?s+' 股':'0 股';
    var pe=document.getElementById('floating-pnl');pe.textContent=(fp>=0?'+':'')+fp.toLocaleString('zh-CN',{minimumFractionDigits:2});pe.className='account-value';if(fp>0)pe.classList.add('positive');else if(fp<0)pe.classList.add('negative');
    var totalReturn=((app.state.totalAssets-app.state.startCapital)/app.state.startCapital*100);
    var rrEl=document.getElementById('return-rate');rrEl.textContent=(totalReturn>=0?'+':'')+totalReturn.toFixed(2)+'%';rrEl.className='account-value';if(totalReturn>0)rrEl.classList.add('positive');else if(totalReturn<0)rrEl.classList.add('negative');
    var lrEl=document.getElementById('live-return');
    if(lrEl){lrEl.textContent='收益率 '+(totalReturn>=0?'+':'')+totalReturn.toFixed(2)+'%';if(totalReturn>0)lrEl.style.color='#ef4444';else if(totalReturn<0)lrEl.style.color='#22c55e';else lrEl.style.color='#787b86';}
  }

  function updateProgress() {
    var rawIdx=app.state.rawIndex, hc=app.state.rawHistoryCount, tc=app.state.totalTrainingBars;
    var trained=Math.max(0, rawIdx-hc+1);
    if (!app.state.trainingStarted && rawIdx >= hc) {
      // 停在历史区末尾，还未进入训练
      updateProgressInHistory(hc, tc);
    } else if (!app.state.trainingStarted) {
      updateProgressInHistory(hc, tc);
    } else {
      var pct=Math.min(100,(trained/tc)*100);
      document.getElementById('progress-fill').style.width=pct+'%';
      document.getElementById('progress-fill').style.background='linear-gradient(90deg, #f04444, #ff7a7a)';
      document.getElementById('progress-text').style.color='';
      document.getElementById('progress-text').textContent=trained+' / '+tc;
    }
  }

  function updateProgressInHistory(hc, tc) {
    document.getElementById('progress-fill').style.width='100%';
    document.getElementById('progress-fill').style.background='linear-gradient(90deg, #f04444, #f04444)';
    document.getElementById('progress-text').style.color='#ff7b7b';
    document.getElementById('progress-text').textContent='历史 '+hc+' → 训练 '+tc;
  }

  function setButtons(en) {
    ['btn-buy','btn-sell','btn-skip'].forEach(function(id){document.getElementById(id).disabled=!en;});
    var undoBtn = document.getElementById('btn-undo');
    if (undoBtn) {
      undoBtn.disabled = !en || !app.state.trainingStarted;
      undoBtn.style.display = (en && app.state.trainingStarted && !app.state.isFinished) ? '' : 'none';
    }
    if (!en) {
      ['btn-buy','btn-sell','btn-skip'].forEach(function(id){document.getElementById(id).disabled=true;});
    }
  }

  function toast(msg,type) {
    var t=document.getElementById('toast');t.textContent=msg;t.className='toast '+type;t.classList.remove('hidden');clearTimeout(app._toastTimer);app._toastTimer=setTimeout(function(){t.classList.add('hidden');},1800);
  }
  function flash(type) {
    var a=document.getElementById('chart-kline');a.classList.remove('flash-buy','flash-sell');void a.offsetWidth;a.classList.add(type==='buy'?'flash-buy':'flash-sell');
  }

  // ===== 缩放 =====
  var DEFAULT_VISIBLE_BARS = 120;  // 默认显示最近 N 根，避免全量历史把 K 线压成一条平线

  // ===== 三图时间轴双向同步引擎（K线 / 成交量 / MACD）=====
  // MACD 因 EMA12/26/9 预热，数据起点比 K 线晚 mi 根：macd逻辑索引 = kline逻辑索引 - mi。
  // 任一图被拖动/缩放，都把可见范围换算后同步给另外两图；
  // _suppressRangeEvent 为真 = 程序化变更，不当作用户操作、也不向外传播。
  function macdOffset() {
    var macdLen = (app.macdData && app.macdData.diff) ? app.macdData.diff.length : 0;
    if (macdLen <= 0) return null;
    return app.state.klines.length - macdLen;
  }
  function isMacdChart(c) { return c === app.charts.macd; }
  // 记录"程序化改过范围"的时刻：库会把 setVisibleLogicalRange/fitContent 的结果
  // 在下一帧异步派发事件（回声），不能把这些回声误判成用户缩放。
  function stampProgrammaticRange() { app._progRangeAt = Date.now(); }
  function isProgrammaticEcho() {
    return typeof app._progRangeAt === 'number' && (Date.now() - app._progRangeAt) < 120;
  }
  // 把 source 图的可见逻辑范围换算到 target 图坐标系（跨 MACD 边界时加减偏移）
  function mapLogicalRange(source, target, r) {
    if (!r) return null;
    var from = r.from, to = r.to;
    if (isMacdChart(source) !== isMacdChart(target)) {
      var mi = macdOffset();
      if (mi === null) return null;
      if (isMacdChart(source)) { from += mi; to += mi; } else { from -= mi; to -= mi; }
    }
    if (!(to > from)) to = from + 1;   // 库要求 to >= from，兜底保证至少 1 根宽
    return { from: from, to: to };
  }
  // 把 source 的范围同步给另外两图；带等值检查，目标已一致就跳过（防回环、减少无效重绘）。
  // 注意：这里不做边界钳位——可见范围比 MACD 数据宽时显示留白，才能和 K 线逐柱对齐。
  function propagateRange(source, range) {
    var prev = app._suppressRangeEvent;
    app._suppressRangeEvent = true;
    stampProgrammaticRange();
    ['kline', 'volume', 'macd'].forEach(function(name) {
      var t = app.charts[name];
      if (!t || t === source) return;
      var r = mapLogicalRange(source, t, range);
      if (!r) return;
      try {
        var cur = t.timeScale().getVisibleLogicalRange();
        if (cur && Math.abs(cur.from - r.from) < 1e-4 && Math.abs(cur.to - r.to) < 1e-4) return;
        t.timeScale().setVisibleLogicalRange(r);
      } catch (e) { /* 忽略 */ }
    });
    app._suppressRangeEvent = prev;
  }
  // 任一图范围变化入口（三图都订阅了它）：程序化变更直接忽略；
  // 用户拖动/缩放则标记 _userZoomed 并把范围同步给另外两图。
  function handleRangeChange(source, range) {
    if (app._suppressRangeEvent) return;
    if (!range) {
      // 主图变空（理论不出现）时让子图跟随 fit；空图（如 MACD 预热期）不向外传播
      if (source === app.charts.kline) {
        var prev = app._suppressRangeEvent;
        app._suppressRangeEvent = true;
        stampProgrammaticRange();
        try { app.charts.volume.timeScale().fitContent(); } catch (e) {}
        try { app.charts.macd.timeScale().fitContent(); } catch (e) {}
        app._suppressRangeEvent = prev;
      }
      return;
    }
    if (!isProgrammaticEcho()) app._userZoomed = true;  // 用户在任一图上动了视野
    propagateRange(source, range);
  }

  // 兼容旧入口：把 K 线可见范围同步给成交量图与 MACD 图。
  // kr 为 null：K 线图无数据（理论不出现），子图 fitContent 兜底。
  function syncSubChartsToKline(kr) {
    if (!kr) {
      var prev = app._suppressRangeEvent;
      app._suppressRangeEvent = true;
      stampProgrammaticRange();
      try { app.charts.volume.timeScale().fitContent(); } catch (e) {}
      try { app.charts.macd.timeScale().fitContent(); } catch (e) {}
      app._suppressRangeEvent = prev;
      return;
    }
    propagateRange(app.charts.kline, kr);
  }

  // 从 K 线图当前可见范围重新对齐子图（训练推进时 setData 会重置 MACD 时间轴，需在推进后调用）
  function resyncSubCharts() {
    try {
      syncSubChartsToKline(app.charts.kline.timeScale().getVisibleLogicalRange());
    } catch (e) {}
  }

  // 程序化视图变更统一走守卫，避免被误判为用户缩放
  function fitContentAll(){
    app._suppressRangeEvent = true;
    stampProgrammaticRange();
    app.charts.kline.timeScale().fitContent();
    app.charts.volume.timeScale().fitContent();
    app.charts.macd.timeScale().fitContent();
    app._suppressRangeEvent = false;
  }

  // 默认视图：显示最后 DEFAULT_VISIBLE_BARS 根（训练区为主），同时保证三图时间轴同步
  function fitToDefaultView(){
    app._suppressRangeEvent = true;
    stampProgrammaticRange();
    // 关键：K 线/成交量/MACD 图实际只渲染了 klines[0 .. currentIndex]，
    // 所以「窗口」必须按图表真实显示的根数算，不能用全量 klines.length（否则索引越界被钳到最右端，MACD 焊死不动）。
    var total = app.state.currentIndex + 1;
    if (total <= DEFAULT_VISIBLE_BARS + 10) {
      app.charts.kline.timeScale().fitContent();
      app.charts.volume.timeScale().fitContent();
      app.charts.macd.timeScale().fitContent();
    } else {
      var from = Math.max(0, total - DEFAULT_VISIBLE_BARS);
      var to = total - 1;
      app.charts.kline.timeScale().setVisibleLogicalRange({from: from, to: to});
      // 兜底：用 set 后实际生效的范围同步子图（正常由订阅回调统一处理，这里幂等保证一致）
      syncSubChartsToKline(app.charts.kline.timeScale().getVisibleLogicalRange());
    }
    app._suppressRangeEvent = false;

    // price scale 必须显式 fit，否则 LightweightCharts 会按全部 setData 的数据定范围
    requestAnimationFrame(function(){
      try { app.charts.kline.priceScale().fitContent(); } catch(e){}
      try { app.charts.volume.priceScale().fitContent(); } catch(e){}
      try { app.charts.macd.priceScale().fitContent(); } catch(e){}
    });
  }

  function setRange(f,t){
    var r={from:f,to:t};
    app._suppressRangeEvent = true;
    stampProgrammaticRange();
    app.charts.kline.timeScale().setVisibleLogicalRange(r);
    syncSubChartsToKline(app.charts.kline.timeScale().getVisibleLogicalRange());
    app._suppressRangeEvent = false;
  }
  function zoomIn(){if(!app.series.candlestick)return;app._userZoomed=true;var r=app.charts.kline.timeScale().getVisibleLogicalRange();if(!r)return;var b=r.to-r.from,c=(r.from+r.to)/2,nb=Math.max(20,b*0.5);setRange(c-nb/2,c+nb/2);}
  function zoomOut(){if(!app.series.candlestick)return;app._userZoomed=true;var r=app.charts.kline.timeScale().getVisibleLogicalRange();if(!r){zoomFit();return;}var b=r.to-r.from,c=(r.from+r.to)/2,nb=b*2,mx=app.state.currentIndex+1-1+2;var nf=Math.max(0,c-nb/2),nt=Math.min(mx,c+nb/2);setRange(nf,nt);if(nt-nf>=app.state.currentIndex+1-5)app._userZoomed=false;}
  function zoomFit(){app._userZoomed=false;fitToDefaultView();}
  function zoomReset(){zoomFit();toast('缩放已重置','info');}

  // ===== 弹窗 =====
  function openSettings() {
    document.getElementById('stop-profit').value=app.settings.stopProfit;
    document.getElementById('stop-loss').value=app.settings.stopLoss;
    document.getElementById('filter-exclude-st').checked=app.settings.excludeST;
    document.getElementById('filter-exclude-st-star').checked=app.settings.excludeSTStar;
    document.getElementById('settings-modal').classList.remove('hidden');
  }
  function saveSettings() {
    app.settings.stopProfit=parseFloat(document.getElementById('stop-profit').value)||0;
    app.settings.stopLoss=parseFloat(document.getElementById('stop-loss').value)||0;
    app.settings.excludeST=document.getElementById('filter-exclude-st').checked;
    app.settings.excludeSTStar=document.getElementById('filter-exclude-st-star').checked;
    document.getElementById('settings-modal').classList.add('hidden');
    toast('设置已保存！下次训练生效','info');
  }
  function openHistory() {
    document.getElementById('history-modal').classList.remove('hidden');
    try{if(window.api&&window.api.getTrainingHistory)window.api.getTrainingHistory().then(function(r){
      if(!r.success)throw new Error(r.error);
      var l=r.data,hc=document.getElementById('history-content');
      if(l.length===0){hc.innerHTML='<div class="history-empty">暂无记录</div>';return;}
      hc.innerHTML=l.map(function(it){return'<div class="history-item"><div><div class="history-stock">'+it.stockName+' ('+it.stockCode+')</div><div class="history-date">'+it.createdAt+' · '+it.totalTrades+'笔</div></div><div class="history-pnl" style="color:'+(it.returnRate>=0?'#ef4444':'#22c55e')+'">'+(it.returnRate>=0?'+':'')+it.returnRate.toFixed(2)+'%</div></div>';}).join('');
    }).catch(function(){document.getElementById('history-content').innerHTML='<div class="history-empty">加载失败</div>';});}catch(e){}
  }
  function switchPeriod(period) {
    if(app.state.period===period)return;
    document.querySelectorAll('.period-btn').forEach(function(b){b.classList.remove('period-active');});
    document.getElementById('btn-period-'+period).classList.add('period-active');
    rebuildForPeriod(period);
    var names={day:'日线',week:'周线',month:'月线'};
    toast('已切换到 '+names[period],'info');
  }

  // ===== 事件绑定 =====
  function bindEvents() {
    document.getElementById('btn-buy').addEventListener('click',buy);
    document.getElementById('btn-sell').addEventListener('click',sell);
    document.getElementById('btn-skip').addEventListener('click',skip);
    document.getElementById('btn-undo').addEventListener('click',undoLastAction);
    document.getElementById('btn-new-training').addEventListener('click',function(){startNewTraining();});
    document.getElementById('btn-reset-capital').addEventListener('click',resetCapital);
    var ratioGroup=document.getElementById('ratio-group');
    if(ratioGroup){ratioGroup.querySelectorAll('.ratio-btn').forEach(function(btn){btn.addEventListener('click',function(){var r=parseFloat(btn.getAttribute('data-ratio'));app.settings.buyRatio=r;app.settings.sellRatio=r;ratioGroup.querySelectorAll('.ratio-btn').forEach(function(b){b.classList.remove('ratio-active');});btn.classList.add('ratio-active');});});}
    document.getElementById('btn-settings').addEventListener('click',openSettings);
    document.getElementById('btn-save-settings').addEventListener('click',saveSettings);
    document.getElementById('btn-close-settings').addEventListener('click',function(){document.getElementById('settings-modal').classList.add('hidden');});
    document.getElementById('btn-close-result').addEventListener('click',function(){document.getElementById('result-modal').classList.add('hidden');startNewTraining();});
    document.getElementById('btn-history').addEventListener('click',openHistory);
    document.getElementById('btn-close-history').addEventListener('click',function(){document.getElementById('history-modal').classList.add('hidden');});
    document.getElementById('btn-zoom-in').addEventListener('click',zoomIn);
    document.getElementById('btn-zoom-out').addEventListener('click',zoomOut);
    document.getElementById('btn-zoom-fit').addEventListener('click',zoomFit);
    document.getElementById('btn-zoom-reset').addEventListener('click',zoomReset);
    document.getElementById('btn-period-day').addEventListener('click',function(){switchPeriod('day');});
    document.getElementById('btn-period-week').addEventListener('click',function(){switchPeriod('week');});
    document.getElementById('btn-period-month').addEventListener('click',function(){switchPeriod('month');});
    document.addEventListener('keydown',function(e){
      if(e.target.tagName==='INPUT')return;
      // 弹窗（设置/复盘/历史）打开时拦截快捷键，避免误触发买卖
      if(!document.getElementById('settings-modal').classList.contains('hidden')||
         !document.getElementById('result-modal').classList.contains('hidden')||
         !document.getElementById('history-modal').classList.contains('hidden'))return;
      switch(e.key){case'b':buy();break;case's':sell();break;case' ':e.preventDefault();skip();break;case'u':undoLastAction();break;case'=':case'+':zoomIn();break;case'-':zoomOut();break;case'0':zoomFit();break;case'Escape':zoomReset();break;case'd':switchPeriod('day');break;case'w':switchPeriod('week');break;case'm':switchPeriod('month');break;}
    });
  }

  document.addEventListener('DOMContentLoaded',function(){initCharts();bindEvents();loadCapital().then(function(){startNewTraining();});});

  // 调试句柄：DevTools 里可通过 window.__zyApp 检查内部状态（不影响功能）
  window.__zyApp = app;
})();
