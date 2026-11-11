# Architecture Design - DataPilot

This document outlines the system architecture, component breakdown, data flow, database schemas, and API design for DataPilot.

---

## 1. High-Level System Architecture

DataPilot is structured as an **Electron-based desktop application** that runs entirely on the engineer's local machine. This ensures that massive binary robotics telemetry files (rosbags) do not need to be uploaded to cloud systems. 

The Electron application uses a hybrid architecture built as a **single unified Node package**:
- **Renderer Process**: Runs the React 19 user interface built with Vite (via `electron-vite`).
- **Main Process (Node.js)**: Runs in the OS environment, communicates with the **Docker socket** (`/var/run/docker.sock`) to orchestrate local backend microservices, and manages native OS functions (e.g., file pickers).
- **Preload Script**: Exposes a contextBridge API to the Renderer using typed contracts defined in a shared namespace.
- **Backend Stack (Local Docker Services)**: Spin up dynamically via the Docker socket when Electron starts. This stack includes the **FastAPI Backend (embedding LangGraph)**, a **Neo4j Graph Database** (Fleet Knowledge Graph), and **5 MCP Workers** running as separate containers.
- **LLM Connectivity**: The orchestrator coordinates with either cloud APIs (**OpenAI**, **Gemini**) or a locally hosted **Llama** model.

```mermaid
graph TD
    %% Electron App Shell
    subgraph Electron [Electron Desktop App Shell - Single Node Package]
        subgraph Renderer [Renderer Process - React 19 + Vite]
            UI[Web Dashboard]
            Timeline[Log Timeline Bespoke SVG Chart]
            ChatBox[AI Chat Interface]
            SetupScreen[Setup & Troubleshooting Screen]
        end
        
        subgraph Preload [Preload Bridge]
            Bridge[contextBridge API]
        end

        subgraph Main [Main Process - Node.js]
            DockerOrch[Docker Socket Orchestrator]
            IPC[IPC Bridge Handler]
            FilePicker[Native File System Picker]
        end
    end

    %% Host System Docker Socket
    DockerSock[(Docker Host Socket: /var/run/docker.sock)]

    %% Orchestrated Container Services
    subgraph Services [Docker Containers - Launched by Electron]
        API[FastAPI Backend + LangGraph]
        Neo4j[(Neo4j DB: Fleet KG & Vectors)]
        
        subgraph MCPWorkers [MCP Workers]
            RosbagReader[Rosbag Reader Service]
            TrajectoryAnalyzer[Trajectory Analyzer Service]
            PlannerFailureInspector[Planner Failure Inspector Service]
            AnomalyDetector[Anomaly Detector Service]
            ReportComposer[Report Composer Service]
        end
    end

    %% Storage
    subgraph Storage [Host Local Storage]
        FS[(Raw Rosbags / Host File System)]
        SQLite[(SQLite DB: Sessions, Config, Costs & Agent Checkpoints)]
    end

    %% LLM Providers
    subgraph LLMProviders [Supported LLM API Providers]
        OpenAI[OpenAI Cloud API]
        Gemini[Google Gemini Cloud API]
        Llama[Local Llama API - e.g. Ollama/Llama.cpp]
    end

    %% Electron Internal Communication
    UI -->|IPC Events| Bridge
    Bridge -->|Secure Bridge| IPC
    IPC -->|Check Docker Daemon| DockerOrch
    IPC -->|Trigger Local Selector| FilePicker
    SetupScreen -->|Poll Setup Verification| DockerOrch

    %% Main Process Orchestrating Docker
    DockerOrch -->|Manage Containers| DockerSock
    DockerSock -->|Run / Monitor| Services

    %% Frontend to Backend API Calls
    UI -.->|Local HTTP Port 8000| API

    %% API Data flows
    API -->|Read/Write State| SQLite
    API -->|Causal & Vector Queries| Neo4j
    API -->|MCP JSON-RPC| MCPWorkers
    MCPWorkers -->|Mount Local Path| FS
    FilePicker -->|Pass Local File Path| API

    %% LLM Routing
    API -->|Cloud Queries| OpenAI
    API -->|Cloud Queries| Gemini
    API -->|Local Queries| Llama
```

