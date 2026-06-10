import { useEffect, useState } from "react";
import { Braces, Check, CircleAlert, Copy, Download, FileInput, Fingerprint, ListChecks, Monitor, ShieldCheck, SlidersHorizontal, X } from "lucide-react";

import type { TranslationKey } from "../../i18n";
import { formatTime } from "../../lib/utils";
import {
  type BrowserProfile,
  type LaunchSnippet,
  type PanelState,
  type ProfilePreflightAction,
  type ProfilePreflightReport,
  type SessionSummary,
  auditProfile,
  generateLaunchSnippets,
  profileScore,
} from "../../shared/profile";
import type { StorageInfo } from "../../shared/settings";
import { statusText } from "./ProfileTable";

export function ProfileInspectorAside({
  busy,
  copySnippet,
  copySnapshotMarkdown,
  downloadSnapshot,
  draft,
  editProfile,
  preflight,
  runPreflightAction,
  selectedSession,
  state,
  storage,
  t,
}: {
  busy: string;
  copySnippet: (code: string) => Promise<void>;
  copySnapshotMarkdown: () => Promise<void>;
  downloadSnapshot: (format: "json" | "md") => void;
  draft: BrowserProfile;
  editProfile: () => void;
  preflight: ProfilePreflightReport | null;
  runPreflightAction: (action: ProfilePreflightAction) => Promise<void>;
  selectedSession?: SessionSummary;
  state: PanelState | null;
  storage?: StorageInfo;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const launchFailed = hasLaunchFailure(selectedSession);
  return (
    <aside className="inspector">
      <header className="inspector-header">
        <div>
          <span className="eyebrow">{t("workspace.inspector")}</span>
          <strong>{t("workspace.selectedProfile")}</strong>
          <small>{t("workspace.inspectorHint")}</small>
        </div>
        {!launchFailed && (
          <button className="command subtle" onClick={editProfile} type="button">
            <SlidersHorizontal size={17} />
            {t("actions.edit")}
          </button>
        )}
      </header>
      <LaunchFailurePanel editProfile={editProfile} session={selectedSession} t={t} />
      <ProfileSummaryPanel draft={draft} session={selectedSession} storage={storage} t={t} />
      <PreflightPanel busy={busy} launchBlocked={launchFailed} onAction={runPreflightAction} report={preflight} t={t} />
      <SessionPanel session={selectedSession} state={state} draft={draft} t={t} />
      <ScorePanel draft={draft} t={t} />
      <CodePanel
        copySnippet={copySnippet}
        copySnapshotMarkdown={copySnapshotMarkdown}
        downloadSnapshot={downloadSnapshot}
        snippets={safeGenerateLaunchSnippets(draft, t)}
        t={t}
      />
    </aside>
  );
}

export function DetailsDrawer({
  close,
  copySnippet,
  copySnapshotMarkdown,
  downloadSnapshot,
  draft,
  busy,
  editProfile,
  preflight,
  runPreflightAction,
  selectedSession,
  state,
  storage,
  t,
}: {
  close: () => void;
  copySnippet: (code: string) => Promise<void>;
  copySnapshotMarkdown: () => Promise<void>;
  downloadSnapshot: (format: "json" | "md") => void;
  draft: BrowserProfile;
  busy: string;
  editProfile: () => void;
  preflight: ProfilePreflightReport | null;
  runPreflightAction: (action: ProfilePreflightAction) => Promise<void>;
  selectedSession?: SessionSummary;
  state: PanelState | null;
  storage?: StorageInfo;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const launchFailed = hasLaunchFailure(selectedSession);
  return (
    <div className="drawer-layer" role="dialog" aria-modal="true" aria-label={t("workspace.inspector")}>
      <button className="drawer-scrim" aria-label={t("actions.close")} onClick={close} type="button" />
      <aside className="drawer-panel detail-drawer">
        <header className="drawer-header">
          <div>
            <span className="eyebrow">{t("workspace.inspector")}</span>
            <h2>{draft.name}</h2>
            <p>{t("workspace.inspectorHint")}</p>
          </div>
          <button className="icon-button" aria-label={t("actions.close")} onClick={close} type="button">
            <X size={18} />
          </button>
        </header>
        {!launchFailed && (
          <div className="detail-drawer-actions">
            <button className="command primary" onClick={editProfile} type="button">
              <SlidersHorizontal size={17} aria-hidden="true" />
              {t("actions.edit")}
            </button>
          </div>
        )}
        <LaunchFailurePanel editProfile={editProfile} session={selectedSession} t={t} />
        <ProfileSummaryPanel draft={draft} session={selectedSession} storage={storage} t={t} />
        <PreflightPanel busy={busy} launchBlocked={launchFailed} onAction={runPreflightAction} report={preflight} t={t} />
        <SessionPanel session={selectedSession} state={state} draft={draft} t={t} />
        <ScorePanel draft={draft} t={t} />
        <CodePanel
          copySnippet={copySnippet}
          copySnapshotMarkdown={copySnapshotMarkdown}
          downloadSnapshot={downloadSnapshot}
          snippets={safeGenerateLaunchSnippets(draft, t)}
          t={t}
        />
      </aside>
    </div>
  );
}

function LaunchFailurePanel({
  editProfile,
  session,
  t,
}: {
  editProfile: () => void;
  session?: SessionSummary;
  t: (key: TranslationKey) => string;
}) {
  if (!hasLaunchFailure(session)) return null;
  const rawMessage = session?.lastError ?? "";
  const message = cleanLaunchError(rawMessage);
  return (
    <section className="side-section launch-failure-card">
      <div className="launch-failure-icon" aria-hidden="true">
        <CircleAlert size={18} />
      </div>
      <div className="launch-failure-copy">
        <span>{t("diagnostic.launchBlocked")}</span>
        <strong>{proxyExitFailureTitle(rawMessage, t)}</strong>
        <small>{message || t("diagnostic.launchBlockedDetail")}</small>
      </div>
      <button className="command subtle compact" onClick={editProfile} type="button">
        <SlidersHorizontal size={16} aria-hidden="true" />
        {t("actions.edit")}
      </button>
    </section>
  );
}

export function ProfileSummaryPanel({ draft, session, storage, t }: { draft: BrowserProfile; session?: SessionSummary; storage?: StorageInfo; t: (key: TranslationKey) => string }) {
  const status = session?.status ?? "stopped";
  const items = [
    { label: t("table.group"), value: draft.group || "-" },
    { label: t("table.mode"), value: t(draft.mode === "persistent" ? "mode.persistent" : "mode.ephemeral") },
    { label: t("table.status"), value: statusText(status, t), tone: status },
    { label: t("panel.storage"), value: storage?.kind ?? "sqlite" },
  ];
  return (
    <section className="side-section profile-summary">
      <div className="section-title">
        <Fingerprint size={17} />
        <h2>{draft.name}</h2>
      </div>
      <dl className="summary-strip">
        {items.map((item) => (
          <div className={item.tone ? `summary-chip ${item.tone}` : "summary-chip"} key={item.label}>
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function SessionPanel({ session, state, draft, t }: { session?: SessionSummary; state: PanelState | null; draft: BrowserProfile; t: (key: TranslationKey, params?: Record<string, string | number>) => string }) {
  const launch = session?.launch;
  const events = session?.events ?? [];
  const launchFailed = hasLaunchFailure(session);
  return (
    <section className="side-section">
      <div className="section-title">
        <Monitor size={17} />
        <h2>{t("panel.session")}</h2>
      </div>
      <dl className="kv-list">
        <div>
          <dt>{t("table.status")}</dt>
          <dd>
            <span className={`pill ${session?.status ?? "stopped"}`}>{statusText(session?.status ?? "stopped", t)}</span>
          </dd>
        </div>
        <div>
          <dt>{t("session.startedAt")}</dt>
          <dd>{session?.startedAt ? new Date(session.startedAt).toLocaleString() : "-"}</dd>
        </div>
        <div>
          <dt>{t("session.page")}</dt>
          <dd>{session?.pageUrl ?? draft.startUrl ?? "-"}</dd>
        </div>
        <div>
          <dt>{t("session.dataDir")}</dt>
          <dd>{launch?.userDataDir ?? state?.meta.dataDir ?? "-"}</dd>
        </div>
        <div>
          <dt>{t("table.launcher")}</dt>
          <dd>{launch ? `${launch.runtimeLauncher} -> ${launch.sdkLauncher}` : draft.runtime.launcher}</dd>
        </div>
      </dl>
      {session?.lastError && !launchFailed && <div className="inline-error">{session.lastError}</div>}
      {events.length > 0 && (
        <details className="session-events" aria-label={t("aria.sessionEvents")}>
          <summary>
            <span>{t("diagnostic.launchLog")}</span>
            <strong>{t("diagnostic.eventCount", { count: events.length })}</strong>
          </summary>
          <div className="session-event-list">
            {events.map((event) => (
              <div className={`session-event ${event.level}`} key={`${event.at}-${event.message}`}>
                <span>{formatTime(event.at)}</span>
                <strong>{event.message}</strong>
                {event.detail && <small>{event.detail}</small>}
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

export function PreflightPanel({
  busy,
  launchBlocked,
  onAction,
  report,
  t,
}: {
  busy: string;
  launchBlocked?: boolean;
  onAction: (action: ProfilePreflightAction) => Promise<void>;
  report: ProfilePreflightReport | null;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const firstFailure = report ? firstPreflightFailure(report) : undefined;
  return (
    <section className="side-section">
      <div className="section-title">
        <ListChecks size={17} />
        <h2>{t("panel.preflight")}</h2>
        {report && <span className={`pill ${report.ok ? "running" : "error"}`}>{report.ok ? t("form.pass") : t("form.fail")}</span>}
      </div>
      {!report ? (
        <div className={launchBlocked ? "preflight-empty diagnostic-note" : "preflight-empty"}>
          <strong>{launchBlocked ? t("diagnostic.launchCheckInterrupted") : t("preflight.notRun")}</strong>
          {launchBlocked && <small>{t("diagnostic.launchCheckInterruptedDetail")}</small>}
        </div>
      ) : (
        <>
          <div className={`preflight-summary ${report.ok ? "pass" : "fail"}`}>
            <strong>{report.ok ? t("preflight.launchable") : t("preflight.needsAction")}</strong>
            <span>
              {formatSummary(report.summary, t, true)}
            </span>
            <small>{new Date(report.checkedAt).toLocaleString()}</small>
          </div>
          {firstFailure && (
            <div className="preflight-focus">
              <span>{t("preflight.firstFailure")}</span>
              <strong>{firstFailure.title}</strong>
              <small>{firstFailure.detail || t("preflight.noDetail")}</small>
              {firstFailure.actions && firstFailure.actions.length > 0 && (
                <span className="preflight-actions">
                  {firstFailure.actions.map((action) => (
                    <button className="mini-action" disabled={busy === "binary-install"} key={`focus-${firstFailure.id}-${action.id}`} onClick={() => void onAction(action)} type="button">
                      {action.label}
                    </button>
                  ))}
                </span>
              )}
            </div>
          )}
          <div className="score-list">
            {report.items.map((item) => (
              <div className={`score-row ${item.severity}`} key={`${item.id}-${item.detail}`}>
                {item.severity === "pass" ? <Check size={16} className="ok" /> : <CircleAlert size={16} className={item.severity} />}
                <span>
                  <strong>{item.title}</strong>
                  <small>{item.detail}</small>
                  {item.actions && item.actions.length > 0 && (
                    <span className="preflight-actions">
                      {item.actions.map((action) => (
                        <button className="mini-action" disabled={busy === "binary-install"} key={`${item.id}-${action.id}`} onClick={() => void onAction(action)} type="button">
                          {action.label}
                        </button>
                      ))}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

export function formatSummary(
  summary: { pass: number; warn: number; fail: number; info?: number },
  t: (key: TranslationKey) => string,
  includeInfo = false,
): string {
  const parts = [
    `${t("summary.pass")} ${summary.pass}`,
    `${t("summary.warn")} ${summary.warn}`,
    `${t("summary.fail")} ${summary.fail}`,
  ];
  if (includeInfo) parts.push(`${t("summary.info")} ${summary.info ?? 0}`);
  return parts.join(" / ");
}

export function firstPreflightFailure(report: ProfilePreflightReport): ProfilePreflightReport["items"][number] | undefined {
  return report.items.find((item) => item.severity === "fail");
}

function hasLaunchFailure(session?: SessionSummary): boolean {
  return session?.status === "error" && Boolean(session.lastError);
}

function cleanLaunchError(message: string): string {
  return message.replace(/^代理出口检测失败，已阻止启动：/, "").replace(/^Proxy exit check failed, launch blocked:\s*/i, "").trim();
}

function proxyExitFailureTitle(message: string, t: (key: TranslationKey) => string): string {
  if (/代理出口|proxy exit/i.test(message)) return t("diagnostic.proxyExitFailed");
  return t("diagnostic.launchFailed");
}

export function preflightToastMessage(
  report: ProfilePreflightReport,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  if (report.ok) return t("toast.preflightPass");
  const failure = firstPreflightFailure(report);
  if (!failure) return t("toast.preflightFail", { count: report.summary.fail });
  return t("toast.preflightFailDetail", {
    count: report.summary.fail,
    title: failure.title,
    detail: failure.detail || t("preflight.noDetail"),
  });
}

export function ScorePanel({ draft, t }: { draft: BrowserProfile; t: (key: TranslationKey) => string }) {
  const report = auditProfile(draft);
  return (
    <section className="side-section">
      <div className="section-title">
        <ShieldCheck size={17} />
        <h2>{t("panel.audit")}</h2>
      </div>
      <div className="audit-summary">
        <strong>{report.score}</strong>
        <span>{t("summary.auditScore")}</span>
        <small>
          {formatSummary(report.summary, t)}
        </small>
      </div>
      <div className="score-list">
        {report.items.slice(0, 8).map((item) => (
          <div className={`score-row ${item.severity}`} key={item.id}>
            {item.severity === "pass" ? <Check size={16} className="ok" /> : <CircleAlert size={16} className={item.severity} />}
            <span>
              <strong>{item.title}</strong>
              <small>{item.detail}</small>
            </span>
          </div>
        ))}
      </div>
      <details className="baseline-score">
        <summary>{t("summary.legacyBaseline")}</summary>
        {profileScore(draft).map((item) => (
          <div className="score-row" key={item.label}>
            {item.ok ? <Check size={16} className="ok" /> : <CircleAlert size={16} className="warn" />}
            <span>
              <strong>{item.label}</strong>
              <small>{item.detail}</small>
            </span>
          </div>
        ))}
      </details>
    </section>
  );
}

export function CodePanel({
  snippets,
  copySnippet,
  copySnapshotMarkdown,
  downloadSnapshot,
  t,
}: {
  snippets: LaunchSnippet[];
  copySnippet: (code: string) => Promise<void>;
  copySnapshotMarkdown: () => Promise<void>;
  downloadSnapshot: (format: "json" | "md") => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const [activeSnippetId, setActiveSnippetId] = useState(snippets[0]?.id ?? "");
  const activeSnippet = snippets.find((snippet) => snippet.id === activeSnippetId) ?? snippets[0];
  const code = activeSnippet?.code ?? "";
  const isError = activeSnippet?.id === "launch-error";

  useEffect(() => {
    if (!snippets.some((snippet) => snippet.id === activeSnippetId)) {
      setActiveSnippetId(snippets[0]?.id ?? "");
    }
  }, [activeSnippetId, snippets]);

  return (
    <section className="side-section code-section">
      <div className="section-title">
        <Braces size={17} />
        <h2>{t("panel.snippets")}</h2>
        <div className="code-actions">
          <button className="icon-button compact" title={t("actions.copy")} onClick={() => void copySnippet(code)} type="button">
            <Copy size={16} />
          </button>
          <button className="icon-button compact" title={t("actions.markdown")} onClick={() => void copySnapshotMarkdown()} type="button">
            <FileInput size={16} />
          </button>
          <button className="icon-button compact" title={t("actions.json")} onClick={() => downloadSnapshot("json")} type="button">
            <Download size={16} />
          </button>
        </div>
      </div>
      <div className="snippet-tabs" aria-label={t("aria.launchSnippets")}>
        {snippets.map((snippet) => (
          <button className={snippet.id === activeSnippet?.id ? "active" : ""} key={snippet.id} onClick={() => setActiveSnippetId(snippet.id)} type="button">
            {snippet.title}
          </button>
        ))}
      </div>
      <pre className={isError ? "code-error" : ""}>{code}</pre>
    </section>
  );
}

export function safeGenerateLaunchSnippets(
  profile: BrowserProfile,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): LaunchSnippet[] {
  try {
    return generateLaunchSnippets(profile);
  } catch (error) {
    const title = t("error.config");
    return [
      {
        id: "launch-error",
        title,
        language: "ts",
        code: `${title}: ${(error as Error).message}`,
      },
    ];
  }
}
