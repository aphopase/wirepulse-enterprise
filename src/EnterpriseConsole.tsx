import { useCallback, useEffect, useRef, useState } from "react";
import {
  EnterpriseApiError, cancelTestJob, createApiKey, createScimToken, createWebhook, deleteWebhook, deleteWorkspace, fetchAuditExport, fetchJobJunit, getWorkspacePlan, hasRole, inviteMember, listApiKeys, listAuditEvents, listGateways, listInvitations, listMembers, listProvisionedUsers, listScimTokens,
  listTestJobs, listWebhookDeliveries, listWebhooks, pingWebhook, redeliverWebhook, registerGateway, removeMember, revokeApiKey, revokeGateway, revokeInvitation, revokeScimToken, rotateGateway, rotateWebhookSecret,
  scimBaseUrl, setGatewayLabels, setMemberRole, streamTestJobs, updateWebhook, verifyAudit,
  type AuditVerification, type EnterpriseApiKey, type EnterpriseAuditEvent, type EnterpriseGateway, type EnterpriseInvitation, type EnterpriseMember, type EnterprisePlan, type EnterpriseProvisionedUser, type EnterpriseScimToken, type ProvisionedState, type EnterpriseTestJob, type EnterpriseWebhook, type EnterpriseWebhookDelivery,
  type EnterpriseWorkspace, type PlanLimits, type Role, type StreamState, type WorkspaceUsage
} from "./enterprise";

type Tab = "jobs" | "gateways" | "team" | "keys" | "provisioning" | "webhooks" | "audit" | "usage";
type Secret = { title: string; hint: string; value: string };

const ROLES: Role[] = ["viewer", "engineer", "maintainer", "administrator"];
const ACTIVE = ["queued", "assigned", "running"];
const ERROR_TEXT: Record<string, string> = {
  gateway_lease_expired: "The gateway stopped responding while running this job.",
  queue_ttl_expired: "No gateway picked the job up in time."
};
const STREAM_TEXT: Record<StreamState, string> = { connecting: "Connecting…", live: "Live", reconnecting: "Reconnecting — refreshing every 10 s", denied: "Live updates refused for this credential — refreshing every 10 s" };

const RESOURCE_TEXT: Record<string, string> = { members: "members", gateways: "gateways", api_keys: "API keys", scim_tokens: "provisioning tokens", webhooks: "webhooks", jobs_per_month: "jobs per month", reports_per_month: "reports per month" };
const CODE_TEXT: Record<string, string> = {
  webhooks_not_configured: "Webhooks are not enabled on this server (the operator has not set a signing key).",
  confirmation_mismatch: "The name you typed does not match the workspace name.",
  delivery_not_failed: "Only failed deliveries can be redelivered."
};
const detailsOf = (error: EnterpriseApiError): Record<string, unknown> => error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : {};
const describe = (error: unknown) => {
  if (!(error instanceof EnterpriseApiError)) return "network error";
  const details = detailsOf(error);
  if (error.message === "plan_limit_reached") return `the ${String(details.plan)} plan limit for ${RESOURCE_TEXT[String(details.resource)] ?? String(details.resource)} (${String(details.limit)}) is reached; free one up or ask your provider for a larger plan`;
  if (typeof details.reason === "string") return `${error.message} (${details.reason})`;
  return CODE_TEXT[error.message] ?? error.message;
};

