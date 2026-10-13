/* demo · 渲染 —— 配置 + 调 render-core */
const path = require('path');
const { renderProject } = require('../../kit/render-core.js');

renderProject({
  html: path.join(__dirname, "fx_demo.html"),
  out: path.join(__dirname, "demo.mp4"),
  fps: 30, dur: 12, w: 1920, h: 1080,
  // voice: require('path').join(__dirname, 'voice.wav'),   // 配音就绪后解开
}).then((r) => console.log(r)).catch((e) => { console.error(e); process.exit(1); });
