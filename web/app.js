const SAMPLE_FILES = {
  "main.tf": `resource "aws_s3_bucket" "uploads" {
  bucket = "acme-image-uploads"

  versioning {
    enabled = true
  }

  server_side_encryption_configuration {
    rule {
      apply_server_side_encryption_by_default {
        sse_algorithm = "AES256"
      }
    }
  }
}

resource "aws_lambda_function" "image_processor" {
  function_name = "image-processor"
  role          = aws_iam_role.processor.arn
  runtime       = "python3.12"
  handler       = "handler.process"
}

resource "aws_iam_role" "processor" {
  name = "image-processor-role"
}

resource "aws_s3_bucket_notification" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  lambda_function {
    lambda_function_arn = aws_lambda_function.image_processor.arn
    events              = ["s3:ObjectCreated:*"]
  }
}

resource "aws_dynamodb_table" "image_metadata" {
  name         = "image-metadata"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "image_id"
}`,
  "variables.tf": `variable "environment" {
  description = "Deployment environment"
  type        = string
  default     = "production"
}

output "upload_bucket_name" {
  value = aws_s3_bucket.uploads.id
}`
};

const state = {analysis: null, files: null, geminiEnabled: false, view: "overview", toastTimer: null};
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]));
const money = (value) => `$${Number(value || 0).toLocaleString("en-US")}`;

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => switchView(button.dataset.view));
});
$("#upload-button").addEventListener("click", () => $("#folder-input").click());
$("#header-upload").addEventListener("click", () => $("#folder-input").click());
$("#browse-files").addEventListener("click", (event) => {
  event.stopPropagation();
  $("#file-input").click();
});
$("#drop-zone").addEventListener("click", (event) => {
  if (event.target.closest("button")) return;
  $("#folder-input").click();
});
$("#drop-zone").addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    $("#folder-input").click();
  }
});
$("#load-sample").addEventListener("click", () => analyzeFiles(SAMPLE_FILES, "image-pipeline"));
$("#file-input").addEventListener("change", (event) => handleSelectedFiles(event.target.files));
$("#folder-input").addEventListener("change", (event) => handleSelectedFiles(event.target.files));
$("#drawer-close").addEventListener("click", () => $("#detail-drawer").classList.add("hidden"));
$("#gemini-button").addEventListener("click", requestGeminiExplanation);
checkGeminiStatus();

const dropZone = $("#drop-zone");
["dragenter", "dragover"].forEach((name) => dropZone.addEventListener(name, (event) => {
  event.preventDefault();
  dropZone.classList.add("dragging");
}));
["dragleave", "drop"].forEach((name) => dropZone.addEventListener(name, (event) => {
  event.preventDefault();
  dropZone.classList.remove("dragging");
}));
dropZone.addEventListener("drop", (event) => handleSelectedFiles(event.dataTransfer.files));

async function handleSelectedFiles(fileList) {
  const files = Array.from(fileList || []);
  const accepted = files.filter((file) => /\.(tf|tf\.json)$/i.test(file.name));
  if (files.some((file) => /(?:^|[\\/])terraform\.tfstate(?:\.backup)?$/i.test(file.webkitRelativePath || file.name))) {
    showToast("State files were skipped. They can contain credentials and sensitive values.", true);
  }
  if (accepted.length === 0) {
    showToast("Choose one or more .tf or .tf.json files. Terraform state files are not supported.", true);
    return;
  }
  if (accepted.length > 100) {
    showToast("Please select no more than 100 Terraform files.", true);
    return;
  }
  const totalBytes = accepted.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > 5 * 1024 * 1024) {
    showToast("The selected Terraform source exceeds the 5 MB upload limit.", true);
    return;
  }
  const contents = await Promise.all(accepted.map((file) => file.text()));
  const byPath = {};
  accepted.forEach((file, index) => {
    const path = file.webkitRelativePath || file.name;
    byPath[path] = contents[index];
  });
  const projectName = accepted[0].webkitRelativePath
    ? accepted[0].webkitRelativePath.split("/")[0]
    : accepted[0].name.replace(/\.tf(?:\.json)?$/i, "");
  await analyzeFiles(byPath, projectName);
  $("#file-input").value = "";
  $("#folder-input").value = "";
}

