/* 调优预览竞态测试：桩 DOM + 可控延迟/乱序的假 Api，加载真实 tuning.js。 */
const path = require("path");

const calls = [];
let callSeq = 0;

function makeEl() {
  const children = new Map();
  const el = {
    innerHTML: "",
    value: "brightness",
    _listeners: {},
    querySelector(sel) {
      if (!children.has(sel)) children.set(sel, makeEl());
      return children.get(sel);
    },
    querySelectorAll() { return []; },
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    set onclick(fn) { this._onclick = fn; },
    set onchange(fn) { this._onchange = fn; },
  };
  return el;
}

let lastFormOnChange = null;
let currentVals = {};

global.window = global;
global.Views = {};
global.Common = {
  esc: (s) => String(s == null ? "" : s),
  galleryHTML: () => "",
  bindGallery: (_c, _i, onSelect) => { global._selectImage = onSelect; },
  fetchImages: async () => [{ id: "img1", filename: "photo.png" }],
  fetchNodes: async () => [
    { type: "brightness", label: "亮度", category: "滤镜", schema: [{ key: "amount" }], defaults: { amount: 0 } },
    { type: "contrast", label: "对比度", category: "滤镜", schema: [{ key: "amount" }], defaults: { amount: 0 } },
  ],
  schemaForm: (_schema, values) => {
    currentVals = { ...values };
    return {
      html: "",
      collect: () => ({ ...currentVals }),
      bind: (_root, onChange) => { lastFormOnChange = (vals) => { currentVals = { ...vals }; onChange(currentVals); }; },
    };
  },
  fetchPresets: async () => [],
  refreshPresets: async () => {},
  modal: () => ({ el: makeEl(), close() {} }),
  toast() {},
};
global.Api = {
  async post(_url, body, signal) {
    const id = ++callSeq;
    const nodeType = body.nodes[0].type;
    const params = body.nodes[0].params;
    const d = {};
    d.promise = new Promise((resolve, reject) => {
      d.resolve = () => resolve({ file_url: `/r/${nodeType}-${params.amount}.png`, cache_hit: params.amount === 0 });
      const onAbort = () => {
        const e = new Error("aborted"); e.name = "AbortError"; reject(e);
      };
      if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort);
    });
    calls.push({ id, nodeType, params, signal, ...d });
    return d.promise;
  },
  async del() { return {}; },
};

require(path.join(__dirname, "..", "static", "js", "views", "tuning.js"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log("  ✓", msg); }
  else { failures++; console.error("  ✗", msg); }
}

(async () => {
  const root = makeEl();
  global.Views.tuning.mount(root);
  await sleep(0); await sleep(0);           // 等 fetchImages/fetchNodes 微任务
  global._selectImage("img1", { filename: "photo.png" });
  await sleep(400);                        // 防抖触发首次 brightness 请求
  assert(calls.length === 1 && calls[0].nodeType === "brightness", "首次请求为 brightness");

  // --- 场景 1：brightness 在飞时切到 contrast，且让 brightness 更晚返回 ---
  root.querySelector("#tu-node").value = "contrast";
  root.querySelector("#tu-node")._onclick; // noop
  // 触发 select 的 change 事件
  const sel = root.querySelector("#tu-node");
  // tuning.js 用的是 onchange 属性赋值
  sel._onchange({ target: sel });
  await sleep(400);
  assert(calls.length === 2 && calls[1].nodeType === "contrast", "切换算法后发出 contrast 请求");
  assert(calls[0].signal.aborted === true, "上一个在飞请求已被 abort");
  // 先让 contrast 返回，再让旧的 brightness 返回
  calls[1].resolve();
  await sleep(0);
  let stageHTML = root.querySelector("#tu-preview").innerHTML;
  assert(stageHTML.includes("/r/contrast-0.png"), "展示的是 contrast 结果");
  calls[0].resolve();  // 旧请求晚到（其 promise 已因 abort reject，此 resolve 无效）
  await sleep(0);
  stageHTML = root.querySelector("#tu-preview").innerHTML;
  assert(!stageHTML.includes("brightness") && stageHTML.includes("contrast"),
    "旧 brightness 响应晚到也不会串场");

  // --- 场景 2：连拖滑块，只有最后一组参数生效 ---
  lastFormOnChange({ amount: 10 });
  lastFormOnChange({ amount: 20 });
  lastFormOnChange({ amount: 30 });
  const callsBefore = calls.length;
  await sleep(100);
  assert(calls.length === callsBefore, "防抖窗口内不发请求");
  await sleep(300);
  const last = calls[calls.length - 1];
  assert(last.nodeType === "contrast" && last.params.amount === 30,
    "快速拖动后只请求最后参数 amount=30");
  last.resolve();
  await sleep(0);
  const meta = root.querySelector("#tu-preview-meta").innerHTML;
  assert(meta.includes("amount: 30"), "状态条显示当前参数 amount: 30");
  assert(meta.includes("contrast"), "状态条显示当前算法 contrast");

  // --- 场景 3：变化瞬间旧图立即作废 ---
  lastFormOnChange({ amount: 40 });
  await sleep(0);
  const staleStage = root.querySelector("#tu-preview").innerHTML;
  assert(staleStage.includes("设置已变化") && !staleStage.includes("<img"),
    "参数一变旧图立即被作废，无残留 <img>");
  const staleMeta = root.querySelector("#tu-preview-meta").innerHTML;
  assert(staleMeta.includes("等待计算") && staleMeta.includes("amount: 40"),
    "作废瞬间状态条即指向新参数 amount: 40");
  await sleep(400);
  calls[calls.length - 1].resolve();
  await sleep(0);
  const readyMeta = root.querySelector("#tu-preview-meta").innerHTML;
  assert(readyMeta.includes("已计算") && readyMeta.includes("与当前设置严格一致"),
    "完成后标注结果与当前设置一致");

  // --- 场景 4：默认参数命中缓存时文案明确 ---
  lastFormOnChange({ amount: 0 });
  await sleep(400);
  calls[calls.length - 1].resolve();
  await sleep(0);
  assert(root.querySelector("#tu-preview-meta").innerHTML.includes("缓存命中 · 与当前设置严格一致"),
    "缓存命中时明确标注命中的是当前设置");

  console.log(failures ? `\n${failures} 个断言失败` : "\n全部通过");
  process.exit(failures ? 1 : 0);
})();
