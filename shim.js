// 智赢K线训练助手 · 网页版数据层
// 把桌面版的 window.api（Electron 桌面接口）替换为纯浏览器实现：
// 股票数据来自静态 JSON 文件（data/ 目录），训练记录与资金保存在用户自己的浏览器本地存储里，不上传任何服务器。
(function () {
  'use strict';

  var TRAINING_BARS = 150;
  var MIN_HIST = Math.max(30, Math.floor(TRAINING_BARS / 2));
  var LS_CAPITAL = 'zyweb_capital';
  var LS_HISTORY = 'zyweb_history_v1';
  var LS_TRADES = 'zyweb_trades_v1';
  var _manifestPromise = null, _manifest = null, _lastCode = null;

  function loadManifest() {
    if (_manifestPromise) return _manifestPromise;
    _manifestPromise = fetch('data/manifest.json').then(function (r) {
      if (!r.ok) throw new Error('manifest ' + r.status);
      return r.json();
    }).then(function (m) { _manifest = m; return m; });
    return _manifestPromise;
  }

  function loadKlines(code) {
    return fetch('data/klines/' + code + '.json').then(function (r) {
      if (!r.ok) throw new Error('klines ' + r.status);
      return r.json();
    });
  }

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function randomInt(min, max) { return min + Math.floor(Math.random() * (max - min)); }

  // 随机训练：与桌面版 getRandomTrainingData 逻辑一致（洗牌选股 → 随机窗口 → 150根训练K线）
  function getNewTraining(opts) {
    opts = opts || {};
    return loadManifest().then(function (m) {
      var pool = m.filter(function (s) {
        if (s.b < TRAINING_BARS + MIN_HIST) return false;
        if (opts.excludeST && s.st === 1) return false;
        return true;
      });
      if (!pool.length) return { success: false, error: 'empty pool' };
      var shuffled = shuffle(pool.slice());
      if (_lastCode && shuffled.length > 1 && shuffled[0].c === _lastCode) {
        var k = randomInt(1, shuffled.length);
        var t = shuffled[0]; shuffled[0] = shuffled[k]; shuffled[k] = t;
      }
      var tryIdx = 0;
      function attempt() {
        if (tryIdx >= shuffled.length) return Promise.resolve({ success: false, error: 'no usable data' });
        var s = shuffled[tryIdx++];
        return loadKlines(s.c).then(function (arr) {
          if (!arr || arr.length < TRAINING_BARS) return attempt();
          var start;
          if (arr.length - TRAINING_BARS <= MIN_HIST) start = 0;
          else start = randomInt(MIN_HIST, arr.length - TRAINING_BARS + 1);
          _lastCode = s.c;
          return {
            success: true,
            data: {
              stock: { id: s.i, code: s.c, name: s.n },
              klines: arr.slice(0, start + TRAINING_BARS),
              isMock: false,
              historyCount: start,
              trainingCount: TRAINING_BARS
            }
          };
        }).catch(function () { return attempt(); });
      }
      return attempt();
    });
  }

  // ---- localStorage 助手 ----
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 存储满/隐私模式时静默失败 */ } }
  function readJSON(k, fallback) {
    try { var v = lsGet(k); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }

  function getSetting(key) {
    if (key === 'currentCapital') return Promise.resolve({ success: true, value: lsGet(LS_CAPITAL) });
    return Promise.resolve({ success: true, value: null });
  }
  function setSetting(key, value) {
    if (key === 'currentCapital') lsSet(LS_CAPITAL, String(value));
    return Promise.resolve({ success: true });
  }

  // 训练记录：摘要存列表（上限100条），交易明细单独存最近20条（控制本地存储体积）
  function saveTraining(rec) {
    try {
      var trades = Array.isArray(rec.trades) ? rec.trades : [];
      var summary = {};
      for (var k in rec) if (k !== 'trades') summary[k] = rec[k];
      var list = readJSON(LS_HISTORY, []);
      var nextId = list.length ? Math.max.apply(null, list.map(function (x) { return x.id || 0; })) + 1 : 1;
      summary.id = nextId;
      var d = new Date();
      function p(n) { return (n < 10 ? '0' : '') + n; }
      summary.createdAt = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
      list.push(summary);
      if (list.length > 100) list = list.slice(-100);
      lsSet(LS_HISTORY, JSON.stringify(list));

      var tradesMap = readJSON(LS_TRADES, {});
      tradesMap[String(nextId)] = trades;
      var ids = Object.keys(tradesMap);
      if (ids.length > 20) {
        ids.sort(function (a, b) { return (+a) - (+b); });
        for (var i = 0; i < ids.length - 20; i++) delete tradesMap[ids[i]];
      }
      lsSet(LS_TRADES, JSON.stringify(tradesMap));
      return Promise.resolve({ success: true, id: nextId });
    } catch (e) {
      return Promise.resolve({ success: false, error: String(e) });
    }
  }
  function getTrainingHistory() {
    return Promise.resolve({ success: true, data: readJSON(LS_HISTORY, []).slice().reverse() });
  }
  function getTrainingDetail(id) {
    var list = readJSON(LS_HISTORY, []);
    var hit = list.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!hit) return Promise.resolve({ success: false, error: 'not found' });
    var tradesMap = readJSON(LS_TRADES, {});
    hit.trades = tradesMap[String(id)] || [];
    return Promise.resolve({ success: true, data: hit });
  }

  window.api = {
    getNewTraining: getNewTraining,
    saveTraining: saveTraining,
    getTrainingHistory: getTrainingHistory,
    getTrainingDetail: getTrainingDetail,
    getSetting: getSetting,
    setSetting: setSetting
  };

  // 首次访问提示（复用页面自带 toast 样式）
  document.addEventListener('DOMContentLoaded', function () {
    if (lsGet('zyweb_seen')) return;
    lsSet('zyweb_seen', '1');
    setTimeout(function () {
      var t = document.getElementById('toast');
      if (!t) return;
      t.textContent = '网页版提示：进度保存在本机浏览器 · 数据仅供学习，不构成投资建议';
      t.className = 'toast info';
      setTimeout(function () { t.className = 'toast hidden'; }, 4500);
    }, 900);
  });
})();