---

## 2. Component Breakdown

### A. Electron Client (Vite + React 19)
* **Renderer Process**:
  - Renders the primary workspace dashboards, log timeline charts, and the diagnostic chat terminal using React 19.
  - All chart visualizations (Timeline, Metric, Map, KGraph, MiniTimeline) are **bespoke React + SVG components** ported directly from the mock design workspace. This ensures exact visual design parity and prevents layout reflows without external charting library overhead.
  - Implements a dedicated **Setup & Troubleshooting Screen** that is displayed if the Docker socket check fails.
  - Screen switching is **rail-driven** via a global `screen` state managed in a `zustand` store (no URL router or hash routing).
  - Fonts are bundled locally and loaded via `@fontsource/inter` and `@fontsource/jetbrains-mono` npm packages.
* **Preload Script**:
  - Exposes `contextBridge.exposeInMainWorld('datapilot', ...)` using typed IPC channels and payload schemas imported from the shared codebase, eliminating raw `ipcRenderer` calls and ensuring type-safety.
* **Main Process (Node.js)**:
  - **Docker Socket Orchestrator**: Connects to the Unix socket `/var/run/docker.sock` via `dockerode`. On startup, it checks if Docker is active and pulls/launches the containerized stack (FastAPI, Neo4j, and the 5 MCP servers).
  - **IPC Bridge Handler**: Coordinates secure IPC events between the Renderer and Main process.
  - **Native File System Picker**: Opens native OS dialogs to select local `.mcap` files, bypassing browser file upload limits.
  - **Claude Code runner** (`src/main/claudeCode/`): Optionally answers Copilot questions with the engineer's own installed, signed-in Claude Code. DataPilot doesn't install it. For each question the runner starts one `claude -p` process in an empty temporary folder, with Claude Code's file, shell and web tools off and the user's own hooks, plugins, skills, memory and CLAUDE.md turned off for that run. It reads the process's stream-json output, hands Claude Code a fresh MCP token each launch, and reports the finished turn to the backend. The module also finds the `claude` binary, checks its version and sign-in status, and loads DataPilot's guide for Claude Code (`datapilot-guide.md`).

### B. Shared Module (`src/shared/`)
* Declares standard, immutable IPC channel contracts and request/response structures.
* Declares backend API response interfaces mirroring the FastAPI Pydantic schemas, ensuring type contracts across the backend and Electron processes cannot drift.

### C. Backend Container (FastAPI + LangGraph)
* **API Layer**: Exposes endpoints on local port `8000` to feed dashboard analytics and manage chat sessions.
* **LangGraph Orchestrator**: Runs the supervisor-specialist multi-agent state machine. It uses LangGraph's standard SQLite saver to persist state checkpoints locally.
* **Claude Code tool endpoint and turn store**: `POST /mcp` (`backend/app/api/mcp_endpoint.py`) is a token-protected MCP endpoint that gives Claude Code 17 tools: 16 read-only tools for the open bag, plus `submit_findings`. Findings are checked against the bag's log lines with the same rule the composer uses, and the summary's log IDs are checked too. An answer with no verified findings says so. The turn store (`backend/app/agent/turn_store.py`, `backend/app/api/agent_turns.py`) records each Claude Code turn in DataPilot's own chat history, so Delete session and Clear all remove it.
* **LLM Router**: Dispatches reasoning queries based on user settings:
  - **OpenAI**: Connects to cloud API.
  - **Gemini**: Connects to cloud API.
  - **Llama**: Connects to a locally running model instance (e.g., Ollama running on port `11434`).

