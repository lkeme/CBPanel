import { Building2, CircleAlert, CircleHelp, CircleX, Gift, Layers3, LoaderCircle, ShieldCheck, UserRound, UsersRound, type LucideIcon } from "lucide-react";

import type { TranslationKey } from "../../i18n";
import { formatTime } from "../../lib/utils";
import type { BrowserCoreLicenseState } from "../../shared/browserCore";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

const planIcons = new Map<string, LucideIcon>([
  ["free", Gift],
  ["solo", UserRound],
  ["team", UsersRound],
  ["business", Building2],
  ["scale", Layers3],
]);

type LicenseState = "missing" | "saving" | "validating" | "valid" | "invalid" | "unavailable";

function licenseState(license: BrowserCoreLicenseState | undefined, saving: boolean): LicenseState {
  if (saving) return "saving";
  if (!license) return "validating";
  if (!license.active) return "missing";
  if (license.valid === false) return "invalid";
  if (license.valid === true && license.plan?.trim()) return "valid";
  return license.checkedAt ? "unavailable" : "validating";
}

function licenseStateDescription(
  license: BrowserCoreLicenseState | undefined,
  t: (key: TranslationKey) => string,
): string {
  const state = licenseState(license, false);
  if (state === "missing") return t("browserCore.licensePlanNone");
  if (state === "invalid") return t("browserCore.licensePlanInvalid");
  if (state === "validating") return t("browserCore.licensePlanValidating");
  return state === "valid" ? license!.plan! : t("browserCore.licensePlanUnknown");
}

export function BrowserCoreLicenseIndicator({ license, saving, source, installed, t }: {
  license?: BrowserCoreLicenseState;
  saving: boolean;
  source?: string;
  installed?: boolean;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const state = licenseState(license, saving);
  const pending = state === "saving" || state === "validating";
  const Icon = pending ? LoaderCircle
    : state === "missing" ? CircleAlert
    : state === "invalid" ? CircleX
    : state === "unavailable" ? CircleHelp
    : planIcons.get(license!.plan!.trim().toLowerCase()) ?? ShieldCheck;
  const description = saving ? t("browserCore.savingLicense") : licenseStateDescription(license, t);
  const label = state === "valid" ? `${t("browserCore.licensePlan")}: ${description}` : description;
  const tone = state === "invalid" ? "invalid" : state === "missing" || state === "unavailable" || installed === false ? "warning" : state === "valid" ? "valid" : "neutral";
  const showDetails = !pending && state !== "missing";
  const time = (value: string) => Number.isFinite(Date.parse(value)) ? formatTime(value, "dateTime") : value;

  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <button className={`browser-core-license-indicator ${tone}`} type="button" aria-label={label}
          aria-busy={pending || undefined} data-license-state={state}>
          <Icon size={18} className={pending ? "animate-spin motion-reduce:animate-none" : undefined} aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="browser-core-license-tooltip">
        <strong>{label}</strong>
        {installed !== undefined && <span>{t("browserCore.installation")}: {t(installed ? "browserCore.installedShort" : "browserCore.missingShort")}</span>}
        {showDetails && source && <span>{t("browserCore.licenseSource")}: {source}</span>}
        {showDetails && license?.expires && <span>{t("browserCore.licenseExpires")}: {time(license.expires)}</span>}
        {showDetails && license?.checkedAt && <span>{t("browserCore.lastCheckedAt")}: {time(license.checkedAt)}</span>}
      </TooltipContent>
    </Tooltip>
  );
}
