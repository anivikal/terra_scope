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

const state = {
  analysis: null,
  files: null,
  geminiEnabled: false,
  graphMode: "all",
  graphPlaying: false,
  selectedGraphNode: null,
  selectedConnection: null,
  graphPositions: new Map(),
  graphTransform: {x: 0, y: 0, scale: 1},
  view: "overview",
  toastTimer: null
};
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
    state.graphPositions = new Map();
    state.graphTransform = {x: 0, y: 0, scale: 1};
    state.graphPlaying = false;
    state.graphMode = "all";
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
    element.addEventListener("click", () => {
      if (state.view === "architecture" && element.closest("#architecture-graph")) return;
      openResource(element.dataset.resourceId);
    });
  });
  if (state.view === "architecture") initializeArchitectureGraph();
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
  const nodeLimit = 80;
  const resources = data.resources.slice(0, nodeLimit);
  const ids = new Set(resources.map((resource) => resource.id));
  const runtimeConnections = data.runtime_flows.flatMap((flow) => {
    if (!ids.has(flow.via)) return [{...flow, flowType: "runtime"}];
    const source = data.resources.find((resource) => resource.id === flow.source);
    const target = data.resources.find((resource) => resource.id === flow.target);
    const trigger = data.resources.find((resource) => resource.id === flow.via);
    const eventText = flow.event ? ` for ${flow.event}` : "";
    return [
      {
        ...flow,
        target: flow.via,
        flowType: "runtime",
        runtimeStep: "trigger",
        description: `${source?.service || flow.source} event${eventText} is wired through ${trigger?.service || flow.via}.`
      },
      {
        ...flow,
        source: flow.via,
        flowType: "runtime",
        runtimeStep: "delivery",
        description: `${trigger?.service || flow.via} routes${eventText} to ${target?.service || flow.target}.`
      }
    ];
  }).filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  const connections = [
    ...data.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)).map((edge) => ({...edge, flowType: "reference"})),
    ...runtimeConnections
  ];
  const visibleConnections = state.graphMode === "runtime"
    ? connections.filter((edge) => edge.flowType === "runtime")
    : connections;
  state.graphConnections = visibleConnections;
  const graph = layoutGraph(resources, visibleConnections);
  state.graphDimensions = graph;
  const connectionsCount = state.graphMode === "runtime" ? runtimeConnections.length : data.edges.length + runtimeConnections.length;
  const connectionMarkup = visibleConnections.map((connection, index) => (
    `<g class="graph-connection ${connection.flowType}" data-connection-index="${index}">`
    + `<path class="connection-line" marker-end="url(#arrow-${connection.flowType})"></path>`
    + '<path class="connection-hit"></path>'
    + `<text class="connection-label"><textPath href="#connection-path-${index}" startOffset="50%" text-anchor="middle">${escapeHtml(connection.flowType === "runtime" ? (connection.event || connection.label) : (connection.attribute || "reference"))}</textPath></text>`
    + "</g>"
  )).join("");
  const nodeMarkup = resources.map((resource) => (
    graphNodeMarkup(resource, graph.positions.get(resource.id))
  )).join("");
  return `
    <div class="panel-heading"><div><h2>Interactive architecture map</h2><div class="panel-subtitle">Drag resources to rearrange · Click a connection for its source, target, and configuration details.</div></div><span class="pill">${connectionsCount} connections</span></div>
    <div class="graph-toolbar">
      <div class="graph-filters">
        <button class="graph-filter ${state.graphMode === "all" ? "active" : ""}" data-graph-mode="all">All connections <span>${data.edges.length + runtimeConnections.length}</span></button>
        <button class="graph-filter ${state.graphMode === "runtime" ? "active" : ""}" data-graph-mode="runtime">Runtime flow <span>${runtimeConnections.length}</span></button>
      </div>
      <div class="graph-controls">
        <button class="graph-control" data-graph-action="zoom-out" aria-label="Zoom out">−</button>
        <button class="graph-control" data-graph-action="zoom-in" aria-label="Zoom in">+</button>
        <button class="graph-control graph-fit" data-graph-action="fit">Fit map</button>
        <button class="graph-control graph-play ${state.graphPlaying ? "active" : ""}" data-graph-action="play">${state.graphPlaying ? "Ⅱ Pause flow" : "▶ Play flow"}</button>
      </div>
    </div>
    <div class="graph-legend"><span><i class="legend-line dependency"></i>Terraform reference</span><span><i class="legend-line runtime"></i>Inferred event flow</span><span class="graph-hint">Scroll to zoom · Drag empty space to pan</span></div>
    <div class="graph-viewport" id="graph-viewport">
      <svg class="graph-svg" id="architecture-graph" role="img" aria-label="Interactive Terraform resource connection graph" viewBox="0 0 ${graph.width} ${graph.height}" preserveAspectRatio="xMidYMid meet">
        <defs>
          <marker id="arrow-reference" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#9da6b4"></path></marker>
          <marker id="arrow-runtime" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#756bec"></path></marker>
        </defs>
        <g id="graph-world">
          <g id="graph-nodes">${nodeMarkup}</g>
          <g id="graph-connections">${connectionMarkup}</g>
        </g>
      </svg>
    </div>
    ${resources.length < data.resources.length ? `<div class="graph-truncation">Showing ${resources.length} of ${data.resources.length} resources to keep the graph responsive.</div>` : ""}
    <div class="graph-inspector" id="graph-inspector"><div class="graph-inspector-empty"><span>↖</span><strong>Select a resource or connection</strong><small>Inspect what connects services and how Terraform wires them together.</small></div></div>`;
}

