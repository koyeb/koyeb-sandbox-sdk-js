# Koyeb Sandbox examples

Each numbered example checks the result that it shows.
The runner requires one scenario for every number from 01 through 31.
It rejects missing or duplicate scenario numbers.

Build and check all examples:

```bash
pnpm examples:check
```

Run all examples against Koyeb:

```bash
cp .env.example .env
# Edit .env and set KOYEB_API_TOKEN.
pnpm examples:e2e
```

The examples load the repository `.env` file automatically.
Existing shell variables take priority over values from `.env`.

Run selected examples:

```bash
pnpm examples:e2e -- --flows 01_create_sandbox,03_basic_commands
```

The snapshot benchmark uses 10 MB and one boot by default.
Set `KOYEB_SNAPSHOT_BENCHMARK_SIZE_MB` or `KOYEB_SNAPSHOT_BENCHMARK_BOOTS` to change these values.

The GitHub Actions workflow needs the `KOYEB_API_TOKEN` repository secret.
It also accepts `KOYEB_API_HOST`, `KOYEB_PROJECT_ID`, `KOYEB_REGION`, and
`KOYEB_NETWORK_POLICY_REGION` and `KOYEB_SERVICE_POOL_REGION` repository variables.
GitHub Actions does not use the local `.env` file.
The API token selects the Koyeb organization.
`KOYEB_PROJECT_ID` selects the project inside that organization.
