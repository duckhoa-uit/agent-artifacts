const state = { token: sessionStorage.getItem("artifactAdminToken") || "", view: "overview" };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.token) headers.set("authorization", `Bearer ${state.token}`);
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401) {
    $("#healthDot").classList.remove("good");
    $("#sessionLabel").textContent = "Authentication required";
    if (!$("#authDialog").open) $("#authDialog").showModal();
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error?.message || `${response.status} ${response.statusText}`);
  }
  return response.status === 204 ? null : response.json();
}

async function connect() {
  try {
    const session = await api("/v1/admin/session");
    $("#healthDot").classList.add("good");
    $("#sessionLabel").textContent = `${session.actor} · ${session.mode}`;
    await loadView(state.view);
  } catch (error) { toast(error.message, true); }
}

async function loadView(view) {
  state.view = view;
  $$(".view").forEach((item) => item.classList.toggle("active", item.id === `view-${view}`));
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  if (view === "overview") await loadOverview();
  if (view === "keys") await loadKeys();
  if (view === "artifacts") await loadArtifacts();
  if (view === "shares") await loadShares();
  if (view === "audit") await loadAudit();
}

async function loadOverview() {
  const data = await api("/v1/admin/overview");
  const values = [["Active keys", data.active_keys], ["Artifacts", data.active_artifacts], ["Stored", bytes(data.stored_bytes)], ["Public shares", data.active_shares], ["Open uploads", data.active_uploads]];
  $("#metrics").innerHTML = values.map(([label, value]) => `<article class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></article>`).join("");
  $("#recentEvents").innerHTML = data.recent_events.length ? data.recent_events.map((event) => `<div class="event"><span class="event-line"></span><div><strong>${escapeHtml(event.event_type)}</strong><small>${escapeHtml(event.actor_id || event.actor_type || "system")}</small></div><time>${date(event.created_at)}</time></div>`).join("") : empty("No activity recorded yet.");
}

async function loadKeys() {
  const { data } = await api("/v1/admin/api-keys");
  $("#keysTable").innerHTML = data.length ? data.map((key) => `<tr><td><strong>${escapeHtml(key.owner)}</strong><small class="mono">${escapeHtml(key.id)}</small></td><td class="mono">${escapeHtml(key.key_prefix)}</td><td class="scope-list">${escapeHtml(JSON.parse(key.scopes).join(" · "))}</td><td>${date(key.last_used_at)}</td><td><span class="state ${key.revoked_at ? "bad" : ""}">${key.revoked_at ? "Revoked" : "Active"}</span></td><td><div class="actions">${key.revoked_at ? "" : `<button class="button danger" data-revoke-key="${escapeHtml(key.id)}">Revoke</button>`}</div></td></tr>`).join("") : rowEmpty(6, "No API keys.");
}

async function loadArtifacts() {
  const query = encodeURIComponent($("#artifactSearch").value.trim());
  const { data } = await api(`/v1/admin/artifacts?q=${query}`);
  $("#artifactsTable").innerHTML = data.length ? data.map((item) => `<tr><td><strong>${escapeHtml(item.filename)}</strong><small class="mono">${escapeHtml(item.id)}</small><small>${escapeHtml(item.repo || item.content_type)}</small></td><td>${escapeHtml(item.owner)}</td><td class="mono">${bytes(item.size_bytes)}</td><td><span class="state ${item.checksum_status === "verified" ? "" : "bad"}">${escapeHtml(item.checksum_status)}</span></td><td><strong>${escapeHtml(item.retention)}</strong><small>${item.expires_at ? date(item.expires_at) : "No expiry"}</small></td><td><div class="actions"><button class="button subtle" data-open-artifact="${escapeHtml(item.id)}">Open</button><button class="button subtle" data-share-artifact="${escapeHtml(item.id)}">Share</button><button class="button danger" data-delete-artifact="${escapeHtml(item.id)}">Delete</button></div></td></tr>`).join("") : rowEmpty(6, "No matching artifacts.");
}

async function loadShares() {
  const { data } = await api("/v1/admin/shares");
  const now = Date.now() / 1000;
  $("#sharesTable").innerHTML = data.length ? data.map((share) => { const inactive = share.revoked_at || (share.expires_at && share.expires_at <= now); return `<tr><td><strong>${escapeHtml(share.filename)}</strong><small class="mono">${escapeHtml(share.artifact_id)}</small></td><td>${escapeHtml(share.created_by_actor || share.created_by_key_id || "system")}</td><td>${date(share.created_at)}</td><td>${share.expires_at ? date(share.expires_at) : "No expiry"}</td><td><span class="state ${inactive ? "bad" : ""}">${share.revoked_at ? "Revoked" : inactive ? "Expired" : "Active"}</span></td><td><div class="actions">${inactive ? "" : `<button class="button danger" data-revoke-share="${escapeHtml(share.id)}">Revoke</button>`}</div></td></tr>`; }).join("") : rowEmpty(6, "No shares.");
}

