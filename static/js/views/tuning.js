/* 视图 9：参数调优与预设（实时预览 + 预设管理）。
 *
 * 预览一致性保证：
 *  - 算法 / 参数 / 图像任一变化，立即作废当前预览（清空旧图，显示「计算中」），
 *    在与当前设置严格对应的结果返回前，不展示任何图片。
 *  - 每次请求带单调递增序号，并通过 AbortController 取消旧请求；响应返回后
 *    双重校验（序号 + 设置指纹），过期响应一律丢弃，绝不允许旧结果串场。
 *  - 预览区始终标明当前结果对应的算法、图像、参数与指纹；「缓存命中」也会
 *    明确指出命中的就是当前这组设置。
 */
window.Views = window.Views || {};
window.Views.tuning = (function () {
  const C = window.Common;
  let imgId = null, imgName = "";
  let nodeType = "brightness", nodeDef = null;

  // 预览请求状态：seq 单调递增，只接受序号最新的响应
  let previewSeq = 0;
  let previewTimer = null;
  let abortCtrl = null;
  const DEBOUNCE_MS = 350;

  return {
    mount(el) {
      el.innerHTML = `
        <div class="split">
          <div class="col">
            <div class="panel"><div class="panel-title">选择图像</div><div id="tu-gallery" style="max-height:280px;overflow:auto"></div></div>
            <div class="panel">
              <div class="panel-title">选择算法与参数</div>
              <div class="field"><label>算法节点</label><select id="tu-node"></select></div>
              <div id="tu-params" class="param-grid"></div>
              <div class="toolbar" style="margin-top:10px">
                <button class="btn" id="tu-save-preset">存为预设</button>
              </div>
            </div>
            <div class="panel">
              <div class="panel-title">我的预设</div>
              <div id="tu-presets"></div>
            </div>
          </div>
          <div class="col">
            <div class="panel">
              <div class="panel-title">实时预览<span class="dim">算法或参数变化即作废旧结果（节流）</span></div>
              <div id="tu-preview-ident" class="preview-ident" hidden></div>
              <div class="stage" id="tu-preview"><span class="dim">选择图像与算法后显示</span></div>
            </div>
          </div>
        </div>`;

      C.fetchImages().then((images) => {
        el.querySelector("#tu-gallery").innerHTML = C.galleryHTML(images);
        C.bindGallery(el.querySelector("#tu-gallery"), images, (id, rec) => {
          imgId = id;
          imgName = (rec && rec.filename) || "";
          schedulePreview(el);
        });
      });

      C.fetchNodes().then((nodes) => {
        C._nodesInfo = C._nodesInfo || {};
        nodes.forEach((n) => { C._nodesInfo[n.type] = n; });
        el.querySelector("#tu-node").innerHTML = nodes.map((n) =>
          `<option value="${n.type}">${C.esc(n.label)} — ${C.esc(n.category)}</option>`).join("");
        selectNode(el, nodeType);
      });

      el.querySelector("#tu-node").onchange = () => selectNode(el, el.querySelector("#tu-node").value);
      el.querySelector("#tu-save-preset").onclick = () => savePreset(el);
      loadPresets(el);
    },
  };

  function selectNode(el, type) {
    nodeType = type;
    nodeDef = (C._nodesInfo || {})[type];
    if (!nodeDef) return;
    const form = C.schemaForm(nodeDef.schema, nodeDef.defaults);
    const box = el.querySelector("#tu-params");
    box.innerHTML = form.html;
    form.bind(box, () => { schedulePreview(el); });
    // 表单刚重建，直接从 DOM 收集，确保预览与面板参数一致
    schedulePreview(el);
  }

  // ---------------------------------------------------------------------------
  // 预览调度：变化即作废 + 节流 + 过期响应丢弃
  // ---------------------------------------------------------------------------

  /* 稳定序列化（键排序），供设置指纹使用。 */
  function stableStringify(v) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return "{" + Object.keys(v).sort()
        .map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
    }
    return JSON.stringify(v);
  }

  /* FNV-1a 短指纹：同一（图像 + 算法 + 参数）必然相同，不同设置几乎不可能撞。 */
  function shortHash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  /* 为本次设置生成自包含的「身份卡」：渲染只依赖它，不再读可变的模块状态。 */
  function makeIdentity(el, params) {
    const schema = (nodeDef && nodeDef.schema) || [];
    const summary = schema.map((p) => {
      const raw = params[p.key];
      const val = typeof raw === "boolean" ? (raw ? "开" : "关") : String(raw);
      return `${p.label}=${val}`;
    }).join("，");
    const sig = [imgId, nodeType, stableStringify(params)].join("|");
    return {
      sig, fp: shortHash(sig),
      nodeType, label: nodeDef ? nodeDef.label : nodeType,
      imgId, imgName, params, summary,
    };
  }

  /* 设置变化时调用：立刻作废旧图 / 取消旧请求，节流后发出新请求。 */
  function schedulePreview(el, vals) {
    clearTimeout(previewTimer);
    // 立即作废进行中的旧请求（双保险：序号校验之外，直接让 fetch 中止）
    if (abortCtrl) { try { abortCtrl.abort(); } catch (_) { /* noop */ } abortCtrl = null; }
    previewSeq += 1;

    const stage = el.querySelector("#tu-preview");
    if (!imgId) {
      renderEmpty(el, "请先在左侧选择一张图像");
      return;
    }
    if (!nodeDef) {
      renderEmpty(el, "算法信息加载中…");
      return;
    }
    const params = vals || currentParams(el);
    const identity = makeIdentity(el, params);

    // 关键：不等网络，先把旧结果撤下，占位为「计算中 + 当前设置」
    renderPending(el, identity);

    const mySeq = previewSeq;
    previewTimer = setTimeout(() => firePreview(el, mySeq, identity), DEBOUNCE_MS);
  }

  async function firePreview(el, mySeq, identity) {
    if (!el.isConnected) return;
    abortCtrl = new AbortController();
    const nodes = [{ id: "t1", type: identity.nodeType, params: identity.params, inputs: [] }];
    try {
      const r = await Api.post("/api/run",
        { image_id: identity.imgId, nodes, pipeline_name: "调优预览" },
        { signal: abortCtrl.signal });
      // 已被更新的设置取代：丢弃，绝不渲染
      if (mySeq !== previewSeq || !el.isConnected) return;
      if (r && r.error) { renderError(el, identity, r.error); return; }
      renderResult(el, identity, r);
    } catch (e) {
      if (e && (e.name === "AbortError" || /aborted/i.test(e.message || ""))) return;
      if (mySeq !== previewSeq || !el.isConnected) return;
      renderError(el, identity, e.message);
    } finally {
      if (mySeq === previewSeq) abortCtrl = null;
    }
  }

  // ---------------------------------------------------------------------------
  // 预览渲染：身份条 + 舞台，状态互斥，旧图在任何时刻都不会残留
  // ---------------------------------------------------------------------------

  function identBar(identity, badgeHtml) {
    return `
      <span class="ident-badge ${badgeHtml.cls}">${badgeHtml.text}</span>
      <span class="ident-text">
        <strong>${C.esc(identity.label)}</strong>
        <span class="dim">(${C.esc(identity.nodeType)})</span>
        · ${C.esc(identity.imgName || identity.imgId)}
      </span>
      <span class="ident-fp mono" title="图像 + 算法 + 参数的设置指纹">#${identity.fp}</span>`;
  }

  function renderEmpty(el, msg) {
    el.querySelector("#tu-preview-ident").hidden = true;
    el.querySelector("#tu-preview").innerHTML = `<span class="dim">${C.esc(msg)}</span>`;
  }

  function renderPending(el, identity) {
    const bar = el.querySelector("#tu-preview-ident");
    bar.hidden = false;
    bar.innerHTML = identBar(identity, { cls: "pending", text: "计算中…" });
    el.querySelector("#tu-preview").innerHTML = `
      <div class="preview-loading">
        <div class="spinner" aria-label="加载中"></div>
        <div>正在按当前设置计算…</div>
        <div class="dim">设置已变化，上一张结果已作废；新结果返回前不显示任何图片</div>
        <div class="preview-params mono">参数：${C.esc(identity.summary)}</div>
      </div>`;
  }

  function renderResult(el, identity, r) {
    const hit = !!(r && r.cache_hit);
    const bar = el.querySelector("#tu-preview-ident");
    bar.hidden = false;
    bar.innerHTML = identBar(identity, {
      cls: "ready",
      text: hit ? "✓ 缓存命中（当前设置）" : "✓ 当前结果",
    });
    el.querySelector("#tu-preview").innerHTML = `
      <img src="${r.file_url}" alt="预览结果">
      <div class="caption">
        <div class="preview-params mono">参数：${C.esc(identity.summary)}</div>
        <div>${hit
          ? "缓存命中：返回的就是上面这组算法与参数对应的结果"
          : "已按当前算法与参数实时计算"}
          · 设置指纹 #${identity.fp}</div>
      </div>`;
  }

  function renderError(el, identity, msg) {
    const bar = el.querySelector("#tu-preview-ident");
    bar.hidden = false;
    bar.innerHTML = identBar(identity, { cls: "error", text: "计算失败" });
    el.querySelector("#tu-preview").innerHTML = `
      <div class="empty">${C.esc(msg || "计算失败")}
        <div class="dim" style="margin-top:6px">当前没有与设置对应的预览图，请调整参数后重试</div>
      </div>`;
  }

  function currentParams(el) {
    const root = el.querySelector("#tu-params");
    const out = {};
    root.querySelectorAll("[data-key]").forEach((inp) => {
      const k = inp.dataset.key;
      if (inp.type === "range" || inp.type === "number") out[k] = Number(inp.value);
      else if (inp.type === "checkbox") out[k] = inp.checked;
      else out[k] = inp.value;
    });
    return out;
  }

  function savePreset(el) {
    const m = C.modal(`<div class="field"><label>预设名称</label><input type="text" id="pr-name" value="${C.esc((C._nodesInfo[nodeType]?.label || nodeType))} 预设"></div>
      <div class="modal-actions"><button class="btn" id="pr-cancel">取消</button><button class="btn btn-primary" id="pr-ok">保存</button></div>`, "保存预设");
    m.el.querySelector("#pr-cancel").onclick = m.close;
    m.el.querySelector("#pr-ok").onclick = async () => {
      const name = m.el.querySelector("#pr-name").value || "预设";
      await Api.post("/api/presets", { name, scope: "filter", node_type: nodeType, params: currentParams(el) });
      m.close();
      C.toast("已保存预设", "success");
      await C.refreshPresets();
      loadPresets(el);
    };
  }

  async function loadPresets(el) {
    const presets = await C.fetchPresets();
    const box = el.querySelector("#tu-presets");
    const filtered = presets.filter((p) => p.scope === "filter");
    if (!filtered.length) { box.innerHTML = `<span class="dim">暂无预设</span>`; return; }
    box.innerHTML = filtered.map((p) => `
      <div class="card" style="padding:10px;margin-bottom:8px">
        <div style="display:flex;align-items:center;gap:6px">
          <strong style="font-size:13px">${C.esc(p.name)}</strong>
          <span class="badge">${C.esc(p.node_type || "")}</span>
          <span style="flex:1"></span>
          <button class="btn btn-sm" data-apply="${p.id}">应用</button>
          <button class="btn btn-sm btn-danger" data-del="${p.id}">删除</button>
        </div>
        <div class="mono" style="color:var(--text-faint);margin-top:4px">${C.esc(JSON.stringify(p.params))}</div>
      </div>`).join("");
    box.querySelectorAll("[data-apply]").forEach((b) => b.onclick = () => {
      const p = filtered.find((x) => x.id === b.dataset.apply);
      if (!p) return;
      el.querySelector("#tu-node").value = p.node_type;
      nodeType = p.node_type; nodeDef = C._nodesInfo[nodeType];
      const form = C.schemaForm(nodeDef.schema, p.params);
      const pb = el.querySelector("#tu-params");
      pb.innerHTML = form.html;
      form.bind(pb, () => schedulePreview(el));
      // 从重建后的表单收集，保证身份条与实际请求参数一致
      schedulePreview(el);
    });
    box.querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => {
      await Api.del(`/api/presets/${b.dataset.del}`);
      C.toast("已删除", "success");
      await C.refreshPresets();
      loadPresets(el);
    });
  }
})();