function layoutGraph(resources, connections) {
  const ids = new Set(resources.map((resource) => resource.id));
  const incoming = new Map(resources.map((resource) => [resource.id, 0]));
  const outgoing = new Map(resources.map((resource) => [resource.id, []]));
  for (const connection of connections) {
    if (!ids.has(connection.source) || !ids.has(connection.target)) continue;
    outgoing.get(connection.source).push(connection.target);
    incoming.set(connection.target, incoming.get(connection.target) + 1);
  }
  const queue = resources.filter((resource) => incoming.get(resource.id) === 0).map((resource) => resource.id);
  const levels = new Map(resources.map((resource) => [resource.id, 0]));
  const visited = new Set();
  while (queue.length) {
    const source = queue.shift();
    if (visited.has(source)) continue;
    visited.add(source);
    for (const target of outgoing.get(source)) {
      levels.set(target, Math.max(levels.get(target), levels.get(source) + 1));
      incoming.set(target, incoming.get(target) - 1);
      if (incoming.get(target) === 0) queue.push(target);
    }
  }
  for (const resource of resources) {
    if (!visited.has(resource.id)) levels.set(resource.id, Math.max(0, ...Array.from(levels.values())));
  }
  const buckets = new Map();
  for (const resource of resources) {
    const level = levels.get(resource.id);
    if (!buckets.has(level)) buckets.set(level, []);
    buckets.get(level).push(resource);
  }
  const positions = new Map();
  for (const [level, bucket] of buckets) {
    bucket.forEach((resource, index) => {
      if (!state.graphPositions.has(resource.id)) {
        state.graphPositions.set(resource.id, {x: 70 + level * 300, y: 52 + index * 128});
      }
      positions.set(resource.id, state.graphPositions.get(resource.id));
    });
  }
  const maxLevel = Math.max(0, ...Array.from(buckets.keys()));
  const maxRows = Math.max(1, ...Array.from(buckets.values(), (bucket) => bucket.length));
  return {
    positions,
    width: Math.max(860, (maxLevel + 1) * 300 + 70),
    height: Math.max(380, maxRows * 128 + 45)
  };
}

function graphNodeMarkup(resource, position) {
  const [iconClass, icon] = nodeIcon(resource.category);
  const iconColor = iconClass === "compute" ? "#c9862c" : iconClass === "database" ? "#398bc0" : iconClass === "network" ? "#655be0" : iconClass === "storage" ? "#348c6f" : "#756bec";
  return `<g class="graph-node" data-resource-id="${escapeHtml(resource.id)}" transform="translate(${position.x} ${position.y})" tabindex="0" role="button" aria-label="${escapeHtml(resource.service)} ${escapeHtml(resource.id)}"><rect class="node-card" width="188" height="78" rx="10"></rect><circle cx="25" cy="25" r="14" fill="${iconColor}" opacity=".12"></circle><text class="graph-node-icon" x="25" y="29" text-anchor="middle" fill="${iconColor}">${icon}</text><text class="graph-node-service" x="48" y="22">${escapeHtml(resource.service).slice(0, 22)}</text><text class="graph-node-category" x="48" y="37">${escapeHtml(resource.category).slice(0, 23)}</text><text class="graph-node-id" x="12" y="61">${escapeHtml(resource.id).slice(0, 29)}</text><circle class="node-port" cx="0" cy="39" r="4"></circle><circle class="node-port" cx="188" cy="39" r="4"></circle></g>`;
}

