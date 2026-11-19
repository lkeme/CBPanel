import { useEffect, useState } from "react";
import { Braces, Check, ChevronDown, ChevronRight, CircleAlert, Copy, Download, FileInput, Fingerprint, ListChecks, Monitor, ShieldCheck, SlidersHorizontal } from "lucide-react";

import type { Locale, TranslationKey } from "../../i18n";
import { formatTime } from "../../lib/utils";
import {
  type BrowserProfile,
  type EffectiveArgPreview,
  type LaunchSnippet,
  type PanelState,
  type ProfilePreflightAction,
  type ProfilePreflightReport,
  type SessionSummary,
  auditProfile,
  generateLaunchSnippets,
  localizedText,
} from "../../shared/profile";
import { withLaunchExtensionPaths } from "../../shared/extensionDisplay";
import { resolveLocalizedText } from "../../shared/reportText";
import type { StorageInfo } from "../../shared/settings";
import { Drawer } from "../ui/form-controls";
import { KeyValueList } from "../ui/KeyValueList";
import { StatusPill, type StatusPillTone } from "../ui/StatusPill";
import { statusText } from "./ProfileTable";

export function DetailsDrawer({
  busy,
  close,
  copySnippet,
  copySnapshotMarkdown,
  downloadSnapshot,
  draft,
  editProfile,
  locale,
  preflight,
  runPreflightAction,
  selectedSession,
  state,
  storage,
  t,
}: {
  busy: string;
  close: () => void;
  copySnippet: (code: string) => Promise<void>;
  copySnapshotMarkdown: () => Promise<void>;
  downloadSnapshot: (format: "json" | "md") => void;
  draft: BrowserProfile;
  editProfile: () => void;
  locale: Locale;
  preflight: ProfilePreflightReport | null;
  runPreflightAction: (action: ProfilePreflightAction) => Promise<void>;
  selectedSession?: SessionSummary;
  state: PanelState | null;
  storage?: StorageInfo;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const launchFailed = hasLaunchFailure(selectedSession);
  // A side drawer, never a column: the table keeps its full width, and the sheet opens over it.
  return (
    <Drawer
      actions={
        !launchFailed ? (
          <button className="command primary" onClick={editProfile} type="button">
            <SlidersHorizontal size={16} aria-hidden="true" />
            {t("actions.edit")}
          </button>
        ) : undefined
      }
      close={close}
      contentClassName="drawer-scroll detail-drawer"
      subtitle={t("workspace.inspectorHint")}
      t={t}
      title={draft.name}
    >
      <LaunchFailurePanel editProfile={editProfile} session={selectedSession} t={t} />
      <ProfileSummaryPanel draft={draft} session={selectedSession} storage={storage} t={t} />
      <PreflightPanel busy={busy} launchBlocked={launchFailed} locale={locale} onAction={runPreflightAction} report={preflight} t={t} />
      <SessionPanel session={selectedSession} state={state} draft={draft} t={t} />
      <ScorePanel draft={draft} locale={locale} t={t} />
      <CodePanel
        copySnippet={copySnippet}
        copySnapshotMarkdown={copySnapshotMarkdown}
        downloadSnapshot={downloadSnapshot}
        locale={locale}
        snippets={safeGenerateLaunchSnippets(withPreviewExtensionPaths(draft, state), t)}
        t={t}
      />
    </Drawer>
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
        <h2>{t("workspace.selectedProfile")}</h2>
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
      <KeyValueList
        items={[
          {
            label: t("table.status"),
            value: (
              <StatusPill tone={(session?.status ?? "stopped") as StatusPillTone}>
                {statusText(session?.status ?? "stopped", t)}
              </StatusPill>
            ),
          },
          { label: t("session.startedAt"), value: session?.startedAt ? new Date(session.startedAt).toLocaleString() : "-" },
          { label: t("session.page"), value: session?.pageUrl ?? draft.startUrl ?? "-" },
          { label: t("session.dataDir"), value: launch?.userDataDir ?? state?.meta.dataDir ?? "-" },
          { label: t("session.sdkLauncher"), value: launch ? `${launch.sdkLauncher} -> ${launch.resultType}` : "-" },
        ]}
      />
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
  locale,
  onAction,
  report,
  t,
}: {
  busy: string;
  launchBlocked?: boolean;
  locale: Locale;
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
        {report && <StatusPill tone={report.ok ? "running" : "error"}>{report.ok ? t("form.pass") : t("form.fail")}</StatusPill>}
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
              <strong>{resolveLocalizedText(firstFailure.title, t, locale)}</strong>
              <small>{resolveLocalizedText(firstFailure.detail, t, locale) || t("preflight.noDetail")}</small>
              {firstFailure.actions && firstFailure.actions.length > 0 && (
                <span className="preflight-actions">
                  {firstFailure.actions.map((action) => (
                    <button className="mini-action" disabled={busy === "binary-install" || busy === "xray-install"} key={`focus-${firstFailure.id}-${action.id}`} onClick={() => void onAction(action)} type="button">
                      {resolveLocalizedText(action.label, t, locale)}
                    </button>
                  ))}
                </span>
              )}
            </div>
          )}
          <div className="score-list">
            {report.items.map((item) => {
              const title = resolveLocalizedText(item.title, t, locale);
              const detail = resolveLocalizedText(item.detail, t, locale);
              return (
                <div className={`score-row ${item.severity}`} key={`${item.id}-${detail}`}>
                  {item.severity === "pass" ? <Check size={16} className="ok" /> : <CircleAlert size={16} className={item.severity} />}
                  <span>
                    <strong>{title}</strong>
                    <small>{detail}</small>
                    {item.actions && item.actions.length > 0 && (
                      <span className="preflight-actions">
                        {item.actions.map((action) => (
                          <button className="mini-action" disabled={busy === "binary-install" || busy === "xray-install"} key={`${item.id}-${action.id}`} onClick={() => void onAction(action)} type="button">
                            {resolveLocalizedText(action.label, t, locale)}
                          </button>
                        ))}
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
          {report.argPreview && <EffectiveArgPanel preview={report.argPreview} t={t} />}
        </>
      )}
    </section>
  );
}

/**
 * The merged argv, folded away because it answers a question ("which value actually wins?") that only
 * comes up while diagnosing. Each row names its source, so a duplicated flag shows once with the source
 * that took effect instead of appearing three times.
 */
function EffectiveArgPanel({
  preview,
  t,
}: {
  preview: EffectiveArgPreview;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="preflight-args">
      <button aria-expanded={open} className="panel-heading panel-toggle" onClick={() => setOpen((current) => !current)} type="button">
        {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        <strong>{t("preflight.effectiveArgs")}</strong>
        <span>{t("preflight.effectiveArgsHint")}</span>
      </button>
      {open && (
        <>
          <div className="result-line">{t("preflight.effectiveArgsNote")}</div>
          {preview.argv.length === 0 ? (
            <div className="preflight-empty">{t("preflight.effectiveArgsEmpty")}</div>
          ) : (
            <ul className="preflight-arg-list">
              {preview.argv.map((arg) => {
                const source = preview.sources[arg.split("=", 1)[0].toLowerCase()] ?? "generated";
                return (
                  <li key={`${source}-${arg}`}>
                    <code>{arg}</code>
                    <small>{t(`preflight.argSource.${source}` as TranslationKey)}</small>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
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
  locale: Locale,
): string {
  if (report.ok) return t("toast.preflightPass");
  const failure = firstPreflightFailure(report);
  if (!failure) return t("toast.preflightFail", { count: report.summary.fail });
  return t("toast.preflightFailDetail", {
    count: report.summary.fail,
    title: resolveLocalizedText(failure.title, t, locale),
    detail: resolveLocalizedText(failure.detail, t, locale) || t("preflight.noDetail"),
  });
}

export function ScorePanel({ draft, locale, t }: { draft: BrowserProfile; locale: Locale; t: (key: TranslationKey, params?: Record<string, string | number>) => string }) {
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
              <strong>{resolveLocalizedText(item.title, t, locale)}</strong>
              <small>{resolveLocalizedText(item.detail, t, locale)}</small>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function CodePanel({
  snippets,
  copySnippet,
  copySnapshotMarkdown,
  downloadSnapshot,
  locale,
  t,
}: {
  snippets: LaunchSnippet[];
  copySnippet: (code: string) => Promise<void>;
  copySnapshotMarkdown: () => Promise<void>;
  downloadSnapshot: (format: "json" | "md") => void;
  locale: Locale;
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
            {resolveLocalizedText(snippet.title, t, locale)}
          </button>
        ))}
      </div>
      <pre className={isError ? "code-error" : ""}>{code}</pre>
    </section>
  );
}

/**
 * Extension directories are not stored on a profile; the launcher resolves them from the binding
 * table just before the browser starts. The snippets have to do the same, or the code an operator
 * copies out would launch without the extensions the panel shows as bound.
 */
export function withPreviewExtensionPaths(
  draft: BrowserProfile,
  state: PanelState | null,
): BrowserProfile {
  const environment = state?.environments?.find((candidate) => candidate.id === draft.id);
  return withLaunchExtensionPaths(draft, environment?.extensionIds, state?.extensions);
}

export function safeGenerateLaunchSnippets(
  profile: BrowserProfile,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): LaunchSnippet[] {
  try {
    return generateLaunchSnippets(profile);
  } catch (error) {
    const title = localizedText("error.config");
    return [
      {
        id: "launch-error",
        title,
        language: "ts",
        code: `${t("error.config")}: ${(error as Error).message}`,
      },
    ];
  }
}