const USAGE_ROWS: Array<{ label: string; used: (usage: WorkspaceUsage) => number; limit: keyof PlanLimits; note?: string }> = [
  { label: "Members", used: (usage) => usage.members + usage.pendingInvitations, limit: "members", note: "including pending invitations" },
  { label: "Gateways", used: (usage) => usage.gateways, limit: "gateways" },
  { label: "API keys", used: (usage) => usage.apiKeys, limit: "apiKeys" },
  { label: "Provisioning tokens", used: (usage) => usage.scimTokens, limit: "scimTokens" },
  { label: "Webhooks", used: (usage) => usage.webhooks, limit: "webhooks" },
  { label: "Queued jobs", used: (usage) => usage.queuedJobs, limit: "queuedJobs" },
  { label: "Jobs this month", used: (usage) => usage.jobsThisMonth, limit: "jobsPerMonth" },
  { label: "Reports this month", used: (usage) => usage.reportsThisMonth, limit: "reportsPerMonth" }
];
const PROVISIONED_BADGE: Record<ProvisionedState, string> = { active: "passed", pending: "running", deactivated: "stopped" };
const PROVISIONED_NOTE: Record<ProvisionedState, string> = { active: "has signed in", pending: "not signed in yet", deactivated: "access removed" };
const DELIVERY_BADGE: Record<EnterpriseWebhookDelivery["status"], string> = { delivered: "passed", failed: "failed", pending: "running" };
const ago = (iso: string | null | undefined) => {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 129_600) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
};
// What an administrator needs to know about a provisioning token before it silently stops working: after it expires, the identity
// provider's requests are refused and leavers are no longer deprovisioned.
const TOKEN_WARN_DAYS = 14;
function tokenHealth(token: EnterpriseScimToken): { state: "revoked" | "expired" | "expiring" | "ok"; days: number } {
  const days = Math.ceil((new Date(token.expiresAt).getTime() - Date.now()) / 86_400_000);
  if (token.revokedAt) return { state: "revoked", days };
  if (days <= 0) return { state: "expired", days };
  return { state: days <= TOKEN_WARN_DAYS ? "expiring" : "ok", days };
}
// The audit filter is entered as whole UTC days; the server wants an inclusive start and an exclusive end.
type AuditFilter = { action: string; from: string; to: string };
const auditQuery = (filter: AuditFilter) => ({
  action: filter.action.trim(),
  from: filter.from ? `${filter.from}T00:00:00.000Z` : "",
  to: filter.to ? new Date(Date.parse(`${filter.to}T00:00:00.000Z`) + 86_400_000).toISOString() : ""
});
const MAX_VERIFY_CALLS = 50;
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const day = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleDateString() : "never";
const formatLabels = (labels: Record<string, string>) => Object.entries(labels).map(([key, value]) => `${key}=${value}`).join(", ");
function parseLabels(text: string): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const part of text.split(",").map((item) => item.trim()).filter(Boolean)) {
    const at = part.indexOf("=");
    if (at < 1) throw new Error(`“${part}” is not key=value`);
    labels[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return labels;
}
const newestFirst = (a: EnterpriseTestJob, b: EnterpriseTestJob) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
// A stream event or a slower list response may arrive out of order; never replace a job with an older version of itself.
const newer = (incoming: EnterpriseTestJob, existing?: EnterpriseTestJob) => !existing || incoming.version === undefined || existing.version === undefined || incoming.version >= existing.version;

export function EnterpriseConsole({ apiUrl, token, workspace, onWorkspaceDeleted }: { apiUrl: string; token: string; workspace: EnterpriseWorkspace; onWorkspaceDeleted?: (workspaceId: string) => void }) {
  const workspaceId = workspace.id;
  const can = (need: Role) => hasRole(workspace.role, need);
  const [tab, setTab] = useState<Tab>("jobs");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<Secret | null>(null);

  const [jobs, setJobs] = useState<EnterpriseTestJob[]>([]);
  const [streamState, setStreamState] = useState<StreamState>("connecting");
  const [jobsError, setJobsError] = useState("");
  const [openJob, setOpenJob] = useState("");
  const [gateways, setGateways] = useState<EnterpriseGateway[]>([]);
  const [gatewayForm, setGatewayForm] = useState({ name: "", labels: "", days: "" });
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [members, setMembers] = useState<EnterpriseMember[]>([]);
  const [invitations, setInvitations] = useState<EnterpriseInvitation[]>([]);
  const [inviteForm, setInviteForm] = useState<{ email: string; role: Role }>({ email: "", role: "engineer" });
  const [keys, setKeys] = useState<EnterpriseApiKey[]>([]);
  const [keyForm, setKeyForm] = useState<{ name: string; role: EnterpriseApiKey["role"]; days: string }>({ name: "", role: "engineer", days: "90" });
  const [plan, setPlan] = useState<EnterprisePlan | null>(null);
  const [deleteName, setDeleteName] = useState("");
  const [scimTokens, setScimTokens] = useState<EnterpriseScimToken[]>([]);
  const [provisioned, setProvisioned] = useState<EnterpriseProvisionedUser[]>([]);
  const [scimForm, setScimForm] = useState({ name: "", days: "365" });
  const [auditDraft, setAuditDraft] = useState<AuditFilter>({ action: "", from: "", to: "" });
  const [audit, setAudit] = useState<{ events: EnterpriseAuditEvent[]; next: string | null; filter: AuditFilter } | null>(null);
  const [auditOpen, setAuditOpen] = useState("");
  const [verification, setVerification] = useState<(AuditVerification & { at: string }) | null>(null);
  const [webhooks, setWebhooks] = useState<EnterpriseWebhook[]>([]);
  const [webhooksOff, setWebhooksOff] = useState(false);
  const [hookForm, setHookForm] = useState({ name: "", url: "" });
  const [hookEdit, setHookEdit] = useState<{ id: string; name: string; url: string } | null>(null);
  const [deliveryView, setDeliveryView] = useState<{ hookId: string; list: EnterpriseWebhookDelivery[] } | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(true);
    try { await action(); } catch (error) { if (mounted.current) setNotice(`${label} failed: ${error instanceof Error && !(error instanceof EnterpriseApiError) ? error.message : describe(error)}`); }
    finally { if (mounted.current) setBusy(false); }
  };

  const refreshJobs = useCallback(async () => {
    try {
      const fetched = await listTestJobs(apiUrl, token, workspaceId);
      if (!mounted.current) return;
      setJobsError("");
      setJobs((current) => {
        const byId = new Map(current.map((job) => [job.id, job]));
        for (const job of fetched) if (newer(job, byId.get(job.id))) byId.set(job.id, job);
        return [...byId.values()].sort(newestFirst).slice(0, 100);
      });
    } catch (error) { if (mounted.current) setJobsError(`Could not load jobs: ${describe(error)}`); }
  }, [apiUrl, token, workspaceId]);
  const refreshGateways = useCallback(async () => {
    try { const list = await listGateways(apiUrl, token, workspaceId); if (mounted.current) setGateways(list); } catch (error) { if (mounted.current) setNotice(`Could not load gateways: ${describe(error)}`); }
  }, [apiUrl, token, workspaceId]);
  const refreshTeam = useCallback(async () => {
    try {
      const [memberList, invitationList] = await Promise.all([listMembers(apiUrl, token, workspaceId), hasRole(workspace.role, "administrator") ? listInvitations(apiUrl, token, workspaceId) : Promise.resolve([])]);
      if (mounted.current) { setMembers(memberList); setInvitations(invitationList); }
    } catch (error) { if (mounted.current) setNotice(`Could not load the team: ${describe(error)}`); }
  }, [apiUrl, token, workspaceId, workspace.role]);
  const refreshKeys = useCallback(async () => {
    try { const list = await listApiKeys(apiUrl, token, workspaceId); if (mounted.current) setKeys(list); } catch (error) { if (mounted.current) setNotice(`Could not load API keys: ${describe(error)}`); }
  }, [apiUrl, token, workspaceId]);
  const refreshProvisioning = useCallback(async () => {
    try {
      const [tokenList, userList] = await Promise.all([listScimTokens(apiUrl, token, workspaceId), listProvisionedUsers(apiUrl, token, workspaceId)]);
      if (mounted.current) { setScimTokens(tokenList); setProvisioned(userList); }
    } catch (error) { if (mounted.current) setNotice(`Could not load provisioning: ${describe(error)}`); }
  }, [apiUrl, token, workspaceId]);
  // Reads the first page for `filter`, or with a cursor the page after the ones already listed.
  const loadAudit = useCallback(async (filter: AuditFilter, cursor?: string, previous: EnterpriseAuditEvent[] = []) => {
    try {
      const page = await listAuditEvents(apiUrl, token, workspaceId, { ...auditQuery(filter), ...(cursor ? { cursor } : {}) });
      if (mounted.current) { setAudit({ events: [...previous, ...page.events], next: page.next, filter }); setAuditOpen(""); }
    } catch (error) { if (mounted.current) setNotice(`Could not load the audit trail: ${describe(error)}`); }
  }, [apiUrl, token, workspaceId]);
  const refreshPlan = useCallback(async () => {
    try { const fetched = await getWorkspacePlan(apiUrl, token, workspaceId); if (mounted.current) setPlan(fetched); } catch (error) { if (mounted.current) setNotice(`Could not load usage: ${describe(error)}`); }
  }, [apiUrl, token, workspaceId]);
  const refreshWebhooks = useCallback(async () => {
    try { const list = await listWebhooks(apiUrl, token, workspaceId); if (mounted.current) { setWebhooksOff(false); setWebhooks(list); } }
    catch (error) { if (!mounted.current) return; if (error instanceof EnterpriseApiError && error.status === 501) setWebhooksOff(true); else setNotice(`Could not load webhooks: ${describe(error)}`); }
  }, [apiUrl, token, workspaceId]);
  const showDeliveries = useCallback(async (hookId: string) => {
    try { const list = await listWebhookDeliveries(apiUrl, token, workspaceId, hookId); if (mounted.current) setDeliveryView({ hookId, list }); } catch (error) { if (mounted.current) setNotice(`Could not load deliveries: ${describe(error)}`); }
  }, [apiUrl, token, workspaceId]);

  // One stream per console. The server caps streams per user, so it is closed on unmount and whenever the credential or workspace changes.
  useEffect(() => {
    void refreshJobs(); void refreshGateways();
    return streamTestJobs(apiUrl, token, workspaceId, {
      onJob: (job) => { if (mounted.current) setJobs((current) => newer(job, current.find((item) => item.id === job.id)) ? [job, ...current.filter((item) => item.id !== job.id)].sort(newestFirst).slice(0, 100) : current); },
      onResync: () => { void refreshJobs(); },
      onState: (state) => { if (mounted.current) setStreamState(state); }
    });
  }, [apiUrl, token, workspaceId, refreshJobs, refreshGateways]);
  useEffect(() => {
    if (streamState === "live") return undefined;
    const timer = setInterval(() => { void refreshJobs(); }, 10_000);
    return () => clearInterval(timer);
  }, [streamState, refreshJobs]);
  useEffect(() => {
    if (tab === "gateways") { void refreshGateways(); const timer = setInterval(() => { void refreshGateways(); }, 15_000); return () => clearInterval(timer); }
    if (tab === "team" && can("maintainer")) void refreshTeam();
    if (tab === "keys" && can("administrator")) void refreshKeys();
    if (tab === "provisioning" && can("administrator")) void refreshProvisioning();
    if (tab === "audit" && can("administrator")) void loadAudit(auditDraft);
    if (tab === "usage") void refreshPlan();
    if (tab === "webhooks" && can("administrator")) void refreshWebhooks();
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, refreshGateways, refreshTeam, refreshKeys, refreshProvisioning, refreshPlan, refreshWebhooks, loadAudit]);

  const gatewayName = (id: string | null) => id ? gateways.find((gateway) => gateway.id === id)?.name ?? id.slice(0, 8) : "";
  const tabs: Array<[Tab, string, boolean]> = [["jobs", "Jobs", true], ["gateways", "Gateways", true], ["team", "Team", can("maintainer")], ["keys", "API keys", can("administrator")], ["provisioning", "Provisioning", can("administrator")], ["webhooks", "Webhooks", can("administrator")], ["audit", "Audit", can("administrator")], ["usage", "Usage", true]];

  async function downloadJunit(job: EnterpriseTestJob) {
    await run("JUnit download", async () => {
      saveBlob(await fetchJobJunit(apiUrl, token, workspaceId, job.id), `wirepulse-${job.id.slice(0, 8)}.xml`);
    });
  }

  return <section className="test-panel ec" aria-label="Enterprise console">
    <div className="section-title"><div><h2>Enterprise console · {workspace.name}</h2><p>Signed in with the {workspace.role} role. The server enforces roles; controls you cannot use are hidden.</p></div></div>
    <div className="ec-tabs" role="tablist">{tabs.filter(([, , visible]) => visible).map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>)}</div>
    {secret && <div className="ec-secret" role="alert"><b>{secret.title}</b><p>{secret.hint}</p><code data-testid="one-time-secret">{secret.value}</code><div className="ec-actions"><button onClick={() => void navigator.clipboard?.writeText(secret.value)}>Copy</button><button onClick={() => setSecret(null)}>I have saved it — hide</button></div></div>}

    {tab === "jobs" && <div>
      <div className="ec-row"><p className="ec-state" data-state={streamState}><span className="ec-dot" aria-hidden="true" />{STREAM_TEXT[streamState]}</p><button onClick={() => void refreshJobs()}>Refresh</button></div>
      {jobsError && <p className="ec-error" role="alert">{jobsError}</p>}
      {jobs.length === 0 ? <p className="ec-empty">No gateway jobs yet. Use “Queue gateway job” in the Enterprise workspace panel.</p> : <ul className="ec-list">{jobs.map((job) => <li className="ec-job" key={job.id}>
        <div className="ec-row"><span className={`ec-badge ${job.status}`}>{job.status.replace("_", " ")}</span><code>{job.id.slice(0, 8)}</code>{job.gatewayId && <span>on {gatewayName(job.gatewayId)}</span>}<small>attempt {job.attempts}{job.maxAttempts ? `/${job.maxAttempts}` : ""} · {ago(job.createdAt)}</small></div>
        {job.status === "queued" && <small>Waiting for a gateway to claim it</small>}
        {(job.status === "assigned" || job.status === "running") && (job.progress ? <label className="ec-progress">{job.progress.completed} of {job.progress.total} tests<progress value={job.progress.completed} max={Math.max(1, job.progress.total)} /></label> : <label className="ec-progress">Starting<progress /></label>)}
        {job.summary && <span className="ec-summary">{job.summary.passed} passed · {job.summary.failed} failed · {job.summary.total} total</span>}
        {job.error && <span className="ec-error">{ERROR_TEXT[job.error] ?? job.error} <small>({job.error})</small></span>}
        <div className="ec-actions">
          {ACTIVE.includes(job.status) && can("engineer") && <button disabled={busy} onClick={() => void run("Cancel", async () => { const cancelled = await cancelTestJob(apiUrl, token, workspaceId, job.id); setJobs((current) => current.map((item) => item.id === cancelled.id && newer(cancelled, item) ? cancelled : item)); setNotice("Job cancelled."); })}>Cancel</button>}
          {job.summary && <button disabled={busy} onClick={() => void downloadJunit(job)}>JUnit XML</button>}
          <button aria-expanded={openJob === job.id} onClick={() => setOpenJob(openJob === job.id ? "" : job.id)}>{openJob === job.id ? "Hide details" : "Details"}</button>
        </div>
        {openJob === job.id && <dl className="ec-details">
          <dt>Requested by</dt><dd>{job.requestedBy ?? "—"}</dd>
          <dt>Started / finished</dt><dd>{job.startedAt ? new Date(job.startedAt).toLocaleString() : "—"} / {job.finishedAt ? new Date(job.finishedAt).toLocaleString() : "—"}</dd>
          <dt>Gateway agent</dt><dd>{job.agentVersion ?? "—"}</dd>
          <dt>Engine fingerprint</dt><dd><code>{job.engineFingerprint ?? "—"}</code></dd>
          <dt>Definition hash</dt><dd><code>{job.definitionHash ?? "—"}</code></dd>
          <dt>Evidence final hash</dt><dd><code>{job.summary?.evidenceFinalHash ?? "—"}</code></dd>
        </dl>}
      </li>)}</ul>}
    </div>}

    {tab === "gateways" && <div>
      <div className="ec-actions"><button onClick={() => void refreshGateways()}>Refresh</button></div>
      <p className="ec-help">A gateway is a small agent on the lab machine that has the device attached. It polls this server for queued jobs and drives the serial port; device bytes never leave that machine.</p>
      {can("maintainer") && <form className="ec-form" onSubmit={(event) => { event.preventDefault(); void run("Register", async () => { const created = await registerGateway(apiUrl, token, workspaceId, gatewayForm.name.trim(), parseLabels(gatewayForm.labels), Number(gatewayForm.days) || undefined); setSecret({ title: `Gateway “${created.name}” registered`, hint: "Save this token on the lab machine (WIREPULSE_GATEWAY_TOKEN_FILE). It is shown once and cannot be recovered; rotate to get a new one.", value: created.token }); setGatewayForm({ name: "", labels: "", days: "" }); setNotice(""); await refreshGateways(); }); }}>
        <label>Name<input required maxLength={120} value={gatewayForm.name} onChange={(event) => setGatewayForm({ ...gatewayForm, name: event.target.value })} placeholder="Bench 3 PC" /></label>
        <label>Labels (key=value, …)<input value={gatewayForm.labels} onChange={(event) => setGatewayForm({ ...gatewayForm, labels: event.target.value })} placeholder="bench=3, board=esp32" /></label>
        <label>Token lifetime (days, optional)<input type="number" min={1} max={3650} value={gatewayForm.days} onChange={(event) => setGatewayForm({ ...gatewayForm, days: event.target.value })} placeholder="until rotated" /></label>
        <button type="submit" disabled={busy || !gatewayForm.name.trim()}>Register gateway</button>
      </form>}
      {gateways.length === 0 ? <p className="ec-empty">No gateways registered.</p> : <ul className="ec-list">{gateways.map((gateway) => <li className="ec-job" key={gateway.id}>
        <div className="ec-row"><b>{gateway.name}</b><span className={`ec-badge ${gateway.revokedAt ? "cancelled" : gateway.online ? "passed" : "stopped"}`}>{gateway.revokedAt ? "revoked" : gateway.online ? "online" : "offline"}</span><small>heartbeat {ago(gateway.lastHeartbeatAt)}{gateway.agentVersion ? ` · agent ${gateway.agentVersion}` : ""}</small></div>
        <small>Labels: {formatLabels(gateway.labels) || "none"} · Token {gateway.tokenExpiresAt ? `expires ${day(gateway.tokenExpiresAt)}` : "does not expire"}{gateway.tokenRotatedAt ? ` · rotated ${ago(gateway.tokenRotatedAt)}` : ""}</small>
        {gateway.online && !gateway.revokedAt && Array.isArray((gateway.capabilities as { serialPorts?: unknown } | null)?.serialPorts) && <small>Serial ports: {((gateway.capabilities as { serialPorts: string[] }).serialPorts).join(", ") || "none reported"}</small>}
        {can("maintainer") && !gateway.revokedAt && (editing?.id === gateway.id
          ? <form className="ec-inline" onSubmit={(event) => { event.preventDefault(); void run("Update labels", async () => { await setGatewayLabels(apiUrl, token, workspaceId, gateway.id, parseLabels(editing.text)); setEditing(null); await refreshGateways(); }); }}><input aria-label="Labels" value={editing.text} onChange={(event) => setEditing({ id: gateway.id, text: event.target.value })} /><button type="submit" disabled={busy}>Save</button><button type="button" onClick={() => setEditing(null)}>Cancel</button></form>
          : <div className="ec-actions">
            <button onClick={() => setEditing({ id: gateway.id, text: formatLabels(gateway.labels) })}>Edit labels</button>
            <button disabled={busy} onClick={() => { if (window.confirm(`Rotate the token for “${gateway.name}”? The agent using the current token is rejected until it is restarted with the new one.`)) void run("Rotate", async () => { const rotated = await rotateGateway(apiUrl, token, workspaceId, gateway.id); setSecret({ title: `New token for “${gateway.name}”`, hint: "Install it on the lab machine and restart the agent. The previous token no longer works. Shown once.", value: rotated.token }); await refreshGateways(); }); }}>Rotate token</button>
            <button className="danger" disabled={busy} onClick={() => { if (window.confirm(`Revoke “${gateway.name}”? Its token stops working immediately and this cannot be undone.`)) void run("Revoke", async () => { await revokeGateway(apiUrl, token, workspaceId, gateway.id); setNotice(`Gateway “${gateway.name}” revoked.`); await refreshGateways(); }); }}>Revoke</button>
          </div>)}
      </li>)}</ul>}
    </div>}

    {tab === "team" && can("maintainer") && <div>
      <h3>Members</h3>
      <ul className="ec-list">{members.map((member) => <li className="ec-job" key={member.subject}>
        <div className="ec-row"><b>{member.email ?? member.subject}</b>{member.email && <small>{member.subject}</small>}
          {can("administrator") ? <select aria-label={`Role of ${member.email ?? member.subject}`} value={member.role} disabled={busy} onChange={(event) => void run("Change role", async () => { await setMemberRole(apiUrl, token, workspaceId, member.subject, event.target.value as Role); setNotice("Role updated."); await refreshTeam(); })}>{ROLES.map((role) => <option key={role} value={role}>{role}</option>)}</select> : <span className="ec-badge stopped">{member.role}</span>}
          {can("administrator") && <button className="danger" disabled={busy} onClick={() => { if (window.confirm(`Remove ${member.email ?? member.subject} from this workspace?`)) void run("Remove", async () => { await removeMember(apiUrl, token, workspaceId, member.subject); setNotice("Member removed."); await refreshTeam(); }); }}>Remove</button>}
        </div>
      </li>)}</ul>
      {can("administrator") && <>
        <h3>Invitations</h3>
        <p className="ec-help">The server emails the invitation when outbound email (SMTP) is configured; if it is not, tell the person yourself. Either way they sign in with that verified address, connect, and accept the invitation shown in the Enterprise workspace panel.</p>
        <form className="ec-form" onSubmit={(event) => { event.preventDefault(); void run("Invite", async () => { const invitation = await inviteMember(apiUrl, token, workspaceId, inviteForm.email.trim(), inviteForm.role); setNotice(`Invited ${invitation.email} as ${invitation.role}. Expires ${day(invitation.expiresAt)}. They are emailed only if this server has email configured; otherwise let them know.`); setInviteForm({ ...inviteForm, email: "" }); await refreshTeam(); }); }}>
          <label>Email<input type="email" required value={inviteForm.email} onChange={(event) => setInviteForm({ ...inviteForm, email: event.target.value })} placeholder="colleague@example.com" /></label>
          <label>Role<select value={inviteForm.role} onChange={(event) => setInviteForm({ ...inviteForm, role: event.target.value as Role })}>{ROLES.map((role) => <option key={role} value={role}>{role}</option>)}</select></label>
          <button type="submit" disabled={busy || !inviteForm.email.trim()}>Invite</button>
        </form>
        <ul className="ec-list">{invitations.map((invitation) => { const state = invitation.acceptedAt ? "accepted" : invitation.revokedAt ? "revoked" : new Date(invitation.expiresAt) < new Date() ? "expired" : "pending"; return <li className="ec-job" key={invitation.id}>
          <div className="ec-row"><b>{invitation.email}</b><span className="ec-badge stopped">{invitation.role}</span><small>{state}{state === "pending" ? ` · expires ${day(invitation.expiresAt)}` : ""}</small>
            {state === "pending" && <button disabled={busy} onClick={() => void run("Revoke invitation", async () => { await revokeInvitation(apiUrl, token, workspaceId, invitation.id); await refreshTeam(); })}>Revoke</button>}</div>
        </li>; })}</ul>
      </>}
    </div>}

    {tab === "keys" && can("administrator") && <div>
      <p className="ec-help">API keys let CI submit and read jobs without a person signing in. Each key belongs to this workspace, can be at most maintainer, and always expires.</p>
      <form className="ec-form" onSubmit={(event) => { event.preventDefault(); void run("Create key", async () => { const created = await createApiKey(apiUrl, token, workspaceId, keyForm.name.trim(), keyForm.role, Number(keyForm.days) || undefined); setSecret({ title: `API key “${created.name}” created`, hint: `Role ${created.role}, expires ${day(created.expiresAt)}. Store it in your CI secret store. It is shown once.`, value: created.token }); setKeyForm({ ...keyForm, name: "" }); await refreshKeys(); }); }}>
        <label>Name<input required maxLength={120} value={keyForm.name} onChange={(event) => setKeyForm({ ...keyForm, name: event.target.value })} placeholder="nightly-ci" /></label>
        <label>Role<select value={keyForm.role} onChange={(event) => setKeyForm({ ...keyForm, role: event.target.value as EnterpriseApiKey["role"] })}>{ROLES.slice(0, 3).map((role) => <option key={role} value={role}>{role}</option>)}</select></label>
        <label>Lifetime (days)<input type="number" min={1} value={keyForm.days} onChange={(event) => setKeyForm({ ...keyForm, days: event.target.value })} /></label>
        <button type="submit" disabled={busy || !keyForm.name.trim()}>Create key</button>
      </form>
      {keys.length === 0 ? <p className="ec-empty">No API keys.</p> : <ul className="ec-list">{keys.map((key) => <li className="ec-job" key={key.id}>
        <div className="ec-row"><b>{key.name}</b><code>{key.prefix}…</code><span className="ec-badge stopped">{key.role}</span><small>{key.revokedAt ? "revoked" : `expires ${day(key.expiresAt)}`} · last used {ago(key.lastUsedAt)}</small>
          {!key.revokedAt && <button className="danger" disabled={busy} onClick={() => { if (window.confirm(`Revoke the key “${key.name}”? Anything using it stops working immediately.`)) void run("Revoke key", async () => { await revokeApiKey(apiUrl, token, workspaceId, key.id); await refreshKeys(); }); }}>Revoke</button>}</div>
      </li>)}</ul>}
    </div>}

    {tab === "provisioning" && can("administrator") && <div>
      <p className="ec-help">Provisioning lets your identity provider (Okta, Microsoft Entra ID, or any SCIM 2.0 client) add and remove people here, so someone deactivated there loses access to this workspace within seconds, including any open live view. People are matched to their sign-in by verified email on their first sign-in; use roles named exactly viewer, engineer, maintainer or administrator. SCIM Groups keep directory membership in sync but do not grant workspace access or change roles.</p>
      <div className="ec-row"><b>SCIM base URL</b><code data-testid="scim-base-url">{scimBaseUrl(apiUrl)}</code><button onClick={() => void navigator.clipboard?.writeText(scimBaseUrl(apiUrl))}>Copy</button></div>
      <form className="ec-form" onSubmit={(event) => { event.preventDefault(); void run("Create token", async () => { const created = await createScimToken(apiUrl, token, workspaceId, scimForm.name.trim(), Number(scimForm.days) || undefined); setSecret({ title: `Provisioning token “${created.name}” created`, hint: `Paste it into your identity provider as the bearer token. It expires ${day(created.expiresAt)}; after that the provider is refused and leavers are no longer removed, so create a replacement before then. It is shown once.`, value: created.token }); setScimForm({ ...scimForm, name: "" }); setNotice(""); await refreshProvisioning(); }); }}>
        <label>Name<input required maxLength={120} value={scimForm.name} onChange={(event) => setScimForm({ ...scimForm, name: event.target.value })} placeholder="okta-production" /></label>
        <label>Lifetime (days)<input type="number" min={1} max={3650} value={scimForm.days} onChange={(event) => setScimForm({ ...scimForm, days: event.target.value })} /></label>
        <button type="submit" disabled={busy || !scimForm.name.trim()}>Create token</button>
      </form>
      <h3>Tokens</h3>
      {scimTokens.length === 0 ? <p className="ec-empty">No provisioning tokens.</p> : <ul className="ec-list">{scimTokens.map((scim) => { const health = tokenHealth(scim); return <li className="ec-job" key={scim.id}>
        <div className="ec-row"><b>{scim.name}</b><code>{scim.prefix}…</code><span className={`ec-badge ${health.state === "ok" ? "passed" : health.state === "expiring" ? "running" : health.state === "expired" ? "failed" : "cancelled"}`} data-testid="scim-token-state">{health.state}</span>
          <small>{health.state === "revoked" ? "revoked" : health.state === "expired" ? `expired ${day(scim.expiresAt)}` : `expires ${day(scim.expiresAt)} (${health.days} d)`} · last used {ago(scim.lastUsedAt)}</small>
          {!scim.revokedAt && <button className="danger" disabled={busy} onClick={() => { if (window.confirm(`Revoke the token “${scim.name}”? Your identity provider is refused immediately and stops adding or removing people until it is given a new token.`)) void run("Revoke token", async () => { await revokeScimToken(apiUrl, token, workspaceId, scim.id); await refreshProvisioning(); }); }}>Revoke</button>}</div>
        {(health.state === "expired" || health.state === "expiring") && <span className="ec-error" role="alert">{health.state === "expired" ? "This token has expired: the identity provider can no longer remove leavers. Create a new token and give it to the provider, then revoke this one." : `This token expires in ${health.days} day${health.days === 1 ? "" : "s"}. Create a replacement and update the identity provider before then.`}</span>}
        {health.state !== "revoked" && health.state !== "expired" && !scim.lastUsedAt && <small>Never used: the identity provider has not connected with it yet.</small>}
      </li>; })}</ul>}
      {scimTokens.length > 0 && !scimTokens.some((scim) => tokenHealth(scim).state === "ok" || tokenHealth(scim).state === "expiring") && <p className="ec-error" role="alert">No usable token: provisioning and deprovisioning from the identity provider are not working.</p>}
      <div className="ec-row"><h3>Provisioned people</h3><button onClick={() => void refreshProvisioning()}>Refresh</button></div>
      {provisioned.length === 0 ? <p className="ec-empty">Nobody has been provisioned yet.</p> : <ul className="ec-list">{provisioned.map((person) => <li className="ec-job" key={person.id}>
        <div className="ec-row"><b>{person.displayName ?? person.userName}</b><small>{person.email ?? person.userName}</small><span className="ec-badge stopped">{person.role}</span><span className={`ec-badge ${PROVISIONED_BADGE[person.state]}`} data-testid="provisioned-state">{person.state}</span><small>{PROVISIONED_NOTE[person.state]}{person.state === "deactivated" && person.deactivatedAt ? ` ${ago(person.deactivatedAt)}` : ""}</small></div>
      </li>)}</ul>}
      <p className="ec-help">Deactivating someone in the identity provider removes their membership here and revokes the API keys they created. A key made by a person who is still here is left alone.</p>
    </div>}

    {tab === "webhooks" && can("administrator") && <div>
      <p className="ec-help">A webhook sends a signed HTTP POST to your system when a job finishes. Deliveries are retried and arrive at least once: ignore a repeated X-WirePulse-Delivery id. Verify the X-WirePulse-Signature header with the secret, which is shown once.</p>
      {webhooksOff ? <p className="ec-empty">Webhooks are not enabled on this server. The operator turns them on by setting a signing key.</p> : <>
        <form className="ec-form" onSubmit={(event) => { event.preventDefault(); void run("Create webhook", async () => { const created = await createWebhook(apiUrl, token, workspaceId, hookForm.name.trim(), hookForm.url.trim(), ["job.finished"]); setSecret({ title: `Webhook “${created.name}” created`, hint: "Use this secret to verify the X-WirePulse-Signature header of each delivery. It is shown once; rotate it to get a new one.", value: created.secret }); setHookForm({ name: "", url: "" }); setNotice(""); await refreshWebhooks(); }); }}>
          <label>Name<input required maxLength={120} value={hookForm.name} onChange={(event) => setHookForm({ ...hookForm, name: event.target.value })} placeholder="CI status" /></label>
          <label>URL<input required type="url" maxLength={2048} value={hookForm.url} onChange={(event) => setHookForm({ ...hookForm, url: event.target.value })} placeholder="https://ci.example.com/hooks/wirepulse" /></label>
          <button type="submit" disabled={busy || !hookForm.name.trim() || !hookForm.url.trim()}>Add webhook</button>
        </form>
        {webhooks.length === 0 ? <p className="ec-empty">No webhooks.</p> : <ul className="ec-list">{webhooks.map((hook) => <li className="ec-job" key={hook.id}>
          <div className="ec-row"><b>{hook.name}</b><span className={`ec-badge ${hook.enabled ? "passed" : "stopped"}`}>{hook.enabled ? "enabled" : "disabled"}</span><small>{hook.events.join(", ")} · secret v{hook.secretVersion}</small></div>
          <small>{hook.url}</small>
          {hookEdit?.id === hook.id
            ? <form className="ec-inline" onSubmit={(event) => { event.preventDefault(); void run("Update webhook", async () => { await updateWebhook(apiUrl, token, workspaceId, hook.id, { name: hookEdit.name.trim(), url: hookEdit.url.trim() }); setHookEdit(null); await refreshWebhooks(); }); }}><input aria-label="Webhook name" required maxLength={120} value={hookEdit.name} onChange={(event) => setHookEdit({ ...hookEdit, name: event.target.value })} /><input aria-label="Webhook URL" required type="url" value={hookEdit.url} onChange={(event) => setHookEdit({ ...hookEdit, url: event.target.value })} /><button type="submit" disabled={busy}>Save</button><button type="button" onClick={() => setHookEdit(null)}>Cancel</button></form>
            : <div className="ec-actions">
              <button disabled={busy} onClick={() => void run(hook.enabled ? "Disable" : "Enable", async () => { await updateWebhook(apiUrl, token, workspaceId, hook.id, { enabled: !hook.enabled }); await refreshWebhooks(); })}>{hook.enabled ? "Disable" : "Enable"}</button>
              <button onClick={() => setHookEdit({ id: hook.id, name: hook.name, url: hook.url })}>Edit</button>
              <button disabled={busy} onClick={() => void run("Ping", async () => { await pingWebhook(apiUrl, token, workspaceId, hook.id); setNotice("Test delivery queued. Refresh the deliveries in a few seconds."); await showDeliveries(hook.id); })}>Send test</button>
              <button aria-expanded={deliveryView?.hookId === hook.id} onClick={() => { if (deliveryView?.hookId === hook.id) setDeliveryView(null); else void showDeliveries(hook.id); }}>{deliveryView?.hookId === hook.id ? "Hide deliveries" : "Deliveries"}</button>
              <button disabled={busy} onClick={() => { if (window.confirm(`Rotate the secret for “${hook.name}”? The old secret stops signing immediately, so your receiver must switch to the new one.`)) void run("Rotate secret", async () => { const rotated = await rotateWebhookSecret(apiUrl, token, workspaceId, hook.id); setSecret({ title: `New secret for “${hook.name}”`, hint: `Version ${rotated.secretVersion}. Update your receiver now: the previous secret no longer signs deliveries. Shown once.`, value: rotated.secret }); await refreshWebhooks(); }); }}>Rotate secret</button>
              <button className="danger" disabled={busy} onClick={() => { if (window.confirm(`Delete the webhook “${hook.name}”? Its delivery history is removed too.`)) void run("Delete webhook", async () => { await deleteWebhook(apiUrl, token, workspaceId, hook.id); setDeliveryView(null); setNotice(`Webhook “${hook.name}” deleted.`); await refreshWebhooks(); }); }}>Delete</button>
            </div>}
          {deliveryView?.hookId === hook.id && <div className="ec-actions"><button onClick={() => void showDeliveries(hook.id)}>Refresh deliveries</button></div>}
          {deliveryView?.hookId === hook.id && (deliveryView.list.length === 0 ? <p className="ec-empty">No deliveries yet.</p> : <ul className="ec-list">{deliveryView.list.map((delivery) => <li className="ec-row" key={delivery.id}>
            <span className={`ec-badge ${DELIVERY_BADGE[delivery.status]}`}>{delivery.status}</span><code>{delivery.eventType}</code>
            <small>attempt {delivery.attempts} · {ago(delivery.createdAt)}{delivery.lastStatus ? ` · HTTP ${delivery.lastStatus}` : ""}{delivery.lastError ? ` · ${delivery.lastError}` : ""}</small>
            {delivery.status === "failed" && <button disabled={busy} onClick={() => void run("Redeliver", async () => { await redeliverWebhook(apiUrl, token, workspaceId, hook.id, delivery.id); await showDeliveries(hook.id); })}>Redeliver</button>}
          </li>)}</ul>)}
        </li>)}</ul>}
      </>}
    </div>}

    {tab === "audit" && can("administrator") && <div>
      <p className="ec-help">Every change to this workspace (who, what, when, from where) is recorded in a trail whose entries are chained by hash, so an edit or deletion after the fact is detectable. “Verify” recomputes the chain on the server. To also catch someone with direct database access rewriting the end of the trail, keep the head hash somewhere they cannot write to, and archive the export.</p>
      <div className="ec-row">
        <button disabled={busy} onClick={() => void run("Verify", async () => {
          let from = 0; let checked = 0; let result = await verifyAudit(apiUrl, token, workspaceId, from);
          for (let calls = 1; ; calls += 1) {
            checked += result.checked;
            if (!result.valid || result.complete || result.nextFromSeq === null || calls >= MAX_VERIFY_CALLS) break;
            from = result.nextFromSeq; result = await verifyAudit(apiUrl, token, workspaceId, from);
          }
          setVerification({ ...result, checked, at: new Date().toISOString() });
        })}>Verify chain</button>
        <button disabled={busy} onClick={() => void run("Export", async () => { saveBlob(await fetchAuditExport(apiUrl, token, workspaceId), `wirepulse-audit-${workspaceId.slice(0, 8)}.ndjson`); })}>Export (NDJSON)</button>
      </div>
      {verification && (verification.valid
        ? <div className="ec-secret" role="status" data-testid="audit-verification"><b>Chain intact</b><p>{verification.checked} event{verification.checked === 1 ? "" : "s"} checked{verification.lastSeq === null ? "" : `, up to #${verification.lastSeq}`}{verification.complete ? "" : " (stopped early; verify again to continue)"} · {new Date(verification.at).toLocaleTimeString()}</p>{verification.headHash && <p>Head hash <code data-testid="audit-head-hash">{verification.headHash}</code> <button onClick={() => void navigator.clipboard?.writeText(verification.headHash ?? "")}>Copy</button></p>}</div>
        : <div className="ec-secret" role="alert" data-testid="audit-verification"><b>Chain broken</b><p>The first entry that does not match is #{verification.firstBadSeq}. Treat this as a security incident: preserve the database and the latest export.</p></div>)}
      <form className="ec-form" onSubmit={(event) => { event.preventDefault(); void run("Filter", () => loadAudit(auditDraft)); }}>
        <label>Action (exact)<input value={auditDraft.action} maxLength={80} onChange={(event) => setAuditDraft({ ...auditDraft, action: event.target.value })} placeholder="gateway.revoked" /></label>
        <label>From (UTC date)<input type="date" value={auditDraft.from} onChange={(event) => setAuditDraft({ ...auditDraft, from: event.target.value })} /></label>
        <label>To (UTC date, inclusive)<input type="date" value={auditDraft.to} onChange={(event) => setAuditDraft({ ...auditDraft, to: event.target.value })} /></label>
        <button type="submit" disabled={busy}>Apply filter</button>
      </form>
      {!audit ? <p className="ec-empty">Loading the audit trail…</p> : audit.events.length === 0 ? <p className="ec-empty">No audit events match.</p> : <ul className="ec-list">{audit.events.map((event) => <li className="ec-job" key={event.id}>
        <div className="ec-row"><code>#{event.chain_seq}</code><b>{event.action}</b><small>{event.actor_subject ?? "—"}{event.resource_type ? ` · ${event.resource_type}${event.resource_id ? ` ${event.resource_id.slice(0, 8)}` : ""}` : ""} · {ago(event.created_at)}</small>
          <button aria-expanded={auditOpen === event.id} onClick={() => setAuditOpen(auditOpen === event.id ? "" : event.id)}>{auditOpen === event.id ? "Hide details" : "Details"}</button></div>
        {auditOpen === event.id && <dl className="ec-details">
          <dt>Time</dt><dd>{new Date(event.created_at).toLocaleString()}</dd>
          <dt>Request / address</dt><dd>{event.request_id ?? "—"} / {event.ip_address ?? "—"}</dd>
          <dt>Details</dt><dd><code>{JSON.stringify(event.details)}</code></dd>
          <dt>Previous hash</dt><dd><code>{event.prev_hash}</code></dd>
          <dt>Entry hash</dt><dd><code>{event.row_hash}</code></dd>
        </dl>}
      </li>)}</ul>}
      {audit?.next && <div className="ec-actions"><button disabled={busy} onClick={() => void run("Load older", () => loadAudit(audit.filter, audit.next ?? undefined, audit.events))}>Load older events</button></div>}
    </div>}

    {tab === "usage" && <div>
      {!plan ? <p className="ec-empty">Loading usage…</p> : <>
        <div className="ec-row"><p className="ec-help">Plan <b data-testid="plan-name">{plan.plan}</b> · usage for {plan.usage.period.slice(0, 7)} (monthly counters reset on the 1st, UTC)</p><button onClick={() => void refreshPlan()}>Refresh</button></div>
        <ul className="ec-list">{USAGE_ROWS.map((row) => { const used = row.used(plan.usage); const limit = plan.limits[row.limit]; return <li className="ec-job" key={row.label}>
          <div className="ec-row"><b>{row.label}</b><span>{used}{limit === null ? " · unlimited" : ` of ${limit}`}</span>{row.note && <small>{row.note}</small>}</div>
          {limit !== null && <progress aria-label={`${row.label} used`} value={used} max={Math.max(1, limit)} />}
        </li>; })}
        <li className="ec-job"><div className="ec-row"><b>Requests per minute</b><span>{plan.limits.requestsPerMinute === null ? "unlimited" : `up to ${plan.limits.requestsPerMinute}`}</span><small>per workspace; excess requests get HTTP 429 and may retry after a moment</small></div></li></ul>
        {can("administrator") && <div className="ec-danger-zone">
          <h3>Delete this workspace</h3>
          <p className="ec-help">Ends access immediately: queued jobs are cancelled, and all gateways, API keys, invitations and webhooks are disabled. The content is kept for a grace period, and your provider can restore it until it is purged. The audit trail is kept. Type the workspace name to confirm.</p>
          <form className="ec-inline" onSubmit={(event) => { event.preventDefault(); void run("Delete workspace", async () => { const deleted = await deleteWorkspace(apiUrl, token, workspaceId, deleteName); setDeleteName(""); onWorkspaceDeleted?.(deleted.id); }); }}>
            <input aria-label="Type the workspace name to confirm" value={deleteName} onChange={(event) => setDeleteName(event.target.value)} placeholder={workspace.name} autoComplete="off" />
            <button className="danger" type="submit" disabled={busy || deleteName !== workspace.name}>Delete workspace</button>
          </form>
        </div>}
      </>}
    </div>}

    <p className="enterprise-status ec-notice" role="status" aria-live="polite">{notice}</p>
  </section>;
}
