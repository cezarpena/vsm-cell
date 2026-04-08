# VSM-Cell

**A fractal, decentralized Cybernetic Power-Up — built on Electron.**

VSM-Cell is a standalone desktop application that acts as an autonomous node in a decentralized cybernetic mesh. It combines local AI-powered document ingestion, secure peer-to-peer networking (with optional Tor anonymity), and agentic capabilities via [OpenClaw](https://github.com/) to form an intelligent, self-organizing knowledge unit.

Each "cell" can operate independently — ingesting, summarizing, and reasoning over local documents — or join a mesh with other cells to exchange queries and reports across an encrypted P2P network.

---

## ✨ Features

| Feature | Description |
|---|---|
| **Local Document Ingestion** | Watches a directory for `.md`, `.txt`, and `.pdf` files. Automatically parses, summarizes (via LLM), and indexes them into a local knowledge base. |
| **AI Agent (OpenClaw)** | Built-in agentic controller that can answer questions, reason over ingested context, and execute autonomous tasks using configurable OpenClaw agents. |
| **P2P Mesh Networking** | Decentralized communication via `libp2p` with mDNS discovery, Kademlia DHT, and GossipSub pubsub. Nodes form an invite-only, cryptographically authenticated mesh. |
| **Tor Integration** | Optional Tor hidden service support for anonymous, NAT-piercing P2P connections between cells. |
| **Invite-Based Security** | Cryptographically signed invite tokens (Ed25519) control mesh membership. Only authorized peers can communicate. |
| **Hierarchical Topology** | Cells have configurable roles and levels (Root Admin, Peer, Member), enabling fractal organizational structures. |
| **Auto-Restructuring** | When ingested content exceeds 100k tokens, the system auto-reorganizes the watched directory to keep context lean. |
| **Modern UI** | React + Tailwind CSS frontend with three views: Project Overview, Chat (agent interaction), and Network (topology visualization). |

---

## 🏗 Architecture

```
┌──────────────────────────────────────────────────┐
│                   Electron App                   │
├─────────────────────┬────────────────────────────┤
│     Main Process    │      Renderer Process      │
│                     │                            │
│  ┌───────────────┐  │  ┌──────────────────────┐  │
│  │  Ingestion    │  │  │  React UI            │  │
│  │  Orchestrator │  │  │  ├─ ProjectView      │  │
│  │  (chokidar)   │  │  │  ├─ ChatView         │  │
│  ├───────────────┤  │  │  ├─ NetworkView      │  │
│  │  P2P Service  │  │  │  └─ FrictionBar      │  │
│  │  (libp2p)     │  │  └──────────────────────┘  │
│  ├───────────────┤  │              ▲              │
│  │  Tor Service  │  │              │ IPC          │
│  ├───────────────┤  │              │              │
│  │  Agentic      │  │  ┌──────────┴───────────┐  │
│  │  Controller   │◄├──►│  Preload (Bridge)    │  │
│  │  (OpenClaw)   │  │  └──────────────────────┘  │
│  └───────────────┘  │                            │
└─────────────────────┴────────────────────────────┘
```

---

## 📋 Prerequisites

- **Node.js** ≥ 20 (LTS recommended)
- **npm** (bundled with Node.js)
- **Git**
- An **OpenAI-compatible API key** for embeddings and LLM inference (see [Environment Variables](#-environment-variables))

---

## 🚀 Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/cezarpena/vsm-cell.git
cd vsm-cell
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` and fill in your API keys (see the [Environment Variables](#-environment-variables)) section below.

### 4. Launch in development mode

```bash
npm run dev
```

This starts the Electron app with the Vite dev server powering the renderer. The app will:
1. Create/load a persistent Ed25519 peer identity (`vsm_peer_id.json`)
2. Start the ingestion orchestrator on the configured watch directory
3. Initialize the P2P service with mDNS discovery
4. Optionally start a Tor hidden service (if a bundled Tor binary is found in `resources/tor/`)
5. Open the main application window

---

## 🔑 Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPENAI_API_KEY` | **Yes** | — | API key for OpenAI (used for embeddings and LLM summarization) |
| `OPENAI_BASE_URL` | No | `https://api.openai.com/v1` | Base URL for the OpenAI-compatible API |
| `CEREBRAS_API_KEY` | No | — | API key for Cerebras high-speed inference |
| `CEREBRAS_BASE_URL` | No | `https://api.cerebras.ai/v1` | Base URL for the Cerebras API |
| `LLM_MODEL` | No | `gpt-oss-120b` | Model identifier for LLM inference |
| `EMBEDDING_MODEL` | No | `text-embedding-3-large` | Model identifier for text embeddings |
| `P2P_PORT` | No | `0` (random) | Port for the libp2p TCP listener |
| `P2P_PEER_ID_FILE` | No | `./vsm_peer_id.json` | Path to the peer identity file |
| `VSM_PORT` | No | `4001` | Port used for Tor hidden service and P2P listen address |
| `VSM_WATCH_DIR` | No | `<userData>/watch` | Directory to watch for document ingestion |
| `VSM_PEER_ID` | No | — | Override path to the peer identity JSON file |
| `VSM_USER_DATA_DIR` | No | Electron default | Override Electron's `userData` directory |
| `VSM_MULTI_INSTANCE` | No | `false` | Set to `1` or `true` to allow multiple instances |

---

## 📜 Available Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start the app in development mode with HMR |
| `npm run build` | Build the production-ready Electron app (outputs to `out/`) |
| `npm run preview` | Preview the production build locally |

---

## 🧪 Multi-Instance Testing (Local P2P)

To test P2P mesh communication locally, spawn multiple VSM-Cell instances with separate identities and watch directories.

**Terminal 1 — Node A:**
```bash
npm run dev -- --vsm-port=4001 \
  --multi-instance \
  --vsm-peer-id=vsm_peer_id_a.json \
  --vsm-watch-dir=./watch-a
```

**Terminal 2 — Node B:**
```bash
npm run dev -- --vsm-port=4002 \
  --multi-instance \
  --vsm-peer-id=vsm_peer_id_b.json \
  --vsm-watch-dir=./watch-b
```

### Connecting two nodes

1. In **Node A**'s Network view, copy your Peer ID.
2. In **Node B**'s Network view, paste Node A's Peer ID and generate an invite token (select PEER or MEMBER role).
3. Copy the generated invite token from **Node A** and paste it into **Node B**'s "Join Mesh" input.
4. Once the handshake completes, both nodes appear in each other's topology.
5. Use the Chat view to send `REMOTE` queries between cells.

---

## 📂 Project Structure

```
vsm-cell/
├── src/
│   ├── main/                      # Electron main process
│   │   ├── index.ts               # App entry — window, IPC handlers, service init
│   │   ├── ingestion/
│   │   │   ├── orchestrator.ts    # File watcher, summarization pipeline
│   │   │   ├── parser.ts          # Document parser (Markdown, PDF, text)
│   │   │   ├── chunker.ts         # Text chunking for embeddings
│   │   │   └── hga.ts             # Host Graph Architecture
│   │   ├── services/
│   │   │   ├── agent.ts           # AgenticController (OpenClaw integration)
│   │   │   ├── llm.ts             # LLM service (OpenAI/Cerebras)
│   │   │   ├── p2p.ts             # P2P mesh networking (libp2p)
│   │   │   ├── tor.ts             # Tor hidden service management
│   │   │   ├── tor-transport.ts   # Custom libp2p Tor transport
│   │   │   ├── tor-message-stream.ts  # Tor message streaming
│   │   │   ├── restructuring.ts   # Auto-restructuring when token limit exceeded
│   │   │   └── token.ts           # Token estimation utilities
│   │   └── skills/                # VSM skill definitions (S2, S3, S5)
│   ├── preload/
│   │   └── index.ts               # Context bridge — exposes vsmAPI to renderer
│   └── renderer/
│       ├── index.html             # HTML entry point
│       └── src/
│           ├── App.tsx            # Root component with view routing
│           ├── main.tsx           # React DOM mount
│           ├── index.css          # Global styles (Tailwind)
│           ├── types.ts           # TypeScript type definitions
│           ├── components/
│           │   ├── Sidebar.tsx        # Navigation sidebar
│           │   ├── ProjectView.tsx    # Project overview & ingestion status
│           │   ├── ChatView.tsx       # Agent chat & remote messaging
│           │   ├── NetworkView.tsx    # Mesh topology & peer management
│           │   └── FrictionBar.tsx    # VSM friction/alert notifications
│           └── utils/             # Frontend utilities
├── tests/                         # Integration test scripts
├── resources/
│   └── tor/                       # Bundled Tor binaries (per platform)
├── electron-vite.config.ts        # Electron-Vite build configuration
├── tailwind.config.cjs            # Tailwind CSS configuration
├── tsconfig.json                  # TypeScript configuration (root)
├── tsconfig.node.json             # TypeScript config for main process
├── tsconfig.web.json              # TypeScript config for renderer
├── package.json
└── .env.example                   # Template for environment variables
```

---

## 🛡 Security Model

- **Ed25519 Peer Identity**: Each cell generates a unique Ed25519 keypair stored locally. The private key never leaves the node.
- **Invite-Only Mesh**: Joining a mesh requires a cryptographically signed invite token scoped to a specific Peer ID. Unauthorized connections are silently dropped.
- **Encrypted Transport**: All P2P connections use the [Noise protocol](https://noiseprotocol.org/) for authenticated encryption.
- **Tor Hidden Services**: When enabled, cells communicate over `.onion` addresses, masking IP addresses from all parties.
- **No Central Server**: There is no central coordinating server. Discovery uses mDNS (local) or direct dialing via stored multiaddrs.

---

## 🔧 Technology Stack

| Layer | Technology |
|---|---|
| Desktop Framework | [Electron](https://www.electronjs.org/) |
| Build System | [electron-vite](https://electron-vite.org/) |
| Frontend | [React](https://react.dev/), [Tailwind CSS](https://tailwindcss.com/) |
| Networking | [libp2p](https://libp2p.io/) |
| Anonymity | [Tor](https://www.torproject.org/) |
| AI / LLM | [OpenAI](https://openai.com/), [OpenClaw](https://github.com/), [Cerebras](https://www.cerebras.ai/) |
| Language | [TypeScript](https://www.typescriptlang.org/) |

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Commit your changes: `git commit -m 'Add my feature'`
4. Push to the branch: `git push origin feature/my-feature`
5. Open a Pull Request

---

## 📄 License

This project is part of an experimental, fractal cybernetic design. See the repository for license details.
