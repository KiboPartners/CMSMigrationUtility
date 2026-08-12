import { describe, it, expect } from "vitest";
import {
  resolveAbsoluteRange,
  parseFlexibleDate,
  zonedWallToUtc,
  freezeFilterSpec,
  buildWhereForArtifact,
  buildDateWhere,
  describeFilterPlan,
  matchCatalogItem,
  validateFilterSpec,
  mergeCliOverrides,
  emptyFilterSpec,
  isFilterActive,
  capsFromInputFieldNames,
  DEFAULT_WHERE_CAPS,
  type CatalogItem,
  resolveModelTitleField,
  filterBadgeKind,
  needsScanConfirm,
} from "../src/shared/filters";

describe("resolveAbsoluteRange", () => {
  const now = new Date("2026-07-15T12:00:00.000Z");

  it("resolves last_7d from now", () => {
    const r = resolveAbsoluteRange(
      { field: "createdOn", mode: "relative", preset: "last_7d" },
      "UTC",
      now
    );
    expect(r.wireField).toBe("createdOn");
    expect(r.to).toContain("2026-07-15");
    expect(new Date(r.from).getTime()).toBeLessThan(now.getTime());
    const days = (new Date(r.to).getTime() - new Date(r.from).getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  it("maps modifiedOn → savedOn wire field", () => {
    const r = resolveAbsoluteRange(
      { field: "modifiedOn", mode: "relative", preset: "last_24h" },
      "UTC",
      now
    );
    expect(r.wireField).toBe("savedOn");
  });

  it("rejects from after to", () => {
    expect(() =>
      resolveAbsoluteRange(
        {
          field: "createdOn",
          mode: "absolute",
          preset: "custom",
          from: "2026-07-20",
          to: "2026-07-10",
        },
        "UTC",
        now
      )
    ).toThrow(/from is after to/);
  });

  it("interprets custom datetime-local in the given timezone", () => {
    const r = resolveAbsoluteRange(
      {
        field: "createdOn",
        mode: "absolute",
        preset: "custom",
        from: "2026-07-15T09:30",
        to: "2026-07-15T17:00",
      },
      "America/New_York",
      now
    );
    // 09:30 EDT (UTC-4) → 13:30Z
    expect(r.from).toBe("2026-07-15T13:30:00.000Z");
    expect(r.to).toBe("2026-07-15T21:00:00.000Z");
  });
});

describe("parseFlexibleDate / zonedWallToUtc", () => {
  it("date-only endOfDay in UTC", () => {
    expect(parseFlexibleDate("2026-07-15", true, "UTC").toISOString()).toBe("2026-07-15T23:59:59.999Z");
    expect(parseFlexibleDate("2026-07-15", false, "UTC").toISOString()).toBe("2026-07-15T00:00:00.000Z");
  });

  it("zonedWallToUtc for America/New_York summer", () => {
    expect(zonedWallToUtc("2026-07-15", "00:00:00.000", "America/New_York").toISOString()).toBe(
      "2026-07-15T04:00:00.000Z"
    );
  });
});

describe("freezeFilterSpec", () => {
  it("freezes relative preset once", () => {
    const now = new Date("2026-07-15T12:00:00.000Z");
    const frozen = freezeFilterSpec(
      {
        date: { field: "createdOn", mode: "relative", preset: "last_7d" },
        fields: [],
        timezone: "UTC",
      },
      now
    );
    expect(frozen.date?.mode).toBe("absolute");
    expect(frozen.date?.from).toBeTruthy();
    expect(frozen.date?.to).toBeTruthy();
    expect(frozen.frozenAt).toContain("2026-07-15");
  });
});

describe("buildDateWhere", () => {
  it("emits suffix between when both ends set", () => {
    const w = buildDateWhere("createdOn", "a", "b", DEFAULT_WHERE_CAPS["cms-entry"]);
    expect(w).toEqual({ createdOn_between: ["a", "b"] });
  });
});

describe("buildWhereForArtifact / describeFilterPlan", () => {
  const frozen = freezeFilterSpec(
    {
      date: {
        field: "createdOn",
        mode: "absolute",
        preset: "custom",
        from: "2026-01-01",
        to: "2026-01-31",
      },
      fields: [
        { artifact: "cms-entry", field: "siteId", op: "eq", value: "kibo-us" },
        { field: "name", op: "contains", value: "hero" },
      ],
      timezone: "UTC",
    },
    new Date("2026-07-15T12:00:00.000Z")
  );

  it("CMS: date + values.siteId + title_contains pushdown", () => {
    const plan = buildWhereForArtifact("cms-entry", frozen, undefined, {
      modelTitleFields: ["title"],
      hasSiteId: true,
    });
    expect(plan.cost).toBe("pushdown");
    expect(plan.where).toMatchObject({
      createdOn_between: expect.any(Array),
      values: { siteId: "kibo-us", title_contains: "hero" },
    });
    expect(plan.pushdown.some((c) => c.key === "date")).toBe(true);
    expect(plan.residual).toHaveLength(0);
  });

  it("files: tags_in + name_contains", () => {
    const spec = freezeFilterSpec({
      fields: [
        { artifact: "file", field: "tags", op: "in", value: ["a", "b"] },
        { artifact: "file", field: "name", op: "contains", value: "banner" },
      ],
      timezone: "UTC",
    });
    const plan = describeFilterPlan("file", spec);
    expect(plan.where).toMatchObject({
      tags_in: ["a", "b"],
      name_contains: "banner",
    });
    expect(plan.cost).toBe("pushdown");
  });

  it("files: name with hyphen/dot is residual (ES/Lucene breaks on - .)", () => {
    const spec = freezeFilterSpec({
      fields: [{ artifact: "file", field: "name", op: "contains", value: "my-file.jpg" }],
      timezone: "UTC",
    });
    const plan = buildWhereForArtifact("file", spec);
    expect(plan.where?.name_contains).toBeUndefined();
    expect(plan.residual.some((c) => c.key === "name" && c.detail.includes("my-file.jpg"))).toBe(true);
    expect(
      matchCatalogItem(
        { type: "file", id: "f1", label: "my-file.jpg", metadata: { name: "my-file.jpg", key: "folder/my-file.jpg" } },
        spec,
        { full: true }
      )
    ).toBe(true);
  });

  it("CMS: title with hyphen is residual when would have been title_contains", () => {
    const spec = freezeFilterSpec({
      fields: [{ artifact: "cms-entry", field: "name", op: "contains", value: "pre-owned" }],
      timezone: "UTC",
    });
    const plan = buildWhereForArtifact("cms-entry", spec, undefined, { modelTitleFields: ["title"] });
    expect(plan.where?.values).toBeUndefined();
    expect(plan.residual.some((c) => c.key === "name")).toBe(true);
  });

  it("pages: date pushdown + name residual → mixed", () => {
    const plan = buildWhereForArtifact("page", frozen);
    expect(plan.pushdown.some((c) => c.key === "date")).toBe(true);
    expect(plan.residual.some((c) => c.key === "name" || c.key === "title")).toBe(true);
    expect(plan.cost).toBe("mixed");
  });

  it("redirects: redirectFrom_contains", () => {
    const spec = freezeFilterSpec({
      fields: [{ artifact: "redirect", field: "from", op: "contains", value: "/old" }],
      timezone: "UTC",
    });
    const plan = buildWhereForArtifact("redirect", spec);
    expect(plan.where).toMatchObject({ redirectFrom_contains: "/old" });
  });

  it("CMS multi-name emits OR of title_contains", () => {
    const spec = freezeFilterSpec({
      fields: [{ artifact: "cms-entry", field: "name", op: "contains", value: ["hero", "banner"] }],
      timezone: "UTC",
    });
    const plan = buildWhereForArtifact("cms-entry", spec, undefined, {
      modelTitleFields: ["title"],
      hasSiteId: true,
    });
    expect(plan.where?.OR).toEqual([
      { values: { title_contains: "hero" } },
      { values: { title_contains: "banner" } },
    ]);
  });

  it("per-artifact name does not apply to other types", () => {
    const spec = freezeFilterSpec({
      fields: [{ artifact: "cms-entry", field: "name", op: "contains", value: "hero" }],
      timezone: "UTC",
    });
    expect(buildWhereForArtifact("file", spec).where).toBeNull();
    expect(buildWhereForArtifact("cms-entry", spec, undefined, { modelTitleFields: ["title"] }).where).toMatchObject({
      values: { title_contains: "hero" },
    });
  });
});

describe("matchCatalogItem residual", () => {
  const item: CatalogItem = {
    type: "page",
    id: "p1",
    label: "Home Hero",
    metadata: { path: "/home", createdOn: "2026-01-15T00:00:00.000Z", status: "published" },
  };

  it("matches name contains on label (OR across commas)", () => {
    const spec = freezeFilterSpec({
      fields: [{ artifact: "page", field: "name", op: "contains", value: ["zzz", "Hero"] }],
      timezone: "UTC",
    });
    expect(matchCatalogItem(item, spec, { full: true })).toBe(true);
    expect(
      matchCatalogItem(
        item,
        freezeFilterSpec({
          fields: [{ artifact: "page", field: "name", op: "contains", value: ["zzz", "nope"] }],
          timezone: "UTC",
        }),
        { full: true }
      )
    ).toBe(false);
  });

  it("matches path residual", () => {
    const spec = freezeFilterSpec({
      fields: [{ field: "path", op: "contains", value: "/home" }],
      timezone: "UTC",
    });
    expect(matchCatalogItem(item, spec, { residualKeys: new Set(["path"]), full: false })).toBe(true);
  });

  it("uses dates[artifact] for date match, not another artifact's range", () => {
    const now = new Date("2026-07-15T12:00:00.000Z");
    const pageItem: CatalogItem = {
      type: "page",
      id: "p1",
      label: "Home",
      metadata: { createdOn: "2026-01-15T00:00:00.000Z" },
    };
    const fileItem: CatalogItem = {
      type: "file",
      id: "f1",
      label: "banner.png",
      metadata: { createdOn: "2026-01-15T00:00:00.000Z" },
    };
    const frozen = freezeFilterSpec(
      {
        timezone: "UTC",
        date: {
          field: "createdOn",
          mode: "absolute",
          preset: "custom",
          from: "2026-06-01",
          to: "2026-07-31",
        },
        dates: {
          page: {
            field: "createdOn",
            mode: "absolute",
            preset: "custom",
            from: "2026-02-01",
            to: "2026-03-31",
          },
          file: {
            field: "createdOn",
            mode: "absolute",
            preset: "custom",
            from: "2026-01-01",
            to: "2026-01-31",
          },
        },
        fields: [],
      },
      now
    );
    // Jan 15 is inside legacy date and dates.file, but outside dates.page
    expect(matchCatalogItem(pageItem, frozen, { full: true })).toBe(false);
    expect(matchCatalogItem(fileItem, frozen, { full: true })).toBe(true);
    expect(
      matchCatalogItem(
        { ...pageItem, metadata: { createdOn: "2026-02-15T00:00:00.000Z" } },
        frozen,
        { full: true }
      )
    ).toBe(true);
  });
});

describe("validateFilterSpec + mergeCliOverrides", () => {
  it("validates and merges site-id / tags", () => {
    const raw = validateFilterSpec({
      timezone: "America/New_York",
      fields: [{ field: "name", op: "contains", value: "x" }],
    });
    const merged = mergeCliOverrides(raw, { siteId: "site-1", tags: "a,b" });
    expect(merged.fields.some((f) => f.field === "siteId" && f.value === "site-1")).toBe(true);
    expect(merged.fields.some((f) => f.field === "tags")).toBe(true);
  });

  it("emptyFilterSpec is inactive until filled", () => {
    expect(emptyFilterSpec().fields).toEqual([]);
    expect(isFilterActive(emptyFilterSpec())).toBe(false);
  });

  it("custom date without from/to is inactive and must not freeze", () => {
    const raw = validateFilterSpec({
      timezone: "UTC",
      fields: [],
      date: { field: "createdOn", mode: "absolute", preset: "custom" },
    });
    expect(isFilterActive(raw)).toBe(false);
    // Callers must check isFilterActive before freeze — freeze would throw.
    expect(() => freezeFilterSpec(raw)).toThrow(/from and\/or to/);
  });
});

describe("capsFromInputFieldNames", () => {
  it("fail-closed when date suffix ops absent", () => {
    const caps = capsFromInputFieldNames("page", ["status", "location"]);
    expect(caps.dates.createdOn).toBe(false);
    expect(caps.fields.status).toBe(true);
  });

  it("detects file name_contains and tags_in", () => {
    const caps = capsFromInputFieldNames("file", ["name_contains", "tags_in", "createdOn_gte"]);
    expect(caps.fields.nameContains).toBe(true);
    expect(caps.fields.tagsIn).toBe(true);
    expect(caps.dates.createdOn).toBe(true);
  });
});

describe("resolveModelTitleField", () => {
  it("prefers settings.title", () => {
    expect(
      resolveModelTitleField([
        { fieldId: "name", type: "text" },
        { fieldId: "headline", type: "text", settings: { title: true } },
      ])
    ).toBe("headline");
  });

  it("prefers title among text fields", () => {
    expect(
      resolveModelTitleField([
        { fieldId: "slug", type: "text" },
        { fieldId: "title", type: "text" },
        { fieldId: "body", type: "long-text" },
      ])
    ).toBe("title");
  });

  it("returns null when nothing title-like", () => {
    expect(resolveModelTitleField([{ fieldId: "ref", type: "ref" }])).toBeNull();
  });
});

describe("per-artifact dates", () => {
  const now = new Date("2026-07-15T12:00:00.000Z");

  it("freezeFilterSpec freezes dates map with per-artifact timezones", () => {
    const frozen = freezeFilterSpec(
      {
        timezone: "UTC",
        dateTimezones: { "cms-entry": "America/New_York", file: "UTC" },
        dates: {
          "cms-entry": { field: "createdOn", mode: "relative", preset: "last_7d" },
          file: { field: "modifiedOn", mode: "relative", preset: "last_24h" },
        },
        fields: [],
      },
      now
    );
    expect(frozen.date).toBeUndefined();
    expect(frozen.dates?.["cms-entry"]?.wireField).toBe("createdOn");
    expect(frozen.dates?.file?.wireField).toBe("savedOn");
    expect(frozen.dates?.["cms-entry"]?.from).toBeTruthy();
    expect(frozen.dates?.file?.from).toBeTruthy();
    // Different presets → different window lengths
    const entrySpan =
      new Date(frozen.dates!["cms-entry"]!.to).getTime() -
      new Date(frozen.dates!["cms-entry"]!.from).getTime();
    const fileSpan =
      new Date(frozen.dates!.file!.to).getTime() - new Date(frozen.dates!.file!.from).getTime();
    expect(entrySpan).toBeGreaterThan(fileSpan);
  });

  it("buildWhereForArtifact prefers dates[artifact] over legacy date", () => {
    const frozen = freezeFilterSpec(
      {
        timezone: "UTC",
        date: { field: "createdOn", mode: "relative", preset: "last_30d" },
        dates: {
          page: { field: "createdOn", mode: "relative", preset: "last_24h" },
        },
        fields: [],
      },
      now
    );
    const pagePlan = buildWhereForArtifact("page", frozen);
    const entryPlan = buildWhereForArtifact("cms-entry", frozen);
    expect(pagePlan.pushdown.some((p) => p.key === "date")).toBe(true);
    expect(entryPlan.pushdown.some((p) => p.key === "date")).toBe(true);
    // page uses last_24h; entry falls back to legacy last_30d — spans differ
    const pageDetail = pagePlan.pushdown.find((p) => p.key === "date")!.detail;
    const entryDetail = entryPlan.pushdown.find((p) => p.key === "date")!.detail;
    expect(pageDetail).not.toEqual(entryDetail);
  });

  it("isFilterActive is true when only dates map is set", () => {
    expect(
      isFilterActive({
        timezone: "UTC",
        dates: { redirect: { field: "createdOn", mode: "relative", preset: "last_7d" } },
        fields: [],
      })
    ).toBe(true);
  });

  it("legacy top-level date still freezes when dates is absent", () => {
    const frozen = freezeFilterSpec(
      {
        timezone: "UTC",
        date: { field: "createdOn", mode: "relative", preset: "last_7d" },
        fields: [],
      },
      now
    );
    expect(frozen.date?.wireField).toBe("createdOn");
    expect(frozen.dates).toBeUndefined();
  });

  it("dateTimezones shifts frozen UTC boundaries for date-only ranges", () => {
    const frozen = freezeFilterSpec(
      {
        timezone: "UTC",
        dateTimezones: { page: "America/New_York", file: "UTC" },
        dates: {
          page: {
            field: "createdOn",
            mode: "absolute",
            preset: "custom",
            from: "2026-07-15",
            to: "2026-07-15",
          },
          file: {
            field: "createdOn",
            mode: "absolute",
            preset: "custom",
            from: "2026-07-15",
            to: "2026-07-15",
          },
        },
        fields: [],
      },
      now
    );
    expect(frozen.dates!.file!.from).toBe("2026-07-15T00:00:00.000Z");
    expect(frozen.dates!.file!.to).toBe("2026-07-15T23:59:59.000Z");
    expect(frozen.dates!.page!.from).toBe("2026-07-15T04:00:00.000Z");
    expect(frozen.dates!.page!.to).toBe("2026-07-16T03:59:59.000Z");
    expect(frozen.dates!.page!.from).not.toEqual(frozen.dates!.file!.from);
    expect(frozen.dates!.page!.to).not.toEqual(frozen.dates!.file!.to);
  });

  it("dateTimezones shifts this_month freeze when calendar month differs by zone", () => {
    const boundary = new Date("2026-07-01T02:00:00.000Z"); // still June 30 in America/Los_Angeles
    const utcMonth = freezeFilterSpec(
      {
        timezone: "UTC",
        dates: { page: { field: "createdOn", mode: "relative", preset: "this_month" } },
        fields: [],
      },
      boundary
    );
    const laMonth = freezeFilterSpec(
      {
        timezone: "UTC",
        dateTimezones: { page: "America/Los_Angeles" },
        dates: { page: { field: "createdOn", mode: "relative", preset: "this_month" } },
        fields: [],
      },
      boundary
    );
    expect(utcMonth.dates!.page!.from).toBe("2026-07-01T00:00:00.000Z");
    expect(laMonth.dates!.page!.from).toBe("2026-06-01T00:00:00.000Z");
    expect(laMonth.dates!.page!.from).not.toEqual(utcMonth.dates!.page!.from);
  });
});

describe("filterBadgeKind / needsScanConfirm", () => {
  it("marks pages+name as mixed", () => {
    const spec = freezeFilterSpec({
      fields: [{ artifact: "page", field: "name", op: "contains", value: "x" }],
      timezone: "UTC",
    });
    expect(filterBadgeKind(["page", "cms-entry"], spec)).toBe("mixed");
  });

  it("source when only siteId on cms-entry", () => {
    const spec = freezeFilterSpec({
      fields: [{ artifact: "cms-entry", field: "siteId", op: "eq", value: "us" }],
      timezone: "UTC",
    });
    expect(filterBadgeKind(["cms-entry"], spec)).toBe("source");
    expect(needsScanConfirm(["cms-entry"], spec)).toBe(false);
  });
});
