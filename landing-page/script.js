/**
 * OpenAtlas Studio Landing Page Interactive Script
 */

// Node Inspection Functionality
function inspectNode(nodeId, element) {
  // Remove active state from all nodes
  const nodes = document.querySelectorAll('.node-group');
  nodes.forEach(n => n.classList.remove('active'));

  // Set active state on target node
  element.classList.add('active');

  // Extract payload data
  const title = element.getAttribute('data-title');
  const type = element.getAttribute('data-type');
  const confidence = element.getAttribute('data-confidence');
  const layer = element.getAttribute('data-layer');
  const payloadRaw = element.getAttribute('data-payload');

  // Update Inspector Panel UI
  document.getElementById('insp-id').innerText = nodeId;
  document.getElementById('insp-title').innerText = title;
  document.getElementById('insp-layer').innerText = layer;
  document.getElementById('insp-type').innerText = type;
  document.getElementById('insp-confidence').innerText = confidence;

  try {
    const formattedJson = JSON.stringify(JSON.parse(payloadRaw), null, 2);
    document.getElementById('insp-payload').innerText = formattedJson;
  } catch (e) {
    document.getElementById('insp-payload').innerText = payloadRaw;
  }
}

// Graph Filter by Layer
function filterGraph(layerMode, tabElement) {
  const tabs = document.querySelectorAll('.graph-tab');
  tabs.forEach(t => t.classList.remove('active'));
  tabElement.classList.add('active');

  const nodes = document.querySelectorAll('.node-group');
  const links = document.querySelectorAll('.link-line');

  nodes.forEach(node => {
    if (layerMode === 'all') {
      node.style.opacity = '1';
    } else {
      if (node.classList.contains('node-' + layerMode)) {
        node.style.opacity = '1';
      } else {
        node.style.opacity = '0.15';
      }
    }
  });

  links.forEach(link => {
    if (layerMode === 'all') {
      link.style.opacity = '1';
    } else {
      if (link.classList.contains('link-' + layerMode)) {
        link.style.opacity = '1';
      } else {
        link.style.opacity = '0.1';
      }
    }
  });
}

// CLI Tab Switcher
function switchCliTab(tabId, tabElement) {
  const tabs = document.querySelectorAll('.cli-tab');
  tabs.forEach(t => t.classList.remove('active'));
  tabElement.classList.add('active');

  const panes = document.querySelectorAll('.cli-pane');
  panes.forEach(p => p.classList.remove('active'));
  document.getElementById('cli-pane-' + tabId).classList.add('active');
}

// Copy Text Helper & Toast Notification
function copyText(text, msg) {
  navigator.clipboard.writeText(text).then(() => {
    showToast(msg || 'Copied to clipboard');
  }).catch(() => {
    showToast('Copying failed');
  });
}

function showToast(message) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerText = '✓ ' + message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

// Simulate Zero-LLM Recall
function simulateRecall() {
  const activeNodeId = document.getElementById('insp-id').innerText;
  showToast('SQLite Recall executed for ' + activeNodeId + ' (<0.85ms)');
}
