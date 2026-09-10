# Koyeb Sandbox examples

Each numbered example checks the result that it shows.

Build and check all examples:

```bash
pnpm examples:check
```

Run all examples against Koyeb:

```bash
export KOYEB_API_TOKEN="your-token"
export KOYEB_PROJECT_ID="your-project-id" # Optional
export KOYEB_REGION="na"                  # Optional
pnpm examples:e2e
```

Run selected examples:

```bash
pnpm examples:e2e -- --flows 01_create_sandbox,03_basic_commands
```

The snapshot benchmark uses 10 MB and one boot by default.
Set `KOYEB_SNAPSHOT_BENCHMARK_SIZE_MB` or `KOYEB_SNAPSHOT_BENCHMARK_BOOTS` to change these values.

The GitHub Actions workflow needs the `KOYEB_API_TOKEN` repository secret.
It also accepts `KOYEB_API_HOST`, `KOYEB_PROJECT_ID`, and `KOYEB_REGION` repository variables.
The API token selects the Koyeb organization.
`KOYEB_PROJECT_ID` selects the project inside that organization.
