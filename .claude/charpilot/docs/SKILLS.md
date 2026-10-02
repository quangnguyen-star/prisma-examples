# The skill

`SKILL.md` is the procedure — the order, the judgement calls, the exit
condition, and the traps. `../tools/` is the commands. They live together so
they cannot drift apart.

Nine files, not one. `SKILL.md` is the router: it carries onboarding, the loop,
the invariants that hold in every stage, and the failure modes that read as
success. One directory per skill beside it holds the per-stage depth the
router deliberately leaves out.

## Install

`install.sh` does this as part of onboarding a repo — per repo, so a checkout
carries its own copy and a local edit is never clobbered by the next install:

```bash
bash nodejs/tools/install.sh <package-root>
```

To install them for every repo on the machine instead:

```bash
# The layout here is EXACTLY the layout of an install, so this is a copy with
# no special cases - and `cmp` can compare any two locations path for path.
cp -R nodejs/skill/charpilot* ~/.claude/skills/
```

Then, in the target repo: *"onboard this repo to characterization testing"*.

**A target with the tools and no skills is the failure mode this layout exists
to stop.** The agent finds forty-three scripts, no order to run them in, no exit
condition, and none of the traps — and the traps are the half that cost two
services to learn.

## What each one is for

| file | when it is read |
|---|---|
| `SKILL.md` | first, always — onboarding, the loop, the invariants, where a question routes |
| `charpilot-stage-1-baseline` | the suite is red, or a number needs its denominator |
| `charpilot-stage-2-scan` | the arm count disagrees with istanbul, or an arm id went stale |
| `charpilot-stage-3-derive-input` | **the agent's stage** — what input takes the other side of this arm |
| `charpilot-stage-4-record` | it will not run: harness failure, blocked egress, a stale row |
| `charpilot-stage-5-emit-tests` | writing the test from the pair, or a generated test fails |
| `charpilot-stage-6-measure` | a claim came back FALSE, or a percentage needs its denominator |
| `charpilot-stage-7-deadcode-and-ruling` | nothing can reach this side — price it, place it, rule it |
| `charpilot-stage-8-mutate` | the tests pass and assert nothing |

## The rule they all rest on

**The agent derives the input. The machine records the output. Neither does the
other's half.** `tools/validate.mjs` enforces it as a hard rejection rather than
a warning: `expected`, `expects`, `returns`, `assert` and `snapshot` are refused
on a proposal, because an agent that writes an expected value can assume an
output, assert its own assumption, and then edit source until the assumption
holds.
