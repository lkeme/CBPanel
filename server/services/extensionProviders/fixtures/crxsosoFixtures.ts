export const TAMPERMONKEY_ID = "dhdgffkkebhmkfjojejmpbldmpobfkfo";
export const UBLOCK_ORIGIN_ID = "cjpalhdlnbpafiamejdnhcphjbkeiagm";
export const ADBLOCK_ID = "gighmmpiobklfepjocnamgkkbiglidom";

export const crxsosoFirstPageFixture: unknown = {
  code: 200,
  data: {
    extensionList: [
      {
        crxId: TAMPERMONKEY_ID,
        name: "Tampermonkey",
        shortDescription: "Userscript manager",
        activeInstallCount: 12_000_000,
        categoryName: "Productivity",
        averageRating: "4.7",
        ratingCount: 90_000,
        iconUrl: "https://provider.invalid/raw-icon.png",
      },
      {
        crxId: "youxiaohoubox",
        name: "Noncanonical alias",
        shortDescription: "Must not become a store identity",
        activeInstallCount: 1,
        categoryName: "Tools",
        averageRating: "4.0",
      },
      {
        crxId: TAMPERMONKEY_ID,
        name: "Duplicate must not replace the first row",
        shortDescription: "Duplicate",
        activeInstallCount: 1,
        categoryName: "Tools",
        averageRating: "1.0",
      },
      {
        crxId: UBLOCK_ORIGIN_ID,
        name: "uBlock Origin",
        shortDescription: null,
        activeInstallCount: 8_000_000,
        categoryName: null,
        averageRating: 4.8,
      },
    ],
    nextToken: "opaque-provider-token-2",
    nextPageNo: 2,
    hasMorePages: true,
  },
};

export const crxsosoNextPageFixture: unknown = {
  code: 200,
  data: {
    extensionList: [
      {
        crxId: ADBLOCK_ID,
        name: "AdBlock",
        shortDescription: "Block ads",
        activeInstallCount: 65_000_000,
        categoryName: "Privacy",
        averageRating: "4.5",
      },
    ],
    nextToken: null,
    nextPageNo: null,
    hasMorePages: false,
  },
};

export const crxsosoEmptyPageFixture: unknown = {
  code: 200,
  data: {
    extensionList: [],
    hasMorePages: false,
  },
};

export const crxsosoSchemaDriftFixture: unknown = {
  code: 200,
  data: {
    extensions: [],
    hasMorePages: false,
  },
};

export const crxsosoArtifactFixture: unknown = {
  code: 200,
  dlink: "https://c2.crxsoso.com/download/current.crx?token=raw-crx-token",
  dlinkOffline: [
    {
      format: ".zip",
      dlink: "https://c2.crxsoso.com/download/provider-history.zip?token=raw-zip-token",
      version: "1.0.0",
    },
    {
      format: ".crx",
      dlink: "https://c2.crxsoso.com/download/current.crx?token=raw-crx-token",
      version: "1.0.0",
    },
  ],
  dlinkHistory: null,
};
