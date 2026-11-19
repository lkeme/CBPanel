import type { BrowserProfile, SessionSummary } from "../../src/shared/profile";

type SessionLifecycle = {
  launchProfile(profile: BrowserProfile, launchRequestId?: string): Promise<SessionSummary>;
  stopProfile(profileId: string, launchRequestId?: string): Promise<SessionSummary>;
};

export async function launchProfileFromRequest(
  profileId: string,
  body: unknown,
  readProfile: (profileId: string) => Promise<BrowserProfile | undefined>,
  sessions: Pick<SessionLifecycle, "launchProfile">,
  missingProfileMessage: string,
): Promise<SessionSummary> {
  // Parse before the repository await. A Stop carrying the same identity may overtake that read and
  // register cancellation before launchProfile is allowed to create its generation.
  const launchRequestId = optionalLaunchRequestId(body);
  const profile = await readProfile(profileId);
  if (!profile) throw Object.assign(new Error(missingProfileMessage), { status: 404 });
  return sessions.launchProfile(profile, launchRequestId);
}

export function stopProfileFromRequest(
  profileId: string,
  body: unknown,
  sessions: Pick<SessionLifecycle, "stopProfile">,
): Promise<SessionSummary> {
  return sessions.stopProfile(profileId, optionalLaunchRequestId(body));
}

export function optionalLaunchRequestId(body: unknown): string | undefined {
  const value = (body as { launchRequestId?: unknown } | null | undefined)?.launchRequestId;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(value)) {
    throw Object.assign(new Error("launchRequestId must be a short opaque identifier"), {
      status: 400,
      code: "LAUNCH_REQUEST_ID_INVALID",
    });
  }
  return value;
}
