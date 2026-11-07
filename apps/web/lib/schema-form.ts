/**
 * Turn an analysis' JSON Schema (generated from its Pydantic params model) into form fields.
 * Column pickers are declared on the backend with `column_param(...)`, which emits
 * `x-widget: "column"` / `"columns"` and an optional `x-kinds` filter.
 */
import type { ColumnInfo, ColumnKind } from "@/lib/api/types";

export type FieldWidget = "column" | "columns" | "number" | "integer" | "boolean" | "select" | "text";

export interface FormField {
  name: string;
  label: string;
  description?: string;
  widget: FieldWidget;
  required: boolean;
  default?: unknown;
  options?: string[];
  kinds?: ColumnKind[];
  minimum?: number;
  maximum?: number;
}

type JsonSchema = {
  type?: string | string[];
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  $ref?: string;
  "x-widget"?: string;
  "x-kinds"?: ColumnKind[];
  $defs?: Record<string, JsonSchema>;
};

function resolve(schema: JsonSchema, root: JsonSchema): JsonSchema {
  if (schema.$ref) {
    const name = schema.$ref.split("/").pop() ?? "";
    return { ...(root.$defs?.[name] ?? {}), ...schema, $ref: undefined };
  }
  if (schema.anyOf) {
    const concrete = schema.anyOf.find((s) => s.type !== "null");
    if (concrete) return { ...resolve(concrete, root), ...schema, anyOf: undefined };
  }
  return schema;
}

function humanize(name: string) {
  const text = name.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function fieldsFromSchema(input: Record<string, unknown>): FormField[] {
  const root = input as JsonSchema;
  const required = new Set(root.required ?? []);
  return Object.entries(root.properties ?? {}).map(([name, raw]) => {
    const schema = resolve(raw, root);
    const xWidget = raw["x-widget"] ?? schema["x-widget"];
    const kinds = raw["x-kinds"] ?? schema["x-kinds"];
    const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
    let widget: FieldWidget = "text";
    if (xWidget === "column" || xWidget === "columns") widget = xWidget;
    else if (schema.enum) widget = "select";
    else if (type === "integer") widget = "integer";
    else if (type === "number") widget = "number";
    else if (type === "boolean") widget = "boolean";
    const minimum = schema.minimum ?? schema.exclusiveMinimum;
    const maximum = schema.maximum ?? schema.exclusiveMaximum;
    return {
      name,
      label: schema.title && schema.title !== humanize(name) ? schema.title : humanize(name),
      description: schema.description,
      widget,
      required: required.has(name),
      default: schema.default,
      options: schema.enum?.map(String),
      kinds,
      minimum,
      maximum,
    } satisfies FormField;
  });
}

export function defaultValues(fields: FormField[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.default !== undefined && field.default !== null) values[field.name] = field.default;
    else if (field.widget === "columns") values[field.name] = [];
    else if (field.widget === "boolean") values[field.name] = false;
  }
  return values;
}

export function columnsForField(field: FormField, columns: ColumnInfo[]): ColumnInfo[] {
  if (!field.kinds?.length) return columns;
  return columns.filter((column) => field.kinds!.includes(column.kind));
}

/** Labels of required fields that are still empty; an empty list means the form can be submitted. */
export function missingRequired(fields: FormField[], values: Record<string, unknown>): string[] {
  return fields
    .filter((field) => field.required)
    .filter((field) => {
      const value = values[field.name];
      return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
    })
    .map((field) => field.label);
}

/** Drop empty optional values so backend defaults apply. */
export function cleanValues(fields: FormField[], values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.name];
    if (value === undefined || value === "" || value === null) continue;
    if (Array.isArray(value) && value.length === 0 && !field.required) continue;
    if ((field.widget === "number" || field.widget === "integer") && typeof value === "string") {
      const n = Number(value);
      if (Number.isFinite(n)) out[field.name] = field.widget === "integer" ? Math.round(n) : n;
      continue;
    }
    out[field.name] = value;
  }
  return out;
}
