import assert from "node:assert/strict";
import test from "node:test";

import { defaultProfile, type BrowserProfile } from "../../src/shared/profile";
import { SessionService } from "../services/sessionService";
import { launchProfileFromRequest, stopProfileFromRequest } from "./sessionRequest";

class RouteRaceSessionService extends SessionService {
  startCount = 0;

  protected override async startRuntime() {
    this.startCount += 1;
    return {
      close: async () => undefined,
      pageUrl: () => "about:blank",
      ready: Promise.resolve({}),
    };
  }
}

test("route coordination lets tokened Stop overtake a delayed profile read without starting runtime", async () => {
  const service = new RouteRaceSessionService({
    browserDataDir: "data/browser-data-test",
    readBinaryInfo: async () => ({ installed: true, binaryPath: "C:/fake/chrome.exe", version: "test" }),
  });
  const profile = defaultProfile({ id: "delayed-route-profile-read-test" });
  const launchRequestId = "launch-delayed-profile-read";
  let releaseProfile!: (profile: BrowserProfile) => void;
  const profileGate = new Promise<BrowserProfile>((resolve) => {
    releaseProfile = resolve;
  });
  let profileReads = 0;

  const launching = launchProfileFromRequest(
    profile.id,
    { launchRequestId },
    async (profileId) => {
      profileReads += 1;
      assert.equal(profileId, profile.id);
      return profileGate;
    },
    service,
    "profile missing",
  );
  assert.equal(profileReads, 1);

  const stopped = await stopProfileFromRequest(
    profile.id,
    { launchRequestId },
    service,
  );
  assert.equal(stopped.status, "stopped");
  releaseProfile(profile);

  await assert.rejects(launching, (error) => {
    assert.equal((error as { status?: number }).status, 409);
    assert.equal((error as { code?: string }).code, "BROWSER_LAUNCH_CANCELLED");
    return true;
  });
  assert.equal(service.startCount, 0);
  assert.deepEqual(service.listSessions(), []);
});

test("route coordination rejects an invalid launch request identity before reading the profile", async () => {
  const service = new RouteRaceSessionService({
    browserDataDir: "data/browser-data-test",
    readBinaryInfo: async () => ({ installed: true, binaryPath: "C:/fake/chrome.exe", version: "test" }),
  });
  let profileReads = 0;

  await assert.rejects(
    launchProfileFromRequest(
      "invalid-token-route-test",
      { launchRequestId: "contains spaces" },
      async () => {
        profileReads += 1;
        return undefined;
      },
      service,
      "profile missing",
    ),
    (error) => {
      assert.equal((error as { status?: number }).status, 400);
      assert.equal((error as { code?: string }).code, "LAUNCH_REQUEST_ID_INVALID");
      return true;
    },
  );
  assert.equal(profileReads, 0);
  assert.equal(service.startCount, 0);
});
