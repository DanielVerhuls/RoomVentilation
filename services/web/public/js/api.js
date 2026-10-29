// Thin client for the layout API (same origin, under /api).

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = data?.detail;
    const message = typeof detail === 'string' ? detail : detail?.message ?? `${res.status} ${res.statusText}`;
    const err = new Error(message);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  return data;
}

const enc = encodeURIComponent;

export const api = {
  health: () => request('GET', '/api/health'),
  validate: (layout) => request('POST', '/api/layouts/validate', layout),
  rasterize: (layout, dx) => request('POST', `/api/rasterize?dx=${dx}`, layout),
  list: () => request('GET', '/api/layouts'),
  get: (name) => request('GET', `/api/layouts/${enc(name)}`),
  put: (name, layout) => request('PUT', `/api/layouts/${enc(name)}`, layout),
  remove: (name) => request('DELETE', `/api/layouts/${enc(name)}`),
};