### D. MCP Workers (Docker Services)
Decoupled services running inside independent Docker containers on the local machine:
1. **RosbagReader**: Extracts topic schemas, diagnostic streams, and TF transformations from raw bags.
2. **TrajectoryAnalyzer**: Computes velocities and plots path deviations.
3. **PlannerFailureInspector**: Checks navigation path states and costmaps.
4. **AnomalyDetector**: Performs statistical evaluation on high-frequency channels.
5. **ReportComposer**: Formats tree characters and recommendations.

### E. Storage & Database Layer
* **Host Local Filesystem**: Stores original rosbags and the SQLite database (`db.sqlite`), allowing data persistence across container restarts.
* **Neo4j Container**: Runs inside the local Docker environment, hosting the Fleet Knowledge Graph and storing log embeddings locally.

---

## 3. Data Flow Diagram

### Phase 1: Startup & Docker Verification Flow
```mermaid
sequenceDiagram
    autonumber
    actor User
    participant ElectronUI as Renderer (React 19)
    participant Main as Main Process (Node)
    participant Docker as Docker Daemon
    participant Stack as Docker Services (FastAPI, Neo4j, MCP)

    User->>Main: Launch DataPilot Desktop App
    Main->>Docker: Verify Connection to /var/run/docker.sock
    
    alt Daemon Offline / Access Denied
        Docker-->>Main: Connection Error (Permissions/Daemon Off)
        Main->>ElectronUI: Emit IPC "docker-error" {code, help_guide}
        ElectronUI->>User: Render Setup & Troubleshooting Screen (Guide)
    else Daemon Online
        Docker-->>Main: Connection Success
        Main->>Docker: Spin up container services (FastAPI, Neo4j, MCP)
        Docker-->>Stack: Launch Stack
        Stack-->>Main: Services Healthy
        Main->>ElectronUI: Emit IPC "docker-ready"
        ElectronUI->>User: Render Active Dashboard
    end
```

### Phase 2: Ingestion & Chat Analysis Flow
```mermaid
sequenceDiagram
    autonumber
    actor User
    participant ElectronUI as Renderer (React 19)
    participant Main as Main Process (Node)
    participant API as FastAPI Backend (Docker)
    participant Neo4j as Neo4j DB (Docker)
    participant MCP as MCP Services (Docker)
    participant LLM as LLM Router (API/Local)

    User->>ElectronUI: Click "Load Local MCAP File"
    ElectronUI->>Main: Trigger IPC "open-file-dialog"
    Main-->>ElectronUI: Return absolute path (e.g. "/Users/kati/bags/log.mcap")
    ElectronUI->>API: POST /api/sessions/create {filepath: "/Users/kati/bags/log.mcap"}
    
    API->>API: Parse log.mcap directly from mounted host path
    API->>Neo4j: Populate Fleet nodes & Vectorize warnings/errors
    API-->>ElectronUI: Return session status (Ingestion Completed)
    
    User->>ElectronUI: Ask: "Why did navigation fail?" & Choose LLM ("Llama")
    ElectronUI->>API: POST /api/sessions/{id}/chat {message, model: "llama"}
    API->>API: Initialize LangGraph loop
    API->>Neo4j: Read vector context
    
    loop Plan-and-Execute (LangGraph)
        API->>LLM: Plan next step using local Llama API
        LLM-->>API: Execute MCP Worker "AnomalyDetector"
        API->>MCP: Call AnomalyDetector (JSON-RPC)
        MCP-->>API: Return observations
    end
    
    API->>LLM: Formulate Report (Llama API)
    LLM-->>API: Diagnostic response
    API-->>ElectronUI: Return response & steps audit trail
    ElectronUI->>User: Render diagnosis and execution timeline
```

