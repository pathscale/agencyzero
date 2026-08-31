import { describe, expect, it } from "vitest";
import { lookup } from "../catalog";
import { createNode, emptyDocument, insert, ROOT_ID, setProp, setText } from "../document";
import { emit } from "./index";

/**
 * The emitted source is the deliverable, so it is asserted as text.
 *
 * H6 said this exactly: dragging a Button onto an empty canvas must emit the
 * import and the element, and that is a string comparison rather than a
 * screenshot. Nothing in this file mounts anything.
 */

function entry(name: string) {
  const found = lookup(name);
  if (!found) throw new Error(`no catalog entry named ${name}`);
  return found;
}

function withButton() {
  return insert(emptyDocument(), ROOT_ID, 0, createNode(entry("Button"), "b1"));
}

describe("the TSX emitter", () => {
  it("emits exactly the import and the element for one dropped Button", () => {
    const [file] = emit(withButton(), "tsx");

    expect(file.path).toBe("Untitled.tsx");
    expect(file.source).toBe(
      [
        'import { Button } from "@pathscale/ui";',
        "",
        "export function Untitled() {",
        "  return <Button>Button</Button>;",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("emits null for an empty artboard and imports nothing", () => {
    const [file] = emit(emptyDocument(), "tsx");

    expect(file.source).toContain("return null;");
    expect(file.source).not.toContain("@pathscale/ui");
  });

  it("wraps two siblings in a fragment and never wraps one", () => {
    const one = withButton();
    const two = insert(one, ROOT_ID, 1, createNode(entry("Badge"), "g1"));

    expect(emit(one, "tsx")[0].source).not.toContain("<>");
    expect(emit(two, "tsx")[0].source).toContain("<>");
  });

  it("names the component after the artboard", () => {
    const document = { ...withButton(), name: "sign-up form" };

    expect(emit(document, "tsx")[0].source).toContain("export function SignUpForm()");
    expect(emit(document, "tsx")[0].path).toBe("SignUpForm.tsx");
  });

  it("deduplicates the import when a component appears twice", () => {
    const twice = insert(withButton(), ROOT_ID, 1, createNode(entry("Button"), "b2"));

    expect(emit(twice, "tsx")[0].source.match(/@pathscale\/ui/g)).toHaveLength(1);
    expect(emit(twice, "tsx")[0].source).toContain('import { Button } from "@pathscale/ui";');
  });

  it("imports Card once for its compound parts", () => {
    let document = insert(emptyDocument(), ROOT_ID, 0, createNode(entry("Card"), "c1"));
    document = insert(document, "c1", 0, createNode(entry("Card.Body"), "c2"));

    const source = emit(document, "tsx")[0].source;
    expect(source).toContain('import { Card } from "@pathscale/ui";');
    expect(source).toContain("<Card.Body></Card.Body>");
  });

  it("prints each prop kind in its own JSX form", () => {
    let document = withButton();
    document = setProp(document, "b1", "flavor", "destructive");
    document = insert(document, ROOT_ID, 1, createNode(entry("Progress"), "p1"));
    document = insert(document, ROOT_ID, 2, createNode(entry("Card"), "k1"));
    document = setProp(document, "k1", "isInteractive", true);

    const source = emit(document, "tsx")[0].source;
    expect(source).toContain('flavor="destructive"');
    expect(source).toContain("value={60}");
    expect(source).toContain("<Card isInteractive>");
  });

  it("omits a prop set back to the component's own default", () => {
    const document = setProp(withButton(), "b1", "variant", "solid");

    expect(emit(document, "tsx")[0].source).not.toContain("variant");
  });

  it("escapes text that JSX would otherwise read as syntax", () => {
    const document = setText(withButton(), "b1", "Save {now}");

    expect(emit(document, "tsx")[0].source).toContain('{"Save {now}"}');
  });
});

describe("the solid-layouts emitter", () => {
  it("emits a template and a recipe as a pair", () => {
    const files = emit(withButton(), "layout");

    expect(files.map((file) => file.path)).toEqual(["Untitled.layout.tsx", "Untitled.recipe.ts"]);
  });

  it("gives the template one root element carrying slot.root", () => {
    const [template] = emit(withButton(), "layout");

    expect(template.source).toBe(
      [
        'import { Button } from "@pathscale/ui";',
        'import type { Layout } from "solid-layouts";',
        'import { untitled } from "./Untitled.recipe";',
        "",
        "export type UntitledProps = Record<string, never>;",
        "",
        "const Untitled: Layout<typeof untitled, UntitledProps> = () => (",
        "  <div {...slot.root}>",
        "    <Button>Button</Button>",
        "  </div>",
        ");",
        "",
        "export const UntitledLayout = Untitled;",
        "export default Untitled;",
        "",
      ].join("\n"),
    );
  });

  it("names the recipe's component in kebab case", () => {
    const [, recipe] = emit({ ...withButton(), name: "Sign up form" }, "layout");

    expect(recipe.source).toContain('component: "sign-up-form",');
    expect(recipe.source).toContain("export const signUpForm = recipe({");
  });
});
