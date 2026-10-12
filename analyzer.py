"""Terraform source parsing and static architecture analysis."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any


RESOURCE_KNOWLEDGE: dict[str, tuple[str, str, str]] = {
    "aws_s3_bucket": ("Amazon S3", "Storage", "Stores objects such as uploads, assets, and backups."),
    "aws_s3_bucket_notification": ("S3 Event Notifications", "Integration", "Routes bucket events to downstream services."),
    "aws_lambda_function": ("AWS Lambda", "Compute", "Runs code in response to events without managing servers."),
    "aws_lambda_event_source_mapping": ("Lambda Event Source Mapping", "Integration", "Connects an event source such as SQS or DynamoDB Streams to Lambda."),
    "aws_dynamodb_table": ("Amazon DynamoDB", "Database", "Stores key-value or document data in a managed NoSQL database."),
    "aws_db_instance": ("Amazon RDS", "Database", "Runs a managed relational database instance."),
    "aws_rds_cluster": ("Amazon Aurora", "Database", "Runs a managed, scalable relational database cluster."),
    "aws_sqs_queue": ("Amazon SQS", "Messaging", "Buffers messages for asynchronous processing."),
    "aws_sns_topic": ("Amazon SNS", "Messaging", "Distributes notifications to subscribed endpoints."),
    "aws_sns_topic_subscription": ("SNS Subscription", "Integration", "Connects an SNS topic to a subscriber."),
    "aws_cloudwatch_event_rule": ("Amazon EventBridge", "Integration", "Matches events and schedules targets."),
    "aws_cloudwatch_event_target": ("EventBridge Target", "Integration", "Delivers matching events to a target service."),
    "aws_cloudwatch_log_group": ("Amazon CloudWatch Logs", "Observability", "Collects and retains application or service logs."),
    "aws_iam_role": ("AWS IAM", "Identity", "Defines an identity that AWS services or users can assume."),
    "aws_iam_policy": ("AWS IAM", "Identity", "Defines permissions for AWS identities and resources."),
    "aws_iam_role_policy": ("AWS IAM", "Identity", "Attaches inline permissions to an IAM role."),
    "aws_iam_role_policy_attachment": ("AWS IAM", "Identity", "Attaches a managed policy to an IAM role."),
    "aws_security_group": ("Amazon VPC Security Groups", "Networking", "Controls inbound and outbound network traffic."),
    "aws_vpc": ("Amazon VPC", "Networking", "Provides an isolated virtual network in AWS."),
    "aws_subnet": ("Amazon VPC Subnet", "Networking", "Places resources into a VPC address range and availability zone."),
    "aws_instance": ("Amazon EC2", "Compute", "Runs a virtual machine in AWS."),
    "aws_lb": ("Elastic Load Balancing", "Networking", "Distributes application traffic across targets."),
    "aws_alb": ("Elastic Load Balancing", "Networking", "Distributes application traffic across targets."),
    "aws_nat_gateway": ("NAT Gateway", "Networking", "Provides outbound internet access to private subnets."),
    "aws_eks_cluster": ("Amazon EKS", "Containers", "Runs a managed Kubernetes control plane."),
    "aws_ecs_cluster": ("Amazon ECS", "Containers", "Groups and manages container workloads."),
    "aws_apigatewayv2_api": ("Amazon API Gateway", "API", "Exposes managed HTTP or WebSocket APIs."),
    "aws_api_gateway_rest_api": ("Amazon API Gateway", "API", "Exposes a managed REST API."),
    "aws_kms_key": ("AWS KMS", "Security", "Creates a key for encrypting data and controlling key access."),
}

RUNTIME_RESOURCE_TYPES = {
    "aws_s3_bucket_notification",
    "aws_lambda_event_source_mapping",
    "aws_cloudwatch_event_target",
    "aws_sns_topic_subscription",
}

BLOCK_HEADER = re.compile(
    r'(?m)^[ \t]*(resource|data|module|variable|output|locals|provider|terraform)\b'
)
REFERENCE = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z0-9_-]+)")
ASSIGNMENT = re.compile(
    r'(?m)^[ \t]*([A-Za-z_][A-Za-z0-9_-]*)[ \t]*=[ \t]*(?:"([^"]*)"|([^\s#]+))'
)


@dataclass
class Block:
    kind: str
    labels: list[str]
    body: str


def _block_header(text: str, start: int) -> tuple[str, list[str], int] | None:
    line_end = text.find("\n", start)
    if line_end == -1:
        line_end = len(text)
    header = text[start:line_end]
    match = re.match(
        r'\s*(resource|data|module|variable|output|locals|provider|terraform)\b'
        r'((?:\s+"[^"]*")*)\s*\{',
        header,
    )
    if not match:
        return None
    labels = re.findall(r'"([^"]*)"', match.group(2))
    return match.group(1), labels, start + match.end() - 1


def _matching_brace(text: str, opening: int) -> int | None:
    depth = 0
    quoted = False
    escaped = False
    line_comment = False
    block_comment = False
    index = opening
    while index < len(text):
        char = text[index]
        following = text[index + 1] if index + 1 < len(text) else ""
        if line_comment:
            if char == "\n":
                line_comment = False
        elif block_comment:
            if char == "*" and following == "/":
                block_comment = False
                index += 1
        elif quoted:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
        elif char == "#" or (char == "/" and following == "/"):
            line_comment = True
            if char == "/":
                index += 1
        elif char == "/" and following == "*":
            block_comment = True
            index += 1
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return index
        index += 1
    return None


def parse_hcl_blocks(source: str) -> tuple[list[Block], list[str]]:
    blocks: list[Block] = []
    warnings: list[str] = []
    cursor = 0
    while (match := BLOCK_HEADER.search(source, cursor)) is not None:
        header = _block_header(source, match.start())
        if header is None:
            cursor = match.end()
            continue
        kind, labels, opening = header
        closing = _matching_brace(source, opening)
        if closing is None:
            line = source.count("\n", 0, match.start()) + 1
            warnings.append(f"Could not find the closing brace for a block near line {line}.")
            break
        blocks.append(Block(kind, labels, source[opening + 1 : closing]))
        cursor = closing + 1
    return blocks, warnings


def _value_map(body: str) -> dict[str, Any]:
    try:
        document = json.loads(body)
    except json.JSONDecodeError:
        document = None
    if isinstance(document, dict):
        return document

    result: dict[str, Any] = {}
    for match in ASSIGNMENT.finditer(body):
        key = match.group(1)
        value: Any = match.group(2) if match.group(2) is not None else match.group(3)
        if isinstance(value, str):
            if value.lower() in {"true", "false"}:
                value = value.lower() == "true"
            elif re.fullmatch(r"-?\d+(?:\.\d+)?", value):
                value = float(value) if "." in value else int(value)
        result[key] = value
    return result


def _resource_id(block: Block) -> str:
    if block.kind == "data":
        return f"data.{block.labels[0]}.{block.labels[1]}"
    if block.kind == "module":
        return f"module.{block.labels[0]}"
    return f"{block.labels[0]}.{block.labels[1]}"


def _knowledge(resource_type: str) -> tuple[str, str, str]:
    if resource_type in RESOURCE_KNOWLEDGE:
        return RESOURCE_KNOWLEDGE[resource_type]
    if resource_type.startswith("aws_"):
        name = resource_type.removeprefix("aws_").replace("_", " ").title()
        return name, "AWS", f"Manages the {name} service or configuration."
    if resource_type.startswith("azurerm_"):
        name = resource_type.removeprefix("azurerm_").replace("_", " ").title()
        return name, "Azure", f"Manages the {name} service or configuration."
    if resource_type.startswith("google_"):
        name = resource_type.removeprefix("google_").replace("_", " ").title()
        return name, "Google Cloud", f"Manages the {name} service or configuration."
    return resource_type.replace("_", " ").title(), "Other", "Terraform-managed infrastructure resource."


def _features(resource_type: str, body: str, values: dict[str, Any]) -> list[dict[str, str]]:
    features: list[dict[str, str]] = []
    lower = body.lower()

    def add(label: str, enabled: bool, impact: str) -> None:
        features.append(
            {"feature": label, "status": "Enabled" if enabled else "Disabled", "impact": impact}
        )

    if resource_type == "aws_s3_bucket":
        if re.search(r'\bversioning\s*\{|["\']versioning["\']\s*:', body):
            enabled = bool(re.search(r'["\']?enabled["\']?\s*[:=]\s*true', body, re.I))
            add("Versioning", enabled, "Previous object versions can be recovered." if enabled else "Previous versions are not retained.")
        if re.search(r'\blifecycle_rule\s*\{|["\']lifecycle_rule["\']\s*:', body):
            add("Lifecycle rules", True, "Object retention or transitions are configured.")
        if re.search(r'\bserver_side_encryption_configuration\s*\{|["\']server_side_encryption_configuration["\']\s*:', body):
            add("Server-side encryption", True, "Stored objects use configured encryption.")
        elif not re.search(r'\bserver_side_encryption_configuration\s*\{|["\']server_side_encryption_configuration["\']\s*:', lower):
            add("Server-side encryption", False, "No bucket-level encryption configuration was found in this resource.")
    if resource_type in {"aws_db_instance", "aws_rds_cluster"}:
        add("Storage encryption", values.get("storage_encrypted") is True, "Database storage encryption is configured." if values.get("storage_encrypted") is True else "Database storage encryption was not enabled in this resource.")
        if "backup_retention_period" in values:
            add("Automated backups", values["backup_retention_period"] > 0, "Automated backups are retained." if values["backup_retention_period"] > 0 else "Automated backups are disabled.")
    if resource_type in {"aws_instance", "aws_eks_cluster", "aws_ecs_cluster"} and "monitoring" in values:
        add("Detailed monitoring", values["monitoring"] is True, "Detailed metrics are enabled." if values["monitoring"] is True else "Only basic metrics may be available.")
    return features


def _security_findings(resource_type: str, body: str, values: dict[str, Any]) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []
    lowered = body.lower()

    def add(severity: str, title: str, detail: str) -> None:
        findings.append({"severity": severity, "title": title, "detail": detail})

    if resource_type == "aws_s3_bucket":
        if re.search(r'["\']?acl["\']?\s*[:=]\s*"public-read(?:-write)?"', body, re.I):
            add("high", "Public bucket ACL", "The bucket ACL grants public read or write access.")
        if re.search(r'"principal"\s*:\s*"\*"', body, re.I) or re.search(r"principal\s*=\s*\"\*\"", body, re.I):
            add("high", "Wildcard bucket principal", "A bucket policy appears to trust any principal; review its actions and conditions.")
        if not re.search(r"block_public_(?:acls|policy|ignore_acls|restrict_public_buckets)\s*=\s*true", lowered):
            add("medium", "Public access block not found", "No enabled S3 public-access-block setting was found on this resource. It may be configured separately.")
        if not re.search(r"server_side_encryption_configuration\s*\{", body):
            add("low", "Encryption configuration not found", "No explicit server-side encryption block was found on this bucket.")
    if resource_type == "aws_security_group":
        ingress_blocks = re.findall(r"ingress\s*\{([^}]*)\}", body, re.S)
        for ingress in ingress_blocks:
            open_to_world = "0.0.0.0/0" in ingress or "::/0" in ingress
            ports = re.search(r"from_port\s*=\s*(\d+)", ingress)
            port = int(ports.group(1)) if ports else None
            if open_to_world and port in {22, 3389}:
                service = "SSH" if port == 22 else "RDP"
                add("high", f"{service} open to the internet", f"Ingress exposes port {port} to a global CIDR; restrict source ranges.")
            elif open_to_world:
                add("medium", "Ingress open to the internet", "An ingress rule accepts traffic from a global CIDR; verify the port and intended exposure.")
    if resource_type in {"aws_db_instance", "aws_rds_cluster"}:
        if values.get("publicly_accessible") is True:
            add("high", "Public database endpoint", "The database is configured as publicly accessible.")
        if values.get("storage_encrypted") is False:
            add("medium", "Database storage encryption disabled", "Set storage_encrypted = true where supported.")
    if resource_type.startswith("aws_iam_") or resource_type == "aws_iam_policy":
        if re.search(r'"Action"\s*:\s*"\*"', body) or re.search(r"actions?\s*=\s*\[\s*\"\*\"", body):
            add("high", "Wildcard IAM action", "The policy appears to grant all actions; apply least-privilege permissions.")
        if re.search(r'"Resource"\s*:\s*"\*"', body) or re.search(r"resources?\s*=\s*\[\s*\"\*\"", body):
            add("medium", "Wildcard IAM resource", "The policy appears to apply to all resources; narrow its scope if possible.")
    return findings


def _cost(resource_type: str, body: str, values: dict[str, Any]) -> dict[str, Any] | None:
    estimates = {
        "aws_instance": (25, 250, "Instance type, uptime, and attached storage"),
        "aws_db_instance": (25, 500, "Instance class, storage, backups, and uptime"),
        "aws_rds_cluster": (30, 700, "Database capacity, storage, and uptime"),
        "aws_nat_gateway": (32, 120, "Hourly gateway charge plus data processed"),
        "aws_lb": (18, 120, "Load balancer hours and processed capacity"),
        "aws_alb": (18, 120, "Load balancer hours and processed capacity"),
        "aws_eks_cluster": (73, 150, "Cluster-hours plus worker nodes and networking"),
        "aws_lambda_function": (0, 20, "Invocations and execution duration"),
        "aws_s3_bucket": (0, 30, "Stored data, requests, and data transfer"),
        "aws_sqs_queue": (0, 10, "Requests and payload size"),
        "aws_sns_topic": (0, 10, "Notifications and delivery volume"),
        "aws_dynamodb_table": (0, 100, "Read/write capacity, storage, and backups"),
    }
    estimate = estimates.get(resource_type)
    if estimate is None:
        return None
    minimum, maximum, drivers = estimate
    return {
        "monthly_min_usd": minimum,
        "monthly_max_usd": maximum,
        "drivers": drivers,
        "confidence": "low",
        "note": "Illustrative per-resource range only; not a billing quote. Region, usage, discounts, and shared resources change actual cost.",
    }


def _json_blocks(source: str) -> list[Block]:
    document = json.loads(source)
    blocks: list[Block] = []
    for kind in ("resource", "data", "module", "variable", "output", "locals"):
        entries = document.get(kind, {})
        if not isinstance(entries, dict):
            continue
        for first, nested in entries.items():
            if kind in {"resource", "data"} and isinstance(nested, dict):
                for second, config in nested.items():
                    body = json.dumps(config) if isinstance(config, dict) else ""
                    blocks.append(Block(kind, [first, second], body))
            elif kind == "module" and isinstance(nested, dict):
                blocks.append(Block(kind, [first], json.dumps(nested)))
            elif kind in {"variable", "output"} and isinstance(nested, dict):
                blocks.append(Block(kind, [first], json.dumps(nested)))
            elif kind == "locals" and isinstance(nested, dict):
                blocks.append(Block(kind, [], json.dumps(nested)))
    return blocks


def analyze_files(files: dict[str, str]) -> dict[str, Any]:
    if not files:
        raise ValueError("Upload at least one .tf or .tf.json file.")
    if len(files) > 100:
        raise ValueError("A maximum of 100 Terraform files can be analyzed at once.")
    blocks: list[Block] = []
    warnings: list[str] = []
    parsed_files = 0
    for filename, source in files.items():
        normalized = filename.replace("\\", "/")
        if normalized.lower().endswith((".tfstate", ".tfstate.backup")) or "terraform.tfstate" in normalized.lower():
            warnings.append(f"Skipped state file '{normalized}'; state files can contain secrets and are not analyzed.")
            continue
        if not normalized.lower().endswith((".tf", ".tf.json")):
            continue
        if not isinstance(source, str):
            raise ValueError(f"File content for '{normalized}' must be text.")
        parsed_files += 1
        try:
            file_blocks = _json_blocks(source) if normalized.lower().endswith(".tf.json") else parse_hcl_blocks(source)[0]
            if not normalized.lower().endswith(".tf.json"):
                _, file_warnings = parse_hcl_blocks(source)
                warnings.extend(f"{normalized}: {warning}" for warning in file_warnings)
            blocks.extend(file_blocks)
        except json.JSONDecodeError as error:
            warnings.append(f"{normalized}: invalid Terraform JSON near line {error.lineno}.")
    if parsed_files == 0:
        raise ValueError("No .tf or .tf.json files were supplied.")

    resources: list[dict[str, Any]] = []
    modules: list[dict[str, Any]] = []
    variables: list[dict[str, Any]] = []
    outputs: list[dict[str, Any]] = []
    locals_found: list[dict[str, Any]] = []
    data_sources: list[dict[str, Any]] = []
    raw_blocks: dict[str, tuple[Block, str]] = {}

    for block in blocks:
        if block.kind == "locals":
            locals_found.extend({"name": key, "value": value} for key, value in _value_map(block.body).items())
            continue
        if not block.labels:
            continue
        if block.kind in {"resource", "data"} and len(block.labels) < 2:
            continue
        if block.kind == "variable":
            variables.append({"name": block.labels[0], "configuration": _value_map(block.body)})
            continue
        if block.kind == "output":
            outputs.append({"name": block.labels[0], "configuration": _value_map(block.body)})
            continue
        if block.kind == "module":
            module_id = _resource_id(block)
            values = _value_map(block.body)
            module = {
                "id": module_id,
                "name": block.labels[0],
                "source": values.get("source", "local or unspecified"),
            }
            modules.append(module)
            raw_blocks[module_id] = (block, module_id)
            continue
        if block.kind not in {"resource", "data"}:
            continue
        resource_type = block.labels[0]
        resource_id = _resource_id(block)
        service, category, purpose = _knowledge(resource_type)
        values = _value_map(block.body)
        is_data_source = block.kind == "data"
        item = {
            "id": resource_id,
            "type": resource_type,
            "name": block.labels[1],
            "service": service,
            "category": category,
            "purpose": purpose,
            "configuration": values,
            "features": [] if is_data_source else _features(resource_type, block.body, values),
            "risks": [] if is_data_source else _security_findings(resource_type, block.body, values),
            "cost": None if is_data_source else _cost(resource_type, block.body, values),
            "kind": "data" if is_data_source else "resource",
        }
        resources.append(item)
        if block.kind == "data":
            data_sources.append(item)
        raw_blocks[resource_id] = (block, resource_id)

    for bucket in (item for item in resources if item["type"] == "aws_s3_bucket"):
        bucket_block = raw_blocks[bucket["id"]][0]
        for related in resources:
            if related["id"] == bucket["id"]:
                continue
            related_block = raw_blocks[related["id"]][0]
            references_bucket = any(
                f"{match.group(1)}.{match.group(2)}" == bucket["id"]
                for match in REFERENCE.finditer(related_block.body)
            )
            if not references_bucket:
                continue
            if related["type"] == "aws_s3_bucket_public_access_block":
                settings = _value_map(related_block.body)
                public_access_enabled = all(
                    settings.get(key) is True
                    for key in (
                        "block_public_acls",
                        "block_public_policy",
                        "ignore_public_acls",
                        "restrict_public_buckets",
                    )
                )
                if public_access_enabled:
                    bucket["risks"] = [
                        risk for risk in bucket["risks"]
                        if risk["title"] != "Public access block not found"
                    ]
            if related["type"] == "aws_s3_bucket_server_side_encryption_configuration":
                bucket["risks"] = [
                    risk for risk in bucket["risks"]
                    if risk["title"] != "Encryption configuration not found"
                ]

    resource_ids = {resource["id"] for resource in resources}
    edges: list[dict[str, str]] = []
    runtime_edges: list[dict[str, str]] = []
    edge_keys: set[tuple[str, str, str]] = set()
    for resource in resources:
        block, _ = raw_blocks[resource["id"]]
        for match in REFERENCE.finditer(block.body):
            referenced_id = f"{match.group(1)}.{match.group(2)}"
            if referenced_id not in resource_ids or referenced_id == resource["id"]:
                continue
            if (referenced_id, resource["id"], "depends_on") not in edge_keys:
                edges.append({"source": referenced_id, "target": resource["id"], "kind": "depends_on"})
                edge_keys.add((referenced_id, resource["id"], "depends_on"))

    def add_runtime(source: str, target: str, label: str) -> None:
        if source in resource_ids and target in resource_ids and source != target:
            if not any(edge["source"] == source and edge["target"] == target for edge in runtime_edges):
                runtime_edges.append({"source": source, "target": target, "label": label})

    by_id = {resource["id"]: resource for resource in resources}
    for resource in resources:
        if resource["type"] not in RUNTIME_RESOURCE_TYPES:
            continue
        block, _ = raw_blocks[resource["id"]]
        referenced = {
            f"{match.group(1)}.{match.group(2)}"
            for match in REFERENCE.finditer(block.body)
        }
        candidates = [by_id[item] for item in referenced if item in by_id]
        if resource["type"] == "aws_s3_bucket_notification":
            buckets = [item for item in candidates if item["type"] == "aws_s3_bucket"]
            functions = [item for item in candidates if item["type"] == "aws_lambda_function"]
            for bucket in buckets:
                for function in functions:
                    add_runtime(bucket["id"], function["id"], "Object event")
        elif resource["type"] == "aws_lambda_event_source_mapping":
            sources = [item for item in candidates if item["type"] in {"aws_sqs_queue", "aws_dynamodb_table"}]
            functions = [item for item in candidates if item["type"] == "aws_lambda_function"]
            for source in sources:
                for function in functions:
                    add_runtime(source["id"], function["id"], "Event source")
        elif resource["type"] == "aws_cloudwatch_event_target":
            rules = [item for item in candidates if item["type"] == "aws_cloudwatch_event_rule"]
            targets = [item for item in candidates if item["type"] in {"aws_lambda_function", "aws_sns_topic", "aws_sqs_queue"}]
            for rule in rules:
                for target in targets:
                    add_runtime(rule["id"], target["id"], "Matched event")
        elif resource["type"] == "aws_sns_topic_subscription":
            topics = [item for item in candidates if item["type"] == "aws_sns_topic"]
            endpoints = [item for item in candidates if item["id"] != topics[0]["id"]] if topics else []
            for topic in topics:
                for endpoint in endpoints:
                    add_runtime(topic["id"], endpoint["id"], "Notification")

    flattened_risks = [
        {"resource_id": resource["id"], **risk}
        for resource in resources
        for risk in resource["risks"]
    ]
    cost_items = [
        {"resource_id": resource["id"], "service": resource["service"], **resource["cost"]}
        for resource in resources
        if resource["cost"] is not None
    ]
    estimated_min = sum(item["monthly_min_usd"] for item in cost_items)
    estimated_max = sum(item["monthly_max_usd"] for item in cost_items)
    categories: dict[str, int] = {}
    for resource in resources:
        categories[resource["category"]] = categories.get(resource["category"], 0) + 1

    service_chain = " → ".join(
        by_id[edge["source"]]["service"] for edge in runtime_edges
    )
    if runtime_edges:
        chain_ids: list[str] = []
        for edge in runtime_edges:
            if edge["source"] not in chain_ids:
                chain_ids.append(edge["source"])
            if edge["target"] not in chain_ids:
                chain_ids.append(edge["target"])
        service_chain = " → ".join(by_id[item]["service"] for item in chain_ids)
    elif resources:
        service_chain = " → ".join(dict.fromkeys(resource["service"] for resource in resources[:5]))
    else:
        service_chain = "No managed resources were found."

    managed_count = sum(1 for resource in resources if resource["kind"] == "resource")
    data_source_count = len(data_sources)
    resource_label = "resource" if managed_count == 1 else "resources"
    data_source_label = "data source" if data_source_count == 1 else "data sources"
    data_source_summary = (
        f" and {data_source_count} {data_source_label}" if data_source_count else ""
    )
    module_label = "module" if len(modules) == 1 else "modules"
    finding_label = "finding" if len(flattened_risks) == 1 else "findings"
    summary = (
        f"This Terraform configuration defines {managed_count} managed {resource_label}"
        f"{data_source_summary}"
        f"{f' across {len(modules)} {module_label}' if modules else ''}. "
        f"The main services are {service_chain}. "
        f"Static analysis found {len(flattened_risks)} security {finding_label}. "
        f"Illustrative monthly cost ranges from ${estimated_min:,} to ${estimated_max:,} USD "
        "for resources with common pricing drivers; actual costs depend on region and usage."
    )
    return {
        "project": {"name": "Terraform project", "files_analyzed": parsed_files},
        "nodes": resources,
        "edges": edges,
        "runtime_flows": runtime_edges,
        "resources": resources,
        "modules": modules,
        "variables": variables,
        "outputs": outputs,
        "locals": locals_found,
        "data_sources": data_sources,
        "summary": summary,
        "resource_count": len(resources),
        "category_counts": categories,
        "security": {
            "findings": flattened_risks,
            "critical_count": sum(1 for finding in flattened_risks if finding["severity"] == "critical"),
            "high_count": sum(1 for finding in flattened_risks if finding["severity"] == "high"),
            "medium_count": sum(1 for finding in flattened_risks if finding["severity"] == "medium"),
            "low_count": sum(1 for finding in flattened_risks if finding["severity"] == "low"),
        },
        "cost": {
            "monthly_min_usd": estimated_min,
            "monthly_max_usd": estimated_max,
            "items": cost_items,
            "disclaimer": "Illustrative estimates only, not a billing quote. Region, usage, discounts, and shared resources are not modeled.",
        },
        "warnings": warnings,
        "analysis_note": "Analysis is static and based on uploaded Terraform source. It does not evaluate modules, variables, provider defaults, plan values, or deployed cloud state.",
    }
