/* API 客户端：统一的 fetch 封装。 */
window.Api = (function () {
  async function request(method, url, body, isForm, signal) {
    const opts = { method, headers: {}, signal: signal || null };
    if (isForm) {
      opts.body = body;
    } else if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const resp = await fetch(url, opts);
    const ct = resp.headers.get("content-type") || "";
    const data = ct.includes("application/json") ? await resp.json() : await resp.blob();
    if (!resp.ok) {
      const msg = (data && data.error) ? data.error : ("HTTP " + resp.status);
      throw new Error(msg);
    }
    return data;
  }
  return {
    get: (u, opts) => request("GET", u, undefined, false, opts && opts.signal),
    post: (u, b, opts) => request("POST", u, b, false, opts && opts.signal),
    put: (u, b, opts) => request("PUT", u, b, false, opts && opts.signal),
    patch: (u, b, opts) => request("PATCH", u, b, false, opts && opts.signal),
    del: (u, opts) => request("DELETE", u, undefined, false, opts && opts.signal),
    upload(files) {
      const fd = new FormData();
      for (const f of files) fd.append("files", f);
      return request("POST", "/api/images", fd, true);
    },
  };
})();