async function analyzeFiles(files, projectName) {
  $("#upload-button").disabled = true;
  $("#header-upload").disabled = true;
  $("#upload-button").innerHTML = "<span>…</span> Analyzing";
  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({files})
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Analysis failed.");
    state.analysis = result;
    state.files = files;
    state.analysis.project.name = projectName || result.project.name;
    $("#welcome-panel").classList.add("hidden");
    $("#analysis-area").classList.remove("hidden");
    $("#workspace-name").textContent = state.analysis.project.name;
    $("#breadcrumb-project").textContent = state.analysis.project.name;
    renderAnalysis();
    switchView(state.view);
    if (result.warnings.length) showToast(result.warnings.join(" "));
  } catch (error) {
    showToast(error.message || "Could not analyze Terraform files.", true);
  } finally {
    $("#upload-button").disabled = false;
    $("#header-upload").disabled = false;
    $("#upload-button").innerHTML = "<span>↥</span> Upload Terraform";
  }
}

function switchView(view) {
  state.view = view;
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  const labels = {
    overview: ["Overview", "Understand your infrastructure.", "Turn Terraform into a clear, explorable map of your cloud architecture."],
    architecture: ["Architecture", "See how it all connects.", "Explore the services and dependencies defined in your Terraform."],
    runtime: ["Runtime flow", "Follow the event journey.", "See event-driven paths detected from explicit Terraform trigger resources."],
    resources: ["Resources", "Explore every resource.", "Browse services, configuration signals, and resource relationships."],
    security: ["Security", "Review security signals.", "Static checks highlight configurations worth reviewing—not a compliance audit."],
    cost: ["Cost estimate", "Understand likely cost drivers.", "Illustrative monthly ranges for common resource types, not a billing quote."]
  };
  const [breadcrumb, title, subtitle] = labels[view] || labels.overview;
  $("#breadcrumb-project").textContent = state.analysis ? `${state.analysis.project.name} / ${breadcrumb}` : breadcrumb;
  $("#page-title").textContent = state.analysis ? title : "Understand your infrastructure.";
  $("#page-subtitle").textContent = state.analysis ? subtitle : "Turn Terraform into a clear, explorable map of your cloud architecture.";
  if (state.analysis) renderActivePanel();
}

function renderAnalysis() {
  const data = state.analysis;
  $("#gemini-button").disabled = !state.geminiEnabled;
  $("#gemini-output").textContent = "";
  $("#gemini-output").classList.add("hidden");
  $("#metrics-grid").innerHTML = `
    <div class="metric-card"><div class="metric-head">Resources mapped <span class="metric-icon">▦</span></div><div class="metric-value">${data.resource_count}</div><div class="metric-caption">Resources &amp; data sources</div></div>
    <div class="metric-card"><div class="metric-head">Connections found <span class="metric-icon green">⟷</span></div><div class="metric-value">${data.edges.length}</div><div class="metric-caption">Explicit resource references</div></div>
    <div class="metric-card"><div class="metric-head">Security signals <span class="metric-icon orange">◈</span></div><div class="metric-value">${data.security.findings.length}</div><div class="metric-caption">${data.security.high_count} high · ${data.security.medium_count} medium</div></div>
    <div class="metric-card"><div class="metric-head">Monthly estimate <span class="metric-icon green">$</span></div><div class="metric-value">${money(data.cost.monthly_min_usd)}–${money(data.cost.monthly_max_usd)}</div><div class="metric-caption">Illustrative USD range</div></div>`;
  $("#summary-text").textContent = data.summary;
  $("#resource-nav-count").textContent = data.resource_count;
  $("#risk-nav-count").textContent = data.security.findings.length;
  $("#disclaimer").textContent = `${data.analysis_note} ${data.cost.disclaimer}`;
  renderActivePanel();
}

async function checkGeminiStatus() {
  try {
    const response = await fetch("/api/ai/status");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not check Gemini configuration.");
    const button = $("#gemini-button");
    const badge = $("#ai-status");
    if (result.enabled) {
      state.geminiEnabled = true;
      badge.textContent = `Gemini · ${result.model}`;
      badge.title = "AI explanations are enabled.";
      button.disabled = !state.analysis;
    } else {
      state.geminiEnabled = false;
      badge.textContent = "Add key in local .env";
      badge.title = "Add GEMINI_API_KEY to your local .env file and restart the server.";
      button.disabled = true;
      button.title = "Add GEMINI_API_KEY to your local .env file and restart the server.";
    }
  } catch (error) {
    state.geminiEnabled = false;
    $("#ai-status").textContent = "Gemini status unavailable";
    $("#gemini-button").disabled = true;
    showToast(error.message || "Could not check Gemini configuration.", true);
  }
}

