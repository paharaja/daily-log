// Dropbox from the browser: OAuth code flow with PKCE (no app secret), refresh tokens, App-folder files.
// Endpoints: https://docs.dropboxapi.com/dropbox-api/docs/oauth and the HTTP API reference.

const AUTH_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const RPC = 'https://api.dropboxapi.com/2/';
const CONTENT = 'https://content.dropboxapi.com/2/';

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
// Dropbox-API-Arg travels in an HTTP header, so non-ASCII must be escaped.
const headerJson = (o) => JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

export function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

export class DropboxError extends Error {
  constructor(message, { status, conflict = false, auth = false, body } = {}) {
    super(message);
    Object.assign(this, { status, conflict, auth, body });
  }
}

export function dropboxClient({ appKey, store, fetchImpl = (...a) => fetch(...a) }) {
  async function tokens() { return (await store.getMeta('tokens')) || null; }

  async function startLogin() {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
    sessionStorage.setItem('bp.pkce', JSON.stringify({ verifier, state }));
    const q = new URLSearchParams({
      client_id: appKey, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256',
      token_access_type: 'offline', redirect_uri: redirectUri(), state,
    });
    location.assign(`${AUTH_URL}?${q}`);
  }

  // Call on page load. Returns true if a sign-in just completed.
  async function handleRedirect() {
    const p = new URLSearchParams(location.search);
    if (!p.has('code') && !p.has('error')) return false;
    const saved = JSON.parse(sessionStorage.getItem('bp.pkce') || 'null');
    sessionStorage.removeItem('bp.pkce');
    history.replaceState(null, '', redirectUri() + location.hash);
    if (p.has('error')) throw new DropboxError(`Dropbox sign-in was cancelled (${p.get('error')}).`);
    if (!saved || saved.state !== p.get('state')) throw new DropboxError('Sign-in reply did not match this page — please try again.');
    const body = new URLSearchParams({
      code: p.get('code'), grant_type: 'authorization_code', code_verifier: saved.verifier,
      client_id: appKey, redirect_uri: redirectUri(),
    });
    const res = await fetchImpl(TOKEN_URL, { method: 'POST', body });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new DropboxError(`Dropbox sign-in failed: ${j.error_description || j.error || res.status}`, { status: res.status, body: j });
    await saveTokens(j);
    return true;
  }

  async function saveTokens(j, previous = {}) {
    const t = {
      access: j.access_token,
      expiresAt: Date.now() + (Number(j.expires_in) || 14400) * 1000,
      refresh: j.refresh_token || previous.refresh,
      account: j.account_id || previous.account,
    };
    await store.setMeta('tokens', t);
    return t;
  }

  async function accessToken() {
    const t = await tokens();
    if (!t) throw new DropboxError('Not connected to Dropbox.', { auth: true });
    if (Date.now() < t.expiresAt - 60000) return t.access;
    if (!t.refresh) throw new DropboxError('Dropbox sign-in has expired.', { auth: true });
    const res = await fetchImpl(TOKEN_URL, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: appKey }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 400 || res.status === 401) await store.setMeta('tokens', null);
      throw new DropboxError(`Dropbox sign-in needs renewing (${j.error_description || j.error || res.status}).`, { status: res.status, auth: true, body: j });
    }
    return (await saveTokens(j, t)).access;
  }

  async function call(url, init) {
    const res = await fetchImpl(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${await accessToken()}` } });
    if (res.status === 401) { await store.setMeta('tokens', null); throw new DropboxError('Dropbox access was revoked or expired — connect again.', { status: 401, auth: true }); }
    return res;
  }

  async function rpc(endpoint, args) {
    const res = await call(RPC + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new DropboxError(`Dropbox ${endpoint}: ${j.error_summary || res.status}`, { status: res.status, body: j });
    return j;
  }

  async function listFolder() {
    let r = await rpc('files/list_folder', { path: '' });
    const entries = [...r.entries];
    while (r.has_more) { r = await rpc('files/list_folder/continue', { cursor: r.cursor }); entries.push(...r.entries); }
    return entries.filter((e) => e['.tag'] === 'file');
  }

  async function download(path) {
    const res = await call(CONTENT + 'files/download', { method: 'POST', headers: { 'Dropbox-API-Arg': headerJson({ path }) } });
    if (!res.ok) throw new DropboxError(`Dropbox download ${path}: ${res.status}`, { status: res.status });
    const meta = JSON.parse(res.headers.get('Dropbox-API-Result') || '{}');
    return { text: await res.text(), rev: meta.rev || null };
  }

  async function upload(path, text, rev) {
    const arg = { path, mode: rev ? { '.tag': 'update', update: rev } : 'add', autorename: false, mute: true, strict_conflict: true };
    const res = await call(CONTENT + 'files/upload', {
      method: 'POST',
      headers: { 'Dropbox-API-Arg': headerJson(arg), 'Content-Type': 'application/octet-stream' },
      body: new TextEncoder().encode(text),
    });
    const j = await res.json().catch(() => ({}));
    if (res.status === 409) throw new DropboxError(`Dropbox upload conflict on ${path}`, { status: 409, conflict: true, body: j });
    if (!res.ok) throw new DropboxError(`Dropbox upload ${path}: ${j.error_summary || res.status}`, { status: res.status, body: j });
    return j;
  }

  // Diagnostic: force a refresh now (proves secret-free renewal works) and list the app folder.
  async function checkConnection() {
    const t = await tokens();
    if (!t) throw new DropboxError('Not connected to Dropbox.', { auth: true });
    await store.setMeta('tokens', { ...t, expiresAt: 0 });
    await accessToken();
    const files = await listFolder();
    return { refreshed: true, files: files.map((f) => f.name) };
  }

  async function disconnect() {
    try { await rpc('auth/token/revoke', null); } catch { /* already gone */ }
    await store.setMeta('tokens', null);
  }

  return { startLogin, handleRedirect, tokens, accessToken, listFolder, download, upload, disconnect, checkConnection };
}
