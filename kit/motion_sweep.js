/* 单文件 HTML 动效工程 · 参数面板端到端扫描（通用）
   用法: node motion_sweep.js <html路径> --sweep <控件id>=<v1,v2,...>[%] [--sweep ...]

   为什么必须有这一步：**静态读代码看不出滑块失效**。
   实例 BUG-2123：HTML 写 min="0" max="3"（真实档位）而绑定函数按**百分位**映射
   → 滑块值被 clamp，永远取第 0 档 —— 表现是「四个档位量出来的读数一模一样」，
   只有**逐档位跑一遍**才会露馅。
   ⚠️ 滑块 min/max 与映射函数必须同一口径；一旦发现"改档位读数不变"，先怀疑映射不是实现。
   页面需暴露 __ANALYZE()（返回 {stall, vmax,...}）与 __CFG()。                                  */
const puppeteer = require('puppeteer');
const { pathToFileURL } = require('url');
const path = require('path');

const FILE = process.argv[2];
if (!FILE) { console.log('用法: node motion_sweep.js <html路径> --sweep id=v1,v2,...'); process.exit(1); }
const sweeps = [];
for (let i = 3; i < process.argv.length; i++) {
  if (process.argv[i] === '--sweep' && process.argv[i + 1]) {
    const m = /^([^=]+)=(.+)$/.exec(process.argv[i + 1]);
    if (m) sweeps.push({ id: m[1], vals: m[2].split(',').map(Number) });
  }
}
const URL0 = pathToFileURL(path.resolve(FILE)).href;

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new', args: ['--no-sandbox']
  });
  const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(URL0, { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 500));

  const set = (id, v) => p.evaluate((id, v) => {
    const el = document.getElementById(id);
    if (!el) throw new Error('找不到控件 #' + id);
    el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
  }, id, v);
  const read = () => p.evaluate(() => {
    const r = window.__ANALYZE ? window.__ANALYZE() : null;
    return {
      stall: r ? r.stall * 1000 : null, vmax: r ? r.vmax : null,
      cfg: window.__CFG ? window.__CFG() : null
    };
  });
  const sig = r => JSON.stringify([r.stall == null ? null : +r.stall.toFixed(2), r.cfg]);

  console.log('\n【面板扫描 · ' + path.basename(FILE) + '】');

  /* ⚠️ 每条扫描开始前，把【所有被扫控件】恢复到初始值 ——
     否则上一条扫描留下的档位会污染下一条（实测：曲线留在「指数」时，
     幅度怎么调停顿都 255ms，会误报"控件没生效"）。 */
  const init = {};
  for (const s of sweeps) init[s.id] = await p.evaluate(id => (document.getElementById(id) || {}).value, s.id);
  const resetAll = async () => { for (const s of sweeps) await set(s.id, init[s.id]); };

  for (const s of sweeps) {
    await resetAll();
    console.log('  扫描 #' + s.id + '（其余控件已复位）:');
    const seen = [], cfgSigs = [];
    for (const v of s.vals) {
      await set(s.id, v);
      const r = await read();
      seen.push(sig(r)); cfgSigs.push(JSON.stringify(r.cfg));
      console.log('    ' + String(v).padStart(4) + '  →  停顿 ' +
        (r.stall == null ? '?' : r.stall.toFixed(0) + 'ms (' + (r.stall / 1000 * 60).toFixed(1) + '帧)') +
        (r.cfg ? '   ANT_D=' + (r.cfg.ANT_D != null ? r.cfg.ANT_D.toFixed(3) : '-') +
                 '  幅度=' + (r.cfg.ANT != null ? r.cfg.ANT.toFixed(0) : '-') +
                 (r.cfg.fam ? '  族=' + r.cfg.fam : '') : ''));
    }
    const uniqAll = new Set(seen), uniqCfg = new Set(cfgSigs);
    if (s.vals.length < 2) { console.log('    （单个取值，跳过生效性判定）'); continue; }
    if (uniqCfg.size === 1) {
      console.log('    ✗ **连 cfg 都没变** → 该控件确实没生效（查 min/max 与映射单位，见 BUG-2123）');
    } else if (uniqAll.size === 1) {
      /* cfg 变了、但停顿不变 —— ⚠️ 这是【正常结论】不是失败：
         反解 ANT_D 的目的就是让停顿与幅度无关；族的两端加速度为 0 时停顿同样恒定。
         判据口径要匹配被测量：用"读数变不变"代理"控件生不生效"会在这里假警报。 */
      console.log('    ✓ 控件生效（cfg 在变）；停顿对它是**常数** —— 这通常是设计使然，不是缺陷');
    } else {
      console.log('    ✓ 读数随档位变化，控件生效');
    }
  }
  console.log('  JS_ERRORS=' + errs.length);
  errs.forEach(e => console.log('    ' + e));
  await b.close();
})();