### Phase 3: Claude Code Answer Flow
Copilot questions are answered either by DataPilot's agents (Phase 2) or by Claude Code, chosen in the Copilot header's "Answer with" menu or by turning on "Use for Copilot" in Settings. With Claude Code, the question, a recap of the chat's earlier turns, Claude Code's instructions plus DataPilot's guide, and the tool results for the open bag go to Anthropic under the user's own account. Usage counts against the user's Claude plan, or is billed to the API key or cloud provider Claude Code is signed in with.

```mermaid
flowchart LR
    R["Renderer<br/>Copilot, Settings"] -- IPC --> M["Electron main<br/>Claude Code runner"]
    M -- "spawns, reads stream-json" --> C["Claude Code<br/>(user's install, user's sign-in)"]
    C -- "MCP over HTTP, localhost, token" --> B["Backend in Docker<br/>tool endpoint + submit_findings"]
    M -- "complete turn" --> B
    C -- "question + recap + tool results" --> A["Anthropic<br/>(user's own account)"]
```

1. The runner calls `POST /api/sessions/{id}/agent-turns` to open a turn, then spawns `claude -p`.
2. Claude Code calls DataPilot's 17 tools at `http://localhost:8000/mcp`: it reads the open bag with the 16 read-only ones and reports through `submit_findings`.
3. The runner calls `POST /api/sessions/{id}/agent-turns/{turn_id}/complete` with the answer and usage, and the backend saves the turn in the chat history.

---

## 4. Technology Stack Recommendation

| Layer | Recommended Choice | Justification |
| :--- | :--- | :--- |
| **Desktop Shell** | **Electron** | Cross-platform desktop runtime packaging Chromium and Node.js. |
| **Build System** | **electron-vite** | Unified tooling config that compiles the main process, preload scripts, and renderer with Hot Module Replacement (HMR). |
| **Renderer Framework**| **React 19** | Modern UI framework for rendering dynamic states, without Next.js/SSR overhead. |
| **Styling** | **Vanilla CSS** | Porting the custom mock design theme verbatim into Tailwind v4 `@theme` tokens. |
| **Fonts** | **@fontsource/inter** & **@fontsource/jetbrains-mono** | Local npm font packages bundled by Vite, avoiding Google Fonts network calls. |
| **Docker Orchestration** | **dockerode** (Node.js SDK) | Node.js library that accesses `/var/run/docker.sock` to manage containers. |
| **Backend Framework** | **FastAPI** (within Docker) | Exposes endpoints to Electron, running containerized to maintain Python version consistency. |
| **Orchestrator** | **LangGraph** (Python) | Embedded in backend container, manages multi-step agent logic. |
| **Database** | **SQLite + Neo4j** | SQLite on host handles sessions and checkpointers. Neo4j in Docker stores graphs and vectors. |
| **Charts** | **Bespoke React + SVG Components** | Custom SVG graphics for timeline, metrics, and KGraph views, matching the mock design with zero external dependencies. |
| **LLM APIs** | **OpenAI, Gemini, Llama** | Routes queries to either cloud API gateways or local ports (e.g. Ollama for local Llama). |

---

## 5. Database Schema Draft

### SQLite Schema
Used for session metadata, settings configs, cost tracking, and LangGraph state checkpointers.

```sql
-- Represents a single loaded rosbag debugging session
CREATE TABLE sessions (
    id TEXT PRIMARY KEY, -- UUID
    filename TEXT NOT NULL,
    filepath TEXT NOT NULL, -- Absolute path on the host filesystem
    robot_name TEXT,
    ros_version TEXT,
    duration_seconds REAL,
    start_time TEXT,
    end_time TEXT,
    total_messages INTEGER,
    topics_list TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Maintains conversational thread history per session
CREATE TABLE chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL, -- 'user' or 'assistant'
    content TEXT NOT NULL,
    execution_steps TEXT, -- JSON array of tools executed in this turn
    citations TEXT, -- JSON array of source log links
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Specialist model selection overrides (mutable via Agents UI)
CREATE TABLE agent_models (
    specialist TEXT PRIMARY KEY,
    model_id TEXT NOT NULL
);

-- Token usage and cost tracking telemetry per chat turn
CREATE TABLE session_costs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    turn_index INTEGER NOT NULL,
    tokens_in INTEGER NOT NULL,
    tokens_out INTEGER NOT NULL,
    est_cost_usd REAL NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- LangGraph State Checkpointer table (handled automatically by SqliteSaver)
-- Table: langgraph_checkpoints (survives Electron app restarts)
```

