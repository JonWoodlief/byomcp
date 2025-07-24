#!/usr/bin/env python3
import os
import asyncio
import json
from dotenv import load_dotenv
from langchain_anthropic import ChatAnthropic
from langchain.tools import BaseTool
from langchain.agents import AgentExecutor, create_tool_calling_agent
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from typing import Optional, Dict, Any
import logging

logging.basicConfig(level=logging.INFO)
load_dotenv()

class ConnectionManager:
    """Manages a single WebSocket connection and its associated agent"""
    
    def __init__(self, websocket: WebSocket):
        self.websocket = websocket
        self.mcp_request_id = 0
        self.pending_mcp_requests: Dict[int, asyncio.Future] = {}
        self.agent_executor: Optional[AgentExecutor] = None
        self.listener_task: Optional[asyncio.Task] = None

    async def listen(self):
        """Listens for incoming messages and handles them"""
        try:
            while True:
                data = await self.websocket.receive_text()
                try:
                    message_data = json.loads(data)
                    if "jsonrpc" in message_data and "method" not in message_data:
                        await self.handle_mcp_response(message_data)
                    else:
                        message = message_data.get("message", "")
                        message_id = message_data.get("messageId")
                        if message:
                            asyncio.create_task(self.process_agent_message(message, message_id))

                except json.JSONDecodeError:
                    logging.error("Invalid JSON format received")
                except Exception as e:
                    logging.error(f"Error processing message: {e}")

        except WebSocketDisconnect:
            logging.info("WebSocket disconnected.")
        except Exception as e:
            logging.error(f"Exception in listener task: {e}")
        finally:
            self.cleanup()

    def start_listening(self):
        """Starts the listener task"""
        self.listener_task = asyncio.create_task(self.listen())

    def cleanup(self):
        """Cleans up resources for this connection"""
        if self.listener_task and not self.listener_task.done():
            self.listener_task.cancel()
        logging.info("Cleaned up connection.")

    async def handle_mcp_response(self, mcp_data: dict):
        """Handles MCP responses from the browser"""
        request_id = mcp_data.get("id")
        if request_id in self.pending_mcp_requests:
            future = self.pending_mcp_requests.pop(request_id)
            if not future.done():
                future.set_result(mcp_data)
        else:
            logging.warning(f"Received response for unknown request ID: {request_id}")

    async def send_mcp_request(self, method: str, params: Optional[Dict] = None) -> Any:
        """Sends an MCP request and waits for the response"""
        self.mcp_request_id += 1
        request_id = self.mcp_request_id
        
        mcp_request = {
            "jsonrpc": "2.0",
            "method": method,
            "id": request_id,
        }
        if params:
            mcp_request["params"] = params

        future = asyncio.Future()
        self.pending_mcp_requests[request_id] = future
        
        try:
            await self.websocket.send_text(json.dumps(mcp_request))
            response = await asyncio.wait_for(future, timeout=15.0)
            return response
        except asyncio.TimeoutError:
            logging.error(f"Timeout waiting for MCP response for request ID {request_id}")
            raise
        except Exception as e:
            logging.error(f"Error during MCP request: {e}")
            self.pending_mcp_requests.pop(request_id, None)
            raise

    async def process_agent_message(self, message: str, message_id: Optional[str]):
        """Processes a message with the agent"""
        if not self.agent_executor:
            response = {"error": "Agent not ready"}
            if message_id:
                response["messageId"] = message_id
            await self.websocket.send_text(json.dumps(response))
            return

        try:
            result = await self.agent_executor.ainvoke({"input": message})
            output = result.get("output", str(result))
            response = {"result": output}
            if message_id:
                response["messageId"] = message_id
            await self.websocket.send_text(json.dumps(response))
        except Exception as e:
            logging.error(f"Error during agent processing: {e}")
            response = {"error": str(e)}
            if message_id:
                response["messageId"] = message_id
            await self.websocket.send_text(json.dumps(response))

class DynamicMCPTool(BaseTool):
    """Dynamic tool that represents an MCP tool from the browser"""
    name: str
    description: str
    manager: ConnectionManager
    tool_info: dict
    
    class Config:
        arbitrary_types_allowed = True

    def _run(self, **kwargs) -> str:
        raise NotImplementedError("Use async version")
    
    async def _arun(self, **kwargs) -> str:
        """Call the MCP tool on the browser via the connection manager"""
        try:
            from pydantic_core import to_jsonable_python
            serializable_kwargs = to_jsonable_python(kwargs)
            
            params = {"name": self.name, "arguments": serializable_kwargs}
            response = await self.manager.send_mcp_request("tools/call", params)
            
            if "error" in response:
                return f"Error calling {self.name}: {response['error']}"
            
            return str(response.get("result", {}))
            
        except Exception as e:
            return f"Error calling {self.name}: {str(e)}"


from jsonschema_pydantic import jsonschema_to_pydantic


async def discover_and_create_tools(manager: ConnectionManager) -> list[BaseTool]:
    """Discover MCP tools from browser and create LangChain tools"""
    try:
        response = await manager.send_mcp_request("tools/list")
        
        if "error" in response:
            logging.error(f"Error getting tools: {response['error']}")
            return []
        
        tools_data = response.get("result", {}).get("tools", [])
        
        tools = []
        for tool_info in tools_data:
            tool_name = tool_info["name"]
            args_schema = None
            if "inputSchema" in tool_info:
                try:
                    args_schema = jsonschema_to_pydantic(tool_info["inputSchema"])
                except Exception as e:
                    logging.error(f"Failed to create Pydantic model for {tool_name}: {e}")
                    args_schema = None

            tool = DynamicMCPTool(
                name=tool_name,
                description=tool_info["description"],
                manager=manager,
                tool_info=tool_info,
                args_schema=args_schema
            )
            tools.append(tool)
        
        return tools
        
    except Exception as e:
        logging.error(f"Error discovering tools: {e}")
        return []

async def create_agent_with_tools(tools: list[BaseTool]) -> AgentExecutor:
    """Create a new agent with the given tools"""
    llm = ChatAnthropic(model="claude-sonnet-4-20250514", api_key=os.getenv("ANTHROPIC_API_KEY"))
    prompt = ChatPromptTemplate.from_messages([
        ("system", "You are a helpful form-filling assistant."),
        MessagesPlaceholder(variable_name="chat_history", optional=True),
        ("human", "{input}"),
        MessagesPlaceholder(variable_name="agent_scratchpad")
    ])
    agent = create_tool_calling_agent(llm, tools, prompt)
    return AgentExecutor(agent=agent, tools=tools)

app = FastAPI(title="Form Assistant Agent")

@app.websocket("/chat")
async def websocket_chat(websocket: WebSocket):
    await websocket.accept()
    manager = ConnectionManager(websocket)

    # Start listening for messages immediately
    manager.start_listening()
    
    tools = await discover_and_create_tools(manager)
    
    if tools:
        manager.agent_executor = await create_agent_with_tools(tools)
    else:
        manager.agent_executor = await create_agent_with_tools([])

    try:
        # Keep the connection alive by waiting on the listener task
        if manager.listener_task:
            await manager.listener_task
    except asyncio.CancelledError:
        logging.info("WebSocket handler's listener task was cancelled.")
    finally:
        manager.cleanup()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)