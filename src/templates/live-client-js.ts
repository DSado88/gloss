/**
 * Browser-side JavaScript for the live/streaming mode.
 *
 * Injected as an extra script into the HTML page when serving in --live mode.
 * Handles WebSocket connection, DOM updates for new/updated turns,
 * auto-scroll, reconnection, and the LIVE badge.
 */
export function buildLiveClientJs(wsUrl: string): string {
  return `
// ── Live mode ──
(function() {
  const WS_URL = ${JSON.stringify(wsUrl)};
  let ws;
  let reconnectDelay = 500;
  const MAX_RECONNECT_DELAY = 10000;

  // Insert LIVE badge into the controls bar
  const controls = document.querySelector('.controls');
  if (controls) {
    const badge = document.createElement('span');
    badge.className = 'live-badge';
    badge.textContent = 'LIVE';
    badge.id = 'live-badge';
    controls.insertBefore(badge, controls.firstChild);
  }

  // Reference to conversation data array (maintained by main client JS)
  // convoData is declared in the main client script
  const getConvoData = () => {
    try { return convoData; } catch { return []; }
  };

  function isNearBottom() {
    const threshold = 200;
    return (document.documentElement.scrollHeight - window.scrollY - window.innerHeight) < threshold;
  }

  function scrollToBottom() {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
  }

  function handleMessage(evt) {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }

    const convoContainer = document.querySelector('.conversation');
    const tocBody = document.getElementById('toc-body');
    if (!convoContainer) return;

    const wasNearBottom = isNearBottom();

    if (msg.type === 'new_turn') {
      // Append new turn HTML
      const div = document.createElement('div');
      div.innerHTML = msg.html;
      while (div.firstChild) {
        convoContainer.appendChild(div.firstChild);
      }

      // Append TOC entry if present
      if (msg.tocHtml && tocBody) {
        const tocDiv = document.createElement('div');
        tocDiv.innerHTML = msg.tocHtml;
        while (tocDiv.firstChild) {
          tocBody.appendChild(tocDiv.firstChild);
        }
      }

      // Update CONVO_DATA
      if (msg.convoDataEntry) {
        try {
          const cd = getConvoData();
          if (Array.isArray(cd)) cd.push(msg.convoDataEntry);
        } catch {}
      }

      // Update turn count in metadata
      updateTurnCount(msg.turnIndex + 1);

    } else if (msg.type === 'update_turn') {
      // Replace existing turn content
      const turnEl = document.getElementById('turn-' + msg.turnIndex);
      if (turnEl) {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = msg.html;
        const newTurn = wrapper.firstElementChild;
        if (newTurn) {
          turnEl.replaceWith(newTurn);
        }
      }

      // Update TOC entry if present
      if (msg.tocHtml) {
        // Find existing toc item that points to this turn
        if (tocBody) {
          const existing = tocBody.querySelector('[onclick*="turn-' + msg.turnIndex + '"]');
          if (existing) {
            const tocDiv = document.createElement('div');
            tocDiv.innerHTML = msg.tocHtml;
            existing.replaceWith(tocDiv.firstElementChild || tocDiv);
          }
        }
      }

      // Update CONVO_DATA entry
      if (msg.convoDataEntry) {
        try {
          const cd = getConvoData();
          if (Array.isArray(cd) && msg.turnIndex < cd.length) {
            cd[msg.turnIndex] = msg.convoDataEntry;
          }
        } catch {}
      }
    }

    if (wasNearBottom) {
      requestAnimationFrame(scrollToBottom);
    }
  }

  function updateTurnCount(count) {
    // Update the "N turns (M user)" span in the meta area
    const metaSpans = document.querySelectorAll('.meta span');
    for (const span of metaSpans) {
      if (span.textContent && span.textContent.match(/^\\d+ turns/)) {
        // We cannot easily track user turns from here, so just update total
        span.textContent = span.textContent.replace(/^\\d+/, String(count));
        break;
      }
    }
  }

  function connect() {
    ws = new WebSocket(WS_URL);

    ws.onopen = function() {
      reconnectDelay = 500;
      document.body.classList.remove('ws-disconnected');
    };

    ws.onmessage = handleMessage;

    ws.onclose = function() {
      document.body.classList.add('ws-disconnected');
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    };

    ws.onerror = function() {
      ws.close();
    };
  }

  connect();
})();
`;
}
