/**
 * Stub A2UI bundle for isolated deployments.
 * This minimal bundle defines the moltbot-a2ui-host custom element
 * so the canvas page loads without errors when vendor sources are unavailable.
 */
(() => {
  "use strict";

  class MoltbotA2UIHost extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
    }

    connectedCallback() {
      this.shadowRoot.innerHTML = `
        <style>
          :host {
            display: block;
            height: 100%;
          }
          .stub-container {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100%;
            color: rgba(255, 255, 255, 0.6);
            font: 14px/1.4 system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
            text-align: center;
            padding: 24px;
            box-sizing: border-box;
          }
        </style>
        <div class="stub-container">
          <span>A2UI canvas ready</span>
        </div>
      `;
    }
  }

  if (!customElements.get("moltbot-a2ui-host")) {
    customElements.define("moltbot-a2ui-host", MoltbotA2UIHost);
  }
})();
