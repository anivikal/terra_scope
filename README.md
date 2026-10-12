# TerraScope

TerraScope turns Terraform source files into a local, interactive architecture explorer. It parses Terraform resource blocks, detects explicit references and selected event triggers, explains known services, and surfaces static security signals and illustrative cost ranges.

## Run locally

Requires Python 3.10 or newer. No third-party Python packages are needed.

```powershell
python server.py
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000). The server binds to loopback only. Terraform source is analyzed locally; it is only sent to Google if you explicitly request Gemini analysis.

Choose **Upload Terraform** to select a project folder or individual `.tf` / `.tf.json` files. You can also explore the included sample from the empty-project screen. Terraform state files are excluded because they can contain secrets.

## Optional Gemini explanations

To enable detailed AI-generated architecture explanations, set `GEMINI_API_KEY` in the project-root `.env` file. Never paste the key into chat or commit `.env`. Restart `python server.py` after changing environment settings. `GEMINI_MODEL` is optional and defaults to `gemini-3.8-flash`; set it to another model available to your API key if desired.

Gemini is called only when you press **Ask Gemini**. That request sends a Terraform-derived architecture summary, service/resource identifiers, selected configuration, detected findings, and cost ranges to Google's Gemini API. Raw Terraform files and state files are not sent to Google. Sensitive configuration keys and common credential formats are excluded or redacted before the request; review the details before sending if resource names or non-secret configuration are confidential. Gemini usage is subject to your Google AI Studio quota and billing.

## What it analyzes

- Resources, modules, variables, outputs, locals, and data sources.
- Direct resource references, displayed as dependencies.
- Explicit S3 notifications, Lambda event-source mappings, EventBridge targets, and SNS subscriptions, displayed as runtime flows.
- Selected configuration signals for S3, IAM, security groups, and RDS.
- Broad, low-confidence monthly cost ranges for common AWS resource types.
- A deterministic, source-grounded architecture summary; the core analyzer does not require credentials.
- Optional on-demand Gemini explanations through Google's Interactions API, configured with a local `.env`.

This is a static source analyzer, not a Terraform evaluator. It does not execute Terraform, resolve module contents, interpolate variables, inspect a cloud account, or confirm deployed settings. Security findings are review prompts; cost ranges are illustrative and should not be used as quotes.

## Tests

```powershell
python -m unittest discover -s tests -v
```

## API

`POST /api/analyze` accepts JSON shaped like:

```json
{
  "files": {
    "main.tf": "resource \"aws_s3_bucket\" \"uploads\" { ... }"
  }
}
```

Only `.tf` and `.tf.json` source files are accepted. Requests are capped at 6 MB and 100 source files.
