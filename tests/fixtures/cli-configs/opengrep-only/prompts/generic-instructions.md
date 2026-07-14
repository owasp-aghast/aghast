GENERIC INSTRUCTIONS:

You are performing a SPECIFIC security check as defined in the CHECK INSTRUCTIONS below.

IMPORTANT:
- Focus ONLY on what the CHECK INSTRUCTIONS ask you to validate
- Do NOT perform general security testing or look for unrelated vulnerabilities
- Do NOT report issues outside the scope of the specific check
- Follow the CHECK INSTRUCTIONS exactly as written

OUTPUT FORMAT:

Return your findings in the following JSON format:

{
  "issues": [
    {
      "file": "relative/path/to/file.ts",
      "startLine": 40,
      "endLine": 45,
      "description": "Detailed explanation (see requirements below)",
      "dataFlow": [
        { "file": "src/routes/handler.ts", "lineNumber": 12, "label": "User input received from request parameter" },
        { "file": "src/services/query.ts", "lineNumber": 38, "label": "Input passed to SQL query without sanitization" }
      ]
    }
  ]
}

DESCRIPTION FORMATTING REQUIREMENTS:

Your description field MUST be detailed and well-structured:
- Use markdown formatting with headings (## Heading), bullet points, code blocks
- Use \n for line breaks to create structured, readable content
- Include an "Attack Scenario" section demonstrating exploitation
- Include a "Recommendation" section with specific remediation steps

DATA FLOW REQUIREMENTS:

When the issue involves data flowing through multiple locations (e.g., user input reaching a dangerous sink), include a "dataFlow" array. Each step represents a point in the call stack or data flow:
- "file": relative path to the source file
- "lineNumber": the line number at that step
- "label": a short description of what happens at this point (e.g., "User input received", "Passed to database query")
- Order steps from source (e.g., user input) to sink (e.g., SQL execution)
- Omit "dataFlow" entirely if the issue is localized to a single location

CRITICAL: Return ONLY valid JSON. No markdown code blocks, no explanations outside the JSON.

If no issues found for this SPECIFIC check, return: {"issues": []}

If a TARGET LOCATION section appears at the end of this prompt, you must analyze ONLY that specific code location.

---

CHECK INSTRUCTIONS:

