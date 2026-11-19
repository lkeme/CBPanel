import type { BrowserCorePrivateRelease } from "../../shared/browserCore";

/** A catalog belongs to the repository that produced it. */
export interface PrivateCoreCatalog {
  repositoryUrl: string;
  loaded: boolean;
  releases: BrowserCorePrivateRelease[];
}

export function emptyPrivateCoreCatalog(): PrivateCoreCatalog {
  return { repositoryUrl: "", loaded: false, releases: [] };
}

export function privateCoreConfigurationDirty(savedRepositoryUrl: string, draftRepositoryUrl: string, draftToken: string): boolean {
  return savedRepositoryUrl.trim() !== draftRepositoryUrl.trim() || Boolean(draftToken.trim());
}

export function receivePrivateCoreCatalog(repositoryUrl: string, releases: BrowserCorePrivateRelease[]): PrivateCoreCatalog {
  return { repositoryUrl, loaded: true, releases };
}
