#!/usr/bin/env node

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const artifactsUrl = process.env.ARTIFACTS_URL;
const allowedEmail = process.env.ACCESS_ALLOWED_EMAIL;
const apply = process.argv.includes("--apply");

if (!accountId || !token || !artifactsUrl || !allowedEmail) {
  fail("Required: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, ARTIFACTS_URL, ACCESS_ALLOWED_EMAIL");
}

const parsedUrl = new URL(artifactsUrl);
const host = parsedUrl.host;
const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
const applications = await api("GET", "/access/apps");
const definitions = [
  { name: "agent-artifacts-admin-ui", domain: `${host}/admin*` },
  { name: "agent-artifacts-admin-api", domain: `${host}/v1/admin/*` },
];
const audiences = [];

for (const definition of definitions) {
  let app = applications.result?.find((candidate) => candidate.domain === definition.domain);
  if (!app) {
    if (!apply) {
      console.log(JSON.stringify({ action: "create", application: definition, policy: { email: allowedEmail } }));
      continue;
    }
    app = await api("POST", "/access/apps", {
      name: definition.name,
      domain: definition.domain,
      type: "self_hosted",
      session_duration: "24h",
      auto_redirect_to_identity: true,
      enable_binding_cookie: true,
    });
  }
  if (app.aud) audiences.push(app.aud);

  const policies = await api("GET", `/access/apps/${app.id}/policies`);
  const hasAllowPolicy = policies.result?.some((policy) => policy.decision === "allow" && policy.include?.some((rule) => rule.email?.email === allowedEmail));
  if (!hasAllowPolicy) {
    if (!apply) {
      console.log(JSON.stringify({ action: "create-policy", application_id: app.id, email: allowedEmail }));
      continue;
    }
    await api("POST", `/access/apps/${app.id}/policies`, {
      name: `Allow ${allowedEmail}`,
      decision: "allow",
      include: [{ email: { email: allowedEmail } }],
    });
  }
}

if (apply) {
  console.log(JSON.stringify({
    configured: true,
    access_team_domain: `https://${parsedUrl.hostname}`,
    access_aud: audiences.join(","),
    next: "Set ACCESS_TEAM_DOMAIN without https:// and ACCESS_AUD to the comma-separated value above, then deploy.",
  }));
} else {
  console.log(JSON.stringify({
    dry_run: true,
    next: "Re-run with --apply to create missing applications and policies. No credentials or secrets are printed.",
  }));
}

async function api(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json();
  if (!response.ok || payload.success === false) {
    throw new Error(`${method} ${path} failed (${response.status}): ${JSON.stringify(payload.errors || payload)}`);
  }
  return payload;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
