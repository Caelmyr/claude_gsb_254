/* 视图 9：参数调优与预设（实时预览 + 预设管理）。
 *
 * 预览一致性保证（防止旧结果串场）：
 *  - 每次算法/参数/图像变化都会令设置代次 settingsSeq +1，
 *    并立即把右侧旧图作废为「等待/计算中」状态，绝不保留上一张图。
 *  - 新变化会 abort 掉上一个在飞请求；响应回来后必须同时满足
 *    「未被 abort」且「代次仍是最新」才允许上屏，因此快速切换算法/连拖
 *    滑块时，旧响应即使晚到也会被丢弃。
 *  - 结果头部始终写明当前预览对应的算法与完整参数，缓存命中也标注
 *    「与当前设置一致」，避免用户对着过期图调参。
 */
window.Views = window.Views || {};
window.Views.tuning = (function () {
  const C = window.Common;
  let imgId = null, imgName = null, nodeType = "brightness", nodeDef = null;
  let settingsSeq = 0;      // 已提交（去抖后在飞）的最新设置代次
  let inflightController = null;
  let previewTimer = null;

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
              <div class="panel-title">实时预览<span class="dim">参数变化自动运行（节流）· 结果与当前设置严格对应</span></div>
              <div id="tu-preview-meta" class="preview-meta"></div>
              <div class="stage" id="tu-preview"><span class="dim">选择图像与算法后显示</span></div>
            </div>
          </div>
        </div>`;

      C.fetchImages().then((images) => {
        el.querySelector("#tu-gallery").innerHTML = C.galleryHTML(images);
        C.bindGallery(el.querySelector("#tu-gallery"), images, (id, rec) => {
          imgId = id;
          imgName = rec ? rec.filename : "";
          runPreview(el, currentParams(el));
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

  /* 当前设置的快照：算法 + 参数 + 图像，是判断「这张图是否对应当前设置」的唯一依据。 */
  function currentSettings(el, vals) {
    const params = vals || currentParams(el);
    return {
      imgId,
      imgName: imgName || "",
      nodeType,
      nodeLabel: (nodeDef && nodeDef.label) || nodeType,
      params,
    };
  }

  /* 设置指纹：与后端缓存键同口径（算法类型 + 排序后的完整参数 JSON）。 */
  function settingsFingerprint(s) {
    const keys = Object.keys(s.params).sort();
    const pairs = keys.map((k) => `${C.esc(k)}: ${C.esc(String(s.params[k]))}`);
    return pairs.join("，");
  }

  /* 头部状态条：任何状态下都明确「当前设置是什么、预览处于什么状态」。 */
  function renderMeta(el, s, state, extra) {
    const box = el.querySelector("#tu-preview-meta");
    if (!box) return;
    const paramsText = settingsFingerprint(s);
    let badge = "";
    if (state === "pending") {
      badge = `<span class="badge amber">等待计算…</span>`;
    } else if (state === "computing") {
      badge = `<span class="badge amber">计算中…（旧结果已作废）</span>`;
    } else if (state === "ready") {
      badge = extra && extra.cache_hit
        ? `<span class="badge green">缓存命中 · 与当前设置严格一致</span>`
        : `<span class="badge green">已计算 · 与当前设置严格一致</span>`;
    } else if (state === "error") {
      badge = `<span class="badge red">计算失败</span>`;
    }
    box.innerHTML = `
      <div class="preview-meta-row"><span class="preview-meta-k">图像</span>
        <span class="mono">${C.esc(s.imgName || s.imgId || "未选择")}</span></div>
      <div class="preview-meta-row"><span class="preview-meta-k">算法</span>
        <strong>${C.esc(s.nodeLabel)}</strong>
        <span class="badge">${C.esc(s.nodeType)}</span></div>
      <div class="preview-meta-row"><span class="preview-meta-k">参数</span>
        <span class="mono">${paramsText || "（无参数）"}</span></div>
      <div class="preview-meta-row"><span class="preview-meta-k">状态</span>${badge}</div>`;
  }

  function selectNode(el, type) {
    nodeType = type;
    nodeDef = (C._nodesInfo || {})[type];
    if (!nodeDef) return;
    const form = C.schemaForm(nodeDef.schema, nodeDef.defaults);
    const box = el.querySelector("#tu-params");
    box.innerHTML = form.html;
    const vals = form.collect(box);
    form.bind(box, (v) => {
      // 参数一变：立即以新设置作废旧图，再由防抖决定何时真正发请求。
      invalidatePreview(el, v, "pending");
    });
    invalidatePreview(el, vals, "pending");
  }

  /* 设置变化的唯一入口：作废旧图、中止在飞请求、重置去抖计时器。 */
  function invalidatePreview(el, vals, state) {
    const s = currentSettings(el, vals);

    // 中止上一个仍在飞的请求，杜绝「旧响应晚到覆盖新结果」。
    if (inflightController) {
      abortInflight(inflightController);
      inflightController = null;
    }
    clearTimeout(previewTimer);
    previewTimer = null;
    settingsSeq += 1;

    if (!s.imgId) {
      el.querySelector("#tu-preview").innerHTML =
        `<span class="dim">请先在左侧选择一张图像</span>`;
      el.querySelector("#tu-preview-meta").innerHTML = "";
      return;
    }

    // 立即作废旧图：右侧不再显示任何上一次设置的结果。
    const stage = el.querySelector("#tu-preview");
    stage.innerHTML = `<div class="loading">⏳ 设置已变化，正在更新预览…<div class="caption">` +
      `${C.esc(s.nodeLabel)}（${C.esc(settingsFingerprint(s)) || "无参数"}）</div></div>`;
    renderMeta(el, s, state);

    const seq = settingsSeq;
    previewTimer = setTimeout(() => {
      previewTimer = null;
      fetchPreview(el, s, seq);
    }, 350);
  }

  function runPreview(el, vals) {
    invalidatePreview(el, vals, "pending");
  }

  async function fetchPreview(el, s, seq) {
    // 去抖结束、请求真正发出前再次确认代次；若已被更新的设置取代则直接放弃。
    if (seq !== settingsSeq) return;
    const controller = new AbortController();
    inflightController = controller;
    renderMeta(el, s, "computing");

    const nodes = [{ id: "t1", type: s.nodeType, params: s.params, inputs: [] }];
    try {
      const r = await Api.post("/api/run",
        { image_id: s.imgId, nodes, pipeline_name: "调优预览" }, controller.signal);
      // 响应到达时严格校验：只允许「最新一次设置」的结果上屏。
      if (seq !== settingsSeq || controller.signal.aborted) return;
      renderResult(el, s, r);
    } catch (e) {
      if (e && e.name === "AbortError") return;  // 已被新设置取代，什么都不显示
      if (seq !== settingsSeq) return;
      renderError(el, s, e);
    } finally {
      if (inflightController === controller) inflightController = null;
    }
  }

  function renderResult(el, s, r) {
    renderMeta(el, s, "ready", { cache_hit: r.cache_hit });
    el.querySelector("#tu-preview").innerHTML =
      `<img src="${r.file_url}" alt="预览结果">` +
      `<div class="caption">当前预览 = ${C.esc(s.nodeLabel)}｜${C.esc(settingsFingerprint(s))}</div>`;
  }

  function renderError(el, s, e) {
    renderMeta(el, s, "error");
    el.querySelector("#tu-preview").innerHTML =
      `<div class="empty">计算失败：${C.esc(e.message)}</div>`;
  }

  // AbortController.abort 在极旧浏览器上可能缺失，包一层防御。
  function abortInflight(controller) {
    try { controller.abort(); } catch (_) { /* noop */ }
  }

  function currentParams(el) {
    const root = el.querySelector("#tu-params");
    const out = {};
    if (!root) return out;
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
      const vals = form.collect(pb);
      form.bind(pb, () => invalidatePreview(el, currentParams(el), "pending"));
      invalidatePreview(el, vals, "pending");
    });
    box.querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => {
      await Api.del(`/api/presets/${b.dataset.del}`);
      C.toast("已删除", "success");
      await C.refreshPresets();
      loadPresets(el);
    });
  }
})();
