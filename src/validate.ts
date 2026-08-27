import { FieldDef, FieldType, NoteTypeDef } from "./schema";

export type Severity = "error" | "warning";

/** A single problem found in a note's frontmatter. */
export interface Violation {
	field: string;
	message: string;
	severity: Severity;
}

/** A safe, mechanical repair that can be applied without guessing intent. */
export interface Fix {
	field: string;
	/** What the fix does, for user feedback. */
	description: string;
	/** Mutates the frontmatter object in place. */
	apply: (frontmatter: Record<string, unknown>) => void;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ].*)?$/;

/** True when `value` already satisfies `type` (no coercion applied). */
export function matchesType(value: unknown, def: FieldDef): boolean {
	switch (def.type) {
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number" && !Number.isNaN(value);
		case "boolean":
			return typeof value === "boolean";
		case "date":
			// parseYaml may hand back a Date or an ISO-ish string.
			return value instanceof Date || (typeof value === "string" && DATE_RE.test(value));
		case "enum":
			return typeof value === "string" && !!def.values && def.values.includes(value);
		case "list":
			return Array.isArray(value);
	}
}

/** Human-friendly name of what a type expects, used in messages. */
function expected(type: FieldType): string {
	switch (type) {
		case "date":
			return "a date (YYYY-MM-DD)";
		case "enum":
			return "one of the allowed values";
		case "list":
			return "a list";
		default:
			return `a ${type}`;
	}
}

/**
 * Try to coerce `value` into `def.type`. Returns `{ ok:true, value }` only for
 * unambiguous conversions; otherwise `{ ok:false }`. Never loses information.
 */
export function coerce(value: unknown, def: FieldDef): { ok: true; value: unknown } | { ok: false } {
	switch (def.type) {
		case "number": {
			if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
				return { ok: true, value: Number(value) };
			}
			return { ok: false };
		}
		case "boolean": {
			if (typeof value === "string") {
				const v = value.trim().toLowerCase();
				if (v === "true") return { ok: true, value: true };
				if (v === "false") return { ok: true, value: false };
			}
			return { ok: false };
		}
		case "list": {
			// A lone scalar where a list is expected can be safely wrapped — but only
			// when the result would actually be valid (respect a `values` allow-list).
			if (value !== null && value !== undefined && !Array.isArray(value)) {
				if (def.values && def.values.length > 0) {
					if (typeof value === "string" && def.values.includes(value)) {
						return { ok: true, value: [value] };
					}
					return { ok: false };
				}
				return { ok: true, value: [value] };
			}
			return { ok: false };
		}
		case "string": {
			if (typeof value === "number" || typeof value === "boolean") {
				return { ok: true, value: String(value) };
			}
			return { ok: false };
		}
		default:
			return { ok: false };
	}
}

/**
 * Validate a frontmatter object against a note type.
 * Produces errors (missing required, wrong type, bad enum) and warnings (unknown fields).
 */
export function validateFrontmatter(
	frontmatter: Record<string, unknown> | undefined,
	typeName: string,
	def: NoteTypeDef,
): Violation[] {
	const fm = frontmatter ?? {};
	const violations: Violation[] = [];

	for (const [name, field] of Object.entries(def.fields)) {
		const present = name in fm && fm[name] !== null && fm[name] !== undefined;
		if (!present) {
			if (field.required) {
				violations.push({
					field: name,
					message: `Missing required field "${name}" (${expected(field.type)})`,
					severity: "error",
				});
			}
			continue;
		}
		const value = fm[name];
		if (field.type === "enum") {
			if (!matchesType(value, field)) {
				const allowed = field.values?.join(", ") ?? "";
				violations.push({
					field: name,
					message: `Field "${name}" = ${JSON.stringify(value)} is not allowed (expected: ${allowed})`,
					severity: "error",
				});
			}
			continue;
		}
		if (!matchesType(value, field)) {
			violations.push({
				field: name,
				message: `Field "${name}" should be ${expected(field.type)}, got ${JSON.stringify(value)}`,
				severity: "error",
			});
			continue;
		}
		// List members are validated against `values` when the field declares them.
		if (field.type === "list" && field.values && field.values.length > 0) {
			const allowed = field.values;
			const bad = (value as unknown[]).filter(
				(member) => typeof member !== "string" || !allowed.includes(member),
			);
			if (bad.length > 0) {
				violations.push({
					field: name,
					message:
						`Field "${name}" contains disallowed value(s) ` +
						`${bad.map((b) => JSON.stringify(b)).join(", ")} (allowed: ${allowed.join(", ")})`,
					severity: "error",
				});
			}
		}
	}

	// Unknown fields are warnings only; `type` is the reserved discriminator and always allowed.
	for (const key of Object.keys(fm)) {
		if (key === "type") continue;
		if (!(key in def.fields)) {
			violations.push({
				field: key,
				message: `Unknown field "${key}" is not declared in type "${typeName}"`,
				severity: "warning",
			});
		}
	}

	return violations;
}

/**
 * Compute the set of safe fixes for a note: insert missing required fields that
 * have a declared default, and coerce obviously-mistyped values.
 * Only reversible, intent-preserving repairs are returned.
 */
export function computeSafeFixes(
	frontmatter: Record<string, unknown> | undefined,
	def: NoteTypeDef,
): Fix[] {
	const fm = frontmatter ?? {};
	const fixes: Fix[] = [];

	for (const [name, field] of Object.entries(def.fields)) {
		const present = name in fm && fm[name] !== null && fm[name] !== undefined;
		if (!present) {
			if (field.required && "default" in field && field.default !== undefined) {
				const def0 = field.default;
				fixes.push({
					field: name,
					description: `Insert "${name}: ${JSON.stringify(def0)}"`,
					apply: (f) => {
						f[name] = def0;
					},
				});
			}
			continue;
		}
		const value = fm[name];
		if (matchesType(value, field)) continue;
		const c = coerce(value, field);
		if (c.ok) {
			fixes.push({
				field: name,
				description: `Coerce "${name}" to ${JSON.stringify(c.value)}`,
				apply: (f) => {
					f[name] = c.value;
				},
			});
		}
	}

	return fixes;
}
