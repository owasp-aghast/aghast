### Glob Discovery Test

#### Overview
Validates that glob-based discovery walks the repository and produces whole-file targets.

#### What to Check
1. Each matching TypeScript source file is presented to the AI as a whole-file target
2. The discovery does not pick up files outside the glob pattern

#### Result
- **PASS**: No issues are reported by the AI
- **FAIL**: The AI reports any issue
