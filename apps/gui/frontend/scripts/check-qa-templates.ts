/*
 * Enforce the QA templates in tests/ps-qa/templates.ron.
 *
 * `check-ui-controls.ts` already proves every imported input primitive names
 * some ps-qa outcome. That is not enough: `15-select.ron` named two outcomes,
 * passed 2/2, and covered a Select that could not select. It asserted
 * `SelectionChanges` on an *option* node, whose own selected flag flips whether
 * or not the value ever reaches the trigger the reader actually looks at.
 *
 * So this gate checks the shape of each check rather than its existence:
 *
 *   1. every component type used by the application has the checks its
 *      template requires, by suffix; and
 *   2. each of those checks asserts one of the expectations the template
 *      allows, on a subject of the role the template requires.
 *
 * Rule (2) is what makes the weak assertion unspellable. A `value` check must
 * name the value-bearing control as its subject, so "assert on the option" is
 * rejected at lint time rather than discovered by an owner months later.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..", "..", "..", "..");
const qaRoot = join(repositoryRoot, "tests", "ps-qa");
// Templates live outside the checks directory: ps-qa parses every .ron under
// tests/ps-qa as a check list, so a template file there fails the harness's own
// manifest validation before any check can run.
const templatesFile = join(repositoryRoot, "tests", "qa-templates", "templates.ron");

type Requirement = {
  suffix: string;
  expect: string[];
  subjectRole: string[] | null;
  why: string;
};
type Template = { kind: string; appliesTo: string[]; required: Requirement[] };

/*
 * A deliberately small reader for the subset of RON these files use. Pulling a
 * parser in for four record shapes would be a dependency nobody chose, and the
 * failure mode of a wrong read here is a loud one: a missing template turns
 * into "unknown component type", not a silent pass.
 */
function parseTemplates(source: string): Template[] {
  const templates: Template[] = [];
  const blocks = source.split(/\n\s*\(\s*\n\s*kind:/).slice(1);

  for (const block of blocks) {
    const kind = block.match(/^\s*"([^"]+)"/)?.[1];
    const appliesTo = [
      ...(block.match(/applies_to:\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g),
    ].map((match) => match[1]);
    if (!kind) continue;

    const required: Requirement[] = [];
    for (const line of block.matchAll(
      /\(suffix:\s*"([^"]+)",\s*expect:\s*"([^"]+)",\s*subject_role:\s*(?:Some\("([^"]+)"\)|None),\s*why:\s*"([^"]*)"\)/g,
    )) {
      required.push({
        suffix: line[1],
        expect: line[2].split("|"),
        subjectRole: line[3] ? line[3].split("|") : null,
        why: line[4],
      });
    }
    templates.push({ kind, appliesTo, required });
  }
  return templates;
}

type Check = { id: string; expect: string; subject: string; file: string };

function parseChecks(): Check[] {
  const checks: Check[] = [];
  for (const name of readdirSync(qaRoot)) {
    if (!name.endsWith(".ron")) continue;
    const source = readFileSync(join(qaRoot, name), "utf8");
    for (const record of source.matchAll(
      /id:\s*"([^"]+)"[\s\S]*?subject:\s*"([^"]+)"[\s\S]*?expect:\s*(\w+)/g,
    )) {
      checks.push({ id: record[1], subject: record[2], expect: record[3], file: name });
    }
  }
  return checks;
}

const templates = parseTemplates(readFileSync(templatesFile, "utf8"));
const checks = parseChecks();

/*
 * Which component types this application actually uses. Read from the same
 * coverage map check-ui-controls.ts maintains, so the two gates cannot disagree
 * about what is in play.
 */
const controlsGate = readFileSync(join(import.meta.dir, "check-ui-controls.ts"), "utf8");
const coverage = new Map<string, string[]>();
const coverageBlock =
  controlsGate.match(/const inputCoverage[^=]*=\s*\{([\s\S]*?)\n\};/)?.[1] ?? "";
for (const entry of coverageBlock.matchAll(/(\w+):\s*\[([\s\S]*?)\]/g)) {
  coverage.set(
    entry[1],
    [...entry[2].matchAll(/"([^"]+)"/g)].map((match) => match[1]),
  );
}

const violations: string[] = [];

for (const [component, outcomeIds] of coverage) {
  const template = templates.find((candidate) => candidate.appliesTo.includes(component));
  if (!template) {
    violations.push(
      `${component}: no template in templates.ron covers this component type, so nothing says what its checks must assert`,
    );
    continue;
  }

  const named = outcomeIds
    .map((id) => checks.find((check) => check.id === id))
    .filter((check): check is Check => Boolean(check));

  for (const requirement of template.required) {
    const matching = named.filter((check) => check.id.includes(requirement.suffix));
    if (matching.length === 0) {
      violations.push(
        `${component}: template "${template.kind}" requires a "${requirement.suffix}" check. ${requirement.why}`,
      );
      continue;
    }

    for (const check of matching) {
      if (!requirement.expect.includes(check.expect)) {
        violations.push(
          `${check.file}: ${check.id} asserts ${check.expect}, but a "${requirement.suffix}" check on a ${template.kind} control must assert one of ${requirement.expect.join("|")}. ${requirement.why}`,
        );
      }
      /*
       * Only an explicit, wrong role is a violation. A bare accessible name
       * ("Glass", "Response verbosity for this project") resolves to whatever
       * the renderer says that control is, which is the ordinary way to name a
       * subject and is not what went wrong here. What went wrong was naming a
       * *different node than the one the reader reads* — `option:...` on a
       * check that is supposed to prove the trigger updated.
       */
      if (requirement.subjectRole && check.subject.includes(":")) {
        const role = check.subject.split(":")[0];
        if (!requirement.subjectRole.includes(role)) {
          violations.push(
            `${check.file}: ${check.id} asserts on subject "${check.subject}", but a "${requirement.suffix}" check on a ${template.kind} control must assert on a ${requirement.subjectRole.join("|")}. ${requirement.why}`,
          );
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error("QA template violations:");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log(
  `QA templates: ${coverage.size} component types matched to ${templates.length} templates; every required check present and asserting on the right subject`,
);