async function loadAudit() {
  const { data } = await api("/v1/admin/audit-logs?limit=100");
  $("#auditTable").innerHTML = data.length ? data.map((event) => `<tr><td class="mono">${date(event.created_at)}</td><td><strong>${escapeHtml(event.event_type)}</strong></td><td>${escapeHtml(event.actor_id || event.api_key_id || "system")}<small>${escapeHtml(event.actor_type || "")}</small></td><td class="mono">${escapeHtml(event.artifact_id || "—")}</td><td class="mono">${escapeHtml(event.metadata || "—")}</td></tr>`).join("") : rowEmpty(5, "No audit events.");
}

$("#nav").addEventListener("click", (event) => { const item = event.target.closest("[data-view]"); if (item) loadView(item.dataset.view).catch(handle); });
$$('[data-refresh]').forEach((button) => button.addEventListener("click", () => loadView(state.view).catch(handle)));
$("#cleanupButton").addEventListener("click", async () => { try { const result = await api("/v1/admin/cleanup", { method:"POST" }); toast(`Cleanup complete · ${result.expiredArtifacts} expired · ${result.staleUploads} stale · ${result.reconciledObjects} reconciled`); await loadOverview(); } catch (error) { handle(error); } });
$("#authButton").addEventListener("click", () => $("#authDialog").showModal());
$("#saveToken").addEventListener("click", (event) => { event.preventDefault(); state.token = $("#adminToken").value.trim(); sessionStorage.setItem("artifactAdminToken", state.token); $("#authDialog").close(); connect(); });
$("#newKeyButton").addEventListener("click", () => $("#keyDialog").showModal());
$("#keyDialog [data-close]").addEventListener("click", () => $("#keyDialog").close());
$("#keyForm").addEventListener("submit", async (event) => { event.preventDefault(); const formElement = event.currentTarget; try { const form = new FormData(formElement); const result = await api("/v1/admin/api-keys", { method:"POST", body:JSON.stringify({ owner:form.get("owner"), scopes:form.getAll("scope") }) }); $("#keyDialog").close(); formElement.reset(); $("#secretValue").textContent = result.token; $("#secretDialog").showModal(); await loadKeys(); } catch (error) { handle(error); } });
$("#copySecret").addEventListener("click", async () => { await navigator.clipboard.writeText($("#secretValue").textContent); toast("API key copied."); });
$("#closeSecret").addEventListener("click", () => { $("#secretValue").textContent = ""; $("#secretDialog").close(); });
$("#artifactSearch").addEventListener("input", debounce(() => loadArtifacts().catch(handle), 250));

document.addEventListener("click", async (event) => {
  const revokeKey = event.target.closest("[data-revoke-key]");
  const openArtifact = event.target.closest("[data-open-artifact]");
  const deleteArtifact = event.target.closest("[data-delete-artifact]");
  const shareArtifact = event.target.closest("[data-share-artifact]");
  const revokeShare = event.target.closest("[data-revoke-share]");
  try {
    if (openArtifact) { const response = await fetch(`/v1/admin/artifacts/${encodeURIComponent(openArtifact.dataset.openArtifact)}/content`, { headers:state.token ? { authorization:`Bearer ${state.token}` } : {} }); if (!response.ok) throw new Error(`Open failed: ${response.status}`); const url = URL.createObjectURL(await response.blob()); window.open(url, "_blank", "noopener,noreferrer"); setTimeout(() => URL.revokeObjectURL(url), 60_000); }
    if (revokeKey && confirm("Revoke this API key immediately?")) { await api(`/v1/admin/api-keys/${encodeURIComponent(revokeKey.dataset.revokeKey)}`, { method:"DELETE" }); await loadKeys(); toast("Key revoked."); }
    if (deleteArtifact && confirm("Delete this artifact and revoke every share?")) { await api(`/v1/admin/artifacts/${encodeURIComponent(deleteArtifact.dataset.deleteArtifact)}`, { method:"DELETE" }); await loadArtifacts(); toast("Artifact deleted."); }
    if (shareArtifact) { const result = await api("/v1/admin/shares", { method:"POST", body:JSON.stringify({ artifact_id:shareArtifact.dataset.shareArtifact, retention:"temporary" }) }); await navigator.clipboard.writeText(result.url); toast("Share URL copied."); }
    if (revokeShare && confirm("Revoke this share link?")) { await api(`/v1/admin/shares/${encodeURIComponent(revokeShare.dataset.revokeShare)}`, { method:"DELETE" }); await loadShares(); toast("Share revoked."); }
  } catch (error) { handle(error); }
});

function handle(error) { toast(error.message || String(error), true); }
function toast(message, bad = false) { const node = $("#toast"); node.textContent = message; node.style.background = bad ? "#8f2929" : "#15201b"; node.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove("show"), 3200); }
function date(value) { return value ? new Intl.DateTimeFormat(undefined, { dateStyle:"medium", timeStyle:"short" }).format(new Date(value * 1000)) : "Never"; }
function bytes(value) { if (!value) return "0 B"; const units = ["B","KB","MB","GB","TB"]; const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1); return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[char]); }
function empty(message) { return `<p>${escapeHtml(message)}</p>`; }
function rowEmpty(columns, message) { return `<tr><td colspan="${columns}">${escapeHtml(message)}</td></tr>`; }
function debounce(fn, wait) { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); }; }

connect();
