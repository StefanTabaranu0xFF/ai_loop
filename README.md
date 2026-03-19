# ai_loop

`ai_loop.js` is a goal-driven Node.js coding loop for local Ollama models such as `gemma3:12b`. It can:

- read input artifacts produced by OpenLab,
- analyze the files to infer likely format, record counts, and candidate fields,
- ask an Ollama model to generate or repair a C# solution,
- write the returned files into a workspace,
- compile, test, and optionally run the solution,
- feed the real command output back to the model until the goal is achieved or the retry limit is reached.

## How it works

1. You provide a goal, for example: "Generate C# code that reads OpenLab `.amx` files and prints a record summary".
2. `ai_loop.js` reads the files under `--openlab-path`, infers whether they look like XML, JSON, delimited text, key/value text, binary, or unknown `.amx` data, and extracts candidate field names and record estimates.
3. The script calls the local Ollama HTTP API and requests a strict JSON response containing the files to write.
4. The generated files are written into `--workspace`.
5. Before running `dotnet build`, the loop checks that the model actually produced a `.csproj` or `.sln` file.
6. If validation fails, the exact structural/build/test/runtime output is sent back to the model for the next repair attempt.

## Requirements

- Node.js 18+
- A running Ollama server (default: `http://127.0.0.1:11434`)
- A .NET SDK installation for commands such as `dotnet build`, `dotnet test`, and `dotnet run`

## Example

```bash
node ai_loop.js \
  "Create a C# console app that reads all .amx files produced by OpenLab and prints the number of records and extracts information from the files." \
  --model gemma3:12b \
  --openlab-path ./openlab/Methods \
  --workspace ./generated_solution \
  --build-command "dotnet build" \
  --build-command "dotnet test --no-build" \
  --run-command "dotnet run --no-build" \
  --success-substring "records"
```

## Useful options

- `--dry-run`: print the fully constructed prompt without calling Ollama.
- `--build-command ...`: provide one or more validation commands.
- `--run-command ""`: skip the runtime execution step.
- `--max-iterations N`: control how many repair rounds the loop performs.
- `--file-limit N`: limit how many OpenLab files are inlined into the prompt.
- `--ollama-host URL`: point to a non-default Ollama server.

## Behavior improvements

- If `--openlab-path` is wrong, the CLI now tries to suggest nearby matching directories from the current working tree.
- The OpenLab prompt context now includes inferred file format, size, record estimates, candidate field names, and a preview or hex sample for each analyzed file.
- If the model forgets to generate a `.csproj` or `.sln`, the loop fails fast with a targeted repair message instead of only surfacing `MSB1003`.
- Network failures to Ollama now include a clearer hint to check that Ollama is running and the requested model is installed.

## Notes

- The script writes prompts, model responses, and command results to `.ai_loop/` inside the workspace for inspection.
- The generated solution is constrained to stay inside the workspace directory.
- The repository includes Node.js tests for prompt construction, path safety, OpenLab ingestion, missing-path diagnostics, and loop orchestration helpers.
