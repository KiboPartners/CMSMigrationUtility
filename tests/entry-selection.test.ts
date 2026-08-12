import { describe, it, expect } from "vitest";
import { unwrapType, introspectedFieldLines, entryDisplayLines } from "../src/artifacts/cms-entries/entry-selection";

// Minimal fake GraphQLClient: answers __type(name:"X") introspection from a map.
function mockClient(types: Record<string, Array<{ name: string; type: unknown }>>) {
  return {
    request: async (q: string) => {
      const m = q.match(/__type\(name:\s*"([^"]+)"\)/);
      const name = m && m[1];
      return { __type: name && types[name] ? { kind: "OBJECT", fields: types[name] } : null };
    },
  } as unknown as Parameters<typeof introspectedFieldLines>[0];
}
const scalar = (name: string) => ({ name, type: { kind: "SCALAR", name: "String" } });
const obj = (name: string, typeName: string) => ({ name, type: { kind: "OBJECT", name: typeName } });

describe("unwrapType", () => {
  it("returns a named scalar as-is", () => {
    expect(unwrapType({ kind: "SCALAR", name: "String" })).toEqual({ kind: "SCALAR", name: "String" });
  });

  it("unwraps NON_NULL → LIST → SCALAR", () => {
    expect(unwrapType({
      kind: "NON_NULL", name: null,
      ofType: { kind: "LIST", name: null, ofType: { kind: "SCALAR", name: "Int" } },
    })).toEqual({ kind: "SCALAR", name: "Int" });
  });

  it("unwraps to an OBJECT type name", () => {
    expect(unwrapType({
      kind: "LIST", name: null,
      ofType: { kind: "NON_NULL", name: null, ofType: { kind: "OBJECT", name: "PromoBannerBlock" } },
    })).toEqual({ kind: "OBJECT", name: "PromoBannerBlock" });
  });

  it("handles null/undefined", () => {
    expect(unwrapType(null)).toEqual({ kind: "", name: null });
  });
});

describe("introspectedFieldLines", () => {
  it("expands BOTH sibling fields of the same object type (no cross-sibling pruning)", async () => {
    const client = mockClient({
      Query: [obj("listFoos", "FooResp")],
      FooResp: [{ name: "data", type: { kind: "LIST", name: null, ofType: { kind: "OBJECT", name: "Foo" } } }],
      Foo: [obj("values", "FooValues"), scalar("id")],
      FooValues: [obj("linkA", "Link"), obj("linkB", "Link"), scalar("title")],
      Link: [scalar("url"), scalar("label")],
    });
    const map = await introspectedFieldLines(client, { listOperation: "listFoos" } as never);
    expect(map).not.toBeNull();
    expect(map!.get("title")).toBe("title");
    // Sibling fields under the same parent must both remain in the selection.
    expect(map!.get("linkA")).toBe("linkA { url label }");
    expect(map!.get("linkB")).toBe("linkB { url label }");
  });

  it("returns null when the values type can't be resolved", async () => {
    const client = mockClient({ Query: [] });
    expect(await introspectedFieldLines(client, { listOperation: "listFoos" } as never)).toBeNull();
  });
});

describe("entryDisplayLines", () => {
  it("includes meta { status version title } when the entry type has a meta field", async () => {
    const client = mockClient({
      Query: [obj("listFoos", "FooResp")],
      FooResp: [{ name: "data", type: { kind: "LIST", name: null, ofType: { kind: "OBJECT", name: "Foo" } } }],
      Foo: [
        obj("values", "FooValues"),
        scalar("id"),
        scalar("createdOn"),
        scalar("savedOn"),
        obj("meta", "FooMeta"),
        obj("createdBy", "FooUser"),
      ],
      FooMeta: [scalar("status"), scalar("version"), scalar("title")],
      FooUser: [scalar("displayName"), scalar("id")],
    });
    const lines = await entryDisplayLines(client, "listFoos");
    expect(lines).toContain("meta { status version title }");
    expect(lines).toContain("createdOn");
    expect(lines).toContain("savedOn");
  });

  it("returns an empty array when the entry type can't be resolved", async () => {
    const client = mockClient({ Query: [] });
    expect(await entryDisplayLines(client, "listFoos")).toEqual([]);
  });
});