function initializeArchitectureGraph() {
  const svg = $("#architecture-graph");
  if (!svg) return;
  const world = $("#graph-world");
  const viewport = $("#graph-viewport");
  const inspector = $("#graph-inspector");
  const positions = state.graphPositions;
  const connections = state.graphConnections;
  const dimensions = state.graphDimensions;
  const connectionsGroup = $("#graph-connections");
  const updateTransform = () => world.setAttribute("transform", `translate(${state.graphTransform.x} ${state.graphTransform.y}) scale(${state.graphTransform.scale})`);
  const pointInSvg = (event) => {
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    return point.matrixTransform(svg.getScreenCTM().inverse());
  };
  const pointInWorld = (event) => {
    const point = pointInSvg(event);
    return point.matrixTransform(world.getScreenCTM().inverse());
  };
  const edgePath = (connection, connectionIndex) => {
    const source = positions.get(connection.source);
    const target = positions.get(connection.target);
    if (!source || !target) return "";
    const parallel = connections
      .map((candidate, index) => ({candidate, index}))
      .filter(({candidate}) => candidate.source === connection.source && candidate.target === connection.target);
    const parallelIndex = parallel.findIndex(({index}) => index === connectionIndex);
    const offset = (parallelIndex - (parallel.length - 1) / 2) * 14;
    const forward = target.x >= source.x;
    const startX = source.x + (forward ? 188 : 0);
    const endX = target.x + (forward ? 0 : 188);
    const startY = source.y + 39 + offset;
    const endY = target.y + 39 + offset;
    const curve = Math.max(38, Math.abs(endX - startX) * 0.42);
    const direction = forward ? 1 : -1;
    return `M ${startX} ${startY} C ${startX + curve * direction} ${startY}, ${endX - curve * direction} ${endY}, ${endX} ${endY}`;
  };
  const updateConnections = () => {
    connectionsGroup.querySelectorAll(".graph-connection").forEach((group, index) => {
      const path = edgePath(connections[index], index);
      group.querySelector(".connection-line").setAttribute("d", path);
      const hitPath = group.querySelector(".connection-hit");
      hitPath.setAttribute("d", path);
      group.querySelector(".connection-line").setAttribute("id", `connection-path-${index}`);
    });
  };
  const fit = () => {
    state.graphTransform = {x: 0, y: 0, scale: 1};
    updateTransform();
  };
  const showNodeDetails = (resourceId) => {
    const resource = state.analysis.resources.find((item) => item.id === resourceId);
    if (!resource) return;
    state.selectedGraphNode = resourceId;
    state.selectedConnection = null;
    svg.querySelectorAll(".graph-node").forEach((node) => {
      const selected = node.dataset.resourceId === resourceId;
      const connected = connections.some((connection) => (
        (connection.source === resourceId && connection.target === node.dataset.resourceId)
        || (connection.target === resourceId && connection.source === node.dataset.resourceId)
      ));
      node.classList.toggle("selected", selected);
      node.classList.toggle("connected", connected);
      node.classList.toggle("dimmed", !selected && !connected);
    });
    connectionsGroup.querySelectorAll(".graph-connection").forEach((edge, index) => {
      const connected = connections[index].source === resourceId || connections[index].target === resourceId;
      edge.classList.toggle("selected", connected);
      edge.classList.toggle("dimmed", !connected);
    });
    const related = connections.map((connection, index) => ({connection, index})).filter(({connection}) => (
      connection.source === resourceId || connection.target === resourceId
    ));
    inspector.innerHTML = `<div class="graph-inspector-head"><span class="graph-detail-icon">${escapeHtml(resource.category)}</span><div><strong>${escapeHtml(resource.service)}</strong><small>${escapeHtml(resource.id)}</small></div><button class="button button-secondary button-small" data-open-resource="${escapeHtml(resource.id)}">Full resource details</button></div><p class="graph-inspector-description">${escapeHtml(resource.purpose)}</p><div class="connection-list-title">${related.length} related connection${related.length === 1 ? "" : "s"}</div><div class="connection-list">${related.map(({connection, index}) => connectionCard(connection, index)).join("") || '<div class="empty-state">No direct connections were detected for this resource.</div>'}</div>`;
    wireInspector();
  };
  const showConnectionDetails = (index) => {
    const connection = connections[index];
    if (!connection) return;
    state.selectedConnection = index;
    state.selectedGraphNode = null;
    svg.querySelectorAll(".graph-node").forEach((node) => {
      node.classList.toggle("selected", node.dataset.resourceId === connection.source || node.dataset.resourceId === connection.target);
      node.classList.toggle("dimmed", node.dataset.resourceId !== connection.source && node.dataset.resourceId !== connection.target);
      node.classList.remove("connected");
    });
    connectionsGroup.querySelectorAll(".graph-connection").forEach((edge, edgeIndex) => {
      edge.classList.toggle("selected", edgeIndex === index);
      edge.classList.toggle("dimmed", edgeIndex !== index);
    });
    inspector.innerHTML = connectionDetailMarkup(connection);
    wireInspector();
  };
  const wireInspector = () => {
    inspector.querySelectorAll("[data-resource-id]").forEach((button) => button.addEventListener("click", () => showNodeDetails(button.dataset.resourceId)));
    inspector.querySelectorAll("[data-open-resource]").forEach((button) => button.addEventListener("click", () => openResource(button.dataset.openResource)));
    inspector.querySelectorAll("[data-connection-index]").forEach((button) => button.addEventListener("click", () => showConnectionDetails(Number(button.dataset.connectionIndex))));
  };
  const wireGraphEvents = () => {
    svg.querySelectorAll(".graph-node").forEach((node) => {
      node.addEventListener("click", (event) => {
        if (node.dataset.dragged === "true") {
          node.dataset.dragged = "false";
          return;
        }
        event.stopPropagation();
        showNodeDetails(node.dataset.resourceId);
      });
      node.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          showNodeDetails(node.dataset.resourceId);
        }
      });
      node.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
        node.setPointerCapture(event.pointerId);
        const start = pointInWorld(event);
        const initial = positions.get(node.dataset.resourceId);
        const offset = {x: start.x - initial.x, y: start.y - initial.y};
        node.dataset.dragged = "false";
        const move = (moveEvent) => {
          const point = pointInWorld(moveEvent);
          if (Math.abs(point.x - start.x) + Math.abs(point.y - start.y) > 3) node.dataset.dragged = "true";
          const next = {x: Math.max(8, point.x - offset.x), y: Math.max(8, point.y - offset.y)};
          positions.set(node.dataset.resourceId, next);
          node.setAttribute("transform", `translate(${next.x} ${next.y})`);
          updateConnections();
        };
        const end = () => {
          node.removeEventListener("pointermove", move);
          node.removeEventListener("pointerup", end);
          node.removeEventListener("pointercancel", end);
        };
        node.addEventListener("pointermove", move);
        node.addEventListener("pointerup", end);
        node.addEventListener("pointercancel", end);
      });
    });
    connectionsGroup.querySelectorAll(".graph-connection").forEach((edge, index) => {
      edge.addEventListener("click", (event) => {
        event.stopPropagation();
        showConnectionDetails(index);
      });
    });
    svg.addEventListener("click", (event) => {
      if (event.target.closest(".graph-node, .graph-connection")) return;
      state.selectedGraphNode = null;
      state.selectedConnection = null;
      inspector.innerHTML = '<div class="graph-inspector-empty"><span>↖</span><strong>Select a resource or connection</strong><small>Inspect what connects services and how Terraform wires them together.</small></div>';
      svg.querySelectorAll(".graph-node, .graph-connection").forEach((item) => item.classList.remove("selected", "connected", "dimmed"));
    });
    let panStart = null;
    svg.addEventListener("pointerdown", (event) => {
      if (event.target.closest(".graph-node, .graph-connection")) return;
      panStart = {x: event.clientX, y: event.clientY, originX: state.graphTransform.x, originY: state.graphTransform.y};
      svg.setPointerCapture(event.pointerId);
    });
    svg.addEventListener("pointermove", (event) => {
      if (!panStart) return;
      const screenScale = Math.min(svg.clientWidth / dimensions.width, svg.clientHeight / dimensions.height);
      state.graphTransform.x = panStart.originX + (event.clientX - panStart.x) / screenScale;
      state.graphTransform.y = panStart.originY + (event.clientY - panStart.y) / screenScale;
      updateTransform();
    });
    const stopPan = () => { panStart = null; };
    svg.addEventListener("pointerup", stopPan);
    svg.addEventListener("pointercancel", stopPan);
    svg.addEventListener("wheel", (event) => {
      event.preventDefault();
      const oldScale = state.graphTransform.scale;
      const nextScale = Math.min(3, Math.max(0.3, oldScale * (event.deltaY < 0 ? 1.1 : 0.9)));
      const point = pointInSvg(event);
      const px = point.x;
      const py = point.y;
      state.graphTransform.x = px - (px - state.graphTransform.x) * (nextScale / oldScale);
      state.graphTransform.y = py - (py - state.graphTransform.y) * (nextScale / oldScale);
      state.graphTransform.scale = nextScale;
      updateTransform();
    }, {passive: false});
  };
  updateTransform();
  updateConnections();
  wireGraphEvents();
  fit();
  viewport.closest(".panel").querySelectorAll("[data-graph-action]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.graphAction === "fit") fit();
      if (button.dataset.graphAction === "zoom-in" || button.dataset.graphAction === "zoom-out") {
        state.graphTransform.scale = Math.min(3, Math.max(0.3, state.graphTransform.scale * (button.dataset.graphAction === "zoom-in" ? 1.2 : 0.8)));
        updateTransform();
      }
      if (button.dataset.graphAction === "play") {
        state.graphPlaying = !state.graphPlaying;
        svg.classList.toggle("playing", state.graphPlaying);
        button.classList.toggle("active", state.graphPlaying);
        button.textContent = state.graphPlaying ? "Ⅱ Pause flow" : "▶ Play flow";
      }
    });
  });
  viewport.closest(".panel").querySelectorAll("[data-graph-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.graphMode = button.dataset.graphMode;
      state.selectedGraphNode = null;
      state.selectedConnection = null;
      renderActivePanel();
    });
  });
  function connectionCard(connection, index) {
    const from = state.analysis.resources.find((resource) => resource.id === connection.source);
    const to = state.analysis.resources.find((resource) => resource.id === connection.target);
    return `<button class="connection-card ${connection.flowType}" data-connection-index="${index}"><span class="connection-card-type">${connection.flowType === "runtime" ? "EVENT FLOW" : "TERRAFORM REFERENCE"}</span><span class="connection-card-route">${escapeHtml(from?.service || connection.source)} <i>→</i> ${escapeHtml(to?.service || connection.target)}</span><span class="connection-card-reason">${escapeHtml(connection.description || connection.label || "Resource reference")}</span></button>`;
  }
  function connectionDetailMarkup(connection) {
    const from = state.analysis.resources.find((resource) => resource.id === connection.source);
    const to = state.analysis.resources.find((resource) => resource.id === connection.target);
    const runtime = connection.flowType === "runtime";
    const via = runtime ? state.analysis.resources.find((resource) => resource.id === connection.via) : null;
    return `<div class="connection-detail"><div class="connection-detail-heading"><span class="connection-detail-icon ${runtime ? "runtime" : ""}">${runtime ? "⇢" : "↗"}</span><div><strong>${runtime ? "Runtime event flow" : "Terraform resource reference"}</strong><small>${runtime ? "Inferred from an explicit trigger resource" : "Directly referenced in configuration"}</small></div></div><p>${escapeHtml(connection.description || "")}</p><div class="connection-endpoints"><button data-resource-id="${escapeHtml(connection.source)}"><span>FROM</span><strong>${escapeHtml(from?.service || connection.source)}</strong><small>${escapeHtml(connection.source)}</small></button><span class="endpoint-arrow">→</span><button data-resource-id="${escapeHtml(connection.target)}"><span>TO</span><strong>${escapeHtml(to?.service || connection.target)}</strong><small>${escapeHtml(connection.target)}</small></button></div>${runtime ? `<div class="connection-metadata"><div><span>Trigger resource</span><button data-resource-id="${escapeHtml(connection.via)}">${escapeHtml(via?.service || connection.via)}</button></div><div><span>Detected event</span><strong>${escapeHtml(connection.event || connection.label)}</strong></div></div>` : `<div class="connection-metadata"><div><span>Attribute on consumer</span><strong>${escapeHtml(connection.attribute || "Reference")}</strong></div><div><span>Referenced value</span><strong>${escapeHtml(connection.referenced_value || "Resource value")}</strong></div><div class="expression-row"><span>Terraform expression</span><code>${escapeHtml(connection.expression || "")}</code></div></div>`}</div>`;
  }
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
