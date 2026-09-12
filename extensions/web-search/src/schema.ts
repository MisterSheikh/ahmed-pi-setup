import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const text = (maxLength: number, description?: string) =>
  Type.String({ minLength: 1, maxLength, pattern: "\\S", description });
const integer = () =>
  Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const ref = () =>
  text(
    4096,
    "Reference from this Pi session, or an HTTP(S) URL. Re-search after a fork or expired reference.",
  );
const bounded = <T extends ReturnType<typeof Type.Object>>(item: T) =>
  Type.Optional(Type.Array(item, { minItems: 1, maxItems: 4 }));

export const webSchema = Type.Object(
  {
    search_query: bounded(
      Type.Object(
        {
          q: text(2048, "Web search query."),
          recency: Type.Optional(
            Type.Integer({
              minimum: 0,
              maximum: Number.MAX_SAFE_INTEGER,
              description: "Restrict search recency in days.",
            }),
          ),
          domains: Type.Optional(
            Type.Array(text(253), { minItems: 1, maxItems: 10 }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    open: bounded(
      Type.Object(
        {
          ref_id: ref(),
          lineno: Type.Optional(integer()),
        },
        { additionalProperties: false },
      ),
    ),
    click: bounded(
      Type.Object(
        {
          ref_id: ref(),
          id: integer(),
        },
        { additionalProperties: false },
      ),
    ),
    find: bounded(
      Type.Object(
        {
          ref_id: ref(),
          pattern: text(1024, "Text to find in the page."),
        },
        { additionalProperties: false },
      ),
    ),
    response_length: Type.Optional(
      StringEnum(["short", "medium", "long"] as const, {
        description: "Defaults to short.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type WebInput = Static<typeof webSchema>;

/** Revalidate here because Pi tool_call hooks can mutate arguments after validation. */
export function validateCommands(input: unknown): WebInput {
  if (!Check(webSchema, input))
    throw new Error(
      "web: invalid arguments. Use the documented search_query, open, click, or find schema.",
    );
  const count =
    (input.search_query?.length ?? 0) +
    (input.open?.length ?? 0) +
    (input.click?.length ?? 0) +
    (input.find?.length ?? 0);
  if (!count || count > 8)
    throw new Error(
      "web: supply between 1 and 8 operations total, with at most 4 per operation array.",
    );
  // Snapshot validated data before any async work. Never send arbitrary extra fields.
  return JSON.parse(JSON.stringify(input)) as WebInput;
}
