/** Turning an artboard title into the identifiers the emitters need. */

const WORDS = /[^\p{L}\p{N}]+/u;

function words(name: string): string[] {
  return name
    .split(WORDS)
    .flatMap((part) => part.split(/(?<=\p{Ll})(?=\p{Lu})/u))
    .filter((part) => part.length > 0);
}

/**
 * `Sign-up form` becomes `SignUpForm`.
 *
 * A name that starts with a digit gets a leading underscore rather than a
 * rejection. The artboard title is a human label and should not be able to
 * make the emitter refuse to emit.
 */
export function pascalCase(name: string, fallback = "Untitled"): string {
  const parts = words(name);
  if (parts.length === 0) return fallback;
  const joined = parts.map((part) => part[0].toUpperCase() + part.slice(1)).join("");
  return /^\p{N}/u.test(joined) ? `_${joined}` : joined;
}

/** `Sign-up form` becomes `signUpForm`, for the recipe's exported const. */
export function camelCase(name: string, fallback = "untitled"): string {
  const pascal = pascalCase(name, "");
  if (pascal === "") return fallback;
  return pascal[0].toLowerCase() + pascal.slice(1);
}

/** `Sign-up form` becomes `sign-up-form`, for a recipe's `component` key. */
export function kebabCase(name: string, fallback = "untitled"): string {
  const parts = words(name);
  if (parts.length === 0) return fallback;
  return parts.map((part) => part.toLowerCase()).join("-");
}
