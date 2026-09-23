/**
 * Soft-wrap newlines are spaces.
 *
 * A paragraph is separated by a blank line, so any single newline inside one is
 * a wrap in the source rather than a break the author asked for. HTML collapses
 * such a newline to a space between two words, which is why this looked correct
 * until an inline element sat next to one: a text node ending in `"and\n"`
 * followed by a `<code>` element has its trailing whitespace dropped at the
 * element boundary, and the sentence renders as "and`WireMessage::Text`now".
 *
 * Normalising before the inline split keeps the space inside the text node,
 * where the boundary cannot eat it.
 *
 * Its own module so a test can reach it without importing the renderer, which
 * pulls in the component library and its motion entry point.
 */
export function softWrapToSpaces(text: string): string {
  return text.replace(/\n/g, " ");
}
