import { describe, expect, it } from "vitest";
import { NoteTypeDef } from "../src/schema";
import { coerce, computeSafeFixes, matchesType, validateFrontmatter } from "../src/validate";

const bookType: NoteTypeDef = {
	fields: {
		title: { type: "string", required: true },
		rating: { type: "number" },
		read: { type: "boolean" },
		finished: { type: "date" },
		status: { type: "enum", values: ["to-read", "reading", "done"], required: true, default: "to-read" },
		genres: { type: "list", values: ["sci-fi", "fantasy", "non-fiction"] },
		tags: { type: "list" },
	},
};

function errors(v: ReturnType<typeof validateFrontmatter>) {
	return v.filter((x) => x.severity === "error");
}
function warnings(v: ReturnType<typeof validateFrontmatter>) {
	return v.filter((x) => x.severity === "warning");
}

describe("matchesType", () => {
	it("checks strings, numbers and booleans strictly", () => {
		expect(matchesType("x", { type: "string" })).toBe(true);
		expect(matchesType(3, { type: "string" })).toBe(false);
		expect(matchesType(3.5, { type: "number" })).toBe(true);
		expect(matchesType(NaN, { type: "number" })).toBe(false);
		expect(matchesType("3", { type: "number" })).toBe(false);
		expect(matchesType(true, { type: "boolean" })).toBe(true);
		expect(matchesType("true", { type: "boolean" })).toBe(false);
	});

	it("accepts Date objects and ISO-ish strings for dates", () => {
		expect(matchesType(new Date(), { type: "date" })).toBe(true);
		expect(matchesType("2026-08-25", { type: "date" })).toBe(true);
		expect(matchesType("2026-08-25T10:30", { type: "date" })).toBe(true);
		expect(matchesType("Aug 25, 2026", { type: "date" })).toBe(false);
		expect(matchesType("2026-8-25", { type: "date" })).toBe(false);
	});

	it("enum requires membership, list requires an array", () => {
		expect(matchesType("done", { type: "enum", values: ["done"] })).toBe(true);
		expect(matchesType("Done", { type: "enum", values: ["done"] })).toBe(false); // case-sensitive
		expect(matchesType("done", { type: "enum" })).toBe(false); // no values declared
		expect(matchesType(["a"], { type: "list" })).toBe(true);
		expect(matchesType("a", { type: "list" })).toBe(false);
	});
});

describe("validateFrontmatter", () => {
	it("accepts a fully valid note", () => {
		const v = validateFrontmatter(
			{ title: "Dune", rating: 5, read: true, finished: "2026-01-02", status: "done", genres: ["sci-fi"] },
			"book",
			bookType,
		);
		expect(v).toEqual([]);
	});

	it("flags missing required fields (null counts as missing) but not missing optionals", () => {
		const v = validateFrontmatter({ title: null }, "book", bookType);
		const msgs = errors(v).map((x) => x.message);
		expect(msgs).toHaveLength(2);
		expect(msgs.find((m) => m.includes('"title"'))).toContain("Missing required field");
		expect(msgs.find((m) => m.includes('"status"'))).toContain("one of the allowed values");
		// rating/read/finished/genres are optional -> no violations for them
		expect(v.some((x) => x.field === "rating")).toBe(false);
	});

	it("treats an entirely missing frontmatter object as all-missing", () => {
		const v = validateFrontmatter(undefined, "book", bookType);
		expect(errors(v).map((x) => x.field).sort()).toEqual(["status", "title"]);
	});

	it("flags type mismatches with the expected kind in the message", () => {
		const v = validateFrontmatter(
			{ title: 42, rating: "five", finished: "someday", status: "done" },
			"book",
			bookType,
		);
		const byField = Object.fromEntries(v.map((x) => [x.field, x]));
		expect(byField.title.message).toContain("should be a string");
		expect(byField.rating.message).toContain("should be a number");
		expect(byField.finished.message).toContain("a date (YYYY-MM-DD)");
		expect(Object.values(byField).every((x) => x.severity === "error")).toBe(true);
	});

	it("flags enum violations and lists the allowed values", () => {
		const v = validateFrontmatter({ title: "Dune", status: "abandoned" }, "book", bookType);
		const e = errors(v);
		expect(e).toHaveLength(1);
		expect(e[0].field).toBe("status");
		expect(e[0].message).toContain('"status" = "abandoned" is not allowed');
		expect(e[0].message).toContain("to-read, reading, done");
	});

	it("flags disallowed list members when the list declares values", () => {
		const v = validateFrontmatter(
			{ title: "Dune", status: "done", genres: ["sci-fi", "romance", 7] },
			"book",
			bookType,
		);
		const e = errors(v);
		expect(e).toHaveLength(1);
		expect(e[0].field).toBe("genres");
		expect(e[0].message).toContain('"romance"');
		expect(e[0].message).toContain("7");
		expect(e[0].message).toContain("allowed: sci-fi, fantasy, non-fiction");
	});

	it("does not constrain members of a list without values", () => {
		const v = validateFrontmatter({ title: "Dune", status: "done", tags: ["anything", 3] }, "book", bookType);
		expect(v).toEqual([]);
	});

	it("warns about unknown fields but always allows the reserved `type` key", () => {
		const v = validateFrontmatter(
			{ type: "book", title: "Dune", status: "done", publisher: "Ace" },
			"book",
			bookType,
		);
		expect(errors(v)).toHaveLength(0);
		const w = warnings(v);
		expect(w).toHaveLength(1);
		expect(w[0].field).toBe("publisher");
		expect(w[0].message).toContain('not declared in type "book"');
	});
});

