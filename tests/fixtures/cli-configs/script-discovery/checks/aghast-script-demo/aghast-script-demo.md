### Script Discovery Demo

#### Overview
A demo check that uses script discovery to enumerate target locations.

#### What to Check
1. Each script-discovered target represents a place worth analyzing.
2. The AI is given the file + line range and decides whether the code is vulnerable.

#### Result
- **PASS**: AI returns no issues for any target.
- **FAIL**: AI returns at least one issue.
