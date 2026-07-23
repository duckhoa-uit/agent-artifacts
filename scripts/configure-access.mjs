#!/usr/bin/env node
import { pathToFileURL } from "node:url";

/**
 * @param {{
 *   accountId: string;
 *   token: string;
 *   artifactsUrl: string;
 *   allowedEmail: string;
 *   serviceTokenClientId?: string;
 *   apply?: boolean;
 *   fetchImpl?: typeof fetch;
 *   log?: (message: string) => void;
 * }} options
 */
export async function configureAccess({
  accountId,
  token,
  artifactsUrl,
  allowedEmail,
  serviceTokenClientId = undefined,
  apply = false,
  fetchImpl = fetch,
  log = console.log,
}) {
  if (!accountId || !token || !artifactsUrl || !allowedEmail) {
    throw new Error("Required: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, ARTIFACTS_URL, ACCESS_ALLOWED_EMAIL");
  }

  const parsedUrl = new URL(artifactsUrl);
  if (parsedUrl.protocol !== "https:") throw new Error("ARTIFACTS_URL must use https");
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  const api = async (method, path, body) => {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await response.json();
    if (!response.ok || payload.success === false) {
      throw new Error(`${method} ${path} failed (${response.status}): ${JSON.stringify(payload.errors || payload)}`);
    }
    return payload.result;
  };

  const host = parsedUrl.host;
  const destinations = [
    { type: "public", uri: `${host}/admin*` },
    { type: "public", uri: `${host}/v1/admin/*` },
  ];
  const [applications, organization, serviceTokens] = await Promise.all([
    api("GET", "/access/apps"),
    api("GET", "/access/organizations"),
    serviceTokenClientId ? api("GET", "/access/service_tokens") : Promise.resolve([]),
  ]);
  if (!organization?.auth_domain) throw new Error("Cloudflare Zero Trust organization did not return auth_domain");
  const serviceToken = serviceTokenClientId
    ? serviceTokens?.find((candidate) => candidate.client_id === serviceTokenClientId)
    : null;
  if (serviceTokenClientId && (!serviceToken?.id || !serviceToken?.name)) {
    throw new Error(`Cloudflare Access service token not found for client ID ${serviceTokenClientId}`);
  }

  let app = applications?.find((candidate) => hasDestinations(candidate, destinations));
  if (!app) {
    const definition = {
      name: "agent-artifacts-admin",
      type: "self_hosted",
      destinations,
      session_duration: "24h",
      auto_redirect_to_identity: true,
      enable_binding_cookie: true,
    };
    if (!apply) {
      log(JSON.stringify({ action: "create", application: definition, policy: { email: allowedEmail } }));
    } else {
      app = await api("POST", "/access/apps", definition);
    }
  }

  if (app) {
    if (!app.id || !app.aud) throw new Error("Cloudflare Access application response is missing id or aud");
    const policies = await api("GET", `/access/apps/${app.id}/policies`);
    const hasAllowPolicy = policies?.some((policy) => policy.decision === "allow" && policy.include?.some((rule) => rule.email?.email === allowedEmail));
    if (!hasAllowPolicy) {
      if (!apply) {
        log(JSON.stringify({ action: "create-policy", application_id: app.id, email: allowedEmail }));
      } else {
        await api("POST", `/access/apps/${app.id}/policies`, {
          name: `Allow ${allowedEmail}`,
          decision: "allow",
          include: [{ email: { email: allowedEmail } }],
        });
      }
    }

    if (serviceToken) {
      const name = "service-agent-artifacts-e2e";
      const definition = {
        name,
        decision: "service_auth",
        include: [{ service_token: { token_id: serviceToken.id } }],
      };
      const managed = policies?.find((policy) => policy.name === name);
      const managedMatches = policyAllowsServiceToken(managed, serviceToken.id);
      const anotherPolicyMatches = policies?.some((policy) => policyAllowsServiceToken(policy, serviceToken.id));

      if (managed && !managedMatches) {
        if (!apply) {
          log(JSON.stringify({ action: "update-service-policy", application_id: app.id, policy_id: managed.id, service_token: serviceToken.name }));
        } else {
          await api("PUT", `/access/apps/${app.id}/policies/${managed.id}`, definition);
        }
      } else if (!managed && !anotherPolicyMatches) {
        if (!apply) {
          log(JSON.stringify({ action: "create-service-policy", application_id: app.id, service_token: serviceToken.name }));
        } else {
          await api("POST", `/access/apps/${app.id}/policies`, definition);
        }
      }
    }
  }

  const result = {
    configured: apply,
    access_team_domain: organization.auth_domain.replace(/^https?:\/\//, ""),
    access_audience: app?.aud ?? null,
    service_auth: serviceToken ? "managed" : "not-requested",
    next: apply
      ? "Set ACCESS_TEAM_DOMAIN and ACCESS_AUDIENCE to the values above, then deploy."
      : "Re-run with --apply to create missing application or policy. No credentials or secrets are printed.",
  };
  log(JSON.stringify(result));
  return result;
}

function hasDestinations(app, expected) {
  const configured = [
    ...(app.destinations ?? []).filter((value) => value.type === "public").map((value) => value.uri),
    ...(app.self_hosted_domains ?? []),
    ...(app.domain ? [app.domain] : []),
  ];
  return expected.every(({ uri }) => configured.includes(uri));
}

function policyAllowsServiceToken(policy, tokenId) {
  return policy?.decision === "service_auth"
    && policy.include?.some((rule) => rule.service_token?.token_id === tokenId);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  configureAccess({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_API_TOKEN,
    artifactsUrl: process.env.ARTIFACTS_URL,
    allowedEmail: process.env.ACCESS_ALLOWED_EMAIL,
    serviceTokenClientId: process.env.ARTIFACTS_E2E_ACCESS_CLIENT_ID,
    apply: process.argv.includes("--apply"),
  }).catch((cause) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  });
}