describe("coerce", () => {
	it("converts numeric strings but rejects ambiguous ones", () => {
		expect(coerce("42", { type: "number" })).toEqual({ ok: true, value: 42 });
		expect(coerce(" 3.5 ", { type: "number" })).toEqual({ ok: true, value: 3.5 });
		expect(coerce("", { type: "number" })).toEqual({ ok: false });
		expect(coerce("   ", { type: "number" })).toEqual({ ok: false });
		expect(coerce("five", { type: "number" })).toEqual({ ok: false });
		expect(coerce(true, { type: "number" })).toEqual({ ok: false });
	});

	it("converts only literal true/false strings to booleans", () => {
		expect(coerce("true", { type: "boolean" })).toEqual({ ok: true, value: true });
		expect(coerce(" FALSE ", { type: "boolean" })).toEqual({ ok: true, value: false });
		expect(coerce("yes", { type: "boolean" })).toEqual({ ok: false });
		expect(coerce(1, { type: "boolean" })).toEqual({ ok: false });
	});

	it("wraps a lone scalar into a list, but never null/undefined", () => {
		expect(coerce("solo", { type: "list" })).toEqual({ ok: true, value: ["solo"] });
		expect(coerce(7, { type: "list" })).toEqual({ ok: true, value: [7] });
		expect(coerce(null, { type: "list" })).toEqual({ ok: false });
		expect(coerce(undefined, { type: "list" })).toEqual({ ok: false });
	});

	it("respects a list's values allow-list when wrapping", () => {
		const def = { type: "list" as const, values: ["a", "b"] };
		expect(coerce("a", def)).toEqual({ ok: true, value: ["a"] });
		expect(coerce("z", def)).toEqual({ ok: false });
		expect(coerce(3, def)).toEqual({ ok: false });
	});

	it("stringifies numbers and booleans, and never coerces dates or enums", () => {
		expect(coerce(5, { type: "string" })).toEqual({ ok: true, value: "5" });
		expect(coerce(true, { type: "string" })).toEqual({ ok: true, value: "true" });
		expect(coerce({ a: 1 }, { type: "string" })).toEqual({ ok: false });
		expect(coerce("2026-01-01", { type: "date" })).toEqual({ ok: false });
		expect(coerce("done", { type: "enum", values: ["done"] })).toEqual({ ok: false });
	});
});

describe("computeSafeFixes", () => {
	it("inserts a declared default for a missing required field", () => {
		const fixes = computeSafeFixes({ title: "Dune" }, bookType);
		expect(fixes).toHaveLength(1);
		expect(fixes[0].field).toBe("status");
		expect(fixes[0].description).toContain('"to-read"');
		const fm: Record<string, unknown> = { title: "Dune" };
		fixes[0].apply(fm);
		expect(fm.status).toBe("to-read");
	});

	it("offers no fix for missing required fields without a default", () => {
		const fixes = computeSafeFixes({ status: "done" }, bookType);
		expect(fixes.some((f) => f.field === "title")).toBe(false);
	});

	it("offers coercion fixes only for unambiguous mistypes", () => {
		const fm = { title: "Dune", status: "done", rating: "4", read: "true", finished: "someday" };
		const fixes = computeSafeFixes(fm, bookType);
		expect(fixes.map((f) => f.field).sort()).toEqual(["rating", "read"]);
	});

	it("fix + re-validate round-trip clears the violations it targeted", () => {
		const fm: Record<string, unknown> = { title: "Dune", rating: "4", read: "false" };
		expect(errors(validateFrontmatter(fm, "book", bookType))).toHaveLength(3);
		for (const fix of computeSafeFixes(fm, bookType)) fix.apply(fm);
		expect(fm).toEqual({ title: "Dune", rating: 4, read: false, status: "to-read" });
		expect(validateFrontmatter(fm, "book", bookType)).toEqual([]);
	});

	it("returns nothing for an already-valid note", () => {
		expect(computeSafeFixes({ title: "Dune", status: "done" }, bookType)).toEqual([]);
	});
});