### Neo4j Fleet Graph Schema
Models fleet metadata, runs, occurrences, and root causes.

#### Nodes
- **Robot** (`id`, `model`, `fleet`, `metadata`)
- **Component** (`name`, `type` [sensor/planner/controller/actuator], `serial`)
- **Run** (`bag_id`, `start_time`, `end_time`, `environment_tags`, `log_embedding` [vector])
- **Incident** (`timestamp`, `description`, `severity`, `anomaly_score`)
- **FailureMode** (`name`, `description`, `typical_root_cause`, `resolution_steps`)
- **EnvironmentCondition** (`rain`, `lighting`, `temperature`, `payload`)

#### Relationships
- `(Robot)-[:HAS_COMPONENT]->(Component)`
- `(Incident)-[:DURING_RUN]->(Run)`
- `(Incident)-[:CAUSED_BY]->(FailureMode)`
- `(Incident)-[:OCCURRED_IN]->(EnvironmentCondition)`
- `(Incident)-[:RESOLVED_BY]->(FailureMode)`
- `(Run)-[:SIMILAR_TO]->(Run)` (Semantic link based on log_embedding cosine similarity)

---

## 6. API Endpoint Design

Most endpoints are hosted on `http://localhost:8000/api`.

### Session Creation

#### 1. Ingest Local File
* **Method**: `POST`
* **Path**: `/api/sessions/create`
* **Request**:
  ```json
  {
    "filepath": "/Users/kati/bags/nav_crash_sample.mcap"
  }
  ```
* **Response**: `202 Accepted`
  ```json
  {
    "session_id": "8f8981df-83cd-41e9-86f2-1fb49cb45e99",
    "filepath": "/Users/kati/bags/nav_crash_sample.mcap",
    "status": "processing"
  }
  ```

### Chat Debugging with LLM Selection

#### 2. Chat & Diagnose
* **Method**: `POST`
* **Path**: `/api/sessions/{session_id}/chat`
* **Request**:
  ```json
  {
    "message": "Why did the navigation abort?",
    "composer_provider": "llama", -- "openai" | "gemini" | "llama"
    "composer_model": "llama-3.3-8b"
  }
  ```
* **Response**: `200 OK` (Streams SSE payload containing plan steps status, token streams, and final structured citations/audit_trail blocks).

### Claude Code Endpoints

#### 3. MCP Tool Endpoint
* **Method**: `POST`
* **Path**: `/mcp` (at `http://localhost:8000/mcp`, outside `/api`)
* **Auth**: Bearer token that Electron main creates fresh each launch.
* **Purpose**: MCP over HTTP for Claude Code. Exposes 17 tools: 16 read-only tools for the open bag, plus `submit_findings`.

#### 4. Open an Agent Turn
* **Method**: `POST`
* **Path**: `/api/sessions/{session_id}/agent-turns`
* **Response**: `201 Created`
  ```json
  {
    "turn_id": "..."
  }
  ```

#### 5. Complete an Agent Turn
* **Method**: `POST`
* **Path**: `/api/sessions/{session_id}/agent-turns/{turn_id}/complete`
* **Purpose**: Saves the Claude Code answer, with its verified findings and usage, into the session's chat history.

#### 6. Chat History
* **Method**: `GET`
* **Path**: `/api/sessions/{id}/messages`
* **Change**: Each row gains `answered_by`, `verified`, `flagged_log_ids` and `claude_code_usage`.
