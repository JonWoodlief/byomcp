# MCP in the Browser

This project demonstrates how a remote AI agent can execute tools on a user's local machine. This is achieved by using a web browser to mediate communication through the Model-Context-Protocol (MCP), allowing the agent to access local resources securely.

For more information, see [jonwoodlief.com/bring-your-own-mcp.html](https://jonwoodlief.com/bring-your-own-mcp.html).

## Getting Started

1.  **Install dependencies and run the agent:**

    In your terminal, run the following commands:

    ```bash
    uv sync
    uv run agent/agent.py
    ```

2.  **Open the application:**

    Open `static/index.html` in your web browser.

    ```bash
    open static/index.html
    ```
