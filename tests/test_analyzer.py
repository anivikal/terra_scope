import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from analyzer import analyze_files, parse_hcl_blocks
from gemini import GeminiError, build_prompt, explain_architecture, load_dotenv


class TerraformAnalyzerTests(unittest.TestCase):
    def test_nested_blocks_and_quoted_braces_parse(self):
        source = '''resource "aws_s3_bucket" "images" {
  bucket = "uploads-{prod}"
  versioning {
    enabled = true
  }
}'''
        blocks, warnings = parse_hcl_blocks(source)
        self.assertEqual([], warnings)
        self.assertEqual(1, len(blocks))
        self.assertIn("enabled = true", blocks[0].body)
        self.assertEqual("aws_s3_bucket", blocks[0].labels[0])

    def test_detects_event_flow_security_and_cost(self):
        files = {
            "main.tf": '''resource "aws_s3_bucket" "uploads" {
  acl = "public-read"
}
resource "aws_lambda_function" "processor" {
  role = aws_iam_role.processor.arn
}
resource "aws_iam_role" "processor" {
}
resource "aws_s3_bucket_notification" "uploads" {
  bucket = aws_s3_bucket.uploads.id
  lambda_function {
    lambda_function_arn = aws_lambda_function.processor.arn
  }
}
resource "aws_instance" "worker" {
  instance_type = "t3.micro"
}'''
        }
        result = analyze_files(files)
        self.assertEqual(5, result["resource_count"])
        self.assertEqual(
            [{"source": "aws_s3_bucket.uploads", "target": "aws_lambda_function.processor", "label": "Object event"}],
            result["runtime_flows"],
        )
        self.assertTrue(any(item["title"] == "Public bucket ACL" for item in result["security"]["findings"]))
        self.assertEqual(25, result["cost"]["monthly_min_usd"])
        self.assertTrue(any(edge["source"] == "aws_iam_role.processor" for edge in result["edges"]))

    def test_state_is_ignored_and_warned(self):
        result = analyze_files({
            "main.tf": 'resource "aws_s3_bucket" "safe" {}',
            "terraform.tfstate": '{"secret": "do-not-parse"}',
        })
        self.assertEqual(1, result["resource_count"])
        self.assertTrue(any("state file" in warning for warning in result["warnings"]))

    def test_invalid_terraform_json_returns_warning(self):
        result = analyze_files({"main.tf.json": "{not json"})
        self.assertEqual(0, result["resource_count"])
        self.assertTrue(any("invalid Terraform JSON" in warning for warning in result["warnings"]))

    def test_separate_bucket_controls_and_data_sources_are_handled(self):
        result = analyze_files({
            "main.tf": '''resource "aws_s3_bucket" "assets" {
  bucket = "assets"
}
resource "aws_s3_bucket_public_access_block" "assets" {
  bucket                  = aws_s3_bucket.assets.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
data "aws_s3_bucket" "existing" {
  bucket = "already-managed"
}'''
        })
        bucket = next(item for item in result["resources"] if item["id"] == "aws_s3_bucket.assets")
        data_source = next(item for item in result["resources"] if item["id"] == "data.aws_s3_bucket.existing")
        self.assertFalse(any(risk["title"] == "Public access block not found" for risk in bucket["risks"]))
        self.assertEqual([], data_source["risks"])
        self.assertIsNone(data_source["cost"])

    def test_terraform_json_resources_are_parsed(self):
        result = analyze_files({
            "main.tf.json": '{"resource":{"aws_s3_bucket":{"uploads":{"bucket":"uploads","acl":"public-read"}}}}'
        })
        self.assertEqual(1, result["resource_count"])
        self.assertTrue(any(risk["title"] == "Public bucket ACL" for risk in result["security"]["findings"]))


class GeminiIntegrationTests(unittest.TestCase):
    def test_dotenv_load_does_not_override_existing_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            env_path = Path(directory) / ".env"
            env_path.write_text('GEMINI_API_KEY="local value"\nGEMINI_MODEL=gemini-test\n', encoding="utf-8")
            with patch.dict(os.environ, {"GEMINI_API_KEY": "existing"}, clear=True):
                load_dotenv(env_path)
                self.assertEqual("existing", os.environ["GEMINI_API_KEY"])
                self.assertEqual("gemini-test", os.environ["GEMINI_MODEL"])

    def test_prompt_redacts_secret_fields_and_does_not_include_raw_source(self):
        prompt = build_prompt({
            "resources": [{
                "id": "aws_instance.web",
                "type": "aws_instance",
                "service": "Amazon EC2",
                "category": "Compute",
                "purpose": "Runs a virtual machine.",
                "configuration": {
                    "instance_type": "t3.micro",
                    "password": "do-not-send-this",
                    "user_data": "private script",
                },
                "features": [],
                "risks": [],
                "cost": None,
            }],
            "edges": [],
            "runtime_flows": [],
            "summary": "Local deterministic summary.",
            "analysis_note": "Static analysis only.",
        })
        self.assertIn("t3.micro", prompt)
        self.assertNotIn("do-not-send-this", prompt)
        self.assertNotIn("private script", prompt)
        self.assertNotIn("raw Terraform source code", prompt)

    def test_prompt_omits_sensitive_variable_defaults_and_caps_large_context(self):
        resources = [{
            "id": f"aws_instance.worker_{index}",
            "type": "aws_instance",
            "service": "Amazon EC2",
            "category": "Compute",
            "purpose": "Runs a virtual machine.",
            "configuration": {f"attribute_{key}": "x" * 500 for key in range(30)},
            "features": [{"feature": "feature", "impact": "x" * 500} for _ in range(50)],
            "risks": [{"title": "signal", "detail": "x" * 500} for _ in range(50)],
            "cost": None,
        } for index in range(50)]
        prompt = build_prompt({
            "resources": resources,
            "variables": [{
                "name": "database_password",
                "configuration": {"default": "never-send-this"},
            }],
        })
        self.assertNotIn("never-send-this", prompt)
        self.assertLess(len(prompt), 55_000)

    def test_gemini_interactions_request_returns_model_output(self):
        response_body = json.dumps({
            "status": "completed",
            "steps": [{
                "type": "model_output",
                "content": [{"type": "text", "text": "## Project purpose\nA web service."}],
            }],
        }).encode("utf-8")

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return response_body

        with patch.dict(os.environ, {"GEMINI_API_KEY": "test-key", "GEMINI_MODEL": "gemini-test"}):
            with patch("gemini.urllib.request.urlopen", return_value=FakeResponse()) as urlopen:
                result = explain_architecture({"resources": [], "edges": [], "runtime_flows": []})
        self.assertEqual("gemini-test", result["model"])
        self.assertIn("A web service", result["explanation"])
        request = urlopen.call_args.args[0]
        self.assertNotIn("test-key", request.full_url)
        self.assertEqual("test-key", request.get_header("X-goog-api-key"))

    def test_missing_api_key_fails_explicitly(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(GeminiError, "GEMINI_API_KEY"):
                explain_architecture({"resources": []})


if __name__ == "__main__":
    unittest.main()
