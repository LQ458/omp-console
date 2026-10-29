# Get started with omp-console

Follow this guide after [installing omp-console](INSTALL.md). You will connect your browser, start a session in a project folder, and find your earlier work.

## 1. Open the page and connect this browser

Open `http://127.0.0.1:7490` on the computer running omp-console. If the install did not open a connection page, use the `open` command in [Everyday use](INSTALL.md#everyday-use).

On the connection page, click **Pair this browser**. This approves this browser to use your local service. Keep the service on your computer unless you set up the private Tailscale route described in [Connect your phone](INSTALL.md#connect-your-phone).

## 2. Take the tour

On your first visit, follow the five-step tour. It points out the main parts of the screen as you go. You can replay it later from **Settings → Show tour**.

The home screen also has a checklist for omp, model sign-in, earlier omp sessions, and Claude Code history. If a check says something is missing, follow the action shown there. You need to sign in to omp before starting a working session.

## 3. Start your first session

1. Click **+** (New session) at the top of the session list.
2. Choose **Recent projects** to select a folder you used before, or **Browse folders** to find another. Pick the folder that contains your project's files, for example the folder you would open in VS Code. Open it, then click **Start in "<folder name>"**. Click **New folder** to create a folder, or **Type a path** if you know its full path.
3. Type one clear task in the message box and send it. For example, ask omp to explain a file or make a specific change.

The session opens in the project folder you chose. The folder is the context for the work; it does not copy the project into omp-console.

## 4. Watch, steer, or stop the work

Watch the conversation and activity in the session. To change direction or add a detail, send another message in the message box. To interrupt the current work, use **Stop** in the session controls. Read the response before asking for the next change.

## 5. Find an earlier terminal session

Sessions you started in a terminal appear in the session list marked **From terminal** (the home checklist's **Existing omp sessions** row has an **Open sessions** button that shows them). Select one to open a copy. The tooltip says: “Opens a copy; the terminal session is unchanged.” The terminal's original session file is not changed.

## 6. Import Claude Code history

On the home checklist, find **Claude Code history** and click **Open Claude Code import**. You can also open **Import from Claude Code** in Settings. Choose the conversations to bring in, click **Import selected**, and wait for the results. Click **Open** beside an imported conversation to continue it in omp.

The importer reads Claude Code files on the computer running the service. If it finds no history, start Claude Code on that computer and refresh the panel. Imports make omp copies; they do not edit or delete Claude Code transcripts. If other people can use this service, remember that connected browsers can read imported conversations. See [Migrate from Claude Code or Codex](migrating-from-claude-code.md) for project setup, configuration choices, and import details.

## 7. Connect a phone

Install Tailscale on the computer and phone, then sign in to the same Tailscale account on both. Follow [Connect your phone](INSTALL.md#connect-your-phone) to allow your computer's Tailscale name and run Tailscale Serve. On the computer, open **Settings → Devices → Pair another device** and request a code. Open the printed HTTPS address on your phone and click **Pair this browser** with that code.

Do not use Tailscale Funnel or a public reverse proxy. The service can run commands on the computer where it is installed.