async function requestGeminiExplanation() {
  const button = $("#gemini-button");
  const output = $("#gemini-output");
  if (!state.files || button.disabled) return;
  button.disabled = true;
  button.textContent = "Analyzing with Gemini…";
  output.classList.remove("hidden");
  output.textContent = "Gemini is analyzing the sanitized architecture model. This can take a few seconds.";
  try {
    const response = await fetch("/api/ai/explain", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({files: state.files})
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Gemini analysis failed.");
    output.textContent = result.explanation;
    $("#ai-status").textContent = `Gemini · ${result.model}`;
  } catch (error) {
    output.textContent = "";
    output.classList.add("hidden");
    showToast(error.message || "Gemini analysis failed.", true);
  } finally {
    button.textContent = "✦ Ask Gemini";
    button.disabled = !state.geminiEnabled || !state.analysis;
  }
}

function renderActivePanel() {
  const panel = $("#active-panel");
  const renderers = {
    overview: renderOverview,
    architecture: renderArchitecture,
    runtime: renderRuntime,
    resources: renderResources,
    security: renderSecurity,
    cost: renderCost
  };
  panel.innerHTML = (renderers[state.view] || renderOverview)();
  panel.querySelectorAll("[data-resource-id]").forEach((element) => {
    element.addEventListener("click", () => openResource(element.dataset.resourceId));
  });
}

function nodeIcon(category) {
  if (/database/i.test(category)) return ["database", "▤"];
  if (/compute|containers/i.test(category)) return ["compute", "◇"];
  if (/network/i.test(category)) return ["network", "⌘"];
  if (/storage/i.test(category)) return ["storage", "▱"];
  return ["", "◈"];
}

function renderOverview() {
  const data = state.analysis;
  const resources = data.resources;
  const rows = resources.slice(0, 8).map((resource) => {
    const [iconClass, icon] = nodeIcon(resource.category);
    return `<button class="resource-node" data-resource-id="${escapeHtml(resource.id)}"><div class="node-top"><span class="node-icon ${iconClass}">${icon}</span><span><span class="node-name">${escapeHtml(resource.service)}</span><span class="node-type">${escapeHtml(resource.id)}</span></span></div><div class="node-caption">${escapeHtml(resource.purpose)}</div></button>`;
  }).join('<span class="diagram-arrow">···</span>');
  const categories = Object.entries(data.category_counts).map(([name, count]) => `<span><strong>${count}</strong> ${escapeHtml(name)}</span>`).join("");
  return `<div class="panel-heading"><div><h2>Architecture at a glance</h2><div class="panel-subtitle">Select any service to inspect its configuration and signals.</div></div><div class="diagram-legend"><span><i class="legend-dot storage"></i>Storage</span><span><i class="legend-dot compute"></i>Compute</span><span><i class="legend-dot database"></i>Database</span></div></div><div class="architecture-canvas">${resources.length ? `<div class="diagram-row">${rows}</div>` : '<div class="empty-state">No resource blocks were found in the uploaded Terraform files.</div>'}</div><div class="inventory-strip">${categories || "<span>No service categories detected</span>"}<span><strong>${data.modules.length}</strong> Modules</span><span><strong>${data.variables.length}</strong> Variables</span><span><strong>${data.outputs.length}</strong> Outputs</span></div>`;
}

function renderArchitecture() {
  const data = state.analysis;
  const resourceById = new Map(data.resources.map((resource) => [resource.id, resource]));
  const usedTargets = new Set(data.edges.map((edge) => edge.target));
  const roots = data.resources.filter((resource) => !usedTargets.has(resource.id));
  const start = roots.length ? roots : data.resources;
  const ordered = [...start, ...data.resources.filter((resource) => !start.includes(resource))].slice(0, 18);
  const nodeMarkup = ordered.map((resource, index) => {
    const [iconClass, icon] = nodeIcon(resource.category);
    const next = ordered[index + 1];
    const connected = next && data.edges.some((edge) => edge.source === resource.id && edge.target === next.id);
    return `<button class="resource-node" data-resource-id="${escapeHtml(resource.id)}"><div class="node-top"><span class="node-icon ${iconClass}">${icon}</span><span><span class="node-name">${escapeHtml(resource.service)}</span><span class="node-type">${escapeHtml(resource.id)}</span></span></div><div class="node-caption">${escapeHtml(resource.purpose)}</div></button>${next ? `<span class="diagram-arrow">${connected ? "→" : "·"}<span>${connected ? "references" : "not directly linked"}</span></span>` : ""}`;
  }).join("");
  const links = data.edges.map((edge) => `<div class="property-row"><span>${escapeHtml(resourceById.get(edge.source)?.service || edge.source)} → ${escapeHtml(resourceById.get(edge.target)?.service || edge.target)}</span><strong>Explicit dependency</strong></div>`).join("");
  return `<div class="panel-heading"><div><h2>Infrastructure map</h2><div class="panel-subtitle">Resource references inferred directly from Terraform expressions.</div></div><span class="pill">${data.edges.length} dependencies</span></div><div class="architecture-canvas">${nodeMarkup ? `<div class="diagram-row">${nodeMarkup}</div>` : '<div class="empty-state">Upload Terraform to map its resources.</div>'}</div><div class="drawer-section"><h3>Detected dependencies</h3>${links || '<div class="empty-state">No explicit resource-to-resource references were detected.</div>'}</div>`;
}

function renderRuntime() {
  const data = state.analysis;
  const flows = data.runtime_flows;
  const resources = new Map(data.resources.map((resource) => [resource.id, resource]));
  const flowMarkup = flows.map((flow) => `<button class="flow-step" data-resource-id="${escapeHtml(flow.source)}"><strong>${escapeHtml(resources.get(flow.source)?.service || flow.source)}</strong><small>${escapeHtml(flow.source)}</small></button><span class="flow-arrow">→</span><button class="flow-step" data-resource-id="${escapeHtml(flow.target)}"><strong>${escapeHtml(resources.get(flow.target)?.service || flow.target)}</strong><small>${escapeHtml(flow.label)} · ${escapeHtml(flow.target)}</small></button>`).join("");
  return `<div class="panel-heading"><div><h2>Event-driven runtime paths</h2><div class="panel-subtitle">Only explicit trigger resources are shown. Ordinary Terraform references are not assumed to be runtime events.</div></div><span class="pill">${flows.length} trigger paths</span></div>${flows.length ? `<div class="flow-list">${flowMarkup}</div>` : '<div class="empty-state">No explicit event-trigger paths detected yet.<br>We look for S3 notifications, Lambda event source mappings, EventBridge targets, and SNS subscriptions.</div>'}`;
}

function renderResources() {
  const data = state.analysis;
  const rows = data.resources.map((resource) => {
    const severities = resource.risks.map((risk) => risk.severity);
    const highest = severities.includes("high") ? "high" : severities.includes("medium") ? "medium" : "low";
    const riskText = resource.risks.length ? `<span class="risk-pill risk-${highest}">${resource.risks.length} signal${resource.risks.length > 1 ? "s" : ""}</span>` : '<span class="risk-pill risk-low">No signals</span>';
    return `<tr data-resource-id="${escapeHtml(resource.id)}"><td><span class="resource-name">${escapeHtml(resource.service)}</span><span class="resource-code">${escapeHtml(resource.id)}</span></td><td><span class="category-tag">${escapeHtml(resource.category)}</span></td><td>${riskText}</td><td>${resource.cost ? `${money(resource.cost.monthly_min_usd)}–${money(resource.cost.monthly_max_usd)}` : "—"}</td></tr>`;
  }).join("");
  const inventory = data.modules.length + data.variables.length + data.outputs.length + data.locals.length + data.data_sources.length;
  return `<div class="panel-heading"><div><h2>Resource inventory</h2><div class="panel-subtitle">Choose a row to inspect purpose, settings, relationships, and risk signals.</div></div><span class="pill">${data.resource_count} resources</span></div><div class="table-scroll"><table class="resource-table"><thead><tr><th>SERVICE / ADDRESS</th><th>CATEGORY</th><th>SECURITY</th><th>EST. / MONTH</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="empty-state">No resources found.</td></tr>'}</tbody></table></div><div class="inventory-strip"><span><strong>${data.modules.length}</strong> Modules</span><span><strong>${data.variables.length}</strong> Variables</span><span><strong>${data.outputs.length}</strong> Outputs</span><span><strong>${data.locals.length}</strong> Locals</span><span><strong>${data.data_sources.length}</strong> Data sources</span><span><strong>${inventory}</strong> supporting blocks</span></div>`;
}

function renderSecurity() {
  const findings = state.analysis.security.findings;
  const rows = findings.map((finding) => `<div class="risk-card"><span class="risk-pill risk-${escapeHtml(finding.severity)}">${escapeHtml(finding.severity.toUpperCase())}</span><div><strong>${escapeHtml(finding.title)}</strong><p>${escapeHtml(finding.detail)}</p></div><button class="text-button risk-resource" data-resource-id="${escapeHtml(finding.resource_id)}">${escapeHtml(finding.resource_id)}</button></div>`).join("");
  const findingLabel = findings.length === 1 ? "finding" : "findings";
  return `<div class="panel-heading"><div><h2>Static security signals</h2><div class="panel-subtitle">These are review prompts from source—not confirmed deployed exposure or compliance results.</div></div><span class="pill">${findings.length} ${findingLabel}</span></div>${rows || '<div class="empty-state">No matching security signals found in the supported checks.</div>'}`;
}

function renderCost() {
  const cost = state.analysis.cost;
  const maximum = Math.max(1, ...cost.items.map((item) => item.monthly_max_usd));
  const rows = cost.items.map((item) => `<div class="cost-item"><div><div class="cost-label">${escapeHtml(item.service)}</div><div class="cost-detail">${escapeHtml(item.resource_id)} · ${escapeHtml(item.drivers)}</div></div><div class="bar-track"><progress class="bar-fill" max="${maximum}" value="${item.monthly_max_usd}" aria-label="${escapeHtml(item.service)} estimated cost range"></progress></div><div class="cost-range">${money(item.monthly_min_usd)} – ${money(item.monthly_max_usd)} / mo</div></div>`).join("");
  return `<div class="panel-heading"><div><h2>Estimated monthly cost drivers</h2><div class="panel-subtitle">Broad per-resource ranges for common AWS resource types.</div></div><span class="pill">Low confidence</span></div><div class="cost-total">${money(cost.monthly_min_usd)} – ${money(cost.monthly_max_usd)} <span>USD / month</span></div><div class="cost-list">${rows || '<div class="empty-hint">No resources with built-in illustrative estimates were found.</div>'}</div><div class="drawer-section"><p>${escapeHtml(cost.disclaimer)}</p></div>`;
}

function openResource(resourceId) {
  const resource = state.analysis.resources.find((item) => item.id === resourceId);
  if (!resource) return;
  const outgoing = state.analysis.edges.filter((edge) => edge.source === resourceId).map((edge) => edge.target);
  const incoming = state.analysis.edges.filter((edge) => edge.target === resourceId).map((edge) => edge.source);
  const config = Object.entries(resource.configuration).map(([key, value]) => `<div class="property-row"><span>${escapeHtml(key)}</span><strong>${escapeHtml(typeof value === "string" ? value : JSON.stringify(value))}</strong></div>`).join("");
  const features = resource.features.map((feature) => `<div class="property-row"><span>${escapeHtml(feature.feature)}</span><strong>${escapeHtml(feature.status)}</strong></div><p>${escapeHtml(feature.impact)}</p>`).join("");
  const risks = resource.risks.map((risk) => `<div class="risk-card"><span class="risk-pill risk-${escapeHtml(risk.severity)}">${escapeHtml(risk.severity.toUpperCase())}</span><div><strong>${escapeHtml(risk.title)}</strong><p>${escapeHtml(risk.detail)}</p></div></div>`).join("") || "<p>No matching static security signals.</p>";
  const price = resource.cost ? `<div class="property-row"><span>Illustrative monthly range</span><strong>${money(resource.cost.monthly_min_usd)} – ${money(resource.cost.monthly_max_usd)}</strong></div><p>${escapeHtml(resource.cost.drivers)}. Low-confidence estimate.</p>` : "<p>No built-in cost range for this resource type.</p>";
  $("#drawer-content").innerHTML = `<div class="drawer-kicker">${escapeHtml(resource.category.toUpperCase())}</div><div class="drawer-title">${escapeHtml(resource.service)}</div><div class="drawer-type">${escapeHtml(resource.id)}</div><section class="drawer-section"><h3>Purpose</h3><p>${escapeHtml(resource.purpose)}</p></section><section class="drawer-section"><h3>Configuration</h3>${config || "<p>No simple top-level attributes were extracted.</p>"}</section><section class="drawer-section"><h3>Features detected</h3>${features || "<p>No supported feature settings detected.</p>"}</section><section class="drawer-section"><h3>Relationships</h3><div class="property-row"><span>Uses</span><strong>${escapeHtml(incoming.join(", ") || "No explicit dependencies")}</strong></div><div class="property-row"><span>Used by</span><strong>${escapeHtml(outgoing.join(", ") || "No explicit dependents")}</strong></div></section><section class="drawer-section"><h3>Risk analysis</h3>${risks}</section><section class="drawer-section"><h3>Cost analysis</h3>${price}</section>`;
  $("#detail-drawer").classList.remove("hidden");
}

function showToast(message, isError = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.remove("hidden");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.add("hidden"), 6000);
}
